"""网关斜杠命令系统。

在消息平台内提供快捷斜杠命令（/help, /model, /skill 等），
用户无需切换界面即可执行常用操作。

与 Hook 系统的集成：
  - SlashCommandManager 注册为 PRE_DISPATCH Hook
  - 拦截以 / 开头的消息，路由到对应命令处理器
  - 非斜杠命令消息正常传递

集成示例::

    from agent.gateway.slash_commands import SlashCommandManager

    mgr = SlashCommandManager()
    mgr.register_defaults()
    result = await mgr.try_handle(message)
"""

from __future__ import annotations

import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.gateway.base import Message
from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.slash_commands")


class CommandScope(str, Enum):
    ALL = "all"
    ADMIN = "admin"
    OWNER = "owner"


@dataclass
class SlashCommand:
    name: str
    handler: Callable[..., Awaitable[str]]
    desc: str = ""
    usage: str = ""
    scope: CommandScope = CommandScope.ALL
    aliases: list[str] = field(default_factory=list)
    enabled: bool = True
    call_count: int = 0
    last_called: float = 0.0


@dataclass
class CommandResult:
    success: bool
    output: str
    command: str = ""
    args: str = ""
    duration_ms: float = 0.0


@dataclass
class CommandAccess:
    user_permissions: dict[str, list[str]] = field(default_factory=dict)

    def is_allowed(self, user: str, command_name: str, command_scope: CommandScope) -> bool:
        if command_scope == CommandScope.ALL:
            return True
        perms = self.user_permissions.get(user, [])
        if command_scope == CommandScope.ADMIN and "admin" in perms:
            return True
        if command_scope == CommandScope.OWNER and "owner" in perms:
            return True
        return False


_SLASH_PATTERN = re.compile(r"^/(\w+)(?:\s+(.*))?$")


class SlashCommandManager:
    """斜杠命令管理器。

    注册、发现和执行斜杠命令。支持权限控制和帮助信息生成。
    """

    def __init__(self) -> None:
        self._commands: OrderedDict[str, SlashCommand] = OrderedDict()
        self._aliases: dict[str, str] = {}
        self._access = CommandAccess()

    def command(
        self,
        name: str,
        desc: str = "",
        usage: str = "",
        scope: CommandScope = CommandScope.ALL,
        aliases: list[str] | None = None,
    ) -> Callable:
        """装饰器方式注册斜杠命令。"""
        def decorator(func: Callable[..., Awaitable[str]]) -> Callable[..., Awaitable[str]]:
            cmd = SlashCommand(
                name=name,
                handler=func,
                desc=desc,
                usage=usage or f"/{name}",
                scope=scope,
                aliases=aliases or [],
            )
            self._commands[name] = cmd
            for alias in (aliases or []):
                self._aliases[alias] = name
            return func
        return decorator

    def add_command(
        self,
        name: str,
        handler: Callable[..., Awaitable[str]],
        desc: str = "",
        usage: str = "",
        scope: CommandScope = CommandScope.ALL,
        aliases: list[str] | None = None,
    ) -> None:
        cmd = SlashCommand(
            name=name,
            handler=handler,
            desc=desc,
            usage=usage or f"/{name}",
            scope=scope,
            aliases=aliases or [],
        )
        self._commands[name] = cmd
        for alias in (aliases or []):
            self._aliases[alias] = name

    def remove_command(self, name: str) -> bool:
        cmd = self._commands.pop(name, None)
        if cmd is None:
            return False
        for alias in cmd.aliases:
            self._aliases.pop(alias, None)
        return True

    def enable_command(self, name: str) -> None:
        if name in self._commands:
            self._commands[name].enabled = True

    def disable_command(self, name: str) -> None:
        if name in self._commands:
            self._commands[name].enabled = False

    def set_user_permissions(self, user: str, permissions: list[str]) -> None:
        self._access.user_permissions[user] = permissions

    def _resolve_command(self, name: str) -> SlashCommand | None:
        cmd = self._commands.get(name)
        if cmd:
            return cmd
        alias_target = self._aliases.get(name)
        if alias_target:
            return self._commands.get(alias_target)
        return None

    def _parse_message(self, content: str) -> tuple[str, str] | None:
        content = content.strip()
        match = _SLASH_PATTERN.match(content)
        if not match:
            return None
        return match.group(1), (match.group(2) or "").strip()

    async def try_handle(self, message: Message, **kwargs: Any) -> CommandResult | None:
        """尝试处理斜杠命令。如果不是斜杠命令返回 None。"""
        parsed = self._parse_message(message.content)
        if parsed is None:
            return None

        cmd_name, cmd_args = parsed
        cmd = self._resolve_command(cmd_name)

        if cmd is None:
            return CommandResult(
                success=False,
                output=f"未知命令: /{cmd_name}。输入 /help 查看所有命令。",
                command=cmd_name,
                args=cmd_args,
            )

        if not cmd.enabled:
            return CommandResult(
                success=False,
                output=f"命令 /{cmd_name} 已禁用。",
                command=cmd_name,
                args=cmd_args,
            )

        if not self._access.is_allowed(message.sender, cmd_name, cmd.scope):
            return CommandResult(
                success=False,
                output=f"权限不足: /{cmd_name} 需要 {cmd.scope.value} 权限。",
                command=cmd_name,
                args=cmd_args,
            )

        start = time.monotonic()
        try:
            output = await cmd.handler(cmd_args, message, **kwargs)
            duration = (time.monotonic() - start) * 1000
            cmd.call_count += 1
            cmd.last_called = time.time()
            return CommandResult(
                success=True,
                output=output,
                command=cmd_name,
                args=cmd_args,
                duration_ms=duration,
            )
        except Exception as e:
            duration = (time.monotonic() - start) * 1000
            log.error("斜杠命令执行失败", command=cmd_name, error=str(e))
            return CommandResult(
                success=False,
                output=f"命令 /{cmd_name} 执行失败: {e}",
                command=cmd_name,
                args=cmd_args,
                duration_ms=duration,
            )

    def is_slash_command(self, content: str) -> bool:
        return _SLASH_PATTERN.match(content.strip()) is not None

    def format_help(self) -> str:
        lines = ["可用命令:"]
        for cmd in self._commands.values():
            if not cmd.enabled:
                continue
            alias_str = f" (别名: {', '.join(f'/{a}' for a in cmd.aliases)})" if cmd.aliases else ""
            scope_str = f" [{cmd.scope.value}]" if cmd.scope != CommandScope.ALL else ""
            lines.append(f"  {cmd.usage}{alias_str}{scope_str} - {cmd.desc}")
        return "\n".join(lines)

    def get_command_list(self) -> list[dict[str, Any]]:
        result = []
        for cmd in self._commands.values():
            result.append({
                "name": cmd.name,
                "desc": cmd.desc,
                "usage": cmd.usage,
                "scope": cmd.scope.value,
                "aliases": cmd.aliases,
                "enabled": cmd.enabled,
                "call_count": cmd.call_count,
            })
        return result

    def register_defaults(self) -> None:
        """注册内置默认命令。"""

        @self.command("help", desc="查看所有可用命令", aliases=["h", "?"])
        async def cmd_help(args: str, message: Message, **kwargs: Any) -> str:
            return self.format_help()

        @self.command("ping", desc="检查服务状态")
        async def cmd_ping(args: str, message: Message, **kwargs: Any) -> str:
            return "pong"

        @self.command("echo", desc="回显消息", usage="/echo <text>")
        async def cmd_echo(args: str, message: Message, **kwargs: Any) -> str:
            return args or "(empty)"

        @self.command("commands", desc="查看命令统计", scope=CommandScope.ADMIN)
        async def cmd_commands(args: str, message: Message, **kwargs: Any) -> str:
            lines = ["命令统计:"]
            for cmd in self._commands.values():
                lines.append(f"  /{cmd.name}: 调用 {cmd.call_count} 次")
            return "\n".join(lines)
