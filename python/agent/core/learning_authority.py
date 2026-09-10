"""D5 LearningAuthority — Python 侧主实现（AGENTS.md §0.1: Learning 归 Python）

闭环语义（冻结方案 D5 验收标准）:
    Evidence → Prediction Error → Belief update → Future Decision

与 TS 侧 src/authority/LearningAuthority.ts 语义对齐，差异（有意）:
  - contextSignature 粒度: proposerId::actionName（工具名）而非
    proposerId::actionType——Python LLMProposer 的 actionType 恒为 "tool_call"，
    TS 粒度会把所有工具调用折叠进同一信念，无法表达"bash 常失败"这类事实。
  - 线程安全: RLock 保护全部可变状态。

职责:
  ✅ compute_prediction_error(evidence) → PredictionError
  ✅ learn(evidence) → BeliefUpdate | None（写入信念库）
  ✅ adjust_candidate(candidate) → 应用信念偏移的候选（DecisionAuthority 裁决前调用）
  ✅ record_decision(decision) → 记录 decisionId→(proposer, actionName) 供证据侧回查
  ❌ 不裁决（→ DecisionAuthority）
  ❌ 不执行动作（→ tool_registry）
  ❌ 不修改 Goal 状态（→ GoalAuthority）
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.authority_types import Decision, DecisionCandidate, GoalEvidence
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("learning_authority")

# 偏移量系数（与 TS computeConfidenceAdjustment/computeProgressAdjustment 对齐）
_CONF_MATCH = 0.01
_CONF_UNDER = 0.15
_CONF_OVER_SCALE = -0.3
_CONF_UNKNOWN = -0.05
_PROG_MATCH = 0.0
_PROG_UNDER = 0.05
_PROG_OVER_SCALE = -0.1
_PROG_UNKNOWN = -0.02

_MAX_HISTORY = 1000


@dataclass
class PredictionError:
    evidenceId: str
    goalId: str
    decisionId: str
    expectedEffect: str
    actualEffect: str
    errorMagnitude: float
    errorType: str  # 'over_prediction' | 'under_prediction' | 'match' | 'unknown'
    timestamp: float = field(default_factory=time.time)


@dataclass
class BeliefUpdate:
    beliefId: str
    sourceEvidenceId: str
    sourceGoalId: str
    sourceDecisionId: str
    proposerId: str
    actionName: str
    contextSignature: str
    confidenceAdjustment: float
    progressAdjustment: float
    reason: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class LearnedBelief:
    contextSignature: str
    proposerId: str
    actionName: str
    confidenceBias: float
    progressBias: float
    sampleCount: int
    lastUpdated: float


def _gen_belief_id() -> str:
    import uuid

    return f"BU_{uuid.uuid4().hex[:12]}"


def _count_shared_words(a: str, b: str) -> int:
    words_a = {w for w in a.split() if len(w) > 2}
    words_b = {w for w in b.split() if len(w) > 2}
    return len(words_a & words_b)


class LearningAuthority:
    _instance: LearningAuthority | None = None
    _lock = threading.Lock()

    @classmethod
    def getInstance(cls) -> LearningAuthority:
        with cls._lock:
            if cls._instance is None:
                cls._instance = LearningAuthority()
            return cls._instance

    @classmethod
    def resetInstance(cls) -> None:
        with cls._lock:
            cls._instance = None

    def __init__(self) -> None:
        self._mu = threading.RLock()
        self._beliefs: dict[str, LearnedBelief] = {}
        self._belief_history: list[BeliefUpdate] = []
        self._prediction_errors: list[PredictionError] = []
        # decisionId → (proposerId, actionName)：证据写回时回查 proposer
        self._decision_provenance: dict[str, tuple[str, str]] = {}

    # ---------------------------------------------------------- 证据侧入口

    def record_decision(self, decision: Decision) -> None:
        """DecisionAuthority 裁决后登记 provenance，供 learn() 回查 proposer。"""
        action_name = ""
        payload = decision.chosen.action.payload if decision.chosen else {}
        if isinstance(payload, dict):
            action_name = str(payload.get("name", ""))
        with self._mu:
            self._decision_provenance[decision.decisionId] = (
                decision.chosen.proposerId if decision.chosen else "unknown",
                action_name,
            )
            if len(self._decision_provenance) > _MAX_HISTORY:
                # 淘汰最早的 10% 防无限增长
                drop = max(1, _MAX_HISTORY // 10)
                for k in list(self._decision_provenance.keys())[:drop]:
                    self._decision_provenance.pop(k, None)

    def compute_prediction_error(self, evidence: GoalEvidence) -> PredictionError:
        """Evidence 的预期效果 vs 实际效果 → 预测误差（分类与 TS 对齐）。"""
        expected = (evidence.expectedEffect or "").strip()
        actual = (evidence.actualEffect or "").strip()
        expected_lower = expected.lower()
        actual_lower = actual.lower()

        if expected_lower == actual_lower:
            magnitude, error_type = 0.0, "match"
        else:
            actual_is_success = actual_lower == "success"
            actual_is_failure = actual_lower == "failed" or "fail" in actual_lower
            expected_is_success = expected_lower == "success"

            if actual_is_success and expected_is_success:
                magnitude, error_type = 0.0, "match"
            elif actual_is_success and not expected_is_success:
                magnitude, error_type = 0.3, "under_prediction"
            elif actual_is_failure and expected_is_success:
                magnitude, error_type = 1.0, "over_prediction"
            elif actual_is_failure and not expected_is_success:
                magnitude, error_type = 0.5, "over_prediction"
            else:
                shared = _count_shared_words(expected_lower, actual_lower)
                total = len(set(expected_lower.split()) | set(actual_lower.split()))
                magnitude = (1 - shared / total) if total > 0 else 0.5
                error_type = "over_prediction" if magnitude > 0.5 else "under_prediction"

        pe = PredictionError(
            evidenceId=evidence.evidenceId,
            goalId=evidence.goalId,
            decisionId=evidence.decisionId,
            expectedEffect=expected,
            actualEffect=actual,
            errorMagnitude=magnitude,
            errorType=error_type,
        )
        with self._mu:
            self._prediction_errors.append(pe)
            if len(self._prediction_errors) > _MAX_HISTORY:
                self._prediction_errors.pop(0)
        return pe

    def learn(self, evidence: GoalEvidence) -> BeliefUpdate | None:
        """Evidence → Prediction Error → BeliefUpdate（写入信念库）。

        完全匹配（error=0, type=match）不产生更新——只从意外中学习。
        """
        pe = self.compute_prediction_error(evidence)

        proposer_id, provenance_action = "unknown", ""
        with self._mu:
            provenance = self._decision_provenance.get(evidence.decisionId)
        if provenance is not None:
            proposer_id, provenance_action = provenance
        action_name = evidence.actionName or provenance_action or "unknown"

        signature = f"{proposer_id}::{action_name}"

        if pe.errorType == "match" and pe.errorMagnitude == 0:
            return None

        conf_adj = self._confidence_adjustment(pe)
        prog_adj = self._progress_adjustment(pe)

        update = BeliefUpdate(
            beliefId=_gen_belief_id(),
            sourceEvidenceId=evidence.evidenceId,
            sourceGoalId=evidence.goalId,
            sourceDecisionId=evidence.decisionId,
            proposerId=proposer_id,
            actionName=action_name,
            contextSignature=signature,
            confidenceAdjustment=conf_adj,
            progressAdjustment=prog_adj,
            reason=(
                f"{pe.errorType}: expected=\"{pe.expectedEffect}\" "
                f"actual=\"{pe.actualEffect}\" error={pe.errorMagnitude:.2f}"
            ),
        )
        self._apply_belief_update(update)
        with self._mu:
            self._belief_history.append(update)
            if len(self._belief_history) > _MAX_HISTORY:
                self._belief_history.pop(0)

        log.info(
            "D5 belief updated",
            beliefId=update.beliefId,
            signature=signature,
            confAdj=round(conf_adj, 3),
            progAdj=round(prog_adj, 3),
        )
        return update

    # ---------------------------------------------------------- 决策侧入口

    def adjust_candidate(self, candidate: DecisionCandidate) -> DecisionCandidate:
        """按信念对候选做置信度/进度偏移（DecisionAuthority 裁决前调用）。"""
        payload = candidate.action.payload if isinstance(candidate.action.payload, dict) else {}
        action_name = str(payload.get("name", "") or "unknown")
        signature = f"{candidate.proposerId}::{action_name}"

        with self._mu:
            belief = self._beliefs.get(signature)
        if belief is None:
            return candidate

        adjusted_conf = max(0.01, min(1.0, candidate.confidence + belief.confidenceBias))
        adjusted_prog = max(0.0, min(1.0, candidate.estimatedGoalProgress + belief.progressBias))

        if (
            abs(adjusted_conf - candidate.confidence) < 0.001
            and abs(adjusted_prog - candidate.estimatedGoalProgress) < 0.001
        ):
            return candidate

        return DecisionCandidate(
            candidateId=candidate.candidateId,
            proposerId=candidate.proposerId,
            action=candidate.action,
            confidence=adjusted_conf,
            estimatedGoalProgress=adjusted_prog,
            reasoning=(
                f"{candidate.reasoning} [learned: confBias={belief.confidenceBias:.3f}, "
                f"progBias={belief.progressBias:.3f}, samples={belief.sampleCount}]"
            ),
        )

    # ---------------------------------------------------------- 查询（replay 用）

    def get_belief(self, contextSignature: str) -> LearnedBelief | None:
        with self._mu:
            return self._beliefs.get(contextSignature)

    def get_all_beliefs(self) -> list[LearnedBelief]:
        with self._mu:
            return list(self._beliefs.values())

    def get_belief_history(self) -> list[BeliefUpdate]:
        with self._mu:
            return list(self._belief_history)

    def get_belief_history_for_goal(self, goalId: str) -> list[BeliefUpdate]:
        with self._mu:
            return [b for b in self._belief_history if b.sourceGoalId == goalId]

    def get_prediction_errors(self) -> list[PredictionError]:
        with self._mu:
            return list(self._prediction_errors)

    # ---------------------------------------------------------- 内部

    def _apply_belief_update(self, update: BeliefUpdate) -> None:
        with self._mu:
            existing = self._beliefs.get(update.contextSignature)
            if existing is not None:
                decay = max(0.3, 1 / existing.sampleCount)
                new_conf = existing.confidenceBias * (1 - decay) + update.confidenceAdjustment * decay
                new_prog = existing.progressBias * (1 - decay) + update.progressAdjustment * decay
                belief = LearnedBelief(
                    contextSignature=update.contextSignature,
                    proposerId=update.proposerId,
                    actionName=update.actionName,
                    confidenceBias=new_conf,
                    progressBias=new_prog,
                    sampleCount=existing.sampleCount + 1,
                    lastUpdated=time.time(),
                )
            else:
                belief = LearnedBelief(
                    contextSignature=update.contextSignature,
                    proposerId=update.proposerId,
                    actionName=update.actionName,
                    confidenceBias=update.confidenceAdjustment,
                    progressBias=update.progressAdjustment,
                    sampleCount=1,
                    lastUpdated=time.time(),
                )
            self._beliefs[update.contextSignature] = belief

        # D6: 信念持久化（Risk 4 — 信念跨进程/重启存活）。失败不阻断学习。
        try:
            from agent.core.memory_authority import MemoryAuthority

            MemoryAuthority.getInstance().persist_belief_update(update, belief)
        except Exception as _persist_exc:
            log_ignored(log, "LearningAuthority.persist_belief", _persist_exc)

    def restore_from_store(self) -> int:
        """D6: 从 MemoryAuthority 恢复信念库（进程启动时显式调用，测试安全）。"""
        try:
            from agent.core.memory_authority import MemoryAuthority

            restored = MemoryAuthority.getInstance().load_beliefs()
        except Exception as _restore_exc:
            log_ignored(log, "LearningAuthority.restore_from_store", _restore_exc)
            return 0
        with self._mu:
            self._beliefs.update(restored)
        return len(restored)

    def _confidence_adjustment(self, pe: PredictionError) -> float:
        if pe.errorType == "match":
            return _CONF_MATCH
        if pe.errorType == "under_prediction":
            return _CONF_UNDER
        if pe.errorType == "over_prediction":
            return _CONF_OVER_SCALE * pe.errorMagnitude
        return _CONF_UNKNOWN

    def _progress_adjustment(self, pe: PredictionError) -> float:
        if pe.errorType == "match":
            return _PROG_MATCH
        if pe.errorType == "under_prediction":
            return _PROG_UNDER
        if pe.errorType == "over_prediction":
            return _PROG_OVER_SCALE * pe.errorMagnitude
        return _PROG_UNKNOWN
