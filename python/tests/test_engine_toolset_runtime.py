"""T1 运行时接线测试：引擎 select_tools_for_input / select_openai_tools_for_input。

验证 AGENT_TOOLSET_SAMPLING 开关接入运行时调用点：
  - 关闭（默认）→ 返回全量工具（零回归，行为同旧版）。
  - 开启 + coding 场景 → 按工具集过滤为子集（默认采样器单候选，确定性）。
"""
from __future__ import annotations

import os

import pytest

from agent.core.engine import AgentEngine
from agent.tools.builtin_toolsets import BUILTIN_TOOLSETS
from agent.tools.registry import ToolCategory, ToolDefinition, ToolRegistry
from agent.tools.toolset_registry import ToolsetRegistry


async def _noop(params: dict | None = None):
    return None


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
        reg.register(ToolDefinition(name=name, description=name, category=cat), _noop)
    return reg


def _make_engine() -> AgentEngine:
    engine = AgentEngine()
    engine.tool_registry = _make_registry()
    tsr = ToolsetRegistry()
    for d in BUILTIN_TOOLSETS:
        tsr.register(d)
    engine.toolset_registry = tsr
    engine._toolset_mapper = None  # 强制下次调用按当前 env 重建映射器
    return engine


@pytest.fixture
def engine():
    return _make_engine()


def test_sampling_off_returns_all_tools(engine):
    """AGENT_TOOLSET_SAMPLING 缺省 → 全量工具（零回归）。"""
    os.environ.pop("AGENT_TOOLSET_SAMPLING", None)
    engine._toolset_mapper = None
    all_names = {d.name for d in engine.tool_registry.get_all_definitions()}
    selected = engine.select_tools_for_input("帮我写个函数修复这个 bug")
    sel_names = {d.name for d in selected}
    assert sel_names == all_names
    assert len(sel_names) == 10


def test_sampling_on_coding_scene_returns_toolset_subset(engine):
    """AGENT_TOOLSET_SAMPLING=on + coding 场景 → 过滤为 coding 工具集（子集）。"""
    os.environ["AGENT_TOOLSET_SAMPLING"] = "on"
    engine._toolset_mapper = None
    selected = engine.select_tools_for_input("帮我写个函数修复这个 bug")
    sel_names = {d.name for d in selected}
    all_names = {d.name for d in engine.tool_registry.get_all_definitions()}
    # 严格子集
    assert sel_names < all_names
    # coding 工具集应含代码/文件类工具
    assert "code_gen" in sel_names
    assert "file_read" in sel_names
    assert "shell_exec" in sel_names
    # 不应含桌面/日程/网络类工具
    assert "desktop_click" not in sel_names
    assert "schedule_add" not in sel_names
    assert "web_search" not in sel_names


def test_sampling_on_openai_schema_matches_toolset(engine):
    """select_openai_tools_for_input 返回与 select_tools_for_input 一致的工具名子集。"""
    os.environ["AGENT_TOOLSET_SAMPLING"] = "on"
    engine._toolset_mapper = None
    schemas = engine.select_openai_tools_for_input("写代码实现登录接口")
    names = {s["function"]["name"] for s in schemas}
    all_names = {d.name for d in engine.tool_registry.get_all_definitions()}
    assert names < all_names
    assert "code_gen" in names
    assert "desktop_click" not in names


def test_sampling_off_openai_schema_is_full(engine):
    """AGENT_TOOLSET_SAMPLING 缺省 → 全量 OpenAI 工具 schema。"""
    os.environ.pop("AGENT_TOOLSET_SAMPLING", None)
    engine._toolset_mapper = None
    schemas = engine.select_openai_tools_for_input("随便聊聊")
    names = {s["function"]["name"] for s in schemas}
    all_names = {d.name for d in engine.tool_registry.get_all_definitions()}
    assert names == all_names
