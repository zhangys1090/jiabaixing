"""
五感感知工具集 — 情绪感知 + 场景感知 + 环境感知

将五感能力注册为 Tool，复用 ToolRegistry 统一调度。
LLM 在推理循环中自主决定何时感知、何时执行。

工具清单：
- emotion_perceive:  情绪感知（基于 LLM 语义分析）
- scene_perceive:    场景感知（基于 LLM 语义分析）
- environment_sense: 环境感知（真实系统信息）

@module perception.tools
@version 1.0.0
@since 2026-08-06
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("perception_tools_v2")


EMOTION_PERCEIVE_DEF = ToolDefinition(
    name="emotion_perceive",
    description=(
        "情绪感知工具 — 基于LLM语义分析用户文本的情绪状态。"
        "返回情绪类型(happy/sad/angry/anxious/frustrated/neutral/curious/confident)、"
        "强度(0-1)、潜在需求列表和置信度。"
        "适用场景：Agent需要理解用户情绪以调整交互策略时。"
        "不适用：纯事实性查询（无需情绪分析）。"
    ),
    short_desc="LLM语义情绪感知",
    category=ToolCategory.PERCEPTION,
    tags=["emotion", "sentiment", "perception", "affect"],
    scenes=["daily", "desktop"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="text", type="string",
                         description="待分析的用户文本"),
        ToolParameterDef(name="context", type="string", required=False,
                         description="额外上下文（如对话历史摘要）"),
    ],
    risk_level="low",
)


SCENE_PERCEIVE_DEF = ToolDefinition(
    name="scene_perceive",
    description=(
        "场景感知工具 — 基于LLM语义分析用户输入的场景类型。"
        "返回场景类型(coding/debugging/code_review/writing/meeting/research等)、"
        "交互模式、推荐工具列表和置信度。"
        "适用场景：Agent需要根据场景选择合适的工具和策略时。"
        "不适用：场景已经明确时（无需额外感知）。"
    ),
    short_desc="LLM语义场景感知",
    category=ToolCategory.PERCEPTION,
    tags=["scene", "context", "perception", "classification"],
    scenes=["daily", "desktop"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="text", type="string",
                         description="待分析的用户输入"),
        ToolParameterDef(name="available_tools", type="string", required=False,
                         description="可用工具列表（逗号分隔），用于生成推荐工具"),
    ],
    risk_level="low",
)


ENVIRONMENT_SENSE_V2_DEF = ToolDefinition(
    name="environment_sense_v2",
    description=(
        "增强版环境感知工具 — 返回真实系统环境信息。"
        "包括：操作系统、活跃窗口、网络状态、屏幕分辨率、时间上下文。"
        "适用场景：Agent需要了解当前运行环境以做出合适决策时。"
    ),
    short_desc="真实系统环境感知",
    category=ToolCategory.PERCEPTION,
    tags=["environment", "system", "perception", "os"],
    scenes=["desktop", "daily"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="include_processes", type="boolean", required=False,
                         description="是否包含活跃进程列表，默认false"),
        ToolParameterDef(name="include_network", type="boolean", required=False,
                         description="是否检测网络状态，默认true"),
    ],
    risk_level="low",
)


def _parse_json_from_llm(text: str) -> dict[str, Any] | None:
    match = re.search(r'\{[\s\S]*\}', text)
    if not match:
        return None
    try:
        return json.loads(match.group())
    except (json.JSONDecodeError, ValueError):
        return None


async def emotion_perceive_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    text = str(params.get("text", ""))
    extra_context = str(params.get("context", ""))

    if not text:
        return ToolResult(
            success=False,
            error="缺少待分析文本(text参数)",
            duration=time.time() - start,
        )

    try:
        from agent.llm.provider import LLMProvider
        from agent.core.engine import get_engine
        engine = get_engine()
        llm = getattr(engine, "_llm", None) or getattr(engine, "llm", None)
        if llm is None:
            return ToolResult(
                success=True,
                output=json.dumps({
                    "type": "neutral",
                    "intensity": 0.5,
                    "potentialNeeds": [],
                    "confidence": 0.0,
                    "method": "rule_fallback",
                }, ensure_ascii=False),
                duration=time.time() - start,
            )

        context_part = f"\n额外上下文: {extra_context}" if extra_context else ""
        prompt = (
            "你是情绪分析专家。分析以下用户文本的情绪状态，严格返回JSON：\n"
            "{\n"
            '  "type": "happy|sad|angry|anxious|frustrated|neutral|curious|confident",\n'
            '  "intensity": 0.0到1.0的浮点数,\n'
            '  "potentialNeeds": ["需求1", "需求2"],\n'
            '  "confidence": 0.0到1.0的浮点数\n'
            "}\n\n"
            f"用户文本: {text}{context_part}"
        )

        result = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            use_cache=True,
            task_type="cheap",
        )
        content = result.get("content", "")
        parsed = _parse_json_from_llm(content)

        if parsed:
            valid_types = {"happy", "sad", "angry", "anxious", "frustrated", "neutral", "curious", "confident"}
            if parsed.get("type") not in valid_types:
                parsed["type"] = "neutral"
            parsed["intensity"] = max(0.0, min(1.0, float(parsed.get("intensity", 0.5))))
            parsed["confidence"] = max(0.0, min(1.0, float(parsed.get("confidence", 0.0))))
            parsed["method"] = "llm"
            return ToolResult(
                success=True,
                output=json.dumps(parsed, ensure_ascii=False),
                duration=time.time() - start,
            )

        fallback = _emotion_rule_fallback(text)
        fallback["method"] = "rule_fallback"
        return ToolResult(
            success=True,
            output=json.dumps(fallback, ensure_ascii=False),
            duration=time.time() - start,
        )

    except Exception as e:
        fallback = _emotion_rule_fallback(text)
        fallback["method"] = "rule_fallback_error"
        return ToolResult(
            success=True,
            output=json.dumps(fallback, ensure_ascii=False),
            duration=time.time() - start,
        )


def _emotion_rule_fallback(text: str) -> dict[str, Any]:
    t = text.lower()
    rules: list[tuple[list[str], str, float, list[str]]] = [
        (["烦", "崩溃", "跑不通", "报错", "失败", "搞不定", "damn", "frustrating"], "frustrated", 0.7, ["debugging_help", "emotional_support"]),
        (["气死", "愤怒", "太过分", "angry", "furious"], "angry", 0.8, ["emotional_support", "clarification"]),
        (["难过", "伤心", "失望", "sad", "disappointed"], "sad", 0.6, ["emotional_support"]),
        (["太棒了", "成功了", "终于", "开心", "awesome", "great"], "happy", 0.8, []),
        (["着急", "担心", "焦虑", "anxious", "worried"], "anxious", 0.6, ["reassurance", "quick_solution"]),
        (["好奇", "想知道", "为什么", "how", "why"], "curious", 0.5, ["explanation", "information"]),
    ]
    for keywords, etype, intensity, needs in rules:
        if any(kw in t for kw in keywords):
            return {"type": etype, "intensity": intensity, "potentialNeeds": needs, "confidence": 0.6}
    return {"type": "neutral", "intensity": 0.5, "potentialNeeds": [], "confidence": 0.3}


async def scene_perceive_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    text = str(params.get("text", ""))
    available_tools_str = str(params.get("available_tools", ""))

    if not text:
        return ToolResult(
            success=False,
            error="缺少待分析文本(text参数)",
            duration=time.time() - start,
        )

    try:
        from agent.llm.provider import LLMProvider
        from agent.core.engine import get_engine
        engine = get_engine()
        llm = getattr(engine, "_llm", None) or getattr(engine, "llm", None)
        if llm is None:
            fallback = _scene_rule_fallback(text)
            fallback["method"] = "rule_fallback"
            return ToolResult(
                success=True,
                output=json.dumps(fallback, ensure_ascii=False),
                duration=time.time() - start,
            )

        tools_hint = ""
        if available_tools_str:
            tools_hint = f"\n可用工具: {available_tools_str}"

        prompt = (
            "你是场景识别专家。分析以下用户输入的场景类型，严格返回JSON：\n"
            "{\n"
            '  "type": "场景类型",\n'
            '  "interactionMode": "text|voice|gui",\n'
            '  "recommendedTools": ["工具1", "工具2"],\n'
            '  "confidence": 0.0到1.0的浮点数\n'
            "}\n\n"
            "可选场景类型: coding, debugging, code_review, writing, meeting, "
            "presentation, research, data_analysis, deployment, monitoring, "
            "daily, general, file_management, system_admin, learning\n\n"
            f"用户输入: {text}{tools_hint}"
        )

        result = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            use_cache=True,
            task_type="cheap",
        )
        content = result.get("content", "")
        parsed = _parse_json_from_llm(content)

        if parsed:
            valid_modes = {"text", "voice", "gui"}
            if parsed.get("interactionMode") not in valid_modes:
                parsed["interactionMode"] = "text"
            parsed["confidence"] = max(0.0, min(1.0, float(parsed.get("confidence", 0.0))))
            parsed["method"] = "llm"
            return ToolResult(
                success=True,
                output=json.dumps(parsed, ensure_ascii=False),
                duration=time.time() - start,
            )

        fallback = _scene_rule_fallback(text)
        fallback["method"] = "rule_fallback"
        return ToolResult(
            success=True,
            output=json.dumps(fallback, ensure_ascii=False),
            duration=time.time() - start,
        )

    except Exception as e:
        fallback = _scene_rule_fallback(text)
        fallback["method"] = "rule_fallback_error"
        return ToolResult(
            success=True,
            output=json.dumps(fallback, ensure_ascii=False),
            duration=time.time() - start,
        )


def _scene_rule_fallback(text: str) -> dict[str, Any]:
    t = text.lower()
    rules: list[tuple[list[str], str, list[str]]] = [
        (["review", "pr", "代码审查", "审查"], "code_review", ["file_read", "code_analyze"]),
        (["debug", "调试", "报错", "bug", "错误", "traceback"], "debugging", ["shell_exec", "file_read", "code_analyze"]),
        (["部署", "deploy", "发布", "上线", "ci/cd"], "deployment", ["shell_exec", "file_read"]),
        (["监控", "monitor", "日志", "log", "alert"], "monitoring", ["shell_exec", "file_read"]),
        (["分析数据", "data analysis", "统计", "报表", "可视化"], "data_analysis", ["execute_code", "file_read"]),
        (["写", "写作", "文档", "document", "write", "文章"], "writing", ["file_write", "file_read"]),
        (["搜索", "search", "查找", "查询", "调研"], "research", ["web_search", "file_read"]),
        (["代码", "code", "编程", "实现", "开发", "函数", "类"], "coding", ["file_read", "file_write", "code_analyze", "execute_code"]),
        (["文件", "file", "目录", "folder", "移动", "复制"], "file_management", ["file_read", "file_write", "shell_exec"]),
        (["系统", "system", "服务", "service", "进程", "端口"], "system_admin", ["shell_exec"]),
        (["学习", "learn", "教程", "tutorial", "解释"], "learning", ["web_search", "file_read"]),
    ]
    for keywords, scene_type, tools in rules:
        if any(kw in t for kw in keywords):
            return {"type": scene_type, "interactionMode": "text", "recommendedTools": tools, "confidence": 0.6}
    return {"type": "general", "interactionMode": "text", "recommendedTools": [], "confidence": 0.3}


async def environment_sense_v2_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    include_processes = bool(params.get("include_processes", False))
    include_network = bool(params.get("include_network", True))

    try:
        import platform
        import datetime

        os_info = f"{platform.system()} {platform.release()}".strip()
        if not os_info:
            os_info = platform.platform()

        now = datetime.datetime.now()
        hour = now.hour
        if 6 <= hour < 12:
            time_ctx = "上午(工作时间)"
        elif 12 <= hour < 14:
            time_ctx = "中午(休息时间)"
        elif 14 <= hour < 18:
            time_ctx = "下午(工作时间)"
        elif 18 <= hour < 22:
            time_ctx = "晚间(个人时间)"
        else:
            time_ctx = "深夜(休息时间)"

        weekday = now.weekday()
        if weekday < 5:
            time_ctx += " 工作日"
        else:
            time_ctx += " 周末"

        active_window = ""
        try:
            if platform.system() == "Windows":
                import ctypes
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                if hwnd:
                    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd) + 1
                    buf = ctypes.create_unicode_buffer(length)
                    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length)
                    active_window = buf.value
            elif platform.system() == "Darwin":
                import subprocess
                result = subprocess.run(
                    ["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
                    capture_output=True, text=True, timeout=2,
                )
                if result.returncode == 0:
                    active_window = result.stdout.strip()
        except Exception as _exc:
            log_ignored(log, "tools.environment_sense_v2_executor", _exc)

        network_status = "unknown"
        if include_network:
            try:
                import socket
                socket.create_connection(("8.8.8.8", 53), timeout=2)
                network_status = "online"
            except Exception:
                network_status = "offline"

        screen_resolution = ""
        try:
            if platform.system() == "Windows":
                import ctypes
                user32 = ctypes.windll.user32
                screen_resolution = f"{user32.GetSystemMetrics(0)}x{user32.GetSystemMetrics(1)}"
        except Exception as _exc:
            log_ignored(log, "tools.environment_sense_v2_executor", _exc)

        processes: list[str] = []
        if include_processes:
            try:
                import subprocess
                if platform.system() == "Windows":
                    result = subprocess.run(
                        ["tasklist", "/FO", "CSV", "/NH"],
                        capture_output=True, text=True, timeout=5,
                    )
                    for line in result.stdout.strip().split("\n")[:20]:
                        parts = line.strip().strip('"').split('","')
                        if parts:
                            processes.append(parts[0])
                else:
                    result = subprocess.run(
                        ["ps", "aux"], capture_output=True, text=True, timeout=5,
                    )
                    for line in result.stdout.strip().split("\n")[1:21]:
                        parts = line.split()
                        if len(parts) >= 11:
                            processes.append(parts[10][:50])
            except Exception as _exc:
                log_ignored(log, "tools.environment_sense_v2_executor", _exc)

        data = {
            "os": os_info,
            "activeWindow": active_window,
            "networkStatus": network_status,
            "timeContext": time_ctx,
            "screenResolution": screen_resolution,
            "hostname": platform.node(),
            "pythonVersion": platform.python_version(),
        }
        if processes:
            data["activeProcesses"] = processes[:20]

        return ToolResult(
            success=True,
            output=json.dumps(data, ensure_ascii=False),
            duration=time.time() - start,
        )

    except Exception as e:
        return ToolResult(
            success=False,
            error=f"环境感知失败: {e}",
            duration=time.time() - start,
        )


TOOL_DEFINITIONS = [
    (EMOTION_PERCEIVE_DEF, emotion_perceive_executor),
    (SCENE_PERCEIVE_DEF, scene_perceive_executor),
    (ENVIRONMENT_SENSE_V2_DEF, environment_sense_v2_executor),
]


def register_perception_tools(registry: Any) -> None:
    for definition, executor in TOOL_DEFINITIONS:
        if not registry.has(definition.name):
            registry.register(definition, executor)
            log.info(f"Perception tool registered: {definition.name}")
