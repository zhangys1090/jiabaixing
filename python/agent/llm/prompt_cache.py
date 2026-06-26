from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR


@dataclass
class CacheEntry:
    key: str
    value: str
    created_at: float
    ttl_ms: int
    hit_count: int = 0
    kind: str = "response"


@dataclass
class CacheResult:
    hit: bool
    value: str | None = None
    match_type: str = "none"
    latency_ms: float = 0.0
    key: str = ""


@dataclass
class PrefixCacheEntry:
    key: str
    prefix_hash: str
    user_input: str
    value: str
    created_at: float
    ttl_ms: int


class PromptCacheStore:
    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DATA_DIR / "prompt_cache.db"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._path))
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._init_tables()

    def _init_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS exact_cache (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at REAL NOT NULL,
                ttl_ms INTEGER NOT NULL,
                hit_count INTEGER DEFAULT 0,
                kind TEXT DEFAULT 'response'
            );
            CREATE TABLE IF NOT EXISTS prefix_cache (
                key TEXT PRIMARY KEY,
                prefix_hash TEXT NOT NULL,
                user_input TEXT DEFAULT '',
                value TEXT NOT NULL,
                created_at REAL NOT NULL,
                ttl_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_prefix_hash ON prefix_cache(prefix_hash);
        """)
        self._conn.commit()

    def get_entry(self, key: str) -> CacheEntry | None:
        row = self._conn.execute(
            "SELECT key, value, created_at, ttl_ms, hit_count, kind FROM exact_cache WHERE key = ?",
            (key,),
        ).fetchone()
        if not row:
            return None
        entry = CacheEntry(key=row[0], value=row[1], created_at=row[2], ttl_ms=row[3], hit_count=row[4], kind=row[5])
        if time.time() * 1000 - entry.created_at > entry.ttl_ms:
            self._conn.execute("DELETE FROM exact_cache WHERE key = ?", (key,))
            self._conn.commit()
            return None
        self._conn.execute("UPDATE exact_cache SET hit_count = hit_count + 1 WHERE key = ?", (key,))
        self._conn.commit()
        entry.hit_count += 1
        return entry

    def set_entry(self, key: str, value: str, ttl_ms: int, kind: str = "response") -> None:
        now = time.time() * 1000
        self._conn.execute(
            "INSERT OR REPLACE INTO exact_cache (key, value, created_at, ttl_ms, hit_count, kind) VALUES (?, ?, ?, ?, 0, ?)",
            (key, value, now, ttl_ms, kind),
        )
        self._conn.commit()

    def get_by_prefix_hash(self, prefix_hash: str) -> list[PrefixCacheEntry]:
        rows = self._conn.execute(
            "SELECT key, prefix_hash, user_input, value, created_at, ttl_ms FROM prefix_cache WHERE prefix_hash = ?",
            (prefix_hash,),
        ).fetchall()
        results = []
        for row in rows:
            entry = PrefixCacheEntry(key=row[0], prefix_hash=row[1], user_input=row[2], value=row[3], created_at=row[4], ttl_ms=row[5])
            if time.time() * 1000 - entry.created_at <= entry.ttl_ms:
                results.append(entry)
        return results

    def set_prefix_entry(self, key: str, prefix_hash: str, user_input: str, value: str, ttl_ms: int) -> None:
        now = time.time() * 1000
        self._conn.execute(
            "INSERT OR REPLACE INTO prefix_cache (key, prefix_hash, user_input, value, created_at, ttl_ms) VALUES (?, ?, ?, ?, ?, ?)",
            (key, prefix_hash, user_input, value, now, ttl_ms),
        )
        self._conn.commit()

    def get_stats(self) -> dict[str, int]:
        exact_count = self._conn.execute("SELECT COUNT(*) FROM exact_cache").fetchone()[0]
        prefix_count = self._conn.execute("SELECT COUNT(*) FROM prefix_cache").fetchone()[0]
        return {"exact_entries": exact_count, "prefix_entries": prefix_count}

    def cleanup_expired(self) -> int:
        now = time.time() * 1000
        r1 = self._conn.execute("DELETE FROM exact_cache WHERE created_at + ttl_ms < ?", (now,)).rowcount
        r2 = self._conn.execute("DELETE FROM prefix_cache WHERE created_at + ttl_ms < ?", (now,)).rowcount
        self._conn.commit()
        return r1 + r2

    def close(self) -> None:
        self._conn.close()


class PromptCacheManager:
    def __init__(
        self,
        enabled: bool = True,
        default_ttl_ms: int = 300_000,
        similarity_threshold: float = 0.7,
        min_word_count: int = 3,
    ) -> None:
        self._enabled = enabled
        self._default_ttl_ms = default_ttl_ms
        self._similarity_threshold = similarity_threshold
        self._min_word_count = min_word_count
        self._store = PromptCacheStore()
        self._session_hits = 0
        self._session_misses = 0
        self._prefix_hits = 0
        self._semantic_hits = 0

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    @staticmethod
    def _normalize(params: dict[str, Any]) -> str:
        parts: list[str] = []
        if params.get("system_prompt"):
            parts.append(f"sys:{params['system_prompt'].strip()}")
        if params.get("messages"):
            msgs = params["messages"]
            parts.append(f"msgs:{json.dumps(msgs, ensure_ascii=False, sort_keys=True)}")
        if params.get("model_name"):
            parts.append(f"model:{params['model_name']}")
        if params.get("temperature") is not None:
            parts.append(f"temp:{params['temperature']}")
        return "||".join(parts)

    @staticmethod
    def _hash(content: str) -> str:
        return hashlib.md5(content.encode()).hexdigest()

    def generate_exact_key(self, params: dict[str, Any]) -> str:
        normalized = self._normalize(params)
        return "exact:" + self._hash(normalized)

    def generate_prefix_key(self, params: dict[str, Any]) -> tuple[str, str | None]:
        msgs = params.get("messages", [])
        last_user_idx = -1
        for i in range(len(msgs) - 1, -1, -1):
            if msgs[i].get("role") == "user":
                last_user_idx = i
                break

        prefix_msgs = msgs[:last_user_idx] if last_user_idx >= 0 else msgs
        last_user_msg = None
        if last_user_idx >= 0:
            content = msgs[last_user_idx].get("content", "")
            last_user_msg = content if isinstance(content, str) else None

        parts: list[str] = []
        if params.get("system_prompt"):
            parts.append(f"sys:{params['system_prompt'].strip()}")
        if prefix_msgs:
            parts.append(f"msgs:{json.dumps(prefix_msgs, ensure_ascii=False, sort_keys=True)}")
        if params.get("model_name"):
            parts.append(f"model:{params['model_name']}")

        prefix_hash = "prefix:" + self._hash("||".join(parts))
        return prefix_hash, last_user_msg

    def try_get_exact(self, params: dict[str, Any]) -> CacheResult:
        if not self._enabled:
            return CacheResult(hit=False, match_type="disabled")

        start = time.time()
        key = self.generate_exact_key(params)
        entry = self._store.get_entry(key)

        if entry:
            self._session_hits += 1
            value = self._parse_cache_value(entry.value)
            return CacheResult(
                hit=True,
                value=value,
                match_type="exact",
                latency_ms=(time.time() - start) * 1000,
                key=key,
            )

        self._session_misses += 1

        prefix_key, last_user_msg = self.generate_prefix_key(params)
        prefix_entries = self._store.get_by_prefix_hash(prefix_key)
        if prefix_entries:
            self._prefix_hits += 1
            if last_user_msg and len(self._tokenize(last_user_msg)) >= self._min_word_count:
                semantic = self._try_semantic_match(prefix_entries, last_user_msg)
                if semantic:
                    self._semantic_hits += 1
                    return CacheResult(
                        hit=True,
                        value=semantic,
                        match_type="semantic",
                        latency_ms=(time.time() - start) * 1000,
                        key=prefix_key,
                    )

            return CacheResult(
                hit=False,
                match_type="prefix_miss",
                latency_ms=(time.time() - start) * 1000,
                key=prefix_key,
            )

        return CacheResult(
            hit=False,
            match_type="none",
            latency_ms=(time.time() - start) * 1000,
            key=key,
        )

    def store_exact(self, params: dict[str, Any], response: str, ttl_ms: int | None = None) -> None:
        if not self._enabled or not response or len(response.strip()) < 5:
            return

        key = self.generate_exact_key(params)
        effective_ttl = ttl_ms or self._default_ttl_ms

        _, last_user_msg = self.generate_prefix_key(params)
        store_value = json.dumps({"response": response, "user_input": last_user_msg}, ensure_ascii=False) if last_user_msg else response

        self._store.set_entry(key, store_value, effective_ttl, "response")

        prefix_key, _ = self.generate_prefix_key(params)
        prefix_ttl = min(effective_ttl, 300_000)
        self._store.set_prefix_entry(
            key=f"pfx_{key}",
            prefix_hash=prefix_key,
            user_input=last_user_msg or "",
            value="1",
            ttl_ms=prefix_ttl,
        )

    def get_stats(self) -> dict[str, Any]:
        store_stats = self._store.get_stats()
        return {
            "enabled": self._enabled,
            "session_hits": self._session_hits,
            "session_misses": self._session_misses,
            "prefix_hits": self._prefix_hits,
            "semantic_hits": self._semantic_hits,
            "hit_rate": self._session_hits / max(1, self._session_hits + self._session_misses),
            **store_stats,
        }

    def cleanup(self) -> int:
        return self._store.cleanup_expired()

    def close(self) -> None:
        self._store.close()

    @staticmethod
    def _parse_cache_value(raw: str) -> str:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict) and "response" in parsed:
                return parsed["response"]
        except (json.JSONDecodeError, TypeError):
            pass
        return raw

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        words = text.lower().split()
        import re
        cn_chars = re.findall(r"[\u4e00-\u9fff]+", text)
        for seg in cn_chars:
            for i in range(len(seg)):
                words.append(seg[i])
                if i + 1 < len(seg):
                    words.append(seg[i:i + 2])
        return words

    def _try_semantic_match(self, entries: list[PrefixCacheEntry], current_input: str) -> str | None:
        current_words = set(self._tokenize(current_input))
        if len(current_words) < self._min_word_count:
            return None

        best_match: tuple[str, float] | None = None
        for entry in entries:
            if not entry.user_input:
                continue
            cached_words = set(self._tokenize(entry.user_input))
            if len(cached_words) < self._min_word_count:
                continue

            intersection = current_words & cached_words
            union = current_words | cached_words
            similarity = len(intersection) / len(union) if union else 0

            if similarity >= self._similarity_threshold:
                if best_match is None or similarity > best_match[1]:
                    exact_key = entry.key.replace("pfx_", "")
                    exact_entry = self._store.get_entry(exact_key)
                    if exact_entry:
                        best_match = (self._parse_cache_value(exact_entry.value), similarity)

        return best_match[0] if best_match else None


@dataclass
class AnthropicCacheBreakpoint:
    position: str
    content_type: str
    cache_control: dict[str, str] = field(default_factory=lambda: {"type": "ephemeral"})


class AnthropicPrefixCacheBuilder:
    def __init__(
        self,
        enabled: bool = True,
        min_prefix_tokens: int = 1024,
        max_breakpoints: int = 4,
    ) -> None:
        self._enabled = enabled
        self._min_prefix_tokens = min_prefix_tokens
        self._max_breakpoints = max_breakpoints

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    def apply_cache_breakpoints(
        self,
        messages: list[dict[str, Any]],
        system_blocks: list[dict[str, Any]] | None = None,
        tools: list[dict[str, Any]] | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]] | None, list[dict[str, Any]] | None]:
        if not self._enabled:
            return messages, system_blocks, tools

        updated_system = self._apply_system_breakpoint(system_blocks)
        updated_tools = self._apply_tools_breakpoint(tools)
        updated_messages = self._apply_message_breakpoints(messages)
        return updated_messages, updated_system, updated_tools

    def _apply_system_breakpoint(self, system_blocks: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
        if not system_blocks:
            return system_blocks
        result = [dict(b) for b in system_blocks]
        if result:
            last = result[-1]
            if "cache_control" not in last:
                result[-1] = {**last, "cache_control": {"type": "ephemeral"}}
        return result

    def _apply_tools_breakpoint(self, tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
        if not tools:
            return tools
        result = [dict(t) for t in tools]
        if result:
            last = result[-1]
            if "cache_control" not in last:
                result[-1] = {**last, "cache_control": {"type": "ephemeral"}}
        return result

    def _apply_message_breakpoints(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not messages:
            return messages

        result = [dict(m) for m in messages]
        total_estimated = self._estimate_tokens(messages)
        if total_estimated < self._min_prefix_tokens:
            return result

        breakpoints_placed = 0
        accumulated = 0
        interval = max(self._min_prefix_tokens, total_estimated // (self._max_breakpoints + 1))

        for i, msg in enumerate(result):
            content = msg.get("content", "")
            accumulated += self._estimate_single(content)

            if (
                accumulated >= interval * (breakpoints_placed + 1)
                and breakpoints_placed < self._max_breakpoints
                and i < len(result) - 1
            ):
                if isinstance(content, str):
                    result[i] = {**msg, "content": content}
                    breakpoints_placed += 1
                    accumulated = 0

        return result

    @staticmethod
    def _estimate_tokens(messages: list[dict[str, Any]]) -> int:
        total = 0
        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, str):
                total += AnthropicPrefixCacheBuilder._estimate_single(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and "text" in block:
                        total += AnthropicPrefixCacheBuilder._estimate_single(block["text"])
        return total

    @staticmethod
    def _estimate_single(text: str) -> int:
        cn = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
        en = len(text) - cn
        return int(cn * 1.5 + en * 0.25)

    def get_stats(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "min_prefix_tokens": self._min_prefix_tokens,
            "max_breakpoints": self._max_breakpoints,
        }
