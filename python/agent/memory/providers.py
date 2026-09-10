"""记忆提供者（Honcho / Mem0 / Hindsight 集成）。

提供统一的记忆存储接口，支持多种后端：
  - 内置记忆存储（默认）
  - Honcho 对话记忆 API
  - Mem0 智能记忆管理
  - Hindsight 长期记忆检索
  - 记忆同步与迁移

与 Memory 模型的关系：
  - MemoryItem 定义记忆数据结构
  - MemoryProvider 定义存储接口
  - 不同后端实现相同接口，可互换

集成示例::

    from agent.memory.providers import MemoryProviderFactory

    provider = MemoryProviderFactory.create("mem0", api_key=os.environ["MEM0_API_KEY"])
    await provider.store("user_123", "用户喜欢简洁的回答", memory_type="long_term")
    results = await provider.search("user_123", "用户偏好")
"""

from __future__ import annotations

import json
import time
import uuid
from abc import ABC, abstractmethod
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_ROOT
from agent.core.logger import StructuredLogger

log = StructuredLogger("memory.providers")


class MemoryType(str, Enum):
    SHORT_TERM = "short_term"
    LONG_TERM = "long_term"
    INSTANT = "instant"
    EPISODIC = "episodic"
    SEMANTIC = "semantic"


@dataclass
class MemoryItem:
    id: str
    user_id: str
    content: str
    memory_type: MemoryType = MemoryType.SHORT_TERM
    scene: str = ""
    emotion: str = "neutral"
    relevance_score: float = 0.0
    timestamp: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id:
            self.id = str(uuid.uuid4())
        if self.timestamp == 0.0:
            self.timestamp = time.time()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "content": self.content,
            "memory_type": self.memory_type.value,
            "scene": self.scene,
            "emotion": self.emotion,
            "relevance_score": self.relevance_score,
            "timestamp": self.timestamp,
            "metadata": self.metadata,
        }


@dataclass
class SearchResult:
    items: list[MemoryItem]
    total: int = 0
    query: str = ""


class MemoryProvider(ABC):
    """记忆存储提供者抽象基类。"""

    @abstractmethod
    async def store(self, user_id: str, content: str, **kwargs: Any) -> MemoryItem:
        ...

    @abstractmethod
    async def search(self, user_id: str, query: str, limit: int = 10, **kwargs: Any) -> SearchResult:
        ...

    @abstractmethod
    async def get(self, memory_id: str) -> MemoryItem | None:
        ...

    @abstractmethod
    async def delete(self, memory_id: str) -> bool:
        ...

    @abstractmethod
    async def list_memories(self, user_id: str, memory_type: MemoryType | None = None, limit: int = 50) -> list[MemoryItem]:
        ...


class BuiltinMemoryProvider(MemoryProvider):
    """内置记忆存储（默认）。"""

    def __init__(self, data_dir: Path | None = None) -> None:
        self._dir = data_dir or DATA_ROOT / "memory"
        self._store: dict[str, list[MemoryItem]] = defaultdict(list)
        self._by_id: dict[str, MemoryItem] = {}
        self._MAX_USERS = 5000
        self._load()

    def _load(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        for fp in self._dir.glob("*.json"):
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
                for item in data.get("memories", []):
                    m = MemoryItem(
                        id=item.get("id", ""),
                        user_id=item.get("user_id", ""),
                        content=item.get("content", ""),
                        memory_type=MemoryType(item.get("memory_type", "short_term")),
                        scene=item.get("scene", ""),
                        emotion=item.get("emotion", "neutral"),
                        relevance_score=item.get("relevance_score", 0),
                        timestamp=item.get("timestamp", 0),
                        metadata=item.get("metadata", {}),
                    )
                    self._store[m.user_id].append(m)
                    self._by_id[m.id] = m
            except Exception as e:
                log.warning("加载记忆数据失败", file=str(fp), error=str(e))

    def _save_user(self, user_id: str) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        fp = self._dir / f"{user_id}.json"
        memories = [m.to_dict() for m in self._store.get(user_id, [])]
        fp.write_text(json.dumps({"memories": memories}, ensure_ascii=False, indent=2), encoding="utf-8")

    async def store(self, user_id: str, content: str, **kwargs: Any) -> MemoryItem:
        m = MemoryItem(
            user_id=user_id,
            content=content,
            memory_type=MemoryType(kwargs.get("memory_type", "short_term")),
            scene=kwargs.get("scene", ""),
            emotion=kwargs.get("emotion", "neutral"),
            metadata=kwargs.get("metadata", {}),
        )
        self._store[user_id].append(m)
        self._by_id[m.id] = m
        if len(self._store) > self._MAX_USERS:
            oldest_users = list(self._store.keys())[: len(self._store) - (self._MAX_USERS * 3 // 4)]
            for uid in oldest_users:
                for item in self._store.pop(uid, []):
                    self._by_id.pop(item.id, None)
        self._save_user(user_id)
        return m

    async def search(self, user_id: str, query: str, limit: int = 10, **kwargs: Any) -> SearchResult:
        q = query.lower()
        items = self._store.get(user_id, [])
        scored = []
        for m in items:
            if q in m.content.lower():
                score = m.relevance_score + 0.5
            else:
                words = q.split()
                matches = sum(1 for w in words if w in m.content.lower())
                score = matches / max(len(words), 1) * 0.3
            if score > 0:
                scored.append((m, score))

        scored.sort(key=lambda x: x[1], reverse=True)
        results = [m for m, s in scored[:limit]]
        return SearchResult(items=results, total=len(scored), query=query)

    async def get(self, memory_id: str) -> MemoryItem | None:
        return self._by_id.get(memory_id)

    async def delete(self, memory_id: str) -> bool:
        m = self._by_id.pop(memory_id, None)
        if m is None:
            return False
        if m.user_id in self._store:
            self._store[m.user_id] = [x for x in self._store[m.user_id] if x.id != memory_id]
            self._save_user(m.user_id)
        return True

    async def list_memories(self, user_id: str, memory_type: MemoryType | None = None, limit: int = 50) -> list[MemoryItem]:
        items = self._store.get(user_id, [])
        if memory_type:
            items = [m for m in items if m.memory_type == memory_type]
        return sorted(items, key=lambda m: m.timestamp, reverse=True)[:limit]


class HonchoProvider(MemoryProvider):
    """Honcho 对话记忆 API 提供者。"""

    def __init__(self, api_key: str = "", base_url: str = "https://api.honcho.ai") -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._fallback = BuiltinMemoryProvider()

    async def store(self, user_id: str, content: str, **kwargs: Any) -> MemoryItem:
        if not self._api_key:
            return await self._fallback.store(user_id, content, **kwargs)
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{self._base_url}/v1/memories",
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    json={"user_id": user_id, "content": content, **kwargs},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return MemoryItem(id=data.get("id", ""), user_id=user_id, content=content)
        except Exception as e:
            log.warning("Honcho API 调用失败，回退到内置", error=str(e))
        return await self._fallback.store(user_id, content, **kwargs)

    async def search(self, user_id: str, query: str, limit: int = 10, **kwargs: Any) -> SearchResult:
        if not self._api_key:
            return await self._fallback.search(user_id, query, limit, **kwargs)
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{self._base_url}/v1/memories/search",
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    json={"user_id": user_id, "query": query, "limit": limit},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    items = [
                        MemoryItem(id=d.get("id", ""), user_id=user_id, content=d.get("content", ""))
                        for d in data.get("results", [])
                    ]
                    return SearchResult(items=items, total=len(items), query=query)
        except Exception as e:
            log.warning("Honcho 搜索失败，回退到内置", error=str(e))
        return await self._fallback.search(user_id, query, limit, **kwargs)

    async def get(self, memory_id: str) -> MemoryItem | None:
        return await self._fallback.get(memory_id)

    async def delete(self, memory_id: str) -> bool:
        return await self._fallback.delete(memory_id)

    async def list_memories(self, user_id: str, memory_type: MemoryType | None = None, limit: int = 50) -> list[MemoryItem]:
        return await self._fallback.list_memories(user_id, memory_type, limit)


class Mem0Provider(MemoryProvider):
    """Mem0 智能记忆管理提供者。"""

    def __init__(self, api_key: str = "") -> None:
        self._api_key = api_key
        self._fallback = BuiltinMemoryProvider()

    async def store(self, user_id: str, content: str, **kwargs: Any) -> MemoryItem:
        if not self._api_key:
            return await self._fallback.store(user_id, content, **kwargs)
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "https://api.mem0.ai/v1/memories",
                    headers={"Authorization": f"Token {self._api_key}"},
                    json={"messages": [{"role": "user", "content": content}], "user_id": user_id},
                )
                if resp.status_code in (200, 201):
                    return MemoryItem(id=str(uuid.uuid4()), user_id=user_id, content=content)
        except Exception as e:
            log.warning("Mem0 API 调用失败，回退到内置", error=str(e))
        return await self._fallback.store(user_id, content, **kwargs)

    async def search(self, user_id: str, query: str, limit: int = 10, **kwargs: Any) -> SearchResult:
        if not self._api_key:
            return await self._fallback.search(user_id, query, limit, **kwargs)
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    "https://api.mem0.ai/v1/memories",
                    headers={"Authorization": f"Token {self._api_key}"},
                    params={"user_id": user_id, "q": query, "limit": limit},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    items = [
                        MemoryItem(id=d.get("id", ""), user_id=user_id, content=d.get("memory", ""))
                        for d in data.get("memories", [])
                    ]
                    return SearchResult(items=items, total=len(items), query=query)
        except Exception as e:
            log.warning("Mem0 搜索失败，回退到内置", error=str(e))
        return await self._fallback.search(user_id, query, limit, **kwargs)

    async def get(self, memory_id: str) -> MemoryItem | None:
        return await self._fallback.get(memory_id)

    async def delete(self, memory_id: str) -> bool:
        return await self._fallback.delete(memory_id)

    async def list_memories(self, user_id: str, memory_type: MemoryType | None = None, limit: int = 50) -> list[MemoryItem]:
        return await self._fallback.list_memories(user_id, memory_type, limit)


class MemoryProviderFactory:
    """记忆提供者工厂。"""

    _PROVIDERS: dict[str, type[MemoryProvider]] = {
        "builtin": BuiltinMemoryProvider,
        "honcho": HonchoProvider,
        "mem0": Mem0Provider,
    }

    @classmethod
    def create(cls, provider_type: str, **kwargs: Any) -> MemoryProvider:
        provider_cls = cls._PROVIDERS.get(provider_type)
        if provider_cls is None:
            raise ValueError(f"未知记忆提供者: {provider_type}，可选: {list(cls._PROVIDERS.keys())}")
        return provider_cls(**kwargs)

    @classmethod
    def available_providers(cls) -> list[str]:
        return list(cls._PROVIDERS.keys())
