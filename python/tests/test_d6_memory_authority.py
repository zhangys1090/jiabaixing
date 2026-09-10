"""D6 Memory Authority — 持久化权威验收

冻结方案 D6 验收标准映射：
  - Risk 4（信念跨进程存活）: test_belief_survives_process_restart
  - 单一权威写路径 + 重启一致性: test_persistence_round_trip
  - 检索服务 Decision（验收②）: test_state_authority_memory_provider
  - Risk 1（TS→Python Decision 交叉验证）: test_cross_validation_endpoint
  - 无静默分歧（存储故障可观测降级）: test_store_unavailable_degrades
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.api.authority import router as authority_router
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
from agent.core.memory_authority import MemoryAuthority
from agent.core.state_authority import StateAuthority


@pytest.fixture()
def store_path(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTHORITY_STORE_PATH", str(tmp_path / "authority.db"))
    MemoryAuthority.resetInstance()
    DecisionAuthority.resetInstance()
    GoalAuthority.resetInstance()
    LearningAuthority.resetInstance()
    StateAuthority.resetInstance()
    yield tmp_path / "authority.db"
    MemoryAuthority.resetInstance()
    DecisionAuthority.resetInstance()
    GoalAuthority.resetInstance()
    LearningAuthority.resetInstance()
    StateAuthority.resetInstance()


def _candidates() -> list[DecisionCandidate]:
    return [
        DecisionCandidate(
            candidateId="C_bash",
            proposerId="llm",
            action=ProposedAction(type="tool_call", payload={"name": "bash"}),
            confidence=0.9,
            reasoning="run shell",
            estimatedGoalProgress=0.6,
        ),
    ]


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


@pytest.mark.asyncio
async def test_persistence_round_trip(store_path):
    """decide + evidence 全部落盘；用全新 store 实例可完整读回（单一写路径）。"""
    ga = GoalAuthority.getInstance()
    da = DecisionAuthority.getInstance()

    goal = ga.createGoal(description="d6 round trip", originalInput="d6 round trip")
    decision = await da.decide(
        DecisionContext(goalId=goal.goalId, snapshot=_snapshot("SS_D6"), candidates=_candidates())
    )
    ga.updateFromEvidence(
        goalId=goal.goalId,
        decisionId=decision.decisionId,
        actionName="bash",
        expectedEffect="success",
        actualEffect="failed: boom",
        progressDelta=0.0,
    )

    # 全新实例（模拟另一进程/重启）从同一文件读
    fresh = MemoryAuthority(str(store_path))
    try:
        dec = fresh.get_decision(decision.decisionId)
        assert dec is not None
        assert dec["goalId"] == goal.goalId
        assert dec["actionName"] == "bash"
        assert dec["chosenCandidateId"] == "C_bash"

        evid = fresh.get_evidence_for_goal(goal.goalId)
        assert len(evid) == 1
        assert evid[0]["decisionId"] == decision.decisionId
        assert "boom" in evid[0]["actualEffect"]

        hist = fresh.get_belief_history_for_goal(goal.goalId)
        assert len(hist) == 1
        assert hist[0]["contextSignature"] == "llm::bash"

        beliefs = fresh.load_beliefs()
        assert "llm::bash" in beliefs
        assert beliefs["llm::bash"].confidenceBias < 0
    finally:
        fresh.close()


def test_belief_survives_process_restart(store_path):
    """Risk 4: LearningAuthority 重建后信念从 store 恢复。"""
    from agent.core.authority_types import Decision, DecisionCandidate, GoalEvidence, ProposedAction

    learning = LearningAuthority.getInstance()
    # 真实 provenance：先登记决策，learn() 才能把 Evidence 归到 proposer
    learning.record_decision(Decision(
        decisionId="D_r1",
        goalId="G_r1",
        snapshotId="SS_r1",
        candidateIds=["C_bash"],
        chosenCandidateId="C_bash",
        chosen=DecisionCandidate(
            candidateId="C_bash",
            proposerId="llm",
            action=ProposedAction(type="tool_call", payload={"name": "bash"}),
            confidence=0.9,
        ),
    ))
    evidence = GoalEvidence(
        evidenceId="E_r1",
        goalId="G_r1",
        decisionId="D_r1",
        actionName="bash",
        expectedEffect="success",
        actualEffect="failed: x",
    )
    update = learning.learn(evidence)
    assert update is not None

    # 模拟进程重启：实例销毁重建
    LearningAuthority.resetInstance()
    learning2 = LearningAuthority.getInstance()
    assert learning2.get_belief("llm::bash") is None  # 内存态已清空

    restored = learning2.restore_from_store()
    assert restored >= 1
    belief = learning2.get_belief("llm::bash")
    assert belief is not None
    assert belief.confidenceBias < 0


@pytest.mark.asyncio
async def test_state_authority_memory_provider(store_path):
    """D6 验收②: 检索服务 Decision — 快照 MemoryView 携带真实记忆。"""
    sa = StateAuthority.getInstance()
    ga = GoalAuthority.getInstance()
    goal = ga.createGoal(description="查询竞品定价策略", originalInput="查询竞品定价策略")

    async def fake_read_memory(query: str) -> MemoryView:
        return MemoryView(
            query=query,
            relevantMemories=[{"content": "历史记录：竞品A定价 199 元", "relevanceScore": 0.8}],
        )

    sa.registerMemoryProvider(fake_read_memory)
    snap = await sa.captureSnapshot(activeGoalIds=[goal.goalId])
    assert snap.memory.relevantMemories, "readMemory provider 必须服务快照"
    assert "竞品A" in snap.memory.relevantMemories[0]["content"]
    assert snap.memory.query == "查询竞品定价策略"

    # provider 抛异常 → 降级空视图而非崩溃（无静默分歧：语义仍正确）
    async def bad_provider(query: str) -> MemoryView:
        raise RuntimeError("search down")

    sa.registerMemoryProvider(bad_provider)
    snap2 = await sa.captureSnapshot(activeGoalIds=[goal.goalId])
    assert snap2.memory.relevantMemories == []


@pytest.mark.asyncio
async def test_cross_validation_endpoint(store_path):
    """Risk 1: TS→Python Decision 交叉验证 — 已裁决可查、未知 404。"""
    ga = GoalAuthority.getInstance()
    da = DecisionAuthority.getInstance()
    goal = ga.createGoal(description="xval", originalInput="xval")

    app = FastAPI()
    app.include_router(authority_router, prefix="/v1")

    with TestClient(app) as client:
        # 未裁决 → 404（拒绝伪造的 decisionId）
        r404 = client.get("/v1/authority/decisions/D_fake_123")
        assert r404.status_code == 404

        decision = await da.decide(
            DecisionContext(goalId=goal.goalId, snapshot=_snapshot("SS_XV"), candidates=_candidates())
        )

        r = client.get(f"/v1/authority/decisions/{decision.decisionId}")
        assert r.status_code == 200
        body = r.json()
        assert body["verified"] is True
        assert body["decision"]["goalId"] == goal.goalId

        rlist = client.get(f"/v1/authority/goals/{goal.goalId}/decisions")
        assert rlist.status_code == 200
        assert len(rlist.json()["decisions"]) == 1


@pytest.mark.asyncio
async def test_store_unavailable_degrades(store_path, tmp_path, monkeypatch):
    """存储不可用 → Authority 链照常工作，降级可观测（is_persistent=False）。"""
    # 把 store 指到一个文件内部（必然 mkdir/连接失败）
    blocker = tmp_path / "blocker"
    blocker.write_text("not a dir", encoding="utf-8")
    monkeypatch.setenv("AUTHORITY_STORE_PATH", str(blocker / "nested" / "authority.db"))
    MemoryAuthority.resetInstance()

    broken = MemoryAuthority()
    try:
        assert broken.is_persistent is False
        assert broken.load_beliefs() == {}
        assert broken.get_decision("D_any") is None
    finally:
        broken.close()

    # Authority 链在存储故障下仍完成裁决与证据记账
    ga = GoalAuthority.getInstance()
    da = DecisionAuthority.getInstance()

    goal = ga.createGoal(description="degraded", originalInput="degraded")
    decision = await da.decide(
        DecisionContext(goalId=goal.goalId, snapshot=_snapshot("SS_DG"), candidates=_candidates())
    )
    assert decision.chosenCandidateId == "C_bash"  # 裁决不受存储故障影响
    ga.updateFromEvidence(
        goalId=goal.goalId,
        decisionId=decision.decisionId,
        actionName="bash",
        expectedEffect="success",
        actualEffect="success",
        progressDelta=0.3,
    )
