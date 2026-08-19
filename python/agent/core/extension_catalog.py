"""窄腰能力目录构建（#6d 超大文件拆分首批提取）。

原位于 ``agent/core/engine.py``（4841 行单体 ``AgentEngine`` 的一部分）。
该函数在引擎启动时构建 skill:*/mcp:* 窄腰目录，与引擎状态无耦合，
是首个被安全外提的叶子纯函数。

提取不改动对外签名：``agent.core.engine`` 仍通过 re-export 暴露
``build_extension_catalog``，现有调用方与测试无需改动。
"""

from __future__ import annotations

from typing import Any


def build_extension_catalog(env_value: str | None = None) -> Any:
    """构建引擎使用的窄腰能力目录（skill:*/mcp:*），默认全部启用（向后兼容）。

    - 注册各内置技能为 skill:<name>（OPTIONAL）。
    - 注册各默认 MCP 服务器为 mcp:<name>（OPTIONAL）。
    - env 表达式缺省按 "*" 处理 → 全部启用；设具体列表则仅启用所列（白名单）。

    Returns:
        ExtensionCatalog 实例。
    """
    from agent.catalog import EXTENSIONS_ENV, ExtensionCatalog, ExtensionState
    from agent.skills.registry import builtin_skill_names

    cat = ExtensionCatalog()
    for name in builtin_skill_names():
        cat.register(f"skill:{name}", ExtensionState.OPTIONAL)
    # 默认 MCP 服务器（与 MCPServerManager._initialize_default_servers 对齐）。
    for srv in ("filesystem", "sqlite", "browser", "cron"):
        cat.register(f"mcp:{srv}", ExtensionState.OPTIONAL)
    # 向后兼容：env 缺省 → 全部启用。
    cat.apply_env(env_value if env_value else "*")
    return cat
