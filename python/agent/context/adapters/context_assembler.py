from __future__ import annotations

from agent.context.base import ContextComponent
from agent.context.models import (
    BuildContext,
    ComponentDependency,
    ComponentPriority,
    ContextBuildRequest,
)


class ContextAssemblerComponent(ContextComponent):
    """上下文组装组件

    负责组装最终的上下文消息，包括历史消息和用户输入。
    """

    def __init__(self) -> None:
        super().__init__()

    @property
    def name(self) -> str:
        return "context_assembler"

    @property
    def priority(self) -> int:
        return ComponentPriority.CONTEXT_ASSEMBLER

    @property
    def dependencies(self) -> list[ComponentDependency]:
        return [
            ComponentDependency(component_name="token_budget", required=False),
        ]

    def can_handle(self, request: ContextBuildRequest) -> bool:
        return True

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict:
        """执行上下文组装

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            dict: 输出数据
        """
        # 添加历史消息
        history = request.history or []
        history_count = 0

        if history:
            # 限制历史消息数量
            limited_history = history[-request.history_limit :]
            history_count = len(limited_history)

            # 检查Token预算
            if context.token_budget > 0:
                # 计算历史消息的Token
                history_tokens = 0
                selected_history = []
                for msg in reversed(limited_history):
                    msg_tokens = len(msg.get("content", "")) // 4 + 10
                    if context.tokens_used + history_tokens + msg_tokens > context.token_budget * 0.8:
                        break
                    selected_history.insert(0, msg)
                    history_tokens += msg_tokens
                limited_history = selected_history
                history_count = len(limited_history)

            # 添加历史消息
            for msg in limited_history:
                context.messages.append(
                    {"role": msg.get("role", "user"), "content": msg.get("content", "")}
                )

        # 添加用户输入
        context.add_message("user", request.user_input)

        # 计算总Token
        total_tokens = 0
        for msg in context.messages:
            total_tokens += len(msg.get("content", "")) // 4 + 10

        context.tokens_used = total_tokens

        return {
            "history_count": history_count,
            "total_messages": len(context.messages),
            "total_tokens": total_tokens,
            "has_history": len(history) > 0,
        }
