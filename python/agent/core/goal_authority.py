"""
D4 GoalAuthority — Python 侧实现

职责：
  ✅ 创建/查询 Goal
  ✅ evaluateStatus() → GoalStatusEvaluation（只评估，不决策）
  ✅ updateFromEvidence() → evidence-based progress
  ✅ replan() → planVersion++（Goal identity 不变）
  ✅ markCompleted / markAbandoned
  ❌ 不决定"下一步做什么"（→ DecisionAuthority）
  ❌ 不读取 state（→ StateAuthority）
"""
from __future__ import annotations

import time
import threading
from typing import Any

from agent.core.authority_types import (
    Goal,
    GoalEvidence,
    GoalPriority,
    GoalStatus,
    GoalStatusEvaluation,
    _gen_id,
)
from agent.core.logger import StructuredLogger, log_ignored

_log = StructuredLogger("goal_authority")


class GoalAuthority:
    _instance: GoalAuthority | None = None
    _lock = threading.Lock()

    @classmethod
    def getInstance(cls) -> GoalAuthority:
        with cls._lock:
            if cls._instance is None:
                cls._instance = GoalAuthority()
        return cls._instance

    @classmethod
    def resetInstance(cls) -> None:
        with cls._lock:
            cls._instance = None

    def __init__(self) -> None:
        self._goals: dict[str, Goal] = {}
        self._evidence_log: dict[str, list[GoalEvidence]] = {}

    def createGoal(
        self,
        description: str,
        originalInput: str,
        priority: GoalPriority = GoalPriority.MEDIUM,
        parentGoalId: str | None = None,
        successCondition: str = "",
        abandonmentCondition: str = "",
    ) -> Goal:
        goal = Goal(
            goalId=_gen_id("G"),
            description=description,
            originalInput=originalInput,
            priority=priority,
            parentGoalId=parentGoalId,
            successCondition=successCondition,
            abandonmentCondition=abandonmentCondition,
            currentStage="created",
            planVersion=1,
        )
        self._goals[goal.goalId] = goal
        return goal

    def getGoal(self, goalId: str) -> Goal | None:
        return self._goals.get(goalId)

    def getActiveGoals(self) -> list[Goal]:
        return [g for g in self._goals.values() if g.status == GoalStatus.ACTIVE]

    def updateFromEvidence(
        self,
        goalId: str,
        decisionId: str,
        actionName: str,
        actionParams: dict[str, Any] | None = None,
        observation: Any = None,
        expectedEffect: str = "",
        actualEffect: str = "",
        progressDelta: float = 0.0,
    ) -> Goal:
        goal = self._get_goal_or_throw(goalId)
        evidence = GoalEvidence(
            evidenceId=_gen_id("E"),
            goalId=goalId,
            decisionId=decisionId,
            observation=observation,
            actionName=actionName,
            actionParams=actionParams or {},
            expectedEffect=expectedEffect,
            actualEffect=actualEffect,
            progressDelta=progressDelta,
        )
        if goalId not in self._evidence_log:
            self._evidence_log[goalId] = []
        self._evidence_log[goalId].append(evidence)

        # D5: Evidence → LearningAuthority（Prediction Error → Belief update）
        # 学习失败不阻断 Evidence 记账（progress/status 更新必须完成）。
        try:
            from agent.core.learning_authority import LearningAuthority

            LearningAuthority.getInstance().learn(evidence)
        except Exception as _learn_exc:
            log_ignored(_log, "GoalAuthority.updateFromEvidence.learning", _learn_exc)

        # D6: Evidence 持久化（跨进程一致 + replay 溯源）。失败不阻断记账。
        try:
            from agent.core.memory_authority import MemoryAuthority

            MemoryAuthority.getInstance().persist_evidence(evidence)
        except Exception as _persist_exc:
            log_ignored(_log, "GoalAuthority.persist_evidence", _persist_exc)

        clamped = max(0.0, min(1.0, goal.progress + progressDelta))
        goal.progress = clamped
        goal.updatedAt = evidence.timestamp

        if clamped >= 1.0 and goal.status == GoalStatus.ACTIVE:
            goal.status = GoalStatus.COMPLETED

        return goal

    def updateStage(self, goalId: str, stage: str) -> Goal:
        goal = self._get_goal_or_throw(goalId)
        goal.currentStage = stage
        goal.updatedAt = time.time()
        return goal

    def markCompleted(self, goalId: str, reason: str = "") -> Goal:
        goal = self._get_goal_or_throw(goalId)
        goal.status = GoalStatus.COMPLETED
        goal.progress = 1.0
        goal.updatedAt = time.time()
        if reason:
            goal.metadata["completionReason"] = reason
        return goal

    def markAbandoned(self, goalId: str, reason: str = "") -> Goal:
        goal = self._get_goal_or_throw(goalId)
        goal.status = GoalStatus.ABANDONED
        goal.updatedAt = time.time()
        if reason:
            goal.metadata["abandonmentReason"] = reason
        return goal

    def replan(self, goalId: str, reason: str) -> Goal:
        goal = self._get_goal_or_throw(goalId)
        goal.planVersion += 1
        goal.updatedAt = time.time()
        goal.metadata[f"replanReason_v{goal.planVersion}"] = reason
        return goal

    def evaluateStatus(
        self,
        goalId: str,
        evidence: GoalEvidence | None = None,
    ) -> GoalStatusEvaluation:
        goal = self._get_goal_or_throw(goalId)
        if goal.status == GoalStatus.COMPLETED:
            return GoalStatusEvaluation(status=GoalStatus.COMPLETED, reason="progress reached 1.0")
        if goal.status == GoalStatus.ABANDONED:
            return GoalStatusEvaluation(
                status=GoalStatus.ABANDONED,
                reason=goal.metadata.get("abandonmentReason", "abandoned"),
            )
        if goal.progress >= 1.0:
            return GoalStatusEvaluation(status=GoalStatus.COMPLETED, reason="progress reached 1.0")
        if evidence and evidence.progressDelta < -0.3:
            return GoalStatusEvaluation(
                status=GoalStatus.ACTIVE,
                reason=f"active but negative evidence (delta={evidence.progressDelta:.2f}), consider replan",
            )
        return GoalStatusEvaluation(
            status=GoalStatus.ACTIVE,
            reason=f"progress={goal.progress:.2f}, plan v{goal.planVersion}",
        )

    def getEvidenceLog(self, goalId: str) -> list[GoalEvidence]:
        return self._evidence_log.get(goalId, [])

    def _get_goal_or_throw(self, goalId: str) -> Goal:
        goal = self._goals.get(goalId)
        if goal is None:
            raise ValueError(f"goal {goalId} not found")
        return goal
