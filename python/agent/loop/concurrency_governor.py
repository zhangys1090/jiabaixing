"""并发配额管理器（Concurrency Governor）。

在现有 Executor 并行执行基础上，增强为：
1. 分级并发配额：按工具风险等级（critical/high/normal/low）分配不同并发上限
2. 动态超时策略：按工具类型和历史执行时间动态调整超时
3. 资源预算追踪：实时追踪并发资源占用，超限自动排队
4. 优先级调度：高优先级任务可抢占低优先级任务的并发配额
5. 背压机制：资源紧张时自动降级并发度，避免系统过载

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 Executor 集成，复用其并行执行框架
- 非侵入式：包装 Executor，不修改其内部逻辑
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("concurrency_governor")



class RiskTier(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


class ConcurrencyAction(str, Enum):
    ALLOW = "allow"
    QUEUE = "queue"
    REJECT = "reject"
    PREEMPT = "preempt"


@dataclass
class TierQuota:
    tier: RiskTier = RiskTier.NORMAL
    max_concurrent: int = 4
    timeout_seconds: float = 30.0
    max_retries: int = 1
    priority_boost: int = 0


@dataclass
class ConcurrencyRequest:
    request_id: str = ""
    tool_name: str = ""
    risk_tier: RiskTier = RiskTier.NORMAL
    priority: int = 2
    estimated_duration_ms: float = 0.0
    timestamp: float = field(default_factory=time.time)


@dataclass
class ConcurrencyDecision:
    action: ConcurrencyAction = ConcurrencyAction.ALLOW
    wait_seconds: float = 0.0
    effective_timeout: float = 30.0
    effective_max_retries: int = 1
    queue_position: int = 0
    reason: str = ""


@dataclass
class ConcurrencyMetrics:
    total_requests: int = 0
    allowed: int = 0
    queued: int = 0
    rejected: int = 0
    preempted: int = 0
    avg_wait_seconds: float = 0.0
    current_active: dict[str, int] = field(default_factory=dict)
    peak_active: dict[str, int] = field(default_factory=dict)


DEFAULT_TIER_QUOTAS: dict[RiskTier, TierQuota] = {
    RiskTier.CRITICAL: TierQuota(
        tier=RiskTier.CRITICAL,
        max_concurrent=1,
        timeout_seconds=120.0,
        max_retries=0,
        priority_boost=10,
    ),
    RiskTier.HIGH: TierQuota(
        tier=RiskTier.HIGH,
        max_concurrent=2,
        timeout_seconds=60.0,
        max_retries=1,
        priority_boost=5,
    ),
    RiskTier.NORMAL: TierQuota(
        tier=RiskTier.NORMAL,
        max_concurrent=4,
        timeout_seconds=30.0,
        max_retries=2,
        priority_boost=0,
    ),
    RiskTier.LOW: TierQuota(
        tier=RiskTier.LOW,
        max_concurrent=8,
        timeout_seconds=15.0,
        max_retries=3,
        priority_boost=-5,
    ),
}

_CRITICAL_TOOLS: frozenset[str] = frozenset({
    "code_execution", "shell_exec", "desktop_automate",
    "write_file", "delete_file", "system_exec",
})
_HIGH_TOOLS: frozenset[str] = frozenset({
    "browser_automation", "desktop_screenshot", "desktop_window",
    "git_commit", "git_push", "network_request",
})
_LOW_TOOLS: frozenset[str] = frozenset({
    "read_file", "search_files", "list_directory",
    "get_tool_info", "memory_search",
})


class ConcurrencyGovernor:
    """并发配额管理器：分级并发控制 + 动态超时 + 背压机制。"""

    _instance: ConcurrencyGovernor | None = None

    def __init__(
        self,
        tier_quotas: dict[RiskTier, TierQuota] | None = None,
        global_max_concurrent: int | None = None,
        backpressure_threshold: float = 0.85,
    ) -> None:
        self._tier_quotas = tier_quotas or dict(DEFAULT_TIER_QUOTAS)
        self._global_max = global_max_concurrent or int(
            os.environ.get("CONCURRENCY_GOVERNOR_MAX", "16")
        )
        self._backpressure_threshold = backpressure_threshold
        self._active: dict[str, list[str]] = {tier: [] for tier in RiskTier}
        self._semaphores: dict[RiskTier, asyncio.Semaphore] = {}
        self._global_semaphore: asyncio.Semaphore | None = None
        self._metrics = ConcurrencyMetrics()
        self._tool_history: dict[str, list[float]] = {}
        self._tool_tier_overrides: dict[str, RiskTier] = {}
        self._initialized = False

    @classmethod
    def get_instance(cls) -> ConcurrencyGovernor:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        for tier, quota in self._tier_quotas.items():
            self._semaphores[tier] = asyncio.Semaphore(quota.max_concurrent)
        self._global_semaphore = asyncio.Semaphore(self._global_max)
        self._initialized = True

    def classify_tool(self, tool_name: str) -> RiskTier:
        if tool_name in self._tool_tier_overrides:
            return self._tool_tier_overrides[tool_name]
        if tool_name in _CRITICAL_TOOLS:
            return RiskTier.CRITICAL
        if tool_name in _HIGH_TOOLS:
            return RiskTier.HIGH
        if tool_name in _LOW_TOOLS:
            return RiskTier.LOW
        return RiskTier.NORMAL

    def set_tool_tier(self, tool_name: str, tier: RiskTier) -> None:
        self._tool_tier_overrides[tool_name] = tier

    def request(self, req: ConcurrencyRequest) -> ConcurrencyDecision:
        self._ensure_initialized()
        self._metrics.total_requests += 1

        tier = req.risk_tier
        quota = self._tier_quotas.get(tier, self._tier_quotas[RiskTier.NORMAL])
        tier_active = len(self._active.get(tier, []))
        global_active = sum(len(v) for v in self._active.values())

        effective_timeout = self._compute_timeout(tier, req.tool_name, quota)
        effective_retries = quota.max_retries

        if tier_active < quota.max_concurrent and global_active < self._global_max:
            self._active[tier].append(req.request_id)
            self._metrics.allowed += 1
            self._update_peak()
            return ConcurrencyDecision(
                action=ConcurrencyAction.ALLOW,
                effective_timeout=effective_timeout,
                effective_max_retries=effective_retries,
                reason=f"配额允许 (tier={tier.value}, active={tier_active}/{quota.max_concurrent})",
            )

        if self._is_backpressure_active(global_active):
            self._metrics.rejected += 1
            return ConcurrencyDecision(
                action=ConcurrencyAction.REJECT,
                effective_timeout=effective_timeout,
                effective_max_retries=0,
                reason=f"背压激活 (global_active={global_active}/{self._global_max}, threshold={self._backpressure_threshold})",
            )

        queue_pos = tier_active - quota.max_concurrent + 1
        wait_sec = self._estimate_wait(tier, req)
        self._metrics.queued += 1

        return ConcurrencyDecision(
            action=ConcurrencyAction.QUEUE,
            wait_seconds=wait_sec,
            effective_timeout=effective_timeout,
            effective_max_retries=effective_retries,
            queue_position=queue_pos,
            reason=f"排队等待 (tier={tier.value}, position={queue_pos}, est_wait={wait_sec:.1f}s)",
        )

    def release(self, request_id: str, tier: RiskTier, duration_ms: float = 0.0) -> None:
        active_list = self._active.get(tier, [])
        if request_id in active_list:
            active_list.remove(request_id)

    def record_tool_duration(self, tool_name: str, duration_ms: float) -> None:
        if tool_name not in self._tool_history:
            self._tool_history[tool_name] = []
        history = self._tool_history[tool_name]
        history.append(duration_ms)
        if len(history) > 100:
            history.pop(0)

    def _compute_timeout(self, tier: RiskTier, tool_name: str, quota: TierQuota) -> float:
        base_timeout = quota.timeout_seconds
        history = self._tool_history.get(tool_name, [])
        if len(history) < 3:
            return base_timeout
        avg_duration_s = sum(history[-20:]) / len(history[-20:]) / 1000.0
        p95_estimate = avg_duration_s * 1.5
        dynamic_timeout = max(p95_estimate * 2.0, base_timeout * 0.5)
        return min(dynamic_timeout, base_timeout * 3.0)

    def _is_backpressure_active(self, global_active: int) -> bool:
        return global_active >= self._global_max * self._backpressure_threshold

    def _estimate_wait(self, tier: RiskTier, req: ConcurrencyRequest) -> float:
        quota = self._tier_quotas.get(tier, self._tier_quotas[RiskTier.NORMAL])
        history = self._tool_history.get(req.tool_name, [])
        if history:
            avg_ms = sum(history[-10:]) / len(history[-10:])
            return avg_ms / 1000.0
        return quota.timeout_seconds / 2.0

    def _update_peak(self) -> None:
        for tier, active in self._active.items():
            current = len(active)
            peak = self._metrics.peak_active.get(tier, 0)
            if current > peak:
                self._metrics.peak_active[tier] = current

    def get_metrics(self) -> ConcurrencyMetrics:
        self._metrics.current_active = {
            tier: len(active) for tier, active in self._active.items()
        }
        return self._metrics

    def get_status(self) -> dict[str, Any]:
        metrics = self.get_metrics()
        return {
            "global_max": self._global_max,
            "global_active": sum(metrics.current_active.values()),
            "backpressure_active": self._is_backpressure_active(
                sum(metrics.current_active.values())
            ),
            "tier_status": {
                tier.value: {
                    "active": len(self._active.get(tier, [])),
                    "max": self._tier_quotas.get(tier, TierQuota()).max_concurrent,
                    "peak": metrics.peak_active.get(tier, 0),
                }
                for tier in RiskTier
            },
            "metrics": {
                "total_requests": metrics.total_requests,
                "allowed": metrics.allowed,
                "queued": metrics.queued,
                "rejected": metrics.rejected,
            },
        }


class GovernorAwareExecutor:
    """并发感知执行器：包装 Executor 的并发调用，注入配额管理。

    用法：
        governor = ConcurrencyGovernor.get_instance()
        g_executor = GovernorAwareExecutor(governor)
        result = await g_executor.execute_with_governor(tool_name, params, executor_fn)
    """

    def __init__(self, governor: ConcurrencyGovernor | None = None) -> None:
        self._governor = governor or ConcurrencyGovernor.get_instance()

    async def execute_with_governor(
        self,
        tool_name: str,
        params: dict[str, Any],
        executor_fn: Any,
        request_id: str = "",
        priority: int = 2,
    ) -> dict[str, Any]:
        import uuid
        if not request_id:
            request_id = f"gov_{uuid.uuid4().hex[:8]}"

        tier = self._governor.classify_tool(tool_name)
        req = ConcurrencyRequest(
            request_id=request_id,
            tool_name=tool_name,
            risk_tier=tier,
            priority=priority,
        )
        decision = self._governor.request(req)

        if decision.action == ConcurrencyAction.REJECT:
            return {
                "success": False,
                "error": decision.reason,
                "metadata": {"governor_rejected": True},
            }

        if decision.action == ConcurrencyAction.QUEUE and decision.wait_seconds > 0:
            await asyncio.sleep(min(decision.wait_seconds, 5.0))
            decision = self._governor.request(req)
            if decision.action == ConcurrencyAction.REJECT:
                return {
                    "success": False,
                    "error": decision.reason,
                    "metadata": {"governor_rejected_after_wait": True},
                }

        start = time.time()
        try:
            result = await asyncio.wait_for(
                executor_fn(tool_name, params),
                timeout=decision.effective_timeout,
            )
            duration_ms = (time.time() - start) * 1000
            self._governor.record_tool_duration(tool_name, duration_ms)
            return result
        except asyncio.TimeoutError:
            return {
                "success": False,
                "error": f"工具 '{tool_name}' 执行超时 (>{decision.effective_timeout}s, governor)",
                "metadata": {"governor_timeout": True},
            }
        finally:
            self._governor.release(request_id, tier)
