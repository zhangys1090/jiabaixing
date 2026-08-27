"""步骤执行器 — 执行工作流中的各类步骤。

支持四种步骤类型：
1. LLMStepExecutor: 调用 LLM + FC 循环
2. ToolStepExecutor: 直接调用指定工具
3. SubflowStepExecutor: 嵌套子工作流
4. HumanStepExecutor: 等待人工输入/审批

每个执行器返回 dict 结果，由 WorkflowStateMachine 写入变量。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger
from agent.workflow.types import WorkflowStep, StepType
log = StructuredLogger("step_executor")



class StepExecutor:
    """步骤执行器 — 根据步骤类型分派到对应执行器。

    Usage:
        executor = StepExecutor(llm_runner=my_llm_runner, tool_runner=my_tool_runner)
        result = await executor.execute(step, variables)
    """

    def __init__(
        self,
        llm_runner: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
        tool_runner: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
        subflow_runner: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
        human_runner: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
    ) -> None:
        self._llm_runner = llm_runner
        self._tool_runner = tool_runner
        self._subflow_runner = subflow_runner
        self._human_runner = human_runner

    async def execute(
        self,
        step: WorkflowStep,
        variables: dict[str, Any],
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        """执行步骤。

        Args:
            step: 工作流步骤。
            variables: 当前工作流变量。
            timeout_seconds: 步骤超时（覆盖步骤定义）。

        Returns:
            dict: 步骤执行结果。
        """
        timeout = timeout_seconds or step.timeout_seconds
        resolved_prompt = self._resolve_variables(step.prompt, variables)
        resolved_inputs = self._resolve_inputs(step, variables)

        try:
            if step.type == StepType.LLM:
                result = await self._execute_with_timeout(
                    self._execute_llm(step, resolved_prompt, resolved_inputs),
                    timeout,
                )
            elif step.type == StepType.TOOL:
                result = await self._execute_with_timeout(
                    self._execute_tool(step, resolved_inputs),
                    timeout,
                )
            elif step.type == StepType.SUBFLOW:
                result = await self._execute_with_timeout(
                    self._execute_subflow(step, resolved_inputs),
                    timeout,
                )
            elif step.type == StepType.HUMAN:
                result = await self._execute_with_timeout(
                    self._execute_human(step, resolved_prompt, resolved_inputs),
                    timeout * 10,
                )
            else:
                result = {"success": False, "error": f"未知步骤类型: {step.type}"}

            log.info("步骤执行完成", step=step.id, type=step.type, success=result.get("success", True))
            return result

        except asyncio.TimeoutError:
            log.warning("步骤执行超时", step=step.id, timeout=timeout)
            return {"success": False, "error": f"步骤超时 ({timeout}s)"}
        except Exception as e:
            log.error("步骤执行异常", step=step.id, error=str(e))
            return {"success": False, "error": str(e)}

    async def _execute_llm(
        self,
        step: WorkflowStep,
        prompt: str,
        inputs: dict[str, Any],
    ) -> dict[str, Any]:
        if not self._llm_runner:
            return {"success": False, "error": "LLM 执行器未配置"}
        return await self._llm_runner(prompt, inputs)

    async def _execute_tool(
        self,
        step: WorkflowStep,
        inputs: dict[str, Any],
    ) -> dict[str, Any]:
        if not self._tool_runner:
            return {"success": False, "error": "工具执行器未配置"}
        if not step.tool_name:
            return {"success": False, "error": "工具步骤未指定 tool_name"}
        return await self._tool_runner(step.tool_name, inputs)

    async def _execute_subflow(
        self,
        step: WorkflowStep,
        inputs: dict[str, Any],
    ) -> dict[str, Any]:
        if not self._subflow_runner:
            return {"success": False, "error": "子工作流执行器未配置"}
        if not step.subflow_id:
            return {"success": False, "error": "子工作流步骤未指定 subflow_id"}
        return await self._subflow_runner(step.subflow_id, inputs)

    async def _execute_human(
        self,
        step: WorkflowStep,
        prompt: str,
        inputs: dict[str, Any],
    ) -> dict[str, Any]:
        if not self._human_runner:
            return {
                "success": True,
                "action": "waiting_for_human",
                "prompt": prompt,
                "message": f"步骤 '{step.name}' 等待人工操作",
            }
        return await self._human_runner(prompt, inputs)

    async def _execute_with_timeout(
        self,
        coro: Awaitable[dict[str, Any]],
        timeout: float,
    ) -> dict[str, Any]:
        return await asyncio.wait_for(coro, timeout=timeout)

    def _resolve_variables(self, template: str, variables: dict[str, Any]) -> str:
        result = template
        for key, val in variables.items():
            placeholder = f"${{{key}}}"
            if placeholder in result:
                result = result.replace(placeholder, str(val))
            placeholder2 = f"${key}"
            if placeholder2 in result and not placeholder2.endswith("}"):
                result = result.replace(placeholder2, str(val))
        return result

    def _resolve_inputs(self, step: WorkflowStep, variables: dict[str, Any]) -> dict[str, Any]:
        if not step.variables_input:
            return dict(variables)
        resolved = {}
        for local_name, var_name in step.variables_input.items():
            if var_name in variables:
                resolved[local_name] = variables[var_name]
        return resolved
