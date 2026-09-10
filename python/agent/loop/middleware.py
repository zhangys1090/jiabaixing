"""LoopController 中间件系统 — V6.0 架构增强

将 run() 中散落的上下文注入逻辑统一为可插拔中间件，
支持 before_loop / after_loop / before_step / after_step 四个钩子。
"""

from __future__ import annotations

import time
from typing import Any, Protocol, runtime_checkable

from agent.loop.types import LoopContext
from agent.core.logger import StructuredLogger, log_ignored
log = StructuredLogger("middleware")



@runtime_checkable
class LoopMiddleware(Protocol):
    """LoopController 中间件协议。"""

    name: str

    async def before_loop(self, context: LoopContext) -> LoopContext:
        """循环开始前 — 注入上下文、校验输入等。"""
        ...

    async def after_loop(self, context: LoopContext, result: Any) -> Any:
        """循环结束后 — 后处理、记录等。"""
        ...

    async def before_step(self, context: LoopContext, step_index: int) -> LoopContext:
        """每步执行前 — 注入步骤级上下文。"""
        ...

    async def after_step(self, context: LoopContext, step_index: int, step_result: Any) -> Any:
        """每步执行后 — 收集反馈、校验结果等。"""
        ...


class KnowledgeInjectMiddleware:
    """P1-2: 知识上下文注入中间件。"""

    name = "knowledge_inject"

    def __init__(self, knowledge_lifecycle: Any | None = None) -> None:
        self._knowledge_lifecycle = knowledge_lifecycle

    async def before_loop(self, context: LoopContext) -> LoopContext:
        if not self._knowledge_lifecycle:
            return context
        try:
            knowledge_results = await self._knowledge_lifecycle.retrieve(
                context.user_input, top_k=3, min_confidence=0.4,
            )
            if knowledge_results:
                knowledge_text = "\n".join(
                    f"- {r.entry.content} (置信度:{r.entry.confidence:.0%})"
                    for r in knowledge_results
                )
                context.messages.insert(0, {
                    "role": "system",
                    "content": f"【相关历史知识】\n{knowledge_text}",
                })
        except Exception as _exc:
            log.debug("middleware 异常处理", error=str(_exc))
            log_ignored(log, "middleware.KnowledgeInject.before_loop", _exc)
        return context

    async def after_loop(self, context: LoopContext, result: Any) -> Any:
        return result

    async def before_step(self, context: LoopContext, step_index: int) -> LoopContext:
        return context

    async def after_step(self, context: LoopContext, step_index: int, step_result: Any) -> Any:
        return step_result


class PerceptionInjectMiddleware:
    """P1-1: 感知上下文注入中间件。"""

    name = "perception_inject"

    def __init__(self, perception_loop: Any | None = None) -> None:
        self._perception_loop = perception_loop

    async def before_loop(self, context: LoopContext) -> LoopContext:
        if not self._perception_loop:
            return context
        try:
            watcher = getattr(self._perception_loop, "_watcher", None)
            if watcher is not None and hasattr(watcher, "get_events"):
                recent_events = watcher.get_events(limit=3)
                if recent_events:
                    event_text = "\n".join(
                        f"- [{time.strftime('%H:%M:%S', time.localtime(e.timestamp))}] "
                        f"屏幕变化 (差异度:{e.diff_score:.1%}, 区域数:{len(e.changed_regions)})"
                        for e in recent_events
                    )
                    context.messages.insert(0, {
                        "role": "system",
                        "content": f"【最近屏幕变化】\n{event_text}",
                    })
        except Exception as _exc:
            log.debug("middleware 异常处理", error=str(_exc))
            log_ignored(log, "middleware.PerceptionInject.before_loop", _exc)
        return context

    async def after_loop(self, context: LoopContext, result: Any) -> Any:
        return result

    async def before_step(self, context: LoopContext, step_index: int) -> LoopContext:
        return context

    async def after_step(self, context: LoopContext, step_index: int, step_result: Any) -> Any:
        return step_result


class WorkflowInjectMiddleware:
    """P0-2: 工作流状态注入中间件。"""

    name = "workflow_inject"

    def __init__(self, workflow_engine: Any | None = None) -> None:
        self._workflow_engine = workflow_engine

    async def before_loop(self, context: LoopContext) -> LoopContext:
        if not self._workflow_engine:
            return context
        try:
            store = getattr(self._workflow_engine, "_store", None)
            if store is not None and hasattr(store, "list_instances"):
                active_instances = store.list_instances(status="running")
                if active_instances:
                    wf_text = "\n".join(
                        f"- 工作流 {inst.definition_id} (实例:{inst.id[:8]}, "
                        f"步骤:{inst.current_step_index}/{len(inst.step_statuses)})"
                        for inst in active_instances[:5]
                        if hasattr(inst, "definition_id")
                    )
                    if wf_text:
                        context.messages.insert(0, {
                            "role": "system",
                            "content": f"【活跃工作流】\n{wf_text}",
                        })
        except Exception as _exc:
            log.debug("middleware 异常处理", error=str(_exc))
            log_ignored(log, "middleware.WorkflowInject.before_loop", _exc)
        return context

    async def after_loop(self, context: LoopContext, result: Any) -> Any:
        return result

    async def before_step(self, context: LoopContext, step_index: int) -> LoopContext:
        return context

    async def after_step(self, context: LoopContext, step_index: int, step_result: Any) -> Any:
        return step_result


class McpResourceInjectMiddleware:
    """P1-3: MCP 资源变更注入中间件。"""

    name = "mcp_resource_inject"

    def __init__(self, mcp_resource_events: list[Any] | None = None) -> None:
        self._mcp_resource_events = mcp_resource_events

    async def before_loop(self, context: LoopContext) -> LoopContext:
        if not self._mcp_resource_events:
            return context
        try:
            recent_resource_events = list(self._mcp_resource_events)[-5:]
            if recent_resource_events:
                res_text = "\n".join(
                    f"- [{time.strftime('%H:%M:%S', time.localtime(e.timestamp))}] "
                    f"资源变更: {e.uri} ({e.action})"
                    for e in recent_resource_events
                )
                context.messages.insert(0, {
                    "role": "system",
                    "content": f"【MCP 资源变更】\n{res_text}",
                })
        except Exception as _exc:
            log.debug("middleware 异常处理", error=str(_exc))
            log_ignored(log, "middleware.McpResourceInject.before_loop", _exc)
        return context

    async def after_loop(self, context: LoopContext, result: Any) -> Any:
        return result

    async def before_step(self, context: LoopContext, step_index: int) -> LoopContext:
        return context

    async def after_step(self, context: LoopContext, step_index: int, step_result: Any) -> Any:
        return step_result


class SandboxAuditMiddleware:
    """Phase 3+4: 沙箱审计中间件 — 将沙箱健康状态和指标注入主循环上下文。

    before_loop: 执行沙箱健康检查，将结果注入 context.metadata。
    after_loop: 采集沙箱指标快照，记录到 context.metadata。
    """

    name = "sandbox_audit"

    def __init__(self, enabled: bool = True) -> None:
        self._enabled = enabled
        self._last_health_check: dict[str, Any] = {}

    async def before_loop(self, context: LoopContext) -> LoopContext:
        if not self._enabled:
            return context
        try:
            from agent.sandbox.kernel_isolation import KernelIsolationProvider
            health = await KernelIsolationProvider.health_check(force=False)
            available_backends = [
                k.value for k, v in health.items() if v.available
            ]
            degraded_backends = [
                k.value for k, v in health.items()
                if not v.available and v.consecutive_failures > 0
            ]
            self._last_health_check = {
                "available": available_backends,
                "degraded": degraded_backends,
                "timestamp": time.time(),
            }
            context.metadata["sandbox_health"] = self._last_health_check
            if degraded_backends:
                context.messages.insert(0, {
                    "role": "system",
                    "content": f"【沙箱审计】后端降级: {', '.join(degraded_backends)}",
                })
        except Exception as _exc:
            log.debug("middleware 异常处理", error=str(_exc))
            log_ignored(log, "middleware.SandboxAudit.before_loop", _exc)
        return context

    async def after_loop(self, context: LoopContext, result: Any) -> Any:
        if not self._enabled:
            return result
        try:
            from agent.sandbox.kernel_isolation import KernelIsolationProvider
            metrics = KernelIsolationProvider.get_metrics()
            context.metadata["sandbox_metrics"] = metrics.to_dict()
        except Exception as _exc:
            log.debug("middleware 异常处理", error=str(_exc))
            log_ignored(log, "middleware.SandboxAudit.after_loop", _exc)
        return result

    async def before_step(self, context: LoopContext, step_index: int) -> LoopContext:
        return context

    async def after_step(self, context: LoopContext, step_index: int, step_result: Any) -> Any:
        return step_result


class MiddlewarePipeline:
    """中间件管道 — 按注册顺序执行 before_*, 按逆序执行 after_*。"""

    def __init__(self) -> None:
        self._middlewares: list[LoopMiddleware] = []

    def use(self, middleware: LoopMiddleware) -> "MiddlewarePipeline":
        self._middlewares.append(middleware)
        return self

    @property
    def names(self) -> list[str]:
        return [m.name for m in self._middlewares]

    async def before_loop(self, context: LoopContext) -> LoopContext:
        for mw in self._middlewares:
            context = await mw.before_loop(context)
        return context

    async def after_loop(self, context: LoopContext, result: Any) -> Any:
        for mw in reversed(self._middlewares):
            result = await mw.after_loop(context, result)
        return result

    async def before_step(self, context: LoopContext, step_index: int) -> LoopContext:
        for mw in self._middlewares:
            context = await mw.before_step(context, step_index)
        return context

    async def after_step(self, context: LoopContext, step_index: int, step_result: Any) -> Any:
        for mw in reversed(self._middlewares):
            step_result = await mw.after_step(context, step_index, step_result)
        return step_result
