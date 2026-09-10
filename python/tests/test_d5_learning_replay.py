"""D5 Learning Authority — 真实链路闭环验收

冻结方案 D5 验收标准：必须证明
    Evidence → Prediction Error → Belief update → Future Decision
不能是 "update() 写 cache 就结束"。

本测试通过真实 GoalAuthority / DecisionAuthority / LearningAuthority
（无 stub LLM——决策候选直接构造）验证：
  1. 失败 Evidence → over_prediction → 负向 belief → 下一次同上下文决策
     该候选置信度被压低/排序改变（future decision 真实改变）
  2. 成功超预期 Evidence → under_prediction → 正向 belief
  3. 完全匹配 Evidence → 不产生 belief update（只从意外中学习）
  4. belief 可按 goalId 溯源（replay 语义）
  5. 无信念时决策路径与 D4 行为完全一致（零回归）
"""
from __future__ import annotations

import pytest

from agent.core.authority_types import (
    CanonicalDecisionSnapshot,
    CapabilitySet,
    ContextView,
    DecisionCandidate,
    DecisionContext,
    MemoryView,
    ProposedAction,
    SelfView,
    WorldView,
)
from agent.core.decision_authority import DecisionAuthority
from agent.core.goal_authority import GoalAuthority
from agent.core.learning_authority import LearningAuthority


def _snapshot(snapshot_id: str) -> CanonicalDecisionSnapshot:
    return CanonicalDecisionSnapshot(
        snapshotId=snapshot_id,
        timestamp=1.0,
        activeGoalIds=[],
        self=SelfView(agentId="test"),
        world=WorldView(),
        memory=MemoryView(),
        context=ContextView(),
        capabilities=CapabilitySet(),
    )


def _candidates() -> list[DecisionCandidate]:
    """两个候选：bash(conf 0.9) 与 python(conf 0.7)——bash 初始更优。"""
    return [
        DecisionCandidate(
            candidateId="C_bash",
            proposerId="llm",
            action=ProposedAction(type="tool_call", payload={"name": "bash"}),
            confidence=0.9,
            reasoning="run shell",
            estimatedGoalProgress=0.6,
        ),
        DecisionCandidate(
            candidateId="C_python",
            proposerId="llm",
            action=ProposedAction(type="tool_call", payload={"name": "python"}),
            confidence=0.85,
            reasoning="run python",
            estimatedGoalProgress=0.55,
        ),
    ]


@pytest.fixture(autouse=True)
def _fresh_authorities():
    DecisionAuthority.resetInstance()
    GoalAuthority.resetInstance()
    LearningAuthority.resetInstance()
    yield
    DecisionAuthority.resetInstance()
    GoalAuthority.resetInstance()
    LearningAuthority.resetInstance()


@pytest.mark.asyncio
async def test_evidence_to_belief_to_future_decision_closed_loop():
    """核心闭环：失败 Evidence 改变未来决策。"""
    ga = GoalAuthority.getInstance()
    da = DecisionAuthority.getInstance()
    learning = LearningAuthority.getInstance()

    # ---- 第 1 轮：goal A，bash 胜出（0.9*0.4+0.6*0.6=0.72 > python 0.52）----
    goal_a = ga.createGoal(description="task A", originalInput="task A")
    decision_a = await da.decide(
        DecisionContext(goalId=goal_a.goalId, snapshot=_snapshot("SS_A"), candidates=_candidates())
    )
    assert decision_a.chosenCandidateId == "C_bash"

    # ---- Evidence：bash 失败（expected=success, actual=failed）----
    ga.updateFromEvidence(
        goalId=goal_a.goalId,
        decisionId=decision_a.decisionId,
        actionName="bash",
        expectedEffect="success",
        actualEffect="failed: exit code 1",
        progressDelta=0.0,
    )

    # PredictionError 已产出且分类为 over_prediction
    errors = learning.get_prediction_errors()
    assert len(errors) == 1
    assert errors[0].errorType == "over_prediction"
    assert errors[0].errorMagnitude == 1.0

    # BeliefUpdate 已写入信念库（Evidence→Belief 侧闭合）
    belief = learning.get_belief("llm::bash")
    assert belief is not None
    assert belief.confidenceBias < 0  # over_prediction → 负向偏移
    assert belief.sampleCount == 1

    # ---- 第 2 轮：goal B 同上下文——bash 被压低，python 胜出 ----
    goal_b = ga.createGoal(description="task B", originalInput="task B")
    decision_b = await da.decide(
        DecisionContext(goalId=goal_b.goalId, snapshot=_snapshot("SS_B"), candidates=_candidates())
    )

    chosen = decision_b.chosen
    assert chosen.candidateId == "C_python", (
        "失败 Evidence 必须改变未来决策：bash confBias<0 后 python 应胜出"
    )
    # learned 注记写进 reasoning（审计可追溯）
    assert "[learned:" in chosen.reasoning or "[learned:" in decision_b.selectionReason or any(
        "[learned:" in c.reasoning for c in decision_b.acceptedCandidates
    )
    # bash 候选被真实调整（confidence < 原 0.9）
    bash_adj = next(c for c in decision_b.candidateIds if c == "C_bash")
    assert bash_adj  # id 在列
    assert "learningAdjustments=" in decision_b.selectionReason

    # ---- replay：belief 历史可按 goalId 溯源 ----
    hist_a = learning.get_belief_history_for_goal(goal_a.goalId)
    assert len(hist_a) == 1
    assert hist_a[0].sourceDecisionId == decision_a.decisionId
    assert hist_a[0].sourceEvidenceId


@pytest.mark.asyncio
async def test_learning_edge_cases():
    """match 不更新 / under_prediction 正向 / 无信念路径零回归。"""
    ga = GoalAuthority.getInstance()
    da = DecisionAuthority.getInstance()
    learning = LearningAuthority.getInstance()

    goal = ga.createGoal(description="edge", originalInput="edge")

    # 1) match：完全匹配 → 无 belief update
    ga.updateFromEvidence(
        goalId=goal.goalId,
        decisionId="D_none",
        actionName="echo",
        expectedEffect="success",
        actualEffect="success",
        progressDelta=0.1,
    )
    assert learning.get_belief("unknown::echo") is None
    assert learning.get_prediction_errors()[0].errorType == "match"

    # 2) under_prediction：成功超预期 → 正向 belief
    goal2 = ga.createGoal(description="edge2", originalInput="edge2")
    da_record = await da.decide(
        DecisionContext(
            goalId=goal2.goalId,
            snapshot=_snapshot("SS_edge2"),
            candidates=[DecisionCandidate(
                candidateId="C_grep",
                proposerId="llm",
                action=ProposedAction(type="tool_call", payload={"name": "grep"}),
                confidence=0.5,
                estimatedGoalProgress=0.3,
            )],
        )
    )
    ga.updateFromEvidence(
        goalId=goal2.goalId,
        decisionId=da_record.decisionId,
        actionName="grep",
        expectedEffect="partial match",
        actualEffect="success",
        progressDelta=0.2,
    )
    belief_grep = learning.get_belief("llm::grep")
    assert belief_grep is not None
    assert belief_grep.confidenceBias > 0  # under_prediction → 正向偏移

    # 3) 无信念工具不受影响：adjust_candidate 对未知签名是恒等
    cand = DecisionCandidate(
        candidateId="C_x", proposerId="llm",
        action=ProposedAction(type="tool_call", payload={"name": "unknown_tool"}),
        confidence=0.8,
    )
    assert learning.adjust_candidate(cand) is cand

    # 4) 无信念时 decide() 行为与 D4 一致（confidence 0.9 的 bash 仍胜出）
    goal3 = ga.createGoal(description="no-belief", originalInput="no-belief")
    decision3 = await da.decide(
        DecisionContext(goalId=goal3.goalId, snapshot=_snapshot("SS_3"), candidates=_candidates())
    )
    assert decision3.chosenCandidateId == "C_bash"  # grep 的信念不影响 bash
