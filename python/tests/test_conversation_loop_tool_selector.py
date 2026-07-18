"""T1 运行时接缝测试：ConversationLoop 真正消费引擎注入的 tool_selector。

证明 AGENT_TOOLSET_SAMPLING 开关在对话循环的真实调用点生效：
  - 注入 tool_selector → _build_tools_schema 调用它，并以返回值作为工具 schema。
  - 未注入 → 退化为全量工具（旧版行为，零回归）。
  - tool_selector 抛异常 / 返回空 → 安全退化为全量工具（避免无工具可用）。
"""
from __future__ import annotations

from types import SimpleNamespace

from agent.core.conversation_loop import ConversationLoop
from agent.tools.registry import ToolCategory, ToolDefinition, ToolRegistry


async def _noop(params: dict | None = None):
    return None


def _make_registry() -> ToolRegistry:
    reg = ToolRegistry()
    for name, cat in [
        ("memory_recall", ToolCategory.MEMORY),
        ("reason", ToolCategory.COGNITION),
        ("code_gen", ToolCategory.CODE),
        ("shell_exec", ToolCategory.CODE),
        ("file_read", ToolCategory.FILE),
        ("web_search", ToolCategory.NETWORK),
    ]:
        reg.register(ToolDefinition(name=name, description=name, category=cat), _noop)
    return reg


def _loop_with(reg: ToolRegistry, selector=None) -> ConversationLoop:
    # ConversationLoop 仅存储 llm，_build_tools_schema 不依赖它，传占位即可。
    return ConversationLoop(llm=SimpleNamespace(), tool_registry=reg, tool_selector=selector)


def test_selector_is_invoked_and_result_used():
    """注入选择器 → 调用它并以返回子集作为 schema（非全量）。"""
    reg = _make_registry()
    calls: list[str] = []

    def selector(inp: str):
        calls.append(inp)
        return [{"type": "function", "function": {"name": "code_gen", "parameters": {}}}]

    loop = _loop_with(reg, selector)
    schema = loop._build_tools_schema("帮我写个函数", use_tools=True)
    assert calls == ["帮我写个函数"]
    assert [s["function"]["name"] for s in schema] == ["code_gen"]


def test_no_selector_falls_back_to_full_registry():
    """未注入选择器 → 返回全量工具 schema（零回归）。"""
    reg = _make_registry()
    loop = _loop_with(reg, selector=None)
    schema = loop._build_tools_schema("随便聊聊", use_tools=True)
    names = {s["function"]["name"] for s in schema}
    assert names == {d.name for d in reg.get_all_definitions()}


def test_selector_exception_degrades_to_full():
    """选择器抛异常 → 安全退化为全量工具。"""

    def selector(inp: str):
        raise RuntimeError("boom")

    reg = _make_registry()
    loop = _loop_with(reg, selector)
    schema = loop._build_tools_schema("输入", use_tools=True)
    names = {s["function"]["name"] for s in schema}
    assert names == {d.name for d in reg.get_all_definitions()}


def test_selector_empty_return_degrades_to_full():
    """选择器返回空 → 退化为全量工具。"""
    reg = _make_registry()
    loop = _loop_with(reg, lambda inp: [])
    schema = loop._build_tools_schema("输入", use_tools=True)
    names = {s["function"]["name"] for s in schema}
    assert names == {d.name for d in reg.get_all_definitions()}


def test_use_tools_false_returns_none():
    """use_tools=False → 不传工具（None）。"""
    reg = _make_registry()
    called = []
    loop = _loop_with(reg, lambda inp: called.append(inp) or [{"type": "function", "function": {"name": "x"}}])
    assert loop._build_tools_schema("输入", use_tools=False) is None
    assert called == []  # 不应调用选择器
