from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)
log = StructuredLogger("delegate_tool")

if TYPE_CHECKING:  # 仅供类型注解使用
    from agent.tools.registry import ToolRegistry


# ─── 审计 P2-6：子 Agent 工具下放白名单（双轨：元数据派生 + 显式拒绝集）───
# 设计原则（详见 docs/P2-6_SUBAGENT_SANDBOX_DESIGN.md）：
#   - 默认安全集 = 注册表「risk_level == "low"」且不在 SUBAGENT_DENY_TOOLS 的工具。
#     新增的低危只读工具自动获得下放，改名/删除也不会静默失效（元数据派生）。
#   - SUBAGENT_DENY_TOOLS 是权威安全层：即便 risk_level == "low"，以下「低风险但
#     有状态/外部副作用」的工具也禁止下放（纯 risk 规则会漏掉它们，故必须显式拒绝）。
#   - delegate_task 永远不可经白名单加回（防递归委派绕过 MAX_SPAWN_DEPTH 深度守卫）。
#   - 手写基线 SUBAGENT_SAFE_TOOLS 仅作无注册表时的回退，与元数据派生结果保持一致。

# 显式拒绝集（即便 risk_level == "low" 也禁止下放）：写操作 / 外部副作用 / 递归委派。
# 注：项目内大量高危工具被误标为 low（message_push / memory_store / image_generate /
#     skill_create / kanban_* / ha_* / test_gen_* / browser_* / file_dedup / sanbao_* /
#     note_take / task_* 等），故拒绝集是绝对必需的安全层，不能依赖 risk 标注。
SUBAGENT_DENY_TOOLS: frozenset[str] = frozenset({
    # 记忆写入
    "memory_store",
    # 外部副作用 / 内容生成（外部成本或副作用）
    "message_push", "image_generate", "skill_create", "skill_share",
    # 看板（状态写）
    "kanban_get_board", "kanban_add_task", "kanban_move_task",
    # 笔记 / 提醒 / 日程（外部有状态）
    "note_take", "reminder_set", "natural_schedule",
    # 任务管理（状态写）
    "task_manage", "task_priority", "task_dependency", "batch_task", "todo",
    # 智能家居控制
    "ha_scene", "ha_sensor",
    # 上下文 / 交互 / 审批（外部或阻塞式）
    "context_manage", "ask_clarification", "clarify", "write_approval",
    "voice_interact", "voice_mode",
    # 测试生成 / 执行（写文件或跑测试，含被误标 low 的项）
    "test_generate", "test_gen_analyze", "test_gen_coverage",
    "test_gen_execute", "test_run", "code_generate_ast",
    # 浏览器驱动（即便标 low，属副作用）
    "browser_get_text", "browser_navigate", "browser_screenshot",
    # 文件变更
    "file_dedup",
    # 图表生成（外部成本）
    "chart_generate",
    # 三保（训练/诊断/反馈系统，非常规只读）
    "sanbao_ask", "sanbao_diagnose", "sanbao_feedback", "sanbao_predict", "sanbao_status",
})

# 手写基线：低风险且非拒绝集工具（无注册表时的回退；与元数据派生结果保持一致）。
# 注意：code_generate_ast / test_run 已移出（写文件 / 跑测试，属 medium 越界）。
SUBAGENT_SAFE_TOOLS: frozenset[str] = frozenset({
    "action_verify", "calendar", "code_analyze", "code_review", "coverage_read",
    "cronjob_list", "csv_analyze", "docx_parse", "emotion_detect", "file_grep",
    "file_list", "file_read", "file_search", "get_active_file", "git_diff",
    "git_log", "git_status", "knowledge_query", "log_view", "lsp_completion",
    "lsp_definition", "lsp_diagnostics", "lsp_hover", "lsp_references",
    "lsp_symbols", "memory_recall", "memory_search", "morning_brief",
    "ocr_extract", "pdf_parse", "preview_execution", "scene_analyze",
    "screen_parse", "self_reflect", "session_search", "smart_wait",
    "speech_transcribe", "system_status", "task_analytics", "uia_get_text",
    "vision_understand", "web_fetch", "web_search", "xlsx_parse",
})

# unsafe 能力开关：仅当算子级环境变量启用时，unsafe=True 才允许白名单突破默认子集。
# 否则 unsafe 被忽略（回退子集强制），避免任意调用方绕过沙箱。
SUBAGENT_UNSAFE_ENV = "AGENT_SUBAGENT_UNSAFE"


def _unsafe_capability_enabled() -> bool:
    """unsafe 突破是否被授予（算子级能力开关，非自由参数）。"""
    return os.environ.get(SUBAGENT_UNSAFE_ENV, "") in ("1", "true", "True", "yes")


def derive_default_safe_tools(registry: Any) -> frozenset[str]:
    """从注册表元数据派生子 Agent 默认安全白名单。

    规则：risk_level == "low" 且 name 不在 SUBAGENT_DENY_TOOLS 且非 delegate_task。
    无注册表时回退到手写基线 SUBAGENT_SAFE_TOOLS。
    """
    if registry is None or not hasattr(registry, "get_entries"):
        return SUBAGENT_SAFE_TOOLS
    safe: set[str] = set()
    for name, definition, _ in registry.get_entries():
        if name == "delegate_task" or name in SUBAGENT_DENY_TOOLS:
            continue
        if getattr(definition, "risk_level", "low") == "low":
            safe.add(name)
    return frozenset(safe)


def resolve_allowed_tools(
    override: set[str] | None,
    unsafe: bool,
    default_safe: frozenset[str],
) -> set[str]:
    """解析子 Agent 最终白名单（子集校验 + unsafe 能力门控）。

    - override 为 None → 用默认安全集。
    - delegate_task 永远不可经覆盖加回（防递归委派绕过深度守卫）。
    - unsafe=True 且仅当算子能力开关启用时，才允许突破默认子集；
      否则 override 必须是默认安全集的子集，越界工具被剔除并告警（fail-safe 可见）。
    """
    if not override:
        return set(default_safe)
    allowed = set(override)
    if "delegate_task" in allowed:
        log.warning("子Agent白名单含 delegate_task，已强制移除（防递归绕过深度守卫）")
        allowed.discard("delegate_task")
    if unsafe and _unsafe_capability_enabled():
        log.warning("子Agent以 unsafe 模式运行：白名单突破默认安全子集", tools=sorted(allowed))
        return allowed
    extra = allowed - default_safe
    if extra:
        log.warning("子Agent白名单含未授权工具，已剔除", extra=sorted(extra))
        allowed -= extra
    return allowed

SUBAGENT_SYSTEM_PROMPT = (
    "你是一个专注的子 Agent，被委派执行一个明确的子任务。\n"
    "你可以使用一组工具来完成任务。请遵循以下规则：\n"
    "1. 先用工具收集必要信息，再给出最终答案；不要臆测文件内容或外部事实。\n"
    "2. 一次回复中可以调用一个或多个工具；工具结果会以消息形式回传给你。\n"
    "3. 当你已获得足够信息、能够直接回答委派任务时，停止调用工具，只输出最终答案。\n"
    "4. 最终答案应简洁、只针对委派的任务，不要包含多余解释或元评论。\n"
    "5. 你只能在被提供的工具范围内行动，禁止尝试调用未提供的工具。\n"
)

# 单轮 ReAct 内子 Agent 的最大 LLM 轮数（防止无限循环）。
DEFAULT_SUBAGENT_MAX_ITERATIONS = 5
# 单轮 ReAct 内子 Agent 的最大工具调用次数（第五道墙：防单轮多工具失控爆量）。
DEFAULT_SUBAGENT_MAX_STEPS = 12
# 单工具调用超时（秒）：超出即降级为失败结果，而非挂死等待。
DEFAULT_PER_TOOL_TIMEOUT = 30
# 单工具输出回灌上下文前的最大字符数：超出截断，防止上下文爆量 / 成本失控。
DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8000


class DelegateStatus(str, Enum):
    """子 Agent 任务状态枚举。

    追踪委派任务的完整生命周期。

    Attributes:
        PENDING: 等待执行。
        RUNNING: 正在执行。
        COMPLETED: 执行成功完成。
        FAILED: 执行失败。
        CANCELLED: 已被取消。
    """

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DelegateRole(str, Enum):
    """审计 P0-3：委派角色区分。

    leaf: 叶子节点，不可再委派任务给其他 Agent。
    orchestrator: 编排节点，可继续委派任务（受 max_spawn_depth 限制）。
    """

    LEAF = "leaf"
    ORCHESTRATOR = "orchestrator"


@dataclass
class DelegateResult:
    """子 Agent 委派结果。

    Attributes:
        task_id: 任务唯一标识。
        status: 当前任务状态。
        result_text: 任务执行结果文本。
        duration_ms: 执行耗时（毫秒）。
        sub_agent_id: 子 Agent 唯一标识。
        tool_calls_made: 子 Agent 在 ReAct 循环中实际执行的工具次数。
        rounds_used: 子 Agent 消耗的 LLM 轮数。
    """

    task_id: str = ""
    status: DelegateStatus = DelegateStatus.PENDING
    result_text: str = ""
    duration_ms: float = 0.0
    sub_agent_id: str = ""
    tool_calls_made: int = 0
    rounds_used: int = 0


class SubAgentDelegator:
    """子 Agent 任务委派管理器。

    管理子 Agent 的任务委派、状态查询、取消和活跃任务列表。
    支持延迟注入 LLM Provider，无 LLM 时返回友好提示。
    支持委派角色区分（leaf/orchestrator），防委派树膨胀。

    Usage:
        delegator = SubAgentDelegator()
        delegator.set_llm(my_llm)
        result = await delegator.delegate("分析这段代码", context="...")
    """

    # ─── 审计 P0-3：委派角色 + 最大深度 ───
    MAX_SPAWN_DEPTH: int = 3

    def __init__(self, role: DelegateRole = DelegateRole.ORCHESTRATOR, spawn_depth: int = 0) -> None:
        self._llm: Any = None
        self._registry: Any = None
        self._tasks: dict[str, DelegateResult] = {}
        self._running_tasks: dict[str, asyncio.Task[None]] = {}
        self._role = role
        self._spawn_depth = spawn_depth

    @property
    def role(self) -> DelegateRole:
        return self._role

    @property
    def spawn_depth(self) -> int:
        return self._spawn_depth

    @property
    def can_delegate(self) -> bool:
        """leaf 角色不可再委派。"""
        return self._role == DelegateRole.ORCHESTRATOR and self._spawn_depth < self.MAX_SPAWN_DEPTH

    def set_llm(self, llm: Any) -> None:
        """设置 LLM Provider（延迟注入）。

        Args:
            llm: LLM Provider 实例，需实现 chat(messages, use_cache) 方法。
        """
        self._llm = llm

    def set_registry(self, registry: Any) -> None:
        """设置父工具注册表（延迟注入），用于构建子 Agent 白名单子注册表。

        Args:
            registry: ToolRegistry 实例，提供全量工具。
        """
        self._registry = registry

    async def delegate(
        self,
        task_description: str,
        context: str = "",
        timeout: int = 120,
        max_iterations: int | None = None,
        allowed_tools: set[str] | None = None,
        *,
        unsafe: bool = False,
        per_tool_timeout: int = DEFAULT_PER_TOOL_TIMEOUT,
        max_tool_output_chars: int = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
        max_steps: int = DEFAULT_SUBAGENT_MAX_STEPS,
    ) -> DelegateResult:
        """委派任务给子 Agent 执行（审计 P2-6：子 Agent 工具下放 + 独立 ReAct 循环）。

        当已注入 LLM 与父工具注册表时，子 Agent 会运行一个精简 ReAct 循环：
        基于白名单构建子注册表 → 调 LLM（带工具 schema）→ 解析 tool_calls →
        在子注册表内执行工具（天然拒绝非白名单工具）→ 回灌结果 → 重复直到
        产出最终答案或无工具调用。若未注入注册表，则回退为单次裸 LLM 调用
        （原行为，零回归）。

        Args:
            task_description: 要委派给子 Agent 的任务描述。
            context: 任务上下文信息，默认为空。
            timeout: 单轮 LLM 调用的超时秒数，默认 120。
            max_iterations: 子 Agent 最大 LLM 轮数；None 时用
                ``DEFAULT_SUBAGENT_MAX_ITERATIONS``。
            allowed_tools: 显式工具白名单覆盖；None 时用 ``SUBAGENT_SAFE_TOOLS``。

        Returns:
            DelegateResult: 包含任务 ID、状态、结果文本、工具调用统计等信息。
        """
        task_id = uuid.uuid4().hex[:12]
        sub_agent_id = f"sub_{uuid.uuid4().hex[:8]}"

        if not self.can_delegate:
            return DelegateResult(
                task_id=task_id,
                status=DelegateStatus.FAILED,
                result_text=f"委派被拒绝：角色={self._role.value}, 深度={self._spawn_depth}/{self.MAX_SPAWN_DEPTH}",
                sub_agent_id=sub_agent_id,
            )

        result = DelegateResult(
            task_id=task_id,
            status=DelegateStatus.PENDING,
            sub_agent_id=sub_agent_id,
        )
        self._tasks[task_id] = result

        if not self._llm:
            result.status = DelegateStatus.FAILED
            result.result_text = "需要 LLM 才能执行子 Agent 任务"
            return result

        result.status = DelegateStatus.RUNNING
        start = time.monotonic()

        # 审计 P2-6：有注册表 → 走带工具的 ReAct 子循环；否则回退裸 LLM。
        if self._registry is not None:
            try:
                default_safe = derive_default_safe_tools(self._registry)
                resolved = resolve_allowed_tools(
                    allowed_tools, unsafe=unsafe, default_safe=default_safe
                )
                final_text, tool_calls_made, rounds_used = await self._run_react(
                    task_description=task_description,
                    context=context,
                    timeout=timeout,
                    max_iterations=max_iterations or DEFAULT_SUBAGENT_MAX_ITERATIONS,
                    allowed_tools=resolved,
                    per_tool_timeout=per_tool_timeout,
                    max_tool_output_chars=max_tool_output_chars,
                    max_steps=max_steps,
                )
                elapsed = (time.monotonic() - start) * 1000
                result.result_text = final_text
                result.tool_calls_made = tool_calls_made
                result.rounds_used = rounds_used
                result.status = (
                    DelegateStatus.COMPLETED if final_text else DelegateStatus.FAILED
                )
                result.duration_ms = elapsed
            except asyncio.TimeoutError:
                elapsed = (time.monotonic() - start) * 1000
                result.status = DelegateStatus.FAILED
                result.result_text = f"子 Agent 任务超时（{timeout}秒）"
                result.duration_ms = elapsed
            except Exception as exc:
                log.debug("delegate_tool 异常处理", error=str(exc))
                elapsed = (time.monotonic() - start) * 1000
                result.status = DelegateStatus.FAILED
                result.result_text = f"子 Agent 执行失败: {exc}"
                result.duration_ms = elapsed
        else:
            # 裸 LLM 回退（无工具），保持原语义。
            prompt = (
                f"你是一个专注的子 Agent。请完成以下任务，只返回结果，不要额外解释。\n\n"
                f"任务: {task_description}\n"
            )
            if context:
                prompt += f"上下文: {context}\n"
            prompt += "\n请直接给出任务结果:"
            try:
                response = await asyncio.wait_for(
                    self._llm.chat(
                        messages=[{"role": "user", "content": prompt}],
                        use_cache=False,
                    ),
                    timeout=timeout,
                )
                elapsed = (time.monotonic() - start) * 1000
                content = response.get("content", "") if isinstance(response, dict) else str(response)
                result.status = DelegateStatus.COMPLETED
                result.result_text = content
                result.duration_ms = elapsed
            except asyncio.TimeoutError:
                elapsed = (time.monotonic() - start) * 1000
                result.status = DelegateStatus.FAILED
                result.result_text = f"子 Agent 任务超时（{timeout}秒）"
                result.duration_ms = elapsed
            except Exception as exc:
                log.debug("delegate_tool 异常处理", error=str(exc))
                elapsed = (time.monotonic() - start) * 1000
                result.status = DelegateStatus.FAILED
                result.result_text = f"子 Agent 执行失败: {exc}"
                result.duration_ms = elapsed

        return result

    def _build_sub_registry(self, allowed: set[str]) -> "ToolRegistry":
        """基于白名单从父注册表构建子注册表。

        只有 name 命中 ``allowed`` 且确实已注册的工具才会被下放，
        其余工具（含高危工具）对子 Agent 完全不可见。
        """
        from agent.tools.registry import ToolRegistry

        sub = ToolRegistry()
        if self._registry is None or not hasattr(self._registry, "get_entries"):
            return sub
        for name, definition, executor in self._registry.get_entries():
            if name in allowed:
                sub.register(definition, executor)
        return sub

    async def _run_react(
        self,
        task_description: str,
        context: str,
        timeout: int,
        max_iterations: int,
        allowed_tools: set[str],
        per_tool_timeout: int = DEFAULT_PER_TOOL_TIMEOUT,
        max_tool_output_chars: int = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
        max_steps: int = DEFAULT_SUBAGENT_MAX_STEPS,
    ) -> tuple[str, int, int]:
        """子 Agent 精简 ReAct 循环。

        Returns:
            (final_text, tool_calls_made, rounds_used)。
        """
        from agent.tools.registry import ToolRegistry

        sub: ToolRegistry = self._build_sub_registry(allowed_tools)
        if sub.size() == 0:
            # 白名单与已注册工具无交集 → 退化为裸 LLM 回答（无可用工具）。
            log.warning("子 Agent 白名单无可用工具，回退裸 LLM")
            response = await asyncio.wait_for(
                self._llm.chat(
                    messages=[{
                        "role": "user",
                        "content": f"任务: {task_description}\n"
                        + (f"上下文: {context}\n" if context else "")
                        + "\n请直接给出任务结果:",
                    }],
                    use_cache=False,
                ),
                timeout=timeout,
            )
            content = response.get("content", "") if isinstance(response, dict) else str(response)
            return (content or "", 0, 1)

        schema = sub.to_openai_tools()
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SUBAGENT_SYSTEM_PROMPT},
            {"role": "user", "content": self._build_user_prompt(task_description, context)},
        ]

        final_text = ""
        tool_calls_made = 0
        rounds_used = 0

        for _ in range(max(1, max_iterations)):
            # 第五道墙：单轮总工具调用次数上限，防单轮多工具失控爆量。
            if max_steps and tool_calls_made >= max_steps:
                final_text = "(子 Agent 达到最大工具调用次数上限，提前终止)"
                log.warning("子Agent达到最大工具调用次数，提前终止", max_steps=max_steps)
                break
            rounds_used += 1
            response = await asyncio.wait_for(
                self._llm.chat(messages=messages, tools=schema, use_cache=False),
                timeout=timeout,
            )
            content = response.get("content", "") or "" if isinstance(response, dict) else str(response)
            tool_calls = response.get("tool_calls") if isinstance(response, dict) else None

            if not tool_calls:
                final_text = content
                break

            # 记录 assistant 消息（含 tool_calls），维持 OpenAI 工具调用配对。
            assistant_msg: dict[str, Any] = {"role": "assistant", "content": content}
            assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)

            for tc in tool_calls:
                # 第五道墙（单轮内）：已达步数上限则停止执行更多工具。
                if max_steps and tool_calls_made >= max_steps:
                    break
                fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                name = fn.get("name", "")
                raw_args = fn.get("arguments", "{}")
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                except (ValueError, TypeError):
                    args = {}
                tool_id = tc.get("id") or f"tc_{uuid.uuid4().hex[:6]}"
                # 仅子注册表内的白名单工具可被执行；非白名单返回 not found → 安全。
                # 单工具超时边界：超出 per_tool_timeout 降级为失败结果，而非挂死。
                try:
                    tool_result = await asyncio.wait_for(
                        sub.execute(name, args), timeout=per_tool_timeout
                    )
                except asyncio.TimeoutError:
                    tool_result = ToolResult(
                        success=False,
                        error=f"工具 '{name}' 执行超时（>{per_tool_timeout}s）",
                    )
                tool_calls_made += 1
                # 输出体积边界：超限截断后回灌，防上下文爆量 / 成本失控。
                raw = tool_result.output or (tool_result.error or "")
                if raw and len(raw) > max_tool_output_chars:
                    raw = (
                        raw[:max_tool_output_chars]
                        + f"\n...[output truncated at {max_tool_output_chars} chars]"
                    )
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "content": raw,
                })

            # 第五道墙：单轮处理完工具后若已达步数上限，提前结束循环。
            if max_steps and tool_calls_made >= max_steps:
                final_text = "(子 Agent 达到最大工具调用次数上限，提前终止)"
                log.warning("子Agent达到最大工具调用次数，提前终止", max_steps=max_steps)
                break

        if not final_text:
            final_text = "(子 Agent 达到最大迭代次数，未产出最终答案)"
        return (final_text, tool_calls_made, rounds_used)

    @staticmethod
    def _build_user_prompt(task_description: str, context: str) -> str:
        """构造子 Agent 的用户提示。"""
        prompt = f"任务: {task_description}\n"
        if context:
            prompt += f"\n上下文:\n{context}\n"
        prompt += "\n请使用可用工具完成任务，并在信息充分时给出最终答案。"
        return prompt

    def get_status(self, task_id: str) -> DelegateResult | None:
        """查询指定任务的状态。

        Args:
            task_id: 任务唯一标识。

        Returns:
            DelegateResult | None: 任务结果，不存在则返回 None。
        """
        return self._tasks.get(task_id)

    def cancel(self, task_id: str) -> bool:
        """取消指定任务。

        如果任务正在运行（有对应的 asyncio.Task），则取消该协程。
        仅对 PENDING 或 RUNNING 状态的任务生效。

        Args:
            task_id: 任务唯一标识。

        Returns:
            bool: 是否成功取消。
        """
        result = self._tasks.get(task_id)
        if not result or result.status not in (
            DelegateStatus.PENDING,
            DelegateStatus.RUNNING,
        ):
            return False

        running_task = self._running_tasks.get(task_id)
        if running_task and not running_task.done():
            running_task.cancel()

        result.status = DelegateStatus.CANCELLED
        result.result_text = "任务已被取消"
        self._running_tasks.pop(task_id, None)
        return True

    def list_active(self) -> list[DelegateResult]:
        """列出所有活跃（PENDING/RUNNING）任务。

        Returns:
            list[DelegateResult]: 活跃任务列表。
        """
        return [
            r for r in self._tasks.values()
            if r.status in (DelegateStatus.PENDING, DelegateStatus.RUNNING)
        ]


# ==================== 工具定义与注册 ====================

DELEGATE_TASK_DEF = ToolDefinition(
    name="delegate_task",
    description="将任务委派给子 Agent 执行，支持独立上下文和超时控制。适用场景：并行处理多个独立任务、将复杂任务拆分给专门执行者。不适用：简单直接可用单个工具完成的任务。",
    short_desc="委派任务给子Agent",
    category=ToolCategory.COGNITION,
    tags=["delegate", "sub-agent", "task", "cognition", "parallel"],
    scenes=["coding", "development", "research", "work"],
    capability_level=3,
    parameters=[
        ToolParameterDef(
            name="task_description", type="string", required=True,
            description="要委派给子 Agent 的任务描述",
        ),
        ToolParameterDef(
            name="context", type="string", required=False,
            description="任务上下文信息",
        ),
        ToolParameterDef(
            name="timeout", type="number", required=False,
            description="超时秒数，默认120",
        ),
        ToolParameterDef(
            name="max_iterations", type="number", required=False,
            description="子 Agent 最大推理轮数，默认5。每轮可调用一次或多次工具，达到上限即停止。",
        ),
        ToolParameterDef(
            name="tools_whitelist", type="string", required=False,
            description="逗号分隔的工具名白名单，覆盖默认安全集。必须是默认安全集的子集（仅允许列出的只读/低风险工具），越界工具会被剔除；留空使用内置安全白名单。",
        ),
        ToolParameterDef(
            name="unsafe", type="boolean", required=False,
            description="是否突破默认安全子集（允许下放更高风险工具）。需算子级能力开关 AGENT_SUBAGENT_UNSAFE 启用才生效，否则被忽略；delegate_task 无论如何都不可经此加回。默认 false。",
        ),
        ToolParameterDef(
            name="per_tool_timeout", type="number", required=False,
            description="单个工具调用超时秒数，默认 30；超出降级为失败结果而非挂死。",
        ),
        ToolParameterDef(
            name="max_tool_output_chars", type="number", required=False,
            description="单个工具输出回灌上下文前的最大字符数，默认 8000；超出截断。",
        ),
        ToolParameterDef(
            name="max_steps", type="number", required=False,
            description="单轮 ReAct 内子 Agent 最大工具调用次数（防失控爆量），默认 12。",
        ),
    ],
    risk_level="medium",
)

_delegator_instance = SubAgentDelegator()


def _get_engine() -> Any:
    """延迟获取全局引擎实例（LLM 与工具注册表的统一来源）。

    Returns:
        AgentEngine 实例或 None（未初始化/导入失败时为 None）。
    """
    try:
        from agent.main import engine
        return engine
    except ImportError:
        return None
    except Exception as exc:
        log.warning("获取引擎实例失败", error=str(exc))
        return None


def _get_llm() -> Any:
    """获取全局 LLM Provider 实例。

    Returns:
        LLM Provider 实例或 None。
    """
    engine = _get_engine()
    if engine and getattr(engine, "llm", None):
        return engine.llm
    return None


def _get_registry() -> Any:
    """获取全局工具注册表实例（用于构建子 Agent 白名单子注册表）。"""
    engine = _get_engine()
    if engine and getattr(engine, "tool_registry", None) is not None:
        return engine.tool_registry
    return None


def _parse_whitelist(raw: Any) -> set[str] | None:
    """解析 tools_whitelist 参数为工具名集合；空/非法返回 None（用默认安全集）。"""
    if not raw:
        return None
    if isinstance(raw, list):
        return {str(x).strip() for x in raw if str(x).strip()}
    if isinstance(raw, str):
        items = [p.strip() for p in raw.split(",") if p.strip()]
        return set(items) if items else None
    return None


async def delegate_task_executor(params: dict[str, Any]) -> ToolResult:
    """delegate_task 工具执行器。

    Args:
        params: 工具参数字典，包含 task_description、context、timeout 等。

    Returns:
        ToolResult: 工具执行结果。
    """
    start = time.time()
    task_description = str(params.get("task_description", ""))
    context = str(params.get("context", ""))
    timeout = int(params.get("timeout", 120))
    max_iterations = int(params.get("max_iterations", 5)) if params.get("max_iterations") else None
    allowed_tools = _parse_whitelist(params.get("tools_whitelist"))
    unsafe = bool(params.get("unsafe", False))
    per_tool_timeout = int(params.get("per_tool_timeout", DEFAULT_PER_TOOL_TIMEOUT)) if params.get("per_tool_timeout") else DEFAULT_PER_TOOL_TIMEOUT
    max_tool_output_chars = int(params.get("max_tool_output_chars", DEFAULT_MAX_TOOL_OUTPUT_CHARS)) if params.get("max_tool_output_chars") else DEFAULT_MAX_TOOL_OUTPUT_CHARS
    max_steps = int(params.get("max_steps", DEFAULT_SUBAGENT_MAX_STEPS)) if params.get("max_steps") else DEFAULT_SUBAGENT_MAX_STEPS

    if not task_description.strip():
        log.warning("委派任务描述为空")
        return ToolResult(
            success=False,
            error="任务描述不能为空",
            duration=time.time() - start,
        )

    # 延迟注入 LLM 与工具注册表
    if not _delegator_instance._llm:
        llm = _get_llm()
        if llm:
            _delegator_instance.set_llm(llm)
    if _delegator_instance._registry is None:
        registry = _get_registry()
        if registry:
            _delegator_instance.set_registry(registry)

    result = await _delegator_instance.delegate(
        task_description=task_description,
        context=context,
        timeout=timeout,
        max_iterations=max_iterations,
        allowed_tools=allowed_tools,
        unsafe=unsafe,
        per_tool_timeout=per_tool_timeout,
        max_tool_output_chars=max_tool_output_chars,
        max_steps=max_steps,
    )

    if result.status == DelegateStatus.COMPLETED:
        log.info("子Agent委派完成", sub_agent_id=result.sub_agent_id, duration_ms=result.duration_ms, tool_calls=result.tool_calls_made)
        output = (
            f"✅ 子 Agent 任务完成\n\n"
            f"📋 任务: {task_description}\n"
            f"🤖 子 Agent: {result.sub_agent_id}\n"
            f"🔧 工具调用: {result.tool_calls_made} 次 / {result.rounds_used} 轮\n"
            f"⏱️ 耗时: {result.duration_ms:.0f}ms\n\n"
            f"📄 结果:\n{result.result_text[:5000]}"
        )
    elif result.status == DelegateStatus.FAILED:
        log.error("子Agent委派失败", sub_agent_id=result.sub_agent_id, error=result.result_text[:200])
        output = (
            f"❌ 子 Agent 任务失败\n\n"
            f"📋 任务: {task_description}\n"
            f"🤖 子 Agent: {result.sub_agent_id}\n"
            f"⏱️ 耗时: {result.duration_ms:.0f}ms\n\n"
            f"原因: {result.result_text}"
        )
    else:
        output = f"任务状态: {result.status.value}"

    return ToolResult(
        success=result.status == DelegateStatus.COMPLETED,
        output=output,
        error=result.result_text if result.status == DelegateStatus.FAILED else None,
        duration=time.time() - start,
        metadata={
            "task_id": result.task_id,
            "status": result.status.value,
            "sub_agent_id": result.sub_agent_id,
            "duration_ms": result.duration_ms,
            "tool_calls_made": result.tool_calls_made,
            "rounds_used": result.rounds_used,
        },
    )


def register_delegate_tool(registry: Any) -> None:
    """注册子 Agent 委派工具到工具注册中心。

    Args:
        registry: ToolRegistry 实例。
    """
    registry.register(DELEGATE_TASK_DEF, delegate_task_executor)
