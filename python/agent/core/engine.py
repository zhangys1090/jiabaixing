from __future__ import annotations

import os
from typing import Any

from agent.core.dependencies import SUBSYSTEM_DEPS, SubsystemSpec
from agent.core.logger import StructuredLogger
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
from agent.core.context_pipeline import (
    ContextManager,
    ContextFileRegistry,
    ContextReferenceResolver,
)
from agent.core.context_compressor import ContextCompressor, ContextWindowManager
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
        self.memory: MemoryEngine | None = None
        self.loop: LoopController | None = None
        self.evolution: EvolutionEngine | None = None
        self.conversation: ConversationLoop | None = None
        self.context_manager: ContextManager | None = None
        self.context_compressor: ContextCompressor | None = None
        self.context_window_manager: ContextWindowManager | None = None
        self.context_file_registry: ContextFileRegistry | None = None
        self.context_reference_resolver: ContextReferenceResolver | None = None
        self.persona: PersonaCore | None = None
        self.unified_context_orchestrator: UnifiedContextOrchestrator | None = None
        self.security: SecurityGuard | None = None
        self.tool_registry: ToolRegistry | None = None
        # 会话回顾和标题生成器（延迟初始化）
        self.session_recap: Any = None
        self.title_generator: Any = None
        self.toolset_registry: ToolsetRegistry | None = None
        self.mcp_tool_bridge: MCPToolBridge | None = None
        self.permission_guard: PermissionGuard | None = None
        self.schema_validator: SchemaValidator | None = None
        self.tool_call_guard: ToolCallGuard | None = None
        self.approval_manager: ApprovalManager | None = None
        self.skill_registry: SkillRegistry | None = None
        self.session_store: SessionStore | None = None
        self.trajectory_db: TrajectoryDatabase | None = None
        self.flywheel: TrajectoryFlywheel | None = None
        self.persistence: PersistenceService | None = None
        self.curator: Curator | None = None
        self.verification: VerificationService | None = None
        self.constraints: ConstraintsService | None = None
        self.hook_manager: HookManager | None = None
        self.feedback_loops: FeedbackLoops | None = None
        self.agent_registry: AgentRegistry | None = None
        self.orchestrator: OrchestratorAgent | None = None
        self.cron_scheduler: CronJobScheduler | None = None
        self.output_guardrail: OutputGuardrailEngine | None = None
        self.sandbox: SandboxExecutor | None = None
        self.batch_processor: BatchProcessor | None = None
        self.attention_focus: AttentionFocusEngine | None = None
        self.think_scrubber: ThinkScrubber | None = None
        # OTel tracer/meter 不再缓存到实例属性，统一通过 otel_metrics/otel_tracer 工厂获取
        self._redis_cache: Any = None
        # P3-#3: 生产埋点采集器 + 持续反馈闭环
        self.production_metrics: Any = None
        self.feedback_loop: ContinuousFeedbackLoop | None = None
        self._start_time: float = 0.0
        self._session_count: int = 0
        self._active_sessions: int = 0  # 当前活跃会话数，用于 OTel gauge
        self.performance_monitor: PerformanceMonitor | None = None
        self.evolution_trigger: EvolutionTrigger | None = None
        self.fewshot_generalizer: FewShotGeneralizer | None = None
        self.strategy_adapter: StrategyAdapter | None = None
        self.learning_signals: LearningSignalCollector | None = None
        self.incremental_planner: IncrementalPlanner | None = None
        self.plan_quality_checker: PlanQualityChecker | None = None
        self.reflection_applier: ReflectionApplicationManager | None = None
        self.canary_manager: CanaryReleaseManager | None = None
        self.priority_scorer: DynamicPriorityScorer | None = None
        # A2A 协议组件 — 跨 Agent 通信能力
        self.a2a_manager: A2AProtocolManager | None = None
        self.a2a_self_card: A2AAgentCard | None = None
        # A2A 运行时鉴权拦截器 — 入站校验 + 出站凭据注入
        self.a2a_auth_interceptor: A2AAuthInterceptor | None = None
        # 远程 A2A Agent 端点列表（逗号分隔 URL，从环境变量 A2A_REMOTE_AGENTS 加载）
        self.a2a_remote_endpoints: list[str] = []
        # 新增功能模块属性
        self.web_search_registry: Any = None
        self.tool_search_index: Any = None
        self.path_security_guard: Any = None
        self.url_safety_guard: Any = None
        self.ssl_guard: Any = None
        self.redaction_engine: Any = None
        self.error_classifier: Any = None
        self.local_title_generator: Any = None
        self.session_recap_engine: Any = None
        self.session_search_index: Any = None
        self.session_lineage_tracker: Any = None
        self.credential_store: Any = None
        self.credential_discovery: Any = None
        self.eval_runner: Any = None
        self.gateway_dispatcher: Any = None
        self.a2a_task_manager: Any = None
        self.a2a_discovery: Any = None
        self.a2a_trust_manager: Any = None
        # T0 用户体验
        self.clarify_manager: Any = None
        self.todo_manager: Any = None
        self.code_executor: Any = None
        self.delegate_delegator: Any = None
        self.write_approval_manager: Any = None
        # T1 效率
        self.lazy_deps: Any = None
        self.coding_context_detector: Any = None
        self.subdirectory_hints: Any = None
        self.tool_result_cache: Any = None
        self.conversation_compressor_v2: Any = None
        # T2 安全可控
        self.budget_guard: Any = None
        self.osv_checker: Any = None
        self.disk_cleaner: Any = None
        self.security_guidance: Any = None
        # T3+T4 差异化
        self.voice_mode_manager: Any = None
        self.workspace_manager: Any = None
        self.i18n_instance: Any = None
        self.plugin_manager: Any = None
        # P3-P5 扩展节点
        self.skill_hub: Any = None
        self.skill_audit: Any = None
        self.profile_manager: Any = None
        self.async_delegator: Any = None
        self.memory_providers: Any = None
        self.proxy_server: Any = None
        self.dashboard_auth: Any = None
        self.hot_reloader: Any = None
        self.shutdown_forensics: Any = None
        self.relay_adapter: Any = None
        # P6 扩展节点
        self.batch_trajectory: Any = None
        self.stream_diag: Any = None
        self.nous_rate_guard: Any = None
        self.portal_tags: Any = None
        # P7 扩展节点
        self.message_content: Any = None
        self.retry_utils: Any = None
        self.skill_provenance: Any = None
        self.cli_output: Any = None
        self.markdown_tables: Any = None
        # P8 扩展节点
        self.display_formatter: Any = None
        self.curses_tui: Any = None
        self.pty_bridge: Any = None
        self.shell_completion: Any = None
        self.clipboard: Any = None
        # P9 扩展节点
        self.prompt_caching: Any = None
        self.turn_finalizer: Any = None
        self.turn_retry_state: Any = None
        self.batch_runner: Any = None
        # 子系统注册中心（用于拓扑排序初始化）
        self._registry: SubsystemRegistry | None = None

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
        except Exception:
            pass

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
        if self.hook_manager:
            await self.hook_manager.trigger(ON_SESSION_START, session_id="engine", modules_loaded=True)

    async def initialize(self) -> None:
        import time
        self._start_time = time.time()

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
        except Exception:
            pass

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

        try:
            self.trajectory_db = TrajectoryDatabase()
            log.info("Trajectory Database ready")
        except Exception as e:
            log.warning("Trajectory Database init failed", error=str(e))
            self.trajectory_db = None

        try:
            self.tool_registry = ToolRegistry()
            count = register_default_tools(self.tool_registry)
            log.info("Tool Registry ready", count=count)
        except Exception as e:
            log.warning("Tool Registry init failed", error=str(e))
            self.tool_registry = None

        try:
            self.toolset_registry = ToolsetRegistry(self.tool_registry)
            log.info("Toolset Registry ready")
        except Exception as e:
            log.warning("Toolset Registry init failed", error=str(e))
            self.toolset_registry = None

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

        try:
            self.permission_guard = PermissionGuard()
            log.info("Permission Guard ready")
        except Exception as e:
            log.warning("Permission Guard init failed", error=str(e))
            self.permission_guard = None

        try:
            self.schema_validator = SchemaValidator()
            log.info("Schema Validator ready")
        except Exception as e:
            log.warning("Schema Validator init failed", error=str(e))
            self.schema_validator = None

        try:
            self.tool_call_guard = ToolCallGuard()
            log.info("Tool Call Guard ready")
        except Exception as e:
            log.warning("Tool Call Guard init failed", error=str(e))
            self.tool_call_guard = None

        try:
            # 非交互模式下自动批准所有工具调用（CLI/API/WS 场景无人审批）
            self.approval_manager = ApprovalManager(auto_approve_all=True)
            log.info("Approval Manager ready | mode=auto_approve_all")
        except Exception as e:
            log.warning("Approval Manager init failed", error=str(e))
            self.approval_manager = None

        # 金丝雀发布管理 — 必须在 LoopController 之前初始化，供其注入到 LLMProvider
        try:
            self.canary_manager = CanaryReleaseManager()
            log.info("Canary Release Manager ready")
        except Exception as e:
            log.warning("Canary Release Manager init failed", error=str(e))
            self.canary_manager = None

        # 约束服务 — 必须在 LoopController 之前初始化，供其调用 resolve_adaptive_budget
        try:
            self.constraints = ConstraintsService()
            log.info("Constraints Service ready")
        except Exception as e:
            log.warning("Constraints Service init failed", error=str(e))
            self.constraints = None

        try:
            self.loop = LoopController(
                self.llm,
                trajectory_db=self.trajectory_db,
                tool_registry=self.tool_registry,
                evolution=None,
                memory_engine=self.memory,  # 修复断层 2.1: 传入记忆引擎，启用 Loop 模式下记忆检索
                canary_manager=self.canary_manager,  # 修复断层 1.1: 传入灰度发布管理器
                constraints_service=self.constraints,  # 修复断层 3.3: 传入约束服务，启用自适应预算
            )
            log.info("Loop Controller ready")
        except Exception as e:
            log.warning("Loop Controller init failed", error=str(e))
            self.loop = None

        try:
            self.evolution = EvolutionEngine()
            log.info("Evolution Engine ready")
        except Exception as e:
            log.warning("Evolution Engine init failed", error=str(e))
            self.evolution = None

        if self.loop and self.evolution:
            self.loop.evolution = self.evolution

        # GAP-02: 性能监控 + 自动进化触发
        try:
            self.performance_monitor = PerformanceMonitor()
            log.info("Performance Monitor ready")
        except Exception as e:
            log.warning("Performance Monitor init failed", error=str(e))
            self.performance_monitor = None

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
            )
            log.info("Conversation Loop ready (with safety modules + hooks)")
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

        # 初始化会话回顾和标题生成器
        if self.session_store:
            try:
                from agent.persistence.session_recap import SessionRecapGenerator
                from agent.persistence.title_generator import SessionTitleGenerator
                self.session_recap = SessionRecapGenerator(self.session_store, self.llm)
                self.title_generator = SessionTitleGenerator(self.session_store, self.llm)
                log.info("Session recap & title generator ready")
            except Exception as e:
                log.warning("Session recap/title generator init failed", error=str(e))

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
            self.feedback_loops = FeedbackLoops(
                evolution_engine=self.evolution,
                memory_engine=self.memory,
            )
            log.info("Feedback Loops ready")
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
    ) -> dict[str, Any]:
        import time
        # P3-#3: 请求埋点 — 记录起始时间用于耗时计算
        _req_start = time.time()
        self._session_count += 1
        # 更新活跃会话数 gauge（OTel 启用时由 MetricReader 周期性拉取）
        self._active_sessions += 1
        try:
            set_active_sessions(self._active_sessions)
        except Exception:
            pass

        try:
            if self.hook_manager:
                await self.hook_manager.trigger(BEFORE_LOOP, session_id=session_id, event="before_loop")

            if self.security:
                sec_result = self.security.check_command(message)
                if not sec_result.allowed:
                    return {
                        "content": f"请求被安全策略拦截: {'; '.join(sec_result.blocked_reasons)}",
                        "session_id": session_id,
                        "trace_id": f"blocked_{self._session_count}",
                        "intent": "blocked",
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
                except (OSError, IOError, ValueError, KeyError):
                    pass

            if self.context_reference_resolver:
                try:
                    resolved = self.context_reference_resolver.resolve(message)
                    if resolved.has_references and resolved.resolved_content:
                        context_text += "\n\n" + resolved.resolved_content
                        message = resolved.cleaned_input
                except Exception:
                    pass

            if context_text:
                message = context_text + "\n\n--- 用户输入 ---\n" + message

            should_use_loop = use_loop
            if should_use_loop is None:
                should_use_loop = self._should_use_loop(message)

            # P1-5: 超复杂任务走 MultiAgentOrchestrator 分解
            if should_use_loop and self._multi_agent_orchestrator and self.loop:
                complexity = self._multi_agent_orchestrator._complexity_analyzer.analyze(message)
                if complexity.complexity == "very_complex" and complexity.recommended_agents > 1:
                    orch_result = await self._multi_agent_orchestrator.process_goal_with_loop(
                        goal=message,
                        context={},
                        loop_controller=self.loop,
                    )
                    result = {
                        "content": orch_result.summary,
                        "session_id": session_id,
                        "trace_id": f"orch_{self._session_count}",
                        "intent": "multi_agent_orchestration",
                        "quality_score": orch_result.quality_score,
                        "tool_activities": [
                            {"name": sr.agent_name, "success": sr.success, "error": sr.error}
                            for sr in orch_result.sub_results
                        ],
                    }
                else:
                    result = await self._process_with_loop(message, session_id, user_id=user_id, strategy_name=strategy_name)
            elif should_use_loop and self.loop:
                result = await self._process_with_loop(message, session_id, user_id=user_id, strategy_name=strategy_name)
            elif self.conversation:
                result = await self._process_with_conversation(message, session_id, use_tools, trace_id=trace_id)
            else:
                result = await self._process_simple(message, session_id)

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
                except Exception:
                    pass

            if self.hook_manager:
                await self.hook_manager.trigger(
                    AFTER_LOOP,
                    event="after_loop",
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
                except Exception:
                    pass

            return result
        except Exception as exc:
            # P3-#3: 错误埋点 — 记录异常类型与请求耗时
            if self.production_metrics:
                try:
                    _duration_ms = (time.time() - _req_start) * 1000
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
                except Exception:
                    pass
            raise
        finally:
            # 会话结束：递减活跃会话数并更新 gauge
            self._active_sessions = max(0, self._active_sessions - 1)
            try:
                set_active_sessions(self._active_sessions)
            except Exception:
                pass

    def _should_use_loop(self, message: str) -> bool:
        complex_indicators = [
            "分析", "对比", "设计", "实现", "优化", "重构",
            "迁移", "集成", "部署", "步骤", "流程", "方案",
            "搜索", "查找", "读取", "修改", "执行", "运行",
        ]
        score = sum(1 for kw in complex_indicators if kw in message)
        return score >= 2

    async def _process_simple(
        self,
        message: str,
        session_id: str = "default",
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
            except Exception:
                pass

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
        result = await self.llm.chat(messages=messages)
        response_content = result.get("content", "")

        if self.memory:
            try:
                await self.memory.store_instant(message, scene="chat")
                await self.memory.store_short_term(response_content, scene="chat_response")
                await self._auto_reflect(message, response_content, session_id)
            except Exception:
                pass

        if self.evolution:
            try:
                from agent.evolution.types import FeedbackSignal
                import time
                await self.evolution.collect_feedback(FeedbackSignal(
                    interaction_id=f"py_{self._session_count}",
                    quality_score=0.8,
                    cause="chat",
                    timestamp=time.time(),
                    scene="chat",
                    response_length=len(response_content),
                ))
            except Exception:
                pass

        # GAP-09: 学习信号（simple 路径）
        if self.learning_signals:
            try:
                self.learning_signals.record_signal(
                    signal_type="task_success",
                    value=0.8,
                    source="simple",
                    context={"session_id": session_id},
                )
            except Exception:
                pass

        # GAP-06: 策略自适应（simple 路径）
        if self.strategy_adapter:
            try:
                self.strategy_adapter.record_outcome("chat", "simple", success=True)
            except Exception:
                pass

        # GAP-02: 性能监控（simple 路径）
        if self.performance_monitor:
            try:
                self.performance_monitor.record_metric("task_completion", success=True, duration=0.0)
            except Exception:
                pass

        return {
            "content": response_content,
            "session_id": session_id,
            "trace_id": trace_id or f"py_{self._session_count}_{id(self):x}",
            "intent": "",
            "related_files": [],
            "tool_activities": [],
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
            except Exception:
                pass

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
            except Exception:
                pass

        if self.session_store:
            try:
                msgs = self.session_store.get_messages(session_id, limit=10)
                history = [{"role": m.role, "content": m.content} for m in msgs]
            except Exception:
                pass

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
            except Exception:
                pass

            try:
                guardrail_result = self.verification.check_guardrails(output_content)
                if not guardrail_result.passed:
                    output_content = "抱歉，无法提供该内容（安全检查未通过）"
            except Exception:
                pass

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
            except Exception:
                pass

        quality_score = 0.7 if conv_result.finish_reason == "stop" else 0.4
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
            except Exception:
                pass

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
            except Exception:
                pass

        # GAP-06: 策略自适应 — 根据结果调整策略
        if self.strategy_adapter:
            try:
                scene = ContextManager.infer_scene(message) if self.context_manager else "daily"
                success = quality_score >= 0.6
                self.strategy_adapter.record_outcome(scene, "conversation", success=success)
            except Exception:
                pass

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
                    except Exception:
                        pass
            except Exception:
                pass

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
            except Exception:
                pass

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
            except Exception:
                pass

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
            except Exception:
                pass

        if self.memory:
            try:
                await self.memory.store_instant(message, scene="conversation")
                await self.memory.store_short_term(conv_result.content, scene="conversation_response")
                tool_names = [tc.get("name", "") for tc in conv_result.metadata.get("tool_calls", [])]
                if tool_names:
                    await self.memory.store_episodic(
                        event=f"用户请求: {message[:100]}",
                        participants=tool_names,
                        outcome="成功" if conv_result.finish_reason == "stop" else "部分完成",
                        emotion="positive" if quality_score >= 0.6 else "neutral",
                    )
                await self._auto_reflect(message, conv_result.content, session_id, quality_score, tool_names)
            except Exception:
                pass

        if self.session_store:
            try:
                self.session_store.add_message(session_id, "user", message)
                self.session_store.add_message(session_id, "assistant", conv_result.content)
            except Exception:
                pass

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
                    response_length=len(conv_result.content),
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
                        except Exception:
                            pass

                if quality_score >= 0.7 and tool_names:
                    try:
                        skill_name = self.evolution.generate_skill({
                            "input": message,
                            "response": conv_result.content,
                            "tools_used": tool_names,
                            "quality_score": quality_score,
                            "scene": scene,
                        })
                        if skill_name:
                            log.info("Skill auto-generated", skill_name=skill_name)
                    except Exception:
                        pass
            except Exception:
                pass

        if self.trajectory_db:
            try:
                import time as _t
                self.trajectory_db.record_execution(ExecutionRecord(
                    id=conv_result.trace_id,
                    input=message[:500],
                    response=conv_result.content[:500],
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
            except Exception:
                pass

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
        if self.session_store:
            try:
                msgs = self.session_store.get_messages(session_id, limit=10)
                history = [{"role": m.role, "content": m.content} for m in msgs]
            except Exception:
                pass

        # 合并历史到 messages（系统消息 + 历史 + 用户消息由 loop 内部追加）
        all_messages = system_messages + history if history else system_messages

        result = await self.loop.run(
            input_text=message,
            messages=all_messages or None,
            session_id=session_id,
            cancel_event=cancel_token,
            user_id=user_id,
            strategy_name=strategy_name,
        )

        output_content = result.response

        if self.verification:
            try:
                safety = self.verification.check_output_safety(output_content)
                if not safety.safe:
                    output_content = safety.sanitized_output or output_content
            except Exception:
                pass

            try:
                guardrail_result = self.verification.check_guardrails(output_content)
                if not guardrail_result.passed:
                    output_content = "抱歉，无法提供该内容（安全检查未通过）"
            except Exception:
                pass

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
            except Exception:
                pass

        quality_score = result.quality_score

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
            except Exception:
                pass

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
            except Exception:
                pass

        # GAP-09: 多维度学习信号采集（loop 路径）
        if self.learning_signals:
            try:
                self.learning_signals.record_signal(
                    signal_type="task_success" if quality_score >= 0.6 else "task_partial",
                    value=quality_score,
                    source="loop",
                    context={"session_id": session_id},
                )
            except Exception:
                pass

        # GAP-06: 策略自适应（loop 路径）
        if self.strategy_adapter:
            try:
                scene = ContextManager.infer_scene(message) if self.context_manager else "daily"
                success = quality_score >= 0.6
                self.strategy_adapter.record_outcome(scene, "loop", success=success)
            except Exception:
                pass

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
                    except Exception:
                        pass
            except Exception:
                pass

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
            except Exception:
                pass

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
            except Exception:
                pass

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
            except Exception:
                pass

        if self.memory:
            try:
                await self.memory.store_instant(message, scene="loop_chat")
                await self.memory.store_short_term(result.response, scene="loop_response")
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
                await self._auto_reflect(message, result.response, session_id, quality_score, tool_names)
            except Exception:
                pass

        if self.session_store:
            try:
                self.session_store.add_message(session_id, "user", message)
                self.session_store.add_message(session_id, "assistant", result.response)
            except Exception:
                pass

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
                    response_length=len(result.response),
                    rounds_used=result.metadata.get("rounds_used", 1),
                ))
                plan = await self.evolution.should_evolve()
                if plan:
                    log.info("Evolution triggered (loop)", plan_type=plan.evolution_type, priority=plan.priority)
                    await self.evolution.execute_evolution(plan)
            except Exception:
                pass

        if self.trajectory_db:
            try:
                import time as _t
                self.trajectory_db.record_execution(ExecutionRecord(
                    id=result.trace_id,
                    input=message[:500],
                    response=result.response[:500],
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
            except Exception:
                pass

        return {
            "content": output_content,
            "session_id": result.session_id,
            "trace_id": result.trace_id,
            "intent": "",
            "related_files": [],
            "tool_activities": result.metadata.get("tool_calls", []),
            "quality_score": quality_score,
            "steps_completed": result.steps_completed,
            "steps_total": result.steps_total,
            "loop_metadata": result.metadata,
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
                    except Exception:
                        pass
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
                    except Exception:
                        pass
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
                    except Exception:
                        pass
        except Exception:
            pass

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
            yield {"type": "done", "trace_id": "", "content": "任务已取消"}
            return

        # 立即发送 thinking 事件 — 首字反馈，让用户知道系统已开始处理
        yield {"type": "thinking", "content": "正在理解您的请求..."}

        # 2. 加载会话历史
        history: list[dict[str, str]] = []
        if self.session_store:
            try:
                msgs = self.session_store.get_messages(session_id, limit=10)
                history = [{"role": m.role, "content": m.content} for m in msgs]
            except Exception:
                pass

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
                    # 检查取消
                    if cancel_token and cancel_token.is_set():
                        yield {"type": "done", "trace_id": "", "content": "任务已取消"}
                        return

                    # 累积 token 内容用于持久化
                    if event.get("type") == "token" and event.get("content"):
                        response_buffer.append(event["content"])
                    elif event.get("type") == "done" and event.get("content"):
                        if not response_buffer:
                            response_buffer.append(event["content"])

                    # 透传事件
                    yield event

                # 5. 持久化会话历史 — 保存用户消息和助手回复
                if self.session_store:
                    try:
                        assistant_response = "".join(response_buffer).strip()
                        self.session_store.add_message(session_id, "user", message)
                        if assistant_response:
                            self.session_store.add_message(session_id, "assistant", assistant_response)
                    except Exception as e:
                        log.warning("Failed to persist stream session history", error=str(e))
                return
            except _asyncio.CancelledError:
                yield {"type": "done", "trace_id": "", "content": "任务已取消"}
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
            async for chunk in self.llm.chat_stream(messages=messages):
                if cancel_token and cancel_token.is_set():
                    yield {"type": "done", "trace_id": "", "content": "任务已取消"}
                    return
                chunk_str = chunk if isinstance(chunk, str) else str(chunk)
                response_buffer.append(chunk_str)
                yield {"type": "token", "content": chunk_str}
        except Exception as e:
            yield {"type": "error", "content": str(e)}

        # 降级路径也持久化会话历史
        if self.session_store:
            try:
                assistant_response = "".join(response_buffer).strip()
                self.session_store.add_message(session_id, "user", message)
                if assistant_response:
                    self.session_store.add_message(session_id, "assistant", assistant_response)
            except Exception as e:
                log.warning("Failed to persist fallback stream history", error=str(e))

        yield {"type": "done", "trace_id": ""}

    # ─────────────────────────────────────────────────────────────
    # 子系统初始化方法（对应 SUBSYSTEM_DEPS 的 factory 字段）
    # 每个方法必须是 async def 且无参数，依赖通过 self 访问
    # ─────────────────────────────────────────────────────────────

    async def _init_llm(self) -> LLMProvider:
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
            log.info("Tool Registry ready", count=count)
            return self.tool_registry
        except Exception as e:
            log.warning("Tool Registry init failed", error=str(e))
            return None

    async def _init_toolset_registry(self) -> ToolsetRegistry | None:
        try:
            self.toolset_registry = ToolsetRegistry(self.tool_registry)
            log.info("Toolset Registry ready")
            return self.toolset_registry
        except Exception as e:
            log.warning("Toolset Registry init failed", error=str(e))
            return None

    async def _init_mcp_tool_bridge(self) -> MCPToolBridge | None:
        try:
            from agent.mcp.server_manager import MCPServerManager
            mcp_manager = MCPServerManager.get_instance()
            self.mcp_tool_bridge = MCPToolBridge(provider=mcp_manager)
            if self.tool_registry is not None:
                synced = await self.mcp_tool_bridge.sync_to_registry(self.tool_registry)
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
            self.approval_manager = ApprovalManager(auto_approve_all=True)
            log.info("Approval Manager ready | mode=auto_approve_all")
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
            self.loop = LoopController(
                self.llm,
                trajectory_db=self.trajectory_db,
                tool_registry=self.tool_registry,
                evolution=None,
                memory_engine=self.memory,
                canary_manager=self.canary_manager,
                constraints_service=self.constraints,
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
            )
            log.info("Conversation Loop ready (with safety modules + hooks)")
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
            self.skill_registry.register_builtin_skills()
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

    async def _init_write_approval(self) -> Any:
        """初始化写入审批管理器。"""
        try:
            from agent.tools.write_approval_tool import WriteApprovalManager
            self.write_approval_manager = WriteApprovalManager()
            log.info("Write Approval Manager ready")
            return self.write_approval_manager
        except Exception as e:
            log.warning("Write Approval Manager init failed", error=str(e))
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

    async def _init_tool_result_cache(self) -> Any:
        """初始化工具结果缓存。"""
        try:
            from agent.tools.tool_result_cache import ToolResultCache
            self.tool_result_cache = ToolResultCache()
            log.info("Tool Result Cache ready")
            return self.tool_result_cache
        except Exception as e:
            log.warning("Tool Result Cache init failed", error=str(e))
            return None

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
            self.plugin_manager = PluginManager()
            log.info("Plugin Manager ready")
            return self.plugin_manager
        except Exception as e:
            log.warning("Plugin Manager init failed", error=str(e))
            return None

    # ── P3-P5 扩展节点初始化 ──

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
            from agent.llm.prompt_caching import PromptCaching
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

    @property
    def uptime(self) -> float:
        if not self._start_time:
            return 0.0
        import time
        return time.time() - self._start_time
