"""T4 运行时接线测试：ExtensionCatalog 门控 skill / mcp 注册。

验证：
  - build_extension_catalog 默认全部启用（向后兼容）；AGENT_OPTIONAL_EXTENSIONS
    白名单只启用所列，未列禁用。
  - SkillRegistry.register_builtin_skills(enabled_check) 跳过被禁用的技能。
  - MCPToolBridge.sync_to_registry(enabled_check) 跳过被禁用的 MCP 服务器。
"""
from __future__ import annotations

from agent.catalog import ExtensionCatalog
from agent.core.engine import build_extension_catalog
from agent.skills.registry import SkillRegistry
from agent.tools.mcp_tool_bridge import MCPToolBridge
from agent.tools.registry import ToolRegistry


def _all_skill_names(reg: SkillRegistry) -> set[str]:
    return {s.definition.name for s in reg.get_all_skills()}


def test_default_catalog_all_enabled():
    cat = build_extension_catalog()  # 缺省 → "*" 全部启用
    enabled = set(cat.list_enabled())
    assert "skill:chat" in enabled
    assert "skill:task_plan" in enabled
    assert "mcp:filesystem" in enabled
    assert "mcp:browser" in enabled


def test_whitelist_disables_others():
    cat = build_extension_catalog("skill:chat,mcp:sqlite")
    enabled = set(cat.list_enabled())
    assert "skill:chat" in enabled
    assert "skill:task_plan" not in enabled  # 未列入白名单
    assert "mcp:sqlite" in enabled
    assert "mcp:filesystem" not in enabled  # 未列入白名单


def test_register_builtin_skills_gated():
    reg = SkillRegistry()  # 全新实例，避免污染单例
    def checker(ref: str) -> bool:
        return ref != "skill:code_analysis"
    reg.register_builtin_skills(enabled_check=checker)
    names = _all_skill_names(reg)
    assert "chat" in names
    assert "code_analysis" not in names  # 被门控禁用


def test_register_builtin_skills_no_gate_keeps_all():
    reg = SkillRegistry()
    reg.register_builtin_skills()  # 无门控 → 全部
    names = _all_skill_names(reg)
    assert "code_analysis" in names
    assert "task_plan" in names


class _FakeMCPProvider:
    def get_running_servers(self):
        return ["filesystem", "sqlite"]

    def list_tools(self, server_name):
        return [{"name": f"{server_name}_tool", "description": "d", "inputSchema": {}}]

    def call_tool(self, server_name, tool_name, params):
        return "ok"


def test_mcp_sync_gated():
    reg = ToolRegistry()
    bridge = MCPToolBridge(provider=_FakeMCPProvider())

    def checker(ref: str) -> bool:
        return ref != "mcp:filesystem"  # 禁用 filesystem 服务器

    import asyncio
    synced = asyncio.run(bridge.sync_to_registry(reg, enabled_check=checker))
    names = {d.name for d, _ in reg._tools.values()}
    assert "mcp_filesystem_filesystem_tool" not in names  # 被禁用
    assert "mcp_sqlite_sqlite_tool" in names  # 启用
    assert synced == 1
