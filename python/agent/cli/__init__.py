"""CLI 子系统。

提供命令行界面、插件管理、配置管理等能力。
"""

from agent.cli.cli_output import CliOutput
from agent.cli.plugin_manager import PluginManager
from agent.cli.profile_manager import ProfileManager

__all__ = [
    "CliOutput",
    "PluginManager",
    "ProfileManager",
]
