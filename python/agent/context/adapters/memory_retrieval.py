from __future__ import annotations

from agent.context.base import ContextComponent
import logging
from agent.context.models import (
    BuildContext,
    ComponentDependency,
    ComponentPriority,
    ContextBuildRequest,
)
logger = logging.getLogger(__name__)


class MemoryRetrievalComponent(ContextComponent):
    """记忆检索组件

    负责从记忆系统中检索相关记忆。
    """

    def __init__(self, memory_engine=None) -> None:
        super().__init__()
        self._memory_engine = memory_engine

    @property
    def name(self) -> str:
        return "memory_retrieval"

    @property
    def priority(self) -> int:
        return ComponentPriority.MEMORY_RETRIEVAL

    @property
    def dependencies(self) -> list[ComponentDependency]:
        return [
            ComponentDependency(component_name="persona", required=False),
        ]

    def can_handle(self, request: ContextBuildRequest) -> bool:
        return request.use_memory

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict:
        """执行记忆检索

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            dict: 输出数据
        """
        memories = []
        memory_results = []

        # 如果有 MemoryEngine，使用它
        if self._memory_engine is not None:
            try:
                mem_results = await self._memory_engine.search_with_context(
                    query=request.user_input,
                    limit=request.memory_limit,
                )
                memory_results = mem_results or []
                memories = [m.get("content", "") for m in memory_results[: request.memory_limit]]
            except Exception as e:
                logger.warning("memory_retrieval.search 记忆检索失败", error=str(e))
                # 记忆检索失败，降级为空
                memories = []
                memory_results = []

        # 如果有记忆，添加到系统消息
        if memories:
            memory_content = "# 相关记忆\n"
            for i, mem in enumerate(memories, 1):
                memory_content += f"{i}. {mem}\n"

            # 添加到第一个 system 消息
            for i, msg in enumerate(context.messages):
                if msg.get("role") == "system":
                    context.messages[i] = {
                        "role": "system",
                        "content": msg["content"] + "\n\n" + memory_content,
                    }
                    break

        return {
            "memories": memories,
            "memory_count": len(memories),
            "memory_results": memory_results,
        }
