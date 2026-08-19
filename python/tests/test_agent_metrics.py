"""测试 AgentMetricsDashboard Agent级指标仪表盘。"""

from __future__ import annotations

from agent.core.agent_metrics import AgentMetrics, AgentMetricsDashboard, DashboardSummary


def test_record_single_agent():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=True, duration_ms=100, tokens=500)

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.agent_name == "agent_1"
    assert stats.total_requests == 1
    assert stats.success_count == 1
    assert stats.failure_count == 0


def test_record_multiple_requests():
    dashboard = AgentMetricsDashboard()
    for i in range(10):
        success = i % 3 != 0
        dashboard.record("agent_1", "coding", success=success, duration_ms=100 + i)

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.total_requests == 10
    # range(10) 中 i%3!=0 的取值为 1,2,4,5,7,8（共 6），其余 0,3,6,9 为失败（共 4）
    assert stats.success_count == 6
    assert stats.failure_count == 4


def test_success_rate():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=True)
    dashboard.record("agent_1", "coding", success=False)
    dashboard.record("agent_1", "coding", success=True)

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.success_rate == 2 / 3


def test_multiple_agents():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=True)
    dashboard.record("agent_2", "search", success=True)
    dashboard.record("agent_3", "analysis", success=False)

    all_agents = dashboard.get_all_agents()
    assert len(all_agents) == 3


def test_scene_stats():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=True, duration_ms=100)
    dashboard.record("agent_2", "coding", success=True, duration_ms=200)
    dashboard.record("agent_3", "search", success=False, duration_ms=300)

    coding_stats = dashboard.get_scene_stats("coding")
    assert coding_stats is not None
    assert coding_stats.total_requests == 2
    assert coding_stats.success_count == 2

    search_stats = dashboard.get_scene_stats("search")
    assert search_stats is not None
    assert search_stats.total_requests == 1
    assert search_stats.failure_count == 1


def test_error_distribution():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=False, error="timeout")
    dashboard.record("agent_1", "coding", success=False, error="timeout")
    dashboard.record("agent_1", "coding", success=False, error="auth_error")

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.error_distribution == {"timeout": 2, "auth_error": 1}


def test_latency():
    dashboard = AgentMetricsDashboard()
    for i in range(100):
        dashboard.record("agent_1", "coding", success=True, duration_ms=float(i + 1))

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.p50_latency > 0
    assert stats.p95_latency > 0
    assert stats.p99_latency > 0
    assert stats.p99_latency >= stats.p95_latency >= stats.p50_latency


def test_avg_latency():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", duration_ms=100)
    dashboard.record("agent_1", "coding", duration_ms=200)
    dashboard.record("agent_1", "coding", duration_ms=300)

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.avg_latency == 200.0


def test_tool_stats():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", tool_calls=5, tool_success=4)
    dashboard.record("agent_1", "coding", tool_calls=3, tool_success=3)

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.total_tool_calls == 8
    assert stats.total_tool_success == 7
    assert stats.tool_success_rate == 7 / 8


def test_token_usage():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", tokens=1000)
    dashboard.record("agent_1", "coding", tokens=2000)

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is not None
    assert stats.total_tokens == 3000
    assert stats.avg_tokens_per_request == 1500.0


def test_summary():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=True)
    dashboard.record("agent_2", "search", success=False)
    dashboard.record("agent_3", "analysis", success=True)

    summary = dashboard.get_summary()
    assert isinstance(summary, DashboardSummary)
    assert summary.total_agents == 3
    assert summary.total_requests == 3
    assert summary.overall_success_rate == 2 / 3


def test_summary_error_summary():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=False, error="timeout")
    dashboard.record("agent_2", "search", success=False, error="timeout")
    dashboard.record("agent_2", "search", success=False, error="auth_error")

    summary = dashboard.get_summary()
    assert summary.error_summary == {"timeout": 2, "auth_error": 1}


def test_top_failing_agents():
    dashboard = AgentMetricsDashboard()
    dashboard.record("good_agent", "coding", success=True)
    dashboard.record("good_agent", "coding", success=True)
    dashboard.record("bad_agent", "coding", success=False)
    dashboard.record("bad_agent", "coding", success=False)

    top = dashboard.get_top_failing_agents(limit=2)
    assert len(top) >= 2
    assert top[0].agent_name == "bad_agent"


def test_top_latency_agents():
    dashboard = AgentMetricsDashboard()
    dashboard.record("slow", "coding", duration_ms=5000)
    dashboard.record("fast", "coding", duration_ms=100)

    top = dashboard.get_top_latency_agents(limit=2)
    assert len(top) >= 2
    assert top[0].agent_name == "slow"


def test_top_error_types():
    dashboard = AgentMetricsDashboard()
    dashboard.record("a", "coding", success=False, error="timeout")
    dashboard.record("a", "coding", success=False, error="timeout")
    dashboard.record("b", "coding", success=False, error="timeout")
    dashboard.record("b", "coding", success=False, error="auth_error")

    top = dashboard.get_top_error_types(limit=2)
    assert len(top) >= 2
    assert top[0] == ("timeout", 3)


def test_recent_requests():
    dashboard = AgentMetricsDashboard()
    for i in range(10):
        dashboard.record(f"agent_{i % 2}", "coding")

    recent = dashboard.get_recent_requests(limit=3)
    assert len(recent) == 3


def test_recent_requests_by_agent():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding")
    dashboard.record("agent_2", "coding")
    dashboard.record("agent_1", "coding")

    recent = dashboard.get_recent_requests(agent_name="agent_1", limit=10)
    assert len(recent) == 2


def test_unknown_agent():
    dashboard = AgentMetricsDashboard()
    stats = dashboard.get_agent_stats("nonexistent")
    assert stats is None


def test_reset():
    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=True)
    dashboard.reset()

    stats = dashboard.get_agent_stats("agent_1")
    assert stats is None


def test_metrics_dataclass_defaults():
    metrics = AgentMetrics(agent_name="test")
    assert metrics.success_rate == 1.0
    assert metrics.avg_latency == 0.0
    assert metrics.avg_tokens_per_request == 0.0
    assert metrics.tool_success_rate == 1.0
    assert metrics.uptime_seconds == 0.0


def test_metrics_uptime():
    metrics = AgentMetrics(agent_name="test", first_request_at=1000, last_request_at=2000)
    assert metrics.uptime_seconds == 1000.0


def test_metrics_success_rate_zero_requests():
    metrics = AgentMetrics(agent_name="test", total_requests=0)
    assert metrics.success_rate == 1.0


def test_metrics_tool_success_rate_zero_calls():
    metrics = AgentMetrics(agent_name="test", total_tool_calls=0)
    assert metrics.tool_success_rate == 1.0
