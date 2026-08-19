"""感知驱动规划增强器 — 将感知状态深度融入规划决策。

核心价值：
1. 感知状态 → 规划约束：将当前感知状态转化为规划约束条件
2. 感知状态 → 工具推荐：根据场景感知推荐最合适的工具集
3. 感知状态 → 执行策略：根据情绪/场景调整执行策略（保守/激进/交互式）
4. 感知状态 → 风险评估：根据环境状态评估操作风险

设计原则：
- 非侵入式：感知驱动失败不阻断规划，静默降级
- 可解释：每次感知驱动的规划调整都有明确的感知依据
- 可配置：支持启用/禁用各感知驱动的维度

Usage:
    enhancer = PerceptionDrivenPlanner()
    constraints = enhancer.derive_constraints(perception_state)
    tool_filter = enhancer.recommend_tools(perception_state)
    strategy = enhancer.derive_strategy(perception_state)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("perception_driven_planner")


class ExecutionStrategy(str, Enum):
    CONSERVATIVE = "conservative"
    BALANCED = "balanced"
    AGGRESSIVE = "aggressive"
    INTERACTIVE = "interactive"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class PlanningConstraints:
    max_steps: int = 10
    max_retries: int = 3
    timeout_ms: float = 30000.0
    require_confirmation: bool = False
    avoid_tools: list[str] = field(default_factory=list)
    prefer_tools: list[str] = field(default_factory=list)
    risk_level: RiskLevel = RiskLevel.LOW
    strategy: ExecutionStrategy = ExecutionStrategy.BALANCED
    perception_evidence: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_steps": self.max_steps,
            "max_retries": self.max_retries,
            "timeout_ms": self.timeout_ms,
            "require_confirmation": self.require_confirmation,
            "avoid_tools": self.avoid_tools,
            "prefer_tools": self.prefer_tools,
            "risk_level": self.risk_level.value,
            "strategy": self.strategy.value,
            "perception_evidence": self.perception_evidence,
        }


@dataclass
class ToolRecommendation:
    tool_name: str
    score: float
    reason: str
    perception_source: str


@dataclass
class StrategyAdjustment:
    strategy: ExecutionStrategy
    reason: str
    perception_source: str
    confidence: float = 0.5


_SCENE_TOOL_MAP: dict[str, list[str]] = {
    "desktop": [
        "desktop_automate", "desktop_screenshot", "desktop_window",
        "desktop_clipboard", "screen_parse", "action_verify",
    ],
    "browser": [
        "web_search", "web_scrape", "browser_navigate",
        "browser_click", "browser_type",
    ],
    "file": [
        "file_read", "file_write", "file_search", "file_list",
    ],
    "code": [
        "code_search", "code_read", "code_write", "terminal_execute",
    ],
    "communication": [
        "send_email", "send_message", "calendar_check",
    ],
}

_EMOTION_STRATEGY_MAP: dict[str, ExecutionStrategy] = {
    "frustrated": ExecutionStrategy.CONSERVATIVE,
    "confused": ExecutionStrategy.INTERACTIVE,
    "urgent": ExecutionStrategy.AGGRESSIVE,
    "calm": ExecutionStrategy.BALANCED,
    "neutral": ExecutionStrategy.BALANCED,
    "curious": ExecutionStrategy.BALANCED,
}

_NETWORK_RISK_MAP: dict[str, RiskLevel] = {
    "offline": RiskLevel.CRITICAL,
    "unstable": RiskLevel.HIGH,
    "slow": RiskLevel.MEDIUM,
    "good": RiskLevel.LOW,
    "unknown": RiskLevel.MEDIUM,
}


class PerceptionDrivenPlanner:
    def __init__(self, enabled: bool = True) -> None:
        self._enabled = enabled
        self._adjustment_history: list[StrategyAdjustment] = []
        self._constraint_history: list[PlanningConstraints] = []

    def derive_constraints(self, perception_state: Any) -> PlanningConstraints:
        if not self._enabled or perception_state is None:
            return PlanningConstraints()

        constraints = PlanningConstraints()
        evidence: dict[str, str] = {}

        emotion = getattr(perception_state, "emotion", None)
        if emotion is not None:
            emotion_type = getattr(emotion, "emotion_type", "neutral")
            intensity = getattr(emotion, "intensity", 0.5)

            if emotion_type in ("frustrated", "angry") and intensity > 0.7:
                constraints.max_steps = 5
                constraints.max_retries = 1
                constraints.require_confirmation = True
                constraints.strategy = ExecutionStrategy.CONSERVATIVE
                evidence["emotion"] = f"用户情绪{emotion_type}(强度{intensity:.1f})，采用保守策略"
            elif emotion_type == "urgent" and intensity > 0.6:
                constraints.max_steps = 15
                constraints.strategy = ExecutionStrategy.AGGRESSIVE
                evidence["emotion"] = f"用户情绪紧急(强度{intensity:.1f})，采用激进策略"
            elif emotion_type == "confused" and intensity > 0.5:
                constraints.require_confirmation = True
                constraints.strategy = ExecutionStrategy.INTERACTIVE
                evidence["emotion"] = f"用户困惑(强度{intensity:.1f})，采用交互式策略"

        environment = getattr(perception_state, "environment", None)
        if environment is not None:
            network = getattr(environment, "network_status", "unknown")
            if network in ("offline", "unstable"):
                constraints.avoid_tools.extend([
                    "web_search", "web_scrape", "browser_navigate",
                    "send_email", "send_message",
                ])
                constraints.risk_level = _NETWORK_RISK_MAP.get(network, RiskLevel.MEDIUM)
                evidence["network"] = f"网络状态{network}，避免网络工具"

        visual = getattr(perception_state, "visual", None)
        if visual is not None:
            has_dialog = getattr(visual, "has_dialog", False)
            has_notification = getattr(visual, "has_notification", False)
            if has_dialog:
                constraints.prefer_tools.extend(["desktop_automate", "desktop_screenshot"])
                evidence["visual"] = "检测到对话框，优先桌面操作工具"
            if has_notification:
                constraints.require_confirmation = True
                evidence.setdefault("visual", "")
                evidence["visual"] += "；检测到通知，需确认操作"

        constraints.perception_evidence = evidence
        self._constraint_history.append(constraints)
        if len(self._constraint_history) > 100:
            self._constraint_history = self._constraint_history[-50:]

        return constraints

    def recommend_tools(
        self,
        perception_state: Any,
        available_tools: list[str] | None = None,
    ) -> list[ToolRecommendation]:
        if not self._enabled or perception_state is None:
            return []

        recommendations: list[ToolRecommendation] = []

        scene = getattr(perception_state, "scene", None)
        if scene is not None:
            scene_type = getattr(scene, "scene_type", "general")
            scene_tools = getattr(scene, "recommended_tools", [])
            confidence = getattr(scene, "confidence", 0.0)

            if scene_type in _SCENE_TOOL_MAP:
                for tool in _SCENE_TOOL_MAP[scene_type]:
                    if available_tools and tool not in available_tools:
                        continue
                    recommendations.append(ToolRecommendation(
                        tool_name=tool,
                        score=0.8 * confidence,
                        reason=f"场景{scene_type}推荐",
                        perception_source="scene",
                    ))

            for tool in scene_tools:
                if available_tools and tool not in available_tools:
                    continue
                recommendations.append(ToolRecommendation(
                    tool_name=tool,
                    score=0.9 * confidence,
                    reason="场景感知直接推荐",
                    perception_source="scene",
                ))

        environment = getattr(perception_state, "environment", None)
        if environment is not None:
            active_window = getattr(environment, "active_window", "")
            if active_window:
                window_lower = active_window.lower()
                if any(kw in window_lower for kw in ("chrome", "firefox", "edge", "browser")):
                    for tool in _SCENE_TOOL_MAP.get("browser", []):
                        if available_tools and tool not in available_tools:
                            continue
                        recommendations.append(ToolRecommendation(
                            tool_name=tool,
                            score=0.7,
                            reason=f"活跃窗口{active_window}暗示浏览器场景",
                            perception_source="environment",
                        ))
                elif any(kw in window_lower for kw in ("code", "vscode", "pycharm", "idea")):
                    for tool in _SCENE_TOOL_MAP.get("code", []):
                        if available_tools and tool not in available_tools:
                            continue
                        recommendations.append(ToolRecommendation(
                            tool_name=tool,
                            score=0.7,
                            reason=f"活跃窗口{active_window}暗示代码场景",
                            perception_source="environment",
                        ))

        seen: dict[str, ToolRecommendation] = {}
        for r in recommendations:
            if r.tool_name not in seen or r.score > seen[r.tool_name].score:
                seen[r.tool_name] = r

        return sorted(seen.values(), key=lambda x: x.score, reverse=True)[:10]

    def derive_strategy(self, perception_state: Any) -> StrategyAdjustment:
        if not self._enabled or perception_state is None:
            return StrategyAdjustment(
                strategy=ExecutionStrategy.BALANCED,
                reason="感知未启用或无感知状态",
                perception_source="none",
            )

        emotion = getattr(perception_state, "emotion", None)
        if emotion is not None:
            emotion_type = getattr(emotion, "emotion_type", "neutral")
            intensity = getattr(emotion, "intensity", 0.5)
            confidence = getattr(emotion, "confidence", 0.0)

            strategy = _EMOTION_STRATEGY_MAP.get(emotion_type, ExecutionStrategy.BALANCED)
            if intensity < 0.3:
                strategy = ExecutionStrategy.BALANCED

            adjustment = StrategyAdjustment(
                strategy=strategy,
                reason=f"情绪{emotion_type}(强度{intensity:.1f})",
                perception_source="emotion",
                confidence=confidence,
            )
        else:
            adjustment = StrategyAdjustment(
                strategy=ExecutionStrategy.BALANCED,
                reason="无情绪感知",
                perception_source="none",
            )

        self._adjustment_history.append(adjustment)
        if len(self._adjustment_history) > 100:
            self._adjustment_history = self._adjustment_history[-50:]

        return adjustment

    def assess_risk(self, perception_state: Any, action: str = "", target: str = "") -> RiskLevel:
        if not self._enabled or perception_state is None:
            return RiskLevel.LOW

        risk = RiskLevel.LOW

        environment = getattr(perception_state, "environment", None)
        if environment is not None:
            network = getattr(environment, "network_status", "unknown")
            if network in ("offline", "unstable"):
                risk = max(risk, _NETWORK_RISK_MAP.get(network, RiskLevel.MEDIUM), key=lambda x: list(RiskLevel).index(x))

        visual = getattr(perception_state, "visual", None)
        if visual is not None:
            has_dialog = getattr(visual, "has_dialog", False)
            if has_dialog and action in ("desktop_automate", "desktop_clipboard"):
                risk = RiskLevel.HIGH

        high_risk_actions = {"file_write", "file_delete", "terminal_execute", "desktop_automate"}
        if action in high_risk_actions:
            current_idx = list(RiskLevel).index(risk)
            risk = list(RiskLevel)[min(current_idx + 1, len(RiskLevel) - 1)]

        return risk

    def get_stats(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "constraint_count": len(self._constraint_history),
            "adjustment_count": len(self._adjustment_history),
            "recent_strategies": [
                adj.strategy.value for adj in self._adjustment_history[-5:]
            ],
        }
