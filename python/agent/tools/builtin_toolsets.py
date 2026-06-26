from __future__ import annotations

from agent.tools.registry import ToolCategory
from agent.tools.toolset_registry import ToolsetDefinition, ToolsetEntry, get_toolset_registry

BASE_TOOLSET = ToolsetDefinition(
    id="base",
    display_name="基础工具集",
    description="所有 Agent 共用的最小工具集（记忆+认知+系统基础）",
    includes=[
        ToolsetEntry(category=ToolCategory.MEMORY),
        ToolsetEntry(category=ToolCategory.COGNITION),
        ToolsetEntry(name="ask_clarification"),
        ToolsetEntry(name="system_status"),
        ToolsetEntry(name="context_manage"),
    ],
    max_tools=0,
)

CODING_TOOLSET = ToolsetDefinition(
    id="coding",
    display_name="编码工具集",
    description="CodingAgent 专用：文件操作 + 代码工具 + Shell 执行",
    extends="base",
    includes=[
        ToolsetEntry(category=ToolCategory.FILE),
        ToolsetEntry(category=ToolCategory.CODE),
        ToolsetEntry(name="shell_exec"),
        ToolsetEntry(name="execute_code"),
        ToolsetEntry(name="preview_execution"),
        ToolsetEntry(name="rollback_changes"),
        ToolsetEntry(name="delegate_task"),
    ],
    max_tools=20,
)

DESKTOP_TOOLSET = ToolsetDefinition(
    id="desktop",
    display_name="桌面工具集",
    description="DesktopAgent 专用：桌面自动化 + 截图 + 视觉",
    extends="base",
    includes=[
        ToolsetEntry(category=ToolCategory.DESKTOP),
        ToolsetEntry(name="execute_code"),
        ToolsetEntry(name="shell_exec"),
        ToolsetEntry(name="voice_interact"),
    ],
    max_tools=15,
)

DAILY_TOOLSET = ToolsetDefinition(
    id="daily",
    display_name="日常管理工具集",
    description="DailyAgent 专用：日程/任务/提醒/笔记",
    extends="base",
    includes=[ToolsetEntry(category=ToolCategory.DAILY)],
    max_tools=20,
)

NETWORK_TOOLSET = ToolsetDefinition(
    id="network",
    display_name="网络工具集",
    description="ResearchAgent 专用：搜索/抓取/图表/图像生成",
    extends="base",
    includes=[ToolsetEntry(category=ToolCategory.NETWORK), ToolsetEntry(name="knowledge_query")],
    max_tools=15,
)

FULL_TOOLSET = ToolsetDefinition(
    id="full",
    display_name="全能工具集",
    description="OrchestratorAgent 专用：包含所有已注册工具",
    includes=[
        ToolsetEntry(category=ToolCategory.MEMORY),
        ToolsetEntry(category=ToolCategory.COGNITION),
        ToolsetEntry(category=ToolCategory.FILE),
        ToolsetEntry(category=ToolCategory.CODE),
        ToolsetEntry(category=ToolCategory.DESKTOP),
        ToolsetEntry(category=ToolCategory.DAILY),
        ToolsetEntry(category=ToolCategory.NETWORK),
        ToolsetEntry(category=ToolCategory.IOT),
        ToolsetEntry(category=ToolCategory.SYSTEM),
    ],
    max_tools=0,
)

MINIMAL_TOOLSET = ToolsetDefinition(
    id="minimal",
    display_name="最小工具集",
    description="轻量对话场景：仅认知 + 系统状态",
    includes=[
        ToolsetEntry(category=ToolCategory.COGNITION),
        ToolsetEntry(name="system_status"),
        ToolsetEntry(name="ask_clarification"),
    ],
    max_tools=0,
)

IOT_TOOLSET = ToolsetDefinition(
    id="iot",
    display_name="智能家居工具集",
    description="IoTAgent 专用：Home Assistant 设备控制、场景管理、传感器查询",
    extends="base",
    includes=[
        ToolsetEntry(category=ToolCategory.IOT),
        ToolsetEntry(name="natural_schedule"),
        ToolsetEntry(name="reminder_set"),
    ],
    max_tools=10,
)

BUILTIN_TOOLSETS: list[ToolsetDefinition] = [
    BASE_TOOLSET,
    MINIMAL_TOOLSET,
    CODING_TOOLSET,
    DESKTOP_TOOLSET,
    DAILY_TOOLSET,
    NETWORK_TOOLSET,
    IOT_TOOLSET,
    FULL_TOOLSET,
]

AGENT_TOOLSET_MAP: dict[str, str] = {
    "coding": "coding",
    "desktop": "desktop",
    "daily": "daily",
    "research": "network",
    "orchestrator": "full",
    "iot": "iot",
    "base": "base",
    "minimal": "minimal",
}


def register_builtin_toolsets() -> None:
    """注册所有内置工具集到全局工具集注册中心。

    包括基础工具集、编码工具集、桌面工具集、日常管理工具集、
    网络工具集、全能工具集和最小工具集。
    """
    registry = get_toolset_registry()
    for definition in BUILTIN_TOOLSETS:
        registry.register(definition)


def get_default_toolset_for_agent(agent_type: str) -> str:
    return AGENT_TOOLSET_MAP.get(agent_type, "base")
