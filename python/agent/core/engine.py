from __future__ import annotations

import asyncio
import os
import threading
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # 仅供类型注解使用（PEP 563 下不会在运行时求值）
    pass

from agent.core.dependencies import SUBSYSTEM_DEPS, SubsystemSpec
from agent.core.domain_containers import SUBSYSTEM_TO_DOMAIN
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.core.registry import SubsystemRegistry
from agent.core.think_scrubber import ThinkScrubber
from agent.infrastructure.otel_setup import setup_otel, get_tracer, get_meter, is_otel_enabled, traced
from agent.core.otel_metrics import set_active_sessions, llm_tokens_counter
from agent.core.production_metrics import get_production_metrics_collector
from agent.evolution.feedback_loop import ContinuousFeedbackLoop
from agent.llm.provider import LLMProvider
from agent.loop.reflection import (
    ReflectionResult,
    TaskReflectionInput,
)
from agent.loop.controller import LoopController
from agent.memory.engine import MemoryEngine
from agent.memory.episodic_memory import EpisodicMemoryStore
from agent.evolution.engine import EvolutionEngine
from agent.evolution.orchestrator import EvolutionOrchestrator
from agent.core.conversation_loop import ConversationLoop
from agent.core.backpressure import BackpressureController, BackpressureConfig
from agent.core.config_watcher import ConfigReloader
from agent.memory.consolidation import MemoryConsolidator, ConsolidationConfig
from agent.core.verification_loop import VerificationLoop, VerificationReport, StepVerification
from agent.core.clarification import ClarificationEngine, ClarificationConfig, AmbiguityResult
from agent.core.context_pipeline import (
    ContextManager,
    ContextFileRegistry,
    ContextReferenceResolver,
)
from agent.core.context_compressor import ContextCompressor, ContextWindowManager


# #6d 超大文件拆分首批：build_extension_catalog 已外提至独立模块并 re-export，
# 保持 engine.py 对外签名不变（含测试 `from agent.core.engine import build_extension_catalog`）。
from agent.core.extension_catalog import build_extension_catalog
from agent.core.persona import PersonaCore
from agent.context import UnifiedContextOrchestrator, ContextBuildRequest
from agent.context.models import ContextBuildResult
from agent.context.adapters import (
    SystemPromptComponent,
    PersonaComponent,
    MemoryRetrievalComponent,
    FileContextComponent,
    TokenBudgetComponent,
    ContextAssemblerComponent,
)
from agent.context.attention_focus import AttentionFocusEngine
from agent.core.security import SecurityGuard
from agent.core.hooks import (
    HookManager,
    BEFORE_TOOL_CALL,
    AFTER_TOOL_CALL,
    ON_TOOL_ERROR,
    BEFORE_LOOP,
    AFTER_LOOP,
    ON_SESSION_START,
    ON_SESSION_END,
    ON_BUDGET_EXCEEDED,
    ON_CONSTRAINT_VIOLATION,
)
from agent.tools.registry import ToolRegistry, register_default_tools
from agent.tools.permission_guard import PermissionGuard, Permission
from agent.tools.schema_validator import SchemaValidator
from agent.tools.tool_call_guard import ToolCallGuard
from agent.tools.approval_manager import ApprovalManager
from agent.security.runtime_posture import RuntimePosture
from agent.tools.toolset_registry import ToolsetRegistry
from agent.tools.mcp_tool_bridge import MCPToolBridge
from agent.skills.registry import SkillRegistry
from agent.persistence.session_store import SessionStore
from agent.persistence.trajectory import TrajectoryDatabase, ExecutionRecord, ToolInvocationRecord
from agent.persistence.flywheel import TrajectoryFlywheel, FlywheelConfig
from agent.persistence.service import PersistenceService
from agent.memory.curator import Curator
from agent.verification.service import VerificationService
from agent.constraints.service import ConstraintsService
from agent.evolution.monitor import PerformanceMonitor
from agent.evolution.trigger import EvolutionTrigger, EvolutionTriggerConfig
from agent.evolution.fewshot_generalizer import FewShotGeneralizer
from agent.evolution.strategy_adapter import StrategyAdapter
from agent.evolution.learning_signals import LearningSignalCollector
from agent.loop.incremental_planner import IncrementalPlanner
from agent.loop.plan_quality_checker import PlanQualityChecker
from agent.loop.reflection_applier import ReflectionApplicationManager
from agent.core.canary_release import CanaryReleaseManager
from agent.core.dynamic_priority import DynamicPriorityScorer
from agent.orchestration.agent_factory import (
    AgentFactory,
    AgentRegistry,
    OrchestratorAgent,
    AgentScene,
    AgentConfig,
    MultiAgentOrchestrator,
)
from agent.a2a import (
    A2AAgentCard,
    A2AAuthInterceptor,
    A2AAuthType,
    A2ACapability,
    A2ACapabilityType,
    A2ATransport,
    A2AProtocolManager,
    get_a2a_manager,
)
from agent.loop.feedback_loops import FeedbackLoops
from agent.scheduler.cron import CronJobScheduler
from agent.security.output_guardrail import OutputGuardrailEngine
from agent.sandbox.executor import SandboxExecutor
from agent.loop.batch_processor import BatchProcessor, BatchConfig

log = StructuredLogger("engine")


class AgentEngine:
    def __init__(self) -> None:
        self.llm = LLMProvider()
        self.provider_oauth_status: dict[str, dict] = {}  # T3：各 OAuth provider 凭据解析结果
        self._start_time: float = 0.0
        self._session_count: int = 0
        self._active_sessions: int = 0  # 当前活跃会话数，用于 OTel gauge
        self._counter_lock = threading.Lock()
        self.a2a_remote_endpoints: list[str] = []
        self._registry: SubsystemRegistry | None = None
        self._degraded_subsystems: set[str] = set()
        self._degraded_reasons: dict[str, str] = {}
        self._critical_degraded: set[str] = set()
        self._shutdown_event: asyncio.Event | None = None
        # ── 域容器（V6.0 域独占门面） ──
        from agent.core.domain_containers import (
            CoreDomain, ToolDomain, ContextDomain, SecurityDomain,
            PersistenceDomain, OrchestrationDomain, EvolutionDomain,
            IntegrationDomain, PresentationDomain, UtilityDomain,
            ObservabilityDomain, SessionDomain, CacheDomain,
        )
        self.domains = {
            "core": CoreDomain(),
            "tool": ToolDomain(),
            "context": ContextDomain(),
            "security": SecurityDomain(),
            "persistence": PersistenceDomain(),
            "orchestration": OrchestrationDomain(),
            "evolution": EvolutionDomain(),
            "integration": IntegrationDomain(),
            "presentation": PresentationDomain(),
            "observability": ObservabilityDomain(),
            "session": SessionDomain(),
            "cache": CacheDomain(),
            "utility": UtilityDomain(),
        }
        self._domain_proxy_enabled: bool = True
        from agent.core.domain_containers import DomainEventBus
        self.domain_events = DomainEventBus()
        self._loop_strategies: dict[str, Any] = {}
        # 多智能体编排器：必须在此显式初始化。
        # __getattr__ 对下划线开头属性一律抛 AttributeError，若不预置为 None，
        # 当 _init_multi_agent_orchestrator 因 self.loop 未就绪而跳过赋值时，
        # 主对话路径读取 self._multi_agent_orchestrator 会崩溃。
        self._multi_agent_orchestrator: Any = None

    _ENGINE_OWN_ATTRS: frozenset[str] = frozenset({
        "a2a_remote_endpoints",
        "_start_time", "_session_count", "_active_sessions",
        "_registry", "_degraded_subsystems", "_degraded_reasons",
        "_domain_proxy_enabled", "_loop_strategies", "_counter_lock",
        "_multi_agent_orchestrator",
    })

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_") and name != "_redis_cache":
            raise AttributeError(f"AgentEngine has no attribute '{name}'")
        if not self.__dict__.get("_domain_proxy_enabled", False):
            raise AttributeError(f"AgentEngine has no attribute '{name}'")
        domain_name = SUBSYSTEM_TO_DOMAIN.get(name)
        if domain_name is not None:
            domains = self.__dict__.get("domains")
            if domains is not None:
                domain = domains.get(domain_name)
                if domain is not None and hasattr(domain, name):
                    return getattr(domain, name)
        raise AttributeError(f"AgentEngine has no attribute '{name}'")

    def __setattr__(self, name: str, value: Any) -> None:
        if (name.startswith("_") and name != "_redis_cache") or name in ("domains", "domain_events"):
            object.__setattr__(self, name, value)
            return
        domains = self.__dict__.get("domains")
        if domains is not None and self.__dict__.get("_domain_proxy_enabled", False):
            from agent.core.domain_containers import SUBSYSTEM_TO_DOMAIN
            domain_name = SUBSYSTEM_TO_DOMAIN.get(name)
            if domain_name is not None:
                domain = domains.get(domain_name)
                if domain is not None:
                    setattr(domain, name, value)
                    return
        object.__setattr__(self, name, value)

    async def initialize_v2(self) -> None:
        """基于依赖图的拓扑排序初始化（新版）。

        相比旧的 initialize() 方法，主要改进:
        - 按 SUBSYSTEM_DEPS 声明的依赖关系自动排序，杜绝顺序 bug
        - hook_manager 保证在 conversation 之前初始化（修复旧版顺序 bug）
        - 统一的失败可降级策略（critical=False 的子系统失败不阻断）
        - 启动顺序运行时可校验，便于调试和扩展
        - 启动前预验证必要配置，避免白跑初始化链

        Returns:
            None

        Raises:
            RuntimeError: 配置缺失或关键子系统初始化失败时抛出。
        """
        import time
        self._start_time = time.time()

        # P3: 配置预验证 — 缺少必要配置时立即报错，不启动任何子系统
        missing = self._validate_required_config()
        if missing:
            msg = f"缺少必要配置: {', '.join(missing)}。请检查环境变量或 .env 文件。"
            log.error("Config pre-validation failed", missing=missing)
            raise RuntimeError(msg)

        self._registry = SubsystemRegistry()
        self._registry.register_many(SUBSYSTEM_DEPS)

        self._init_observability()

        try:
            results = await self._registry.boot_all(self)
            log.info("Agent Engine v2 initialized", module_count=len(results))
        except Exception as e:
            log.error("Agent Engine v2 init failed, falling back to v1", error=str(e))
            await self.initialize()
            return

        await self._finalize_boot()
        self._mark_domains_initialized()

    def _validate_required_config(self) -> list[str]:
        """检查必要配置是否完整。

        Returns:
            缺失的配置项名列表。空列表表示配置完整。

        检查项:
        - OPENAI_API_KEY / ANTHROPIC_API_KEY 等 LLM 凭据（至少一个）
        - AGENT_PORT（默认 3112，但显式检查）
        """
        import os

        missing: list[str] = []
        api_keys = [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GOOGLE_API_KEY",
            "AZURE_OPENAI_API_KEY",
            "DEEPSEEK_API_KEY",
        ]
        if not any(os.environ.get(k) for k in api_keys):
            missing.append("LLM_API_KEY (至少需要一个: OPENAI/ANTHROPIC/GOOGLE/AZURE/DEEPSEEK)")

        return missing

    def _init_observability(self) -> None:
        """初始化 OTel + Redis + 活跃会话 gauge（P0 阶段）。"""
        try:
            if setup_otel():
                log.info("OpenTelemetry initialized", enabled=True)
            else:
                log.info("OpenTelemetry disabled (set OTEL_ENABLED=true to enable)")
        except Exception as e:
            log.warning("OpenTelemetry init failed", error=str(e))

        try:
            set_active_sessions(0)
        except Exception as _exc:
            log_ignored(log, "engine.AgentEngine._init_observability", _exc)

        try:
            from agent.memory.redis_cache import get_redis_cache, is_redis_enabled
            if is_redis_enabled():
                self._redis_cache = get_redis_cache()
            else:
                log.info("Redis Cache disabled (set REDIS_ENABLED=true to enable)")
        except Exception as e:
            log.warning("Redis Cache init failed", error=str(e))
            self._redis_cache = None

    async def _finalize_boot(self) -> None:
        """初始化完成后的收尾工作。"""
        self._register_default_loop_strategies()
        if self.hook_manager:
            await self.hook_manager.trigger(ON_SESSION_START, session_id="engine", modules_loaded=True)

    def _register_default_loop_strategies(self) -> None:
        if self.loop is not None:
            self.register_loop_strategy("plan_exec_eval", self.loop)
            if hasattr(self.loop, "run_react_loop"):
                self.register_loop_strategy("react", self.loop)
        if self.conversation is not None:
            self.register_loop_strategy("simple", self.conversation)
        if self._multi_agent_orchestrator is not None:
            self.register_loop_strategy("multi_agent", self._multi_agent_orchestrator)

    def is_subsystem_available(self, name: str) -> bool:
        """检查子系统是否可用（已初始化且未降级）。

        Args:
            name: 子系统属性名（如 'memory', 'loop', 'evolution'）

        Returns:
            True 表示可用，False 表示未初始化或已降级
        """
        if name in self._degraded_subsystems:
            return False
        return getattr(self, name, None) is not None

    def get_degraded_report(self) -> dict[str, Any]:
        """获取降级子系统健康报告。

        Returns:
            包含 degraded_count、degraded_subsystems、critical_degraded、
            all_healthy 的字典
        """
        return {
            "degraded_count": len(self._degraded_subsystems),
            "degraded_subsystems": dict(self._degraded_reasons),
            "critical_degraded": sorted(self._critical_degraded),
            "critical_degraded_count": len(self._critical_degraded),
            "all_healthy": len(self._degraded_subsystems) == 0,
        }

    def _mark_subsystem_degraded(self, name: str, reason: str = "", critical: bool = False) -> None:
        """标记子系统已降级。

        Args:
            name: 子系统名称
            reason: 降级原因
            critical: 是否为关键子系统（如 loop / tool_registry / schema_validator /
                constraints）。关键子系统降级会影响核心服务能力，会被标记进
                `_critical_degraded` 并反映在健康检查中（status=unhealthy），
                而非静默放行。
        """
        self._degraded_subsystems.add(name)
        self._degraded_reasons[name] = reason
        if critical:
            self._critical_degraded.add(name)
            log.error("Critical subsystem degraded", subsystem=name, reason=reason)
        else:
            log.warning("Subsystem degraded", subsystem=name, reason=reason)

        try:
            from agent.core.subsystem_guard import get_degraded_tracker
            get_degraded_tracker().mark_degraded(name, reason)
        except Exception as _exc:
            log_ignored(log, "engine.AgentEngine._mark_subsystem_degraded", _exc)

    def _mark_domains_initialized(self) -> None:
        """V6.0: 扁平属性已归零，仅提取 LLM 子域并标记域初始化完成。"""
        core = self.domains.get("core")
        if core and core.llm is not None:
            from agent.core.domain_containers import LLMSubDomain
            if core.llm_sub is None:
                core.llm_sub = LLMSubDomain()
            core.llm_sub.from_provider(core.llm)

        for domain in self.domains.values():
            domain.mark_initialized()

    def get_domain(self, name: str) -> Any | None:
        """按名称获取域容器。

        Args:
            name: 域名称（如 'core', 'tool', 'security'）

        Returns:
            域容器实例，不存在则返回 None
        """
        return self.domains.get(name)

    def get_domain_report(self) -> dict[str, Any]:
        """获取所有域的健康报告。

        Returns:
            每个域的初始化状态和子系统列表
        """
        report: dict[str, Any] = {}
        for name, domain in self.domains.items():
            report[name] = {
                "initialized": domain.is_initialized,
                "subsystems": domain.list_subsystems(),
            }
        report["degraded"] = self.get_degraded_report()
        return report

    def _topological_sort_domains(self) -> list[str]:
        """基于 depends_on 声明对域进行拓扑排序。

        Returns:
            按依赖顺序排列的域名称列表（被依赖的域排在前面）。

        Raises:
            ValueError: 如果存在循环依赖。
        """
        in_degree: dict[str, int] = {name: 0 for name in self.domains}
        adj: dict[str, list[str]] = {name: [] for name in self.domains}
        for name, domain in self.domains.items():
            deps = getattr(domain, "depends_on", ())
            for dep in deps:
                if dep in self.domains:
                    adj[dep].append(name)
                    in_degree[name] += 1
        queue = [n for n, d in in_degree.items() if d == 0]
        result: list[str] = []
        while queue:
            node = queue.pop(0)
            result.append(node)
            for neighbor in adj[node]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)
        if len(result) != len(self.domains):
            remaining = set(self.domains) - set(result)
            raise ValueError(f"Circular dependency detected among domains: {remaining}")
        return result

    async def startup_domains(self) -> None:
        """按拓扑顺序启动所有域。"""
        order = self._topological_sort_domains()
        for name in order:
            domain = self.domains.get(name)
            if domain is not None:
                try:
                    await domain.startup()
                except Exception as e:
                    log.warning("Domain startup failed", domain=name, error=str(e))
                    self._mark_subsystem_degraded(f"domain:{name}", str(e))

    async def shutdown_domains(self) -> None:
        """按逆拓扑顺序关闭所有域。"""
        if self._shutdown_event is not None:
            self._shutdown_event.set()
        order = self._topological_sort_domains()
        for name in reversed(order):
            domain = self.domains.get(name)
            if domain is not None:
                try:
                    await domain.shutdown()
                except Exception as e:
                    log.warning("Domain shutdown failed", domain=name, error=str(e))

    async def health_check_domains(self) -> dict[str, dict[str, Any]]:
        """对所有域执行健康检查。"""
        results: dict[str, dict[str, Any]] = {}
        for name, domain in self.domains.items():
            try:
                results[name] = await domain.health_check()
            except Exception as e:
                results[name] = {"healthy": False, "domain": name, "error": str(e)}
        return results

    def register_loop_strategy(self, name: str, strategy: Any) -> None:
        self._loop_strategies[name] = strategy

    def get_loop_strategy(self, name: str) -> Any | None:
        return self._loop_strategies.get(name)

    def select_loop_strategy(self, input_text: str) -> str:
        if not self._loop_strategies:
            return "simple"
        if "react" in self._loop_strategies:
            core = self.domains.get("core")
            if core and core.loop and hasattr(core.loop, "_should_use_react"):
                if core.loop._should_use_react(input_text):
                    return "react"
        if "plan_exec_eval" in self._loop_strategies:
            return "plan_exec_eval"
        return next(iter(self._loop_strategies), "simple")

    def _resolve_execution_strategy(self, input_text: str, should_use_loop: bool) -> str:
        if should_use_loop and self._multi_agent_orchestrator and self.loop:
            try:
                complexity = self._multi_agent_orchestrator._complexity_analyzer.analyze(input_text)
                if complexity.complexity == "very_complex" and complexity.recommended_agents > 1:
                    return "multi_agent"
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._resolve_execution_strategy", _exc)
        if should_use_loop and self.loop:
            return self.select_loop_strategy(input_text)
        if self.conversation:
            return "simple"
        return "fallback"

    async def initialize(self) -> None:
        import time
        self._start_time = time.time()

        self._shutdown_event = asyncio.Event()

        # P0: OTel 可观测性初始化
        # 注意：OTel tracer/meter 通过 otel_metrics/otel_tracer 模块的工厂函数按需获取，
        # 此处不再缓存到实例属性（避免死代码）。OTEL_ENABLED=true 时启用，
        # 默认 false 以保证开发环境友好（部署文档需明确标注）。
        try:
            if setup_otel():
                log.info("OpenTelemetry initialized", enabled=True)
            else:
                log.info("OpenTelemetry disabled (set OTEL_ENABLED=true to enable)")
        except Exception as e:
            log.warning("OpenTelemetry init failed", error=str(e))

        # 初始化活跃会话 gauge 为 0（OTel 启用时由 MetricReader 周期性拉取）
        try:
            set_active_sessions(0)
        except Exception as _exc:
            log_ignored(log, "engine.AgentEngine.initialize", _exc)

        # P0: Redis 缓存层初始化（显式注入，供 LLM 缓存等使用）
        try:
            from agent.memory.redis_cache import get_redis_cache, is_redis_enabled
            if is_redis_enabled():
                self._redis_cache = get_redis_cache()
                health = await self._redis_cache.health_check()
                log.info("Redis Cache initialized", healthy=health)
            else:
                log.info("Redis Cache disabled (set REDIS_ENABLED=true to enable)")
        except Exception as e:
            log.warning("Redis Cache init failed", error=str(e))
            self._redis_cache = None

        available = await self.llm.check_available()
        status = "available" if available else "unavailable"
        log.info("LLM Provider initialized", model=self.llm.model, status=status)

        try:
            self.memory = MemoryEngine(llm=self.llm)
            # P0 接线修复：注入 EpisodicMemoryStore，启用情景记忆检索
            # 此前 set_episodic_store 从未被调用，导致 engine.py:91 的 if self._episodic_store 分支永远为 False
            self.memory.set_episodic_store(EpisodicMemoryStore())
            await self.memory.initialize()
            log.info("Memory Engine ready (with EpisodicMemoryStore)")
        except Exception as e:
            log.warning("Memory Engine init failed", error=str(e))
            self.memory = None
            self._mark_subsystem_degraded("memory", str(e))

        try:
            self.trajectory_db = TrajectoryDatabase()
            log.info("Trajectory Database ready")
        except Exception as e:
            log.warning("Trajectory Database init failed", error=str(e))
            self.trajectory_db = None
            self._mark_subsystem_degraded("trajectory_db", str(e))

        try:
            self.tool_registry = ToolRegistry()
            count = register_default_tools(self.tool_registry)
            try:
                from agent.perception.tools import register_perception_tools
                register_perception_tools(self.tool_registry)
                log.info("Perception tools registered")
            except Exception as _e:
                log.warning("Perception tools registration failed", error=str(_e))
            log.info("Tool Registry ready", count=count)
        except Exception as e:
            log.warning("Tool Registry init failed", error=str(e))
            self.tool_registry = None
            self._mark_subsystem_degraded("tool_registry", str(e), critical=True)

        try:
            self.toolset_registry = ToolsetRegistry(self.tool_registry)
            log.info("Toolset Registry ready")
        except Exception as e:
            log.warning("Toolset Registry init failed", error=str(e))
            self.toolset_registry = None
            self._mark_subsystem_degraded("toolset_registry", str(e))

        try:
            # P0 修复：MCPToolBridge 应持有 MCPServerManager（MCPProvider 实现），
            # 而非 ToolRegistry（此前为类型错误，导致 sync_to_registry 从未生效）。
            from agent.mcp.server_manager import MCPServerManager
            mcp_manager = MCPServerManager.get_instance()
            self.mcp_tool_bridge = MCPToolBridge(provider=mcp_manager)
            # 同步 MCP 服务器工具到本地 ToolRegistry
            if self.tool_registry is not None:
                synced = await self.mcp_tool_bridge.sync_to_registry(self.tool_registry)
                self.mcp_tool_bridge.start_auto_sync(self.tool_registry)
                log.info("MCP Tool Bridge ready", synced_tools=synced)
            else:
                log.warning("MCP Tool Bridge ready but tool_registry is None, sync skipped")
        except Exception as e:
            log.warning("MCP Tool Bridge init failed", error=str(e))
            self.mcp_tool_bridge = None
            self._mark_subsystem_degraded("mcp_tool_bridge", str(e), critical=True)

        try:
            self.permission_guard = PermissionGuard()
            log.info("Permission Guard ready")
        except Exception as e:
            log.warning("Permission Guard init failed", error=str(e))
            self.permission_guard = None
            self._mark_subsystem_degraded("permission_guard", str(e), critical=True)

        try:
            self.schema_validator = SchemaValidator()
            log.info("Schema Validator ready")
        except Exception as e:
            log.warning("Schema Validator init failed", error=str(e))
            self.schema_validator = None
            self._mark_subsystem_degraded("schema_validator", str(e), critical=True)

        try:
            self.tool_call_guard = ToolCallGuard()
            log.info("Tool Call Guard ready")
        except Exception as e:
            log.warning("Tool Call Guard init failed", error=str(e))
            self.tool_call_guard = None
            self._mark_subsystem_degraded("tool_call_guard", str(e))

        try:
            _posture = RuntimePosture.from_env()
            import os as _os
            _env_mode = _os.environ.get("ENV", "development").lower()
            _auto_approve = _env_mode not in ("production", "prod", "staging", "stage")
            self.approval_manager = ApprovalManager(auto_approve_all=_auto_approve, posture=_posture)
            log.info("Approval Manager ready", posture=_posture.value, auto_approve_all=_auto_approve)
        except Exception as e:
            log.warning("Approval Manager init failed", error=str(e))
            self.approval_manager = None
            self._mark_subsystem_degraded("approval_manager", str(e))

        try:
            self.canary_manager = CanaryReleaseManager()
            log.info("Canary Release Manager ready")
        except Exception as e:
            log.warning("Canary Release Manager init failed", error=str(e))
            self.canary_manager = None
            self._mark_subsystem_degraded("canary_manager", str(e))

        # P0-P1: 新架构组件初始化
        # 注：并行工具执行器不再挂到 engine 上（此前为双重孤儿，执行路径用
        # conversation_loop._parallel_executor 自有实例）。见审计报告 §1.6 W1。
        self.backpressure = BackpressureController()
        self.config_reloader = ConfigReloader(self)
        self.memory_consolidator = MemoryConsolidator(llm=self.llm)
        self.verification_loop = VerificationLoop(verification=self.verification)
        self.clarification_engine = ClarificationEngine()
        log.info("Engine extensions initialized (backpressure, config_reloader, memory_consolidator, verification_loop, clarification_engine)")

        # 约束服务 — 必须在 LoopController 之前初始化，供其调用 resolve_adaptive_budget
        try:
            self.constraints = ConstraintsService()
            log.info("Constraints Service ready")
        except Exception as e:
            log.warning("Constraints Service init failed", error=str(e))
            self.constraints = None
            self._mark_subsystem_degraded("constraints", str(e), critical=True)

        try:
            perception_bus = None
            try:
                from agent.perception.bus import PerceptionBus, PerceptionLevel
                perception_bus = PerceptionBus(
                    tool_registry=self.tool_registry,
                    llm=self.llm,
                    level=PerceptionLevel(
                        os.environ.get("PERCEPTION_LEVEL", "standard")
                    ),
                )
                log.info("PerceptionBus ready")
            except Exception as _e:
                log.warning("PerceptionBus init failed", error=str(_e))

            self.loop = LoopController(
                self.llm,
                trajectory_db=self.trajectory_db,
                tool_registry=self.tool_registry,
                evolution=None,
                memory_engine=self.memory,
                canary_manager=self.canary_manager,
                constraints_service=self.constraints,
                perception_bus=perception_bus,
                schema_validator=getattr(self, "schema_validator", None),
                tool_call_guard=getattr(self, "tool_call_guard", None),
                proactive_engine=getattr(self, "proactive_engine", None),
            )

            # Phase 3+4: 将进化闭环和辩论器注入 DebateHarness
            if hasattr(self.loop, "_debate_harness") and self.loop._debate_harness:
                if hasattr(self, "evolution_closed_loop") and self.evolution_closed_loop:
                    self.loop._debate_harness._evolution_closed_loop = self.evolution_closed_loop
                debater_instance = self.loop._get_debater() if hasattr(self.loop, "_get_debater") else None
                if debater_instance:
                    self.loop._debate_harness._debater = debater_instance
                if hasattr(self.loop, "_causal") and self.loop._causal:
                    self.loop._debate_harness._causal_modeler = self.loop._causal

            log.info("Loop Controller ready")
        except Exception as e:
            log.warning("Loop Controller init failed", error=str(e))
            self.loop = None
            self._mark_subsystem_degraded("loop", str(e), critical=True)

        try:
            self.evolution = EvolutionEngine()

            # Phase 4: 进化闭环打通 — 连通 EvolutionEngine + EvolutionOrchestrator
            try:
                from agent.evolution.closed_loop import EvolutionClosedLoop
                self.evolution_closed_loop = EvolutionClosedLoop(
                    evolution_engine=self.evolution,
                )
                log.info("Evolution Closed Loop ready")
            except Exception as _e:
                log.warning("Evolution Closed Loop init failed", error=str(_e))
                self.evolution_closed_loop = None

            # Phase 4: 跨会话记忆 + 主动行为引擎
            try:
                from agent.memory.cross_session import CrossSessionMemory, ProactiveEngine
                self.cross_session_memory = CrossSessionMemory()
                self.proactive_engine = ProactiveEngine(
                    memory=self.cross_session_memory,
                    perception_bus=perception_bus,
                )
                log.info("Cross-session Memory + Proactive Engine ready")
            except Exception as _e:
                log.warning("Cross-session Memory init failed", error=str(_e))
                self.cross_session_memory = None
                self.proactive_engine = None

            # Phase 3: 任务感知模型路由
            try:
                from agent.llm.task_aware_model_router import TaskAwareModelRouter
                cap_router = getattr(self.llm, "_capability_router", None)
                self.task_aware_router = TaskAwareModelRouter(capability_router=cap_router)
                log.info("Task-aware Model Router ready")
            except Exception as _e:
                log.warning("Task-aware Model Router init failed", error=str(_e))
                self.task_aware_router = None

            # Phase 3+4: 行动安全沙箱 — 高风险操作拦截 + 操作回滚
            try:
                from agent.desktop.action_sandbox import ActionSandbox
                self.action_sandbox = ActionSandbox()
                log.info("Action Sandbox ready")
            except Exception as _e:
                log.warning("Action Sandbox init failed", error=str(_e))
                self.action_sandbox = None

            # Phase 3+4: 智能工具缓存 — 细粒度缓存 + 幂等性标记
            try:
                from agent.tools.smart_tool_cache import SmartToolCache
                self.smart_tool_cache = SmartToolCache()
                log.info("Smart Tool Cache ready")
            except Exception as _e:
                log.warning("Smart Tool Cache init failed", error=str(_e))
                self.smart_tool_cache = None

            # Phase 3+4: 工具自愈 — 工具调用失败时自动修复与降级
            try:
                from agent.tools.tool_self_healing import ToolSelfHealing
                self.tool_self_healing = ToolSelfHealing(
                    tool_registry=self.tool_registry,
                    trajectory_db=self.trajectory_db,
                    llm=self.llm,
                )
                log.info("Tool Self-Healing ready")
            except Exception as _e:
                log.warning("Tool Self-Healing init failed", error=str(_e))
                self.tool_self_healing = None

            log.info("Evolution Engine ready")
        except Exception as e:
            log.warning("Evolution Engine init failed", error=str(e))
            self.evolution = None
            self._mark_subsystem_degraded("evolution", str(e))

        if self.loop and self.evolution:
            self.loop.evolution = self.evolution

        # P0-修复2: 进化闭环注入 — EvolutionClosedLoop 在上方才创建（晚于 DebateHarness
        # 初始化），故 L5 进化层与 controller 报告反馈需在此补注入，修复时序 Bug。
        if self.loop and getattr(self, "evolution_closed_loop", None):
            self.loop.evolution_closed_loop = self.evolution_closed_loop
            if hasattr(self.loop, "_debate_harness") and self.loop._debate_harness:
                self.loop._debate_harness._evolution_closed_loop = self.evolution_closed_loop
                log.info("EvolutionClosedLoop injected into DebateHarness (L5)")

        # F8: 注入 EpisodicMemoryStore 到 ReflectionEngine，启用反思经验的情景记忆存储
        if self.loop and self.memory and hasattr(self.memory, '_episodic_store') and self.memory._episodic_store:
            try:
                self.loop.reflection._episodic_store = self.memory._episodic_store
                log.info("EpisodicMemoryStore injected into ReflectionEngine")
            except Exception as e:
                log.warning("EpisodicMemoryStore injection into ReflectionEngine failed", error=str(e))

        # F6: 注入 OrchestrationExecutor 到 LoopController，启用 DAG 调度
        if self.loop:
            try:
                from agent.orchestration.executor import OrchestrationExecutor, OrchestrationConfig
                self.loop._orchestration_executor = OrchestrationExecutor(
                    config=OrchestrationConfig(),
                )
                log.info("OrchestrationExecutor injected into LoopController")
            except Exception as e:
                log.warning("OrchestrationExecutor injection failed", error=str(e))

            # Phase 3+4: 注入 ActionSandbox / SmartToolCache / ToolSelfHealing 到 Executor
            try:
                executor = self.loop.executor
                if executor is not None:
                    if self.action_sandbox is not None:
                        executor._action_sandbox = self.action_sandbox
                    if self.smart_tool_cache is not None:
                        executor._smart_tool_cache = self.smart_tool_cache
                    if self.tool_self_healing is not None:
                        executor._tool_self_healing = self.tool_self_healing
                    log.info("ActionSandbox/SmartToolCache/ToolSelfHealing injected into Executor")
            except Exception as e:
                log.warning("Executor injection failed", error=str(e))

        # F4: 注入 FeedbackLoops 到 LoopController
        if self.loop and self.feedback_loops:
            self.loop._feedback_loops = self.feedback_loops
            log.info("FeedbackLoops injected into LoopController")

        # F7: 注入 ContextWindowManager 到 LoopController（在 context pipeline 初始化之后）
        # 此处先标记需要注入，实际注入在 context_window_manager 初始化后执行

        # GAP-02: 性能监控 + 自动进化触发
        try:
            self.performance_monitor = PerformanceMonitor()
            log.info("Performance Monitor ready")
        except Exception as e:
            log.warning("Performance Monitor init failed", error=str(e))
            self.performance_monitor = None
            self._mark_subsystem_degraded("performance_monitor", str(e))

        if self.performance_monitor and self.evolution:
            try:
                from agent.evolution.v2_engine import EvolutionEngineV2
                v2_engine = EvolutionEngineV2.get_instance()
                self.evolution_trigger = EvolutionTrigger(
                    evolution_engine=v2_engine,
                    monitor=self.performance_monitor,
                    config=EvolutionTriggerConfig(
                        strategy="moderate",
                        min_evolution_interval=300,
                        max_daily_evolutions=10,
                        auto_rollback=True,
                    ),
                )
                self.evolution_trigger.start()
                log.info("Evolution Trigger ready and started (GAP-02 integrated)")
            except Exception as e:
                log.warning("Evolution Trigger init failed", error=str(e))
                self.evolution_trigger = None

        # GAP-03: 经验泛化与迁移
        try:
            from agent.loop.reflection_knowledge_base import ReflectionKnowledgeBase
            kb = ReflectionKnowledgeBase.get_instance() if hasattr(ReflectionKnowledgeBase, 'get_instance') else ReflectionKnowledgeBase()
            self.fewshot_generalizer = FewShotGeneralizer(kb)
            log.info("FewShot Generalizer ready (GAP-03 integrated)")
        except Exception as e:
            log.warning("FewShot Generalizer init failed", error=str(e))
            self.fewshot_generalizer = None

        # GAP-06: 细粒度策略自适应
        try:
            self.strategy_adapter = StrategyAdapter()
            log.info("Strategy Adapter ready (GAP-06 integrated)")
        except Exception as e:
            log.warning("Strategy Adapter init failed", error=str(e))
            self.strategy_adapter = None

        # GAP-09: 多维度学习信号
        try:
            self.learning_signals = LearningSignalCollector()
            log.info("Learning Signal Collector ready (GAP-09 integrated)")
        except Exception as e:
            log.warning("Learning Signal Collector init failed", error=str(e))
            self.learning_signals = None

        # GAP-05: 增量重规划
        try:
            self.incremental_planner = IncrementalPlanner()
            log.info("Incremental Planner ready (GAP-05 integrated)")
        except Exception as e:
            log.warning("Incremental Planner init failed", error=str(e))
            self.incremental_planner = None

        # GAP-08: 规划质量预检
        try:
            self.plan_quality_checker = PlanQualityChecker()
            log.info("Plan Quality Checker ready (GAP-08 integrated)")
        except Exception as e:
            log.warning("Plan Quality Checker init failed", error=str(e))
            self.plan_quality_checker = None

        # GAP-10: 反思结果应用闭环
        try:
            self.reflection_applier = ReflectionApplicationManager()
            log.info("Reflection Applier ready (GAP-10 integrated)")
        except Exception as e:
            log.warning("Reflection Applier init failed", error=str(e))
            self.reflection_applier = None

        # 动态优先级评分
        try:
            self.priority_scorer = DynamicPriorityScorer()
            log.info("Dynamic Priority Scorer ready")
        except Exception as e:
            log.warning("Dynamic Priority Scorer init failed", error=str(e))
            self.priority_scorer = None

        # P0 接线修复：接入 EvolutionOrchestrator，启用进化编排/自动检测/验证回滚
        # 此前 EvolutionOrchestrator (725行) 完全未接入生产调用链，仅在测试中被调用
        try:
            orchestrator = EvolutionOrchestrator.get_instance()
            orchestrator.register_engines(evolution_engine=self.evolution)
            orchestrator.start()
            self._evolution_orchestrator = orchestrator
            log.info("Evolution Orchestrator started (auto-detection + rollback enabled)")
        except Exception as e:
            log.warning("Evolution Orchestrator init failed", error=str(e))
            self._evolution_orchestrator = None

        # W1-2/W1-3: EventBus 订阅者接线 — 打通学习信号闭环
        # DomainEventBus 已在 emit 端发布 domain.evolution.feedback / domain.tool.executed，
        # 但此前无任何订阅者消费。现将 EvolutionOrchestrator 和 StrategyAdapter 注册为订阅者，
        # 使学习信号通过事件驱动闭环运行。
        self._wire_domain_event_subscribers()

        if self.loop:
            try:
                self._multi_agent_orchestrator = MultiAgentOrchestrator(llm=self.llm)
                log.info("Multi-Agent Orchestrator ready (connected to LoopController)")
            except Exception as e:
                log.warning("Multi-Agent Orchestrator init failed", error=str(e))

        try:
            self.conversation = ConversationLoop(
                llm=self.llm,
                tool_registry=self.tool_registry,
                max_tool_rounds=10,
                permission_guard=self.permission_guard,
                schema_validator=self.schema_validator,
                tool_call_guard=self.tool_call_guard,
                approval_manager=self.approval_manager,
                hook_manager=self.hook_manager,
                tool_selector=self.select_openai_tools_for_input,
                # D8（审计 §1.7）：接入验证闭环，工具结果验证失败时回灌纠错提示。
                verification_loop=getattr(self, "verification_loop", None),
            )
            log.info("Conversation Loop ready (with safety modules + hooks + verification)")
        except Exception as e:
            log.warning("Conversation Loop init failed", error=str(e))
            self.conversation = None

        try:
            self.context_file_registry = ContextFileRegistry()
            self.context_reference_resolver = ContextReferenceResolver(
                project_root=str(__import__("pathlib").Path.cwd())
            )
            self.context_manager = ContextManager()
            self.context_manager.set_file_registry(self.context_file_registry)
            self.context_manager.set_reference_resolver(self.context_reference_resolver)
            self.context_compressor = ContextCompressor()
            self.context_window_manager = ContextWindowManager(
                max_tokens=8000,
                reserve_ratio=0.3,
                auto_compress=True,
            )
            # F7: 注入 ContextWindowManager 到 LoopController，启用循环级 Token 预算管理
            if self.loop and self.context_window_manager:
                self.loop._context_window_manager = self.context_window_manager
                log.info("ContextWindowManager injected into LoopController")
            log.info("Context Pipeline ready (with file registry, reference resolver, window manager)")
        except Exception as e:
            log.warning("Context Pipeline init failed", error=str(e))

        # 统一上下文编排器（默认关闭，通过环境变量启用）
        try:
            use_unified = os.environ.get("USE_UNIFIED_CONTEXT", "true").lower() == "true"
            if use_unified:
                self.unified_context_orchestrator = UnifiedContextOrchestrator(
                    use_cache=True,
                    cache_max_size=100,
                    cache_ttl=300,
                    enabled=True,
                )

                # 注册默认组件
                self.unified_context_orchestrator.register_component(SystemPromptComponent())
                self.unified_context_orchestrator.register_component(
                    PersonaComponent(persona_core=self.persona)
                )
                self.unified_context_orchestrator.register_component(
                    MemoryRetrievalComponent(memory_engine=self.memory)
                )
                self.unified_context_orchestrator.register_component(
                    FileContextComponent(file_registry=self.context_file_registry)
                )
                self.unified_context_orchestrator.register_component(TokenBudgetComponent())
                self.unified_context_orchestrator.register_component(ContextAssemblerComponent())

                try:
                    self.attention_focus = AttentionFocusEngine()
                    from agent.context.adapters.attention_focus import AttentionFocusComponent
                    self.unified_context_orchestrator.register_component(
                        AttentionFocusComponent(attention_engine=self.attention_focus)
                    )
                    log.info("Attention Focus Engine ready and registered")
                except Exception as e:
                    log.warning("Attention Focus Engine init failed", error=str(e))

                log.info(
                    "Unified Context Orchestrator ready",
                    components=self.unified_context_orchestrator.component_count,
                )
            else:
                log.info("Unified Context Orchestrator disabled (set USE_UNIFIED_CONTEXT=true to enable)")
        except Exception as e:
            log.warning("Unified Context Orchestrator init failed", error=str(e))
            self.unified_context_orchestrator = None

        try:
            self.persona = PersonaCore()
            log.info("Persona Core ready")
        except Exception as e:
            log.warning("Persona Core init failed", error=str(e))

        try:
            self.security = SecurityGuard()
            log.info("Security Guard ready")
        except Exception as e:
            log.warning("Security Guard init failed", error=str(e))

        try:
            self.verification = VerificationService()
            log.info("Verification Service ready")
        except Exception as e:
            log.warning("Verification Service init failed", error=str(e))

        try:
            self.output_guardrail = OutputGuardrailEngine()
            log.info("Output Guardrail Engine ready")
        except Exception as e:
            log.warning("Output Guardrail Engine init failed", error=str(e))
            self.output_guardrail = None

        try:
            self.skill_registry = SkillRegistry.get_instance()
            self.skill_registry.register_builtin_skills()
            log.info("Skill Registry ready", count=len(self.skill_registry.get_all_skills()))
        except Exception as e:
            log.warning("Skill Registry init failed", error=str(e))

        # 技能生命周期闭环：SkillHub（发现/安装/更新）+ SkillAudit（安全审计）→ SkillRegistry（执行）
        try:
            from agent.evolution.skill_audit import SkillAuditor
            self.skill_audit = SkillAuditor()
            log.info("Skill Auditor ready")
        except Exception as e:
            log.warning("Skill Auditor init failed", error=str(e))
            self.skill_audit = None

        try:
            from agent.evolution.skill_hub import SkillHub
            self.skill_hub = SkillHub(auditor=self.skill_audit)
            log.info("Skill Hub ready (with Auditor)")
        except Exception as e:
            log.warning("Skill Hub init failed", error=str(e))
            self.skill_hub = None

        try:
            self.session_store = SessionStore()
            log.info("Session Store ready")
        except Exception as e:
            log.warning("Session Store init failed", error=str(e))

        # 注册会话搜索工具（需要 session_store 实例）
        if self.tool_registry and self.session_store:
            try:
                from agent.tools.session_search_tool import register_session_search_tool
                register_session_search_tool(self.tool_registry, self.session_store)
                log.info("Session search tool registered")
            except Exception as e:
                log.warning("Session search tool registration failed", error=str(e))

        if self.trajectory_db:
            try:
                self.flywheel = TrajectoryFlywheel(self.trajectory_db, FlywheelConfig())
                log.info("Trajectory Flywheel ready")
            except Exception as e:
                log.warning("Trajectory Flywheel init failed", error=str(e))

        try:
            self.persistence = PersistenceService(
                memory_engine=self.memory,
                trajectory_db=self.trajectory_db,
            )
            await self.persistence.initialize()
            log.info("Persistence Service ready")
        except Exception as e:
            log.warning("Persistence Service init failed", error=str(e))

        if self.memory:
            try:
                self.curator = Curator(self.memory)
                log.info("Curator ready")
            except Exception as e:
                log.warning("Curator init failed", error=str(e))

        try:
            self.hook_manager = HookManager()
            self._setup_default_hooks()
            log.info("Hook Manager ready")
        except Exception as e:
            log.warning("Hook Manager init failed", error=str(e))
            self.hook_manager = None

        try:
            episodic_store = None
            if self.memory and hasattr(self.memory, '_episodic_store'):
                episodic_store = self.memory._episodic_store
            self.feedback_loops = FeedbackLoops(
                evolution_engine=self.evolution,
                memory_engine=self.memory,
                episodic_store=episodic_store,
            )
            log.info("Feedback Loops ready (with EpisodicMemoryStore)")
        except Exception as e:
            log.warning("Feedback Loops init failed", error=str(e))
            self.feedback_loops = None

        # A2A 协议初始化 — 发布本机 AgentCard，建立跨 Agent 通信能力
        # 此前 main.py 未挂载 A2A 路由、未发布 AgentCard，导致 A2A 模块完全闲置
        try:
            self.a2a_manager = await get_a2a_manager()

            # 加载远程 A2A Agent 端点（逗号分隔），供 OrchestratorAgent 主动发现远程 Agent
            remote_env = os.environ.get("A2A_REMOTE_AGENTS", "")
            self.a2a_remote_endpoints = [
                ep.strip() for ep in remote_env.split(",") if ep.strip()
            ]

            # 从环境变量构造 A2A 鉴权拦截器（入站校验 + 出站凭据注入）
            # 即使未配置鉴权（A2A_AUTH_TYPE=none 或缺失），也会创建一个 NONE 类型的拦截器
            self.a2a_auth_interceptor = A2AAuthInterceptor.from_env()
            auth_type_env = A2AAuthType.parse(os.environ.get("A2A_AUTH_TYPE", "none"))

            # 构造本机 AgentCard — id="agent:jiabaixing", capabilities=[TASK_EXECUTION]
            host = os.environ.get("AGENT_HOST", "0.0.0.0")
            port = int(os.environ.get("AGENT_PORT", "3112"))
            # 0.0.0.0 对外不可达，发布时使用 localhost 兜底
            publish_host = "localhost" if host in ("0.0.0.0", "") else host
            self.a2a_self_card = A2AAgentCard(
                id="agent:jiabaixing",
                name="Jiabaixing",
                description="家百星主 Agent — 提供任务执行、编排与多工具协作能力",
                url=f"http://{publish_host}:{port}/a2a",
                transport=A2ATransport.HTTP,
                capabilities=[
                    A2ACapability(
                        type=A2ACapabilityType.TASK_EXECUTION,
                        name="task-execution",
                        description="执行通用任务（代码、文件、桌面、网络、记忆）",
                    ),
                    A2ACapability(
                        type=A2ACapabilityType.ORCHESTRATION,
                        name="orchestration",
                        description="多 Agent 编排与协调",
                    ),
                ],
                # 公开自身鉴权类型（仅 type 字段，不暴露凭据），供远程 Agent 出站注入
                authentication={"type": auth_type_env.value},
                version="1.0.0",
                provider={"name": "Jiabaixing", "url": "https://jiabaixing.example.com"},
            )
            await self.a2a_manager.publish_agent_card(self.a2a_self_card)
            log.info(
                "A2A Protocol initialized",
                self_card_id=self.a2a_self_card.id,
                remote_endpoints=len(self.a2a_remote_endpoints),
                auth_type=auth_type_env.value,
            )
        except Exception as e:
            log.warning("A2A Protocol init failed", error=str(e))
            self.a2a_manager = None
            self.a2a_self_card = None
            self.a2a_auth_interceptor = None

        try:
            self.agent_registry = AgentRegistry.get_instance()
            agent_factory = AgentFactory.get_instance()
            for scene in AgentScene:
                agent = agent_factory.create_agent(scene)
                self.agent_registry.register(
                    name=agent.name,
                    agent=agent,
                    scene=scene,
                )
            self.orchestrator = OrchestratorAgent(
                registry=self.agent_registry,
                agent_factory=agent_factory,
                a2a_manager=self.a2a_manager,
                a2a_remote_endpoints=self.a2a_remote_endpoints,
                self_agent_id=self.a2a_self_card.id if self.a2a_self_card else "agent:jiabaixing",
                a2a_auth_interceptor=self.a2a_auth_interceptor,
            )
            log.info("Agent Registry + Orchestrator ready", agent_count=self.agent_registry.get_agent_count())
        except Exception as e:
            log.warning("Agent Registry + Orchestrator init failed", error=str(e))
            self.agent_registry = None
            self.orchestrator = None

        try:
            self.cron_scheduler = CronJobScheduler.get_instance()
            await self.cron_scheduler.start()
            log.info("Cron Job Scheduler ready")
        except Exception as e:
            log.warning("Cron Job Scheduler init failed", error=str(e))
            self.cron_scheduler = None

        try:
            self.sandbox = SandboxExecutor()
            log.info("Sandbox Executor ready")
        except Exception as e:
            log.warning("Sandbox Executor init failed", error=str(e))
            self.sandbox = None

        try:
            self.batch_processor = BatchProcessor(BatchConfig(concurrency=5))
            log.info("Batch Processor ready")
        except Exception as e:
            log.warning("Batch Processor init failed", error=str(e))
            self.batch_processor = None

        try:
            self.think_scrubber = ThinkScrubber()
            log.info("Think Scrubber ready")
        except Exception as e:
            log.warning("Think Scrubber init failed", error=str(e))
            self.think_scrubber = None

        # P3-#3: 生产埋点采集器（单例，OTel 未启用时为 NoOp）
        try:
            self.production_metrics = get_production_metrics_collector()
            log.info("Production Metrics Collector ready")
        except Exception as e:
            log.warning("Production Metrics Collector init failed", error=str(e))
            self.production_metrics = None

        # P3-#3: 持续反馈闭环 — 用户反馈 → 学习信号 → 进化引擎
        try:
            self.feedback_loop = ContinuousFeedbackLoop(
                evolution_engine=self.evolution,
                canary_manager=self.canary_manager,
                optimize_threshold=int(os.environ.get("FEEDBACK_OPTIMIZE_THRESHOLD", "100")),
                time_window_seconds=int(os.environ.get("FEEDBACK_OPTIMIZE_WINDOW", "86400")),
            )
            log.info("Continuous Feedback Loop ready")
        except Exception as e:
            log.warning("Continuous Feedback Loop init failed", error=str(e))
            self.feedback_loop = None

        self._mark_domains_initialized()
        await self.startup_domains()
        await self.hook_manager.trigger(ON_SESSION_START, session_id="engine", modules_loaded=True)
        log.info("Agent Engine fully initialized", module_count=20)

    def _setup_default_hooks(self) -> None:
        if not self.hook_manager:
            return

        async def log_tool_call(tool_name: str = "", **kwargs: Any) -> None:
            log.info("Hook: tool_call", tool=tool_name)

        async def log_tool_result(tool_name: str = "", success: bool = False, **kwargs: Any) -> None:
            if not success:
                log.warning("Hook: tool_failed", tool=tool_name)

        async def log_tool_error(tool_name: str = "", error: str = "", **kwargs: Any) -> None:
            log.error("Hook: tool_error", tool=tool_name, error=error)

        async def log_loop_event(event: str = "", **kwargs: Any) -> None:
            log.info(f"Hook: {event}", **kwargs)

        async def check_budget(used: int = 0, limit: int = 0, **kwargs: Any) -> None:
            if used > limit * 0.8:
                log.warning("Hook: budget_high", used=used, limit=limit, pct=f"{used/limit*100:.0f}%")

        self.hook_manager.on(BEFORE_TOOL_CALL, log_tool_call, hook_type="gateway", priority=10, label="log_tool_call")
        self.hook_manager.on(AFTER_TOOL_CALL, log_tool_result, hook_type="gateway", priority=10, label="log_tool_result")
        self.hook_manager.on(ON_TOOL_ERROR, log_tool_error, hook_type="gateway", priority=10, label="log_tool_error")
        self.hook_manager.on(BEFORE_LOOP, log_loop_event, hook_type="lifecycle", priority=20, label="log_before_loop")
        self.hook_manager.on(AFTER_LOOP, log_loop_event, hook_type="lifecycle", priority=20, label="log_after_loop")
        self.hook_manager.on(ON_BUDGET_EXCEEDED, check_budget, hook_type="lifecycle", priority=5, label="check_budget")

    async def build_context(
        self,
        user_input: str,
        session_id: str = "default",
        scene: str = "daily",
        system_prompt: str = "",
        history: list[dict[str, str]] | None = None,
        use_memory: bool = True,
        use_file_context: bool = True,
        max_tokens: int = 8000,
        **kwargs: Any,
    ) -> ContextBuildResult | None:
        """使用统一上下文编排器构建上下文

        这是一个便捷方法，封装了统一上下文编排器的调用。
        如果编排器未启用，则返回 None。

        Args:
            user_input: 用户输入
            session_id: 会话ID
            scene: 场景类型
            system_prompt: 基础系统Prompt
            history: 历史消息
            use_memory: 是否使用记忆
            use_file_context: 是否使用文件上下文
            max_tokens: 最大Token数
            **kwargs: 其他参数

        Returns:
            ContextBuildResult | None: 构建结果，如果编排器未启用则返回None
        """
        if not self.unified_context_orchestrator:
            return None

        request = ContextBuildRequest(
            user_input=user_input,
            session_id=session_id,
            scene=scene,
            system_prompt=system_prompt,
            history=history,
            use_memory=use_memory,
            use_file_context=use_file_context,
            max_tokens=max_tokens,
            **kwargs,
        )

        return await self.unified_context_orchestrator.build_context(request)

    async def process_input(
        self,
        message: str,
        session_id: str = "default",
        context_files: list[str] | None = None,
        use_loop: bool | None = None,
        use_tools: bool = True,
        user_id: str | None = None,
        strategy_name: str | None = None,
        trace_id: str | None = None,
        history: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        import time
        # P3-#3: 请求埋点 — 记录起始时间用于耗时计算
        _req_start = time.time()
        with self._counter_lock:
            self._session_count += 1
            self._active_sessions += 1
            _current_active = self._active_sessions
        try:
            set_active_sessions(_current_active)
        except Exception as _exc:
            log_ignored(log, "engine.AgentEngine.process_input", _exc)

        try:
            if self.hook_manager:
                await self.hook_manager.trigger(BEFORE_LOOP, session_id=session_id)

            if self.security:
                sec_result = self.security.check_command(message)
                if not sec_result.allowed:
                    try:
                        await self.domain_events.emit("domain.security.violation", {
                            "session_id": session_id,
                            "reasons": sec_result.blocked_reasons,
                            "input_preview": message[:100],
                        })
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine.process_input", _exc)
                    return {
                        "content": f"请求被安全策略拦截: {'; '.join(sec_result.blocked_reasons)}",
                        "session_id": session_id,
                        "trace_id": f"blocked_{self._session_count}",
                        "intent": "blocked",
                        "quality_score": 0.0,
                        "tool_calls_made": 0,
                        "rounds_used": 0,
                        "duration": 0.0,
                        "finish_reason": "blocked",
                    }

            context_text = ""
            if context_files and self.context_file_registry:
                try:
                    entries = self.context_file_registry.load_all()
                    for entry in entries:
                        if entry.file_name in context_files or any(
                            entry.file_name.endswith(f) for f in context_files
                        ):
                            context_text += f"\n\n--- {entry.file_name} ---\n{entry.content[:2000]}"
                # 上下文文件加载失败不影响主流程，静默跳过
                except (OSError, IOError, ValueError, KeyError) as _exc:
                    log_ignored(log, "engine.AgentEngine.process_input", _exc)

            if self.context_reference_resolver:
                try:
                    resolved = self.context_reference_resolver.resolve(message)
                    if resolved.has_references and resolved.resolved_content:
                        context_text += "\n\n" + resolved.resolved_content
                        message = resolved.cleaned_input
                except Exception as _exc:
                    log_ignored(log, "engine.AgentEngine.process_input", _exc)

            if context_text:
                message = context_text + "\n\n--- 用户输入 ---\n" + message

            should_use_loop = use_loop
            if should_use_loop is None:
                should_use_loop = self._should_use_loop(message)

            strategy = self._resolve_execution_strategy(message, should_use_loop)
            strategy_impl = self.get_loop_strategy(strategy)
            if strategy == "multi_agent" and strategy_impl is not None:
                orch_result = await self._multi_agent_orchestrator.process_goal_with_loop(
                    goal=message,
                    context={},
                    loop_controller=self.loop,
                )
                orch_output = orch_result.summary
                if self.verification and orch_output:
                    try:
                        safety = self.verification.check_output_safety(orch_output)
                        if not safety.safe:
                            orch_output = safety.sanitized_output or orch_output
                    except Exception as _sec_exc:
                        # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                        # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                        log.error(
                            "安全检查异常，该项校验已跳过",
                            check="output_safety",
                            error=str(_sec_exc),
                        )
                        self._mark_subsystem_degraded("verification", f"output_safety 检查异常: {_sec_exc}")
                    try:
                        guardrail_result = self.verification.check_guardrails(orch_output)
                        if not guardrail_result.passed:
                            orch_output = "抱歉，无法提供该内容（安全检查未通过）"
                    except Exception as _sec_exc:
                        # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                        # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                        log.error(
                            "安全检查异常，该项校验已跳过",
                            check="guardrails",
                            error=str(_sec_exc),
                        )
                        self._mark_subsystem_degraded("verification", f"guardrails 检查异常: {_sec_exc}")
                if self.output_guardrail and orch_output:
                    try:
                        guard_result = self.output_guardrail.check(orch_output)
                        if not guard_result.passed:
                            log.warning(
                                "Multi-agent output blocked by guardrail",
                                reason=guard_result.reason,
                                risk_level=guard_result.risk_level,
                            )
                            orch_output = "抱歉，输出内容被安全策略拦截"
                    except Exception as _sec_exc:
                        # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                        # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                        log.error(
                            "安全检查异常，该项校验已跳过",
                            check="output_guardrail",
                            error=str(_sec_exc),
                        )
                        self._mark_subsystem_degraded("verification", f"output_guardrail 检查异常: {_sec_exc}")
                if self.session_store:
                    try:
                        self.session_store.add_message(session_id, "user", message)
                        self.session_store.add_message(session_id, "assistant", orch_output)
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine.process_input", _exc)
                result = {
                    "content": orch_output,
                    "session_id": session_id,
                    "trace_id": f"orch_{self._session_count}",
                    "intent": "multi_agent_orchestration",
                    "quality_score": orch_result.quality_score,
                    "tool_calls_made": len(orch_result.sub_results),
                    "rounds_used": getattr(orch_result, "rounds_used", 1),
                    "duration": getattr(orch_result, "duration", orch_result.duration_ms / 1000.0 if orch_result.duration_ms else 0.0),
                    "finish_reason": "stop" if orch_result.success else "error",
                    "tool_activities": [
                        {"name": sr.agent_name, "success": sr.success, "error": sr.error}
                        for sr in orch_result.sub_results
                    ],
                }
            elif strategy in ("plan_exec_eval", "react") and strategy_impl is not None:
                result = await self._process_with_loop(message, session_id, user_id=user_id, strategy_name=strategy, external_history=history)
            elif strategy == "simple" and strategy_impl is not None:
                result = await self._process_with_conversation(message, session_id, use_tools, trace_id=trace_id)
            elif should_use_loop and self.loop:
                result = await self._process_with_loop(message, session_id, user_id=user_id, strategy_name=strategy_name, external_history=history)
            elif self.conversation:
                result = await self._process_with_conversation(message, session_id, use_tools, trace_id=trace_id)
            else:
                result = await self._process_simple(message, session_id, trace_id=trace_id)

            if self.feedback_loops:
                try:
                    tool_failures = []
                    for tc in result.get("tool_activities", []):
                        if tc.get("error"):
                            tool_failures.append({"tool_name": tc.get("name", ""), "error": tc.get("error", "")})
                    await self.feedback_loops.run_all(
                        user_input=message,
                        response=result.get("content", ""),
                        quality_score=result.get("quality_score", 0.5),
                        tool_failures=tool_failures,
                        user_corrections=[],
                        session_id=session_id,
                    )
                except Exception as _exc:
                    log_ignored(log, "engine.AgentEngine.process_input", _exc)

            try:
                tool_acts = result.get("tool_activities", [])
                if tool_acts:
                    await self.domain_events.emit("domain.tool.executed", {
                        "session_id": session_id,
                        "tool_count": len(tool_acts),
                        "tool_names": [tc.get("name", "") for tc in tool_acts[:10]],
                        "failures": len([tc for tc in tool_acts if tc.get("error")]),
                    })
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine.process_input", _exc)

            if self.hook_manager:
                await self.hook_manager.trigger(
                    AFTER_LOOP,
                    session_id=session_id,
                    trace_id=result.get("trace_id", ""),
                    quality_score=result.get("quality_score", 0),
                )

            # P3-#3: 请求成功埋点 — 记录请求耗时 + 工具调用
            if self.production_metrics:
                try:
                    _duration_ms = (time.time() - _req_start) * 1000
                    self.production_metrics.record_request(
                        user_id=session_id,
                        intent=result.get("intent", "") or "",
                        status="success",
                        duration_ms=_duration_ms,
                    )
                    for tc in result.get("tool_activities", []):
                        self.production_metrics.record_tool_call(
                            tool_name=tc.get("name", "unknown"),
                            success=not bool(tc.get("error")),
                            duration_ms=float(tc.get("duration_ms", 0.0) or 0.0),
                        )
                except Exception as _exc:
                    log_ignored(log, "engine.AgentEngine.process_input", _exc)

            return result
        except Exception as exc:
            # P3-#3: 错误埋点 — 记录异常类型与请求耗时
            if self.production_metrics:
                try:
                    try:
                        _duration_ms = (time.time() - _req_start) * 1000
                    except NameError:
                        _duration_ms = 0.0
                    self.production_metrics.record_request(
                        user_id=session_id,
                        intent="error",
                        status="failed",
                        duration_ms=_duration_ms,
                    )
                    self.production_metrics.record_error(
                        error_type=type(exc).__name__,
                        error_message=str(exc),
                    )
                except Exception as _exc:
                    log_ignored(log, "engine.AgentEngine.process_input", _exc)
            raise
        finally:
            # 会话结束：递减活跃会话数并更新 gauge
            with self._counter_lock:
                self._active_sessions = max(0, self._active_sessions - 1)
                _current_active = self._active_sessions
            try:
                set_active_sessions(_current_active)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine.process_input", _exc)

    def _should_use_loop(self, message: str) -> bool:
        complex_indicators = [
            "分析", "对比", "设计", "实现", "优化", "重构",
            "迁移", "集成", "部署", "步骤", "流程", "方案",
        ]
        tool_indicators = ["搜索", "查找", "读取", "修改", "执行", "运行"]
        complex_score = sum(1 for kw in complex_indicators if kw in message)
        tool_score = sum(1 for kw in tool_indicators if kw in message)
        if complex_score >= 2:
            return True
        if complex_score >= 1 and tool_score >= 1:
            return True
        # 两个及以上工具动词即视为多步任务（如"搜索并读取文件内容"）。
        # 此前门槛为 >=3，导致串联双工具任务被判为"简单"而绕过 ReAct 循环，
        # 走单轮 _process_simple 路径 —— 属静默路由降级。见审计报告 §1.7。
        if tool_score >= 2:
            return True
        return False

    async def _process_simple(
        self,
        message: str,
        session_id: str = "default",
        trace_id: str | None = None,
    ) -> dict[str, Any]:
        context_parts: list[str] = []
        memory_results: list[dict[str, Any]] = []

        if self.memory:
            try:
                mem_results = await self.memory.search_with_context(
                    query=message, recent_hours=48.0, limit=5,
                )
                memory_results = mem_results
                if mem_results:
                    context_parts.append("相关记忆:")
                    for m in mem_results[:3]:
                        context_parts.append(f"  - {m['content']}")
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_simple", _exc)

        system_content = (
            "你是家百星（Jiabaixing），一个智能AI助手。"
            "你拥有57个工具，必须主动使用工具完成任务。"
            "即使是简单问候，也要检查是否有相关上下文可以展示。"
            "用简洁、友好的方式回答，展示你的思考过程和工具调用结果。"
        )
        if context_parts:
            system_content += "\n\n" + "\n".join(context_parts)

        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": message},
        ]
        core = self.domains.get("core")
        if core is not None and core.is_initialized:
            result = await core.invoke(messages=messages)
        else:
            result = await self.llm.chat(messages=messages)
        response_content = result.get("content", "")

        if self.verification and response_content:
            try:
                safety = self.verification.check_output_safety(response_content)
                if not safety.safe:
                    response_content = safety.sanitized_output or response_content
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="output_safety",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"output_safety 检查异常: {_sec_exc}")
            try:
                guardrail_result = self.verification.check_guardrails(response_content)
                if not guardrail_result.passed:
                    response_content = "抱歉，无法提供该内容（安全检查未通过）"
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="guardrails",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"guardrails 检查异常: {_sec_exc}")
        if self.output_guardrail and response_content:
            try:
                guard_result = self.output_guardrail.check(response_content)
                if not guard_result.passed:
                    log.warning(
                        "Simple output blocked by guardrail",
                        reason=guard_result.reason,
                        risk_level=guard_result.risk_level,
                    )
                    response_content = "抱歉，输出内容被安全策略拦截"
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="output_guardrail",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"output_guardrail 检查异常: {_sec_exc}")

        _simple_quality = min(1.0, max(0.3, len(response_content) / 200.0)) if response_content else 0.1

        try:
            await self.domain_events.emit("domain.core.llm_invoked", {
                "session_id": session_id, "strategy": "simple",
                "response_len": len(response_content),
                "quality": _simple_quality, "duration_ms": 0.0,
            })
        except Exception as _exc:
            log_ignored(log, "engine.AgentEngine._process_simple", _exc)

        if self.memory:
            try:
                await self.memory.store_instant(message, scene="chat")
                await self.memory.store_short_term(response_content, scene="chat_response")
                await self._auto_reflect(message, response_content, session_id)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_simple", _exc)

        if self.evolution:
            try:
                from agent.evolution.types import FeedbackSignal
                import time
                await self.evolution.collect_feedback(FeedbackSignal(
                    interaction_id=f"py_{self._session_count}",
                    quality_score=_simple_quality,
                    cause="chat",
                    timestamp=time.time(),
                    scene="chat",
                    response_length=len(response_content),
                ))
                try:
                    await self.domain_events.emit("domain.evolution.feedback", {
                        "session_id": session_id, "cause": "chat",
                        "quality_score": _simple_quality, "scene": "chat",
                        "response_time_ms": 0.0, "tool_successes": True,
                    })
                except Exception as _exc:
                    log_ignored(log, "engine.AgentEngine._process_simple", _exc)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_simple", _exc)

        # GAP-09: 学习信号（simple 路径）
        if self.learning_signals:
            try:
                self.learning_signals.record_signal(
                    signal_type="task_success" if _simple_quality >= 0.6 else "task_partial",
                    value=_simple_quality,
                    source="simple",
                    context={"session_id": session_id},
                )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_simple", _exc)

        # GAP-06: 策略自适应（simple 路径）
        if self.strategy_adapter:
            try:
                self.strategy_adapter.record_outcome("chat", "simple", success=_simple_quality >= 0.6)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_simple", _exc)

        # GAP-02: 性能监控（simple 路径）
        if self.performance_monitor:
            try:
                self.performance_monitor.record_metric("task_completion", success=_simple_quality >= 0.6, duration=0.0)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_simple", _exc)

        if self.session_store:
            try:
                self.session_store.add_message(session_id, "user", message)
                self.session_store.add_message(session_id, "assistant", response_content)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_simple", _exc)

        return {
            "content": response_content,
            "session_id": session_id,
            "trace_id": trace_id or f"py_{self._session_count}_{id(self):x}",
            "intent": "",
            "related_files": [],
            "tool_activities": [],
            "tool_calls_made": 0,
            "rounds_used": 1,
            "duration": 0.0,
            "finish_reason": "stop",
            "quality_score": _simple_quality,
        }

    async def _process_with_conversation(
        self,
        message: str,
        session_id: str = "default",
        use_tools: bool = True,
        trace_id: str | None = None,
    ) -> dict[str, Any]:
        system_prompt = (
            "你是家百星（Jiabaixing），一个智能AI助手。\n\n"
            "# 核心原则\n"
            "- 你拥有57个工具（文件读写/代码执行/Web搜索/MCP服务等），必须主动使用工具完成任务\n"
            "- 即使是简单问候，也要先检查是否有相关上下文或待办事项可以展示\n"
            "- 绝不允许'为了省算力不调工具'——工具是你的核心能力\n\n"
            "# ReAct 思维模式\n"
            "对每个用户输入，按以下流程思考：\n"
            "1. Thought: 分析用户意图，判断是否需要工具\n"
            "2. Action: 如果需要，选择最合适的工具并调用\n"
            "3. Observation: 分析工具返回结果\n"
            "4. Reflection: 结果是否满足需求？是否需要修正参数重试？\n"
            "5. Response: 基于所有观察给出最终回复\n\n"
            "# 工具使用规则\n"
            "- 优先使用工具获取真实数据，不要凭记忆猜测\n"
            "- 工具失败时分析原因、修正参数后重试，最多3次\n"
            "- 多步任务时依次调用工具，逐步推进\n"
            "- 回复中要说明你做了什么操作、得到了什么结果\n\n"
            "# 输出要求\n"
            "- 用简洁、友好的方式回答\n"
            "- 展示你的思考过程和工具调用结果\n"
            "- 如果不确定，先用工具验证再回答"
        )

        if self.evolution:
            try:
                evo_section = self.evolution.build_evolution_prompt_section()
                if evo_section:
                    system_prompt += "\n\n" + evo_section
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        memories: list[str] = []
        history: list[dict[str, str]] = []
        memory_results: list[dict[str, Any]] = []

        if self.memory:
            try:
                mem_results = await self.memory.search_with_context(
                    query=message, recent_hours=48.0, limit=5,
                )
                memory_results = mem_results
                memories = [m["content"] for m in mem_results[:3]]
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        if self.session_store:
            try:
                msgs = self.session_store.get_messages(session_id, limit=10)
                history = [{"role": m.role, "content": m.content} for m in msgs]
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        if self.context_manager:
            scene = ContextManager.infer_scene(message)
            persona_summary = self.persona.build_persona_summary() if self.persona else ""
            tone_instruction = self.persona.build_scene_tone_instruction(scene) if self.persona else ""

            built_messages = self.context_manager.build_context(
                user_input=message,
                system_prompt=system_prompt,
                memories=memories,
                history=history,
                persona_summary=persona_summary + "\n" + tone_instruction if persona_summary else "",
                scene=scene,
            )

            if self.context_window_manager:
                compressed_msgs, compression = self.context_window_manager.check_and_compress(
                    built_messages
                )
                if compression and compression.ratio < 1.0:
                    log.info(
                        "Context compressed",
                        strategy=compression.strategy,
                        ratio=f"{compression.ratio:.2f}",
                    )
                    if self.hook_manager:
                        await self.hook_manager.trigger(
                            ON_BUDGET_EXCEEDED,
                            used=compression.original_tokens,
                            limit=compression.original_tokens,
                        )
                if compression and compression.summary:
                    compressed_msgs = [
                        m for m in compressed_msgs
                        if m.get("role") != "system" or "历史对话摘要" not in m.get("content", "")
                    ]
                    compressed_msgs.insert(1, {"role": "system", "content": compression.summary})
                built_messages = compressed_msgs
            elif self.context_compressor:
                compression = self.context_compressor.compress_with_attention(
                    built_messages,
                    memory_results=memory_results if memory_results else None,
                )
                if compression.ratio < 1.0:
                    log.info(
                        "Context compressed",
                        strategy=compression.strategy,
                        ratio=f"{compression.ratio:.2f}",
                        attention_keywords=compression.attention_keywords[:5],
                    )
                if compression.summary:
                    built_messages = [
                        m for m in built_messages
                        if m.get("role") != "system" or "历史对话摘要" not in m.get("content", "")
                    ]
                    built_messages.insert(1, {"role": "system", "content": compression.summary})

            system_prompt = ""
            for msg in built_messages:
                if msg["role"] == "system" and not system_prompt:
                    system_prompt = msg["content"]
                elif msg["role"] == "system":
                    system_prompt += "\n\n" + msg["content"]

            history = [
                {"role": m["role"], "content": m["content"]}
                for m in built_messages
                if m["role"] in ("user", "assistant")
            ]

        conv_result = await self.conversation.run(
            user_input=message,
            session_id=session_id,
            system_prompt=system_prompt or None,
            history=history if history else None,
            use_tools=use_tools,
        )

        output_content = conv_result.content

        if self.verification:
            try:
                safety = self.verification.check_output_safety(output_content)
                if not safety.safe:
                    output_content = safety.sanitized_output or output_content
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="output_safety",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"output_safety 检查异常: {_sec_exc}")

            try:
                guardrail_result = self.verification.check_guardrails(output_content)
                if not guardrail_result.passed:
                    output_content = "抱歉，无法提供该内容（安全检查未通过）"
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="guardrails",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"guardrails 检查异常: {_sec_exc}")

        if self.output_guardrail and output_content:
            try:
                guard_result = self.output_guardrail.check(output_content)
                if not guard_result.passed:
                    log.warning(
                        "Output blocked by guardrail",
                        reason=guard_result.reason,
                        risk_level=guard_result.risk_level,
                    )
                    output_content = "抱歉，输出内容被安全策略拦截"
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="output_guardrail",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"output_guardrail 检查异常: {_sec_exc}")

        quality_score = conv_result.quality_score if conv_result.quality_score > 0 else (0.7 if conv_result.finish_reason == "stop" else 0.4)
        if self.verification:
            try:
                quality = self.verification.score_quality({
                    "loop_count": conv_result.rounds_used,
                    "total_tool_calls": conv_result.tool_calls_made,
                    "total_tool_duration": 0.0,
                    "total_duration": (conv_result.duration or 0.0) * 1000,
                    "completed_successfully": conv_result.finish_reason == "stop",
                })
                quality_score = quality.overall
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        # GAP-09: 多维度学习信号采集
        if self.learning_signals:
            try:
                self.learning_signals.record_signal(
                    signal_type="task_success" if quality_score >= 0.6 else "task_partial",
                    value=quality_score,
                    source="conversation",
                    context={"session_id": session_id, "rounds": conv_result.rounds_used},
                )
                if conv_result.tool_calls_made > 0:
                    self.learning_signals.record_signal(
                        signal_type="tool_usage",
                        value=float(conv_result.tool_calls_made),
                        source="conversation",
                    )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        # GAP-06: 策略自适应 — 根据结果调整策略
        if self.strategy_adapter:
            try:
                scene = ContextManager.infer_scene(message) if self.context_manager else "daily"
                success = quality_score >= 0.6
                self.strategy_adapter.record_outcome(scene, "conversation", success=success)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        # GAP-02: 性能监控指标记录
        if self.performance_monitor:
            try:
                self.performance_monitor.record_metric(
                    "task_completion",
                    success=quality_score >= 0.6,
                    duration=conv_result.duration or 0.0,
                )
                # GAP-02 闭环：检查告警并触发自动进化
                alerts = self.performance_monitor.check_alerts()
                if alerts and self.evolution_trigger:
                    try:
                        await self.evolution_trigger._check_and_trigger()
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        # GAP-06 闭环：策略自适应 — 读取最优策略
        if self.strategy_adapter:
            try:
                scene = ContextManager.infer_scene(message) if self.context_manager else "daily"
                best = self.strategy_adapter.get_best_strategy(scene)
                if best and best.confidence >= 0.7:
                    log.info(
                        "Strategy recommendation available",
                        scene=scene,
                        strategy=best.strategy_name,
                        confidence=round(best.confidence, 2),
                    )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        # GAP-09 闭环：学习信号分析
        if self.learning_signals:
            try:
                insights = self.learning_signals.analyze_signals()
                if insights and insights.weak_areas:
                    log.warning(
                        "Learning signal weak areas",
                        weak_areas=insights.weak_areas,
                        trend=insights.signal_trend,
                    )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        if self.verification and quality_score == 0.0:
            try:
                quality = self.verification.score_quality({
                    "loop_count": conv_result.rounds_used,
                    "total_tool_calls": conv_result.tool_calls_made,
                    "total_tool_duration": 0.0,
                    "total_duration": (conv_result.duration or 0.0) * 1000,
                    "completed_successfully": conv_result.finish_reason == "stop",
                })
                quality_score = quality.overall
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        if self.memory:
            try:
                await self.memory.store_instant(message, scene="conversation")
                await self.memory.store_short_term(output_content, scene="conversation_response")
                tool_names = [tc.get("name", "") for tc in conv_result.metadata.get("tool_calls", [])]
                if tool_names:
                    await self.memory.store_episodic(
                        event=f"用户请求: {message[:100]}",
                        participants=tool_names,
                        outcome="成功" if conv_result.finish_reason == "stop" else "部分完成",
                        emotion="positive" if quality_score >= 0.6 else "neutral",
                    )
                await self._auto_reflect(message, output_content, session_id, quality_score, tool_names)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        if self.session_store:
            try:
                self.session_store.add_message(session_id, "user", message)
                self.session_store.add_message(session_id, "assistant", output_content)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        if self.evolution:
            try:
                from agent.evolution.types import FeedbackSignal
                import time as _t
                raw_tool_calls = conv_result.metadata.get("tool_calls", [])
                raw_tool_results = conv_result.metadata.get("tool_results", [])
                tool_names = [tc.get("name", "") for tc in raw_tool_calls if tc.get("name")]
                tool_successes: dict[str, bool] = {}
                for tr in raw_tool_results:
                    name = tr.get("name", "")
                    if name:
                        tool_successes[name] = tr.get("success", True)
                scene = ContextManager.infer_scene(message) if self.context_manager else ""
                await self.evolution.collect_feedback(FeedbackSignal(
                    interaction_id=conv_result.trace_id,
                    quality_score=quality_score,
                    cause="conversation",
                    tool_name=tool_names[0] if tool_names else None,
                    timestamp=_t.time(),
                    tools_used=tool_names,
                    tool_successes=tool_successes,
                    session_id=session_id,
                    scene=scene,
                    response_length=len(output_content),
                    rounds_used=conv_result.rounds_used,
                ))
                plan = await self.evolution.should_evolve()
                if plan:
                    log.info("Evolution triggered", plan_type=plan.evolution_type, priority=plan.priority)
                    await self.evolution.execute_evolution(plan)

                if self.evolution:
                    nudge = self.evolution.nudge_knowledge_persistence(message, tool_names)
                    if nudge:
                        log.info("Knowledge persistence nudge", nudge=nudge[:80])
                        try:
                            if self.memory:
                                await self.memory.store_long_term(
                                    f"用户偏好提醒: {nudge}",
                                    scene="knowledge_nudge",
                                )
                        except Exception as _exc:
                            log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

                if quality_score >= 0.7 and tool_names:
                    try:
                        skill_name = self.evolution.generate_skill({
                            "input": message,
                            "response": output_content,
                            "tools_used": tool_names,
                            "quality_score": quality_score,
                            "scene": scene,
                        })
                        if skill_name:
                            log.info("Skill auto-generated", skill_name=skill_name)
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        if self.trajectory_db:
            try:
                import time as _t
                self.trajectory_db.record_execution(ExecutionRecord(
                    id=conv_result.trace_id,
                    input=message[:500],
                    response=output_content[:500],
                    status="success" if conv_result.finish_reason == "stop" else "failed",
                    quality_overall=quality_score,
                    loop_rounds=conv_result.rounds_used,
                    total_tool_calls=conv_result.tool_calls_made,
                    total_duration=int(conv_result.duration * 1000) if conv_result.duration else 0,
                    created_at=int(_t.time() * 1000),
                    updated_at=int(_t.time() * 1000),
                ))
                for tc in conv_result.metadata.get("tool_calls", []):
                    self.trajectory_db.record_tool_invocation(ToolInvocationRecord(
                        execution_id=conv_result.trace_id,
                        step_index=tc.get("index", 0),
                        tool_name=tc.get("name", "unknown"),
                        args_json=str(tc.get("arguments", {})),
                        result_success=1,
                    ))
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_conversation", _exc)

        return {
            "content": output_content,
            "session_id": conv_result.session_id,
            "trace_id": trace_id or conv_result.trace_id,
            "intent": "",
            "related_files": [],
            "tool_activities": conv_result.metadata.get("tool_calls", []),
            "tool_calls_made": conv_result.tool_calls_made,
            "rounds_used": conv_result.rounds_used,
            "duration": conv_result.duration,
            "finish_reason": conv_result.finish_reason,
            "quality_score": quality_score,
        }

    async def _process_with_loop(
        self,
        message: str,
        session_id: str = "default",
        cancel_token: "asyncio.Event | None" = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
        external_history: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        # P0-4: 构建统一上下文（系统提示、人格、记忆、文件上下文、注意力聚焦）
        system_messages: list[dict[str, str]] = []
        if self.unified_context_orchestrator:
            try:
                ctx_result = await self.build_context(
                    user_input=message,
                    session_id=session_id,
                    scene="daily",
                    use_memory=True,
                    use_file_context=True,
                )
                if ctx_result and ctx_result.messages:
                    system_messages = ctx_result.messages
            except Exception as e:
                log.warning("Unified context build failed, using default", error=str(e))

        # 加载会话历史，避免 loop 模式失忆
        history: list[dict[str, str]] = []
        if external_history:
            history = external_history
        elif self.session_store:
            try:
                msgs = self.session_store.get_messages(session_id, limit=10)
                history = [{"role": m.role, "content": m.content} for m in msgs]
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # 合并历史到 messages（系统消息 + 历史 + 用户消息由 loop 内部追加）
        all_messages = system_messages + history if history else system_messages

        # P1: 澄清交互集成 — 模糊度检测 + 系统提示增强
        ambiguity_result = None
        if self.clarification_engine:
            ambiguity_result = self.clarification_engine.detect_ambiguity(message)
            if ambiguity_result.is_ambiguous:
                log.info(
                    "Ambiguity detected",
                    level=ambiguity_result.level.value,
                    dimensions=[d.value for d in ambiguity_result.dimensions],
                    confidence=ambiguity_result.confidence,
                )
                if system_messages:
                    for msg in system_messages:
                        if msg.get("role") == "system":
                            msg["content"] = self.clarification_engine.enhance_system_prompt(
                                msg["content"]
                            )
                elif all_messages:
                    for msg in all_messages:
                        if msg.get("role") == "system":
                            msg["content"] = self.clarification_engine.enhance_system_prompt(
                                msg["content"]
                            )

        effective_strategy = strategy_name or self.select_loop_strategy(message)
        loop_strategy = self.get_loop_strategy(effective_strategy)
        if loop_strategy is not None and hasattr(loop_strategy, "run"):
            result = await loop_strategy.run(
                input_text=message,
                messages=all_messages or None,
                session_id=session_id,
                cancel_event=cancel_token,
                user_id=user_id,
                strategy_name=effective_strategy,
            )
        else:
            result = await self.loop.run(
                input_text=message,
                messages=all_messages or None,
                session_id=session_id,
                cancel_event=cancel_token,
                user_id=user_id,
                strategy_name=strategy_name,
            )

        output_content = result.response

        try:
            try:
                _elapsed_ms = (time.time() - _req_start) * 1000
            except NameError:
                _elapsed_ms = 0.0
            await self.domain_events.emit("domain.core.llm_invoked", {
                "session_id": session_id, "strategy": effective_strategy,
                "steps_completed": getattr(result, "steps_completed", 0),
                "success": getattr(result, "success", True),
                "quality": getattr(result, "quality_score", 0.5),
                "duration_ms": _elapsed_ms,
            })
        except Exception as _exc:
            log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # P1: 验证闭环集成 — 使用 VerificationLoop 统一验证响应
        verification_result = None
        if self.verification_loop:
            try:
                vcontext = {
                    "loop_count": result.steps_completed,
                    "total_tool_calls": result.metadata.get("total_tool_calls", 0),
                    "total_tool_duration": result.metadata.get("total_tool_duration", 0.0),
                    "total_duration": result.metadata.get("duration", 0.0),
                    "completed_successfully": result.success,
                }
                verification_result = self.verification_loop.verify_response(
                    output_content, context=vcontext,
                )
                self.verification_loop.record_step(verification_result)

                if verification_result.action == "block":
                    log.warning(
                        "Response blocked by verification",
                        action=verification_result.action,
                        message=verification_result.message,
                    )
                    output_content = "抱歉，无法提供该内容（安全检查未通过）"
                elif verification_result.action == "retry":
                    # D8（审计 §1.7）+ P1-5 增强：RETRY 动作现在真正触发重执行。
                    # 原实现仅将 correction 挂到 metadata（零调用点死方法），
                    # 现在改为：将纠错提示注入 messages，使下一轮 LLM 调用
                    # 能看到验证失败的原因并自动修正，形成真正的闭环。
                    correction = self.verification_loop.build_correction_prompt(
                        verification_result, output_content,
                    )
                    log.warning(
                        "Response verification requested retry",
                        action=verification_result.action,
                        message=verification_result.message,
                        has_correction=bool(correction),
                    )
                    if correction:
                        result.metadata["verification_correction"] = correction
                        # P1-5: 将纠错提示注入消息列表，使下一轮 LLM 调用
                        # 能看到验证失败的原因并自动修正输出
                        if hasattr(result, 'messages') and result.messages is not None:
                            result.messages.append({
                                "role": "system",
                                "content": f"【验证纠错】{correction}",
                            })
                        # 同时在 output_content 末尾追加纠错标记，
                        # 确保即使不走 messages 路径也能被上层消费
                        output_content += f"\n\n[系统提示：上一次输出未通过验证，已生成纠错提示，将在下一轮自动修正]"
                elif verification_result.action == "warn":
                    log.warning(
                        "Response verification warning",
                        action=verification_result.action,
                        message=verification_result.message,
                    )
            except Exception as e:
                log.warning("Verification loop failed", error=str(e))

        if self.verification:
            try:
                safety = self.verification.check_output_safety(output_content)
                if not safety.safe:
                    output_content = safety.sanitized_output or output_content
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="output_safety",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"output_safety 检查异常: {_sec_exc}")

            try:
                guardrail_result = self.verification.check_guardrails(output_content)
                if not guardrail_result.passed:
                    output_content = "抱歉，无法提供该内容（安全检查未通过）"
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="guardrails",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"guardrails 检查异常: {_sec_exc}")

        if self.output_guardrail and output_content:
            try:
                guard_result = self.output_guardrail.check(output_content)
                if not guard_result.passed:
                    log.warning(
                        "Output blocked by guardrail (loop)",
                        reason=guard_result.reason,
                        risk_level=guard_result.risk_level,
                    )
                    output_content = "抱歉，输出内容被安全策略拦截"
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="output_guardrail",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"output_guardrail 检查异常: {_sec_exc}")

        quality_score = result.quality_score

        # P1: 验证闭环质量评分覆盖 — 如果 VerificationLoop 提供了质量评分，优先使用
        if verification_result and verification_result.quality:
            quality_score = verification_result.quality.overall

        # 后备质量评分：当 loop 返回 quality_score==0.0 时用 verification 重新计算
        if quality_score == 0.0 and self.verification:
            try:
                quality = self.verification.score_quality({
                    "loop_count": result.steps_completed,
                    "total_tool_calls": result.metadata.get("total_tool_calls", 0),
                    "total_tool_duration": result.metadata.get("total_tool_duration", 0.0),
                    "total_duration": result.metadata.get("duration", 0.0),
                    "completed_successfully": result.success,
                })
                quality_score = quality.overall
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # GAP-08: 规划质量预检
        if self.plan_quality_checker and result.metadata.get("plan_steps"):
            try:
                plan_steps = result.metadata["plan_steps"]
                if isinstance(plan_steps, list) and len(plan_steps) > 0:
                    quality_result = self.plan_quality_checker.check_plan(plan_steps)
                    if not quality_result.is_passed:
                        log.warning(
                            "Plan quality check failed",
                            score=quality_result.quality_score,
                            issues=[i.description for i in quality_result.issues[:3]],
                        )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # GAP-05: 增量重规划 — 如果 loop 结果标记需要重规划
        if self.incremental_planner and result.metadata.get("needs_replan"):
            try:
                original_steps = result.metadata.get("plan_steps", [])
                changed_step = result.metadata.get("changed_step")
                if original_steps and changed_step:
                    replan_result = self.incremental_planner.incremental_replan(
                        original_plan=original_steps,
                        changed_step=changed_step,
                        reason=result.metadata.get("replan_reason", "quality_low"),
                    )
                    if replan_result.success:
                        log.info(
                            "Incremental replan succeeded",
                            changes=len(replan_result.changes),
                        )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # GAP-09: 多维度学习信号采集（loop 路径）
        if self.learning_signals:
            try:
                self.learning_signals.record_signal(
                    signal_type="task_success" if quality_score >= 0.6 else "task_partial",
                    value=quality_score,
                    source="loop",
                    context={"session_id": session_id},
                )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # GAP-06: 策略自适应（loop 路径）
        if self.strategy_adapter:
            try:
                scene = ContextManager.infer_scene(message) if self.context_manager else "daily"
                success = quality_score >= 0.6
                self.strategy_adapter.record_outcome(scene, "loop", success=success)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # GAP-02: 性能监控指标记录（loop 路径）
        if self.performance_monitor:
            try:
                self.performance_monitor.record_metric(
                    "task_completion",
                    success=quality_score >= 0.6,
                    duration=result.metadata.get("total_duration_ms", 0) / 1000.0,
                )
                # GAP-02 闭环：检查告警并触发自动进化
                alerts = self.performance_monitor.check_alerts()
                if alerts and self.evolution_trigger:
                    try:
                        await self.evolution_trigger._check_and_trigger()
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # GAP-06 闭环：策略自适应 — 读取最优策略用于日志和后续优化
        if self.strategy_adapter:
            try:
                scene = ContextManager.infer_scene(message) if self.context_manager else "daily"
                best = self.strategy_adapter.get_best_strategy(scene)
                if best and best.confidence >= 0.7:
                    log.info(
                        "Strategy recommendation available",
                        scene=scene,
                        strategy=best.strategy_name,
                        confidence=round(best.confidence, 2),
                        expected_success_rate=round(best.expected_success_rate, 2),
                    )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # GAP-09 闭环：学习信号分析 — 检测弱项和趋势
        if self.learning_signals:
            try:
                insights = self.learning_signals.analyze_signals()
                if insights and insights.weak_areas:
                    log.warning(
                        "Learning signal weak areas detected",
                        weak_areas=insights.weak_areas,
                        trend=insights.signal_trend,
                    )
                if insights and insights.recommendations:
                    log.info(
                        "Learning signal recommendations",
                        recommendations=insights.recommendations[:3],
                    )
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        # GAP-07 闭环：记忆策展 — 定期执行记忆整理
        if self.curator and self.memory:
            try:
                recent_memories = await self.memory.search_with_context(
                    query=message, recent_hours=24.0, limit=50,
                )
                if recent_memories:
                    curate_result = self.curator.curate(recent_memories, force=False)
                    if curate_result.get("curated"):
                        log.info("Memory curated", result=curate_result)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        if self.memory:
            try:
                await self.memory.store_instant(message, scene="loop_chat")
                await self.memory.store_short_term(output_content, scene="loop_response")
                tool_names = [
                    tc.get("name", "")
                    for tc in result.metadata.get("tool_calls", [])
                    if tc.get("name")
                ]
                if tool_names:
                    await self.memory.store_episodic(
                        event=f"用户请求: {message[:100]}",
                        participants=tool_names,
                        outcome="成功" if quality_score >= 0.6 else "部分完成",
                        emotion="positive" if quality_score >= 0.6 else "neutral",
                    )
                await self._auto_reflect(message, output_content, session_id, quality_score, tool_names)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        if self.session_store:
            try:
                self.session_store.add_message(session_id, "user", message)
                self.session_store.add_message(session_id, "assistant", output_content)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        if self.evolution:
            try:
                from agent.evolution.types import FeedbackSignal
                import time as _t
                raw_tool_calls = result.metadata.get("tool_calls", [])
                tool_names = [tc.get("name", "") for tc in raw_tool_calls if tc.get("name")]
                tool_successes: dict[str, bool] = {}
                for tc in raw_tool_calls:
                    name = tc.get("name", "")
                    if name:
                        tool_successes[name] = not bool(tc.get("error"))
                scene = ContextManager.infer_scene(message) if self.context_manager else ""
                await self.evolution.collect_feedback(FeedbackSignal(
                    interaction_id=result.trace_id,
                    quality_score=quality_score,
                    cause="loop",
                    tool_name=tool_names[0] if tool_names else None,
                    timestamp=_t.time(),
                    tools_used=tool_names,
                    tool_successes=tool_successes,
                    session_id=session_id,
                    scene=scene,
                    response_length=len(output_content),
                    rounds_used=result.metadata.get("rounds_used", 1),
                ))
                plan = await self.evolution.should_evolve()
                if plan:
                    log.info("Evolution triggered (loop)", plan_type=plan.evolution_type, priority=plan.priority)
                    await self.evolution.execute_evolution(plan)
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        if self.trajectory_db:
            try:
                import time as _t
                self.trajectory_db.record_execution(ExecutionRecord(
                    id=result.trace_id,
                    input=message[:500],
                    response=output_content[:500],
                    status="success" if quality_score >= 0.6 else "failed",
                    quality_overall=quality_score,
                    loop_rounds=result.metadata.get("rounds_used", 0),
                    total_tool_calls=result.metadata.get("tool_calls_used", 0),
                    total_duration=result.metadata.get("total_duration_ms", 0),
                    created_at=int(_t.time() * 1000),
                    updated_at=int(_t.time() * 1000),
                ))
                for tc in result.metadata.get("tool_calls", []):
                    self.trajectory_db.record_tool_invocation(ToolInvocationRecord(
                        execution_id=result.trace_id,
                        step_index=tc.get("step_id", 0),
                        tool_name=tc.get("name", "unknown"),
                        args_json="{}",
                        result_success=0 if tc.get("error") else 1,
                    ))
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine._process_with_loop", _exc)

        _loop_extra = {
            "steps_completed": result.steps_completed,
            "steps_total": result.steps_total,
            "loop_metadata": result.metadata,
            "clarification": ambiguity_result.is_ambiguous if ambiguity_result else False,
            "clarification_details": (
                {
                    "level": ambiguity_result.level.value,
                    "dimensions": [d.value for d in ambiguity_result.dimensions],
                    "suggestions": ambiguity_result.suggestions,
                }
                if ambiguity_result and ambiguity_result.is_ambiguous
                else None
            ),
            "verification": (
                {
                    "action": verification_result.action.value,
                    "message": verification_result.message,
                    "quality": (
                        {
                            "overall": verification_result.quality.overall,
                            "accuracy": verification_result.quality.accuracy,
                        }
                        if verification_result.quality
                        else None
                    ),
                }
                if verification_result
                else None
            ),
        }

        return {
            "content": output_content,
            "session_id": result.session_id,
            "trace_id": result.trace_id,
            "intent": "",
            "related_files": [],
            "tool_activities": result.metadata.get("tool_calls", []),
            "tool_calls_made": result.metadata.get("total_tool_calls", 0),
            "rounds_used": result.metadata.get("rounds_used", result.steps_completed),
            "duration": result.metadata.get("total_duration_ms", 0) / 1000.0,
            "finish_reason": "stop" if result.success else "error",
            "quality_score": quality_score,
            "loop_extra": _loop_extra,
        }

    async def _auto_reflect(
        self,
        user_input: str,
        response: str,
        session_id: str,
        quality_score: float = 0.8,
        tool_names: list[str] | None = None,
    ) -> None:
        if not self.loop:
            return
        try:
            reflection = await self.loop.reflection.reflect_on_task_failure(
                TaskReflectionInput(
                    user_input=user_input,
                    task_goal=response[:200],
                    goal_progress=quality_score,
                    rounds_used=1,
                )
            )
            if quality_score < 0.6 and reflection.confidence > 0.5:
                log.info("Auto-reflection triggered", diagnosis=reflection.task_diagnosis)
                if self.memory:
                    try:
                        await self.memory.store_long_term(
                            f"反思记录: {reflection.task_diagnosis} | 策略调整: {reflection.strategy_adjustment}",
                            scene="auto_reflection",
                        )
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine._auto_reflect", _exc)
                # GAP-10: 反思结果应用闭环
                if self.reflection_applier:
                    try:
                        from agent.loop.reflection_applier import ReflectionType
                        rtype = ReflectionType.TOOL_FAILURE if tool_names else ReflectionType.STRATEGY
                        record = self.reflection_applier.add_reflection(
                            reflection_type=rtype,
                            content=reflection.task_diagnosis,
                            insight=reflection.strategy_adjustment,
                            tags=tool_names or [],
                        )
                        if record:
                            log.info("Reflection recorded for application", record_id=record.id)
                    except Exception as e:
                        log.warning("Reflection applier record failed", error=str(e))
                # GAP-09: 记录学习信号
                if self.learning_signals:
                    try:
                        self.learning_signals.record_signal(
                            signal_type="task_partial",
                            value=quality_score,
                            source="auto_reflect",
                            context={"diagnosis": reflection.task_diagnosis},
                        )
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine._auto_reflect", _exc)
            elif tool_names and self.evolution:
                for tn in tool_names:
                    try:
                        from agent.evolution.types import FeedbackSignal
                        import time as _t
                        await self.evolution.collect_feedback(FeedbackSignal(
                            interaction_id=f"ref_{session_id}",
                            quality_score=quality_score,
                            cause="tool_success" if quality_score >= 0.6 else "tool_suboptimal",
                            tool_name=tn,
                            timestamp=_t.time(),
                        ))
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine._auto_reflect", _exc)
        except Exception as _exc:
            log_ignored(log, "engine.AgentEngine._auto_reflect", _exc)

    async def process_input_stream(
        self,
        message: str,
        session_id: str = "default",
        cancel_token: "asyncio.Event | None" = None,
    ):
        """真正的流式 ReAct 循环 — 支持工具调用 + 思考过程 + 会话历史 + 记忆检索。

        将请求委托给 ConversationLoop.run_stream（已实现完整流式+工具+思考事件），
        并补齐会话历史加载和统一上下文构建。

        Args:
            message: 用户输入
            session_id: 会话ID
            cancel_token: 取消令牌，设置后中止流式输出

        Yields:
            dict 事件: {"type": "token"|"thinking"|"tool_start"|"tool_end"|"done"|"error", ...}
        """
        import asyncio as _asyncio

        # 1. 检查取消
        if cancel_token and cancel_token.is_set():
            if self.session_store:
                try:
                    self.session_store.add_message(session_id, "user", message)
                except Exception as _exc:
                    log_ignored(log, "engine.AgentEngine.process_input_stream", _exc)
            yield {"type": "done", "trace_id": "", "content": "任务已取消", "quality_score": 0.0, "finish_reason": "cancelled"}
            return

        # 立即发送 thinking 事件 — 首字反馈，让用户知道系统已开始处理
        yield {"type": "thinking", "content": "正在理解您的请求..."}

        # 2. 加载会话历史
        history: list[dict[str, str]] = []
        if self.session_store:
            try:
                msgs = self.session_store.get_messages(session_id, limit=10)
                history = [{"role": m.role, "content": m.content} for m in msgs]
            except Exception as _exc:
                log_ignored(log, "engine.AgentEngine.process_input_stream", _exc)

        # 3. 构建统一上下文（系统提示、人格、记忆）
        yield {"type": "thinking", "content": "正在检索记忆和构建上下文..."}

        system_prompt: str = ""
        if self.unified_context_orchestrator:
            try:
                ctx_result = await self.build_context(
                    user_input=message,
                    session_id=session_id,
                    scene="daily",
                    use_memory=True,
                    use_file_context=True,
                )
                if ctx_result and ctx_result.messages:
                    # 提取系统消息作为 system_prompt
                    for msg in ctx_result.messages:
                        if msg.get("role") == "system":
                            system_prompt = msg.get("content", "")
                            break
            except Exception as e:
                log.warning("Stream context build failed", error=str(e))

        if not system_prompt:
            system_prompt = (
                "你是家百星（Jiabaixing），一个智能AI助手。"
                "你善于理解中文，能够帮助用户完成各种任务。"
                "请用简洁、友好的方式回答问题。"
            )

        # 用于累积完整响应内容，以便最终持久化
        response_buffer: list[str] = []

        # 4. 委托给 ConversationLoop.run_stream
        if self.conversation:
            try:
                async for event in self.conversation.run_stream(
                    user_input=message,
                    session_id=session_id,
                    system_prompt=system_prompt,
                    history=history,
                    use_tools=True,
                ):
                    # 检查取消 — 持久化已接收的部分响应后再退出
                    if cancel_token and cancel_token.is_set():
                        if self.session_store:
                            try:
                                partial = "".join(response_buffer).strip()
                                self.session_store.add_message(session_id, "user", message)
                                if partial:
                                    self.session_store.add_message(session_id, "assistant", partial + "\n[已取消]")
                            except Exception as _exc:
                                log_ignored(log, "engine.AgentEngine.process_input_stream", _exc)
                        yield {"type": "done", "trace_id": "", "content": "任务已取消", "quality_score": 0.0, "finish_reason": "cancelled"}
                        return

                    # 累积 token 内容用于持久化
                    if event.get("type") == "token" and event.get("content"):
                        response_buffer.append(event["content"])
                    elif event.get("type") == "done" and event.get("content"):
                        if not response_buffer:
                            response_buffer.append(event["content"])

                    # 透传事件
                    yield event

                # 5. 安全检查 + 持久化会话历史
                assistant_response = "".join(response_buffer).strip()
                if self.verification and assistant_response:
                    try:
                        safety = self.verification.check_output_safety(assistant_response)
                        if not safety.safe:
                            assistant_response = safety.sanitized_output or assistant_response
                    except Exception as _sec_exc:
                        # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                        # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                        log.error(
                            "安全检查异常，该项校验已跳过",
                            check="output_safety",
                            error=str(_sec_exc),
                        )
                        self._mark_subsystem_degraded("verification", f"output_safety 检查异常: {_sec_exc}")
                    try:
                        guardrail_result = self.verification.check_guardrails(assistant_response)
                        if not guardrail_result.passed:
                            assistant_response = "抱歉，无法提供该内容（安全检查未通过）"
                    except Exception as _sec_exc:
                        # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                        # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                        log.error(
                            "安全检查异常，该项校验已跳过",
                            check="guardrails",
                            error=str(_sec_exc),
                        )
                        self._mark_subsystem_degraded("verification", f"guardrails 检查异常: {_sec_exc}")
                if self.output_guardrail and assistant_response:
                    try:
                        guard_result = self.output_guardrail.check(assistant_response)
                        if not guard_result.passed:
                            log.warning(
                                "Stream output blocked by guardrail",
                                reason=guard_result.reason,
                                risk_level=guard_result.risk_level,
                            )
                            assistant_response = "抱歉，输出内容被安全策略拦截"
                    except Exception as _sec_exc:
                        # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                        # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                        log.error(
                            "安全检查异常，该项校验已跳过",
                            check="output_guardrail",
                            error=str(_sec_exc),
                        )
                        self._mark_subsystem_degraded("verification", f"output_guardrail 检查异常: {_sec_exc}")
                if self.session_store:
                    try:
                        self.session_store.add_message(session_id, "user", message)
                        if assistant_response:
                            self.session_store.add_message(session_id, "assistant", assistant_response)
                    except Exception as e:
                        log.warning("Failed to persist stream session history", error=str(e))
                return
            except _asyncio.CancelledError:
                if self.session_store:
                    try:
                        partial = "".join(response_buffer).strip()
                        self.session_store.add_message(session_id, "user", message)
                        if partial:
                            self.session_store.add_message(session_id, "assistant", partial + "\n[已取消]")
                    except Exception as _exc:
                        log_ignored(log, "engine.AgentEngine.process_input_stream", _exc)
                yield {"type": "done", "trace_id": "", "content": "任务已取消", "quality_score": 0.0, "finish_reason": "cancelled"}
                return
            except Exception as e:
                log.error("Stream loop failed, fallback to raw LLM", error=str(e))
                # 继续走下面的降级路径

        # 6. 降级：ConversationLoop 不可用时，使用裸 LLM 流式
        messages = [
            {"role": "system", "content": system_prompt},
            *history,
            {"role": "user", "content": message},
        ]
        try:
            core = self.domains.get("core")
            if core is not None and core.is_initialized:
                async for chunk in core.invoke_stream(messages=messages):
                    if cancel_token and cancel_token.is_set():
                        if self.session_store:
                            try:
                                partial = "".join(response_buffer).strip()
                                self.session_store.add_message(session_id, "user", message)
                                if partial:
                                    self.session_store.add_message(session_id, "assistant", partial + "\n[已取消]")
                            except Exception as _exc:
                                log_ignored(log, "engine.AgentEngine.process_input_stream", _exc)
                        yield {"type": "done", "trace_id": "", "content": "任务已取消", "quality_score": 0.0, "finish_reason": "cancelled"}
                        return
                    chunk_str = chunk if isinstance(chunk, str) else (chunk.get("content", "") if isinstance(chunk, dict) else str(chunk))
                    response_buffer.append(chunk_str)
                    yield {"type": "token", "content": chunk_str}
            else:
                async for chunk in self.llm.chat_stream(messages=messages):
                    if cancel_token and cancel_token.is_set():
                        if self.session_store:
                            try:
                                partial = "".join(response_buffer).strip()
                                self.session_store.add_message(session_id, "user", message)
                                if partial:
                                    self.session_store.add_message(session_id, "assistant", partial + "\n[已取消]")
                            except Exception as _exc:
                                log_ignored(log, "engine.AgentEngine.process_input_stream", _exc)
                        yield {"type": "done", "trace_id": "", "content": "任务已取消", "quality_score": 0.0, "finish_reason": "cancelled"}
                        return
                    chunk_str = chunk if isinstance(chunk, str) else (chunk.get("content", "") if isinstance(chunk, dict) else str(chunk))
                    response_buffer.append(chunk_str)
                    yield {"type": "token", "content": chunk_str}
        except _asyncio.CancelledError:
            if self.session_store:
                try:
                    partial = "".join(response_buffer).strip()
                    self.session_store.add_message(session_id, "user", message)
                    if partial:
                        self.session_store.add_message(session_id, "assistant", partial + "\n[已取消]")
                except Exception as _exc:
                    log_ignored(log, "engine.AgentEngine.process_input_stream", _exc)
            yield {"type": "done", "trace_id": "", "content": "任务已取消", "quality_score": 0.0, "finish_reason": "cancelled"}
            return
        except Exception as e:
            yield {"type": "error", "content": str(e)}

        # 降级路径也做安全检查 + 持久化会话历史
        assistant_response = "".join(response_buffer).strip()
        if self.verification and assistant_response:
            try:
                safety = self.verification.check_output_safety(assistant_response)
                if not safety.safe:
                    assistant_response = safety.sanitized_output or assistant_response
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="output_safety",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"output_safety 检查异常: {_sec_exc}")
            try:
                guardrail_result = self.verification.check_guardrails(assistant_response)
                if not guardrail_result.passed:
                    assistant_response = "抱歉，无法提供该内容（安全检查未通过）"
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="guardrails",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"guardrails 检查异常: {_sec_exc}")
        if self.output_guardrail and assistant_response:
            try:
                guard_result = self.output_guardrail.check(assistant_response)
                if not guard_result.passed:
                    log.warning(
                        "Fallback stream output blocked by guardrail",
                        reason=guard_result.reason,
                        risk_level=guard_result.risk_level,
                    )
                    assistant_response = "抱歉，输出内容被安全策略拦截"
            except Exception as _sec_exc:
                # D2（审计 §1.7）：安全检查异常此前静默吞掉 —— 输出未经校验即放行且零日志。
                # 保持放行语义（避免误伤正常输出），但必须留痕并接入 /health 降级视图。
                log.error(
                    "安全检查异常，该项校验已跳过",
                    check="output_guardrail",
                    error=str(_sec_exc),
                )
                self._mark_subsystem_degraded("verification", f"output_guardrail 检查异常: {_sec_exc}")
        if self.session_store:
            try:
                self.session_store.add_message(session_id, "user", message)
                if assistant_response:
                    self.session_store.add_message(session_id, "assistant", assistant_response)
            except Exception as e:
                log.warning("Failed to persist fallback stream history", error=str(e))

        _fallback_quality = min(1.0, max(0.1, len(assistant_response) / 200.0)) if assistant_response else 0.0
        yield {"type": "done", "trace_id": "", "quality_score": _fallback_quality, "finish_reason": "stop" if assistant_response else "error"}

    # ─────────────────────────────────────────────────────────────
    # 子系统初始化方法（对应 SUBSYSTEM_DEPS 的 factory 字段）
    # 每个方法必须是 async def 且无参数，依赖通过 self 访问
    # ─────────────────────────────────────────────────────────────

    async def _init_llm(self) -> LLMProvider:
        # T3：构建 Provider 目录（元数据 + providers.json 合并）并解析 OAuth 凭据。
        # 凭据解析优雅降级，绝不阻断启动。
        try:
            from agent.config import DATA_DIR
            from agent.llm.oauth_credentials import resolve_provider_credentials
            from agent.llm.provider_catalog import ProviderCatalog

            catalog_path = DATA_DIR / "providers.json"
            self.provider_catalog = ProviderCatalog.from_providers_json(catalog_path)

            oauth_status: dict[str, dict] = {}
            for spec in self.provider_catalog.configured_with_oauth():
                try:
                    creds = resolve_provider_credentials(spec.id)
                    if creds is not None:
                        oauth_status[spec.id] = creds
                        # 只记录来源/降级状态，绝不记录密钥明文。
                        log.info(
                            "Provider OAuth 凭据解析",
                            provider=spec.id,
                            source=creds.get("source"),
                            degraded=creds.get("degraded"),
                        )
                except Exception as e:
                    log.warning("Provider OAuth 凭据解析失败", provider=spec.id, error=str(e))
            self.provider_oauth_status = oauth_status
            log.info(
                "Provider Catalog ready",
                known=len(self.provider_catalog.known_provider_ids()),
                configured=len(self.provider_catalog.configured_ids()),
                oauth_resolved=len(oauth_status),
            )
        except Exception as e:
            log.warning("Provider Catalog 初始化失败", error=str(e))
            self.provider_catalog = None
            self.provider_oauth_status = {}

        available = await self.llm.check_available()
        status = "available" if available else "unavailable"
        log.info("LLM Provider initialized", model=self.llm.model, status=status)
        return self.llm

    async def _init_memory(self) -> MemoryEngine | None:
        try:
            self.memory = MemoryEngine(llm=self.llm)
            self.memory.set_episodic_store(EpisodicMemoryStore())
            await self.memory.initialize()
            log.info("Memory Engine ready (with EpisodicMemoryStore)")
            return self.memory
        except Exception as e:
            log.warning("Memory Engine init failed", error=str(e))
            return None

    async def _init_trajectory_db(self) -> TrajectoryDatabase | None:
        try:
            self.trajectory_db = TrajectoryDatabase()
            log.info("Trajectory Database ready")
            return self.trajectory_db
        except Exception as e:
            log.warning("Trajectory Database init failed", error=str(e))
            return None

    async def _init_tool_registry(self) -> ToolRegistry | None:
        try:
            self.tool_registry = ToolRegistry()
            count = register_default_tools(self.tool_registry)
            try:
                from agent.perception.tools import register_perception_tools
                register_perception_tools(self.tool_registry)
                log.info("Perception tools registered")
            except Exception as _e:
                log.warning("Perception tools registration failed", error=str(_e))
            log.info("Tool Registry ready", count=count)
            return self.tool_registry
        except Exception as e:
            log.warning("Tool Registry init failed", error=str(e))
            return None

    async def _init_toolset_registry(self) -> ToolsetRegistry | None:
        try:
            self.toolset_registry = ToolsetRegistry(self.tool_registry)
            # R2 运行时依赖：将内置工具集定义注册进引擎持有的注册表实例，
            # 使 resolve(toolset_id) 可用（全局注册表与引擎实例不是同一个）。
            from agent.tools.builtin_toolsets import BUILTIN_TOOLSETS
            for definition in BUILTIN_TOOLSETS:
                self.toolset_registry.register(definition)
            log.info("Toolset Registry ready", toolsets=len(BUILTIN_TOOLSETS))
            return self.toolset_registry
        except Exception as e:
            log.warning("Toolset Registry init failed", error=str(e))
            return None

    # ==================== R2：场景→工具集运行时选择 ====================

    def _ensure_toolset_mapper(self) -> Any:
        """延迟构建并缓存 SceneToToolsetMapper（读取 AGENT_TOOLSET_SAMPLING）。"""
        if self._toolset_mapper is None:
            from agent.tools.toolset_registry import SceneToToolsetMapper
            self._toolset_mapper = SceneToToolsetMapper()
        return self._toolset_mapper

    def _feed_evolution_toolset(
        self,
        scene: str,
        toolset_id: str,
        tool_names: list[str],
        method: str = "sampled",
    ) -> None:
        """把 R2 采样选中的工具集喂送给 EvolutionEngine（场景→工具集分布学习）。

        仅在 evolution 子系统就绪且确有工具被选中时生效；任何异常都吞掉，
        绝不影响正常工具选择流程（零回归）。
        """
        evo = self.evolution
        if evo is None or not tool_names:
            return
        try:
            evo.record_toolset_selection(
                scene=scene,
                toolset_id=toolset_id,
                tool_names=list(tool_names),
                method=method,
            )
        except Exception as e:
            log.debug("工具集采样信号喂送 EvolutionEngine 失败", error=str(e))

    def select_tools_for_input(
        self,
        input_text: str,
        env: str | None = None,
        rng: Any = None,
    ) -> list[Any]:
        """按场景选择活跃工具集（R2 接入运行时，返回 ToolDefinition 列表）。

        数据流:
            用户输入 + 环境
              → [agent_native 模型] → 直接返回全量工具
              → SceneToToolsetMapper.detect_scene()
              → sample_toolset()（AGENT_TOOLSET_SAMPLING=on 时概率分发，否则确定性）
              → toolset_registry.resolve(toolset_id) 展开工具名
              → tool_registry.filter_tools(工具名集合)

        退化保护（零回归）:
            - agent_native 模型 → 返回全量工具（模型自主选择）。
            - AGENT_TOOLSET_SAMPLING 未启用 → 返回全量工具（行为同旧版）。
            - toolset_registry / tool_registry 为 None → 全量或空。
            - 工具集解析为空 → 退化为全量工具。

        Args:
            input_text: 用户输入文本。
            env: 环境标识（如 "coding" / "browsing"），可选。
            rng: 可选随机源（测试可复现）；None 时由映射器自带 rng 决定。

        Returns:
            list[ToolDefinition]: 过滤后的活跃工具定义列表。
        """
        if self.tool_registry is None:
            return []
        # agent_native 模型：直接返回全量工具，让模型自主选择
        if self._is_agent_native_model():
            return self.tool_registry.filter_tools(None)
        if self.toolset_registry is None:
            return self.tool_registry.filter_tools(None)
        try:
            mapper = self._ensure_toolset_mapper()
        except Exception as e:
            log.warning("SceneToToolsetMapper 构建失败, 退化为全量工具", error=str(e))
            return self.tool_registry.filter_tools(None)
        # 开关未开启：返回全量工具（确定性，零回归）。
        if not mapper.enable_sampling:
            return self.tool_registry.filter_tools(None)
        scene = mapper.detect_scene(input_text, env)
        config = mapper.sample_toolset(scene, rng=rng)
        resolved = self.toolset_registry.resolve(config.toolset_id, self.tool_registry)
        if resolved is None or not resolved.tool_names:
            log.warning(
                "工具集解析为空, 退化为全量工具",
                scene=scene,
                toolset_id=config.toolset_id,
            )
            return self.tool_registry.filter_tools(None)
        return self.tool_registry.filter_tools(set(resolved.tool_names))

    def select_openai_tools_for_input(
        self,
        input_text: str,
        env: str | None = None,
        rng: Any = None,
    ) -> list[dict[str, Any]]:
        """select_tools_for_input 的 OpenAI Function-Calling Schema 形态。

        供 ConversationLoop 直接作为 tool_selector 注入 LLM 调用。
        开关未启用或任一子系统缺失时返回全量工具 schema（零回归）。

        工具选择策略（按优先级）：
        0. agent_native 模型 → 直接返回全量工具（模型自主选择）
        1. 场景 → 工具集采样（SceneToToolsetMapper）
        2. 语义 embedding 检索（AGENT_SEMANTIC_TOOL_SELECT=on）
        3. 全量工具回退

        Returns:
            list[dict]: OpenAI 格式的工具 schema 列表。
        """
        if self.tool_registry is None:
            return []
        # agent_native 模型：直接返回全量工具，让模型自主选择
        # 原生 Agent 模型（如 DeepSeek V4 Flash）工具调用准确率高，
        # 无需通过场景关键词检测裁剪工具集，反而会限制模型能力
        if self._is_agent_native_model():
            return self.tool_registry.to_openai_tools()
        if self.toolset_registry is None:
            return self.tool_registry.to_openai_tools()
        try:
            mapper = self._ensure_toolset_mapper()
        except Exception as e:
            log.warning("SceneToToolsetMapper 构建失败, 退化为全量工具", error=str(e))
            return self.tool_registry.to_openai_tools()
        if not mapper.enable_sampling:
            return self._select_tools_semantic(input_text) or self.tool_registry.to_openai_tools()
        scene = mapper.detect_scene(input_text, env)
        config = mapper.sample_toolset(scene, rng=rng)
        openai_tools = self.toolset_registry.resolve_to_openai(config.toolset_id, self.tool_registry)
        if not openai_tools:
            openai_tools = self._select_tools_semantic(input_text)
        if not openai_tools:
            log.warning(
                "工具集 OpenAI schema 为空, 退化为全量工具",
                scene=scene,
                toolset_id=config.toolset_id,
            )
            return self.tool_registry.to_openai_tools()
        tool_names = [
            (t.get("function") or {}).get("name") or t.get("name")
            for t in openai_tools
        ]
        self._feed_evolution_toolset(scene, config.toolset_id, tool_names, method="sampled")
        return openai_tools

    def _select_tools_semantic(self, input_text: str) -> list[dict[str, Any]] | None:
        """基于语义 embedding 的工具选择。

        使用 sentence-transformers 对工具描述和用户输入做语义匹配，
        返回最相关的 Top-K 工具 schema。

        Args:
            input_text: 用户输入文本。

        Returns:
            list[dict] | None: OpenAI 工具 schema 列表，None 表示不可用。
        """
        try:
            from agent.tools.semantic_selector import SemanticToolSelector
            selector = self._ensure_semantic_selector()
            return selector.select(input_text, top_k=15)
        except Exception as e:
            log.debug("Semantic tool selection unavailable", error=str(e))
            return None

    def _ensure_semantic_selector(self) -> Any:
        if not hasattr(self, "_semantic_selector"):
            from agent.tools.semantic_selector import SemanticToolSelector
            self._semantic_selector = SemanticToolSelector(
                tool_registry=self.tool_registry,
            )
        return self._semantic_selector

    def _is_agent_native_model(self) -> bool:
        """检测当前 LLM 是否具备原生 Agent 能力。

        通过 LLMCapabilityDetector 探测当前模型的 agent_native 标志。
        agent_native 模型（如 DeepSeek V4 Flash）工具调用准确率高，
        可直接接收全量工具注册表，无需场景关键词检测裁剪。

        可通过环境变量 AGENT_NATIVE_FORCE_DISABLE=true 强制关闭。

        Returns:
            bool: True 表示模型具备原生 Agent 能力。
        """
        if os.environ.get("AGENT_NATIVE_FORCE_DISABLE", "").lower() == "true":
            return False
        try:
            from agent.evolution.llm_capability_detector import LLMCapabilityDetector
            model_name = getattr(self.llm, "model_name", "") or ""
            provider = getattr(self.llm, "provider", "") or ""
            if not model_name:
                return False
            detector = LLMCapabilityDetector()
            caps = detector.detect(model_name, provider=provider)
            return getattr(caps, "agent_native", False)
        except Exception:
            return False

    async def _init_mcp_tool_bridge(self) -> MCPToolBridge | None:
        try:
            from agent.mcp.server_manager import MCPServerManager
            mcp_manager = MCPServerManager.get_instance()
            self.mcp_tool_bridge = MCPToolBridge(provider=mcp_manager)
            if self.tool_registry is not None:
                # T4：按 ExtensionCatalog 门控 MCP 服务器同步（默认全启用）。
                enabled_check = (
                    (lambda ref: self.extension_catalog.is_enabled(ref))
                    if self.extension_catalog is not None
                    else None
                )
                synced = await self.mcp_tool_bridge.sync_to_registry(
                    self.tool_registry, enabled_check=enabled_check
                )
                self.mcp_tool_bridge.start_auto_sync(self.tool_registry)
                log.info("MCP Tool Bridge ready", synced_tools=synced)
            else:
                log.warning("MCP Tool Bridge ready but tool_registry is None, sync skipped")
            return self.mcp_tool_bridge
        except Exception as e:
            log.warning("MCP Tool Bridge init failed", error=str(e))
            return None

    async def _init_permission_guard(self) -> PermissionGuard | None:
        try:
            self.permission_guard = PermissionGuard()
            log.info("Permission Guard ready")
            return self.permission_guard
        except Exception as e:
            log.warning("Permission Guard init failed", error=str(e))
            return None

    async def _init_schema_validator(self) -> SchemaValidator | None:
        try:
            self.schema_validator = SchemaValidator()
            log.info("Schema Validator ready")
            return self.schema_validator
        except Exception as e:
            log.warning("Schema Validator init failed", error=str(e))
            return None

    async def _init_tool_call_guard(self) -> ToolCallGuard | None:
        try:
            self.tool_call_guard = ToolCallGuard()
            log.info("Tool Call Guard ready")
            return self.tool_call_guard
        except Exception as e:
            log.warning("Tool Call Guard init failed", error=str(e))
            return None

    async def _init_approval_manager(self) -> ApprovalManager | None:
        try:
            _posture = RuntimePosture.from_env()
            import os as _os2
            _env_mode2 = _os2.environ.get("ENV", "development").lower()
            _auto_approve2 = _env_mode2 not in ("production", "prod", "staging", "stage")
            self.approval_manager = ApprovalManager(auto_approve_all=_auto_approve2, posture=_posture)
            # 接线 R1 管理面控制器（姿态覆盖 / 锁定 推送到真实执行器）
            from agent.security.runtime_control import get_controller
            get_controller().attach_approval_manager(self.approval_manager)
            log.info("Approval Manager ready", posture=_posture.value, auto_approve_all=_auto_approve2)
            return self.approval_manager
        except Exception as e:
            log.warning("Approval Manager init failed", error=str(e))
            return None

    async def _init_canary_manager(self) -> CanaryReleaseManager | None:
        try:
            self.canary_manager = CanaryReleaseManager()
            log.info("Canary Release Manager ready")
            return self.canary_manager
        except Exception as e:
            log.warning("Canary Release Manager init failed", error=str(e))
            return None

    async def _init_constraints(self) -> ConstraintsService | None:
        try:
            self.constraints = ConstraintsService()
            log.info("Constraints Service ready")
            return self.constraints
        except Exception as e:
            log.warning("Constraints Service init failed", error=str(e))
            return None

    async def _init_hook_manager(self) -> HookManager | None:
        try:
            self.hook_manager = HookManager()
            self._setup_default_hooks()
            log.info("Hook Manager ready")
            return self.hook_manager
        except Exception as e:
            log.warning("Hook Manager init failed", error=str(e))
            return None

    async def _init_loop(self) -> LoopController | None:
        try:
            perception_bus = None
            try:
                from agent.perception.bus import PerceptionBus, PerceptionLevel
                perception_bus = PerceptionBus(
                    tool_registry=self.tool_registry,
                    llm=self.llm,
                    level=PerceptionLevel(
                        os.environ.get("PERCEPTION_LEVEL", "standard")
                    ),
                )
                log.info("PerceptionBus ready")
            except Exception as _e:
                log.warning("PerceptionBus init failed", error=str(_e))

            self.loop = LoopController(
                self.llm,
                trajectory_db=self.trajectory_db,
                tool_registry=self.tool_registry,
                evolution=None,
                memory_engine=self.memory,
                canary_manager=self.canary_manager,
                constraints_service=self.constraints,
                perception_bus=perception_bus,
                schema_validator=getattr(self, "schema_validator", None),
                tool_call_guard=getattr(self, "tool_call_guard", None),
                proactive_engine=getattr(self, "proactive_engine", None),
            )
            log.info("Loop Controller ready")
            return self.loop
        except Exception as e:
            log.warning("Loop Controller init failed", error=str(e))
            return None

    async def _init_evolution(self) -> EvolutionEngine | None:
        try:
            self.evolution = EvolutionEngine()
            log.info("Evolution Engine ready")
            return self.evolution
        except Exception as e:
            log.warning("Evolution Engine init failed", error=str(e))
            return None

    async def _init_conversation(self) -> ConversationLoop | None:
        try:
            self.conversation = ConversationLoop(
                llm=self.llm,
                tool_registry=self.tool_registry,
                max_tool_rounds=10,
                permission_guard=self.permission_guard,
                schema_validator=self.schema_validator,
                tool_call_guard=self.tool_call_guard,
                approval_manager=self.approval_manager,
                hook_manager=self.hook_manager,
                tool_selector=self.select_openai_tools_for_input,
                # D8（审计 §1.7）：接入验证闭环，工具结果验证失败时回灌纠错提示。
                verification_loop=getattr(self, "verification_loop", None),
            )
            log.info("Conversation Loop ready (with safety modules + hooks + verification)")
            return self.conversation
        except Exception as e:
            log.warning("Conversation Loop init failed", error=str(e))
            return None

    async def _init_context_file_registry(self) -> ContextFileRegistry | None:
        try:
            self.context_file_registry = ContextFileRegistry()
            log.info("Context File Registry ready")
            return self.context_file_registry
        except Exception as e:
            log.warning("Context File Registry init failed", error=str(e))
            return None

    async def _init_context_reference_resolver(self) -> ContextReferenceResolver | None:
        try:
            self.context_reference_resolver = ContextReferenceResolver(
                project_root=str(__import__("pathlib").Path.cwd())
            )
            log.info("Context Reference Resolver ready")
            return self.context_reference_resolver
        except Exception as e:
            log.warning("Context Reference Resolver init failed", error=str(e))
            return None

    async def _init_context_manager(self) -> ContextManager | None:
        try:
            self.context_manager = ContextManager()
            if self.context_file_registry:
                self.context_manager.set_file_registry(self.context_file_registry)
            if self.context_reference_resolver:
                self.context_manager.set_reference_resolver(self.context_reference_resolver)
            log.info("Context Manager ready")
            return self.context_manager
        except Exception as e:
            log.warning("Context Manager init failed", error=str(e))
            return None

    async def _init_context_compressor(self) -> ContextCompressor | None:
        try:
            self.context_compressor = ContextCompressor()
            log.info("Context Compressor ready")
            return self.context_compressor
        except Exception as e:
            log.warning("Context Compressor init failed", error=str(e))
            return None

    async def _init_context_window_manager(self) -> ContextWindowManager | None:
        try:
            self.context_window_manager = ContextWindowManager(
                max_tokens=8000,
                reserve_ratio=0.3,
                auto_compress=True,
            )
            log.info("Context Window Manager ready")
            return self.context_window_manager
        except Exception as e:
            log.warning("Context Window Manager init failed", error=str(e))
            return None

    async def _init_unified_context_orchestrator(self) -> UnifiedContextOrchestrator | None:
        try:
            use_unified = os.environ.get("USE_UNIFIED_CONTEXT", "true").lower() == "true"
            if use_unified:
                self.unified_context_orchestrator = UnifiedContextOrchestrator(
                    use_cache=True,
                    cache_max_size=100,
                    cache_ttl=300,
                    enabled=True,
                )
                self.unified_context_orchestrator.register_component(SystemPromptComponent())
                self.unified_context_orchestrator.register_component(
                    PersonaComponent(persona_core=self.persona)
                )
                self.unified_context_orchestrator.register_component(
                    MemoryRetrievalComponent(memory_engine=self.memory)
                )
                self.unified_context_orchestrator.register_component(
                    FileContextComponent(file_registry=self.context_file_registry)
                )
                self.unified_context_orchestrator.register_component(TokenBudgetComponent())
                self.unified_context_orchestrator.register_component(ContextAssemblerComponent())

                try:
                    self.attention_focus = AttentionFocusEngine()
                    from agent.context.adapters.attention_focus import AttentionFocusComponent
                    self.unified_context_orchestrator.register_component(
                        AttentionFocusComponent(attention_engine=self.attention_focus)
                    )
                    log.info("Attention Focus Engine ready and registered")
                except Exception as e:
                    log.warning("Attention Focus Engine init failed", error=str(e))

                log.info(
                    "Unified Context Orchestrator ready",
                    components=self.unified_context_orchestrator.component_count,
                )
            else:
                log.info("Unified Context Orchestrator disabled (set USE_UNIFIED_CONTEXT=true to enable)")
            return self.unified_context_orchestrator
        except Exception as e:
            log.warning("Unified Context Orchestrator init failed", error=str(e))
            return None

    async def _init_persona(self) -> PersonaCore | None:
        try:
            self.persona = PersonaCore()
            log.info("Persona Core ready")
            return self.persona
        except Exception as e:
            log.warning("Persona Core init failed", error=str(e))
            return None

    async def _init_security(self) -> SecurityGuard | None:
        try:
            self.security = SecurityGuard()
            log.info("Security Guard ready")
            return self.security
        except Exception as e:
            log.warning("Security Guard init failed", error=str(e))
            return None

    async def _init_verification(self) -> VerificationService | None:
        try:
            self.verification = VerificationService()
            log.info("Verification Service ready")
            return self.verification
        except Exception as e:
            log.warning("Verification Service init failed", error=str(e))
            return None

    async def _init_output_guardrail(self) -> OutputGuardrailEngine | None:
        try:
            self.output_guardrail = OutputGuardrailEngine()
            log.info("Output Guardrail Engine ready")
            return self.output_guardrail
        except Exception as e:
            log.warning("Output Guardrail Engine init failed", error=str(e))
            return None

    async def _init_skill_registry(self) -> SkillRegistry | None:
        try:
            self.skill_registry = SkillRegistry.get_instance()
            # T4：按 ExtensionCatalog 门控内置技能注册（默认全启用）。
            enabled_check = (
                (lambda ref: self.extension_catalog.is_enabled(ref))
                if self.extension_catalog is not None
                else None
            )
            self.skill_registry.register_builtin_skills(enabled_check=enabled_check)
            log.info("Skill Registry ready", count=len(self.skill_registry.get_all_skills()))
            return self.skill_registry
        except Exception as e:
            log.warning("Skill Registry init failed", error=str(e))
            return None

    async def _init_session_store(self) -> SessionStore | None:
        try:
            self.session_store = SessionStore()
            log.info("Session Store ready")
            return self.session_store
        except Exception as e:
            log.warning("Session Store init failed", error=str(e))
            return None

    async def _init_persistence(self) -> PersistenceService | None:
        try:
            self.persistence = PersistenceService(
                memory_engine=self.memory,
                trajectory_db=self.trajectory_db,
            )
            await self.persistence.initialize()
            log.info("Persistence Service ready")
            return self.persistence
        except Exception as e:
            log.warning("Persistence Service init failed", error=str(e))
            return None

    async def _init_curator(self) -> Curator | None:
        try:
            self.curator = Curator(self.memory)
            log.info("Curator ready")
            return self.curator
        except Exception as e:
            log.warning("Curator init failed", error=str(e))
            return None

    async def _init_trajectory_flywheel(self) -> TrajectoryFlywheel | None:
        try:
            if self.trajectory_db:
                self.flywheel = TrajectoryFlywheel(self.trajectory_db, FlywheelConfig())
                log.info("Trajectory Flywheel ready")
            return self.flywheel
        except Exception as e:
            log.warning("Trajectory Flywheel init failed", error=str(e))
            return None

    async def _init_feedback_loops(self) -> FeedbackLoops | None:
        try:
            self.feedback_loops = FeedbackLoops(
                evolution_engine=self.evolution,
                memory_engine=self.memory,
            )
            log.info("Feedback Loops ready")
            return self.feedback_loops
        except Exception as e:
            log.warning("Feedback Loops init failed", error=str(e))
            return None

    async def _init_performance_monitor(self) -> PerformanceMonitor | None:
        try:
            self.performance_monitor = PerformanceMonitor()
            log.info("Performance Monitor ready")
            return self.performance_monitor
        except Exception as e:
            log.warning("Performance Monitor init failed", error=str(e))
            return None

    async def _init_evolution_trigger(self) -> EvolutionTrigger | None:
        try:
            if self.performance_monitor and self.evolution:
                from agent.evolution.v2_engine import EvolutionEngineV2
                v2_engine = EvolutionEngineV2.get_instance()
                self.evolution_trigger = EvolutionTrigger(
                    evolution_engine=v2_engine,
                    monitor=self.performance_monitor,
                    config=EvolutionTriggerConfig(
                        strategy="moderate",
                        min_evolution_interval=300,
                        max_daily_evolutions=10,
                        auto_rollback=True,
                    ),
                )
                self.evolution_trigger.start()
                log.info("Evolution Trigger ready and started")
            return self.evolution_trigger
        except Exception as e:
            log.warning("Evolution Trigger init failed", error=str(e))
            return None

    async def _init_fewshot_generalizer(self) -> FewShotGeneralizer | None:
        try:
            from agent.loop.reflection_knowledge_base import ReflectionKnowledgeBase
            kb = ReflectionKnowledgeBase.get_instance() if hasattr(ReflectionKnowledgeBase, 'get_instance') else ReflectionKnowledgeBase()
            self.fewshot_generalizer = FewShotGeneralizer(kb)
            log.info("FewShot Generalizer ready")
            return self.fewshot_generalizer
        except Exception as e:
            log.warning("FewShot Generalizer init failed", error=str(e))
            return None

    async def _init_strategy_adapter(self) -> StrategyAdapter | None:
        try:
            self.strategy_adapter = StrategyAdapter()
            log.info("Strategy Adapter ready")
            return self.strategy_adapter
        except Exception as e:
            log.warning("Strategy Adapter init failed", error=str(e))
            return None

    async def _init_learning_signals(self) -> LearningSignalCollector | None:
        try:
            self.learning_signals = LearningSignalCollector()
            log.info("Learning Signal Collector ready")
            return self.learning_signals
        except Exception as e:
            log.warning("Learning Signal Collector init failed", error=str(e))
            return None

    async def _init_incremental_planner(self) -> IncrementalPlanner | None:
        try:
            self.incremental_planner = IncrementalPlanner()
            log.info("Incremental Planner ready")
            return self.incremental_planner
        except Exception as e:
            log.warning("Incremental Planner init failed", error=str(e))
            return None

    async def _init_plan_quality_checker(self) -> PlanQualityChecker | None:
        try:
            self.plan_quality_checker = PlanQualityChecker()
            log.info("Plan Quality Checker ready")
            return self.plan_quality_checker
        except Exception as e:
            log.warning("Plan Quality Checker init failed", error=str(e))
            return None

    async def _init_reflection_applier(self) -> ReflectionApplicationManager | None:
        try:
            self.reflection_applier = ReflectionApplicationManager()
            log.info("Reflection Applier ready")
            return self.reflection_applier
        except Exception as e:
            log.warning("Reflection Applier init failed", error=str(e))
            return None

    async def _init_priority_scorer(self) -> DynamicPriorityScorer | None:
        try:
            self.priority_scorer = DynamicPriorityScorer()
            log.info("Dynamic Priority Scorer ready")
            return self.priority_scorer
        except Exception as e:
            log.warning("Dynamic Priority Scorer init failed", error=str(e))
            return None

    def _wire_domain_event_subscribers(self) -> None:
        """W1-2/W1-3: 将 DomainEventBus 事件连接到 EvolutionOrchestrator 和 StrategyAdapter。

        打通学习信号闭环：
        - domain.evolution.feedback → EvolutionOrchestrator.record_interaction()
        - domain.tool.executed → StrategyAdapter.record_signal() (工具级学习)
        - domain.core.llm_invoked → EvolutionOrchestrator (LLM 调用质量追踪)

        设计原则：
        - 订阅者异常不阻塞 EventBus 发射端（DomainEventBus 已有 try/except）
        - 保留直连调用作为降级路径（EventBus 不可用时）
        - 订阅者处理为异步，不阻塞主流程
        """
        orchestrator = getattr(self, "_evolution_orchestrator", None)

        async def _on_evolution_feedback(payload: Any) -> None:
            if orchestrator is None:
                return
            try:
                if isinstance(payload, dict):
                    quality = float(payload.get("quality_score", 0.5))
                    response_time_ms = float(payload.get("response_time_ms", 0.0))
                    tool_successes = payload.get("tool_successes", True)
                    await orchestrator.record_interaction(
                        quality=quality,
                        response_time_ms=response_time_ms,
                        tool_successes=tool_successes,
                    )
            except Exception as e:
                log_ignored(log, "engine._on_evolution_feedback", e)

        async def _on_tool_executed(payload: Any) -> None:
            if orchestrator is None:
                return
            try:
                if isinstance(payload, dict):
                    adapter = getattr(orchestrator, "_strategy_adapter", None)
                    if adapter is None:
                        return
                    tool_names = payload.get("tool_names", [])
                    failures = payload.get("failures", 0)
                    for tname in tool_names:
                        if failures > 0:
                            adapter.record_signal(f"tool_failure:{tname}", value=-1.0)
                        else:
                            adapter.record_signal(f"tool_success:{tname}", value=1.0)
            except Exception as e:
                log_ignored(log, "engine._on_tool_executed", e)

        async def _on_llm_invoked(payload: Any) -> None:
            if orchestrator is None:
                return
            try:
                if isinstance(payload, dict):
                    quality = float(payload.get("quality", 0.5))
                    response_time_ms = float(payload.get("duration_ms", 0.0))
                    await orchestrator.record_interaction(
                        quality=quality,
                        response_time_ms=response_time_ms,
                        tool_successes=True,
                    )
            except Exception as e:
                log_ignored(log, "engine._on_llm_invoked", e)

        self.domain_events.on("domain.evolution.feedback", _on_evolution_feedback)
        self.domain_events.on("domain.tool.executed", _on_tool_executed)
        self.domain_events.on("domain.core.llm_invoked", _on_llm_invoked)

        log.info(
            "DomainEventBus subscribers wired",
            evolution_feedback=self.domain_events.listener_count("domain.evolution.feedback"),
            tool_executed=self.domain_events.listener_count("domain.tool.executed"),
            llm_invoked=self.domain_events.listener_count("domain.core.llm_invoked"),
        )

    async def _init_evolution_orchestrator(self) -> Any:
        try:
            orchestrator = EvolutionOrchestrator.get_instance()
            orchestrator.register_engines(evolution_engine=self.evolution)
            orchestrator.start()
            log.info("Evolution Orchestrator started")
            return orchestrator
        except Exception as e:
            log.warning("Evolution Orchestrator init failed", error=str(e))
            return None

    async def _init_multi_agent_orchestrator(self) -> Any:
        try:
            if self.loop:
                self._multi_agent_orchestrator = MultiAgentOrchestrator(llm=self.llm)
                log.info("Multi-Agent Orchestrator ready")
            return self._multi_agent_orchestrator
        except Exception as e:
            log.warning("Multi-Agent Orchestrator init failed", error=str(e))
            return None

    async def _init_a2a_manager(self) -> A2AProtocolManager | None:
        try:
            self.a2a_manager = await get_a2a_manager()

            remote_env = os.environ.get("A2A_REMOTE_AGENTS", "")
            self.a2a_remote_endpoints = [
                ep.strip() for ep in remote_env.split(",") if ep.strip()
            ]

            self.a2a_auth_interceptor = A2AAuthInterceptor.from_env()
            log.info("A2A Manager ready")
            return self.a2a_manager
        except Exception as e:
            log.warning("A2A Manager init failed", error=str(e))
            return None

    async def _init_a2a_self_card(self) -> A2AAgentCard | None:
        try:
            if self.a2a_manager:
                auth_type_env = A2AAuthType.parse(os.environ.get("A2A_AUTH_TYPE", "none"))
                host = os.environ.get("AGENT_HOST", "0.0.0.0")
                port = int(os.environ.get("AGENT_PORT", "3112"))
                publish_host = "localhost" if host in ("0.0.0.0", "") else host
                self.a2a_self_card = A2AAgentCard(
                    id="agent:jiabaixing",
                    name="Jiabaixing",
                    description="家百星主 Agent",
                    url=f"http://{publish_host}:{port}/a2a",
                    transport=A2ATransport.HTTP,
                    capabilities=[
                        A2ACapability(type=A2ACapabilityType.TASK_EXECUTION, name="task-execution"),
                        A2ACapability(type=A2ACapabilityType.ORCHESTRATION, name="orchestration"),
                    ],
                    authentication={"type": auth_type_env.value},
                    version="1.0.0",
                    provider={"name": "Jiabaixing", "url": "https://jiabaixing.example.com"},
                )
                await self.a2a_manager.publish_agent_card(self.a2a_self_card)
                log.info("A2A Self Card published")
            return self.a2a_self_card
        except Exception as e:
            log.warning("A2A Self Card init failed", error=str(e))
            return None

    async def _init_a2a_auth_interceptor(self) -> A2AAuthInterceptor | None:
        try:
            if not self.a2a_auth_interceptor:
                self.a2a_auth_interceptor = A2AAuthInterceptor.from_env()
            return self.a2a_auth_interceptor
        except Exception as e:
            log.warning("A2A Auth Interceptor init failed", error=str(e))
            return None

    async def _init_agent_registry(self) -> AgentRegistry | None:
        try:
            self.agent_registry = AgentRegistry.get_instance()
            agent_factory = AgentFactory.get_instance()
            for scene in AgentScene:
                agent = agent_factory.create_agent(scene)
                self.agent_registry.register(name=agent.name, agent=agent, scene=scene)
            log.info("Agent Registry ready", agent_count=self.agent_registry.get_agent_count())
            return self.agent_registry
        except Exception as e:
            log.warning("Agent Registry init failed", error=str(e))
            return None

    async def _init_orchestrator(self) -> OrchestratorAgent | None:
        try:
            if self.agent_registry:
                agent_factory = AgentFactory.get_instance()
                self.orchestrator = OrchestratorAgent(
                    registry=self.agent_registry,
                    agent_factory=agent_factory,
                    a2a_manager=self.a2a_manager,
                    a2a_remote_endpoints=self.a2a_remote_endpoints,
                    self_agent_id=self.a2a_self_card.id if self.a2a_self_card else "agent:jiabaixing",
                    a2a_auth_interceptor=self.a2a_auth_interceptor,
                )
                log.info("Orchestrator ready")
            return self.orchestrator
        except Exception as e:
            log.warning("Orchestrator init failed", error=str(e))
            return None

    async def _init_orchestration_executor(self) -> Any:
        try:
            from agent.orchestration.executor import OrchestrationExecutor, OrchestrationConfig
            self.orchestration_executor = OrchestrationExecutor(
                config=OrchestrationConfig(),
            )
            log.info("OrchestrationExecutor ready")
            return self.orchestration_executor
        except Exception as e:
            log.warning("OrchestrationExecutor init failed", error=str(e))
            return None

    async def _init_cron_scheduler(self) -> CronJobScheduler | None:
        try:
            self.cron_scheduler = CronJobScheduler.get_instance()
            await self.cron_scheduler.start()
            log.info("Cron Job Scheduler ready")
            return self.cron_scheduler
        except Exception as e:
            log.warning("Cron Job Scheduler init failed", error=str(e))
            return None

    async def _init_sandbox(self) -> SandboxExecutor | None:
        try:
            self.sandbox = SandboxExecutor()
            log.info("Sandbox Executor ready")
            return self.sandbox
        except Exception as e:
            log.warning("Sandbox Executor init failed", error=str(e))
            return None

    async def _init_batch_processor(self) -> BatchProcessor | None:
        try:
            self.batch_processor = BatchProcessor(BatchConfig(concurrency=5))
            log.info("Batch Processor ready")
            return self.batch_processor
        except Exception as e:
            log.warning("Batch Processor init failed", error=str(e))
            return None

    async def _init_think_scrubber(self) -> ThinkScrubber | None:
        try:
            self.think_scrubber = ThinkScrubber()
            log.info("Think Scrubber ready")
            return self.think_scrubber
        except Exception as e:
            log.warning("Think Scrubber init failed", error=str(e))
            return None

    async def _init_production_metrics(self) -> Any:
        try:
            self.production_metrics = get_production_metrics_collector()
            log.info("Production Metrics Collector ready")
            return self.production_metrics
        except Exception as e:
            log.warning("Production Metrics Collector init failed", error=str(e))
            return None

    async def _init_feedback_loop(self) -> ContinuousFeedbackLoop | None:
        try:
            self.feedback_loop = ContinuousFeedbackLoop(
                evolution_engine=self.evolution,
                canary_manager=self.canary_manager,
                optimize_threshold=int(os.environ.get("FEEDBACK_OPTIMIZE_THRESHOLD", "100")),
                time_window_seconds=int(os.environ.get("FEEDBACK_OPTIMIZE_WINDOW", "86400")),
            )
            log.info("Continuous Feedback Loop ready")
            return self.feedback_loop
        except Exception as e:
            log.warning("Continuous Feedback Loop init failed", error=str(e))
            return None

    async def _init_redis_cache(self) -> Any:
        try:
            from agent.memory.redis_cache import get_redis_cache, is_redis_enabled
            if is_redis_enabled():
                self._redis_cache = get_redis_cache()
                health = await self._redis_cache.health_check()
                log.info("Redis Cache initialized", healthy=health)
            else:
                log.info("Redis Cache disabled")
            return self._redis_cache
        except Exception as e:
            log.warning("Redis Cache init failed", error=str(e))
            return None

    async def _init_web_search(self) -> Any:
        """初始化 Web 搜索注册中心。"""
        try:
            from agent.tools.web_search_provider import WebSearchRegistry
            self.web_search_registry = WebSearchRegistry()
            log.info("Web Search Registry ready")
            return self.web_search_registry
        except Exception as e:
            log.warning("Web Search Registry init failed", error=str(e))
            return None

    async def _init_tool_search(self) -> Any:
        """初始化工具搜索索引。"""
        try:
            from agent.tools.tool_search import ToolSearchIndex
            self.tool_search_index = ToolSearchIndex()
            if self.tool_registry:
                self.tool_search_index.index_tools(self.tool_registry)
            log.info("Tool Search Index ready")
            return self.tool_search_index
        except Exception as e:
            log.warning("Tool Search Index init failed", error=str(e))
            return None

    async def _init_path_security(self) -> Any:
        """初始化路径安全守卫。"""
        try:
            from agent.security.path_security import PathSecurityGuard
            self.path_security_guard = PathSecurityGuard()
            log.info("Path Security Guard ready")
            return self.path_security_guard
        except Exception as e:
            log.warning("Path Security Guard init failed", error=str(e))
            return None

    async def _init_url_safety(self) -> Any:
        """初始化 URL 安全守卫。"""
        try:
            from agent.security.url_safety import URLSafetyGuard
            self.url_safety_guard = URLSafetyGuard()
            log.info("URL Safety Guard ready")
            return self.url_safety_guard
        except Exception as e:
            log.warning("URL Safety Guard init failed", error=str(e))
            return None

    async def _init_ssl_guard(self) -> Any:
        """初始化 SSL 守卫。"""
        try:
            from agent.security.ssl_guard import SSLGuard
            self.ssl_guard = SSLGuard()
            log.info("SSL Guard ready")
            return self.ssl_guard
        except Exception as e:
            log.warning("SSL Guard init failed", error=str(e))
            return None

    async def _init_redaction(self) -> Any:
        """初始化敏感信息脱敏引擎。"""
        try:
            from agent.security.redact import RedactionEngine
            self.redaction_engine = RedactionEngine()
            log.info("Redaction Engine ready")
            return self.redaction_engine
        except Exception as e:
            log.warning("Redaction Engine init failed", error=str(e))
            return None

    async def _init_error_classifier(self) -> Any:
        """初始化错误分类器。"""
        try:
            from agent.core.error_classifier import ErrorClassifier
            self.error_classifier = ErrorClassifier()
            log.info("Error Classifier ready")
            return self.error_classifier
        except Exception as e:
            log.warning("Error Classifier init failed", error=str(e))
            return None

    async def _init_title_generator(self) -> Any:
        """初始化本地会话标题生成器。"""
        try:
            from agent.persistence.title_generator import TitleGenerator
            self.local_title_generator = TitleGenerator()
            log.info("Title Generator (local) ready")
            return self.local_title_generator
        except Exception as e:
            log.warning("Title Generator init failed", error=str(e))
            return None

    async def _init_session_recap(self) -> Any:
        """初始化会话回顾引擎。"""
        try:
            from agent.persistence.session_recap import SessionRecap
            self.session_recap_engine = SessionRecap()
            log.info("Session Recap Engine ready")
            return self.session_recap_engine
        except Exception as e:
            log.warning("Session Recap init failed", error=str(e))
            return None

    async def _init_session_search_index(self) -> Any:
        """初始化会话搜索索引。"""
        try:
            from agent.persistence.session_search_index import SessionSearchIndex
            self.session_search_index = SessionSearchIndex()
            log.info("Session Search Index ready")
            return self.session_search_index
        except Exception as e:
            log.warning("Session Search Index init failed", error=str(e))
            return None

    async def _init_session_lineage(self) -> Any:
        """初始化会话血缘追踪器。"""
        try:
            from agent.persistence.session_lineage import SessionLineageTracker
            self.session_lineage_tracker = SessionLineageTracker()
            log.info("Session Lineage Tracker ready")
            return self.session_lineage_tracker
        except Exception as e:
            log.warning("Session Lineage Tracker init failed", error=str(e))
            return None

    async def _init_credential_store(self) -> Any:
        """初始化凭据持久化存储。"""
        try:
            from agent.llm.credential_persistence import CredentialStore
            self.credential_store = CredentialStore()
            log.info("Credential Store ready")
            return self.credential_store
        except Exception as e:
            log.warning("Credential Store init failed", error=str(e))
            return None

    async def _init_credential_discovery(self) -> Any:
        """初始化凭据来源发现。"""
        try:
            from agent.llm.credential_sources import CredentialDiscovery
            self.credential_discovery = CredentialDiscovery()
            log.info("Credential Discovery ready")
            return self.credential_discovery
        except Exception as e:
            log.warning("Credential Discovery init failed", error=str(e))
            return None

    async def _init_eval_runner(self) -> Any:
        """初始化评估运行器。"""
        try:
            from agent.evaluation.eval_runner import EvalRunner
            self.eval_runner = EvalRunner()
            log.info("Eval Runner ready")
            return self.eval_runner
        except Exception as e:
            log.warning("Eval Runner init failed", error=str(e))
            return None

    async def _init_gateway_dispatcher(self) -> Any:
        """初始化消息分发中心。"""
        try:
            from agent.gateway.dispatcher import MessageDispatcher
            self.gateway_dispatcher = MessageDispatcher()

            # A-02: 设置 handler 并启动消费循环
            async def _gateway_handler(message: Any) -> str:
                try:
                    result = await self.process_input(
                        session_id=message.chat_id or "gateway",
                        user_input=message.content,
                    )
                    return result.response if hasattr(result, "response") else str(result)
                except Exception as exc:
                    return f"[gateway handler error] {exc}"

            self.gateway_dispatcher.set_handler(_gateway_handler)
            await self.gateway_dispatcher.start_consuming()

            log.info("Gateway Dispatcher ready (consuming)")
            return self.gateway_dispatcher
        except Exception as e:
            log.warning("Gateway Dispatcher init failed", error=str(e))
            return None

    async def _init_a2a_task_manager(self) -> Any:
        """初始化 A2A 任务管理器。"""
        try:
            from agent.a2a.protocol import A2ATaskManager
            self.a2a_task_manager = A2ATaskManager()
            log.info("A2A Task Manager ready")
            return self.a2a_task_manager
        except Exception as e:
            log.warning("A2A Task Manager init failed", error=str(e))
            return None

    async def _init_a2a_discovery(self) -> Any:
        """初始化 A2A Agent 发现服务。"""
        try:
            from agent.a2a.protocol import A2ADiscovery
            self.a2a_discovery = A2ADiscovery()
            log.info("A2A Discovery ready")
            return self.a2a_discovery
        except Exception as e:
            log.warning("A2A Discovery init failed", error=str(e))
            return None

    async def _init_a2a_trust_manager(self) -> Any:
        """初始化 A2A 信任管理器。"""
        try:
            from agent.a2a.protocol import A2ATrustManager
            self.a2a_trust_manager = A2ATrustManager()
            log.info("A2A Trust Manager ready")
            return self.a2a_trust_manager
        except Exception as e:
            log.warning("A2A Trust Manager init failed", error=str(e))
            return None

    # ── T0 用户体验层 ──

    async def _init_clarify(self) -> Any:
        """初始化澄清工具管理器。"""
        try:
            from agent.tools.clarify_tool import register_clarify_tool
            # clarify 已在 register_default_tools 中注册，这里只做标记
            self.clarify_manager = True
            log.info("Clarify tool ready")
            return self.clarify_manager
        except Exception as e:
            log.warning("Clarify init failed", error=str(e))
            return None

    async def _init_todo_manager(self) -> Any:
        """初始化待办事项管理器。"""
        try:
            from agent.tools.todo_tool import TodoManager
            self.todo_manager = TodoManager()
            log.info("Todo Manager ready")
            return self.todo_manager
        except Exception as e:
            log.warning("Todo Manager init failed", error=str(e))
            return None

    async def _init_code_executor(self) -> Any:
        """初始化代码执行器。"""
        try:
            from agent.tools.code_execution_tool import CodeExecutor
            self.code_executor = CodeExecutor()
            log.info("Code Executor ready")
            return self.code_executor
        except Exception as e:
            log.warning("Code Executor init failed", error=str(e))
            return None

    async def _init_delegate(self) -> Any:
        """初始化子 Agent 委派器。"""
        try:
            from agent.tools.delegate_tool import SubAgentDelegator
            self.delegate_delegator = SubAgentDelegator()
            if self.llm:
                self.delegate_delegator.set_llm(self.llm)
            log.info("Delegate Delegator ready")
            return self.delegate_delegator
        except Exception as e:
            log.warning("Delegate Delegator init failed", error=str(e))
            return None

    # ── T1 效率层 ──

    async def _init_lazy_deps(self) -> Any:
        """初始化延迟依赖加载器。"""
        try:
            from agent.infrastructure.lazy_deps import create_default_lazy_deps
            self.lazy_deps = create_default_lazy_deps()
            log.info("Lazy Deps ready")
            return self.lazy_deps
        except Exception as e:
            log.warning("Lazy Deps init failed", error=str(e))
            return None

    async def _init_coding_context(self) -> Any:
        """初始化编码上下文检测器。"""
        try:
            from agent.context.coding_context import CodingContextDetector
            self.coding_context_detector = CodingContextDetector()
            log.info("Coding Context Detector ready")
            return self.coding_context_detector
        except Exception as e:
            log.warning("Coding Context Detector init failed", error=str(e))
            return None

    async def _init_subdirectory_hints(self) -> Any:
        """初始化子目录提示。"""
        try:
            from agent.context.subdirectory_hints import SubdirectoryHints
            self.subdirectory_hints = SubdirectoryHints()
            log.info("Subdirectory Hints ready")
            return self.subdirectory_hints
        except Exception as e:
            log.warning("Subdirectory Hints init failed", error=str(e))
            return None

    # W3（审计 §1.6）：已移除 _init_tool_result_cache。
    # ToolResultCache 此前在此实例化并注册为子系统，但全项目零调用点
    # （无任何 .put()/.get()），属孤儿接线——只占内存、日志上报 "ready"，
    # 却从未缓存过任何工具结果，制造"缓存已启用"的假象。
    # 工具注册表缺少只读/幂等元数据，盲目接线会让 file_write / shell_exec
    # 等副作用工具被错误复用，风险高于收益。
    # 类实现保留在 agent/tools/tool_result_cache.py 备用；未来接线需先引入
    # ToolDefinition.cacheable 白名单（需架构师批准）。

    async def _init_conversation_compressor(self) -> Any:
        """初始化对话压缩器 V2。"""
        try:
            from agent.core.context_compressor import ConversationCompressor
            self.conversation_compressor_v2 = ConversationCompressor()
            log.info("Conversation Compressor V2 ready")
            return self.conversation_compressor_v2
        except Exception as e:
            log.warning("Conversation Compressor V2 init failed", error=str(e))
            return None

    # ── T2 安全可控层 ──

    async def _init_budget_guard(self) -> Any:
        """初始化预算守卫。"""
        try:
            from agent.llm.budget_config import BudgetGuard
            self.budget_guard = BudgetGuard()
            log.info("Budget Guard ready")
            return self.budget_guard
        except Exception as e:
            log.warning("Budget Guard init failed", error=str(e))
            return None

    async def _init_osv_checker(self) -> Any:
        """初始化 OSV 漏洞检查器。"""
        try:
            from agent.security.osv_check import OSVChecker
            self.osv_checker = OSVChecker()
            log.info("OSV Checker ready")
            return self.osv_checker
        except Exception as e:
            log.warning("OSV Checker init failed", error=str(e))
            return None

    async def _init_disk_cleaner(self) -> Any:
        """初始化磁盘清理器。"""
        try:
            from agent.infrastructure.disk_cleanup import DiskCleaner
            self.disk_cleaner = DiskCleaner()
            log.info("Disk Cleaner ready")
            return self.disk_cleaner
        except Exception as e:
            log.warning("Disk Cleaner init failed", error=str(e))
            return None

    async def _init_security_guidance(self) -> Any:
        """初始化安全指导模块。"""
        try:
            from agent.security.security_guidance import SecurityGuidance
            self.security_guidance = SecurityGuidance()
            log.info("Security Guidance ready")
            return self.security_guidance
        except Exception as e:
            log.warning("Security Guidance init failed", error=str(e))
            return None

    # ── T3+T4 差异化层 ──

    async def _init_voice_mode(self) -> Any:
        """初始化语音模式管理器。"""
        try:
            from agent.tools.voice_mode_tool import VoiceModeManager
            self.voice_mode_manager = VoiceModeManager()
            log.info("Voice Mode Manager ready")
            return self.voice_mode_manager
        except Exception as e:
            log.warning("Voice Mode Manager init failed", error=str(e))
            return None

    async def _init_workspace(self) -> Any:
        """初始化工作区管理器。"""
        try:
            from agent.persistence.workspace import WorkspaceManager
            self.workspace_manager = WorkspaceManager()
            log.info("Workspace Manager ready")
            return self.workspace_manager
        except Exception as e:
            log.warning("Workspace Manager init failed", error=str(e))
            return None

    async def _init_i18n(self) -> Any:
        """初始化国际化模块。"""
        try:
            from agent.i18n import get_i18n
            self.i18n_instance = get_i18n()
            log.info("I18n ready")
            return self.i18n_instance
        except Exception as e:
            log.warning("I18n init failed", error=str(e))
            return None

    async def _init_plugin_manager(self) -> Any:
        """初始化插件管理器。"""
        try:
            from agent.plugins import PluginManager
            from agent.plugins.trust import PluginTrustPolicy
            # 从环境变量预声明受信插件（未列出的插件默认 UNTRUSTED）。
            self.plugin_manager = PluginManager(trust_policy=PluginTrustPolicy.from_env())
            # T2：运行时激活工具信任 gate —— 把受信插件的工具注册进核心工具
            # 注册表（每个工具过 guard_plugin_tool；UNTRUSTED 工具全不注册）。
            # 初始无插件时为空操作；后续启用插件并调用 register_all_tools 即生效。
            if self.tool_registry is not None:
                try:
                    self.plugin_manager.register_all_tools(self.tool_registry)
                    log.info("Plugin tools registration (trust-gated) attempted")
                except Exception as e:
                    log.warning("Plugin tools registration skipped", error=str(e))
            log.info("Plugin Manager ready")
            # 接线 R1-B 管理面控制器（插件信任改写推送到真实策略）
            from agent.security.runtime_control import get_controller
            get_controller().attach_plugin_policy(self.plugin_manager._trust)
            return self.plugin_manager
        except Exception as e:
            log.warning("Plugin Manager init failed", error=str(e))
            return None

    # ── P3-P5 扩展节点初始化 ──

    async def _init_extension_catalog(self) -> Any:
        """T4：构建窄腰能力目录（skill:*/mcp:*），供技能/MCP 注册门控复用。

        默认全部启用（向后兼容）；AGENT_OPTIONAL_EXTENSIONS 可设为白名单。
        """
        try:
            from agent.catalog import EXTENSIONS_ENV

            self.extension_catalog = build_extension_catalog(os.environ.get(EXTENSIONS_ENV))
            log.info(
                "Extension Catalog ready",
                enabled=len(self.extension_catalog.list_enabled()),
                total=len(self.extension_catalog.entries()),
            )
            return self.extension_catalog
        except Exception as e:
            log.warning("Extension Catalog init failed", error=str(e))
            self.extension_catalog = None
            return None

    async def _init_skill_hub(self) -> Any:
        """初始化技能市场（Skill Hub）。"""
        try:
            from agent.evolution.skill_hub import SkillHub
            self.skill_hub = SkillHub()
            log.info("Skill Hub ready")
            return self.skill_hub
        except Exception as e:
            log.warning("Skill Hub init failed", error=str(e))
            return None

    async def _init_skill_audit(self) -> Any:
        """初始化技能安全审计器。"""
        try:
            from agent.evolution.skill_audit import SkillAuditor
            self.skill_audit = SkillAuditor()
            log.info("Skill Auditor ready")
            return self.skill_audit
        except Exception as e:
            log.warning("Skill Auditor init failed", error=str(e))
            return None

    async def _init_profile_manager(self) -> Any:
        """初始化 Profile 配置管理器。"""
        try:
            from agent.cli.profile_manager import ProfileManager
            self.profile_manager = ProfileManager()
            log.info("Profile Manager ready")
            return self.profile_manager
        except Exception as e:
            log.warning("Profile Manager init failed", error=str(e))
            return None

    async def _init_async_delegator(self) -> Any:
        """初始化并行委派器。"""
        try:
            from agent.tools.async_delegation import AsyncDelegator
            self.async_delegator = AsyncDelegator()
            log.info("Async Delegator ready")
            return self.async_delegator
        except Exception as e:
            log.warning("Async Delegator init failed", error=str(e))
            return None

    async def _init_memory_providers(self) -> Any:
        """初始化记忆提供者工厂。"""
        try:
            from agent.memory.providers import MemoryProviderFactory
            self.memory_providers = MemoryProviderFactory
            log.info("Memory Providers ready")
            return self.memory_providers
        except Exception as e:
            log.warning("Memory Providers init failed", error=str(e))
            return None

    async def _init_proxy_server(self) -> Any:
        """初始化 API 代理服务器。"""
        try:
            from agent.api.proxy_server import ProxyServer
            self.proxy_server = ProxyServer()
            log.info("Proxy Server ready")
            return self.proxy_server
        except Exception as e:
            log.warning("Proxy Server init failed", error=str(e))
            return None

    async def _init_dashboard_auth(self) -> Any:
        """初始化 Dashboard 认证系统。"""
        try:
            from agent.api.dashboard_auth import DashboardAuth
            self.dashboard_auth = DashboardAuth()
            log.info("Dashboard Auth ready")
            return self.dashboard_auth
        except Exception as e:
            log.warning("Dashboard Auth init failed", error=str(e))
            return None

    async def _init_hot_reloader(self) -> Any:
        """初始化热重载器。"""
        try:
            from agent.gateway.restart import HotReloader
            self.hot_reloader = HotReloader()
            log.info("Hot Reloader ready")
            return self.hot_reloader
        except Exception as e:
            log.warning("Hot Reloader init failed", error=str(e))
            return None

    async def _init_shutdown_forensics(self) -> Any:
        """初始化关闭取证分析器。"""
        try:
            from agent.gateway.forensics import ShutdownForensics
            self.shutdown_forensics = ShutdownForensics()
            log.info("Shutdown Forensics ready")
            return self.shutdown_forensics
        except Exception as e:
            log.warning("Shutdown Forensics init failed", error=str(e))
            return None

    async def _init_relay_adapter(self) -> Any:
        """初始化 WebSocket 中继适配器。"""
        try:
            from agent.gateway.platforms.relay_adapter import RelayAdapter
            self.relay_adapter = RelayAdapter()
            log.info("Relay Adapter ready")
            return self.relay_adapter
        except Exception as e:
            log.warning("Relay Adapter init failed", error=str(e))
            return None

    # ── P6 扩展节点初始化 ──

    async def _init_batch_trajectory(self) -> Any:
        """初始化批量轨迹生成器。"""
        try:
            from agent.persistence.batch_trajectory import BatchTrajectoryGenerator
            self.batch_trajectory = BatchTrajectoryGenerator()
            log.info("Batch Trajectory Generator ready")
            return self.batch_trajectory
        except Exception as e:
            log.warning("Batch Trajectory Generator init failed", error=str(e))
            return None

    async def _init_stream_diag(self) -> Any:
        """初始化流式传输诊断器。"""
        try:
            from agent.llm.stream_diag import StreamDiagnostics
            self.stream_diag = StreamDiagnostics()
            log.info("Stream Diagnostics ready")
            return self.stream_diag
        except Exception as e:
            log.warning("Stream Diagnostics init failed", error=str(e))
            return None

    async def _init_nous_rate_guard(self) -> Any:
        """初始化 Nous Portal 速率守卫。"""
        try:
            from agent.llm.nous_rate_guard import NousRateGuard
            self.nous_rate_guard = NousRateGuard()
            log.info("Nous Rate Guard ready")
            return self.nous_rate_guard
        except Exception as e:
            log.warning("Nous Rate Guard init failed", error=str(e))
            return None

    async def _init_portal_tags(self) -> Any:
        """初始化 Portal OAuth 标签管理器。"""
        try:
            from agent.llm.portal_tags import PortalTagManager
            self.portal_tags = PortalTagManager()
            log.info("Portal Tag Manager ready")
            return self.portal_tags
        except Exception as e:
            log.warning("Portal Tag Manager init failed", error=str(e))
            return None

    # ── P7 扩展节点初始化 ──

    async def _init_message_content(self) -> Any:
        """初始化消息内容处理器。"""
        try:
            from agent.gateway.message_content import MessageContentProcessor
            self.message_content = MessageContentProcessor()
            log.info("Message Content Processor ready")
            return self.message_content
        except Exception as e:
            log.warning("Message Content Processor init failed", error=str(e))
            return None

    async def _init_retry_utils(self) -> Any:
        """初始化重试执行器。"""
        try:
            from agent.core.retry_utils import RetryExecutor
            self.retry_utils = RetryExecutor()
            log.info("Retry Executor ready")
            return self.retry_utils
        except Exception as e:
            log.warning("Retry Executor init failed", error=str(e))
            return None

    async def _init_skill_provenance(self) -> Any:
        """初始化技能来源追踪器。"""
        try:
            from agent.evolution.skill_provenance import SkillProvenance
            self.skill_provenance = SkillProvenance()
            log.info("Skill Provenance ready")
            return self.skill_provenance
        except Exception as e:
            log.warning("Skill Provenance init failed", error=str(e))
            return None

    async def _init_cli_output(self) -> Any:
        """初始化 CLI 输出格式化器。"""
        try:
            from agent.cli.cli_output import CliOutput
            self.cli_output = CliOutput()
            log.info("CLI Output ready")
            return self.cli_output
        except Exception as e:
            log.warning("CLI Output init failed", error=str(e))
            return None

    async def _init_markdown_tables(self) -> Any:
        """初始化 Markdown 表格渲染器。"""
        try:
            from agent.gateway.markdown_tables import MarkdownTables
            self.markdown_tables = MarkdownTables()
            log.info("Markdown Tables ready")
            return self.markdown_tables
        except Exception as e:
            log.warning("Markdown Tables init failed", error=str(e))
            return None

    # ── P8 扩展节点初始化 ──

    async def _init_display_formatter(self) -> Any:
        """初始化显示格式化器。"""
        try:
            from agent.cli.display_formatter import DisplayFormatter
            self.display_formatter = DisplayFormatter()
            log.info("Display Formatter ready")
            return self.display_formatter
        except Exception as e:
            log.warning("Display Formatter init failed", error=str(e))
            return None

    async def _init_curses_tui(self) -> Any:
        """初始化 Curses TUI。"""
        try:
            from agent.cli.curses_tui import CursesTUI
            self.curses_tui = CursesTUI()
            log.info("Curses TUI ready")
            return self.curses_tui
        except Exception as e:
            log.warning("Curses TUI init failed", error=str(e))
            return None

    async def _init_pty_bridge(self) -> Any:
        """初始化 PTY 桥接器。"""
        try:
            from agent.cli.pty_bridge import PtyBridge
            self.pty_bridge = PtyBridge()
            log.info("PTY Bridge ready")
            return self.pty_bridge
        except Exception as e:
            log.warning("PTY Bridge init failed", error=str(e))
            return None

    async def _init_shell_completion(self) -> Any:
        """初始化 Shell 补全生成器。"""
        try:
            from agent.cli.shell_completion import ShellCompletion
            self.shell_completion = ShellCompletion()
            log.info("Shell Completion ready")
            return self.shell_completion
        except Exception as e:
            log.warning("Shell Completion init failed", error=str(e))
            return None

    async def _init_clipboard(self) -> Any:
        """初始化剪贴板工具。"""
        try:
            from agent.cli.clipboard import Clipboard
            self.clipboard = Clipboard()
            log.info("Clipboard ready")
            return self.clipboard
        except Exception as e:
            log.warning("Clipboard init failed", error=str(e))
            return None

    # ── P9 扩展节点初始化 ──

    async def _init_prompt_caching(self) -> Any:
        """初始化 Prompt 前缀缓存管理器。"""
        try:
            from agent.llm.prompt_cache import PromptCaching
            self.prompt_caching = PromptCaching()
            log.info("Prompt Caching ready")
            return self.prompt_caching
        except Exception as e:
            log.warning("Prompt Caching init failed", error=str(e))
            return None

    async def _init_turn_finalizer(self) -> Any:
        """初始化回合终态处理器。"""
        try:
            from agent.core.turn_finalizer import TurnFinalizer
            self.turn_finalizer = TurnFinalizer()
            log.info("Turn Finalizer ready")
            return self.turn_finalizer
        except Exception as e:
            log.warning("Turn Finalizer init failed", error=str(e))
            return None

    async def _init_turn_retry_state(self) -> Any:
        """初始化回合重试状态机。"""
        try:
            from agent.core.turn_retry_state import TurnRetryState
            self.turn_retry_state = TurnRetryState()
            log.info("Turn Retry State ready")
            return self.turn_retry_state
        except Exception as e:
            log.warning("Turn Retry State init failed", error=str(e))
            return None

    async def _init_batch_runner(self) -> Any:
        """初始化批量任务运行器。"""
        try:
            from agent.core.batch_runner import BatchRunner
            self.batch_runner = BatchRunner()
            log.info("Batch Runner ready")
            return self.batch_runner
        except Exception as e:
            log.warning("Batch Runner init failed", error=str(e))
            return None

    # ── P10 安全+记忆+Prompt增强节点初始化 ──

    async def _init_write_approval(self) -> Any:
        """初始化文件写入审批工具。"""
        try:
            from agent.security.write_approval import WriteApproval
            self.write_approval = WriteApproval()
            log.info("Write Approval ready")
            return self.write_approval
        except Exception as e:
            log.warning("Write Approval init failed", error=str(e))
            return None

    async def _init_threat_patterns(self) -> Any:
        """初始化威胁模式检测器。"""
        try:
            from agent.security.threat_patterns import ThreatPatternDetector
            self.threat_patterns = ThreatPatternDetector()
            log.info("Threat Patterns ready")
            return self.threat_patterns
        except Exception as e:
            log.warning("Threat Patterns init failed", error=str(e))
            return None

    async def _init_memory_manager(self) -> Any:
        """初始化统一记忆管理器。"""
        try:
            from agent.memory.memory_manager import MemoryManager
            self.memory_manager = MemoryManager()
            log.info("Memory Manager ready")
            return self.memory_manager
        except Exception as e:
            log.warning("Memory Manager init failed", error=str(e))
            return None

    async def _init_insights(self) -> Any:
        """初始化记忆洞察提取器。"""
        try:
            from agent.memory.insights import InsightExtractor
            self.insights = InsightExtractor()
            log.info("Insights ready")
            return self.insights
        except Exception as e:
            log.warning("Insights init failed", error=str(e))
            return None

    async def _init_background_review(self) -> Any:
        """初始化后台记忆审查器。"""
        try:
            from agent.memory.background_review import BackgroundReview
            self.background_review = BackgroundReview()
            log.info("Background Review ready")
            return self.background_review
        except Exception as e:
            log.warning("Background Review init failed", error=str(e))
            return None

    async def _init_conversation_compression(self) -> Any:
        """初始化长对话压缩器。"""
        try:
            from agent.context.conversation_compression import ConversationCompression
            self.conversation_compression = ConversationCompression()
            log.info("Conversation Compression ready")
            return self.conversation_compression
        except Exception as e:
            log.warning("Conversation Compression init failed", error=str(e))
            return None

    async def _init_context_references(self) -> Any:
        """初始化上下文引用解析器。"""
        try:
            from agent.context.context_references import ContextReferences
            self.context_references = ContextReferences()
            log.info("Context References ready")
            return self.context_references
        except Exception as e:
            log.warning("Context References init failed", error=str(e))
            return None

    # ── P11 平台扩展+LSP+ACP+Skill节点初始化 ──

    async def _init_platform_manager(self) -> Any:
        """初始化多平台适配器管理器。"""
        try:
            from agent.gateway.platform_manager import PlatformManager
            self.platform_manager = PlatformManager()
            log.info("Platform Manager ready")
            return self.platform_manager
        except Exception as e:
            log.warning("Platform Manager init failed", error=str(e))
            return None

    async def _init_lsp_servers(self) -> Any:
        """初始化 LSP 服务器管理器。"""
        try:
            from agent.lsp.servers import LspServerManager
            self.lsp_servers = LspServerManager()
            log.info("LSP Servers ready")
            return self.lsp_servers
        except Exception as e:
            log.warning("LSP Servers init failed", error=str(e))
            return None

    async def _init_lsp_workspace(self) -> Any:
        """初始化 LSP 工作区。"""
        try:
            from agent.lsp.workspace import LspWorkspace
            self.lsp_workspace = LspWorkspace()
            log.info("LSP Workspace ready")
            return self.lsp_workspace
        except Exception as e:
            log.warning("LSP Workspace init failed", error=str(e))
            return None

    async def _init_acp_entry(self) -> Any:
        """初始化 ACP 协议入口。"""
        try:
            from agent.acp.entry import ACPEntry
            self.acp_entry = ACPEntry(agent_engine=self)
            log.info("ACP Entry ready")
            return self.acp_entry
        except Exception as e:
            log.warning("ACP Entry init failed", error=str(e))
            return None

    async def _init_acp_server(self) -> Any:
        """初始化 ACP HTTP 服务器。"""
        try:
            from agent.acp.server import ACPServer
            self.acp_server = ACPServer(agent_engine=self)
            log.info("ACP Server ready")
            return self.acp_server
        except Exception as e:
            log.warning("ACP Server init failed", error=str(e))
            return None

    async def _init_acp_auth(self) -> Any:
        """初始化 ACP 认证管理器。"""
        try:
            from agent.acp.auth import ACPAuthManager
            self.acp_auth = ACPAuthManager()
            log.info("ACP Auth ready")
            return self.acp_auth
        except Exception as e:
            log.warning("ACP Auth init failed", error=str(e))
            return None

    async def _init_skill_sync(self) -> Any:
        """初始化技能同步管理器。"""
        try:
            from agent.skill.skill_sync import SkillSyncManager
            self.skill_sync = SkillSyncManager()
            log.info("Skill Sync ready")
            return self.skill_sync
        except Exception as e:
            log.warning("Skill Sync init failed", error=str(e))
            return None

    async def _init_skill_bundles(self) -> Any:
        """初始化技能打包器。"""
        try:
            from agent.skill.skill_bundles import SkillBundler
            self.skill_bundles = SkillBundler()
            log.info("Skill Bundles ready")
            return self.skill_bundles
        except Exception as e:
            log.warning("Skill Bundles init failed", error=str(e))
            return None

    # ── P12 游离节点初始化 ──

    async def _init_model_cost_guard(self) -> Any:
        """初始化模型成本守卫。"""
        try:
            from agent.llm.model_cost_guard import ModelCostGuard
            self.model_cost_guard = ModelCostGuard()
            log.info("Model Cost Guard ready")
            return self.model_cost_guard
        except Exception as e:
            log.warning("Model Cost Guard init failed", error=str(e))
            return None

    async def _init_auxiliary_client(self) -> Any:
        """初始化辅助 LLM 客户端。"""
        try:
            from agent.llm.auxiliary_client import AuxiliaryLLMClient
            self.auxiliary_client = AuxiliaryLLMClient()
            log.info("Auxiliary LLM Client ready")
            return self.auxiliary_client
        except Exception as e:
            log.warning("Auxiliary LLM Client init failed", error=str(e))
            return None

    async def _init_moa_aggregator(self) -> Any:
        """初始化 MoA 聚合器。"""
        try:
            from agent.llm.moa_aggregator import MoAAggregator
            self.moa_aggregator = MoAAggregator()
            log.info("MoA Aggregator ready")
            return self.moa_aggregator
        except Exception as e:
            log.warning("MoA Aggregator init failed", error=str(e))
            return None

    async def _init_streaming_scrubber(self) -> Any:
        """初始化流式脱敏器。"""
        try:
            from agent.security.streaming_scrubber import StreamingScrubber
            self.streaming_scrubber = StreamingScrubber()
            log.info("Streaming Scrubber ready")
            return self.streaming_scrubber
        except Exception as e:
            log.warning("Streaming Scrubber init failed", error=str(e))
            return None

    async def _init_account_usage(self) -> Any:
        """初始化账户用量追踪。"""
        try:
            from agent.persistence.account_usage import AccountUsageTracker
            self.account_usage = AccountUsageTracker()
            log.info("Account Usage Tracker ready")
            return self.account_usage
        except Exception as e:
            log.warning("Account Usage Tracker init failed", error=str(e))
            return None

    async def _init_learning_graph(self) -> Any:
        """初始化学习图。"""
        try:
            from agent.evolution.learning_graph import LearningGraph
            self.learning_graph = LearningGraph()
            log.info("Learning Graph ready")
            return self.learning_graph
        except Exception as e:
            log.warning("Learning Graph init failed", error=str(e))
            return None

    async def _init_rate_limit_tracker(self) -> Any:
        """初始化速率限制追踪器。"""
        try:
            from agent.llm.rate_limit_tracker import RateLimitTracker
            self.rate_limit_tracker = RateLimitTracker()
            log.info("Rate Limit Tracker ready")
            return self.rate_limit_tracker
        except Exception as e:
            log.warning("Rate Limit Tracker init failed", error=str(e))
            return None

    async def _init_blueprint_catalog(self) -> Any:
        """初始化蓝图目录。"""
        try:
            from agent.scheduler.blueprint_catalog import BlueprintCatalog
            self.blueprint_catalog = BlueprintCatalog()
            log.info("Blueprint Catalog ready")
            return self.blueprint_catalog
        except Exception as e:
            log.warning("Blueprint Catalog init failed", error=str(e))
            return None

    async def _init_onboarding(self) -> Any:
        """初始化引导向导。"""
        try:
            from agent.core.onboarding import OnboardingWizard
            self.onboarding = OnboardingWizard()
            log.info("Onboarding Wizard ready")
            return self.onboarding
        except Exception as e:
            log.warning("Onboarding Wizard init failed", error=str(e))
            return None

    async def _init_gateway_hooks(self) -> Any:
        """初始化 Gateway 钩子管理器。"""
        try:
            from agent.gateway.hooks import HookManager as GatewayHookManager
            self.gateway_hooks = GatewayHookManager()
            log.info("Gateway Hooks ready")
            return self.gateway_hooks
        except Exception as e:
            log.warning("Gateway Hooks init failed", error=str(e))
            return None

    async def _init_slash_commands(self) -> Any:
        """初始化斜杠命令管理器。"""
        try:
            from agent.gateway.slash_commands import SlashCommandManager
            self.slash_commands = SlashCommandManager()
            log.info("Slash Commands ready")
            return self.slash_commands
        except Exception as e:
            log.warning("Slash Commands init failed", error=str(e))
            return None

    async def _init_safety_net(self) -> Any:
        """初始化 SafetyNet 安全沙箱。

        SafetyNet 集成 CheckpointManager、OperationScope、AutoRollback、
        AuditTrail、DryRunExecutor 五大组件，为 agent_native 模型提供
        高风险操作的自动审批和还原点保护。
        """
        try:
            from agent.safety import SafetyNet
            self.safety_net = SafetyNet()

            if self.approval_manager is not None:
                self.approval_manager._safety_net = self.safety_net

            try:
                from agent.tools.code_execution_tool import set_safety_net as _cesn
                _cesn(self.safety_net)
            except Exception as _exc:
                log_ignored(log, "engine._setup_safety_net.code_execution", _exc)

            try:
                from agent.tools.write_approval_tool import set_safety_net as _wasn
                _wasn(self.safety_net)
            except Exception as _exc:
                log_ignored(log, "engine._setup_safety_net.write_approval", _exc)

            log.info("SafetyNet ready")
            return self.safety_net
        except Exception as e:
            log.warning("SafetyNet init failed", error=str(e))
            return None

    async def _init_workflow_engine(self) -> Any:
        """初始化 WorkflowEngine 持久化工作流引擎。

        WorkflowEngine 支持 DAG 任务编排、状态持久化、事件触发、
        崩溃恢复，让 agent_native 模型可以执行跨会话的持续任务。
        依赖 SafetyNet 提供还原点保护。
        """
        try:
            from agent.workflow import WorkflowEngine
            safety_net = getattr(self, "safety_net", None)
            self.workflow_engine = WorkflowEngine(safety_net=safety_net)

            try:
                from agent.workflow.tools import register_workflow_tools
                tool_registry = getattr(self, "tool_registry", None)
                if tool_registry is not None:
                    register_workflow_tools(tool_registry, self.workflow_engine)
            except Exception as _exc:
                log_ignored(log, "engine._init_workflow_engine.register_tools", _exc)

            # P0-2: 延迟注入到 LoopController，启用工作流状态上下文注入
            if hasattr(self, "loop") and self.loop is not None:
                self.loop._workflow_engine = self.workflow_engine
                log.info("WorkflowEngine injected into LoopController")

            log.info("WorkflowEngine ready")
            return self.workflow_engine
        except Exception as e:
            log.warning("WorkflowEngine init failed", error=str(e))
            return None

    async def _init_perception_loop(self) -> Any:
        """初始化 PerceptionActionLoop 多模态感知闭环。

        整合 UIAElementCache、ActionVerifier、VisualGrounding、
        ScreenWatcher、LocalOCR 五大组件，提供完整的
        感知-行动闭环能力。
        """
        try:
            from agent.perception import PerceptionActionLoop
            self.perception_loop = PerceptionActionLoop(
                enable_watcher=True,
                enable_ocr=True,
                shutdown_event=getattr(self, "_shutdown_event", None),
            )

            # P1-1: 延迟注入到 LoopController.Executor，启用桌面操作自动验证
            if hasattr(self, "loop") and self.loop is not None:
                executor = getattr(self.loop, "executor", None)
                if executor is not None and hasattr(executor, "set_perception_loop"):
                    executor.set_perception_loop(self.perception_loop)
                    log.info("PerceptionActionLoop injected into Executor")

                # P1-1: 延迟注入到 LoopController，启用感知上下文注入
                self.loop._perception_loop = self.perception_loop
                log.info("PerceptionActionLoop injected into LoopController")

            log.info("PerceptionActionLoop ready")
            return self.perception_loop
        except Exception as e:
            log.warning("PerceptionActionLoop init failed", error=str(e))
            return None

    async def _init_knowledge_lifecycle(self) -> Any:
        """初始化 KnowledgeLifecycle 知识沉淀与主动学习。

        整合 KnowledgeStore、KnowledgeExtractor、KnowledgeDecay，
        提供完整的知识沉淀、检索、衰减、淘汰闭环。
        """
        try:
            from agent.knowledge import KnowledgeLifecycle
            self.knowledge_lifecycle = KnowledgeLifecycle()
            await self.knowledge_lifecycle.initialize()

            # P1-2: 延迟注入到 LoopController，启用知识上下文注入和对话后自动提取
            if hasattr(self, "loop") and self.loop is not None:
                self.loop._knowledge_lifecycle = self.knowledge_lifecycle
                log.info("KnowledgeLifecycle injected into LoopController")

            # P1-2: 启动知识衰减定时任务，自动维护知识库
            await self.knowledge_lifecycle.start_decay_scheduler()
            log.info("KnowledgeLifecycle decay scheduler started")

            log.info("KnowledgeLifecycle ready")
            return self.knowledge_lifecycle
        except Exception as e:
            log.warning("KnowledgeLifecycle init failed", error=str(e))
            return None

    async def _init_mcp_integration(self) -> Any:
        """初始化 MCP 生态集成。

        整合 MCPClient、MCPToolBridge、MCPLifecycle，
        实现 MCP 服务端连接、工具桥接和生命周期管理。
        同时桥接 ResourceSubscriptionManager 事件到 LoopController。
        """
        try:
            from agent.mcp_integration import MCPClient, MCPToolBridge, MCPLifecycle
            self.mcp_client = MCPClient()
            self.mcp_tool_bridge = MCPToolBridge(
                self.mcp_client,
                getattr(self, "tool_registry", None),
            )
            self.mcp_lifecycle = MCPLifecycle(self.mcp_client)

            mcp_config = os.environ.get("MCP_CONFIG_PATH", "")
            if mcp_config:
                await self.mcp_lifecycle.load_config(mcp_config)
            else:
                await self.mcp_lifecycle.auto_load()

            # P1-3: 自动启动已配置的 MCP 服务端
            if self.mcp_lifecycle and hasattr(self.mcp_lifecycle, "_servers") and self.mcp_lifecycle._servers:
                try:
                    start_results = await self.mcp_lifecycle.start_all()
                    started = sum(1 for v in start_results.values() if v)
                    log.info("MCP servers auto-started", total=len(start_results), success=started)
                except Exception as start_err:
                    log.warning("MCP auto-start failed", error=str(start_err))

            # P1-3: 桥接资源变更事件到 LoopController
            try:
                resource_sub = getattr(self.mcp_client, "_resource_sub", None)
                if resource_sub is None:
                    from agent.mcp_integration.resource_subscription import ResourceSubscriptionManager
                    resource_sub = ResourceSubscriptionManager(self.mcp_client)
                    self.mcp_client._resource_sub = resource_sub

                loop_ctrl = getattr(self, "loop", None)
                if loop_ctrl is not None:
                    async def _on_resource_change(event: Any) -> None:
                        if hasattr(loop_ctrl, "_mcp_resource_events"):
                            loop_ctrl._mcp_resource_events.append(event)
                            if len(loop_ctrl._mcp_resource_events) > 50:
                                loop_ctrl._mcp_resource_events = loop_ctrl._mcp_resource_events[-50:]

                    resource_sub.on_change(_on_resource_change)
                    await resource_sub.start_processor()
                    log.info("MCP resource subscription bridge to LoopController active")
            except Exception as bridge_err:
                log.warning("MCP resource subscription bridge failed", error=str(bridge_err))

            log.info("MCP Integration ready")
            return self.mcp_client
        except Exception as e:
            log.warning("MCP Integration init failed", error=str(e))
            return None

    @property
    def uptime(self) -> float:
        if not self._start_time:
            return 0.0
        import time
        return time.time() - self._start_time
