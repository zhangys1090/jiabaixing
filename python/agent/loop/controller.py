from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any, Awaitable, Callable

from agent.llm.provider import LLMProvider
from agent.loop.causal import CausalModeler, CausalGraph, DependencyAnalysis, FailureImpact
from agent.loop.attention import AttentionFocusManager
from agent.loop.evaluator import Evaluator
from agent.loop.executor import Executor
from agent.loop.observer import LoopObserver, LoopPhase
from agent.loop.planner import Planner
from agent.loop.plan_scheduler import PlanScheduler, PlanSchedulerConfig
from agent.loop.meta_decision_engine import MetaDecisionEngine, DecisionStrategy, DecisionContext
from agent.loop.reasoning_chain import ReasoningChainEngine, ReasoningDepth
from agent.loop.debate_harness import DebateHarness, DebateVerdict
from agent.loop.adaptive_degradation import AdaptiveDegradation
from agent.loop.decision_trace import DecisionTracer, DecisionType
from agent.loop.semantic_verifier import SemanticVerifier, VerificationLevel
from agent.loop.structured_report import StructuredReportGenerator
from agent.loop.interaction_checkpoint import InteractionCheckpoint
from agent.perception.perception_driven_planner import PerceptionDrivenPlanner
from agent.loop.intent_tracker import IntentTracker, IntentType
from agent.loop.adaptive_strategy import AdaptiveStrategyEngine
from agent.loop.quality_scorer import BuiltInQualityScorer
from agent.loop.reflection import (
    DeepReflectionResult,
    ExperienceEntry,
    ReflectionEngine,
    ReflectionResult,
    TaskReflectionInput,
)
from agent.loop.reflection_application import ReflectionApplicationManager
from agent.loop.reflection_knowledge_base import ReflectionKnowledgeBase
from agent.loop.reporter import Reporter
from agent.loop.types import (
    AgentResult,
    BudgetState,
    ExecutionPlan,
    EvaluatorOutput,
    ExecutorOutput,
    HookContext,
    LifecycleHook,
    LoopContext,
    LoopState,
    PlanStep,
    ReActActionResult,
    ReActThought,
    ReporterOutput,
    StepResult,
    StructuredReActStep,
)
from agent.evolution.implicit_feedback import (
    ImplicitFeedbackCollector,
    FeedbackType,
    FeedbackStrength,
    FeedbackSource,
)
from agent.persistence.trajectory import (
    ExecutionEstimate,
    ExecutionRecord,
    ToolInvocationRecord,
    StateTransitionRecord,
    TrajectoryDatabase,
)
from agent.constraints.service import AdaptiveBudgetConfig, ConstraintsService
from agent.loop.middleware import (
    MiddlewarePipeline,
    KnowledgeInjectMiddleware,
    PerceptionInjectMiddleware,
    WorkflowInjectMiddleware,
    McpResourceInjectMiddleware,
    SandboxAuditMiddleware,
)
from agent.tools.registry import ToolRegistry
from agent.perception.bus import PerceptionBus, PerceptionLevel, PerceptionState
from agent.core.canary_release import CanaryReleaseManager
from agent.core.otel_tracer import otel_trace, get_tracer
from agent.core.otel_metrics import loop_iterations_counter, loop_duration_histogram
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.loop.debater import DefaultDebater, DebaterOutput
from agent.loop.plan_quality_checker import PlanQualityChecker
from agent.loop.feedback_loops import FeedbackLoops
log = StructuredLogger("controller")

# 模块级日志器：供 replan / A2A fallback / meta reflection 等所有代码路径使用


class InferenceCacheEntry:
    """P2-7: 推理缓存条目 — 存储推理路径的输入摘要与输出结果。

    当遇到相似推理路径时，直接复用缓存结果，避免重复 LLM 调用。

    Attributes:
        key: 推理路径的哈希键（基于输入摘要 + 工具序列）.
        input_digest: 输入摘要（任务描述 + 上下文关键词）.
        tool_sequence: 使用的工具调用序列.
        result: 推理结果.
        quality: 结果质量评分.
        created_at: 创建时间.
        hit_count: 缓存命中次数.
    """

    __slots__ = (
        "key", "input_digest", "tool_sequence",
        "result", "quality", "created_at", "hit_count",
    )

    def __init__(
        self,
        key: str,
        input_digest: str,
        tool_sequence: list[str],
        result: Any,
        quality: float = 0.0,
    ) -> None:
        self.key = key
        self.input_digest = input_digest
        self.tool_sequence = tool_sequence
        self.result = result
        self.quality = quality
        self.created_at = time.time()
        self.hit_count = 0


class LoopController:
    MAX_REPLAN_COUNT = 3
    MAX_CONTINUE_STREAK = 3  # 连续 continue 且无进度提升时强制升级为重规划（审计 L-05）

    def __init__(
        self,
        llm: LLMProvider,
        trajectory_db: TrajectoryDatabase | None = None,
        tool_registry: ToolRegistry | None = None,
        evolution: Any | None = None,
        reflection_kb: ReflectionKnowledgeBase | None = None,
        memory_engine: Any | None = None,
        canary_manager: CanaryReleaseManager | None = None,
        constraints_service: ConstraintsService | None = None,
        feedback_loops: FeedbackLoops | None = None,
        knowledge_lifecycle: Any | None = None,
        perception_loop: Any | None = None,
        workflow_engine: Any | None = None,
        risk_precheck: Any | None = None,
        failure_learner: Any | None = None,
        perception_bus: PerceptionBus | None = None,
        schema_validator: Any | None = None,
        tool_call_guard: Any | None = None,
        proactive_engine: Any | None = None,
    ) -> None:
        self.llm = llm
        # 灰度发布：注入到 LLMProvider，供 chat/chat_stream 在调用前选择版本
        if canary_manager is not None:
            self.llm.canary_manager = canary_manager
        self.planner = Planner(llm, tool_registry=tool_registry)
        if memory_engine:
            self.planner.set_memory_engine(memory_engine)
        self._plan_scheduler = PlanScheduler(
            llm=llm,
            tool_registry=tool_registry,
            memory_engine=memory_engine,
            config=PlanSchedulerConfig(),
        )
        self.reflection = ReflectionEngine(llm, knowledge_base=reflection_kb)
        # C1: 将 engine 注入的共享防护实例（Schema 校验 / 调用守卫）透传给 Executor，
        # 使 LoopController 执行路径与主聊天路径 conversation_loop 共用同一套防护与去重/限速状态。
        self._schema_validator = schema_validator
        self._tool_call_guard = tool_call_guard
        self.executor = Executor(
            llm,
            tool_registry=tool_registry,
            reflection=self.reflection,
            schema_validator=schema_validator,
            tool_call_guard=tool_call_guard,
        )
        self.evaluator = Evaluator(llm)
        self.reporter = Reporter()
        self._causal: CausalModeler | None = None
        self.trajectory_db = trajectory_db
        self.tool_registry = tool_registry
        self.evolution = evolution
        # P0-修复3: 进化闭环实例 — 由 engine.py 在 EvolutionClosedLoop 创建后注入。
        # ingest_structured_report 位于此类而非 EvolutionEngine。
        self.evolution_closed_loop: Any | None = None
        # P1-修复5: MCTS 规划器懒加载实例 — 辩论 ESCALATE 时启用蒙特卡洛搜索替代。
        self._mcts_planner: Any | None = None
        # 时间预算预估：注入 ConstraintsService，供 _resolve_budget_max_duration 调用
        # resolve_adaptive_budget 实现历史预估 → 静态配置的降级策略
        self.constraints_service: ConstraintsService | None = constraints_service
        self.state: LoopState = LoopState.IDLE
        self._last_reflection_insight: dict[str, Any] | None = None
        self._hooks: dict[LifecycleHook, list[Any]] = {
            hook: [] for hook in LifecycleHook
        }

        # 循环观察者（可观测性）
        self._observer = LoopObserver.get_instance()
        # 隐式反馈收集器
        self._feedback_collector = ImplicitFeedbackCollector.get_instance()

        # 模块级日志器（无条件初始化，避免取消任务等路径触发 AttributeError）
        self._logger: StructuredLogger = log

        # 反思应用管理器（可选）
        self._reflection_app: ReflectionApplicationManager | None = None
        self._reflection_app_enabled = os.environ.get("REFLECTION_APPLICATION_ENABLED", "true").lower() == "true"
        if self._reflection_app_enabled:
            try:
                self._reflection_app = ReflectionApplicationManager(kb=reflection_kb)
                self._logger.info("Reflection application manager enabled")
            except Exception as e:
                self._logger.warning("Failed to init reflection application manager", error=str(e))
                self._reflection_app = None

        # 注意力聚焦管理器
        self._attention_focus = AttentionFocusManager(
            max_messages=int(os.environ.get("ATTENTION_MAX_MESSAGES", "15")),
            max_total_tokens=int(os.environ.get("ATTENTION_MAX_TOKENS", "4000")),
        )

        # P2-1: 内置质量评分器
        self._quality_scorer = BuiltInQualityScorer(
            max_expected_rounds=int(os.environ.get("QUALITY_MAX_ROUNDS", "5")),
            max_expected_steps_per_round=int(os.environ.get("QUALITY_MAX_STEPS", "8")),
        )

        # P0 接入：辩论式计划审查器（延迟初始化，首次使用时创建）
        self._debater_enabled = os.environ.get("DEBATER_ENABLED", "true").lower() == "true"
        self._debater: DefaultDebater | None = None

        # F3: 计划质量检查器 — 规划后验证计划完整性和风险
        self._plan_quality_checker = PlanQualityChecker()

        # F4: 闭环反馈服务 — 进化/工具失败/偏好学习/知识提取四大闭环
        self._feedback_loops = feedback_loops

        # P1-2: 知识生命周期 — 上下文注入 + 对话后自动提取
        self._knowledge_lifecycle = knowledge_lifecycle

        # P1-1: 感知闭环 — 桌面操作自动验证 + 屏幕变化监听
        self._perception_loop = perception_loop
        if perception_loop is not None:
            self.executor.set_perception_loop(perception_loop)

        # W3-3: 预测验证循环 — 执行前预测、执行后验证、偏差调整
        from agent.loop.prediction_verification import PredictionVerificationLoop
        self._prediction_loop = PredictionVerificationLoop(
            trajectory_db=self.trajectory_db,
        )
        self.executor.set_prediction_loop(self._prediction_loop)

        # W3-4: 自主触发增强 — 基于学习结果和环境变化主动行动
        self._proactive_engine = proactive_engine

        # P0-2: ReAct 循环重规划计数器
        self._replan_count: int = 0
        self._meta_reflect_counter: int = 0

        # P0-2: 工作流引擎 — 主循环感知工作流状态
        self._workflow_engine = workflow_engine

        # Phase 3+4: 沙箱审计子代理 — 周期性检测隔离完整性
        from agent.sandbox.sandbox_audit_agent import SandboxAuditAgent
        self._sandbox_audit_agent = SandboxAuditAgent(
            check_interval_sec=float(os.environ.get("SANDBOX_AUDIT_INTERVAL", "120")),
        )

        # 安全沙箱：高风险动作预检 + 人工审批联动（注入执行器）
        self._risk_precheck = risk_precheck
        if risk_precheck is not None:
            self.executor.set_risk_precheck(risk_precheck)

        # 知识沉淀：主动从失败学习闭环
        self._failure_learner = failure_learner

        # 五感感知总线 — 统一调度情绪/场景/环境/视觉/听觉五通道
        self._perception_bus = perception_bus
        if self._perception_bus is None:
            try:
                self._perception_bus = PerceptionBus(
                    tool_registry=tool_registry,
                    llm=llm,
                    level=PerceptionLevel(
                        os.environ.get("PERCEPTION_LEVEL", "standard")
                    ),
                )
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.__init__.perception_bus", _exc)
                self._perception_bus = None
        elif tool_registry and not self._perception_bus._tool_registry:
            self._perception_bus.set_tool_registry(tool_registry)
        elif llm and not self._perception_bus._llm:
            self._perception_bus.set_llm(llm)

        if self._perception_bus is not None and self.trajectory_db:
            self._perception_bus.set_trajectory_db(self.trajectory_db)

        # P1-3: MCP 资源变更事件缓冲（由 engine.py 注入回调填充）
        self._mcp_resource_events: list[Any] = []

        # F6: DAG 任务调度器（延迟注入，由 engine.py 在初始化后设置）
        self._orchestration_executor: Any | None = None

        # F7: 上下文窗口管理器（延迟注入，由 engine.py 在初始化后设置）
        self._context_window_manager: Any | None = None

        # Phase 3: 元决策引擎 — 决策策略自适应选择 + 决策经验持久化
        self._meta_decision = MetaDecisionEngine()

        # Phase 3: 推理链引擎 — 动态推理深度 + 推理链验证
        self._reasoning_chain_engine = ReasoningChainEngine(llm=llm)

        # Phase 3+4: 辩论驱动六层 Harness — 安全/辩论/因果/反思/进化/元决策六层审查
        self._debate_harness = DebateHarness(
            debater=None,
            meta_decision=self._meta_decision,
            causal_modeler=None,
            reflection_engine=self.reflection,
            evolution_closed_loop=None,
            risk_precheck=risk_precheck,
        )

        # Phase 3+4: 动态降级策略 — 基于历史成功率的自适应工具降级
        self._adaptive_degradation = AdaptiveDegradation(trajectory_db=trajectory_db)

        # Phase 3+4: 决策可解释性 — 决策链追踪与可解释输出
        self._decision_tracer = DecisionTracer()

        # Phase 3+4: 语义验证增强 — 即使轻量模式也执行最小语义验证
        self._semantic_verifier = SemanticVerifier(llm=llm)

        # Phase 3+4: 结构化执行报告 — 每轮循环输出 JSON 报告
        self._structured_reporter = StructuredReportGenerator()

        # Phase 3+4: 交互中断与恢复 — 用户中断后从最近检查点恢复
        self._checkpoint_mgr = InteractionCheckpoint()

        # Phase 3+4: 感知驱动规划增强 — 将感知状态深度融入规划决策
        self._perception_driven_planner = PerceptionDrivenPlanner()

        # Phase 3+4: 用户意图追踪 — 实时追踪用户意图变化和漂移检测
        self._intent_tracker = IntentTracker()

        # Phase 3+4: 自适应执行策略引擎 — 统一调度感知驱动/降级/意图追踪策略
        self._adaptive_strategy = AdaptiveStrategyEngine()

        # P2-7: 推理缓存 — 相似推理路径结果复用
        self._inference_cache: dict[str, InferenceCacheEntry] = {}
        self._inference_cache_max = int(os.environ.get("INFERENCE_CACHE_MAX", "200"))
        self._inference_cache_enabled = os.environ.get("INFERENCE_CACHE_ENABLED", "true").lower() == "true"

        # V6.0: 中间件管道 — 将上下文注入逻辑统一为可插拔中间件
        self._middleware_pipeline = MiddlewarePipeline()
        self._middleware_pipeline.use(KnowledgeInjectMiddleware(self._knowledge_lifecycle))
        self._middleware_pipeline.use(PerceptionInjectMiddleware(self._perception_loop))
        self._middleware_pipeline.use(WorkflowInjectMiddleware(self._workflow_engine))
        self._middleware_pipeline.use(McpResourceInjectMiddleware(self._mcp_resource_events))
        # Phase 3+4: 沙箱审计中间件 — 将沙箱健康状态和指标注入主循环上下文
        self._middleware_pipeline.use(SandboxAuditMiddleware(
            enabled=os.environ.get("SANDBOX_AUDIT_MIDDLEWARE_ENABLED", "true").lower() == "true",
        ))

        # 检查环境变量启用状态
        if os.environ.get("LOOP_OBSERVER_ENABLED", "").lower() == "true":
            self._observer.enable(
                verbose=os.environ.get("LOOP_OBSERVER_VERBOSE", "").lower() == "true"
            )
        if os.environ.get("IMPLICIT_FEEDBACK_ENABLED", "true").lower() == "false":
            self._feedback_collector.set_enabled(False)

    def _compute_inference_cache_key(
        self,
        input_text: str,
        tool_sequence: list[str] | None = None,
    ) -> str:
        """P2-7: 计算推理缓存键 — 基于输入摘要和工具序列的哈希。"""
        import hashlib
        digest = hashlib.sha256(input_text.encode("utf-8")).hexdigest()[:16]
        if tool_sequence:
            tool_sig = "|".join(tool_sequence)
            digest += hashlib.sha256(tool_sig.encode("utf-8")).hexdigest()[:8]
        return digest

    def _lookup_inference_cache(
        self,
        input_text: str,
        tool_sequence: list[str] | None = None,
        quality_threshold: float = 0.7,
    ) -> Any | None:
        """P2-7: 查找推理缓存 — 当相似路径有高质量结果时直接复用。

        Args:
            input_text: 输入文本.
            tool_sequence: 工具调用序列.
            quality_threshold: 最低质量阈值.

        Returns:
            缓存的推理结果，未命中返回 None.
        """
        if not self._inference_cache_enabled:
            return None

        key = self._compute_inference_cache_key(input_text, tool_sequence)
        entry = self._inference_cache.get(key)
        if entry is None:
            return None

        if entry.quality < quality_threshold:
            return None

        entry.hit_count += 1
        self._logger.info(
            "P2-7: 推理缓存命中",
            key=key,
            quality=entry.quality,
            hits=entry.hit_count,
        )
        return entry.result

    def _store_inference_cache(
        self,
        input_text: str,
        tool_sequence: list[str] | None,
        result: Any,
        quality: float = 0.0,
    ) -> None:
        """P2-7: 存储推理结果到缓存。

        仅缓存质量高于阈值的推理结果，低质量结果不缓存。
        缓存满时按 LRU 淘汰（移除 hit_count 最低的条目）。
        """
        if not self._inference_cache_enabled:
            return

        if quality < 0.5:
            return

        key = self._compute_inference_cache_key(input_text, tool_sequence)

        if len(self._inference_cache) >= self._inference_cache_max:
            min_key = min(
                self._inference_cache,
                key=lambda k: self._inference_cache[k].hit_count,
            )
            del self._inference_cache[min_key]

        self._inference_cache[key] = InferenceCacheEntry(
            key=key,
            input_digest=input_text[:200],
            tool_sequence=tool_sequence or [],
            result=result,
            quality=quality,
        )
        self._logger.info(
            "P2-7: 推理结果已缓存",
            key=key,
            quality=quality,
            cache_size=len(self._inference_cache),
        )

    def get_inference_cache_stats(self) -> dict[str, Any]:
        """P2-7: 获取推理缓存统计信息（用于监控/诊断）。"""
        entries = list(self._inference_cache.values())
        return {
            "size": len(entries),
            "max_size": self._inference_cache_max,
            "enabled": self._inference_cache_enabled,
            "total_hits": sum(e.hit_count for e in entries),
            "avg_quality": sum(e.quality for e in entries) / len(entries) if entries else 0.0,
        }

    def register_hook(self, hook: LifecycleHook, callback: Any) -> None:
        self._hooks[hook].append(callback)

    async def _fire_hook(self, hook: LifecycleHook, context: LoopContext, data: dict[str, Any] | None = None) -> None:
        callbacks = self._hooks.get(hook, [])
        if not callbacks:
            return
        hook_ctx = HookContext(hook=hook, loop_context=context, data=data or {})
        for cb in callbacks:
            try:
                result = cb(hook_ctx)
                if result is not None and hasattr(result, "__await__"):
                    await result
            except Exception as e:
                log.debug("controller 异常处理", error=str(e))
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").warning("Hook error", hook=hook.value, error=str(e))

    @otel_trace("loop.execute")
    async def run(
        self,
        input_text: str,
        messages: list[dict[str, str]] | None = None,
        session_id: str = "default",
        react_mode: bool | None = None,
        cancel_event: "asyncio.Event | None" = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
    ) -> AgentResult:
        # P1-3: 自动选择执行模式 — 简单任务用 ReAct，复杂任务用 Plan→Exec→Eval
        # 审计 B-01：统一复杂度判定 — 关键词快速通道 + 语义分析权威确认
        if react_mode is None:
            react_mode = self._should_use_react(input_text)
        if react_mode:
            # 语义分析二次确认：避免关键词误判（如"搜索"但在复杂上下文中）
            confirmed = await self._confirm_react_mode(input_text)
            if confirmed:
                return await self.run_react_loop(
                    input_text=input_text,
                    messages=messages,
                    session_id=session_id,
                    max_iterations=10,
                    cancel_event=cancel_event,
                    user_id=user_id,
                    strategy_name=strategy_name,
                )
            # 语义分析未确认 → 降级进入 Plan→Exec→Eval 循环

        trace_id = f"loop_{uuid.uuid4().hex[:8]}"

        # P2 #15: 基于历史数据预估执行时间，注入 BudgetState.max_duration_ms
        task_type = self._derive_task_type(input_text)
        max_duration_ms = self._resolve_budget_max_duration(task_type, input_text)

        # agent_native 检测：具备原生 Agent 能力的模型放宽预算限制
        is_agent_native = self._detect_agent_native()
        verification_level = "light" if is_agent_native else "full"

        if is_agent_native and self.constraints_service:
            try:
                complexity = self._compute_complexity(input_text)
                allocation = self.constraints_service.resolve_adaptive_budget(
                    complexity, agent_native=True,
                )
                max_duration_ms = allocation.max_duration_ms
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run.agent_native_budget", _exc)

        context = LoopContext(
            user_input=input_text,
            session_id=session_id,
            messages=list(messages) if messages else [],
            budget=BudgetState(
                start_time=time.time(),
                max_duration_ms=max_duration_ms,
                agent_native=is_agent_native,
                verification_level=verification_level,
            ),
            trace_id=trace_id,
            cancel_event=cancel_event,
            user_id=user_id,
            strategy_name=strategy_name,
            task_type=task_type,
        )

        # V6.0: 中间件管道统一注入上下文（替代内联注入逻辑）
        context = await self._middleware_pipeline.before_loop(context)

        # 循环观察者：开始追踪
        observer_trace_id = self._observer.start_loop(user_input=input_text)

        # 隐式反馈：记录用户消息
        try:
            self._feedback_collector.on_user_message(input_text)
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController.run", _exc)

        exec_record: ExecutionRecord | None = None
        if self.trajectory_db:
            exec_record = ExecutionRecord(
                id=trace_id,
                input=input_text,
                status="running",
                created_at=int(time.time() * 1000),
                updated_at=int(time.time() * 1000),
                task_type=task_type,
            )
            self.trajectory_db.record_execution(exec_record)

        causal_graph: CausalGraph | None = None

        replan_count = 0
        continue_streak = 0
        plan: ExecutionPlan | None = None

        await self._fire_hook(LifecycleHook.BEFORE_LOOP, context, {"input_text": input_text})

        # Phase 3+4: 用户意图追踪 — 设置初始意图
        if self._intent_tracker:
            try:
                self._intent_tracker.set_initial_intent(input_text)
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run.intent_init", _exc)

        while True:
            # 取消检查点：每轮循环开头检查
            if context.is_cancelled():
                self._logger.info("Loop cancelled by user", trace_id=trace_id, round=context.budget.rounds_used)
                # Phase 3+4: 交互中断与恢复 — 保存检查点供后续恢复
                try:
                    self._checkpoint_mgr.save(
                        step_id=f"round_{context.budget.rounds_used}",
                        context=context,
                        step_results={k: v for k, v in context.step_results.items()},
                        session_id=session_id,
                        messages=context.messages,
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.checkpoint_on_cancel", _exc)
                break

            # 轻量级预算检查：内联判断避免每轮创建 ServiceBudgetState 对象
            if context.budget.rounds_used >= context.budget.max_rounds:
                break
            if context.budget.tool_calls_used >= context.budget.max_tool_calls:
                break
            if context.budget.max_duration_ms and context.budget.max_duration_ms > 0:
                elapsed_ms = (time.time() - context.budget.start_time) * 1000
                if elapsed_ms > context.budget.max_duration_ms:
                    self._logger.info(
                        "Loop exceeded max duration, stopping",
                        trace_id=trace_id,
                        elapsed_ms=int(elapsed_ms),
                        max_duration_ms=context.budget.max_duration_ms,
                    )
                    break

            # 完整约束检查：仅在轻量检查通过后调用（含 token/软限制等高级策略）
            if self.constraints_service:
                try:
                    from agent.constraints.service import BudgetState as ServiceBudgetState
                    budget_state = ServiceBudgetState(
                        rounds_used=context.budget.rounds_used,
                        hard_round_limit=context.budget.max_rounds,
                        soft_round_limit=context.budget.max_rounds,
                        tokens_used=context.budget.tokens_used,
                        token_hard_limit=context.budget.max_tokens,
                        token_warning_limit=context.budget.max_tokens,
                        tool_calls_used=context.budget.tool_calls_used,
                        max_tool_calls=context.budget.max_tool_calls,
                        max_duration_ms=context.budget.max_duration_ms,
                        start_time=context.budget.start_time,
                    )
                    budget_result = self.constraints_service.check_budget(budget_state)
                    if not budget_result.within_budget:
                        self._logger.warning(
                            "Constraint budget exceeded, stopping loop",
                            trace_id=trace_id,
                            warnings=budget_result.warnings,
                        )
                        break
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run", _exc)

            context.budget.rounds_used += 1

            # ─── Phase 0: PERCEIVING ───
            # 五感感知：在规划前感知当前环境状态，实现感知驱动的规划
            self.state = LoopState.PERCEIVING
            self._observer.start_phase(LoopPhase.PERCEIVER, input_summary=input_text)

            # 闭环修复：循环→感知 — 将上一轮执行结果作为感知上下文传入
            _perception_extra: dict[str, Any] = {
                "session_id": session_id,
                "trace_id": trace_id,
                "round": context.budget.rounds_used,
            }
            if context.step_results:
                _prev_summary = {
                    sid: {"success": sr.success, "tool": sr.tool_name, "error": sr.error}
                    for sid, sr in list(context.step_results.items())[-5:]
                }
                _perception_extra["previous_results"] = _prev_summary
            if context.metadata.get("verification_passed") is False:
                _perception_extra["verification_failed"] = True
            if context.metadata.get("adaptive_strategy"):
                _perception_extra["strategy_state"] = context.metadata["adaptive_strategy"]

            if self._perception_bus is not None:
                try:
                    perception_state = await self._perception_bus.perceive(
                        user_input=input_text,
                        context=_perception_extra,
                    )

                    # W3-2: 加载历史环境状态作为补充（跨会话环境记忆）
                    if self.trajectory_db and perception_state is not None:
                        try:
                            historical = self._perception_bus.load_historical_state(
                                session_id=session_id,
                            )
                            if historical is not None:
                                if not perception_state.environment.os_info and historical.environment.os_info:
                                    perception_state.environment.os_info = historical.environment.os_info
                                if not perception_state.environment.screen_resolution and historical.environment.screen_resolution:
                                    perception_state.environment.screen_resolution = historical.environment.screen_resolution
                        except Exception as _exc:
                            log.debug("controller 异常处理", error=str(_exc))
                            log_ignored(log, "controller.LoopController.run.historical_env", _exc)

                    context.perception_state = perception_state

                    perception_text = perception_state.to_prompt_text()
                    if perception_text:
                        context.messages = [
                            m for m in context.messages
                            if not (m.get("role") == "system" and m.get("content", "").startswith("【当前感知状态】"))
                        ]
                        context.messages.insert(0, {"role": "system", "content": perception_text})

                    self._logger.info(
                        "Perception phase completed",
                        channels=perception_state.channels_active,
                        duration_ms=round(perception_state.duration_ms),
                        emotion=perception_state.emotion.emotion_type,
                        scene=perception_state.scene.scene_type,
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.perceive", _exc)

            self._observer.end_phase(
                LoopPhase.PERCEIVER,
                success=True,
                output_summary=f"perception={'done' if self._perception_bus else 'skipped'}",
            )

            # Phase 3+4: 感知驱动规划增强 — 将感知状态转化为规划约束和工具推荐
            if self._perception_driven_planner and context.perception_state is not None:
                try:
                    p_constraints = self._perception_driven_planner.derive_constraints(context.perception_state)
                    p_strategy = self._perception_driven_planner.derive_strategy(context.perception_state)
                    p_tools = self._perception_driven_planner.recommend_tools(context.perception_state)

                    context.metadata["perception_constraints"] = p_constraints.to_dict()
                    context.metadata["perception_strategy"] = {
                        "strategy": p_strategy.strategy.value,
                        "reason": p_strategy.reason,
                        "confidence": p_strategy.confidence,
                    }
                    if p_tools:
                        context.metadata["perception_tool_recommendations"] = [
                            {"tool": t.tool_name, "score": t.score, "reason": t.reason}
                            for t in p_tools[:5]
                        ]

                    if p_constraints.perception_evidence:
                        evidence_text = "；".join(
                            f"[{k}]{v}" for k, v in p_constraints.perception_evidence.items()
                        )
                        context.messages.append({
                            "role": "system",
                            "content": f"【感知驱动规划】{evidence_text}",
                        })

                    self._logger.info(
                        "Perception-driven planning constraints derived",
                        strategy=p_strategy.strategy.value,
                        risk_level=p_constraints.risk_level.value,
                        prefer_tools=len(p_constraints.prefer_tools),
                        avoid_tools=len(p_constraints.avoid_tools),
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.perception_driven_planning", _exc)

            # P1-修复4: 元决策策略选择 — 基于感知状态用 Q-Learning 选择决策策略
            # （rule_based / llm_driven / debate_driven / mcts_driven），驱动规划路径路由。
            if self._meta_decision:
                try:
                    _meta_ctx = self._meta_decision.build_context_from_loop(
                        context, context.perception_state,
                    )
                    _chosen_strategy = self._meta_decision.decide(_meta_ctx)
                    context.metadata["decision_strategy"] = _chosen_strategy.value
                    context.metadata["decision_context"] = {
                        "complexity": _meta_ctx.complexity,
                        "scene": _meta_ctx.scene,
                        "emotion": _meta_ctx.emotion,
                        "risk_level": _meta_ctx.risk_level,
                    }
                    self._logger.info(
                        "Meta-decision strategy selected",
                        strategy=_chosen_strategy.value,
                        complexity=_meta_ctx.complexity,
                        scene=_meta_ctx.scene,
                        risk_level=_meta_ctx.risk_level,
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.meta_decide", _exc)

            # ─── Phase 1: PLANNING ───
            self.state = LoopState.PLANNING
            self._observer.start_phase(LoopPhase.PLANNER, input_summary=input_text)

            # 残留-2 修复：决策策略驱动规划路由 — 元决策 decide() 选定的策略强制路由规划路径
            _chosen_strategy = context.metadata.get("decision_strategy", "rule_based")
            if _chosen_strategy == "mcts_driven" and (plan is None or replan_count > 0):
                try:
                    _mcts_plan = await self._try_mcts_replan(input_text, context)
                    if _mcts_plan is not None and _mcts_plan.steps:
                        plan = _mcts_plan
                        context.plan = plan
                        if not plan.simple:
                            self._inject_plan_into_context(plan, context)
                        self._logger.info(
                            "MCTS-driven planning (meta-decision)",
                            steps=len(plan.steps),
                        )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.mcts_driven_plan", _exc)

            # 闭环修复：感知约束 → 规划约束 — 将感知驱动的工具偏好/规避注入规划上下文
            if context.metadata.get("perception_constraints"):
                try:
                    pc = context.metadata["perception_constraints"]
                    avoid = pc.get("avoid_tools", [])
                    prefer = pc.get("prefer_tools", [])
                    if avoid or prefer:
                        constraint_parts = []
                        if avoid:
                            constraint_parts.append(f"避免使用工具: {', '.join(avoid)}")
                        if prefer:
                            constraint_parts.append(f"优先使用工具: {', '.join(prefer)}")
                        if pc.get("require_confirmation"):
                            constraint_parts.append("高风险操作需确认")
                        if pc.get("max_steps", 10) < 10:
                            constraint_parts.append(f"最多{pc['max_steps']}步")
                        context.messages.append({
                            "role": "system",
                            "content": f"【规划约束（感知驱动）】{'；'.join(constraint_parts)}",
                        })
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.perception_to_plan", _exc)

            if plan is None or replan_count > 0:
                # P2-7: 推理缓存查找 — 相似路径有高质量结果时直接复用
                _cached_plan = None
                if self._inference_cache_enabled:
                    try:
                        _cached_result = self._lookup_inference_cache(
                            input_text=input_text,
                            quality_threshold=0.7,
                        )
                        if _cached_result is not None and hasattr(_cached_result, 'suggested_action'):
                            if getattr(_cached_result, 'goal_progress', 0) >= 0.8:
                                self._logger.info(
                                    "P2-7: 推理缓存命中高质量结果，跳过规划",
                                    quality=getattr(_cached_result, 'goal_progress', 0),
                                )
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run.inference_cache_lookup", _exc)

                # W2-4: 历史经验驱动规划 — 从 TrajectoryDatabase 检索相似任务经验
                if self.trajectory_db:
                    try:
                        similar_tasks = self.trajectory_db.query_similar_tasks(
                            query=input_text,
                            include_failed=True,
                            max_results=3,
                            min_quality=0.5,
                        )
                        if similar_tasks:
                            experience_parts = ["【历史经验参考】"]
                            high_quality_count = 0
                            for idx, st in enumerate(similar_tasks):
                                exec_rec = st.get("execution")
                                rel_score = st.get("relevance_score", 0)
                                quality_score = st.get("quality_score", 0)
                                combined_score = st.get("combined_score", 0)
                                if exec_rec:
                                    status_tag = "✅" if exec_rec.status == "success" else "❌"
                                    tool_invocations = st.get("tool_invocations", [])
                                    tool_seq = " → ".join(
                                        ti.tool_name for ti in tool_invocations[:5]
                                    ) if tool_invocations else "无工具记录"
                                    quality_tag = f"质量:{quality_score:.0%}" if quality_score > 0 else "质量:未知"
                                    experience_parts.append(
                                        f"{idx + 1}. {status_tag} 相似度:{rel_score:.0%} {quality_tag} "
                                        f"任务:{exec_rec.input[:60]} "
                                        f"工具链:{tool_seq}"
                                    )
                                    if exec_rec.status == "success" and quality_score >= 0.7:
                                        high_quality_count += 1
                                    if exec_rec.status != "success" and exec_rec.error_summary:
                                        experience_parts.append(f"   失败原因: {exec_rec.error_summary[:80]}")
                            if high_quality_count > 0:
                                experience_parts.append(
                                    f"建议：有 {high_quality_count} 条高质量成功经验可复用，优先参考其工具链。"
                                )
                            if len(experience_parts) > 1:
                                context.messages.append({
                                    "role": "system",
                                    "content": "\n".join(experience_parts),
                                })
                                self._logger.info(
                                    "W3-1: Historical experience injected with quality feedback",
                                    similar_count=len(similar_tasks),
                                    high_quality_count=high_quality_count,
                                )
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run.experience_inject", _exc)

                plan = await self._plan_scheduler.schedule(input_text, context)
                context.plan = plan
                # 安全沙箱联动：规划完成后为每一步标注工具风险等级
                if self._risk_precheck is not None:
                    try:
                        self._risk_precheck.annotate_plan(plan)
                        # 规划阶段即把「需审批」步骤推给前端确认 UI（预览一次、执行即放行）
                        await self._risk_precheck.preview_plan(plan)
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run.annotate_plan", _exc)

                if not plan.simple:
                    self._inject_plan_into_context(plan, context)

                    if replan_count > 0 and self._last_reflection_insight:
                        self._inject_reflection_into_context(context)

                if self.trajectory_db:
                    asyncio.ensure_future(self._async_record_transition(
                        trace_id,
                        "evaluating" if replan_count > 0 else "idle",
                        "planning",
                        f"第{context.budget.rounds_used}轮规划" + ("（重规划）" if replan_count > 0 else ""),
                    ))

                # P2 优化：仅 complex 计划构建因果图 + 辩论审查（省 2 次 LLM 调用）
                causal_task: "asyncio.Task[CausalGraph | None] | None" = None
                if causal_graph is None and not plan.simple and len(plan.steps) >= 3:
                    causal_task = asyncio.create_task(self._safe_build_causal(input_text))

                # 反思应用：根据经验优化规划（同步，不阻塞 I/O）
                self._apply_reflection_to_planning(input_text, context, plan)

                # 等待因果图构建完成
                if causal_task is not None:
                    try:
                        causal_graph = await causal_task
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        causal_graph = None

                await self._fire_hook(LifecycleHook.AFTER_PLAN, context, {"plan": plan})

                # F3: 计划质量检查 — 验证完整性/可行性/风险，拦截低质量计划
                if not plan.simple and plan.steps and self._plan_quality_checker.enabled:
                    try:
                        plan_dicts = [
                            {"step_id": s.step_id, "description": s.description, "tool_name": s.tool_name or ""}
                            for s in plan.steps
                        ]
                        quality_result = self._plan_quality_checker.check_plan(plan_dicts)
                        if not quality_result.is_passed:
                            self._logger.warning(
                                "Plan quality check failed",
                                quality_score=quality_result.quality_score,
                                issues=[i.description for i in quality_result.issues],
                            )
                            context.metadata["plan_quality_issues"] = [
                                {"severity": i.severity, "description": i.description}
                                for i in quality_result.issues
                            ]
                        else:
                            self._logger.info(
                                "Plan quality check passed",
                                quality_score=quality_result.quality_score,
                            )
                    except Exception as e:
                        self._logger.debug("Plan quality check failed", error=str(e))

                # P0 接入：辩论式计划审查 — 在执行前验证计划质量
                # Phase 3+4: 优先使用 DebateHarness 六层审查，降级到单一辩论器
                # 残留-2 修复：debate_driven 策略强制启用辩论审查，即使计划简单/步数少
                _force_debate = _chosen_strategy == "debate_driven"
                if (not plan.simple and len(plan.steps) >= 2) or _force_debate:
                    try:
                        if self._debate_harness:
                            harness_result = await self._debate_harness.review(plan, input_text, context)
                            context.metadata["debate_result"] = {
                                "passed": harness_result.verdict == DebateVerdict.APPROVED,
                                "quality_score": harness_result.quality_score,
                                "vulnerabilities": harness_result.vulnerabilities,
                                "improvements": harness_result.improvements,
                                "harness_levels": len(harness_result.harness_results),
                                "escalated": harness_result.escalated,
                            }
                            if harness_result.verdict == DebateVerdict.REJECTED:
                                self._logger.warning(
                                    "DebateHarness rejected plan",
                                    quality_score=harness_result.quality_score,
                                    vulnerabilities=harness_result.vulnerabilities,
                                )
                            elif harness_result.verdict == DebateVerdict.ESCALATE:
                                # P1-修复5: 接入 MCTS 升级路径 — 辩论未通过时用蒙特卡洛搜索替代原计划
                                self._logger.warning(
                                    "DebateHarness escalated plan, invoking MCTS replan",
                                    reason=harness_result.escalation_reason,
                                )
                                _mcts_plan = await self._try_mcts_replan(input_text, context)
                                if _mcts_plan is not None and _mcts_plan.steps:
                                    plan = _mcts_plan
                                    context.plan = plan
                                    if not plan.simple:
                                        self._inject_plan_into_context(plan, context)
                                    self._logger.info(
                                        "MCTS replan succeeded",
                                        steps=len(plan.steps),
                                        reasoning=(plan.reasoning or "")[:80],
                                    )
                                else:
                                    self._logger.info(
                                        "MCTS replan unavailable, keeping original plan",
                                    )
                            else:
                                self._logger.info(
                                    "DebateHarness approved plan",
                                    quality_score=harness_result.quality_score,
                                )
                        elif self._get_debater():
                            debate_result = await self._debater.debate(plan, input_text, context)
                            context.metadata["debate_result"] = {
                                "passed": debate_result.passed,
                                "quality_score": debate_result.quality_score,
                                "vulnerabilities": debate_result.vulnerabilities,
                                "improvements": debate_result.improvements,
                            }
                            if not debate_result.passed:
                                self._logger.warning(
                                    "Debater rejected plan",
                                    quality_score=debate_result.quality_score,
                                    vulnerabilities=debate_result.vulnerabilities,
                                    improvements=debate_result.improvements,
                                )
                            else:
                                self._logger.info(
                                    "Debater approved plan",
                                    quality_score=debate_result.quality_score,
                                )
                    except Exception as e:
                        self._logger.warning("Debate review failed, proceeding anyway", error=str(e))

            self._observer.end_phase(
                LoopPhase.PLANNER,
                success=True,
                output_summary=f"{len(plan.steps)} steps" if plan and plan.steps else "simple",
            )

            # ─── Phase 2: EXECUTING ───
            self.state = LoopState.EXECUTING
            self._observer.start_phase(LoopPhase.EXECUTOR)

            # 取消检查点：执行前检查
            if context.is_cancelled():
                self._logger.info("Loop cancelled before executing", trace_id=trace_id)
                break

            if self.trajectory_db:
                asyncio.ensure_future(self._async_record_transition(
                    trace_id, "planning", "executing",
                    f"第{context.budget.rounds_used}轮执行",
                ))

            # P1-4: 有链式依赖时使用 execute_chain，否则使用 execute
            # P2 优化：因果图有并行组时使用 execute_hybrid 组内并行执行
            # F6: complex 计划（5+步骤）使用 OrchestrationExecutor DAG 调度
            has_chain = any(
                s.input_from_step for s in plan.steps
            ) if plan and plan.steps else False
            parallel_groups = None
            if not has_chain and causal_graph and causal_graph.nodes:
                try:
                    parallel_groups = self.causal.find_parallel_groups(causal_graph)
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    parallel_groups = None

            use_orchestration = (
                not plan.simple
                and len(plan.steps) >= 5
                and not has_chain
                and hasattr(self, '_orchestration_executor')
                and self._orchestration_executor is not None
            )

            # W3-5: 增强自动触发 — 基于预测偏差和历史经验智能决策
            if (
                not use_orchestration
                and not plan.simple
                and not has_chain
                and hasattr(self, '_orchestration_executor')
                and self._orchestration_executor is not None
            ):
                try:
                    if self._prediction_loop is not None:
                        pred_stats = self._prediction_loop.get_statistics()
                        mismatch_rate = pred_stats.get("mismatch_rate", 0.0)
                        if mismatch_rate > 0.3 and len(plan.steps) >= 3:
                            use_orchestration = True
                            self._logger.info(
                                "W3-5: Auto-triggering orchestration due to high mismatch rate",
                                mismatch_rate=f"{mismatch_rate:.0%}",
                                steps=len(plan.steps),
                            )
                    if self.trajectory_db is not None and not use_orchestration:
                        try:
                            similar = self.trajectory_db.query_similar_tasks(
                                query=input_text,
                                include_failed=True,
                                max_results=3,
                                min_quality=0.3,
                            )
                            fail_count = sum(
                                1 for st in similar
                                if st.get("execution") and st.get("execution").status != "success"
                            )
                            if fail_count >= 2 and len(plan.steps) >= 3:
                                use_orchestration = True
                                self._logger.info(
                                    "W3-5: Auto-triggering orchestration due to historical failures",
                                    fail_count=fail_count,
                                    steps=len(plan.steps),
                                )
                        except Exception as _exc:
                            log.debug("controller 异常处理", error=str(_exc))
                            log_ignored(log, "controller.LoopController.run.orchestration_history", _exc)
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.orchestration_trigger", _exc)

            if has_chain:
                executor_output = await self.executor.execute_chain(plan.steps, context)
            elif use_orchestration:
                executor_output = await self._execute_with_orchestration(plan, context)
            elif parallel_groups and len(parallel_groups) > 1:
                executor_output = await self.executor.execute_hybrid(plan, context, parallel_groups)
            else:
                executor_output = await self.executor.execute(plan, context)

            for msg in executor_output.messages:
                if msg not in context.messages:
                    context.messages.append(msg)

            for sr in executor_output.step_results:
                context.step_results[sr.step_id] = sr

                # 循环观察者：工具调用级埋点
                if sr.tool_name:
                    tool_call_id = self._observer.start_tool_call(
                        sr.tool_name,
                        params={"step_id": sr.step_id},
                    )
                    self._observer.end_tool_call(
                        tool_call_id,
                        success=sr.success,
                        result=sr.content,
                        error=sr.error,
                    )

            context.budget.tool_calls_used += executor_output.tool_calls_count

            # Phase 3+4: 动态降级策略 — 记录每个工具调用的成功/失败，更新降级状态
            for sr in executor_output.step_results:
                if sr.tool_name:
                    try:
                        self._adaptive_degradation.record_result(
                            tool_name=sr.tool_name,
                            success=sr.success,
                            latency_ms=getattr(sr, "duration_ms", 0) or 0,
                        )
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run.adaptive_degradation", _exc)

            # Phase 3+4: 交互中断与恢复 — 每轮执行后保存检查点
            try:
                self._checkpoint_mgr.save(
                    step_id=f"round_{context.budget.rounds_used}",
                    context=context,
                    step_results={k: v for k, v in context.step_results.items()},
                    session_id=session_id,
                    messages=context.messages,
                )
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run.checkpoint_save", _exc)

            # P1-1: 感知验证结果注入 — 桌面操作验证失败时提示 LLM
            for sr in executor_output.step_results:
                if sr.metadata and "perception" in sr.metadata:
                    p = sr.metadata["perception"]
                    if p.get("perception_verified") and not p.get("perception_success"):
                        evidence = p.get("perception_evidence", "未知原因")
                        confidence = p.get("perception_confidence", 0)
                        context.messages.append({
                            "role": "system",
                            "content": f"【感知验证】工具 {sr.tool_name} 执行后验证未通过 (置信度:{confidence:.0%})，证据: {evidence}",
                        })

            # ─── 工具失败 → 反思纠错 ───
            failed_steps = [sr for sr in executor_output.step_results if not sr.success]
            if failed_steps and self._last_reflection_insight is None:
                # 隐式反馈：工具失败作为负向信号
                try:
                    self._feedback_collector.record_signal(
                        signal_type=FeedbackType.NEGATIVE,
                        strength=FeedbackStrength.MEDIUM,
                        source=FeedbackSource.RETRY,
                        confidence=0.7,
                        metadata={
                            "tool_name": failed_steps[0].tool_name,
                            "error": failed_steps[0].error,
                        },
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run", _exc)

                await self._reflect_on_failure(failed_steps[0], context)

            # 主动从失败学习闭环：每次失败都沉淀经验（独立于反思分支，确保不漏）
            if failed_steps and self._failure_learner is not None:
                try:
                    _fs = failed_steps[0]
                    await self._failure_learner.learn_from_failure(
                        action=getattr(_fs, "tool_name", "") or "unknown",
                        error=getattr(_fs, "error", "") or "未知错误",
                        task=input_text,
                        session_id=session_id,
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.failure_learn", _exc)

            # P1-1: 成功反思 — 从成功执行中提炼模式和最佳实践
            successful_steps = [sr for sr in executor_output.step_results if sr.success and sr.tool_name]
            for sr in successful_steps:
                try:
                    await self.reflection.reflect_on_success(
                        tool_name=sr.tool_name or "",
                        args=sr.tool_params,
                        result=sr.content or "",
                        context={"traceId": context.trace_id, "step_id": sr.step_id},
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run", _exc)

            # 因果影响分析（如果有失败的步骤）
            if failed_steps and causal_graph and causal_graph.nodes:
                impact = self.causal.get_failure_impact(
                    causal_graph, failed_steps[0].step_id
                )
                if impact.affected_steps:
                    context.messages.append({
                        "role": "system",
                        "content": f"【因果影响分析】步骤 {failed_steps[0].step_id} 失败可能影响: {', '.join(impact.affected_steps)} (严重度: {impact.severity})",
                    })

            if self.trajectory_db:
                for idx, sr in enumerate(executor_output.step_results):
                    asyncio.ensure_future(self._async_record_tool(
                        trace_id, idx, sr,
                    ))

            self._observer.end_phase(
                LoopPhase.EXECUTOR,
                success=not failed_steps,
                output_summary=f"{len(executor_output.step_results)} steps executed",
            )

            # ─── Phase 2.5: VERIFYING ───
            # 语义验证：即使轻量模式也执行最小语义验证
            self.state = LoopState.VERIFYING
            self._observer.start_phase(LoopPhase.VERIFIER)

            try:
                verification_result = await self._verify_execution(
                    input_text, context, executor_output,
                )
                if verification_result and not verification_result.get("passed", True):
                    verification_feedback = verification_result.get("feedback", "")
                    if verification_feedback:
                        context.messages.append({
                            "role": "system",
                            "content": f"【语义验证反馈】{verification_feedback}",
                        })
                    self._logger.info(
                        "Verification phase: issues detected",
                        passed=verification_result.get("passed", True),
                        score=verification_result.get("score", 0.0),
                    )
                    # 闭环修复：验证→评估 — 将验证分数注入 context 供评估器参考
                    context.metadata["verification_score"] = verification_result.get("score", 0.0)
                    context.metadata["verification_passed"] = verification_result.get("passed", True)
                else:
                    self._logger.debug("Verification phase: passed")
                    context.metadata["verification_score"] = 1.0
                    context.metadata["verification_passed"] = True
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run.verify", _exc)

            self._observer.end_phase(
                LoopPhase.VERIFIER,
                success=True,
                output_summary="verified",
            )

            # W3-4: 自主触发增强 — 基于学习结果和环境变化评估主动行动
            if self._proactive_engine is not None:
                try:
                    prediction_stats = self._prediction_loop.get_statistics() if self._prediction_loop else None
                    env_change = context.metadata.get("environment_change")
                    proactive_actions = self._proactive_engine.evaluate(
                        perception_state=context.perception_state,
                        current_input=input_text,
                        prediction_stats=prediction_stats,
                        environment_change=env_change,
                    )
                    if proactive_actions:
                        action_parts = []
                        for pa in proactive_actions[:3]:
                            action_parts.append(f"[{pa.action_type.value}] {pa.title}: {pa.description}")
                        context.messages.append({
                            "role": "system",
                            "content": "【主动建议】\n" + "\n".join(action_parts),
                        })
                        self._logger.info(
                            "W3-4: Proactive actions triggered",
                            count=len(proactive_actions),
                            types=[a.action_type.value for a in proactive_actions],
                        )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.proactive", _exc)

            # ─── P2 优化：评估并行启动，与轻量反思/注意力聚焦重叠 ───
            eval_task = asyncio.create_task(self.evaluator.evaluate(input_text, context))

            # ─── 轻量级反思（每轮执行后） ───
            await self._lightweight_reflection_round(executor_output.step_results, context)

            # P0-3: 注意力聚焦 — 清理低价值上下文消息
            try:
                if self._context_window_manager and context.messages:
                    compressed_msgs, compression = self._context_window_manager.check_and_compress(
                        context.messages
                    )
                    if compression and compression.ratio < 1.0:
                        self._logger.info(
                            "Context window compressed",
                            strategy=compression.strategy,
                            ratio=f"{compression.ratio:.2f}",
                        )
                        if compression.summary:
                            compressed_msgs = [
                                m for m in compressed_msgs
                                if m.get("role") != "system" or "历史对话摘要" not in m.get("content", "")
                            ]
                            compressed_msgs.insert(1, {"role": "system", "content": compression.summary})
                        context.messages = compressed_msgs
                else:
                    self._attention_focus.apply_to_context(context)
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                try:
                    self._attention_focus.apply_to_context(context)
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run", _exc)

            # ─── Phase 3: EVALUATING ───
            self.state = LoopState.EVALUATING
            self._observer.start_phase(LoopPhase.EVALUATOR)

            if self.trajectory_db:
                asyncio.ensure_future(self._async_record_transition(
                    trace_id, "executing", "evaluating",
                    f"第{context.budget.rounds_used}轮评估",
                ))

            eval_result = await eval_task

            # P2-7: 推理缓存存储 — 评估完成后将本轮推理结果存入缓存
            if self._inference_cache_enabled and eval_result is not None:
                try:
                    _tool_seq = [
                        sr.tool_name for sr in context.step_results.values()
                        if sr.tool_name
                    ] if context.step_results else []
                    _quality = getattr(eval_result, 'goal_progress', 0.0)
                    self._store_inference_cache(
                        input_text=input_text,
                        tool_sequence=_tool_seq,
                        result=eval_result,
                        quality=_quality,
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.inference_cache_store", _exc)

            # Phase 3+4: 自适应执行策略引擎 — 统一调度多维度策略信号
            if self._adaptive_strategy:
                try:
                    degradation_decision = None
                    if self._adaptive_degradation:
                        degradation_decision = self._adaptive_degradation.evaluate("overall")

                    drift_result = None
                    if self._intent_tracker:
                        drift_result = self._intent_tracker.check_drift(input_text)

                    resolved = self._adaptive_strategy.resolve(
                        perception_state=context.perception_state,
                        degradation_decision=degradation_decision,
                        drift_result=drift_result,
                        budget_state=context.budget,
                    )

                    context.metadata["adaptive_strategy"] = resolved.to_dict()

                    if resolved.action.value != "proceed" and resolved.confidence > 0.6:
                        self._logger.info(
                            "Adaptive strategy resolved",
                            action=resolved.action.value,
                            confidence=resolved.confidence,
                            reasons=resolved.reasons[:3],
                        )

                        # 闭环修复：评估→行动 — 策略引擎结果实际影响执行路径
                        if resolved.action.value == "pause_and_ask":
                            context.messages.append({
                                "role": "system",
                                "content": f"【策略建议】{'; '.join(resolved.reasons[:2])}，建议暂停确认",
                            })
                        elif resolved.action.value == "confirm_before_proceed":
                            context.metadata["require_confirmation"] = True
                            context.messages.append({
                                "role": "system",
                                "content": f"【策略调整】{'; '.join(resolved.reasons[:2])}，后续操作需确认",
                            })
                        elif resolved.action.value == "degrade_and_continue":
                            context.metadata["degradation_active"] = True
                            context.messages.append({
                                "role": "system",
                                "content": f"【降级执行】{'; '.join(resolved.reasons[:2])}，使用降级策略继续",
                            })
                        elif resolved.action.value == "proceed_cautious":
                            context.metadata["cautious_mode"] = True
                            if context.budget.max_retries > 1:
                                context.budget.max_retries = 1
                        elif resolved.action.value == "replan":
                            if eval_result.suggested_action == "continue":
                                eval_result = eval_result._replace(suggested_action="replan") if hasattr(eval_result, '_replace') else eval_result
                                self._logger.info("Adaptive strategy override: continue → replan")
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.adaptive_strategy", _exc)

            await self._fire_hook(LifecycleHook.AFTER_EVALUATE, context, {"eval_result": eval_result})

            # 反思应用：更新经验知识库
            self._update_reflection_knowledge(input_text, context, eval_result)

            self._observer.end_phase(
                LoopPhase.EVALUATOR,
                success=True,
                output_summary=f"action={eval_result.suggested_action}, progress={eval_result.goal_progress:.2f}",
            )

            # ─── Phase 3.5: REFLECTING ───
            enable_deep_reflection = True
            adjusted_max_retries = 2
            should_slow_down = False

            if self.evolution:
                try:
                    from agent.evolution.types import LearningSignal, SignalType
                    config = self.evolution.get_adjusted_reflection_config()
                    enable_deep_reflection = config.enable_deep_reflection
                    adjusted_max_retries = config.max_retries

                    # P0-3: 尝试获取实时学习反馈
                    if hasattr(self.evolution, 'get_realtime_feedback'):
                        try:
                            rt = self.evolution.get_realtime_feedback()
                            adjusted_max_retries = rt.get('suggested_max_retries', adjusted_max_retries)
                            should_slow_down = rt.get('should_slow_down', False)
                            if rt.get('tool_recommendations'):
                                context.metadata['tool_weights'] = rt['tool_recommendations']
                        except Exception as _exc:
                            log.debug("controller 异常处理", error=str(_exc))
                            log_ignored(log, "controller.LoopController.run", _exc)

                    log.info(
                        "Strategy adaptive",
                        deep_reflection=enable_deep_reflection,
                        max_retries=adjusted_max_retries,
                        slow_down=should_slow_down,
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run", _exc)

            if should_slow_down:
                context.budget.max_duration_ms = int(context.budget.max_duration_ms * 1.5)
                log.info("Slowing down: extended max duration by 1.5x")

            if not enable_deep_reflection and context.budget.rounds_used > 1:
                log.info("Strategy adaptive: high success rate, skip deep reflection")
            elif eval_result.suggested_action == "replan" and eval_result.goal_progress < 0.5:
                await self._deep_reflect(input_text, context, eval_result)

            # P2-8: 记忆整理质量驱动 — 当质量低于阈值时自动触发记忆整理
            if self._inference_cache_enabled and eval_result.goal_progress < 0.5:
                try:
                    if self._memory_engine is not None:
                        _store = getattr(self._memory_engine, '_store', None) or getattr(self._memory_engine, 'store', None)
                        if _store is not None and hasattr(_store, 'consolidate_by_quality'):
                            _consolidation_report = _store.consolidate_by_quality(
                                quality_threshold=0.6,
                                max_consolidation=20,
                            )
                            if _consolidation_report.get("deleted", 0) + _consolidation_report.get("promoted", 0) > 0:
                                self._logger.info(
                                    "P2-8: 质量驱动记忆整理已触发",
                                    deleted=_consolidation_report.get("deleted", 0),
                                    promoted=_consolidation_report.get("promoted", 0),
                                    merged=_consolidation_report.get("merged", 0),
                                )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.memory_consolidation", _exc)

            # W2-2: 步骤级动态调整 — should_replan + suggest_step_adjustment
            _step_adjustment_applied = False
            if plan and not plan.simple and eval_result.suggested_action == "continue":
                _eval_dicts = [
                    {
                        "goal_progress": eval_result.goal_progress,
                        "suggested_action": eval_result.suggested_action,
                        "quality_score": eval_result.quality_score,
                        "step_success_rate": eval_result.step_success_rate,
                    }
                ]
                _replan_decision = self.executor.should_replan(_eval_dicts, context.budget.rounds_used)
                if _replan_decision.get("should_replan"):
                    _adjustment = self._suggest_step_adjustment(plan, eval_result, context)
                    if _adjustment:
                        self._apply_step_adjustment(plan, _adjustment, context)
                        _step_adjustment_applied = True
                        self._logger.info(
                            "W2-2: Step adjustment applied",
                            adjustment_type=_adjustment.get("type"),
                            target_step=_adjustment.get("target_step_id"),
                            reason=_adjustment.get("reason"),
                        )

            # ─── 决策 ───
            action = eval_result.suggested_action

            if action == "continue":
                if eval_result.goal_progress >= 0.8:
                    break
                continue_streak += 1
                # 卡死保护（审计 L-05）：持续 continue 但进度无提升时强制升级为重规划
                if continue_streak >= self.MAX_CONTINUE_STREAK and context.plan:
                    replan_count += 1
                    if replan_count >= self.MAX_REPLAN_COUNT:
                        break
                    plan = None
                    self._logger.info(
                        "Stuck in continue with no progress, forcing replan",
                        trace_id=trace_id,
                        continue_streak=continue_streak,
                    )
                    continue
                if context.budget.rounds_used >= context.budget.max_rounds:
                    break
                continue

            elif action == "replan":
                continue_streak = 0
                replan_count += 1
                if replan_count >= self.MAX_REPLAN_COUNT:
                    # P2-5: 重规划耗尽时触发回滚链 — 撤销已执行的可逆操作
                    if hasattr(self, '_executor') and self._executor is not None:
                        try:
                            _rollback_result = await self._executor.rollback_chain()
                            if _rollback_result:
                                self._logger.info(
                                    "P2-5: 重规划耗尽，回滚链已执行",
                                    rolled_back=len(_rollback_result),
                                )
                        except Exception as _exc:
                            log.debug("controller 异常处理", error=str(_exc))
                            log_ignored(log, "controller.LoopController.run.rollback_on_exhaust", _exc)
                    break

                # Phase 3+4: 用户意图漂移检测 — 重规划前检查意图是否偏移
                if self._intent_tracker:
                    try:
                        drift = self._intent_tracker.check_drift(input_text)
                        if drift.is_drifted and drift.severity.value in ("moderate", "major"):
                            context.messages.append({
                                "role": "system",
                                "content": f"【意图漂移】{drift.recommendation}（连续性: {drift.continuity_score:.0%}）",
                            })
                            self._logger.info(
                                "Intent drift detected during replan",
                                severity=drift.severity.value,
                                continuity=drift.continuity_score,
                                original=drift.original_intent[:50],
                                current=drift.current_intent[:50],
                            )
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run.intent_drift", _exc)

                if eval_result.failure_analysis:
                    context.messages.append({
                        "role": "system",
                        "content": f"【评估反馈】{eval_result.failure_analysis}\n修正建议: {eval_result.suggested_correction or '重新规划'}",
                    })

                # 主动从失败学习闭环：把历史失败经验注入 replan 上下文，避免重蹈覆辙
                if self._failure_learner is not None:
                    try:
                        _lesson = await self._failure_learner.build_injection_prompt(input_text)
                        if _lesson:
                            context.messages.append({
                                "role": "system",
                                "content": _lesson,
                            })
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run.failure_inject", _exc)

                failed_info = [
                    {
                        "step_id": sr.step_id,
                        "tool_name": sr.tool_name,
                        "error": sr.error,
                    }
                    for sr in context.step_results.values()
                    if not sr.success
                ]
                root_cause = None
                if self._last_reflection_insight:
                    root_cause = self._last_reflection_insight.get("rootCause")

                plan = await self._plan_scheduler.replan(
                    input_text, context, plan, failed_info, root_cause,
                )
                context.plan = plan
                # 安全沙箱联动：replan 后为新步骤标注风险等级
                if self._risk_precheck is not None:
                    try:
                        self._risk_precheck.annotate_plan(plan)
                        # 重规划后同样推送待审批预览至前端确认 UI
                        await self._risk_precheck.preview_plan(plan)
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run.annotate_replan", _exc)
                log.info(
                    "Iterative replan",
                    replan_count=replan_count,
                    new_steps=len(plan.steps),
                    root_cause=root_cause,
                )

                continue

            elif action == "abort":
                break

            else:
                break

        # ─── Phase 4: REPORTING ───
        self.state = LoopState.REPORTING
        self._observer.start_phase(LoopPhase.REPORTER)

        report = self.reporter.report(context)

        # Phase 3+4: 结构化执行报告 — 生成可被进化引擎自动解析的 JSON 报告
        try:
            structured_report = self._structured_reporter.generate(
                context=context,
                result=report,
                session_id=session_id,
            )
            context.metadata["structured_report"] = structured_report.to_dict()

            # P0-修复3: 报告→进化反馈 — ingest_structured_report 位于 EvolutionClosedLoop
            # 而非 EvolutionEngine。优先用闭环实例，回退到进化引擎（若未来补齐方法）。
            _evo_target = self.evolution_closed_loop or self.evolution
            if _evo_target and hasattr(_evo_target, 'ingest_structured_report'):
                try:
                    asyncio.ensure_future(_evo_target.ingest_structured_report(structured_report))
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run.report_to_evolution", _exc)
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController.run.structured_report", _exc)

        await self._fire_hook(LifecycleHook.AFTER_RESPONSE, context, {"report": report})

        self._observer.end_phase(
            LoopPhase.REPORTER,
            success=True,
            output_summary=f"quality={report.quality_score:.2f}",
        )

        # 隐式反馈：记录 AI 回复
        try:
            self._feedback_collector.on_ai_message(report.response)
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController.run", _exc)

        # 循环观察者：结束追踪
        success = report.quality_score >= 0.6
        self._observer.end_loop(
            success=success,
            error=None if success else "quality below threshold",
            ai_output=report.response,
        )

        if self.trajectory_db and exec_record:
            self.trajectory_db.update_execution_status(
                trace_id,
                "success" if report.quality_score >= 0.6 else "failed",
                response=report.response[:500] if report.response else None,
            )
            exec_record.loop_rounds = context.budget.rounds_used
            exec_record.total_tool_calls = context.budget.tool_calls_used
            exec_record.total_duration = int((time.time() - context.budget.start_time) * 1000)
            exec_record.quality_overall = report.quality_score
            exec_record.updated_at = int(time.time() * 1000)
            self.trajectory_db.record_execution(exec_record)

        tool_call_details = []
        for sr in context.step_results.values():
            detail: dict[str, Any] = {"name": sr.tool_name or "unknown", "step_id": sr.step_id}
            if sr.error:
                detail["error"] = sr.error
            if sr.duration_ms:
                detail["duration_ms"] = sr.duration_ms
            tool_call_details.append(detail)

        # ─── P5: 批量异步记录学习信号（解耦主流程，省 6-8 次串行调用） ───
        if self.evolution:
            asyncio.ensure_future(self._record_signals_async(
                report.quality_score, context, trace_id,
            ))

        # F4: 触发闭环反馈 — 进化/工具失败/偏好学习/知识提取
        if self._feedback_loops:
            try:
                tool_failures = [
                    {"tool_name": sr.tool_name, "error": sr.error, "step_id": sr.step_id}
                    for sr in context.step_results.values()
                    if not sr.success and sr.tool_name
                ]
                asyncio.ensure_future(self._feedback_loops.run_all(
                    user_input=input_text,
                    response=report.response,
                    quality_score=report.quality_score,
                    tool_failures=tool_failures,
                    user_corrections=[],
                ))
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run", _exc)

        self.state = LoopState.COMPLETED

        # 反思应用：保存最终经验和统计
        self._save_reflection_experience(input_text, context, report.quality_score >= 0.6)

        # P1-1: 每 10 次 loop 触发一次元反思
        self._meta_reflect_counter += 1
        if self._meta_reflect_counter >= 10:
            self._meta_reflect_counter = 0
            try:
                await self._trigger_meta_reflect(context)
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run.meta_reflect", _exc)

        # Phase 3+4: 沙箱审计 — 每 10 次 loop 执行一次完整审计
        try:
            audit_report = await self._sandbox_audit_agent.run_audit()
            if audit_report.has_critical:
                log.warning(
                    "Sandbox audit: critical findings",
                    count=sum(1 for f in audit_report.findings if f.severity.value == "critical"),
                )
            context.metadata["sandbox_audit"] = audit_report.to_dict()
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController.run.sandbox_audit", _exc)

        # OTel 指标：记录循环迭代次数与总耗时
        try:
            _loop_success = report.quality_score >= 0.6
            loop_iterations_counter().add(
                context.budget.rounds_used,
                {"status": "success" if _loop_success else "failed"},
            )
            _loop_duration_s = time.time() - context.budget.start_time
            loop_duration_histogram().record(_loop_duration_s)
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController.run", _exc)

        # P1-2: 对话后自动提取知识 — 异步执行不阻塞返回
        if self._knowledge_lifecycle and context.messages:
            try:
                asyncio.ensure_future(self._knowledge_lifecycle.ingest_dialog(
                    context.messages, session_id=session_id,
                ))
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run.knowledge_ingest", _exc)

        # Phase 3: 元决策经验记录 — 记录本轮决策策略和结果
        if self._meta_decision:
            try:
                meta_ctx = self._meta_decision.build_context_from_loop(
                    context, context.perception_state,
                )
                # P1-修复4: 使用规划前 decide() 选定的策略记录经验，而非硬编码 RULE_BASED
                _strategy_name = context.metadata.get("decision_strategy", "rule_based")
                try:
                    _strategy_enum = DecisionStrategy(_strategy_name)
                except ValueError:
                    _strategy_enum = DecisionStrategy.RULE_BASED
                self._meta_decision.record_outcome(
                    context=meta_ctx,
                    strategy=_strategy_enum,
                    success=report.quality_score >= 0.6,
                    quality_score=report.quality_score,
                    duration_ms=report.total_duration_ms,
                    session_id=session_id,
                )
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run.meta_decision_record", _exc)

        # Phase 3+4: 决策可解释性 — 记录本轮关键决策的完整决策链
        try:
            trace = self._decision_tracer.begin(
                decision_type=DecisionType.STRATEGY_SELECTION,
                trigger=f"loop_round_{context.budget.rounds_used}",
                context={
                    "quality_score": report.quality_score,
                    "replan_count": replan_count,
                    "steps_completed": report.steps_completed,
                },
            )
            self._decision_tracer.add_option(
                trace, "continue", score=0.5, description="继续执行",
            )
            self._decision_tracer.add_option(
                trace, "replan", score=0.3, description="重规划",
            )
            self._decision_tracer.add_option(
                trace, "abort", score=0.1, description="终止任务",
            )
            self._decision_tracer.select(
                trace,
                "continue" if report.quality_score >= 0.6 else "replan",
                reason=f"质量评分 {report.quality_score:.2f}",
                expected_outcome="任务完成" if report.quality_score >= 0.6 else "需要调整策略",
            )
            self._decision_tracer.end(
                trace,
                success=report.quality_score >= 0.6,
                quality_score=report.quality_score,
                actual_outcome=f"完成 {report.steps_completed}/{report.steps_total} 步骤",
            )
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController.run.decision_trace", _exc)

        return AgentResult(
            response=report.response,
            quality_score=report.quality_score,
            trace_id=trace_id,
            session_id=session_id,
            steps_completed=report.steps_completed,
            steps_total=report.steps_total,
            metadata={
                "rounds_used": context.budget.rounds_used,
                "tool_calls_used": context.budget.tool_calls_used,
                "tool_calls": tool_call_details,
                "total_duration_ms": report.total_duration_ms,
                "replan_count": replan_count,
                "reflection_metrics": self.reflection.get_metrics().__dict__,
                "plan_steps": [s.dict() if hasattr(s, "dict") else s for s in context.plan.steps] if context.plan and context.plan.steps else [],
                "needs_replan": report.quality_score < 0.5 and replan_count < context.budget.max_rounds,
            },
        )

    async def run_react_loop(
        self,
        input_text: str,
        messages: list[dict[str, str]] | None = None,
        session_id: str = "default",
        max_iterations: int = 10,
        cancel_event: "asyncio.Event | None" = None,
        user_id: str | None = None,
        strategy_name: str | None = None,
    ) -> AgentResult:
        """P1-1: 结构化 ReAct 循环: Thought → Action → Observation。

        每轮迭代使用显式 JSON 结构 {"thought","action","observation"}:
        1. Thought: LLM 思考当前状态和下一步行动
        2. Action: 执行工具调用或生成回复
        3. Observation: 观察执行结果，更新上下文

        Args:
            input_text: 用户输入。
            messages: 历史消息。
            session_id: 会话ID。
            max_iterations: 最大迭代次数。
            cancel_event: 取消事件，设置后将在下一个检查点中止循环。
            user_id: 用户标识，用于灰度发布分桶（可选）。
            strategy_name: 灰度发布策略名称（可选）。

        Returns:
            AgentResult: 最终结果。
        """
        import time as _t

        is_agent_native = self._detect_agent_native()
        verification_level = "light" if is_agent_native else "full"

        context = LoopContext(
            user_input=input_text,
            session_id=session_id,
            messages=list(messages) if messages else [],
            budget=BudgetState(
                start_time=_t.time(),
                agent_native=is_agent_native,
                verification_level=verification_level,
            ),
            trace_id=f"react-{session_id}-{_t.time_ns()}",
            cancel_event=cancel_event,
            user_id=user_id,
            strategy_name=strategy_name,
        )

        # P1-2: 知识上下文注入 — ReAct 循环同样需要历史知识
        if self._knowledge_lifecycle:
            try:
                knowledge_results = await self._knowledge_lifecycle.retrieve(
                    input_text, top_k=3, min_confidence=0.4,
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
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run_react_loop.knowledge_inject", _exc)

        self.state = LoopState.EXECUTING
        step_count = 0
        structured_steps: list[StructuredReActStep] = []

        await self._fire_hook(LifecycleHook.BEFORE_LOOP, context, {"input_text": input_text})

        while step_count < max_iterations:
            step_count += 1

            # 取消检查点：每步开头检查
            if context.is_cancelled():
                self._logger.info("ReAct loop cancelled by user", trace_id=context.trace_id, step=step_count)
                break

            # P0-修复1: ReAct 循环补感知 — 与主循环对齐，避免简单任务盲目执行。
            # 每步开头感知环境/情绪/场景，并将上一轮观察回灌感知形成闭环。
            if self._perception_bus is not None:
                try:
                    self.state = LoopState.PERCEIVING
                    _react_perception_extra: dict[str, Any] = {
                        "session_id": session_id,
                        "trace_id": context.trace_id,
                        "round": step_count,
                        "react_mode": True,
                    }
                    if structured_steps:
                        _last_step = structured_steps[-1]
                        _react_perception_extra["previous_results"] = [{
                            "success": _last_step.observation is not None,
                            "tool": _last_step.action.get("tool_name", ""),
                        }]
                    perception_state = await self._perception_bus.perceive(
                        user_input=input_text,
                        context=_react_perception_extra,
                    )
                    context.perception_state = perception_state
                    perception_text = perception_state.to_prompt_text()
                    if perception_text:
                        context.messages = [
                            m for m in context.messages
                            if not (m.get("role") == "system" and m.get("content", "").startswith("【当前感知状态】"))
                        ]
                        context.messages.insert(0, {"role": "system", "content": perception_text})
                    self.state = LoopState.EXECUTING
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController.run_react_loop.perceive", _exc)
                    self.state = LoopState.EXECUTING

            structured_step = await self._react_think_structured(input_text, context, step_count)
            structured_steps.append(structured_step)

            context.messages.append({
                "role": "assistant",
                "content": structured_step.to_context_message(),
            })

            if structured_step.is_final:
                self.state = LoopState.REPORTING
                final_answer = structured_step.action.get("final_answer", structured_step.thought)
                # P1-2: ReAct 对话后自动提取知识
                if self._knowledge_lifecycle and context.messages:
                    try:
                        asyncio.ensure_future(self._knowledge_lifecycle.ingest_dialog(
                            context.messages, session_id=session_id,
                        ))
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run_react_loop.knowledge_ingest", _exc)
                return AgentResult(
                    response=final_answer,
                    success=True,
                    metadata={
                        "thought_count": step_count,
                        "tool_calls": context.budget.tool_calls_used,
                        "react_mode": True,
                        "structured_steps": [s.to_dict() for s in structured_steps],
                    },
                )

            tool_name = structured_step.action.get("tool_name")
            tool_args = structured_step.action.get("tool_args", {})

            thought = ReActThought(
                text=structured_step.thought,
                tool_name=tool_name,
                tool_args=tool_args,
                is_final=False,
            )

            # P1 强化：Thought 质量评估 — 检测敷衍式推理，注入改进提示
            prev_obs = structured_steps[-1].observation if (len(structured_steps) > 1 and structured_steps[-1].observation) else None
            thought_score, thought_hint = self._evaluate_thought_quality(
                thought=structured_step.thought,
                observation=prev_obs,
                step_index=step_count,
            )
            if thought_hint:
                context.messages.append({
                    "role": "system",
                    "content": f"【推理质量提示】{thought_hint}",
                })

            action_result = await self._react_act(thought, context)

            observation = await self._react_observe(action_result, context)
            structured_step.observation = observation

            context.messages.append({
                "role": "system",
                "content": structured_step.to_context_message(),
            })

            # P0-3: ReAct循环中也应用注意力聚焦
            try:
                self._attention_focus.apply_to_context(context, max_messages=12)
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run_react_loop", _exc)

            if action_result.success and action_result.is_complete:
                self.state = LoopState.REPORTING
                # P1-2: ReAct 对话后自动提取知识
                if self._knowledge_lifecycle and context.messages:
                    try:
                        asyncio.ensure_future(self._knowledge_lifecycle.ingest_dialog(
                            context.messages, session_id=session_id,
                        ))
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run_react_loop.knowledge_ingest", _exc)

                # P1-1: 任务完成后自动复盘 — 调用反思引擎沉淀经验
                # 由 QualityScorer 自动计算满意度，低于阈值时触发深度反思。
                auto_reflect_enabled = os.environ.get("REACT_AUTO_REFLECT", "true").lower() == "true"
                if auto_reflect_enabled:
                    try:
                        await self._auto_reflect_on_completion(
                            context=context,
                            step_count=step_count,
                            success=True,
                            session_id=session_id,
                        )
                    except Exception as _exc:
                        log.debug("controller 异常处理", error=str(_exc))
                        log_ignored(log, "controller.LoopController.run_react_loop.auto_reflect", _exc)

                return AgentResult(
                    response=action_result.content or thought.text,
                    success=True,
                    metadata={
                        "thought_count": step_count,
                        "tool_calls": context.budget.tool_calls_used,
                        "react_mode": True,
                        "structured_steps": [s.to_dict() for s in structured_steps],
                    },
                )

            if not action_result.success:
                # P1 强化：多轮自纠错 — 从单次修正升级为「分析→修正→重试→降级」闭环
                correction_attempts = 0
                max_corrections = int(os.environ.get("REACT_MAX_CORRECTIONS", "2"))
                current_tool = thought.tool_name
                current_args = thought.tool_args or {}
                current_error = action_result.error or "unknown error"
                correction_succeeded = False

                while correction_attempts < max_corrections and current_tool:
                    correction_attempts += 1
                    reflection = await self.reflection.reflect(
                        tool_name=current_tool or "unknown",
                        args=current_args,
                        error=current_error,
                        context={"iteration": step_count, "correction_attempt": correction_attempts},
                    )

                    # 路径A：参数修正后重试原工具
                    if reflection.corrected_args and current_tool:
                        corrected_step = PlanStep(
                            step_id=f"react-correct-{step_count}-{correction_attempts}",
                            description=f"修正重试#{correction_attempts}: {thought.text[:100]}",
                            tool_name=current_tool,
                            tool_params=reflection.corrected_args,
                        )
                        corrected_result = await self.executor._execute_step(corrected_step, context)
                        if corrected_result.success:
                            obs_text = f"[观察] 第{correction_attempts}次修正后工具调用成功: {corrected_result.content[:200] if corrected_result.content else '完成'}"
                            context.messages.append({"role": "system", "content": obs_text})
                            correction_succeeded = True
                            # 记录成功经验
                            self.reflection.record_experience(
                                ExperienceEntry(
                                    tool_name=current_tool,
                                    args=reflection.corrected_args,
                                    error=current_error,
                                    root_cause=reflection.root_cause,
                                    resolution=f"第{correction_attempts}次参数修正成功",
                                    success=True,
                                )
                            )
                            break
                        # 修正后仍失败，更新错误信息进入下一轮
                        current_error = corrected_result.error or current_error
                        current_args = reflection.corrected_args
                        continue

                    # 路径B：替代工具降级
                    if reflection.alternative_tool and self.tool_registry:
                        alt_def = self.tool_registry.get_definition(reflection.alternative_tool) if hasattr(self.tool_registry, 'get_definition') else None
                        if alt_def or reflection.alternative_tool:
                            log.info(
                                "ReAct self-correction: switching to alternative tool",
                                original=current_tool,
                                alternative=reflection.alternative_tool,
                                attempt=correction_attempts,
                            )
                            alt_step = PlanStep(
                                step_id=f"react-alt-{step_count}-{correction_attempts}",
                                description=f"替代工具重试: {reflection.alternative_tool}",
                                tool_name=reflection.alternative_tool,
                                tool_params=reflection.corrected_args or {},
                            )
                            alt_result = await self.executor._execute_step(alt_step, context)
                            if alt_result.success:
                                obs_text = f"[观察] 替代工具 {reflection.alternative_tool} 调用成功: {alt_result.content[:200] if alt_result.content else '完成'}"
                                context.messages.append({"role": "system", "content": obs_text})
                                correction_succeeded = True
                                self.reflection.record_experience(
                                    ExperienceEntry(
                                        tool_name=current_tool,
                                        args=current_args,
                                        error=current_error,
                                        root_cause=reflection.root_cause,
                                        resolution=f"降级到替代工具 {reflection.alternative_tool} 成功",
                                        success=True,
                                    )
                                )
                                break
                            current_error = alt_result.error or current_error
                            current_tool = reflection.alternative_tool
                            current_args = reflection.corrected_args or {}
                            continue
                    break

                if not correction_succeeded:
                    obs_text = f"[观察] 工具调用失败，经{correction_attempts}次自纠错仍未能恢复: {current_error[:200]}"
                    context.messages.append({"role": "system", "content": obs_text})

                    # P0-2: 自纠错耗尽后自动触发动态重规划
                    # 当 ReAct 循环中工具失败且所有修正路径均失败时，
                    # 不再仅记录错误，而是触发 dynamic_dag_replanner 进行
                    # 任务级重规划（替换工具/降级策略/跳过非关键步骤）。
                    replan_enabled = os.environ.get("REACT_AUTO_REPLAN", "true").lower() == "true"
                    if replan_enabled and hasattr(self, '_replan_count'):
                        self._replan_count = getattr(self, '_replan_count', 0)
                        max_replans = int(os.environ.get("REACT_MAX_REPLAN", "2"))
                        if self._replan_count < max_replans:
                            try:
                                replan_hint = await self._auto_replan_on_failure(
                                    failed_tool=current_tool or "unknown",
                                    error=current_error,
                                    context=context,
                                    step_count=step_count,
                                )
                                if replan_hint:
                                    context.messages.append({
                                        "role": "system",
                                        "content": f"【自动重规划】{replan_hint}",
                                    })
                                    self._replan_count += 1
                                    self._logger.info(
                                        "P0-2 auto-replan triggered after correction exhaustion",
                                        failed_tool=current_tool,
                                        replan_count=self._replan_count,
                                    )
                            except Exception as _replan_exc:
                                log.debug("controller 异常处理", error=str(_replan_exc))
                                log_ignored(log, "controller.LoopController._react_observe.auto_replan", _replan_exc)

        self.state = LoopState.REPORTING
        # P1-2: ReAct 对话后自动提取知识（达到最大迭代次数也提取）
        if self._knowledge_lifecycle and context.messages:
            try:
                asyncio.ensure_future(self._knowledge_lifecycle.ingest_dialog(
                    context.messages, session_id=session_id,
                ))
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController.run_react_loop.knowledge_ingest", _exc)
        return AgentResult(
            response=context.messages[-1].get("content", "") if context.messages else "达到最大迭代次数",
            success=False,
            metadata={
                "thought_count": step_count,
                "tool_calls": context.budget.tool_calls_used,
                "react_mode": True,
                "reason": "max_iterations_reached",
                "structured_steps": [s.to_dict() for s in structured_steps],
            },
        )

    async def _react_think_structured(
        self,
        input_text: str,
        context: LoopContext,
        step_index: int,
    ) -> StructuredReActStep:
        """P1-1: 结构化 ReAct Thought — 要求 LLM 输出显式 JSON。"""
        import json as _json

        tool_list = self._build_react_tool_list()

        system_prompt = (
            "你是一个智能助手，使用结构化 ReAct 模式工作。\n"
            "在每一步，你必须输出一个 JSON 对象，包含以下字段：\n"
            '- "thought": 你的推理过程（字符串）\n'
            '- "action": 你的行动决策（对象）\n'
            "  - 如果需要调用工具: {\"tool_name\": \"工具名\", \"tool_args\": {参数}}\n"
            '  - 如果可以给出最终回答: {"final_answer": "最终回答内容"}\n\n'
            f"可用工具: {tool_list}\n\n"
            "重要：只输出 JSON 对象，不要输出其他内容。"
        )

        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(context.messages[-10:])
        messages.append({"role": "user", "content": f"当前任务: {input_text}"})

        # 灰度发布：从 LoopContext 读取 user_id/strategy_name 传递到 llm.chat，
        # 触发 CanaryReleaseManager.select_version 进行哈希分桶选择版本
        # 能力驱动路由（W1/U2 最后一公里）：透传 task_type 触发 CapabilityAwareRouter
        # 任务级选型，使主 ReAct 推理落在与任务画像匹配的模型上。
        result = await self.llm.chat(
            messages=messages,
            use_cache=False,
            user_id=context.user_id,
            strategy_name=context.strategy_name,
            task_type=context.task_type,
        )
        content = result.get("content", "")

        return self._parse_structured_react(content, step_index)

    def _parse_structured_react(self, content: str, step_index: int) -> StructuredReActStep:
        """P1-1: 解析 LLM 输出为 StructuredReActStep，带回退到正则解析。"""
        import json as _json

        step = StructuredReActStep(step_index=step_index)

        json_str = content.strip()
        if json_str.startswith("```"):
            lines = json_str.split("\n")
            json_str = "\n".join(lines[1:-1] if len(lines) > 2 else lines)

        try:
            parsed = _json.loads(json_str)
            step.thought = parsed.get("thought", "")
            step.action = parsed.get("action", {})
            step.is_final = "final_answer" in step.action
            return step
        except (_json.JSONDecodeError, TypeError) as _exc:
            log_ignored(log, "controller.LoopController._parse_structured_react", _exc)

        try:
            start = content.find("{")
            end = content.rfind("}") + 1
            if start >= 0 and end > start:
                parsed = _json.loads(content[start:end])
                step.thought = parsed.get("thought", "")
                step.action = parsed.get("action", {})
                step.is_final = "final_answer" in step.action
                return step
        except (_json.JSONDecodeError, TypeError) as _exc:
            log_ignored(log, "controller.LoopController._parse_structured_react", _exc)

        legacy = self._parse_react_thought(content)
        step.thought = legacy.text
        if legacy.is_final:
            step.action = {"final_answer": legacy.final_answer or legacy.text}
            step.is_final = True
        elif legacy.tool_name:
            step.action = {"tool_name": legacy.tool_name, "tool_args": legacy.tool_args or {}}
        return step

    def _evaluate_thought_quality(
        self,
        thought: str,
        observation: str | None = None,
        step_index: int = 0,
    ) -> tuple[float, str | None]:
        """P1 强化：评估 Thought 推理质量，检测敷衍式推理。

        Returns:
            (quality_score, improvement_hint) — score ∈ [0,1]，hint 为 None 表示质量合格。
        """
        if not thought or len(thought.strip()) < 10:
            return 0.2, "Thought 过短，请详细分析当前状态和下一步行动的理由"

        # 检查是否引用了上一步的 Observation
        if observation and step_index > 0:
            obs_keywords = [w for w in observation[:200] if len(w) > 2]
            references_obs = any(kw in thought for kw in observation[:80])
            if not references_obs:
                return 0.4, "Thought 未引用上一步观察结果，请基于 Observation 分析"

        # 检查是否是模板化推理（仅说"我需要调用XX工具"）
        template_patterns = ["我需要调用", "我将使用", "让我用", "调用工具"]
        is_template = any(p in thought for p in template_patterns) and len(thought) < 30
        if is_template:
            return 0.3, "Thought 过于简略，请说明为什么选择这个工具以及预期效果"

        return 0.8, None

    async def _react_act(
        self,
        thought: ReActThought,
        context: LoopContext,
    ) -> ReActActionResult:
        """ReAct Action 阶段: 执行工具调用。"""
        if not thought.tool_name or not self._tool_registry_available():
            return ReActActionResult(
                success=False,
                content=thought.final_answer or "",
                error="No tool specified",
                is_complete=bool(thought.final_answer),
            )

        step = PlanStep(
            step_id=f"react-{context.budget.rounds_used}",
            description=thought.text[:200],
            tool_name=thought.tool_name,
            tool_params=thought.tool_args,
        )

        result = await self.executor._execute_step(step, context)
        context.budget.tool_calls_used += 1

        if result.success:
            context.step_results[step.step_id] = result

        return ReActActionResult(
            success=result.success,
            content=result.content,
            error=result.error,
            is_complete=False,
        )

    async def _react_observe(
        self,
        action_result: ReActActionResult,
        context: LoopContext,
    ) -> str:
        """ReAct Observation 阶段: 观察执行结果。

        P0-1 增强：当 action_result.success=True 但质量评分低于阈值时，
        自动触发 build_correction_prompt 生成修正提示注入上下文，
        实现「验证→修正→重执行」的反思闭环，而非仅记录。
        """
        if action_result.success:
            content_preview = (action_result.content or "")[:500]
            observation = f"[观察] 工具调用成功。结果: {content_preview}"

            quality_threshold = float(os.environ.get("REACT_QUALITY_THRESHOLD", "0.5"))
            if quality_threshold > 0 and self._quality_scorer is not None:
                try:
                    quality_report = self._quality_scorer.score(
                        step_results=context.step_results,
                        planned_steps=0,
                        rounds_used=context.budget.rounds_used,
                        reflection_experiences=len(self.reflection._experiences) if hasattr(self.reflection, '_experiences') else 0,
                        context_message_count=len(context.messages),
                    )
                    if quality_report.overall_score < quality_threshold:
                        correction_prompt = (
                            f"【质量修正】当前执行质量评分为 {quality_report.overall_score:.2f}，"
                            f"低于阈值 {quality_threshold}。"
                            f"\n各维度得分: {', '.join(f'{k}={v:.2f}' for k, v in quality_report.breakdown.items())}"
                            f"\n请分析原因并改进下一步行动策略。"
                        )
                        context.messages.append({
                            "role": "system",
                            "content": correction_prompt,
                        })
                        observation += f"\n[质量告警] 评分 {quality_report.overall_score:.2f} < 阈值 {quality_threshold}，已注入修正提示"
                        self._logger.info(
                            "P0-1 correction loop triggered in _react_observe",
                            overall_score=quality_report.overall_score,
                            threshold=quality_threshold,
                        )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController._react_observe.quality_check", _exc)

            return observation
        else:
            return f"[观察] 工具调用失败。错误: {action_result.error or '未知错误'}"

    def _tool_registry_available(self) -> bool:
        return self.tool_registry is not None

    def _should_use_react(self, input_text: str) -> bool:
        """P1-3: 判断是否使用 ReAct 模式而非 Plan→Exec→Eval。

        语义化判断逻辑：
        - 含明确工具指示词的单步骤任务 → ReAct
        - 多步骤复杂任务（含2+个"然后/接着/并且"）→ Plan→Exec→Eval
        - 其他默认走 Plan→Exec→Eval（更可控）
        """
        # 多步骤指示词 → 不使用 ReAct，走 Plan→Exec→Eval
        multi_step_indicators = ["然后", "接着", "并且", "之后", "最后", "第一步", "第二步", "先", "再"]
        multi_step_count = sum(1 for kw in multi_step_indicators if kw in input_text)
        if multi_step_count >= 2:
            return False

        # 单步骤工具指示词 → 使用 ReAct
        react_indicators = [
            "搜索", "查找", "查询", "搜索一下", "找一下",
            "读取", "打开", "看看",
            "天气", "新闻", "时间",
            "翻译", "计算",
        ]
        for kw in react_indicators:
            if kw in input_text:
                return True

        # 默认走 Plan→Exec→Eval（更可控，支持重规划和反思）
        return False

    async def _confirm_react_mode(self, input_text: str) -> bool:
        """审计 B-01：语义分析二次确认 ReAct 模式。

        关键词匹配可能误判（如"搜索最近的文档并分析趋势"），
        通过 planner 的语义分析做权威确认。仅当两套判定一致时才使用 ReAct。

        优化：高置信关键词（天气/时间/翻译/计算）直接通过，省 1 次 LLM 调用。
        """
        # 高置信关键词：无需语义确认，直接通过
        high_confidence_kw = ["天气", "新闻", "时间", "翻译", "计算", "几点"]
        if any(kw in input_text for kw in high_confidence_kw):
            return True

        # 多步骤指示词存在时也无需确认（已经判定为非 ReAct）
        multi_step_indicators = ["然后", "接着", "并且", "之后", "最后", "第一步", "第二步"]
        if any(kw in input_text for kw in multi_step_indicators):
            return False

        try:
            complexity = await self.planner._analyze_complexity_semantic(input_text)
            return complexity == "simple"
        except Exception as _exc:
            log.warning("异常降级处理", error=str(_exc))
            return True  # 语义分析失败时信任关键词判定

    def _derive_task_type(self, input_text: str) -> str:
        """从输入文本推导任务类型，用于时间预算预估分类。

        P2 #15: 将任务分为 react / simple / moderate / complex 四类，
        与历史执行记录的 task_type 字段对齐，使 estimate_execution_time
        能按类型过滤历史样本。

        Args:
            input_text: 用户输入文本。

        Returns:
            str: 任务类型标识（react/simple/moderate/complex）。
        """
        if self._should_use_react(input_text):
            return "react"
        try:
            complexity = self.planner._analyze_complexity(input_text)
            return complexity  # "simple" / "moderate" / "complex"
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            return "moderate"

    def _compute_complexity(self, input_text: str | None) -> float | None:
        """基于关键词密度估算任务复杂度（0.0-1.0）。

        用于 trajectory_db.estimate_execution_time 的 complexity 参数，
        使历史预估能根据任务难度做线性调整。

        Args:
            input_text: 用户输入文本，None 时返回 None。

        Returns:
            float | None: 复杂度分值（0.0-1.0），None 表示未提供输入。
        """
        if not input_text:
            return None
        try:
            # 复用 planner 的关键词复杂度评分（返回命中的关键词数）
            raw_score = self.planner._keyword_complexity_score(input_text)
            # 归一化到 0.0-1.0：5+ 个关键词命中即视为最高复杂度
            return min(1.0, raw_score / 5.0)
        except Exception as _exc:
            log.warning("异常降级处理", error=str(_exc))
            return None

    def _detect_agent_native(self) -> bool:
        """检测当前 LLM 是否具备原生 Agent 能力。

        通过 LLMCapabilityDetector 探测当前模型的 agent_native 标志。
        探测失败时安全降级为 False（走传统重编排路径）。

        可通过环境变量 AGENT_NATIVE_FORCE_DISABLE=true 强制关闭，
        即使模型具备原生 Agent 能力也走传统重编排路径。

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
        except Exception as _exc:
            log.warning("异常降级处理", error=str(_exc))
            return False

    def _resolve_budget_max_duration(self, task_type: str, input_text: str | None = None) -> int:
        """解析预算最大执行时长（毫秒）。

        P2 #15: 优先调用 trajectory_db.estimate_execution_time 获取历史预估，
        并传入 complexity 参数实现难度感知；样本充足时通过
        ConstraintsService.resolve_adaptive_budget 计算 max_duration_ms
        （= estimated_ms * 1.2）；样本不足或异常时降级到
        AdaptiveBudgetConfig 静态配置。任何异常都不影响主流程，回退到默认 60000ms。

        Args:
            task_type: 任务类型标识。
            input_text: 用户输入文本，用于计算复杂度（可选）。

        Returns:
            int: 最大执行时长（毫秒）。
        """
        # 优先使用历史预估 + ConstraintsService.resolve_adaptive_budget
        if self.trajectory_db:
            try:
                complexity = self._compute_complexity(input_text)
                estimate = self.trajectory_db.estimate_execution_time(
                    task_type, complexity=complexity
                )
                if estimate is not None and self.constraints_service:
                    allocation = self.constraints_service.resolve_adaptive_budget(
                        task_type, historical_estimate=estimate
                    )
                    return allocation.max_duration_ms
                if estimate is not None:
                    return int(estimate.estimated_ms * 1.2)
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController._resolve_budget_max_duration", _exc)

        # 降级到 ConstraintsService.resolve_adaptive_budget 静态配置
        if self.constraints_service:
            try:
                allocation = self.constraints_service.resolve_adaptive_budget(task_type)
                return allocation.max_duration_ms
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController._resolve_budget_max_duration", _exc)

        # 最终兜底：AdaptiveBudgetConfig 静态默认值
        try:
            config = AdaptiveBudgetConfig()
            base_map = {
                "simple": config.simple,
                "moderate": config.moderate,
                "complex": config.complex,
                "react": config.simple,  # react 任务按简单任务处理
            }
            allocation = base_map.get(task_type, config.moderate)
            return allocation.max_duration_ms
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            return 60000  # BudgetAllocation 默认 max_duration_ms

    def _build_react_tool_list(self) -> str:
        if not self.tool_registry:
            return "（无可用工具）"
        definitions = self.tool_registry.get_all_definitions()
        if not definitions:
            return "（无可用工具）"
        return ", ".join(f"{d.name}({d.description[:30]})" for d in definitions[:15])

    def _parse_react_thought(self, content: str) -> ReActThought:
        """解析 LLM 输出为 ReActThought。"""
        import re as _re

        thought_text = content
        tool_name = None
        tool_args = None
        final_answer = None

        thought_match = _re.search(r"Thought:\s*(.+?)(?=\n(?:Action|Final)|$)", content, _re.DOTALL)
        if thought_match:
            thought_text = thought_match.group(1).strip()

        action_match = _re.search(r"Action:\s*(\S+)", content)
        if action_match:
            tool_name = action_match.group(1).strip()

        args_marker = _re.search(r"Args:\s*", content)
        if args_marker:
            brace_start = content.find("{", args_marker.end())
            if brace_start != -1:
                # 平衡括号扫描：支持嵌套 JSON 参数（如 {"filters": {"type": "x"}}）。
                # 旧正则 (\{.+?\}) 为非贪婪，遇首个 } 即截断，导致嵌套参数被截断为非法 JSON 而整体丢失。
                depth = 0
                in_str = False
                escaped = False
                i = brace_start
                n = len(content)
                while i < n:
                    ch = content[i]
                    if in_str:
                        if escaped:
                            escaped = False
                        elif ch == "\\":
                            escaped = True
                        elif ch == '"':
                            in_str = False
                    else:
                        if ch == '"':
                            in_str = True
                        elif ch == "{":
                            depth += 1
                        elif ch == "}":
                            depth -= 1
                            if depth == 0:
                                try:
                                    import json as _json
                                    tool_args = _json.loads(content[brace_start : i + 1])
                                except Exception as _exc:
                                    log.debug("controller 异常处理", error=str(_exc))
                                    tool_args = {}
                                break
                    i += 1

        final_match = _re.search(r"Final Answer:\s*(.+?)$", content, _re.DOTALL)
        if final_match:
            final_answer = final_match.group(1).strip()

        return ReActThought(
            text=thought_text,
            tool_name=tool_name,
            tool_args=tool_args,
            is_final=bool(final_answer),
            final_answer=final_answer,
        )

    async def _lightweight_reflection_round(
        self,
        step_results: list[StepResult],
        context: LoopContext,
    ) -> None:
        """每轮执行后的轻量级反思。

        对本轮所有步骤进行快速反思，总结成功经验和失败教训。
        设计目标：<500ms，不阻塞主流程，失败时静默降级。

        Args:
            step_results: 本轮步骤结果列表。
            context: 循环上下文。
        """
        # 检查是否启用轻量级反思
        if not os.environ.get("LIGHTWEIGHT_REFLECTION_ENABLED", "true").lower() == "true":
            return

        try:
            # 对每个步骤进行轻量级反思
            for sr in step_results:
                if not sr.tool_name:
                    continue

                # 异步执行反思（实际是同步但很快）
                reflection = await self.reflection.lightweight_reflect(
                    tool_name=sr.tool_name,
                    success=sr.success,
                    args=sr.tool_params,
                    result=sr.content or "",
                    error=sr.error or "",
                    context={
                        "traceId": context.trace_id,
                        "round": context.budget.rounds_used,
                        "step_id": sr.step_id,
                    },
                )

                # 如果是成功且有价值的洞察，注入到上下文供后续使用
                if sr.success and reflection.key_learning:
                    # 只在第一轮或有重要洞察时才注入，避免上下文膨胀
                    if context.budget.rounds_used <= 2 or "重要" in reflection.key_learning:
                        context.messages.append({
                            "role": "system",
                            "content": f"【经验提示】{reflection.key_learning}",
                        })

                # 记录到隐式反馈
                try:
                    self._feedback_collector.record_signal(
                        signal_type=FeedbackType.POSITIVE if sr.success else FeedbackType.NEGATIVE,
                        strength=FeedbackStrength.LOW,
                        source=FeedbackSource.LEARNING,
                        confidence=0.5,
                        metadata={
                            "tool_name": sr.tool_name,
                            "reflection_type": "lightweight",
                            "insight": reflection.key_learning,
                        },
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController._lightweight_reflection_round", _exc)

        except Exception as e:
            log.debug("controller 异常处理", error=str(e))
            # 静默降级，不影响主流程
            try:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").debug("Lightweight reflection failed", error=str(e))
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController._lightweight_reflection_round", _exc)

    async def _verify_execution(
        self,
        input_text: str,
        context: LoopContext,
        executor_output: ExecutorOutput,
    ) -> dict[str, Any] | None:
        """语义验证阶段 — 即使轻量模式也执行最小语义验证。

        验证维度：
        1. 输出是否回答了用户问题（相关性）
        2. 是否存在自相矛盾（一致性）
        3. 是否包含已知错误模式（安全性）

        轻量模式：SemanticVerifier minimal + 规则验证（<100ms）
        完整模式：SemanticVerifier thorough + 规则验证 + LLM 语义验证（<2s）

        Returns:
            dict | None: {"passed": bool, "score": float, "feedback": str}
        """
        if not context.step_results:
            return {"passed": True, "score": 1.0, "feedback": ""}

        rule_result = self._verify_by_rules(input_text, context, executor_output)

        verification_level = getattr(context.budget, "verification_level", "full")

        # Phase 3+4: SemanticVerifier 增强验证 — 即使轻量模式也执行最小语义验证
        try:
            all_content = " ".join(
                (sr.content or "") for sr in context.step_results.values()
            )
            if all_content.strip():
                sv_level = VerificationLevel.MINIMAL if verification_level == "light" else VerificationLevel.STANDARD
                sv_result = await self._semantic_verifier.verify(
                    input_text=input_text,
                    output=all_content,
                    context=context,
                    level=sv_level,
                )
                if not sv_result.passed:
                    sv_feedback = "; ".join(
                        f"[{i.issue_type}] {i.description}"
                        for i in sv_result.issues
                        if i.severity.value in ("error", "critical", "warning")
                    )
                    combined_score = rule_result["score"] * 0.5 + sv_result.score * 0.5
                    passed = combined_score >= 0.5
                    feedback_parts = []
                    if rule_result.get("feedback"):
                        feedback_parts.append(rule_result["feedback"])
                    if sv_feedback:
                        feedback_parts.append(sv_feedback)
                    rule_result = {
                        "passed": passed,
                        "score": combined_score,
                        "feedback": "; ".join(feedback_parts) if not passed else "",
                    }
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController._verify_execution.semantic_verifier", _exc)

        if verification_level == "light":
            return rule_result

        try:
            llm_result = await self._verify_by_llm(input_text, context)
            if llm_result:
                combined_score = rule_result["score"] * 0.4 + llm_result["score"] * 0.6
                passed = combined_score >= 0.5
                feedback_parts = []
                if rule_result.get("feedback"):
                    feedback_parts.append(rule_result["feedback"])
                if llm_result.get("feedback"):
                    feedback_parts.append(llm_result["feedback"])
                return {
                    "passed": passed,
                    "score": combined_score,
                    "feedback": "; ".join(feedback_parts) if not passed else "",
                }
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController._verify_execution.llm", _exc)

        return rule_result

    def _verify_by_rules(
        self,
        input_text: str,
        context: LoopContext,
        executor_output: ExecutorOutput,
    ) -> dict[str, Any]:
        """规则验证：快速检查输出质量。"""
        issues: list[str] = []
        score = 1.0

        failed_count = sum(1 for sr in context.step_results.values() if not sr.success)
        total_count = len(context.step_results)
        if total_count > 0 and failed_count > 0:
            fail_ratio = failed_count / total_count
            score -= fail_ratio * 0.5
            if fail_ratio > 0.5:
                issues.append(f"超过半数步骤失败({failed_count}/{total_count})")

        all_content = " ".join(
            (sr.content or "") for sr in context.step_results.values()
        )
        if not all_content.strip() and total_count > 0:
            issues.append("所有步骤均无有效输出")
            score -= 0.3

        error_patterns = ["error", "exception", "failed", "timeout", "错误", "异常", "超时", "失败"]
        error_count = sum(1 for p in error_patterns if p.lower() in all_content.lower())
        if error_count > 3:
            issues.append(f"输出中包含多个错误关键词({error_count}个)")
            score -= 0.1

        score = max(0.0, min(1.0, score))
        return {
            "passed": score >= 0.5 and len(issues) == 0,
            "score": score,
            "feedback": "; ".join(issues) if issues else "",
        }

    async def _verify_by_llm(
        self,
        input_text: str,
        context: LoopContext,
    ) -> dict[str, Any] | None:
        """LLM 语义验证：检查输出是否回答了用户问题。"""
        all_content = " ".join(
            (sr.content or "")[:200] for sr in list(context.step_results.values())[-5:]
        )
        if not all_content.strip():
            return None

        prompt = (
            "验证以下执行结果是否有效回答了用户问题，返回JSON：\n"
            '{"passed": true/false, "score": 0.0-1.0, "feedback": "问题描述（如有）"}\n\n'
            f"用户问题: {input_text[:300]}\n"
            f"执行结果: {all_content[:500]}"
        )
        try:
            result = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=True,
                task_type="cheap",
            )
            content = result.get("content", "")
            import json
            import re
            match = re.search(r'\{[\s\S]*\}', content)
            if match:
                parsed = json.loads(match.group())
                return {
                    "passed": bool(parsed.get("passed", True)),
                    "score": float(parsed.get("score", 0.7)),
                    "feedback": parsed.get("feedback", ""),
                }
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController._verify_by_llm", _exc)
        return None

    async def _auto_reflect_on_completion(
        self,
        context: LoopContext,
        step_count: int,
        success: bool,
        session_id: str = "",
    ) -> None:
        """P1-1: 任务完成后自动复盘，沉淀经验到长期记忆。

        当 QualityScorer 评分低于阈值时触发深度反思，
        否则仅做轻量级经验记录。

        Args:
            context: 当前循环上下文。
            step_count: 总步骤数。
            success: 任务是否成功。
            session_id: 会话 ID。
        """
        reflect_threshold = float(os.environ.get("REACT_REFLECT_THRESHOLD", "0.7"))

        quality_report = None
        if self._quality_scorer is not None:
            try:
                quality_report = self._quality_scorer.score(
                    step_results=context.step_results,
                    planned_steps=0,
                    rounds_used=context.budget.rounds_used,
                    reflection_experiences=len(self.reflection._experiences) if hasattr(self.reflection, '_experiences') else 0,
                    context_message_count=len(context.messages),
                )
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller._auto_reflect_on_completion.quality_score", _exc)

        overall_score = quality_report.overall_score if quality_report else 0.5

        if overall_score < reflect_threshold:
            try:
                summary_parts = []
                for sid, sr in context.step_results.items():
                    status = "成功" if sr.success else "失败"
                    summary_parts.append(f"  - {sr.tool_name or sid}: {status}")
                task_summary = "\n".join(summary_parts) if summary_parts else "无步骤记录"

                reflection = await self.reflection.reflect(
                    tool_name="task_completion_review",
                    args={"step_count": step_count, "success": success},
                    error=f"任务质量评分 {overall_score:.2f} 低于阈值 {reflect_threshold}" if not success else "",
                    context={
                        "quality_score": overall_score,
                        "task_summary": task_summary,
                        "session_id": session_id,
                    },
                )

                self.reflection.record_experience(
                    ExperienceEntry(
                        tool_name="auto_reflect",
                        args={"quality_score": overall_score},
                        error="",
                        root_cause=reflection.root_cause,
                        resolution=reflection.corrected_args and "参数已修正" or "经验已沉淀",
                        success=True,
                    )
                )

                self._logger.info(
                    "P1-1 auto-reflect on completion",
                    quality_score=overall_score,
                    threshold=reflect_threshold,
                    root_cause=reflection.root_cause,
                )
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller._auto_reflect_on_completion.deep_reflect", _exc)
        else:
            self._logger.debug(
                "P1-1 task completed with good quality, skip deep reflection",
                quality_score=overall_score,
                threshold=reflect_threshold,
            )

    async def _auto_replan_on_failure(
        self,
        failed_tool: str,
        error: str,
        context: LoopContext,
        step_count: int,
    ) -> str | None:
        """P0-2: 自纠错耗尽后自动触发重规划。

        当 ReAct 循环中工具失败且所有修正路径（参数修正/替代工具降级）均失败时，
        调用此方法生成重规划提示，引导 LLM 在下一步选择完全不同的策略。

        重规划策略优先级：
        1. 替代工具建议（基于 ReflectionEngine 的 alternative_tool）
        2. 任务分解建议（将当前步骤拆为更小的子步骤）
        3. 降级策略建议（跳过非关键步骤或使用简化方案）

        Args:
            failed_tool: 失败的工具名称。
            error: 错误信息。
            context: 当前循环上下文。
            step_count: 当前步骤计数。

        Returns:
            重规划提示文本，或 None（无法生成时）。
        """
        strategies: list[str] = []

        if self.tool_registry and hasattr(self.tool_registry, 'list_tools'):
            try:
                all_tools = self.tool_registry.list_tools()
                similar_tools = [
                    t for t in all_tools
                    if t != failed_tool and any(
                        kw in t for kw in failed_tool.split("_") if len(kw) > 2
                    )
                ]
                if similar_tools:
                    strategies.append(
                        f"替代工具: 可尝试 {', '.join(similar_tools[:3])} 替代 {failed_tool}"
                    )
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller._auto_replan_on_failure.similar_tools", _exc)

        strategies.append(
            f"任务分解: 将当前步骤拆分为更小的子步骤，逐步验证"
        )
        strategies.append(
            f"降级策略: 跳过非关键步骤，或使用简化方案完成核心目标"
        )

        hint = (
            f"工具 {failed_tool} 在第 {step_count} 步失败且自纠错耗尽。"
            f"\n错误: {error[:200]}"
            f"\n建议策略（按优先级）:\n" +
            "\n".join(f"  {i+1}. {s}" for i, s in enumerate(strategies))
        )
        return hint

    async def _reflect_on_failure(
        self,
        failed_step: StepResult,
        context: LoopContext,
    ) -> None:
        reflection = await self.reflection.reflect(
            tool_name=failed_step.tool_name or "unknown",
            args={},
            error=failed_step.error or "未知错误",
            context={
                "traceId": context.trace_id,
                "loopCount": context.budget.rounds_used,
            },
        )

        self.reflection.record_experience(
            ExperienceEntry(
                tool_name=failed_step.tool_name or "unknown",
                args={},
                error=failed_step.error or "",
                root_cause=reflection.root_cause,
                resolution="修正参数后重试" if reflection.corrected_args else ("重试" if reflection.should_retry else "不重试"),
                success=reflection.should_retry,
            )
        )

        self._last_reflection_insight = {
            "rootCause": reflection.root_cause,
            "correctedArgs": reflection.corrected_args,
            "shouldRetry": reflection.should_retry,
            "alternativeTool": reflection.alternative_tool,
        }

    async def _safe_build_causal(self, input_text: str) -> CausalGraph | None:
        try:
            return await self.causal.build_causal_model(input_text)
        except Exception as _exc:
            log.warning("异常降级处理", error=str(_exc))
            return None

    def _get_debater(self) -> DefaultDebater | None:
        """延迟初始化 Debater：仅在首次 complex 计划审查时创建。"""
        if not self._debater_enabled:
            return None
        if self._debater is None:
            self._debater = DefaultDebater(llm=self.llm)
            self._logger.info("Debater lazy-initialized for plan quality review")
        return self._debater

    @property
    def causal(self) -> CausalModeler:
        """延迟初始化 CausalModeler：仅在首次 complex 计划需要因果分析时创建。"""
        if self._causal is None:
            self._causal = CausalModeler(self.llm)
            self._logger.info("CausalModeler lazy-initialized")
        return self._causal

    async def _async_record_transition(
        self, trace_id: str, from_state: str, to_state: str, reason: str,
    ) -> None:
        """异步记录状态转换，避免阻塞主循环。"""
        try:
            self.trajectory_db.record_state_transition(StateTransitionRecord(
                execution_id=trace_id,
                from_state=from_state,
                to_state=to_state,
                reason=reason,
            ))
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController._async_record_transition", _exc)

    async def _async_record_tool(
        self, trace_id: str, step_index: int, sr: StepResult,
    ) -> None:
        """异步记录工具调用，避免阻塞主循环。"""
        try:
            self.trajectory_db.record_tool_invocation(ToolInvocationRecord(
                execution_id=trace_id,
                step_index=step_index,
                tool_name=sr.tool_name or "unknown",
                args_json="{}",
                result_success=1 if sr.success else 0,
                result_output=(sr.content or "")[:500],
                duration=int(sr.duration_ms) if sr.duration_ms else 0,
                error_message=sr.error,
            ))
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController._async_record_tool", _exc)

    async def _record_signals_async(
        self,
        quality_score: float,
        context: LoopContext,
        trace_id: str,
    ) -> None:
        """异步批量记录学习信号，解耦主流程。

        将 6-8 次 evolution.record_signal() 调用从 Reporting 热路径移出，
        通过 asyncio.ensure_future 在后台执行，不阻塞 AgentResult 返回。
        """
        try:
            from agent.evolution.types import LearningSignal, SignalType
            import time as _t

            signals: list[LearningSignal] = []
            now = _t.time()

            if quality_score >= 0.6:
                signals.append(LearningSignal(
                    signal_type=SignalType.TASK_SUCCESS,
                    quality=quality_score,
                    timestamp=now,
                ))
                try:
                    self._feedback_collector.record_signal(
                        signal_type=FeedbackType.POSITIVE,
                        strength=FeedbackStrength.MEDIUM,
                        source=FeedbackSource.SATISFACTION,
                        confidence=0.6,
                        metadata={"quality_score": quality_score},
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController._record_signals_async", _exc)
            else:
                signals.append(LearningSignal(
                    signal_type=SignalType.TASK_FAILURE,
                    error="Loop quality below threshold",
                    timestamp=now,
                ))
                try:
                    self._feedback_collector.record_signal(
                        signal_type=FeedbackType.NEGATIVE,
                        strength=FeedbackStrength.MEDIUM,
                        source=FeedbackSource.RETRY,
                        confidence=0.6,
                        metadata={"quality_score": quality_score},
                    )
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController._record_signals_async", _exc)

            for sr in context.step_results.values():
                if sr.tool_name:
                    signals.append(LearningSignal(
                        signal_type=SignalType.POSITIVE if sr.success else SignalType.NEGATIVE,
                        tool_name=sr.tool_name,
                        quality=1.0 if sr.success else 0.0,
                        error=sr.error,
                        timestamp=now,
                    ))

            plan_quality = 0.5
            try:
                planned_steps = len(context.plan.steps) if context.plan and context.plan.steps else 0
                executed_steps = len(context.step_results)
                if planned_steps > 0:
                    plan_quality = min(1.0, max(0.0, executed_steps / planned_steps))
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController._record_signals_async", _exc)
            signals.append(LearningSignal(
                signal_type=SignalType.PLAN_QUALITY,
                quality=plan_quality,
                metadata={"planned_steps": plan_quality * 10, "executed_steps": len(context.step_results)},
                timestamp=now,
            ))

            tool_stats: dict[str, list[int]] = {}
            for sr in context.step_results.values():
                if sr.tool_name:
                    if sr.tool_name not in tool_stats:
                        tool_stats[sr.tool_name] = [0, 0]
                    tool_stats[sr.tool_name][1] += 1
                    if sr.success:
                        tool_stats[sr.tool_name][0] += 1
            for tname, counts in tool_stats.items():
                signals.append(LearningSignal(
                    signal_type=SignalType.TOOL_SELECTION_QUALITY,
                    tool_name=tname,
                    quality=counts[0] / counts[1] if counts[1] > 0 else 0.0,
                    timestamp=now,
                ))

            if self.reflection and hasattr(self.reflection, '_experience_store'):
                exp_count = len(self.reflection._experience_store) if self.reflection._experience_store else 0
                if exp_count > 0:
                    signals.append(LearningSignal(
                        signal_type=SignalType.REFLECTION_EFFECTIVENESS,
                        quality=min(1.0, exp_count / 10.0),
                        metadata={"experience_count": exp_count},
                        timestamp=now,
                    ))

            if context.messages and len(context.messages) <= 10:
                signals.append(LearningSignal(
                    signal_type=SignalType.CONTEXT_COMPRESSION_SUCCESS,
                    quality=1.0,
                    metadata={"message_count": len(context.messages)},
                    timestamp=now,
                ))

            for sig in signals:
                try:
                    self.evolution.record_signal(sig)
                except Exception as _exc:
                    log.debug("controller 异常处理", error=str(_exc))
                    log_ignored(log, "controller.LoopController._record_signals_async", _exc)

            try:
                feedback_stats = self._feedback_collector.get_statistics()
                if hasattr(self.evolution, 'record_implicit_feedback'):
                    self.evolution.record_implicit_feedback(feedback_stats)
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController._record_signals_async", _exc)
        except Exception as _exc:
            log.debug("controller 异常处理", error=str(_exc))
            log_ignored(log, "controller.LoopController._record_signals_async", _exc)

    async def _deep_reflect(
        self,
        input_text: str,
        context: LoopContext,
        eval_result: EvaluatorOutput,
    ) -> None:
        trajectory: list[dict[str, Any]] = []
        for sr in context.step_results.values():
            trajectory.append({
                "toolName": sr.tool_name or "unknown",
                "success": sr.success,
                "error": sr.error,
                "output": sr.content[:100] if sr.content else None,
            })

        deep_result = await self.reflection.deep_reflect(
            user_input=input_text,
            trajectory=trajectory,
            eval_result={
                "goalProgress": eval_result.goal_progress,
                "suggestedAction": eval_result.suggested_action,
                "reason": eval_result.reason,
            },
        )

        self._last_reflection_insight = {
            "rootCause": deep_result.root_cause,
            "diagnosis": deep_result.diagnosis,
            "fixStrategy": deep_result.fix_strategy,
            "correctedPlan": deep_result.corrected_plan,
        }

    def _inject_plan_into_context(
        self, plan: ExecutionPlan, context: LoopContext
    ) -> None:
        context.messages = [
            m
            for m in context.messages
            if not (m.get("role") == "system" and m.get("content", "").startswith("【执行计划】"))
        ]

        steps_text = "\n".join(
            f"{i + 1}. {s.description}"
            + (f" (使用 {s.tool_name})" if s.tool_name else "")
            for i, s in enumerate(plan.steps)
        )

        parts = ["【执行计划】"]
        if plan.reasoning:
            parts.append(f"任务分析: {plan.reasoning[:500]}")
            parts.append("")
        parts.append(f"执行步骤:\n{steps_text}")
        parts.append("\n你可以根据实际情况调整执行顺序或跳过不需要的步骤。")

        context.messages.append({"role": "system", "content": "\n".join(parts)})

    async def _try_mcts_replan(
        self, input_text: str, context: LoopContext
    ) -> "ExecutionPlan | None":
        """P1-修复5: MCTS 升级路径 — 辩论 ESCALATE 时用蒙特卡洛树搜索重规划。

        懒加载 MCTSPlanner，复用主 LLM；搜索失败时返回 None 以保留原计划。
        """
        try:
            from agent.loop.mcts_planner import MCTSConfig, MCTSPlanner

            if self._mcts_planner is None:
                self._mcts_planner = MCTSPlanner(
                    llm=self.llm,
                    config=MCTSConfig(time_limit_ms=15000.0, max_iterations=20),
                )
            plan, meta = await self._mcts_planner.plan(input_text, context)
            if meta:
                self._logger.info(
                    "MCTS search completed",
                    iterations=meta.iterations,
                    nodes=meta.nodes_explored,
                    best_reward=round(meta.best_reward, 3),
                    duration_ms=round(meta.duration_ms, 1),
                )
            return plan
        except Exception as e:
            self._logger.warning("MCTS replan failed", error=str(e))
            return None

    def _inject_reflection_into_context(self, context: LoopContext) -> None:
        insight = self._last_reflection_insight
        if not insight:
            return

        context.messages = [
            m
            for m in context.messages
            if not (m.get("role") == "system" and m.get("content", "").startswith("【反思结论】"))
        ]

        parts = ["【反思结论】"]
        parts.append(f"根因分析: {insight.get('rootCause', '未知')}")

        if insight.get("diagnosis"):
            parts.append(f"诊断: {insight['diagnosis']}")
        if insight.get("fixStrategy"):
            parts.append(f"修复策略: {insight['fixStrategy']}")
        if insight.get("correctedArgs"):
            parts.append(f"建议参数: {insight['correctedArgs']}")
        if insight.get("correctedPlan"):
            parts.append("修正计划:")
            for i, step in enumerate(insight["correctedPlan"]):
                parts.append(f"  {i + 1}. {step.get('stepDescription', '')} (工具: {step.get('toolName', '无')})")

        if insight.get("alternativeTool"):
            parts.append(f"替代工具建议: {insight['alternativeTool']}")

        parts.append("\n请基于以上反思结论调整执行策略。")

        reflection_text = "\n".join(parts)
        context.messages.append({"role": "system", "content": reflection_text})

        if hasattr(self.planner, "inject_reflection_insight"):
            self.planner.inject_reflection_insight(reflection_text)

        self._last_reflection_insight = None

    def _apply_reflection_to_planning(
        self,
        input_text: str,
        context: LoopContext,
        plan: ExecutionPlan,
    ) -> None:
        """根据经验知识库优化规划。

        从反思知识库中获取相关经验，注入到上下文中辅助规划。
        P1-4: 增加经验迁移注入，从历史任务提取可迁移模式。
        失败时静默降级，不影响主流程。

        Args:
            input_text: 用户输入。
            context: 循环上下文。
            plan: 执行计划。
        """
        if not self._reflection_app_enabled or not self._reflection_app:
            return

        try:
            # P1-4: 经验迁移 — 从历史任务提取可迁移模式，注入规划阶段
            kb = getattr(self._reflection_app, "_kb", None)
            if kb and hasattr(kb, "build_planning_injection"):
                migration_text = kb.build_planning_injection(
                    task_description=input_text,
                    max_patterns=3,
                )
                if migration_text:
                    context.messages = [
                        m
                        for m in context.messages
                        if not (m.get("role") == "system" and m.get("content", "").startswith("【经验迁移】"))
                    ]
                    context.messages.append({"role": "system", "content": migration_text})

            # 获取自适应配置
            config = self._reflection_app.get_adjusted_config(input_text)

            # 获取推荐工具
            recommended_tools = config.get("recommended_tools", [])
            if recommended_tools and plan.recommended_tools:
                # 合并推荐工具，优先使用经验推荐的
                merged_tools = recommended_tools + [
                    t for t in plan.recommended_tools if t not in recommended_tools
                ]
                plan.recommended_tools = merged_tools[:5]

            # 如果有策略调整建议，注入到上下文
            if config.get("reflection_depth") == "shallow":
                context.messages.append({
                    "role": "system",
                    "content": "【经验提示】检测到简单任务，使用快速执行策略。",
                })
            elif config.get("reflection_depth") == "deep":
                context.messages.append({
                    "role": "system",
                    "content": "【经验提示】检测到复杂任务，建议仔细规划后执行。",
                })

        except Exception as e:
            log.debug("controller 异常处理", error=str(e))
            # 静默降级，不影响主流程
            try:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").debug("Apply reflection to planning failed", error=str(e))
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController._apply_reflection_to_planning", _exc)

    def _update_reflection_knowledge(
        self,
        input_text: str,
        context: LoopContext,
        eval_result: EvaluatorOutput,
    ) -> None:
        """更新经验知识库。

        根据评估结果更新相关经验的成功率。
        失败时静默降级，不影响主流程。

        Args:
            input_text: 用户输入。
            context: 循环上下文。
            eval_result: 评估结果。
        """
        if not self._reflection_app_enabled or not self._reflection_app:
            return

        try:
            # 更新工具执行结果
            for sr in context.step_results.values():
                if sr.tool_name:
                    self._reflection_app.tool_selector.record_tool_result(
                        tool_name=sr.tool_name,
                        success=sr.success,
                        context={"step_id": sr.step_id},
                        result=sr.content[:200] if sr.content else "",
                        insight=sr.error or "",
                    )

        except Exception as e:
            log.debug("controller 异常处理", error=str(e))
            # 静默降级，不影响主流程
            try:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").debug("Update reflection knowledge failed", error=str(e))
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController._update_reflection_knowledge", _exc)

    def _save_reflection_experience(
        self,
        input_text: str,
        context: LoopContext,
        success: bool,
    ) -> None:
        """保存最终经验到知识库。

        在循环结束时保存整体任务的经验。
        失败时静默降级，不影响主流程。

        Args:
            input_text: 用户输入。
            context: 循环上下文。
            success: 任务是否成功。
        """
        if not self._reflection_app_enabled or not self._reflection_app:
            return

        try:
            # 记录规划策略结果
            complexity = self._reflection_app.strategy_adapter.estimate_complexity(input_text)
            self._reflection_app.strategy_adapter.record_planning_result(
                task_input=input_text,
                success=success,
                complexity=complexity,
                strategy_used="default",
                result=f"rounds_used={context.budget.rounds_used}",
                insight=f"任务复杂度约{complexity:.2f}，使用{context.budget.rounds_used}轮完成",
            )

        except Exception as e:
            log.debug("controller 异常处理", error=str(e))
            # 静默降级，不影响主流程
            try:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").debug("Save reflection experience failed", error=str(e))
            except Exception as _exc:
                log.debug("controller 异常处理", error=str(_exc))
                log_ignored(log, "controller.LoopController._save_reflection_experience", _exc)

    def _suggest_step_adjustment(
        self,
        plan: ExecutionPlan,
        eval_result: EvaluatorOutput,
        context: LoopContext,
    ) -> dict[str, Any] | None:
        """W2-2: 步骤级动态调整建议。

        基于评估结果和当前计划状态，建议五种调整动作之一：
        1. reorder: 重排步骤顺序（低价值步骤后移）
        2. skip: 跳过低价值步骤
        3. merge: 合并相似步骤
        4. split: 拆分过大步骤
        5. replace_tool: 替换失败工具

        Args:
            plan: 当前执行计划。
            eval_result: 评估结果。
            context: 循环上下文。

        Returns:
            调整建议字典，或 None（无需调整）。
        """
        pending_steps = [s for s in plan.steps if s.status not in ("completed", "failed")]
        if not pending_steps:
            return None

        failed_step_ids = {sr.step_id for sr in context.step_results.values() if not sr.success}

        for step in pending_steps:
            if step.step_id in failed_step_ids and step.tool_name:
                return {
                    "type": "replace_tool",
                    "target_step_id": step.step_id,
                    "old_tool": step.tool_name,
                    "reason": f"工具 {step.tool_name} 执行失败，建议替换",
                    "confidence": 0.7,
                }

        if eval_result.step_success_rate < 0.5 and len(pending_steps) > 2:
            low_value_steps = [
                s for s in pending_steps
                if s.tool_name and s.tool_name in ("file_read", "file_search", "file_list")
            ]
            if low_value_steps:
                return {
                    "type": "skip",
                    "target_step_id": low_value_steps[0].step_id,
                    "reason": f"成功率低({eval_result.step_success_rate:.0%})，跳过低价值步骤 {low_value_steps[0].tool_name}",
                    "confidence": 0.6,
                }

        if eval_result.goal_progress < 0.3 and len(pending_steps) > 3:
            tool_counts: dict[str, int] = {}
            for s in pending_steps:
                if s.tool_name:
                    tool_counts[s.tool_name] = tool_counts.get(s.tool_name, 0) + 1
            for tool, count in tool_counts.items():
                if count >= 2:
                    return {
                        "type": "merge",
                        "target_tool": tool,
                        "reason": f"工具 {tool} 被调用 {count} 次，建议合并",
                        "confidence": 0.5,
                    }

        return None

    def _apply_step_adjustment(
        self,
        plan: ExecutionPlan,
        adjustment: dict[str, Any],
        context: LoopContext,
    ) -> None:
        """W2-2: 应用步骤级调整到当前计划。

        根据调整类型修改计划步骤的状态或属性。

        Args:
            plan: 执行计划（就地修改）。
            adjustment: 调整建议字典。
            context: 循环上下文。
        """
        adj_type = adjustment.get("type")
        target_step_id = adjustment.get("target_step_id")

        if adj_type == "skip" and target_step_id:
            for step in plan.steps:
                if step.step_id == target_step_id:
                    step.status = "skipped"
                    context.messages.append({
                        "role": "system",
                        "content": f"【步骤调整】跳过步骤 {step.description[:40]}：{adjustment.get('reason', '')}",
                    })
                    break

        elif adj_type == "replace_tool" and target_step_id:
            from agent.loop.types import StepState
            new_tool = self._find_alternative_tool(adjustment.get("old_tool", ""))
            if new_tool:
                for step in plan.steps:
                    if step.step_id == target_step_id:
                        old_tool = step.tool_name
                        step.tool_name = new_tool
                        step.status = "pending"
                        if hasattr(step, 'step_state') and hasattr(step, 'transition_state'):
                            step.transition_state(StepState.PENDING)
                        context.messages.append({
                            "role": "system",
                            "content": f"【步骤调整】步骤 {step.description[:40]} 工具从 {old_tool} 替换为 {new_tool}",
                        })
                        break

        elif adj_type == "merge" and adjustment.get("target_tool"):
            target_tool = adjustment["target_tool"]
            merge_steps = [s for s in plan.steps if s.tool_name == target_tool and s.status == "pending"]
            if len(merge_steps) >= 2:
                keeper = merge_steps[0]
                for s in merge_steps[1:]:
                    if keeper.description and s.description:
                        keeper.description = f"{keeper.description} + {s.description}"
                    s.status = "skipped"
                context.messages.append({
                    "role": "system",
                    "content": f"【步骤调整】合并 {len(merge_steps)} 个 {target_tool} 步骤为 1 个",
                })

    def _find_alternative_tool(self, failed_tool: str) -> str | None:
        """查找替代工具。

        基于工具注册表中的元数据，查找功能相似的替代工具。

        Args:
            failed_tool: 失败的工具名称。

        Returns:
            替代工具名称，或 None。
        """
        TOOL_ALTERNATIVES: dict[str, list[str]] = {
            "file_read": ["file_search", "file_grep"],
            "file_search": ["file_grep", "file_list"],
            "file_grep": ["file_search", "file_read"],
            "web_search": ["web_fetch"],
            "web_fetch": ["web_search"],
            "shell_execute": ["file_write"],
            "desktop_click": ["desktop_type"],
            "desktop_type": ["desktop_click"],
        }
        alternatives = TOOL_ALTERNATIVES.get(failed_tool, [])
        if not alternatives:
            return None
        if self._tool_registry:
            for alt in alternatives:
                if self._tool_registry.get_tool(alt):
                    return alt
        return alternatives[0] if alternatives else None

    async def _trigger_meta_reflect(self, context: LoopContext) -> None:
        """P1-1: 触发元反思，评估反思质量并提出改进建议。

        收集最近 N 次的反思记录和执行结果，调用 ReflectionEngine.meta_reflect()。
        将结果注入上下文供后续循环使用。
        """
        try:
            recent_reflections: list[dict[str, Any]] = []
            execution_outcomes: list[dict[str, Any]] = []

            for sid, sr in context.step_results.items():
                outcome = {
                    "step_id": sid,
                    "tool_name": sr.tool_name,
                    "success": sr.success,
                    "error": sr.error,
                    "was_retry": sr.duration_ms > 0,
                }
                execution_outcomes.append(outcome)

            # 从轻量级反思提取最近的反思记录（实际走 ReflectionEngine 的经验库）
            if self.reflection and hasattr(self.reflection, "_experience_buffer"):
                for exp in self.reflection._experience_buffer[-20:]:
                    recent_reflections.append({
                        "tool_name": exp.tool_name,
                        "should_retry": not exp.success,
                        "error_category": exp.root_cause or "",
                    })

            result = await self.reflection.meta_reflect(
                recent_reflections=recent_reflections,
                execution_outcomes=execution_outcomes,
            )

            if result.should_adjust_strategy and result.adjusted_params:
                log.info(
                    "Meta reflection: strategy adjusted",
                    params=result.adjusted_params,
                    blind_spots=len(result.identified_blind_spots),
                )
                context.metadata["meta_reflection"] = {
                    "quality": result.reflection_quality,
                    "blind_spots": result.identified_blind_spots,
                    "adjustments": result.adjusted_params,
                }
        except Exception as e:
            log.debug("Meta reflection failed (non-blocking)", error=str(e))

    async def _execute_with_orchestration(
        self,
        plan: ExecutionPlan,
        context: LoopContext,
    ) -> ExecutorOutput:
        """F6: 使用 OrchestrationExecutor DAG 调度执行复杂计划。

        将 PlanStep 转换为 TaskNode，基于因果图设置依赖关系，
        利用 DAG 调度器自动识别可并行步骤并最大化并发度。

        Args:
            plan: 执行计划（5+ 步骤的 complex 计划）。
            context: 循环上下文。

        Returns:
            ExecutorOutput: 执行结果。
        """
        from agent.orchestration.executor import (
            OrchestrationExecutor,
            OrchestrationConfig,
            TaskPriority,
        )

        orch = OrchestrationExecutor(config=OrchestrationConfig(
            max_concurrent=5,
            default_timeout_ms=60000,
            default_max_retries=1,
            fail_fast=False,
            collect_results=True,
        ))

        step_id_to_task_id: dict[str, str] = {}

        for step in plan.steps:
            if step.status == "completed":
                continue

            def _make_step_executor(s: PlanStep) -> Callable[..., Awaitable[Any]]:
                async def _step_fn(prev_results: dict[str, Any]) -> Any:
                    if context.is_cancelled():
                        return {"skipped": True, "step_id": s.step_id}
                    result = await self.executor._execute_step(s, context)
                    context.step_results[s.step_id] = result
                    return {
                        "step_id": result.step_id,
                        "success": result.success,
                        "content": result.content,
                        "error": result.error,
                    }
                return _step_fn

            deps: list[str] = []
            if step.input_from_step:
                ref_key = step.input_from_step
                if ref_key.startswith("step:") or ref_key.startswith("result:"):
                    ref_id = ref_key.split(":", 1)[1]
                else:
                    ref_id = ref_key
                if ref_id in step_id_to_task_id:
                    deps.append(step_id_to_task_id[ref_id])

            priority = TaskPriority.NORMAL
            if step.step_id.startswith("step_"):
                try:
                    step_num = int(step.step_id.replace("step_", ""))
                    if step_num <= 2:
                        priority = TaskPriority.HIGH
                except ValueError as _exc:
                    log_ignored(log, "controller.LoopController._execute_with_orchestration", _exc)

            task_id = orch.add_task(
                name=f"{step.step_id}: {step.description[:60]}",
                executor=_make_step_executor(step),
                dependencies=deps if deps else None,
                priority=priority,
                timeout_ms=60000,
                max_retries=1,
                metadata={"step_id": step.step_id, "tool_name": step.tool_name or ""},
            )
            step_id_to_task_id[step.step_id] = task_id

        if not orch._tasks:
            return ExecutorOutput(
                messages=list(context.messages),
                tool_calls_count=0,
                tool_duration=0.0,
                completed_naturally=True,
                step_results=[],
            )

        orch_result = await orch.execute()

        all_results: list[StepResult] = []
        messages = list(context.messages)

        for task_id, task_node in orch_result.tasks.items():
            step_id = task_node.metadata.get("step_id", "")
            if task_node.status.value in ("completed",):
                sr = context.step_results.get(step_id)
                if sr:
                    all_results.append(sr)
                    if sr.content:
                        messages.append({"role": "assistant", "content": sr.content})
            elif task_node.status.value in ("failed", "skipped", "cancelled"):
                sr = context.step_results.get(step_id) or StepResult(
                    step_id=step_id or task_id,
                    success=False,
                    error=task_node.error or f"任务{task_node.status.value}",
                    tool_name=task_node.metadata.get("tool_name"),
                )
                all_results.append(sr)
                context.step_results[sr.step_id] = sr

        completed = all(r.success for r in all_results) if all_results else True

        self._logger.info(
            "Orchestration execution completed",
            total_tasks=len(orch_result.tasks),
            completed=orch_result.completed_count,
            failed=orch_result.failed_count,
            skipped=orch_result.skipped_count,
            duration_ms=orch_result.total_duration_ms,
        )

        return ExecutorOutput(
            messages=messages,
            tool_calls_count=sum(1 for r in all_results if r.tool_name),
            tool_duration=sum(r.duration_ms for r in all_results),
            completed_naturally=completed,
            step_results=all_results,
        )
