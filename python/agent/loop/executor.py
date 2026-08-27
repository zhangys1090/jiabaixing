from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.llm.provider import LLMProvider
from agent.loop.reflection import ReflectionEngine, ReflectionResult
from agent.loop.robustness import (
    ErrorType,
    RobustnessManager,
)
from agent.loop.types import (
    ExecutionPlan,
    ExecutorOutput,
    LoopContext,
    PlanStep,
    StepResult,
    StepState,
)
from agent.tools.registry import ToolRegistry, ToolResult
from agent.core.otel_tracer import otel_trace
from agent.core.otel_metrics import tool_calls_counter, tool_duration_histogram
from agent.core.resilience import get_circuit, CircuitState
from opentelemetry import trace as _otel_trace_api


_MAX_REFLECTION_RETRIES = 3


class RollbackEntry:
    """P2-5: 动作回滚链条目 — 记录一个已执行动作及其补偿操作。

    Attributes:
        step_id: 关联的步骤 ID.
        tool_name: 执行的工具名称.
        tool_params: 工具参数.
        compensate_tool: 补偿工具名称（如 file_write → file_delete）.
        compensate_params: 补偿工具参数.
        executed_at: 执行时间戳.
        rolled_back: 是否已回滚.
    """

    __slots__ = (
        "step_id", "tool_name", "tool_params",
        "compensate_tool", "compensate_params",
        "executed_at", "rolled_back",
    )

    def __init__(
        self,
        step_id: str,
        tool_name: str,
        tool_params: dict[str, Any],
        compensate_tool: str | None = None,
        compensate_params: dict[str, Any] | None = None,
    ) -> None:
        self.step_id = step_id
        self.tool_name = tool_name
        self.tool_params = tool_params
        self.compensate_tool = compensate_tool
        self.compensate_params = compensate_params or {}
        self.executed_at = time.time()
        self.rolled_back = False


_ROLLBACK_COMPENSATIONS: dict[str, tuple[str, str]] = {
    "file_write": ("file_delete", "file_path"),
    "file_edit": ("file_write", "file_path"),
    "file_delete": ("file_write", "file_path"),
    "mkdir": ("rmdir", "path"),
    "db_insert": ("db_delete", "table"),
    "db_update": ("db_update", "table"),
    "web_post": ("web_delete", "url"),
    "web_put": ("web_delete", "url"),
}
# P1-1: 桌面操作工具名称集合 — 这些工具执行后自动触发感知验证
_DESKTOP_TOOL_NAMES = frozenset({
    "desktop_automate", "desktop_screenshot", "desktop_window", "desktop_clipboard",
    "screen_parse", "action_verify", "smart_wait",
})
# 单个工具调用默认超时（秒），可通过环境变量 TOOL_TIMEOUT 覆盖
import os as _os
log = StructuredLogger("executor")
_DEFAULT_TOOL_TIMEOUT = float(_os.environ.get("TOOL_TIMEOUT", "30"))
# LLM 调用默认超时（秒）
_DEFAULT_LLM_TIMEOUT = float(_os.environ.get("LLM_TIMEOUT", "60"))


class Executor:
    def __init__(
        self,
        llm: LLMProvider,
        tool_registry: ToolRegistry | None = None,
        reflection: ReflectionEngine | None = None,
        robustness_manager: RobustnessManager | None = None,
        risk_precheck: Any | None = None,
        action_sandbox: Any | None = None,
        smart_tool_cache: Any | None = None,
        tool_self_healing: Any | None = None,
        schema_validator: Any | None = None,
        tool_call_guard: Any | None = None,
    ) -> None:
        self.llm = llm
        self._tool_registry = tool_registry
        self._reflection = reflection
        # 鲁棒性管理器（第一阶段新增）
        self._robustness = robustness_manager or RobustnessManager.get_instance()
        # 安全沙箱：高风险动作预检 + 人工审批层（可空，空则零开销直通）
        self._risk_precheck = risk_precheck
        # Phase 3+4: 行动安全沙箱 — 高风险操作拦截 + 操作回滚
        self._action_sandbox = action_sandbox
        # Phase 3+4: 智能工具缓存 — 细粒度缓存 + 幂等性标记
        self._smart_tool_cache = smart_tool_cache
        # Phase 3+4: 工具自愈 — 工具调用失败时自动修复与降级
        self._tool_self_healing = tool_self_healing
        # C1: 防护串主路径——与主聊天路径 conversation_loop 对齐的 Schema 校验 / 调用守卫。
        # 由 engine 注入共享实例（与 conversation_loop 共用同一 ToolCallGuard，保证去重/限速跨路径一致）。
        # 缺省为 None（测试/直构造场景）时零开销直通，行为与 C1 前一致。
        self._schema_validator = schema_validator
        self._tool_call_guard = tool_call_guard

        # P2-5: 动作回滚链 — 记录每个可逆操作及其补偿动作
        self._rollback_chain: list[RollbackEntry] = []
        self._rollback_enabled = os.environ.get("ROLLBACK_CHAIN_ENABLED", "true").lower() == "true"
        self._MAX_ROLLBACK_CHAIN = 500
        # W3-3: 预测验证循环 — 执行前预测、执行后验证、偏差调整
        self._prediction_loop: Any | None = None

    def set_risk_precheck(self, risk_precheck: Any) -> None:
        """注入安全沙箱预检层，使高风险工具调用先过审批。"""
        self._risk_precheck = risk_precheck

    async def _run_tool(self, name: str, params: dict[str, Any]) -> ToolResult:
        """统一工具执行入口：高风险动作先经预检层，否则直通。"""
        if self._risk_precheck is not None:
            try:
                return await self._risk_precheck.execute(name, params)
            except Exception as exc:
                log.debug("executor 异常处理", error=str(exc))
                return ToolResult(
                    success=False,
                    error=f"高风险预检异常: {exc}",
                    metadata={"stage": "risk_precheck", "tool_name": name},
                )
        return await self._tool_registry.execute(name, params)

    def set_tool_registry(self, registry: ToolRegistry) -> None:
        self._tool_registry = registry

    def set_reflection(self, reflection: ReflectionEngine) -> None:
        self._reflection = reflection

    def set_robustness_manager(self, manager: RobustnessManager) -> None:
        self._robustness = manager

    def set_prediction_loop(self, prediction_loop: Any) -> None:
        self._prediction_loop = prediction_loop

    _perception_loop: Any = None

    def set_perception_loop(self, perception_loop: Any) -> None:
        """P1-1: 注入 PerceptionActionLoop，启用桌面操作自动验证。"""
        self._perception_loop = perception_loop

    def _record_rollback_entry(
        self,
        step_id: str,
        tool_name: str,
        tool_params: dict[str, Any],
    ) -> None:
        """P2-5: 记录可回滚动作到回滚链。

        根据预定义的补偿映射表，为有逆操作的工具自动生成补偿动作。
        无补偿映射的工具（如只读操作）不记录。
        """
        if not self._rollback_enabled:
            return

        comp = _ROLLBACK_COMPENSATIONS.get(tool_name)
        if comp is None:
            return

        compensate_tool, key_param = comp
        compensate_params: dict[str, Any] = {}
        if key_param in tool_params:
            compensate_params[key_param] = tool_params[key_param]

        entry = RollbackEntry(
            step_id=step_id,
            tool_name=tool_name,
            tool_params=tool_params,
            compensate_tool=compensate_tool,
            compensate_params=compensate_params,
        )
        self._rollback_chain.append(entry)
        if len(self._rollback_chain) > self._MAX_ROLLBACK_CHAIN:
            self._rollback_chain = self._rollback_chain[-self._MAX_ROLLBACK_CHAIN * 3 // 4:]
        log.info(
            "P2-5: 回滚链记录",
            step_id=step_id,
            tool=tool_name,
            compensate=compensate_tool,
            chain_len=len(self._rollback_chain),
        )

    async def rollback_chain(self, up_to_step_id: str | None = None) -> list[str]:
        """P2-5: 执行回滚链 — 按逆序执行补偿动作。

        Args:
            up_to_step_id: 回滚到指定步骤（不含该步骤）。None 表示回滚全部。

        Returns:
            已回滚的步骤 ID 列表。
        """
        if not self._rollback_chain:
            log.info("P2-5: 回滚链为空，无需回滚")
            return []

        rolled_back: list[str] = []
        entries = list(reversed(self._rollback_chain))

        for entry in entries:
            if entry.rolled_back:
                continue
            if up_to_step_id and entry.step_id == up_to_step_id:
                break

            if entry.compensate_tool and self._tool_registry:
                try:
                    result = await asyncio.wait_for(
                        self._run_tool(entry.compensate_tool, entry.compensate_params),
                        timeout=_DEFAULT_TOOL_TIMEOUT,
                    )
                    entry.rolled_back = True
                    rolled_back.append(entry.step_id)
                    log.info(
                        "P2-5: 回滚成功",
                        step_id=entry.step_id,
                        original=entry.tool_name,
                        compensate=entry.compensate_tool,
                        success=result.success,
                    )
                except Exception as exc:
                    log.warning(
                        "P2-5: 回滚失败",
                        step_id=entry.step_id,
                        compensate=entry.compensate_tool,
                        error=str(exc),
                    )
            else:
                entry.rolled_back = True
                rolled_back.append(entry.step_id)

        log.info(
            "P2-5: 回滚链执行完成",
            total=len(self._rollback_chain),
            rolled_back=len(rolled_back),
        )
        self._rollback_chain.clear()
        return rolled_back

    def get_rollback_chain_info(self) -> list[dict[str, Any]]:
        """P2-5: 获取回滚链信息（用于监控/诊断）。"""
        return [
            {
                "step_id": e.step_id,
                "tool_name": e.tool_name,
                "compensate_tool": e.compensate_tool,
                "executed_at": e.executed_at,
                "rolled_back": e.rolled_back,
            }
            for e in self._rollback_chain
        ]

    def _get_dynamic_max_retries(self) -> int:
        """P0 修复：从 EvolutionOrchestrator 实时反馈动态获取最大反思重试次数。

        此前 _MAX_REFLECTION_RETRIES=3 硬编码，学习闭环未打通。
        现在根据进化引擎的实时质量反馈动态调整：高质量时减少重试，低质量时增加重试。
        """
        base_retries = self._robustness.config.max_reflection_retries
        try:
            from agent.evolution.orchestrator import EvolutionOrchestrator

            orchestrator = EvolutionOrchestrator.get_instance()
            if orchestrator._is_running:
                feedback = orchestrator.get_realtime_feedback()
                suggested = feedback.get("suggested_max_retries")
                if isinstance(suggested, int) and 1 <= suggested <= 6:
                    return suggested
        except Exception as _exc:
            log.debug("executor 异常处理", error=str(_exc))
            log_ignored(log, "executor.Executor._get_dynamic_max_retries", _exc)
        return base_retries

    async def execute(
        self,
        plan: ExecutionPlan,
        context: LoopContext,
    ) -> ExecutorOutput:
        all_results: list[StepResult] = []
        messages = list(context.messages)

        if plan.simple and plan.steps:
            step = plan.steps[0]
            result = await self._execute_step(step, context)
            all_results.append(result)
            if result.content:
                messages.append({"role": "assistant", "content": result.content})
        else:
            parallel_enabled = os.environ.get("EXECUTOR_PARALLEL_ENABLED", "true").lower() != "false"
            has_chain = any(s.input_from_step for s in plan.steps)

            if parallel_enabled and not has_chain and len(plan.steps) > 1:
                all_results, messages = await self._execute_parallel(plan, context, messages)
            else:
                all_results, messages = await self._execute_sequential(plan, context, messages)

        completed = all(r.success for r in all_results) if all_results else True
        return ExecutorOutput(
            messages=messages,
            tool_calls_count=sum(1 for r in all_results if r.tool_name),
            tool_duration=sum(r.duration_ms for r in all_results),
            completed_naturally=completed,
            step_results=all_results,
        )

    async def _execute_sequential(
        self,
        plan: ExecutionPlan,
        context: LoopContext,
        messages: list[dict[str, str]],
    ) -> tuple[list[StepResult], list[dict[str, str]]]:
        """串行执行计划步骤（原有逻辑）。"""
        all_results: list[StepResult] = []
        for i, step in enumerate(plan.steps):
            if step.status == "completed":
                continue

            if context.is_cancelled():
                log.info("Executor cancelled by user", step_index=i, step_id=step.step_id)
                break

            context.current_step_index = i
            result = await self._execute_step(step, context)
            all_results.append(result)
            context.step_results[step.step_id] = result

            if result.success:
                step.transition_state(StepState.COMPLETED)
                if result.content:
                    messages.append({"role": "assistant", "content": result.content})
            else:
                step.transition_state(StepState.FAILED)
                corrected_result = await self._retry_with_reflection(
                    step, result, context,
                )
                all_results.append(corrected_result)
                context.step_results[step.step_id] = corrected_result
                if corrected_result.success:
                    if step.can_transition_to(StepState.COMPLETED):
                        step.transition_state(StepState.COMPLETED)
                    if corrected_result.content:
                        messages.append(
                            {"role": "assistant", "content": corrected_result.content}
                        )
                else:
                    if step.can_transition_to(StepState.FAILED):
                        step.transition_state(StepState.FAILED)
                    messages.append(
                        {"role": "assistant", "content": f"步骤失败: {step.description}"}
                    )

        return all_results, messages

    async def _execute_parallel(
        self,
        plan: ExecutionPlan,
        context: LoopContext,
        messages: list[dict[str, str]],
    ) -> tuple[list[StepResult], list[dict[str, str]]]:
        """并行执行无依赖的计划步骤。

        基于 PlanStep.input_from_step 分析依赖关系：
        - 无 input_from_step 的步骤可并行执行
        - 有 input_from_step 的步骤等待依赖完成后串行执行
        - 失败策略 CONTINUE：单步骤失败不中断其他并行步骤
        """
        from agent.core.tool_executor import (
            ParallelToolExecutor,
            ParallelExecConfig,
            ToolCallItem,
            ToolCallResult,
            FailurePolicy,
        )

        all_results: list[StepResult] = []
        step_by_id = {s.step_id: s for s in plan.steps}
        completed_step_ids: set[str] = set()

        pending = [s for s in plan.steps if s.status != "completed"]

        while pending:
            if context.is_cancelled():
                break

            parallel_group: list[PlanStep] = []
            still_pending: list[PlanStep] = []

            for step in pending:
                dep = step.input_from_step
                if dep:
                    ref_id = dep.split(":", 1)[1] if ":" in dep else dep
                    if ref_id not in completed_step_ids:
                        still_pending.append(step)
                        continue
                parallel_group.append(step)

            if not parallel_group and still_pending:
                parallel_group = [still_pending.pop(0)]

            if len(parallel_group) == 1:
                step = parallel_group[0]
                context.current_step_index = plan.steps.index(step) if step in plan.steps else 0
                result = await self._execute_step(step, context)
                all_results.append(result)
                context.step_results[step.step_id] = result

                if result.success:
                    step.transition_state(StepState.COMPLETED)
                    completed_step_ids.add(step.step_id)
                    if result.content:
                        messages.append({"role": "assistant", "content": result.content})
                else:
                    step.transition_state(StepState.FAILED)
                    corrected_result = await self._retry_with_reflection(
                        step, result, context,
                    )
                    all_results.append(corrected_result)
                    context.step_results[step.step_id] = corrected_result
                    if corrected_result.success:
                        if step.can_transition_to(StepState.COMPLETED):
                            step.transition_state(StepState.COMPLETED)
                        completed_step_ids.add(step.step_id)
                        if corrected_result.content:
                            messages.append({"role": "assistant", "content": corrected_result.content})
                    else:
                        if step.can_transition_to(StepState.FAILED):
                            step.transition_state(StepState.FAILED)
                        messages.append({"role": "assistant", "content": f"步骤失败: {step.description}"})
            else:
                items = [
                    ToolCallItem(
                        id=s.step_id,
                        name=s.tool_name or f"step_{s.step_id}",
                        arguments=s.tool_params,
                    )
                    for s in parallel_group
                ]
                step_map = {s.step_id: s for s in parallel_group}

                async def _exec_step(item: ToolCallItem) -> ToolCallResult:
                    step = step_map[item.id]
                    result = await self._execute_step(step, context)
                    return ToolCallResult(
                        id=item.id,
                        name=item.name,
                        success=result.success,
                        output=result.content or "",
                        error=result.error or "",
                    )

                max_parallel = int(os.environ.get("EXECUTOR_MAX_PARALLEL", "4"))
                parallel_executor = ParallelToolExecutor(
                    ParallelExecConfig(
                        max_parallel=max_parallel,
                        default_timeout=30.0,
                        failure_policy=FailurePolicy.CONTINUE,
                        enabled=True,
                    )
                )

                p_results, p_stats = await parallel_executor.execute(items, _exec_step)

                log.info(
                    "Parallel step execution",
                    count=len(p_results),
                    parallel_groups=p_stats.parallel_groups,
                    speedup=round(p_stats.speedup_ratio, 2),
                )

                for pr in p_results:
                    step = step_map.get(pr.id)
                    if step is None:
                        continue

                    sr = StepResult(
                        step_id=step.step_id,
                        success=pr.success,
                        content=pr.output,
                        tool_name=step.tool_name,
                        tool_params=step.tool_params,
                        error=pr.error or None,
                    )
                    all_results.append(sr)
                    context.step_results[step.step_id] = sr

                    if pr.success:
                        step.transition_state(StepState.COMPLETED)
                        completed_step_ids.add(step.step_id)
                        if pr.output:
                            messages.append({"role": "assistant", "content": pr.output})
                    else:
                        step.transition_state(StepState.FAILED)
                        corrected_result = await self._retry_with_reflection(
                            step, sr, context,
                        )
                        all_results.append(corrected_result)
                        context.step_results[step.step_id] = corrected_result
                        if corrected_result.success:
                            if step.can_transition_to(StepState.COMPLETED):
                                step.transition_state(StepState.COMPLETED)
                            completed_step_ids.add(step.step_id)
                            if corrected_result.content:
                                messages.append({"role": "assistant", "content": corrected_result.content})
                        else:
                            if step.can_transition_to(StepState.FAILED):
                                step.transition_state(StepState.FAILED)
                            messages.append({"role": "assistant", "content": f"步骤失败: {step.description}"})

            pending = still_pending + [s for s in pending if s.status != "completed" and s.step_id not in completed_step_ids]

        return all_results, messages

    async def execute_chain(
        self,
        chain: list[PlanStep],
        context: LoopContext,
    ) -> ExecutorOutput:
        """工具链编排：顺序执行链式步骤，前一步输出自动作为后一步输入。

        链式数据流：
          step_A.output → step_B.params[step_B.input_param_name] → step_B.output → step_C...

        链中断时自动调用反思引擎修正参数后重试（最多 _MAX_REFLECTION_RETRIES 次）。

        Args:
            chain: 有序的步骤列表，后一步可引用前一步的输出
            context: 循环上下文

        Returns:
            执行结果（含所有步骤的结果）
        """
        all_results: list[StepResult] = []
        messages = list(context.messages)

        for i, step in enumerate(chain):
            if step.status == "completed":
                continue

            context.current_step_index = i

            # 链式数据流：将前一步的输出注入当前步骤的参数
            if i > 0 and step.input_from_step:
                # 解析引用的步骤 ID
                ref_key = step.input_from_step
                if ref_key.startswith("step:") or ref_key.startswith("result:"):
                    ref_id = ref_key.split(":", 1)[1]
                else:
                    ref_id = ref_key

                # 从已执行的结果中查找
                prev_result = None
                for r in all_results:
                    if r.step_id == ref_id:
                        prev_result = r
                        break
                # 也查 context 中已有的结果
                if prev_result is None:
                    prev_result = context.step_results.get(ref_id)

                if prev_result and prev_result.content:
                    param_name = step.input_param_name or "input"
                    step.tool_params = dict(step.tool_params or {})
                    step.tool_params[param_name] = prev_result.content
                    log.info(
                        "Chain data flow",
                        step=step.step_id,
                        input_from=ref_id,
                        param=param_name,
                        content_length=len(prev_result.content),
                    )

            # 执行当前步骤
            result = await self._execute_step(step, context)
            all_results.append(result)
            context.step_results[step.step_id] = result

            if result.success:
                step.transition_state(StepState.COMPLETED)
                if result.content:
                    messages.append({"role": "assistant", "content": result.content})
            else:
                step.transition_state(StepState.FAILED)
                corrected_result = await self._retry_with_reflection(
                    step, result, context,
                )
                all_results.append(corrected_result)
                context.step_results[step.step_id] = corrected_result
                if corrected_result.success:
                    if step.can_transition_to(StepState.COMPLETED):
                        step.transition_state(StepState.COMPLETED)
                    if corrected_result.content:
                        messages.append(
                            {"role": "assistant", "content": corrected_result.content}
                        )
                else:
                    if step.can_transition_to(StepState.FAILED):
                        step.transition_state(StepState.FAILED)
                    messages.append(
                        {"role": "assistant", "content": f"链步骤失败: {step.description}"}
                    )
                    break

        completed = all(r.success for r in all_results) if all_results else True
        return ExecutorOutput(
            messages=messages,
            tool_calls_count=sum(1 for r in all_results if r.tool_name),
            tool_duration=sum(r.duration_ms for r in all_results),
            completed_naturally=completed,
            step_results=all_results,
        )

    async def execute_parallel(
        self,
        steps: list[PlanStep],
        context: LoopContext,
    ) -> ExecutorOutput:
        """并行执行无依赖的独立步骤。

        利用 asyncio.gather 并发执行多个步骤，适用于 CausalModeler 识别出的
        并行组。失败步骤不影响其他步骤的执行，所有步骤均会尝试完成。

        Args:
            steps: 独立（无依赖）的步骤列表
            context: 循环上下文

        Returns:
            执行结果（含所有步骤的结果，顺序与输入一致）
        """
        pending = [s for s in steps if s.status != "completed"]
        if not pending:
            return ExecutorOutput(
                messages=list(context.messages),
                tool_calls_count=0,
                tool_duration=0.0,
                completed_naturally=True,
                step_results=[],
            )

        log.info(
            "Parallel execution",
            step_count=len(pending),
            step_ids=[s.step_id for s in pending],
        )

        # 并发执行所有独立步骤
        tasks = [self._execute_step_safe(step, context) for step in pending]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        all_results: list[StepResult] = []
        messages = list(context.messages)

        for step, result in zip(pending, results):
            if isinstance(result, Exception):
                sr = StepResult(
                    step_id=step.step_id,
                    success=False,
                    error=f"并行执行异常: {result}",
                    tool_name=step.tool_name,
                    duration_ms=0.0,
                )
                all_results.append(sr)
                context.step_results[step.step_id] = sr
                step.transition_state(StepState.FAILED)
            else:
                all_results.append(result)
                context.step_results[step.step_id] = result
                if result.success:
                    step.transition_state(StepState.COMPLETED)
                    if result.content:
                        messages.append({"role": "assistant", "content": result.content})
                else:
                    step.transition_state(StepState.FAILED)

        completed = all(r.success for r in all_results) if all_results else True
        return ExecutorOutput(
            messages=messages,
            tool_calls_count=sum(1 for r in all_results if r.tool_name),
            tool_duration=sum(r.duration_ms for r in all_results),
            completed_naturally=completed,
            step_results=all_results,
        )

    async def execute_hybrid(
        self,
        plan: ExecutionPlan,
        context: LoopContext,
        parallel_groups: list[list[str]] | None = None,
    ) -> ExecutorOutput:
        """混合执行：自动识别并行组，组内并行、组间顺序。

        利用 CausalModeler 的依赖分析结果，将步骤分为顺序执行的组，
        同一组内的步骤并行执行，最大化 I/O 并发度。

        Args:
            plan: 执行计划。
            context: 循环上下文。
            parallel_groups: 并行组（每组为 step_id 列表），None 时全部顺序执行。

        Returns:
            ExecutorOutput: 执行结果。
        """
        if plan.simple and plan.steps:
            result = await self._execute_step(plan.steps[0], context)
            messages = list(context.messages)
            if result.content:
                messages.append({"role": "assistant", "content": result.content})
            return ExecutorOutput(
                messages=messages,
                tool_calls_count=1 if result.tool_name else 0,
                tool_duration=result.duration_ms,
                completed_naturally=result.success,
                step_results=[result],
            )

        # 构建 step_id → PlanStep 映射
        step_map: dict[str, PlanStep] = {s.step_id: s for s in plan.steps}

        # 如果没有并行组或只有一组，按原逻辑执行
        if not parallel_groups or len(parallel_groups) <= 1:
            return await self.execute(plan, context)

        all_results: list[StepResult] = []
        messages = list(context.messages)

        for group_ids in parallel_groups:
            group_steps = [step_map[sid] for sid in group_ids if sid in step_map]
            if not group_steps:
                continue

            # 跳过已完成的步骤
            pending = [s for s in group_steps if s.status != "completed"]
            if not pending:
                continue

            if len(pending) == 1:
                # 单步骤：顺序执行
                step = pending[0]
                if context.is_cancelled():
                    break
                result = await self._execute_step(step, context)
                all_results.append(result)
                context.step_results[step.step_id] = result
                if result.success:
                    step.transition_state(StepState.COMPLETED)
                    if result.content:
                        messages.append({"role": "assistant", "content": result.content})
                else:
                    step.transition_state(StepState.FAILED)
                    corrected = await self._retry_with_reflection(step, result, context)
                    all_results.append(corrected)
                    context.step_results[step.step_id] = corrected
                    if corrected.success:
                        if step.can_transition_to(StepState.COMPLETED):
                            step.transition_state(StepState.COMPLETED)
                    else:
                        if step.can_transition_to(StepState.FAILED):
                            step.transition_state(StepState.FAILED)
            else:
                # 多步骤：并行执行
                log.info(
                    "Hybrid parallel group",
                    group_size=len(pending),
                    step_ids=[s.step_id for s in pending],
                )
                group_results = await self._execute_parallel_group(pending, context)
                all_results.extend(group_results)
                for sr, step in zip(group_results, pending):
                    context.step_results[step.step_id] = sr
                    if sr.success:
                        step.transition_state(StepState.COMPLETED)
                        if sr.content:
                            messages.append({"role": "assistant", "content": sr.content})
                    else:
                        step.transition_state(StepState.FAILED)

        completed = all(r.success for r in all_results) if all_results else True
        return ExecutorOutput(
            messages=messages,
            tool_calls_count=sum(1 for r in all_results if r.tool_name),
            tool_duration=sum(r.duration_ms for r in all_results),
            completed_naturally=completed,
            step_results=all_results,
        )

    async def _execute_parallel_group(
        self,
        steps: list[PlanStep],
        context: LoopContext,
    ) -> list[StepResult]:
        tasks = [self._execute_step_safe(step, context) for step in steps]
        raw_results = await asyncio.gather(*tasks, return_exceptions=True)
        results: list[StepResult] = []
        for step, raw in zip(steps, raw_results):
            if isinstance(raw, Exception):
                results.append(StepResult(
                    step_id=step.step_id,
                    success=False,
                    error=f"并行执行异常: {raw}",
                    tool_name=step.tool_name,
                    duration_ms=0.0,
                ))
            else:
                results.append(raw)
        return results

    async def _execute_step_safe(
        self,
        step: PlanStep,
        context: LoopContext,
    ) -> StepResult:
        """安全执行单个步骤，捕获所有异常防止并行执行中一个失败影响其他。"""
        try:
            return await self._execute_step(step, context)
        except Exception as e:
            log.debug("executor 异常处理", error=str(e))
            return StepResult(
                step_id=step.step_id,
                success=False,
                error=str(e),
                tool_name=step.tool_name,
                duration_ms=0.0,
            )

    async def _execute_step(
        self,
        step: PlanStep,
        context: LoopContext,
    ) -> StepResult:
        current = step.step_state
        if current == StepState.RETRYING:
            pass
        else:
            if step.can_transition_to(StepState.READY):
                step.transition_state(StepState.READY)
            if step.can_transition_to(StepState.RUNNING):
                step.transition_state(StepState.RUNNING)

        prediction = None
        if self._prediction_loop is not None:
            try:
                prediction = self._prediction_loop.predict_step(step, context)
            except Exception as _exc:
                log.debug("executor 异常处理", error=str(_exc))
                log_ignored(log, "executor.Executor._execute_step.predict", _exc)

        if step.tool_name and self._tool_registry:
            result = await self._execute_with_tool(step, context)
        else:
            result = await self._execute_with_llm(step, context)

        if self._prediction_loop is not None and prediction is not None:
            try:
                vr = self._prediction_loop.verify_step(prediction, result)
                self._prediction_loop.record_observation(
                    step.tool_name or "llm",
                    result.success,
                    result.duration_ms,
                )
                if vr.outcome.value != "match" and vr.outcome.value != "no_prediction":
                    log.info(
                        "W3-3: Prediction deviation detected",
                        step_id=step.step_id,
                        tool=step.tool_name,
                        outcome=vr.outcome.value,
                        deviation=round(vr.deviation_score, 2),
                        adjustment=vr.adjustment.value,
                    )
                if result.metadata is None:
                    result.metadata = {}
                result.metadata["prediction_outcome"] = vr.outcome.value
                result.metadata["prediction_adjustment"] = vr.adjustment.value
            except Exception as _exc:
                log.debug("executor 异常处理", error=str(_exc))
                log_ignored(log, "executor.Executor._execute_step.verify", _exc)

        return result

    async def _retry_with_reflection(
        self,
        step: PlanStep,
        failed_result: StepResult,
        context: LoopContext,
    ) -> StepResult:
        """使用反思引擎进行重试，支持错误类型路由。

        错误类型路由（省 LLM 调用）：
        - NETWORK_ERROR / TIMEOUT / RETRYABLE → 指数退避重试，不调 LLM
        - PARAM_ERROR / SYNTAX_ERROR → LLM 反思修正参数
        - TOOL_UNAVAILABLE → 直接降级替代工具，不调 LLM
        - 其他 → 走完整反思（含参数修正 + 工具替代）
        """
        if step.can_transition_to(StepState.RETRYING):
            step.transition_state(StepState.RETRYING)

        result = failed_result
        step.retry_count += 1

        # 如果鲁棒性功能未启用或没有反思引擎，使用简单重试
        if not self._robustness.enabled or not self._reflection or not step.tool_name:
            if step.retry_count < step.max_retries:
                return await self._execute_step(step, context)
            return result

        # 错误类型分类
        error_type = self._robustness.classify_error(
            result.error or "",
            step.tool_name,
        )

        # ─── 类型路由：网络/超时类 → 指数退避，不调 LLM ───
        if error_type in (ErrorType.NETWORK_ERROR, ErrorType.TIMEOUT, ErrorType.RETRYABLE,
                          ErrorType.RATE_LIMITED, ErrorType.OVERLOADED):
            return await self._retry_with_backoff(step, error_type, context)

        # ─── 类型路由：工具不可用 → 直接降级，不调 LLM ───
        if error_type == ErrorType.TOOL_UNAVAILABLE:
            return await self._retry_with_fallback(step, context)

        max_reflection_retries = min(
            self._get_dynamic_max_retries(),
            step.max_retries,
        )

        reflection = None
        for attempt in range(max_reflection_retries):
            if step.retry_count >= step.max_retries:
                break

            # ─── 类型路由：参数/语法错 → LLM 修正参数 ───
            if error_type in (ErrorType.PARAM_ERROR, ErrorType.SYNTAX_ERROR):
                reflection = await self._reflection.reflect(
                    tool_name=step.tool_name,
                    args=dict(step.tool_params) if step.tool_params else {},
                    error=result.error or "unknown error",
                    context={"step_id": step.step_id, "attempt": attempt + 1,
                             "error_type": error_type, "focus": "param_correction"},
                )
                if reflection.corrected_args:
                    step.tool_params = reflection.corrected_args
                    log.info(
                        "Param error: corrected by reflection",
                        tool=step.tool_name,
                        attempt=attempt + 1,
                    )
                elif reflection.should_retry:
                    continue
                else:
                    break

            else:
                # ─── 通用反思路径（当前逻辑） ───
                reflection = await self._reflection.reflect(
                    tool_name=step.tool_name,
                    args=dict(step.tool_params) if step.tool_params else {},
                    error=result.error or "unknown error",
                    context={"step_id": step.step_id, "attempt": attempt + 1},
                )

                if self._robustness.config.enable_metrics:
                    self._robustness.metrics.record_reflection(False)

                if not reflection.should_retry:
                    log.info(
                        "Reflection suggests no retry",
                        tool=step.tool_name,
                        reason=reflection.root_cause,
                    )
                    break

                if reflection.corrected_args:
                    step.tool_params = reflection.corrected_args
                    log.info(
                        "Retrying with corrected params",
                        tool=step.tool_name,
                        attempt=attempt + 1,
                        corrected_args=list(reflection.corrected_args.keys()),
                    )

                if reflection.alternative_tool and self._tool_registry:
                    definition = self._tool_registry.get_definition(reflection.alternative_tool)
                    if definition:
                        original_tool = step.tool_name  # 保存原始工具名
                        step.tool_name = reflection.alternative_tool
                        log.info(
                            "Switching to alternative tool (from reflection)",
                            original=original_tool,
                            alternative=reflection.alternative_tool,
                        )
                        # P1-2: 经验迁移 — 从原工具迁移经验到替代工具
                        if self._reflection:
                            try:
                                migrated = self._reflection.transfer_experience(
                                    source_tool=original_tool,  # 修复: 用原始工具名，不是已替换的 step.tool_name
                                    target_tool=reflection.alternative_tool,
                                )
                                if migrated:
                                    log.info(
                                        "Experience transferred",
                                        source=original_tool,
                                        target=reflection.alternative_tool,
                                        count=len(migrated),
                                    )
                            except Exception as _exc:
                                log.debug("executor 异常处理", error=str(_exc))
                                log_ignored(log, "executor.Executor._retry_with_reflection", _exc)

            # 工具替代：通用路径和参数路径都执行到此
            # 注意：替代工具已在上面（第406-430行）设置，这里只做 fallback 检查
            if reflection is not None and not (
                error_type in (ErrorType.PARAM_ERROR, ErrorType.SYNTAX_ERROR)
                and reflection.corrected_args
            ):
                if not reflection.alternative_tool:  # 只在 reflection 未提供替代工具时检查 robustness fallback
                    if self._robustness.has_tool_alternatives(step.tool_name):
                        alternatives = self._robustness.get_tool_alternatives(step.tool_name)
                        if alternatives:
                            alt = alternatives[0]
                            if self._tool_registry.get_definition(alt.tool):
                                step.tool_name = alt.tool
                                step.tool_params = alt.arg_transform(step.tool_params or {})
                                log.info(
                                    "Switching to alternative tool (from robustness fallback)",
                                    original=step.tool_name,
                                    alternative=alt.tool,
                                )
                    # 使用鲁棒性模块的降级映射作为后备
                    alternatives = self._robustness.get_tool_alternatives(step.tool_name)
                    if alternatives:
                        alt = alternatives[0]
                        if self._tool_registry.get_definition(alt.tool):
                            step.tool_name = alt.tool
                            step.tool_params = alt.arg_transform(step.tool_params or {})
                            log.info(
                                "Switching to alternative tool (from robustness fallback)",
                                original=step.tool_name,
                                alternative=alt.tool,
                            )

            step.retry_count += 1
            result = await self._execute_step(step, context)

            if result.success:
                log.info(
                    "Reflection-driven retry succeeded",
                    tool=step.tool_name,
                    attempt=attempt + 1,
                )
                # 记录反思成功指标
                if self._robustness.config.enable_metrics:
                    self._robustness.metrics.record_reflection(True)

                # 记录经验
                if self._reflection:
                    from agent.loop.reflection import ExperienceEntry
                    self._reflection.record_experience(ExperienceEntry(
                        tool_name=step.tool_name,
                        args=step.tool_params or {},
                        error=failed_result.error or "",
                        root_cause=reflection.root_cause,
                        resolution=f"修正参数后重试成功(第{attempt+1}次)",
                        success=True,
                    ))
                return result

        log.warning(
            "Reflection-driven retries exhausted",
            tool=step.tool_name,
            error=result.error,
            retries=step.retry_count,
        )
        return result

    @otel_trace("tool.execute")
    async def _execute_with_tool(
        self,
        step: PlanStep,
        context: LoopContext,
    ) -> StepResult:
        """执行工具调用，支持断路器保护、自动重试和错误分类。

        增强：
        - 断路器保护：工具连续失败时自动熔断，避免拖慢循环
        - 集成错误分类器，区分不同类型的错误
        - 支持指数退避重试
        - 支持工具降级
        - 记录效果监控指标
        """
        start = time.time()
        tool_name = step.tool_name or ""
        tool_params = dict(step.tool_params) if step.tool_params else {}

        try:
            _otel_trace_api.get_current_span().set_attribute("tool_name", tool_name)
        except Exception as _exc:
            log.debug("executor 异常处理", error=str(_exc))
            log_ignored(log, "executor.Executor._execute_with_tool", _exc)

        if not tool_params and step.description:
            tool_params = await self._infer_tool_params(tool_name, step.description, context)

        # C1: Schema 参数校验（与主聊天路径 conversation_loop._execute_tool_call 对齐）。
        # 在 step 级（重试循环之前）拦截非法参数，fail-closed 拒绝执行。
        if self._schema_validator:
            try:
                definition = self._tool_registry.get_definition(tool_name) if self._tool_registry else None
                if definition and hasattr(definition, "parameters"):
                    from agent.tools.schema_validator import ToolParameterDef as SVParamDef

                    param_defs: dict[str, SVParamDef] = {}
                    required_params: list[str] = []
                    for p in definition.parameters:
                        param_defs[p.name] = SVParamDef(
                            name=p.name,
                            type=getattr(p, "type", "string"),
                            description=getattr(p, "description", ""),
                            required=getattr(p, "required", False),
                            enum=getattr(p, "enum", None),
                            default=getattr(p, "default", None),
                        )
                        if getattr(p, "required", False):
                            required_params.append(p.name)
                    sv_result = self._schema_validator.validate(tool_params, param_defs, required_params)
                    if not sv_result.valid:
                        duration = (time.time() - start) * 1000
                        log.warning(
                            "Schema validation failed (executor)",
                            tool=tool_name,
                            errors=sv_result.errors,
                        )
                        return StepResult(
                            step_id=step.step_id,
                            success=False,
                            error=f"参数校验失败: {'; '.join(sv_result.errors)}",
                            tool_name=tool_name,
                            tool_params=tool_params,
                            duration_ms=duration,
                            metadata={"schema_validation_failed": True},
                        )
                    tool_params = sv_result.sanitized_params
            except Exception as exc:
                log.debug("executor 异常处理", error=str(exc))
                # D6（审计 §1.7）：Schema 校验异常不得静默放行，改为 fail-closed 拦截。
                duration = (time.time() - start) * 1000
                log.error("Schema校验异常，拒绝执行 (executor)", tool=tool_name, error=str(exc))
                return StepResult(
                    step_id=step.step_id,
                    success=False,
                    error=f"参数校验异常，已拒绝执行: {exc}",
                    tool_name=tool_name,
                    tool_params=tool_params,
                    duration_ms=duration,
                    metadata={"schema_validation_error": True},
                )

        # C1: 工具调用守卫（去重/缓存/限速），step 级一次检查；被拦截则直接返回，不进入执行/重试。
        if self._tool_call_guard:
            try:
                _gr = self._tool_call_guard.check(tool_name, tool_params)
                if _gr.blocked:
                    gr_result = _gr.result or {}
                    gr_success = gr_result.get("success", True)
                    gr_output = gr_result.get("output", "")
                    gr_meta = gr_result.get("metadata", {}) or {}
                    duration = (time.time() - start) * 1000
                    log.info("工具调用被守卫拦截 (executor)", tool=tool_name, reason=_gr.reason)
                    return StepResult(
                        step_id=step.step_id,
                        success=gr_success,
                        content=gr_output,
                        tool_name=tool_name,
                        tool_params=tool_params,
                        error=None,
                        duration_ms=duration,
                        metadata={**gr_meta, "guard_blocked": True, "guard_reason": _gr.reason},
                    )
            except Exception as exc:
                log.debug("executor 异常处理", error=str(exc))
                # D6（审计 §1.7）：守卫检查异常不得静默放行（fail-open），改为 fail-closed 拦截。
                duration = (time.time() - start) * 1000
                log.error("工具调用守卫异常，拒绝执行 (executor)", tool=tool_name, error=str(exc))
                return StepResult(
                    step_id=step.step_id,
                    success=False,
                    error=f"工具调用守卫异常，已拒绝执行: {exc}",
                    tool_name=tool_name,
                    tool_params=tool_params,
                    duration_ms=duration,
                    metadata={"tool_guard_error": True},
                )

        # Phase 3+4: ActionSandbox 风险预检 — 高风险操作拦截
        if self._action_sandbox is not None:
            try:
                risk_result = self._action_sandbox.pre_check(
                    action_type=tool_name,
                    target=str(tool_params)[:200],
                    params=tool_params,
                )
                if not risk_result.allowed:
                    duration = (time.time() - start) * 1000
                    log.warning(
                        "ActionSandbox blocked tool",
                        tool=tool_name,
                        risk_level=risk_result.risk_level,
                        reason=risk_result.blocked_reason or risk_result.reason,
                    )
                    return StepResult(
                        step_id=step.step_id,
                        success=False,
                        error=f"操作被安全沙箱拦截: {risk_result.blocked_reason or risk_result.reason}",
                        tool_name=tool_name,
                        tool_params=tool_params,
                        duration_ms=duration,
                        metadata={"sandbox_blocked": True, "risk_level": risk_result.risk_level.value if hasattr(risk_result.risk_level, 'value') else str(risk_result.risk_level)},
                    )
            except Exception as _exc:
                log.debug("executor 异常处理", error=str(_exc))
                log_ignored(log, "executor.Executor._execute_with_tool.sandbox", _exc)

        # Phase 3+4: SmartToolCache 缓存命中检查 — 幂等工具直接返回缓存
        if self._smart_tool_cache is not None:
            try:
                cached = self._smart_tool_cache.get(tool_name, tool_params)
                if cached is not None:
                    duration = (time.time() - start) * 1000
                    log.info(
                        "SmartToolCache hit",
                        tool=tool_name,
                        duration=f"{duration:.0f}ms",
                    )
                    return StepResult(
                        step_id=step.step_id,
                        success=True,
                        content=str(cached),
                        tool_name=tool_name,
                        tool_params=tool_params,
                        error=None,
                        duration_ms=duration,
                        metadata={"cache_hit": True},
                    )
            except Exception as _exc:
                log.debug("executor 异常处理", error=str(_exc))
                log_ignored(log, "executor.Executor._execute_with_tool.cache_get", _exc)

        log.info("Executing tool", tool=tool_name, step_id=step.step_id)

        circuit = get_circuit(f"tool:{tool_name}", failure_threshold=3, recovery_timeout=30.0)
        if not circuit.allow_request():
            log.warning("Tool circuit breaker open", tool=tool_name, state=circuit.state)
            if self._robustness.has_tool_alternatives(tool_name):
                alternatives = self._robustness.get_tool_alternatives(tool_name)
                for alt in alternatives:
                    if self._tool_registry and self._tool_registry.get_definition(alt.tool):
                        alt_circuit = get_circuit(f"tool:{alt.tool}", failure_threshold=3, recovery_timeout=30.0)
                        if alt_circuit.allow_request():
                            log.info("Circuit breaker: using fallback tool", original=tool_name, alternative=alt.tool)
                            alt_params = alt.arg_transform(tool_params)
                            try:
                                result = await asyncio.wait_for(
                                    self._run_tool(alt.tool, alt_params),
                                    timeout=_DEFAULT_TOOL_TIMEOUT,
                                )
                                if result.success:
                                    alt_circuit.record_success()
                                    duration = (time.time() - start) * 1000
                                    return StepResult(
                                        step_id=step.step_id,
                                        success=True,
                                        content=result.output or "",
                                        tool_name=alt.tool,
                                        error=None,
                                        duration_ms=duration,
                                    )
                            except Exception as _exc:
                                log.debug("executor 异常处理", error=str(_exc))
                                log_ignored(log, "executor.Executor._execute_with_tool", _exc)
            duration = (time.time() - start) * 1000
            return StepResult(
                step_id=step.step_id,
                success=False,
                error=f"工具 '{tool_name}' 熔断中 (state={circuit.state}, failures={circuit.failure_count})，无可用替代工具",
                tool_name=tool_name,
                tool_params=tool_params,
                duration_ms=duration,
            )

        trace_id = context.trace_id or "default"
        last_error = ""
        last_error_type = ErrorType.UNKNOWN

        for attempt in range(self._robustness.config.retry_config.max_retries + 1):
            try:
                # 超时保护：防止单个工具调用无限期阻塞
                result = await asyncio.wait_for(
                    self._run_tool(tool_name, tool_params),
                    timeout=_DEFAULT_TOOL_TIMEOUT,
                )
                duration = (time.time() - start) * 1000

                if result.success:
                    content = result.output or ""
                    circuit.record_success()
                    log.info(
                        "Tool succeeded",
                        tool=tool_name,
                        duration=f"{duration:.0f}ms",
                        attempt=attempt + 1,
                    )
                    # 记录成功指标
                    if self._robustness.config.enable_metrics:
                        self._robustness.metrics.record_tool_call(True, duration)

                    # OTel 指标与 span 属性：工具调用成功
                    try:
                        tool_calls_counter().add(
                            1, {"tool_name": tool_name, "status": "success"}
                        )
                        tool_duration_histogram().record(duration / 1000.0)
                        _otel_trace_api.get_current_span().set_attribute(
                            "tool_success", True
                        )
                    except Exception as _exc:
                        log.debug("executor 异常处理", error=str(_exc))
                        log_ignored(log, "executor.Executor._execute_with_tool", _exc)

                    # P1-1: 桌面操作自动验证 — 感知闭环协同
                    perception_meta: dict[str, Any] | None = None
                    if self._perception_loop and tool_name in _DESKTOP_TOOL_NAMES:
                        try:
                            verify_result = await self._perception_loop.verify_only(
                                action_description=step.description or tool_name,
                                strategy="auto",
                            )
                            perception_meta = {
                                "perception_verified": True,
                                "perception_success": verify_result.success,
                                "perception_confidence": verify_result.confidence,
                                "perception_method": verify_result.method,
                                "perception_evidence": verify_result.evidence[:200] if verify_result.evidence else "",
                            }
                            if not verify_result.success and verify_result.retry_suggested:
                                perception_meta["perception_retry_suggested"] = True
                                perception_meta["perception_retry_action"] = verify_result.retry_action
                            log.info(
                                "Perception verification",
                                tool=tool_name,
                                verified=verify_result.success,
                                confidence=verify_result.confidence,
                                method=verify_result.method,
                            )
                        except Exception as _exc:
                            log.debug("executor 异常处理", error=str(_exc))
                            log_ignored(log, "executor.Executor._execute_with_tool.perception", _exc)

                    step_meta = {}
                    if perception_meta:
                        step_meta["perception"] = perception_meta

                    # C1: 工具调用守卫记录（与主聊天路径对齐）——仅在 step 真正执行成功时记录一次，
                    # 供去重/缓存/限速跨路径（conversation_loop 与 LoopController 共用同一实例）生效。
                    if self._tool_call_guard:
                        try:
                            self._tool_call_guard.record(
                                tool_name, tool_params,
                                {"success": True, "output": content},
                            )
                        except Exception as _exc:
                            log.debug("executor 异常处理", error=str(_exc))
                            log_ignored(log, "executor.Executor._execute_with_tool.guard_record", _exc)

                    # Phase 3+4: SmartToolCache 缓存存储 — 成功结果写入缓存
                    if self._smart_tool_cache is not None:
                        try:
                            self._smart_tool_cache.put(
                                tool_name=tool_name,
                                params=tool_params,
                                result=content,
                                latency_ms=duration,
                            )
                        except Exception as _exc:
                            log.debug("executor 异常处理", error=str(_exc))
                            log_ignored(log, "executor.Executor._execute_with_tool.cache_put", _exc)

                    # P2-5: 记录可回滚动作到回滚链
                    self._record_rollback_entry(step.step_id, tool_name, tool_params)

                    return StepResult(
                        step_id=step.step_id,
                        success=True,
                        content=content,
                        tool_name=tool_name,
                        tool_params=tool_params,
                        error=None,
                        duration_ms=duration,
                        metadata=step_meta if step_meta else None,
                    )
                else:
                    last_error = result.error or "工具执行失败"
                    last_error_type = self._robustness.classify_error(last_error, tool_name)
                    circuit.record_failure()
                    log.warning(
                        "Tool failed",
                        tool=tool_name,
                        error=last_error,
                        error_type=last_error_type,
                        attempt=attempt + 1,
                        circuit_failures=circuit.failure_count,
                    )

            except asyncio.TimeoutError:
                last_error = f"工具 '{tool_name}' 执行超时 (>{_DEFAULT_TOOL_TIMEOUT}s)"
                last_error_type = ErrorType.TIMEOUT
                circuit.record_failure()
                log.warning(
                    "Tool timeout",
                    tool=tool_name,
                    timeout_s=_DEFAULT_TOOL_TIMEOUT,
                    attempt=attempt + 1,
                    circuit_failures=circuit.failure_count,
                )

            except Exception as e:
                log.debug("executor 异常处理", error=str(e))
                last_error = str(e)
                last_error_type = self._robustness.classify_error(last_error, tool_name)
                circuit.record_failure()
                log.error(
                    "Tool exception",
                    tool=tool_name,
                    error=last_error,
                    error_type=last_error_type,
                    attempt=attempt + 1,
                    circuit_failures=circuit.failure_count,
                )

            # 判断是否需要重试
            should_retry, error_type, backoff_ms = self._robustness.should_retry_tool(
                trace_id=trace_id,
                error=last_error,
                tool_name=tool_name,
            )

            if not should_retry or attempt >= self._robustness.config.retry_config.max_retries:
                break

            # 记录重试尝试
            self._robustness.record_retry_attempt(trace_id, last_error, tool_name)

            # 指数退避等待
            log.info(
                "Retrying tool",
                tool=tool_name,
                attempt=attempt + 1,
                backoff_ms=f"{backoff_ms:.0f}ms",
                error_type=error_type,
            )
            await asyncio.sleep(backoff_ms / 1000.0)

        # 所有重试都失败了，尝试工具降级
        duration = (time.time() - start) * 1000

        # 记录失败指标
        if self._robustness.config.enable_metrics:
            self._robustness.metrics.record_tool_call(False, duration, last_error_type)

        # 尝试工具降级（第一阶段：仅尝试第一个替代工具）
        if self._robustness.has_tool_alternatives(tool_name):
            alternatives = self._robustness.get_tool_alternatives(tool_name)
            for alt in alternatives:
                # 检查替代工具是否可用
                if self._tool_registry and self._tool_registry.get_definition(alt.tool):
                    log.info(
                        "Trying tool fallback",
                        original=tool_name,
                        alternative=alt.tool,
                        reason=alt.reason,
                    )

                    # 转换参数
                    alt_params = alt.arg_transform(tool_params)

                    try:
                        fallback_start = time.time()
                        result = await asyncio.wait_for(
                            self._run_tool(alt.tool, alt_params),
                            timeout=_DEFAULT_TOOL_TIMEOUT,
                        )
                        fallback_duration = (time.time() - fallback_start) * 1000

                        if result.success:
                            log.info(
                                "Tool fallback succeeded",
                                original=tool_name,
                                alternative=alt.tool,
                            )
                            # 记录降级成功指标
                            if self._robustness.config.enable_metrics:
                                self._robustness.metrics.record_fallback(True)

                            return StepResult(
                                step_id=step.step_id,
                                success=True,
                                content=result.output or "",
                                tool_name=alt.tool,
                                error=None,
                                duration_ms=duration + fallback_duration,
                            )
                        else:
                            log.warning(
                                "Tool fallback failed",
                                original=tool_name,
                                alternative=alt.tool,
                                error=result.error,
                            )
                            last_error = result.error or "降级工具执行失败"
                    except Exception as e:
                        log.warning(
                            "Tool fallback exception",
                            original=tool_name,
                            alternative=alt.tool,
                            error=str(e),
                        )
                        last_error = str(e)

                    # 记录降级失败指标
                    if self._robustness.config.enable_metrics:
                        self._robustness.metrics.record_fallback(False)

                    # 只尝试第一个可用的替代工具（保守策略）
                    break

        # 所有尝试都失败了
        log.warning(
            "Tool execution failed after all retries and fallbacks",
            tool=tool_name,
            error=last_error,
            error_type=last_error_type,
        )

        # OTel 指标与 span 属性：工具调用失败
        try:
            tool_calls_counter().add(
                1, {"tool_name": tool_name, "status": "failed"}
            )
            tool_duration_histogram().record(duration / 1000.0)
            _otel_trace_api.get_current_span().set_attribute("tool_success", False)
        except Exception as _exc:
            log.debug("executor 异常处理", error=str(_exc))
            log_ignored(log, "executor.Executor._execute_with_tool", _exc)

        # Phase 3+4: ToolSelfHealing — 工具自愈尝试（参数修正/替代工具/降级策略）
        if self._tool_self_healing is not None:
            try:
                heal_result = await self._tool_self_healing.heal(
                    tool_name=tool_name,
                    params=tool_params,
                    error=last_error,
                    error_type=last_error_type.value if hasattr(last_error_type, 'value') else str(last_error_type),
                )
                if heal_result.success and heal_result.result is not None:
                    log.info(
                        "ToolSelfHealing recovered",
                        tool=tool_name,
                        strategy=heal_result.strategy,
                    )
                    return StepResult(
                        step_id=step.step_id,
                        success=True,
                        content=str(heal_result.result),
                        tool_name=heal_result.tool_used or tool_name,
                        tool_params=heal_result.params_used or tool_params,
                        error=None,
                        duration_ms=duration,
                        metadata={"self_healed": True, "heal_strategy": heal_result.strategy},
                    )
            except Exception as _exc:
                log.debug("executor 异常处理", error=str(_exc))
                log_ignored(log, "executor.Executor._execute_with_tool.self_healing", _exc)

        return StepResult(
            step_id=step.step_id,
            success=False,
            error=last_error,
            tool_name=tool_name,
            tool_params=tool_params,
            duration_ms=duration,
        )

    async def _execute_with_llm(
        self,
        step: PlanStep,
        context: LoopContext,
    ) -> StepResult:
        start = time.time()
        try:
            messages = [
                {
                    "role": "system",
                    "content": "你是家百星AI助手。请执行以下步骤并返回结果。",
                },
                {"role": "user", "content": step.description},
            ]

            result = await asyncio.wait_for(
                self.llm.chat(messages=messages, use_cache=True),
                timeout=_DEFAULT_LLM_TIMEOUT,
            )
            content = result.get("content", "")
            duration = (time.time() - start) * 1000

            return StepResult(
                step_id=step.step_id,
                success=True,
                content=content,
                tool_name=step.tool_name,
                tool_params=step.tool_params or {},
                duration_ms=duration,
            )
        except Exception as e:
            log.debug("executor 异常处理", error=str(e))
            duration = (time.time() - start) * 1000
            return StepResult(
                step_id=step.step_id,
                success=False,
                error=str(e),
                tool_name=step.tool_name,
                tool_params=step.tool_params or {},
                duration_ms=duration,
            )

    async def _infer_tool_params(
        self,
        tool_name: str,
        step_description: str,
        context: LoopContext,
    ) -> dict[str, Any]:
        if not self._tool_registry:
            return {}

        definition = self._tool_registry.get_definition(tool_name)
        if not definition:
            return {}

        required_params = [p for p in definition.parameters if p.required]
        if not required_params:
            return {}

        prompt = (
            f"工具 '{tool_name}' 需要以下参数:\n"
            + "\n".join(f"- {p.name} ({p.type}): {p.description}" for p in required_params)
            + f"\n\n请根据以下步骤描述，提取参数值:\n{step_description}\n\n"
            + "返回 JSON 格式的参数，例如: {\"path\": \"/some/path\"}\n"
            + "只返回 JSON，不要其他内容。"
        )

        try:
            result = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
                task_type="agentic",
            )
            content = result.get("content", "")
            import re
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                return json.loads(json_match.group())
        except Exception as e:
            log.warning("Failed to infer tool params", tool=tool_name, error=str(e))

        return {}

    def should_replan(
        self,
        evaluations: list[dict[str, Any]],
        rounds_used: int,
    ) -> dict[str, Any]:
        if not evaluations:
            return {"should_replan": False, "reason": "无评估结果"}

        avg_progress = sum(e.get("goal_progress", 0) for e in evaluations) / len(
            evaluations
        )
        any_abort = any(e.get("suggested_action") == "abort" for e in evaluations)

        if any_abort:
            return {"should_replan": False, "reason": "评估建议中止"}

        if avg_progress < 0.3 and rounds_used < 3:
            return {
                "should_replan": True,
                "reason": f"平均进展仅 {avg_progress:.1%}，建议重新规划",
                "adjustment_hint": "更换工具组合或调整步骤顺序",
            }

        return {"should_replan": False, "reason": "执行质量正常"}

    async def execute_and_reflect(
        self,
        plan: ExecutionPlan,
        context: LoopContext,
    ) -> tuple[ExecutorOutput, list[dict[str, Any]]]:
        """执行并反思框架。

        第一阶段核心功能：
        - 执行计划
        - 每轮执行后自动反思
        - 先记录反思结果，后续阶段再应用

        Args:
            plan: 执行计划
            context: 循环上下文

        Returns:
            (执行结果, 反思结果列表)
        """
        # 先执行
        output = await self.execute(plan, context)

        # 如果鲁棒性或反思未启用，直接返回
        if not self._robustness.enabled or not self._robustness.config.enable_reflection:
            return output, []

        # 执行后反思（第一阶段：仅记录，不应用）
        reflections: list[dict[str, Any]] = []

        for step_result in output.step_results:
            if step_result.success:
                # 成功步骤的轻量级反思
                reflection = await self._reflect_on_success(step_result, context)
                if reflection:
                    reflections.append(reflection)
            else:
                # 失败步骤的深度反思
                reflection = await self._reflect_on_failure(step_result, context)
                if reflection:
                    reflections.append(reflection)

        # 记录反思数量
        if self._robustness.config.enable_metrics and reflections:
            log.info(
                "Execute and reflect completed",
                reflection_count=len(reflections),
                success_reflections=sum(1 for r in reflections if r.get("type") == "success"),
                failure_reflections=sum(1 for r in reflections if r.get("type") == "failure"),
            )

        return output, reflections

    async def _reflect_on_success(
        self,
        step_result: StepResult,
        context: LoopContext,
    ) -> dict[str, Any] | None:
        """对成功步骤进行轻量级反思。

        第一阶段：仅记录成功经验，不应用到当前执行。

        Args:
            step_result: 步骤执行结果
            context: 循环上下文

        Returns:
            反思结果字典，或None（如果反思被跳过）
        """
        if not self._reflection:
            return None

        try:
            # 轻量级成功反思（第一阶段简化实现）
            reflection = {
                "type": "success",
                "step_id": step_result.step_id,
                "tool_name": step_result.tool_name,
                "success": True,
                "duration_ms": step_result.duration_ms,
                "insight": "步骤执行成功",
                "timestamp": time.time(),
            }

            # 记录到反思引擎的经验库
            if step_result.tool_name:
                from agent.loop.reflection import ExperienceEntry
                self._reflection.record_experience(ExperienceEntry(
                    tool_name=step_result.tool_name,
                    args={},
                    error="",
                    root_cause="",
                    resolution="成功执行",
                    success=True,
                ))

            return reflection
        except Exception as e:
            log.warning("Success reflection failed", error=str(e))
            return None

    async def _reflect_on_failure(
        self,
        step_result: StepResult,
        context: LoopContext,
    ) -> dict[str, Any] | None:
        """对失败步骤进行深度反思。

        第一阶段：仅记录失败原因和改进建议，不应用到当前执行。

        Args:
            step_result: 步骤执行结果
            context: 循环上下文

        Returns:
            反思结果字典，或None（如果反思被跳过）
        """
        if not self._reflection or not step_result.tool_name:
            return None

        try:
            # 使用反思引擎进行深度分析
            reflection_result = await self._reflection.reflect(
                tool_name=step_result.tool_name,
                args={},
                error=step_result.error or "unknown error",
                context={"step_id": step_result.step_id, "phase": "post_execution"},
            )

            reflection = {
                "type": "failure",
                "step_id": step_result.step_id,
                "tool_name": step_result.tool_name,
                "success": False,
                "error": step_result.error,
                "root_cause": reflection_result.root_cause,
                "corrected_args": reflection_result.corrected_args,
                "alternative_tool": reflection_result.alternative_tool,
                "should_retry": reflection_result.should_retry,
                "duration_ms": step_result.duration_ms,
                "timestamp": time.time(),
            }

            # 错误分类
            error_type = self._robustness.classify_error(
                step_result.error or "",
                step_result.tool_name,
            )
            reflection["error_type"] = error_type

            return reflection
        except Exception as e:
            log.warning("Failure reflection failed", error=str(e))
            return None

    def get_robustness_metrics(self) -> dict[str, Any]:
        """获取鲁棒性监控指标。

        Returns:
            鲁棒性指标摘要
        """
        return self._robustness.get_metrics_summary()

    async def _retry_with_backoff(
        self, step: PlanStep, error_type: str, context: LoopContext
    ) -> StepResult:
        """错误类型路由：网络/超时类错误 → 指数退避+抖动重试，不调 LLM。

        P1-4 增强：添加 full jitter 策略避免惊群效应，
        并支持工具级重试配置覆盖全局默认值。
        """
        import asyncio
        import random

        base_delay = 0.5 if error_type in (ErrorType.RETRYABLE, ErrorType.TIMEOUT) else 1.0
        max_delay = float(os.environ.get("TOOL_RETRY_MAX_DELAY", "30.0"))
        # 预置结果，避免 max_retries==0 时 result 未绑定（审计 L-02）
        result = StepResult(
            step_id=step.step_id,
            success=False,
            error=f"Backoff retries exhausted ({error_type})",
        )
        for attempt in range(self._robustness.config.retry_config.max_retries):
            if step.retry_count >= step.max_retries:
                break
            # P1-4: full jitter — delay = random(0, min(max_delay, base * 2^attempt))
            # 比 decorrelated jitter 更简单且效果相当，避免多实例同时重试
            raw_delay = base_delay * (2 ** attempt)
            capped_delay = min(max_delay, raw_delay)
            delay = random.uniform(0, capped_delay)
            log.info(
                "Retrying with backoff+jitter (no reflection)",
                tool=step.tool_name,
                attempt=attempt + 1,
                delay_ms=int(delay * 1000),
                error_type=error_type,
            )
            await asyncio.sleep(delay)
            step.retry_count += 1
            # 传入真实 context，避免伪造对象导致 AttributeError（审计 L-02）
            result = await self._execute_step(step, context)
            if result.success:
                return result
            if step.retry_count >= step.max_retries:
                break
        return result

    async def _retry_with_fallback(self, step: PlanStep, context: LoopContext) -> StepResult:
        """错误类型路由：工具不可用 → 直接尝试降级替代工具，不调 LLM。"""
        if not self._robustness.has_tool_alternatives(step.tool_name or ""):
            return StepResult(
                step_id=step.step_id, success=False,
                error=f"Tool '{step.tool_name}' unavailable and no fallback registered",
            )
        alternatives = self._robustness.get_tool_alternatives(step.tool_name or "")
        for alt in alternatives:
            if self._tool_registry and self._tool_registry.get_definition(alt.tool):
                step.tool_name = alt.tool
                step.tool_params = alt.arg_transform(step.tool_params or {})
                log.info(
                    "Fallback: switching tool (no reflection)",
                    original=step.tool_name,
                    alternative=alt.tool,
                )
                return await self._execute_step(step, context)
        return StepResult(
            step_id=step.step_id, success=False,
            error=f"No available fallback for tool '{step.tool_name}'",
        )
