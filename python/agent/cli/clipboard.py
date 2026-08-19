"""跨平台剪贴板工具。

提供跨平台的剪贴板读写能力：
  - 文本复制到剪贴板
  - 从剪贴板粘贴文本
  - 自动检测平台剪贴板工具
  - 降级方案（无剪贴板工具时使用临时文件）
  - 剪贴板内容类型检测

集成示例::

    from agent.cli.clipboard import Clipboard

    cb = Clipboard()
    cb.copy("Hello, World!")
    text = cb.paste()
    print(text)  # "Hello, World!"
"""

from __future__ import annotations

import os
import shutil
from agent.infrastructure.subprocess_util import run
import sys
import tempfile
from dataclasses import dataclass
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("clipboard")


class ClipboardBackend(str, Enum):
    """剪贴板后端。"""

    PBcopy = "pbcopy"
    XCLIP = "xclip"
    XSEL = "xsel"
    WL_COPY = "wl-copy"
    CLIP = "clip"
    TERMUX = "termux"
    FILE = "file"


@dataclass
class ClipboardInfo:
    """剪贴板信息。

    Attributes:
        backend: 使用的后端。
        available: 是否可用。
    """

    backend: ClipboardBackend = ClipboardBackend.FILE
    available: bool = False


class Clipboard:
    """跨平台剪贴板工具。

    自动检测平台剪贴板工具，提供读写能力。
    """

    def __init__(self) -> None:
        self._backend = self._detect_backend()
        self._info = ClipboardInfo(
            backend=self._backend,
            available=self._backend != ClipboardBackend.FILE or True,
        )

    @property
    def info(self) -> ClipboardInfo:
        return self._info

    def copy(self, text: str) -> bool:
        """复制文本到剪贴板。

        Args:
            text: 要复制的文本。

        Returns:
            是否成功。
        """
        try:
            if self._backend == ClipboardBackend.PBcopy:
                return self._copy_pbcopy(text)
            elif self._backend == ClipboardBackend.XCLIP:
                return self._copy_xclip(text)
            elif self._backend == ClipboardBackend.XSEL:
                return self._copy_xsel(text)
            elif self._backend == ClipboardBackend.WL_COPY:
                return self._copy_wl_copy(text)
            elif self._backend == ClipboardBackend.CLIP:
                return self._copy_clip(text)
            elif self._backend == ClipboardBackend.TERMUX:
                return self._copy_termux(text)
            else:
                return self._copy_file(text)
        except Exception as e:
            log.warning("Clipboard copy failed", backend=self._backend.value, error=str(e))
            return self._copy_file(text)

    def paste(self) -> str:
        """从剪贴板粘贴文本。

        Returns:
            剪贴板文本内容。
        """
        try:
            if self._backend == ClipboardBackend.PBcopy:
                return self._paste_pbpaste()
            elif self._backend == ClipboardBackend.XCLIP:
                return self._paste_xclip()
            elif self._backend == ClipboardBackend.XSEL:
                return self._paste_xsel()
            elif self._backend == ClipboardBackend.WL_COPY:
                return self._paste_wl_paste()
            elif self._backend == ClipboardBackend.CLIP:
                return self._paste_powershell()
            elif self._backend == ClipboardBackend.TERMUX:
                return self._paste_termux()
            else:
                return self._paste_file()
        except Exception as e:
            log.warning("Clipboard paste failed", backend=self._backend.value, error=str(e))
            return ""

    def clear(self) -> bool:
        """清空剪贴板。"""
        return self.copy("")

    def _detect_backend(self) -> ClipboardBackend:
        """检测可用的剪贴板后端。"""
        if sys.platform == "darwin":
            if shutil.which("pbcopy"):
                return ClipboardBackend.PBcopy
        elif sys.platform == "win32":
            return ClipboardBackend.CLIP
        elif sys.platform == "linux":
            if os.environ.get("WAYLAND_DISPLAY"):
                if shutil.which("wl-copy"):
                    return ClipboardBackend.WL_COPY
            if shutil.which("xclip"):
                return ClipboardBackend.XCLIP
            if shutil.which("xsel"):
                return ClipboardBackend.XSEL
        if shutil.which("termux-clipboard-set"):
            return ClipboardBackend.TERMUX
        return ClipboardBackend.FILE

    def _copy_pbcopy(self, text: str) -> bool:
        proc = run(["pbcopy"], input=text.encode(), capture_output=True)
        return proc.returncode == 0

    def _paste_pbpaste(self) -> str:
        proc = run(["pbpaste"], capture_output=True, text=True)
        return proc.stdout if proc.returncode == 0 else ""

    def _copy_xclip(self, text: str) -> bool:
        proc = run(
            ["xclip", "-selection", "clipboard"],
            input=text.encode(),
            capture_output=True,
        )
        return proc.returncode == 0

    def _paste_xclip(self) -> str:
        proc = run(
            ["xclip", "-selection", "clipboard", "-o"],
            capture_output=True,
            text=True,
        )
        return proc.stdout if proc.returncode == 0 else ""

    def _copy_xsel(self, text: str) -> bool:
        proc = run(
            ["xsel", "--clipboard", "--input"],
            input=text.encode(),
            capture_output=True,
        )
        return proc.returncode == 0

    def _paste_xsel(self) -> str:
        proc = run(
            ["xsel", "--clipboard", "--output"],
            capture_output=True,
            text=True,
        )
        return proc.stdout if proc.returncode == 0 else ""

    def _copy_wl_copy(self, text: str) -> bool:
        proc = run(["wl-copy"], input=text.encode(), capture_output=True)
        return proc.returncode == 0

    def _paste_wl_paste(self) -> str:
        proc = run(["wl-paste"], capture_output=True, text=True)
        return proc.stdout if proc.returncode == 0 else ""

    def _copy_clip(self, text: str) -> bool:
        proc = run(["clip"], input=text.encode(), capture_output=True)
        return proc.returncode == 0

    def _paste_powershell(self) -> str:
        proc = run(
            ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
            capture_output=True,
            text=True,
        )
        return proc.stdout.strip() if proc.returncode == 0 else ""

    def _copy_termux(self, text: str) -> bool:
        proc = run(
            ["termux-clipboard-set"],
            input=text.encode(),
            capture_output=True,
        )
        return proc.returncode == 0

    def _paste_termux(self) -> str:
        proc = run(
            ["termux-clipboard-get"],
            capture_output=True,
            text=True,
        )
        return proc.stdout if proc.returncode == 0 else ""

    def _copy_file(self, text: str) -> bool:
        try:
            path = os.path.join(tempfile.gettempdir(), "jiabaixing_clipboard.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            return True
        except Exception:
            return False

    def _paste_file(self) -> str:
        try:
            path = os.path.join(tempfile.gettempdir(), "jiabaixing_clipboard.txt")
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    return f.read()
        except Exception as _exc:
            log_ignored(log, "clipboard.Clipboard._paste_file", _exc)
        return ""
