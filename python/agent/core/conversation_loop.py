from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Callable

from agent.core.error_classifier import ClassifiedError, ErrorClassifier
from agent.core.tool_executor import (
    FailurePolicy,
    ParallelExecConfig,
    ParallelToolExecutor,
    ToolCallItem,
    ToolCallResult,
)
from agent.core.logger import StructuredLogger
from agent.core.think_scrubber import ThinkScrubber
from agent.core.turn_finalizer import TurnFinalizer
from agent.core.retry_utils import RetryPolicy
from agent.core.turn_retry_state import TurnRetryState
from agent.core.turn_types import (
    ConversationResult,
    IterationBudget,
    ToolCall,
    ToolResult,
    TurnContext,
    TurnState,
)
from agent.llm.provider import LLMProvider
from agent.tools.permission_guard import (
    DEFAULT_PERMISSIONS,
    Permission,
    PermissionCheckResult,
    ToolContext,
)
from agent.tools.registry import ToolRegistry

# D2 (P2 第4轮回灌): 会话级认知信号(情绪/反思)注入 ReAct 循环 LLM 上下文
from agent.core.cognition_buffer import inject_cognition_into_messages

log = StructuredLogger("conversation_loop")

_MAX_TOOL_RETRIES = 3


class ConversationLoop:
    """对话循环引擎 — ReAct 模式的多轮工具调用循环。

    管理用户输入到最终响应的完整对话循环，支持：
    - 多轮 LLM 调用 + 工具执行
    - ThinkScrubber 思考过程清洗
    - 工具执行失败自动反思与重试
    - 流式输出（run_stream）

    Usage:
        loop = ConversationLoop(llm=llm, tool_registry=registry)
        result = await loop.run("列出当前目录文件")
        async for event in loop.run_stream("分析代码"):
            print(event)
    """

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
        turn_finalizer: TurnFinalizer | None = None,
        prompt_caching: Any = None,
        tool_selector: "Callable[[str], list[dict[str, Any]]] | None" = None,
        verification_loop: Any = None,
    ) -> None:
        """初始化对话循环。

        Args:
            llm: LLM 提供者实例。
            tool_registry: 工具注册表，None 时禁用工具调用。
            max_tool_rounds: 最大工具调用轮数。
            max_retries: LLM 调用最大重试次数。
            permission_guard: 权限守卫，None 时跳过权限检查。
            schema_validator: Schema 校验器，None 时跳过校验。
            tool_call_guard: 工具调用守卫，None 时跳过守卫。
            approval_manager: 审批管理器，None 时跳过审批。
            hook_manager: 钩子管理器，None 时跳过钩子触发。
            turn_finalizer: 回合终态处理器，None 时使用默认实例。
            prompt_caching: Prompt 前缀缓存管理器，None 时禁用缓存断点标记。
            verification_loop: 验证闭环，None 时跳过工具结果验证与自动纠错回灌。
        """
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
        self._error_classifier = ErrorClassifier()
        self._turn_finalizer = turn_finalizer or TurnFinalizer()
        self._prompt_caching = prompt_caching
        # R2：工具集场景选择器（AGENT_TOOLSET_SAMPLING=on 时由引擎注入，
        # 对输入做场景检测 → 工具集过滤，再生成 OpenAI 工具 schema）。
        # 为 None 时退化为全量工具（旧版行为，零回归）。
        self._tool_selector = tool_selector

        # D8（审计 §1.7）：此前 VerificationLoop.verify_tool_result 与
        # build_correction_prompt 均为零调用点死方法 —— RETRY 动作根本不会产生，
        # 「验证闭环」实为开环。此处接入工具结果验证，失败时把纠错提示回灌到
        # tool 消息，由 ReAct 下一轮自然重试，形成真正闭环。
        self._verification_loop = verification_loop
        self._correction_rounds_used = 0

        # P1-6: 接线此前孤立的 ParallelToolExecutor。
        # 本轮回合无依赖工具数 > 1 时并发执行，最大幅度降低多工具调用延迟。
        # 失败策略 CONTINUE：单工具失败不中断同轮其他工具，等价于历史串行语义。
        # 可用环境变量 PARALLEL_TOOL_EXECUTION=false 关闭（回退串行），
        # MAX_PARALLEL_TOOLS 调整并发度（默认 8）。
        self._parallel_executor = self._build_parallel_executor()

    @staticmethod
    def _build_parallel_executor() -> "ParallelToolExecutor | None":
        """按环境变量构建并行执行器；关闭或配置异常时返回 None（回退串行）。"""
        enabled = os.environ.get("PARALLEL_TOOL_EXECUTION", "true").lower() != "false"
        if not enabled:
            return None
        try:
            max_parallel = int(os.environ.get("MAX_PARALLEL_TOOLS", "8"))
        except ValueError:
            max_parallel = 8
        if max_parallel < 1:
            max_parallel = 1
        return ParallelToolExecutor(
            ParallelExecConfig(
                max_parallel=max_parallel,
                default_timeout=30.0,
                failure_policy=FailurePolicy.CONTINUE,
                enabled=True,
            )
        )

    @staticmethod
    def _safe_parse_args(raw: "str | dict[str, Any]") -> dict[str, Any]:
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}

    def _verify_and_correct(self, tool_result: ToolResult) -> str:
        """D8：验证工具结果，必要时把纠错提示回灌进 tool 消息。

        闭环方式：不额外发起 LLM 调用，而是把 ``build_correction_prompt`` 生成的
        纠错文本追加到本条 tool 消息里。ReAct 主循环下一轮会带着该提示重新决策，
        等价于「验证失败 → 自我修正 → 重试」，且不会破坏工具调用配对。

        纠错回灌次数受 ``VerificationLoop.max_correction_rounds`` 限制，避免
        单回合内无限追加。验证器自身异常一律降级为「不改写输出」，绝不阻断主链路。

        Returns:
            str: 应写入 tool 消息的输出（原样或追加纠错提示后的文本）。
        """
        vloop = self._verification_loop
        if vloop is None:
            return tool_result.output

        try:
            step = vloop.verify_tool_result(
                tool_name=tool_result.name,
                output=tool_result.output,
                success=tool_result.success,
                error=tool_result.error or None,
            )
            vloop.record_step(step)

            action = getattr(step, "action", None)
            action_value = getattr(action, "value", action)
            if action_value not in ("retry", "warn"):
                return tool_result.output

            max_rounds = getattr(vloop, "_max_correction_rounds", 2)
            if self._correction_rounds_used >= max_rounds:
                log.warning(
                    "纠错轮次已达上限，不再回灌纠错提示",
                    tool=tool_result.name,
                    used=self._correction_rounds_used,
                    max_rounds=max_rounds,
                )
                return tool_result.output

            correction = vloop.build_correction_prompt(step, tool_result.output)
            if not correction:
                return tool_result.output

            self._correction_rounds_used += 1
            log.info(
                "验证未通过，回灌纠错提示",
                tool=tool_result.name,
                action=action_value,
                round=self._correction_rounds_used,
            )
            return f"{tool_result.output}\n\n[验证反馈]\n{correction}"
        except Exception as exc:
            # 验证是增强能力而非安全边界，异常不得阻断工具主链路；
            # 但必须留下 error 日志，禁止静默（对齐 D2/D6 治理口径）。
            log.error(
                "工具结果验证异常，跳过纠错回灌",
                tool=tool_result.name,
                error=str(exc),
            )
            return tool_result.output

    async def _dispatch_tool_calls(
        self,
        round_calls: list[ToolCall],
        turn: TurnContext,
        budget: IterationBudget,
    ) -> None:
        """执行本轮全部工具调用。

        并行执行器启用且本轮工具数 > 1 时，无依赖工具并发执行（性能收益最大）；
        否则逐条串行，完全等价于旧行为。失败策略 CONTINUE 保证单工具失败不
        中断同轮其他工具，与历史串行语义一致。结果顺序与原 LLM 返回顺序一致。
        """
        if not round_calls:
            return

        if self._parallel_executor is None or len(round_calls) <= 1:
            for tc in round_calls:
                tool_result = await self._execute_tool_with_retry(tc)
                turn.tool_results.append(tool_result)
                turn.add_tool_result_message(tc.id, self._verify_and_correct(tool_result))
                if not tool_result.success:
                    budget.record_failure()
                else:
                    budget.reset_failure_streak()
            return

        call_by_id = {tc.id: tc for tc in round_calls}
        items = [
            ToolCallItem(
                id=tc.id,
                name=tc.name,
                arguments=self._safe_parse_args(tc.arguments),
            )
            for tc in round_calls
        ]

        async def _exec_one(item: ToolCallItem) -> ToolCallResult:
            dom = call_by_id[item.id]
            dom_result = await self._execute_tool_with_retry(dom)
            return ToolCallResult(
                id=item.id,
                name=item.name,
                success=dom_result.success,
                output=dom_result.output,
                error=dom_result.error or "",
            )

        results, stats = await self._parallel_executor.execute(items, _exec_one)
        for r in results:
            tc = call_by_id.get(r.id)
            if tc is None:
                continue
            dom_result = ToolResult(
                tool_call_id=r.id,
                name=r.name,
                output=r.output,
                success=r.success,
                error=r.error or "",
            )
            turn.tool_results.append(dom_result)
            turn.add_tool_result_message(tc.id, self._verify_and_correct(dom_result))
            if not r.success:
                budget.record_failure()
            else:
                budget.reset_failure_streak()
        log.info(
            "Parallel tool execution dispatched",
            count=len(results),
            parallel_groups=stats.parallel_groups,
            speedup=round(stats.speedup_ratio, 2),
        )

    def _build_tools_schema(
        self,
        user_input: str,
        use_tools: bool,
    ) -> list[dict[str, Any]] | None:
        """构建本轮回合传给 LLM 的工具 schema。

        - use_tools 关闭或工具注册表为空 → 返回 None（不传工具）。
        - 注入了 tool_selector（引擎 select_openai_tools_for_input）→ 调用它做
          场景→工具集过滤（AGENT_TOOLSET_SAMPLING=on 时生效；关闭时返回全量）。
        - 无 tool_selector → 旧版全量工具 schema（零回归）。

        tool_selector 异常时安全退化为全量工具，避免无工具可用。
        """
        if not (use_tools and self._tool_registry and self._tool_registry.size() > 0):
            return None
        if self._tool_selector is not None:
            try:
                selected = self._tool_selector(user_input)
                if selected:
                    return selected
                log.warning("tool_selector 返回空, 退化为全量工具")
            except Exception as e:
                log.warning("tool_selector 失败, 退化为全量工具", error=str(e))
        return self._tool_registry.to_openai_tools()

    async def run(
        self,
        user_input: str,
        session_id: str = "default",
        system_prompt: str | None = None,
        history: list[dict[str, str]] | None = None,
        use_tools: bool = True,
        images: list[dict[str, Any]] | None = None,
    ) -> ConversationResult:
        """执行完整对话循环，返回最终结果。

        ReAct 模式：LLM 生成 → 检测工具调用 → 执行工具 → 结果反馈 →
        重复直到无工具调用或预算耗尽。

        Args:
            user_input: 用户输入文本。
            session_id: 会话 ID。
            system_prompt: 系统提示，None 时不含系统消息。
            history: 历史消息列表，None 时无历史。
            use_tools: 是否启用工具调用。
            images: 多模态图片列表，每项为 {"data": base64, "mime_type": "image/png"}。

        Returns:
            ConversationResult: 包含最终内容、工具调用统计和元数据。
        """
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

        user_message: dict[str, Any] = {"role": "user", "content": user_input}
        if images:
            content_parts: list[dict[str, Any]] = [{"type": "text", "text": user_input}]
            for img in images:
                content_parts.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{img.get('mime_type', 'image/png')};base64,{img['data']}",
                        "detail": img.get("detail", "auto"),
                    },
                })
            user_message = {"role": "user", "content": content_parts}

        messages.append(user_message)
        turn.messages = list(messages)

        # D2 (P2 第4轮回灌): 把会话级认知信号(情绪/反思)注入本轮 LLM 上下文(元认知回灌)。
        # 注入一次(整轮共享), 不每轮重复插入, 避免上下文膨胀。
        try:
            inject_cognition_into_messages(session_id, turn.messages)
        except Exception as exc:
            log.warning("D2 认知信号注入失败(已跳过, 不影响主链路)", error=str(exc))

        budget = IterationBudget(max_tool_rounds=self._max_tool_rounds)
        retry_state = TurnRetryState()

        # T-04: 每轮对话开始时重置工具调用守卫的速率计数和去重窗口。
        if self._tool_call_guard and hasattr(self._tool_call_guard, "reset_round"):
            try:
                self._tool_call_guard.reset_round()
            except Exception as exc:
                # D2（审计 §1.7）：重置失败会让上一轮的去重窗口与速率计数残留，
                # 可能误拦本轮合法调用；不阻断主链路，但禁止静默。
                log.error("工具守卫轮次重置失败，去重/限速窗口可能残留", error=str(exc))

        tools_schema = self._build_tools_schema(user_input, use_tools)

        final_content = ""
        finish_reason = "stop"

        while not budget.is_exhausted and not budget.is_token_exhausted and not budget.is_failure_exhausted:
            budget.increment()
            # OTel追踪：记录循环迭代span
            from agent.core.tracing import get_tracing_manager
            _tracing = get_tracing_manager()
            _iter_span = _tracing.start_span("loop.iteration", {"round": budget.current_round, "trace_id": trace_id})

            try:
                llm_messages = turn.messages
                if self._prompt_caching and hasattr(self._prompt_caching, "mark_cache_breakpoints"):
                    llm_messages = self._prompt_caching.mark_cache_breakpoints(llm_messages)

                response = await self._llm.chat(
                    messages=llm_messages,
                    tools=tools_schema if budget.current_round <= self._max_tool_rounds else None,
                    use_cache=False,
                )
            except Exception as e:
                classified = self._error_classifier.classify_llm_error(
                    e, attempt=retry_state.attempts,
                )
                turn.error = str(e)
                if classified.is_retryable and retry_state.should_retry(e):
                    retry_state.record_attempt(success=False)
                    budget.record_failure()
                    turn.retry_count += 1
                    turn.state = TurnState.RETRYING
                    log.warning(
                        "LLM call failed, retrying",
                        attempt=retry_state.attempts,
                        category=classified.category.value,
                        retry_delay=classified.retry_delay,
                        error=str(e),
                    )
                    _tracing.end_span(_iter_span)
                    continue
                retry_state.record_attempt(success=False)
                budget.record_failure()
                turn.state = TurnState.FAILED
                turn.error = str(e)
                final_content = classified.user_message
                finish_reason = "error"
                _tracing.end_span(_iter_span)
                break

            content = response.get("content", "")
            tool_calls_raw = response.get("tool_calls")
            finish_reason = response.get("finish_reason", "stop")

            usage = response.get("usage", {})
            if usage and isinstance(usage, dict):
                tokens_used = usage.get("total_tokens", 0)
                if tokens_used:
                    budget.add_tokens(tokens_used)

            # LLM 调用成功，重置重试状态
            retry_state.record_attempt(success=True)
            budget.reset_failure_streak()

            scrub_result = self._think_scrubber.scrub(content)
            content = scrub_result.cleaned

            if not tool_calls_raw:
                final_content = content
                turn.state = TurnState.COMPLETED
                _tracing.end_span(_iter_span)
                break

            turn.state = TurnState.TOOL_CALLING

            assistant_msg: dict[str, Any] = {"role": "assistant", "content": content or ""}
            assistant_msg["tool_calls"] = tool_calls_raw
            turn.messages.append(assistant_msg)

            round_calls: list[ToolCall] = []
            for tc_raw in tool_calls_raw:
                fn = tc_raw.get("function", {})
                tc = ToolCall(
                    id=tc_raw.get("id", f"tc_{uuid.uuid4().hex[:6]}"),
                    name=fn.get("name", ""),
                    arguments=fn.get("arguments", "{}"),
                )
                round_calls.append(tc)
                turn.tool_calls.append(tc)

            # P1-6: 优先并行执行（无依赖工具并发），回退串行；语义与原行为一致。
            await self._dispatch_tool_calls(round_calls, turn, budget)
            _tracing.end_span(_iter_span)

        if not final_content and turn.messages:
            for msg in reversed(turn.messages):
                if msg.get("role") == "assistant" and msg.get("content"):
                    final_content = msg["content"]
                    break

        if not final_content:
            # 重试（或预算）耗尽且始终未拿到有效响应：明确标记为失败，
            # 而非伪装成"处理完成"。否则上层无法区分"空响应"与"真实失败"。
            if turn.error:
                final_content = f"请求失败：{turn.error}"
                finish_reason = "error"
                turn.state = TurnState.FAILED
            else:
                final_content = "处理完成，但未生成有效响应。"

        turn.end_time = time.time()
        if turn.state != TurnState.FAILED:
            turn.state = TurnState.COMPLETED

        tool_results_for_finalizer = [
            {"name": tr.name, "result": tr.output, "success": tr.success, "error": tr.error or ""}
            for tr in turn.tool_results
        ]
        finalized = await self._turn_finalizer.finalize(
            turn_output=final_content,
            tool_results=tool_results_for_finalizer,
            metadata={
                "tool_count": len(turn.tool_calls),
                "rounds": budget.current_round,
                "tokens": budget.total_tokens_used,
            },
        )
        final_content = finalized.final_response or final_content

        _tool_successes = sum(1 for tr in turn.tool_results if tr.success)
        _tool_total = max(len(turn.tool_results), 1)
        _initial_quality = 0.7 if finish_reason == "stop" else 0.4
        if turn.tool_results:
            _initial_quality = _tool_successes / _tool_total

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
            quality_score=round(_initial_quality, 4),
            metadata={
                "tool_calls": [
                    {"name": tc.name, "id": tc.id}
                    for tc in turn.tool_calls
                ],
                "tool_results": [
                    {"name": tr.name, "success": tr.success}
                    for tr in turn.tool_results
                ],
                "turn_status": finalized.status.value,
                "tool_summary": finalized.tool_summary,
            },
        )

    def _tool_risk_and_permissions(self, tool_name: str) -> tuple[str, list[Permission]]:
        """从工具定义解析声明的风险等级与所需权限。

        Returns:
            (risk_level, required_permissions)。定义缺失时回退到 ("low", [])。
        """
        risk = "low"
        required: list[Permission] = []
        registry = self._tool_registry
        if registry is not None and hasattr(registry, "get_definition"):
            definition = registry.get_definition(tool_name)
            if definition is not None:
                risk = getattr(definition, "risk_level", "low") or "low"
                for p in getattr(definition, "permissions", []) or []:
                    try:
                        required.append(Permission(p))
                    except ValueError:
                        continue
        return risk, required

    def _check_permission(
        self, tool_name: str, params: dict[str, Any], risk: str, required: list[Permission],
        session_id: str = "default",
    ) -> PermissionCheckResult | None:
        """执行权限检查，返回规范化结果（None 表示无守卫）。

        修复 T-01：历史实现以 `check(name, params)` 错误参数调用 PermissionGuard，
        抛 TypeError 被 `except: pass` 吞掉，且把返回对象当布尔判断（恒 truthy）→ 永不拒绝。
        本实现按正确签名调用，并把 needs_confirmation 交由审批流处理（不在此硬拒）。
        """
        guard = self._permission_guard
        if guard is None:
            return None
        check = getattr(guard, "check", None)
        if not callable(check):
            return None
        ctx = ToolContext(session_id=session_id, permissions=set(DEFAULT_PERMISSIONS))
        try:
            result = check(tool_name, required, risk, ctx)
        except TypeError:
            # 兼容旧式/自定义守卫：check(name, params)
            try:
                result = check(tool_name, params)
            except Exception as exc:  # noqa: BLE001
                log.warning("权限检查异常，按拒绝处理", tool=tool_name, error=str(exc))
                return PermissionCheckResult(allowed=False, reason=f"权限检查异常: {exc}")
        except Exception as exc:  # noqa: BLE001
            log.warning("权限检查异常，按拒绝处理", tool=tool_name, error=str(exc))
            return PermissionCheckResult(allowed=False, reason=f"权限检查异常: {exc}")

        allowed = getattr(result, "allowed", result)
        reason = getattr(result, "reason", "") or ""
        needs_confirmation = getattr(result, "needs_confirmation", False)
        return PermissionCheckResult(
            allowed=bool(allowed), reason=reason, needs_confirmation=bool(needs_confirmation)
        )

    async def _execute_tool(self, tool_call: ToolCall) -> ToolResult:
        """执行单个工具调用，含权限检查、审批和钩子触发。

        Args:
            tool_call: 工具调用描述。

        Returns:
            ToolResult: 工具执行结果。
        """
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

        # T-04: Schema 参数校验——在权限检查前拦截非法参数。
        if self._schema_validator:
            try:
                definition = self._tool_registry.get_definition(tool_call.name) if self._tool_registry else None
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
                    sv_result = self._schema_validator.validate(params, param_defs, required_params)
                    if not sv_result.valid:
                        return ToolResult(
                            tool_call_id=tool_call.id,
                            name=tool_call.name,
                            output=f"参数校验失败: {'; '.join(sv_result.errors)}",
                            success=False,
                            error="schema_validation_failed",
                            duration=time.time() - start,
                        )
                    params = sv_result.sanitized_params
            except Exception as exc:
                # D6（审计 §1.7）：Schema 校验异常不得静默放行，改为 fail-closed 拦截。
                log.error("Schema校验异常，拒绝执行", tool=tool_call.name, error=str(exc))
                return ToolResult(
                    tool_call_id=tool_call.id,
                    name=tool_call.name,
                    output=f"参数校验异常，已拒绝执行: {exc}",
                    success=False,
                    error="schema_validation_error",
                    duration=time.time() - start,
                )

        # T-04: 工具调用守卫——去重/缓存/限速检查。
        if self._tool_call_guard:
            try:
                guard_result = self._tool_call_guard.check(tool_call.name, params)
                if guard_result.blocked:
                    guard_output = guard_result.result.get("output", "") if guard_result.result else ""
                    guard_meta = guard_result.result.get("metadata", {}) if guard_result.result else {}
                    log.info("工具调用被守卫拦截", tool=tool_call.name, reason=guard_result.reason)
                    return ToolResult(
                        tool_call_id=tool_call.id,
                        name=tool_call.name,
                        output=guard_output,
                        success=True,
                        duration=time.time() - start,
                        metadata={**guard_meta, "guard_blocked": True, "guard_reason": guard_result.reason},
                    )
            except Exception as exc:
                # D6（审计 §1.7）：守卫检查异常不得静默放行（fail-open），改为 fail-closed 拦截。
                log.error("工具调用守卫异常，拒绝执行", tool=tool_call.name, error=str(exc))
                return ToolResult(
                    tool_call_id=tool_call.id,
                    name=tool_call.name,
                    output=f"工具调用守卫异常，已拒绝执行: {exc}",
                    success=False,
                    error="tool_guard_error",
                    duration=time.time() - start,
                )

        # 工具声明的风险等级与所需权限（供权限检查与审批共用），修复 T-03 风险硬编码。
        risk, required_permissions = self._tool_risk_and_permissions(tool_call.name)

        if self._permission_guard:
            decision = self._check_permission(
                tool_call.name, params, risk, required_permissions
            )
            # 仅当明确拒绝且不属于"需确认"时才硬拒；needs_confirmation 交由审批流处理。
            if decision is not None and not decision.allowed and not decision.needs_confirmation:
                return ToolResult(
                    tool_call_id=tool_call.id,
                    name=tool_call.name,
                    output=f"权限不足: {decision.reason or f'工具 {tool_call.name} 需要更高权限'}",
                    success=False,
                    error="permission_denied",
                    duration=time.time() - start,
                )

        if self._approval_manager:
            try:
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
            except Exception as exc:
                # D4（审计 §1.7）：审批请求异常不得静默放行（fail-open），改为 fail-closed 默认拒绝。
                log.error("审批请求异常，拒绝执行", tool=tool_call.name, error=str(exc))
                return ToolResult(
                    tool_call_id=tool_call.id,
                    name=tool_call.name,
                    output=f"审批请求异常，已拒绝执行: {exc}",
                    success=False,
                    error="approval_error",
                    duration=time.time() - start,
                )

        if self._hook_manager:
            await self._hook_manager.trigger(
                "beforeToolCall",
                tool_name=tool_call.name,
                tool_call_id=tool_call.id,
            )

        result = await self._tool_registry.execute(tool_call.name, params)

        # T-04: 工具调用守卫记录——缓存成功结果、更新去重历史和速率计数。
        if self._tool_call_guard:
            try:
                self._tool_call_guard.record(
                    tool_call.name, params,
                    {"success": result.success, "output": result.output or "", "error": result.error, "metadata": dict(getattr(result, "metadata", {}) or {})},
                )
            except Exception as exc:
                # D2（审计 §1.7）：记录失败 → 去重历史缺失，同参数工具可能被反复
                # 重复调用（死循环风险）。不阻断主链路，但必须留痕。
                log.error(
                    "工具守卫记录失败，去重历史未更新",
                    tool=tool_call.name,
                    error=str(exc),
                )

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
            # 修复 T-08：透传 registry 写入的 truncated/original_chars/exit_code 等元数据。
            metadata=dict(getattr(result, "metadata", {}) or {}),
        )

    async def _execute_tool_with_retry(self, tool_call: ToolCall) -> ToolResult:
        """执行工具调用，失败时自动反思并重试。

        最多重试 _MAX_TOOL_RETRIES 次，每次通过 _reflect_on_failure
        分析错误原因并尝试修正参数。

        Args:
            tool_call: 工具调用描述。

        Returns:
            ToolResult: 最终执行结果（可能成功或失败）。
        """
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
                corrected_call = ToolCall(id=tool_call.id, name=tool_call.name, arguments=json.dumps(corrected_params))
                result = await self._execute_tool(corrected_call)
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
        """反思工具执行失败原因，判断是否应重试。

        分析错误类型：不可重试错误（权限/不存在）直接放弃，
        可重试错误（超时/连接）尝试修正参数后重试。

        Args:
            tool_call: 工具调用描述。
            result: 工具执行失败结果。

        Returns:
            dict: 包含 should_retry、reason、corrected_params 的反思结论。
        """
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
                candidate = os.path.realpath(os.path.join(os.getcwd(), path_val))
                cwd_real = os.path.realpath(os.getcwd())
                if not candidate.startswith(cwd_real + os.sep) and candidate != cwd_real:
                    return {"should_retry": False, "reason": "path traversal detected"}
                if os.path.exists(candidate):
                    corrected["path"] = candidate
                    return {"should_retry": True, "corrected_params": corrected}

        if "timeout" in error_lower or "timed out" in error_lower:
            return {"should_retry": True, "corrected_params": corrected}

        if "connection" in error_lower or "refused" in error_lower:
            return {"should_retry": True, "corrected_params": corrected}

        return {"should_retry": True, "corrected_params": None}

    async def run_stream(
        self,
        user_input: str,
        session_id: str = "default",
        system_prompt: str | None = None,
        history: list[dict[str, str]] | None = None,
        use_tools: bool = True,
        images: list[dict[str, Any]] | None = None,
    ):
        """P0-1/P1-4: 流式 ReAct 循环 — 富类型流式事件。

        每一轮 LLM 调用都使用 chat_stream 进行实时 token 输出，
        同时通过 ThinkScrubber 分离思考过程并 yield thinking 事件。

        事件类型:
        - stream_start: 流开始
        - progress: 进度更新 (current_round, total_rounds)
        - plan: 生成的执行计划
        - thinking: LLM 思考过程
        - token: 文本 token 增量
        - tool_start: 工具调用开始
        - tool_end: 工具调用结束（含结果摘要）
        - reflection: 中间评估结果
        - stream_done: 流结束（含汇总元数据）
        - error: 错误

        Yields:
            dict 事件: {"type": str, "content": str, "metadata": {...}, ...}
        """
        import uuid
        import time as _t

        trace_id = f"conv_{uuid.uuid4().hex[:8]}"
        start_time = _t.time()
        tool_call_count = 0
        tool_success_count = 0
        total_tool_duration_ms = 0.0

        messages: list[dict[str, Any]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history:
            messages.extend(history)

        user_message: dict[str, Any] = {"role": "user", "content": user_input}
        if images:
            content_parts: list[dict[str, Any]] = [{"type": "text", "text": user_input}]
            for img in images:
                content_parts.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{img.get('mime_type', 'image/png')};base64,{img['data']}",
                        "detail": img.get("detail", "auto"),
                    },
                })
            user_message = {"role": "user", "content": content_parts}
        messages.append(user_message)

        # D2 (P2 第4轮回灌): 注入会话级认知信号到本轮 LLM 上下文(流式路径)。
        try:
            inject_cognition_into_messages(session_id, messages)
        except Exception as exc:
            log.warning("D2 认知信号注入失败(已跳过)", error=str(exc))

        tools_schema = self._build_tools_schema(user_input, use_tools)
        max_rounds = self._max_tool_rounds
        stream_budget = IterationBudget(max_tool_rounds=max_rounds)
        consecutive_failures = 0
        max_consecutive_failures = 3

        yield {
            "type": "stream_start",
            "content": "",
            "trace_id": trace_id,
            "session_id": session_id,
            "metadata": {"max_rounds": max_rounds, "has_tools": bool(tools_schema)},
        }

        for round_idx in range(max_rounds):
            yield {
                "type": "progress",
                "content": "",
                "metadata": {
                    "current_round": round_idx + 1,
                    "total_rounds": max_rounds,
                    "tool_calls_so_far": tool_call_count,
                },
            }

            try:
                response = await self._llm.chat(
                    messages=messages,
                    tools=tools_schema if round_idx < max_rounds - 1 else None,
                    use_cache=False,
                )
            except Exception as e:
                classified = self._error_classifier.classify_llm_error(e)
                consecutive_failures += 1
                if consecutive_failures >= max_consecutive_failures:
                    yield {
                        "type": "error",
                        "content": classified.user_message,
                        "metadata": {
                            "category": classified.category.value,
                            "consecutive_failures": consecutive_failures,
                        },
                    }
                    return
                yield {
                    "type": "error",
                    "content": classified.user_message,
                    "metadata": {"category": classified.category.value},
                }
                return

            content = response.get("content", "")
            tool_calls_raw = response.get("tool_calls")

            usage = response.get("usage", {})
            if usage and isinstance(usage, dict):
                tokens_used = usage.get("total_tokens", 0)
                if tokens_used:
                    stream_budget.add_tokens(tokens_used)

            if stream_budget.is_token_exhausted:
                _qs = tool_success_count / max(tool_call_count, 1) if tool_call_count > 0 else 0.0
                _dur_ms = int((_t.time() - start_time) * 1000)
                yield {
                    "type": "stream_done",
                    "content": "",
                    "trace_id": trace_id,
                    "session_id": session_id,
                    "quality_score": round(_qs * 0.7, 4),
                    "rounds_used": round_idx + 1,
                    "duration": _dur_ms / 1000.0,
                    "finish_reason": "token_budget_exhausted",
                    "metadata": {
                        "total_rounds": round_idx + 1,
                        "tool_calls": tool_call_count,
                        "tool_successes": tool_success_count,
                        "duration_ms": _dur_ms,
                        "tool_duration_ms": int(total_tool_duration_ms),
                        "finish_reason": "token_budget_exhausted",
                    },
                }
                return

            scrub_result = self._think_scrubber.scrub(content)
            if scrub_result.thinking:
                yield {
                    "type": "thinking",
                    "content": scrub_result.thinking,
                    "metadata": {"round": round_idx + 1},
                }
            content = scrub_result.cleaned

            if not tool_calls_raw:
                for i in range(0, len(content), 10):
                    yield {"type": "token", "content": content[i:i + 10]}
                _qs = 0.7 if content else 0.3
                _dur_ms = int((_t.time() - start_time) * 1000)
                yield {
                    "type": "stream_done",
                    "content": "",
                    "trace_id": trace_id,
                    "session_id": session_id,
                    "quality_score": _qs,
                    "rounds_used": round_idx + 1,
                    "duration": _dur_ms / 1000.0,
                    "finish_reason": "complete",
                    "metadata": {
                        "total_rounds": round_idx + 1,
                        "tool_calls": tool_call_count,
                        "tool_successes": tool_success_count,
                        "duration_ms": _dur_ms,
                        "tool_duration_ms": int(total_tool_duration_ms),
                        "finish_reason": "complete",
                    },
                }
                return

            yield {"type": "token", "content": content or ""}

            assistant_msg: dict[str, Any] = {"role": "assistant", "content": content or ""}
            assistant_msg["tool_calls"] = tool_calls_raw
            messages.append(assistant_msg)

            for tc_raw in tool_calls_raw:
                fn = tc_raw.get("function", {})
                tc = ToolCall(
                    id=tc_raw.get("id", f"tc_{uuid.uuid4().hex[:6]}"),
                    name=fn.get("name", ""),
                    arguments=fn.get("arguments", "{}"),
                )

                yield {
                    "type": "tool_start",
                    "content": tc.name,
                    "metadata": {
                        "tool_name": tc.name,
                        "tool_args": tc.parse_arguments(),
                        "round": round_idx + 1,
                    },
                }

                tool_start = _t.time()
                tool_result = await self._execute_tool_with_retry(tc)
                tool_duration = (_t.time() - tool_start) * 1000
                total_tool_duration_ms += tool_duration
                tool_call_count += 1
                if tool_result.success:
                    tool_success_count += 1
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1
                    if consecutive_failures >= max_consecutive_failures:
                        _qs = tool_success_count / max(tool_call_count, 1) if tool_call_count > 0 else 0.0
                        _dur_ms = int((_t.time() - start_time) * 1000)
                        yield {
                            "type": "stream_done",
                            "content": "",
                            "trace_id": trace_id,
                            "session_id": session_id,
                            "quality_score": round(_qs * 0.5, 4),
                            "rounds_used": round_idx + 1,
                            "duration": _dur_ms / 1000.0,
                            "finish_reason": "failure_exhausted",
                            "metadata": {
                                "total_rounds": round_idx + 1,
                                "tool_calls": tool_call_count,
                                "tool_successes": tool_success_count,
                                "duration_ms": _dur_ms,
                                "tool_duration_ms": int(total_tool_duration_ms),
                                "finish_reason": "failure_exhausted",
                            },
                        }
                        return

                yield {
                    "type": "tool_end",
                    "content": tool_result.output[:300] if tool_result.output else "",
                    "metadata": {
                        "tool_name": tc.name,
                        "success": tool_result.success,
                        "error": tool_result.error,
                        "duration_ms": int(tool_duration),
                        "round": round_idx + 1,
                    },
                }

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": tool_result.output[:1000] if tool_result.output else "",
                })

        _qs = tool_success_count / max(tool_call_count, 1) if tool_call_count > 0 else 0.5
        _dur_ms = int((_t.time() - start_time) * 1000)
        yield {
            "type": "stream_done",
            "content": "",
            "trace_id": trace_id,
            "session_id": session_id,
            "quality_score": round(_qs, 4),
            "rounds_used": max_rounds,
            "duration": _dur_ms / 1000.0,
            "finish_reason": "max_rounds",
            "metadata": {
                "total_rounds": max_rounds,
                "tool_calls": tool_call_count,
                "tool_successes": tool_success_count,
                "duration_ms": _dur_ms,
                "tool_duration_ms": int(total_tool_duration_ms),
                "finish_reason": "max_rounds",
            },
        }
