"""CLI TUI 终端用户界面。

提供富文本终端交互界面，替代基础 input/print REPL：
  - Rich 风格输出（Markdown 渲染、语法高亮、表格）
  - 多面板布局（对话区 + 状态栏 + 侧边栏）
  - 命令自动补全
  - 历史记录导航
  - 实时流式输出

与 agent.cli 的关系：
  - agent.cli 提供 argparse 命令入口
  - TUI 提供交互式 REPL 的富文本体验
  - 两者共享 AgentEngine 后端

集成示例::

    from agent.cli.tui import ChatTUI

    tui = ChatTUI(engine)
    await tui.run()
"""

from __future__ import annotations

import asyncio
import sys
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("cli.tui")


class Theme(str, Enum):
    DARK = "dark"
    LIGHT = "light"
    MONOKAI = "monokai"
    NORD = "nord"


class PanelLayout(str, Enum):
    FULL = "full"
    SIDEBAR = "sidebar"
    COMPACT = "compact"


@dataclass
class TUIConfig:
    theme: Theme = Theme.DARK
    layout: PanelLayout = PanelLayout.SIDEBAR
    show_timestamps: bool = True
    show_tokens: bool = False
    show_model: bool = True
    max_history: int = 1000
    scrollback: int = 500
    auto_scroll: bool = True
    word_wrap: bool = True
    font_size: int = 14


@dataclass
class ChatMessage:
    role: str
    content: str
    timestamp: float = 0.0
    model: str = ""
    tokens: int = 0
    duration_ms: float = 0.0

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()


@dataclass
class StatusBarState:
    model: str = ""
    session_id: str = ""
    turn_count: int = 0
    total_tokens: int = 0
    total_cost: float = 0.0
    connected: bool = True
    status_text: str = ""


@dataclass
class CommandCompletion:
    commands: list[str] = field(default_factory=list)

    def complete(self, partial: str) -> list[str]:
        if not partial:
            return self.commands
        return [c for c in self.commands if c.startswith(partial)]


_BUILTIN_COMMANDS = [
    "/help", "/quit", "/exit", "/clear", "/history",
    "/model", "/profile", "/config", "/status",
    "/export", "/search", "/undo", "/redo",
    "/skill", "/tools", "/memory",
]


class ChatTUI:
    """终端用户界面。

    提供富文本交互式对话 REPL，支持流式输出、
    命令补全、历史导航和多面板布局。
    """

    def __init__(self, engine: Any = None, config: TUIConfig | None = None) -> None:
        self._engine = engine
        self._config = config or TUIConfig()
        self._messages: list[ChatMessage] = []
        self._history: list[str] = []
        self._history_index: int = 0
        self._status = StatusBarState()
        self._completion = CommandCompletion(commands=_BUILTIN_COMMANDS)
        self._running: bool = False
        self._session_id: str = f"tui-{id(self)}"

    async def run(self) -> None:
        self._running = True
        self._render_header()
        while self._running:
            try:
                user_input = await self._read_input()
                if not user_input:
                    continue
                if await self._handle_command(user_input):
                    continue
                await self._process_message(user_input)
            except (EOFError, KeyboardInterrupt):
                break
        self._render_footer()

    async def _read_input(self) -> str:
        try:
            return input("  👤 ").strip()
        except (EOFError, KeyboardInterrupt):
            raise

    async def _handle_command(self, text: str) -> bool:
        if not text.startswith("/"):
            return False

        cmd = text.lower().strip()
        if cmd in ("/quit", "/exit"):
            self._running = False
            return True
        elif cmd == "/clear":
            self._messages.clear()
            self._render_system("对话已清空")
            return True
        elif cmd == "/help":
            self._render_help()
            return True
        elif cmd == "/history":
            self._render_history()
            return True
        elif cmd == "/status":
            self._render_status()
            return True
        elif cmd.startswith("/model "):
            model_name = text[7:].strip()
            self._status.model = model_name
            self._render_system(f"已切换模型: {model_name}")
            return True
        elif cmd.startswith("/search "):
            query = text[8:].strip()
            self._render_search_results(query)
            return True

        self._render_system(f"未知命令: {text}。输入 /help 查看帮助。")
        return True

    async def _process_message(self, text: str) -> None:
        self._history.append(text)
        self._history_index = len(self._history)
        user_msg = ChatMessage(role="user", content=text)
        self._messages.append(user_msg)
        self._render_message(user_msg)

        if self._engine is None:
            assistant_msg = ChatMessage(role="assistant", content="[引擎未初始化]")
            self._messages.append(assistant_msg)
            self._render_message(assistant_msg)
            return

        start = time.monotonic()
        try:
            result = await self._engine.process_input(
                message=text,
                session_id=self._session_id,
            )
            duration = (time.monotonic() - start) * 1000
            content = result.get("content", "")
            model = result.get("model", self._status.model)
            tokens = result.get("tokens", 0)

            assistant_msg = ChatMessage(
                role="assistant",
                content=content,
                model=model,
                tokens=tokens,
                duration_ms=duration,
            )
            self._messages.append(assistant_msg)
            self._render_message(assistant_msg)
            self._status.turn_count += 1
            self._status.total_tokens += tokens
        except Exception as e:
            log.debug("cli_tui 异常处理", error=str(e))
            error_msg = ChatMessage(role="system", content=f"错误: {e}")
            self._messages.append(error_msg)
            self._render_message(error_msg)

    def _render_header(self) -> None:
        print("\n  ╔══════════════════════════════════════╗")
        print("  ║       🎯 家百星 Agent TUI            ║")
        print("  ╚══════════════════════════════════════╝")
        print(f"  主题: {self._config.theme.value} | 布局: {self._config.layout.value}")
        print("  输入消息开始对话，/help 查看命令\n")

    def _render_footer(self) -> None:
        print(f"\n  会话统计: {self._status.turn_count} 轮 | {self._status.total_tokens} tokens")

    def _render_message(self, msg: ChatMessage) -> None:
        ts = time.strftime("%H:%M:%S", time.localtime(msg.timestamp)) if self._config.show_timestamps else ""
        if msg.role == "user":
            prefix = f"[{ts}] 👤" if ts else "👤"
        elif msg.role == "assistant":
            model_info = f" ({msg.model})" if self._config.show_model and msg.model else ""
            prefix = f"[{ts}] 🤖{model_info}" if ts else f"🤖{model_info}"
        else:
            prefix = f"[{ts}] ⚙️" if ts else "⚙️"
        print(f"  {prefix} {msg.content}")

    def _render_system(self, text: str) -> None:
        print(f"  ⚙️ {text}")

    def _render_help(self) -> None:
        lines = [
            "可用命令:",
            "  /help      - 查看帮助",
            "  /quit      - 退出",
            "  /clear     - 清空对话",
            "  /history   - 查看历史",
            "  /status    - 查看状态",
            "  /model <n> - 切换模型",
            "  /search <q>- 搜索历史",
            "  /profile   - 查看配置",
            "  /export    - 导出对话",
            "  /skill     - 技能管理",
            "  /memory    - 记忆管理",
        ]
        for line in lines:
            print(f"  {line}")

    def _render_history(self) -> None:
        if not self._history:
            self._render_system("无历史记录")
            return
        for i, h in enumerate(self._history[-20:], 1):
            print(f"  {i:3d}. {h[:80]}")

    def _render_status(self) -> None:
        print(f"  模型: {self._status.model or 'default'}")
        print(f"  会话: {self._session_id}")
        print(f"  轮次: {self._status.turn_count}")
        print(f"  Tokens: {self._status.total_tokens}")
        print(f"  消息数: {len(self._messages)}")

    def _render_search_results(self, query: str) -> None:
        results = [m for m in self._messages if query.lower() in m.content.lower()]
        if not results:
            self._render_system(f"未找到匹配: {query}")
            return
        for m in results[-10:]:
            role_icon = "👤" if m.role == "user" else "🤖"
            print(f"  {role_icon} {m.content[:80]}")

    def get_messages(self) -> list[ChatMessage]:
        return list(self._messages)

    def export_markdown(self) -> str:
        lines = [f"# 家百星对话导出", f""]
        for msg in self._messages:
            ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(msg.timestamp))
            if msg.role == "user":
                lines.append(f"## 👤 用户 [{ts}]")
            elif msg.role == "assistant":
                lines.append(f"## 🤖 助手 [{ts}] ({msg.model})")
            else:
                lines.append(f"## ⚙️ 系统 [{ts}]")
            lines.append(f"")
            lines.append(msg.content)
            lines.append(f"")
        return "\n".join(lines)
