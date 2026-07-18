"""运行时安全姿态（Runtime Posture）。

把"是否打扰用户"从每个工具的散点判断，收敛为一条可切换的全局运行时策略。
对标 Hermes 的 --safe-mode / --yolo / --accept-hooks 分级自治开关。

四种姿态：
    SAFE    只读放行、任何写/执行类（risk >= medium）一律拦截，不打扰用户。
    CONFIRM 逐项审批（现状默认）。本模块对该姿态不介入，交回 ApprovalManager
            既有的 auto_approve_* 流程处理，保证 100% 向后兼容。
    AUTO    自动放行非敏感（low/medium），high/critical 仍走审批。对标 accept-hooks。
    YOLO    全放行，仅 critical 保留硬底线审批。

安全硬底线：无论何种姿态，critical 风险都不会被静默 ALLOW —— SAFE 直接 DENY，
其余姿态一律 REVIEW（走正常审批流），与 ApprovalManager._NEVER_AUTO_APPROVE_RISKS 一致。
"""

from __future__ import annotations

import os
from enum import Enum


class RuntimePosture(str, Enum):
    """运行时安全姿态。"""

    SAFE = "safe"
    CONFIRM = "confirm"
    AUTO = "auto"
    YOLO = "yolo"

    @classmethod
    def parse(cls, value: str | None, default: "RuntimePosture" = None) -> "RuntimePosture":
        """宽松解析字符串为姿态，无法识别时回退到 default（默认 CONFIRM）。"""
        fallback = default if default is not None else cls.CONFIRM
        if not value:
            return fallback
        normalized = str(value).strip().lower()
        for member in cls:
            if member.value == normalized:
                return member
        return _RUNTIME_POSTURE_ALIASES.get(normalized, fallback)

    @classmethod
    def is_valid(cls, value: str | None) -> bool:
        """严格校验：仅当 value 是已知姿态或别名时才返回 True（用于管理面入参校验）。"""
        if not value:
            return False
        normalized = str(value).strip().lower()
        known = {member.value for member in cls} | set(_RUNTIME_POSTURE_ALIASES.keys())
        return normalized in known

    @classmethod
    def from_env(cls, env_var: str = "AGENT_RUNTIME_POSTURE") -> "RuntimePosture":
        """从环境变量读取姿态，未设置或非法时回退 CONFIRM。"""
        return cls.parse(os.environ.get(env_var))


#: 常见别名（管理面入参 / CLI 兼容）。
#: 必须放在模块级而非 Enum 类内 —— Enum 元类会把类属性当作成员收集，
#: 会导致 `cls._ALIASES` 解析成枚举实例（而非 dict），且 `list(RuntimePosture)`
#: 会把别名 dict 也当成一个"姿态"。放在类定义之后即可正常引用成员。
_RUNTIME_POSTURE_ALIASES: dict[str, RuntimePosture] = {
    "safe-mode": RuntimePosture.SAFE,
    "readonly": RuntimePosture.SAFE,
    "read-only": RuntimePosture.SAFE,
    "accept-hooks": RuntimePosture.AUTO,
    "auto-approve": RuntimePosture.AUTO,
    "danger": RuntimePosture.YOLO,
    "full-auto": RuntimePosture.YOLO,
}


class PostureDecision(str, Enum):
    """姿态对某次工具调用的裁决。"""

    ALLOW = "allow"    # 立即放行，不打扰用户
    DENY = "deny"      # 立即拒绝，返回明确原因
    REVIEW = "review"  # 交回正常审批流（提示/等待/超时）


#: 归一化后的风险等级顺序（未知等级按 high 保守处理）。
_KNOWN_RISKS = frozenset({"low", "medium", "high", "critical"})

#: 姿态 × 风险 → 裁决 决策矩阵。critical 永不被静默 ALLOW。
_MATRIX: dict[RuntimePosture, dict[str, PostureDecision]] = {
    RuntimePosture.SAFE: {
        "low": PostureDecision.ALLOW,
        "medium": PostureDecision.DENY,
        "high": PostureDecision.DENY,
        "critical": PostureDecision.DENY,
    },
    RuntimePosture.CONFIRM: {
        "low": PostureDecision.REVIEW,
        "medium": PostureDecision.REVIEW,
        "high": PostureDecision.REVIEW,
        "critical": PostureDecision.REVIEW,
    },
    RuntimePosture.AUTO: {
        "low": PostureDecision.ALLOW,
        "medium": PostureDecision.ALLOW,
        "high": PostureDecision.REVIEW,
        "critical": PostureDecision.REVIEW,
    },
    RuntimePosture.YOLO: {
        "low": PostureDecision.ALLOW,
        "medium": PostureDecision.ALLOW,
        "high": PostureDecision.ALLOW,
        "critical": PostureDecision.REVIEW,
    },
}


def _normalize_risk(risk_level: str | None) -> str:
    """归一化风险等级，未知或空值按 high 保守处理。"""
    if not risk_level:
        return "high"
    normalized = str(risk_level).strip().lower()
    return normalized if normalized in _KNOWN_RISKS else "high"


def decide(posture: RuntimePosture, risk_level: str | None) -> PostureDecision:
    """给定姿态与风险等级，返回裁决。纯函数，便于独立测试。

    Args:
        posture: 当前运行时姿态。
        risk_level: 工具调用风险等级（low/medium/high/critical）。

    Returns:
        PostureDecision.ALLOW / DENY / REVIEW。
    """
    risk = _normalize_risk(risk_level)
    return _MATRIX.get(posture, _MATRIX[RuntimePosture.CONFIRM])[risk]
