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
from agent.desktop.action_sandbox import (
    ActionSandbox,
    RiskLevel,
    ActionType,
    RiskCheckResult,
    CheckpointData as SandboxCheckpointData,
    SandboxConfig,
)
from agent.desktop.operation_loop import (
    DesktopOperationLoop,
    OperationSpec,
    OperationResult,
    OperationLoopMetrics,
)

__all__ = [
    "DesktopController",
    "get_desktop_controller",
    "Point",
    "Rect",
    "WindowInfo",
    "ScreenshotResult",
    "ActionResult",
    "ActionSandbox",
    "RiskLevel",
    "ActionType",
    "RiskCheckResult",
    "SandboxCheckpointData",
    "SandboxConfig",
    "DesktopOperationLoop",
    "OperationSpec",
    "OperationResult",
    "OperationLoopMetrics",
]
