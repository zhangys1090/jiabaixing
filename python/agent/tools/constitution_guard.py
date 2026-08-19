"""宪法/人格约束守卫 —— U4 第 2 项「宪法约束作用于动作」（文档 3 §五）。

把人格 / 宪法约束**前置**到动作执行守卫（与 ``ToolCallGuard`` 协同），
避免「感知到危险仍执行」。

核心思想：
- 守卫是**硬约束**闸门，独立于权限 / 风险 / 去重等既有逻辑。
- 内置关键规则：当感知融合中出现**危险信号**（火势 / 泄露 / 报警 …）时，
  拦截一切**破坏性动作**（删除 / 关机 / 断电 …），即"感知到危险仍执行"防护。
- 规则可配置、可叠加；既支持"仅危险时拦截"，也支持"无条件硬阻断某工具"。

设计要点（遵循 AGENTS.md §0.1）：
- 决策核心在 Python（真实执行守卫所在），TS ``ToolCallGuard`` 仅通过注入
  provider 委托本模块，不重复实现判断逻辑。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.perception.sensory_fusion import FusedPerception


class ConstitutionSeverity(str, Enum):
    """宪法约束严重级别。"""

    BLOCK = "block"  # 硬约束：直接拦截动作
    WARN = "warn"  # 软约束：记录但不拦截（除非叠加危险感知）


@dataclass
class ConstitutionRule:
    """单条宪法 / 人格约束规则。

    Attributes:
        rule_id: 规则唯一标识。
        description: 规则人类可读描述。
        severity: 严重级别（block / warn）。
        action_keywords: 动作名（小写）命中关键字；命中即视为受约束动作。
        requires_perception_danger: 仅当感知到危险时才触发；否则无条件下触发。
    """

    rule_id: str
    description: str
    severity: ConstitutionSeverity = ConstitutionSeverity.BLOCK
    action_keywords: tuple[str, ...] = ()
    requires_perception_danger: bool = False


@dataclass
class Violation:
    """一条违规记录。"""

    rule_id: str
    description: str
    severity: ConstitutionSeverity


@dataclass
class GuardVerdict:
    """守卫裁决结果。"""

    allowed: bool
    violations: list[Violation]
    reason: str
    danger_detected: bool

    @property
    def blocked_by(self) -> list[str]:
        """被拦截（block 级）的规则 id 列表。"""
        return [v.rule_id for v in self.violations if v.severity == ConstitutionSeverity.BLOCK]


# 默认危险关键词：用于从融合感知中识别"危险"信号
DEFAULT_DANGER_KEYWORDS: tuple[str, ...] = (
    "危险",
    "火势",
    "火灾",
    "泄露",
    "爆炸",
    "高温",
    "报警",
    "异常",
    "紧急",
    "故障",
    "断电",
)

# 默认破坏性动作关键字（动作名命中即视为破坏性）
DEFAULT_DESTRUCTIVE_KEYWORDS: tuple[str, ...] = (
    "delete",
    "remove",
    "shutdown",
    "format",
    "kill",
    "drop",
    "truncate",
    "rm",
    "断电",
    "删除",
    "关闭",
    "格式化",
    "销毁",
)


def detect_danger(
    fused: FusedPerception | None = None,
    structured: dict[str, Any] | None = None,
    keywords: tuple[str, ...] = DEFAULT_DANGER_KEYWORDS,
) -> bool:
    """扫描融合感知，判断是否存在危险信号。

    遍历 ``structured`` 中每个通道的样本 ``content``，命中任一危险关键词即返回 True。
    """
    if structured is None:
        structured = fused.structured if fused is not None else {}
    if not structured:
        return False
    lowered = tuple(k.lower() for k in keywords)
    for samples in structured.values():
        if not isinstance(samples, list):
            continue
        for sample in samples:
            content = str(sample.get("content", "")) if isinstance(sample, dict) else str(sample)
            text = content.lower()
            if any(kw in text for kw in lowered):
                return True
    return False


def _action_name(action: dict[str, Any]) -> str:
    """统一提取动作名（兼容 tool / name / tool_name 字段）。"""
    for key in ("tool", "name", "tool_name"):
        val = action.get(key)
        if isinstance(val, str) and val:
            return val
    return ""


class ConstitutionGuard:
    """宪法 / 人格约束守卫：在动作执行前评估是否允许。

    Usage:
        guard = ConstitutionGuard.default()
        verdict = guard.evaluate({"tool": "shutdown_device"}, fused=fused)
        if not verdict.allowed:
            ...  # 拦截，reason 说明原因
    """

    def __init__(
        self,
        rules: list[ConstitutionRule] | None = None,
        danger_keywords: tuple[str, ...] = DEFAULT_DANGER_KEYWORDS,
        destructive_keywords: tuple[str, ...] = DEFAULT_DESTRUCTIVE_KEYWORDS,
    ) -> None:
        self._rules = list(rules) if rules is not None else self._default_rules(destructive_keywords)
        self._danger_keywords = danger_keywords
        self._destructive_keywords = destructive_keywords

    @staticmethod
    def _default_rules(
        destructive_keywords: tuple[str, ...],
    ) -> list[ConstitutionRule]:
        """内置默认规则集。"""
        return [
            ConstitutionRule(
                rule_id="danger_blocks_destructive",
                description="感知到危险信号时，禁止一切破坏性动作（避免感知到危险仍执行）",
                severity=ConstitutionSeverity.BLOCK,
                action_keywords=destructive_keywords,
                requires_perception_danger=True,
            ),
        ]

    @classmethod
    def default(cls) -> "ConstitutionGuard":
        """构造带默认规则与关键词的守卫实例。"""
        return cls()

    def add_rule(self, rule: ConstitutionRule) -> None:
        """追加一条自定义宪法规则。"""
        self._rules.append(rule)

    def evaluate(
        self,
        action: dict[str, Any],
        fused: FusedPerception | None = None,
        structured: dict[str, Any] | None = None,
    ) -> GuardVerdict:
        """评估动作是否违反宪法约束。

        Args:
            action: 动作描述，含 ``tool`` / ``name`` / ``tool_name`` 与 ``args``。
            fused: 当前融合感知（``FusedPerception``）。
            structured: 直接传入感知结构（与 fused 二选一）。

        Returns:
            GuardVerdict: 含 allowed / violations / reason / danger_detected。
        """
        danger = detect_danger(fused=fused, structured=structured, keywords=self._danger_keywords)
        name = _action_name(action).lower()

        violations: list[Violation] = []
        for rule in self._rules:
            # 仅危险触发类规则：无危险则跳过
            if rule.requires_perception_danger and not danger:
                continue
            # 动作名是否命中规则关键字
            if rule.action_keywords and not any(kw in name for kw in rule.action_keywords):
                continue
            violations.append(
                Violation(rule_id=rule.rule_id, description=rule.description, severity=rule.severity)
            )

        block_violations = [v for v in violations if v.severity == ConstitutionSeverity.BLOCK]
        allowed = len(block_violations) == 0
        if not allowed:
            reasons = "; ".join(v.description for v in block_violations)
            reason = f"宪法守卫拦截: {reasons}"
        elif violations:
            reason = "宪法守卫通过（存在软约束提醒）"
        else:
            reason = "宪法守卫通过"

        return GuardVerdict(
            allowed=allowed,
            violations=violations,
            reason=reason,
            danger_detected=danger,
        )
