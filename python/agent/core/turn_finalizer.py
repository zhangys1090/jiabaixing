"""回合终态处理器。

在 LLM 回合结束时进行终态处理：
  - 工具调用结果汇总
  - 回合输出格式化
  - 思考链/推理步骤提取
  - 最终响应组装
  - 回合元数据收集
  - 后置 Hook 执行

与 conversation_loop 的关系：
  - conversation_loop 管理回合流转
  - TurnFinalizer 处理回合结束时的收尾工作
  - 确保每次回合输出完整、格式统一

集成示例::

    from agent.core.turn_finalizer import TurnFinalizer

    finalizer = TurnFinalizer()
    result = await finalizer.finalize(
        turn_output="这是回答",
        tool_results=[{"name": "search", "result": "..."}],
        metadata={"model": "gpt-4o", "tokens": 150},
    )
    print(result.final_response)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine

from agent.core.logger import StructuredLogger

log = StructuredLogger("turn_finalizer")


class TurnStatus(str, Enum):
    """回合状态。"""

    COMPLETED = "completed"
    PARTIAL = "partial"
    ERROR = "error"
    INTERRUPTED = "interrupted"
    TOOL_ONLY = "tool_only"


@dataclass
class ToolResult:
    """工具调用结果。

    Attributes:
        name: 工具名称。
        result: 返回值。
        success: 是否成功。
        duration: 执行耗时（秒）。
        error: 错误信息。
    """

    name: str = ""
    result: Any = None
    success: bool = True
    duration: float = 0.0
    error: str = ""


@dataclass
class TurnMetadata:
    """回合元数据。

    Attributes:
        model: 使用的模型。
        input_tokens: 输入 token 数。
        output_tokens: 输出 token 数。
        total_tokens: 总 token 数。
        latency: 回合延迟（秒）。
        tool_count: 工具调用次数。
        cache_hit: 是否命中缓存。
    """

    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    latency: float = 0.0
    tool_count: int = 0
    cache_hit: bool = False


@dataclass
class FinalizedTurn:
    """终态处理后的回合结果。

    Attributes:
        final_response: 最终响应文本。
        status: 回合状态。
        tool_summary: 工具调用摘要。
        thinking_chain: 思考链提取。
        metadata: 回合元数据。
        warnings: 警告列表。
        finalized_at: 终态处理时间。
    """

    final_response: str = ""
    status: TurnStatus = TurnStatus.COMPLETED
    tool_summary: str = ""
    thinking_chain: list[str] = field(default_factory=list)
    metadata: TurnMetadata = field(default_factory=TurnMetadata)
    warnings: list[str] = field(default_factory=list)
    finalized_at: float = 0.0

    def __post_init__(self) -> None:
        if self.finalized_at == 0.0:
            self.finalized_at = time.time()


class TurnFinalizer:
    """回合终态处理器。

    在 LLM 回合结束时进行终态处理，确保输出完整、格式统一。
    """

    def __init__(self) -> None:
        self._post_hooks: list[Callable[..., Coroutine[Any, Any, None]]] = []
        self._finalize_count: int = 0

    def add_post_hook(
        self, hook: Callable[..., Coroutine[Any, Any, None]]
    ) -> None:
        """添加后置 Hook。

        Args:
            hook: 异步回调，接收 FinalizedTurn 参数。
        """
        self._post_hooks.append(hook)

    async def finalize(
        self,
        turn_output: str = "",
        tool_results: list[dict[str, Any]] | None = None,
        thinking_chain: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        status: TurnStatus = TurnStatus.COMPLETED,
        warnings: list[str] | None = None,
    ) -> FinalizedTurn:
        """执行回合终态处理。

        Args:
            turn_output: 回合输出文本。
            tool_results: 工具调用结果列表。
            thinking_chain: 思考链。
            metadata: 元数据字典。
            status: 回合状态。
            warnings: 警告列表。

        Returns:
            FinalizedTurn 终态处理结果。
        """
        self._finalize_count += 1

        parsed_tools = self._parse_tool_results(tool_results or [])
        tool_summary = self._build_tool_summary(parsed_tools)
        turn_meta = self._build_metadata(metadata or {})

        final_response = self._assemble_response(
            turn_output=turn_output,
            tool_summary=tool_summary,
            parsed_tools=parsed_tools,
        )

        detected_status = self._detect_status(
            status=status,
            turn_output=turn_output,
            tool_results=parsed_tools,
        )

        result = FinalizedTurn(
            final_response=final_response,
            status=detected_status,
            tool_summary=tool_summary,
            thinking_chain=thinking_chain or [],
            metadata=turn_meta,
            warnings=warnings or [],
        )

        await self._run_post_hooks(result)

        log.info(
            "Turn finalized",
            status=detected_status.value,
            tools=len(parsed_tools),
            tokens=turn_meta.total_tokens,
        )

        return result

    def _parse_tool_results(self, results: list[dict[str, Any]]) -> list[ToolResult]:
        """解析工具调用结果。"""
        parsed: list[ToolResult] = []
        for r in results:
            parsed.append(ToolResult(
                name=r.get("name", ""),
                result=r.get("result"),
                success=r.get("success", True),
                duration=r.get("duration", 0.0),
                error=r.get("error", ""),
            ))
        return parsed

    def _build_tool_summary(self, tools: list[ToolResult]) -> str:
        """构建工具调用摘要。"""
        if not tools:
            return ""

        success_count = sum(1 for t in tools if t.success)
        fail_count = len(tools) - success_count

        parts = [f"调用了 {len(tools)} 个工具"]
        if fail_count > 0:
            parts.append(f"（{fail_count} 个失败）")

        tool_names = [t.name for t in tools if t.success]
        if tool_names:
            parts.append(f": {', '.join(tool_names)}")

        return "".join(parts)

    def _build_metadata(self, meta: dict[str, Any]) -> TurnMetadata:
        """构建回合元数据。"""
        return TurnMetadata(
            model=meta.get("model", ""),
            input_tokens=meta.get("input_tokens", 0),
            output_tokens=meta.get("output_tokens", 0),
            total_tokens=meta.get("total_tokens", meta.get("input_tokens", 0) + meta.get("output_tokens", 0)),
            latency=meta.get("latency", 0.0),
            tool_count=meta.get("tool_count", 0),
            cache_hit=meta.get("cache_hit", False),
        )

    def _assemble_response(
        self,
        turn_output: str,
        tool_summary: str,
        parsed_tools: list[ToolResult],
    ) -> str:
        """组装最终响应。"""
        if not turn_output and not parsed_tools:
            return ""

        if not turn_output and parsed_tools:
            return tool_summary

        return turn_output

    def _detect_status(
        self,
        status: TurnStatus,
        turn_output: str,
        tool_results: list[ToolResult],
    ) -> TurnStatus:
        """检测回合状态。"""
        if status != TurnStatus.COMPLETED:
            return status

        if any(not t.success for t in tool_results):
            return TurnStatus.PARTIAL

        if not turn_output and tool_results:
            return TurnStatus.TOOL_ONLY

        return TurnStatus.COMPLETED

    async def _run_post_hooks(self, result: FinalizedTurn) -> None:
        """执行后置 Hook。"""
        for hook in self._post_hooks:
            try:
                await hook(result)
            except Exception as e:
                log.warning("Post hook failed", error=str(e))
