r"""回归测试：ReAct 思考解析器（_parse_react_thought）。

重点锁定审计发现的嵌套 JSON 参数解析缺陷：
旧正则 `Args:\s*(\{.+?\})` 为非贪婪，遇首个 } 即截断，
导致嵌套参数（如 {"filters": {"type": "x"}}）被截断为非法 JSON 而整体丢失。
"""
from __future__ import annotations

from agent.loop.controller import LoopController


def _make_controller() -> LoopController:
    """绕过重型 __init__，仅用于调用不依赖实例状态的解析方法。"""
    return object.__new__(LoopController)


def test_nested_args_parsed_correctly() -> None:
    ctrl = _make_controller()
    content = (
        "Thought: 我需要按类型过滤\n"
        'Action: search\n'
        'Args: {"query": "hello", "filters": {"type": "x", "sub": {"a": 1}}}\n'
        "Final Answer: done"
    )
    thought = ctrl._parse_react_thought(content)
    assert thought.tool_name == "search"
    assert thought.tool_args == {
        "query": "hello",
        "filters": {"type": "x", "sub": {"a": 1}},
    }
    assert thought.is_final is True


def test_flat_args_parsed() -> None:
    ctrl = _make_controller()
    content = 'Action: ping\nArgs: {"host": "127.0.0.1"}'
    thought = ctrl._parse_react_thought(content)
    assert thought.tool_name == "ping"
    assert thought.tool_args == {"host": "127.0.0.1"}


def test_string_with_braces_inside_args() -> None:
    """参数值内含花括号字符（在字符串里）不应干扰平衡扫描。"""
    ctrl = _make_controller()
    content = 'Action: echo\nArgs: {"text": "a } b { c"}'
    thought = ctrl._parse_react_thought(content)
    assert thought.tool_args == {"text": "a } b { c"}


def test_no_args_returns_none() -> None:
    ctrl = _make_controller()
    content = "Thought: 直接回答\nFinal Answer: 无工具调用"
    thought = ctrl._parse_react_thought(content)
    assert thought.tool_name is None
    assert thought.tool_args is None
    assert thought.is_final is True
