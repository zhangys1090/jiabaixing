"""动态工具过滤器。

根据任务上下文智能过滤和排序工具列表，减少发送给 LLM 的工具数量，
提高工具选择准确率和 Token 使用效率。

核心策略:
- 任务类型分析: 根据 goal 推断工具偏好
- 渐进式过滤: 基础过滤 → 场景匹配 → 语义匹配 → 智能排序
- 上下文感知: 考虑对话历史、已执行工具、任务复杂度
- 降级策略: 过滤结果不足时自动放宽条件

Usage:
    from agent.tools.dynamic_filter import DynamicToolFilter

    filter = DynamicToolFilter(registry)
    tools = filter.filter_for_task(
        goal="创建一个新的 Python 项目",
        task_type="coding",
        max_tools=15,
    )
    definitions = filter.get_definitions(tools)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("dynamic_tool_filter")


class ToolSelectionMode(str, Enum):
    """工具选择模式。"""

    CONSERVATIVE = "conservative"
    BALANCED = "balanced"
    AGGRESSIVE = "aggressive"


@dataclass
class FilteredTool:
    """过滤后的工具条目。

    Attributes:
        definition: 工具定义。
        relevance_score: 相关性分数（0-1）。
        match_reasons: 匹配原因列表。
    """

    definition: Any
    relevance_score: float = 0.0
    match_reasons: list[str] = field(default_factory=list)


@dataclass
class ToolFilterResult:
    """工具过滤结果。

    Attributes:
        tools: 过滤后的工具列表。
        total_before: 过滤前工具总数。
        total_after: 过滤后工具总数。
        task_type: 任务类型。
        selection_mode: 选择模式。
        filter_stages: 各阶段过滤统计。
    """

    tools: list[FilteredTool] = field(default_factory=list)
    total_before: int = 0
    total_after: int = 0
    task_type: str = "general"
    selection_mode: str = "balanced"
    filter_stages: dict[str, int] = field(default_factory=dict)


class DynamicToolFilter:
    """动态工具过滤器。

    根据任务上下文智能过滤和排序工具列表。
    """

    _TASK_TOOL_PRIORITY = {
        "coding": {
            "high": ["code", "file", "system"],
            "medium": ["memory", "network", "cognition"],
            "low": ["desktop", "daily", "iot", "perception"],
        },
        "analysis": {
            "high": ["cognition", "memory", "network"],
            "medium": ["code", "file", "system"],
            "low": ["desktop", "daily", "iot", "perception"],
        },
        "search": {
            "high": ["file", "network", "memory"],
            "medium": ["code", "system", "cognition"],
            "low": ["desktop", "daily", "iot", "perception"],
        },
        "file_management": {
            "high": ["file", "system"],
            "medium": ["code", "network", "memory", "cognition"],
            "low": ["desktop", "daily", "iot", "perception"],
        },
        "desktop": {
            "high": ["desktop", "system"],
            "medium": ["file", "network", "code"],
            "low": ["memory", "cognition", "daily", "iot", "perception"],
        },
        "conversation": {
            "high": ["memory", "cognition"],
            "medium": ["file", "network", "system"],
            "low": ["code", "desktop", "daily", "iot", "perception"],
        },
        "general": {
            "high": ["file", "system", "memory", "cognition"],
            "medium": ["code", "network", "desktop"],
            "low": ["daily", "iot", "perception"],
        },
    }

    _GOAL_KEYWORD_CATEGORIES = {
        "代码": "coding",
        "写": "coding",
        "编程": "coding",
        "debug": "coding",
        "bug": "coding",
        "测试": "coding",
        "重构": "coding",
        "搜索": "search",
        "查找": "search",
        "找到": "search",
        "分析": "analysis",
        "检查": "analysis",
        "审查": "analysis",
        "总结": "analysis",
        "文件": "file_management",
        "文件夹": "file_management",
        "目录": "file_management",
        "桌面": "desktop",
        "窗口": "desktop",
        "屏幕": "desktop",
        "聊天": "conversation",
        "对话": "conversation",
        "讨论": "conversation",
    }

    def __init__(
        self,
        registry: Any = None,
        default_mode: ToolSelectionMode = ToolSelectionMode.BALANCED,
        default_max_tools: int = 20,
    ) -> None:
        self._registry = registry
        self._default_mode = default_mode
        self._default_max_tools = default_max_tools

    def filter_for_task(
        self,
        goal: str,
        task_type: str = "general",
        mode: ToolSelectionMode | None = None,
        max_tools: int | None = None,
        exclude_risky: bool = True,
        already_used_tools: list[str] | None = None,
        conversation_length: int = 0,
    ) -> ToolFilterResult:
        """根据任务上下文智能过滤工具。

        Args:
            goal: 任务目标。
            task_type: 任务类型。
            mode: 选择模式。
            max_tools: 最大工具数。
            exclude_risky: 是否排除高风险工具。
            already_used_tools: 已使用的工具名称列表。
            conversation_length: 当前对话长度。

        Returns:
            ToolFilterResult: 过滤结果。
        """
        if mode is None:
            mode = self._default_mode
        if max_tools is None:
            max_tools = self._default_max_tools

        stage_counts: dict[str, int] = {
            "initial": 0,
            "risk_filter": 0,
            "category_filter": 0,
            "goal_keyword_filter": 0,
            "used_tools_filter": 0,
            "capability_filter": 0,
            "final": 0,
        }

        all_defs = self._get_all_definitions()
        stage_counts["initial"] = len(all_defs)

        if not all_defs:
            return ToolFilterResult(
                tools=[],
                total_before=0,
                total_after=0,
                task_type=task_type,
                selection_mode=mode.value,
                filter_stages=stage_counts,
            )

        filtered = [FilteredTool(definition=d, relevance_score=0.0) for d in all_defs]

        if exclude_risky:
            filtered = self._filter_risk(filtered)
            stage_counts["risk_filter"] = len(filtered)

        inferred_task = self._infer_task_type(goal, task_type)
        filtered = self._filter_by_category(filtered, inferred_task, mode)
        stage_counts["category_filter"] = len(filtered)

        filtered = self._score_by_goal_keywords(filtered, goal)
        stage_counts["goal_keyword_filter"] = len(filtered)

        if already_used_tools:
            used_set = set(already_used_tools)
            filtered = self._filter_used_tools(filtered, used_set)
            stage_counts["used_tools_filter"] = len(filtered)

        filtered = self._adjust_by_conversation(filtered, conversation_length, mode)

        filtered.sort(key=lambda t: t.relevance_score, reverse=True)

        final = filtered[:max_tools]
        stage_counts["final"] = len(final)

        return ToolFilterResult(
            tools=final,
            total_before=stage_counts["initial"],
            total_after=stage_counts["final"],
            task_type=inferred_task,
            selection_mode=mode.value,
            filter_stages=stage_counts,
        )

    def get_definitions(self, tools: list[FilteredTool]) -> list[Any]:
        return [t.definition for t in tools]

    def _get_all_definitions(self) -> list[Any]:
        if self._registry is None:
            return []
        if hasattr(self._registry, "get_all_definitions"):
            return self._registry.get_all_definitions()
        return []

    def _infer_task_type(self, goal: str, fallback: str) -> str:
        goal_lower = goal.lower()
        scores: dict[str, int] = {}

        for keyword, cat in self._GOAL_KEYWORD_CATEGORIES.items():
            if keyword.lower() in goal_lower:
                scores[cat] = scores.get(cat, 0) + 1

        if not scores:
            return fallback

        max_count = max(scores.values())
        top_cats = [cat for cat, count in scores.items() if count == max_count]

        if len(top_cats) == 1:
            return top_cats[0]

        detection_order = list(dict.fromkeys(
            cat for kw, cat in self._GOAL_KEYWORD_CATEGORIES.items()
            if kw.lower() in goal_lower
        ))

        for cat in detection_order:
            if cat in top_cats:
                return cat

        return fallback

    def _filter_risk(self, tools: list[FilteredTool]) -> list[FilteredTool]:
        result = []
        for t in tools:
            risk = getattr(t.definition, "risk_level", "low")
            if risk == "critical":
                t.relevance_score -= 0.5
            elif risk == "high":
                t.relevance_score -= 0.2
            result.append(t)

        return [t for t in result if t.relevance_score > -0.3]

    def _filter_by_category(
        self,
        tools: list[FilteredTool],
        task_type: str,
        mode: ToolSelectionMode,
    ) -> list[FilteredTool]:
        priority_map = self._TASK_TOOL_PRIORITY.get(
            task_type, self._TASK_TOOL_PRIORITY["general"]
        )

        high_cats = set(priority_map.get("high", []))
        medium_cats = set(priority_map.get("medium", []))
        low_cats = set(priority_map.get("low", []))

        for t in tools:
            cat = getattr(t.definition, "category", None)
            cat_str = cat.value if hasattr(cat, "value") else str(cat) if cat else ""

            if cat_str in high_cats:
                t.relevance_score += 0.4
                t.match_reasons.append(f"high_priority_category:{cat_str}")
            elif cat_str in medium_cats:
                t.relevance_score += 0.2
                t.match_reasons.append(f"medium_priority_category:{cat_str}")
            elif cat_str in low_cats:
                if mode == ToolSelectionMode.AGGRESSIVE:
                    t.relevance_score += 0.05
                elif mode == ToolSelectionMode.CONSERVATIVE:
                    t.relevance_score -= 0.3
                else:
                    t.relevance_score -= 0.1

        if mode == ToolSelectionMode.CONSERVATIVE:
            return [t for t in tools if t.relevance_score > -0.2]
        return tools

    def _score_by_goal_keywords(
        self,
        tools: list[FilteredTool],
        goal: str,
    ) -> list[FilteredTool]:
        goal_lower = goal.lower()

        keyword_patterns = {
            "file": [r"文件", r"file", r"目录", r"路径", r"读写", r"保存"],
            "code": [r"代码", r"code", r"函数", r"类", r"测试", r"bug", r"debug"],
            "search": [r"搜索", r"查找", r"找到", r"search", r"find"],
            "memory": [r"记忆", r"记住", r"回忆", r"历史", r"memory", r"偏好"],
            "network": [r"网络", r"下载", r"http", r"api", r"请求"],
            "desktop": [r"桌面", r"窗口", r"屏幕", r"截图", r"desktop"],
            "cognition": [r"分析", r"推理", r"思考", r"总结", r"理解"],
        }

        for t in tools:
            tags = getattr(t.definition, "tags", []) or []
            scenes = getattr(t.definition, "scenes", []) or []
            desc = getattr(t.definition, "description", "") or ""
            name = getattr(t.definition, "name", "") or ""

            for cat, patterns in keyword_patterns.items():
                for pattern in patterns:
                    if re.search(pattern, goal_lower, re.IGNORECASE):
                        if cat in [s.lower() for s in scenes] or cat in [t.lower() for t in tags]:
                            t.relevance_score += 0.15
                            t.match_reasons.append(f"keyword_match:{cat}")
                            break
                        if re.search(pattern, desc, re.IGNORECASE) or re.search(pattern, name, re.IGNORECASE):
                            t.relevance_score += 0.08
                            break

        return tools

    def _filter_used_tools(
        self,
        tools: list[FilteredTool],
        used_set: set[str],
    ) -> list[FilteredTool]:
        for t in tools:
            name = getattr(t.definition, "name", "")
            if name in used_set:
                t.relevance_score -= 0.3
                t.match_reasons.append("already_used")
        return tools

    def _adjust_by_conversation(
        self,
        tools: list[FilteredTool],
        conversation_length: int,
        mode: ToolSelectionMode,
    ) -> list[FilteredTool]:
        if conversation_length <= 0:
            return tools

        if conversation_length > 20:
            for t in tools:
                cat = getattr(t.definition, "category", None)
                cat_str = cat.value if hasattr(cat, "value") else str(cat) if cat else ""
                if cat_str in ("memory", "cognition"):
                    t.relevance_score += 0.1
                    t.match_reasons.append("long_conversation_boost")

        if mode == ToolSelectionMode.CONSERVATIVE and conversation_length > 10:
            for t in tools:
                cat = getattr(t.definition, "category", None)
                cat_str = cat.value if hasattr(cat, "value") else str(cat) if cat else ""
                if cat_str in ("iot", "perception", "daily"):
                    t.relevance_score -= 0.2

        return tools
