"""
桌面自动化工具集 - Python原生实现 + TS DesktopExecutionAgent 代理

架构：
1. 优先走 TS DesktopExecutionAgent（Codex 风格 Computer Use）
2. TS 不可用时回退到 Python DesktopController（pyautogui/pywin32）

TS 后端地址可通过环境变量 TS_BACKEND_URL 配置（默认 http://localhost:3111）。
可通过 DESKTOP_TS_ENABLED=false 禁用 TS 代理。
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)

_TS_BACKEND = os.environ.get("TS_BACKEND_URL", "http://localhost:3111")
_TS_ENABLED = os.environ.get("DESKTOP_TS_ENABLED", "true").lower() == "true"

log: Any = None


def _get_logger() -> Any:
    global log
    if log is None:
        from agent.core.logger import StructuredLogger
        log = StructuredLogger("desktop_tools")
    return log


async def _call_ts_desktop(task: str, timeout: float = 60.0) -> dict[str, Any] | None:
    """调用 TS DesktopExecutionAgent 执行桌面任务。
    
    Returns:
        成功时返回 TS 响应 dict，失败（网络错误/超时/500）时返回 None。
    """
    if not _TS_ENABLED:
        return None
    try:
        import httpx
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=3.0)) as client:
            resp = await client.post(
                f"{_TS_BACKEND}/api/desktop/automate",
                json={"task": task},
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code != 200:
                _get_logger().warning(
                    "TS desktop returned non-200",
                    status=resp.status_code,
                )
                return None
            data = resp.json()
            if data.get("success"):
                return data
            return None
    except Exception as e:
        _get_logger().info(
            "TS desktop unavailable, falling back to Python",
            error=str(e)[:60],
        )
        return None

from agent.desktop.desktop_controller import get_desktop_controller


# ─────────────────────────────────────────────────────────────
# 工具定义
# ─────────────────────────────────────────────────────────────

DESKTOP_AUTOMATE_DEF = ToolDefinition(
    name="desktop_automate",
    description='在用户电脑上执行桌面自动化操作。支持截图、点击、输入文字、按键、移动鼠标、滚动、拖拽、剪贴板读写、Shell命令、窗口管理、打开应用。适用场景：用户要求操作电脑（打开应用、截图、点击、输入文字、管理窗口等）。不适用：纯文字对话、信息查询。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="task", type="string", description="桌面操作描述，如：打开记事本并输入Hello World、截图保存桌面、点击屏幕上的确定按钮、最大化浏览器窗口、读取剪贴板内容"),
    ],
    risk_level="high",
)


DESKTOP_SCREENSHOT_DEF = ToolDefinition(
    name="desktop_screenshot",
    description='截取屏幕截图并可选进行视觉分析。适用场景：用户说看看我屏幕上是什么、帮我截个图、需要了解用户桌面状态时。不适用：自动化操作桌面（用 desktop_automate）。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="screen_index", type="number", required=False, description="显示器索引（多显示器时使用），默认0为主显示器"),
        ToolParameterDef(name="analyze", type="boolean", required=False, description="是否对截图进行视觉分析（描述截图内容）"),
        ToolParameterDef(name="region", type="string", required=False, description="截图区域，格式为 x,y,width,height。如 100,200,800,600"),
        ToolParameterDef(name="window_title", type="string", required=False, description="截取指定标题的窗口"),
    ],
    risk_level="high",
)


DESKTOP_WINDOW_DEF = ToolDefinition(
    name="desktop_window",
    description='窗口管理工具，支持列出窗口、激活窗口、关闭窗口、最大化、最小化等操作。适用场景：用户要求切换窗口、关闭某个程序、最大化窗口等。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型：list（列出窗口）、activate（激活）、close（关闭）、maximize（最大化）、minimize（最小化）"),
        ToolParameterDef(name="title", type="string", required=False, description="窗口标题关键词（list操作不需要）"),
    ],
    risk_level="medium",
)


DESKTOP_CLIPBOARD_DEF = ToolDefinition(
    name="desktop_clipboard",
    description='剪贴板操作工具，支持读取和写入剪贴板内容。适用场景：用户要求复制内容、读取剪贴板、粘贴文字等。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型：read（读取）、write（写入）"),
        ToolParameterDef(name="text", type="string", required=False, description="要写入的文字（write操作需要）"),
    ],
    risk_level="medium",
)


DESKTOP_SHELL_DEF = ToolDefinition(
    name="desktop_shell",
    description='在用户电脑上执行Shell命令。适用场景：需要执行命令行操作、运行脚本、查看系统信息等。注意：危险操作会被拦截。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="command", type="string", description="要执行的Shell命令"),
        ToolParameterDef(name="timeout", type="number", required=False, description="超时时间（秒），默认30秒"),
    ],
    risk_level="high",
)


# ─────────────────────────────────────────────────────────────
# 危险命令黑名单
# ─────────────────────────────────────────────────────────────

DANGEROUS_COMMANDS = [
    "format", "del /s", "rm -rf", "rm -rf /", "rm -rf /*",
    "shutdown", "restart", "reg delete", "reg add",
    "net user", "net localgroup", "cipher /w", "diskpart",
    "bcdedit", "taskkill /f /im svchost",
]


def _is_dangerous_command(command: str) -> bool:
    """检查命令是否危险"""
    cmd_lower = command.lower()
    return any(danger in cmd_lower for danger in DANGEROUS_COMMANDS)


# ─────────────────────────────────────────────────────────────
# 工具执行器
# ─────────────────────────────────────────────────────────────

async def desktop_automate_executor(params: dict[str, Any]) -> ToolResult:
    """桌面自动化执行器 - 高级接口，一句话任务
    
    优先调用 TS DesktopExecutionAgent（Codex 风格 Computer Use），
    TS 不可用时回退到 Python DesktopController。
    """
    start = time.time()
    task = str(params.get("task", ""))

    if not task:
        return ToolResult(success=False, error="请提供要执行的桌面操作任务描述", duration=time.time() - start)

    # ─── 优先走 TS DesktopExecutionAgent ───
    ts_result = await _call_ts_desktop(task)
    if ts_result is not None:
        data = ts_result.get("data", {})
        output = data.get("output") or ts_result.get("output", "")
        return ToolResult(
            success=True,
            output=f"[TS DesktopExecutionAgent] {output}" if output else "操作完成",
            duration=time.time() - start,
        )

    # ─── TS 不可用，回退到 Python DesktopController ───
    controller = get_desktop_controller()
    task_lower = task.lower()

    try:
        # 简单任务解析 - 基于关键词的快速路径
        # 复杂任务由 LLM 规划（在 DesktopAgentLoop 中处理）

        # 截图相关
        if "截图" in task_lower or "screenshot" in task_lower or "截个图" in task_lower:
            result = controller.screenshot_full()
            if result.success:
                return ToolResult(
                    success=True,
                    output=f"📸 截图已保存: {result.image_path}\n分辨率: {result.width}x{result.height}",
                    duration=time.time() - start,
                )
            else:
                return ToolResult(success=False, error=result.error, duration=time.time() - start)

        # 打开应用
        if "打开" in task_lower and ("记事本" in task_lower or "notepad" in task_lower):
            result = controller.open_app("notepad.exe")
            if result.success:
                time.sleep(0.5)  # 等待窗口打开
                return ToolResult(
                    success=True,
                    output="✅ 已打开记事本",
                    duration=time.time() - start,
                )
            else:
                return ToolResult(success=False, error=result.error, duration=time.time() - start)

        if "打开" in task_lower and ("计算器" in task_lower or "calc" in task_lower):
            result = controller.open_app("calc.exe")
            if result.success:
                time.sleep(0.5)
                return ToolResult(
                    success=True,
                    output="✅ 已打开计算器",
                    duration=time.time() - start,
                )
            else:
                return ToolResult(success=False, error=result.error, duration=time.time() - start)

        if "打开" in task_lower and ("浏览器" in task_lower or "chrome" in task_lower):
            result = controller.open_app("chrome.exe")
            if result.success:
                time.sleep(1)
                return ToolResult(
                    success=True,
                    output="✅ 已打开Chrome浏览器",
                    duration=time.time() - start,
                )
            else:
                return ToolResult(success=False, error=result.error, duration=time.time() - start)

        # 窗口管理
        if "最大化" in task_lower:
            # 提取窗口标题关键词
            title = task_lower.replace("最大化", "").replace("窗口", "").strip()
            if title:
                result = controller.maximize_window(title)
                return ToolResult(
                    success=result.success,
                    output=result.output if result.success else "",
                    error=result.error if not result.success else None,
                    duration=time.time() - start,
                )

        if "最小化" in task_lower:
            title = task_lower.replace("最小化", "").replace("窗口", "").strip()
            if title:
                result = controller.minimize_window(title)
                return ToolResult(
                    success=result.success,
                    output=result.output if result.success else "",
                    error=result.error if not result.success else None,
                    duration=time.time() - start,
                )

        if "关闭" in task_lower and "窗口" in task_lower:
            title = task_lower.replace("关闭", "").replace("窗口", "").strip()
            if title:
                result = controller.close_window(title)
                return ToolResult(
                    success=result.success,
                    output=result.output if result.success else "",
                    error=result.error if not result.success else None,
                    duration=time.time() - start,
                )

        # 剪贴板
        if "读取剪贴板" in task_lower or "剪贴板内容" in task_lower:
            result = controller.clipboard_read()
            return ToolResult(
                success=result.success,
                output=f"📋 剪贴板内容:\n{result.output}" if result.success else "",
                error=result.error if not result.success else None,
                duration=time.time() - start,
            )

        # 列出窗口
        if "窗口列表" in task_lower or "列出窗口" in task_lower or "有哪些窗口" in task_lower:
            windows = controller.list_windows()
            if windows:
                output = "🪟 当前打开的窗口:\n"
                for i, w in enumerate(windows[:20], 1):
                    status = " [最小化]" if w.is_minimized else ""
                    output += f"{i}. {w.title}{status}\n"
                if len(windows) > 20:
                    output += f"... 共 {len(windows)} 个窗口"
                return ToolResult(success=True, output=output, duration=time.time() - start)
            else:
                return ToolResult(success=False, error="未找到窗口或窗口管理功能不可用", duration=time.time() - start)

        # 默认：返回提示，说明需要更具体的指令
        # 完整的任务规划由 DesktopAgentLoop 处理
        capabilities = controller.capabilities
        available = [k for k, v in capabilities.items() if v]

        output = f"""🖥️ 桌面自动化工具已就绪

当前可用能力: {', '.join(available)}

支持的操作类型:
• 截图：desktop_screenshot 工具
• 窗口管理：desktop_window 工具
• 剪贴板：desktop_clipboard 工具
• 命令执行：desktop_shell 工具
• 打开应用：desktop_automate（指定应用名）

提示：对于复杂的多步操作任务，将使用桌面执行Agent循环自动完成。

你的任务: {task}
"""
        return ToolResult(success=True, output=output, duration=time.time() - start)

    except Exception as e:
        return ToolResult(success=False, error=f"桌面操作失败: {e}", duration=time.time() - start)


async def desktop_screenshot_executor(params: dict[str, Any]) -> ToolResult:
    """截图工具执行器"""
    start = time.time()
    screen_index = int(params.get("screen_index", 0))
    analyze = bool(params.get("analyze", False))
    region = params.get("region", "")
    window_title = params.get("window_title", "")

    controller = get_desktop_controller()

    try:
        # 窗口截图
        if window_title:
            result = controller.screenshot_window(window_title)
        # 区域截图
        elif region:
            parts = region.split(",")
            if len(parts) == 4:
                x, y, w, h = [int(p.strip()) for p in parts]
                result = controller.screenshot_region(x, y, w, h)
            else:
                return ToolResult(success=False, error="区域格式错误，应为 x,y,width,height", duration=time.time() - start)
        # 全屏截图
        else:
            result = controller.screenshot_full()

        if result.success:
            output = f"📸 截图已保存: {result.image_path}\n分辨率: {result.width}x{result.height}"
            if analyze:
                output += "\n⚠️ 视觉分析需要多模态LLM支持，当前仅保存截图文件。"
            return ToolResult(success=True, output=output, duration=time.time() - start)
        else:
            return ToolResult(success=False, error=result.error, duration=time.time() - start)

    except Exception as e:
        return ToolResult(success=False, error=f"截图失败: {e}", duration=time.time() - start)


async def desktop_window_executor(params: dict[str, Any]) -> ToolResult:
    """窗口管理工具执行器"""
    start = time.time()
    action = str(params.get("action", "list")).lower()
    title = str(params.get("title", ""))

    controller = get_desktop_controller()

    try:
        if action == "list":
            windows = controller.list_windows()
            if windows:
                output = "🪟 当前打开的窗口:\n"
                for i, w in enumerate(windows[:30], 1):
                    status = " [最小化]" if w.is_minimized else ""
                    output += f"{i}. {w.title}{status}\n"
                if len(windows) > 30:
                    output += f"... 共 {len(windows)} 个窗口"
                return ToolResult(success=True, output=output, duration=time.time() - start)
            else:
                return ToolResult(success=False, error="未找到窗口或窗口管理功能不可用", duration=time.time() - start)

        elif action == "activate":
            if not title:
                return ToolResult(success=False, error="请提供窗口标题", duration=time.time() - start)
            result = controller.activate_window(title)
            return ToolResult(
                success=result.success,
                output=result.output if result.success else "",
                error=result.error if not result.success else None,
                duration=time.time() - start,
            )

        elif action == "close":
            if not title:
                return ToolResult(success=False, error="请提供窗口标题", duration=time.time() - start)
            result = controller.close_window(title)
            return ToolResult(
                success=result.success,
                output=result.output if result.success else "",
                error=result.error if not result.success else None,
                duration=time.time() - start,
            )

        elif action == "maximize":
            if not title:
                return ToolResult(success=False, error="请提供窗口标题", duration=time.time() - start)
            result = controller.maximize_window(title)
            return ToolResult(
                success=result.success,
                output=result.output if result.success else "",
                error=result.error if not result.success else None,
                duration=time.time() - start,
            )

        elif action == "minimize":
            if not title:
                return ToolResult(success=False, error="请提供窗口标题", duration=time.time() - start)
            result = controller.minimize_window(title)
            return ToolResult(
                success=result.success,
                output=result.output if result.success else "",
                error=result.error if not result.success else None,
                duration=time.time() - start,
            )

        else:
            return ToolResult(success=False, error=f"未知操作: {action}，支持: list, activate, close, maximize, minimize", duration=time.time() - start)

    except Exception as e:
        return ToolResult(success=False, error=f"窗口操作失败: {e}", duration=time.time() - start)


async def desktop_clipboard_executor(params: dict[str, Any]) -> ToolResult:
    """剪贴板工具执行器"""
    start = time.time()
    action = str(params.get("action", "read")).lower()
    text = str(params.get("text", ""))

    controller = get_desktop_controller()

    try:
        if action == "read":
            result = controller.clipboard_read()
            return ToolResult(
                success=result.success,
                output=f"📋 剪贴板内容:\n{result.output}" if result.success else "",
                error=result.error if not result.success else None,
                duration=time.time() - start,
            )

        elif action == "write":
            if not text:
                return ToolResult(success=False, error="请提供要写入的文字", duration=time.time() - start)
            result = controller.clipboard_write(text)
            return ToolResult(
                success=result.success,
                output=result.output if result.success else "",
                error=result.error if not result.success else None,
                duration=time.time() - start,
            )

        else:
            return ToolResult(success=False, error=f"未知操作: {action}，支持: read, write", duration=time.time() - start)

    except Exception as e:
        return ToolResult(success=False, error=f"剪贴板操作失败: {e}", duration=time.time() - start)


async def desktop_shell_executor(params: dict[str, Any]) -> ToolResult:
    """Shell命令执行器"""
    start = time.time()
    command = str(params.get("command", ""))
    timeout = int(params.get("timeout", 30))

    if not command:
        return ToolResult(success=False, error="请提供要执行的命令", duration=time.time() - start)

    # 安全检查
    if _is_dangerous_command(command):
        return ToolResult(
            success=False,
            error="⚠️ 检测到危险操作，已被安全策略拦截。如需执行，请确认操作安全性。",
            duration=time.time() - start,
        )

    controller = get_desktop_controller()

    try:
        result = controller.shell_exec(command, timeout=timeout)
        return ToolResult(
            success=result.success,
            output=result.output if result.success else result.output,
            error=result.error if not result.success else None,
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"命令执行失败: {e}", duration=time.time() - start)
