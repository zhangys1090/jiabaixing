"""Shell 自动补全生成器。

为 Jiabaixing CLI 生成 Shell 自动补全脚本：
  - Bash 补全
  - Zsh 补全
  - Fish 补全
  - PowerShell 补全
  - 命令/选项/参数补全定义
  - 动态补全（子命令、模型列表等）

集成示例::

    from agent.cli.shell_completion import ShellCompletion

    comp = ShellCompletion()
    comp.add_command("chat", description="开始对话")
    comp.add_option("chat", "--model", values=["gpt-4o", "claude-3"])
    script = comp.generate("bash")
    print(script)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("shell_completion")


class ShellType(str, Enum):
    """Shell 类型。"""

    BASH = "bash"
    ZSH = "zsh"
    FISH = "fish"
    POWERSHELL = "powershell"


@dataclass
class CompletionOption:
    """补全选项。

    Attributes:
        name: 选项名（如 --model）。
        short: 短选项（如 -m）。
        description: 描述。
        values: 可选值列表。
        value_hint: 值提示（如 "MODEL"）。
        is_flag: 是否为标志（无值）。
    """

    name: str = ""
    short: str = ""
    description: str = ""
    values: list[str] = field(default_factory=list)
    value_hint: str = ""
    is_flag: bool = False


@dataclass
class CompletionCommand:
    """补全命令。

    Attributes:
        name: 命令名。
        description: 描述。
        subcommands: 子命令。
        options: 选项列表。
        arguments: 参数列表。
    """

    name: str = ""
    description: str = ""
    subcommands: dict[str, "CompletionCommand"] = field(default_factory=dict)
    options: list[CompletionOption] = field(default_factory=list)
    arguments: list[str] = field(default_factory=list)


class ShellCompletion:
    """Shell 自动补全生成器。

    为 CLI 生成多种 Shell 的自动补全脚本。
    """

    def __init__(self, app_name: str = "jiabaixing") -> None:
        self._app_name = app_name
        self._root = CompletionCommand(name=app_name, description="Jiabaixing AI Agent CLI")

    def add_command(
        self,
        name: str,
        description: str = "",
        parent: str = "",
    ) -> CompletionCommand:
        """添加命令。

        Args:
            name: 命令名。
            description: 描述。
            parent: 父命令名。

        Returns:
            CompletionCommand 命令对象。
        """
        cmd = CompletionCommand(name=name, description=description)
        if parent:
            parent_cmd = self._find_command(parent, self._root)
            if parent_cmd:
                parent_cmd.subcommands[name] = cmd
        else:
            self._root.subcommands[name] = cmd
        return cmd

    def add_option(
        self,
        command: str,
        name: str,
        short: str = "",
        description: str = "",
        values: list[str] | None = None,
        value_hint: str = "",
        is_flag: bool = False,
    ) -> None:
        """添加选项。

        Args:
            command: 命令名。
            name: 选项名。
            short: 短选项。
            description: 描述。
            values: 可选值列表。
            value_hint: 值提示。
            is_flag: 是否为标志。
        """
        cmd = self._find_command(command, self._root)
        if cmd:
            cmd.options.append(CompletionOption(
                name=name,
                short=short,
                description=description,
                values=values or [],
                value_hint=value_hint,
                is_flag=is_flag,
            ))

    def generate(self, shell: ShellType | None = None) -> str:
        """生成补全脚本。

        Args:
            shell: Shell 类型（None 自动检测）。

        Returns:
            补全脚本文本。
        """
        st = shell or self._detect_shell()
        if st == ShellType.BASH:
            return self._generate_bash()
        elif st == ShellType.ZSH:
            return self._generate_zsh()
        elif st == ShellType.FISH:
            return self._generate_fish()
        elif st == ShellType.POWERSHELL:
            return self._generate_powershell()
        return self._generate_bash()

    def _detect_shell(self) -> ShellType:
        """检测当前 Shell。"""
        if sys.platform == "win32":
            return ShellType.POWERSHELL

        import os

        shell_path = os.environ.get("SHELL", "")
        if "zsh" in shell_path:
            return ShellType.ZSH
        if "fish" in shell_path:
            return ShellType.FISH
        return ShellType.BASH

    def _find_command(self, name: str, root: CompletionCommand) -> CompletionCommand | None:
        """查找命令。"""
        if root.name == name:
            return root
        for sub in root.subcommands.values():
            found = self._find_command(name, sub)
            if found:
                return found
        return None

    def _generate_bash(self) -> str:
        """生成 Bash 补全脚本。"""
        lines: list[str] = []
        app = self._app_name
        lines.append(f"#!/bin/bash")
        lines.append(f"# {app} bash completion")
        lines.append(f'_{app}_completions() {{')
        lines.append(f'  local cur prev words cword')
        lines.append(f'  _init_completion || return')
        lines.append(f'')
        lines.append(f'  local commands=""')
        for name, cmd in self._root.subcommands.items():
            lines.append(f'  commands="$commands {name}"')
        lines.append(f'')
        lines.append(f'  if [[ ${{cword}} -eq 1 ]]; then')
        lines.append(f'    COMPREPLY=($(compgen -W "$commands" -- $cur))')
        lines.append(f'    return')
        lines.append(f'  fi')
        lines.append(f'')

        for name, cmd in self._root.subcommands.items():
            opts = " ".join(o.name for o in cmd.options)
            shorts = " ".join(o.short for o in cmd.options if o.short)
            all_opts = f"{opts} {shorts}".strip()
            if all_opts:
                lines.append(f'  if [[ ${{prev}} == "{name}" ]]; then')
                lines.append(f'    COMPREPLY=($(compgen -W "{all_opts}" -- $cur))')
                lines.append(f'    return')
                lines.append(f'  fi')

        for name, cmd in self._root.subcommands.items():
            for opt in cmd.options:
                if opt.values:
                    vals = " ".join(opt.values)
                    lines.append(f'  if [[ ${{prev}} == "{opt.name}" ]] || [[ ${{prev}} == "{opt.short}" ]]; then')
                    lines.append(f'    COMPREPLY=($(compgen -W "{vals}" -- $cur))')
                    lines.append(f'    return')
                    lines.append(f'  fi')

        lines.append(f'  COMPREPLY=()')
        lines.append(f'}}')
        lines.append(f'complete -F _{app}_completions {app}')
        return "\n".join(lines)

    def _generate_zsh(self) -> str:
        """生成 Zsh 补全脚本。"""
        lines: list[str] = []
        app = self._app_name
        lines.append(f"#compdef {app}")
        lines.append(f"# {app} zsh completion")
        lines.append(f'')
        lines.append(f'_{app}() {{')
        lines.append(f'  local -a commands')
        lines.append(f'  commands=(')
        for name, cmd in self._root.subcommands.items():
            desc = cmd.description.replace("'", "'\\''")
            lines.append(f"    '{name}:{desc}'")
        lines.append(f'  )')
        lines.append(f'')
        lines.append(f'  _arguments -C \\')
        lines.append(f'    "1:command:->command" \\')
        lines.append(f'    "*::arg:->args"')
        lines.append(f'')
        lines.append(f'  case $state in')
        lines.append(f'    command)')
        lines.append(f'      _describe "command" commands')
        lines.append(f'      ;;')
        lines.append(f'    args)')
        lines.append(f'      case $words[1] in')

        for name, cmd in self._root.subcommands.items():
            if cmd.options:
                opt_args = []
                for opt in cmd.options:
                    if opt.is_flag:
                        opt_args.append(f"'{opt.name}[{opt.description}]'")
                    elif opt.values:
                        vals = "(" + " ".join(opt.values) + ")"
                        opt_args.append(f"'{opt.name}::{opt.value_hint or opt.name}:{vals}'")
                    else:
                        opt_args.append(f"'{opt.name}:{opt.value_hint or opt.name}:'")
                lines.append(f'        {name})')
                lines.append(f'          _arguments {" ".join(opt_args)}')
                lines.append(f'          ;;')

        lines.append(f'      esac')
        lines.append(f'      ;;')
        lines.append(f'  esac')
        lines.append(f'}}')
        lines.append(f'_{app}')
        return "\n".join(lines)

    def _generate_fish(self) -> str:
        """生成 Fish 补全脚本。"""
        lines: list[str] = []
        app = self._app_name
        lines.append(f"# {app} fish completion")

        for name, cmd in self._root.subcommands.items():
            desc = cmd.description.replace("'", "'\\''")
            lines.append(f"complete -c {app} -n '__fish_use_subcommand' -a '{name}' -d '{desc}'")

        for name, cmd in self._root.subcommands.items():
            for opt in cmd.options:
                opt_desc = opt.description.replace("'", "'\\''")
                args = f"-l {opt.name[2:]}" if opt.name.startswith("--") else f"-o {opt.name[1:]}"
                if opt.short:
                    args += f" -s {opt.short[1:]}"
                if opt.values:
                    vals = " ".join(opt.values)
                    lines.append(f"complete -c {app} -n '__fish_seen_subcommand_from {name}' {args} -d '{opt_desc}' -r -f -a '{vals}'")
                else:
                    lines.append(f"complete -c {app} -n '__fish_seen_subcommand_from {name}' {args} -d '{opt_desc}'")

        return "\n".join(lines)

    def _generate_powershell(self) -> str:
        """生成 PowerShell 补全脚本。"""
        lines: list[str] = []
        app = self._app_name
        lines.append(f"# {app} PowerShell completion")
        lines.append(f'Register-ArgumentCompleter -Native -CommandName {app} -ScriptBlock {{')
        lines.append(f'  param($commandName, $wordToComplete, $cursorPosition)')
        lines.append(f'  $completions = @()')
        lines.append(f'')
        lines.append(f'  if ($wordToComplete -eq "" -or $wordToComplete.StartsWith("-")) {{')

        for name, cmd in self._root.subcommands.items():
            lines.append(f'    $completions += "{name}"')

        lines.append(f'  }}')
        lines.append(f'')
        lines.append(f'  $completions | Where-Object {{ $_ -like "$wordToComplete*" }} | ForEach-Object {{')
        lines.append(f'    [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)')
        lines.append(f'  }}')
        lines.append(f'}}')
        return "\n".join(lines)
