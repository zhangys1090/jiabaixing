"""宪法规则学习 + 冲突解决（Constitution Rule Learning & Conflict Resolution）。

在现有 ConstitutionGuard（静态规则评估）基础上，增强为：
1. 规则学习：从用户反馈和执行结果中自动学习新规则
2. 规则泛化：将具体案例泛化为通用规则
3. 冲突检测：检测规则间的逻辑冲突
4. 冲突解决：基于优先级和特异性解决规则冲突
5. 规则版本管理：规则变更历史追踪和回滚

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 ConstitutionGuard 集成，复用其规则评估逻辑
- 非侵入式：包装 ConstitutionGuard，不修改其内部逻辑
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.tools.constitution_guard import (
    ConstitutionGuard,
    ConstitutionRule,
    ConstitutionSeverity,
    GuardVerdict,
    Violation,
)
from agent.core.logger import StructuredLogger

log = StructuredLogger("constitution_learning")


class LearningSource(str, Enum):
    USER_FEEDBACK = "user_feedback"
    EXECUTION_RESULT = "execution_result"
    INCIDENT_ANALYSIS = "incident_analysis"
    MANUAL = "manual"
    AUTO_GENERALIZATION = "auto_generalization"


class ConflictType(str, Enum):
    CONTRADICTORY = "contradictory"
    OVERLAPPING = "overlapping"
    SUBSUMING = "subsuming"
    DUPLICATE = "duplicate"


@dataclass
class RuleConflict:
    conflict_id: str = ""
    rule_a_id: str = ""
    rule_b_id: str = ""
    conflict_type: ConflictType = ConflictType.OVERLAPPING
    description: str = ""
    resolution: str = ""
    resolved: bool = False
    timestamp: float = field(default_factory=time.time)


@dataclass
class RuleVersion:
    version_id: str = ""
    rule_id: str = ""
    rule: ConstitutionRule | None = None
    change_type: str = ""
    change_reason: str = ""
    timestamp: float = field(default_factory=time.time)
    source: LearningSource = LearningSource.MANUAL


@dataclass
class LearningExample:
    example_id: str = ""
    action: dict[str, Any] = field(default_factory=dict)
    perception_context: dict[str, Any] = field(default_factory=dict)
    should_block: bool = False
    reason: str = ""
    source: LearningSource = LearningSource.USER_FEEDBACK
    timestamp: float = field(default_factory=time.time)
    generalized: bool = False


class ConstitutionRuleLearner:
    """宪法规则学习器：从反馈和执行结果中学习新规则。"""

    def __init__(
        self,
        base_guard: ConstitutionGuard | None = None,
        data_dir: str | Path | None = None,
    ) -> None:
        self._guard = base_guard or ConstitutionGuard.default()
        if data_dir:
            self._data_dir = Path(data_dir)
        else:
            self._data_dir = Path(
                __file__
            ).resolve().parent.parent.parent / "data" / "constitution_learning"
        self._data_dir.mkdir(parents=True, exist_ok=True)

        self._examples: list[LearningExample] = []
        self._learned_rules: list[ConstitutionRule] = []
        self._conflicts: list[RuleConflict] = []
        self._versions: list[RuleVersion] = []
        self._max_examples = 500
        self._max_versions = 200
        self._min_examples_for_generalization = 3

        self._examples_path = self._data_dir / "learning_examples.jsonl"
        self._versions_path = self._data_dir / "rule_versions.jsonl"
        self._load()

    def learn_from_feedback(
        self,
        action: dict[str, Any],
        should_block: bool,
        reason: str = "",
        perception_context: dict[str, Any] | None = None,
    ) -> LearningExample:
        example = LearningExample(
            example_id=f"ex_{int(time.time())}_{len(self._examples)}",
            action=action,
            perception_context=perception_context or {},
            should_block=should_block,
            reason=reason,
            source=LearningSource.USER_FEEDBACK,
        )
        self._add_example(example)

        if self._should_try_generalize():
            self._try_generalize()

        return example

    def learn_from_execution(
        self,
        action: dict[str, Any],
        result: dict[str, Any],
        perception_context: dict[str, Any] | None = None,
    ) -> LearningExample | None:
        had_error = result.get("error") is not None or result.get("success") is False
        is_dangerous = result.get("dangerous", False) or result.get("irreversible", False)

        if not had_error and not is_dangerous:
            return None

        should_block = is_dangerous and had_error
        reason = ""
        if is_dangerous:
            reason = "执行结果标记为危险/不可逆"
        if had_error:
            reason += f"; 错误: {result.get('error', 'unknown')}"

        example = LearningExample(
            example_id=f"ex_{int(time.time())}_{len(self._examples)}",
            action=action,
            perception_context=perception_context or {},
            should_block=should_block,
            reason=reason,
            source=LearningSource.EXECUTION_RESULT,
        )
        self._add_example(example)
        return example

    def add_learned_rule(
        self,
        rule: ConstitutionRule,
        source: LearningSource = LearningSource.AUTO_GENERALIZATION,
        reason: str = "",
    ) -> None:
        conflict = self._check_rule_conflict(rule)
        if conflict:
            resolved = self._resolve_conflict(conflict)
            if not resolved:
                log.warning(
                    "Rule conflict unresolved, skipping",
                    rule_id=rule.rule_id,
                    conflict=conflict.conflict_id,
                )
                return

        self._guard.add_rule(rule)
        self._learned_rules.append(rule)

        version = RuleVersion(
            version_id=f"v_{int(time.time())}_{len(self._versions)}",
            rule_id=rule.rule_id,
            rule=rule,
            change_type="add",
            change_reason=reason or f"从 {source.value} 学习",
            source=source,
        )
        self._versions.append(version)
        if len(self._versions) > self._max_versions:
            self._versions = self._versions[-self._max_versions:]

        self._append_version(version)
        log.info("Learned rule added", rule_id=rule.rule_id, source=source.value)

    def evaluate(
        self,
        action: dict[str, Any],
        fused: Any = None,
        structured: dict[str, Any] | None = None,
    ) -> GuardVerdict:
        return self._guard.evaluate(action, fused=fused, structured=structured)

    def detect_conflicts(self) -> list[RuleConflict]:
        all_rules = list(self._guard._rules)
        conflicts: list[RuleConflict] = []

        for i, rule_a in enumerate(all_rules):
            for rule_b in all_rules[i + 1:]:
                conflict = self._analyze_pair(rule_a, rule_b)
                if conflict:
                    conflicts.append(conflict)

        self._conflicts = conflicts
        return conflicts

    def resolve_conflict(self, conflict_id: str, resolution: str = "") -> bool:
        for c in self._conflicts:
            if c.conflict_id == conflict_id:
                c.resolved = True
                c.resolution = resolution or f"保留高优先级规则 {c.rule_a_id}"
                return True
        return False

    def get_rule_history(self, rule_id: str) -> list[RuleVersion]:
        return [v for v in self._versions if v.rule_id == rule_id]

    def get_all_learned_rules(self) -> list[ConstitutionRule]:
        return list(self._learned_rules)

    def get_unresolved_conflicts(self) -> list[RuleConflict]:
        return [c for c in self._conflicts if not c.resolved]

    def get_stats(self) -> dict[str, Any]:
        return {
            "total_examples": len(self._examples),
            "learned_rules_count": len(self._learned_rules),
            "conflicts_count": len(self._conflicts),
            "unresolved_conflicts": len(self.get_unresolved_conflicts()),
            "versions_count": len(self._versions),
        }

    def _add_example(self, example: LearningExample) -> None:
        self._examples.append(example)
        if len(self._examples) > self._max_examples:
            self._examples = self._examples[-self._max_examples:]
        self._append_example(example)

    def _should_try_generalize(self) -> bool:
        ungeneralized = [e for e in self._examples if not e.generalized]
        return len(ungeneralized) >= self._min_examples_for_generalization

    def _try_generalize(self) -> None:
        ungeneralized = [e for e in self._examples if not e.generalized]

        block_examples = [e for e in ungeneralized if e.should_block]
        if len(block_examples) < self._min_examples_for_generalization:
            return

        action_keywords: dict[str, int] = {}
        for ex in block_examples:
            action_name = ""
            for key in ("tool", "name", "tool_name"):
                val = ex.action.get(key)
                if isinstance(val, str) and val:
                    action_name = val.lower()
                    break
            if action_name:
                action_keywords[action_name] = action_keywords.get(action_name, 0) + 1

        for keyword, count in action_keywords.items():
            if count >= self._min_examples_for_generalization:
                rule_id = f"learned_{keyword}_{int(time.time())}"
                existing_ids = {r.rule_id for r in self._learned_rules}
                if rule_id in existing_ids:
                    continue

                rule = ConstitutionRule(
                    rule_id=rule_id,
                    description=f"从 {count} 个用户反馈中学习：拦截动作 '{keyword}'",
                    severity=ConstitutionSeverity.WARN,
                    action_keywords=(keyword,),
                    requires_perception_danger=False,
                )
                self.add_learned_rule(
                    rule,
                    source=LearningSource.AUTO_GENERALIZATION,
                    reason=f"从 {count} 个反馈案例泛化",
                )

                for ex in block_examples:
                    action_name = ""
                    for key in ("tool", "name", "tool_name"):
                        val = ex.action.get(key)
                        if isinstance(val, str) and val:
                            action_name = val.lower()
                            break
                    if action_name == keyword:
                        ex.generalized = True

    def _check_rule_conflict(self, new_rule: ConstitutionRule) -> RuleConflict | None:
        for existing in self._guard._rules:
            if existing.rule_id == new_rule.rule_id:
                return RuleConflict(
                    conflict_id=f"conflict_{int(time.time())}",
                    rule_a_id=existing.rule_id,
                    rule_b_id=new_rule.rule_id,
                    conflict_type=ConflictType.DUPLICATE,
                    description=f"规则ID重复: {new_rule.rule_id}",
                )

            overlap_a = set(new_rule.action_keywords) & set(existing.action_keywords)
            if overlap_a and new_rule.severity != existing.severity:
                return RuleConflict(
                    conflict_id=f"conflict_{int(time.time())}",
                    rule_a_id=existing.rule_id,
                    rule_b_id=new_rule.rule_id,
                    conflict_type=ConflictType.CONTRADICTORY,
                    description=f"动作关键字重叠 {overlap_a} 但严重级别不同",
                )

        return None

    def _resolve_conflict(self, conflict: RuleConflict) -> bool:
        if conflict.conflict_type == ConflictType.DUPLICATE:
            conflict.resolved = True
            conflict.resolution = "跳过重复规则"
            return True

        if conflict.conflict_type == ConflictType.CONTRADICTORY:
            rule_a = next((r for r in self._guard._rules if r.rule_id == conflict.rule_a_id), None)
            rule_b = next((r for r in self._learned_rules if r.rule_id == conflict.rule_b_id), None)
            if rule_a and rule_b:
                if rule_a.severity == ConstitutionSeverity.BLOCK:
                    conflict.resolved = True
                    conflict.resolution = f"保留已有 BLOCK 规则 {rule_a.rule_id}"
                    return True
                if rule_b.severity == ConstitutionSeverity.BLOCK:
                    conflict.resolved = True
                    conflict.resolution = f"升级为新 BLOCK 规则 {rule_b.rule_id}"
                    return True

        return False

    def _analyze_pair(self, rule_a: ConstitutionRule, rule_b: ConstitutionRule) -> RuleConflict | None:
        if rule_a.rule_id == rule_b.rule_id:
            return None

        overlap = set(rule_a.action_keywords) & set(rule_b.action_keywords)
        if not overlap:
            return None

        if overlap == set(rule_a.action_keywords) == set(rule_b.action_keywords):
            if rule_a.severity == rule_b.severity:
                conflict_type = ConflictType.DUPLICATE
                desc = f"规则 {rule_a.rule_id} 和 {rule_b.rule_id} 完全重复"
            else:
                conflict_type = ConflictType.CONTRADICTORY
                desc = f"规则 {rule_a.rule_id}({rule_a.severity.value}) 和 {rule_b.rule_id}({rule_b.severity.value}) 严重级别矛盾"
        elif overlap == set(rule_a.action_keywords) or overlap == set(rule_b.action_keywords):
            conflict_type = ConflictType.SUBSUMING
            desc = f"规则 {rule_a.rule_id} 和 {rule_b.rule_id} 存在包含关系"
        else:
            conflict_type = ConflictType.OVERLAPPING
            desc = f"规则 {rule_a.rule_id} 和 {rule_b.rule_id} 关键字部分重叠: {overlap}"

        return RuleConflict(
            conflict_id=f"conflict_{rule_a.rule_id}_{rule_b.rule_id}",
            rule_a_id=rule_a.rule_id,
            rule_b_id=rule_b.rule_id,
            conflict_type=conflict_type,
            description=desc,
        )

    def _append_example(self, example: LearningExample) -> None:
        try:
            data = {
                "example_id": example.example_id,
                "action": example.action,
                "should_block": example.should_block,
                "reason": example.reason,
                "source": example.source.value,
                "timestamp": example.timestamp,
                "generalized": example.generalized,
            }
            line = json.dumps(data, ensure_ascii=False) + "\n"
            with open(self._examples_path, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception as e:
            log.debug("Failed to append example", error=str(e))

    def _append_version(self, version: RuleVersion) -> None:
        try:
            data = {
                "version_id": version.version_id,
                "rule_id": version.rule_id,
                "change_type": version.change_type,
                "change_reason": version.change_reason,
                "source": version.source.value,
                "timestamp": version.timestamp,
            }
            if version.rule:
                data["rule"] = {
                    "rule_id": version.rule.rule_id,
                    "description": version.rule.description,
                    "severity": version.rule.severity.value,
                    "action_keywords": list(version.rule.action_keywords),
                    "requires_perception_danger": version.rule.requires_perception_danger,
                }
            line = json.dumps(data, ensure_ascii=False) + "\n"
            with open(self._versions_path, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception as e:
            log.debug("Failed to append version", error=str(e))

    def _load(self) -> None:
        if self._examples_path.exists():
            try:
                lines = self._examples_path.read_text(encoding="utf-8").strip().split("\n")
                for line in lines:
                    if not line.strip():
                        continue
                    raw = json.loads(line)
                    self._examples.append(LearningExample(
                        example_id=raw.get("example_id", ""),
                        action=raw.get("action", {}),
                        should_block=raw.get("should_block", False),
                        reason=raw.get("reason", ""),
                        source=LearningSource(raw.get("source", "user_feedback")),
                        timestamp=raw.get("timestamp", 0.0),
                        generalized=raw.get("generalized", False),
                    ))
            except Exception as e:
                log.debug("Failed to load examples", error=str(e))

        if self._versions_path.exists():
            try:
                lines = self._versions_path.read_text(encoding="utf-8").strip().split("\n")
                for line in lines:
                    if not line.strip():
                        continue
                    raw = json.loads(line)
                    rule_data = raw.get("rule")
                    rule = None
                    if rule_data:
                        rule = ConstitutionRule(
                            rule_id=rule_data.get("rule_id", ""),
                            description=rule_data.get("description", ""),
                            severity=ConstitutionSeverity(rule_data.get("severity", "warn")),
                            action_keywords=tuple(rule_data.get("action_keywords", ())),
                            requires_perception_danger=rule_data.get("requires_perception_danger", False),
                        )
                    self._versions.append(RuleVersion(
                        version_id=raw.get("version_id", ""),
                        rule_id=raw.get("rule_id", ""),
                        rule=rule,
                        change_type=raw.get("change_type", ""),
                        change_reason=raw.get("change_reason", ""),
                        source=LearningSource(raw.get("source", "manual")),
                        timestamp=raw.get("timestamp", 0.0),
                    ))
            except Exception as e:
                log.debug("Failed to load versions", error=str(e))
