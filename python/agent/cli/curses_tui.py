"""Curses TUI 界面。

提供终端全屏 TUI 界面能力：
  - 基于 curses 的全屏界面
  - 可选 textual 富 TUI 后端
  - 聊天界面布局（输入框 + 消息区 + 状态栏）
  - 键盘快捷键绑定
  - 主题/颜色方案
  - 自动降级（无 curses 时退化为行模式）

与 CliOutput 的关系：
  - CliOutput 提供行级输出
  - CursesTUI 提供全屏交互界面
  - 两者互为降级方案

集成示例::

    from agent.cli.curses_tui import CursesTUI

    tui = CursesTUI()
    tui.add_message("user", "你好")
    tui.add_message("assistant", "你好！有什么可以帮助你的？")
    await tui.run()
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from agent.core.logger import StructuredLogger, log_ignored
from agent.core.logger import StructuredLogger

log = StructuredLogger("curses_tui")



class TUIBackend(str, Enum):
    """TUI 后端。"""

    CURSES = "curses"
    TEXTUAL = "textual"
    FALLBACK = "fallback"


class Theme(str, Enum):
    """主题。"""

    DARK = "dark"
    LIGHT = "light"
    MONO = "mono"


@dataclass
class TUIConfig:
    """TUI 配置。

    Attributes:
        backend: TUI 后端。
        theme: 主题。
        show_status_bar: 是否显示状态栏。
        show_sidebar: 是否显示侧边栏。
        max_history: 最大消息历史数。
        scroll_offset: 滚动偏移。
    """

    backend: TUIBackend = TUIBackend.CURSES
    theme: Theme = Theme.DARK
    show_status_bar: bool = True
    show_sidebar: bool = False
    max_history: int = 1000
    scroll_offset: int = 0


@dataclass
class ChatMessage:
    """聊天消息。

    Attributes:
        role: 角色（user/assistant/system）。
        content: 内容。
        timestamp: 时间戳。
    """

    role: str = ""
    content: str = ""
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()


THEME_COLORS: dict[Theme, dict[str, tuple[int, int]]] = {
    Theme.DARK: {
        "user_msg": (2, 0),
        "assistant_msg": (6, 0),
        "system_msg": (3, 0),
        "status_bar": (0, 2),
        "input_box": (0, 4),
        "border": (4, 0),
    },
    Theme.LIGHT: {
        "user_msg": (4, 0),
        "assistant_msg": (2, 0),
        "system_msg": (6, 0),
        "status_bar": (7, 4),
        "input_box": (0, 7),
        "border": (0, 0),
    },
    Theme.MONO: {},
}


class CursesTUI:
    """Curses TUI 界面。

    提供终端全屏交互界面，支持 curses 和 textual 后端。
    """

    def __init__(self, config: TUIConfig | None = None) -> None:
        self._config = config or TUIConfig()
        self._messages: list[ChatMessage] = []
        self._status_text: str = ""
        self._input_text: str = ""
        self._running: bool = False
        self._on_submit: Callable[[str], Any] | None = None
        self._on_quit: Callable[[], Any] | None = None
        self._key_bindings: dict[int, Callable[[], Any]] = {}
        self._backend: Any = None

    @property
    def config(self) -> TUIConfig:
        return self._config

    @property
    def messages(self) -> list[ChatMessage]:
        return self._messages

    def add_message(self, role: str, content: str) -> None:
        """添加消息。

        Args:
            role: 角色。
            content: 内容。
        """
        msg = ChatMessage(role=role, content=content)
        self._messages.append(msg)
        if len(self._messages) > self._config.max_history:
            self._messages = self._messages[-self._config.max_history :]

    def set_status(self, text: str) -> None:
        """设置状态栏文本。"""
        self._status_text = text

    def on_submit(self, callback: Callable[[str], Any]) -> None:
        """设置提交回调。"""
        self._on_submit = callback

    def on_quit(self, callback: Callable[[], Any]) -> None:
        """设置退出回调。"""
        self._on_quit = callback

    def bind_key(self, key: int, callback: Callable[[], Any]) -> None:
        """绑定快捷键。"""
        self._key_bindings[key] = callback

    async def run(self) -> None:
        """运行 TUI 主循环。"""
        backend = self._detect_backend()
        self._config.backend = backend

        if backend == TUIBackend.TEXTUAL:
            await self._run_textual()
        elif backend == TUIBackend.CURSES:
            await self._run_curses()
        else:
            await self._run_fallback()

    def stop(self) -> None:
        """停止 TUI。"""
        self._running = False

    def _detect_backend(self) -> TUIBackend:
        """检测可用的 TUI 后端。"""
        if self._config.backend == TUIBackend.TEXTUAL:
            try:
                import textual

                return TUIBackend.TEXTUAL
            except ImportError as _exc:
                log_ignored(log, "curses_tui.CursesTUI._detect_backend", _exc)

        if self._config.backend == TUIBackend.CURSES or self._config.backend == TUIBackend.TEXTUAL:
            try:
                import curses

                if sys.stdout.isatty():
                    return TUIBackend.CURSES
            except ImportError as _exc:
                log_ignored(log, "curses_tui.CursesTUI._detect_backend", _exc)

        return TUIBackend.FALLBACK

    async def _run_curses(self) -> None:
        """运行 curses 后端。"""
        try:
            import curses

            self._running = True
            stdscr = curses.initscr()
            curses.start_color()
            curses.use_default_colors()
            curses.noecho()
            curses.cbreak()
            stdscr.keypad(True)
            curses.curs_set(1)

            try:
                while self._running:
                    self._render_curses(stdscr)
                    key = stdscr.getch()

                    if key == ord("q") or key == 27:
                        self._running = False
                        if self._on_quit:
                            self._on_quit()
                    elif key == curses.KEY_ENTER or key == 10 or key == 13:
                        if self._on_submit and self._input_text:
                            self._on_submit(self._input_text)
                            self._input_text = ""
                    elif key == curses.KEY_BACKSPACE or key == 127:
                        self._input_text = self._input_text[:-1]
                    elif 32 <= key < 256:
                        self._input_text += chr(key)

                    if key in self._key_bindings:
                        self._key_bindings[key]()
            finally:
                curses.nocbreak()
                stdscr.keypad(False)
                curses.echo()
                curses.endwin()

        except Exception as e:
            log.warning("Curses failed, falling back", error=str(e))
            await self._run_fallback()

    def _render_curses(self, stdscr: Any) -> None:
        """渲染 curses 界面。"""
        import curses

        height, width = stdscr.getmaxyx()
        msg_area_height = height - 3

        stdscr.clear()

        for i, msg in enumerate(self._messages[-msg_area_height:]):
            prefix = f"[{msg.role}]"
            line = f" {prefix} {msg.content[: width - len(prefix) - 3]}"
            try:
                stdscr.addstr(i, 0, line)
            except curses.error as _exc:
                log_ignored(log, "curses_tui.CursesTUI._render_curses", _exc)

        try:
            stdscr.addstr(height - 2, 0, "-" * width)
        except curses.error as _exc:
            log_ignored(log, "curses_tui.CursesTUI._render_curses", _exc)

        try:
            stdscr.addstr(height - 1, 0, f"> {self._input_text}")
        except curses.error as _exc:
            log_ignored(log, "curses_tui.CursesTUI._render_curses", _exc)

        if self._config.show_status_bar and self._status_text:
            try:
                stdscr.addstr(0, width - len(self._status_text) - 1, self._status_text)
            except curses.error as _exc:
                log_ignored(log, "curses_tui.CursesTUI._render_curses", _exc)

        stdscr.refresh()

    async def _run_textual(self) -> None:
        """运行 textual 后端。"""
        try:
            from textual.app import App, ComposeResult
            from textual.widgets import Header, Footer, Static, Input
            from textual.containers import Container, VerticalScroll

            class ChatApp(App):
                TITLE = "Jiabaixing Agent"

                def compose(self) -> ComposeResult:
                    yield Header()
                    with VerticalScroll(id="messages"):
                        for msg in self._tui._messages:
                            yield Static(f"[{msg.role}] {msg.content}")
                    yield Input(placeholder="输入消息...", id="input")
                    yield Footer()

                def __init__(self, tui: CursesTUI) -> None:
                    super().__init__()
                    self._tui = tui

                def on_input_submitted(self, event: Input.Submitted) -> None:
                    if self._tui._on_submit:
                        self._tui._on_submit(event.value)
                    event.input.value = ""

            app = ChatApp(self)
            await app.run_async()

        except Exception as e:
            log.warning("Textual failed, falling back", error=str(e))
            await self._run_fallback()

    async def _run_fallback(self) -> None:
        """运行行模式降级后端。"""
        self._running = True
        print("Jiabaixing Agent (行模式 — 输入 /quit 退出)")
        print("-" * 40)

        while self._running:
            try:
                for msg in self._messages[-20:]:
                    print(f"  [{msg.role}] {msg.content}")
                self._messages.clear()

                line = input("> ")
                if line.strip() == "/quit":
                    self._running = False
                    if self._on_quit:
                        self._on_quit()
                    break

                if self._on_submit:
                    result = self._on_submit(line)
                    if hasattr(result, "__await__"):
                        await result
            except EOFError:
                self._running = False
            except KeyboardInterrupt:
                self._running = False
