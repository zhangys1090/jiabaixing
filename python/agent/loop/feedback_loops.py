from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger

log = StructuredLogger("feedback_loops")


@dataclass
class FeedbackLoopResult:
    """闭环反馈结果。

    Attributes:
        loop_name: 闭环名称。
        success: 是否成功。
        message: 结果消息。
        data: 附加数据。
    """

    loop_name: str
    success: bool = True
    message: str = ""
    data: dict[str, Any] = field(default_factory=dict)


class FeedbackLoops:
    """闭环服务——管理进化、工具失败、偏好学习和知识提取四大闭环。

    每个闭环在 AFTER_RESPONSE 阶段触发，与主循环解耦：
    1. 进化闭环：质量评分 → 进化引擎记录交互
    2. 工具失败反馈闭环：工具失败 → 记录失败模式
    3. 偏好学习闭环：用户纠正 → 偏好管理器应用纠正
    4. 自动知识提取：对话 → 记忆引擎自动提取关键信息

    Usage:
        loops = FeedbackLoops(evolution_engine=evo, memory_engine=mem)
        results = await loops.run_all(
            user_input="你好",
            response="你好！",
            quality_score=0.9,
            tool_failures=[],
            user_corrections=[],
        )
    """

    def __init__(
        self,
        evolution_engine: Any = None,
        memory_engine: Any = None,
        preference_manager: Any = None,
    ) -> None:
        self._evolution_engine = evolution_engine
        self._memory_engine = memory_engine
        self._preference_manager = preference_manager
        self._custom_loops: list[Callable[..., Awaitable[FeedbackLoopResult]]] = []

    def add_loop(self, loop_fn: Callable[..., Awaitable[FeedbackLoopResult]]) -> None:
        """注册自定义闭环函数。

        Args:
            loop_fn: 闭环函数，接收关键字参数，返回FeedbackLoopResult。
        """
        self._custom_loops.append(loop_fn)

    async def run_all(
        self,
        user_input: str = "",
        response: str = "",
        quality_score: float = 0.0,
        tool_failures: list[dict[str, Any]] | None = None,
        user_corrections: list[dict[str, Any]] | None = None,
        session_id: str = "",
        **kwargs: Any,
    ) -> list[FeedbackLoopResult]:
        """运行所有闭环。

        Args:
            user_input: 用户输入。
            response: 系统响应。
            quality_score: 质量评分。
            tool_failures: 工具失败列表。
            user_corrections: 用户纠正列表。
            session_id: 会话ID。
            **kwargs: 附加上下文。

        Returns:
            list[FeedbackLoopResult]: 所有闭环的执行结果。
        """
        results: list[FeedbackLoopResult] = []

        results.append(await self._evolution_loop(user_input, response, quality_score, **kwargs))

        if tool_failures:
            results.append(await self._tool_failure_loop(tool_failures, **kwargs))

        if user_corrections:
            results.append(await self._preference_loop(user_corrections, **kwargs))

        results.append(await self._knowledge_extraction_loop(user_input, response, session_id, **kwargs))

        for loop_fn in self._custom_loops:
            try:
                result = await loop_fn(
                    user_input=user_input,
                    response=response,
                    quality_score=quality_score,
                    tool_failures=tool_failures or [],
                    user_corrections=user_corrections or [],
                    session_id=session_id,
                    **kwargs,
                )
                results.append(result)
            except Exception as e:
                log.warning(f"自定义闭环失败: {e}")

        return results

    async def _evolution_loop(
        self, user_input: str, response: str, quality_score: float, **kwargs: Any
    ) -> FeedbackLoopResult:
        try:
            if self._evolution_engine and hasattr(self._evolution_engine, "record_interaction"):
                await self._evolution_engine.record_interaction(
                    user_input=user_input,
                    response=response,
                    quality_score=quality_score,
                    **kwargs,
                )
                return FeedbackLoopResult(
                    loop_name="evolution",
                    success=True,
                    message=f"进化记录已保存（评分: {quality_score}）",
                )
            return FeedbackLoopResult(
                loop_name="evolution",
                success=False,
                message="进化引擎未配置或缺少record_interaction方法",
            )
        except Exception as e:
            log.warning(f"进化闭环失败: {e}")
            return FeedbackLoopResult(loop_name="evolution", success=False, message=str(e))

    async def _tool_failure_loop(
        self, tool_failures: list[dict[str, Any]], **kwargs: Any
    ) -> FeedbackLoopResult:
        try:
            if self._evolution_engine and hasattr(self._evolution_engine, "record_tool_failure"):
                for failure in tool_failures:
                    await self._evolution_engine.record_tool_failure(
                        tool_name=failure.get("tool_name", "unknown"),
                        error=failure.get("error", ""),
                        **kwargs,
                    )
                return FeedbackLoopResult(
                    loop_name="tool_failure",
                    success=True,
                    message=f"记录了 {len(tool_failures)} 个工具失败",
                )
            return FeedbackLoopResult(
                loop_name="tool_failure",
                success=False,
                message="进化引擎未配置或缺少record_tool_failure方法",
            )
        except Exception as e:
            log.warning(f"工具失败反馈闭环失败: {e}")
            return FeedbackLoopResult(loop_name="tool_failure", success=False, message=str(e))

    async def _preference_loop(
        self, user_corrections: list[dict[str, Any]], **kwargs: Any
    ) -> FeedbackLoopResult:
        try:
            if self._preference_manager and hasattr(self._preference_manager, "apply_correction"):
                for correction in user_corrections:
                    await self._preference_manager.apply_correction(
                        original=correction.get("original", ""),
                        corrected=correction.get("corrected", ""),
                        **kwargs,
                    )
                return FeedbackLoopResult(
                    loop_name="preference",
                    success=True,
                    message=f"应用了 {len(user_corrections)} 个偏好纠正",
                )
            return FeedbackLoopResult(
                loop_name="preference",
                success=False,
                message="偏好管理器未配置或缺少apply_correction方法",
            )
        except Exception as e:
            log.warning(f"偏好学习闭环失败: {e}")
            return FeedbackLoopResult(loop_name="preference", success=False, message=str(e))

    async def _knowledge_extraction_loop(
        self, user_input: str, response: str, session_id: str, **kwargs: Any
    ) -> FeedbackLoopResult:
        try:
            if self._memory_engine and hasattr(self._memory_engine, "auto_extract_knowledge"):
                count = await self._memory_engine.auto_extract_knowledge(
                    user_input=user_input,
                    response=response,
                    session_id=session_id,
                    **kwargs,
                )
                return FeedbackLoopResult(
                    loop_name="knowledge_extraction",
                    success=True,
                    message=f"自动提取了 {count} 条知识",
                    data={"count": count},
                )
            return FeedbackLoopResult(
                loop_name="knowledge_extraction",
                success=False,
                message="记忆引擎未配置或缺少auto_extract_knowledge方法",
            )
        except Exception as e:
            log.warning(f"知识提取闭环失败: {e}")
            return FeedbackLoopResult(loop_name="knowledge_extraction", success=False, message=str(e))
