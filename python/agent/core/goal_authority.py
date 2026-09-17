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
        # 长任务 Goal 复用：session_id → goalId 绑定。同一会话的后续请求复用
        # 同一 Goal 身份（progress/evidence/planVersion 跨轮延续）。
        self._session_goals: dict[str, str] = {}

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

    def getOrCreateGoal(
        self,
        description: str,
        originalInput: str,
        session_id: str | None = None,
        explicit_goal_id: str | None = None,
        priority: GoalPriority = GoalPriority.MEDIUM,
        parentGoalId: str | None = None,
        successCondition: str = "",
        abandonmentCondition: str = "",
    ) -> Goal:
        """跨请求 Goal 身份复用（长任务编排）。

        优先级：
        1. explicit_goal_id（TS 网关委派身份 / 长任务编排器显式指定）：
           已存在 → 复用；不存在 → 以该 ID 落库（避免 getGoal/replan 断链）。
        2. session_id 绑定过 ACTIVE Goal → 复用（跨轮延续，description 追加轮次）。
        3. 否则新建并绑定 session。

        复用不改变 Goal 身份（goalId/planVersion 延续），只把新输入追加到描述，
        使 replan / Evidence / Learning 的跨轮价值真正兑现。
        """
        if explicit_goal_id:
            existing = self._goals.get(explicit_goal_id)
            if existing:
                if session_id:
                    self._session_goals[session_id] = existing.goalId
                _log.info(
                    "Goal reused (delegated)",
                    goalId=existing.goalId,
                    sessionId=session_id or "",
                    planVersion=existing.planVersion,
                )
                return existing
            # 委派身份在本进程不存在（如 TS 网关下发）→ 以相同 ID 落库。
            goal = Goal(
                goalId=explicit_goal_id,
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
            if session_id:
                self._session_goals[session_id] = goal.goalId
            _log.info(
                "Goal registered (delegated id)",
                goalId=goal.goalId,
                sessionId=session_id or "",
            )
            return goal

        if session_id:
            bound_id = self._session_goals.get(session_id)
            if bound_id:
                bound = self._goals.get(bound_id)
                if bound is not None and bound.status == GoalStatus.ACTIVE:
                    # 跨轮复用：追加本轮描述，保留 originalInput（长任务语义）。
                    if description and description != bound.description:
                        bound.description = (
                            f"{bound.description} | 续: {description[:200]}"
                        )
                    bound.updatedAt = time.time()
                    _log.info(
                        "Goal reused (session)",
                        goalId=bound.goalId,
                        sessionId=session_id,
                        planVersion=bound.planVersion,
                        progress=bound.progress,
                    )
                    return bound

        goal = self.createGoal(
            description=description,
            originalInput=originalInput,
            priority=priority,
            parentGoalId=parentGoalId,
            successCondition=successCondition,
            abandonmentCondition=abandonmentCondition,
        )
        if session_id:
            self._session_goals[session_id] = goal.goalId
        _log.info(
            "Goal created",
            goalId=goal.goalId,
            sessionId=session_id or "",
        )
        return goal

    def _unbindSessionForGoal(self, goalId: str) -> None:
        """Goal 完结/放弃后解除 session 绑定，下次请求新建 Goal。"""
        for sid, gid in list(self._session_goals.items()):
            if gid == goalId:
                self._session_goals.pop(sid, None)

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
        self._unbindSessionForGoal(goalId)
        return goal

    def markAbandoned(self, goalId: str, reason: str = "") -> Goal:
        goal = self._get_goal_or_throw(goalId)
        goal.status = GoalStatus.ABANDONED
        goal.updatedAt = time.time()
        if reason:
            goal.metadata["abandonmentReason"] = reason
        self._unbindSessionForGoal(goalId)
        return goal

    def replan(
        self,
        goalId: str,
        reason: str,
        expectedVersion: int | None = None,
    ) -> Goal:
        goal = self._get_goal_or_throw(goalId)
        # 并发安全：若调用方给出期望版本且已被并发 replan 越过，拒绝重复递增。
        if expectedVersion is not None and goal.planVersion != expectedVersion:
            return goal
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
