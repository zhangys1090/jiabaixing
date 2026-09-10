from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger
log = StructuredLogger("hooks")


HookEvent = str

HookCallback = Callable[..., Awaitable[Any] | Any]

BEFORE_TOOL_CALL: HookEvent = "beforeToolCall"
AFTER_TOOL_CALL: HookEvent = "afterToolCall"
ON_TOOL_ERROR: HookEvent = "onToolError"
BEFORE_LOOP: HookEvent = "beforeLoop"
AFTER_LOOP: HookEvent = "afterLoop"
ON_BUDGET_EXCEEDED: HookEvent = "onBudgetExceeded"
ON_CONSTRAINT_VIOLATION: HookEvent = "onConstraintViolation"
ON_SESSION_START: HookEvent = "onSessionStart"
ON_SESSION_END: HookEvent = "onSessionEnd"


@dataclass
class HookRegistration:
    """钩子注册信息。

    Attributes:
        event: 钩子事件类型。
        callback: 回调函数。
        hook_type: 钩子类型（gateway/plugin/lifecycle）。
        priority: 优先级（数字越小越先执行）。
        enabled: 是否启用。
        label: 标签，便于调试。
    """

    event: HookEvent
    callback: HookCallback
    hook_type: str = "plugin"
    priority: int = 100
    enabled: bool = True
    label: str = ""


class HookManager:
    """统一钩子管理器——管理gateway/plugin/lifecycle三种钩子。

    支持事件驱动的钩子注册与触发，按优先级排序执行。
    所有钩子执行失败不影响主流程（fail-safe）。

    Usage:
        manager = HookManager()

        async def my_logger(ctx):
            logger.info("Tool called: {ctx.get('tool_name')}")

        manager.on("beforeToolCall", my_logger, hook_type="gateway")
        await manager.trigger("beforeToolCall", tool_name="search")
    """

    def __init__(self) -> None:
        self._registrations: list[HookRegistration] = []
        self._MAX_REGISTRATIONS = 500

    def on(
        self,
        event: HookEvent,
        callback: HookCallback,
        hook_type: str = "plugin",
        priority: int = 100,
        label: str = "",
    ) -> None:
        """注册钩子。

        Args:
            event: 钩子事件类型。
            callback: 回调函数，接收关键字参数。
            hook_type: 钩子类型（gateway/plugin/lifecycle）。
            priority: 优先级（数字越小越先执行）。
            label: 调试标签。
        """
        self._registrations.append(
            HookRegistration(
                event=event,
                callback=callback,
                hook_type=hook_type,
                priority=priority,
                label=label or callback.__name__,
            )
        )
        if len(self._registrations) > self._MAX_REGISTRATIONS:
            self._registrations = self._registrations[-(self._MAX_REGISTRATIONS * 3 // 4):]
        self._registrations.sort(key=lambda r: (r.priority, r.label))

    def off(self, event: HookEvent, callback: HookCallback) -> bool:
        """移除钩子注册。

        Args:
            event: 钩子事件类型。
            callback: 回调函数。

        Returns:
            bool: 是否成功移除。
        """
        initial_len = len(self._registrations)
        self._registrations = [
            r
            for r in self._registrations
            if not (r.event == event and r.callback == callback)
        ]
        return len(self._registrations) < initial_len

    def off_all(self, event: HookEvent | None = None) -> int:
        """移除所有注册的钩子。

        Args:
            event: 指定事件类型则只移除该事件，None则移除全部。

        Returns:
            int: 移除的钩子数量。
        """
        initial_len = len(self._registrations)
        if event is None:
            self._registrations = []
        else:
            self._registrations = [r for r in self._registrations if r.event != event]
        return initial_len - len(self._registrations)

    async def trigger(self, event: HookEvent, **kwargs: Any) -> None:
        """触发指定事件的所有钩子。

        钩子执行失败不影响其他钩子和主流程。

        Args:
            event: 钩子事件类型。
            **kwargs: 传递给回调函数的上下文参数。
        """
        matching = [r for r in self._registrations if r.event == event and r.enabled]

        for reg in matching:
            try:
                result = reg.callback(**kwargs)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as e:
                log.warning(f"钩子执行失败: {reg.label} ({reg.hook_type})", error=str(e))

    def get_registrations(self) -> list[HookRegistration]:
        """获取所有注册的钩子。

        Returns:
            list[HookRegistration]: 钩子注册列表。
        """
        return list(self._registrations)

    def get_by_type(self, hook_type: str) -> list[HookRegistration]:
        """按钩子类型获取注册列表。

        Args:
            hook_type: 钩子类型（gateway/plugin/lifecycle）。

        Returns:
            list[HookRegistration]: 匹配的钩子注册列表。
        """
        return [r for r in self._registrations if r.hook_type == hook_type]

    def enable(self, event: HookEvent, callback: HookCallback) -> bool:
        """启用指定钩子。

        Args:
            event: 钩子事件类型。
            callback: 回调函数。

        Returns:
            bool: 是否成功启用。
        """
        for reg in self._registrations:
            if reg.event == event and reg.callback == callback:
                reg.enabled = True
                return True
        return False

    def disable(self, event: HookEvent, callback: HookCallback) -> bool:
        """禁用指定钩子。

        Args:
            event: 钩子事件类型。
            callback: 回调函数。

        Returns:
            bool: 是否成功禁用。
        """
        for reg in self._registrations:
            if reg.event == event and reg.callback == callback:
                reg.enabled = False
                return True
        return False