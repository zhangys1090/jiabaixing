from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Awaitable, Callable
from agent.core.logger import StructuredLogger
log = StructuredLogger("registry")

if TYPE_CHECKING:  # 仅供类型注解使用，避免 toolset_registry ↔ registry 循环导入
    from agent.tools.toolset_registry import SceneToToolsetMapper


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
    PERCEPTION = "perception"
    AUTOMATION = "automation"


@dataclass
class ToolParameterDef:
    """工具参数定义。

    Attributes:
        name: 参数名称。
        type: 参数类型。
        required: 是否必填。
        description: 参数描述。
        enum: 允许的枚举值。
        items: 数组元素类型描述（type=array 时使用）。
        properties: 对象属性定义（type=object 时使用）。
        default: 默认值。
    """

    name: str
    type: str = "string"
    required: bool = True
    description: str = ""
    enum: list[str] | None = None
    items: dict[str, Any] | None = None
    properties: dict[str, Any] | None = None
    default: Any = None


@dataclass
class ToolDefinition:
    """工具定义——注册到系统的工具元数据。

    Attributes:
        name: 工具唯一名称。
        description: 工具功能描述（完整描述）。
        short_desc: 简短描述（渐进式披露 Level 1: 一句话概括）。
        category: 工具分类。
        tags: 语义标签列表（如 'git', 'search', 'file', 'code', 'debug'）。
        scenes: 适用场景列表（如 'coding', 'desktop', 'daily', 'research'）。
        capability_level: 工具能力等级 1=基础 2=中级 3=高级。
        parameters: 参数定义列表。
        risk_level: 风险等级。
        permissions: 所需权限列表。
    """

    name: str
    description: str
    short_desc: str = ""
    category: ToolCategory = ToolCategory.SYSTEM
    tags: list[str] = field(default_factory=list)
    scenes: list[str] = field(default_factory=list)
    capability_level: int = 1  # 1=基础 2=中级 3=高级
    parameters: list[ToolParameterDef] = field(default_factory=list)
    risk_level: str = "low"
    permissions: list[str] = field(default_factory=list)
    timeout: float = 0.0


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
        self._feedback_collector: Any | None = None

    def register(self, definition: ToolDefinition, executor: ToolExecutor) -> None:
        if definition.name in self._tools:
            log.warning(
                "工具注册覆盖已有同名工具",
                tool_name=definition.name,
                hint="检查是否存在重复注册或工具名冲突",
            )
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

    def filter_tools(self, names: set[str] | None) -> list[ToolDefinition]:
        """仅保留 names 中的工具定义（活跃工具集过滤）。

        Args:
            names: 允许保留的工具名集合；为 None / 空集合时返回全部（不裁剪）。

        Returns:
            list[ToolDefinition]: 过滤后的工具定义列表（保持注册顺序）。
        """
        if not names:
            return [d for d, _ in self._tools.values()]
        name_set = {n for n in names if n}
        return [d for n, (d, _) in self._tools.items() if n in name_set]

    def get_by_tags(self, tags: list[str]) -> list[ToolDefinition]:
        """按语义标签过滤工具（交集匹配）。"""
        if not tags:
            return []
        tag_set = {t.lower() for t in tags}
        return [
            d for d, _ in self._tools.values()
            if d.tags and tag_set & {t.lower() for t in d.tags}
        ]

    def get_by_scene(self, scene: str) -> list[ToolDefinition]:
        """按适用场景过滤工具。"""
        s = scene.lower()
        return [
            d for d, _ in self._tools.values()
            if d.scenes and s in {sc.lower() for sc in d.scenes}
        ]

    def get_by_capability_level(self, max_level: int = 3) -> list[ToolDefinition]:
        """按能力等级过滤（渐进式披露）。max_level: 1=基础 2=中级 3=高级。"""
        return [
            d for d, _ in self._tools.values()
            if d.capability_level <= max_level
        ]

    def filter_by(
        self,
        *,
        tags: list[str] | None = None,
        scene: str | None = None,
        max_capability_level: int | None = None,
        exclude_categories: list[ToolCategory] | None = None,
    ) -> list[ToolDefinition]:
        """多条件组合过滤：标签 + 场景 + 能力等级 + 排除分类。"""
        results = [d for d, _ in self._tools.values()]

        if tags:
            tag_set = {t.lower() for t in tags}
            results = [
                d for d in results
                if d.tags and tag_set & {t.lower() for t in d.tags}
            ]

        if scene:
            s = scene.lower()
            results = [
                d for d in results
                if d.scenes and s in {sc.lower() for sc in d.scenes}
            ]

        if max_capability_level is not None:
            results = [d for d in results if d.capability_level <= max_capability_level]

        if exclude_categories:
            cat_set = set(exclude_categories)
            results = [d for d in results if d.category not in cat_set]

        return results

    def get_all_definitions(self) -> list[ToolDefinition]:
        return [d for d, _ in self._tools.values()]

    def get_entries(self) -> list[tuple[str, "ToolDefinition", "ToolExecutor"]]:
        """返回全部 (name, definition, executor) 三元组。

        用于构建白名单子注册表（如子 Agent 工具下放）等场景，
        避免在调用方直接访问私有属性 ``_tools``。
        """
        return [(n, d, e) for n, (d, e) in self._tools.items()]

    def set_feedback_collector(self, collector: Any) -> None:
        """设置反馈收集器实例。

        Args:
            collector: FeedbackCollector 实例，用于在工具执行后收集反馈数据。
        """
        self._feedback_collector = collector

    def _record_feedback(self, tool_name: str, result: ToolResult) -> None:
        """记录工具调用的反馈数据（异步flush，不影响执行性能）。

        Args:
            tool_name: 工具名称。
            result: 工具执行结果。
        """
        if self._feedback_collector is None:
            return
        try:
            self._feedback_collector.record_tool_call(
                tool_name=tool_name,
                success=result.success,
                duration=result.duration,
                error=result.error,
            )
            self._feedback_collector.maybe_flush()
        except Exception as exc:
            self.log.warning("记录工具反馈失败，已跳过: %s", exc)

    async def execute(self, name: str, params: dict[str, Any] | None = None) -> ToolResult:
        entry = self._tools.get(name)
        if not entry:
            return ToolResult(success=False, error=f"Tool '{name}' not found")
        definition, executor = entry
        import asyncio
        import time
        from agent.config import TOOL_EXECUTE_TIMEOUT
        # OTel追踪：记录工具执行span
        from agent.core.tracing import get_tracing_manager
        _tracing = get_tracing_manager()
        _span = _tracing.start_span(f"tool.{name}", {"tool_name": name})
        start = time.monotonic()
        try:
            # timeout<=0 视为不设置超时（审计 T-07：wait_for(..., timeout=0) 会立即抛 TimeoutError）
            _timeout = TOOL_EXECUTE_TIMEOUT if TOOL_EXECUTE_TIMEOUT and TOOL_EXECUTE_TIMEOUT > 0 else None
            result = await asyncio.wait_for(executor(params or {}), timeout=_timeout)
            result.duration = time.monotonic() - start
            # 输出大小限制（仅成功时截断）
            if result.success and result.output:
                from agent.tools.output_limiter import get_output_limiter
                limiter = get_output_limiter()
                truncated = limiter.limit(name, result.output)
                if truncated.was_truncated:
                    result.output = truncated.output + f"\n\n{truncated.truncation_note}"
                    result.metadata = result.metadata or {}
                    result.metadata["truncated"] = True
                    result.metadata["original_chars"] = truncated.original_chars
                    result.metadata["truncated_chars"] = truncated.truncated_chars
                    result.metadata["original_lines"] = truncated.original_lines
                    result.metadata["truncated_lines"] = truncated.truncated_lines
            # 反馈收集钩子：异步记录工具调用结果，不影响执行性能
            self._record_feedback(name, result)
            _tracing.end_span(_span)
            return result
        except asyncio.TimeoutError:
            result = ToolResult(
                success=False,
                error=f"Tool '{name}' timed out after {TOOL_EXECUTE_TIMEOUT}s",
                duration=time.monotonic() - start,
            )
            self._record_feedback(name, result)
            _tracing.end_span(_span)
            return result
        except Exception as e:
            log.debug("registry 异常处理", error=str(e))
            result = ToolResult(
                success=False,
                error=f"{type(e).__name__}: {e}",
                duration=time.monotonic() - start,
                metadata={"exception_type": type(e).__name__, "exception_module": type(e).__module__},
            )
            self._record_feedback(name, result)
            _tracing.end_span(_span)
            return result

    def to_openai_tools(self) -> list[dict[str, Any]]:
        tools = []
        for definition, _ in self._tools.values():
            params_properties: dict[str, Any] = {}
            required: list[str] = []
            for p in definition.parameters:
                prop: dict[str, Any] = {"type": p.type, "description": p.description}
                if p.enum:
                    prop["enum"] = p.enum
                if p.items and p.type == "array":
                    prop["items"] = p.items
                if p.properties and p.type == "object":
                    prop["properties"] = p.properties
                if p.default is not None:
                    prop["default"] = p.default
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


def register_default_tools(registry: ToolRegistry, session_store: Any = None) -> int:
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

    # ===== 多模态文件解析工具 =====
    from agent.tools.file_parse_tools import (
        PDF_PARSE_DEF, XLSX_PARSE_DEF, DOCX_PARSE_DEF,
        OCR_EXTRACT_DEF,
        pdf_parse_executor, xlsx_parse_executor, docx_parse_executor,
        ocr_extract_executor,
    )
    for definition, executor in [
        (PDF_PARSE_DEF, pdf_parse_executor),
        (XLSX_PARSE_DEF, xlsx_parse_executor),
        (DOCX_PARSE_DEF, docx_parse_executor),
        (OCR_EXTRACT_DEF, ocr_extract_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    # ===== Vision工具 =====
    from agent.tools.vision_tools import (
        VISION_UNDERSTAND_DEF,
        vision_understand_executor,
    )
    registry.register(VISION_UNDERSTAND_DEF, vision_understand_executor)
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
        CODE_GENERATE_AST_DEF, CODE_EDIT_AST_DEF,
        code_generate_executor, code_analyze_executor,
        code_fix_executor, shell_exec_executor,
        code_review_executor, csv_analyze_executor,
        code_generate_ast_executor, code_edit_ast_executor,
    )
    for definition, executor in [
        (CODE_GENERATE_DEF, code_generate_executor),
        (CODE_ANALYZE_DEF, code_analyze_executor),
        (CODE_FIX_DEF, code_fix_executor),
        (SHELL_EXEC_DEF, shell_exec_executor),
        (CODE_REVIEW_DEF, code_review_executor),
        (CSV_ANALYZE_DEF, csv_analyze_executor),
        (CODE_GENERATE_AST_DEF, code_generate_ast_executor),
        (CODE_EDIT_AST_DEF, code_edit_ast_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    # ===== 重构工具链（AST感知：重命名/提取/移动/预览） =====
    from agent.tools.refactor_tools import (
        REFACTOR_RENAME_DEF, REFACTOR_EXTRACT_DEF, REFACTOR_MOVE_DEF,
        REFACTOR_PREVIEW_DEF, REFACTOR_DEPGRAPH_DEF,
        refactor_rename_executor, refactor_extract_executor,
        refactor_move_executor, refactor_preview_executor, refactor_depgraph_executor,
    )
    for definition, executor in [
        (REFACTOR_RENAME_DEF, refactor_rename_executor),
        (REFACTOR_EXTRACT_DEF, refactor_extract_executor),
        (REFACTOR_MOVE_DEF, refactor_move_executor),
        (REFACTOR_PREVIEW_DEF, refactor_preview_executor),
        (REFACTOR_DEPGRAPH_DEF, refactor_depgraph_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    # ===== 测试链路（审计 P1-1） =====
    from agent.tools.test_tools import (
        TEST_RUN_DEF, TEST_GENERATE_DEF, COVERAGE_READ_DEF,
        test_run_executor, test_generate_executor, coverage_read_executor,
    )
    for definition, executor in [
        (TEST_RUN_DEF, test_run_executor),
        (TEST_GENERATE_DEF, test_generate_executor),
        (COVERAGE_READ_DEF, coverage_read_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    # ===== Git 链路（审计 P1-2） =====
    from agent.tools.git_tools import (
        GIT_STATUS_DEF, GIT_DIFF_DEF, GIT_COMMIT_DEF, GIT_LOG_DEF,
        git_status_executor, git_diff_executor, git_commit_executor, git_log_executor,
    )
    for definition, executor in [
        (GIT_STATUS_DEF, git_status_executor),
        (GIT_DIFF_DEF, git_diff_executor),
        (GIT_COMMIT_DEF, git_commit_executor),
        (GIT_LOG_DEF, git_log_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.network_tools import (
        WEB_SEARCH_DEF, WEB_FETCH_DEF, CHART_GENERATE_DEF,
        web_search_executor, web_fetch_executor,
        chart_generate_executor,
    )
    for definition, executor in [
        (WEB_SEARCH_DEF, web_search_executor),
        (WEB_FETCH_DEF, web_fetch_executor),
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
        DESKTOP_WINDOW_DEF, DESKTOP_CLIPBOARD_DEF,
        DESKTOP_UIA_ACTION_DEF, DESKTOP_EXPLORE_DEF,
        desktop_automate_executor, desktop_screenshot_executor,
        desktop_window_executor, desktop_clipboard_executor,
        desktop_uia_action_executor, desktop_explore_executor,
    )
    for definition, executor in [
        (DESKTOP_AUTOMATE_DEF, desktop_automate_executor),
        (DESKTOP_SCREENSHOT_DEF, desktop_screenshot_executor),
        (DESKTOP_WINDOW_DEF, desktop_window_executor),
        (DESKTOP_CLIPBOARD_DEF, desktop_clipboard_executor),
        (DESKTOP_UIA_ACTION_DEF, desktop_uia_action_executor),
        (DESKTOP_EXPLORE_DEF, desktop_explore_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    from agent.tools.browser_tools import (
        BROWSER_AGENT_DEF, BROWSER_NAVIGATE_DEF, BROWSER_SCREENSHOT_DEF,
        BROWSER_CLICK_DEF, BROWSER_TYPE_DEF, BROWSER_GET_TEXT_DEF,
        BROWSER_FILL_FORM_DEF,
        browser_agent_executor, browser_navigate_executor, browser_screenshot_executor,
        browser_click_executor, browser_type_executor, browser_get_text_executor,
        browser_fill_form_executor,
    )
    for definition, executor in [
        (BROWSER_AGENT_DEF, browser_agent_executor),
        (BROWSER_NAVIGATE_DEF, browser_navigate_executor),
        (BROWSER_SCREENSHOT_DEF, browser_screenshot_executor),
        (BROWSER_CLICK_DEF, browser_click_executor),
        (BROWSER_TYPE_DEF, browser_type_executor),
        (BROWSER_GET_TEXT_DEF, browser_get_text_executor),
        (BROWSER_FILL_FORM_DEF, browser_fill_form_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    # ===== 感知工具（五感：视觉解析/语音识别/操作验证/智能等待/五感融合/环境感） =====
    from agent.tools.perception_tools import (
        SCREEN_PARSE_DEF, ACTION_VERIFY_DEF, SMART_WAIT_DEF, SPEECH_TRANSCRIBE_DEF,
        PERCEPTION_FUSE_DEF, ENVIRONMENT_SENSE_DEF,
        screen_parse_executor, action_verify_executor,
        smart_wait_executor, speech_transcribe_executor,
        perception_fuse_executor, environment_sense_executor,
    )
    for definition, executor in [
        (SCREEN_PARSE_DEF, screen_parse_executor),
        (ACTION_VERIFY_DEF, action_verify_executor),
        (SMART_WAIT_DEF, smart_wait_executor),
        (SPEECH_TRANSCRIBE_DEF, speech_transcribe_executor),
        (PERCEPTION_FUSE_DEF, perception_fuse_executor),
        (ENVIRONMENT_SENSE_DEF, environment_sense_executor),
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
        VOICE_INTERACT_DEF, GET_ACTIVE_FILE_DEF,
        file_dedup_executor, log_view_executor, shell_generate_executor,
        voice_interact_executor, get_active_file_executor,
    )
    for definition, executor in [
        (FILE_DEDUP_DEF, file_dedup_executor),
        (LOG_VIEW_DEF, log_view_executor),
        (SHELL_GENERATE_DEF, shell_generate_executor),
        (VOICE_INTERACT_DEF, voice_interact_executor),
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

    # ===== 会话搜索工具（FTS5 全文搜索过往对话） =====
    if session_store is not None:
        from agent.tools.session_search_tool import register_session_search_tool
        register_session_search_tool(registry, session_store)
        count += 1

    # ===== 用户体验工具（澄清/TODO/写入审批） =====
    from agent.tools.clarify_tool import register_clarify_tool
    from agent.tools.todo_tool import register_todo_tool
    from agent.tools.write_approval_tool import register_write_approval_tool
    register_clarify_tool(registry)
    count += 1
    register_todo_tool(registry)
    count += 1
    register_write_approval_tool(registry)
    count += 1

    # ===== 高级工具（代码执行/子Agent委派） =====
    from agent.tools.code_execution_tool import register_code_execution_tool
    from agent.tools.delegate_tool import register_delegate_tool
    register_code_execution_tool(registry)
    count += 1
    register_delegate_tool(registry)
    count += 1

    # ===== 语音对话模式工具（VoiceMode 状态机） =====
    from agent.tools.voice_mode_tool import register_voice_mode_tool
    register_voice_mode_tool(registry)
    count += 1

    # ===== Sanbao AGI 群论推理工具（0 token，不依赖LLM） =====
    from agent.tools.sanbao_tools import (
        SANBAO_ASK_DEF, SANBAO_PREDICT_DEF, SANBAO_DIAGNOSE_DEF,
        SANBAO_TRAIN_DEF, SANBAO_FEEDBACK_DEF, SANBAO_STATUS_DEF,
        sanbao_ask_executor, sanbao_predict_executor, sanbao_diagnose_executor,
        sanbao_train_executor, sanbao_feedback_executor, sanbao_status_executor,
    )
    for definition, executor in [
        (SANBAO_ASK_DEF, sanbao_ask_executor),
        (SANBAO_PREDICT_DEF, sanbao_predict_executor),
        (SANBAO_DIAGNOSE_DEF, sanbao_diagnose_executor),
        (SANBAO_TRAIN_DEF, sanbao_train_executor),
        (SANBAO_FEEDBACK_DEF, sanbao_feedback_executor),
        (SANBAO_STATUS_DEF, sanbao_status_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    # ===== P0 接入：Kanban 多代理可视化 =====
    from agent.tools.kanban_swarm import register_kanban_tools
    register_kanban_tools(registry)
    count += 3

    # ===== P0 接入：Cronjob 定时任务模板 =====
    from agent.tools.cronjob_tools import register_cronjob_tools
    register_cronjob_tools(registry)
    count += 3

    # ===== P0 接入：Windows UIA 精确桌面自动化 =====
    from agent.tools.windows_uia import register_uia_tools
    register_uia_tools(registry)
    count += 3

    # ===== 自动测试生成闭环工具（分析/生成/执行/迭代/覆盖率） =====
    from agent.tools.test_gen_tools import (
        TEST_GEN_ANALYZE_DEF, TEST_GEN_GENERATE_DEF, TEST_GEN_EXECUTE_DEF,
        TEST_GEN_ITERATE_DEF, TEST_GEN_COVERAGE_DEF,
        test_gen_analyze_executor, test_gen_generate_executor,
        test_gen_execute_executor, test_gen_iterate_executor,
        test_gen_coverage_executor,
    )
    for definition, executor in [
        (TEST_GEN_ANALYZE_DEF, test_gen_analyze_executor),
        (TEST_GEN_GENERATE_DEF, test_gen_generate_executor),
        (TEST_GEN_EXECUTE_DEF, test_gen_execute_executor),
        (TEST_GEN_ITERATE_DEF, test_gen_iterate_executor),
        (TEST_GEN_COVERAGE_DEF, test_gen_coverage_executor),
    ]:
        registry.register(definition, executor)
        count += 1

    return count


# ==================== 工具可靠性追踪器 ====================


@dataclass
class ToolCallStats:
    """工具调用统计。

    Attributes:
        calls: 总调用次数。
        successes: 成功次数。
        total_duration: 总耗时（秒）。
        last_error: 最近一次错误信息。
    """

    calls: int = 0
    successes: int = 0
    total_duration: float = 0.0
    last_error: str | None = None


class ToolReliabilityTracker:
    """工具可靠性追踪器。

    记录工具调用结果，计算成功率和综合评分，
    支持进化权重调整，用于工具推荐排序。
    """

    def __init__(self) -> None:
        self._stats: dict[str, ToolCallStats] = {}
        self._evolution_weights: dict[str, float] = {}

    def record_call(
        self,
        tool_name: str,
        success: bool,
        duration: float,
        error: str | None = None,
    ) -> None:
        """记录工具调用结果。"""
        existing = self._stats.get(tool_name)
        if existing:
            existing.calls += 1
            if success:
                existing.successes += 1
            existing.total_duration += duration
            if error:
                existing.last_error = error
        else:
            self._stats[tool_name] = ToolCallStats(
                calls=1,
                successes=1 if success else 0,
                total_duration=duration,
                last_error=error,
            )

    def get_success_rate(self, tool_name: str) -> float:
        """获取工具成功率。"""
        stats = self._stats.get(tool_name)
        if not stats or stats.calls == 0:
            return 1.0
        return stats.successes / stats.calls

    def get_avg_duration(self, tool_name: str) -> float:
        """获取工具平均耗时。"""
        stats = self._stats.get(tool_name)
        if not stats or stats.calls == 0:
            return 0.0
        return stats.total_duration / stats.calls

    def apply_evolution_weights(self, weights: dict[str, float]) -> None:
        """应用进化引擎产出的技能权重调整。"""
        for tool_name, weight in weights.items():
            self._evolution_weights[tool_name] = weight

    def get_evolution_weight(self, tool_name: str) -> float:
        """获取工具的进化权重。"""
        return self._evolution_weights.get(tool_name, 1.0)

    def get_composite_score(self, tool_name: str) -> float:
        """获取综合评分（成功率 × 进化权重）。"""
        success_rate = self.get_success_rate(tool_name)
        weight = self.get_evolution_weight(tool_name)
        return success_rate * weight

    def get_stats(self, tool_name: str) -> ToolCallStats | None:
        """获取工具调用统计。"""
        return self._stats.get(tool_name)

    def get_all_stats(self) -> dict[str, ToolCallStats]:
        """获取所有工具的调用统计。"""
        return dict(self._stats)


# ==================== 工具推荐引擎 ====================


class ToolRecommendationEngine:
    """工具推荐引擎。

    统一排序模块：场景检测 + 可靠性评分 + 进化权重 + 用户历史
    → 推荐工具列表。
    """

    def __init__(
        self,
        tool_registry: ToolRegistry,
        reliability_tracker: ToolReliabilityTracker | None = None,
        scene_mapper: "SceneToToolsetMapper | None" = None,
    ) -> None:
        self._registry = tool_registry
        self._tracker = reliability_tracker or ToolReliabilityTracker()
        self._scene_mapper = scene_mapper

    def recommend(
        self,
        input_text: str,
        env: str | None = None,
        max_tools: int = 15,
    ) -> list[dict[str, Any]]:
        """根据输入推荐工具列表。

        Args:
            input_text: 用户输入。
            env: 环境状态。
            max_tools: 最大推荐数量。

        Returns:
            排序后的工具推荐列表，每项包含 name, score, reason。
        """
        if self._scene_mapper:
            resolution = self._scene_mapper.resolve(input_text, env)
            scene = resolution["scene"]
            tags = resolution.get("tags", [])
            disclosure_level = resolution.get("disclosure_level", 2)
            exclude_categories = resolution.get("exclude_categories", [])
        else:
            scene = "daily"
            tags = []
            disclosure_level = 2
            exclude_categories = []

        exclude_cats = []
        for cat_name in exclude_categories:
            try:
                exclude_cats.append(ToolCategory(cat_name))
            except ValueError:
                self.log.debug("跳过无效工具类别: %s", cat_name)

        candidates = self._registry.filter_by(
            tags=tags if tags else None,
            scene=scene,
            max_capability_level=disclosure_level,
            exclude_categories=exclude_cats if exclude_cats else None,
        )

        if not candidates:
            candidates = self._registry.get_by_capability_level(disclosure_level)

        scored: list[dict[str, Any]] = []
        for tool_def in candidates:
            composite = self._tracker.get_composite_score(tool_def.name)
            scene_match = 1.0 if tool_def.scenes and scene in {
                s.lower() for s in tool_def.scenes
            } else 0.5
            tag_match = 0.0
            if tags and tool_def.tags:
                overlap = len(set(tags) & {t.lower() for t in tool_def.tags})
                tag_match = min(overlap / max(len(tags), 1), 1.0)

            final_score = composite * 0.4 + scene_match * 0.3 + tag_match * 0.3

            reason_parts = []
            if scene_match > 0.8:
                reason_parts.append(f"场景匹配({scene})")
            if tag_match > 0:
                reason_parts.append(f"标签匹配({tag_match:.0%})")
            if composite > 1.0:
                reason_parts.append("进化加权")
            elif composite < 0.8:
                reason_parts.append("可靠性较低")

            scored.append({
                "name": tool_def.name,
                "score": round(final_score, 3),
                "reason": " + ".join(reason_parts) if reason_parts else "默认推荐",
                "short_desc": tool_def.short_desc or tool_def.description[:50],
                "capability_level": tool_def.capability_level,
            })

        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:max_tools]
