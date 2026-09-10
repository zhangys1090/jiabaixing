"""
D4 DecisionAuthority — Python 侧实现

FINAL Authority 原则：
  本模块是 Python 进程内的唯一 FINAL Decision Authority。
  TS 侧 DecisionAuthority 是 TS 进程内的唯一 FINAL。
  两者不嵌套、不互相 override。
  跨进程通信只传递 Decision ID（decisionId/goalId/snapshotId），
  不传递 Decision 语义（chosen/rejected/reason）——
  每个进程只服从自己执行上下文内的 FINAL。

职责：
  ✅ decide() → FINAL Decision（本进程唯一裁决点）
  ✅ decideWithProposers() → 从注册的 Proposer 收集候选 + 裁决
  ✅ 完整审计 trail（selectionReason, rejectedCandidates, proposerSet）
  ❌ 不做安全检查（→ ActionAuthority / permission_guard）
  ❌ 不执行动作（→ tool_registry.execute）
  ❌ 不修改 Goal/State
  ❌ 不服从任何其他进程的 Decision Authority
"""
from __future__ import annotations

import time
from typing import Any

from agent.core.authority_types import (
    CanonicalDecisionSnapshot,
    Decision,
    DecisionCandidate,
    DecisionContext,
    DecisionProposer,
    Goal,
    GoalStatus,
    ProposedAction,
    _gen_id,
)
from agent.core.goal_authority import GoalAuthority
from agent.core.learning_authority import LearningAuthority
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("decision_authority")


class LLMProposer:
    """将 LLM tool_calls 转为 DecisionCandidate[] 的 Proposer。"""

    def __init__(self) -> None:
        self.proposerId = "llm"

    async def propose(
        self,
        goal: Goal,
        snapshot: CanonicalDecisionSnapshot,
        tool_calls_raw: list[dict[str, Any]] | None = None,
    ) -> list[DecisionCandidate]:
        if not tool_calls_raw:
            return []
        candidates: list[DecisionCandidate] = []
        for i, tc_raw in enumerate(tool_calls_raw):
            fn = tc_raw.get("function", {})
            name = fn.get("name", "")
            args_str = fn.get("arguments", "{}")
            candidates.append(DecisionCandidate(
                candidateId=_gen_id("C"),
                proposerId=self.proposerId,
                action=ProposedAction(
                    type="tool_call",
                    payload={"name": name, "arguments": args_str, "id": tc_raw.get("id", "")},
                ),
                confidence=0.85,
                reasoning=f"LLM chose tool {name} for goal '{goal.description[:50]}'",
                estimatedGoalProgress=min(1.0, goal.progress + 0.3),
            ))
        return candidates


class SkillProposer:
    """将 skill match 结果转为 DecisionCandidate[] 的 Proposer。"""

    def __init__(self) -> None:
        self.proposerId = "skill"

    async def propose(
        self,
        goal: Goal,
        snapshot: CanonicalDecisionSnapshot,
        matched_skills: list[dict[str, Any]] | None = None,
    ) -> list[DecisionCandidate]:
        if not matched_skills:
            return []
        candidates: list[DecisionCandidate] = []
        for skill in matched_skills:
            candidates.append(DecisionCandidate(
                candidateId=_gen_id("C"),
                proposerId=self.proposerId,
                action=ProposedAction(
                    type="skill_call",
                    payload=skill,
                ),
                confidence=skill.get("confidence", 0.5),
                reasoning=f"Skill match: {skill.get('name', 'unknown')}",
                estimatedGoalProgress=min(1.0, goal.progress + skill.get("confidence", 0.5) * 0.2),
            ))
        return candidates


class DecisionAuthority:
    _instance: DecisionAuthority | None = None

    @classmethod
    def getInstance(cls) -> DecisionAuthority:
        if cls._instance is None:
            cls._instance = DecisionAuthority()
        return cls._instance

    @classmethod
    def resetInstance(cls) -> None:
        cls._instance = None

    def __init__(self) -> None:
        self._proposers: dict[str, DecisionProposer] = {}
        self._decision_history: dict[str, list[Decision]] = {}

    def registerProposer(self, proposer: DecisionProposer) -> None:
        self._proposers[proposer.proposerId] = proposer

    async def decide(self, context: DecisionContext) -> Decision:
        goalAuth = GoalAuthority.getInstance()
        goal = goalAuth.getGoal(context.goalId)
        if goal is None:
            raise ValueError(f"goal {context.goalId} not found")
        if goal.status != GoalStatus.ACTIVE:
            raise ValueError(f"goal {context.goalId} is {goal.status.value}, not active")

        candidates = context.candidates
        if not candidates:
            raise ValueError(f"no candidates for goal {context.goalId}")

        # D5: LearningAuthority — 依历史 Evidence 信念调整候选（Evidence→Belief→Decision 闭环）
        learning = LearningAuthority.getInstance()
        adjusted = [learning.adjust_candidate(c) for c in candidates]
        learned_count = sum(
            1 for a, o in zip(adjusted, candidates)
            if a.confidence != o.confidence or a.estimatedGoalProgress != o.estimatedGoalProgress
        )

        scored = [(c, self._score_candidate(c, goal.progress)) for c in adjusted]
        scored.sort(key=lambda x: x[1], reverse=True)

        chosen = scored[0][0]
        chosen_score = scored[0][1]

        accept_threshold = chosen_score * 0.7
        accepted = [s[0] for s in scored if s[1] >= accept_threshold]
        rejected = [s[0] for s in scored if s[1] < accept_threshold]

        selection_reason = self._build_selection_reason(chosen, chosen_score, goal.progress, len(accepted))
        if learned_count:
            selection_reason += f" learningAdjustments={learned_count}"

        decision = Decision(
            decisionId=_gen_id("D"),
            goalId=context.goalId,
            snapshotId=context.snapshot.snapshotId,
            candidateIds=[c.candidateId for c in candidates],
            chosenCandidateId=chosen.candidateId,
            chosen=chosen,
            acceptedCandidates=accepted,
            rejectedCandidates=rejected,
            selectionReason=selection_reason,
            proposerSet=list({c.proposerId for c in candidates}),
            vetoReason=None,
            timestamp=time.time(),
        )

        if context.goalId not in self._decision_history:
            self._decision_history[context.goalId] = []
        self._decision_history[context.goalId].append(decision)

        # D5: 登记 provenance（decisionId→proposer/actionName），供 Evidence 写回时学习
        try:
            learning.record_decision(decision)
        except Exception as _lrn_exc:
            log_ignored(log, "DecisionAuthority.record_decision", _lrn_exc)

        # D6: Decision 持久化（Risk 1 — TS 交叉验证数据源）。失败不阻断裁决。
        try:
            from agent.core.memory_authority import MemoryAuthority

            MemoryAuthority.getInstance().persist_decision(decision)
        except Exception as _persist_exc:
            log_ignored(log, "DecisionAuthority.persist_decision", _persist_exc)

        return decision

    async def decideWithProposers(
        self,
        goalId: str,
        snapshot: CanonicalDecisionSnapshot,
    ) -> Decision:
        goalAuth = GoalAuthority.getInstance()
        goal = goalAuth.getGoal(goalId)
        if goal is None:
            raise ValueError(f"goal {goalId} not found")

        all_candidates: list[DecisionCandidate] = []
        proposer_count = 0
        for proposer in self._proposers.values():
            proposer_count += 1
            try:
                cands = await proposer.propose(goal, snapshot)
                all_candidates.extend(cands)
            except Exception as _prop_exc:
                # 单个 proposer 失败不中断其它 proposer，但必须可观测（P2-1 红线）
                log_ignored(log, "DecisionAuthority.decideWithProposers", _prop_exc)

        if not all_candidates:
            raise ValueError(f"no candidates from {proposer_count} proposers")

        context = DecisionContext(
            goalId=goalId,
            snapshot=snapshot,
            candidates=all_candidates,
        )
        return await self.decide(context)

    def getDecisionHistory(self, goalId: str) -> list[Decision]:
        return self._decision_history.get(goalId, [])

    def _score_candidate(self, candidate: DecisionCandidate, currentProgress: float) -> float:
        progress_weight = 0.6
        confidence_weight = 0.4
        return (
            confidence_weight * candidate.confidence
            + progress_weight * candidate.estimatedGoalProgress
        )

    def _build_selection_reason(
        self,
        chosen: DecisionCandidate,
        score: float,
        currentProgress: float,
        acceptedCount: int = 1,
    ) -> str:
        return (
            f"proposer={chosen.proposerId} "
            f"confidence={chosen.confidence:.2f} "
            f"estimatedProgress={chosen.estimatedGoalProgress:.2f} "
            f"score={score:.4f} "
            f"currentProgress={currentProgress:.2f} "
            f"acceptedCount={acceptedCount}"
        )
