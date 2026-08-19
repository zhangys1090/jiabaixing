"""自适应执行策略引擎 — 统一调度感知驱动策略、降级策略和意图追踪。

核心价值：
1. 统一策略决策：将感知驱动、降级、意图追踪等多维度信号统一为执行策略
2. 策略冲突解决：当多个维度给出矛盾策略时，自动选择最安全的策略
3. 策略平滑过渡：避免策略突变导致的执行不稳定
4. 策略可解释性：每次策略调整都有完整的决策依据

设计原则：
- 安全优先：冲突时选择最保守的策略
- 平滑过渡：策略变更需要渐进式过渡
- 非侵入式：策略引擎失败不阻断执行

Usage:
    engine = AdaptiveStrategyEngine()
    strategy = engine.resolve(perception_state, degradation_state, drift_result)
    print(strategy.action, strategy.reason)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("adaptive_strategy_engine")


class StrategyAction(str, Enum):
    PROCEED = "proceed"
    PROCEED_CAUTIOUS = "proceed_cautious"
    CONFIRM_BEFORE_PROCEED = "confirm_before_proceed"
    REPLAN = "replan"
    PAUSE_AND_ASK = "pause_and_ask"
    DEGRADE_AND_CONTINUE = "degrade_and_continue"
    ABORT = "abort"


class StrategySource(str, Enum):
    PERCEPTION = "perception"
    DEGRADATION = "degradation"
    INTENT = "intent"
    BUDGET = "budget"
    SAFETY = "safety"
    DEFAULT = "default"


@dataclass
class StrategySignal:
    action: StrategyAction
    source: StrategySource
    confidence: float = 0.5
    reason: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ResolvedStrategy:
    action: StrategyAction = StrategyAction.PROCEED
    confidence: float = 0.5
    reasons: list[str] = field(default_factory=list)
    sources: list[StrategySource] = field(default_factory=list)
    prev_action: StrategyAction | None = None
    transition_smooth: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action.value,
            "confidence": self.confidence,
            "reasons": self.reasons,
            "sources": [s.value for s in self.sources],
            "prev_action": self.prev_action.value if self.prev_action else None,
            "transition_smooth": self.transition_smooth,
        }


_ACTION_PRIORITY: dict[StrategyAction, int] = {
    StrategyAction.ABORT: 0,
    StrategyAction.PAUSE_AND_ASK: 1,
    StrategyAction.CONFIRM_BEFORE_PROCEED: 2,
    StrategyAction.REPLAN: 3,
    StrategyAction.DEGRADE_AND_CONTINUE: 4,
    StrategyAction.PROCEED_CAUTIOUS: 5,
    StrategyAction.PROCEED: 6,
}

_SMOOTH_TRANSITIONS: set[tuple[StrategyAction, StrategyAction]] = {
    (StrategyAction.PROCEED, StrategyAction.PROCEED_CAUTIOUS),
    (StrategyAction.PROCEED_CAUTIOUS, StrategyAction.CONFIRM_BEFORE_PROCEED),
    (StrategyAction.CONFIRM_BEFORE_PROCEED, StrategyAction.PAUSE_AND_ASK),
    (StrategyAction.PROCEED, StrategyAction.DEGRADE_AND_CONTINUE),
    (StrategyAction.DEGRADE_AND_CONTINUE, StrategyAction.PROCEED_CAUTIOUS),
    (StrategyAction.PROCEED_CAUTIOUS, StrategyAction.REPLAN),
    (StrategyAction.REPLAN, StrategyAction.PROCEED_CAUTIOUS),
}


class AdaptiveStrategyEngine:
    def __init__(self, smoothing_window: int = 3) -> None:
        self._smoothing_window = smoothing_window
        self._strategy_history: list[ResolvedStrategy] = []
        self._current_strategy: ResolvedStrategy = ResolvedStrategy()

    def resolve(
        self,
        perception_state: Any = None,
        degradation_decision: Any = None,
        drift_result: Any = None,
        budget_state: Any = None,
        safety_signals: list[StrategySignal] | None = None,
    ) -> ResolvedStrategy:
        signals: list[StrategySignal] = []

        if perception_state is not None:
            sig = self._signal_from_perception(perception_state)
            if sig is not None:
                signals.append(sig)

        if degradation_decision is not None:
            sig = self._signal_from_degradation(degradation_decision)
            if sig is not None:
                signals.append(sig)

        if drift_result is not None:
            sig = self._signal_from_drift(drift_result)
            if sig is not None:
                signals.append(sig)

        if budget_state is not None:
            sig = self._signal_from_budget(budget_state)
            if sig is not None:
                signals.append(sig)

        if safety_signals:
            signals.extend(safety_signals)

        if not signals:
            return self._apply_smoothing(ResolvedStrategy(
                action=StrategyAction.PROCEED,
                confidence=0.5,
                reasons=["无特殊信号，默认继续"],
                sources=[StrategySource.DEFAULT],
            ))

        signals.sort(key=lambda s: _ACTION_PRIORITY.get(s.action, 6))
        selected = signals[0]

        all_reasons = [f"[{s.source.value}] {s.reason}" for s in signals if s.reason]
        all_sources = list({s.source for s in signals})
        avg_confidence = sum(s.confidence for s in signals) / len(signals)

        resolved = ResolvedStrategy(
            action=selected.action,
            confidence=avg_confidence,
            reasons=all_reasons,
            sources=all_sources,
            prev_action=self._current_strategy.action,
        )

        resolved.transition_smooth = self._check_smooth_transition(
            self._current_strategy.action, resolved.action
        )

        if not resolved.transition_smooth:
            resolved.action = self._find_intermediate(
                self._current_strategy.action, resolved.action,
            )
            resolved.reasons.append(
                f"策略平滑过渡：{self._current_strategy.action.value} → {resolved.action.value}"
            )

        return self._apply_smoothing(resolved)

    def get_current_strategy(self) -> ResolvedStrategy:
        return self._current_strategy

    def get_stats(self) -> dict[str, Any]:
        return {
            "current_action": self._current_strategy.action.value,
            "current_confidence": self._current_strategy.confidence,
            "history_size": len(self._strategy_history),
            "recent_actions": [
                s.action.value for s in self._strategy_history[-5:]
            ],
        }

    def _signal_from_perception(self, state: Any) -> StrategySignal | None:
        try:
            emotion = getattr(state, "emotion", None)
            if emotion is not None:
                emotion_type = getattr(emotion, "emotion_type", "neutral")
                intensity = getattr(emotion, "intensity", 0.5)

                if emotion_type in ("frustrated", "angry") and intensity > 0.7:
                    return StrategySignal(
                        action=StrategyAction.PROCEED_CAUTIOUS,
                        source=StrategySource.PERCEPTION,
                        confidence=0.8,
                        reason=f"用户情绪{emotion_type}，建议谨慎执行",
                    )
                if emotion_type == "urgent" and intensity > 0.6:
                    return StrategySignal(
                        action=StrategyAction.PROCEED,
                        source=StrategySource.PERCEPTION,
                        confidence=0.7,
                        reason="用户紧急，建议快速执行",
                    )
                if emotion_type == "confused" and intensity > 0.5:
                    return StrategySignal(
                        action=StrategyAction.CONFIRM_BEFORE_PROCEED,
                        source=StrategySource.PERCEPTION,
                        confidence=0.7,
                        reason="用户困惑，建议确认后执行",
                    )

            environment = getattr(state, "environment", None)
            if environment is not None:
                network = getattr(environment, "network_status", "unknown")
                if network in ("offline", "unstable"):
                    return StrategySignal(
                        action=StrategyAction.DEGRADE_AND_CONTINUE,
                        source=StrategySource.PERCEPTION,
                        confidence=0.8,
                        reason=f"网络{network}，建议降级执行",
                    )
        except Exception as _exc:
            log.warning("Failed to derive perception signal", error=str(_exc))

        return None

    def _signal_from_degradation(self, decision: Any) -> StrategySignal | None:
        try:
            level = getattr(decision, "level", None)
            if level is not None:
                level_value = level.value if hasattr(level, "value") else str(level)
                if level_value in ("severe", "critical"):
                    return StrategySignal(
                        action=StrategyAction.DEGRADE_AND_CONTINUE,
                        source=StrategySource.DEGRADATION,
                        confidence=0.8,
                        reason=f"工具降级级别{level_value}",
                    )
                if level_value == "moderate":
                    return StrategySignal(
                        action=StrategyAction.PROCEED_CAUTIOUS,
                        source=StrategySource.DEGRADATION,
                        confidence=0.6,
                        reason=f"工具降级级别{level_value}",
                    )

            should_degrade = getattr(decision, "should_degrade", False)
            if should_degrade:
                return StrategySignal(
                    action=StrategyAction.DEGRADE_AND_CONTINUE,
                    source=StrategySource.DEGRADATION,
                    confidence=0.7,
                    reason="工具需要降级",
                )
        except Exception as _exc:
            log.warning("Failed to derive degradation signal", error=str(_exc))

        return None

    def _signal_from_drift(self, drift: Any) -> StrategySignal | None:
        try:
            is_drifted = getattr(drift, "is_drifted", False)
            if not is_drifted:
                return None

            severity = getattr(drift, "severity", None)
            severity_value = severity.value if hasattr(severity, "value") else str(severity)

            if severity_value == "major":
                return StrategySignal(
                    action=StrategyAction.PAUSE_AND_ASK,
                    source=StrategySource.INTENT,
                    confidence=0.8,
                    reason=f"意图大幅偏移: {getattr(drift, 'recommendation', '')}",
                )
            if severity_value == "moderate":
                return StrategySignal(
                    action=StrategyAction.CONFIRM_BEFORE_PROCEED,
                    source=StrategySource.INTENT,
                    confidence=0.7,
                    reason=f"意图中等偏移: {getattr(drift, 'recommendation', '')}",
                )
            if severity_value == "minor":
                return StrategySignal(
                    action=StrategyAction.PROCEED_CAUTIOUS,
                    source=StrategySource.INTENT,
                    confidence=0.5,
                    reason="意图轻微偏移",
                )
        except Exception as _exc:
            log.warning("Failed to derive drift signal", error=str(_exc))

        return None

    def _signal_from_budget(self, budget: Any) -> StrategySignal | None:
        try:
            rounds_used = getattr(budget, "rounds_used", 0)
            max_rounds = getattr(budget, "max_rounds", 10)
            if max_rounds > 0 and rounds_used >= max_rounds * 0.9:
                return StrategySignal(
                    action=StrategyAction.PROCEED_CAUTIOUS,
                    source=StrategySource.BUDGET,
                    confidence=0.6,
                    reason=f"预算接近上限 ({rounds_used}/{max_rounds})",
                )
        except Exception as _exc:
            log.warning("Failed to derive budget signal", error=str(_exc))

        return None

    def _check_smooth_transition(self, prev: StrategyAction, next_: StrategyAction) -> bool:
        if prev == next_:
            return True
        return (prev, next_) in _SMOOTH_TRANSITIONS

    def _find_intermediate(self, prev: StrategyAction, target: StrategyAction) -> StrategyAction:
        prev_priority = _ACTION_PRIORITY.get(prev, 6)
        target_priority = _ACTION_PRIORITY.get(target, 6)

        if prev_priority > target_priority:
            step = prev_priority - 1
        else:
            step = prev_priority + 1

        for action, priority in _ACTION_PRIORITY.items():
            if priority == step:
                return action

        return prev

    def _apply_smoothing(self, strategy: ResolvedStrategy) -> ResolvedStrategy:
        self._strategy_history.append(strategy)
        if len(self._strategy_history) > 100:
            self._strategy_history = self._strategy_history[-50:]

        recent = self._strategy_history[-self._smoothing_window:]
        if len(recent) >= 2:
            action_counts: dict[StrategyAction, int] = {}
            for s in recent:
                action_counts[s.action] = action_counts.get(s.action, 0) + 1
            most_common = max(action_counts, key=action_counts.get)
            if most_common != strategy.action and action_counts[most_common] >= 2:
                strategy.transition_smooth = True
                strategy.reasons.append(
                    f"策略平滑：最近{self._smoothing_window}轮中{most_common.value}出现{action_counts[most_common]}次"
                )

        self._current_strategy = strategy
        return strategy
