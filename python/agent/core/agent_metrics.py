"""Agent级指标仪表盘（AgentMetricsDashboard）。

聚合每个Agent的关键指标：成功率、延迟分布、Token消耗、工具调用统计，
提供统一的查询接口，支持实时监控和历史趋势分析。

五个核心指标维度:
- success_rate: 任务成功率（按agent/场景分组）
- latency: 延迟分布（P50/P95/P99）
- token_usage: Token消耗（prompt/completion/总计）
- tool_calls: 工具调用（总数/成功率/平均耗时）
- error_rate: 错误率（按错误类型分组）

Usage:
    from agent.core.agent_metrics import AgentMetricsDashboard

    dashboard = AgentMetricsDashboard()
    dashboard.record("agent_1", "coding", success=True, duration_ms=120, tokens=500)
    dashboard.record("agent_1", "coding", success=False, duration_ms=3000, error="timeout")
    stats = dashboard.get_agent_stats("agent_1")
    print(stats.success_rate)  # 0.5
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentMetrics:
    """单个Agent的聚合指标。

    Attributes:
        agent_name: Agent名称。
        total_requests: 总请求数。
        success_count: 成功数。
        failure_count: 失败数。
        total_duration_ms: 累计耗时（毫秒）。
        total_tokens: 累计Token消耗。
        total_tool_calls: 累计工具调用数。
        total_tool_success: 工具调用成功数。
        error_distribution: 错误类型分布。
        p50_latency: P50延迟。
        p95_latency: P95延迟。
        p99_latency: P99延迟。
        first_request_at: 首次请求时间。
        last_request_at: 最后请求时间。
    """

    agent_name: str = ""
    total_requests: int = 0
    success_count: int = 0
    failure_count: int = 0
    total_duration_ms: float = 0.0
    total_tokens: int = 0
    total_tool_calls: int = 0
    total_tool_success: int = 0
    error_distribution: dict[str, int] = field(default_factory=dict)
    p50_latency: float = 0.0
    p95_latency: float = 0.0
    p99_latency: float = 0.0
    first_request_at: float = 0.0
    last_request_at: float = 0.0

    @property
    def success_rate(self) -> float:
        if self.total_requests == 0:
            return 1.0
        return self.success_count / self.total_requests

    @property
    def avg_latency(self) -> float:
        if self.total_requests == 0:
            return 0.0
        return self.total_duration_ms / self.total_requests

    @property
    def avg_tokens_per_request(self) -> float:
        if self.total_requests == 0:
            return 0.0
        return self.total_tokens / self.total_requests

    @property
    def tool_success_rate(self) -> float:
        if self.total_tool_calls == 0:
            return 1.0
        return self.total_tool_success / self.total_tool_calls

    @property
    def uptime_seconds(self) -> float:
        if self.first_request_at == 0:
            return 0.0
        return (self.last_request_at or time.time()) - self.first_request_at


@dataclass
class DashboardSummary:
    """仪表盘汇总。

    Attributes:
        total_agents: Agent总数。
        total_requests: 总请求数。
        overall_success_rate: 整体成功率。
        agents: 各Agent指标列表。
        scene_stats: 按场景分组的指标。
        error_summary: 错误类型汇总。
    """

    total_agents: int = 0
    total_requests: int = 0
    overall_success_rate: float = 0.0
    agents: list[AgentMetrics] = field(default_factory=list)
    scene_stats: dict[str, AgentMetrics] = field(default_factory=dict)
    error_summary: dict[str, int] = field(default_factory=dict)
    generated_at: float = 0.0


class AgentMetricsDashboard:
    """Agent级指标仪表盘。

    聚合每个Agent的关键指标，支持实时监控和历史趋势分析。
    纯内存存储，高效查询，支持按Agent/场景/时间窗口过滤。
    """

    _MAX_AGENTS = 500
    _MAX_SCENES = 200
    _TRIM_AGENTS_TO = 350
    _TRIM_SCENES_TO = 150

    def __init__(self, max_history: int = 10000) -> None:
        self._max_history = max_history
        self._agents: dict[str, AgentMetrics] = {}
        self._scenes: dict[str, AgentMetrics] = {}
        self._agent_access: dict[str, float] = {}
        self._scene_access: dict[str, float] = {}
        self._latency_samples: dict[str, list[float]] = defaultdict(list)
        self._request_log: list[dict] = []

    def _trim_agents(self) -> None:
        if len(self._agents) <= self._MAX_AGENTS:
            return
        sorted_agents = sorted(self._agent_access.items(), key=lambda x: x[1])
        to_remove = sorted_agents[: len(self._agents) - self._TRIM_AGENTS_TO]
        for name, _ in to_remove:
            self._agents.pop(name, None)
            self._agent_access.pop(name, None)
            self._latency_samples.pop(name, None)

    def _trim_scenes(self) -> None:
        if len(self._scenes) <= self._MAX_SCENES:
            return
        sorted_scenes = sorted(self._scene_access.items(), key=lambda x: x[1])
        to_remove = sorted_scenes[: len(self._scenes) - self._TRIM_SCENES_TO]
        for name, _ in to_remove:
            self._scenes.pop(name, None)
            self._scene_access.pop(name, None)

    def record(
        self,
        agent_name: str,
        scene: str = "general",
        success: bool = True,
        duration_ms: float = 0.0,
        tokens: int = 0,
        tool_calls: int = 0,
        tool_success: int = 0,
        error: str = "",
    ) -> None:
        """记录一次Agent请求。

        Args:
            agent_name: Agent名称。
            scene: 场景名称。
            success: 是否成功。
            duration_ms: 耗时（毫秒）。
            tokens: Token消耗。
            tool_calls: 工具调用数。
            tool_success: 工具调用成功数。
            error: 错误类型。
        """
        now = time.time()

        if agent_name not in self._agents:
            self._agents[agent_name] = AgentMetrics(agent_name=agent_name)
        agent = self._agents[agent_name]
        self._agent_access[agent_name] = now

        agent.total_requests += 1
        if success:
            agent.success_count += 1
        else:
            agent.failure_count += 1
        agent.total_duration_ms += duration_ms
        agent.total_tokens += tokens
        agent.total_tool_calls += tool_calls
        agent.total_tool_success += tool_success

        if error:
            agent.error_distribution[error] = agent.error_distribution.get(error, 0) + 1

        if agent.first_request_at == 0:
            agent.first_request_at = now
        agent.last_request_at = now

        self._latency_samples[agent_name].append(duration_ms)
        if len(self._latency_samples[agent_name]) > self._max_history:
            self._latency_samples[agent_name] = self._latency_samples[agent_name][-self._max_history:]

        if scene not in self._scenes:
            self._scenes[scene] = AgentMetrics(agent_name=f"scene:{scene}")
        scene_metrics = self._scenes[scene]
        self._scene_access[scene] = now
        scene_metrics.total_requests += 1
        if success:
            scene_metrics.success_count += 1
        else:
            scene_metrics.failure_count += 1
        scene_metrics.total_duration_ms += duration_ms
        scene_metrics.total_tokens += tokens
        scene_metrics.total_tool_calls += tool_calls
        scene_metrics.total_tool_success += tool_success
        if error:
            scene_metrics.error_distribution[error] = scene_metrics.error_distribution.get(error, 0) + 1

        self._request_log.append({
            "agent": agent_name,
            "scene": scene,
            "success": success,
            "duration_ms": duration_ms,
            "tokens": tokens,
            "error": error,
            "timestamp": now,
        })
        if len(self._request_log) > self._max_history:
            self._request_log = self._request_log[-self._max_history:]

        self._trim_agents()
        self._trim_scenes()
        self._compute_percentiles(agent_name)

    def get_agent_stats(self, agent_name: str) -> AgentMetrics | None:
        return self._agents.get(agent_name)

    def get_all_agents(self) -> list[AgentMetrics]:
        return list(self._agents.values())

    def get_scene_stats(self, scene: str) -> AgentMetrics | None:
        return self._scenes.get(scene)

    def get_summary(self) -> DashboardSummary:
        total_requests = sum(a.total_requests for a in self._agents.values())
        total_success = sum(a.success_count for a in self._agents.values())
        overall_sr = total_success / total_requests if total_requests > 0 else 1.0

        error_summary: dict[str, int] = {}
        for agent in self._agents.values():
            for err_type, count in agent.error_distribution.items():
                error_summary[err_type] = error_summary.get(err_type, 0) + count

        return DashboardSummary(
            total_agents=len(self._agents),
            total_requests=total_requests,
            overall_success_rate=overall_sr,
            agents=list(self._agents.values()),
            scene_stats=dict(self._scenes),
            error_summary=error_summary,
            generated_at=time.time(),
        )

    def get_top_failing_agents(self, limit: int = 5) -> list[AgentMetrics]:
        agents = [a for a in self._agents.values() if a.total_requests > 0]
        agents.sort(key=lambda a: a.success_rate)
        return agents[:limit]

    def get_top_latency_agents(self, limit: int = 5) -> list[AgentMetrics]:
        agents = [a for a in self._agents.values() if a.total_requests > 0]
        agents.sort(key=lambda a: a.avg_latency, reverse=True)
        return agents[:limit]

    def get_top_error_types(self, limit: int = 5) -> list[tuple[str, int]]:
        summary = self.get_summary()
        sorted_errors = sorted(summary.error_summary.items(), key=lambda x: x[1], reverse=True)
        return sorted_errors[:limit]

    def get_recent_requests(self, agent_name: str | None = None, limit: int = 20) -> list[dict]:
        if agent_name:
            return [r for r in self._request_log if r["agent"] == agent_name][-limit:]
        return self._request_log[-limit:]

    def reset(self) -> None:
        self._agents.clear()
        self._scenes.clear()
        self._agent_access.clear()
        self._scene_access.clear()
        self._latency_samples.clear()
        self._request_log.clear()

    def _compute_percentiles(self, agent_name: str) -> None:
        samples = sorted(self._latency_samples.get(agent_name, []))
        if not samples:
            return
        agent = self._agents.get(agent_name)
        if not agent:
            return
        n = len(samples)
        agent.p50_latency = samples[int(n * 0.50)]
        agent.p95_latency = samples[min(int(n * 0.95), n - 1)]
        agent.p99_latency = samples[min(int(n * 0.99), n - 1)]
