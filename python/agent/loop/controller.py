from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any

from agent.llm.provider import LLMProvider
from agent.loop.causal import CausalModeler, CausalGraph, DependencyAnalysis, FailureImpact
from agent.loop.attention import AttentionFocusManager
from agent.loop.evaluator import Evaluator
from agent.loop.executor import Executor
from agent.loop.observer import LoopObserver, LoopPhase
from agent.loop.planner import Planner
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
from agent.tools.registry import ToolRegistry
from agent.core.canary_release import CanaryReleaseManager
from agent.core.otel_tracer import otel_trace, get_tracer
from agent.core.otel_metrics import loop_iterations_counter, loop_duration_histogram
from agent.core.logger import StructuredLogger

# 模块级日志器：供 replan / A2A fallback / meta reflection 等所有代码路径使用
log = StructuredLogger("controller")


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
    ) -> None:
        self.llm = llm
        # 灰度发布：注入到 LLMProvider，供 chat/chat_stream 在调用前选择版本
        if canary_manager is not None:
            self.llm.canary_manager = canary_manager
        self.planner = Planner(llm, tool_registry=tool_registry)
        if memory_engine:
            self.planner.set_memory_engine(memory_engine)
        self.reflection = ReflectionEngine(llm, knowledge_base=reflection_kb)
        self.executor = Executor(llm, tool_registry=tool_registry, reflection=self.reflection)
        self.evaluator = Evaluator(llm)
        self.reporter = Reporter()
        self.causal = CausalModeler(llm)
        self.trajectory_db = trajectory_db
        self.tool_registry = tool_registry
        self.evolution = evolution
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

        # 检查环境变量启用状态
        if os.environ.get("LOOP_OBSERVER_ENABLED", "").lower() == "true":
            self._observer.enable(
                verbose=os.environ.get("LOOP_OBSERVER_VERBOSE", "").lower() == "true"
            )
        if os.environ.get("IMPLICIT_FEEDBACK_ENABLED", "true").lower() == "false":
            self._feedback_collector.set_enabled(False)

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
        if react_mode is None:
            react_mode = self._should_use_react(input_text)
        if react_mode:
            return await self.run_react_loop(
                input_text=input_text,
                messages=messages,
                session_id=session_id,
                max_iterations=10,
                cancel_event=cancel_event,
                user_id=user_id,
                strategy_name=strategy_name,
            )

        trace_id = f"loop_{uuid.uuid4().hex[:8]}"

        # P2 #15: 基于历史数据预估执行时间，注入 BudgetState.max_duration_ms
        task_type = self._derive_task_type(input_text)
        max_duration_ms = self._resolve_budget_max_duration(task_type, input_text)

        context = LoopContext(
            user_input=input_text,
            session_id=session_id,
            messages=list(messages) if messages else [],
            budget=BudgetState(start_time=time.time(), max_duration_ms=max_duration_ms),
            trace_id=trace_id,
            cancel_event=cancel_event,
            user_id=user_id,
            strategy_name=strategy_name,
        )

        # 循环观察者：开始追踪
        observer_trace_id = self._observer.start_loop(user_input=input_text)

        # 隐式反馈：记录用户消息
        try:
            self._feedback_collector.on_user_message(input_text)
        except Exception:
            pass  # 反馈收集失败不影响主流程

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

        while True:
            # 取消检查点：每轮循环开头检查
            if context.is_cancelled():
                self._logger.info("Loop cancelled by user", trace_id=trace_id, round=context.budget.rounds_used)
                break

            if context.budget.rounds_used >= context.budget.max_rounds:
                break

            if context.budget.tool_calls_used >= context.budget.max_tool_calls:
                break

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
                except Exception:
                    pass

            # 时间预算强制（审计 L-04）：max_duration_ms<=0 视为不启用时间预算
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

            context.budget.rounds_used += 1

            # ─── Phase 1: PLANNING ───
            self.state = LoopState.PLANNING
            self._observer.start_phase(LoopPhase.PLANNER, input_summary=input_text)

            if plan is None or replan_count > 0:
                plan = await self.planner.plan(input_text, context)
                context.plan = plan

                if not plan.simple:
                    self._inject_plan_into_context(plan, context)

                    if replan_count > 0 and self._last_reflection_insight:
                        self._inject_reflection_into_context(context)

                if self.trajectory_db:
                    self.trajectory_db.record_state_transition(StateTransitionRecord(
                        execution_id=trace_id,
                        from_state="evaluating" if replan_count > 0 else "idle",
                        to_state="planning",
                        reason=f"第{context.budget.rounds_used}轮规划" + ("（重规划）" if replan_count > 0 else ""),
                    ))

                try:
                    causal_graph = await self.causal.build_causal_model(input_text)
                except Exception:
                    causal_graph = None

                await self._fire_hook(LifecycleHook.AFTER_PLAN, context, {"plan": plan})

                # 反思应用：根据经验优化规划
                self._apply_reflection_to_planning(input_text, context, plan)

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
                self.trajectory_db.record_state_transition(StateTransitionRecord(
                    execution_id=trace_id,
                    from_state="planning",
                    to_state="executing",
                    reason=f"第{context.budget.rounds_used}轮执行",
                ))

            # P1-4: 有链式依赖时使用 execute_chain，否则使用 execute
            has_chain = any(
                s.input_from_step for s in plan.steps
            ) if plan and plan.steps else False
            if has_chain:
                executor_output = await self.executor.execute_chain(plan.steps, context)
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
                except Exception:
                    pass

                await self._reflect_on_failure(failed_steps[0], context)

            # P1-1: 成功反思 — 从成功执行中提炼模式和最佳实践
            successful_steps = [sr for sr in executor_output.step_results if sr.success and sr.tool_name]
            for sr in successful_steps:
                try:
                    await self.reflection.reflect_on_success(
                        tool_name=sr.tool_name or "",
                        args=sr.tool_params if hasattr(sr, 'tool_params') else {},
                        result=sr.content or "",
                        context={"traceId": context.trace_id, "step_id": sr.step_id},
                    )
                except Exception:
                    pass  # 成功反思失败不影响主流程

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
                    self.trajectory_db.record_tool_invocation(ToolInvocationRecord(
                        execution_id=trace_id,
                        step_index=idx,
                        tool_name=sr.tool_name or "unknown",
                        args_json="{}",
                        result_success=1 if sr.success else 0,
                        result_output=(sr.content or "")[:500],
                        duration=int(sr.duration_ms) if sr.duration_ms else 0,
                        error_message=sr.error,
                    ))

            self._observer.end_phase(
                LoopPhase.EXECUTOR,
                success=not failed_steps,
                output_summary=f"{len(executor_output.step_results)} steps executed",
            )

            # ─── 轻量级反思（每轮执行后） ───
            await self._lightweight_reflection_round(executor_output.step_results, context)

            # P0-3: 注意力聚焦 — 清理低价值上下文消息
            try:
                self._attention_focus.apply_to_context(context)
            except Exception:
                pass

            # ─── Phase 3: EVALUATING ───
            self.state = LoopState.EVALUATING
            self._observer.start_phase(LoopPhase.EVALUATOR)

            if self.trajectory_db:
                self.trajectory_db.record_state_transition(StateTransitionRecord(
                    execution_id=trace_id,
                    from_state="executing",
                    to_state="evaluating",
                    reason=f"第{context.budget.rounds_used}轮评估",
                ))

            eval_result = await self.evaluator.evaluate(input_text, context)

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
                        except Exception:
                            pass

                    log.info(
                        "Strategy adaptive",
                        deep_reflection=enable_deep_reflection,
                        max_retries=adjusted_max_retries,
                        slow_down=should_slow_down,
                    )
                except Exception:
                    pass

            if should_slow_down:
                context.budget.max_duration_ms = int(context.budget.max_duration_ms * 1.5)
                log.info("Slowing down: extended max duration by 1.5x")

            if not enable_deep_reflection and context.budget.rounds_used > 1:
                log.info("Strategy adaptive: high success rate, skip deep reflection")
            elif eval_result.suggested_action == "replan" and eval_result.goal_progress < 0.5:
                await self._deep_reflect(input_text, context, eval_result)

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
                    break

                if eval_result.failure_analysis:
                    context.messages.append({
                        "role": "system",
                        "content": f"【评估反馈】{eval_result.failure_analysis}\n修正建议: {eval_result.suggested_correction or '重新规划'}",
                    })

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

                plan = await self.planner.replan(
                    input_text, context, plan, failed_info, root_cause,
                )
                context.plan = plan
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

        await self._fire_hook(LifecycleHook.AFTER_RESPONSE, context, {"report": report})

        self._observer.end_phase(
            LoopPhase.REPORTER,
            success=True,
            output_summary=f"quality={report.quality_score:.2f}",
        )

        # 隐式反馈：记录 AI 回复
        try:
            self._feedback_collector.on_ai_message(report.response)
        except Exception:
            pass

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

        # ─── P5: 记录学习信号到 StrategyAdjuster ───
        if self.evolution:
            try:
                from agent.evolution.types import LearningSignal, SignalType
                import time as _t

                if report.quality_score >= 0.6:
                    self.evolution.record_signal(LearningSignal(
                        signal_type=SignalType.TASK_SUCCESS,
                        quality=report.quality_score,
                        timestamp=_t.time(),
                    ))

                    # 隐式反馈：任务成功作为正向信号
                    try:
                        self._feedback_collector.record_signal(
                            signal_type=FeedbackType.POSITIVE,
                            strength=FeedbackStrength.MEDIUM,
                            source=FeedbackSource.SATISFACTION,
                            confidence=0.6,
                            metadata={"quality_score": report.quality_score},
                        )
                    except Exception:
                        pass
                else:
                    self.evolution.record_signal(LearningSignal(
                        signal_type=SignalType.TASK_FAILURE,
                        error="Loop quality below threshold",
                        timestamp=_t.time(),
                    ))

                    # 隐式反馈：任务失败作为负向信号
                    try:
                        self._feedback_collector.record_signal(
                            signal_type=FeedbackType.NEGATIVE,
                            strength=FeedbackStrength.MEDIUM,
                            source=FeedbackSource.RETRY,
                            confidence=0.6,
                            metadata={"quality_score": report.quality_score},
                        )
                    except Exception:
                        pass

                for sr in context.step_results.values():
                    if sr.tool_name:
                        self.evolution.record_signal(LearningSignal(
                            signal_type=SignalType.POSITIVE if sr.success else SignalType.NEGATIVE,
                            tool_name=sr.tool_name,
                            quality=1.0 if sr.success else 0.0,
                            error=sr.error,
                            timestamp=_t.time(),
                        ))

                # P1-2: 丰富学习信号 — 注入 PLAN_QUALITY
                plan_quality = 0.5  # 默认中等
                try:
                    planned_steps = len(context.plan.steps) if context.plan and context.plan.steps else 0
                    executed_steps = len(context.step_results) if hasattr(context, 'step_results') else 0
                    if planned_steps > 0:
                        completion_ratio = executed_steps / planned_steps
                        plan_quality = min(1.0, max(0.0, completion_ratio))
                except Exception:
                    pass
                self.evolution.record_signal(LearningSignal(
                    signal_type=SignalType.PLAN_QUALITY,
                    quality=plan_quality,
                    metadata={"planned_steps": plan_quality * 10, "executed_steps": executed_steps},
                    timestamp=_t.time(),
                ))

                # P1-2: 丰富学习信号 — 注入 TOOL_SELECTION_QUALITY（基于工具成功率）
                tool_stats: dict[str, tuple[int, int]] = {}  # tool_name -> (success_count, total_count)
                for sr in context.step_results.values():
                    if sr.tool_name:
                        if sr.tool_name not in tool_stats:
                            tool_stats[sr.tool_name] = [0, 0]
                        tool_stats[sr.tool_name][1] += 1
                        if sr.success:
                            tool_stats[sr.tool_name][0] += 1
                for tname, (succ, total) in tool_stats.items():
                    self.evolution.record_signal(LearningSignal(
                        signal_type=SignalType.TOOL_SELECTION_QUALITY,
                        tool_name=tname,
                        quality=succ / total if total > 0 else 0.0,
                        timestamp=_t.time(),
                    ))

                # P1-2: 丰富学习信号 — 注入 REFLECTION_EFFECTIVENESS
                if self.reflection and hasattr(self.reflection, '_experience_store'):
                    exp_count = len(self.reflection._experience_store) if self.reflection._experience_store else 0
                    if exp_count > 0:
                        self.evolution.record_signal(LearningSignal(
                            signal_type=SignalType.REFLECTION_EFFECTIVENESS,
                            quality=min(1.0, exp_count / 10.0),  # 10+ 条经验 = 满分
                            metadata={"experience_count": exp_count},
                            timestamp=_t.time(),
                        ))

                # P1-2: 丰富学习信号 — 注入 MEMORY_RETRIEVAL_HIT
                if self.planner and hasattr(self.planner, '_memory_engine') and self.planner._memory_engine:
                    try:
                        recent_msgs = [m for m in context.messages if isinstance(m, dict)]
                        recent_input = recent_msgs[-1].get('content', '') if recent_msgs else ''
                        if recent_input:
                            hits = self.planner._memory_engine.search_with_context(recent_input, top_k=1)
                            if hits:
                                self.evolution.record_signal(LearningSignal(
                                    signal_type=SignalType.MEMORY_RETRIEVAL_HIT,
                                    quality=float(hits[0].get('similarity', 0)),
                                    metadata={"retrieved_count": len(hits)},
                                    timestamp=_t.time(),
                                ))
                    except Exception:
                        pass

                # P1-2: 丰富学习信号 — 注入 CONTEXT_COMPRESSION_SUCCESS
                if context.messages:
                    msg_len = len(context.messages)
                    if msg_len <= 10:  # 注意力聚焦生效了
                        self.evolution.record_signal(LearningSignal(
                            signal_type=SignalType.CONTEXT_COMPRESSION_SUCCESS,
                            quality=1.0,
                            metadata={"message_count": msg_len},
                            timestamp=_t.time(),
                        ))

                # 将隐式反馈统计传递给进化引擎
                try:
                    feedback_stats = self._feedback_collector.get_statistics()
                    if hasattr(self.evolution, 'record_implicit_feedback'):
                        self.evolution.record_implicit_feedback(feedback_stats)
                except Exception:
                    pass
            except Exception:
                pass

        self.state = LoopState.COMPLETED

        # 反思应用：保存最终经验和统计
        self._save_reflection_experience(input_text, context, report.quality_score >= 0.6)

        # P1-1: 每 10 次 loop 触发一次元反思
        self._meta_reflect_counter = getattr(self, '_meta_reflect_counter', 0) + 1
        if self._meta_reflect_counter >= 10:
            self._meta_reflect_counter = 0
            asyncio.ensure_future(self._trigger_meta_reflect(context))

        # OTel 指标：记录循环迭代次数与总耗时
        try:
            _loop_success = report.quality_score >= 0.6
            loop_iterations_counter().add(
                context.budget.rounds_used,
                {"status": "success" if _loop_success else "failed"},
            )
            _loop_duration_s = time.time() - context.budget.start_time
            loop_duration_histogram().record(_loop_duration_s)
        except Exception:
            pass  # 指标记录失败不影响主流程

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

        context = LoopContext(
            user_input=input_text,
            session_id=session_id,
            messages=list(messages) if messages else [],
            budget=BudgetState(start_time=_t.time()),
            trace_id=f"react-{session_id}-{_t.time_ns()}",
            cancel_event=cancel_event,
            user_id=user_id,
            strategy_name=strategy_name,
        )

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

            structured_step = await self._react_think_structured(input_text, context, step_count)
            structured_steps.append(structured_step)

            context.messages.append({
                "role": "assistant",
                "content": structured_step.to_context_message(),
            })

            if structured_step.is_final:
                self.state = LoopState.REPORTING
                final_answer = structured_step.action.get("final_answer", structured_step.thought)
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
            except Exception:
                pass

            if action_result.success and action_result.is_complete:
                self.state = LoopState.REPORTING
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

        self.state = LoopState.REPORTING
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
        result = await self.llm.chat(
            messages=messages,
            use_cache=False,
            user_id=context.user_id,
            strategy_name=context.strategy_name,
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
        except (_json.JSONDecodeError, TypeError):
            pass

        try:
            start = content.find("{")
            end = content.rfind("}") + 1
            if start >= 0 and end > start:
                parsed = _json.loads(content[start:end])
                step.thought = parsed.get("thought", "")
                step.action = parsed.get("action", {})
                step.is_final = "final_answer" in step.action
                return step
        except (_json.JSONDecodeError, TypeError):
            pass

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
        """ReAct Observation 阶段: 观察执行结果。"""
        if action_result.success:
            content_preview = (action_result.content or "")[:500]
            return f"[观察] 工具调用成功。结果: {content_preview}"
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
        except Exception:
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
        except Exception:
            return None

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
            except Exception:
                pass  # 预估失败，降级到静态配置

        # 降级到 ConstraintsService.resolve_adaptive_budget 静态配置
        if self.constraints_service:
            try:
                allocation = self.constraints_service.resolve_adaptive_budget(task_type)
                return allocation.max_duration_ms
            except Exception:
                pass

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
        except Exception:
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

        args_match = _re.search(r"Args:\s*(\{.+?\})", content, _re.DOTALL)
        if args_match:
            try:
                import json as _json
                tool_args = _json.loads(args_match.group(1))
            except Exception:
                tool_args = {}

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
                    args=sr.tool_params if hasattr(sr, 'tool_params') else {},
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
                except Exception:
                    pass

        except Exception as e:
            # 静默降级，不影响主流程
            try:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").debug("Lightweight reflection failed", error=str(e))
            except Exception:
                pass

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
            # 静默降级，不影响主流程
            try:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").debug("Apply reflection to planning failed", error=str(e))
            except Exception:
                pass

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
            # 静默降级，不影响主流程
            try:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").debug("Update reflection knowledge failed", error=str(e))
            except Exception:
                pass

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
            # 静默降级，不影响主流程
            try:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").debug("Save reflection experience failed", error=str(e))
            except Exception:
                pass

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
