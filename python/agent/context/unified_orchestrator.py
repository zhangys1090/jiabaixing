from __future__ import annotations

import os
import time
from typing import Any

from agent.core.logger import StructuredLogger
from agent.context.base import ComponentRegistry, ContextComponent, DependencyResolver
from agent.context.cache import ContextCache
from agent.context.models import (
    BuildContext,
    BuildStatistics,
    BuildStatus,
    ComponentResult,
    ComponentStatus,
    ContextBuildRequest,
    ContextBuildResult,
    ErrorInfo,
)

log = StructuredLogger("unified_context_orchestrator")


# ============================================================================
# 统一上下文编排器
# ============================================================================


class UnifiedContextOrchestrator:
    """统一上下文编排器

    负责统一管理和编排所有上下文组件，提供单一的上下文构建入口。

    主要功能：
    - 组件注册和管理
    - 依赖解析和执行顺序编排
    - 多级缓存管理
    - 错误处理和降级机制
    - 统计和监控
    """

    def __init__(
        self,
        use_cache: bool = True,
        cache_max_size: int = 100,
        cache_ttl: int = 300,
        enabled: bool = True,
    ) -> None:
        """初始化统一上下文编排器

        性能优化：
        - 依赖预解析：注册时计算执行顺序，避免每次构建都重新计算
        - 执行顺序缓存：常用组件组合缓存执行顺序
        - 快速路径：简单场景直接处理

        Args:
            use_cache: 是否启用缓存
            cache_max_size: 缓存最大条目数
            cache_ttl: 缓存过期时间（秒）
            enabled: 是否启用编排器
        """
        self._enabled = enabled
        self._registry = ComponentRegistry()
        self._dependency_resolver = DependencyResolver()
        self._cache = ContextCache(max_size=cache_max_size, ttl=cache_ttl)
        self._use_cache = use_cache

        # 统计
        self._statistics = BuildStatistics()

        # 配置
        self._component_timeout: float = 5.0  # 组件超时时间（秒）

        # 性能优化：执行顺序缓存
        self._execution_order_cache: dict[str, list[ContextComponent]] = {}
        self._last_registry_version: int = 0
        self._registry_version: int = 0

        # 性能优化：常用请求模式的快速路径
        self._fast_path_enabled = True

        self._logger = StructuredLogger("unified_orchestrator")
        self._logger.info(
            "UnifiedContextOrchestrator initialized",
            enabled=enabled,
            use_cache=use_cache,
            optimizations=["dependency_pre_resolution", "execution_order_cache", "fast_path"],
        )

    # ------------------------------------------------------------------------
    # 核心构建方法
    # ------------------------------------------------------------------------

    async def build_context(
        self,
        request: ContextBuildRequest,
    ) -> ContextBuildResult:
        """统一的上下文构建入口

        Args:
            request: 上下文构建请求

        Returns:
            ContextBuildResult: 构建结果
        """
        start_time = time.time()

        # 如果编排器未启用，返回基础结果
        if not self._enabled:
            return self._build_basic_result(request)

        self._logger.debug(
            "Building context",
            session_id=request.session_id,
            scene=request.scene,
        )

        # 检查缓存
        if self._use_cache and request.use_cache:
            cache_key = request.get_cache_key()
            cached_result, hit = self._cache.get_result(cache_key)
            if hit and isinstance(cached_result, ContextBuildResult):
                cached_result.from_cache = True
                self._logger.debug(
                    "Context cache hit",
                    key=cache_key[:8],
                    build_time_ms=cached_result.build_time_ms,
                )
                return cached_result

        # 执行构建
        result = await self._execute_build(request)

        # 记录统计
        result.build_time_ms = (time.time() - start_time) * 1000
        self._statistics.record_build(result)

        # 写入缓存
        if self._use_cache and request.use_cache and result.is_success():
            cache_key = request.get_cache_key()
            self._cache.set_result(cache_key, result)

        # 日志
        if result.status == BuildStatus.SUCCESS:
            self._logger.info(
                "Context build successful",
                session_id=request.session_id,
                build_time_ms=round(result.build_time_ms, 2),
                total_tokens=result.total_tokens,
                component_count=len(result.component_results),
            )
        elif result.status == BuildStatus.PARTIAL:
            self._logger.warning(
                "Context build partial",
                session_id=request.session_id,
                build_time_ms=round(result.build_time_ms, 2),
                failed_components=len(result.get_failed_components()),
                degraded_components=len(result.get_degraded_components()),
            )
        else:
            self._logger.error(
                "Context build failed",
                session_id=request.session_id,
                build_time_ms=round(result.build_time_ms, 2),
                error_count=len(result.errors),
            )

        return result

    async def _execute_build(
        self,
        request: ContextBuildRequest,
    ) -> ContextBuildResult:
        """执行实际的构建流程

        性能优化：
        - 使用缓存的执行顺序，避免重复拓扑排序
        - 快速路径：组件数量少时直接执行
        - 预分配列表容量

        Args:
            request: 构建请求

        Returns:
            ContextBuildResult: 构建结果
        """
        # 初始化构建上下文
        context = BuildContext(
            request=request,
            token_budget=request.max_tokens,
        )

        # 获取需要执行的组件
        components = self._get_components_to_execute(request)

        if not components:
            self._logger.warning("No components to execute")
            return self._build_empty_result(request)

        # 性能优化：使用缓存的执行顺序
        ordered_components = self._get_cached_execution_order(components)

        # 检查依赖（快速路径：组件少时跳过详细检查）
        if len(components) > 3:
            missing_deps = self._dependency_resolver.check_dependencies(components)
            if missing_deps:
                for comp_name, deps in missing_deps.items():
                    context.add_warning(
                        f"Component '{comp_name}' has missing dependencies: {deps}"
                    )

        # 顺序执行组件
        for component in ordered_components:
            await self._execute_component(component, request, context)

        # 组装结果
        result = self._assemble_result(request, context)

        return result

    async def _execute_component(
        self,
        component: ContextComponent,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> None:
        """执行单个组件

        Args:
            component: 要执行的组件
            request: 构建请求
            context: 构建上下文
        """
        context.current_component = component.name

        # 检查依赖是否满足
        if not self._check_component_dependencies(component, context):
            result = ComponentResult(
                component_name=component.name,
                status=ComponentStatus.SKIPPED,
            )
            context.component_results[component.name] = result
            context.add_warning(
                f"Component '{component.name}' skipped due to missing dependencies"
            )
            return

        # 执行组件
        try:
            result = await component.execute(request, context)
        except Exception as e:
            # 兜底错误处理
            error_info = ErrorInfo(
                error_type=type(e).__name__,
                message=str(e),
                component=component.name,
            )
            result = ComponentResult(
                component_name=component.name,
                status=ComponentStatus.FAILED,
                error=error_info,
            )
            context.add_error(error_info)
            self._logger.error(
                "Component execution failed (unhandled)",
                component=component.name,
                error=str(e),
            )

        # 保存结果
        context.component_results[component.name] = result

        # 如果成功，保存输出
        if result.is_success() and result.output:
            context.set_output(component.name, result.output)

        # 如果失败且是强依赖，记录错误
        if result.status == ComponentStatus.FAILED and result.error:
            context.add_error(result.error)

    def _check_component_dependencies(
        self,
        component: ContextComponent,
        context: BuildContext,
    ) -> bool:
        """检查组件的依赖是否满足

        Args:
            component: 组件
            context: 构建上下文

        Returns:
            bool: 依赖是否满足
        """
        for dep in component.dependencies:
            if not dep.required:
                continue  # 非强依赖可以跳过

            dep_result = context.component_results.get(dep.component_name)
            if dep_result is None:
                return False  # 依赖未执行
            if not dep_result.is_success():
                return False  # 依赖执行失败

        return True

    def _get_components_to_execute(
        self,
        request: ContextBuildRequest,
    ) -> list[ContextComponent]:
        """获取需要执行的组件列表

        Args:
            request: 构建请求

        Returns:
            list[ContextComponent]: 需要执行的组件列表
        """
        # 已经按优先级排序，直接过滤
        enabled_components = self._registry.get_enabled()
        return [c for c in enabled_components if c.can_handle(request)]

    def _get_cached_execution_order(
        self,
        components: list[ContextComponent],
    ) -> list[ContextComponent]:
        """获取缓存的执行顺序

        性能优化：避免每次构建都重新拓扑排序。
        使用组件名称的组合作为缓存键。

        Args:
            components: 组件列表

        Returns:
            list[ContextComponent]: 排序后的组件列表
        """
        # 快速路径：只有1-2个组件，直接返回
        if len(components) <= 2:
            return components

        # 生成缓存键：组件名称的有序组合
        cache_key = ",".join(c.name for c in components)

        # 检查缓存
        cached = self._execution_order_cache.get(cache_key)
        if cached is not None:
            return cached

        # 未命中，计算执行顺序
        try:
            ordered = self._dependency_resolver.resolve_execution_order(components)
        except ValueError:
            # 循环依赖，降级为按优先级顺序
            ordered = components

        # 缓存结果（限制缓存大小，避免内存泄漏）
        if len(self._execution_order_cache) < 100:
            self._execution_order_cache[cache_key] = ordered

        return ordered

    def get_performance_stats(self) -> dict[str, Any]:
        """获取性能统计信息

        Returns:
            dict: 性能统计数据
        """
        stats = self._statistics
        cache_stats = self.get_cache_stats()

        return {
            "total_builds": stats.total_builds,
            "success_rate": round(stats.success_rate, 4),
            "avg_build_time_ms": round(stats.avg_time_ms, 2),
            "min_build_time_ms": round(stats.min_time_ms, 2),
            "max_build_time_ms": round(stats.max_time_ms, 2),
            "component_count": self.component_count,
            "execution_order_cache_size": len(self._execution_order_cache),
            "cache": cache_stats,
            "components": {
                name: {
                    "total_executions": m.total_executions,
                    "success_rate": round(m.success_rate, 4),
                    "avg_time_ms": round(m.avg_time_ms, 2),
                    "cache_hit_rate": round(m.cache_hit_rate, 4),
                }
                for name, m in stats.component_metrics.items()
            },
        }

    def set_cache_config(self, max_size: int | None = None, ttl: int | None = None) -> None:
        """运行时调整缓存配置

        Args:
            max_size: 新的缓存最大条目数（None表示不修改）
            ttl: 新的缓存过期时间（None表示不修改）
        """
        # 注意：这只是配置更新，现有缓存实例需要重新创建才会生效
        if max_size is not None:
            self._cache._max_size = max_size
        if ttl is not None:
            self._cache._ttl = ttl
        self._logger.info(
            "Cache config updated",
            max_size=max_size,
            ttl=ttl,
        )

    def reset_performance_stats(self) -> None:
        """重置性能统计数据"""
        self._statistics = BuildStatistics()
        self._execution_order_cache.clear()
        self._logger.info("Performance stats reset")

    # ------------------------------------------------------------------------
    # 结果组装
    # ------------------------------------------------------------------------

    def _assemble_result(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> ContextBuildResult:
        """组装构建结果

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            ContextBuildResult: 构建结果
        """
        # 确定构建状态
        failed_count = sum(
            1
            for r in context.component_results.values()
            if r.status == ComponentStatus.FAILED
        )
        degraded_count = sum(
            1 for r in context.component_results.values() if r.degraded
        )

        if failed_count == 0 and degraded_count == 0:
            status = BuildStatus.SUCCESS
        elif failed_count == 0 and degraded_count > 0:
            status = BuildStatus.PARTIAL
        elif failed_count > 0 and len(context.component_results) > failed_count:
            status = BuildStatus.PARTIAL
        else:
            status = BuildStatus.FAILED

        # 计算Token使用量（简单估算）
        total_tokens = 0
        system_tokens = 0
        history_tokens = 0

        for msg in context.messages:
            msg_tokens = len(msg.get("content", "")) // 4 + 10
            total_tokens += msg_tokens
            if msg.get("role") == "system":
                system_tokens += msg_tokens
            elif msg.get("role") in ("user", "assistant"):
                history_tokens += msg_tokens

        # 提取 system_prompt 和 history
        system_prompt = ""
        history: list[dict[str, str]] = []

        for msg in context.messages:
            if msg.get("role") == "system":
                if system_prompt:
                    system_prompt += "\n\n"
                system_prompt += msg.get("content", "")
            else:
                history.append(msg)

        result = ContextBuildResult(
            messages=list(context.messages),
            system_prompt=system_prompt,
            history=history,
            total_tokens=total_tokens,
            system_tokens=system_tokens,
            history_tokens=history_tokens,
            component_results=dict(context.component_results),
            status=status,
            errors=list(context.errors),
            warnings=list(context.warnings),
            request=request,
        )

        return result

    def _build_basic_result(
        self,
        request: ContextBuildRequest,
    ) -> ContextBuildResult:
        """构建基础结果（当编排器未启用时）

        Args:
            request: 构建请求

        Returns:
            ContextBuildResult: 基础结果
        """
        messages = []

        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})

        if request.history:
            messages.extend(request.history)

        messages.append({"role": "user", "content": request.user_input})

        return ContextBuildResult(
            messages=messages,
            system_prompt=request.system_prompt,
            history=request.history or [],
            status=BuildStatus.SUCCESS,
            request=request,
        )

    def _build_empty_result(
        self,
        request: ContextBuildRequest,
    ) -> ContextBuildResult:
        """构建空结果

        Args:
            request: 构建请求

        Returns:
            ContextBuildResult: 空结果
        """
        return ContextBuildResult(
            messages=[],
            status=BuildStatus.FAILED,
            errors=[
                ErrorInfo(
                    error_type="NoComponents",
                    message="No context components available",
                    component="orchestrator",
                )
            ],
            request=request,
        )

    # ------------------------------------------------------------------------
    # 组件管理
    # ------------------------------------------------------------------------

    def register_component(self, component: ContextComponent) -> None:
        """注册组件

        Args:
            component: 要注册的组件
        """
        self._registry.register(component)
        self._logger.info(
            "Component registered",
            component=component.name,
            priority=component.priority,
        )

    def unregister_component(self, name: str) -> bool:
        """注销组件

        Args:
            name: 组件名称

        Returns:
            bool: 是否成功注销
        """
        success = self._registry.unregister(name)
        if success:
            # 同时清理该组件的缓存
            self._cache.invalidate_component(name)
        return success

    def get_component(self, name: str) -> ContextComponent | None:
        """获取组件

        Args:
            name: 组件名称

        Returns:
            ContextComponent | None: 组件实例
        """
        return self._registry.get(name)

    def list_components(self) -> list[str]:
        """列出所有已注册的组件名称

        Returns:
            list[str]: 组件名称列表
        """
        return self._registry.list_names()

    def enable_component(self, name: str) -> bool:
        """启用组件

        Args:
            name: 组件名称

        Returns:
            bool: 是否成功启用
        """
        component = self._registry.get(name)
        if component:
            component.enabled = True
            return True
        return False

    def disable_component(self, name: str) -> bool:
        """禁用组件

        Args:
            name: 组件名称

        Returns:
            bool: 是否成功禁用
        """
        component = self._registry.get(name)
        if component:
            component.enabled = False
            # 清理缓存
            self._cache.invalidate_component(name)
            return True
        return False

    # ------------------------------------------------------------------------
    # 缓存管理
    # ------------------------------------------------------------------------

    def clear_cache(self) -> None:
        """清空所有缓存"""
        self._cache.clear_all()
        self._logger.info("Cache cleared")

    def get_cache_stats(self) -> dict[str, Any]:
        """获取缓存统计

        Returns:
            dict: 缓存统计信息
        """
        metrics = self._cache.get_metrics()
        return {
            "hit_rate": metrics.hit_rate,
            "total_requests": metrics.total_requests,
            "cache_hits": metrics.cache_hits,
            "cache_misses": metrics.cache_misses,
            "cache_size": metrics.cache_size,
            "max_cache_size": metrics.max_cache_size,
            "evictions": metrics.evictions,
        }

    # ------------------------------------------------------------------------
    # 统计管理
    # ------------------------------------------------------------------------

    def get_statistics(self) -> BuildStatistics:
        """获取构建统计信息

        Returns:
            BuildStatistics: 统计信息
        """
        return self._statistics

    def reset_statistics(self) -> None:
        """重置统计信息"""
        self._statistics = BuildStatistics()
        self._logger.info("Statistics reset")

    # ------------------------------------------------------------------------
    # 属性
    # ------------------------------------------------------------------------

    @property
    def enabled(self) -> bool:
        """是否启用"""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置启用状态"""
        self._enabled = value
        self._logger.info("Orchestrator enabled state changed", enabled=value)

    @property
    def component_count(self) -> int:
        """已注册组件数量"""
        return self._registry.count()

    @property
    def use_cache(self) -> bool:
        """是否使用缓存"""
        return self._use_cache

    @use_cache.setter
    def use_cache(self, value: bool) -> None:
        """设置是否使用缓存"""
        self._use_cache = value
        self._logger.info("Cache usage changed", use_cache=value)


# ============================================================================
# 单例模式
# ============================================================================


_orchestrator_instance: UnifiedContextOrchestrator | None = None


def get_orchestrator() -> UnifiedContextOrchestrator:
    """获取编排器单例

    Returns:
        UnifiedContextOrchestrator: 编排器实例
    """
    global _orchestrator_instance
    if _orchestrator_instance is None:
        # 检查环境变量
        enabled = os.environ.get("JIA_BAI_XING_USE_UNIFIED_CONTEXT", "false").lower() == "true"
        _orchestrator_instance = UnifiedContextOrchestrator(enabled=enabled)
    return _orchestrator_instance


def reset_orchestrator() -> None:
    """重置编排器单例（主要用于测试）"""
    global _orchestrator_instance
    _orchestrator_instance = None
