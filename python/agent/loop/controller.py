from __future__ import annotations

import os
import time
import uuid
from typing import Any

from agent.llm.provider import LLMProvider
from agent.loop.causal import CausalModeler, CausalGraph, DependencyAnalysis, FailureImpact
from agent.loop.evaluator import Evaluator
from agent.loop.executor import Executor
from agent.loop.observer import LoopObserver, LoopPhase
from agent.loop.planner import Planner
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
    ExecutionRecord,
    ToolInvocationRecord,
    StateTransitionRecord,
    TrajectoryDatabase,
)
from agent.tools.registry import ToolRegistry


class LoopController:
    MAX_REPLAN_COUNT = 3

    def __init__(
        self,
        llm: LLMProvider,
        trajectory_db: TrajectoryDatabase | None = None,
        tool_registry: ToolRegistry | None = None,
        evolution: Any | None = None,
        reflection_kb: ReflectionKnowledgeBase | None = None,
    ) -> None:
        self.llm = llm
        self.planner = Planner(llm, tool_registry=tool_registry)
        self.reflection = ReflectionEngine(llm, knowledge_base=reflection_kb)
        self.executor = Executor(llm, tool_registry=tool_registry, reflection=self.reflection)
        self.evaluator = Evaluator(llm)
        self.reporter = Reporter()
        self.causal = CausalModeler(llm)
        self.trajectory_db = trajectory_db
        self.tool_registry = tool_registry
        self.evolution = evolution
        self.state: LoopState = LoopState.IDLE
        self._last_reflection_insight: dict[str, Any] | None = None
        self._hooks: dict[LifecycleHook, list[Any]] = {
            hook: [] for hook in LifecycleHook
        }

        # 循环观察者（可观测性）
        self._observer = LoopObserver.get_instance()
        # 隐式反馈收集器
        self._feedback_collector = ImplicitFeedbackCollector.get_instance()

        # 反思应用管理器（可选）
        self._reflection_app: ReflectionApplicationManager | None = None
        self._reflection_app_enabled = os.environ.get("REFLECTION_APPLICATION_ENABLED", "true").lower() == "true"
        if self._reflection_app_enabled:
            try:
                self._reflection_app = ReflectionApplicationManager(kb=reflection_kb)
                self._logger = StructuredLogger("controller")
                self._logger.info("Reflection application manager enabled")
            except Exception as e:
                from agent.core.logger import StructuredLogger as _SL
                _SL("controller").warning("Failed to init reflection application manager", error=str(e))
                self._reflection_app = None

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

    async def run(
        self,
        input_text: str,
        messages: list[dict[str, str]] | None = None,
        session_id: str = "default",
        react_mode: bool | None = None,
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
            )

        trace_id = f"loop_{uuid.uuid4().hex[:8]}"
        context = LoopContext(
            user_input=input_text,
            session_id=session_id,
            messages=list(messages) if messages else [],
            budget=BudgetState(start_time=time.time()),
            trace_id=trace_id,
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
            )
            self.trajectory_db.record_execution(exec_record)

        causal_graph: CausalGraph | None = None

        replan_count = 0
        plan: ExecutionPlan | None = None

        await self._fire_hook(LifecycleHook.BEFORE_LOOP, context, {"input_text": input_text})

        while True:
            if context.budget.rounds_used >= context.budget.max_rounds:
                break

            if context.budget.tool_calls_used >= context.budget.max_tool_calls:
                break

            # ─── 时间预算检查 ───
            elapsed_ms = (time.time() - context.budget.start_time) * 1000
            if context.budget.max_duration_ms > 0 and elapsed_ms >= context.budget.max_duration_ms:
                log.warning(
                    "Time budget exceeded, stopping loop",
                    elapsed_ms=f"{elapsed_ms:.0f}",
                    budget_ms=context.budget.max_duration_ms,
                    rounds_used=context.budget.rounds_used,
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

            if self.trajectory_db:
                self.trajectory_db.record_state_transition(StateTransitionRecord(
                    execution_id=trace_id,
                    from_state="planning",
                    to_state="executing",
                    reason=f"第{context.budget.rounds_used}轮执行",
                ))

            # P1-4: 有链式依赖时使用 execute_chain，有并行组时使用 execute_parallel，否则使用 execute
            has_chain = any(
                s.input_from_step for s in plan.steps
            ) if plan and plan.steps else False
            parallel_groups: list[list[str]] = context.metadata.get("parallel_groups", [])
            if has_chain:
                executor_output = await self.executor.execute_chain(plan.steps, context)
            elif parallel_groups and len(parallel_groups) > 1 and not plan.simple:
                # 因果建模识别到多并行组 → 并行执行独立步骤
                # 收集所有非链式、非已完成的步骤进行并行执行
                independent_steps = [
                    s for s in plan.steps
                    if s.status != "completed" and not s.input_from_step
                ]
                if len(independent_steps) > 1:
                    log.info(
                        "Parallel execution via causal model",
                        parallel_groups=len(parallel_groups),
                        independent_steps=len(independent_steps),
                    )
                    executor_output = await self.executor.execute_parallel(
                        independent_steps, context
                    )
                else:
                    executor_output = await self.executor.execute(plan, context)
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

                if causal_graph and causal_graph.nodes:
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
                if context.budget.rounds_used >= context.budget.max_rounds:
                    break
                continue

            elif action == "replan":
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
            },
        )

    async def run_react_loop(
        self,
        input_text: str,
        messages: list[dict[str, str]] | None = None,
        session_id: str = "default",
        max_iterations: int = 10,
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
        )

        self.state = LoopState.EXECUTING
        step_count = 0
        structured_steps: list[StructuredReActStep] = []

        await self._fire_hook(LifecycleHook.BEFORE_LOOP, context, {"input_text": input_text})

        while step_count < max_iterations:
            step_count += 1

            # ─── ReAct 预算检查：时间 + 工具调用次数 ───
            elapsed_ms = (_t.time() - context.budget.start_time) * 1000
            if context.budget.max_duration_ms > 0 and elapsed_ms >= context.budget.max_duration_ms:
                log.warning(
                    "ReAct time budget exceeded",
                    elapsed_ms=f"{elapsed_ms:.0f}",
                    budget_ms=context.budget.max_duration_ms,
                    iterations=step_count,
                )
                break
            if context.budget.tool_calls_used >= context.budget.max_tool_calls:
                log.warning(
                    "ReAct tool call budget exceeded",
                    used=context.budget.tool_calls_used,
                    max=context.budget.max_tool_calls,
                    iterations=step_count,
                )
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

            action_result = await self._react_act(thought, context)

            observation = await self._react_observe(action_result, context)
            structured_step.observation = observation

            context.messages.append({
                "role": "system",
                "content": structured_step.to_context_message(),
            })

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
                reflection = await self.reflection.reflect(
                    tool_name=thought.tool_name or "unknown",
                    args=thought.tool_args or {},
                    error=action_result.error or "unknown error",
                    context={"iteration": step_count},
                )
                if reflection.corrected_args and thought.tool_name:
                    corrected_step = PlanStep(
                        step_id=f"react-correct-{step_count}",
                        description=f"修正重试: {thought.text[:100]}",
                        tool_name=thought.tool_name,
                        tool_params=reflection.corrected_args,
                    )
                    corrected_result = await self.executor._execute_step(corrected_step, context)
                    if corrected_result.success:
                        obs_text = f"[观察] 修正后工具调用成功: {corrected_result.content[:200] if corrected_result.content else '完成'}"
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

        result = await self.llm.chat(messages=messages, use_cache=False)
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

        当任务满足以下条件时使用 ReAct：
        - 非复杂多步骤任务
        - 需要单次工具调用即可完成
        """
        react_indicators = [
            "搜索", "查找", "查询", "搜索一下", "找一下",
            "读取", "打开", "看看",
            "天气", "新闻", "时间",
            "翻译", "计算",
        ]
        for kw in react_indicators:
            if kw in input_text:
                return True
        return False

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
