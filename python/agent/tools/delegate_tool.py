from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)


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


@dataclass
class DelegateResult:
    """子 Agent 委派结果。

    Attributes:
        task_id: 任务唯一标识。
        status: 当前任务状态。
        result_text: 任务执行结果文本。
        duration_ms: 执行耗时（毫秒）。
        sub_agent_id: 子 Agent 唯一标识。
    """

    task_id: str = ""
    status: DelegateStatus = DelegateStatus.PENDING
    result_text: str = ""
    duration_ms: float = 0.0
    sub_agent_id: str = ""


class SubAgentDelegator:
    """子 Agent 任务委派管理器。

    管理子 Agent 的任务委派、状态查询、取消和活跃任务列表。
    支持延迟注入 LLM Provider，无 LLM 时返回友好提示。

    Usage:
        delegator = SubAgentDelegator()
        delegator.set_llm(my_llm)
        result = await delegator.delegate("分析这段代码", context="...")
    """

    def __init__(self) -> None:
        self._llm: Any = None
        self._tasks: dict[str, DelegateResult] = {}
        self._running_tasks: dict[str, asyncio.Task[None]] = {}

    def set_llm(self, llm: Any) -> None:
        """设置 LLM Provider（延迟注入）。

        Args:
            llm: LLM Provider 实例，需实现 chat(messages, use_cache) 方法。
        """
        self._llm = llm

    async def delegate(
        self,
        task_description: str,
        context: str = "",
        timeout: int = 120,
    ) -> DelegateResult:
        """委派任务给子 Agent 执行。

        如果已注入 LLM，使用简化 prompt 调用 LLM 生成子 Agent 响应。
        如果没有 LLM，返回需要 LLM 的提示。

        Args:
            task_description: 要委派给子 Agent 的任务描述。
            context: 任务上下文信息，默认为空。
            timeout: 超时秒数，默认 120。

        Returns:
            DelegateResult: 包含任务 ID、状态、结果文本等信息。
        """
        task_id = uuid.uuid4().hex[:12]
        sub_agent_id = f"sub_{uuid.uuid4().hex[:8]}"

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
            elapsed = (time.monotonic() - start) * 1000
            result.status = DelegateStatus.FAILED
            result.result_text = f"子 Agent 执行失败: {exc}"
            result.duration_ms = elapsed

        return result

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
    ],
    risk_level="medium",
)

_delegator_instance = SubAgentDelegator()


def _get_llm() -> Any:
    """获取全局 LLM Provider 实例。

    Returns:
        LLM Provider 实例或 None。
    """
    try:
        from agent.main import engine
        if engine and hasattr(engine, "llm") and engine.llm:
            return engine.llm
    except Exception:
        pass
    return None


async def delegate_task_executor(params: dict[str, Any]) -> ToolResult:
    """delegate_task 工具执行器。

    Args:
        params: 工具参数字典，包含 task_description、context、timeout。

    Returns:
        ToolResult: 工具执行结果。
    """
    start = time.time()
    task_description = str(params.get("task_description", ""))
    context = str(params.get("context", ""))
    timeout = int(params.get("timeout", 120))

    if not task_description.strip():
        return ToolResult(
            success=False,
            error="任务描述不能为空",
            duration=time.time() - start,
        )

    # 延迟注入 LLM
    if not _delegator_instance._llm:
        llm = _get_llm()
        if llm:
            _delegator_instance.set_llm(llm)

    result = await _delegator_instance.delegate(
        task_description=task_description,
        context=context,
        timeout=timeout,
    )

    if result.status == DelegateStatus.COMPLETED:
        output = (
            f"✅ 子 Agent 任务完成\n\n"
            f"📋 任务: {task_description}\n"
            f"🤖 子 Agent: {result.sub_agent_id}\n"
            f"⏱️ 耗时: {result.duration_ms:.0f}ms\n\n"
            f"📄 结果:\n{result.result_text[:5000]}"
        )
    elif result.status == DelegateStatus.FAILED:
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
        },
    )


def register_delegate_tool(registry: Any) -> None:
    """注册子 Agent 委派工具到工具注册中心。

    Args:
        registry: ToolRegistry 实例。
    """
    registry.register(DELEGATE_TASK_DEF, delegate_task_executor)
