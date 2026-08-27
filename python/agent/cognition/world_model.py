"""P2-1: 世界模型 — 环境状态建模 + 预判能力。

设计目标：
1. 环境状态建模：将感知总线的 FusedPerception + 跨会话记忆融合为结构化世界状态
2. 因果推理：基于当前状态和动作，预判执行后的状态变化
3. 模拟推演：对候选动作序列进行蒙特卡洛式模拟，选择最优路径
4. 状态差异检测：比较预期状态与实际状态，发现意外变化

世界模型层次：
  L0: 当前状态快照（感知融合 + 记忆检索）
  L1: 因果模型（动作→状态转移概率表，从历史学习）
  L2: 模拟推演（基于L1进行多步前向模拟）
  L3: 意外检测（预期vs实际，触发重新规划）

Usage:
    model = WorldModel(perception_bus=bus, cross_session_memory=mem)
    state = await model.build_current_state()
    prediction = await model.predict(state, action="click_button_ok")
    best = await model.simulate(state, candidate_actions, horizon=3)
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.types import runtime_range_check

log = StructuredLogger("world_model")


class EntityState(str, Enum):
    ACTIVE = "active"
    IDLE = "idle"
    BLOCKED = "blocked"
    ERROR = "error"
    UNKNOWN = "unknown"


class PredictionConfidence(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    UNKNOWN = "unknown"


@dataclass
class Entity:
    entity_id: str = ""
    entity_type: str = "ui_element"
    name: str = ""
    state: EntityState = EntityState.UNKNOWN
    properties: dict[str, Any] = field(default_factory=dict)
    position: tuple[int, int] | None = None
    visible: bool = True
    enabled: bool = True
    confidence: float = 1.0


@dataclass
class WorldState:
    state_id: str = ""
    timestamp: float = 0.0
    entities: dict[str, Entity] = field(default_factory=dict)
    environment: dict[str, Any] = field(default_factory=dict)
    active_window: str = ""
    active_application: str = ""
    user_intent: str = ""
    task_progress: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def entity_count(self) -> int:
        return len(self.entities)

    @property
    def active_entities(self) -> list[Entity]:
        return [e for e in self.entities.values() if e.state == EntityState.ACTIVE]

    def find_entity(self, name: str) -> Entity | None:
        lower = name.lower()
        for e in self.entities.values():
            if lower in e.name.lower() or lower in e.entity_id.lower():
                return e
        return None

    def diff(self, other: "WorldState") -> StateDiff:
        added = set(other.entities) - set(self.entities)
        removed = set(self.entities) - set(other.entities)
        changed: dict[str, dict[str, Any]] = {}
        common = set(self.entities) & set(other.entities)
        for eid in common:
            before = self.entities[eid]
            after = other.entities[eid]
            changes: dict[str, Any] = {}
            if before.state != after.state:
                changes["state"] = {"before": before.state.value, "after": after.state.value}
            if before.visible != after.visible:
                changes["visible"] = {"before": before.visible, "after": after.visible}
            if before.enabled != after.enabled:
                changes["enabled"] = {"before": before.enabled, "after": after.enabled}
            if before.position != after.position:
                changes["position"] = {"before": before.position, "after": after.position}
            if changes:
                changed[eid] = changes
        env_changes: dict[str, Any] = {}
        for k in set(other.environment) | set(self.environment):
            v_before = self.environment.get(k)
            v_after = other.environment.get(k)
            if v_before != v_after:
                env_changes[k] = {"before": v_before, "after": v_after}
        return StateDiff(
            added_entities=list(added),
            removed_entities=list(removed),
            changed_entities=changed,
            env_changes=env_changes,
        )


@dataclass
class StateDiff:
    added_entities: list[str] = field(default_factory=list)
    removed_entities: list[str] = field(default_factory=list)
    changed_entities: dict[str, dict[str, Any]] = field(default_factory=dict)
    env_changes: dict[str, Any] = field(default_factory=dict)

    @property
    def has_changes(self) -> bool:
        return bool(self.added_entities or self.removed_entities or self.changed_entities or self.env_changes)

    @property
    def change_count(self) -> int:
        return (
            len(self.added_entities)
            + len(self.removed_entities)
            + len(self.changed_entities)
            + len(self.env_changes)
        )


@dataclass
class ActionEffect:
    action: str = ""
    target: str = ""
    expected_state_changes: dict[str, Any] = field(default_factory=dict)
    probability: float = 0.8
    estimated_duration_ms: float = 500.0
    side_effects: list[str] = field(default_factory=list)
    preconditions: list[str] = field(default_factory=list)


@dataclass
class Prediction:
    prediction_id: str = ""
    action: str = ""
    target: str = ""
    state_before: str = ""
    predicted_state_after: WorldState = field(default_factory=WorldState)
    confidence: float = 0.5
    confidence_level: PredictionConfidence = PredictionConfidence.MEDIUM
    reasoning: str = ""
    estimated_duration_ms: float = 500.0
    risks: list[str] = field(default_factory=list)
    timestamp: float = 0.0


@dataclass
class SimulationStep:
    step: int = 0
    action: str = ""
    target: str = ""
    predicted_state: WorldState = field(default_factory=WorldState)
    confidence: float = 0.5
    cumulative_confidence: float = 0.5


@dataclass
class SimulationResult:
    simulation_id: str = ""
    actions: list[SimulationStep] = field(default_factory=list)
    final_state: WorldState = field(default_factory=WorldState)
    total_confidence: float = 0.0
    total_duration_ms: float = 0.0
    is_feasible: bool = True
    failure_reason: str = ""


@dataclass
class CausalRule:
    rule_id: str = ""
    action_pattern: str = ""
    target_pattern: str = ""
    expected_effects: dict[str, Any] = field(default_factory=dict)
    probability: float = 0.8
    learned_from: int = 0
    last_validated: float = 0.0


_ACTION_EFFECTS: dict[str, dict[str, Any]] = {
    "click": {"state_change": "activated", "typical_duration_ms": 300},
    "type": {"state_change": "text_entered", "typical_duration_ms": 100},
    "scroll": {"state_change": "view_changed", "typical_duration_ms": 200},
    "navigate": {"state_change": "page_changed", "typical_duration_ms": 1500},
    "close": {"state_change": "entity_removed", "typical_duration_ms": 200},
    "open": {"state_change": "entity_added", "typical_duration_ms": 800},
    "drag": {"state_change": "position_changed", "typical_duration_ms": 400},
    "wait": {"state_change": "none", "typical_duration_ms": 1000},
    "search": {"state_change": "results_loaded", "typical_duration_ms": 2000},
    "copy": {"state_change": "clipboard_updated", "typical_duration_ms": 100},
    "paste": {"state_change": "text_entered", "typical_duration_ms": 100},
}

_RISK_PATTERNS: dict[str, list[str]] = {
    "close": ["数据可能未保存", "窗口可能包含未提交的表单"],
    "navigate": ["当前页面状态可能丢失", "表单数据可能清空"],
    "delete": ["操作不可逆", "数据无法恢复"],
    "type": ["可能覆盖已有内容"],
}


class WorldModel:
    """世界模型 — 环境状态建模 + 预判能力。

    Args:
        perception_bus: 共享感知总线（可选，用于实时感知融合）。
        cross_session_memory: 跨会话记忆（可选，用于历史因果学习）。
        causal_rules: 预定义因果规则（可选）。
        max_simulation_horizon: 最大模拟步数。
    """

    def __init__(
        self,
        perception_bus: Any | None = None,
        cross_session_memory: Any | None = None,
        causal_rules: list[CausalRule] | None = None,
        max_simulation_horizon: int = 5,
    ) -> None:
        self._perception_bus = perception_bus
        self._cross_session_memory = cross_session_memory
        self._causal_rules: dict[str, CausalRule] = {}
        self._max_horizon = max_simulation_horizon
        self._state_history: list[WorldState] = []
        self._prediction_history: list[Prediction] = []
        self._max_history = 100

        if causal_rules:
            for rule in causal_rules:
                self._causal_rules[rule.rule_id] = rule

        self._learn_default_rules()

    def _learn_default_rules(self) -> None:
        defaults = [
            CausalRule(rule_id="click_activate", action_pattern="click", target_pattern="button",
                       expected_effects={"state": "activated", "visible": True}, probability=0.9),
            CausalRule(rule_id="type_enter", action_pattern="type", target_pattern="input",
                       expected_effects={"state": "filled", "has_text": True}, probability=0.95),
            CausalRule(rule_id="close_remove", action_pattern="close", target_pattern="window",
                       expected_effects={"state": "closed", "visible": False}, probability=0.95),
            CausalRule(rule_id="navigate_change", action_pattern="navigate", target_pattern="*",
                       expected_effects={"page_changed": True}, probability=0.85),
        ]
        for rule in defaults:
            if rule.rule_id not in self._causal_rules:
                rule.learned_from = 0
                self._causal_rules[rule.rule_id] = rule

    async def build_current_state(self, perception_data: dict[str, Any] | None = None) -> WorldState:
        state = WorldState(
            state_id=f"ws_{uuid.uuid4().hex[:12]}",
            timestamp=time.time(),
        )
        if perception_data:
            entities_data = perception_data.get("entities", [])
            for ed in entities_data:
                if isinstance(ed, dict):
                    eid = ed.get("id", ed.get("entity_id", f"e_{uuid.uuid4().hex[:8]}"))
                    entity = Entity(
                        entity_id=eid,
                        entity_type=ed.get("type", "ui_element"),
                        name=ed.get("name", ""),
                        state=EntityState(ed.get("state", "unknown")),
                        properties=ed.get("properties", {}),
                        position=ed.get("position"),
                        visible=ed.get("visible", True),
                        enabled=ed.get("enabled", True),
                        confidence=ed.get("confidence", 1.0),
                    )
                    state.entities[eid] = entity
            state.environment = perception_data.get("environment", {})
            state.active_window = perception_data.get("active_window", "")
            state.active_application = perception_data.get("active_application", "")
            state.user_intent = perception_data.get("user_intent", "")

        if self._perception_bus is not None:
            try:
                fused = self._perception_bus.get_latest_fused()
                if fused and hasattr(fused, "modalities"):
                    for mod, sample in getattr(fused, "samples", {}).items():
                        if mod == "uia" and isinstance(sample, dict):
                            for elem in sample.get("elements", []):
                                eid = elem.get("id", f"uia_{uuid.uuid4().hex[:6]}")
                                state.entities[eid] = Entity(
                                    entity_id=eid, entity_type="uia_element",
                                    name=elem.get("name", ""), confidence=elem.get("confidence", 0.8),
                                )
            except Exception:
                pass

        self._state_history.append(state)
        if len(self._state_history) > self._max_history:
            self._state_history.pop(0)

        log.info("世界状态构建完成", state_id=state.state_id, entities=state.entity_count,
                 window=state.active_window)
        return state

    async def predict(
        self,
        current_state: WorldState,
        action: str,
        target: str = "",
        context: dict[str, Any] | None = None,
    ) -> Prediction:
        import copy
        predicted = WorldState(
            state_id=f"ws_{uuid.uuid4().hex[:12]}",
            timestamp=time.time(),
            entities={eid: copy.deepcopy(e) for eid, e in current_state.entities.items()},
            environment=dict(current_state.environment),
            active_window=current_state.active_window,
            active_application=current_state.active_application,
        )
        matched_rules = self._match_causal_rules(action, target)
        confidence = 0.5
        reasoning_parts: list[str] = []
        if matched_rules:
            best_rule = max(matched_rules, key=lambda r: r.probability)
            confidence = best_rule.probability
            reasoning_parts.append(f"因果规则[{best_rule.rule_id}]匹配，概率={best_rule.probability:.2f}")
            target_entity = current_state.find_entity(target) if target else None
            if target_entity and target_entity.entity_id in predicted.entities:
                for key, value in best_rule.expected_effects.items():
                    if key == "state":
                        try:
                            predicted.entities[target_entity.entity_id].state = EntityState(value)
                        except ValueError:
                            pass
                    elif key == "visible":
                        predicted.entities[target_entity.entity_id].visible = value
                    elif key in ("page_changed",):
                        predicted.environment[key] = value
        else:
            effect_info = _ACTION_EFFECTS.get(action)
            if effect_info:
                confidence = 0.6
                reasoning_parts.append(f"默认效果表匹配：{effect_info['state_change']}")
            else:
                confidence = 0.3
                reasoning_parts.append("无匹配因果规则，使用低置信度默认预判")

        target_entity = current_state.find_entity(target) if target else None
        if target_entity and not target_entity.enabled:
            confidence *= 0.5
            reasoning_parts.append("目标元素已禁用，成功率降低")
        if target_entity and not target_entity.visible:
            confidence *= 0.3
            reasoning_parts.append("目标元素不可见，成功率大幅降低")

        risks = _RISK_PATTERNS.get(action, [])
        effect_info = _ACTION_EFFECTS.get(action, {})
        duration = effect_info.get("typical_duration_ms", 500.0)

        conf_level = PredictionConfidence.HIGH if confidence >= 0.8 else (
            PredictionConfidence.MEDIUM if confidence >= 0.5 else PredictionConfidence.LOW)

        prediction = Prediction(
            prediction_id=f"pred_{uuid.uuid4().hex[:12]}",
            action=action,
            target=target,
            state_before=current_state.state_id,
            predicted_state_after=predicted,
            confidence=confidence,
            confidence_level=conf_level,
            reasoning="；".join(reasoning_parts),
            estimated_duration_ms=duration,
            risks=risks,
            timestamp=time.time(),
        )
        self._prediction_history.append(prediction)
        if len(self._prediction_history) > self._max_history:
            self._prediction_history.pop(0)

        log.info("预判完成", prediction_id=prediction.prediction_id,
                 action=action, target=target, confidence=f"{confidence:.2f}",
                 level=conf_level.value)
        return prediction

    async def simulate(
        self,
        initial_state: WorldState,
        action_sequence: list[dict[str, str]],
        horizon: int | None = None,
        num_branches: int = 1,
    ) -> SimulationResult:
        max_steps = min(horizon or self._max_horizon, self._max_horizon)
        if num_branches <= 1:
            return await self._simulate_linear(initial_state, action_sequence, max_steps)
        best_result: SimulationResult | None = None
        for branch_idx in range(num_branches):
            result = await self._simulate_linear(initial_state, action_sequence, max_steps)
            if best_result is None or (result.is_feasible and result.total_confidence > best_result.total_confidence):
                best_result = result
            if best_result is not None and best_result.is_feasible and best_result.total_confidence >= 0.8:
                break
        return best_result or SimulationResult(
            simulation_id=f"sim_{uuid.uuid4().hex[:12]}",
            is_feasible=False,
            failure_reason="所有分支模拟均不可行",
        )

    async def _simulate_linear(
        self,
        initial_state: WorldState,
        action_sequence: list[dict[str, str]],
        max_steps: int,
    ) -> SimulationResult:
        steps: list[SimulationStep] = []
        current = initial_state
        cumulative_conf = 1.0
        total_duration = 0.0

        for i, action_def in enumerate(action_sequence[:max_steps]):
            action = action_def.get("action", "")
            target = action_def.get("target", "")
            pred = await self.predict(current, action, target)
            cumulative_conf *= pred.confidence
            total_duration += pred.estimated_duration_ms
            step = SimulationStep(
                step=i,
                action=action,
                target=target,
                predicted_state=pred.predicted_state_after,
                confidence=pred.confidence,
                cumulative_confidence=cumulative_conf,
            )
            steps.append(step)
            current = pred.predicted_state_after
            if cumulative_conf < 0.1:
                return SimulationResult(
                    simulation_id=f"sim_{uuid.uuid4().hex[:12]}",
                    actions=steps,
                    final_state=current,
                    total_confidence=cumulative_conf,
                    total_duration_ms=total_duration,
                    is_feasible=False,
                    failure_reason=f"步骤{i}后累积置信度降至{cumulative_conf:.2f}，低于阈值0.1",
                )

        return SimulationResult(
            simulation_id=f"sim_{uuid.uuid4().hex[:12]}",
            actions=steps,
            final_state=current,
            total_confidence=cumulative_conf,
            total_duration_ms=total_duration,
            is_feasible=True,
        )

    @runtime_range_check(threshold=(0.0, 1.0))
    async def detect_surprise(
        self,
        expected: WorldState,
        actual: WorldState,
        threshold: float = 0.3,
    ) -> SurpriseReport:
        diff = expected.diff(actual)
        surprise_score = 0.0
        surprises: list[str] = []
        for eid in diff.removed_entities:
            surprises.append(f"实体{eid}意外消失")
            surprise_score += 0.3
        for eid in diff.added_entities:
            surprises.append(f"意外出现新实体{eid}")
            surprise_score += 0.15
        for eid, changes in diff.changed_entities.items():
            for attr, change in changes.items():
                surprises.append(f"实体{eid}的{attr}意外变化：{change['before']}→{change['after']}")
                surprise_score += 0.2
        for key, change in diff.env_changes.items():
            surprises.append(f"环境{key}意外变化：{change['before']}→{change['after']}")
            surprise_score += 0.1
        surprise_score = min(1.0, surprise_score)
        is_surprising = surprise_score >= threshold

        report = SurpriseReport(
            report_id=f"sr_{uuid.uuid4().hex[:12]}",
            surprise_score=surprise_score,
            is_surprising=is_surprising,
            surprises=surprises,
            diff=diff,
            timestamp=time.time(),
        )
        log.info("意外检测完成", report_id=report.report_id,
                 score=f"{surprise_score:.2f}", surprising=is_surprising,
                 count=len(surprises))
        return report

    def _match_causal_rules(self, action: str, target: str) -> list[CausalRule]:
        matched = []
        for rule in self._causal_rules.values():
            if rule.action_pattern == action or rule.action_pattern == "*":
                if rule.target_pattern == target or rule.target_pattern == "*":
                    matched.append(rule)
                elif target and rule.target_pattern in target.lower():
                    matched.append(rule)
        return matched

    def learn_causal_rule(self, rule: CausalRule) -> None:
        self._causal_rules[rule.rule_id] = rule
        log.info("学习新因果规则", rule_id=rule.rule_id,
                 action=rule.action_pattern, target=rule.target_pattern,
                 probability=f"{rule.probability:.2f}")

    def update_rule_from_outcome(self, rule_id: str, success: bool) -> None:
        rule = self._causal_rules.get(rule_id)
        if not rule:
            return
        rule.learned_from += 1
        alpha = 1.0 / (rule.learned_from + 1)
        if success:
            rule.probability = rule.probability + alpha * (1.0 - rule.probability)
        else:
            rule.probability = rule.probability - alpha * rule.probability
        rule.last_validated = time.time()

    @property
    def causal_rules(self) -> dict[str, CausalRule]:
        return dict(self._causal_rules)

    @property
    def state_history(self) -> list[WorldState]:
        return list(self._state_history)

    def save_state(self) -> dict[str, Any]:
        """将因果规则和状态历史序列化为可持久化字典。"""
        import json
        rules_data = {}
        for rid, rule in self._causal_rules.items():
            rules_data[rid] = {
                "rule_id": rule.rule_id,
                "action_pattern": rule.action_pattern,
                "target_pattern": rule.target_pattern,
                "expected_effects": rule.expected_effects,
                "probability": rule.probability,
                "learned_from": rule.learned_from,
                "last_validated": rule.last_validated,
            }
        return {
            "causal_rules": rules_data,
            "state_count": len(self._state_history),
            "prediction_count": len(self._prediction_history),
        }

    def load_state(self, data: dict[str, Any]) -> None:
        """从持久化字典恢复因果规则。"""
        rules_data = data.get("causal_rules", {})
        for rid, rdata in rules_data.items():
            if rid not in self._causal_rules:
                self._causal_rules[rid] = CausalRule(
                    rule_id=rdata["rule_id"],
                    action_pattern=rdata["action_pattern"],
                    target_pattern=rdata["target_pattern"],
                    expected_effects=rdata.get("expected_effects", {}),
                    probability=rdata.get("probability", 0.8),
                    learned_from=rdata.get("learned_from", 0),
                    last_validated=rdata.get("last_validated", 0.0),
                )
        log.info("世界模型状态恢复", rules_loaded=len(rules_data))

    async def detect_surprise_adaptive(
        self,
        expected: WorldState,
        actual: WorldState,
    ) -> SurpriseReport:
        """自适应意外检测 — 根据历史意外频率动态调整阈值。"""
        base_threshold = 0.3
        if len(self._state_history) >= 10:
            recent_surprises = sum(
                1 for s in self._state_history[-10:]
                if hasattr(s, "metadata") and s.metadata.get("was_surprising", False)
            )
            surprise_rate = recent_surprises / 10.0
            if surprise_rate > 0.5:
                base_threshold = 0.5
            elif surprise_rate < 0.1:
                base_threshold = 0.2
        return await self.detect_surprise(expected, actual, base_threshold)


@dataclass
class SurpriseReport:
    report_id: str = ""
    surprise_score: float = 0.0
    is_surprising: bool = False
    surprises: list[str] = field(default_factory=list)
    diff: StateDiff = field(default_factory=StateDiff)
    timestamp: float = 0.0
