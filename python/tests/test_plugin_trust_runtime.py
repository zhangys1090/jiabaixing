"""T2 运行时接线测试：插件 LLM/工具信任 gate 接入真实调用点。

验证：
  - register_all_tools 现在逐工具过 guard_plugin_tool：
      * UNTRUSTED 插件工具一律不进核心注册表；
      * 受信插件按 (信任等级 × 风险) 矩阵放行；critical 永不放行。
  - 能力请求点 request_llm / can_use_* 作为 LLM/工具 gate 的主动入口。
"""
from __future__ import annotations

from agent.a2a.protocol import TrustLevel
from agent.plugins.base import Plugin, PluginState
from agent.plugins.manager import PluginManager
from agent.plugins.trust import PluginTrustError
from agent.tools.registry import ToolCategory, ToolDefinition


class _FakeReg:
    def __init__(self) -> None:
        self.names: list[str] = []

    def register(self, definition: ToolDefinition, executor) -> None:
        self.names.append(definition.name)


class _FakePlugin(Plugin):
    def __init__(self, name: str, tools: list[tuple[str, str]]) -> None:
        self._name = name
        self._tools = tools

    @property
    def name(self) -> str:
        return self._name

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def description(self) -> str:
        return "fake plugin"

    def register_tools(self, registry) -> None:
        for tname, risk in self._tools:
            registry.register(
                ToolDefinition(
                    name=tname, description=tname,
                    risk_level=risk, category=ToolCategory.SYSTEM,
                ),
                lambda p=None: None,
            )


def _make_manager() -> PluginManager:
    mgr = PluginManager()  # 默认 UNTRUSTED
    evil = _FakePlugin("evil", [("echo", "low"), ("rm_rf", "critical")])
    good = _FakePlugin("good", [("safe_tool", "low"), ("shutdown", "high")])
    mgr.register_plugin(evil)
    mgr.register_plugin(good)
    mgr.set_plugin_trust("good", TrustLevel.MEDIUM)
    mgr._states["evil"] = PluginState.ENABLED
    mgr._states["good"] = PluginState.ENABLED
    return mgr


def test_untrusted_plugin_tools_not_registered():
    mgr = _make_manager()
    reg = _FakeReg()
    mgr.register_all_tools(reg)
    # evil 是 UNTRUSTED → 全部工具被拒
    assert "echo" not in reg.names
    assert "rm_rf" not in reg.names


def test_trusted_plugin_tools_filtered_by_risk():
    mgr = _make_manager()
    reg = _FakeReg()
    mgr.register_all_tools(reg)
    # good 是 MEDIUM：low 放行，high 拒绝
    assert "safe_tool" in reg.names
    assert "shutdown" not in reg.names


def test_critical_tools_never_registered():
    mgr = PluginManager()
    p = _FakePlugin("crit", [("nuke", "critical")])
    mgr.register_plugin(p)
    mgr.set_plugin_trust("crit", TrustLevel.HIGH)  # 即便最高信任
    mgr._states["crit"] = PluginState.ENABLED
    reg = _FakeReg()
    mgr.register_all_tools(reg)
    assert "nuke" not in reg.names  # critical 硬底线，永不放行


def test_request_llm_gate_raises_for_untrusted():
    mgr = _make_manager()
    import pytest
    with pytest.raises(PluginTrustError):
        mgr.request_llm("evil")
    # good (MEDIUM >= LOW) 通过
    mgr.request_llm("good")


def test_can_use_tool_matrix():
    mgr = _make_manager()
    assert mgr.can_use_tool("evil", "low") is False   # UNTRUSTED 不能用任何工具
    assert mgr.can_use_tool("good", "low") is True
    assert mgr.can_use_tool("good", "high") is False  # MEDIUM 上限 medium
    assert mgr.can_use_tool("good", "critical") is False
