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
            except Exception as e:
                logger.warning("token_budget.allocate 预算分配失败", error=str(e))
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


class DynamicTokenBudgetAllocator:
    """动态 Token 预算分配器。

    根据任务类型、工具数量、对话长度等因素动态调整预算分配，
    替代固定百分比的静态分配策略。

    核心策略:
    - 规划类任务: 增加 system_prompt 预算
    - 工具密集型任务: 增加 tool_results 预算
    - 长对话: 增加 history 预算，压缩 memory 预算
    - 记忆检索: 增加 memory 预算
    """

    _DEFAULT_ALLOCATION = {
        "system_prompt": 0.30,
        "memory": 0.15,
        "history": 0.25,
        "dynamic_context": 0.15,
        "tool_results": 0.15,
    }

    _TASK_TYPE_WEIGHTS = {
        "planning": {"system_prompt": 0.40, "tool_results": 0.05},
        "coding": {"dynamic_context": 0.25, "tool_results": 0.20},
        "analysis": {"system_prompt": 0.35, "memory": 0.20},
        "search": {"tool_results": 0.25, "history": 0.15},
        "conversation": {"history": 0.35, "system_prompt": 0.20},
        "tool_heavy": {"tool_results": 0.30, "system_prompt": 0.20},
    }

    def __init__(
        self,
        max_tokens: int = 128000,
        task_type: str = "general",
        tool_count: int = 0,
        conversation_length: int = 0,
        use_memory_retrieval: bool = False,
    ) -> None:
        self._max_tokens = max_tokens
        self._task_type = task_type
        self._tool_count = tool_count
        self._conversation_length = conversation_length
        self._use_memory_retrieval = use_memory_retrieval

    def allocate(self) -> dict[str, int]:
        """动态分配 Token 预算。

        Returns:
            dict: 各区域的 Token 分配。
        """
        weights = dict(self._DEFAULT_ALLOCATION)

        task_weights = self._TASK_TYPE_WEIGHTS.get(self._task_type, {})
        for key, weight in task_weights.items():
            weights[key] = weight

        remaining = 1.0 - sum(weights.values())
        default_keys = [k for k in self._DEFAULT_ALLOCATION if k not in task_weights]
        if default_keys and remaining > 0:
            default_total = sum(self._DEFAULT_ALLOCATION[k] for k in default_keys)
            for key in default_keys:
                if default_total > 0:
                    weights[key] = remaining * (self._DEFAULT_ALLOCATION[key] / default_total)

        if self._tool_count > 5:
            shift = min(0.10, weights.get("history", 0.25) * 0.3)
            weights["tool_results"] = min(0.35, weights.get("tool_results", 0.15) + shift)
            weights["history"] = max(0.10, weights.get("history", 0.25) - shift)

        if self._conversation_length > 10:
            weights["history"] = min(0.40, weights.get("history", 0.25) + 0.05)
            weights["memory"] = max(0.05, weights.get("memory", 0.15) - 0.05)

        if self._use_memory_retrieval:
            weights["memory"] = min(0.25, weights.get("memory", 0.15) + 0.05)
            weights["dynamic_context"] = max(0.05, weights.get("dynamic_context", 0.15) - 0.05)

        total_weight = sum(weights.values())
        if total_weight > 0:
            weights = {k: v / total_weight for k, v in weights.items()}

        allocation = {}
        for key, ratio in weights.items():
            allocation[key] = int(self._max_tokens * ratio)

        alloc_sum = sum(allocation.values())
        if alloc_sum < self._max_tokens:
            allocation["reserve"] = self._max_tokens - alloc_sum
        else:
            allocation["reserve"] = 0

        return allocation

    def update_task_type(self, task_type: str) -> None:
        self._task_type = task_type

    def update_tool_count(self, count: int) -> None:
        self._tool_count = count

    def update_conversation_length(self, length: int) -> None:
        self._conversation_length = length

    def update_memory_retrieval(self, enabled: bool) -> None:
        self._use_memory_retrieval = enabled
