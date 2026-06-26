from __future__ import annotations

from agent.context.base import ContextComponent
from agent.context.models import (
    BuildContext,
    ComponentPriority,
    ContextBuildRequest,
)


class SystemPromptComponent(ContextComponent):
    """系统Prompt组件

    负责构建基础的系统Prompt。
    """

    def __init__(self, default_system_prompt: str = "") -> None:
        super().__init__()
        self._default_system_prompt = default_system_prompt

    @property
    def name(self) -> str:
        return "system_prompt"

    @property
    def priority(self) -> int:
        return ComponentPriority.SYSTEM_PROMPT

    def can_handle(self, request: ContextBuildRequest) -> bool:
        return True  # 总是执行

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict:
        """执行系统Prompt构建

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            dict: 输出数据
        """
        system_prompt = request.system_prompt or self._default_system_prompt

        if not system_prompt:
            # 默认系统Prompt
            system_prompt = (
                "你是家百星（Jiabaixing），一个智能AI助手。\n\n"
                "# 核心原则\n"
                "- 你拥有多种工具，必须主动使用工具完成任务\n"
                "- 即使是简单问候，也要先检查是否有相关上下文可以展示\n"
                "- 用简洁、友好的方式回答，展示你的思考过程和工具调用结果"
            )

        # 添加到消息列表
        context.add_message("system", system_prompt)

        return {
            "system_prompt": system_prompt,
            "prompt_length": len(system_prompt),
        }
