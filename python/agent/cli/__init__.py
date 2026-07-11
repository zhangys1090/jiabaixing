"""CLI 子系统。

提供命令行界面、插件管理、配置管理、TUI、Shell补全等能力。
"""

from agent.cli.cli_output import CliOutput
from agent.cli.plugin_manager import PluginManager
from agent.cli.profile_manager import ProfileManager
from agent.cli.display_formatter import DisplayFormatter
from agent.cli.curses_tui import CursesTUI
from agent.cli.pty_bridge import PtyBridge
from agent.cli.shell_completion import ShellCompletion
from agent.cli.clipboard import Clipboard

__all__ = [
    "CliOutput",
    "PluginManager",
    "ProfileManager",
    "DisplayFormatter",
    "CursesTUI",
    "PtyBridge",
    "ShellCompletion",
    "Clipboard",
]
