from __future__ import annotations

from agent.context.base import ContextComponent
from agent.context.models import (
    BuildContext,
    ComponentDependency,
    ComponentPriority,
    ContextBuildRequest,
)


class TokenBudgetComponent(ContextComponent):
    """Token预算分配组件

    负责分配和管理Token预算。
    """

    def __init__(self, budget_allocator=None) -> None:
        super().__init__()
        self._budget_allocator = budget_allocator

    @property
    def name(self) -> str:
        return "token_budget"

    @property
    def priority(self) -> int:
        return ComponentPriority.TOKEN_BUDGET

    @property
    def dependencies(self) -> list[ComponentDependency]:
        return [
            ComponentDependency(component_name="file_context", required=False),
        ]

    def can_handle(self, request: ContextBuildRequest) -> bool:
        return True

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict:
        """执行Token预算分配

        Args:
            request: 构建请求
            context: 构建上下文

        Returns:
            dict: 输出数据
        """
        max_tokens = request.max_tokens

        # 计算当前已使用的Token
        current_tokens = 0
        for msg in context.messages:
            current_tokens += len(msg.get("content", "")) // 4 + 10

        # 计算剩余预算
        remaining_budget = max_tokens - current_tokens
        if remaining_budget < 0:
            remaining_budget = 0

        # 如果有 TokenBudgetAllocator，使用它
        allocation = None
        if self._budget_allocator is not None:
            try:
                allocation = self._budget_allocator.allocate()
            except Exception:
                allocation = None

        # 默认预算分配
        if allocation is None:
            allocation = {
                "system_prompt": int(max_tokens * 0.3),
                "memory": int(max_tokens * 0.15),
                "history": int(max_tokens * 0.25),
                "dynamic_context": int(max_tokens * 0.15),
                "tool_results": int(max_tokens * 0.15),
                "reserve": int(max_tokens * 0.1),
            }

        # 更新上下文中的Token信息
        context.tokens_used = current_tokens
        context.token_budget = max_tokens

        return {
            "max_tokens": max_tokens,
            "current_tokens": current_tokens,
            "remaining_budget": remaining_budget,
            "allocation": allocation,
            "budget_usage_ratio": current_tokens / max_tokens if max_tokens > 0 else 0,
        }
