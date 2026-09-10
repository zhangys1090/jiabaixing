"""jiabaixing Harness v3 模块测试套件.

覆盖:
- ApprovalManager: 三级审批策略 + 风险等级
- SandboxGuard: 沙箱隔离 + 文件变更回滚
- ThreeAxisScorer: 三维评分 (Outcome/Compliance/Process)
- PluginRegistry: 插件注册/激活/热插拔/依赖管理
- TraceLog: 执行轨迹日志 + 唯一真相源
- ContextWindowManager: 上下文窗口截断 + Token预算
- AgentEvalSystem v3: 集成验证
"""
from __future__ import annotations

import pytest

from agent.harness.approval import ApprovalManager, ApprovalPolicy, ApprovalDecision, RiskTier, ToolRiskProfile
from agent.harness.sandbox import SandboxGuard, SandboxPolicy, SandboxConfig, SandboxSession
from agent.harness.three_axis import ThreeAxisScorer, ThreeAxisScore, OutcomeVerifier, ComplianceVerifier, ProcessVerifier
from agent.harness.plugin_registry import PluginRegistry, PluginSpec, PluginCategory, PluginState
from agent.harness.context_window import ContextWindowManager, TokenBudget, TruncationPolicy, ContextEntry, TruncationResult
from agent.harness.trace_log import TraceLog, TraceEntry, TraceEventType


class TestApprovalManager:
    def test_suggest_policy_blocks_all(self):
        mgr = ApprovalManager(ApprovalPolicy.SUGGEST)
        for tool in ["memory_search", "file_write", "shell_exec", "web_fetch"]:
            d = mgr.check(tool)
            assert not d.approved, f"suggest should block {tool}"

    def test_auto_edit_readonly_auto(self):
        mgr = ApprovalManager(ApprovalPolicy.AUTO_EDIT)
        d = mgr.check("memory_search")
        assert d.approved
        assert not d.needs_confirmation

    def test_auto_edit_high_needs_confirm(self):
        mgr = ApprovalManager(ApprovalPolicy.AUTO_EDIT)
        d = mgr.check("file_write")
        assert d.approved
        assert d.needs_confirmation

    def test_auto_edit_critical_needs_confirm(self):
        mgr = ApprovalManager(ApprovalPolicy.AUTO_EDIT)
        d = mgr.check("shell_exec")
        assert d.approved
        assert d.needs_confirmation

    def test_full_auto_all_approved(self):
        mgr = ApprovalManager(ApprovalPolicy.FULL_AUTO)
        for tool in ["memory_search", "file_write", "shell_exec", "web_fetch"]:
            d = mgr.check(tool)
            assert d.approved, f"full-auto should approve {tool}"

    def test_full_auto_critical_still_needs_confirm(self):
        mgr = ApprovalManager(ApprovalPolicy.FULL_AUTO)
        d = mgr.check("shell_exec")
        assert d.needs_confirmation

    def test_session_policy_override(self):
        mgr = ApprovalManager(ApprovalPolicy.SUGGEST)
        mgr.set_session_policy("session1", ApprovalPolicy.FULL_AUTO)
        d = mgr.check("file_write", session_id="session1")
        assert d.approved

    def test_unknown_tool_medium_risk(self):
        mgr = ApprovalManager(ApprovalPolicy.AUTO_EDIT)
        d = mgr.check("unknown_tool_xyz")
        assert d.approved
        assert d.risk_tier == RiskTier.MEDIUM

    def test_decision_fields(self):
        mgr = ApprovalManager(ApprovalPolicy.AUTO_EDIT)
        d = mgr.check("file_write")
        assert isinstance(d, ApprovalDecision)
        assert d.tool_name == "file_write"
        assert d.policy == ApprovalPolicy.AUTO_EDIT
        assert d.reason != ""


class TestSandboxGuard:
    def test_eval_policy_blocks_file_and_shell(self):
        guard = SandboxGuard()
        guard.create_session("s1", SandboxPolicy.EVAL)
        ok_file, _ = guard.check_operation("s1", "file_write")
        ok_shell, _ = guard.check_operation("s1", "shell")
        ok_net, _ = guard.check_operation("s1", "network")
        assert not ok_file
        assert not ok_shell
        assert ok_net
        guard.destroy_session("s1")

    def test_tool_policy_allows_file(self):
        guard = SandboxGuard()
        guard.create_session("s2", SandboxPolicy.TOOL)
        ok_file, _ = guard.check_operation("s2", "file_write")
        ok_shell, _ = guard.check_operation("s2", "shell")
        assert ok_file
        assert not ok_shell
        guard.destroy_session("s2")

    def test_strict_policy_blocks_all(self):
        guard = SandboxGuard()
        guard.create_session("s3", SandboxPolicy.STRICT)
        for op in ["file_write", "shell", "network"]:
            ok, _ = guard.check_operation("s3", op)
            assert not ok, f"strict should block {op}"
        guard.destroy_session("s3")

    def test_none_policy_allows_all(self):
        guard = SandboxGuard()
        guard.create_session("s4", SandboxPolicy.NONE)
        for op in ["file_write", "shell", "network"]:
            ok, _ = guard.check_operation("s4", op)
            assert ok, f"none policy should allow {op}"
        guard.destroy_session("s4")

    def test_file_change_tracking_and_rollback(self):
        guard = SandboxGuard()
        guard.create_session("s5", SandboxPolicy.TOOL)
        guard.record_file_change("s5", "/tmp/a.txt", "write", "", "content_a")
        guard.record_file_change("s5", "/tmp/b.txt", "write", "", "content_b")
        rolled = guard.rollback_session("s5")
        assert len(rolled) == 2
        guard.destroy_session("s5")

    def test_unknown_session_denied(self):
        guard = SandboxGuard()
        ok, reason = guard.check_operation("nonexistent", "file_write")
        assert not ok


class TestThreeAxisScorer:
    def test_perfect_response(self):
        scorer = ThreeAxisScorer()
        score, detail = scorer.score(
            output="北京今天晴，25度",
            golden_output="北京今天晴，25度",
            tool_calls=[{"name": "web_search"}],
            expected_tools=["web_search"],
        )
        assert score.outcome == 1.0
        assert score.compliance >= 0.9
        assert score.process >= 0.9

    def test_empty_output(self):
        scorer = ThreeAxisScorer()
        score, _ = scorer.score(output="", golden_output="expected")
        assert score.outcome == 0.0

    def test_safety_violation(self):
        scorer = ThreeAxisScorer()
        score, detail = scorer.score(
            output="您的银行卡号6222021234567890123已记录",
        )
        assert score.compliance < 1.0

    def test_weighted_formula(self):
        score = ThreeAxisScore(outcome=1.0, compliance=1.0, process=1.0)
        assert score.weighted == pytest.approx(1.0, abs=0.01)

    def test_weighted_partial(self):
        score = ThreeAxisScore(outcome=0.5, compliance=0.8, process=0.6)
        expected = 0.5 * 0.4 + 0.8 * 0.35 + 0.6 * 0.25
        assert score.weighted == pytest.approx(expected, abs=0.01)

    def test_tool_redundancy_penalty(self):
        scorer = ThreeAxisScorer()
        score, _ = scorer.score(
            output="已搜索",
            tool_calls=[{"name": "web_search"}, {"name": "web_search"}, {"name": "web_search"}],
            expected_tools=["web_search"],
        )
        assert score.process < 1.0

    def test_missing_tool_penalty(self):
        scorer = ThreeAxisScorer()
        score, _ = scorer.score(
            output="结果",
            tool_calls=[],
            expected_tools=["web_search"],
        )
        assert score.process < 1.0

    def test_score_range(self):
        scorer = ThreeAxisScorer()
        score, _ = scorer.score(output="test")
        assert 0.0 <= score.outcome <= 1.0
        assert 0.0 <= score.compliance <= 1.0
        assert 0.0 <= score.process <= 1.0
        assert 0.0 <= score.weighted <= 1.0

    def test_verifiers_independent(self):
        ov = OutcomeVerifier()
        cv = ComplianceVerifier()
        pv = ProcessVerifier()
        o_score, _ = ov.verify("test", "", [])
        c_score, _ = cv.verify("test")
        p_score, _ = pv.verify([])
        assert 0.0 <= o_score <= 1.0
        assert 0.0 <= c_score <= 1.0
        assert 0.0 <= p_score <= 1.0


class TestPluginRegistry:
    def test_register_and_activate(self):
        reg = PluginRegistry()
        reg.register(PluginSpec(name="p1", category=PluginCategory.SCORER, version="1.0.0", description="test"))
        reg.activate("p1")
        plugins = reg.list_plugins()
        assert any(p["name"] == "p1" and p["state"] == "active" for p in plugins)

    def test_activate_nonexistent_returns_false(self):
        reg = PluginRegistry()
        result = reg.activate("nonexistent")
        assert not result

    def test_deactivate(self):
        reg = PluginRegistry()
        reg.register(PluginSpec(name="p2", category=PluginCategory.SCORER, version="1.0.0", description="test"))
        reg.activate("p2")
        reg.deactivate("p2")
        plugins = reg.list_plugins()
        p2 = next(p for p in plugins if p["name"] == "p2")
        assert p2["state"] == "inactive"

    def test_dependency_enforcement(self):
        reg = PluginRegistry()
        reg.register(PluginSpec(name="base", category=PluginCategory.SCORER, version="1.0.0", description="base"))
        reg.register(PluginSpec(name="dep", category=PluginCategory.VERIFIER, version="1.0.0", description="dep", dependencies=["base"]))
        reg.activate("base")
        reg.activate("dep")
        result = reg.deactivate("base")
        assert not result

    def test_hot_swap(self):
        reg = PluginRegistry()
        reg.register(PluginSpec(name="hs", category=PluginCategory.SCORER, version="1.0.0", description="v1"))
        reg.activate("hs")
        reg.hot_swap("hs", PluginSpec(name="hs", category=PluginCategory.SCORER, version="2.0.0", description="v2"))
        spec = reg.get_spec("hs")
        assert spec.version == "2.0.0"
        plugins = reg.list_plugins()
        hs = next(p for p in plugins if p["name"] == "hs")
        assert hs["state"] == "active"

    def test_unregister(self):
        reg = PluginRegistry()
        reg.register(PluginSpec(name="rm", category=PluginCategory.SCORER, version="1.0.0", description="rm"))
        result = reg.unregister("rm")
        assert result
        spec = reg.get_spec("rm")
        assert spec is None

    def test_list_by_category(self):
        reg = PluginRegistry()
        reg.register(PluginSpec(name="s1", category=PluginCategory.SCORER, version="1.0.0", description="s"))
        reg.register(PluginSpec(name="v1", category=PluginCategory.VERIFIER, version="1.0.0", description="v"))
        scorers = reg.list_plugins(category=PluginCategory.SCORER)
        assert len(scorers) == 1
        assert scorers[0]["name"] == "s1"


class TestTraceLog:
    def test_record_and_query(self):
        log = TraceLog()
        log.record("t1", "s1", TraceEventType.SESSION_START, {"user": "test"})
        log.record("t1", "s1", TraceEventType.USER_INPUT, {"message": "hello"})
        log.record("t1", "s1", TraceEventType.LLM_RESPONSE, {"content": "hi"})
        log.record("t1", "s1", TraceEventType.SESSION_END, {})
        stats = log.stats()
        assert stats["total_entries"] == 4
        assert stats["total_sessions"] == 1

    def test_tool_call_trace(self):
        log = TraceLog()
        log.record("t1", "s1", TraceEventType.TOOL_CALL, {"tool_name": "web_search", "arguments": {"q": "test"}}, duration_ms=100)
        trace = log.get_tool_call_trace("s1")
        assert len(trace) == 1
        assert trace[0]["tool_name"] == "web_search"

    def test_score_trace(self):
        log = TraceLog()
        log.record("t1", "s1", TraceEventType.SCORE, {"scores": {"outcome": 0.9, "compliance": 1.0}})
        trace = log.get_score_trace("s1")
        assert len(trace) == 1
        assert trace[0]["scores"]["outcome"] == 0.9

    def test_multi_session(self):
        log = TraceLog()
        log.record("t1", "s1", TraceEventType.SESSION_START, {})
        log.record("t2", "s2", TraceEventType.SESSION_START, {})
        stats = log.stats()
        assert stats["total_sessions"] == 2

    def test_empty_session_trace(self):
        log = TraceLog()
        assert log.get_tool_call_trace("nonexistent") == []
        assert log.get_score_trace("nonexistent") == []


class TestContextWindowManager:
    def test_truncate_within_budget(self):
        mgr = ContextWindowManager(budget=TokenBudget(total=10000))
        entries = [
            ContextEntry(role="user", content="hello", token_count=10, turn_index=0),
            ContextEntry(role="assistant", content="hi", token_count=10, turn_index=1),
        ]
        result = mgr.truncate(entries)
        assert result.truncated_count == 2
        assert result.tokens_after <= 10000

    def test_truncate_exceeds_budget(self):
        mgr = ContextWindowManager(budget=TokenBudget(total=100))
        entries = []
        for i in range(20):
            entries.append(ContextEntry(role="user", content=f"msg{i}", token_count=20, turn_index=i))
        result = mgr.truncate(entries)
        assert result.truncated_count < 20
        assert result.compression_ratio < 1.0

    def test_system_prompt_preserved(self):
        mgr = ContextWindowManager(budget=TokenBudget(total=100))
        entries = [
            ContextEntry(role="system", content="system prompt", token_count=20, turn_index=0, is_system=True),
        ]
        for i in range(1, 20):
            entries.append(ContextEntry(role="user", content=f"msg{i}", token_count=20, turn_index=i))
        result = mgr.truncate(entries)
        first = result.entries[0] if result.entries else None
        if first:
            assert first.is_system

    def test_empty_entries(self):
        mgr = ContextWindowManager()
        result = mgr.truncate([])
        assert result.truncated_count == 0
        assert result.tokens_after == 0

    def test_truncation_result_fields(self):
        mgr = ContextWindowManager(budget=TokenBudget(total=10000))
        entries = [ContextEntry(role="user", content="test", token_count=5, turn_index=0)]
        result = mgr.truncate(entries)
        assert hasattr(result, "original_count")
        assert hasattr(result, "truncated_count")
        assert hasattr(result, "tokens_before")
        assert hasattr(result, "tokens_after")
        assert hasattr(result, "compression_ratio")
        assert hasattr(result, "strategy_used")


class TestHarnessIntegration:
    def test_eval_system_instantiation(self):
        from agent.evaluation.agent_eval_system import AgentEvalSystem
        system = AgentEvalSystem(
            pass_k=1,
            enable_regression=False,
            approval_policy="auto-edit",
            sandbox_policy="eval",
        )
        assert system.approval.default_policy == ApprovalPolicy.AUTO_EDIT
        assert isinstance(system.three_axis_scorer, ThreeAxisScorer)
        assert isinstance(system.sandbox, SandboxGuard)
        assert isinstance(system.trace_log, TraceLog)
        assert isinstance(system.plugin_registry, PluginRegistry)

    def test_eval_system_plugins_registered(self):
        from agent.evaluation.agent_eval_system import AgentEvalSystem
        system = AgentEvalSystem(pass_k=1, enable_regression=False)
        plugins = system.plugin_registry.list_plugins()
        plugin_names = {p["name"] for p in plugins}
        assert "three_axis_scorer" in plugin_names
        assert "multi_scorer" in plugin_names
        assert "assertion_validator" in plugin_names

    def test_harness_module_all_exports(self):
        import agent.harness as h
        assert len(h.__all__) >= 20
        assert "ApprovalManager" in h.__all__
        assert "ThreeAxisScorer" in h.__all__
        assert "PluginRegistry" in h.__all__
        assert "TraceLog" in h.__all__
        assert "ContextWindowManager" in h.__all__

    def test_approval_sandbox_together(self):
        mgr = ApprovalManager(ApprovalPolicy.AUTO_EDIT)
        guard = SandboxGuard()
        guard.create_session("int_test", SandboxPolicy.EVAL)
        d = mgr.check("file_write")
        ok, _ = guard.check_operation("int_test", "file_write")
        assert d.approved and d.needs_confirmation
        assert not ok
        guard.destroy_session("int_test")

    def test_trace_log_with_scorer(self):
        log = TraceLog()
        scorer = ThreeAxisScorer()
        score, _ = scorer.score(output="test response", golden_output="test response")
        log.record("t1", "s1", TraceEventType.SCORE, {
            "scores": {"outcome": score.outcome, "compliance": score.compliance, "process": score.process},
        })
        trace = log.get_score_trace("s1")
        assert len(trace) == 1
        assert trace[0]["scores"]["outcome"] == 1.0


class TestEnhancements:
    def test_three_axis_category_weights(self):
        scorer = ThreeAxisScorer()
        score_safety, _ = scorer.score(
            output="安全提示", golden_output="安全提示",
            case_category="safety",
        )
        score_memory, _ = scorer.score(
            output="记忆结果", golden_output="记忆结果",
            case_category="memory",
        )
        assert score_safety._weights == (0.20, 0.50, 0.30)
        assert score_memory._weights == (0.45, 0.25, 0.30)
        assert score_safety.weighted != score_memory.weighted or score_safety.outcome == score_memory.outcome

    def test_three_axis_default_weights(self):
        scorer = ThreeAxisScorer()
        score, _ = scorer.score(output="test", golden_output="test", case_category="unknown_cat")
        assert score._weights == (0.40, 0.35, 0.25)

    def test_approval_async_adapter(self):
        import asyncio
        mgr = ApprovalManager(ApprovalPolicy.AUTO_EDIT)
        d = asyncio.get_event_loop().run_until_complete(
            mgr.request_approval("file_write", risk_level="high")
        )
        assert d.approved
        assert d.needs_confirmation
        assert d.tool_name == "file_write"

    def test_approval_async_adapter_full_auto(self):
        import asyncio
        mgr = ApprovalManager(ApprovalPolicy.FULL_AUTO)
        d = asyncio.get_event_loop().run_until_complete(
            mgr.request_approval("memory_search", risk_level="read-only")
        )
        assert d.approved
        assert not d.needs_confirmation

    def test_context_window_from_messages(self):
        mgr = ContextWindowManager(budget=TokenBudget(total=10000))
        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        entries = mgr.from_messages(messages)
        assert len(entries) == 3
        assert entries[0].is_system
        assert not entries[1].is_system

    def test_context_window_truncate_long_conversation(self):
        mgr = ContextWindowManager(budget=TokenBudget(total=200))
        messages = []
        for i in range(30):
            messages.append({"role": "user", "content": f"Message {i} with some content"})
            messages.append({"role": "assistant", "content": f"Response {i} with some content"})
        entries = mgr.from_messages(messages)
        result = mgr.truncate(entries)
        assert result.truncated_count < len(entries)
        assert result.compression_ratio < 1.0

    def test_regression_guard_category_thresholds(self):
        from agent.evaluation.agent_eval_system import RegressionGuard
        guard = RegressionGuard()
        assert "safety" in guard.category_thresholds
        assert guard.category_thresholds["safety"]["safety"] == -2.0
        assert "memory" in guard.category_thresholds
        assert guard.category_thresholds["memory"]["accuracy"] == -8.0

    def test_eval_system_trace_log_persist_dir(self):
        from agent.evaluation.agent_eval_system import AgentEvalSystem
        system = AgentEvalSystem(pass_k=1, enable_regression=False)
        assert system.trace_log._persist_dir is not None

    def test_harness_approval_adapter_interface(self):
        mgr = ApprovalManager(ApprovalPolicy.SUGGEST)
        assert hasattr(mgr, "request_approval")
        assert hasattr(mgr, "check")
        assert hasattr(mgr, "get_session_policy")
        assert hasattr(mgr, "set_session_policy")
