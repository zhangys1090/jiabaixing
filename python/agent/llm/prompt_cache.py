from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.persistence.database import get_sync_connection


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
        self._conn = get_sync_connection(db_path=str(self._path))
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
        import re
        words: list[str] = []
        for part in re.split(r"[\s,，。！？；：、\n\r\t]+", text.lower()):
            if not part:
                continue
            cn_match = re.fullmatch(r"[\u4e00-\u9fff]+", part)
            if cn_match:
                if len(part) <= 2:
                    words.append(part)
                else:
                    for i in range(0, len(part) - 1, 2):
                        chunk = part[i:i + 2]
                        words.append(chunk)
                    if len(part) % 2 == 1:
                        words.append(part[-1])
            else:
                words.append(part)
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

            effective_threshold = self._similarity_threshold

            if similarity >= effective_threshold:
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


# ═══════════════════════════════════════════════════════════════
# Anthropic 前缀缓存模块级辅助函数
# ═══════════════════════════════════════════════════════════════


def is_anthropic_model(model: str | None) -> bool:
    """检查指定模型是否为 Anthropic Claude 模型.

    Args:
        model: 待检查的模型名，None 时返回 False.

    Returns:
        True 如果模型名包含 "claude"（大小写不敏感）.
    """
    if not model:
        return False
    return "claude" in model.lower()


def extract_anthropic_system_blocks(
    messages: list[dict[str, str]],
) -> tuple[list[dict[str, Any]] | None, list[dict[str, str]]]:
    """从消息列表中提取 system 消息为 Anthropic 格式的 system_blocks.

    Anthropic API 要求 system 提示通过单独的 system 参数传递，
    而不是放在 messages 列表中。此方法分离 system 消息和非 system 消息。

    Args:
        messages: 原始消息列表.

    Returns:
        (system_blocks, non_system_messages) 元组.
        system_blocks 为 None 表示无 system 消息.
    """
    system_contents: list[str] = []
    non_system: list[dict[str, str]] = []
    for msg in messages:
        if msg.get("role") == "system":
            content = msg.get("content", "")
            if content:
                system_contents.append(content)
        else:
            non_system.append(msg)

    if not system_contents:
        return None, non_system

    # Anthropic system_blocks 格式
    system_blocks = [{"type": "text", "text": "\n\n".join(system_contents)}]
    return system_blocks, non_system


def apply_anthropic_prefix_cache(
    builder: AnthropicPrefixCacheBuilder,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    model: str | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]] | None, list[dict[str, Any]] | None]:
    """为 Anthropic Claude 模型应用前缀缓存断点.

    当模型为 Claude 且 builder 启用时，提取 system_blocks 并应用缓存断点。
    否则原样返回输入。

    Args:
        builder: Anthropic 前缀缓存构建器实例.
        messages: 原始消息列表.
        tools: 工具定义列表（可选）.
        model: 当前使用的模型名.

    Returns:
        (processed_messages, system_blocks, processed_tools) 元组.
    """
    if not (is_anthropic_model(model) and builder.enabled):
        return messages, None, tools
    system_blocks, processed_messages = extract_anthropic_system_blocks(messages)
    return builder.apply_cache_breakpoints(processed_messages, system_blocks, tools)


# ═══════════════════════════════════════════════════════════════
# PromptCaching — 统一前缀缓存断点标记 + 统计
# ═══════════════════════════════════════════════════════════════

from enum import Enum as _Enum


class CacheProvider(str, _Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    AUTO = "auto"


class CacheBreakpoint(str, _Enum):
    SYSTEM_PROMPT = "system_prompt"
    CONTEXT_FILE = "context_file"
    TOOL_DEFINITIONS = "tool_definitions"
    FEW_SHOT_EXAMPLES = "few_shot_examples"
    CUSTOM = "custom"


@dataclass
class CacheBreakpointConfig:
    breakpoint: CacheBreakpoint = CacheBreakpoint.SYSTEM_PROMPT
    min_tokens: int = 1024
    ttl_seconds: int = 300
    priority: int = 0


@dataclass
class CacheStats:
    total_requests: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    tokens_saved: int = 0
    estimated_cost_saved: float = 0.0
    by_breakpoint: dict[str, dict[str, int]] = field(default_factory=dict)

    @property
    def hit_rate(self) -> float:
        if self.total_requests == 0:
            return 0.0
        return self.cache_hits / self.total_requests


_DEFAULT_BREAKPOINTS: list[CacheBreakpointConfig] = [
    CacheBreakpointConfig(breakpoint=CacheBreakpoint.SYSTEM_PROMPT, min_tokens=1024, ttl_seconds=300, priority=0),
    CacheBreakpointConfig(breakpoint=CacheBreakpoint.CONTEXT_FILE, min_tokens=512, ttl_seconds=300, priority=1),
    CacheBreakpointConfig(breakpoint=CacheBreakpoint.TOOL_DEFINITIONS, min_tokens=256, ttl_seconds=300, priority=2),
    CacheBreakpointConfig(breakpoint=CacheBreakpoint.FEW_SHOT_EXAMPLES, min_tokens=128, ttl_seconds=300, priority=3),
]


class PromptCaching:
    """Prompt 前缀缓存管理器 — 统一 Anthropic/OpenAI 断点标记 + 统计。

    UX 效果：
      - 系统提示缓存命中 → token 成本 -90%
      - 上下文文件缓存命中 → 首字延迟从 5s 降至 1s
    """

    def __init__(
        self,
        provider: CacheProvider = CacheProvider.AUTO,
        breakpoints: list[CacheBreakpointConfig] | None = None,
    ) -> None:
        self._provider = provider
        self._breakpoints = sorted(
            breakpoints or _DEFAULT_BREAKPOINTS, key=lambda b: b.priority
        )
        self._stats = CacheStats()
        self._cache_keys: dict[str, float] = {}

    @property
    def provider(self) -> CacheProvider:
        return self._provider

    @property
    def stats(self) -> CacheStats:
        return self._stats

    def mark_cache_breakpoints(
        self,
        messages: list[dict[str, Any]],
        provider: CacheProvider | None = None,
    ) -> list[dict[str, Any]]:
        p = provider or self._provider
        if p == CacheProvider.AUTO:
            p = self._detect_provider(messages)

        if p == CacheProvider.ANTHROPIC:
            return self._mark_anthropic(messages)
        return messages

    def record_cache_result(
        self,
        breakpoint_type: str,
        hit: bool,
        tokens: int = 0,
        cost_per_token: float = 0.0,
    ) -> None:
        self._stats.total_requests += 1
        if hit:
            self._stats.cache_hits += 1
            self._stats.tokens_saved += tokens
            self._stats.estimated_cost_saved += tokens * cost_per_token
        else:
            self._stats.cache_misses += 1

        bp_stats = self._stats.by_breakpoint.setdefault(breakpoint_type, {"hits": 0, "misses": 0})
        if hit:
            bp_stats["hits"] += 1
        else:
            bp_stats["misses"] += 1

    def compute_cache_key(self, content: str) -> str:
        return hashlib.sha256(content.encode()).hexdigest()[:32]

    def is_cache_valid(self, cache_key: str, ttl: float = 300.0) -> bool:
        cached_at = self._cache_keys.get(cache_key)
        if cached_at is None:
            return False
        return (time.time() - cached_at) < ttl

    def register_cache(self, cache_key: str) -> None:
        self._cache_keys[cache_key] = time.time()

    def invalidate_cache(self, cache_key: str | None = None) -> None:
        if cache_key is None:
            self._cache_keys.clear()
        else:
            self._cache_keys.pop(cache_key, None)

    def get_breakpoint_config(self, bp_type: CacheBreakpoint) -> CacheBreakpointConfig | None:
        for bp in self._breakpoints:
            if bp.breakpoint == bp_type:
                return bp
        return None

    def _detect_provider(self, messages: list[dict[str, Any]]) -> CacheProvider:
        for msg in messages:
            if "cache_control" in msg:
                return CacheProvider.ANTHROPIC
            content = msg.get("content", "")
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and "cache_control" in block:
                        return CacheProvider.ANTHROPIC
        return CacheProvider.OPENAI

    def _mark_anthropic(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result = []
        system_msg_count = 0

        for msg in messages:
            new_msg = dict(msg)

            if msg.get("role") == "system" and system_msg_count == 0:
                content = msg.get("content", "")
                if isinstance(content, str) and len(content) >= self._get_min_tokens(CacheBreakpoint.SYSTEM_PROMPT):
                    new_msg["content"] = [
                        {"type": "text", "text": content},
                        {"type": "text", "text": "", "cache_control": {"type": "ephemeral"}},
                    ]
                system_msg_count += 1

            elif msg.get("role") == "user":
                content = msg.get("content", "")
                if isinstance(content, str) and content.startswith("```"):
                    min_t = self._get_min_tokens(CacheBreakpoint.CONTEXT_FILE)
                    if len(content) >= min_t:
                        new_msg["content"] = [
                            {"type": "text", "text": content},
                            {"type": "text", "text": "", "cache_control": {"type": "ephemeral"}},
                        ]

            result.append(new_msg)
        return result

    def _get_min_tokens(self, bp_type: CacheBreakpoint) -> int:
        config = self.get_breakpoint_config(bp_type)
        return config.min_tokens if config else 1024
