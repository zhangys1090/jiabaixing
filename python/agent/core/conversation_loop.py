from __future__ import annotations

import json
import time
import uuid
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.think_scrubber import ThinkScrubber
from agent.core.turn_types import (
    ConversationResult,
    IterationBudget,
    ToolCall,
    ToolResult,
    TurnContext,
    TurnState,
)
from agent.llm.provider import LLMProvider
from agent.tools.registry import ToolRegistry

log = StructuredLogger("conversation_loop")

_MAX_TOOL_RETRIES = 3


class ConversationLoop:
    def __init__(
        self,
        llm: LLMProvider,
        tool_registry: ToolRegistry | None = None,
        max_tool_rounds: int = 10,
        max_retries: int = 3,
        permission_guard: Any = None,
        schema_validator: Any = None,
        tool_call_guard: Any = None,
        approval_manager: Any = None,
        hook_manager: Any = None,
    ) -> None:
        self._llm = llm
        self._tool_registry = tool_registry
        self._max_tool_rounds = max_tool_rounds
        self._max_retries = max_retries
        self._permission_guard = permission_guard
        self._schema_validator = schema_validator
        self._tool_call_guard = tool_call_guard
        self._approval_manager = approval_manager
        self._hook_manager = hook_manager
        self._think_scrubber = ThinkScrubber()

    async def run(
        self,
        user_input: str,
        session_id: str = "default",
        system_prompt: str | None = None,
        history: list[dict[str, str]] | None = None,
        use_tools: bool = True,
    ) -> ConversationResult:
        trace_id = f"conv_{uuid.uuid4().hex[:8]}"
        start = time.time()

        turn = TurnContext(
            turn_id=trace_id,
            user_input=user_input,
            state=TurnState.PROCESSING,
            start_time=start,
            max_retries=self._max_retries,
        )

        messages: list[dict[str, Any]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": user_input})
        turn.messages = list(messages)

        budget = IterationBudget(max_tool_rounds=self._max_tool_rounds)
        tools_schema = None
        if use_tools and self._tool_registry and self._tool_registry.size() > 0:
            tools_schema = self._tool_registry.to_openai_tools()

        final_content = ""
        finish_reason = "stop"

        while not budget.is_exhausted:
            budget.increment()

            try:
                response = await self._llm.chat(
                    messages=turn.messages,
                    tools=tools_schema if budget.current_round <= self._max_tool_rounds else None,
                    use_cache=False,
                )
            except Exception as e:
                if turn.retry_count < turn.max_retries:
                    turn.retry_count += 1
                    turn.state = TurnState.RETRYING
                    continue
                turn.state = TurnState.FAILED
                turn.error = str(e)
                final_content = f"请求失败: {e}"
                finish_reason = "error"
                break

            content = response.get("content", "")
            tool_calls_raw = response.get("tool_calls")
            finish_reason = response.get("finish_reason", "stop")

            scrub_result = self._think_scrubber.scrub(content)
            content = scrub_result.cleaned

            if not tool_calls_raw:
                final_content = content
                turn.state = TurnState.COMPLETED
                break

            turn.state = TurnState.TOOL_CALLING

            assistant_msg: dict[str, Any] = {"role": "assistant", "content": content or ""}
            assistant_msg["tool_calls"] = tool_calls_raw
            turn.messages.append(assistant_msg)

            for tc_raw in tool_calls_raw:
                fn = tc_raw.get("function", {})
                tc = ToolCall(
                    id=tc_raw.get("id", f"tc_{uuid.uuid4().hex[:6]}"),
                    name=fn.get("name", ""),
                    arguments=fn.get("arguments", "{}"),
                )
                turn.tool_calls.append(tc)

                tool_result = await self._execute_tool_with_retry(tc)
                turn.tool_results.append(tool_result)
                turn.add_tool_result_message(tc.id, tool_result.output)

        if not final_content and turn.messages:
            for msg in reversed(turn.messages):
                if msg.get("role") == "assistant" and msg.get("content"):
                    final_content = msg["content"]
                    break

        if not final_content:
            final_content = "处理完成，但未生成有效响应。"

        turn.end_time = time.time()
        turn.state = TurnState.COMPLETED

        return ConversationResult(
            content=final_content,
            session_id=session_id,
            trace_id=trace_id,
            tool_calls_made=len(turn.tool_calls),
            tool_results_count=len(turn.tool_results),
            rounds_used=budget.current_round,
            total_tokens=budget.total_tokens_used,
            duration=turn.duration,
            finish_reason=finish_reason,
            metadata={
                "tool_calls": [
                    {"name": tc.name, "id": tc.id}
                    for tc in turn.tool_calls
                ],
                "tool_results": [
                    {"name": tr.name, "success": tr.success}
                    for tr in turn.tool_results
                ],
            },
        )

    async def _execute_tool(self, tool_call: ToolCall) -> ToolResult:
        start = time.time()

        if not self._tool_registry:
            return ToolResult(
                tool_call_id=tool_call.id,
                name=tool_call.name,
                output="工具注册表未初始化",
                success=False,
                error="no tool registry",
                duration=time.time() - start,
            )

        params = tool_call.parse_arguments()

        if self._permission_guard:
            try:
                allowed = self._permission_guard.check(tool_call.name, params)
                if not allowed:
                    return ToolResult(
                        tool_call_id=tool_call.id,
                        name=tool_call.name,
                        output=f"权限不足: 工具 {tool_call.name} 需要更高权限",
                        success=False,
                        error="permission_denied",
                        duration=time.time() - start,
                    )
            except Exception:
                pass

        if self._approval_manager:
            try:
                risk = self._approval_manager._auto_approve_low_risk and "low" or "medium"
                approved = await self._approval_manager.request_approval(
                    tool_name=tool_call.name,
                    params=params,
                    risk_level=risk,
                )
                if not approved.approved:
                    return ToolResult(
                        tool_call_id=tool_call.id,
                        name=tool_call.name,
                        output=f"工具 {tool_call.name} 需要审批: {approved.reason}",
                        success=False,
                        error="approval_denied",
                        duration=time.time() - start,
                    )
            except Exception:
                pass

        if self._hook_manager:
            await self._hook_manager.trigger(
                "beforeToolCall",
                tool_name=tool_call.name,
                tool_call_id=tool_call.id,
            )

        result = await self._tool_registry.execute(tool_call.name, params)

        if self._hook_manager:
            await self._hook_manager.trigger(
                "afterToolCall",
                tool_name=tool_call.name,
                tool_call_id=tool_call.id,
                success=result.success,
            )

        if not result.success and self._hook_manager:
            await self._hook_manager.trigger(
                "onToolError",
                tool_name=tool_call.name,
                tool_call_id=tool_call.id,
                error=result.error or "unknown",
            )

        return ToolResult(
            tool_call_id=tool_call.id,
            name=tool_call.name,
            output=result.output or "",
            success=result.success,
            error=result.error,
            duration=time.time() - start,
        )

    async def _execute_tool_with_retry(self, tool_call: ToolCall) -> ToolResult:
        result = await self._execute_tool(tool_call)

        if result.success:
            log.info("Tool executed", tool=tool_call.name, duration=f"{result.duration:.3f}s")
            return result

        for attempt in range(1, _MAX_TOOL_RETRIES + 1):
            log.warning(
                "Tool failed, analyzing for retry",
                tool=tool_call.name,
                attempt=attempt,
                error=result.error,
            )

            reflection = await self._reflect_on_failure(tool_call, result)
            if not reflection.get("should_retry"):
                log.info("Reflection suggests no retry", tool=tool_call.name, reason=reflection.get("reason", ""))
                break

            corrected_params = reflection.get("corrected_params")
            if corrected_params:
                log.info("Retrying with corrected params", tool=tool_call.name, attempt=attempt)
                start = time.time()
                if self._tool_registry:
                    retry_result = await self._tool_registry.execute(tool_call.name, corrected_params)
                    result = ToolResult(
                        tool_call_id=tool_call.id,
                        name=tool_call.name,
                        output=retry_result.output or "",
                        success=retry_result.success,
                        error=retry_result.error,
                        duration=time.time() - start,
                    )
                if result.success:
                    log.info("Tool retry succeeded", tool=tool_call.name, attempt=attempt)
                    return result
            else:
                break

        log.warning("Tool retries exhausted", tool=tool_call.name, error=result.error)
        return result

    async def _reflect_on_failure(
        self, tool_call: ToolCall, result: ToolResult
    ) -> dict[str, Any]:
        if not result.error:
            return {"should_retry": False, "reason": "no error"}

        error_lower = result.error.lower()
        non_retryable = [
            "not found", "未找到", "不存在", "permission denied",
            "权限", "forbidden", "unauthorized", "invalid tool",
        ]
        for pattern in non_retryable:
            if pattern in error_lower:
                return {"should_retry": False, "reason": f"non-retryable error: {pattern}"}

        params = tool_call.parse_arguments()
        corrected: dict[str, Any] = dict(params)

        if "path" in corrected and ("no such file" in error_lower or "找不到" in error_lower):
            path_val = corrected["path"]
            if not path_val.startswith("/"):
                import os
                candidates = [
                    os.path.join(os.getcwd(), path_val),
                    os.path.join(os.getcwd(), "src", path_val),
                    os.path.join(os.getcwd(), "python", path_val),
                ]
                for candidate in candidates:
                    if os.path.exists(candidate):
                        corrected["path"] = candidate
                        return {"should_retry": True, "corrected_params": corrected}

        if "timeout" in error_lower or "timed out" in error_lower:
            return {"should_retry": True, "corrected_params": corrected}

        if "connection" in error_lower or "refused" in error_lower:
            return {"should_retry": True, "corrected_params": corrected}

        return {"should_retry": True, "corrected_params": None}
