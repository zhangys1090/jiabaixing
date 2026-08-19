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


def _convert_normalized_task(task: str, screen_width: int, screen_height: str) -> str:
    """将任务描述中的归一化坐标 (x,y) 转换为像素坐标

    支持格式：
    - (500,300)          → 单点坐标
    - (100,200,400,600)  → 矩形区域 x1,y1,x2,y2
    - click(500,300)     → 带动作前缀
    """
    import re
    from agent.desktop.coordinate_system import from_normalized, NORMALIZED_MAX

    def _replacer(m: re.Match) -> str:
        nums_str = m.group(1)
        nums = [int(p.strip()) for p in nums_str.split(",")]

        if len(nums) == 2:
            nx, ny = nums
            if 0 <= nx <= NORMALIZED_MAX and 0 <= ny <= NORMALIZED_MAX:
                px, py = from_normalized(nx, ny, screen_width, screen_height)
                return f"({px},{py})"
        elif len(nums) == 4:
            x1, y1, x2, y2 = nums
            if all(0 <= v <= NORMALIZED_MAX for v in nums):
                px1, py1 = from_normalized(x1, y1, screen_width, screen_height)
                px2, py2 = from_normalized(x2, y2, screen_width, screen_height)
                return f"({px1},{py1},{px2},{py2})"

        return m.group(0)

    return re.sub(r'\((\d+(?:\s*,\s*\d+){1,3})\)', _replacer, task)


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
    description='在用户电脑上执行桌面自动化操作。支持截图、点击、输入文字、按键、移动鼠标、滚动、拖拽、剪贴板读写、窗口管理、打开应用。坐标支持归一化模式(0-1000)和像素模式。Shell命令请用shell_exec工具。适用场景：用户要求操作电脑（打开应用、截图、点击、输入文字、管理窗口等）。不适用：纯文字对话、信息查询。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="task", type="string", description="桌面操作描述，如：打开记事本并输入Hello World、截图保存桌面、点击屏幕上的确定按钮、最大化浏览器窗口、读取剪贴板内容"),
        ToolParameterDef(name="coordinate_mode", type="string", required=False, description="坐标模式：pixel（绝对像素）或 normalized（归一化0-1000），默认pixel", enum=["pixel", "normalized"]),
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


# desktop_shell 已移除 — 与 shell_exec (code_tools) 重复，统一使用 shell_exec


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
    支持 coordinate_mode=normalized 时将归一化坐标(0-1000)转换为像素坐标。
    """
    start = time.time()
    task = str(params.get("task", ""))
    coordinate_mode = str(params.get("coordinate_mode", "pixel")).lower()

    if not task:
        return ToolResult(success=False, error="请提供要执行的桌面操作任务描述", duration=time.time() - start)

    # ─── 归一化坐标转换 ───
    if coordinate_mode == "normalized":
        from agent.desktop.coordinate_system import NormalizedPoint
        controller = get_desktop_controller()
        sw, sh = controller.get_screen_size()
        task = _convert_normalized_task(task, sw, sh)

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


# desktop_shell_executor 已移除 — 与 shell_exec (code_tools) 重复


# ─────────────────────────────────────────────────────────────
# UIA 增强桌面操作工具 — 精确元素定位 + 操作验证闭环
# ─────────────────────────────────────────────────────────────

DESKTOP_UIA_ACTION_DEF = ToolDefinition(
    name="desktop_uia_action",
    description=(
        "UIA增强桌面操作 — 通过Windows UIA精确元素定位执行桌面操作，"
        "自动执行操作前截图、操作后验证的完整闭环。"
        "适用场景：需要精确点击按钮、输入文字到指定输入框、读取界面元素文本。"
        "比desktop_automate更精确，支持操作验证和自动重试。"
        "不适用：简单截图、窗口管理（用desktop_screenshot/desktop_window）。"
    ),
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型：click/type/get_text/set_text/screenshot/activate_window/hotkey/scroll", enum=["click", "type", "get_text", "set_text", "screenshot", "activate_window", "hotkey", "scroll"]),
        ToolParameterDef(name="target", type="string", required=False, description="目标元素名称或窗口标题"),
        ToolParameterDef(name="value", type="string", required=False, description="输入值（type/set_text时为文字，hotkey时为组合键如ctrl+c，scroll时为滚动次数）"),
        ToolParameterDef(name="control_type", type="string", required=False, description="UIA控制类型（Button/Edit/Window等），提高定位精度"),
        ToolParameterDef(name="verify", type="boolean", required=False, description="是否执行操作后验证（默认true）"),
        ToolParameterDef(name="max_retries", type="number", required=False, description="最大重试次数（默认2）"),
    ],
    risk_level="high",
)


async def desktop_uia_action_executor(params: dict[str, Any]) -> ToolResult:
    """UIA增强桌面操作执行器 — 精确元素定位 + 操作验证闭环。"""
    start = time.time()
    action = str(params.get("action", "click")).lower()
    target = str(params.get("target", ""))
    value = str(params.get("value", ""))
    control_type = str(params.get("control_type", ""))
    verify = bool(params.get("verify", True))
    max_retries = int(params.get("max_retries", 2))

    try:
        from agent.desktop.operation_loop import DesktopOperationLoop, OperationSpec

        loop = DesktopOperationLoop()
        spec = OperationSpec(
            action_type=action,
            target=target,
            value=value,
            control_type=control_type,
            max_retries=max_retries,
            verify_strategy="auto" if verify else "pixel",
        )
        result = await loop.execute(spec)

        output_parts = []
        if result.success:
            output_parts.append(f"✅ {action} 操作成功")
        else:
            output_parts.append(f"❌ {action} 操作失败")

        if target:
            output_parts.append(f"目标: {target}")
        if result.evidence:
            output_parts.append(f"验证: {result.evidence}")
        if result.verification:
            conf = result.verification.get("confidence", 0)
            method = result.verification.get("method", "")
            output_parts.append(f"置信度: {conf:.0%} (方法: {method})")
        if result.retries > 0:
            output_parts.append(f"重试: {result.retries} 次")

        return ToolResult(
            success=result.success,
            output="\n".join(output_parts),
            error=result.error if not result.success else None,
            duration=time.time() - start,
            metadata={
                "verification": result.verification,
                "retries": result.retries,
                "duration_ms": result.duration_ms,
            },
        )

    except Exception as e:
        return ToolResult(
            success=False,
            error=f"UIA增强操作失败: {e}",
            duration=time.time() - start,
        )


# ─────────────────────────────────────────────────────────────
# 桌面元素探索工具 — UIA 元素树浏览
# ─────────────────────────────────────────────────────────────

DESKTOP_EXPLORE_DEF = ToolDefinition(
    name="desktop_explore",
    description=(
        "桌面元素探索 — 通过UIA浏览当前桌面的UI元素树，"
        "查看可交互的按钮、输入框、菜单等元素。"
        "适用场景：在执行桌面操作前先了解界面结构，找到目标元素名称和控制类型。"
        "不适用：直接执行操作（用desktop_uia_action/desktop_automate）。"
    ),
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="filter", type="string", required=False, description="过滤关键词（只显示名称包含此关键词的元素）"),
        ToolParameterDef(name="control_type", type="string", required=False, description="只显示指定控制类型的元素"),
        ToolParameterDef(name="depth", type="number", required=False, description="搜索深度（默认3，越大越详细但越慢）"),
    ],
    risk_level="low",
)


async def desktop_explore_executor(params: dict[str, Any]) -> ToolResult:
    """桌面元素探索执行器。"""
    start = time.time()
    filter_text = str(params.get("filter", "")).lower()
    control_type = params.get("control_type")
    depth = int(params.get("depth", 3))

    try:
        from agent.tools.windows_uia import UIAEngine, UIAQuery

        engine = UIAEngine.get_instance()
        query = UIAQuery(
            name_contains=filter_text if filter_text else None,
            control_type=control_type,
            max_depth=depth,
        )
        elements = await engine.find_elements(query)

        if not elements:
            hint = "尝试减少过滤条件或增加搜索深度" if filter_text or control_type else "当前无可交互元素"
            return ToolResult(
                success=True,
                output=f"未找到匹配元素。{hint}",
                duration=time.time() - start,
            )

        lines = [f"🔍 找到 {len(elements)} 个元素:\n"]
        for i, el in enumerate(elements[:30], 1):
            rect = el.rect
            line = f"{i}. [{el.control_type}] \"{el.name}\""
            if el.automation_id:
                line += f" id={el.automation_id}"
            if el.value:
                line += f" value=\"{el.value[:50]}\""
            line += f" pos=({rect['x']},{rect['y']})"
            if not el.is_enabled:
                line += " [禁用]"
            lines.append(line)

        if len(elements) > 30:
            lines.append(f"... 共 {len(elements)} 个元素（显示前30个）")

        return ToolResult(
            success=True,
            output="\n".join(lines),
            duration=time.time() - start,
            metadata={"count": len(elements)},
        )

    except Exception as e:
        return ToolResult(
            success=False,
            error=f"桌面探索失败: {e}",
            duration=time.time() - start,
        )
