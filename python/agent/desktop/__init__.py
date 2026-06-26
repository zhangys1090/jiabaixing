"""
桌面自动化模块 - 执行Agent的核心能力

提供Python原生的桌面控制能力，不依赖TS后端。
"""

from agent.desktop.desktop_controller import (
    DesktopController,
    get_desktop_controller,
    Point,
    Rect,
    WindowInfo,
    ScreenshotResult,
    ActionResult,
)

__all__ = [
    "DesktopController",
    "get_desktop_controller",
    "Point",
    "Rect",
    "WindowInfo",
    "ScreenshotResult",
    "ActionResult",
]
