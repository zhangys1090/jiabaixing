"""插件系统包，导出插件管理器、插件基类、插件信息和插件状态。

Usage:
    from agent.plugins import PluginManager, Plugin, PluginInfo, PluginState
"""

from __future__ import annotations

from agent.plugins.base import Plugin, PluginInfo, PluginState
from agent.plugins.manager import PluginManager

__all__ = [
    "PluginManager",
    "Plugin",
    "PluginInfo",
    "PluginState",
]
