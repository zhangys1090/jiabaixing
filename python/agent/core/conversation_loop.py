from __future__ import annotations

import asyncio
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
    CancellationToken,
    ConversationResult,
    IterationBudget,
    LoopCheckpoint,
    ToolCall,
    ToolResult,
    TurnContext,
    TurnState,
)
from agent.llm.provider import LLMProvider
from agent.core.types import Permission, PermissionCheckResult, DEFAULT_PERMISSIONS
from agent.tools.permission_guard import ToolContext
from agent.tools.registry import ToolRegistry

# D2 (P2 第4轮回灌): 会话级认知信号(情绪/反思)注入 ReAct 循环 LLM 上下文
from agent.core.cognition_buffer import inject_cognition_into_messages

try:
    from agent.harness.trace_log import TraceLog, TraceEventType
    from agent.harness.context_window import ContextWindowManager, TokenBudget
    _HAS_HARNESS = True
except ImportError:
    _HAS_HARNESS = False

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
            logger.info(event)
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
        trace_log: Any = None,
        context_window_manager: Any = None,
        tool_timeouts: dict[str, float] | None = None,
        default_tool_timeout: float = 120.0,
        strategy_hint: str | None = None,
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
            trace_log: Harness执行轨迹日志，None 时禁用轨迹记录。
            context_window_manager: Harness上下文窗口管理器，None 时禁用自动截断。
            tool_timeouts: W2: 每工具超时配置 {tool_name: timeout_seconds}。
            default_tool_timeout: W2: 未配置工具的默认超时秒数。
            strategy_hint: W10: 策略选择提示，控制使用哪种执行策略。
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
        self._trace_log = trace_log
        self._context_window_manager = context_window_manager
        self._tool_selector = tool_selector

        self._verification_loop = verification_loop
        self._correction_rounds_used = 0

        self._parallel_executor = self._build_parallel_executor()

        # W2: 每工具超时配置。tool_timeouts 按工具名声明独立超时，
        # 未配置工具回退到 default_tool_timeout（默认 120s）。
        # 超时 <= 0 视为不限制（部分工具如 sandbox 需要无限等待）。
        self._tool_timeouts: dict[str, float] = tool_timeouts or {}
        self._default_tool_timeout = default_tool_timeout

        # W10: 策略选择提示。用户可通过 strategy_hint 控制执行策略偏好，
        # 如 "fast"（优先并行/低超时）、"safe"（串行/高超时/严格验证）、
        # "balanced"（默认）。None 时退化为 balanced。
        self._strategy_hint = strategy_hint or "balanced"

        self._last_checkpoint: LoopCheckpoint | None = None

        self._long_task_orchestrator: Any = None

        self._reasoning_chain_engine: Any = None
        self._semantic_verifier: Any = None
        self._causal_modeler: Any = None
        self._reflection_kb: Any = None
        self._tool_selection_memory: Any = None
        self._behavior_monitor: Any = None
        self._reasoning_kernel: Any = None
        self._meta_cognition: Any = None
        self._hallucination_detector: Any = None
        self._adaptive_budget: Any = None
        self._memory_isolator: Any = None
        self._operation_rollback: Any = None
        self._world_model: Any = None
        self._continual_learning: Any = None
        self._cross_device_coordinator: Any = None

    def set_long_task_orchestrator(self, orchestrator: Any) -> None:
        """绑定长任务编排器，使对话循环可自动委托长任务."""
        self._long_task_orchestrator = orchestrator

    def set_reasoning_chain_engine(self, engine: Any) -> None:
        """绑定推理链引擎，使 Think 阶段产出结构化推理链。"""
        self._reasoning_chain_engine = engine

    def set_semantic_verifier(self, verifier: Any) -> None:
        """绑定语义验证器，使 tool_end 阶段自动校验输出质量。"""
        self._semantic_verifier = verifier

    def set_max_tool_rounds(self, max_rounds: int) -> None:
        """R1: 动态预算 — 运行时调整最大工具调用轮数。

        根据任务复杂度动态调整预算，而非固定使用初始化时的值。
        简单任务3轮、中等任务8轮、复杂任务12轮、极复杂任务18轮。
        """
        if max_rounds < 1:
            max_rounds = 1
        self._max_tool_rounds = max_rounds
        log.debug("R1: max_tool_rounds adjusted", max_rounds=max_rounds)

    def set_causal_modeler(self, modeler: Any) -> None:
        """R3: 因果建模器 — 使多工具调用时可分析并行执行组。"""
        self._causal_modeler = modeler

    def set_reflection_kb(self, kb: Any) -> None:
        """R4: 反思知识库 — 使 tool_end 后自动沉淀经验，新一轮开始时检索复用。"""
        self._reflection_kb = kb

    def set_tool_selection_memory(self, memory: Any) -> None:
        """R2: 工具选择记忆 — 记录工具选择历史，优化未来选择。"""
        self._tool_selection_memory = memory

    def set_behavior_monitor(self, monitor: Any) -> None:
        """A3: 行为边界监控 — 每次工具调用后记录，检测异常模式。"""
        self._behavior_monitor = monitor

    def set_reasoning_kernel(self, kernel: Any) -> None:
        """P1-4: 统一推理内核 — 策略路由+可插拔推理引擎。"""
        self._reasoning_kernel = kernel

    def set_meta_cognition(self, engine: Any) -> None:
        """P1-5: 元认知引擎 — 让Agent感知自己的认知状态。"""
        self._meta_cognition = engine

    def set_hallucination_detector(self, detector: Any) -> None:
        """P0-3: 幻觉检测器 — 三层检测架构(模式+自一致性+事实核查)。"""
        self._hallucination_detector = detector

    def set_adaptive_budget(self, engine: Any) -> None:
        """P1-6: 自适应Token预算引擎 — 场景感知+历史反馈。"""
        self._adaptive_budget = engine

    def set_memory_isolator(self, isolator: Any) -> None:
        """P1-7: 子Agent记忆隔离器 — 防止子Agent间记忆污染。"""
        self._memory_isolator = isolator

    def set_operation_rollback(self, engine: Any) -> None:
        """P1-7: 操作回滚引擎 — 失败时按逆序回滚已执行操作。"""
        self._operation_rollback = engine

    def set_world_model(self, model: Any) -> None:
        """P2-1: 世界模型 — 环境状态建模+预判能力。"""
        self._world_model = model

    def set_continual_learning(self, loop: Any) -> None:
        """P2-2: 持续学习回路 — 经验采集+策略优化+知识沉淀。"""
        self._continual_learning = loop

    def set_cross_device_coordinator(self, coordinator: Any) -> None:
        """P2-3: 跨设备协同 — 多设备调度+故障转移。"""
        self._cross_device_coordinator = coordinator

    def set_execution_mode(self, mode: str) -> None:
        """设置执行模式。

        Args:
            mode: 执行模式
                - "react": ReAct 模式（默认），思考→行动→观察循环
                - "plan_execute_evaluate": Plan-Execute-Evaluate 模式，先规划后执行再评估
        """
        valid = ("react", "plan_execute_evaluate")
        if mode not in valid:
            return
        self._execution_mode = mode

    @property
    def execution_mode(self) -> str:
        """当前执行模式。"""
        return getattr(self, "_execution_mode", "react")

    @property
    def last_checkpoint(self) -> LoopCheckpoint | None:
        """W1: 获取最近检查点，供外部序列化存储以实现暂停/恢复。"""
        return self._last_checkpoint

    @property
    def strategy_hint(self) -> str:
        """W10: 获取当前策略选择提示。"""
        return self._strategy_hint

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

    def _get_tool_timeout(self, tool_name: str) -> float | None:
        """W2: 获取工具执行超时秒数。

        查找优先级：tool_timeouts[tool_name] > 工具定义声明 > default_tool_timeout。
        超时 <= 0 视为不限制（返回 None），避免 asyncio.wait_for(timeout=0) 立即抛异常。
        """
        explicit = self._tool_timeouts.get(tool_name)
        if explicit is not None:
            return explicit if explicit > 0 else None

        if self._tool_registry and hasattr(self._tool_registry, "get_definition"):
            definition = self._tool_registry.get_definition(tool_name)
            if definition is not None:
                declared = getattr(definition, "timeout", None)
                if declared is not None:
                    return declared if declared > 0 else None

        return self._default_tool_timeout if self._default_tool_timeout > 0 else None

    def _pre_tool_verify(self, tool_name: str, params: dict[str, Any]) -> str | None:
        """W9: 工具执行前验证钩子（pre_tool）。

        在工具执行前调用 VerificationLoop 的 pre_tool_check（如果存在），
        返回 None 表示放行，返回 str 表示拒绝原因。
        """
        vloop = self._verification_loop
        if vloop is None:
            return None
        check_fn = getattr(vloop, "pre_tool_check", None)
        if not callable(check_fn):
            return None
        try:
            result = check_fn(tool_name=tool_name, params=params)
            if result is None:
                return None
            blocked = getattr(result, "blocked", False)
            if blocked:
                return getattr(result, "reason", "pre_tool verification blocked")
            return None
        except Exception as exc:
            log.warning("W9 pre_tool验证异常，放行", tool=tool_name, error=str(exc))
            return None

    def _post_response_verify(self, content: str, tool_calls_raw: list[dict] | None) -> str | None:
        """W9: LLM响应后验证钩子（post_response）。

        在LLM响应后调用 VerificationLoop 的 post_response_check（如果存在），
        返回 None 表示放行，返回 str 表示需要修正的提示。
        """
        vloop = self._verification_loop
        if vloop is None:
            return None
        check_fn = getattr(vloop, "post_response_check", None)
        if not callable(check_fn):
            return None
        try:
            result = check_fn(content=content, tool_calls=tool_calls_raw or [])
            if result is None:
                return None
            needs_correction = getattr(result, "needs_correction", False)
            if needs_correction:
                return getattr(result, "correction_prompt", "post_response verification failed")
            return None
        except Exception as exc:
            log.warning("W9 post_response验证异常，放行", error=str(exc))
            return None

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

    @staticmethod
    def _resolve_tool_dependencies(
        tool_call: ToolCall,
        all_calls: list[ToolCall],
    ) -> list[str]:
        """W4: 解析工具调用间的依赖关系，防止读写冲突。

        规则：
        1. file_write 依赖同路径的 file_read（先读后写）
        2. 同名文件的多个 write 串行化（先写先执行）
        3. 其他工具默认无依赖（可并行）

        Returns:
            依赖的 tool_call_id 列表。
        """
        WRITE_TOOLS = {"file_write", "file_edit", "file_delete", "shell_exec"}
        READ_TOOLS = {"file_read", "file_list", "file_search", "directory_list"}
        deps: list[str] = []

        params = tool_call.parse_arguments() if hasattr(tool_call, "parse_arguments") else {}
        target_path = params.get("path") or params.get("file_path") or params.get("directory")

        if not target_path or tool_call.name not in WRITE_TOOLS:
            return deps

        for other in all_calls:
            if other.id == tool_call.id:
                continue
            other_params = other.parse_arguments() if hasattr(other, "parse_arguments") else {}
            other_path = other_params.get("path") or other_params.get("file_path") or other_params.get("directory")

            if not other_path or other_path != target_path:
                continue

            if tool_call.name in WRITE_TOOLS and other.name in READ_TOOLS:
                deps.append(other.id)
            elif tool_call.name in WRITE_TOOLS and other.name in WRITE_TOOLS:
                if all_calls.index(other) < all_calls.index(tool_call):
                    deps.append(other.id)

        return deps

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
                # P1-7: 操作回滚 — 工具执行前保存检查点
                _rollback_cp = None
                if self._operation_rollback is not None:
                    try:
                        from agent.desktop.operation_rollback import OperationType
                        _rollback_cp = self._operation_rollback.save_checkpoint(
                            OperationType.FILE_WRITE, target=tc.name,
                        )
                    except Exception:
                        pass
                tool_result = await self._execute_tool_with_retry(tc)
                turn.tool_results.append(tool_result)
                turn.add_tool_result_message(tc.id, self._verify_and_correct(tool_result))
                if not tool_result.success:
                    budget.record_failure()
                    # P1-7: 操作回滚 — 工具执行失败时回滚
                    if self._operation_rollback is not None and _rollback_cp is not None:
                        try:
                            _rb_result = self._operation_rollback.rollback(_rollback_cp.checkpoint_id)
                            if _rb_result.success:
                                log.info("P1-7: 操作回滚成功", tool=tc.name,
                                         checkpoint=_rollback_cp.checkpoint_id)
                        except Exception as _rb_exc:
                            log.debug("P1-7: 操作回滚异常，非阻断", error=str(_rb_exc))
                else:
                    budget.reset_failure_streak()
            self._last_tool_results = [
                {"tool": tr.name, "result": tr.content, "success": tr.success}
                for tr in turn.tool_results
            ]
            # R4: 反思知识自动沉淀 (run 串行路径)
            if self._reflection_kb is not None:
                try:
                    from agent.loop.reflection_knowledge_base import ReflectionExperience
                    exp = ReflectionExperience(
                        type="tool_usage", context={"tool": tc.name},
                        action=tc.name,
                        result="success" if tool_result.success else "failure",
                        reflection="", insight="",
                        success_rate=1.0 if tool_result.success else 0.0,
                        tags=[tc.name],
                    )
                    self._reflection_kb.add_experience(exp)
                except Exception:
                    pass
            # R2: 工具选择记忆 (run 串行路径)
            if self._tool_selection_memory is not None:
                try:
                    self._tool_selection_memory.record(tool_name=tc.name, success=tool_result.success)
                except Exception:
                    pass
            return

        call_by_id = {tc.id: tc for tc in round_calls}
        items = [
            ToolCallItem(
                id=tc.id,
                name=tc.name,
                arguments=self._safe_parse_args(tc.arguments),
                depends_on=self._resolve_tool_dependencies(tc, round_calls),
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
        self._last_tool_results = [
            {"tool": tr.name, "result": tr.content, "success": tr.success}
            for tr in turn.tool_results
        ]
        # R4: 反思知识自动沉淀 (run 并行路径)
        if self._reflection_kb is not None:
            try:
                from agent.loop.reflection_knowledge_base import ReflectionExperience
                exp = ReflectionExperience(
                    type="tool_usage", context={"tool": r.name},
                    action=r.name,
                    result="success" if r.success else "failure",
                    reflection="", insight="",
                    success_rate=1.0 if r.success else 0.0,
                    tags=[r.name],
                )
                self._reflection_kb.add_experience(exp)
            except Exception:
                pass
        # R2: 工具选择记忆 (run 并行路径)
        if self._tool_selection_memory is not None:
            try:
                self._tool_selection_memory.record(tool_name=r.name, success=r.success)
            except Exception:
                pass
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
        cancellation_token: CancellationToken | None = None,
        checkpoint: LoopCheckpoint | None = None,
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
            cancellation_token: W5: 协作式取消令牌，外部调用 cancel() 可中断循环。
            checkpoint: W1: 检查点，非 None 时从该点恢复对话而非从头开始。

        Returns:
            ConversationResult: 包含最终内容、工具调用统计和元数据。
        """
        trace_id = f"conv_{uuid.uuid4().hex[:8]}"
        start = time.time()

        if self._trace_log and _HAS_HARNESS:
            try:
                self._trace_log.record(trace_id, session_id, TraceEventType.SESSION_START, {"user_input": user_input[:200]})
            except Exception:
                pass

        turn = TurnContext(
            turn_id=trace_id,
            user_input=user_input,
            state=TurnState.PROCESSING,
            start_time=start,
            max_retries=self._max_retries,
        )

        # W1: 从检查点恢复对话状态（跳过已完成的轮次）。
        messages: list[dict[str, Any]] = []
        budget: IterationBudget
        if checkpoint is not None:
            messages = list(checkpoint.messages)
            turn.tool_calls = [ToolCall(id=tc.get("id", ""), name=tc.get("name", ""), arguments=tc.get("arguments", "{}")) for tc in checkpoint.tool_calls]
            turn.tool_results = [ToolResult(tool_call_id=tr.get("tool_call_id", ""), name=tr.get("name", ""), output=tr.get("output", ""), success=tr.get("success", True), error=tr.get("error")) for tr in checkpoint.tool_results]
            budget = IterationBudget(max_tool_rounds=self._max_tool_rounds, current_round=checkpoint.current_round)
            if checkpoint.budget_data:
                budget.total_tokens_used = checkpoint.budget_data.get("total_tokens_used", 0)
                budget.consecutive_failures = checkpoint.budget_data.get("consecutive_failures", 0)
                budget.total_failures = checkpoint.budget_data.get("total_failures", 0)
                budget.total_tool_calls = checkpoint.budget_data.get("total_tool_calls", 0)
            trace_id = checkpoint.turn_id
            session_id = checkpoint.session_id
            user_input = checkpoint.user_input
            log.info("W1: 从检查点恢复对话", turn_id=trace_id, round=checkpoint.current_round, messages=len(messages))
            if self._trace_log and _HAS_HARNESS:
                try:
                    self._trace_log.record(trace_id, session_id, TraceEventType.SESSION_START, {"resumed_from_checkpoint": True, "round": checkpoint.current_round})
                except Exception:
                    pass
        else:
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

        self._correction_rounds_used = 0

        # D2 (P2 第4轮回灌): 把会话级认知信号(情绪/反思)注入本轮 LLM 上下文(元认知回灌)。
        # 注入一次(整轮共享), 不每轮重复插入, 避免上下文膨胀。
        try:
            inject_cognition_into_messages(session_id, turn.messages)
        except Exception as exc:
            log.warning("D2 认知信号注入失败(已跳过, 不影响主链路)", error=str(exc))

        # R4: 反思知识复用 — 检索相似任务经验注入上下文
        _reflection_ctx = ""
        if self._reflection_kb is not None:
            try:
                similar = self._reflection_kb.search_experiences(
                    query=user_input, type="tool_usage", limit=3, min_success_rate=0.6,
                )
                if similar:
                    items = [f"  - {e.action}: {e.result} (成功率{e.success_rate:.0%})" for e in similar]
                    _reflection_ctx = "\n相关经验:\n" + "\n".join(items)
            except Exception as _r4r_exc:
                log.debug("R4: reflection KB retrieval failed (run), non-blocking", error=str(_r4r_exc))
        if _reflection_ctx:
            for _mi, _m in enumerate(turn.messages):
                if _m.get("role") == "system":
                    turn.messages[_mi] = {"role": "system", "content": _m["content"] + _reflection_ctx}
                    break

        # R2: 工具选择记忆 — 检索历史偏好注入上下文
        if self._tool_selection_memory is not None:
            try:
                preferred = self._tool_selection_memory.get_preferred_tools(limit=5)
                if preferred:
                    pref_str = ", ".join(preferred)
                    for _mi, _m in enumerate(turn.messages):
                        if _m.get("role") == "system":
                            turn.messages[_mi] = {"role": "system", "content": _m["content"] + f"\n常用工具: {pref_str}"}
                            break
            except Exception as _r2r_exc:
                log.debug("R2: tool selection memory retrieval failed (run), non-blocking", error=str(_r2r_exc))

        # P1-6: 自适应Token预算 — 场景感知分配
        if self._adaptive_budget is not None:
            try:
                _ab_scene = self._adaptive_budget.auto_detect_scene(user_input)
                _ab_result = self._adaptive_budget.allocate(scene=_ab_scene)
                if _ab_result.allocation.reserve > 0:
                    log.debug("P1-6: 自适应预算分配", scene=_ab_scene.value,
                              total=_ab_result.allocation.total_budget)
            except Exception as _ab_exc:
                log.debug("P1-6: 自适应预算异常，非阻断", error=str(_ab_exc))

        # P2-2: 持续学习 — 检索相关经验注入系统提示
        if self._continual_learning is not None:
            try:
                _cl_entries = self._continual_learning.retrieve_relevant_knowledge(
                    query=user_input, top_k=3,
                )
                if _cl_entries:
                    _cl_ctx = "\n相关经验:\n" + "\n".join(
                        f"  - {e.title}: {e.content[:60]}" for e in _cl_entries[:2]
                    )
                    for _mi, _m in enumerate(turn.messages):
                        if _m.get("role") == "system":
                            turn.messages[_mi] = {"role": "system", "content": _m["content"] + _cl_ctx}
                            break
            except Exception as _cl_inject_exc:
                log.debug("P2-2: 持续学习经验注入异常，非阻断", error=str(_cl_inject_exc))

        if checkpoint is None:
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
            # W5: 协作式取消检查——外部调用 cancellation_token.cancel() 可中断循环。
            if cancellation_token is not None and cancellation_token.is_cancelled:
                log.info("W5: 对话循环被取消令牌中断", round=budget.current_round)
                finish_reason = "cancelled"
                break
            budget.increment()
            # OTel追踪：记录循环迭代span
            from agent.core.tracing import get_tracing_manager
            _tracing = get_tracing_manager()
            _iter_span = _tracing.start_span("loop.iteration", {"round": budget.current_round, "trace_id": trace_id})

            try:
                llm_messages = turn.messages
                if self._prompt_caching and hasattr(self._prompt_caching, "mark_cache_breakpoints"):
                    llm_messages = self._prompt_caching.mark_cache_breakpoints(llm_messages)

                # W7: 上下文截断策略——使用Token计数而非消息条数。
                # 当 context_window_manager 可用时，基于 token 预算截断；
                # 不可用时，按消息条数 > 20 降级截断（兼容旧行为）。
                if self._context_window_manager and _HAS_HARNESS:
                    _should_truncate = budget.is_token_exhausted or len(llm_messages) > 20
                    if _should_truncate:
                        try:
                            entries = self._context_window_manager.from_messages(llm_messages)
                            result = self._context_window_manager.truncate(entries)
                            if result.truncated_count < len(entries):
                                llm_messages = [
                                    {"role": e.role, "content": e.content}
                                    for e in result.entries
                                ]
                                log.info(
                                    "上下文窗口截断",
                                    original=len(entries),
                                    truncated=result.truncated_count,
                                    ratio=result.compression_ratio,
                                )
                                if self._trace_log and _HAS_HARNESS:
                                    try:
                                        self._trace_log.record(trace_id, session_id, TraceEventType.CONTEXT_TRUNCATION, {
                                            "original": len(entries), "truncated": result.truncated_count,
                                        })
                                    except Exception:
                                        pass
                        except Exception as exc:
                            log.warning("上下文窗口截断失败，使用原始消息", error=str(exc))

                # W6: 记录LLM请求事件
                if self._trace_log and _HAS_HARNESS:
                    try:
                        self._trace_log.record(trace_id, session_id, TraceEventType.LLM_CALL, {
                            "round": budget.current_round, "message_count": len(llm_messages),
                            "has_tools": tools_schema is not None,
                        })
                    except Exception:
                        pass

                response = await self._llm.chat(
                    messages=llm_messages,
                    tools=tools_schema if budget.current_round <= self._max_tool_rounds else None,
                    use_cache=False,
                )
            except Exception as e:
                log.debug("conversation_loop 异常处理", error=str(e))
                classified = self._error_classifier.classify_llm_error(
                    e, attempt=retry_state.attempts,
                )
                # W6: 记录LLM错误事件
                if self._trace_log and _HAS_HARNESS:
                    try:
                        self._trace_log.record(trace_id, session_id, TraceEventType.ERROR, {
                            "round": budget.current_round, "category": classified.category.value,
                            "error": str(e)[:200],
                        })
                    except Exception:
                        pass
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

            # W6: 记录LLM响应事件
            if self._trace_log and _HAS_HARNESS:
                try:
                    self._trace_log.record(trace_id, session_id, TraceEventType.LLM_RESPONSE, {
                        "round": budget.current_round, "has_tool_calls": bool(tool_calls_raw),
                        "finish_reason": finish_reason, "content_len": len(content),
                    })
                except Exception:
                    pass

            # W9: LLM响应后验证（post_response）——检查响应质量，必要时回灌纠错提示。
            post_response_correction = self._post_response_verify(content, tool_calls_raw)
            if post_response_correction:
                log.info("W9: post_response验证未通过，回灌纠错提示", round=budget.current_round)
                content = f"{content}\n\n[验证反馈]\n{post_response_correction}"

            # P0-3: 幻觉检测 — 三层检测(模式+自一致性+事实核查)
            if self._hallucination_detector is not None and content:
                try:
                    _hd_result = await self._hallucination_detector.detect(
                        output=content,
                        tool_results=getattr(self, '_last_tool_results', None),
                    )
                    if _hd_result.overall_level.value == "low":
                        log.warning("P0-3: 幻觉检测低置信度", confidence=round(_hd_result.overall_confidence, 3))
                        content = f"{content}\n\n[置信度低: {_hd_result.overall_confidence:.0%}]"
                except Exception as _hd_exc:
                    log.debug("P0-3: 幻觉检测异常，非阻断", error=str(_hd_exc))

            # P1-5 + P2-1: 元认知评估 + 世界模型预判 — 并行执行降低感知-行动延迟
            _mc_coro = None
            _wm_coro = None
            if self._meta_cognition is not None and content:
                async def _do_mc():
                    try:
                        assessment = await self._meta_cognition.assess_confidence(
                            task=message, result=content,
                        )
                        if assessment.should_seek_help:
                            log.info("P1-5: 元认知建议寻求帮助", confidence=round(assessment.overall_confidence, 3))
                    except Exception as exc:
                        log.debug("P1-5: 元认知评估异常，非阻断", error=str(exc))
                _mc_coro = _do_mc()
            if self._world_model is not None and tool_calls_raw:
                async def _do_wm():
                    try:
                        wm_state = await self._world_model.build_current_state()
                        for tc_raw in tool_calls_raw[:3]:
                            tc_fn = tc_raw.get("function", {})
                            pred = await self._world_model.predict(
                                wm_state, tc_fn.get("name", ""), "",
                            )
                            if pred.confidence_level.value == "low":
                                log.warning("P2-1: 世界模型预判低置信度",
                                            action=tc_fn.get("name", ""),
                                            confidence=round(pred.confidence, 3),
                                            risks=pred.risks)
                            wm_state = pred.predicted_state_after
                    except Exception as exc:
                        log.debug("P2-1: 世界模型预判异常，非阻断", error=str(exc))
                _wm_coro = _do_wm()
            if _mc_coro and _wm_coro:
                await asyncio.gather(_mc_coro, _wm_coro, return_exceptions=True)
            elif _mc_coro:
                await _mc_coro
            elif _wm_coro:
                await _wm_coro

            # P2-2: 持续学习 — 检索相关经验注入上下文
            if self._continual_learning is not None and content:
                try:
                    _cl_knowledge = self._continual_learning.retrieve_relevant_knowledge(
                        query=message, top_k=3,
                    )
                    if _cl_knowledge:
                        _cl_tips = [f"  - {k.title}: {k.content[:80]}" for k in _cl_knowledge[:2]]
                        log.info("P2-2: 持续学习检索到相关经验", count=len(_cl_knowledge))
                except Exception as _cl_exc:
                    log.debug("P2-2: 持续学习检索异常，非阻断", error=str(_cl_exc))

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

            # P2-2: 持续学习 — 记录本轮工具执行经验
            if self._continual_learning is not None:
                try:
                    for _tr in turn.tool_results:
                        self._continual_learning.record_experience(
                            task=message, action=_tr.name, outcome=_tr.output[:100],
                            success=_tr.success, duration_ms=0.0,
                            tools_used=[_tr.name],
                        )
                except Exception as _cl_rec_exc:
                    log.debug("P2-2: 持续学习记录异常，非阻断", error=str(_cl_rec_exc))

            # P2-1: 世界模型意外检测 — 比较预期状态与实际状态
            if self._world_model is not None and hasattr(self._world_model, '_state_history') and len(self._world_model._state_history) >= 2:
                try:
                    _prev_state = self._world_model._state_history[-2]
                    _curr_state = self._world_model._state_history[-1]
                    _surprise = await self._world_model.detect_surprise(_prev_state, _curr_state)
                    if _surprise.is_surprising:
                        log.warning("P2-1: 世界模型检测到意外变化",
                                    score=round(_surprise.surprise_score, 3),
                                    surprises=_surprise.surprises[:3])
                except Exception as _wm_s_exc:
                    log.debug("P2-1: 世界模型意外检测异常，非阻断", error=str(_wm_s_exc))

            # W1: 每轮工具执行后保存检查点（供外部获取以实现暂停/恢复）。
            self._last_checkpoint = LoopCheckpoint(
                turn_id=trace_id,
                session_id=session_id,
                user_input=user_input,
                messages=list(turn.messages),
                tool_calls=[{"id": tc.id, "name": tc.name, "arguments": tc.arguments} for tc in turn.tool_calls],
                tool_results=[{"tool_call_id": tr.tool_call_id, "name": tr.name, "output": tr.output, "success": tr.success, "error": tr.error} for tr in turn.tool_results],
                current_round=budget.current_round,
                budget_data={
                    "total_tokens_used": budget.total_tokens_used,
                    "consecutive_failures": budget.consecutive_failures,
                    "total_failures": budget.total_failures,
                    "total_tool_calls": budget.total_tool_calls,
                },
                finish_reason=finish_reason,
            )
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

        if self._trace_log and _HAS_HARNESS:
            try:
                self._trace_log.record(trace_id, session_id, TraceEventType.SESSION_END, {
                    "tool_calls": len(turn.tool_calls),
                    "rounds": budget.current_round,
                    "duration_ms": (time.time() - start) * 1000,
                })
            except Exception:
                pass

        _tool_successes = sum(1 for tr in turn.tool_results if tr.success)
        _tool_total = max(len(turn.tool_results), 1)
        _initial_quality = 0.7 if finish_reason == "stop" else 0.4
        if turn.tool_results:
            _initial_quality = _tool_successes / _tool_total

        # P2-2: 持续学习 — 对话结束时触发异步学习（模式识别+知识沉淀）
        if self._continual_learning is not None:
            try:
                _cl_report = await self._continual_learning.learn()
                if _cl_report.adjustments_made > 0 or _cl_report.knowledge_solidified > 0:
                    log.info("P2-2: 持续学习完成",
                             patterns=_cl_report.new_patterns_found,
                             adjustments=_cl_report.adjustments_made,
                             solidified=_cl_report.knowledge_solidified)
            except Exception as _cl_learn_exc:
                log.debug("P2-2: 持续学习触发异常，非阻断", error=str(_cl_learn_exc))

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
                "strategy_hint": self._strategy_hint,
                "has_checkpoint": self._last_checkpoint is not None,
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
            except Exception as exc:
                log.warning("权限检查异常，按拒绝处理", tool=tool_name, error=str(exc))
                return PermissionCheckResult(allowed=False, reason=f"权限检查异常: {exc}")
        except Exception as exc:
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

        # W9: 工具执行前验证（pre_tool）——检查参数合法性，必要时拒绝执行。
        pre_tool_block_reason = self._pre_tool_verify(tool_call.name, params)
        if pre_tool_block_reason is not None:
            log.info("W9: pre_tool验证拒绝执行", tool=tool_call.name, reason=pre_tool_block_reason)
            return ToolResult(
                tool_call_id=tool_call.id,
                name=tool_call.name,
                output=f"工具执行被验证拒绝: {pre_tool_block_reason}",
                success=False,
                error="pre_tool_verification_blocked",
                duration=time.time() - start,
            )

        # W2: 工具执行超时控制——按工具名查找超时配置，用 asyncio.wait_for 强制终止。
        tool_timeout = self._get_tool_timeout(tool_call.name)
        try:
            if tool_timeout is not None:
                result = await asyncio.wait_for(
                    self._tool_registry.execute(tool_call.name, params),
                    timeout=tool_timeout,
                )
            else:
                result = await self._tool_registry.execute(tool_call.name, params)
        except asyncio.TimeoutError:
            log.warning("W2: 工具执行超时", tool=tool_call.name, timeout=tool_timeout)
            if self._trace_log and _HAS_HARNESS:
                try:
                    self._trace_log.record(tool_call.id, "", TraceEventType.ERROR, {
                        "tool_name": tool_call.name, "timeout": tool_timeout, "error": "timeout",
                    })
                except Exception:
                    pass
            return ToolResult(
                tool_call_id=tool_call.id,
                name=tool_call.name,
                output=f"工具 {tool_call.name} 执行超时（>{tool_timeout}s）",
                success=False,
                error=f"timeout_after_{tool_timeout}s",
                duration=time.time() - start,
            )

        if self._trace_log and _HAS_HARNESS:
            try:
                self._trace_log.record(
                    tool_call.id, "", TraceEventType.TOOL_CALL,
                    {"tool_name": tool_call.name, "arguments": params, "success": result.success},
                    duration_ms=(time.time() - start) * 1000,
                )
            except Exception:
                pass

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
        """W3: 反思工具执行失败原因，使用 ErrorClassifier 区分临时/永久错误。

        替代原简单字符串匹配，利用 ErrorClassifier 的语义化分类：
        - 临时错误（TIMEOUT/NETWORK_ERROR/SERVER_ERROR/RATE_LIMIT）→ 可重试
        - 永久错误（AUTH_FAILED/INVALID_REQUEST/CONTEXT_TOO_LONG）→ 不重试
        - UNKNOWN → 保守重试

        Args:
            tool_call: 工具调用描述。
            result: 工具执行失败结果。

        Returns:
            dict: 包含 should_retry、reason、corrected_params 的反思结论。
        """
        if not result.error:
            return {"should_retry": False, "reason": "no error"}

        # W3: 使用 ErrorClassifier 分类工具错误
        try:
            tool_error = Exception(result.error)
            classified = self._error_classifier.classify(tool_error)
            if not classified.is_retryable:
                return {"should_retry": False, "reason": f"non-retryable: {classified.category.value}"}
        except Exception as exc:
            log.debug("Tool retry classification failed", tool=tool_call.name, error=str(exc))
        params = tool_call.parse_arguments() if hasattr(tool_call, "parse_arguments") else {}
        corrected: dict[str, Any] = dict(params)

        if "path" in corrected and ("no such file" in result.error.lower() or "找不到" in result.error.lower()):
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
        - llm_request: W8 LLM调用开始（含消息数/工具数）
        - llm_response: W8 LLM响应完成（含token用量/finish_reason）
        - tool_start: 工具调用开始
        - tool_progress: W8 工具执行中间进度（含阶段/百分比）
        - tool_end: 工具调用结束（含结果摘要）
        - checkpoint: W8 检查点保存事件（含轮次/消息数）
        - verification: W8 验证结果事件（含pre_tool/post_response结果）
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

        # R4: 反思知识复用 — 检索相似任务经验注入上下文
        _reflection_context = ""
        if self._reflection_kb is not None:
            try:
                similar = self._reflection_kb.search_experiences(
                    query=user_input, type="tool_usage", limit=3, min_success_rate=0.6,
                )
                if similar:
                    items = [f"  - {e.action}: {e.result} (成功率{e.success_rate:.0%})" for e in similar]
                    _reflection_context = "\n相关经验:\n" + "\n".join(items)
            except Exception as _r4r_exc:
                log.debug("R4: reflection KB retrieval failed, non-blocking", error=str(_r4r_exc))
        if _reflection_context:
            for _mi, _m in enumerate(messages):
                if _m.get("role") == "system":
                    messages[_mi] = {"role": "system", "content": _m["content"] + _reflection_context}
                    break

        # R2: 工具选择记忆 — 检索历史偏好注入上下文
        if self._tool_selection_memory is not None:
            try:
                preferred = self._tool_selection_memory.get_preferred_tools(limit=5)
                if preferred:
                    pref_str = ", ".join(preferred)
                    for _mi, _m in enumerate(messages):
                        if _m.get("role") == "system":
                            messages[_mi] = {"role": "system", "content": _m["content"] + f"\n常用工具: {pref_str}"}
                            break
            except Exception as _r2r_exc:
                log.debug("R2: tool selection memory retrieval failed, non-blocking", error=str(_r2r_exc))

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
                "type": "llm_request",
                "content": "",
                "metadata": {
                    "round": round_idx + 1,
                    "total_rounds": max_rounds,
                    "message_count": len(messages),
                    "has_tools": bool(tools_schema),
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
                log.debug("conversation_loop 异常处理", error=str(e))
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

            # W8: LLM响应完成事件
            yield {
                "type": "llm_response",
                "content": "",
                "metadata": {
                    "round": round_idx + 1,
                    "has_tool_calls": bool(tool_calls_raw),
                    "finish_reason": response.get("finish_reason", "stop"),
                    "content_len": len(content),
                },
            }

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

                # S2: 推理链引擎 — 将思考过程结构化为可验证的推理链
                # D1: 构建后自动验证+压缩，D2: 复杂度联动深度判定
                if self._reasoning_chain_engine is not None:
                    try:
                        _rc_complexity = "moderate"
                        if hasattr(self, '_current_complexity') and self._current_complexity:
                            _rc_complexity = self._current_complexity
                        chain = await self._reasoning_chain_engine.reason(
                            query=message,
                            complexity=_rc_complexity,
                        )
                        # D1: 自动验证推理链
                        _verify_results = await self._reasoning_chain_engine.verify(chain)
                        _verify_passed = all(r.passed for r in _verify_results.values())
                        _verify_score = sum(r.score for r in _verify_results.values()) / len(_verify_results) if _verify_results else 1.0
                        # D1: 验证不通过时压缩推理链并记录问题
                        _chain_metadata = {
                            "chain_id": chain.id,
                            "depth": chain.depth.value,
                            "nodes": len(chain.nodes),
                            "confidence": round(chain.total_confidence, 3),
                            "verified": _verify_passed,
                            "verify_score": round(_verify_score, 3),
                            "round": round_idx + 1,
                        }
                        if not _verify_passed:
                            _all_issues = []
                            for _vr in _verify_results.values():
                                _all_issues.extend(_vr.issues[:2])
                            _chain_metadata["verification_issues"] = _all_issues[:4]
                            if len(chain.nodes) > 5:
                                chain = self._reasoning_chain_engine.compress(chain, target_ratio=0.6)
                                _chain_metadata["compressed"] = True
                                _chain_metadata["compressed_nodes"] = len(chain.nodes)
                        yield {
                            "type": "reflection",
                            "content": chain.nodes[-1].content if chain.nodes else "",
                            "metadata": _chain_metadata,
                        }
                        # D3: 验证分数低或高风险关键词时触发反事实推理
                        if _verify_score < 0.7 or any(kw in message for kw in ["删除", "格式化", "重置", "覆盖", "不可逆"]):
                            try:
                                _cf_result = await self._reasoning_chain_engine.counterfactual(chain)
                                if _cf_result.get("counterfactual_paths"):
                                    yield {
                                        "type": "reflection",
                                        "content": f"反事实分析: {_cf_result.get('recommendation', '')}",
                                        "metadata": {
                                            "counterfactual": _cf_result,
                                            "round": round_idx + 1,
                                        },
                                    }
                            except Exception as _cf_exc:
                                log.debug("D3: counterfactual analysis failed, non-blocking", error=str(_cf_exc))
                    except Exception as _rc_exc:
                        log.debug("Reasoning chain failed, non-blocking", error=str(_rc_exc))

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

                # W8: 工具执行中间进度事件
                yield {
                    "type": "tool_progress",
                    "content": f"Executing {tc.name}...",
                    "metadata": {
                        "tool_name": tc.name,
                        "phase": "executing",
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

                # W8: 验证结果事件
                verified_output = self._verify_and_correct(tool_result)
                if verified_output != tool_result.output:
                    yield {
                        "type": "verification",
                        "content": "Tool result verified and corrected",
                        "metadata": {
                            "tool_name": tc.name,
                            "corrected": True,
                            "round": round_idx + 1,
                        },
                    }

                # S3: 语义验证 — tool_end 后自动校验输出质量
                if self._semantic_verifier is not None and tool_result.success and tool_result.output:
                    try:
                        sv_result = await self._semantic_verifier.verify(
                            input_text=message,
                            output=tool_result.output,
                            level="minimal",
                        )
                        if not sv_result.passed:
                            yield {
                                "type": "verification",
                                "content": f"Semantic issues: {len(sv_result.issues)}",
                                "metadata": {
                                    "tool_name": tc.name,
                                    "semantic_score": sv_result.score,
                                    "semantic_issues": [
                                        {"type": i.issue_type, "severity": i.severity.value}
                                        for i in sv_result.issues
                                        if hasattr(i, "severity") and hasattr(i, "issue_type")
                                    ],
                                    "round": round_idx + 1,
                                },
                            }
                    except Exception as _sv_exc:
                        log.debug("Semantic verification failed, non-blocking", error=str(_sv_exc))

                # R4: 反思知识自动沉淀 — tool_end 后将经验写入知识库
                if self._reflection_kb is not None:
                    try:
                        from agent.loop.reflection_knowledge_base import ReflectionExperience
                        exp = ReflectionExperience(
                            type="tool_usage",
                            context={"tool": tc.name, "round": round_idx + 1},
                            action=tc.name,
                            result="success" if tool_result.success else "failure",
                            reflection="",
                            insight="",
                            success_rate=1.0 if tool_result.success else 0.0,
                            tags=[tc.name],
                        )
                        self._reflection_kb.add_experience(exp)
                    except Exception as _r4_exc:
                        log.debug("R4: reflection KB deposit failed, non-blocking", error=str(_r4_exc))

                # R2: 工具选择记忆 — 记录本轮工具选择
                if self._tool_selection_memory is not None:
                    try:
                        self._tool_selection_memory.record(
                            tool_name=tc.name,
                            success=tool_result.success,
                            duration_ms=tool_duration,
                        )
                    except Exception as _r2_exc:
                        log.debug("R2: tool selection memory record failed, non-blocking", error=str(_r2_exc))

                # A3: 行为边界监控 — 记录工具调用
                if self._behavior_monitor is not None:
                    try:
                        self._behavior_monitor.record_tool_call(
                            tool_name=tc.name,
                            success=tool_result.success,
                            duration_ms=tool_duration,
                        )
                    except Exception as _a3_rec_exc:
                        log.debug("A3: behavior monitor record failed, non-blocking", error=str(_a3_rec_exc))

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": tool_result.output[:1000] if tool_result.output else "",
                })

            # W8: 每轮工具执行后发出检查点事件
            yield {
                "type": "checkpoint",
                "content": "",
                "metadata": {
                    "round": round_idx + 1,
                    "message_count": len(messages),
                    "tool_calls_so_far": tool_call_count,
                    "tool_successes": tool_success_count,
                },
            }

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
