"""平台级工具集动态开关 — 不同接入平台的工具权限边界。

定义 CLI/飞书/微信/钉钉/HTTP API/Web UI/Cron 等平台的工具集映射和风险约束。
不同平台有不同的安全边界和交互限制，需要通过工具集裁剪来适配。

Usage:
    from agent.tools.platform_toolset import (
        AgentPlatform, PLATFORM_TOOLSET_MAP, PLATFORM_RISK_CONSTRAINTS,
        resolve_tools_for_platform,
    )
    tools = resolve_tools_for_platform(
        platform=AgentPlatform.FEISHU,
        tool_registry=registry,
        toolset_registry=ts_registry,
    )
"""

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agent.tools.registry import ToolDefinition, ToolRegistry
    from agent.tools.toolset_registry import ToolsetRegistry


class AgentPlatform(str, Enum):
    """Agent 接入平台标识。

    不同平台有不同的交互限制和安全边界：
    - CLI: 命令行环境，全功能
    - FEISHU/WECHAT/DINGTALK: IM 机器人，无桌面/浏览器能力
    - HTTP_API: OpenAI 兼容 API，全功能但需审批
    - WEB_UI: 前端 Web 界面，全功能
    - CRON: 定时任务，仅系统/网络/记忆
    """

    CLI = "cli"
    FEISHU = "feishu"
    WECHAT = "wechat"
    DINGTALK = "dingtalk"
    HTTP_API = "http_api"
    WEB_UI = "web_ui"
    CRON = "cron"


PLATFORM_TOOLSET_MAP: dict[AgentPlatform, str] = {
    AgentPlatform.CLI: "full",
    AgentPlatform.FEISHU: "daily",
    AgentPlatform.WECHAT: "daily",
    AgentPlatform.DINGTALK: "daily",
    AgentPlatform.HTTP_API: "full",
    AgentPlatform.WEB_UI: "full",
    AgentPlatform.CRON: "minimal",
}

PLATFORM_RISK_CONSTRAINTS: dict[AgentPlatform, list[str]] = {
    AgentPlatform.FEISHU: [
        "shell_exec",
        "code_generate",
        "desktop_automate",
        "desktop_screenshot",
        "desktop_window",
        "desktop_clipboard",
        "browser_agent",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_screenshot",
        "browser_get_text",
        "browser_fill_form",
        "execute_code",
        "voice_interact",
    ],
    AgentPlatform.WECHAT: [
        "shell_exec",
        "code_generate",
        "desktop_automate",
        "desktop_screenshot",
        "desktop_window",
        "desktop_clipboard",
        "browser_agent",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_screenshot",
        "browser_get_text",
        "browser_fill_form",
        "execute_code",
        "voice_interact",
    ],
    AgentPlatform.DINGTALK: [
        "shell_exec",
        "code_generate",
        "desktop_automate",
        "desktop_screenshot",
        "desktop_window",
        "desktop_clipboard",
        "browser_agent",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_screenshot",
        "browser_get_text",
        "browser_fill_form",
        "execute_code",
        "voice_interact",
    ],
    AgentPlatform.HTTP_API: [
        "code_generate",
        "execute_code",
        "shell_exec",
        "desktop_automate",
    ],
    AgentPlatform.CRON: [
        "shell_exec",
        "code_generate",
        "execute_code",
        "desktop_automate",
        "desktop_screenshot",
        "browser_agent",
        "voice_interact",
    ],
    # CLI 和 WEB_UI 无限制
}

PLATFORM_DISPLAY_NAMES: dict[AgentPlatform, str] = {
    AgentPlatform.CLI: "命令行",
    AgentPlatform.FEISHU: "飞书",
    AgentPlatform.WECHAT: "微信",
    AgentPlatform.DINGTALK: "钉钉",
    AgentPlatform.HTTP_API: "HTTP API",
    AgentPlatform.WEB_UI: "Web 界面",
    AgentPlatform.CRON: "定时任务",
}


def resolve_tools_for_platform(
    platform: AgentPlatform,
    tool_registry: "ToolRegistry",
    toolset_registry: "ToolsetRegistry",
) -> list["ToolDefinition"]:
    """根据平台解析可用工具集。

    组合了两层过滤：
    1. 工具集基础过滤（PLATFORM_TOOLSET_MAP）
    2. 风险约束过滤（PLATFORM_RISK_CONSTRAINTS）

    Args:
        platform: 接入平台标识。
        tool_registry: 工具注册中心。
        toolset_registry: 工具集注册中心。

    Returns:
        list[ToolDefinition]: 该平台可用的工具定义列表。
    """
    toolset_id = PLATFORM_TOOLSET_MAP.get(platform, "full")
    resolved = toolset_registry.resolve(toolset_id, tool_registry)

    excluded = set(PLATFORM_RISK_CONSTRAINTS.get(platform, []))

    results = []
    for name in resolved.tool_names:
        if name not in excluded:
            definition = tool_registry.get_definition(name)
            if definition is not None:
                results.append(definition)

    return results


def get_platform_restricted_tools(
    platform: AgentPlatform,
) -> list[str]:
    """获取指定平台被禁用的工具列表。

    Args:
        platform: 接入平台标识。

    Returns:
        list[str]: 被禁用的工具名称列表。
    """
    return PLATFORM_RISK_CONSTRAINTS.get(platform, [])
