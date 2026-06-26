from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from agent.core.logger import StructuredLogger
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
)
from agent.tools.registry import ToolRegistry

log = StructuredLogger("executor")

_MAX_REFLECTION_RETRIES = 3


class Executor:
    def __init__(
        self,
        llm: LLMProvider,
        tool_registry: ToolRegistry | None = None,
        reflection: ReflectionEngine | None = None,
        robustness_manager: RobustnessManager | None = None,
    ) -> None:
        self.llm = llm
        self._tool_registry = tool_registry
        self._reflection = reflection
        # 鲁棒性管理器（第一阶段新增）
        self._robustness = robustness_manager or RobustnessManager.get_instance()

    def set_tool_registry(self, registry: ToolRegistry) -> None:
        self._tool_registry = registry

    def set_reflection(self, reflection: ReflectionEngine) -> None:
        self._reflection = reflection

    def set_robustness_manager(self, manager: RobustnessManager) -> None:
        """设置鲁棒性管理器。"""
        self._robustness = manager

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
            for i, step in enumerate(plan.steps):
                if step.status == "completed":
                    continue

                context.current_step_index = i
                result = await self._execute_step(step, context)
                all_results.append(result)
                context.step_results[step.step_id] = result

                if result.success:
                    step.status = "completed"
                    if result.content:
                        messages.append({"role": "assistant", "content": result.content})
                else:
                    corrected_result = await self._retry_with_reflection(
                        step, result, context,
                    )
                    all_results.append(corrected_result)
                    context.step_results[step.step_id] = corrected_result
                    if corrected_result.success:
                        step.status = "completed"
                        if corrected_result.content:
                            messages.append(
                                {"role": "assistant", "content": corrected_result.content}
                            )
                    else:
                        step.status = "failed"
                        messages.append(
                            {"role": "assistant", "content": f"步骤失败: {step.description}"}
                        )

        completed = all(r.success for r in all_results) if all_results else True
        return ExecutorOutput(
            messages=messages,
            tool_calls_count=sum(1 for r in all_results if r.tool_name),
            tool_duration=sum(r.duration_ms for r in all_results),
            completed_naturally=completed,
            step_results=all_results,
        )

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
                step.status = "completed"
                if result.content:
                    messages.append({"role": "assistant", "content": result.content})
            else:
                # 链中断 → 反思重试
                corrected_result = await self._retry_with_reflection(
                    step, result, context,
                )
                all_results.append(corrected_result)
                context.step_results[step.step_id] = corrected_result
                if corrected_result.success:
                    step.status = "completed"
                    if corrected_result.content:
                        messages.append(
                            {"role": "assistant", "content": corrected_result.content}
                        )
                else:
                    step.status = "failed"
                    messages.append(
                        {"role": "assistant", "content": f"链步骤失败: {step.description}"}
                    )
                    # 链中断：后续步骤不再执行
                    break

        completed = all(r.success for r in all_results) if all_results else True
        return ExecutorOutput(
            messages=messages,
            tool_calls_count=sum(1 for r in all_results if r.tool_name),
            tool_duration=sum(r.duration_ms for r in all_results),
            completed_naturally=completed,
            step_results=all_results,
        )

    async def _execute_step(
        self,
        step: PlanStep,
        context: LoopContext,
    ) -> StepResult:
        if step.tool_name and self._tool_registry:
            return await self._execute_with_tool(step, context)

        return await self._execute_with_llm(step, context)

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
            return await self._retry_with_backoff(step, error_type)

        # ─── 类型路由：工具不可用 → 直接降级，不调 LLM ───
        if error_type == ErrorType.TOOL_UNAVAILABLE:
            return await self._retry_with_fallback(step, context)

        max_reflection_retries = min(
            self._robustness.config.max_reflection_retries,
            step.max_retries,
        )

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
                        step.tool_name = reflection.alternative_tool
                        log.info(
                            "Switching to alternative tool (from reflection)",
                            original=step.tool_name,
                            alternative=reflection.alternative_tool,
                        )
                        # P1-2: 经验迁移 — 从原工具迁移经验到替代工具
                        if self._reflection:
                            try:
                                migrated = self._reflection.transfer_experience(
                                    source_tool=step.tool_name,
                                    target_tool=reflection.alternative_tool,
                                )
                                if migrated:
                                    log.info(
                                        "Experience transferred",
                                        source=step.tool_name,
                                        target=reflection.alternative_tool,
                                        count=len(migrated),
                                    )
                            except Exception:
                                pass

            # 工具替代：通用路径和参数路径都执行到此
            if not (error_type in (ErrorType.PARAM_ERROR, ErrorType.SYNTAX_ERROR) and reflection.corrected_args):
                if reflection.alternative_tool and self._tool_registry:
                    definition = self._tool_registry.get_definition(reflection.alternative_tool)
                    if definition:
                        step.tool_name = reflection.alternative_tool
                elif self._robustness.has_tool_alternatives(step.tool_name):
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

    async def _execute_with_tool(
        self,
        step: PlanStep,
        context: LoopContext,
    ) -> StepResult:
        """执行工具调用，支持自动重试和错误分类。
        
        第一阶段增强：
        - 集成错误分类器，区分不同类型的错误
        - 支持指数退避重试
        - 支持工具降级
        - 记录效果监控指标
        """
        start = time.time()
        tool_name = step.tool_name or ""
        tool_params = dict(step.tool_params) if step.tool_params else {}

        if not tool_params and step.description:
            tool_params = await self._infer_tool_params(tool_name, step.description, context)

        log.info("Executing tool", tool=tool_name, step_id=step.step_id)

        # 使用鲁棒性管理器进行错误分类和重试
        trace_id = context.trace_id or "default"
        last_error = ""
        last_error_type = ErrorType.UNKNOWN

        for attempt in range(self._robustness.config.retry_config.max_retries + 1):
            try:
                result = await self._tool_registry.execute(tool_name, tool_params)
                duration = (time.time() - start) * 1000

                if result.success:
                    content = result.output or ""
                    log.info(
                        "Tool succeeded",
                        tool=tool_name,
                        duration=f"{duration:.0f}ms",
                        attempt=attempt + 1,
                    )
                    # 记录成功指标
                    if self._robustness.config.enable_metrics:
                        self._robustness.metrics.record_tool_call(True, duration)
                    
                    return StepResult(
                        step_id=step.step_id,
                        success=True,
                        content=content,
                        tool_name=tool_name,
                        error=None,
                        duration_ms=duration,
                    )
                else:
                    # 工具执行失败（返回错误信息）
                    last_error = result.error or "工具执行失败"
                    last_error_type = self._robustness.classify_error(last_error, tool_name)
                    log.warning(
                        "Tool failed",
                        tool=tool_name,
                        error=last_error,
                        error_type=last_error_type,
                        attempt=attempt + 1,
                    )

            except Exception as e:
                # 工具执行异常
                last_error = str(e)
                last_error_type = self._robustness.classify_error(last_error, tool_name)
                log.error(
                    "Tool exception",
                    tool=tool_name,
                    error=last_error,
                    error_type=last_error_type,
                    attempt=attempt + 1,
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
                        result = await self._tool_registry.execute(alt.tool, alt_params)
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

        return StepResult(
            step_id=step.step_id,
            success=False,
            error=last_error,
            tool_name=tool_name,
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

            result = await self.llm.chat(messages=messages, use_cache=False)
            content = result.get("content", "")
            duration = (time.time() - start) * 1000

            return StepResult(
                step_id=step.step_id,
                success=True,
                content=content,
                tool_name=step.tool_name,
                duration_ms=duration,
            )
        except Exception as e:
            duration = (time.time() - start) * 1000
            return StepResult(
                step_id=step.step_id,
                success=False,
                error=str(e),
                tool_name=step.tool_name,
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

    async def _retry_with_backoff(self, step: PlanStep, error_type: str) -> StepResult:
        """错误类型路由：网络/超时类错误 → 指数退避重试，不调 LLM。"""
        import asyncio
        base_delay = 0.5 if error_type in (ErrorType.RETRYABLE, ErrorType.TIMEOUT) else 1.0
        for attempt in range(self._robustness.config.retry_config.max_retries):
            if step.retry_count >= step.max_retries:
                break
            delay = base_delay * (2 ** attempt)
            log.info(
                "Retrying with backoff (no reflection)",
                tool=step.tool_name,
                attempt=attempt + 1,
                delay_ms=int(delay * 1000),
                error_type=error_type,
            )
            await asyncio.sleep(delay)
            step.retry_count += 1
            result = await self._execute_step(step, type('ctx', (), {'step_results': {}})())
            if result.success:
                return result
            if step.retry_count >= step.max_retries:
                break
        return result if 'result' in dir() else StepResult(
            step_id=step.step_id, success=False,
            error=f"Backoff retries exhausted ({error_type})",
        )

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
