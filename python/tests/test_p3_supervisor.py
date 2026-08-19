"""测试 P3Supervisor 统一监管器。"""

from __future__ import annotations

from agent.evolution.feedback_loop import EvolutionSuggestion
from agent.p3_supervisor import P3HealthStatus, P3InteractionContext, P3Supervisor
from agent.security.audit_reporter import AuditDimension, Severity


class FakeEngine:
    def __init__(self):
        self._tool_weights = {"tool_a": 0.8}
        self._correction_rules = []
        self._knowledge_nudges = []
        self._skills = {}
        self._save_state_called = False

    def _save_state(self):
        self._save_state_called = True


def test_supervisor_creation():
    supervisor = P3Supervisor()
    health = supervisor.get_health_status()
    assert isinstance(health, P3HealthStatus)
    assert health.healthy is True


def test_pre_interaction():
    supervisor = P3Supervisor()
    ctx = supervisor.pre_interaction_sync("agent_1", "coding")

    assert isinstance(ctx, P3InteractionContext)
    assert ctx.agent_name == "agent_1"
    assert ctx.scene == "coding"
    assert ctx.pre_check_passed is True


def test_post_interaction_success():
    supervisor = P3Supervisor()
    suggestions = supervisor.post_interaction_sync(
        agent_name="agent_1",
        scene="coding",
        success=True,
        duration_ms=100,
        tokens=500,
        tool_calls=3,
        tool_success=3,
    )

    assert isinstance(suggestions, list)
    stats = supervisor.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.total_requests == 1
    assert stats.success_count == 1


def test_post_interaction_failure():
    supervisor = P3Supervisor()
    supervisor.post_interaction_sync(
        agent_name="agent_2",
        scene="search",
        success=False,
        error="timeout",
        tool_name="search_tool",
    )

    stats = supervisor.get_agent_stats("agent_2")
    assert stats is not None
    assert stats.failure_count == 1
    assert stats.error_distribution == {"timeout": 1}


def test_post_interaction_collects_feedback():
    supervisor = P3Supervisor()
    supervisor.post_interaction_sync(
        agent_name="agent_1",
        scene="coding",
        success=True,
        tool_name="tool_a",
    )

    feedback_stats = supervisor.get_feedback_stats()
    assert feedback_stats.total_signals == 1


def test_multiple_interactions():
    supervisor = P3Supervisor()
    for i in range(10):
        success = i % 3 != 0
        supervisor.post_interaction_sync(
            agent_name="agent_1",
            scene="coding",
            success=success,
            duration_ms=100 + i,
            tokens=200 + i,
            tool_calls=2,
            tool_success=1 if success else 0,
        )

    stats = supervisor.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.total_requests == 10


def test_health_status_all_healthy():
    supervisor = P3Supervisor()
    health = supervisor.get_health_status()

    assert health.healthy is True
    assert health.observability_ok is True
    assert health.security_ok is True
    assert health.evolution_ok is True
    assert len(health.warnings) == 0


def test_health_status_with_low_success_rate():
    supervisor = P3Supervisor()
    for i in range(10):
        supervisor.post_interaction_sync(
            agent_name="agent_1",
            scene="coding",
            success=False,
            error="failure",
        )

    health = supervisor.get_health_status()
    assert health.observability_ok is False


def test_run_security_audit():
    supervisor = P3Supervisor()
    report = supervisor.run_security_audit(
        dimensions=[AuditDimension.CONFIG, AuditDimension.NETWORK],
        env_vars={"PATH": "/usr/bin"},
        config_values={"ssl_verify": True},
    )

    assert report is not None
    assert report.severity == Severity.LOW


def test_run_security_audit_finds_issues():
    supervisor = P3Supervisor()
    report = supervisor.run_security_audit(
        dimensions=[AuditDimension.NETWORK],
        config_values={"ssl_verify": False, "network_enabled": True},
    )

    assert report.severity == Severity.HIGH


def test_register_engines():
    engine = FakeEngine()
    supervisor = P3Supervisor()
    supervisor.register_engines(evolution_engine=engine)

    suggestions = supervisor.post_interaction_sync(
        agent_name="agent_1",
        scene="coding",
        success=False,
        tool_name="tool_a",
    )

    assert isinstance(suggestions, list)


def test_record_user_correction():
    supervisor = P3Supervisor()
    supervisor.record_user_correction("agent_1", "coding", "wrong answer")

    stats = supervisor.get_feedback_stats()
    assert stats.total_signals == 1


def test_record_user_satisfaction():
    supervisor = P3Supervisor()
    supervisor.record_user_satisfaction("agent_1", "coding", True, "great")

    stats = supervisor.get_feedback_stats()
    assert stats.total_signals == 1


def test_record_user_dissatisfaction():
    supervisor = P3Supervisor()
    supervisor.record_user_satisfaction("agent_1", "coding", False, "bad")

    stats = supervisor.get_feedback_stats()
    assert stats.total_signals == 1


def test_get_dashboard_summary():
    supervisor = P3Supervisor()
    supervisor.post_interaction_sync("agent_1", "coding", success=True)
    supervisor.post_interaction_sync("agent_2", "search", success=False)

    summary = supervisor.get_dashboard_summary()
    assert summary.total_agents == 2
    assert summary.total_requests == 2


def test_get_agent_stats_unknown():
    supervisor = P3Supervisor()
    stats = supervisor.get_agent_stats("nonexistent")
    assert stats is None


def test_reset():
    supervisor = P3Supervisor()
    supervisor.post_interaction_sync("agent_1", "coding", success=True)
    supervisor.reset()

    stats = supervisor.get_agent_stats("agent_1")
    assert stats is None
    feedback_stats = supervisor.get_feedback_stats()
    assert feedback_stats.total_signals == 0


def test_pre_interaction_with_high_severity_audit():
    supervisor = P3Supervisor()

    supervisor.run_security_audit(
        dimensions=[AuditDimension.NETWORK],
        config_values={"ssl_verify": False, "network_enabled": True},
    )

    ctx = supervisor.pre_interaction_sync(
        "agent_1",
        "coding",
        config_values={"ssl_verify": False, "network_enabled": True},
    )

    assert ctx.pre_check_passed is False


def test_health_status_with_security_issues():
    supervisor = P3Supervisor()
    supervisor.run_security_audit(
        dimensions=[AuditDimension.NETWORK],
        config_values={"ssl_verify": False, "network_enabled": True},
    )

    health = supervisor.get_health_status()
    assert health.security_ok is False


def test_consecutive_failures_generate_suggestions():
    engine = FakeEngine()
    supervisor = P3Supervisor()
    supervisor.register_engines(evolution_engine=engine)

    for i in range(5):
        supervisor.post_interaction_sync(
            agent_name="agent_1",
            scene="coding",
            success=False,
            tool_name="tool_a",
            error="error",
        )

    feedback_stats = supervisor.get_feedback_stats()
    assert feedback_stats.total_signals == 5
