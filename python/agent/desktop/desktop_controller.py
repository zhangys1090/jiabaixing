"""
DesktopController - Python原生桌面控制器
封装鼠标、键盘、窗口、截图、剪贴板等基础桌面操作
不依赖TS后端，纯Python实现

支持的后端：
- Pillow (截图)
- pyautogui (鼠标键盘，可选)
- pywin32 (Windows窗口管理，可选)
- ctypes (Windows API，内置)

设计原则：
- 渐进式降级：优先使用高级库，不可用时降级到基础API
- 统一接口：所有操作都有一致的返回格式
- 安全第一：危险操作有明确标记和防护
"""

from __future__ import annotations

import os
import time
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from agent.config import DATA_ROOT
from agent.core.logger import log_ignored
import logging
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# 数据结构定义
# ─────────────────────────────────────────────────────────────

@dataclass
class Point:
    """坐标点"""
    x: int
    y: int


@dataclass
class Rect:
    """矩形区域"""
    x: int
    y: int
    width: int
    height: int

    @property
    def center(self) -> Point:
        return Point(self.x + self.width // 2, self.y + self.height // 2)


@dataclass
class WindowInfo:
    """窗口信息"""
    handle: int
    title: str
    process_name: str = ""
    bounds: Rect = field(default_factory=lambda: Rect(0, 0, 0, 0))
    is_visible: bool = True
    is_minimized: bool = False
    is_maximized: bool = False


@dataclass
class ScreenshotResult:
    """截图结果"""
    success: bool
    image_path: str = ""
    width: int = 0
    height: int = 0
    error: str = ""
    image_data: bytes = b""


@dataclass
class ActionResult:
    """动作执行结果"""
    success: bool
    action: str
    output: str = ""
    error: str = ""
    duration: float = 0.0


# ─────────────────────────────────────────────────────────────
# 桌面控制器
# ─────────────────────────────────────────────────────────────

class DesktopController:
    """
    桌面控制器 - 封装所有基础桌面操作

    支持的操作：
    - 鼠标：点击、右键、双击、移动、拖拽、滚动
    - 键盘：输入文字、按键、组合键
    - 截图：全屏、区域、窗口
    - 窗口：列出、激活、关闭、最大化、最小化
    - 剪贴板：读取、写入
    - Shell：执行命令
    """

    def __init__(self, data_dir: str | None = None):
        self._data_dir = Path(data_dir) if data_dir else Path(os.environ.get("DATA_DIR", str(DATA_ROOT)))
        self._screenshot_dir = self._data_dir / "screenshots"
        self._screenshot_dir.mkdir(parents=True, exist_ok=True)

        # 能力检测
        self._has_pillow = self._check_pillow()
        self._has_pyautogui = self._check_pyautogui()
        self._has_pywin32 = self._check_pywin32()
        self._is_windows = os.name == "nt"

        # 懒加载的对象
        self._pyautogui = None
        self._win32gui = None
        self._win32con = None

    # ─────────────────────────────────────────────────────────
    # 能力检测
    # ─────────────────────────────────────────────────────────

    def _check_pillow(self) -> bool:
        try:
            from PIL import ImageGrab
            return True
        except ImportError:
            return False

    def _check_pyautogui(self) -> bool:
        try:
            import pyautogui
            return True
        except ImportError:
            return False

    def _check_pywin32(self) -> bool:
        try:
            import win32gui
            return True
        except ImportError:
            return False

    def _get_pyautogui(self):
        if self._pyautogui is None and self._has_pyautogui:
            import pyautogui
            pyautogui.FAILSAFE = True  # 启用安全模式：鼠标移到左上角可中断
            pyautogui.PAUSE = 0.1  # 每个动作后暂停
            self._pyautogui = pyautogui
        return self._pyautogui

    def _get_win32_modules(self):
        if self._win32gui is None and self._has_pywin32:
            import win32gui
            import win32con
            self._win32gui = win32gui
            self._win32con = win32con
        return self._win32gui, self._win32con

    # ─────────────────────────────────────────────────────────
    # D5: Windows 特殊路径解析
    # ─────────────────────────────────────────────────────────

    @staticmethod
    def resolve_special_path(name: str) -> str:
        """解析 Windows 特殊文件夹路径。

        支持的名称（不区分大小写）：
        - desktop / 桌面
        - documents / 文档
        - downloads / 下载
        - appdata / roaming
        - local_appdata / localappdata
        - temp / 临时
        - home / 用户目录
        - program_files / program_files_x86
        - system_root / windows

        Args:
            name: 特殊文件夹名称

        Returns:
            解析后的绝对路径，无法解析时返回空字符串
        """
        key = name.strip().lower().replace(" ", "_")

        if key in ("home", "用户目录", "userprofile"):
            return str(Path.home())

        if key in ("desktop", "桌面"):
            return str(Path.home() / "Desktop")

        if key in ("documents", "文档", "my_documents"):
            if os.name == "nt":
                try:
                    import ctypes
                    buf = ctypes.create_unicode_buffer(260)
                    ctypes.windll.shell32.SHGetFolderPathW(0, 5, 0, 0, buf)
                    return buf.value
                except Exception:
                    pass
            return str(Path.home() / "Documents")

        if key in ("downloads", "下载"):
            return str(Path.home() / "Downloads")

        if key in ("appdata", "roaming", "应用数据"):
            val = os.environ.get("APPDATA", "")
            if val:
                return val
            return str(Path.home() / "AppData" / "Roaming")

        if key in ("local_appdata", "localappdata", "本地应用数据"):
            val = os.environ.get("LOCALAPPDATA", "")
            if val:
                return val
            return str(Path.home() / "AppData" / "Local")

        if key in ("temp", "临时", "tmp"):
            return tempfile.gettempdir()

        if key in ("program_files", "程序文件"):
            val = os.environ.get("ProgramFiles", "")
            return val if val else r"C:\Program Files"

        if key in ("program_files_x86", "程序文件x86"):
            val = os.environ.get("ProgramFiles(x86)", "")
            return val if val else r"C:\Program Files (x86)"

        if key in ("system_root", "windows", "系统目录"):
            val = os.environ.get("SystemRoot", "")
            return val if val else r"C:\Windows"

        return ""

    @staticmethod
    def expand_path(path: str) -> str:
        """扩展路径中的环境变量和特殊标记。

        支持：
        - %VAR% Windows 环境变量
        - ~ 用户主目录
        - $VAR Unix 环境变量

        Args:
            path: 可能包含特殊标记的路径

        Returns:
            展开后的绝对路径
        """
        if not path:
            return ""
        result = os.path.expandvars(os.path.expanduser(path))
        return result

    @property
    def capabilities(self) -> dict[str, bool]:
        """返回支持的能力列表"""
        return {
            "screenshot": self._has_pillow,
            "mouse": self._has_pyautogui or self._is_windows,
            "keyboard": self._has_pyautogui or self._is_windows,
            "window_management": self._has_pywin32 or self._is_windows,
            "clipboard": self._is_windows,
            "shell": True,
        }

    # ─────────────────────────────────────────────────────────
    # 鼠标操作
    # ─────────────────────────────────────────────────────────

    def click(self, x: int | None = None, y: int | None = None) -> ActionResult:
        """左键点击"""
        start = time.time()
        try:
            if self._has_pyautogui:
                pg = self._get_pyautogui()
                if x is not None and y is not None:
                    pg.click(x, y)
                else:
                    pg.click()
                return ActionResult(
                    success=True,
                    action="click",
                    output=f"点击 ({x or '当前'}, {y or '当前'})",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="click",
                    error="需要 pyautogui 支持鼠标操作",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="click",
                error=str(e),
                duration=time.time() - start,
            )

    def right_click(self, x: int | None = None, y: int | None = None) -> ActionResult:
        """右键点击"""
        start = time.time()
        try:
            if self._has_pyautogui:
                pg = self._get_pyautogui()
                if x is not None and y is not None:
                    pg.rightClick(x, y)
                else:
                    pg.rightClick()
                return ActionResult(
                    success=True,
                    action="right_click",
                    output=f"右键点击 ({x or '当前'}, {y or '当前'})",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="right_click",
                    error="需要 pyautogui 支持鼠标操作",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="right_click",
                error=str(e),
                duration=time.time() - start,
            )

    def double_click(self, x: int | None = None, y: int | None = None) -> ActionResult:
        """双击"""
        start = time.time()
        try:
            if self._has_pyautogui:
                pg = self._get_pyautogui()
                if x is not None and y is not None:
                    pg.doubleClick(x, y)
                else:
                    pg.doubleClick()
                return ActionResult(
                    success=True,
                    action="double_click",
                    output=f"双击 ({x or '当前'}, {y or '当前'})",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="double_click",
                    error="需要 pyautogui 支持鼠标操作",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="double_click",
                error=str(e),
                duration=time.time() - start,
            )

    def move_mouse(self, x: int, y: int, duration: float = 0.2) -> ActionResult:
        """移动鼠标"""
        start = time.time()
        try:
            if self._has_pyautogui:
                pg = self._get_pyautogui()
                pg.moveTo(x, y, duration=duration)
                return ActionResult(
                    success=True,
                    action="move_mouse",
                    output=f"移动鼠标到 ({x}, {y})",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="move_mouse",
                    error="需要 pyautogui 支持鼠标操作",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="move_mouse",
                error=str(e),
                duration=time.time() - start,
            )

    def drag(self, from_x: int, from_y: int, to_x: int, to_y: int, duration: float = 0.5) -> ActionResult:
        """拖拽"""
        start = time.time()
        try:
            if self._has_pyautogui:
                pg = self._get_pyautogui()
                pg.moveTo(from_x, from_y)
                pg.dragTo(to_x, to_y, duration=duration)
                return ActionResult(
                    success=True,
                    action="drag",
                    output=f"拖拽 ({from_x},{from_y}) → ({to_x},{to_y})",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="drag",
                    error="需要 pyautogui 支持鼠标操作",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="drag",
                error=str(e),
                duration=time.time() - start,
            )

    def scroll(self, delta: int) -> ActionResult:
        """滚动鼠标滚轮（正数向上，负数向下）"""
        start = time.time()
        try:
            if self._has_pyautogui:
                pg = self._get_pyautogui()
                pg.scroll(delta)
                return ActionResult(
                    success=True,
                    action="scroll",
                    output=f"滚动 {delta}",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="scroll",
                    error="需要 pyautogui 支持鼠标操作",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="scroll",
                error=str(e),
                duration=time.time() - start,
            )

    def get_mouse_position(self) -> Point:
        """获取当前鼠标位置"""
        if self._has_pyautogui:
            pg = self._get_pyautogui()
            x, y = pg.position()
            return Point(x=x, y=y)
        return Point(x=0, y=0)

    # ─────────────────────────────────────────────────────────
    # 键盘操作
    # ─────────────────────────────────────────────────────────

    def type_text(self, text: str, interval: float = 0.0, use_clipboard: bool | None = None) -> ActionResult:
        """输入文字。

        D3: 中文输入法兼容 — pyautogui.write() 仅支持ASCII，
        含非ASCII字符时自动切换为剪贴板粘贴策略（Ctrl+V），
        避免中文输入法下的乱码问题。

        Args:
            text: 待输入文字。
            interval: 按键间隔（仅ASCII模式有效）。
            use_clipboard: 强制使用剪贴板模式。None=自动检测。
        """
        start = time.time()
        try:
            has_non_ascii = any(ord(c) > 127 for c in text)
            should_use_clipboard = use_clipboard if use_clipboard is not None else has_non_ascii

            if should_use_clipboard:
                return self._type_via_clipboard(text)

            if self._has_pyautogui:
                pg = self._get_pyautogui()
                pg.write(text, interval=interval)
                return ActionResult(
                    success=True,
                    action="type_text",
                    output=f'输入文字(ascii): "{text[:50]}{"..." if len(text) > 50 else ""}"',
                    duration=time.time() - start,
                )
            else:
                return self._type_via_clipboard(text)
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="type_text",
                error=str(e),
                duration=time.time() - start,
            )

    def _type_via_clipboard(self, text: str) -> ActionResult:
        """D3: 通过剪贴板粘贴输入文字（支持中文等非ASCII字符）。"""
        start = time.time()
        try:
            saved_clipboard = ""
            try:
                saved_clipboard = self.read_clipboard()
            except Exception:
                pass

            self.write_clipboard(text)

            if self._has_pyautogui:
                pg = self._get_pyautogui()
                if self._is_windows:
                    pg.hotkey("ctrl", "v")
                else:
                    pg.hotkey("command", "v")
                time.sleep(0.1)
            elif self._is_windows:
                import ctypes
                ctypes.windll.user32.keybd_event(0x11, 0, 0, 0)
                ctypes.windll.user32.keybd_event(0x56, 0, 0, 0)
                ctypes.windll.user32.keybd_event(0x56, 0, 2, 0)
                ctypes.windll.user32.keybd_event(0x11, 0, 2, 0)
                time.sleep(0.1)

            try:
                self.write_clipboard(saved_clipboard)
            except Exception:
                pass

            return ActionResult(
                success=True,
                action="type_text",
                output=f'输入文字(clipboard): "{text[:50]}{"..." if len(text) > 50 else ""}"',
                duration=time.time() - start,
            )
        except Exception as e:
            return ActionResult(
                success=False,
                action="type_text",
                error=f"剪贴板输入失败: {e}",
                duration=time.time() - start,
            )

    def press_key(self, key: str) -> ActionResult:
        """按下并释放单个键"""
        start = time.time()
        try:
            if self._has_pyautogui:
                pg = self._get_pyautogui()
                pg.press(key)
                return ActionResult(
                    success=True,
                    action="press_key",
                    output=f"按键: {key}",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="press_key",
                    error="需要 pyautogui 支持键盘操作",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="press_key",
                error=str(e),
                duration=time.time() - start,
            )

    def key_combo(self, *keys: str) -> ActionResult:
        """按下组合键，如 key_combo('ctrl', 'c')"""
        start = time.time()
        try:
            if self._has_pyautogui:
                pg = self._get_pyautogui()
                pg.hotkey(*keys)
                return ActionResult(
                    success=True,
                    action="key_combo",
                    output=f"组合键: {'+'.join(keys)}",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="key_combo",
                    error="需要 pyautogui 支持键盘操作",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="key_combo",
                error=str(e),
                duration=time.time() - start,
            )

    # ─────────────────────────────────────────────────────────
    # 截图操作
    # ─────────────────────────────────────────────────────────

    def screenshot_full(self, save: bool = True) -> ScreenshotResult:
        """全屏截图"""
        try:
            if not self._has_pillow:
                return ScreenshotResult(success=False, error="需要 Pillow 支持截图")

            from PIL import ImageGrab

            img = ImageGrab.grab()
            width, height = img.size

            image_path = ""
            image_data = b""

            if save:
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                image_path = str(self._screenshot_dir / f"screenshot_{timestamp}.png")
                img.save(image_path)
            else:
                import io
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                image_data = buf.getvalue()

            return ScreenshotResult(
                success=True,
                image_path=image_path,
                width=width,
                height=height,
                image_data=image_data,
            )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ScreenshotResult(success=False, error=str(e))

    # ─────────────────────────────────────────────────────────
    # D11: 多显示器支持
    # ─────────────────────────────────────────────────────────

    def list_monitors(self) -> list[dict[str, Any]]:
        """列出所有显示器信息。

        Returns:
            显示器列表，每个元素包含:
            - index: 显示器索引（0=主显示器）
            - x, y: 左上角坐标
            - width, height: 分辨率
            - is_primary: 是否为主显示器
        """
        monitors: list[dict[str, Any]] = []
        try:
            if self._has_pywin32 and self._is_windows:
                import ctypes
                user32 = ctypes.windll.user32
                monitor_count = user32.GetSystemMetrics(80)  # SM_CMONITORS
                if monitor_count <= 0:
                    monitor_count = 1

                MONITORENUMPROC = ctypes.WINFUNCTYPE(
                    ctypes.c_int,
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.POINTER(ctypes.c_rect),
                    ctypes.c_double,
                )

                def _callback(hmon, hdc, lprect, lparam):
                    r = lprect.contents
                    monitors.append({
                        "index": len(monitors),
                        "x": r.left,
                        "y": r.top,
                        "width": r.right - r.left,
                        "height": r.bottom - r.top,
                        "is_primary": r.left == 0 and r.top == 0,
                    })
                    return 1

                user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(_callback), 0)
            elif self._has_pillow:
                from PIL import ImageGrab
                try:
                    mlist = ImageGrab.grab().size
                    monitors = [{
                        "index": 0,
                        "x": 0,
                        "y": 0,
                        "width": mlist[0],
                        "height": mlist[1],
                        "is_primary": True,
                    }]
                except Exception:
                    pass
        except Exception as e:
            logger.debug("desktop_controller 异常处理", error=str(e))

        if not monitors:
            monitors = [{
                "index": 0,
                "x": 0,
                "y": 0,
                "width": 1920,
                "height": 1080,
                "is_primary": True,
            }]
        return monitors

    def screenshot_monitor(self, monitor_index: int = 0, save: bool = True) -> ScreenshotResult:
        """截取指定显示器的屏幕。

        Args:
            monitor_index: 显示器索引（0=主显示器）
            save: 是否保存到文件

        Returns:
            ScreenshotResult
        """
        try:
            if not self._has_pillow:
                return ScreenshotResult(success=False, error="需要 Pillow 支持截图")

            from PIL import ImageGrab

            monitors = self.list_monitors()
            if monitor_index < 0 or monitor_index >= len(monitors):
                return ScreenshotResult(success=False, error=f"显示器索引 {monitor_index} 超出范围（共 {len(monitors)} 个）")

            mon = monitors[monitor_index]
            bbox = (mon["x"], mon["y"], mon["x"] + mon["width"], mon["y"] + mon["height"])
            img = ImageGrab.grab(bbox)
            width, height = img.size

            image_path = ""
            image_data = b""

            if save:
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                image_path = str(self._screenshot_dir / f"monitor{monitor_index}_{timestamp}.png")
                img.save(image_path)
            else:
                import io
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                image_data = buf.getvalue()

            return ScreenshotResult(
                success=True,
                image_path=image_path,
                width=width,
                height=height,
                image_data=image_data,
            )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ScreenshotResult(success=False, error=str(e))

    def screenshot_region(self, x: int, y: int, width: int, height: int, save: bool = True) -> ScreenshotResult:
        """区域截图"""
        try:
            if not self._has_pillow:
                return ScreenshotResult(success=False, error="需要 Pillow 支持截图")

            from PIL import ImageGrab

            img = ImageGrab.grab(bbox=(x, y, x + width, y + height))
            w, h = img.size

            image_path = ""
            image_data = b""

            if save:
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                image_path = str(self._screenshot_dir / f"screenshot_region_{timestamp}.png")
                img.save(image_path)
            else:
                import io
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                image_data = buf.getvalue()

            return ScreenshotResult(
                success=True,
                image_path=image_path,
                width=w,
                height=h,
                image_data=image_data,
            )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ScreenshotResult(success=False, error=str(e))

    def screenshot_window(self, window_title: str, save: bool = True) -> ScreenshotResult:
        """窗口截图（根据标题查找窗口）"""
        try:
            window = self.find_window(window_title)
            if not window:
                return ScreenshotResult(success=False, error=f"未找到窗口: {window_title}")

            return self.screenshot_region(
                window.bounds.x,
                window.bounds.y,
                window.bounds.width,
                window.bounds.height,
                save=save,
            )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ScreenshotResult(success=False, error=str(e))

    # ─────────────────────────────────────────────────────────
    # 窗口管理
    # ─────────────────────────────────────────────────────────

    def list_windows(self) -> list[WindowInfo]:
        """列出所有窗口"""
        windows: list[WindowInfo] = []

        if self._has_pywin32:
            win32gui, win32con = self._get_win32_modules()

            def enum_callback(hwnd, _):
                if win32gui.IsWindowVisible(hwnd):
                    title = win32gui.GetWindowText(hwnd)
                    if title:  # 只列出有标题的窗口
                        try:
                            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
                            is_minimized = win32gui.IsIconic(hwnd)
                            windows.append(WindowInfo(
                                handle=hwnd,
                                title=title,
                                bounds=Rect(left, top, right - left, bottom - top),
                                is_visible=True,
                                is_minimized=is_minimized,
                            ))
                        except Exception as _exc:
                            logger.warning("desktop_controller 异常处理", error=str(_exc))
                            log_ignored(None, "desktop_controller.DesktopController.list_windows.enum_callback", _exc)

            win32gui.EnumWindows(enum_callback, None)
        elif self._is_windows:
            # 使用 ctypes 的降级方案
            try:
                import ctypes
                from ctypes import wintypes

                user32 = ctypes.windll.user32

                WNDENUMPROC = ctypes.WINFUNCTYPE(
                    wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
                )

                def enum_callback(hwnd, _):
                    if user32.IsWindowVisible(hwnd):
                        length = user32.GetWindowTextLengthW(hwnd)
                        if length > 0:
                            buf = ctypes.create_unicode_buffer(length + 1)
                            user32.GetWindowTextW(hwnd, buf, length + 1)
                            rect = wintypes.RECT()
                            user32.GetWindowRect(hwnd, ctypes.byref(rect))
                            windows.append(WindowInfo(
                                handle=hwnd,
                                title=buf.value,
                                bounds=Rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top),
                                is_visible=True,
                                is_minimized=user32.IsIconic(hwnd),
                            ))
                    return True

                user32.EnumWindows(WNDENUMPROC(enum_callback), 0)
            except Exception as _exc:
                logger.warning("desktop_controller 异常处理", error=str(_exc))
                log_ignored(None, "desktop_controller.DesktopController.list_windows", _exc)

        return windows

    def find_window(self, title_keyword: str) -> WindowInfo | None:
        """根据标题关键词查找窗口"""
        windows = self.list_windows()
        keyword = title_keyword.lower()

        # 优先精确匹配
        for w in windows:
            if w.title.lower() == keyword:
                return w

        # 然后包含匹配
        for w in windows:
            if keyword in w.title.lower():
                return w

        return None

    def activate_window(self, title_keyword: str) -> ActionResult:
        """激活（前置）窗口"""
        start = time.time()
        try:
            window = self.find_window(title_keyword)
            if not window:
                return ActionResult(
                    success=False,
                    action="activate_window",
                    error=f"未找到窗口: {title_keyword}",
                    duration=time.time() - start,
                )

            if self._has_pywin32:
                win32gui, win32con = self._get_win32_modules()
                if window.is_minimized:
                    win32gui.ShowWindow(window.handle, win32con.SW_RESTORE)
                win32gui.SetForegroundWindow(window.handle)
                return ActionResult(
                    success=True,
                    action="activate_window",
                    output=f"激活窗口: {window.title}",
                    duration=time.time() - start,
                )
            elif self._is_windows:
                import ctypes
                from ctypes import wintypes
                user32 = ctypes.windll.user32
                if window.is_minimized:
                    user32.ShowWindow(window.handle, 9)  # SW_RESTORE
                user32.SetForegroundWindow(window.handle)
                return ActionResult(
                    success=True,
                    action="activate_window",
                    output=f"激活窗口: {window.title}",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="activate_window",
                    error="窗口管理需要 pywin32 或 Windows 系统",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="activate_window",
                error=str(e),
                duration=time.time() - start,
            )

    def close_window(self, title_keyword: str) -> ActionResult:
        """关闭窗口"""
        start = time.time()
        try:
            window = self.find_window(title_keyword)
            if not window:
                return ActionResult(
                    success=False,
                    action="close_window",
                    error=f"未找到窗口: {title_keyword}",
                    duration=time.time() - start,
                )

            if self._has_pywin32:
                win32gui, win32con = self._get_win32_modules()
                win32gui.PostMessage(window.handle, win32con.WM_CLOSE, 0, 0)
                return ActionResult(
                    success=True,
                    action="close_window",
                    output=f"关闭窗口: {window.title}",
                    duration=time.time() - start,
                )
            elif self._is_windows:
                import ctypes
                user32 = ctypes.windll.user32
                WM_CLOSE = 0x0010
                user32.PostMessageW(window.handle, WM_CLOSE, 0, 0)
                return ActionResult(
                    success=True,
                    action="close_window",
                    output=f"关闭窗口: {window.title}",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="close_window",
                    error="窗口管理需要 pywin32 或 Windows 系统",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="close_window",
                error=str(e),
                duration=time.time() - start,
            )

    def maximize_window(self, title_keyword: str) -> ActionResult:
        """最大化窗口"""
        start = time.time()
        try:
            window = self.find_window(title_keyword)
            if not window:
                return ActionResult(
                    success=False,
                    action="maximize_window",
                    error=f"未找到窗口: {title_keyword}",
                    duration=time.time() - start,
                )

            if self._has_pywin32:
                win32gui, win32con = self._get_win32_modules()
                win32gui.ShowWindow(window.handle, win32con.SW_MAXIMIZE)
                return ActionResult(
                    success=True,
                    action="maximize_window",
                    output=f"最大化窗口: {window.title}",
                    duration=time.time() - start,
                )
            elif self._is_windows:
                import ctypes
                user32 = ctypes.windll.user32
                SW_MAXIMIZE = 3
                user32.ShowWindow(window.handle, SW_MAXIMIZE)
                return ActionResult(
                    success=True,
                    action="maximize_window",
                    output=f"最大化窗口: {window.title}",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="maximize_window",
                    error="窗口管理需要 pywin32 或 Windows 系统",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="maximize_window",
                error=str(e),
                duration=time.time() - start,
            )

    def minimize_window(self, title_keyword: str) -> ActionResult:
        """最小化窗口"""
        start = time.time()
        try:
            window = self.find_window(title_keyword)
            if not window:
                return ActionResult(
                    success=False,
                    action="minimize_window",
                    error=f"未找到窗口: {title_keyword}",
                    duration=time.time() - start,
                )

            if self._has_pywin32:
                win32gui, win32con = self._get_win32_modules()
                win32gui.ShowWindow(window.handle, win32con.SW_MINIMIZE)
                return ActionResult(
                    success=True,
                    action="minimize_window",
                    output=f"最小化窗口: {window.title}",
                    duration=time.time() - start,
                )
            elif self._is_windows:
                import ctypes
                user32 = ctypes.windll.user32
                SW_MINIMIZE = 6
                user32.ShowWindow(window.handle, SW_MINIMIZE)
                return ActionResult(
                    success=True,
                    action="minimize_window",
                    output=f"最小化窗口: {window.title}",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="minimize_window",
                    error="窗口管理需要 pywin32 或 Windows 系统",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="minimize_window",
                error=str(e),
                duration=time.time() - start,
            )

    # ─────────────────────────────────────────────────────────
    # 剪贴板操作
    # ─────────────────────────────────────────────────────────

    def clipboard_read(self) -> ActionResult:
        """读取剪贴板内容"""
        start = time.time()
        try:
            if self._is_windows:
                # 使用 PowerShell 读取剪贴板
                result = subprocess.run(
                    ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    encoding="utf-8",
                )
                content = result.stdout.strip()
                return ActionResult(
                    success=True,
                    action="clipboard_read",
                    output=content,
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="clipboard_read",
                    error="剪贴板操作需要 Windows 系统",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="clipboard_read",
                error=str(e),
                duration=time.time() - start,
            )

    def clipboard_write(self, text: str) -> ActionResult:
        """写入剪贴板"""
        start = time.time()
        try:
            if self._is_windows:
                # 使用 PowerShell 写入剪贴板
                escaped = text.replace("'", "''")
                subprocess.run(
                    ["powershell", "-NoProfile", "-Command", f"Set-Clipboard -Value '{escaped}'"],
                    timeout=5,
                    capture_output=True,
                )
                return ActionResult(
                    success=True,
                    action="clipboard_write",
                    output=f"写入剪贴板: {text[:50]}{'...' if len(text) > 50 else ''}",
                    duration=time.time() - start,
                )
            else:
                return ActionResult(
                    success=False,
                    action="clipboard_write",
                    error="剪贴板操作需要 Windows 系统",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="clipboard_write",
                error=str(e),
                duration=time.time() - start,
            )

    # ─────────────────────────────────────────────────────────
    # Shell 命令执行
    # ─────────────────────────────────────────────────────────

    # 危险命令黑名单 — 禁止通过 shell_exec 执行
    _DANGEROUS_COMMANDS = {
        "rm -rf /", "del /f /s /q c:\\", "format ", "mkfs.",
        "dd if=", ":(){ :|:& };:", "shutdown", "reboot",
    }

    def shell_exec(self, command: str, timeout: int = 30) -> ActionResult:
        """执行Shell命令（安全加固：shlex 解析 + 危险命令黑名单 + shell=False）。

        安全约束：
        - 始终以 shell=False 执行（argv 列表），杜绝 Shell 元字符注入；
        - shlex 解析失败时**拒绝执行**（fail-closed），绝不全文回退到 shell=True；
        - 危险命令黑名单仅作纵深防御，不能替代 shell=False 这一根本防线。
        """
        start = time.time()
        try:
            # 危险命令检测（纵深防御）
            cmd_lower = command.lower().strip()
            for dangerous in self._DANGEROUS_COMMANDS:
                if dangerous in cmd_lower:
                    return ActionResult(
                        success=False,
                        action="shell_exec",
                        error=f"命令被安全策略拒绝: 包含危险模式 '{dangerous}'",
                        duration=time.time() - start,
                    )

            # 安全解析：shlex.split + shell=False（Windows 下用 posix=False 保留路径）
            import shlex
            try:
                args = shlex.split(command, posix=not self._is_windows)
            except ValueError as e:
                # 解析失败：拒绝执行，绝不回退到 shell=True（避免命令注入）
                return ActionResult(
                    success=False,
                    action="shell_exec",
                    error=f"命令解析失败，已拒绝执行: {e}",
                    duration=time.time() - start,
                )

            result = subprocess.run(
                args,
                shell=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                encoding="utf-8",
                errors="replace",
            )
            output = result.stdout or result.stderr or "(无输出)"
            return ActionResult(
                success=result.returncode == 0,
                action="shell_exec",
                output=output[:1000],
                error="" if result.returncode == 0 else f"退出码: {result.returncode}",
                duration=time.time() - start,
            )
        except subprocess.TimeoutExpired:
            return ActionResult(
                success=False,
                action="shell_exec",
                error=f"执行超时 ({timeout}s)",
                duration=time.time() - start,
            )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="shell_exec",
                error=str(e),
                duration=time.time() - start,
            )

    def open_app(self, app_name: str) -> ActionResult:
        """打开应用程序（安全加固：使用 os.startfile 替代 shell=True）。"""
        start = time.time()
        try:
            if self._is_windows:
                os.startfile(app_name)
                return ActionResult(
                    success=True,
                    action="open_app",
                    output=f"打开应用: {app_name}",
                    duration=time.time() - start,
                )
            else:
                subprocess.Popen([app_name])
                return ActionResult(
                    success=True,
                    action="open_app",
                    output=f"打开应用: {app_name}",
                    duration=time.time() - start,
                )
        except Exception as e:
            logger.warning("desktop_controller 异常处理", error=str(e))
            return ActionResult(
                success=False,
                action="open_app",
                error=str(e),
                duration=time.time() - start,
            )

    # ─────────────────────────────────────────────────────────
    # 工具方法
    # ─────────────────────────────────────────────────────────

    def wait(self, ms: int) -> ActionResult:
        """等待指定毫秒数"""
        start = time.time()
        time.sleep(ms / 1000)
        return ActionResult(
            success=True,
            action="wait",
            output=f"等待 {ms}ms",
            duration=time.time() - start,
        )

    def get_screen_size(self) -> tuple[int, int]:
        """获取屏幕分辨率"""
        if self._has_pyautogui:
            pg = self._get_pyautogui()
            return pg.size()
        if self._has_pillow:
            from PIL import ImageGrab
            img = ImageGrab.grab()
            return img.size
        return (1920, 1080)  # 默认值


# ─────────────────────────────────────────────────────────────
# 单例模式
# ─────────────────────────────────────────────────────────────

_controller_instance: DesktopController | None = None


def get_desktop_controller() -> DesktopController:
    """获取桌面控制器单例"""
    global _controller_instance
    if _controller_instance is None:
        _controller_instance = DesktopController()
    return _controller_instance
