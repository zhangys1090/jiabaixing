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
from agent.core.logger import log_ignored
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

# D4 Authority: Goal/State/Decision 三权分立（契约见 authority_types.py）。
# LLM tool_calls 必须经 DecisionAuthority 做 FINAL 决策才能执行。
from agent.core.goal_authority import GoalAuthority
from agent.core.state_authority import StateAuthority
from agent.core.decision_authority import (
    DecisionAuthority,
    LLMProposer,
    RecoveryProposer,
    SkillProposer,
)
from agent.core.authority_types import (
    CapabilitySet,
    ContextView,
    DecisionContext,
    MemoryView,
    WorldView,
)

# D2 (P2 第4轮回灌): 会话级认知信号(情绪/反思)注入 ReAct 循环 LLM 上下文
from agent.core.cognition_buffer import inject_cognition_into_messages

# 回合链路摘要：把一轮对话的完整执行链落成可分析的结构化记录，
# 供 scripts/analyze_failure_corpus.py 产出失败地图（M0–M15）。
from agent.core.trace_digest import TraceDigest

try:
    from agent.harness.trace_log import TraceLog, TraceEventType
    from agent.harness.context_window import ContextWindowManager, TokenBudget
    _HAS_HARNESS = True
except ImportError:
    _HAS_HARNESS = False

log = StructuredLogger("conversation_loop")


class _LoopStateProviders:
    """ML4 fix: 生产路径真实状态读取器 — 快照不再空壳。

    此前 StateAuthority.registerProviders() 在生产路径零调用，captureSnapshot
    在无 providers 时返回 world/context/capabilities 全空的 minimal snapshot，
    Decision 基于空状态裁决（日志实锤 "no read providers registered"）。

    本类把主循环**已经在采集**的真实信息接进快照：
        - world: 最近工具执行结果（真实环境反馈）
        - context: 工作目录（文件系统上下文）
        - capabilities: 已注册工具名列表（能力面）
        - memory: 复用 set_memory_engine 注入的 _read_memory（与
          registerMemoryProvider 同一检索链，全量模式不丢记忆）

    纯读取：不写入任何状态、不做决策（StateReadProviders 协议约束）。
    """

    def __init__(self, loop: Any) -> None:
        self._loop = loop

    def getAgentId(self) -> str:
        return "python-agent"

    def getSafetyStatus(self) -> str:
        return "nominal"

    async def readWorldState(self) -> WorldView:
        try:
            recent: list[dict[str, Any]] = []
            for tr in getattr(self._loop, "_last_tool_results", [])[-5:]:
                recent.append({
                    "tool": getattr(tr, "name", ""),
                    "success": bool(getattr(tr, "success", False)),
                    "output": (getattr(tr, "output", "") or "")[:120],
                })
            return WorldView(observation=recent or None, platform="desktop")
        except Exception:
            return WorldView()

    async def readMemory(self, query: str) -> MemoryView:
        try:
            rm = getattr(self._loop, "_read_memory", None)
            if rm is not None:
                return await rm(query)
        except Exception:
            pass
        return MemoryView(query=query)

    async def readContext(self, goalIds: list[str]) -> ContextView:
        try:
            from pathlib import Path
            cwd = str(Path.cwd())
            return ContextView(systemPrompt="", fileContexts=[cwd])
        except Exception:
            return ContextView()

    async def readCapabilities(self) -> CapabilitySet:
        try:
            reg = getattr(self._loop, "_tool_registry", None)
            names: list[str] = []
            if reg is not None:
                try:
                    if hasattr(reg, "filter_tools"):
                        names = [
                            getattr(d, "name", "")
                            for d in (reg.filter_tools(None) or [])
                            if getattr(d, "name", "")
                        ]
                    elif hasattr(reg, "get_all_tools"):
                        names = list(reg.get_all_tools().keys())
                except Exception:
                    names = []
            return CapabilitySet(
                availableTools=names[:300],
                desktopAvailable=True,
                bridgeAvailable=True,
            )
        except Exception:
            return CapabilitySet()



_MAX_TOOL_RETRIES = 3

#: 生产环境标识（与 engine.py:699 / main.py:232 的 ENV 约定保持一致）。
_PRODUCTION_ENVS = frozenset({"production", "prod", "staging", "stage"})


def is_production_env() -> bool:
    """当前是否生产环境（读 ENV 环境变量，默认 development）。"""
    return os.environ.get("ENV", "development").strip().lower() in _PRODUCTION_ENVS


def enforce_authority_invariant(use_authority: bool) -> bool:
    """Layer 1 不变量守卫：生产环境下禁止关闭 Authority 链。

    Layer 1 不变量是"任何生产动作都必须携带 goalId + snapshotId + decisionId"。
    若允许生产环境传 ``use_authority=False``，工具将**在没有任何 Authority 身份**
    的情况下被执行 —— 这是一个静默旁路，且事后无法从审计链看出来。

    因此 ``use_authority=False`` 被明确限定为 **LEGACY / TEST ONLY**：
    仅测试、离线验证脚本与显式兼容接口可以使用。生产环境请求关闭即报错，
    因为该开关**无法通过环境变量配置**，在生产变为 False 的唯一途径是代码改动
    —— 这种改动必须在启动时就响亮地失败，而不是让服务带着旁路静默运行。

    Args:
        use_authority: 调用方请求的开关值。

    Returns:
        生效值。请求 True 时恒为 True。

    Raises:
        ValueError: 生产环境下请求 False 时。
    """
    if use_authority:
        return True
    if is_production_env():
        raise ValueError(
            "生产环境禁止 use_authority=False —— 该开关为 LEGACY/TEST ONLY。"
            "它会产生'动作被执行但不带 goalId/snapshotId/decisionId'的静默旁路，"
            "直接违反 Layer 1 不变量（任何生产动作必须经过 Authority）。"
        )
    log.warning(
        "D4 Authority DISABLED — LEGACY/TEST ONLY 路径：动作将不带 Authority 身份",
        env=os.environ.get("ENV", "development"),
    )
    return False


def action_outcome_tokens(result: Any) -> tuple[str, str]:
    """把一次工具执行归一化为 Evidence 的 (expectedEffect, actualEffect)。

    为什么需要归一化:
        LearningAuthority.compute_prediction_error() 的分类逻辑依赖
        expected/actual 为 "success" / "failed" 这类语义标记
        （见 learning_authority.py:146-160）。此前主循环把工具原始输出
        截断后塞进 actualEffect，导致既非 "success" 也非 "failed"，
        分类永远落到词重叠兜底分支 —— PredictionError 退化为
        "模板串 vs 工具输出" 的 Jaccard 距离噪声，Learning 学的是噪声。

    归一化后的分类行为:
        - 成功: expected="success" == actual="success" → match, magnitude 0
        - 失败: actual 以 "failed" 开头 → over_prediction, magnitude 1.0
        即 D5 设计的"连续失败 → 信念下调 confidence → 决策改选"链路真实可达。

    Args:
        result: ToolResult（或任何有 success/error 属性的对象）。

    Returns:
        (expectedEffect, actualEffect) 二元组。
        expectedEffect 表达"决策时对该动作的预期"：该动作成功推进目标。
        预测的进度量不放在这里 —— 它由 updateFromEvidence 的
        progressDelta 单独承载，避免污染分类语义。
    """
    success = bool(getattr(result, "success", False))
    if success:
        return "success", "success"
    err = (getattr(result, "error", None) or "").strip()
    return "success", (f"failed: {err}" if err else "failed")


def reconcile_tool_messages(messages: list[dict[str, Any]]) -> int:
    """对账并补齐悬空的 tool_call_id（P0 修复，2026-09-17）。

    背景（真实故障，由 LLM 失败报文捕获定位）::

        BadRequestError: An assistant message with 'tool_calls' must be followed
        by tool messages responding to each 'tool_call_id'.
        (insufficient tool messages following tool_calls message)

    成因:
        assistant 消息在裁决**之前**就带上了全部 tool_calls
        （``assistant_msg["tool_calls"] = tool_calls_raw``），
        但只有 DecisionAuthority **接受**的候选才会执行并追加 tool 消息。
        候选被拒 / fail-closed / 连续失败提前跳出 / 执行异常 ——
        都会让该 tool_call_id 悬空，下一轮请求违反 OpenAI 契约，
        **整轮失败**且用户只看到"请求参数有误"。

    修法:
        不改"先记 tool_calls 再裁决"的顺序（那是证据链需要），
        而是在**发给 LLM 之前**对账：为每个没有对应 tool 消息的
        tool_call_id 合成一条占位 tool 消息，明确告知模型该动作未发生及原因。
        在发送前做（而不是在执行循环里做）可以覆盖所有成因，
        也让 run() / run_stream() 两条消息管线共用同一份逻辑。

    Args:
        messages: 将要发给 LLM 的消息列表（就地修改）。

    Returns:
        补齐的条数（诊断用）。
    """
    if not messages:
        return 0

    present: set[str] = set()
    for m in messages:
        if isinstance(m, dict) and m.get("role") == "tool":
            tcid = m.get("tool_call_id")
            if tcid:
                present.add(str(tcid))

    patched = 0
    for m in messages:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        calls = m.get("tool_calls") or []
        if not isinstance(calls, list):
            continue
        for c in calls:
            cid = str(c.get("id") or "") if isinstance(c, dict) else ""
            if not cid or cid in present:
                continue
            messages.append({
                "role": "tool",
                "tool_call_id": cid,
                "content": (
                    "[not executed] 该动作未被执行：DecisionAuthority 未接受此候选"
                    "（fail-closed / 姿态拒绝 / 候选被拒 / 执行中断）。"
                    "请根据当前状态重新决策，不要假设该动作已产生效果。"
                ),
            })
            present.add(cid)
            patched += 1
    return patched


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
        use_authority: bool = True,
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
            use_authority: D4 Authority 链开关，True 时 LLM tool_calls 必须经过
                           DecisionAuthority 才能执行；False 时回退旧行为（直接执行）。
                           **LEGACY / TEST ONLY** —— 仅供测试与离线验证脚本使用。
                           生产环境（ENV ∈ production/prod/staging/stage）请求 False
                           会抛 ValueError，防止产生无 Authority 身份的动作旁路。
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

        # D4 Authority: 三权实例接线。
        # use_authority=False 是 **LEGACY / TEST ONLY** 开关（见
        # enforce_authority_invariant 的文档）—— 生产环境请求关闭会直接报错，
        # 避免出现"动作执行但无 Authority 身份"的静默旁路。
        self._use_authority = enforce_authority_invariant(use_authority)
        if self._use_authority:
            self._goal_authority = GoalAuthority.getInstance()
            self._state_authority = StateAuthority.getInstance()
            self._decision_authority = DecisionAuthority.getInstance()
            self._llm_proposer = LLMProposer()
            self._skill_proposer = SkillProposer()
            # D4-M4: 真实第二候选源 —— 基于实测工具可靠性 + schema 兼容性的替补。
            # 数据源在 set_tool_selection_memory() / 构造时注入；未就绪时恒返回空列表，
            # 此时 DecisionAuthority 会如实标记 competitionDegraded=True。
            self._recovery_proposer = RecoveryProposer(tool_registry=tool_registry)
            self._decision_authority.registerProposer(self._llm_proposer)
            self._decision_authority.registerProposer(self._skill_proposer)
            self._decision_authority.registerProposer(self._recovery_proposer)
            # ML4 fix: 注册真实状态读取器 — 快照不再 minimal。
            # 失败不阻断启动（退化为原 minimal snapshot），但必须留痕。
            try:
                self._state_authority.registerProviders(
                    _LoopStateProviders(self)
                )
                log.info("ML4: state read providers registered")
            except Exception as _prov_exc:
                log.warning("ML4: state providers registration failed", error=str(_prov_exc))
        else:
            self._goal_authority = None
            self._state_authority = None
            self._decision_authority = None
            self._llm_proposer = None
            self._skill_proposer = None
            self._recovery_proposer = None

        # L0 ActionAuthority: 动作执行前的最后一道权力门禁（七层中 Python 侧曾缺失的层）。
        # 无论 use_authority 与否都构造 —— legacy 路径由门禁显式放行并留痕。
        from agent.core.action_authority import ActionAuthority, ActionContext, VERDICT_ALLOW

        self._action_authority = ActionAuthority(
            decision_authority=self._decision_authority
        )

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
        self._memory_engine: Any = None
        self._cross_device_coordinator: Any = None
        self._last_tool_results: list[Any] = []
        self._pending_replan_context: str | None = None

    @property
    def use_authority(self) -> bool:
        """D4 Authority 链当前是否生效（只读视图，供启动断言与健康检查使用）。"""
        return self._use_authority

    def set_use_authority(self, enabled: bool) -> None:
        """运行时切换 Authority 链 —— 与构造参数受**同一不变量守卫**约束。

        Args:
            enabled: 目标状态。

        Raises:
            ValueError: 生产环境下请求关闭时。
        """
        self._use_authority = enforce_authority_invariant(bool(enabled))

    def assert_authority_invariant(self) -> None:
        """启动断言：非 legacy 模式下 Authority 链必须处于开启状态。

        Raises:
            RuntimeError: Authority 被关闭却仍处于生产环境（不应发生，
                是构造守卫与运行时 setter 之外的第三道防线）。
        """
        if not self._use_authority and is_production_env():
            raise RuntimeError(
                "Layer 1 不变量违规：生产环境下 Authority 链处于关闭状态。"
                "任何生产动作都必须携带 goalId/snapshotId/decisionId。"
            )

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
        """R2: 工具选择记忆 — 记录工具选择历史，优化未来选择。

        同时把该记忆绑定给 RecoveryProposer（第二意见来源，D4-M4）
        和 DecisionAuthority（M5：打分时实测成功率优先于 proposer 乐观估计）。
        """
        self._tool_selection_memory = memory
        if self._recovery_proposer is not None:
            self._recovery_proposer.bind(tool_selection_memory=memory)
        if self._decision_authority is not None:
            self._decision_authority.set_tool_selection_memory(memory)

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

    def set_memory_engine(self, engine: Any) -> None:
        """D6: 接通"检索服务 Decision" — MemoryEngine.search 注入 StateAuthority
        快照的 MemoryView（D6 验收②）。幂等，engine 为 None 时忽略。"""
        if engine is None:
            return
        self._memory_engine = engine
        if self._state_authority is not None:
            async def _read_memory(query: str) -> Any:
                from agent.core.authority_types import MemoryView

                try:
                    hits = await engine.search(query, limit=3)
                except Exception as _search_exc:
                    log.warning("D6 readMemory 检索失败，返回空视图", error=str(_search_exc))
                    return MemoryView(query=query)
                return MemoryView(
                    query=query,
                    relevantMemories=[
                        {
                            "content": h.get("content", ""),
                            "memoryType": h.get("memory_type", h.get("type", "")),
                            "relevanceScore": h.get("relevance", h.get("relevanceScore", 0.0)),
                            "timestamp": h.get("timestamp"),
                        }
                        for h in (hits or [])[:3]
                        if isinstance(h, dict)
                    ],
                )

            self._state_authority.registerMemoryProvider(_read_memory)

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
                    except Exception as _exc:
                        log_ignored(log, "conversation_loop.ConversationLoop._dispatch_tool_calls", _exc)
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
                {"tool": tr.name, "result": tr.output, "success": tr.success}
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
                except Exception as _exc:
                    log_ignored(log, "conversation_loop.ConversationLoop._dispatch_tool_calls", _exc)
            # R2: 工具选择记忆 (run 串行路径)
            if self._tool_selection_memory is not None:
                try:
                    self._tool_selection_memory.record(tool_name=tc.name, success=tool_result.success)
                except Exception as _exc:
                    log_ignored(log, "conversation_loop.ConversationLoop._dispatch_tool_calls", _exc)
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
            {"tool": tr.name, "result": tr.output, "success": tr.success}
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
            except Exception as _exc:
                log_ignored(log, "conversation_loop.ConversationLoop._dispatch_tool_calls", _exc)
        # R2: 工具选择记忆 (run 并行路径)
        if self._tool_selection_memory is not None:
            try:
                self._tool_selection_memory.record(tool_name=r.name, success=r.success)
            except Exception as _exc:
                log_ignored(log, "conversation_loop.ConversationLoop._dispatch_tool_calls", _exc)
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
            except Exception as _exc:
                log_ignored(log, "conversation_loop.ConversationLoop.run", _exc)

        # D4 Authority: 每轮对话创建稳定 Goal 身份 + State 快照（goalId/snapshotId 贯穿全程）。
        # 长任务 Goal 复用：同 session 的后续请求复用 ACTIVE Goal（跨轮延续 progress/evidence/planVersion）。
        goal_id: str | None = None
        snapshot_id: str | None = None
        decision_id: str | None = None
        if self._use_authority:
            try:
                goal = self._goal_authority.getOrCreateGoal(
                    description=user_input[:200],
                    originalInput=user_input,
                    session_id=session_id,
                )
                goal_id = goal.goalId
                snapshot = await self._state_authority.captureSnapshot(activeGoalIds=[goal_id])
                snapshot_id = snapshot.snapshotId
            except Exception as _auth_exc:
                log.warning("Authority goal/snapshot creation failed, continuing without", error=str(_auth_exc))

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
                except Exception as _exc:
                    log_ignored(log, "conversation_loop.ConversationLoop.run", _exc)
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
            # ML6 fix: replan 上下文注入 — replan 后通知 LLM 新规划版本，
            # 让后续 Decision 基于新规划（避免 LLM 不知道已 replan，继续旧路径）。
            if self._pending_replan_context:
                turn.messages.append(
                    {"role": "system", "content": self._pending_replan_context}
                )
                self._pending_replan_context = None
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
                                    except Exception as _exc:
                                        log_ignored(log, "conversation_loop.ConversationLoop.run", _exc)
                        except Exception as exc:
                            log.warning("上下文窗口截断失败，使用原始消息", error=str(exc))

                # W6: 记录LLM请求事件
                if self._trace_log and _HAS_HARNESS:
                    try:
                        self._trace_log.record(trace_id, session_id, TraceEventType.LLM_CALL, {
                            "round": budget.current_round, "message_count": len(llm_messages),
                            "has_tools": tools_schema is not None,
                        })
                    except Exception as _exc:
                        log_ignored(log, "conversation_loop.ConversationLoop.run", _exc)

                # P0 修复（2026-09-17）：发送前对账，补齐悬空的 tool_call_id。
                # 真实故障见 reconcile_tool_messages 的文档 —— 否则下一轮请求
                # 违反 OpenAI 契约，整轮失败且用户只看到"请求参数有误"。
                try:
                    _reconciled = reconcile_tool_messages(llm_messages)
                    if _reconciled:
                        log.warning(
                            "tool_calls 对账：补齐悬空的 tool 消息",
                            patched=_reconciled,
                            round=budget.current_round,
                        )
                except Exception as _rec_exc:
                    log.debug("tool message reconcile skipped", error=str(_rec_exc))

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
                    except Exception as _exc:
                        log_ignored(log, "conversation_loop.ConversationLoop.run", _exc)
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
                except Exception as _exc:
                    log_ignored(log, "conversation_loop.ConversationLoop.run", _exc)

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
                        query=user_input, top_k=3,
                    )
                    if _cl_knowledge:
                        _cl_tips = [f"  - {k.title}: {k.content[:80]}" for k in _cl_knowledge[:2]]
                        log.info("P2-2: 持续学习检索到相关经验", count=len(_cl_knowledge))
                        # M9 fix: 将检索到的经验注入 LLM context，而非仅 log
                        _cl_context = "\n".join(_cl_tips)
                        _cl_msg = {
                            "role": "system",
                            "content": f"[相关经验]\n{_cl_context}",
                        }
                        turn.messages.append(_cl_msg)
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
            decision_id: str | None = None

            # P0 修复（2026-09-17）：goal 已 COMPLETED 时正常收口（与 run_stream 同构）。
            # 否则 decide() 抛 "goal is COMPLETED, not active" 会被误报成
            # "所有Proposer均未产生候选动作"，把已完成的任务判成授权失败。
            if self._use_authority and goal_id:
                _goal_now = self._goal_authority.getGoal(goal_id)
                if _goal_now is not None and str(
                    getattr(getattr(_goal_now, "status", None), "value", "")
                ) == "completed":
                    final_content = content or "目标已完成。"
                    turn.state = TurnState.COMPLETED
                    finish_reason = "goal_completed"
                    _tracing.end_span(_iter_span)
                    break

            # D4 Authority: LLM tool_calls 必须经 DecisionAuthority 做 FINAL 决策。
            # M4 fix: 多 Proposer 竞争 — LLMProposer + SkillProposer 同时 propose，
            # DecisionAuthority.decideWithProposers() 收集所有候选后做 FINAL 裁决。
            # 无候选/决策失败 → 拒绝执行（fail-closed，无任何绕过路径）。
            if self._use_authority and goal_id and snapshot_id:
                latest_snapshot = self._state_authority.getLatestSnapshot()
                if latest_snapshot is None:
                    latest_snapshot = await self._state_authority.captureSnapshot(activeGoalIds=[goal_id])

                self._llm_proposer.pending_tool_calls = tool_calls_raw
                if self._recovery_proposer is not None:
                    self._recovery_proposer.pending_tool_calls = tool_calls_raw
                try:
                    decision = await self._decision_authority.decideWithProposers(
                        goalId=goal_id,
                        snapshot=latest_snapshot,
                    )
                except ValueError as _no_cand_exc:
                    log.error(
                        "D4 Authority: no candidates from any proposer — no action will execute",
                        goalId=goal_id,
                        snapshotId=snapshot_id,
                        error=str(_no_cand_exc),
                    )
                    turn.state = TurnState.FAILED
                    turn.error = f"DecisionAuthority: no candidates, action denied — {_no_cand_exc}"
                    final_content = "决策授权失败：所有Proposer均未产生候选动作，拒绝执行。"
                    finish_reason = "authority_denied"
                    _tracing.end_span(_iter_span)
                    break
                except Exception as _dec_exc:
                    log.error(
                        "D4 Authority: DecisionAuthority.decideWithProposers() failed — NO ACTION WILL EXECUTE",
                        goalId=goal_id,
                        snapshotId=snapshot_id,
                        error=str(_dec_exc),
                    )
                    turn.state = TurnState.FAILED
                    turn.error = f"DecisionAuthority failed: {_dec_exc}"
                    final_content = "决策授权失败，拒绝执行任何动作。"
                    finish_reason = "authority_denied"
                    _tracing.end_span(_iter_span)
                    break
                finally:
                    self._llm_proposer.pending_tool_calls = None
                    if self._recovery_proposer is not None:
                        self._recovery_proposer.pending_tool_calls = None

                decision_id = decision.decisionId
                for cand in decision.acceptedCandidates:
                    payload = cand.action.payload
                    tc = ToolCall(
                        id=payload.get("id", f"tc_{uuid.uuid4().hex[:6]}"),
                        name=payload.get("name", ""),
                        arguments=payload.get("arguments", "{}"),
                    )
                    tc.metadata = {
                        "authority_goalId": goal_id,
                        "authority_snapshotId": snapshot_id,
                        "authority_decisionId": decision_id,
                        "authority_candidateId": cand.candidateId,
                        "authority_proposerId": cand.proposerId,
                        "authority_isChosen": cand.candidateId == decision.chosenCandidateId,
                    }
                    round_calls.append(tc)
                    turn.tool_calls.append(tc)

                log.info(
                    "D4 Authority: DecisionAuthority decided",
                    decisionId=decision_id,
                    goalId=goal_id,
                    snapshotId=snapshot_id,
                    chosenTool=round_calls[0].name if round_calls else "none",
                    candidateCount=len(decision.candidateIds),
                    proposerCount=decision.proposerCount,
                    competitionDegraded=decision.competitionDegraded,
                    selectionReason=decision.selectionReason,
                )
            else:
                # P7-G fix: Authority fail-closed — 当 use_authority=True 但
                # goal_id/snapshot_id 缺失时，拒绝执行而非降级。
                if self._use_authority:
                    log.error(
                        "D4 Authority FAIL-CLOSED: use_authority=True but goal_id or snapshot_id missing — refusing to execute",
                        goalId=goal_id,
                        snapshotId=snapshot_id,
                        toolCallCount=len(tool_calls_raw),
                    )
                    turn.state = TurnState.FAILED
                    turn.error = "Authority fail-closed: goal/snapshot unavailable, refusing execution"
                    final_content = "安全拒绝：授权信息缺失，无法验证操作安全性。"
                    finish_reason = "authority_fail_closed"
                    _tracing.end_span(_iter_span)
                    break
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
            self._last_tool_results = list(turn.tool_results)

            # ML6 fix: 循环内 replan — 失败形态触发（与 run_stream 的 M8 重设计
            # 对齐：失败连击≥2 或本轮失败≥2），planVersion<3 时 replan 并注入
            # 下一轮 LLM 上下文。原实现把 replan 放在 while 循环之后 ——
            # 触发时循环已结束，planVersion++ 对本次 run 零影响（死代码）。
            if self._use_authority and goal_id:
                try:
                    _g_now = self._goal_authority.getGoal(goal_id)
                    _streak = 0
                    for _tr in reversed(turn.tool_results):
                        if not getattr(_tr, "success", False):
                            _streak += 1
                        else:
                            break
                    _round_fails = sum(
                        1 for _tr in self._last_tool_results
                        if not getattr(_tr, "success", False)
                    )
                    if (
                        _g_now is not None
                        and _g_now.planVersion < 3
                        and (_streak >= 2 or _round_fails >= 2)
                    ):
                        self._goal_authority.replan(
                            goalId=goal_id,
                            reason=(
                                f"failure_pattern: streak={_streak}, "
                                f"round_fails={_round_fails}"
                            ),
                            expectedVersion=_g_now.planVersion,
                        )
                        _pv = _g_now.planVersion + 1
                        self._pending_replan_context = (
                            f"[系统提示] 当前任务已触发 replan（planVersion → {_pv}）。"
                            "原因：连续失败/重复失误。请基于新规划调整策略，"
                            "避免重复使用失败的工具或参数。"
                        )
                        log.warning(
                            "ML6: replan triggered in-loop",
                            goalId=goal_id,
                            streak=_streak,
                            roundFails=_round_fails,
                            newPlanVersion=_pv,
                        )
                except Exception as _ml6_exc:
                    log.debug("ML6: in-loop replan failed, non-blocking", error=str(_ml6_exc))

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

        # D4 Authority: 证据回写 — Outcome 以 Evidence 形式关联到同一 goalId，
        # 形成 G→S→D→A→E 闭环（goal identity 跨全轮稳定）。
        if self._use_authority and goal_id and decision_id:
            try:
                decision_history = self._decision_authority.getDecisionHistory(goal_id)
                latest_decision = decision_history[-1] if decision_history else None
                # ML5 fix: progress 验证驱动 + 按 decisionId 去重。
                # 原实现每个 chosen 成功工具都加 estimatedGoalProgress 差值，
                # 一轮并行 3 个工具进度虚增 3 次；且所有工具复用最后一个
                # decision 的估计值。改为：每个 decision（=一轮）只推进一次
                # （第一个 chosen 成功工具），其余 chosen 成功工具 delta=0
                # （evidence 仍逐条记账，审计不丢）；失败工具各自 -0.05。
                _progressed_decisions: set[str] = set()
                for tr in turn.tool_results:
                    auth_meta = tr.metadata
                    is_chosen = auth_meta.get("authority_isChosen", False)
                    dec_id = str(auth_meta.get("authority_decisionId", "") or "")
                    if not tr.success:
                        progress_delta = -0.05
                    elif (
                        is_chosen and latest_decision and dec_id not in _progressed_decisions
                    ):
                        progress_delta = latest_decision.chosen.estimatedGoalProgress - self._goal_authority.getGoal(goal_id).progress
                        progress_delta = max(0.0, min(0.5, progress_delta))
                        _progressed_decisions.add(dec_id)
                    else:
                        progress_delta = 0.0
                    _exp_effect, _act_effect = action_outcome_tokens(tr)
                    self._goal_authority.updateFromEvidence(
                        goalId=goal_id,
                        decisionId=decision_id,
                        actionName=tr.name,
                        actionParams={"tool_call_id": tr.tool_call_id},
                        observation=tr.output[:500] if tr.output else None,
                        expectedEffect=_exp_effect,
                        actualEffect=_act_effect,
                        progressDelta=progress_delta,
                    )
            except Exception as _ev_exc:
                log.warning("D4 Authority evidence write-back failed", error=str(_ev_exc))

        # ML6 fix: replan 已移入循环内（失败形态触发 + 上下文注入）。

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
            except Exception as _exc:
                log_ignored(log, "conversation_loop.ConversationLoop.run", _exc)

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
                # D4 Authority: 决策链 ID 暴露到结果元数据（供上游审计/replay）。
                "authority": {
                    "goalId": goal_id,
                    "snapshotId": snapshot_id,
                    "decisionId": decision_id,
                } if self._use_authority else None,
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

        # D4 Authority: ToolCall.metadata 中的 authority_* 注入工具参数，
        # 由 desktop_automate 等工具透传到 TS delegated 路径（附 HMAC 签名）。
        _auth_keys: dict[str, Any] = {}
        if tool_call.metadata:
            _auth_keys = {k: v for k, v in tool_call.metadata.items() if k.startswith("authority_")}
            if _auth_keys:
                params["_authority_meta"] = _auth_keys

        # ── L0 ActionAuthority：执行前的最后一道权力门禁 ──
        # 回答"这个动作有权被执行吗"（与 schema 校验的"参数合法吗"互补）。
        # fail-closed：身份不全 / provenance 无法回查 / 候选不在 accepted 集 / 姿态拒绝 → 一律拒绝。
        from agent.core.action_authority import (
            ActionContext as _ActionContext,
            VERDICT_ALLOW as _VERDICT_ALLOW,
        )

        _l0 = self._action_authority.check(_ActionContext(
            toolName=tool_call.name,
            toolCallId=tool_call.id,
            goalId=_auth_keys.get("authority_goalId"),
            snapshotId=_auth_keys.get("authority_snapshotId"),
            decisionId=_auth_keys.get("authority_decisionId"),
            candidateId=_auth_keys.get("authority_candidateId"),
            proposerId=_auth_keys.get("authority_proposerId"),
            useAuthority=bool(self._use_authority),
        ))
        if _l0.verdict != _VERDICT_ALLOW:
            log.error(
                "L0 ActionAuthority 拒绝执行",
                tool=tool_call.name,
                toolCallId=tool_call.id,
                reason=_l0.reason,
                detail=_l0.detail,
            )
            return ToolResult(
                tool_call_id=tool_call.id,
                name=tool_call.name,
                output=f"动作被 Authority 拒绝执行: {_l0.detail}",
                success=False,
                error=_l0.reason,
                duration=time.time() - start,
            )

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
                except Exception as _exc:
                    log_ignored(log, "conversation_loop.ConversationLoop._execute_tool", _exc)
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
            except Exception as _exc:
                log_ignored(log, "conversation_loop.ConversationLoop._execute_tool", _exc)

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
            # D4 Authority: ToolCall 的 authority_* 元数据继承到 ToolResult（证据回写关联）。
            metadata={
                **dict(getattr(result, "metadata", {}) or {}),
                **({k: v for k, v in tool_call.metadata.items() if k.startswith("authority_")} if tool_call.metadata else {}),
            },
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
        authority_meta: dict[str, Any] | None = None,
    ):
        """P0-1/P1-4: 流式 ReAct 循环 — 富类型流式事件。

        每一轮 LLM 调用都使用 chat_stream 进行实时 token 输出，
        同时通过 ThinkScrubber 分离思考过程并 yield thinking 事件。

        与 run() 一致，本方法同样经过 D4 Authority 链：
        Goal → Snapshot → DecisionAuthority → Action → Evidence → Replan → Learning。
        两条路径产生的 goalId/snapshotId/decisionId 语义完全同构。

        事件类型:
        - stream_start: 流开始
        - progress: 进度更新 (current_round, total_rounds)
        - plan: 生成的执行计划
        - thinking: LLM 思考过程
        - token: 文本 token 增量
        - llm_request: W8 LLM调用开始（含消息数/工具数）
        - llm_response: W8 LLM响应完成（含token用量/finish_reason）
        - authority: D4 决策事件（含 goalId/snapshotId/decisionId/候选集）
        - tool_start: 工具调用开始
        - tool_progress: W8 工具执行中间进度（含阶段/百分比）
        - tool_end: 工具调用结束（含结果摘要）
        - checkpoint: W8 检查点保存事件（含轮次/消息数）
        - verification: W8 验证结果事件（含pre_tool/post_response结果）
        - reflection: 中间评估结果
        - stream_done: 流结束（含汇总元数据）
        - error: 错误

        Args:
            authority_meta: 上游（TS 网关）传入的跨进程委派三元组
                {authority_goalId, authority_snapshotId, authority_decisionId}。
                传入时本进程**不再新建 Goal**，而是绑定到既有 Goal 身份，
                避免跨进程出现两套权力层（AUTHORITY_RECONSTRUCTION §9.7）。

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

        # ── D4 Authority: 建立/绑定 Goal 身份 + State 快照 ──
        # 与 run() 同构：goalId/snapshotId 贯穿全轮，使流式路径同样可审计、可回放。
        goal_id: str | None = None
        snapshot_id: str | None = None
        decision_id: str | None = None
        delegated_meta: dict[str, Any] | None = None
        if self._use_authority:
            if authority_meta:
                # 跨进程委派：只接受身份三元组，不接受 Decision 语义
                # （§9.7 Cross-Process Delegation Is Identity-Only）。
                _g = authority_meta.get("authority_goalId")
                _s = authority_meta.get("authority_snapshotId")
                _d = authority_meta.get("authority_decisionId")
                if _g and _s:
                    goal_id, snapshot_id = str(_g), str(_s)
                    decision_id = str(_d) if _d else None
                    delegated_meta = {
                        "authority_goalId": goal_id,
                        "authority_snapshotId": snapshot_id,
                        "authority_decisionId": decision_id or "",
                    }
                    # 长任务 Goal 复用：TS 网关委派 goalId 在本进程落库（不存在时以该 ID
                    # 注册），避免后续 getGoal/replan/evidence 因身份缺失而断链。
                    try:
                        self._goal_authority.getOrCreateGoal(
                            description=user_input[:200],
                            originalInput=user_input,
                            session_id=session_id,
                            explicit_goal_id=goal_id,
                        )
                    except Exception as _g_exc:
                        log.warning(
                            "D4 Authority: delegated goal registration failed, continuing",
                            error=str(_g_exc),
                        )
                else:
                    # §9.8 委派防伪：三元组不全 → 拒绝委派，退回本进程自建身份。
                    log.warning(
                        "D4 Authority: delegated authority_meta incomplete, ignoring",
                        hasGoal=bool(_g),
                        hasSnapshot=bool(_s),
                    )
            if not goal_id:
                try:
                    goal = self._goal_authority.getOrCreateGoal(
                        description=user_input[:200],
                        originalInput=user_input,
                        session_id=session_id,
                    )
                    goal_id = goal.goalId
                    snapshot = await self._state_authority.captureSnapshot(
                        activeGoalIds=[goal_id]
                    )
                    snapshot_id = snapshot.snapshotId
                except Exception as _auth_exc:
                    log.warning(
                        "Authority goal/snapshot creation failed (stream), continuing without",
                        error=str(_auth_exc),
                    )

        # 本轮流式执行累积的工具结果 —— replan / Learning 需要完整的动作-结果序列。
        stream_tool_results: list[Any] = []
        _authority_closed = {"done": False, "digest_emitted": False}

        # 回合链路摘要（诊断用，任何记录失败都不影响主循环）
        digest = TraceDigest(
            turn_id=trace_id, session_id=session_id, user_input=user_input
        )
        digest.authority_enabled = bool(self._use_authority)
        digest.set_identity(goal_id, snapshot_id)
        if goal_id:
            try:
                _g0 = self._goal_authority.getGoal(goal_id)
                digest.note_goal_progress_start(_g0.progress if _g0 else None)
            except Exception as _dg_exc:
                log.debug("digest: goal progress snapshot failed", error=str(_dg_exc))

        async def _close_authority() -> None:
            """流式路径的 Authority 收口：Replan + Learning（与 run() 同构，幂等）。

            调用点：每个 stream_done 之前。设计约束见开发标准 §9.6
            —— Learning 失败不得阻断主链路。
            """
            if not self._use_authority or not goal_id or _authority_closed["done"]:
                return
            _authority_closed["done"] = True

            # M8 重设计（2026-09-17）：replan 触发条件由"progress 绝对阈值"
            # 改为"**失败形态**"。原条件（progress<0.3）在成功一次 chosen 动作
            # （+0.5）后窗口立即关闭 —— 真实语料 36 回合 15 次失败动作，
            # replan 触发 0 次（休眠）。新条件度量失败本身：
            #   a) 失败连击 ≥2（末尾连续失败）
            #   b) 本回合重复预测失误（over_prediction ≥2，即模型持续高估）
            # 任一命中且 planVersion 未达上限即 replan。
            try:
                goal = self._goal_authority.getGoal(goal_id)

                _fail_results = [r for r in stream_tool_results
                                 if not getattr(r, "success", False)]
                _streak = 0
                for r in reversed(stream_tool_results):
                    if not getattr(r, "success", False):
                        _streak += 1
                    else:
                        break
                _over_pred = sum(
                    1 for rd in digest.rounds
                    for a in (rd.get("actions") or [])
                    if a.get("errorType") == "over_prediction"
                )

                _trigger = False
                _why = ""
                if goal is None:
                    _why = "goal_missing"
                elif str(getattr(getattr(goal, "status", None), "value", "")) == "completed":
                    _why = "goal_completed"
                elif getattr(goal, "planVersion", 0) >= 3:
                    _why = "plan_version_cap_reached"
                elif _streak >= 2:
                    _trigger = True
                    _why = f"consecutive_failures={_streak}"
                elif _over_pred >= 2:
                    _trigger = True
                    _why = f"repeated_prediction_error={_over_pred}"
                elif _fail_results:
                    _why = f"isolated_failures={len(_fail_results)}_below_threshold"
                else:
                    _why = "no_failure_in_turn"

                if goal is not None and _trigger:
                    self._goal_authority.replan(
                        goalId=goal_id,
                        reason=f"{_why}; progress={goal.progress:.2f}",
                        expectedVersion=goal.planVersion,
                    )
                    log.warning(
                        "M8(stream): replan triggered by failure pattern",
                        goalId=goal_id,
                        trigger=_why,
                        progress=round(goal.progress, 2),
                    )
                    digest.record_replan(
                        before=goal.planVersion,
                        after=goal.planVersion + 1,
                        reason=_why,
                    )
                else:
                    digest.replan = {"triggered": False, "reason": _why}
            except Exception as _replan_exc:
                log.debug(
                    "M8(stream): replan trigger failed, non-blocking",
                    error=str(_replan_exc),
                )

            # P2-2: 持续学习 —— 对话结束时触发（模式识别 + 知识沉淀）
            if self._continual_learning is not None:
                try:
                    _cl_report = await self._continual_learning.learn()
                    if _cl_report.adjustments_made > 0 or _cl_report.knowledge_solidified > 0:
                        log.info(
                            "P2-2(stream): 持续学习完成",
                            patterns=_cl_report.new_patterns_found,
                            adjustments=_cl_report.adjustments_made,
                            solidified=_cl_report.knowledge_solidified,
                        )
                except Exception as _cl_exc:
                    log.debug(
                        "P2-2(stream): 持续学习触发异常，非阻断",
                        error=str(_cl_exc),
                    )

        def _emit_digest(finish_reason: str, quality_score: float | None) -> None:
            """收口链路摘要并落盘（诊断用；任何失败都不得影响主循环）。

            幂等：同一回合重复调用只落盘一次（错误路径与正常出口可能都会调）。
            """
            if _authority_closed["digest_emitted"]:
                return
            _authority_closed["digest_emitted"] = True
            try:
                _gp = None
                if goal_id:
                    _g_end = self._goal_authority.getGoal(goal_id)
                    _gp = _g_end.progress if _g_end else None
                digest.finalize(
                    finish_reason, quality_score, goal_progress_end=_gp
                )
                digest.persist()
            except Exception as _dg_exc:
                log.debug("digest finalize failed, non-blocking", error=str(_dg_exc))


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
                # P0 修复（2026-09-17）：发送前对账，补齐悬空的 tool_call_id。
                # run_stream 的 assistant 消息在裁决前就带上了全部 tool_calls，
                # 被拒候选会让对应 tool_call_id 悬空 → 下一轮违反 OpenAI 契约。
                try:
                    _reconciled = reconcile_tool_messages(messages)
                    if _reconciled:
                        log.warning(
                            "tool_calls 对账：补齐悬空的 tool 消息(stream)",
                            patched=_reconciled,
                            round=round_idx + 1,
                        )
                except Exception as _rec_exc:
                    log.debug("tool message reconcile skipped", error=str(_rec_exc))

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
                    # 失败回合同样要留链路摘要 —— 否则"失败最重的回合无痕迹"，
                    # 对失败语料是致命的（_emit_digest 幂等，重复调用安全）。
                    _emit_digest("llm_error", None)
                    yield {
                        "type": "error",
                        "content": classified.user_message,
                        "metadata": {
                            "category": classified.category.value,
                            "consecutive_failures": consecutive_failures,
                        },
                    }
                    return
                _emit_digest("llm_error", None)
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

            # P2-1（run_stream 对齐 run()）：世界模型对拟执行动作做预判。
            # 此前该消费只存在于非流式路径 —— 默认生产路径（WS 流式）从未喂过
            # 世界模型。低置信度预判会作为**当轮风险惩罚**注入 DecisionAuthority
            # 打分（set_world_model_risk）—— World 节点从"只告警"变为"进决策"。
            if self._world_model is not None and tool_calls_raw:
                async def _do_wm_stream():
                    _wm_low: dict[str, float] = {}
                    try:
                        wm_state = await self._world_model.build_current_state()
                        for tc_raw in tool_calls_raw[:3]:
                            tc_fn = tc_raw.get("function", {})
                            pred = await self._world_model.predict(
                                wm_state, tc_fn.get("name", ""), "",
                            )
                            if pred.confidence_level.value == "low":
                                log.warning(
                                    "P2-1(stream): 世界模型预判低置信度",
                                    action=tc_fn.get("name", ""),
                                    confidence=round(pred.confidence, 3),
                                    risks=pred.risks,
                                )
                                _wm_low[tc_fn.get("name", "")] = float(pred.confidence)
                            wm_state = pred.predicted_state_after
                    except Exception as exc:
                        log.debug("P2-1(stream): 世界模型预判异常，非阻断", error=str(exc))
                    if self._decision_authority is not None:
                        self._decision_authority.set_world_model_risk(_wm_low or None)

                try:
                    await asyncio.wait_for(_do_wm_stream(), timeout=10)
                except Exception as _wm_exc:
                    log.debug("world model predict skipped", error=str(_wm_exc))

            if stream_budget.is_token_exhausted:
                _qs = tool_success_count / max(tool_call_count, 1) if tool_call_count > 0 else 0.0
                _dur_ms = int((_t.time() - start_time) * 1000)
                await _close_authority()
                _emit_digest("token_budget_exhausted", round(_qs * 0.7, 4))
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
                            query=user_input,
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
                        if _verify_score < 0.7 or any(kw in user_input for kw in ["删除", "格式化", "重置", "覆盖", "不可逆"]):
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
                await _close_authority()
                _emit_digest("complete", _qs)
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

            # ── D4 Authority: LLM tool_calls 必须经 DecisionAuthority 做 FINAL 决策 ──
            # 与 run() 同构（见本文件 run() 内的同名区块）。无候选/决策失败 → fail-closed，
            # 拒绝执行任何动作，不存在绕过路径。
            round_calls: list[ToolCall] = []
            if self._use_authority and goal_id and snapshot_id:
                # P0 修复（2026-09-17）：goal 已 COMPLETED 时**正常收口**，而非 fail-closed。
                # 真实故障（收敛闭环 M0→M3）：任务做完后 progress 达 1.0 → GoalAuthority
                # 置 COMPLETED → 下一轮 decide() 抛 "goal is COMPLETED, not active"
                # → 被 except ValueError 误报成"所有Proposer均未产生候选动作"
                # → 回合被杀，用户拿到"决策授权失败"而不是结果。
                # 目标完成是 Authority 的正常终态，不是授权违规。
                _goal_now = self._goal_authority.getGoal(goal_id)
                if _goal_now is not None and str(
                    getattr(getattr(_goal_now, "status", None), "value", "")
                ) == "completed":
                    _qs = tool_success_count / max(tool_call_count, 1) if tool_call_count > 0 else 0.7
                    _dur_ms = int((_t.time() - start_time) * 1000)
                    await _close_authority()
                    _emit_digest("goal_completed", round(_qs, 4))
                    yield {
                        "type": "stream_done",
                        "content": "",
                        "trace_id": trace_id,
                        "session_id": session_id,
                        "quality_score": round(_qs, 4),
                        "rounds_used": round_idx + 1,
                        "duration": _dur_ms / 1000.0,
                        "finish_reason": "goal_completed",
                        "metadata": {
                            "total_rounds": round_idx + 1,
                            "tool_calls": tool_call_count,
                            "tool_successes": tool_success_count,
                            "duration_ms": _dur_ms,
                            "tool_duration_ms": int(total_tool_duration_ms),
                            "finish_reason": "goal_completed",
                        },
                    }
                    return
                _latest_snapshot = self._state_authority.getLatestSnapshot()
                if _latest_snapshot is None:
                    _latest_snapshot = await self._state_authority.captureSnapshot(
                        activeGoalIds=[goal_id]
                    )
                self._llm_proposer.pending_tool_calls = tool_calls_raw
                if self._recovery_proposer is not None:
                    self._recovery_proposer.pending_tool_calls = tool_calls_raw
                try:
                    decision = await self._decision_authority.decideWithProposers(
                        goalId=goal_id,
                        snapshot=_latest_snapshot,
                    )
                except ValueError as _no_cand_exc:
                    log.error(
                        "D4 Authority(stream): no candidates from any proposer — no action will execute",
                        goalId=goal_id,
                        snapshotId=snapshot_id,
                        error=str(_no_cand_exc),
                    )
                    # P0 修复（2026-09-17）：被拒回合同样落链路摘要（消除语料 unmatched）
                    _emit_digest("authority_denied", 0.0)
                    yield {
                        "type": "error",
                        "content": "决策授权失败：所有Proposer均未产生候选动作，拒绝执行。",
                        "metadata": {
                            "finish_reason": "authority_denied",
                            "goal_id": goal_id,
                            "snapshot_id": snapshot_id,
                        },
                    }
                    return
                except Exception as _dec_exc:
                    log.error(
                        "D4 Authority(stream): DecisionAuthority.decideWithProposers() failed — NO ACTION WILL EXECUTE",
                        goalId=goal_id,
                        snapshotId=snapshot_id,
                        error=str(_dec_exc),
                    )
                    yield {
                        "type": "error",
                        "content": "决策授权失败，拒绝执行任何动作。",
                        "metadata": {
                            "finish_reason": "authority_denied",
                            "goal_id": goal_id,
                            "snapshot_id": snapshot_id,
                        },
                    }
                    return
                finally:
                    self._llm_proposer.pending_tool_calls = None
                    if self._recovery_proposer is not None:
                        self._recovery_proposer.pending_tool_calls = None

                decision_id = decision.decisionId
                digest.record_decision(decision, round_idx + 1)
                for cand in decision.acceptedCandidates:
                    payload = cand.action.payload
                    _tc = ToolCall(
                        id=payload.get("id", f"tc_{uuid.uuid4().hex[:6]}"),
                        name=payload.get("name", ""),
                        arguments=payload.get("arguments", "{}"),
                    )
                    _tc.metadata = {
                        "authority_goalId": goal_id,
                        "authority_snapshotId": snapshot_id,
                        "authority_decisionId": decision_id,
                        "authority_candidateId": cand.candidateId,
                        "authority_proposerId": cand.proposerId,
                        "authority_isChosen": cand.candidateId == decision.chosenCandidateId,
                    }
                    round_calls.append(_tc)

                yield {
                    "type": "authority",
                    "content": "",
                    "metadata": {
                        "goal_id": goal_id,
                        "snapshot_id": snapshot_id,
                        "decision_id": decision_id,
                        "chosen_candidate": decision.chosenCandidateId,
                        "candidate_count": len(decision.candidateIds),
                        "proposer_set": sorted(decision.proposerSet),
                        "proposer_count": decision.proposerCount,
                        "competition_degraded": decision.competitionDegraded,
                        "selection_reason": decision.selectionReason,
                        "round": round_idx + 1,
                    },
                }
            elif self._use_authority:
                # fail-closed: Authority 开启但 goal/snapshot 缺失 → 拒绝执行而非降级。
                log.error(
                    "D4 Authority(stream) FAIL-CLOSED: use_authority=True but goal_id/snapshot_id missing — refusing to execute",
                    goalId=goal_id,
                    snapshotId=snapshot_id,
                    toolCallCount=len(tool_calls_raw),
                )
                # P0 修复（2026-09-17）：fail-closed 回合同样要落链路摘要。
                # 此前该 return 路径不落盘 → 被拒回合在语料中**无痕迹**，
                # 收敛流水线会把它判为 unmatched，diff 不可信（真实发生）。
                _emit_digest("authority_fail_closed", 0.0)
                yield {
                    "type": "error",
                    "content": "安全拒绝：授权信息缺失，无法验证操作安全性。",
                    "metadata": {
                        "finish_reason": "authority_fail_closed",
                        "goal_id": goal_id,
                        "snapshot_id": snapshot_id,
                    },
                }
                return
            else:
                # Authority 显式关闭时的旧行为（use_authority=False，零回归路径）。
                for tc_raw in tool_calls_raw:
                    fn = tc_raw.get("function", {})
                    round_calls.append(ToolCall(
                        id=tc_raw.get("id", f"tc_{uuid.uuid4().hex[:6]}"),
                        name=fn.get("name", ""),
                        arguments=fn.get("arguments", "{}"),
                    ))

            for tc in round_calls:

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

                # ── D4 Authority: Evidence 写回（动作→证据闭环）──
                # 与 run() 同构，但粒度更细：run() 在整轮结束后批量写回，
                # 流式路径在每次动作后立即写回 —— 即便后续提前 return，
                # 已执行动作的证据也不会丢失。
                stream_tool_results.append(tool_result)
                # ML5(stream) fix: decision 级 progress 去重集合（实例级，每个
                # decisionId 只推进一次 —— 每轮 decisionId 唯一，天然按轮去重，
                # 并行多个 chosen 工具不再虚增进度）。
                if not hasattr(self, "_stream_progressed_decisions"):
                    self._stream_progressed_decisions = set()
                # 预测误差的归一化标记在两条分支上都要有，供链路摘要记录
                _exp_effect, _act_effect = action_outcome_tokens(tool_result)
                _auth_meta = getattr(tc, "metadata", None) or {}
                _pe_type, _pe_mag = "", None
                if self._use_authority and goal_id and decision_id:
                    try:
                        _stream_decision_key = (
                            _auth_meta.get("authority_decisionId", "") or decision_id
                        )
                        if (
                            _auth_meta.get("authority_isChosen", False)
                            and _stream_decision_key not in self._stream_progressed_decisions
                        ):
                            _goal_now = self._goal_authority.getGoal(goal_id)
                            _hist = self._decision_authority.getDecisionHistory(goal_id)
                            _predicted = (
                                getattr(_hist[-1].chosen, "estimatedGoalProgress", None)
                                if _hist else None
                            )
                            if _goal_now is not None and _predicted is not None:
                                progress_delta = max(
                                    0.0, min(0.5, _predicted - _goal_now.progress)
                                )
                            else:
                                progress_delta = 0.0
                        else:
                            progress_delta = 0.0
                        if not tool_result.success:
                            progress_delta = -0.05
                        elif (
                            _auth_meta.get("authority_isChosen", False)
                            and progress_delta > 0
                        ):
                            # 只有"验证成功 + 实际推进"才登记去重键
                            self._stream_progressed_decisions.add(_stream_decision_key)
                        self._goal_authority.updateFromEvidence(
                            goalId=goal_id,
                            decisionId=decision_id,
                            actionName=tc.name,
                            actionParams={"tool_call_id": tc.id},
                            observation=(
                                tool_result.output[:500] if tool_result.output else None
                            ),
                            expectedEffect=_exp_effect,
                            actualEffect=_act_effect,
                            progressDelta=progress_delta,
                        )
                        # 取回本次证据产生的预测误差（仅用于链路摘要，不参与决策）
                        try:
                            from agent.core.learning_authority import LearningAuthority

                            _pes = LearningAuthority.getInstance().get_prediction_errors()
                            if _pes and _pes[-1].decisionId == decision_id:
                                _pe_type = _pes[-1].errorType
                                _pe_mag = _pes[-1].errorMagnitude
                        except Exception as _pe_exc:
                            log.debug("digest: prediction error lookup failed", error=str(_pe_exc))
                    except Exception as _ev_exc:
                        log.warning(
                            "D4 Authority(stream) evidence write-back failed",
                            error=str(_ev_exc),
                            tool=tc.name,
                        )

                digest.record_action(
                    tool_name=tc.name,
                    success=tool_result.success,
                    error=tool_result.error,
                    output=tool_result.output,
                    is_chosen=bool(_auth_meta.get("authority_isChosen", False)),
                    expected_effect=_exp_effect,
                    actual_effect=_act_effect,
                    error_type=_pe_type,
                    error_magnitude=_pe_mag,
                    duration_ms=tool_duration,
                )

                if tool_result.success:
                    tool_success_count += 1
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1
                    if consecutive_failures >= max_consecutive_failures:
                        _qs = tool_success_count / max(tool_call_count, 1) if tool_call_count > 0 else 0.0
                        _dur_ms = int((_t.time() - start_time) * 1000)
                        await _close_authority()
                        _emit_digest("failure_exhausted", round(_qs * 0.5, 4))
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
                            input_text=user_input,
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
        await _close_authority()
        _emit_digest("max_rounds", round(_qs, 4))
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
