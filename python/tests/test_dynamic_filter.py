"""测试 DynamicToolFilter 动态工具过滤器。"""

from __future__ import annotations

import pytest

from agent.tools.dynamic_filter import (
    DynamicToolFilter,
    FilteredTool,
    ToolFilterResult,
    ToolSelectionMode,
)
from agent.tools.registry import ToolCategory, ToolDefinition


def _make_sample_tools() -> list[ToolDefinition]:
    return [
        ToolDefinition(name="file_read", description="读取文件内容", category=ToolCategory.FILE, tags=["file", "read"], scenes=["coding", "file_management"]),
        ToolDefinition(name="file_write", description="写入文件内容", category=ToolCategory.FILE, tags=["file", "write"], scenes=["coding", "file_management"]),
        ToolDefinition(name="code_execute", description="执行代码", category=ToolCategory.CODE, tags=["code", "execute"], scenes=["coding"], risk_level="high"),
        ToolDefinition(name="code_lint", description="代码检查", category=ToolCategory.CODE, tags=["code", "lint"], scenes=["coding"]),
        ToolDefinition(name="web_search", description="搜索网页", category=ToolCategory.NETWORK, tags=["search", "web"], scenes=["search", "analysis"]),
        ToolDefinition(name="memory_store", description="存储记忆", category=ToolCategory.MEMORY, tags=["memory", "store"], scenes=["conversation", "analysis"]),
        ToolDefinition(name="memory_retrieve", description="检索记忆", category=ToolCategory.MEMORY, tags=["memory", "retrieve"], scenes=["conversation", "analysis"]),
        ToolDefinition(name="desktop_screenshot", description="桌面截图", category=ToolCategory.DESKTOP, tags=["desktop", "screenshot"], scenes=["desktop"]),
        ToolDefinition(name="system_info", description="系统信息", category=ToolCategory.SYSTEM, tags=["system", "info"], scenes=["coding", "desktop"]),
        ToolDefinition(name="daily_reminder", description="设置提醒", category=ToolCategory.DAILY, tags=["daily", "reminder"], scenes=["daily"]),
        ToolDefinition(name="analyze_code", description="分析代码结构", category=ToolCategory.COGNITION, tags=["analysis", "code"], scenes=["coding", "analysis"]),
        ToolDefinition(name="iot_control", description="IoT设备控制", category=ToolCategory.IOT, tags=["iot", "control"], scenes=["iot"]),
        ToolDefinition(name="perception_image", description="图像识别", category=ToolCategory.PERCEPTION, tags=["perception", "image"], scenes=["perception"]),
        ToolDefinition(name="dangerous_exec", description="执行危险命令", category=ToolCategory.SYSTEM, tags=["dangerous"], scenes=["system"], risk_level="critical"),
    ]


class _FakeRegistry:
    def __init__(self, tools=None):
        self._tools = tools or []

    def get_all_definitions(self):
        return self._tools


# ═══════════════════════════════════════════════════════════════════════════
# 基础功能测试
# ═══════════════════════════════════════════════════════════════════════════


def test_filter_returns_result():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="创建新的 Python 项目")

    assert isinstance(result, ToolFilterResult)
    assert result.total_before == len(_make_sample_tools())
    assert result.total_after > 0
    assert result.total_after <= result.total_before


def test_filter_respects_max_tools():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="任意任务", max_tools=5)

    assert result.total_after <= 5


def test_filter_coding_task_prioritizes_code_tools():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="编写一个 Python 函数", max_tools=10)

    code_tools = [t for t in result.tools if t.definition.category == ToolCategory.CODE]
    assert len(code_tools) >= 1


def test_filter_search_task_prioritizes_network_tools():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="搜索最新的 Python 教程", max_tools=10)

    network_high = [t for t in result.tools if t.definition.category == ToolCategory.NETWORK]
    if network_high:
        best = max(t.relevance_score for t in network_high)
        assert best > 0


def test_filter_exclude_risky():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="任意任务", exclude_risky=True, max_tools=100)

    critical_tools = [t for t in result.tools if getattr(t.definition, "risk_level", "") == "critical"]
    assert len(critical_tools) == 0


def test_filter_include_risky_when_not_excluded():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="任意任务", exclude_risky=False, max_tools=100)

    critical_tools = [t for t in result.tools if getattr(t.definition, "risk_level", "") == "critical"]
    assert len(critical_tools) >= 1


def test_filter_sorted_by_relevance():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="编写代码", max_tools=10)

    scores = [t.relevance_score for t in result.tools]
    for i in range(len(scores) - 1):
        assert scores[i] >= scores[i + 1]


# ═══════════════════════════════════════════════════════════════════════════
# 选择模式测试
# ═══════════════════════════════════════════════════════════════════════════


def test_conservative_mode_fewer_tools():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    conservative = filter.filter_for_task(
        goal="编码任务",
        mode=ToolSelectionMode.CONSERVATIVE,
        max_tools=100,
    )
    aggressive = filter.filter_for_task(
        goal="编码任务",
        mode=ToolSelectionMode.AGGRESSIVE,
        max_tools=100,
    )

    assert conservative.total_after <= aggressive.total_after


def test_aggressive_mode_includes_more_categories():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(
        goal="编码任务",
        mode=ToolSelectionMode.AGGRESSIVE,
        max_tools=100,
    )

    categories = {t.definition.category for t in result.tools}
    assert len(categories) >= 3


# ═══════════════════════════════════════════════════════════════════════════
# 已使用工具过滤测试
# ═══════════════════════════════════════════════════════════════════════════


def test_filter_already_used_tools_deprioritized():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(
        goal="编码任务",
        already_used_tools=["file_read", "code_execute"],
        max_tools=100,
    )

    used_tools = [t for t in result.tools if t.definition.name in ("file_read", "code_execute")]
    for t in used_tools:
        assert "already_used" in t.match_reasons


def test_filter_no_already_used():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(
        goal="编码任务",
        already_used_tools=[],
        max_tools=100,
    )

    assert result.total_after > 0


# ═══════════════════════════════════════════════════════════════════════════
# 对话长度影响测试
# ═══════════════════════════════════════════════════════════════════════════


def test_long_conversation_boosts_memory():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    short_result = filter.filter_for_task(goal="编码", conversation_length=2, max_tools=100)
    long_result = filter.filter_for_task(goal="编码", conversation_length=30, max_tools=100)

    short_memory = [t for t in short_result.tools if t.definition.category == ToolCategory.MEMORY]
    long_memory = [t for t in long_result.tools if t.definition.category == ToolCategory.MEMORY]

    if short_memory and long_memory:
        short_avg = sum(t.relevance_score for t in short_memory) / len(short_memory)
        long_avg = sum(t.relevance_score for t in long_memory) / len(long_memory)
        assert long_avg >= short_avg


# ═══════════════════════════════════════════════════════════════════════════
# get_definitions 测试
# ═══════════════════════════════════════════════════════════════════════════


def test_get_definitions_returns_original():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="编码", max_tools=5)
    defs = filter.get_definitions(result.tools)

    assert len(defs) == len(result.tools)
    for d in defs:
        assert isinstance(d, ToolDefinition)


# ═══════════════════════════════════════════════════════════════════════════
# 任务类型推断测试
# ═══════════════════════════════════════════════════════════════════════════


def test_infer_task_type_coding():
    filter = DynamicToolFilter()
    assert filter._infer_task_type("帮我写一个 Python 函数", "general") == "coding"


def test_infer_task_type_search():
    filter = DynamicToolFilter()
    assert filter._infer_task_type("搜索最新的新闻", "general") == "search"


def test_infer_task_type_analysis():
    filter = DynamicToolFilter()
    assert filter._infer_task_type("帮我分析一下这份报告", "general") == "analysis"


def test_infer_task_type_file():
    filter = DynamicToolFilter()
    assert filter._infer_task_type("帮我整理文件目录", "general") == "file_management"


def test_infer_task_type_fallback():
    filter = DynamicToolFilter()
    assert filter._infer_task_type("xyzzy 不存在的任务", "general") == "general"


# ═══════════════════════════════════════════════════════════════════════════
# 边界条件测试
# ═══════════════════════════════════════════════════════════════════════════


def test_filter_empty_registry():
    registry = _FakeRegistry([])
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="任意任务")

    assert result.total_before == 0
    assert result.total_after == 0
    assert len(result.tools) == 0


def test_filter_no_registry():
    filter = DynamicToolFilter(registry=None)

    result = filter.filter_for_task(goal="任意任务")

    assert result.total_before == 0
    assert result.total_after == 0


def test_filter_stage_counts():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="编写代码", max_tools=10)

    assert "initial" in result.filter_stages
    assert "risk_filter" in result.filter_stages
    assert "category_filter" in result.filter_stages
    assert "final" in result.filter_stages
    assert result.filter_stages["initial"] == len(_make_sample_tools())


def test_filter_respects_max_tools_large():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="编码", max_tools=1000)

    assert result.total_after <= 1000


def test_filter_result_contains_match_reasons():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="编写 Python 代码", max_tools=10)

    for t in result.tools:
        assert isinstance(t.match_reasons, list)


def test_filter_goal_keyword_scoring():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(goal="搜索文件", max_tools=10)

    file_tools = [t for t in result.tools if t.definition.category == ToolCategory.FILE]
    network_tools = [t for t in result.tools if t.definition.category == ToolCategory.NETWORK]

    if file_tools and network_tools:
        file_max = max(t.relevance_score for t in file_tools)
        network_max = max(t.relevance_score for t in network_tools)
        assert file_max >= network_max * 0.5


def test_filter_conservative_long_conversation():
    registry = _FakeRegistry(_make_sample_tools())
    filter = DynamicToolFilter(registry)

    result = filter.filter_for_task(
        goal="编码",
        mode=ToolSelectionMode.CONSERVATIVE,
        conversation_length=15,
        max_tools=100,
    )

    assert result.total_after > 0
