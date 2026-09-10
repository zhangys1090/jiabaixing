"""Redis 缓存层，为 MemoryEngine 提供高速缓存能力。

基于 redis-py 5.x 的异步实现，支持连接池复用、JSON 序列化和优雅降级。
所有操作均具备优雅降级：Redis 不可用时记录日志、返回 None/false，
不抛出异常，确保调用方逻辑不被中断。
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

import redis.asyncio as aioredis
from redis.exceptions import RedisError
logger = logging.getLogger(__name__)

# 模块级常量
REDIS_ENABLED_DEFAULT: bool = False
REDIS_URL_DEFAULT: str = "redis://localhost:6379/0"
REDIS_POOL_SIZE_DEFAULT: int = 10



class RedisCache:
    """Redis 异步缓存层，提供键值存储与 JSON 序列化能力。

    集成 redis-py 5.x 的异步客户端，支持连接池复用、自动 JSON 序列化反序列化、
    TTL 过期策略。所有操作均具备优雅降级：Redis 不可用时记录日志、返回 None/false，
    不抛出异常，确保调用方逻辑不被中断。

    Attributes:
        _redis_url: Redis 服务地址。
        _pool_size: 连接池大小。
        _pool: 异步 Redis 客户端实例（惰性创建）。

    Usage:
        cache = RedisCache()
        await cache.set("key", {"data": 1}, ttl=60)
        value = await cache.get("key")
        await cache.close()
    """

    def __init__(
        self,
        redis_url: str | None = None,
        pool_size: int | None = None,
    ) -> None:
        """初始化 Redis 异步连接池配置。

        Args:
            redis_url: Redis 连接地址，默认读取 REDIS_URL 环境变量，
                否则使用 REDIS_URL_DEFAULT。
            pool_size: 连接池大小，默认读取 REDIS_POOL_SIZE 环境变量，
                否则使用 REDIS_POOL_SIZE_DEFAULT。
        """
        self._redis_url: str = redis_url or os.environ.get(
            "REDIS_URL", REDIS_URL_DEFAULT
        )
        # Windows: localhost 优先解析 IPv6(::1)，redis-server 默认仅监听 IPv4
        if "://localhost" in self._redis_url:
            self._redis_url = self._redis_url.replace("://localhost", "://127.0.0.1")
        self._pool_size: int = pool_size or int(
            os.environ.get("REDIS_POOL_SIZE", str(REDIS_POOL_SIZE_DEFAULT))
        )
        self._pool: aioredis.Redis | None = None

    async def _ensure_pool(self) -> aioredis.Redis | None:
        """惰性创建 Redis 异步连接池。

        Returns:
            Redis 异步客户端实例；创建失败返回 None。
        """
        if self._pool is not None:
            return self._pool
        try:
            self._pool = aioredis.from_url(
                self._redis_url,
                max_connections=self._pool_size,
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=2,
                protocol=2,  # RESP2 兼容 Redis 5.x
            )
            return self._pool
        except Exception as exc:
            logger.warning("Redis 连接池创建失败: %s", exc)
            self._pool = None
            return None

    async def get(self, key: str) -> Optional[Any]:
        """获取缓存值，自动 JSON 反序列化。

        Args:
            key: 缓存键名。

        Returns:
            反序列化后的值；键不存在或 Redis 不可用时返回 None。
        """
        pool = await self._ensure_pool()
        if pool is None:
            return None
        try:
            raw = await pool.get(key)
            if raw is None:
                return None
            return json.loads(raw)
        except (RedisError, json.JSONDecodeError, TypeError) as exc:
            logger.warning("Redis GET 失败 key=%s: %s", key, exc)
            return None
        except Exception as exc:
            logger.warning("Redis GET 未知异常 key=%s: %s", key, exc)
            return None

    async def set(self, key: str, value: Any, ttl: int = 3600) -> bool:
        """设置缓存，自动 JSON 序列化并附加 TTL。

        Args:
            key: 缓存键名。
            value: 待缓存的值（必须可 JSON 序列化）。
            ttl: 过期时间（秒），默认 3600。

        Returns:
            bool: 设置成功返回 True，失败返回 False。
        """
        pool = await self._ensure_pool()
        if pool is None:
            return False
        try:
            serialized = json.dumps(value, ensure_ascii=False, default=str)
            await pool.set(key, serialized, ex=ttl)
            return True
        except (RedisError, TypeError, ValueError) as exc:
            logger.warning("Redis SET 失败 key=%s: %s", key, exc)
            return False
        except Exception as exc:
            logger.warning("Redis SET 未知异常 key=%s: %s", key, exc)
            return False

    async def delete(self, key: str) -> bool:
        """删除指定键。

        Args:
            key: 缓存键名。

        Returns:
            bool: 删除成功（至少删除 1 个键）返回 True，否则 False。
        """
        pool = await self._ensure_pool()
        if pool is None:
            return False
        try:
            deleted = await pool.delete(key)
            return deleted > 0
        except RedisError as exc:
            logger.warning("Redis DELETE 失败 key=%s: %s", key, exc)
            return False
        except Exception as exc:
            logger.warning("Redis DELETE 未知异常 key=%s: %s", key, exc)
            return False

    async def delete_by_prefix(self, prefix: str) -> int:
        """按前缀批量删除键（使用 SCAN 避免阻塞）。

        Args:
            prefix: 缓存键前缀。

        Returns:
            int: 删除的键数量。
        """
        pool = await self._ensure_pool()
        if pool is None:
            return 0
        try:
            deleted = 0
            cursor = 0
            while True:
                cursor, keys = await pool.scan(cursor=cursor, match=f"{prefix}*", count=100)
                if keys:
                    deleted += await pool.delete(*keys)
                if cursor == 0:
                    break
            return deleted
        except RedisError as exc:
            logger.warning("Redis DELETE_BY_PREFIX 失败 prefix=%s: %s", prefix, exc)
            return 0
        except Exception as exc:
            logger.warning("Redis DELETE_BY_PREFIX 未知异常 prefix=%s: %s", prefix, exc)
            return 0

    async def exists(self, key: str) -> bool:
        """检查键是否存在。

        Args:
            key: 缓存键名。

        Returns:
            bool: 存在返回 True，不存在或 Redis 不可用返回 False。
        """
        pool = await self._ensure_pool()
        if pool is None:
            return False
        try:
            count = await pool.exists(key)
            return count > 0
        except RedisError as exc:
            logger.warning("Redis EXISTS 失败 key=%s: %s", key, exc)
            return False
        except Exception as exc:
            logger.warning("Redis EXISTS 未知异常 key=%s: %s", key, exc)
            return False

    async def close(self) -> None:
        """关闭连接池，释放资源。"""
        if self._pool is not None:
            try:
                await self._pool.aclose()
            except Exception as exc:
                logger.warning("Redis 连接池关闭失败: %s", exc)
            finally:
                self._pool = None

    async def health_check(self) -> bool:
        """健康检查，通过 PING 验证连通性。

        Returns:
            bool: 连通返回 True，不可达返回 False。
        """
        pool = await self._ensure_pool()
        if pool is None:
            return False
        try:
            pong = await pool.ping()
            return bool(pong)
        except RedisError as exc:
            logger.warning("Redis PING 失败: %s", exc)
            return False
        except Exception as exc:
            logger.warning("Redis PING 未知异常: %s", exc)
            return False


# 单例支持
_redis_cache_instance: RedisCache | None = None


def get_redis_cache() -> RedisCache:
    """获取 RedisCache 全局单例。

    首次调用时根据环境变量初始化实例，后续调用返回同一实例。

    Returns:
        RedisCache: 全局单例实例。
    """
    global _redis_cache_instance
    if _redis_cache_instance is None:
        _redis_cache_instance = RedisCache()
    return _redis_cache_instance


def is_redis_enabled() -> bool:
    """判断 Redis 缓存是否启用。

    读取 REDIS_ENABLED 环境变量，默认返回 False。

    Returns:
        bool: 启用返回 True，否则 False。
    """
    return os.environ.get(
        "REDIS_ENABLED", str(REDIS_ENABLED_DEFAULT)
    ).lower() == "true"
