"""③ R2 → EvolutionEngine：工具集采样信号喂送进化引擎。

验证：
  - EvolutionEngine.record_toolset_selection 把每个选中工具记为 TOOL_SELECTION_QUALITY 信号，
    累计 selection_count。
  - record_signal 对 TOOL_SELECTION_QUALITY 安全处理（空 tool_name 不写脏数据）。
  - 引擎 select_openai_tools_for_input（采样开启时）确实把选中工具集喂给 engine.evolution，
    关闭采样后不再喂送（零回归）。
"""

import os

from agent.core.engine import AgentEngine
from agent.evolution.engine import EvolutionEngine
from agent.evolution.types import LearningSignal, SignalType
from agent.tools.builtin_toolsets import BUILTIN_TOOLSETS
from agent.tools.registry import ToolCategory, ToolDefinition, ToolRegistry
from agent.tools.toolset_registry import ToolsetRegistry


def _make_registry() -> ToolRegistry:
    reg = ToolRegistry()
    specs = [
        ("memory_recall", ToolCategory.MEMORY),
        ("reason", ToolCategory.COGNITION),
        ("code_gen", ToolCategory.CODE),
        ("shell_exec", ToolCategory.CODE),
        ("file_read", ToolCategory.FILE),
        ("file_write", ToolCategory.FILE),
        ("desktop_click", ToolCategory.DESKTOP),
        ("schedule_add", ToolCategory.DAILY),
        ("web_search", ToolCategory.NETWORK),
        ("knowledge_query", ToolCategory.NETWORK),
    ]
    for name, cat in specs:
        reg.register(ToolDefinition(name=name, description=name, category=cat), lambda p=None: None)
    return reg


def _make_engine() -> AgentEngine:
    engine = AgentEngine()
    engine.tool_registry = _make_registry()
    tsr = ToolsetRegistry()
    for d in BUILTIN_TOOLSETS:
        tsr.register(d)
    engine.toolset_registry = tsr
    engine._toolset_mapper = None
    return engine


def test_evolution_records_toolset_selection_directly() -> None:
    evo = EvolutionEngine()
    evo.record_toolset_selection(scene="coding", toolset_id="coding", tool_names=["code_gen", "file_read"])
    stats = evo._tool_signal_stats
    assert stats["code_gen"]["selection_count"] == 1
    assert stats["file_read"]["selection_count"] == 1
    # 再次选中同一工具 → 计数累加
    evo.record_toolset_selection(scene="coding", toolset_id="coding", tool_names=["code_gen"])
    assert stats["code_gen"]["selection_count"] == 2


def test_record_signal_tool_selection_quality_safe() -> None:
    evo = EvolutionEngine()
    evo.record_signal(
        LearningSignal(
            signal_type=SignalType.TOOL_SELECTION_QUALITY,
            tool_name="x",
            metadata={"scene": "coding", "toolset_id": "coding"},
        )
    )
    assert evo._tool_signal_stats["x"]["selection_count"] == 1
    # 空 tool_name：不应写入脏键（None）
    evo.record_signal(LearningSignal(signal_type=SignalType.TOOL_SELECTION_QUALITY, tool_name=None))
    assert None not in evo._tool_signal_stats


def test_engine_feeds_evolution_on_sampling() -> None:
    os.environ["AGENT_TOOLSET_SAMPLING"] = "on"
    try:
        engine = _make_engine()
        engine.evolution = EvolutionEngine()
        schemas = engine.select_openai_tools_for_input("帮我写个函数修复这个 bug")
        names = {s["function"]["name"] for s in schemas}
        assert names  # 确有工具被选中

        stats = engine.evolution._tool_signal_stats
        for n in names:
            assert stats.get(n, {}).get("selection_count", 0) >= 1

        # 关闭采样后再次调用 → 不再喂送（计数不变）
        os.environ.pop("AGENT_TOOLSET_SAMPLING", None)
        engine._toolset_mapper = None
        before = sum(v["selection_count"] for v in stats.values())
        engine.select_openai_tools_for_input("随便聊聊")
        after = sum(v["selection_count"] for v in stats.values())
        assert after == before
    finally:
        os.environ.pop("AGENT_TOOLSET_SAMPLING", None)
