"""任务感知模型路由 — 基于任务特征和感知状态自动选择最优 LLM Provider。

设计目标：
1. 任务特征分析：从用户输入和上下文中提取任务类型、复杂度、模态需求
2. 感知增强路由：结合感知状态（场景/情绪/环境）调整路由决策
3. 成本-质量平衡：在质量和成本之间自动权衡
4. 动态降级：Provider 不可用时自动切换到备选

与 CapabilityAwareRouter 的关系：
- CapabilityAwareRouter 是底层能力评分引擎（静态能力 → 评分）
- TaskAwareModelRouter 是上层路由决策引擎（任务需求 → Provider 选择）
- TaskAwareModelRouter 内部调用 CapabilityAwareRouter 进行能力匹配

路由决策流程：
  1. 任务特征提取 → TaskRequirement
  2. 感知状态注入 → 调整 TaskRequirement 权重
  3. 能力匹配 → CapabilityAwareRouter.score()
  4. 成本-质量权衡 → 最终 Provider 选择
  5. 降级检查 → 备选 Provider 准备

Usage:
    router = TaskAwareModelRouter(capability_router=cap_router)
    provider = router.route("分析代码性能瓶颈", perception_state=state)
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("task_aware_model_router")


class TaskType(str, Enum):
    CODING = "coding"
    REASONING = "reasoning"
    AGENTIC = "agentic"
    VISION = "vision"
    CONVERSATION = "conversation"
    ANALYSIS = "analysis"
    CREATIVE = "creative"
    AUTOMATION = "automation"
    RESEARCH = "research"
    DEBUGGING = "debugging"


class CostPreference(str, Enum):
    QUALITY_FIRST = "quality_first"
    BALANCED = "balanced"
    COST_FIRST = "cost_first"


@dataclass
class TaskProfile:
    task_type: TaskType = TaskType.CONVERSATION
    complexity: str = "moderate"
    needs_reasoning: float = 0.3
    needs_tool_calling: float = 0.3
    needs_code_generation: float = 0.0
    needs_structured_output: float = 0.2
    needs_multi_modal: bool = False
    min_context_window: int = 0
    cost_preference: CostPreference = CostPreference.BALANCED
    preferred_provider: str | None = None
    risk_level: str = "low"


@dataclass
class RouteDecision:
    provider: str
    task_type: TaskType
    task_profile: TaskProfile
    score: float = 0.0
    fallback_providers: list[str] = field(default_factory=list)
    reasoning: str = ""
    perception_influenced: bool = False
    duration_ms: float = 0.0


_TASK_KEYWORDS: dict[TaskType, list[str]] = {
    TaskType.CODING: [
        "代码", "编程", "函数", "类", "方法", "bug", "修复", "重构",
        "code", "function", "class", "method", "debug", "fix", "refactor",
        "实现", "开发", "编写", "编译", "运行", "测试",
    ],
    TaskType.REASONING: [
        "分析", "推理", "逻辑", "因果", "证明", "推导", "思考",
        "analyze", "reason", "logic", "prove", "deduce", "think",
        "为什么", "原因", "解释", "判断", "评估",
    ],
    TaskType.AGENTIC: [
        "帮我", "执行", "操作", "自动化", "工具", "调用",
        "help me", "execute", "operate", "automate", "tool", "call",
        "完成", "处理", "安排", "调度",
    ],
    TaskType.VISION: [
        "图片", "截图", "视觉", "看", "识别", "图像",
        "image", "screenshot", "vision", "see", "recognize",
        "界面", "屏幕", "显示",
    ],
    TaskType.ANALYSIS: [
        "数据", "统计", "报告", "趋势", "指标", "对比",
        "data", "statistics", "report", "trend", "metric", "compare",
        "分析", "汇总", "挖掘",
    ],
    TaskType.CREATIVE: [
        "写", "创作", "故事", "文案", "设计", "创意",
        "write", "create", "story", "copy", "design", "creative",
        "生成", "想象", "构思",
    ],
    TaskType.AUTOMATION: [
        "自动化", "批量", "脚本", "定时", "监控", "部署",
        "automate", "batch", "script", "schedule", "monitor", "deploy",
        "流水线", "CI", "CD",
    ],
    TaskType.RESEARCH: [
        "搜索", "查找", "研究", "论文", "文献", "调研",
        "search", "find", "research", "paper", "literature",
        "了解", "调查", "探索",
    ],
    TaskType.DEBUGGING: [
        "报错", "异常", "崩溃", "调试", "排查", "日志",
        "error", "exception", "crash", "debug", "troubleshoot", "log",
        "问题", "故障", "修复",
    ],
}

_COMPLEXITY_KEYWORDS: dict[str, list[str]] = {
    "simple": ["简单", "快速", "直接", "simple", "quick", "direct", "查", "看", "是什么"],
    "complex": ["复杂", "深入", "详细", "全面", "系统", "complex", "deep", "detailed", "comprehensive"],
}

_SCENE_TASK_MAP: dict[str, TaskType] = {
    "desktop": TaskType.AGENTIC,
    "coding": TaskType.CODING,
    "research": TaskType.RESEARCH,
    "daily": TaskType.CONVERSATION,
    "automation": TaskType.AUTOMATION,
    "file_management": TaskType.AGENTIC,
    "communication": TaskType.CONVERSATION,
    "debugging": TaskType.DEBUGGING,
}

_EMOTION_COST_MAP: dict[str, CostPreference] = {
    "frustrated": CostPreference.QUALITY_FIRST,
    "anxious": CostPreference.QUALITY_FIRST,
    "confident": CostPreference.BALANCED,
    "curious": CostPreference.BALANCED,
    "neutral": CostPreference.BALANCED,
}

_TASK_TYPE_REQUIREMENTS: dict[TaskType, dict[str, float]] = {
    TaskType.CODING: {
        "needs_reasoning": 0.4,
        "needs_tool_calling": 0.6,
        "needs_code_generation": 1.0,
        "needs_structured_output": 0.3,
    },
    TaskType.REASONING: {
        "needs_reasoning": 1.0,
        "needs_tool_calling": 0.2,
        "needs_code_generation": 0.1,
        "needs_structured_output": 0.4,
    },
    TaskType.AGENTIC: {
        "needs_reasoning": 0.6,
        "needs_tool_calling": 1.0,
        "needs_code_generation": 0.3,
        "needs_structured_output": 0.5,
    },
    TaskType.VISION: {
        "needs_reasoning": 0.4,
        "needs_tool_calling": 0.2,
        "needs_code_generation": 0.0,
        "needs_structured_output": 0.2,
    },
    TaskType.CONVERSATION: {
        "needs_reasoning": 0.2,
        "needs_tool_calling": 0.1,
        "needs_code_generation": 0.0,
        "needs_structured_output": 0.1,
    },
    TaskType.ANALYSIS: {
        "needs_reasoning": 0.7,
        "needs_tool_calling": 0.4,
        "needs_code_generation": 0.2,
        "needs_structured_output": 0.6,
    },
    TaskType.CREATIVE: {
        "needs_reasoning": 0.3,
        "needs_tool_calling": 0.1,
        "needs_code_generation": 0.1,
        "needs_structured_output": 0.2,
    },
    TaskType.AUTOMATION: {
        "needs_reasoning": 0.5,
        "needs_tool_calling": 0.9,
        "needs_code_generation": 0.5,
        "needs_structured_output": 0.4,
    },
    TaskType.RESEARCH: {
        "needs_reasoning": 0.6,
        "needs_tool_calling": 0.5,
        "needs_code_generation": 0.1,
        "needs_structured_output": 0.3,
    },
    TaskType.DEBUGGING: {
        "needs_reasoning": 0.8,
        "needs_tool_calling": 0.7,
        "needs_code_generation": 0.4,
        "needs_structured_output": 0.3,
    },
}


class TaskAwareModelRouter:
    def __init__(self, capability_router: Any | None = None) -> None:
        self._capability_router = capability_router
        self._default_cost_preference = CostPreference(
            os.environ.get("TASK_ROUTER_COST_PREFERENCE", "balanced")
        )
        self._fallback_chain: list[str] = []

    def set_fallback_chain(self, providers: list[str]) -> None:
        self._fallback_chain = providers

    def analyze_task(self, input_text: str, perception_state: Any | None = None) -> TaskProfile:
        task_type = self._detect_task_type(input_text)
        complexity = self._detect_complexity(input_text)
        needs_multi_modal = self._detect_multi_modal(input_text)
        risk_level = "low"
        cost_preference = self._default_cost_preference

        if perception_state:
            scene = getattr(perception_state, "scene", None)
            if scene and hasattr(scene, "scene_type"):
                scene_type = scene.scene_type
                if scene_type in _SCENE_TASK_MAP:
                    task_type = _SCENE_TASK_MAP[scene_type]
                if scene_type in ("automation", "debugging"):
                    risk_level = "high"

            emotion = getattr(perception_state, "emotion", None)
            if emotion and hasattr(emotion, "emotion_type"):
                emotion_type = emotion.emotion_type
                if emotion_type in _EMOTION_COST_MAP:
                    cost_preference = _EMOTION_COST_MAP[emotion_type]

        high_risk_keywords = ["删除", "格式化", "重置", "清空", "覆盖", "生产环境", "线上"]
        if any(kw in input_text for kw in high_risk_keywords):
            risk_level = "high"

        requirements = _TASK_TYPE_REQUIREMENTS.get(task_type, {})

        return TaskProfile(
            task_type=task_type,
            complexity=complexity,
            needs_reasoning=requirements.get("needs_reasoning", 0.3),
            needs_tool_calling=requirements.get("needs_tool_calling", 0.3),
            needs_code_generation=requirements.get("needs_code_generation", 0.0),
            needs_structured_output=requirements.get("needs_structured_output", 0.2),
            needs_multi_modal=needs_multi_modal,
            min_context_window=8000 if complexity == "complex" else 0,
            cost_preference=cost_preference,
            risk_level=risk_level,
        )

    def route(
        self,
        input_text: str,
        perception_state: Any | None = None,
        preferred_provider: str | None = None,
    ) -> RouteDecision:
        start = time.time()

        profile = self.analyze_task(input_text, perception_state)
        if preferred_provider:
            profile.preferred_provider = preferred_provider

        provider, score, reasoning, fallbacks = self._select_provider(profile)

        perception_influenced = False
        if perception_state:
            scene = getattr(perception_state, "scene", None)
            emotion = getattr(perception_state, "emotion", None)
            if (scene and hasattr(scene, "scene_type")) or (emotion and hasattr(emotion, "emotion_type")):
                perception_influenced = True

        duration_ms = (time.time() - start) * 1000
        decision = RouteDecision(
            provider=provider,
            task_type=profile.task_type,
            task_profile=profile,
            score=score,
            fallback_providers=fallbacks,
            reasoning=reasoning,
            perception_influenced=perception_influenced,
            duration_ms=duration_ms,
        )

        log.info(
            "Task-aware model routed",
            provider=provider,
            task_type=profile.task_type.value,
            complexity=profile.complexity,
            score=round(score, 3),
            perception_influenced=perception_influenced,
            duration_ms=round(duration_ms, 1),
        )
        return decision

    def _detect_task_type(self, input_text: str) -> TaskType:
        text_lower = input_text.lower()
        scores: dict[TaskType, int] = {}
        for task_type, keywords in _TASK_KEYWORDS.items():
            score = sum(1 for kw in keywords if kw in text_lower)
            if score > 0:
                scores[task_type] = score

        if scores:
            return max(scores, key=lambda t: scores[t])
        return TaskType.CONVERSATION

    def _detect_complexity(self, input_text: str) -> str:
        text_lower = input_text.lower()
        for complexity, keywords in _COMPLEXITY_KEYWORDS.items():
            if any(kw in text_lower for kw in keywords):
                return complexity
        return "moderate"

    def _detect_multi_modal(self, input_text: str) -> bool:
        vision_keywords = ["图片", "截图", "视觉", "图像", "界面", "屏幕", "image", "screenshot", "vision"]
        return any(kw in input_text.lower() for kw in vision_keywords)

    def _select_provider(
        self,
        profile: TaskProfile,
    ) -> tuple[str, float, str, list[str]]:
        if self._capability_router:
            try:
                return self._route_via_capability_router(profile)
            except Exception as e:
                log.warning("Capability router failed, falling back", error=str(e))

        if profile.preferred_provider:
            return profile.preferred_provider, 1.0, "用户指定Provider", []

        if self._fallback_chain:
            primary = self._fallback_chain[0]
            fallbacks = self._fallback_chain[1:]
            return primary, 0.7, f"默认Provider链: {primary}", fallbacks

        reasoning_parts = [f"任务类型={profile.task_type.value}"]
        if profile.needs_reasoning > 0.7:
            reasoning_parts.append("高推理需求→选reasoning强的模型")
        if profile.needs_code_generation > 0.7:
            reasoning_parts.append("高代码需求→选code强的模型")
        if profile.needs_multi_modal:
            reasoning_parts.append("多模态需求→选vision模型")
        if profile.cost_preference == CostPreference.QUALITY_FIRST:
            reasoning_parts.append("质量优先→选最强模型")

        return "default", 0.5, "; ".join(reasoning_parts), []

    def _route_via_capability_router(
        self,
        profile: TaskProfile,
    ) -> tuple[str, float, str, list[str]]:
        from agent.llm.capability_aware_router import TaskRequirement

        req = TaskRequirement(
            needs_reasoning=profile.needs_reasoning,
            needs_tool_calling=profile.needs_tool_calling,
            needs_code_generation=profile.needs_code_generation,
            needs_structured_output=profile.needs_structured_output,
            needs_multi_modal=profile.needs_multi_modal,
            min_context_window=profile.min_context_window,
            preferred_provider=profile.preferred_provider,
        )

        if profile.cost_preference == CostPreference.COST_FIRST:
            req.max_cost_tier = 5.0
        elif profile.cost_preference == CostPreference.QUALITY_FIRST:
            req.max_cost_tier = None

        scored = self._capability_router.route(req)  # type: ignore[union-attr]

        if not scored:
            raise RuntimeError("No providers available")

        best = scored[0]
        fallbacks = [s.provider for s in scored[1:3]]

        reasoning = f"能力匹配: {best.provider} (评分={best.score:.3f})"
        if best.reasons:
            reasoning += f", 原因: {'; '.join(best.reasons[:3])}"

        return best.provider, best.score, reasoning, fallbacks
