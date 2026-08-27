from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import Any

from agent.core.logger import StructuredLogger
from agent.context.models import (
    BuildContext,
    ComponentDependency,
    ComponentResult,
    ComponentStatus,
    ContextBuildRequest,
    ErrorInfo,
)

log = StructuredLogger("context_component")


# ============================================================================
# 组件基类
# ============================================================================


class ContextComponent(ABC):
    """上下文组件抽象基类

    所有上下文组件都必须继承此类，实现核心接口方法。
    """

    def __init__(self) -> None:
        self._enabled: bool = True
        self._version: str = "1.0.0"
        self._logger: StructuredLogger | None = None

    def _ensure_logger(self) -> StructuredLogger:
        if self._logger is None:
            self._logger = StructuredLogger(f"component.{self.name}")
        return self._logger

    @property
    @abstractmethod
    def name(self) -> str:
        """组件名称（唯一标识）

        Returns:
            str: 组件名称
        """
        pass

    @property
    @abstractmethod
    def priority(self) -> int:
        """组件优先级

        数字越小，优先级越高，越早执行。
        建议使用 ComponentPriority 中的常量。

        Returns:
            int: 优先级数值
        """
        pass

    @property
    def dependencies(self) -> list[ComponentDependency]:
        """组件依赖列表

        Returns:
            list[ComponentDependency]: 依赖的组件列表
        """
        return []

    @property
    def version(self) -> str:
        """组件版本号

        Returns:
            str: 版本号
        """
        return self._version

    @property
    def enabled(self) -> bool:
        """组件是否启用

        Returns:
            bool: 是否启用
        """
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """设置组件启用状态

        Args:
            value: 是否启用
        """
        self._enabled = value
        log.info(
            "Component enabled state changed",
            component=self.name,
            enabled=value,
        )

    def can_handle(self, request: ContextBuildRequest) -> bool:
        """判断当前组件是否需要处理该请求

        子类可以重写此方法，根据请求内容判断是否需要执行。
        性能优化：默认实现直接返回启用状态，避免额外计算。

        Args:
            request: 构建请求

        Returns:
            bool: 是否需要执行
        """
        return self._enabled

    async def execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> ComponentResult:
        """执行组件逻辑（包装方法，包含错误处理）

        子类不应直接重写此方法，而应重写 _execute 方法。

        性能优化：
        - 快速路径：禁用/跳过的组件快速返回
        - 延迟创建：只在需要时创建完整的结果对象
        - 减少日志：调试日志有条件输出

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            ComponentResult: 执行结果
        """
        # 快速路径1：组件未启用
        if not self._enabled:
            return ComponentResult(
                component_name=self.name,
                status=ComponentStatus.DISABLED,
                execution_time_ms=0.0,
            )

        # 快速路径2：不需要处理
        if not self.can_handle(request):
            return ComponentResult(
                component_name=self.name,
                status=ComponentStatus.SKIPPED,
                execution_time_ms=0.0,
            )

        start_time = time.time()
        result = ComponentResult(component_name=self.name)
        result.status = ComponentStatus.RUNNING

        try:
            # 执行实际逻辑
            output = await self._execute(request, context)

            result.status = ComponentStatus.SUCCESS
            result.output = output or {}

        except Exception as e:
            log.debug("base 异常处理", error=str(e))
            error_info = ErrorInfo(
                error_type=type(e).__name__,
                message=str(e),
                component=self.name,
                recoverable=True,
            )
            result.status = ComponentStatus.FAILED
            result.error = error_info

            log.error(
                "Component execution failed",
                component=self.name,
                error_type=error_info.error_type,
                error_message=error_info.message,
            )

        finally:
            result.execution_time_ms = (time.time() - start_time) * 1000

        return result

    @abstractmethod
    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict[str, Any] | None:
        """执行组件的实际逻辑（子类实现）

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            dict[str, Any] | None: 组件输出数据
        """
        pass

    def cleanup(self) -> None:
        """清理组件资源

        子类可以重写此方法进行资源清理。
        """
        pass

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} name={self.name} priority={self.priority}>"


# ============================================================================
# 组件注册器
# ============================================================================


class ComponentRegistry:
    """组件注册器

    负责组件的注册、注销、查询和排序。
    """

    def __init__(self) -> None:
        self._components: dict[str, ContextComponent] = {}
        self._logger = StructuredLogger("component_registry")

    def register(self, component: ContextComponent) -> None:
        """注册组件

        Args:
            component: 要注册的组件

        Raises:
            ValueError: 如果组件名称已存在
        """
        if component.name in self._components:
            raise ValueError(f"Component '{component.name}' already registered")

        self._components[component.name] = component
        self._logger.debug(
            "Component registered",
            component=component.name,
            priority=component.priority,
            version=component.version,
        )

    def unregister(self, name: str) -> bool:
        """注销组件

        Args:
            name: 组件名称

        Returns:
            bool: 是否成功注销
        """
        if name not in self._components:
            self._logger.warning(
                "Component not found for unregistration",
                component=name,
            )
            return False

        component = self._components.pop(name)
        component.cleanup()

        self._logger.info("Component unregistered", component=name)
        return True

    def get(self, name: str) -> ContextComponent | None:
        """获取组件

        Args:
            name: 组件名称

        Returns:
            ContextComponent | None: 组件实例，如果不存在则返回None
        """
        return self._components.get(name)

    def has(self, name: str) -> bool:
        """检查组件是否存在

        Args:
            name: 组件名称

        Returns:
            bool: 是否存在
        """
        return name in self._components

    def list_all(self) -> list[ContextComponent]:
        """列出所有组件

        Returns:
            list[ContextComponent]: 所有组件列表（未排序）
        """
        return list(self._components.values())

    def list_names(self) -> list[str]:
        """列出所有组件名称

        Returns:
            list[str]: 组件名称列表
        """
        return list(self._components.keys())

    def get_by_priority(self) -> list[ContextComponent]:
        """按优先级排序获取所有组件

        Returns:
            list[ContextComponent]: 按优先级排序的组件列表
        """
        return sorted(self._components.values(), key=lambda c: c.priority)

    def get_enabled(self) -> list[ContextComponent]:
        """获取所有启用的组件（按优先级排序）

        Returns:
            list[ContextComponent]: 启用的组件列表
        """
        return [c for c in self.get_by_priority() if c.enabled]

    def count(self) -> int:
        """获取已注册组件数量

        Returns:
            int: 组件数量
        """
        return len(self._components)

    def clear(self) -> None:
        """清空所有组件"""
        for component in self._components.values():
            component.cleanup()
        self._components.clear()
        self._logger.info("All components cleared")


# ============================================================================
# 依赖解析器
# ============================================================================


class DependencyResolver:
    """组件依赖解析器

    负责解析组件间的依赖关系，进行拓扑排序，检测循环依赖等。
    """

    def __init__(self) -> None:
        self._logger = StructuredLogger("dependency_resolver")

    def resolve_execution_order(
        self,
        components: list[ContextComponent],
    ) -> list[ContextComponent]:
        """解析组件执行顺序（拓扑排序）

        基于优先级和依赖关系进行排序。
        优先级是主要排序依据，依赖是次要约束。

        Args:
            components: 组件列表

        Returns:
            list[ContextComponent]: 排序后的组件列表

        Raises:
            ValueError: 如果存在循环依赖
        """
        # 先按优先级排序
        sorted_by_priority = sorted(components, key=lambda c: c.priority)

        # 检查依赖并调整顺序
        name_to_component = {c.name: c for c in sorted_by_priority}
        ordered: list[ContextComponent] = []
        visited: set[str] = set()
        visiting: set[str] = set()

        def visit(component: ContextComponent) -> None:
            if component.name in visited:
                return
            if component.name in visiting:
                raise ValueError(
                    f"Circular dependency detected involving '{component.name}'"
                )

            visiting.add(component.name)

            # 先访问所有依赖
            for dep in component.dependencies:
                if dep.component_name in name_to_component:
                    visit(name_to_component[dep.component_name])

            visiting.remove(component.name)
            visited.add(component.name)
            ordered.append(component)

        for component in sorted_by_priority:
            visit(component)

        return ordered

    def check_dependencies(
        self,
        components: list[ContextComponent],
    ) -> dict[str, list[str]]:
        """检查依赖是否满足

        Args:
            components: 组件列表

        Returns:
            dict[str, list[str]]: 缺失的依赖（组件名 -> 缺失的依赖列表）
        """
        component_names = {c.name for c in components}
        missing: dict[str, list[str]] = {}

        for component in components:
            missing_deps = []
            for dep in component.dependencies:
                if dep.required and dep.component_name not in component_names:
                    missing_deps.append(dep.component_name)

            if missing_deps:
                missing[component.name] = missing_deps

        return missing

    def detect_circular_dependencies(
        self,
        components: list[ContextComponent],
    ) -> list[list[str]]:
        """检测循环依赖

        Args:
            components: 组件列表

        Returns:
            list[list[str]]: 检测到的循环依赖列表
        """
        cycles: list[list[str]] = []
        name_to_component = {c.name: c for c in components}
        visited: set[str] = set()
        stack: list[str] = []

        def dfs(node: str) -> None:
            if node in stack:
                # 找到循环
                cycle_start = stack.index(node)
                cycle = stack[cycle_start:] + [node]
                cycles.append(cycle)
                return

            if node in visited:
                return

            visited.add(node)
            stack.append(node)

            component = name_to_component.get(node)
            if component:
                for dep in component.dependencies:
                    dfs(dep.component_name)

            stack.pop()

        for component in components:
            dfs(component.name)

        return cycles

    def get_dependents(
        self,
        component_name: str,
        components: list[ContextComponent],
    ) -> list[str]:
        """获取依赖于指定组件的所有组件

        Args:
            component_name: 组件名称
            components: 所有组件列表

        Returns:
            list[str]: 依赖于该组件的组件名称列表
        """
        dependents = []
        for component in components:
            for dep in component.dependencies:
                if dep.component_name == component_name:
                    dependents.append(component.name)
                    break
        return dependents
