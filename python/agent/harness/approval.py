"""审批策略管理器 — 学习 Codex Harness 的 Approval Policy 设计.

Codex Harness 三级审批:
  - suggest:     只建议，不执行任何修改操作
  - auto-edit:   自动执行低风险操作(读文件/搜索)，修改操作需确认
  - full-auto:   全自动执行，沙箱内运行，高风险操作仍需确认

jiabaixing 适配:
  - 与现有 PermissionGuard 集成，而非替代
  - 审批策略可按会话/用户/工具粒度配置
  - 审批决策可回溯（TraceLog记录）
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("approval_manager")


class ApprovalPolicy(str, Enum):
    SUGGEST = "suggest"
    AUTO_EDIT = "auto-edit"
    FULL_AUTO = "full-auto"


class RiskTier(str, Enum):
    READ_ONLY = "read-only"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class ApprovalDecision:
    tool_name: str
    policy: ApprovalPolicy
    risk_tier: RiskTier
    approved: bool
    needs_confirmation: bool
    reason: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class ToolRiskProfile:
    tool_name: str
    risk_tier: RiskTier = RiskTier.MEDIUM
    modifies_state: bool = False
    accesses_network: bool = False
    executes_code: bool = False
    side_effects: list[str] = field(default_factory=list)


_DEFAULT_RISK_PROFILES: list[dict[str, Any]] = [
    {"tool_name": "memory_search", "risk_tier": "read-only", "modifies_state": False},
    {"tool_name": "memory_store", "risk_tier": "low", "modifies_state": True},
    {"tool_name": "file_read", "risk_tier": "read-only", "modifies_state": False},
    {"tool_name": "file_search", "risk_tier": "read-only", "modifies_state": False},
    {"tool_name": "file_write", "risk_tier": "high", "modifies_state": True},
    {"tool_name": "shell_exec", "risk_tier": "critical", "modifies_state": True, "executes_code": True},
    {"tool_name": "web_search", "risk_tier": "low", "accesses_network": True},
    {"tool_name": "web_fetch", "risk_tier": "medium", "accesses_network": True},
    {"tool_name": "code_execute", "risk_tier": "critical", "modifies_state": True, "executes_code": True},
    {"tool_name": "desktop_automate", "risk_tier": "critical", "modifies_state": True},
    {"tool_name": "schedule_create", "risk_tier": "medium", "modifies_state": True},
    {"tool_name": "reminder_set", "risk_tier": "low", "modifies_state": True},
]


class ApprovalManager:
    """审批策略管理器 — Codex-style Approval Policy.

    三级策略:
      suggest:     所有操作仅建议，不实际执行
      auto-edit:   只读操作自动执行，修改操作需确认
      full-auto:   低/中风险自动执行，高风险需确认，critical始终需确认
    """

    def __init__(self, default_policy: ApprovalPolicy = ApprovalPolicy.AUTO_EDIT):
        self.default_policy = default_policy
        self._risk_profiles: dict[str, ToolRiskProfile] = {}
        self._session_policies: dict[str, ApprovalPolicy] = {}
        self._decision_log: list[ApprovalDecision] = []
        self._load_default_profiles()

    def _load_default_profiles(self) -> None:
        for entry in _DEFAULT_RISK_PROFILES:
            profile = ToolRiskProfile(
                tool_name=entry["tool_name"],
                risk_tier=RiskTier(entry.get("risk_tier", "medium")),
                modifies_state=entry.get("modifies_state", False),
                accesses_network=entry.get("accesses_network", False),
                executes_code=entry.get("executes_code", False),
                side_effects=entry.get("side_effects", []),
            )
            self._risk_profiles[profile.tool_name] = profile

    def register_risk_profile(self, profile: ToolRiskProfile) -> None:
        self._risk_profiles[profile.tool_name] = profile

    def set_session_policy(self, session_id: str, policy: ApprovalPolicy) -> None:
        self._session_policies[session_id] = policy
        log.info("审批策略已设置", session=session_id, policy=policy.value)

    def get_session_policy(self, session_id: str) -> ApprovalPolicy:
        return self._session_policies.get(session_id, self.default_policy)

    def check(
        self,
        tool_name: str,
        session_id: str = "",
        override_policy: ApprovalPolicy | None = None,
    ) -> ApprovalDecision:
        policy = override_policy or self.get_session_policy(session_id)
        profile = self._risk_profiles.get(tool_name)
        risk_tier = profile.risk_tier if profile else RiskTier.MEDIUM

        approved, needs_confirm, reason = self._evaluate(policy, risk_tier, profile)

        decision = ApprovalDecision(
            tool_name=tool_name,
            policy=policy,
            risk_tier=risk_tier,
            approved=approved,
            needs_confirmation=needs_confirm,
            reason=reason,
        )
        self._decision_log.append(decision)
        if not approved or needs_confirm:
            log.info("审批决策", tool=tool_name, policy=policy.value,
                     risk=risk_tier.value, approved=approved, confirm=needs_confirm)
        return decision

    def _evaluate(
        self,
        policy: ApprovalPolicy,
        risk_tier: RiskTier,
        profile: ToolRiskProfile | None,
    ) -> tuple[bool, bool, str]:
        if policy == ApprovalPolicy.SUGGEST:
            return False, False, "suggest模式: 仅建议不执行"

        if risk_tier == RiskTier.CRITICAL:
            if policy == ApprovalPolicy.FULL_AUTO:
                return True, True, "full-auto: critical操作需确认"
            return True, True, "critical风险操作需确认"

        if policy == ApprovalPolicy.AUTO_EDIT:
            if risk_tier == RiskTier.READ_ONLY:
                return True, False, "auto-edit: 只读操作自动执行"
            if risk_tier in (RiskTier.LOW, RiskTier.MEDIUM):
                if profile and profile.modifies_state:
                    return True, True, "auto-edit: 修改操作需确认"
                return True, False, "auto-edit: 非修改操作自动执行"
            return True, True, "auto-edit: 高风险操作需确认"

        if policy == ApprovalPolicy.FULL_AUTO:
            if risk_tier in (RiskTier.READ_ONLY, RiskTier.LOW, RiskTier.MEDIUM):
                return True, False, "full-auto: 低中风险自动执行"
            return True, True, "full-auto: 高风险需确认"

        return True, False, "默认允许"

    def get_decision_log(self, session_id: str = "", limit: int = 100) -> list[dict[str, Any]]:
        logs = self._decision_log
        if limit > 0:
            logs = logs[-limit:]
        return [
            {
                "tool": d.tool_name,
                "policy": d.policy.value,
                "risk": d.risk_tier.value,
                "approved": d.approved,
                "needs_confirmation": d.needs_confirmation,
                "reason": d.reason,
                "timestamp": d.timestamp,
            }
            for d in logs
        ]

    async def request_approval(
        self,
        tool_name: str,
        params: dict[str, Any] | None = None,
        risk_level: str = "",
    ) -> ApprovalDecision:
        """兼容旧 ApprovalManager.request_approval 接口的异步适配器.

        供 ConversationLoop 的 self._approval_manager.request_approval() 调用.
        返回 ApprovalDecision (含 approved 属性), 兼容旧 ApprovalResponse.
        """
        risk_map = {
            "critical": RiskTier.CRITICAL,
            "high": RiskTier.HIGH,
            "medium": RiskTier.MEDIUM,
            "low": RiskTier.LOW,
            "read-only": RiskTier.READ_ONLY,
        }
        tier = risk_map.get(risk_level, RiskTier.MEDIUM)
        policy = self.default_policy
        approved, needs_confirm, reason = self._evaluate(policy, tier, self._risk_profiles.get(tool_name))
        decision = ApprovalDecision(
            tool_name=tool_name,
            policy=policy,
            risk_tier=tier,
            approved=approved,
            needs_confirmation=needs_confirm,
            reason=reason,
        )
        self._decision_log.append(decision)
        return decision
