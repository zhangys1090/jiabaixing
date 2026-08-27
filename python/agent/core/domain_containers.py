"""域容器 — AgentEngine God Object 拆分的核心机制。

将 AgentEngine 的 100+ 子系统属性按功能域分组，每个域由独立的 DomainContainer 管理。
AgentEngine 退化为域门面，通过属性委托访问各域子系统。

V6.0 设计:
1. 域容器从"数据持有者"升级为"行为协议实现者" — 每个域定义自己的行为接口
2. LoopProtocol 统一执行策略 — ReAct/PlanExecEval/MultiAgent 实现同一协议
3. DomainEventBus 域间通信 — 替代隐式 self.engine.xxx 属性引用
4. 向后兼容：AgentEngine 保留 __getattr__/__setattr__ 代理

域划分:
- CoreDomain: 核心AI能力（LLM + Memory + Loop + Evolution）— 行为协议: invoke/reflect
- ToolDomain: 工具域能力（Registry + Permission + Schema + MCP + Approval）— 行为协议: execute/validate
- ContextDomain: 上下文域能力（Manager + Compressor + Window + References + Persona）— 行为协议: build/compress
- SecurityDomain: 安全域能力（Guard + Guardrail + Posture + Redaction + Path/URL/SSL）— 行为协议: check/redact
- PersistenceDomain: 持久化域能力（Session + Trajectory + Flywheel + Curator）— 行为协议: save/load
- OrchestrationDomain: 编排域能力（A2A + MultiAgent + Orchestrator + Cron + Batch）— 行为协议: run_loop/delegate
- EvolutionDomain: 进化域能力（Monitor + Trigger + Strategy + Feedback + Learning）— 行为协议: adapt/learn
- IntegrationDomain: 集成域能力（Gateway + Plugin + Skill + Eval + ACP + LSP）
- PresentationDomain: 展示域能力（CLI + TUI + Clipboard + Shell补全）— 延迟加载
- UtilityDomain: 工具域能力（Cache + Config + Backpressure + ThinkScrubber + etc.）
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Protocol, runtime_checkable
from agent.core.logger import StructuredLogger, log_ignored
log = StructuredLogger("domain_containers")


@runtime_checkable
class DomainContainer(Protocol):
    """域容器协议 — 所有域容器必须实现此接口。

    V6.0 P3: 域生命周期 — startup/shutdown/health_check 钩子。
    V6.1: 域间依赖声明 — depends_on 显式化域间启动顺序。
    """

    @property
    def domain_name(self) -> str:
        """域名称标识符。"""
        ...

    @property
    def is_initialized(self) -> bool:
        """域是否已初始化。"""
        ...

    @property
    def depends_on(self) -> tuple[str, ...]:
        """域间依赖 — 声明本域启动前必须就绪的域名称。"""
        ...

    def get_subsystem(self, name: str) -> Any | None:
        """按名称获取域内子系统。"""
        ...

    def list_subsystems(self) -> list[str]:
        """列出域内所有子系统名称。"""
        ...

    async def startup(self) -> None:
        """域启动钩子 — 初始化域内资源（连接池、缓存预热等）。"""
        ...

    async def shutdown(self) -> None:
        """域关闭钩子 — 释放域内资源（关闭连接、刷写缓存等）。"""
        ...

    async def health_check(self) -> dict[str, Any]:
        """域健康检查 — 返回 {healthy: bool, details: dict}。"""
        ...


class _DomainLifecycleMixin:
    """域生命周期默认实现 — 所有域容器继承此混入获得 startup/shutdown/health_check/depends_on。"""

    depends_on: tuple[str, ...] = ()

    @property
    def _depends_on_prop(self) -> tuple[str, ...]:
        return self.depends_on

    async def startup(self) -> None:
        pass

    async def shutdown(self) -> None:
        pass

    async def health_check(self) -> dict[str, Any]:
        return {"healthy": self._initialized, "domain": getattr(self, "domain_name", "unknown")}


@runtime_checkable
class LoopProtocol(Protocol):
    """执行策略协议 — 所有 Loop 实现必须遵循此接口。

    V6.0 核心：将 LoopController.run() / run_react_loop() / MultiAgentOrchestrator
    统一为可插拔的执行策略，AgentEngine.process_input() 通过策略注册表选择。

    实现者:
    - PlanExecEvalLoop: LoopController.run() — Plan→Exec→Eval 循环
    - ReActLoop: LoopController.run_react_loop() — Thought→Action→Observation 循环
    - MultiAgentLoop: MultiAgentOrchestrator.process_goal_with_loop() — 多Agent分解
    - SimpleLoop: ConversationLoop / 直接 LLM 调用
    """

    @property
    def strategy_name(self) -> str:
        """策略名称标识符。"""
        ...

    async def run(
        self,
        input_text: str,
        messages: list[dict[str, str]] | None = None,
        session_id: str = "default",
        cancel_event: Any | None = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
        **kwargs: Any,
    ) -> Any:
        """执行 Agent 循环，返回 AgentResult。"""
        ...

    async def cancel(self) -> None:
        """取消正在执行的循环。"""
        ...


@runtime_checkable
class LLMInvokeProtocol(Protocol):
    """LLM 调用协议 — CoreDomain 的行为接口。

    将 LLMProvider.chat() / chat_stream() / chat_with_tools()
    纳入域边界，使 CoreDomain 成为 LLM 调用的唯一入口。
    """

    async def invoke(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        system_prompt: str | None = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
    ) -> dict[str, Any]:
        """同步调用 LLM，返回完整响应。"""
        ...

    async def invoke_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """流式调用 LLM，逐 chunk yield。"""
        ...

    async def invoke_with_tools(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
    ) -> dict[str, Any]:
        """带 Function Calling 的 LLM 调用。"""
        ...


class LLMSubDomain:
    """LLM 子域 — 将 LLMProvider 内部的 cache/pool/router/limiter 拆为独立子域。

    LLMProvider 自身是 God Object（持有9个子系统），V6.0 P3 将其内部组件
    拆为 LLMSubDomain，由 CoreDomain 持有引用。

    子域组件:
    - cache: LLMCache + TieredCache + PromptCacheManager
    - pool: ConnectionPoolManager + CredentialPool
    - router: ProviderManager + CanaryReleaseManager
    - limiter: AdaptiveRateLimiter + RequestQueue + PriorityRequestQueue
    - circuit: CircuitBreakerRegistry
    - cost: CostGuard
    """

    def __init__(self) -> None:
        self.cache: Any = None
        self.tiered_cache: Any = None
        self.prompt_cache: Any = None
        self.connection_pool: Any = None
        self.credential_pool: Any = None
        self.provider_manager: Any = None
        self.canary_manager: Any = None
        self.rate_limiter: Any = None
        self.queue: Any = None
        self.priority_queue: Any = None
        self.circuit_registry: Any = None
        self.cost_guard: Any = None
        self.anthropic_cache_builder: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "llm_sub"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def list_subsystems(self) -> list[str]:
        return [
            "cache", "tiered_cache", "prompt_cache",
            "connection_pool", "credential_pool",
            "provider_manager", "canary_manager",
            "rate_limiter", "queue", "priority_queue",
            "circuit_registry", "cost_guard",
            "anthropic_cache_builder",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    def from_provider(self, provider: Any) -> None:
        """从 LLMProvider 实例提取子域组件。"""
        self.cache = getattr(provider, "cache", None)
        self.tiered_cache = getattr(provider, "tiered_cache", None)
        self.prompt_cache = getattr(provider, "prompt_cache", None)
        self.connection_pool = getattr(provider, "_connection_pool", None)
        self.credential_pool = getattr(provider, "credential_pool", None)
        self.provider_manager = getattr(provider, "provider_manager", None)
        self.canary_manager = getattr(provider, "canary_manager", None)
        self.rate_limiter = getattr(provider, "rate_limiter", None)
        self.queue = getattr(provider, "queue", None)
        self.priority_queue = getattr(provider, "priority_queue", None)
        self.circuit_registry = getattr(provider, "_circuit_registry", None)
        self.cost_guard = getattr(provider, "cost_guard", None)
        self.anthropic_cache_builder = getattr(provider, "anthropic_cache_builder", None)
        self._initialized = True


class DomainEventBus:
    """域间事件总线 — 替代隐式 self.engine.xxx 属性引用。

    V6.0 域间通信机制:
    - 域容器通过 emit() 发布事件
    - 域容器通过 on() 订阅事件
    - 事件类型: domain.{source}.{event_name}
    - 同步回调立即执行，异步回调排入事件循环

    典型事件:
    - domain.core.llm_invoked: LLM 调用完成
    - domain.tool.executed: 工具执行完成
    - domain.security.violation: 安全违规
    - domain.evolution.feedback: 进化反馈
    """

    def __init__(self) -> None:
        self._handlers: dict[str, list[Any]] = {}

    def on(self, event_pattern: str, handler: Any) -> None:
        if event_pattern not in self._handlers:
            self._handlers[event_pattern] = []
        self._handlers[event_pattern].append(handler)

    def off(self, event_pattern: str, handler: Any) -> None:
        if event_pattern in self._handlers:
            self._handlers[event_pattern] = [
                h for h in self._handlers[event_pattern] if h is not handler
            ]

    async def emit(self, event_type: str, payload: Any = None) -> None:
        handlers = self._handlers.get(event_type, [])
        for handler in handlers:
            try:
                result = handler(payload)
                if result is not None and hasattr(result, "__await__"):
                    await result
            except Exception as e:
                log.debug("domain_containers 异常处理", error=str(e))
                from agent.core.logger import StructuredLogger
                _bus_log = StructuredLogger("domain_event_bus")
                _bus_log.warning("Event handler failed", event=event_type, error=str(e))

    def listener_count(self, event_type: str) -> int:
        return len(self._handlers.get(event_type, []))


class CoreDomain(_DomainLifecycleMixin):
    """核心AI域 — LLM + Memory + Loop + Evolution。

    这是 AgentEngine 最核心的域能力，始终需要初始化。
    V6.0: 实现 LLMInvokeProtocol 行为协议，将 LLM 调用链纳入域边界。
    V6.0 P3: LLM 子域拆分 — cache/pool/router/limiter 归入 LLMSubDomain。
    """

    depends_on: tuple[str, ...] = ()

    def __init__(self) -> None:
        self.llm: Any = None
        self.llm_sub: LLMSubDomain | None = None
        self.memory: Any = None
        self.loop: Any = None
        self.evolution: Any = None
        self.conversation: Any = None
        self.provider_catalog: Any = None
        self.provider_oauth_status: dict[str, dict] = {}
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "core"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "llm", "memory", "loop", "evolution",
            "conversation", "provider_catalog",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    async def startup(self) -> None:
        if self.llm_sub is not None and self.llm is not None:
            try:
                if self.llm_sub.connection_pool is not None and hasattr(self.llm_sub.connection_pool, "warmup"):
                    await self.llm_sub.connection_pool.warmup()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.CoreDomain.startup", _exc)
            try:
                if self.llm_sub.cache is not None and hasattr(self.llm_sub.cache, "warmup"):
                    await self.llm_sub.cache.warmup()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.CoreDomain.startup", _exc)

    async def shutdown(self) -> None:
        if self.llm_sub is not None:
            try:
                if self.llm_sub.connection_pool is not None and hasattr(self.llm_sub.connection_pool, "close"):
                    await self.llm_sub.connection_pool.close()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.CoreDomain.shutdown", _exc)
            try:
                if self.llm_sub.credential_pool is not None and hasattr(self.llm_sub.credential_pool, "close"):
                    await self.llm_sub.credential_pool.close()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.CoreDomain.shutdown", _exc)

    async def health_check(self) -> dict[str, Any]:
        details: dict[str, Any] = {"domain": "core"}
        if self.llm is not None:
            try:
                available = await self.llm.check_available()
                details["llm_available"] = available
            except Exception as e:
                log.warning("domain_containers 异常处理", error=str(e))
                details["llm_available"] = False
                details["llm_error"] = str(e)
        return {"healthy": self._initialized and details.get("llm_available", False), "details": details}

    async def invoke(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        system_prompt: str | None = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
    ) -> dict[str, Any]:
        if self.llm is None:
            return {"content": "", "role": "assistant", "error": "LLM not initialized"}
        return await self.llm.chat(
            messages=messages,
            tools=tools,
            system_prompt=system_prompt,
            user_id=user_id,
            strategy_name=strategy_name,
        )

    async def invoke_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        if self.llm is None:
            return
        async for chunk in self.llm.chat_stream(
            messages=messages,
            tools=tools,
            user_id=user_id,
            strategy_name=strategy_name,
        ):
            yield chunk

    async def invoke_with_tools(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
    ) -> dict[str, Any]:
        if self.llm is None:
            return {"content": "", "role": "assistant", "error": "LLM not initialized"}
        return await self.llm.chat_with_tools(
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
        )

    async def reflect(self, context: Any) -> Any:
        if self.loop is None:
            return None
        if hasattr(self.loop, "reflection"):
            return await self.loop.reflection.reflect(context)
        return None


class ToolDomain(_DomainLifecycleMixin):
    """工具域 — Registry + Permission + Schema + MCP + Approval + Skill。"""

    depends_on: tuple[str, ...] = ("core",)

    def __init__(self) -> None:
        self.tool_registry: Any = None
        self.toolset_registry: Any = None
        self.mcp_tool_bridge: Any = None
        self.permission_guard: Any = None
        self.schema_validator: Any = None
        self.tool_call_guard: Any = None
        self.approval_manager: Any = None
        self.skill_registry: Any = None
        self.extension_catalog: Any = None
        self.tool_executor: Any = None
        # W3：tool_result_cache 已下线（孤儿接线，零调用点），不再声明槽位。
        self.tool_search_index: Any = None
        self._toolset_mapper: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "tool"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "tool_registry", "toolset_registry", "mcp_tool_bridge",
            "permission_guard", "schema_validator", "tool_call_guard",
            "approval_manager", "skill_registry", "extension_catalog",
            "tool_executor", "tool_search_index",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    async def execute(self, tool_name: str, params: dict[str, Any], **kwargs: Any) -> Any:
        if self.tool_registry is None:
            return {"error": "ToolRegistry not initialized", "tool_name": tool_name}
        return await self.tool_registry.execute(tool_name, params, **kwargs)

    def validate(self, tool_name: str, params: dict[str, Any]) -> tuple[bool, str]:
        if self.schema_validator is None:
            return True, ""
        return self.schema_validator.validate(tool_name, params)


class ContextDomain(_DomainLifecycleMixin):
    """上下文域 — Manager + Compressor + Window + References + Persona + Attention。"""

    depends_on: tuple[str, ...] = ("core",)

    def __init__(self) -> None:
        self.context_manager: Any = None
        self.context_compressor: Any = None
        self.context_window_manager: Any = None
        self.context_file_registry: Any = None
        self.context_reference_resolver: Any = None
        self.unified_context_orchestrator: Any = None
        self.persona: Any = None
        self.attention_focus: Any = None
        self.coding_context_detector: Any = None
        self.conversation_compressor_v2: Any = None
        self.conversation_compression: Any = None
        self.context_references: Any = None
        self.subdirectory_hints: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "context"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "context_manager", "context_compressor", "context_window_manager",
            "context_file_registry", "context_reference_resolver",
            "unified_context_orchestrator", "persona", "attention_focus",
            "coding_context_detector", "conversation_compressor_v2",
            "conversation_compression", "context_references", "subdirectory_hints",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    async def build(self, input_text: str, **kwargs: Any) -> Any:
        if self.unified_context_orchestrator is None:
            return None
        return await self.unified_context_orchestrator.build(input_text, **kwargs)

    async def compress(self, messages: list[dict[str, str]], **kwargs: Any) -> list[dict[str, str]]:
        if self.context_compressor is None:
            return messages
        return await self.context_compressor.compress(messages, **kwargs)


class SecurityDomain(_DomainLifecycleMixin):
    """安全域 — Guard + Guardrail + Posture + Redaction + Path/URL/SSL + Budget + SafetyNet。"""

    depends_on: tuple[str, ...] = ("core",)

    def __init__(self) -> None:
        self.security: Any = None
        self.output_guardrail: Any = None
        self.path_security_guard: Any = None
        self.url_safety_guard: Any = None
        self.ssl_guard: Any = None
        self.redaction_engine: Any = None
        self.budget_guard: Any = None
        self.write_approval: Any = None
        self.write_approval_manager: Any = None
        self.threat_patterns: Any = None
        self.security_guidance: Any = None
        self.osv_checker: Any = None
        self.safety_net: Any = None
        self.perception_loop: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "security"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "security", "output_guardrail", "path_security_guard",
            "url_safety_guard", "ssl_guard", "redaction_engine",
            "budget_guard", "write_approval", "write_approval_manager",
            "threat_patterns", "security_guidance", "osv_checker",
            "safety_net", "perception_loop",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    def check(self, command: str) -> Any:
        if self.security is None:
            from types import SimpleNamespace
            return SimpleNamespace(allowed=True, blocked_reasons=[])
        return self.security.check_command(command)

    def redact(self, text: str) -> str:
        if self.redaction_engine is None:
            return text
        return self.redaction_engine.redact(text)

    async def shutdown(self) -> None:
        if self.perception_loop is not None:
            try:
                watcher = getattr(self.perception_loop, "_watcher", None)
                if watcher is not None:
                    shutdown_evt = getattr(watcher, "_shutdown_event", None)
                    if shutdown_evt is not None:
                        shutdown_evt.set()
                    if hasattr(watcher, "stop"):
                        await watcher.stop()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.PerceptionDomain.shutdown", _exc)
        if self.safety_net is not None:
            try:
                cp_mgr = getattr(self.safety_net, "_cp_mgr", None)
                if cp_mgr is not None and hasattr(cp_mgr, "cleanup"):
                    cp_mgr.cleanup(days=0)
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.PersistenceDomain.shutdown", _exc)


class PersistenceDomain(_DomainLifecycleMixin):
    """持久化域 — Session + Trajectory + Flywheel + Curator + MemoryConsolidator。"""

    depends_on: tuple[str, ...] = ("core",)

    def __init__(self) -> None:
        self.session_store: Any = None
        self.trajectory_db: Any = None
        self.flywheel: Any = None
        self.persistence: Any = None
        self.curator: Any = None
        self.memory_consolidator: Any = None
        self.batch_trajectory: Any = None
        self.workflow_engine: Any = None
        self.knowledge_lifecycle: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "persistence"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "session_store", "trajectory_db", "flywheel",
            "persistence", "curator", "memory_consolidator",
            "batch_trajectory", "workflow_engine", "knowledge_lifecycle",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    async def save(self, key: str, data: Any, **kwargs: Any) -> None:
        if self.session_store is not None and hasattr(self.session_store, "save"):
            await self.session_store.save(key, data, **kwargs)
        elif self.persistence is not None and hasattr(self.persistence, "save"):
            await self.persistence.save(key, data, **kwargs)

    async def load(self, key: str, **kwargs: Any) -> Any:
        if self.session_store is not None and hasattr(self.session_store, "load"):
            return await self.session_store.load(key, **kwargs)
        if self.persistence is not None and hasattr(self.persistence, "load"):
            return await self.persistence.load(key, **kwargs)
        return None

    async def shutdown(self) -> None:
        if self.knowledge_lifecycle is not None:
            try:
                await self.knowledge_lifecycle.close()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.PersistenceDomain.shutdown", _exc)
        if self.workflow_engine is not None:
            try:
                store = getattr(self.workflow_engine, "_store", None)
                if store is not None and hasattr(store, "close"):
                    store.close()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.PersistenceDomain.shutdown", _exc)


class OrchestrationDomain(_DomainLifecycleMixin):
    """编排域 — A2A + MultiAgent + Orchestrator + Cron + Batch + Delegate。"""

    depends_on: tuple[str, ...] = ("core", "tool")

    def __init__(self) -> None:
        self.agent_registry: Any = None
        self.orchestrator: Any = None
        self.multi_agent_orchestrator: Any = None
        self.orchestration_executor: Any = None
        self.cron_scheduler: Any = None
        self.batch_processor: Any = None
        self.sandbox: Any = None
        self.a2a_manager: Any = None
        self.a2a_self_card: Any = None
        self.a2a_auth_interceptor: Any = None
        self.a2a_remote_endpoints: list[str] = []
        self.a2a_task_manager: Any = None
        self.a2a_discovery: Any = None
        self.a2a_trust_manager: Any = None
        self.delegate_delegator: Any = None
        self.async_delegator: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "orchestration"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "agent_registry", "orchestrator", "multi_agent_orchestrator",
            "orchestration_executor", "cron_scheduler", "batch_processor",
            "sandbox", "a2a_manager", "a2a_self_card", "a2a_auth_interceptor",
            "a2a_task_manager", "a2a_discovery", "a2a_trust_manager",
            "delegate_delegator", "async_delegator",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    async def run_loop(
        self,
        loop_controller: Any,
        input_text: str,
        session_id: str = "default",
        **kwargs: Any,
    ) -> Any:
        if loop_controller is None:
            return None
        return await loop_controller.run(input_text=input_text, session_id=session_id, **kwargs)

    async def delegate(self, goal: str, **kwargs: Any) -> Any:
        if self.multi_agent_orchestrator is None:
            return None
        return await self.multi_agent_orchestrator.process_goal(goal=goal, **kwargs)


class EvolutionDomain(_DomainLifecycleMixin):
    """进化域 — Monitor + Trigger + Strategy + Feedback + Learning + Canary。"""

    depends_on: tuple[str, ...] = ("core",)

    def __init__(self) -> None:
        self.performance_monitor: Any = None
        self.evolution_trigger: Any = None
        self.fewshot_generalizer: Any = None
        self.strategy_adapter: Any = None
        self.learning_signals: Any = None
        self.feedback_loops: Any = None
        self.feedback_loop: Any = None
        self.evolution_orchestrator: Any = None
        self.canary_manager: Any = None
        self.reflection_applier: Any = None
        self.incremental_planner: Any = None
        self.plan_quality_checker: Any = None
        self.priority_scorer: Any = None
        self.learning_graph: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "evolution"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "performance_monitor", "evolution_trigger", "fewshot_generalizer",
            "strategy_adapter", "learning_signals", "feedback_loops",
            "feedback_loop", "evolution_orchestrator", "canary_manager",
            "reflection_applier", "incremental_planner", "plan_quality_checker",
            "priority_scorer", "learning_graph",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    async def adapt(self, metrics: dict[str, Any]) -> None:
        if self.strategy_adapter is None:
            return
        await self.strategy_adapter.adapt(metrics)

    async def learn(self, feedback: dict[str, Any]) -> None:
        if self.learning_signals is None:
            return
        await self.learning_signals.collect(feedback)


class IntegrationDomain(_DomainLifecycleMixin):
    """集成域 — Gateway + Plugin + Skill + Eval + ACP + LSP + WebSearch + Credential。"""

    depends_on: tuple[str, ...] = ("core", "tool")

    def __init__(self) -> None:
        self.gateway_dispatcher: Any = None
        self.plugin_manager: Any = None
        self.skill_hub: Any = None
        self.skill_audit: Any = None
        self.skill_sync: Any = None
        self.skill_bundles: Any = None
        self.skill_provenance: Any = None
        self.eval_runner: Any = None
        self.acp_entry: Any = None
        self.acp_server: Any = None
        self.acp_auth: Any = None
        self.lsp_servers: Any = None
        self.lsp_workspace: Any = None
        self.web_search_registry: Any = None
        self.credential_store: Any = None
        self.credential_discovery: Any = None
        self.platform_manager: Any = None
        self.proxy_server: Any = None
        self.relay_adapter: Any = None
        self.gateway_hooks: Any = None
        self.slash_commands: Any = None
        self.blueprint_catalog: Any = None
        self.onboarding: Any = None
        self.mcp_client: Any = None
        self.mcp_tool_bridge: Any = None
        self.mcp_lifecycle: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "integration"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "gateway_dispatcher", "plugin_manager", "skill_hub",
            "skill_audit", "skill_sync", "skill_bundles", "skill_provenance",
            "eval_runner", "acp_entry", "acp_server", "acp_auth",
            "lsp_servers", "lsp_workspace", "web_search_registry",
            "credential_store", "credential_discovery", "platform_manager",
            "proxy_server", "relay_adapter", "gateway_hooks",
            "slash_commands", "blueprint_catalog", "onboarding",
            "mcp_client", "mcp_tool_bridge", "mcp_lifecycle",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    async def shutdown(self) -> None:
        if self.mcp_lifecycle is not None:
            try:
                await self.mcp_lifecycle.stop_all()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.IntegrationDomain.shutdown", _exc)
        if self.mcp_client is not None:
            try:
                await self.mcp_client.disconnect_all()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.IntegrationDomain.shutdown", _exc)


class PresentationDomain(_DomainLifecycleMixin):
    """展示域 — CLI + TUI + Clipboard + Shell补全 + Markdown + Formatter。

    延迟加载：仅在 CLI 模式下初始化，headless/API 模式下跳过。
    """

    def __init__(self) -> None:
        self.cli_output: Any = None
        self.curses_tui: Any = None
        self.clipboard: Any = None
        self.shell_completion: Any = None
        self.markdown_tables: Any = None
        self.display_formatter: Any = None
        self.pty_bridge: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "presentation"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "cli_output", "curses_tui", "clipboard",
            "shell_completion", "markdown_tables", "display_formatter",
            "pty_bridge",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True


class ObservabilityDomain(_DomainLifecycleMixin):
    """可观测性域 — Metrics + OTEL + Insights + ProductionMetrics + ErrorClassifier。

    从 UtilityDomain 拆出，消除 UtilityDomain 的 God Object 风险。
    """

    depends_on: tuple[str, ...] = ("core",)

    def __init__(self) -> None:
        self.production_metrics: Any = None
        self.error_classifier: Any = None
        self.insights: Any = None
        self.background_review: Any = None
        self.account_usage: Any = None
        self.rate_limit_tracker: Any = None
        self.nous_rate_guard: Any = None
        self.model_cost_guard: Any = None
        self.shutdown_forensics: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "observability"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "production_metrics", "error_classifier", "insights",
            "background_review", "account_usage", "rate_limit_tracker",
            "nous_rate_guard", "model_cost_guard", "shutdown_forensics",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    def record_request(self, **kwargs: Any) -> None:
        if self.production_metrics is not None:
            self.production_metrics.record_request(**kwargs)

    def record_error(self, **kwargs: Any) -> None:
        if self.production_metrics is not None:
            self.production_metrics.record_error(**kwargs)


class SessionDomain(_DomainLifecycleMixin):
    """会话域 — SessionRecap + SearchIndex + Lineage + Todo + TurnFinalizer + TurnRetry。

    从 UtilityDomain 拆出，将所有会话生命周期相关子系统集中管理。
    """

    def __init__(self) -> None:
        self.session_recap_engine: Any = None
        self.session_search_index: Any = None
        self.session_lineage_tracker: Any = None
        self.todo_manager: Any = None
        self.turn_finalizer: Any = None
        self.turn_retry_state: Any = None
        self.clarify_manager: Any = None
        self.memory_manager: Any = None
        self.message_content: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "session"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "session_recap_engine", "session_search_index",
            "session_lineage_tracker", "todo_manager",
            "turn_finalizer", "turn_retry_state",
            "clarify_manager", "memory_manager", "message_content",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True


class CacheDomain(_DomainLifecycleMixin):
    """缓存域 — Redis + PromptCaching + Backpressure + DiskCleaner。

    从 UtilityDomain 拆出，将所有缓存/限流/清理相关子系统集中管理。
    """

    depends_on: tuple[str, ...] = ("core",)

    def __init__(self) -> None:
        self._redis_cache: Any = None
        self.prompt_caching: Any = None
        self.backpressure: Any = None
        self.disk_cleaner: Any = None
        self.lazy_deps: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "cache"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "_redis_cache", "prompt_caching", "backpressure",
            "disk_cleaner", "lazy_deps",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True

    async def startup(self) -> None:
        if self._redis_cache is not None:
            try:
                health = await self._redis_cache.health_check()
                if not health:
                    import structlog
                    structlog.get_logger().warning("Redis cache unhealthy at startup")
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.CacheDomain.startup", _exc)

    async def shutdown(self) -> None:
        if self._redis_cache is not None:
            try:
                if hasattr(self._redis_cache, "close"):
                    await self._redis_cache.close()
            except Exception as _exc:
                log.warning("domain_containers 异常处理", error=str(_exc))
                log_ignored(None, "domain_containers.CacheDomain.shutdown", _exc)
            self._redis_cache = None

    async def health_check(self) -> dict[str, Any]:
        details: dict[str, Any] = {"domain": "cache"}
        if self._redis_cache is not None:
            try:
                healthy = await self._redis_cache.health_check()
                details["redis_healthy"] = healthy
            except Exception as e:
                log.warning("domain_containers 异常处理", error=str(e))
                details["redis_healthy"] = False
                details["redis_error"] = str(e)
        else:
            details["redis_healthy"] = None
        return {"healthy": self._initialized, "details": details}

    async def invalidate(self, pattern: str = "*") -> int:
        if self._redis_cache is None:
            return 0
        return await self._redis_cache.invalidate(pattern)


class UtilityDomain(_DomainLifecycleMixin):
    """工具域 — 瘦身后的杂项域，仅保留无法归入其他域的子系统。

    V6.0: 从45+子系统瘦身至20-，Observability/Session/Cache已拆出。
    """

    def __init__(self) -> None:
        self.config_reloader: Any = None
        self.think_scrubber: Any = None
        self.verification: Any = None
        self.verification_loop: Any = None
        self.clarification_engine: Any = None
        self.constraints: Any = None
        self.hook_manager: Any = None
        self.local_title_generator: Any = None
        self.code_executor: Any = None
        self.auxiliary_client: Any = None
        self.moa_aggregator: Any = None
        self.streaming_scrubber: Any = None
        self.batch_runner: Any = None
        self.retry_utils: Any = None
        self.portal_tags: Any = None
        self.dashboard_auth: Any = None
        self.hot_reloader: Any = None
        self.voice_mode_manager: Any = None
        self.workspace_manager: Any = None
        self.i18n_instance: Any = None
        self.memory_providers: Any = None
        self.profile_manager: Any = None
        self._initialized: bool = False

    @property
    def domain_name(self) -> str:
        return "utility"

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_subsystem(self, name: str) -> Any | None:
        return getattr(self, name, None)

    def list_subsystems(self) -> list[str]:
        return [
            "config_reloader", "think_scrubber", "verification",
            "verification_loop", "clarification_engine", "constraints",
            "hook_manager", "local_title_generator", "code_executor",
            "auxiliary_client", "moa_aggregator", "streaming_scrubber",
            "batch_runner", "retry_utils", "portal_tags", "dashboard_auth",
            "hot_reloader", "voice_mode_manager", "workspace_manager",
            "i18n_instance", "memory_providers", "profile_manager",
        ]

    def mark_initialized(self) -> None:
        self._initialized = True


DOMAIN_MAP: dict[str, type[DomainContainer]] = {
    "core": CoreDomain,
    "tool": ToolDomain,
    "context": ContextDomain,
    "security": SecurityDomain,
    "persistence": PersistenceDomain,
    "orchestration": OrchestrationDomain,
    "evolution": EvolutionDomain,
    "integration": IntegrationDomain,
    "presentation": PresentationDomain,
    "observability": ObservabilityDomain,
    "session": SessionDomain,
    "cache": CacheDomain,
    "utility": UtilityDomain,
}

SUBSYSTEM_TO_DOMAIN: dict[str, str] = {}
for _domain_name, _domain_cls in DOMAIN_MAP.items():
    for _subsys in _domain_cls().list_subsystems():
        SUBSYSTEM_TO_DOMAIN[_subsys] = _domain_name
