from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


class CacheEntry:
    __slots__ = ("content", "timestamp", "hits")

    def __init__(self, content: str, timestamp: float) -> None:
        self.content = content
        self.timestamp = timestamp
        self.hits = 0


class LLMCache:
    def __init__(self, max_size: int = 500, ttl_seconds: float = 1800) -> None:
        self._store: dict[str, CacheEntry] = {}
        self._max_size = max_size
        self._ttl = ttl_seconds

    @staticmethod
    def _key(
        messages: list[dict[str, str]],
        model: str = "",
        system_prompt: str = "",
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> str:
        # 缓存键必须包含 system_prompt / temperature / tools，否则不同系统提示或
        # 带工具/不带工具的请求会命中同一缓存键返回错误答案（审计 L-12）
        tools_sig = ""
        if tools:
            try:
                tools_sig = "|T:" + ",".join(
                    sorted(t.get("name", "") for t in tools if isinstance(t, dict))
                )
            except Exception:
                tools_sig = "|T:*"
        raw = (
            f"{model}|{temperature}|{system_prompt or ''}|{tools_sig}|"
            + "|".join(f"{m['role']}:{m['content']}" for m in messages)
        )
        return hashlib.sha256(raw.encode()).hexdigest()

    def get(
        self,
        messages: list[dict[str, str]],
        model: str = "",
        system_prompt: str = "",
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> str | None:
        k = self._key(messages, model, system_prompt, temperature, tools)
        entry = self._store.get(k)
        if entry is None:
            return None
        if time.time() - entry.timestamp > self._ttl:
            del self._store[k]
            return None
        entry.hits += 1
        return entry.content

    def set(
        self,
        messages: list[dict[str, str]],
        content: str,
        model: str = "",
        system_prompt: str = "",
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> None:
        k = self._key(messages, model, system_prompt, temperature, tools)
        if len(self._store) >= self._max_size:
            self._evict()
        self._store[k] = CacheEntry(content, time.time())

    def _evict(self) -> None:
        now = time.time()
        expired = [k for k, v in self._store.items() if now - v.timestamp > self._ttl]
        if expired:
            for k in expired:
                del self._store[k]
            return
        least = min(self._store.items(), key=lambda x: x[1].hits)
        del self._store[least[0]]

    def clear(self) -> None:
        self._store.clear()

    @property
    def size(self) -> int:
        return len(self._store)


# ── P0: 分层缓存 (Tiered Cache) ──

class PersistentCache:
    """L2 持久化缓存 — 基于 SQLite 的磁盘缓存。

    进程重启后缓存不丢失，减少冷启动成本。
    使用 WAL 模式提升并发读性能，自动清理过期条目。
    """

    def __init__(
        self,
        db_path: str | Path = "",
        ttl_seconds: float = 86400,
        max_entries: int = 10000,
    ) -> None:
        if not db_path:
            db_path = Path(__file__).parent.parent.parent / "data" / "llm_cache.db"
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._local = threading.local()
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(str(self._db_path))
            self._local.conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn.execute("PRAGMA synchronous=NORMAL")
            self._local.conn.execute("PRAGMA cache_size=-8000")
        return self._local.conn

    def _init_db(self) -> None:
        conn = self._get_conn()
        conn.execute(
            "CREATE TABLE IF NOT EXISTS llm_cache ("
            "  cache_key TEXT PRIMARY KEY,"
            "  content TEXT NOT NULL,"
            "  model TEXT DEFAULT '',"
            "  created_at REAL NOT NULL,"
            "  hits INTEGER DEFAULT 0"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_llm_cache_created "
            "ON llm_cache(created_at)"
        )
        conn.commit()

    def get(self, cache_key: str) -> str | None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT content, created_at, hits FROM llm_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
        if row is None:
            return None
        content, created_at, hits = row
        if time.time() - created_at > self._ttl:
            conn.execute("DELETE FROM llm_cache WHERE cache_key = ?", (cache_key,))
            conn.commit()
            return None
        conn.execute(
            "UPDATE llm_cache SET hits = hits + 1 WHERE cache_key = ?",
            (cache_key,),
        )
        conn.commit()
        return content

    def set(self, cache_key: str, content: str, model: str = "") -> None:
        conn = self._get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO llm_cache (cache_key, content, model, created_at, hits) "
            "VALUES (?, ?, ?, ?, 1)",
            (cache_key, content, model, time.time()),
        )
        conn.commit()
        self._maybe_evict()

    def _maybe_evict(self) -> None:
        conn = self._get_conn()
        count = conn.execute("SELECT COUNT(*) FROM llm_cache").fetchone()[0]
        if count > self._max_entries:
            excess = count - self._max_entries + int(self._max_entries * 0.1)
            conn.execute(
                "DELETE FROM llm_cache WHERE cache_key IN ("
                "  SELECT cache_key FROM llm_cache "
                "  ORDER BY created_at ASC LIMIT ?"
                ")",
                (excess,),
            )
            conn.commit()

    def clear(self) -> None:
        conn = self._get_conn()
        conn.execute("DELETE FROM llm_cache")
        conn.commit()

    def vacuum(self) -> None:
        conn = self._get_conn()
        conn.execute("VACUUM")
        conn.commit()

    @property
    def size(self) -> int:
        conn = self._get_conn()
        return conn.execute("SELECT COUNT(*) FROM llm_cache").fetchone()[0]


class TieredCache:
    """分层缓存 — L1 内存 + L2 磁盘。

    查询流程: L1 命中 → 直接返回; L1 未命中 → 查 L2 → 回填 L1
    写入流程: 同时写入 L1 和 L2
    策略: Read-through + Write-through

    L1 (内存): 热点数据，亚毫秒级延迟，容量有限
    L2 (磁盘): 全量数据，毫秒级延迟，重启不丢失
    """

    def __init__(
        self,
        l1_max_size: int = 500,
        l1_ttl: float = 1800,
        l2_ttl: float = 86400,
        l2_max_entries: int = 10000,
        db_path: str | Path = "",
    ) -> None:
        self._l1 = LLMCache(max_size=l1_max_size, ttl_seconds=l1_ttl)
        self._l2 = PersistentCache(
            db_path=db_path,
            ttl_seconds=l2_ttl,
            max_entries=l2_max_entries,
        )
        self._l1_hits = 0
        self._l2_hits = 0
        self._misses = 0

    def get(
        self,
        messages: list[dict[str, str]],
        model: str = "",
        system_prompt: str = "",
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> str | None:
        cache_key = LLMCache._key(messages, model, system_prompt, temperature, tools)

        l1_result = self._l1._store.get(cache_key)
        if l1_result is not None:
            if time.time() - l1_result.timestamp <= self._l1._ttl:
                l1_result.hits += 1
                self._l1_hits += 1
                return l1_result.content
            del self._l1._store[cache_key]

        l2_result = self._l2.get(cache_key)
        if l2_result is not None:
            self._l1.set(messages, l2_result, model, system_prompt, temperature, tools)
            self._l2_hits += 1
            return l2_result

        self._misses += 1
        return None

    def set(
        self,
        messages: list[dict[str, str]],
        content: str,
        model: str = "",
        system_prompt: str = "",
        temperature: float = 0.0,
        tools: list[dict[str, Any]] | None = None,
    ) -> None:
        cache_key = LLMCache._key(messages, model, system_prompt, temperature, tools)
        self._l1.set(messages, content, model, system_prompt, temperature, tools)
        self._l2.set(cache_key, content, model)

    def stats(self) -> dict[str, Any]:
        total = self._l1_hits + self._l2_hits + self._misses
        return {
            "l1_size": self._l1.size,
            "l2_size": self._l2.size,
            "l1_hits": self._l1_hits,
            "l2_hits": self._l2_hits,
            "misses": self._misses,
            "hit_rate": (self._l1_hits + self._l2_hits) / max(total, 1),
            "l1_hit_rate": self._l1_hits / max(total, 1),
        }

    def clear(self) -> None:
        self._l1.clear()
        self._l2.clear()
        self._l1_hits = 0
        self._l2_hits = 0
        self._misses = 0
