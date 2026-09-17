"""L0 ActionAuthority —— 动作执行前的最后一道权力门禁（Python 侧）。

为什么需要它（七层中 Python 侧唯一缺失的层）:
    主循环此前只有 ``_pre_tool_verify``（**参数 schema** 校验）和
    ``RuntimePosture`` 风险矩阵。两者都回答不了 L0 该回答的问题：

        **这个动作有权被执行吗？**

    Layer 1 不变量（FROZEN 文档）:
        任何 production action 必须携带 goalId + snapshotId + decisionId，
        且必须是 DecisionAuthority FINAL 裁决的 **accepted** 候选。

    没有这一层时，以下旁路在 Python 侧是敞开的：
      - 任何代码路径拿到 ToolCall 就能执行，哪怕它**从未经过** DecisionAuthority
      - 伪造 authority_* 元数据（没有 provenance 回查）
      - rejected 候选 / 已被 veto 的动作仍可被执行
      - TS 网关下发的跨进程委派动作没有身份校验

判定规则（四道检查，任一失败即 fail-closed）:
    1. identity    三元组齐全（goalId / snapshotId / decisionId）
    2. provenance  decisionId 能在 DecisionAuthority 回查到裁决（防伪造）
                   且 candidateId 确实在该裁决的 acceptedCandidates 里
                   （防止 rejected / 已 veto 的动作被偷跑）
    3. posture     RuntimePosture 风险矩阵（复用现有裁决，不在 L0 重复实现）
    4. legacy      use_authority=False 时显式放行并打 LEGACY 标记
                   （该开关本身已受 enforce_authority_invariant 生产守卫约束）

设计约束:
    - 纯判定，**不执行**任何动作（§9.3 同类原则）
    - 拒绝必须可审计：reason 写进 ToolResult.error 与日志
    - 校验器自身异常 → fail-closed（与 schema 校验异常同策略，§1.7）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("action_authority")

#: 允许执行
VERDICT_ALLOW = "allow"
#: 拒绝执行（fail-closed）
VERDICT_DENY = "deny"

#: L0 拒绝码（ToolResult.error 使用，失败地图据此分类）
DENY_NO_IDENTITY = "authority_denied_no_identity"
DENY_FORGED = "authority_denied_forged_provenance"
DENY_NOT_ACCEPTED = "authority_denied_candidate_not_accepted"
DENY_POSTURE = "authority_denied_posture"
DENY_INTERNAL = "authority_denied_internal_error"


@dataclass
class ActionContext:
    """一次待执行动作的 Authority 上下文（来自 ToolCall.metadata）。"""

    toolName: str
    toolCallId: str
    goalId: str | None = None
    snapshotId: str | None = None
    decisionId: str | None = None
    candidateId: str | None = None
    proposerId: str | None = None
    useAuthority: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ActionVerdict:
    """L0 裁决结果。

    Attributes:
        verdict: allow / deny。
        reason: 拒绝码（allow 时为空）。
        detail: 人读说明（写审计日志与 ToolResult）。
    """

    verdict: str
    reason: str = ""
    detail: str = ""


class ActionAuthority:
    """L0 权力门禁 —— 在真正产生副作用之前，验证动作的执行权。"""

    def __init__(self, *, decision_authority: Any = None, posture_checker: Any = None) -> None:
        """
        Args:
            decision_authority: DecisionAuthority 实例（provenance 回查）。
            posture_checker: 可选 ``(toolName, riskLevel) -> (allowed, reason)``。
                未提供时跳过姿态检查（由调用方已有的 RuntimePosture 链负责）。
        """
        self._decision_authority = decision_authority
        self._posture_checker = posture_checker

    def bind_posture(self, checker: Any) -> None:
        """注入姿态检查器（延迟绑定，避免循环依赖）。"""
        self._posture_checker = checker

    # ---------------------------------------------------------- 裁决

    def check(self, ctx: ActionContext) -> ActionVerdict:
        """裁决一次动作是否可执行。

        fail-closed：本方法自身异常时返回 DENY_INTERNAL。
        """
        try:
            return self._check(ctx)
        except Exception as e:
            log.error(
                "L0 门禁内部异常，fail-closed",
                tool=ctx.toolName,
                error=str(e),
            )
            return ActionVerdict(
                verdict=VERDICT_DENY,
                reason=DENY_INTERNAL,
                detail=f"ActionAuthority 内部异常: {e}",
            )

    def _check(self, ctx: ActionContext) -> ActionVerdict:
        # ── legacy 模式：显式放行并标记 ──
        # use_authority=False 本身受 enforce_authority_invariant 生产守卫约束，
        # 只可能出现在测试/兼容路径，这里放行但必须留痕。
        if not ctx.useAuthority:
            log.warning(
                "L0 LEGACY/TEST ONLY 放行：动作未携带 Authority 链",
                tool=ctx.toolName,
                toolCallId=ctx.toolCallId,
            )
            return ActionVerdict(verdict=VERDICT_ALLOW)

        # ── 1. identity：三元组齐全 ──
        if not (ctx.goalId and ctx.snapshotId and ctx.decisionId):
            missing = [
                name for name, v in (
                    ("goalId", ctx.goalId),
                    ("snapshotId", ctx.snapshotId),
                    ("decisionId", ctx.decisionId),
                ) if not v
            ]
            log.warning(
                "L0 拒绝：Authority 身份不完整",
                tool=ctx.toolName,
                toolCallId=ctx.toolCallId,
                missing=missing,
            )
            return ActionVerdict(
                verdict=VERDICT_DENY,
                reason=DENY_NO_IDENTITY,
                detail=f"缺少 Authority 身份字段: {missing}",
            )

        # ── 2. provenance：裁决真实存在，且候选确被接受 ──
        decision = None
        if self._decision_authority is not None:
            decision = self._decision_authority.getDecisionById(ctx.decisionId)

        if decision is None:
            # 查不到裁决：要么伪造，要么来自其他进程且未回填。
            # 两种都不允许执行 —— provenance 必须可回查。
            log.warning(
                "L0 拒绝：decisionId 无法回查（伪造或跨进程未回填）",
                tool=ctx.toolName,
                toolCallId=ctx.toolCallId,
                decisionId=ctx.decisionId,
            )
            return ActionVerdict(
                verdict=VERDICT_DENY,
                reason=DENY_FORGED,
                detail=f"decisionId {ctx.decisionId} 无法回查到 FINAL 裁决",
            )

        accepted_ids = {c.candidateId for c in decision.acceptedCandidates}
        if ctx.candidateId and ctx.candidateId not in accepted_ids:
            log.warning(
                "L0 拒绝：候选不在 accepted 集合（rejected/veto 动作试图执行）",
                tool=ctx.toolName,
                toolCallId=ctx.toolCallId,
                candidateId=ctx.candidateId,
                decisionId=ctx.decisionId,
            )
            return ActionVerdict(
                verdict=VERDICT_DENY,
                reason=DENY_NOT_ACCEPTED,
                detail=(
                    f"candidateId {ctx.candidateId} 不在裁决 "
                    f"{ctx.decisionId} 的 acceptedCandidates 中"
                ),
            )

        # goalId 一致性：动作声称的 goal 必须与裁决的 goal 一致
        if getattr(decision, "goalId", None) and decision.goalId != ctx.goalId:
            log.warning(
                "L0 拒绝：goalId 与裁决不一致",
                tool=ctx.toolName,
                toolCallId=ctx.toolCallId,
            )
            return ActionVerdict(
                verdict=VERDICT_DENY,
                reason=DENY_FORGED,
                detail=(
                    f"action.goalId={ctx.goalId} 与 decision.goalId={decision.goalId} 不一致"
                ),
            )

        # ── 3. posture：风险矩阵 ──
        if self._posture_checker is not None:
            allowed, reason = self._posture_checker(ctx.toolName)
            if not allowed:
                log.warning(
                    "L0 拒绝：姿态不允许该风险等级",
                    tool=ctx.toolName,
                    toolCallId=ctx.toolCallId,
                    postureReason=reason,
                )
                return ActionVerdict(
                    verdict=VERDICT_DENY,
                    reason=DENY_POSTURE,
                    detail=f"RuntimePosture 拒绝: {reason}",
                )

        return ActionVerdict(verdict=VERDICT_ALLOW)
