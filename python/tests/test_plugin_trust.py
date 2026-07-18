"""插件信任策略 PluginTrustPolicy 测试。

覆盖：
- 三条受控路径（LLM / 工具 / 上下文）的信任 gate
- critical 工具硬底线（任何等级都拒绝）
- 新插件默认 UNTRUSTED
- PluginManager 集成
"""

from __future__ import annotations

import pytest

from agent.a2a.protocol import TrustLevel
from agent.plugins.base import Plugin
from agent.plugins.manager import PluginManager
from agent.plugins.trust import (
    ContextScope,
    PluginTrustError,
    PluginTrustPolicy,
    allowed_context_scope,
    can_call_llm,
    can_call_tool,
    parse_trust_level,
)


# ─── 纯 gate 函数 ───

@pytest.mark.parametrize(
    "level,expected",
    [
        (TrustLevel.UNTRUSTED, False),
        (TrustLevel.LOW, True),
        (TrustLevel.MEDIUM, True),
        (TrustLevel.HIGH, True),
    ],
)
def test_can_call_llm(level: TrustLevel, expected: bool) -> None:
    assert can_call_llm(level) is expected


@pytest.mark.parametrize(
    "level,risk,expected",
    [
        (TrustLevel.UNTRUSTED, "low", False),
        (TrustLevel.LOW, "low", True),
        (TrustLevel.LOW, "medium", False),
        (TrustLevel.MEDIUM, "medium", True),
        (TrustLevel.MEDIUM, "high", False),
        (TrustLevel.HIGH, "high", True),
        # critical 硬底线：任何等级都拒绝
        (TrustLevel.HIGH, "critical", False),
        (TrustLevel.MEDIUM, "critical", False),
    ],
)
def test_can_call_tool(level: TrustLevel, risk: str, expected: bool) -> None:
    assert can_call_tool(level, risk) is expected


def test_critical_tool_denied_for_all_levels() -> None:
    for level in TrustLevel:
        assert can_call_tool(level, "critical") is False


def test_unknown_risk_treated_as_high() -> None:
    assert can_call_tool(TrustLevel.MEDIUM, "weird") is False  # high 对 MEDIUM 不放行
    assert can_call_tool(TrustLevel.HIGH, None) is True        # high 对 HIGH 放行


def test_context_scope_by_level() -> None:
    assert allowed_context_scope(TrustLevel.UNTRUSTED) is ContextScope.NONE
    assert allowed_context_scope(TrustLevel.LOW) is ContextScope.SCOPED
    assert allowed_context_scope(TrustLevel.MEDIUM) is ContextScope.SCOPED
    assert allowed_context_scope(TrustLevel.HIGH) is ContextScope.FULL


# ─── PluginTrustPolicy ───

def test_default_untrusted_denies_everything() -> None:
    policy = PluginTrustPolicy()
    policy.register_default("p")
    assert policy.get_trust("p") is TrustLevel.UNTRUSTED
    with pytest.raises(PluginTrustError):
        policy.guard_llm("p")
    with pytest.raises(PluginTrustError):
        policy.guard_tool("p", "read_file", "low")
    with pytest.raises(PluginTrustError):
        policy.guard_context("p")


def test_high_trust_allows_but_critical_still_blocked() -> None:
    policy = PluginTrustPolicy()
    policy.set_trust("p", TrustLevel.HIGH)
    policy.guard_llm("p")  # 不抛
    policy.guard_tool("p", "shell_exec", "high")  # 不抛
    assert policy.guard_context("p") is ContextScope.FULL
    with pytest.raises(PluginTrustError):
        policy.guard_tool("p", "rm_rf", "critical")


def test_medium_trust_boundaries() -> None:
    policy = PluginTrustPolicy()
    policy.set_trust("p", TrustLevel.MEDIUM)
    policy.guard_llm("p")
    policy.guard_tool("p", "edit", "medium")
    with pytest.raises(PluginTrustError):
        policy.guard_tool("p", "deploy", "high")
    assert policy.guard_context("p") is ContextScope.SCOPED


def test_register_default_does_not_override_existing() -> None:
    policy = PluginTrustPolicy()
    policy.set_trust("p", TrustLevel.HIGH)
    policy.register_default("p")  # 不应把已设的 HIGH 覆盖回 UNTRUSTED
    assert policy.get_trust("p") is TrustLevel.HIGH


# ─── PluginManager 集成 ───

class _StubPlugin(Plugin):
    @property
    def name(self) -> str:
        return "stub"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def description(self) -> str:
        return "测试插件"


def test_manager_registers_plugin_as_untrusted() -> None:
    mgr = PluginManager()
    mgr.register_plugin(_StubPlugin())
    assert mgr.get_plugin_trust("stub") is TrustLevel.UNTRUSTED
    with pytest.raises(PluginTrustError):
        mgr.guard_plugin_llm("stub")
    with pytest.raises(PluginTrustError):
        mgr.guard_plugin_context("stub")


def test_manager_trust_elevation_grants_capabilities() -> None:
    mgr = PluginManager()
    mgr.register_plugin(_StubPlugin())
    mgr.set_plugin_trust("stub", TrustLevel.MEDIUM)
    mgr.guard_plugin_llm("stub")
    mgr.guard_plugin_tool("stub", "edit", "medium")
    assert mgr.guard_plugin_context("stub") is ContextScope.SCOPED
    with pytest.raises(PluginTrustError):
        mgr.guard_plugin_tool("stub", "rm_rf", "critical")


# ─── parse_trust_level ───


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("high", TrustLevel.HIGH),
        ("MEDIUM", TrustLevel.MEDIUM),
        (" low ", TrustLevel.LOW),
        ("untrusted", TrustLevel.UNTRUSTED),
        ("bogus", TrustLevel.UNTRUSTED),  # 非法 → 安全默认最低
        ("", TrustLevel.UNTRUSTED),
        (None, TrustLevel.UNTRUSTED),
    ],
)
def test_parse_trust_level(raw, expected) -> None:
    assert parse_trust_level(raw) is expected


def test_parse_trust_level_custom_default() -> None:
    assert parse_trust_level("bogus", default=TrustLevel.LOW) is TrustLevel.LOW


# ─── from_env ───


def test_from_env_empty(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_PLUGIN_TRUST", raising=False)
    policy = PluginTrustPolicy.from_env()
    assert policy.get_trust("anything") is TrustLevel.UNTRUSTED


def test_from_env_parses_multiple(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_PLUGIN_TRUST", "alpha:high, beta:medium ,gamma:low")
    policy = PluginTrustPolicy.from_env()
    assert policy.get_trust("alpha") is TrustLevel.HIGH
    assert policy.get_trust("beta") is TrustLevel.MEDIUM
    assert policy.get_trust("gamma") is TrustLevel.LOW
    # 未列出的插件仍默认 UNTRUSTED
    assert policy.get_trust("delta") is TrustLevel.UNTRUSTED


def test_from_env_skips_malformed(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_PLUGIN_TRUST", "noColon,:onlylevel,valid:high,bad:bogus")
    policy = PluginTrustPolicy.from_env()
    assert policy.get_trust("valid") is TrustLevel.HIGH
    # bad:bogus → 非法等级降级为默认 UNTRUSTED
    assert policy.get_trust("bad") is TrustLevel.UNTRUSTED
    assert policy.get_trust("noColon") is TrustLevel.UNTRUSTED


def test_from_env_register_default_does_not_override(monkeypatch) -> None:
    """from_env 预置的等级不应被 register_default 覆盖。"""
    monkeypatch.setenv("AGENT_PLUGIN_TRUST", "stub:high")
    policy = PluginTrustPolicy.from_env()
    mgr = PluginManager(trust_policy=policy)
    mgr.register_plugin(_StubPlugin())  # 触发 register_default("stub")
    assert mgr.get_plugin_trust("stub") is TrustLevel.HIGH
