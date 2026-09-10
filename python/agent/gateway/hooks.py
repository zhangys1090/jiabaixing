"""网关 Hook 系统。

在消息分发前后插入用户自定义 Hook，实现扩展逻辑：
  - 消息预处理（内容过滤、格式转换、敏感词替换）
  - 消息后处理（日志记录、通知推送、统计计数）
  - 命令拦截（斜杠命令路由）
  - 错误处理（自定义错误恢复策略）

与 MessageDispatcher 的集成点：
  - dispatch() 前 → pre_dispatch hooks
  - dispatch() 后 → post_dispatch hooks
  - broadcast() 前 → pre_broadcast hooks
  - 异常时 → on_error hooks

集成示例::

    from agent.gateway.hooks import HookManager, HookPoint

    hooks = HookManager()

    @hooks.register(HookPoint.PRE_DISPATCH)
    async def log_incoming(message, **kwargs):
        logger.info("[IN] {message.platform}: {message.content[:50]}")

    @hooks.register(HookPoint.POST_DISPATCH)
    async def log_outgoing(message, result, **kwargs):
        logger.info("[OUT] result: {result[:50]}")
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.gateway.base import Message
from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.hooks")


class HookPoint(str, Enum):
    PRE_DISPATCH = "pre_dispatch"
    POST_DISPATCH = "post_dispatch"
    PRE_BROADCAST = "pre_broadcast"
    POST_BROADCAST = "post_broadcast"
    ON_ERROR = "on_error"
    ON_CONNECT = "on_connect"
    ON_DISCONNECT = "on_disconnect"
    ON_MESSAGE_TRANSFORM = "on_message_transform"


@dataclass
class HookInfo:
    name: str
    point: HookPoint
    callback: Callable[..., Awaitable[Any]]
    priority: int = 0
    enabled: bool = True
    call_count: int = 0
    total_duration_ms: float = 0.0
    last_error: str = ""


@dataclass
class HookContext:
    message: Message | None = None
    result: str = ""
    error: Exception | None = None
    platform: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class HookExecutionResult:
    hook_name: str
    success: bool
    duration_ms: float
    error: str = ""
    modified_message: Message | None = None
    modified_result: str = ""


class HookManager:
    """网关 Hook 管理器。

    管理生命周期 Hook 的注册、发现和执行。
    Hook 按 priority 排序执行（数值越小越先执行）。
    """

    def __init__(self) -> None:
        self._hooks: dict[HookPoint, list[HookInfo]] = defaultdict(list)
        self._by_name: dict[str, HookInfo] = {}
        self._global_enabled: bool = True

    def register(
        self,
        point: HookPoint,
        name: str = "",
        priority: int = 0,
    ) -> Callable:
        """装饰器方式注册 Hook。

        Usage::

            @hooks.register(HookPoint.PRE_DISPATCH, name="content_filter", priority=10)
            async def filter_content(message, **kwargs):
                message.content = message.content.replace("bad_word", "***")
                return message
        """
        def decorator(func: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
            hook_name = name or func.__name__
            info = HookInfo(name=hook_name, point=point, callback=func, priority=priority)
            self._hooks[point].append(info)
            self._by_name[hook_name] = info
            self._hooks[point].sort(key=lambda h: h.priority)
            log.debug("Hook 已注册", name=hook_name, point=point.value, priority=priority)
            return func
        return decorator

    def add_hook(
        self,
        point: HookPoint,
        callback: Callable[..., Awaitable[Any]],
        name: str = "",
        priority: int = 0,
    ) -> str:
        """编程方式注册 Hook。"""
        hook_name = name or callback.__name__ or f"hook_{len(self._by_name)}"
        info = HookInfo(name=hook_name, point=point, callback=callback, priority=priority)
        self._hooks[point].append(info)
        self._by_name[hook_name] = info
        self._hooks[point].sort(key=lambda h: h.priority)
        return hook_name

    def remove_hook(self, name: str) -> bool:
        info = self._by_name.pop(name, None)
        if info is None:
            return False
        hooks_list = self._hooks.get(info.point, [])
        self._hooks[info.point] = [h for h in hooks_list if h.name != name]
        log.info("Hook 已移除", name=name)
        return True

    def enable_hook(self, name: str) -> None:
        if name in self._by_name:
            self._by_name[name].enabled = True

    def disable_hook(self, name: str) -> None:
        if name in self._by_name:
            self._by_name[name].enabled = False

    def enable_all(self) -> None:
        self._global_enabled = True

    def disable_all(self) -> None:
        self._global_enabled = False

    async def execute(
        self,
        point: HookPoint,
        context: HookContext | None = None,
        **kwargs: Any,
    ) -> HookContext:
        """执行指定点的所有 Hook。"""
        if not self._global_enabled or point not in self._hooks:
            return context or HookContext()

        ctx = context or HookContext()
        for info in self._hooks[point]:
            if not info.enabled:
                continue

            start = time.monotonic()
            try:
                result = await info.callback(ctx, **kwargs)
                duration = (time.monotonic() - start) * 1000
                info.call_count += 1
                info.total_duration_ms += duration

                if result is not None:
                    if isinstance(result, Message):
                        ctx.message = result
                    elif isinstance(result, str):
                        ctx.result = result
                    elif isinstance(result, HookContext):
                        ctx = result
            except Exception as e:
                log.debug("hooks 异常处理", error=str(e))
                duration = (time.monotonic() - start) * 1000
                info.last_error = str(e)
                info.call_count += 1
                info.total_duration_ms += duration
                log.error(
                    "Hook 执行失败",
                    name=info.name,
                    point=point.value,
                    error=str(e),
                )

        return ctx

    async def execute_pre_dispatch(self, message: Message, **kwargs: Any) -> Message:
        ctx = HookContext(message=message)
        result_ctx = await self.execute(HookPoint.PRE_DISPATCH, ctx, **kwargs)
        return result_ctx.message or message

    async def execute_post_dispatch(self, message: Message, result: str, **kwargs: Any) -> str:
        ctx = HookContext(message=message, result=result)
        result_ctx = await self.execute(HookPoint.POST_DISPATCH, ctx, **kwargs)
        return result_ctx.result

    async def execute_on_error(self, message: Message, error: Exception, **kwargs: Any) -> HookContext:
        ctx = HookContext(message=message, error=error)
        return await self.execute(HookPoint.ON_ERROR, ctx, **kwargs)

    def get_hooks(self, point: HookPoint | None = None) -> list[HookInfo]:
        if point:
            return list(self._hooks.get(point, []))
        all_hooks: list[HookInfo] = []
        for hooks_list in self._hooks.values():
            all_hooks.extend(hooks_list)
        return all_hooks

    def get_stats(self) -> dict[str, Any]:
        stats: dict[str, Any] = {}
        for point, hooks_list in self._hooks.items():
            point_stats = []
            for info in hooks_list:
                point_stats.append({
                    "name": info.name,
                    "enabled": info.enabled,
                    "priority": info.priority,
                    "call_count": info.call_count,
                    "avg_duration_ms": info.total_duration_ms / info.call_count if info.call_count > 0 else 0,
                    "last_error": info.last_error,
                })
            stats[point.value] = point_stats
        return stats
