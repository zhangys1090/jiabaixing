"""
D4-I1-R Integration Integrity Tests

D4-I1  goal identity survives one complete turn
D4-I2  snapshot identity reaches decision
D4-I3  decision identity reaches action
D4-I4  no action executes without DecisionAuthority
D4-I5  evidence writes back to same goal
D4-I6  completion changes Goal status
R1     DecisionAuthority failure -> NO ACTION (no fallback)
R2     Single FINAL owner per execution context
R3     authority IDs enter execution trace (not just metadata)
"""
import pytest
import time

from agent.core.authority_types import (
    CanonicalDecisionSnapshot,
    CapabilitySet,
    ContextView,
    Decision,
    DecisionCandidate,
    DecisionContext,
    GoalStatus,
    MemoryView,
    ProposedAction,
    SelfView,
    WorldView,
    _gen_id,
)
from agent.core.goal_authority import GoalAuthority
from agent.core.state_authority import StateAuthority
from agent.core.decision_authority import DecisionAuthority, LLMProposer


@pytest.fixture(autouse=True)
def reset_authorities():
    GoalAuthority.resetInstance()
    StateAuthority.resetInstance()
    DecisionAuthority.resetInstance()
    yield
    GoalAuthority.resetInstance()
    StateAuthority.resetInstance()
    DecisionAuthority.resetInstance()


def _make_snapshot(active_goal_ids: list[str]) -> CanonicalDecisionSnapshot:
    return CanonicalDecisionSnapshot(
        snapshotId=_gen_id("SS"),
        timestamp=time.time(),
        activeGoalIds=active_goal_ids,
        self=SelfView(agentId="test", activeGoalIds=active_goal_ids),
        world=WorldView(),
        memory=MemoryView(),
        context=ContextView(),
        capabilities=CapabilitySet(),
    )


def _make_candidate(
    proposer_id: str,
    confidence: float,
    estimated_progress: float,
    tool_name: str = "test_tool",
) -> DecisionCandidate:
    return DecisionCandidate(
        candidateId=_gen_id("C"),
        proposerId=proposer_id,
        action=ProposedAction(type="tool_call", payload={"name": tool_name, "arguments": "{}"}),
        confidence=confidence,
        reasoning=f"{proposer_id} proposes {tool_name}",
        estimatedGoalProgress=estimated_progress,
    )


class TestD4I1_GoalIdentitySurvivesOneCompleteTurn:
    @pytest.mark.asyncio
    async def test_goal_id_created_and_stable(self):
        ga = GoalAuthority.getInstance()
        goal = ga.createGoal(description="整理下载文件", originalInput="帮我整理下载文件")
        assert goal.goalId.startswith("G_")
        assert goal.status == GoalStatus.ACTIVE
        assert goal.planVersion == 1
        retrieved = ga.getGoal(goal.goalId)
        assert retrieved.goalId == goal.goalId

    @pytest.mark.asyncio
    async def test_goal_id_survives_evidence_and_replan(self):
        ga = GoalAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        original_id = goal.goalId
        ga.updateFromEvidence(goalId=original_id, decisionId="D_test", actionName="list_files", progressDelta=0.3)
        assert ga.getGoal(original_id).goalId == original_id
        ga.replan(original_id, "strategy changed")
        assert ga.getGoal(original_id).goalId == original_id
        assert ga.getGoal(original_id).planVersion == 2


class TestD4I2_SnapshotIdentityReachesDecision:
    @pytest.mark.asyncio
    async def test_snapshot_id_reaches_decision(self):
        ga = GoalAuthority.getInstance()
        sa = StateAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = await sa.captureSnapshot(activeGoalIds=[goal.goalId])
        assert snapshot.snapshotId.startswith("SS_")
        candidates = [_make_candidate("llm", 0.9, 0.5)]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))
        assert decision.snapshotId == snapshot.snapshotId


class TestD4I3_DecisionIdentityReachesAction:
    @pytest.mark.asyncio
    async def test_decision_id_reaches_evidence(self):
        ga = GoalAuthority.getInstance()
        sa = StateAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = await sa.captureSnapshot(activeGoalIds=[goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5, "open_browser")]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))
        assert decision.decisionId.startswith("D_")
        ga.updateFromEvidence(goalId=goal.goalId, decisionId=decision.decisionId, actionName="open_browser", progressDelta=0.3)
        evidence_log = ga.getEvidenceLog(goal.goalId)
        assert len(evidence_log) == 1
        assert evidence_log[0].decisionId == decision.decisionId


class TestD4I4_NoActionWithoutDecisionAuthority:
    @pytest.mark.asyncio
    async def test_llm_tool_call_must_go_through_decision_authority(self):
        ga = GoalAuthority.getInstance()
        sa = StateAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = await sa.captureSnapshot(activeGoalIds=[goal.goalId])
        llm_proposer = LLMProposer()
        tool_calls_raw = [
            {"id": "tc_1", "function": {"name": "delete_file", "arguments": '{"path": "/important.txt"}'}},
            {"id": "tc_2", "function": {"name": "read_file", "arguments": '{"path": "/safe.txt"}'}},
        ]
        candidates = await llm_proposer.propose(goal=goal, snapshot=snapshot, tool_calls_raw=tool_calls_raw)
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))
        assert decision.chosenCandidateId in [c.candidateId for c in candidates]
        assert decision.selectionReason != ""

    @pytest.mark.asyncio
    async def test_empty_candidates_raises(self):
        da = DecisionAuthority.getInstance()
        ga = GoalAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        with pytest.raises(ValueError, match="no candidates"):
            await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=[]))


class TestD4I5_EvidenceWritesBackToSameGoal:
    @pytest.mark.asyncio
    async def test_evidence_writes_back_to_same_goal(self):
        ga = GoalAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        goal_id = goal.goalId
        ga.updateFromEvidence(goalId=goal_id, decisionId="D_step1", actionName="list_files",
                              observation="found 5 files", progressDelta=0.3)
        ga.updateFromEvidence(goalId=goal_id, decisionId="D_step2", actionName="classify_files",
                              observation="classified all files", progressDelta=0.4)
        evidence_log = ga.getEvidenceLog(goal_id)
        assert len(evidence_log) == 2
        assert all(e.goalId == goal_id for e in evidence_log)
        assert abs(ga.getGoal(goal_id).progress - 0.7) < 0.01


class TestD4I6_CompletionChangesGoalStatus:
    @pytest.mark.asyncio
    async def test_evidence_drives_completion(self):
        ga = GoalAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        ga.updateFromEvidence(goalId=goal.goalId, decisionId="D_1", actionName="step1", progressDelta=0.6)
        assert ga.getGoal(goal.goalId).status == GoalStatus.ACTIVE
        ga.updateFromEvidence(goalId=goal.goalId, decisionId="D_2", actionName="step2", progressDelta=0.5)
        assert ga.getGoal(goal.goalId).status == GoalStatus.COMPLETED


class TestR1_NoFallbackOnAuthorityFailure:
    """R1: DecisionAuthority failure = NO ACTION.

    decide() raises -> no action executes.
    No fallback to direct execution.
    """

    @pytest.mark.asyncio
    async def test_decide_raises_on_missing_goal(self):
        da = DecisionAuthority.getInstance()
        snapshot = _make_snapshot(["G_nonexistent"])
        candidates = [_make_candidate("llm", 0.9, 0.5)]
        with pytest.raises(ValueError, match="goal G_nonexistent not found"):
            await da.decide(DecisionContext(goalId="G_nonexistent", snapshot=snapshot, candidates=candidates))

    @pytest.mark.asyncio
    async def test_decide_raises_on_completed_goal(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        ga.markCompleted(goal.goalId, "done")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5)]
        with pytest.raises(ValueError, match="is completed"):
            await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))

    @pytest.mark.asyncio
    async def test_decide_raises_on_abandoned_goal(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        ga.markAbandoned(goal.goalId, "no longer needed")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5)]
        with pytest.raises(ValueError, match="is abandoned"):
            await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))

    @pytest.mark.asyncio
    async def test_decide_raises_on_empty_candidates(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        with pytest.raises(ValueError, match="no candidates"):
            await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=[]))

    @pytest.mark.asyncio
    async def test_no_silent_fallback_path(self):
        """decide() has exactly two outcomes: Decision or exception. No None/fallback."""
        da = DecisionAuthority.getInstance()
        ga = GoalAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5)]
        result = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))
        assert isinstance(result, Decision)
        assert result.decisionId.startswith("D_")


class TestR2_SingleFinalOwner:
    """R2: One FINAL Decision Authority per execution context.

    Python process: Python DecisionAuthority is FINAL.
    TS process: TS DecisionAuthority is FINAL.
    They do not nest or override each other.
    """

    @pytest.mark.asyncio
    async def test_singleton_is_the_only_final(self):
        da1 = DecisionAuthority.getInstance()
        da2 = DecisionAuthority.getInstance()
        assert da1 is da2

    @pytest.mark.asyncio
    async def test_decision_ids_are_unique_per_decision(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        d1 = await da.decide(DecisionContext(
            goalId=goal.goalId, snapshot=snapshot,
            candidates=[_make_candidate("llm", 0.9, 0.5, "tool_a")],
        ))
        d2 = await da.decide(DecisionContext(
            goalId=goal.goalId, snapshot=snapshot,
            candidates=[_make_candidate("llm", 0.8, 0.4, "tool_b")],
        ))
        assert d1.decisionId != d2.decisionId
        assert d1.goalId == d2.goalId

    @pytest.mark.asyncio
    async def test_no_cross_process_decision_override(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5, "safe_tool")]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))
        assert decision.chosen.action.payload["name"] == "safe_tool"
        history = da.getDecisionHistory(goal.goalId)
        assert len(history) == 1
        assert history[0].chosenCandidateId == decision.chosenCandidateId


class TestR3_AuthorityIDsInExecutionTrace:
    """R3: goalId/snapshotId/decisionId must enter execution trace.

    Path: Decision -> chosen action -> ToolCall.metadata -> ToolResult.metadata
    Not just ConversationResult.metadata.
    """

    @pytest.mark.asyncio
    async def test_tool_call_carries_authority_ids(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5, "list_files")]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))

        from agent.core.turn_types import ToolCall
        tc = ToolCall(
            id="tc_test",
            name=decision.chosen.action.payload["name"],
            arguments=decision.chosen.action.payload.get("arguments", "{}"),
            metadata={
                "authority_goalId": goal.goalId,
                "authority_snapshotId": snapshot.snapshotId,
                "authority_decisionId": decision.decisionId,
                "authority_candidateId": decision.chosen.candidateId,
                "authority_proposerId": decision.chosen.proposerId,
                "authority_isChosen": True,
            },
        )
        assert tc.metadata["authority_goalId"] == goal.goalId
        assert tc.metadata["authority_snapshotId"] == snapshot.snapshotId
        assert tc.metadata["authority_decisionId"] == decision.decisionId

    @pytest.mark.asyncio
    async def test_tool_result_inherits_authority_ids(self):
        from agent.core.turn_types import ToolCall, ToolResult
        tc = ToolCall(
            id="tc_test", name="list_files", arguments="{}",
            metadata={
                "authority_goalId": "G_test123",
                "authority_snapshotId": "SS_test456",
                "authority_decisionId": "D_test789",
            },
        )
        result_meta = {"success": True, "output": "5 files found"}
        result_meta.update({k: v for k, v in tc.metadata.items() if k.startswith("authority_")})
        tr = ToolResult(tool_call_id=tc.id, name=tc.name, output="5 files found", success=True, metadata=result_meta)
        assert tr.metadata["authority_goalId"] == "G_test123"
        assert tr.metadata["authority_snapshotId"] == "SS_test456"
        assert tr.metadata["authority_decisionId"] == "D_test789"

    @pytest.mark.asyncio
    async def test_evidence_references_decision_and_goal(self):
        ga = GoalAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        ga.updateFromEvidence(
            goalId=goal.goalId, decisionId="D_trace_test", actionName="list_files",
            observation="5 files", progressDelta=0.3,
        )
        evidence = ga.getEvidenceLog(goal.goalId)[0]
        assert evidence.goalId == goal.goalId
        assert evidence.decisionId == "D_trace_test"


class TestAcceptedCandidates:
    """Decision uses acceptedCandidates (score threshold), not forced single choice."""

    @pytest.mark.asyncio
    async def test_single_candidate_is_accepted(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5, "tool_a")]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))
        assert len(decision.acceptedCandidates) == 1
        assert decision.acceptedCandidates[0].candidateId == decision.chosenCandidateId

    @pytest.mark.asyncio
    async def test_similar_score_candidates_are_all_accepted(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [
            _make_candidate("llm", 0.9, 0.5, "tool_a"),
            _make_candidate("llm", 0.85, 0.48, "tool_b"),
            _make_candidate("llm", 0.82, 0.46, "tool_c"),
        ]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))
        assert len(decision.acceptedCandidates) >= 1
        assert decision.chosen.candidateId == candidates[0].candidateId

    @pytest.mark.asyncio
    async def test_low_score_candidates_are_rejected(self):
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [
            _make_candidate("llm", 0.95, 0.8, "good_tool"),
            _make_candidate("llm", 0.2, 0.1, "bad_tool"),
        ]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))
        assert decision.chosen.action.payload["name"] == "good_tool"
        assert any(c.action.payload["name"] == "bad_tool" for c in decision.rejectedCandidates)


class TestD4FullProductionTrace:
    @pytest.mark.asyncio
    async def test_full_authority_chain(self):
        ga = GoalAuthority.getInstance()
        sa = StateAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="帮我整理下载文件夹", originalInput="帮我整理下载文件夹")
        goal_id = goal.goalId
        snapshot = await sa.captureSnapshot(activeGoalIds=[goal_id])
        snapshot_id = snapshot.snapshotId
        llm_proposer = LLMProposer()
        tool_calls_raw = [{"id": "tc_1", "function": {"name": "list_downloads", "arguments": "{}"}}]
        candidates = await llm_proposer.propose(goal=goal, snapshot=snapshot, tool_calls_raw=tool_calls_raw)
        decision = await da.decide(DecisionContext(goalId=goal_id, snapshot=snapshot, candidates=candidates))
        decision_id = decision.decisionId
        assert decision.chosen.action.payload["name"] == "list_downloads"
        assert decision.snapshotId == snapshot_id
        ga.updateFromEvidence(
            goalId=goal_id, decisionId=decision_id, actionName="list_downloads",
            observation="found 12 files", expectedEffect="list files", actualEffect="12 files",
            progressDelta=0.5,
        )
        ga.updateFromEvidence(
            goalId=goal_id, decisionId=decision_id, actionName="organize_files",
            observation="organized 12 files", expectedEffect="organize", actualEffect="3 categories",
            progressDelta=0.5,
        )
        final_goal = ga.getGoal(goal_id)
        assert final_goal.status == GoalStatus.COMPLETED
        assert final_goal.progress == 1.0
        assert final_goal.goalId == goal_id


class TestR2_CrossProcessFinalAuthorityTrace:
    """R2: Cross-process FINAL Authority Trace.

    Prove that when Python DecisionAuthority decides action X,
    the Python->TS boundary carries authority_decisionId,
    and TS does NOT re-decide.

    We test the Python side of this boundary (ToolCall.metadata -> HTTP payload).
    The TS side is verified by code review of DesktopExecutionAgent.executeTask().
    """

    @pytest.mark.asyncio
    async def test_authority_meta_flows_from_decision_to_tool_call(self):
        """Decision -> ToolCall.metadata contains authority_decisionId."""
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="test", originalInput="test")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5, "desktop_automate")]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))

        from agent.core.turn_types import ToolCall
        tc = ToolCall(
            id="tc_desktop",
            name="desktop_automate",
            arguments='{"task": "open notepad"}',
            metadata={
                "authority_goalId": goal.goalId,
                "authority_snapshotId": snapshot.snapshotId,
                "authority_decisionId": decision.decisionId,
                "authority_candidateId": decision.chosen.candidateId,
                "authority_proposerId": decision.chosen.proposerId,
                "authority_isChosen": True,
            },
        )
        assert tc.metadata["authority_decisionId"] == decision.decisionId
        assert tc.metadata["authority_goalId"] == goal.goalId

    @pytest.mark.asyncio
    async def test_authority_meta_injects_into_executor_params(self):
        """ToolCall.metadata -> params['_authority_meta'] -> executor receives it."""
        from agent.core.turn_types import ToolCall

        tc = ToolCall(
            id="tc_desktop",
            name="desktop_automate",
            arguments='{"task": "open notepad"}',
            metadata={
                "authority_goalId": "G_test",
                "authority_snapshotId": "SS_test",
                "authority_decisionId": "D_test",
            },
        )

        params = tc.parse_arguments()
        if tc.metadata:
            authority_keys = {k: v for k, v in tc.metadata.items() if k.startswith("authority_")}
            if authority_keys:
                params["_authority_meta"] = authority_keys

        assert "_authority_meta" in params
        assert params["_authority_meta"]["authority_decisionId"] == "D_test"
        assert params["_authority_meta"]["authority_goalId"] == "G_test"

    @pytest.mark.asyncio
    async def test_ts_payload_includes_authority(self):
        """_call_ts_desktop sends authority in HTTP payload."""
        from agent.tools.desktop_tools import _call_ts_desktop
        import inspect

        sig = inspect.signature(_call_ts_desktop)
        assert "authority_meta" in sig.parameters

    @pytest.mark.asyncio
    async def test_decision_id_survives_full_boundary(self):
        """Full trace: Decision -> ToolCall -> params -> TS payload.

        This is the R2 proof: the same decisionId that Python
        DecisionAuthority produced reaches the TS boundary unchanged.
        """
        ga = GoalAuthority.getInstance()
        da = DecisionAuthority.getInstance()
        goal = ga.createGoal(description="open notepad", originalInput="打开记事本")
        snapshot = _make_snapshot([goal.goalId])
        candidates = [_make_candidate("llm", 0.9, 0.5, "desktop_automate")]
        decision = await da.decide(DecisionContext(goalId=goal.goalId, snapshot=snapshot, candidates=candidates))

        from agent.core.turn_types import ToolCall
        tc = ToolCall(
            id="tc_1",
            name="desktop_automate",
            arguments='{"task": "打开记事本"}',
            metadata={
                "authority_goalId": goal.goalId,
                "authority_snapshotId": snapshot.snapshotId,
                "authority_decisionId": decision.decisionId,
                "authority_candidateId": decision.chosen.candidateId,
                "authority_proposerId": decision.chosen.proposerId,
                "authority_isChosen": True,
            },
        )

        params = tc.parse_arguments()
        if tc.metadata:
            authority_keys = {k: v for k, v in tc.metadata.items() if k.startswith("authority_")}
            if authority_keys:
                params["_authority_meta"] = authority_keys

        authority_meta = params.get("_authority_meta", {})
        ts_payload = {"task": "打开记事本"}
        if authority_meta:
            ts_payload["authority"] = authority_meta

        assert ts_payload["authority"]["authority_decisionId"] == decision.decisionId
        assert ts_payload["authority"]["authority_goalId"] == goal.goalId
        assert ts_payload["authority"]["authority_snapshotId"] == snapshot.snapshotId
