"""统一缓存层（Unified Cache Layer）。

P1.1 架构重构：将分散在各模块的缓存实现统一为单一缓存层。

提供:
- CacheBackend: 后端抽象协议
- InMemoryBackend: LRU 内存缓存（统一 context/cache.py 和 tools/tool_result_cache.py 的重复逻辑）
- RedisBackend: Redis 缓存适配器（包装 memory/redis_cache.py）
- TieredCache: 多级缓存（L1 内存 + L2 持久化）
- CacheManager: 中央缓存管理器，带命名空间隔离
- CacheKeyBuilder: 统一的缓存键生成工具
- 兼容适配器: 向后兼容现有模块的桥接

Usage:
    from agent.cache import CacheManager, InMemoryBackend, TieredCache

    manager = CacheManager()
    llm_cache = manager.namespace("llm", backend=InMemoryBackend(max_size=1000))
    tool_cache = manager.namespace("tools", backend=InMemoryBackend(max_size=500))

    await llm_cache.set("key", value, ttl=300)
    result = await llm_cache.get("key")
"""

from agent.cache.in_memory import InMemoryBackend
from agent.cache.keys import CacheKeyBuilder
from agent.cache.manager import CacheManager, CacheNamespace
from agent.cache.protocol import CacheBackend, CacheStats
from agent.cache.redis_backend import RedisBackend
from agent.cache.tiered import TieredCache

__all__ = [
    "CacheBackend",
    "CacheStats",
    "InMemoryBackend",
    "RedisBackend",
    "TieredCache",
    "CacheManager",
    "CacheNamespace",
    "CacheKeyBuilder",
]
