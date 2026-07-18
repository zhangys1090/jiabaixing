"""R3 Provider 目录 + 窄腰目录 测试。

覆盖：
- ProviderCatalog：内置目录广度、OAuth 能力标注、与 providers.json 合并
  （available/configured/unconfigured/unknown）、manifest 可审计。
- ExtensionCatalog：声明/默认禁用/env 启用（含通配）、builtin/disabled
  状态、requires_env 闸门、summary。
"""

from __future__ import annotations

import json

import pytest

from agent.catalog import ExtensionCatalog, ExtensionEntry, ExtensionState
from agent.llm.provider_catalog import (
    ProviderAuth,
    ProviderCatalog,
    ProviderSpec,
)


# ==================== ProviderCatalog ====================


def test_builtin_catalog_breadth() -> None:
    cat = ProviderCatalog()
    ids = cat.known_provider_ids()
    # 至少覆盖美国主流 + 国内主流 + 本地
    for must in ["openai", "anthropic", "gemini", "vertex", "bedrock", "azure",
                 "deepseek", "zhipu", "moonshot", "qwen", "local"]:
        assert must in ids


def test_oauth_capable_annotated() -> None:
    cat = ProviderCatalog()
    oauth = cat.oauth_capable_ids()
    # Vertex / Bedrock 为纯 OAuth 厂商；主流 API Key 厂商也标 oauth_supported
    for must in ["openai", "anthropic", "gemini", "vertex", "bedrock", "azure"]:
        assert must in oauth
    # 纯 API Key 国内厂商不标 oauth
    assert "deepseek" not in oauth
    assert "zhipu" not in oauth


def test_spec_fields_and_auth_enum() -> None:
    cat = ProviderCatalog()
    spec = cat.get_spec("vertex")
    assert spec is not None
    assert spec.auth is ProviderAuth.OAUTH
    assert spec.oauth_supported is True
    assert spec.transport == "gemini"
    # to_dict 可序列化
    d = spec.to_dict()
    assert d["auth"] == "oauth"


def test_merge_with_providers_json(tmp_path) -> None:
    payload = {
        "providers": [
            {"name": "deepseek", "enabled": True},
            {"name": "zhipu", "enabled": False},
            {"name": "local", "enabled": True},
            {"name": "unknown-vendor", "enabled": True},  # 目录未知
        ],
        "primary": "deepseek",
    }
    p = tmp_path / "providers.json"
    p.write_text(json.dumps(payload), encoding="utf-8")

    cat = ProviderCatalog.from_providers_json(p)
    configured = cat.configured_ids()
    assert "deepseek" in configured
    assert "zhipu" in configured
    assert "local" in configured
    # 目录未知但已配置的被审计出来
    assert "unknown-vendor" in cat.unknown_configured_ids()
    # available = 目录已知且已配置
    avail = {s.id for s in cat.available_providers()}
    assert avail == {"deepseek", "zhipu", "local"}
    # unconfigured 仅含目录已知且未配置
    unconf = {s.id for s in cat.unconfigured_catalog()}
    assert "deepseek" not in unconf
    assert "openai" in unconf


def test_from_providers_json_missing_file_is_safe(tmp_path) -> None:
    cat = ProviderCatalog.from_providers_json(tmp_path / "nope.json")
    assert cat.configured_ids() == []
    assert len(cat.known_provider_ids()) >= 15


def test_manifest_structure() -> None:
    cat = ProviderCatalog()
    manifest = cat.to_manifest()
    assert manifest["known_count"] >= 15
    assert "providers" in manifest
    assert isinstance(manifest["oauth_capable"], list)
    # 每个 provider 带 configured 标志
    for p in manifest["providers"]:
        assert "configured" in p


def test_add_spec_overrides() -> None:
    cat = ProviderCatalog()
    cat.add_spec(ProviderSpec(id="deepseek", display_name="DeepSeek-X", transport="openai_compatible"))
    assert cat.get_spec("deepseek").display_name == "DeepSeek-X"


# ==================== ExtensionCatalog ====================


def _catalog() -> ExtensionCatalog:
    return ExtensionCatalog([
        ExtensionEntry(ref="core:chat", state=ExtensionState.BUILTIN),
        ExtensionEntry(ref="skill:code_review", state=ExtensionState.OPTIONAL),
        ExtensionEntry(ref="skill:translate", state=ExtensionState.OPTIONAL),
        ExtensionEntry(ref="mcp:github", state=ExtensionState.OPTIONAL, requires_env="GITHUB_TOKEN"),
        ExtensionEntry(ref="mcp:internal", state=ExtensionState.DISABLED),
    ])


def _getter(env: dict) -> "callable":
    return lambda k: env.get(k)


def test_default_all_optional_disabled() -> None:
    cat = _catalog()
    assert cat.is_enabled("core:chat") is True           # builtin
    assert cat.is_enabled("skill:code_review") is False  # 默认禁用
    assert cat.is_enabled("mcp:internal") is False       # 强制关闭


def test_explicit_enable_via_env() -> None:
    cat = _catalog()
    cat.apply_env("skill:code_review", env_getter=_getter({}))
    assert cat.is_enabled("skill:code_review") is True
    assert cat.is_enabled("skill:translate") is False    # 未声明


def test_wildcard_enables_all_optional() -> None:
    cat = _catalog()
    cat.apply_env("*", env_getter=_getter({"GITHUB_TOKEN": "x"}))
    assert cat.is_enabled("skill:code_review") is True
    assert cat.is_enabled("skill:translate") is True
    assert cat.is_enabled("mcp:github") is True          # requires_env 满足
    assert cat.is_enabled("mcp:internal") is False       # disabled 不被通配开启


def test_requires_env_gate_blocks() -> None:
    cat = _catalog()
    # 声明开启 mcp:github，但 GITHUB_TOKEN 缺失 → 仍不可用
    cat.apply_env("mcp:github", env_getter=_getter({}))
    assert cat.is_enabled("mcp:github") is False
    # 提供 token 后可用
    cat.apply_env("mcp:github", env_getter=_getter({"GITHUB_TOKEN": "abc"}))
    assert cat.is_enabled("mcp:github") is True


def test_disabled_never_enabled() -> None:
    cat = _catalog()
    cat.apply_env("*", env_getter=_getter({}))
    assert cat.is_enabled("mcp:internal") is False


def test_summary_groups_states() -> None:
    cat = _catalog()
    cat.apply_env("skill:code_review", env_getter=_getter({}))
    s = cat.summary()
    assert "core:chat" in s["builtin"]
    assert "mcp:internal" in s["disabled"]
    assert "skill:code_review" in s["enabled"]
    assert "skill:translate" not in s["enabled"]


def test_unknown_ref_is_not_enabled() -> None:
    cat = _catalog()
    cat.apply_env("skill:ghost", env_getter=_getter({}))
    assert cat.is_enabled("skill:ghost") is False


def test_register_and_deregister() -> None:
    cat = ExtensionCatalog()
    cat.register("toolset:research", ExtensionState.OPTIONAL)
    assert cat.is_known("toolset:research")
    cat.deregister("toolset:research")
    assert not cat.is_known("toolset:research")
