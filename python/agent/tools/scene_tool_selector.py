"""场景感知工具选择器 — 基于感知状态自动选择最佳工具。

设计目标：
1. 感知驱动：接收 PerceptionState，分析场景类型和情绪状态
2. 场景-工具映射：预定义场景到工具的推荐规则
3. 动态权重：结合感知置信度、工具能力等级、风险等级综合评分
4. 上下文感知：考虑历史工具使用效果，避免重复失败

选择策略：
- 桌面场景 → desktop_uia_action / desktop_automate / desktop_screenshot
- 编码场景 → code_generate / code_analyze / shell_exec
- 研究场景 → web_search / web_fetch / file_grep
- 日常场景 → task_manage / calendar / note_take
- 自动化场景 → desktop_uia_action / browser_agent / shell_exec
- 情绪焦虑 → ask_clarification（先确认需求）
- 情绪自信 → 直接执行高能力等级工具

Usage:
    selector = SceneToolSelector(tool_registry)
    recommended = selector.select("帮我打开记事本并输入文字", perception_state)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import ToolCategory, ToolRegistry

log = StructuredLogger("scene_tool_selector")


@dataclass
class ToolRecommendation:
    tool_name: str
    score: float
    reason: str
    category: str = ""
    risk_level: str = "low"
    capability_level: int = 1


@dataclass
class SceneToolMapping:
    scene_type: str
    primary_tools: list[str]
    secondary_tools: list[str]
    avoid_tools: list[str] = field(default_factory=list)
    emotion_adjustments: dict[str, float] = field(default_factory=dict)


SCENE_TOOL_MAPPINGS: list[SceneToolMapping] = [
    SceneToolMapping(
        scene_type="desktop",
        primary_tools=["desktop_uia_action", "desktop_automate", "desktop_screenshot", "desktop_explore"],
        secondary_tools=["desktop_window", "desktop_clipboard", "uia_find", "uia_click", "uia_get_text"],
        avoid_tools=["code_generate", "code_analyze"],
        emotion_adjustments={"frustrated": 0.2, "anxious": 0.3},
    ),
    SceneToolMapping(
        scene_type="coding",
        primary_tools=["code_generate", "code_analyze", "code_fix", "shell_exec", "file_edit"],
        secondary_tools=["code_review", "code_generate_ast", "code_edit_ast", "refactor_rename", "test_run"],
        avoid_tools=["desktop_automate", "desktop_uia_action"],
        emotion_adjustments={"confident": 0.1, "frustrated": -0.1},
    ),
    SceneToolMapping(
        scene_type="research",
        primary_tools=["web_search", "web_fetch", "file_grep", "file_search"],
        secondary_tools=["file_read", "memory_search", "knowledge_query", "ocr_extract"],
        avoid_tools=["desktop_automate", "shell_exec"],
        emotion_adjustments={"curious": 0.2},
    ),
    SceneToolMapping(
        scene_type="daily",
        primary_tools=["task_manage", "calendar", "note_take", "reminder_set"],
        secondary_tools=["system_status", "task_priority", "batch_task", "morning_brief"],
        avoid_tools=["shell_exec", "code_generate"],
        emotion_adjustments={},
    ),
    SceneToolMapping(
        scene_type="automation",
        primary_tools=["desktop_uia_action", "browser_agent", "shell_exec", "desktop_automate"],
        secondary_tools=["desktop_explore", "desktop_screenshot", "action_verify", "smart_wait"],
        avoid_tools=["ask_clarification"],
        emotion_adjustments={"confident": 0.2},
    ),
    SceneToolMapping(
        scene_type="file_management",
        primary_tools=["file_read", "file_list", "file_edit", "file_search"],
        secondary_tools=["file_grep", "incremental_edit", "multi_file_edit", "pdf_parse", "xlsx_parse"],
        avoid_tools=["desktop_automate"],
        emotion_adjustments={},
    ),
    SceneToolMapping(
        scene_type="communication",
        primary_tools=["ask_clarification", "message_push", "skill_share"],
        secondary_tools=["note_take", "task_manage"],
        avoid_tools=["shell_exec", "code_fix"],
        emotion_adjustments={"frustrated": 0.3, "anxious": 0.4},
    ),
    SceneToolMapping(
        scene_type="debugging",
        primary_tools=["code_analyze", "code_fix", "shell_exec", "log_view"],
        secondary_tools=["file_grep", "test_run", "coverage_read", "code_review"],
        avoid_tools=["desktop_automate", "note_take"],
        emotion_adjustments={"frustrated": -0.2},
    ),
]

EMOTION_TOOL_PRIORITIES: dict[str, dict[str, float]] = {
    "frustrated": {"ask_clarification": 0.5, "self_reflect": 0.3, "preview_execution": 0.2},
    "anxious": {"ask_clarification": 0.4, "preview_execution": 0.3, "smart_wait": 0.2},
    "curious": {"web_search": 0.3, "knowledge_query": 0.2, "file_search": 0.1},
    "confident": {"shell_exec": 0.2, "code_generate": 0.2, "desktop_uia_action": 0.1},
    "neutral": {},
}


class SceneToolSelector:
    def __init__(self, tool_registry: ToolRegistry | None = None) -> None:
        self._tool_registry = tool_registry
        self._scene_map: dict[str, SceneToolMapping] = {
            m.scene_type: m for m in SCENE_TOOL_MAPPINGS
        }
        self._tool_definitions: dict[str, Any] = {}
        if tool_registry:
            self._build_tool_index()

    def _build_tool_index(self) -> None:
        if not self._tool_registry:
            return
        for tool_def in self._tool_registry.get_all_definitions():
            self._tool_definitions[tool_def.name] = tool_def

    def set_tool_registry(self, registry: ToolRegistry) -> None:
        self._tool_registry = registry
        self._build_tool_index()

    def select(
        self,
        task_description: str,
        perception_state: Any | None = None,
        limit: int = 5,
    ) -> list[ToolRecommendation]:
        scene_type = self._detect_scene(perception_state)
        emotion_type = self._detect_emotion(perception_state)
        scene_confidence = self._get_scene_confidence(perception_state)

        candidates = self._score_candidates(
            task_description, scene_type, emotion_type, scene_confidence,
        )

        candidates.sort(key=lambda r: r.score, reverse=True)
        return candidates[:limit]

    def select_for_step(
        self,
        step_description: str,
        step_tool_hint: str | None = None,
        perception_state: Any | None = None,
    ) -> ToolRecommendation | None:
        recommendations = self.select(step_description, perception_state, limit=3)

        if step_tool_hint:
            for rec in recommendations:
                if rec.tool_name == step_tool_hint:
                    return rec

        if recommendations:
            return recommendations[0]
        return None

    def _detect_scene(self, perception_state: Any | None = None) -> str:
        if perception_state is None:
            return "daily"

        scene = getattr(perception_state, "scene", None)
        if scene and hasattr(scene, "scene_type") and scene.scene_type:
            mapping = {
                "desktop_interaction": "desktop",
                "coding": "coding",
                "research": "research",
                "daily_life": "daily",
                "automation": "automation",
                "file_management": "file_management",
                "communication": "communication",
                "debugging": "debugging",
                "multi_step": "automation",
                "web_browsing": "research",
            }
            return mapping.get(scene.scene_type, scene.scene_type)

        env = getattr(perception_state, "environment", None)
        if env:
            active_app = getattr(env, "active_application", "").lower()
            if any(ide in active_app for ide in ["code", "pycharm", "idea", "vim", "terminal"]):
                return "coding"
            if any(browser in active_app for browser in ["chrome", "firefox", "edge", "browser"]):
                return "research"
            if any(office in active_app for office in ["word", "excel", "powerpoint", "outlook"]):
                return "daily"

        return "daily"

    def _detect_emotion(self, perception_state: Any | None = None) -> str:
        if perception_state is None:
            return "neutral"

        emotion = getattr(perception_state, "emotion", None)
        if emotion and hasattr(emotion, "emotion_type"):
            return emotion.emotion_type

        return "neutral"

    def _get_scene_confidence(self, perception_state: Any | None = None) -> float:
        if perception_state is None:
            return 0.0

        scene = getattr(perception_state, "scene", None)
        if scene and hasattr(scene, "confidence"):
            return scene.confidence

        return 0.5

    def _score_candidates(
        self,
        task_description: str,
        scene_type: str,
        emotion_type: str,
        scene_confidence: float,
    ) -> list[ToolRecommendation]:
        candidates: list[ToolRecommendation] = []
        scored_tools: dict[str, float] = {}

        mapping = self._scene_map.get(scene_type)
        if mapping:
            for tool_name in mapping.primary_tools:
                scored_tools[tool_name] = scored_tools.get(tool_name, 0) + 1.0 * scene_confidence
            for tool_name in mapping.secondary_tools:
                scored_tools[tool_name] = scored_tools.get(tool_name, 0) + 0.5 * scene_confidence
            for tool_name in mapping.avoid_tools:
                scored_tools[tool_name] = scored_tools.get(tool_name, 0) - 0.5

        emotion_priorities = EMOTION_TOOL_PRIORITIES.get(emotion_type, {})
        for tool_name, boost in emotion_priorities.items():
            scored_tools[tool_name] = scored_tools.get(tool_name, 0) + boost

        if mapping and emotion_type in mapping.emotion_adjustments:
            adjustment = mapping.emotion_adjustments[emotion_type]
            for tool_name in mapping.primary_tools:
                scored_tools[tool_name] = scored_tools.get(tool_name, 0) + adjustment

        task_lower = task_description.lower()
        keyword_boosts: dict[str, list[str]] = {
            "click|点击|按下": ["desktop_uia_action", "desktop_automate", "uia_click"],
            "type|输入|填写|写入": ["desktop_uia_action", "desktop_automate", "uia_set_text"],
            "read|读取|查看|获取": ["file_read", "uia_get_text", "desktop_clipboard"],
            "search|搜索|查找|find": ["web_search", "file_search", "file_grep"],
            "write|写入|编辑|修改": ["file_edit", "incremental_edit", "code_edit_ast"],
            "run|运行|执行|execute": ["shell_exec", "code_generate", "test_run"],
            "screenshot|截图|截屏": ["desktop_screenshot", "desktop_automate"],
            "browser|浏览器|网页": ["browser_agent", "browser_navigate", "web_fetch"],
            "analyze|分析|审查|review": ["code_analyze", "code_review", "code_fix"],
            "automate|自动化|批量": ["desktop_uia_action", "desktop_automate", "shell_exec"],
        }
        for pattern, tools in keyword_boosts.items():
            if any(kw in task_lower for kw in pattern.split("|")):
                for tool_name in tools:
                    scored_tools[tool_name] = scored_tools.get(tool_name, 0) + 0.3

        for tool_name, score in scored_tools.items():
            if score <= 0:
                continue

            tool_def = self._tool_definitions.get(tool_name)
            category = tool_def.category.value if tool_def else "unknown"
            risk_level = tool_def.risk_level if tool_def else "low"
            capability_level = tool_def.capability_level if tool_def else 1

            risk_penalty = {"low": 0, "medium": -0.1, "high": -0.2, "critical": -0.3}.get(risk_level, 0)
            final_score = score + risk_penalty

            reason_parts = []
            if mapping and tool_name in mapping.primary_tools:
                reason_parts.append(f"场景匹配({scene_type})")
            if tool_name in emotion_priorities:
                reason_parts.append(f"情绪适配({emotion_type})")
            if any(tool_name in tools for tools in keyword_boosts.values()):
                reason_parts.append("关键词匹配")

            candidates.append(ToolRecommendation(
                tool_name=tool_name,
                score=max(0, final_score),
                reason="; ".join(reason_parts) if reason_parts else "综合评分",
                category=category,
                risk_level=risk_level,
                capability_level=capability_level,
            ))

        return candidates
