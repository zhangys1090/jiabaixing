from __future__ import annotations

import hashlib
import time
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
