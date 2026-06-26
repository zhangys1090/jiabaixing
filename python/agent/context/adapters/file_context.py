from __future__ import annotations

from agent.context.base import ContextComponent
from agent.context.models import (
    BuildContext,
    ComponentDependency,
    ComponentPriority,
    ContextBuildRequest,
)


class FileContextComponent(ContextComponent):
    """文件上下文组件

    负责加载和处理项目上下文文件。
    """

    def __init__(self, file_registry=None) -> None:
        super().__init__()
        self._file_registry = file_registry

    @property
    def name(self) -> str:
        return "file_context"

    @property
    def priority(self) -> int:
        return ComponentPriority.FILE_CONTEXT

    @property
    def dependencies(self) -> list[ComponentDependency]:
        return [
            ComponentDependency(component_name="memory_retrieval", required=False),
        ]

    def can_handle(self, request: ContextBuildRequest) -> bool:
        return request.use_file_context

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict:
        """执行文件上下文加载

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            dict: 输出数据
        """
        context_files = []
        context_content = ""

        # 如果有 ContextFileRegistry，使用它
        if self._file_registry is not None:
            try:
                entries = self._file_registry.load_all()

                # 过滤指定的文件
                if request.context_files:
                    entries = [
                        e
                        for e in entries
                        if e.file_name in request.context_files
                        or any(
                            e.file_name.endswith(f) for f in request.context_files
                        )
                    ]

                context_files = [e.file_name for e in entries]

                # 构建上下文内容
                if entries:
                    context_parts = []
                    for entry in entries:
                        context_parts.append(
                            f"--- {entry.file_name} ---\n{entry.content}"
                        )
                    context_content = "\n\n".join(context_parts)
            except Exception:
                # 文件上下文加载失败，降级为空
                context_files = []
                context_content = ""

        # 如果有文件上下文，添加到系统消息
        if context_content:
            file_context_content = f"# 项目上下文文件\n{context_content}"

            # 添加到第一个 system 消息
            for i, msg in enumerate(context.messages):
                if msg.get("role") == "system":
                    context.messages[i] = {
                        "role": "system",
                        "content": msg["content"] + "\n\n" + file_context_content,
                    }
                    break

        return {
            "context_files": context_files,
            "file_count": len(context_files),
            "context_content": context_content,
        }
