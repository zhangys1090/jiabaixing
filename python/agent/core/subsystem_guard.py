"""子系统降级守卫 — 防止访问未初始化子系统时抛出无意义 AttributeError。

核心机制：
1. SubsystemNotReadyError — 结构化错误，包含子系统名、调用者、修复提示
2. require_subsystem(name) — 装饰器，在方法调用前检查子系统是否可用
3. AgentEngine._degraded_subsystems — 集合，记录初始化失败的子系统
4. AgentEngine.is_subsystem_available(name) — 查询接口，供健康检查和路由层判断

使用示例::

    class AgentEngine:
        @require_subsystem("loop")
        async def chat(self, message, **kwargs):
            return await self.loop.run(message, **kwargs)

        @require_subsystem("memory")
        async def recall(self, query):
            return await self.memory.search(query)

当 self.loop 为 None 时，chat() 抛出 SubsystemNotReadyError 而非 AttributeError。
"""

from __future__ import annotations

import functools
from typing import Any, Callable, TypeVar

from agent.core.logger import StructuredLogger

T = TypeVar("T")
log = StructuredLogger("subsystem_guard")


class SubsystemNotReadyError(RuntimeError):
    """子系统未就绪错误 — 结构化，包含诊断信息。

    Attributes:
        subsystem: 未就绪的子系统名称
        caller: 调用方方法名
        hint: 修复提示
    """

    def __init__(
        self,
        subsystem: str,
        caller: str = "",
        hint: str = "",
    ) -> None:
        self.subsystem = subsystem
        self.caller = caller
        self.hint = hint or f"子系统 '{subsystem}' 初始化失败或未启用，请检查启动日志"
        msg = f"SubsystemNotReady[{subsystem}]"
        if caller:
            msg += f" called by {caller}"
        super().__init__(msg)


def require_subsystem(name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """属性访问守卫装饰器 — 子系统未初始化时抛出 SubsystemNotReadyError。

    Args:
        name: 子系统属性名（对应 AgentEngine 上的属性名）

    Returns:
        装饰器函数

    使用::

        @require_subsystem("loop")
        async def chat(self, message, **kwargs):
            return await self.loop.run(message, **kwargs)
    """

    def decorator(method: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(method)
        async def async_wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
            subsystem = getattr(self, name, None)
            if subsystem is None:
                degraded: set[str] = getattr(self, "_degraded_subsystems", set())
                hint = (
                    f"子系统 '{name}' 初始化失败（已降级），请检查启动日志中 '{name}' 相关错误"
                    if name in degraded
                    else f"子系统 '{name}' 未初始化，请确认配置是否启用"
                )
                raise SubsystemNotReadyError(
                    subsystem=name,
                    caller=f"{type(self).__name__}.{method.__name__}",
                    hint=hint,
                )
            return await method(self, *args, **kwargs)

        @functools.wraps(method)
        def sync_wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
            subsystem = getattr(self, name, None)
            if subsystem is None:
                degraded: set[str] = getattr(self, "_degraded_subsystems", set())
                hint = (
                    f"子系统 '{name}' 初始化失败（已降级），请检查启动日志中 '{name}' 相关错误"
                    if name in degraded
                    else f"子系统 '{name}' 未初始化，请确认配置是否启用"
                )
                raise SubsystemNotReadyError(
                    subsystem=name,
                    caller=f"{type(self).__name__}.{method.__name__}",
                    hint=hint,
                )
            return method(self, *args, **kwargs)

        import asyncio
        if asyncio.iscoroutinefunction(method):
            return async_wrapper
        return sync_wrapper

    return decorator


class DegradedSubsystemTracker:
    """降级子系统追踪器 — 独立于 AgentEngine，可被外部查询。

    使用::

        tracker = DegradedSubsystemTracker()

        # 初始化时登记降级
        tracker.mark_degraded("memory", reason="Redis unavailable")

        # 运行时查询
        if tracker.is_available("memory"):
            await engine.memory.search(query)
        else:
            return "记忆功能暂不可用"

        # 健康检查
        report = tracker.health_report()
    """

    def __init__(self) -> None:
        self._degraded: dict[str, str] = {}

    def mark_degraded(self, name: str, reason: str = "") -> None:
        """标记子系统已降级。

        Args:
            name: 子系统名称
            reason: 降级原因
        """
        self._degraded[name] = reason
        log.warning("Subsystem degraded", subsystem=name, reason=reason)

    def mark_available(self, name: str) -> None:
        """标记子系统已恢复可用。

        Args:
            name: 子系统名称
        """
        if name in self._degraded:
            del self._degraded[name]
            log.info("Subsystem recovered", subsystem=name)

    def is_available(self, name: str) -> bool:
        """检查子系统是否可用。

        Args:
            name: 子系统名称

        Returns:
            True 表示可用，False 表示已降级
        """
        return name not in self._degraded

    @property
    def degraded_names(self) -> set[str]:
        """当前所有降级子系统的名称集合。"""
        return set(self._degraded.keys())

    def health_report(self) -> dict[str, Any]:
        """生成健康报告。

        Returns:
            包含 degraded_count、degraded_subsystems、all_healthy 的字典
        """
        return {
            "degraded_count": len(self._degraded),
            "degraded_subsystems": dict(self._degraded),
            "all_healthy": len(self._degraded) == 0,
        }


_global_tracker = DegradedSubsystemTracker()


def get_degraded_tracker() -> DegradedSubsystemTracker:
    """获取全局降级追踪器单例。"""
    return _global_tracker
