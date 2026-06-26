from __future__ import annotations

import os
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.think_scrubber import ThinkScrubber
from agent.llm.provider import LLMProvider
from agent.loop.reflection import (
    ReflectionResult,
    TaskReflectionInput,
)
from agent.loop.controller import LoopController
from agent.memory.engine import MemoryEngine
from agent.evolution.engine import EvolutionEngine
from agent.core.conversation_loop import ConversationLoop
from agent.core.context_pipeline import (
    ContextManager,
    ContextFileRegistry,
    ContextReferenceResolver,
)
from agent.core.context_compressor import ContextCompressor, ContextWindowManager
from agent.core.persona import PersonaCore
from agent.context import UnifiedContextOrchestrator, ContextBuildRequest
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
from agent.orchestration.agent_factory import (
    AgentFactory,
    AgentRegistry,
    OrchestratorAgent,
    AgentScene,
    AgentConfig,
    MultiAgentOrchestrator,
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
        self._start_time: float = 0.0
        self._session_count: int = 0

    async def initialize(self) -> None:
        import time
        self._start_time = time.time()
        available = await self.llm.check_available()
        status = "available" if available else "unavailable"
        log.info("LLM Provider initialized", model=self.llm.model, status=status)

        try:
            self.memory = MemoryEngine(llm=self.llm)
            await self.memory.initialize()
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
            self.mcp_tool_bridge = MCPToolBridge(self.tool_registry)
            log.info("MCP Tool Bridge ready")
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
            self.approval_manager = ApprovalManager()
            log.info("Approval Manager ready")
        except Exception as e:
            log.warning("Approval Manager init failed", error=str(e))
            self.approval_manager = None

        try:
            self.loop = LoopController(
                self.llm,
                trajectory_db=self.trajectory_db,
                tool_registry=self.tool_registry,
                evolution=None,
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
            self.constraints = ConstraintsService()
            log.info("Constraints Service ready")
        except Exception as e:
            log.warning("Constraints Service init failed", error=str(e))

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
            )
            log.info("Agent Registry + Orchestrator ready", agent_count=self.agent_registry.get_agent_count())
        except Exception as e:
            log.warning("Agent Registry + Orchestrator init failed", error=str(e))
            self.agent_registry = None
            self.orchestrator = None

        self._multi_agent_orchestrator: MultiAgentOrchestrator | None = None

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
    ) -> dict[str, Any]:
        import time
        self._session_count += 1

        if self.hook_manager:
            await self.hook_manager.trigger(BEFORE_LOOP, event="before_loop", session_id=session_id)

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
            except Exception:
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
                result = await self._process_with_loop(message, session_id)
        elif should_use_loop and self.loop:
            result = await self._process_with_loop(message, session_id)
        elif self.conversation:
            result = await self._process_with_conversation(message, session_id, use_tools)
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

        return result

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

        return {
            "content": response_content,
            "session_id": session_id,
            "trace_id": f"py_{self._session_count}_{id(self):x}",
            "intent": "",
            "related_files": [],
            "tool_activities": [],
        }

    async def _process_with_conversation(
        self,
        message: str,
        session_id: str = "default",
        use_tools: bool = True,
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
            "trace_id": conv_result.trace_id,
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

        result = await self.loop.run(
            input_text=message,
            messages=system_messages or None,
            session_id=session_id,
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
    ):
        messages = [
            {
                "role": "system",
                "content": (
                    "你是家百星（Jiabaixing），一个智能AI助手。"
                    "你善于理解中文，能够帮助用户完成各种任务。"
                    "请用简洁、友好的方式回答问题。"
                ),
            },
            {"role": "user", "content": message},
        ]
        async for chunk in self.llm.chat_stream(messages=messages):
            yield chunk

    @property
    def uptime(self) -> float:
        if not self._start_time:
            return 0.0
        import time
        return time.time() - self._start_time
