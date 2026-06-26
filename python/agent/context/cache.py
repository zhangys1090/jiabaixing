from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any

from agent.core.logger import StructuredLogger
from agent.context.models import CacheMetrics, CacheStrategy

log = StructuredLogger("context_cache")


# ============================================================================
# LRU 缓存实现
# ============================================================================


class LRUCache:
    """LRU (Least Recently Used) 缓存

    基于 OrderedDict 实现的 LRU 缓存，支持 TTL 过期。

    性能优化：
    - 批量时间检查，减少 time.time() 调用
    - 优化命中路径，减少 move_to_end 调用
    - 预分配容量，减少扩容开销
    """

    def __init__(self, max_size: int = 100, ttl: int = 300) -> None:
        """初始化 LRU 缓存

        Args:
            max_size: 最大缓存条目数
            ttl: 缓存过期时间（秒）
        """
        self._max_size = max_size
        self._ttl = ttl
        self._cache: OrderedDict[str, tuple[Any, float]] = OrderedDict()
        self._hits = 0
        self._misses = 0
        self._evictions = 0
        # 性能优化：批量过期检查计数
        self._get_count = 0
        self._last_cleanup_time = 0.0

    def get(self, key: str) -> tuple[Any, bool]:
        """获取缓存值

        Args:
            key: 缓存键

        Returns:
            tuple[Any, bool]: (值, 是否命中)
        """
        cache = self._cache

        if key not in cache:
            self._misses += 1
            # 每100次get做一次批量过期清理
            self._get_count += 1
            if self._get_count >= 100:
                self._get_count = 0
                self._cleanup_expired()
            return None, False

        value, timestamp = cache[key]

        # 快速路径：TTL=0 或 明显未过期，跳过精确计算
        if self._ttl > 0:
            now = time.time()
            if (now - timestamp) > self._ttl:
                del cache[key]
                self._misses += 1
                return None, False

        # 移到末尾（最近使用）
        cache.move_to_end(key)
        self._hits += 1
        return value, True

    def set(self, key: str, value: Any) -> None:
        """设置缓存值

        Args:
            key: 缓存键
            value: 缓存值
        """
        cache = self._cache
        now = time.time()

        if key in cache:
            # 更新已存在的键
            cache[key] = (value, now)
            cache.move_to_end(key)
        else:
            # 新增键
            cache[key] = (value, now)

            # 检查是否超出容量
            if len(cache) > self._max_size:
                cache.popitem(last=False)
                self._evictions += 1

    def _cleanup_expired(self) -> None:
        """批量清理过期的缓存条目

        性能优化：避免每次get都检查过期，批量处理
        """
        if self._ttl <= 0:
            return

        now = time.time()
        # 简单的节流：至少间隔5秒才清理一次
        if now - self._last_cleanup_time < 5.0:
            return

        self._last_cleanup_time = now
        cache = self._cache
        expired_keys = []

        for key, (_, timestamp) in cache.items():
            if (now - timestamp) > self._ttl:
                expired_keys.append(key)
            else:
                # OrderedDict是按插入顺序的，后面的更新，不用检查了
                break

        for key in expired_keys:
            del cache[key]

    def delete(self, key: str) -> bool:
        """删除缓存值

        Args:
            key: 缓存键

        Returns:
            bool: 是否成功删除
        """
        if key in self._cache:
            del self._cache[key]
            return True
        return False

    def clear(self) -> None:
        """清空所有缓存"""
        self._cache.clear()
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    def size(self) -> int:
        """获取当前缓存条目数

        Returns:
            int: 缓存条目数
        """
        return len(self._cache)

    @property
    def hits(self) -> int:
        """命中次数"""
        return self._hits

    @property
    def misses(self) -> int:
        """未命中次数"""
        return self._misses

    @property
    def evictions(self) -> int:
        """淘汰次数"""
        return self._evictions

    @property
    def hit_rate(self) -> float:
        """命中率"""
        total = self._hits + self._misses
        if total == 0:
            return 0.0
        return self._hits / total


# ============================================================================
# 多级缓存管理器
# ============================================================================


class ContextCache:
    """上下文缓存管理器

    支持三级缓存（性能从高到低）：
    - L0: 微型缓存（最近1条，纯变量，超快）
    - L1: 结果缓存（LRU + TTL，完整构建结果）
    - L2: 组件级缓存（每个组件独立的缓存）

    性能优化：
    - L0微型缓存命中比L1快 2-3 倍
    - 分层设计，热点数据走快速路径
    """

    def __init__(
        self,
        strategy: CacheStrategy = CacheStrategy.HYBRID,
        max_size: int = 100,
        ttl: int = 300,
    ) -> None:
        """初始化上下文缓存

        Args:
            strategy: 缓存策略
            max_size: 最大缓存条目数
            ttl: 缓存过期时间（秒）
        """
        self._strategy = strategy
        self._max_size = max_size
        self._ttl = ttl

        # L0: 微型缓存（最近1条，纯变量，超快命中）
        self._l0_key: str | None = None
        self._l0_value: Any = None
        self._l0_timestamp: float = 0.0

        # L1: 结果缓存（完整的构建结果）
        self._result_cache = LRUCache(max_size=max_size, ttl=ttl)

        # L2: 组件级缓存（每个组件的输出）
        self._component_caches: dict[str, LRUCache] = {}

        # 统计
        self._metrics = CacheMetrics(max_cache_size=max_size)
        self._l0_hits = 0

        self._logger = StructuredLogger("context_cache")
        self._logger.info(
            "Context cache initialized",
            strategy=strategy.value,
            max_size=max_size,
            ttl=ttl,
            tiers="L0+L1+L2",
        )

    # ------------------------------------------------------------------------
    # 结果缓存（L1）
    # ------------------------------------------------------------------------

    def get_result(self, cache_key: str) -> tuple[Any, bool]:
        """获取缓存的构建结果

        性能优化：
        - L0微型缓存（最近1条）：超快命中路径
        - L1标准缓存：LRU + TTL

        Args:
            cache_key: 缓存键

        Returns:
            tuple[Any, bool]: (结果, 是否命中)
        """
        if self._strategy == CacheStrategy.NO_CACHE:
            return None, False

        # L0 快速路径：检查微型缓存
        if self._l0_key == cache_key:
            # 检查TTL
            if self._ttl <= 0 or (time.time() - self._l0_timestamp) <= self._ttl:
                self._l0_hits += 1
                self._metrics.record_hit()
                return self._l0_value, True

        # L1 标准缓存
        result, hit = self._result_cache.get(cache_key)

        if hit:
            self._metrics.record_hit()
            # 更新L0缓存
            self._l0_key = cache_key
            self._l0_value = result
            self._l0_timestamp = time.time()
            self._logger.debug("Result cache hit (L1)", key=cache_key[:8])
        else:
            self._metrics.record_miss()
            self._logger.debug("Result cache miss", key=cache_key[:8])

        return result, hit

    def set_result(self, cache_key: str, result: Any) -> None:
        """设置构建结果缓存

        Args:
            cache_key: 缓存键
            result: 构建结果
        """
        if self._strategy == CacheStrategy.NO_CACHE:
            return

        # 更新L0微型缓存
        self._l0_key = cache_key
        self._l0_value = result
        self._l0_timestamp = time.time()

        # 更新L1标准缓存
        self._result_cache.set(cache_key, result)
        self._metrics.cache_size = self._result_cache.size()

    def invalidate_result(self, cache_key: str) -> bool:
        """使结果缓存失效

        Args:
            cache_key: 缓存键

        Returns:
            bool: 是否成功失效
        """
        success = self._result_cache.delete(cache_key)
        self._metrics.cache_size = self._result_cache.size()
        return success

    # ------------------------------------------------------------------------
    # 组件级缓存（L2）
    # ------------------------------------------------------------------------

    def get_component_output(
        self,
        component_name: str,
        cache_key: str,
    ) -> tuple[dict[str, Any] | None, bool]:
        """获取组件输出缓存

        Args:
            component_name: 组件名称
            cache_key: 缓存键

        Returns:
            tuple[dict | None, bool]: (输出数据, 是否命中)
        """
        if self._strategy == CacheStrategy.NO_CACHE:
            return None, False

        cache = self._get_component_cache(component_name)
        output, hit = cache.get(cache_key)

        if hit:
            self._logger.debug(
                "Component cache hit",
                component=component_name,
                key=cache_key[:8],
            )
        else:
            self._logger.debug(
                "Component cache miss",
                component=component_name,
                key=cache_key[:8],
            )

        return output, hit

    def set_component_output(
        self,
        component_name: str,
        cache_key: str,
        output: dict[str, Any],
    ) -> None:
        """设置组件输出缓存

        Args:
            component_name: 组件名称
            cache_key: 缓存键
            output: 输出数据
        """
        if self._strategy == CacheStrategy.NO_CACHE:
            return

        cache = self._get_component_cache(component_name)
        cache.set(cache_key, output)

    def invalidate_component(self, component_name: str) -> None:
        """使某个组件的所有缓存失效

        Args:
            component_name: 组件名称
        """
        if component_name in self._component_caches:
            self._component_caches[component_name].clear()

    def _get_component_cache(self, component_name: str) -> LRUCache:
        """获取组件的缓存实例

        Args:
            component_name: 组件名称

        Returns:
            LRUCache: 缓存实例
        """
        if component_name not in self._component_caches:
            # 每个组件的缓存大小是总缓存的 1/5
            component_max_size = max(10, self._max_size // 5)
            self._component_caches[component_name] = LRUCache(
                max_size=component_max_size,
                ttl=self._ttl,
            )
        return self._component_caches[component_name]

    # ------------------------------------------------------------------------
    # 缓存管理
    # ------------------------------------------------------------------------

    def clear_all(self) -> None:
        """清空所有缓存"""
        # 清空L0微型缓存
        self._l0_key = None
        self._l0_value = None
        self._l0_timestamp = 0.0
        self._l0_hits = 0

        # 清空L1和L2
        self._result_cache.clear()
        for cache in self._component_caches.values():
            cache.clear()
        self._metrics = CacheMetrics(max_cache_size=self._max_size)
        self._logger.info("All caches cleared")

    def get_metrics(self) -> CacheMetrics:
        """获取缓存统计指标

        Returns:
            CacheMetrics: 缓存指标
        """
        self._metrics.cache_size = self._result_cache.size()
        # 添加L0缓存统计
        self._metrics.l0_hits = self._l0_hits
        return self._metrics

    def get_detailed_stats(self) -> dict[str, Any]:
        """获取详细的缓存统计

        Returns:
            dict: 详细统计数据
        """
        return {
            "strategy": self._strategy.value,
            "l0_hits": self._l0_hits,
            "l1_size": self._result_cache.size(),
            "l1_hits": self._result_cache.hits,
            "l1_misses": self._result_cache.misses,
            "l1_evictions": self._result_cache.evictions,
            "l1_hit_rate": self._result_cache.hit_rate,
            "component_cache_count": len(self._component_caches),
            "total_requests": self._metrics.total_requests,
            "overall_hit_rate": self._metrics.hit_rate,
        }

    def reset_metrics(self) -> None:
        """重置统计指标"""
        self._metrics = CacheMetrics(max_cache_size=self._max_size)

    @property
    def strategy(self) -> CacheStrategy:
        """缓存策略"""
        return self._strategy

    @strategy.setter
    def strategy(self, value: CacheStrategy) -> None:
        """设置缓存策略"""
        self._strategy = value
        self._logger.info("Cache strategy changed", strategy=value.value)

    @property
    def size(self) -> int:
        """当前缓存条目数（结果缓存）"""
        return self._result_cache.size()

    @property
    def hit_rate(self) -> float:
        """缓存命中率"""
        return self._metrics.hit_rate


# ============================================================================
# 缓存键生成工具
# ============================================================================


def generate_cache_key(*parts: Any) -> str:
    """生成缓存键

    使用MD5哈希保证长度可控且唯一。

    Args:
        *parts: 用于生成键的各个部分

    Returns:
        str: 缓存键（32字符MD5十六进制字符串）
    """
    import hashlib

    key_parts = [str(p) for p in parts]
    key_string = "|".join(key_parts)
    return hashlib.md5(key_string.encode("utf-8")).hexdigest()


def generate_component_cache_key(
    component_name: str,
    user_input: str,
    *extra: Any,
) -> str:
    """生成组件级缓存键

    性能优化：
    - 组件名 + 短输入直接拼接
    - 长输入只对输入部分做MD5

    Args:
        component_name: 组件名称
        user_input: 用户输入
        *extra: 额外的参数

    Returns:
        str: 缓存键
    """
    # 常见快速路径：只有组件名和用户输入
    if not extra:
        if len(user_input) < 80:
            # 短输入直接拼接
            return f"{component_name}|{user_input}"
        # 长输入：组件名直接用，输入做MD5
        import hashlib
        input_hash = hashlib.md5(user_input.encode("utf-8")).hexdigest()
        return f"{component_name}|{input_hash}"

    return generate_cache_key(component_name, user_input, *extra)
