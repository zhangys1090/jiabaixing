from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable


class ToolCategory(str, Enum):
    """工具分类枚举。

    定义工具所属的领域分类，用于按场景筛选和组织工具。
    """

    MEMORY = "memory"
    FILE = "file"
    CODE = "code"
    DESKTOP = "desktop"
    COGNITION = "cognition"
    SYSTEM = "system"
    DAILY = "daily"
    NETWORK = "network"
    IOT = "iot"


@dataclass
class ToolParameterDef:
    """工具参数定义。

    Attributes:
        name: 参数名称。
        type: 参数类型。
        required: 是否必填。
        description: 参数描述。
        enum: 允许的枚举值。
    """

    name: str
    type: str = "string"
    required: bool = True
    description: str = ""
    enum: list[str] | None = None


@dataclass
class ToolDefinition:
    """工具定义——注册到系统的工具元数据。

    Attributes:
        name: 工具唯一名称。
        description: 工具功能描述。
        category: 工具分类。
        parameters: 参数定义列表。
        risk_level: 风险等级。
        permissions: 所需权限列表。
    """

    name: str
    description: str
    category: ToolCategory = ToolCategory.SYSTEM
    parameters: list[ToolParameterDef] = field(default_factory=list)
    risk_level: str = "low"
    permissions: list[str] = field(default_factory=list)


@dataclass
class ToolResult:
    """工具执行结果。

    Attributes:
        success: 是否成功。
        output: 输出文本。
        error: 错误信息。
        duration: 执行耗时（毫秒）。
        metadata: 附加元数据。
    """

    success: bool
    output: str = ""
    error: str | None = None
    duration: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


ToolExecutor = Callable[..., Awaitable[ToolResult]]


class ToolRegistry:
    """工具注册中心。

    统一管理所有可用工具的注册、发现和调用。支持按分类筛选、
    通配符搜索和Function Calling格式的Schema导出。

    Usage:
        registry = ToolRegistry()
        registry.register(ToolDefinition(...), my_executor)
        tools = registry.get_by_category(ToolCategory.CODE)
    """
    def __init__(self) -> None:
        self._tools: dict[str, tuple[ToolDefinition, ToolExecutor]] = {}

    def register(self, definition: ToolDefinition, executor: ToolExecutor) -> None:
        self._tools[definition.name] = (definition, executor)

    def unregister(self, name: str) -> bool:
        if name not in self._tools:
            return False
        del self._tools[name]
        return True

    def get(self, name: str) -> tuple[ToolDefinition, ToolExecutor] | None:
        return self._tools.get(name)

    def has(self, name: str) -> bool:
        return name in self._tools

    def get_definition(self, name: str) -> ToolDefinition | None:
        entry = self._tools.get(name)
        return entry[0] if entry else None

    def size(self) -> int:
        return len(self._tools)

    def get_by_category(self, category: ToolCategory) -> list[ToolDefinition]:
        return [d for d, _ in self._tools.values() if d.category == category]

    def get_all_definitions(self) -> list[ToolDefinition]:
        return [d for d, _ in self._tools.values()]

    async def execute(self, name: str, params: dict[str, Any] | None = None) -> ToolResult:
        entry = self._tools.get(name)
        if not entry:
            return ToolResult(success=False, error=f"Tool '{name}' not found")
        definition, executor = entry
        import asyncio
        import time
        from agent.config import TOOL_EXECUTE_TIMEOUT
        start = time.monotonic()
        try:
            result = await asyncio.wait_for(executor(params or {}), timeout=TOOL_EXECUTE_TIMEOUT)
            result.duration = time.monotonic() - start
            return result
        except asyncio.TimeoutError:
            return ToolResult(
                success=False,
                error=f"Tool '{name}' timed out after {TOOL_EXECUTE_TIMEOUT}s",
                duration=time.monotonic() - start,
            )
        except Exception as e:
            return ToolResult(success=False, error=str(e), duration=time.monotonic() - start)

    def to_openai_tools(self) -> list[dict[str, Any]]:
        tools = []
        for definition, _ in self._tools.values():
            params_properties: dict[str, Any] = {}
            required: list[str] = []
            for p in definition.parameters:
                prop: dict[str, Any] = {"type": p.type, "description": p.description}
                if p.enum:
                    prop["enum"] = p.enum
                params_properties[p.name] = prop
                if p.required:
                    required.append(p.name)

            tools.append({
                "type": "function",
                "function": {
                    "name": definition.name,
                    "description": definition.description,
                    "parameters": {
                        "type": "object",
                        "properties": params_properties,
                        "required": required,
                    },
                },
            })
        return tools


def register_default_tools(registry: ToolRegistry) -> int:
    count = 0

    from agent.tools.file_tools import (
        FILE_READ_DEF, FILE_LIST_DEF, FILE_GREP_DEF, FILE_SEARCH_DEF, FILE_EDIT_DEF,
        INCREMENTAL_EDIT_DEF, MULTI_FILE_EDIT_DEF,
        file_read_executor, file_list_executor, file_grep_executor,
        file_search_executor, file_edit_executor,
        incremental_edit_executor, multi_file_edit_executor,
    )
    for definition, executor in [
        (FILE_READ_DEF, file_read_executor),
        (FILE_LIST_DEF, file_list_executor),
        (FILE_GREP_DEF, file_grep_executor),
        (FILE_SEARCH_DEF, file_search_executor),
        (FILE_EDIT_DEF, file_edit_executor),
        (INCREMENTAL_EDIT_DEF, incremental_edit_executor),
        (MULTI_FILE_EDIT_DEF, multi_file_edit_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.memory_tools import (
        MEMORY_RECALL_DEF, MEMORY_SEARCH_DEF, MEMORY_STORE_DEF, KNOWLEDGE_QUERY_DEF,
        memory_recall_executor, memory_search_executor,
        memory_store_executor, knowledge_query_executor,
    )
    for definition, executor in [
        (MEMORY_RECALL_DEF, memory_recall_executor),
        (MEMORY_SEARCH_DEF, memory_search_executor),
        (MEMORY_STORE_DEF, memory_store_executor),
        (KNOWLEDGE_QUERY_DEF, knowledge_query_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.code_tools import (
        CODE_GENERATE_DEF, CODE_ANALYZE_DEF, CODE_FIX_DEF, SHELL_EXEC_DEF,
        CODE_REVIEW_DEF, CSV_ANALYZE_DEF,
        code_generate_executor, code_analyze_executor,
        code_fix_executor, shell_exec_executor,
        code_review_executor, csv_analyze_executor,
    )
    for definition, executor in [
        (CODE_GENERATE_DEF, code_generate_executor),
        (CODE_ANALYZE_DEF, code_analyze_executor),
        (CODE_FIX_DEF, code_fix_executor),
        (SHELL_EXEC_DEF, shell_exec_executor),
        (CODE_REVIEW_DEF, code_review_executor),
        (CSV_ANALYZE_DEF, csv_analyze_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.network_tools import (
        WEB_SEARCH_DEF, WEB_FETCH_DEF, TTS_SPEAK_DEF, CHART_GENERATE_DEF,
        web_search_executor, web_fetch_executor,
        tts_speak_executor, chart_generate_executor,
    )
    for definition, executor in [
        (WEB_SEARCH_DEF, web_search_executor),
        (WEB_FETCH_DEF, web_fetch_executor),
        (TTS_SPEAK_DEF, tts_speak_executor),
        (CHART_GENERATE_DEF, chart_generate_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.cognition_tools import (
        EMOTION_DETECT_DEF, SCENE_ANALYZE_DEF, SELF_REFLECT_DEF,
        emotion_detect_executor, scene_analyze_executor, self_reflect_executor,
    )
    for definition, executor in [
        (EMOTION_DETECT_DEF, emotion_detect_executor),
        (SCENE_ANALYZE_DEF, scene_analyze_executor),
        (SELF_REFLECT_DEF, self_reflect_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.system_tools import (
        ASK_CLARIFICATION_DEF, CONTEXT_MANAGE_DEF, PREVIEW_EXECUTION_DEF, ROLLBACK_CHANGES_DEF,
        ask_clarification_executor, context_manage_executor,
        preview_execution_executor, rollback_changes_executor,
    )
    for definition, executor in [
        (ASK_CLARIFICATION_DEF, ask_clarification_executor),
        (CONTEXT_MANAGE_DEF, context_manage_executor),
        (PREVIEW_EXECUTION_DEF, preview_execution_executor),
        (ROLLBACK_CHANGES_DEF, rollback_changes_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.daily_tools import (
        TASK_MANAGE_DEF, CALENDAR_DEF, REMINDER_SET_DEF, NOTE_TAKE_DEF,
        SYSTEM_STATUS_DEF, TASK_PRIORITY_DEF, TASK_DEPENDENCY_DEF,
        BATCH_TASK_DEF, TASK_ANALYTICS_DEF,
        task_manage_executor, calendar_executor, reminder_set_executor,
        note_take_executor, system_status_executor, task_priority_executor,
        task_dependency_executor, batch_task_executor, task_analytics_executor,
    )
    for definition, executor in [
        (TASK_MANAGE_DEF, task_manage_executor),
        (CALENDAR_DEF, calendar_executor),
        (REMINDER_SET_DEF, reminder_set_executor),
        (NOTE_TAKE_DEF, note_take_executor),
        (SYSTEM_STATUS_DEF, system_status_executor),
        (TASK_PRIORITY_DEF, task_priority_executor),
        (TASK_DEPENDENCY_DEF, task_dependency_executor),
        (BATCH_TASK_DEF, batch_task_executor),
        (TASK_ANALYTICS_DEF, task_analytics_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.lsp_tools import (
        LSP_COMPLETION_DEF, LSP_DIAGNOSTICS_DEF, LSP_HOVER_DEF,
        LSP_DEFINITION_DEF, LSP_REFERENCES_DEF, LSP_SYMBOLS_DEF,
        lsp_completion_executor, lsp_diagnostics_executor, lsp_hover_executor,
        lsp_definition_executor, lsp_references_executor, lsp_symbols_executor,
    )
    for definition, executor in [
        (LSP_COMPLETION_DEF, lsp_completion_executor),
        (LSP_DIAGNOSTICS_DEF, lsp_diagnostics_executor),
        (LSP_HOVER_DEF, lsp_hover_executor),
        (LSP_DEFINITION_DEF, lsp_definition_executor),
        (LSP_REFERENCES_DEF, lsp_references_executor),
        (LSP_SYMBOLS_DEF, lsp_symbols_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.desktop_tools import (
        DESKTOP_AUTOMATE_DEF, DESKTOP_SCREENSHOT_DEF,
        DESKTOP_WINDOW_DEF, DESKTOP_CLIPBOARD_DEF, DESKTOP_SHELL_DEF,
        desktop_automate_executor, desktop_screenshot_executor,
        desktop_window_executor, desktop_clipboard_executor, desktop_shell_executor,
    )
    for definition, executor in [
        (DESKTOP_AUTOMATE_DEF, desktop_automate_executor),
        (DESKTOP_SCREENSHOT_DEF, desktop_screenshot_executor),
        (DESKTOP_WINDOW_DEF, desktop_window_executor),
        (DESKTOP_CLIPBOARD_DEF, desktop_clipboard_executor),
        (DESKTOP_SHELL_DEF, desktop_shell_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.browser_tools import (
        BROWSER_AGENT_DEF, BROWSER_NAVIGATE_DEF, BROWSER_SCREENSHOT_DEF,
        BROWSER_CLICK_DEF, BROWSER_TYPE_DEF, BROWSER_GET_TEXT_DEF,
        browser_agent_executor, browser_navigate_executor, browser_screenshot_executor,
        browser_click_executor, browser_type_executor, browser_get_text_executor,
    )
    for definition, executor in [
        (BROWSER_AGENT_DEF, browser_agent_executor),
        (BROWSER_NAVIGATE_DEF, browser_navigate_executor),
        (BROWSER_SCREENSHOT_DEF, browser_screenshot_executor),
        (BROWSER_CLICK_DEF, browser_click_executor),
        (BROWSER_TYPE_DEF, browser_type_executor),
        (BROWSER_GET_TEXT_DEF, browser_get_text_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.network_enhanced_tools import (
        IMAGE_GENERATE_DEF, SKILL_CREATE_DEF, MESSAGE_PUSH_DEF,
        image_generate_executor, skill_create_executor, message_push_executor,
    )
    for definition, executor in [
        (IMAGE_GENERATE_DEF, image_generate_executor),
        (SKILL_CREATE_DEF, skill_create_executor),
        (MESSAGE_PUSH_DEF, message_push_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.daily_enhanced_tools import (
        MORNING_BRIEF_DEF, NATURAL_SCHEDULE_DEF, SKILL_SHARE_DEF,
        morning_brief_executor, natural_schedule_executor, skill_share_executor,
    )
    for definition, executor in [
        (MORNING_BRIEF_DEF, morning_brief_executor),
        (NATURAL_SCHEDULE_DEF, natural_schedule_executor),
        (SKILL_SHARE_DEF, skill_share_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.system_tools import (
        FILE_DEDUP_DEF, LOG_VIEW_DEF, SHELL_GENERATE_DEF,
        VOICE_INTERACT_DEF, DELEGATE_TASK_DEF, GET_ACTIVE_FILE_DEF,
        file_dedup_executor, log_view_executor, shell_generate_executor,
        voice_interact_executor, delegate_task_executor, get_active_file_executor,
    )
    for definition, executor in [
        (FILE_DEDUP_DEF, file_dedup_executor),
        (LOG_VIEW_DEF, log_view_executor),
        (SHELL_GENERATE_DEF, shell_generate_executor),
        (VOICE_INTERACT_DEF, voice_interact_executor),
        (DELEGATE_TASK_DEF, delegate_task_executor),
        (GET_ACTIVE_FILE_DEF, get_active_file_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.homeassistant_tool import (
        HA_CONTROL_DEF, HA_SCENE_DEF, HA_SENSOR_DEF,
        ha_control_executor, ha_scene_executor, ha_sensor_executor,
    )
    for definition, executor in [
        (HA_CONTROL_DEF, ha_control_executor),
        (HA_SCENE_DEF, ha_scene_executor),
        (HA_SENSOR_DEF, ha_sensor_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    return count
