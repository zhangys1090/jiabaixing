"""测试 DynamicTokenBudgetAllocator 动态 Token 预算分配器。"""

from __future__ import annotations

import pytest

from agent.context.adapters.token_budget import DynamicTokenBudgetAllocator


# ═══════════════════════════════════════════════════════════════════════════
# 基础功能测试
# ═══════════════════════════════════════════════════════════════════════════


def test_default_allocator_creates_valid_allocation():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000)
    allocation = allocator.allocate()

    assert isinstance(allocation, dict)
    assert "system_prompt" in allocation
    assert "memory" in allocation
    assert "tool_results" in allocation
    assert "history" in allocation
    assert "dynamic_context" in allocation
    assert "reserve" in allocation

    total = sum(allocation.values())
    assert total == 128000


def test_allocation_sums_to_max_tokens():
    for max_tokens in [8000, 32000, 128000, 200000]:
        allocator = DynamicTokenBudgetAllocator(max_tokens=max_tokens)
        allocation = allocator.allocate()
        assert sum(allocation.values()) == max_tokens


def test_all_allocations_are_positive():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000)
    allocation = allocator.allocate()
    for key, value in allocation.items():
        if key != "reserve":
            assert value > 0, f"{key} should be positive, got {value}"


# ═══════════════════════════════════════════════════════════════════════════
# 任务类型适配测试
# ═══════════════════════════════════════════════════════════════════════════


def test_planning_task_has_higher_system_prompt():
    general = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="general")
    planning = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="planning")

    general_alloc = general.allocate()
    planning_alloc = planning.allocate()

    assert planning_alloc["system_prompt"] > general_alloc["system_prompt"]
    assert planning_alloc["tool_results"] < general_alloc["tool_results"]


def test_coding_task_has_higher_dynamic_context():
    general = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="general")
    coding = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="coding")

    general_alloc = general.allocate()
    coding_alloc = coding.allocate()

    assert coding_alloc["dynamic_context"] > general_alloc["dynamic_context"]
    assert coding_alloc["tool_results"] > general_alloc["tool_results"]


def test_search_task_has_higher_tool_results():
    general = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="general")
    search = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="search")

    general_alloc = general.allocate()
    search_alloc = search.allocate()

    assert search_alloc["tool_results"] > general_alloc["tool_results"]
    assert search_alloc["history"] < general_alloc["history"]


def test_conversation_task_has_higher_history():
    general = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="general")
    conv = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="conversation")

    general_alloc = general.allocate()
    conv_alloc = conv.allocate()

    assert conv_alloc["history"] > general_alloc["history"]
    assert conv_alloc["system_prompt"] < general_alloc["system_prompt"]


def test_analysis_task_has_higher_memory():
    general = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="general")
    analysis = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="analysis")

    general_alloc = general.allocate()
    analysis_alloc = analysis.allocate()

    assert analysis_alloc["memory"] > general_alloc["memory"]


def test_tool_heavy_task_has_highest_tool_results():
    general = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="general")
    tool_heavy = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="tool_heavy")

    general_alloc = general.allocate()
    tool_heavy_alloc = tool_heavy.allocate()

    assert tool_heavy_alloc["tool_results"] > general_alloc["tool_results"]


def test_unknown_task_type_uses_default():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="nonexistent")
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 128000


# ═══════════════════════════════════════════════════════════════════════════
# 工具数量影响测试
# ═══════════════════════════════════════════════════════════════════════════


def test_many_tools_increases_tool_results():
    few_tools = DynamicTokenBudgetAllocator(max_tokens=128000, tool_count=2)
    many_tools = DynamicTokenBudgetAllocator(max_tokens=128000, tool_count=10)

    few_alloc = few_tools.allocate()
    many_alloc = many_tools.allocate()

    assert many_alloc["tool_results"] > few_alloc["tool_results"]


def test_many_tools_decreases_history():
    few_tools = DynamicTokenBudgetAllocator(max_tokens=128000, tool_count=2)
    many_tools = DynamicTokenBudgetAllocator(max_tokens=128000, tool_count=10)

    few_alloc = few_tools.allocate()
    many_alloc = many_tools.allocate()

    assert many_alloc["history"] < few_alloc["history"]


def test_few_tools_no_effect():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, tool_count=3)
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 128000


# ═══════════════════════════════════════════════════════════════════════════
# 对话长度影响测试
# ═══════════════════════════════════════════════════════════════════════════


def test_long_conversation_increases_history():
    short = DynamicTokenBudgetAllocator(max_tokens=128000, conversation_length=3)
    long = DynamicTokenBudgetAllocator(max_tokens=128000, conversation_length=15)

    short_alloc = short.allocate()
    long_alloc = long.allocate()

    assert long_alloc["history"] > short_alloc["history"]


def test_long_conversation_decreases_memory():
    short = DynamicTokenBudgetAllocator(max_tokens=128000, conversation_length=3)
    long = DynamicTokenBudgetAllocator(max_tokens=128000, conversation_length=15)

    short_alloc = short.allocate()
    long_alloc = long.allocate()

    assert long_alloc["memory"] < short_alloc["memory"]


def test_short_conversation_no_effect():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, conversation_length=5)
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 128000


# ═══════════════════════════════════════════════════════════════════════════
# 记忆检索影响测试
# ═══════════════════════════════════════════════════════════════════════════


def test_memory_retrieval_increases_memory():
    no_memory = DynamicTokenBudgetAllocator(max_tokens=128000, use_memory_retrieval=False)
    with_memory = DynamicTokenBudgetAllocator(max_tokens=128000, use_memory_retrieval=True)

    no_alloc = no_memory.allocate()
    with_alloc = with_memory.allocate()

    assert with_alloc["memory"] > no_alloc["memory"]


def test_memory_retrieval_decreases_context():
    no_memory = DynamicTokenBudgetAllocator(max_tokens=128000, use_memory_retrieval=False)
    with_memory = DynamicTokenBudgetAllocator(max_tokens=128000, use_memory_retrieval=True)

    no_alloc = no_memory.allocate()
    with_alloc = with_memory.allocate()

    assert with_alloc["dynamic_context"] < no_alloc["dynamic_context"]


# ═══════════════════════════════════════════════════════════════════════════
# 组合场景测试
# ═══════════════════════════════════════════════════════════════════════════


def test_combined_planning_long_conversation():
    allocator = DynamicTokenBudgetAllocator(
        max_tokens=128000,
        task_type="planning",
        conversation_length=20,
        tool_count=2,
    )
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 128000
    assert allocation["system_prompt"] > allocation["tool_results"]


def test_combined_coding_many_tools():
    allocator = DynamicTokenBudgetAllocator(
        max_tokens=128000,
        task_type="coding",
        tool_count=10,
        conversation_length=3,
    )
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 128000
    assert allocation["tool_results"] > 0
    assert allocation["dynamic_context"] > 0


def test_combined_search_with_memory():
    allocator = DynamicTokenBudgetAllocator(
        max_tokens=128000,
        task_type="search",
        use_memory_retrieval=True,
        tool_count=3,
    )
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 128000
    assert allocation["tool_results"] > 0
    assert allocation["memory"] > 0


# ═══════════════════════════════════════════════════════════════════════════
# 更新方法测试
# ═══════════════════════════════════════════════════════════════════════════


def test_update_task_type_changes_allocation():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, task_type="general")
    general_alloc = allocator.allocate()

    allocator.update_task_type("planning")
    planning_alloc = allocator.allocate()

    assert planning_alloc["system_prompt"] != general_alloc["system_prompt"]


def test_update_tool_count_changes_allocation():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, tool_count=2)
    few_alloc = allocator.allocate()

    allocator.update_tool_count(20)
    many_alloc = allocator.allocate()

    assert many_alloc["tool_results"] > few_alloc["tool_results"]


def test_update_conversation_length_changes_allocation():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, conversation_length=2)
    short_alloc = allocator.allocate()

    allocator.update_conversation_length(30)
    long_alloc = allocator.allocate()

    assert long_alloc["history"] > short_alloc["history"]


def test_update_memory_retrieval_changes_allocation():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, use_memory_retrieval=False)
    no_memory_alloc = allocator.allocate()

    allocator.update_memory_retrieval(True)
    with_memory_alloc = allocator.allocate()

    assert with_memory_alloc["memory"] > no_memory_alloc["memory"]


# ═══════════════════════════════════════════════════════════════════════════
# 边界条件测试
# ═══════════════════════════════════════════════════════════════════════════


def test_min_tokens():
    allocator = DynamicTokenBudgetAllocator(max_tokens=100)
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 100


def test_max_tokens_large():
    allocator = DynamicTokenBudgetAllocator(max_tokens=1_000_000)
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 1_000_000


def test_zero_tools():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, tool_count=0)
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 128000


def test_zero_conversation():
    allocator = DynamicTokenBudgetAllocator(max_tokens=128000, conversation_length=0)
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 128000


def test_all_task_types_produce_valid_allocation():
    task_types = ["planning", "coding", "analysis", "search", "conversation", "tool_heavy"]
    for tt in task_types:
        allocator = DynamicTokenBudgetAllocator(max_tokens=128000, task_type=tt)
        allocation = allocator.allocate()
        assert sum(allocation.values()) == 128000, f"Task type {tt} allocation sum mismatch"
        for key in ["system_prompt", "memory", "history", "dynamic_context", "tool_results"]:
            assert allocation[key] >= 0, f"Task type {tt}: {key} is negative"


def test_large_budget_does_not_exceed():
    allocator = DynamicTokenBudgetAllocator(max_tokens=10_000_000)
    allocation = allocator.allocate()

    assert sum(allocation.values()) == 10_000_000
