"""动态降级策略 — 基于历史成功率的自适应工具降级。

设计目标：
1. 动态降级：根据工具历史成功率自动调整降级策略
2. 成功率阈值：成功率 < 50% 的工具自动降级到替代方案
3. 降级恢复：工具成功率恢复后自动升级回原始工具
4. 降级记录：记录降级事件供进化引擎学习

降级策略：
  - 基于历史成功率：从 TrajectoryDatabase 查询工具近 N 次调用成功率
  - 基于错误模式：连续同类错误触发降级
  - 基于性能指标：响应时间飙升触发降级

降级链：
  desktop_uia_invoke → desktop_automate → pyautogui
  lsp_diagnostics → code_analyze → file_read + regex
  web_fetch → web_search → cached_result

Usage:
    degradation = AdaptiveDegradation(trajectory_db=db)
    decision = degradation.evaluate("desktop_uia_invoke")
    if decision.should_degrade:
        result = await execute_tool(decision.fallback_tool, params)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
log = StructuredLogger("adaptive_degradation")



class DegradationReason(str, Enum):
    LOW_SUCCESS_RATE = "low_success_rate"
    CONSECUTIVE_FAILURES = "consecutive_failures"
    HIGH_LATENCY = "high_latency"
    ERROR_PATTERN = "error_pattern"
    MANUAL = "manual"
    RECOVERED = "recovered"


class DegradationLevel(str, Enum):
    NORMAL = "normal"
    DEGRADED = "degraded"
    HEAVILY_DEGRADED = "heavily_degraded"
    UNAVAILABLE = "unavailable"


@dataclass
class DegradationDecision:
    tool_name: str
    should_degrade: bool
    level: DegradationLevel = DegradationLevel.NORMAL
    fallback_tool: str = ""
    fallback_params_mapping: dict[str, str] = field(default_factory=dict)
    reason: DegradationReason = DegradationReason.LOW_SUCCESS_RATE
    original_success_rate: float = 0.0
    fallback_success_rate: float = 0.0
    confidence: float = 0.0


@dataclass
class ToolPerformanceRecord:
    tool_name: str
    success_count: int = 0
    failure_count: int = 0
    total_count: int = 0
    success_rate: float = 1.0
    avg_latency_ms: float = 0.0
    consecutive_failures: int = 0
    last_failure_time: float = 0.0
    last_success_time: float = 0.0
    current_level: DegradationLevel = DegradationLevel.NORMAL
    degradation_history: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class DegradationChain:
    tool_name: str
    fallbacks: list[str]
    param_mappings: list[dict[str, str]] = field(default_factory=list)
    success_threshold: float = 0.5
    recovery_threshold: float = 0.7
    latency_threshold_ms: float = 10000.0
    consecutive_failure_threshold: int = 3


_DEFAULT_CHAINS: list[DegradationChain] = [
    DegradationChain(
        tool_name="desktop_uia_invoke",
        fallbacks=["desktop_automate", "desktop_screenshot"],
        param_mappings=[{"element_name": "target"}, {"element_name": "query"}],
        success_threshold=0.5,
        recovery_threshold=0.7,
    ),
    DegradationChain(
        tool_name="desktop_uia_find",
        fallbacks=["desktop_screenshot", "screen_parse"],
        param_mappings=[{"name": "query"}, {"name": "query"}],
        success_threshold=0.5,
        recovery_threshold=0.7,
    ),
    DegradationChain(
        tool_name="lsp_diagnostics",
        fallbacks=["code_analyze"],
        param_mappings=[{"file_path": "file_path"}],
        success_threshold=0.5,
        recovery_threshold=0.7,
    ),
    DegradationChain(
        tool_name="web_fetch",
        fallbacks=["web_search"],
        param_mappings=[{"url": "query"}],
        success_threshold=0.4,
        recovery_threshold=0.6,
    ),
    DegradationChain(
        tool_name="browser_navigate",
        fallbacks=["web_fetch"],
        param_mappings=[{"url": "url"}],
        success_threshold=0.5,
        recovery_threshold=0.7,
    ),
    DegradationChain(
        tool_name="speech_transcribe",
        fallbacks=[],
        success_threshold=0.3,
        recovery_threshold=0.5,
    ),
]


class AdaptiveDegradation:
    def __init__(
        self,
        trajectory_db: Any | None = None,
        window_size: int = 20,
    ) -> None:
        self._trajectory_db = trajectory_db
        self._window_size = window_size

        self._chains: dict[str, DegradationChain] = {}
        for chain in _DEFAULT_CHAINS:
            self._chains[chain.tool_name] = chain

        self._performance: dict[str, ToolPerformanceRecord] = {}
        self._degradation_events: list[dict[str, Any]] = []
        self._max_events = 500

    def evaluate(self, tool_name: str) -> DegradationDecision:
        perf = self._get_performance(tool_name)
        chain = self._chains.get(tool_name)

        if chain and perf.current_level != DegradationLevel.NORMAL:
            if self._should_recover(perf, chain):
                self._record_recovery(tool_name, perf)
                perf.current_level = DegradationLevel.NORMAL
                perf.consecutive_failures = 0
                return DegradationDecision(
                    tool_name=tool_name,
                    should_degrade=False,
                    level=DegradationLevel.NORMAL,
                    reason=DegradationReason.RECOVERED,
                    original_success_rate=perf.success_rate,
                    confidence=0.8,
                )

        if chain and self._should_degrade(perf, chain):
            fallback_idx = self._resolve_fallback_index(perf, chain)
            if fallback_idx < len(chain.fallbacks):
                fallback_tool = chain.fallbacks[fallback_idx]
                param_mapping = (
                    chain.param_mappings[fallback_idx]
                    if fallback_idx < len(chain.param_mappings)
                    else {}
                )

                level = (
                    DegradationLevel.HEAVILY_DEGRADED
                    if fallback_idx > 0
                    else DegradationLevel.DEGRADED
                )

                self._record_degradation(tool_name, perf, fallback_tool, level)

                perf.current_level = level

                fallback_perf = self._get_performance(fallback_tool)

                return DegradationDecision(
                    tool_name=tool_name,
                    should_degrade=True,
                    level=level,
                    fallback_tool=fallback_tool,
                    fallback_params_mapping=param_mapping,
                    reason=DegradationReason.LOW_SUCCESS_RATE,
                    original_success_rate=perf.success_rate,
                    fallback_success_rate=fallback_perf.success_rate,
                    confidence=self._compute_confidence(perf),
                )

            perf.current_level = DegradationLevel.UNAVAILABLE
            return DegradationDecision(
                tool_name=tool_name,
                should_degrade=True,
                level=DegradationLevel.UNAVAILABLE,
                reason=DegradationReason.LOW_SUCCESS_RATE,
                original_success_rate=perf.success_rate,
                confidence=self._compute_confidence(perf),
            )

        return DegradationDecision(
            tool_name=tool_name,
            should_degrade=False,
            level=perf.current_level,
            original_success_rate=perf.success_rate,
            confidence=self._compute_confidence(perf),
        )

    def record_result(
        self,
        tool_name: str,
        success: bool,
        latency_ms: float = 0.0,
        error_type: str = "",
    ) -> None:
        perf = self._get_performance(tool_name)

        perf.total_count += 1
        if success:
            perf.success_count += 1
            perf.consecutive_failures = 0
            perf.last_success_time = time.time()
        else:
            perf.failure_count += 1
            perf.consecutive_failures += 1
            perf.last_failure_time = time.time()

        if perf.total_count > 0:
            perf.success_rate = perf.success_count / perf.total_count

        if latency_ms > 0:
            if perf.avg_latency_ms == 0:
                perf.avg_latency_ms = latency_ms
            else:
                alpha = 2.0 / (self._window_size + 1)
                perf.avg_latency_ms = alpha * latency_ms + (1 - alpha) * perf.avg_latency_ms

        if self._trajectory_db:
            try:
                self._trajectory_db.record_tool_invocation(
                    tool_name=tool_name,
                    success=success,
                    latency_ms=latency_ms,
                )
            except Exception as e:
                log.debug("adaptive_degradation 异常处理", error=str(e))
                log_ignored(log, "adaptive_degradation.record_result.trajectory", e)

    def add_chain(self, chain: DegradationChain) -> None:
        self._chains[chain.tool_name] = chain

    def get_performance(self, tool_name: str) -> dict[str, Any]:
        perf = self._get_performance(tool_name)
        return {
            "tool_name": perf.tool_name,
            "success_rate": round(perf.success_rate, 4),
            "total_count": perf.total_count,
            "consecutive_failures": perf.consecutive_failures,
            "avg_latency_ms": round(perf.avg_latency_ms, 2),
            "current_level": perf.current_level.value,
        }

    def get_all_performance(self) -> dict[str, dict[str, Any]]:
        return {
            name: self.get_performance(name)
            for name in self._performance
        }

    def get_degradation_events(self, limit: int = 50) -> list[dict[str, Any]]:
        return self._degradation_events[-limit:]

    def get_stats(self) -> dict[str, Any]:
        total_tools = len(self._performance)
        degraded = sum(
            1 for p in self._performance.values()
            if p.current_level != DegradationLevel.NORMAL
        )
        unavailable = sum(
            1 for p in self._performance.values()
            if p.current_level == DegradationLevel.UNAVAILABLE
        )

        return {
            "total_tools_tracked": total_tools,
            "degraded_tools": degraded,
            "unavailable_tools": unavailable,
            "degradation_events": len(self._degradation_events),
            "chains_configured": len(self._chains),
        }

    def _should_degrade(self, perf: ToolPerformanceRecord, chain: DegradationChain) -> bool:
        if perf.total_count < 3:
            return False

        if perf.success_rate < chain.success_threshold:
            return True

        if perf.consecutive_failures >= chain.consecutive_failure_threshold:
            return True

        if perf.avg_latency_ms > chain.latency_threshold_ms:
            return True

        return False

    def _should_recover(self, perf: ToolPerformanceRecord, chain: DegradationChain) -> bool:
        if perf.total_count < 5:
            return False

        if perf.success_rate >= chain.recovery_threshold:
            if perf.consecutive_failures == 0:
                return True

        if perf.consecutive_failures == 0 and perf.last_success_time > perf.last_failure_time:
            time_since_failure = time.time() - perf.last_failure_time
            if time_since_failure > 300:
                return True

        return False

    def _resolve_fallback_index(self, perf: ToolPerformanceRecord, chain: DegradationChain) -> int:
        if perf.current_level == DegradationLevel.NORMAL:
            return 0
        elif perf.current_level == DegradationLevel.DEGRADED:
            return 1
        elif perf.current_level == DegradationLevel.HEAVILY_DEGRADED:
            return min(2, len(chain.fallbacks) - 1)
        return len(chain.fallbacks)

    def _compute_confidence(self, perf: ToolPerformanceRecord) -> float:
        if perf.total_count == 0:
            return 0.0
        sample_confidence = min(perf.total_count / 10.0, 1.0)
        recency = 1.0
        if perf.last_failure_time > 0:
            time_since = time.time() - perf.last_failure_time
            recency = max(0.0, 1.0 - time_since / 3600.0)
        return round(sample_confidence * recency, 4)

    def _get_performance(self, tool_name: str) -> ToolPerformanceRecord:
        if tool_name not in self._performance:
            self._performance[tool_name] = ToolPerformanceRecord(tool_name=tool_name)
        return self._performance[tool_name]

    def _record_degradation(
        self,
        tool_name: str,
        perf: ToolPerformanceRecord,
        fallback: str,
        level: DegradationLevel,
    ) -> None:
        event = {
            "timestamp": time.time(),
            "event": "degradation",
            "tool_name": tool_name,
            "fallback": fallback,
            "level": level.value,
            "success_rate": perf.success_rate,
            "consecutive_failures": perf.consecutive_failures,
        }
        self._degradation_events.append(event)
        perf.degradation_history.append(event)
        if len(self._degradation_events) > self._max_events:
            self._degradation_events = self._degradation_events[-self._max_events:]

    def _record_recovery(self, tool_name: str, perf: ToolPerformanceRecord) -> None:
        event = {
            "timestamp": time.time(),
            "event": "recovery",
            "tool_name": tool_name,
            "success_rate": perf.success_rate,
            "previous_level": perf.current_level.value,
        }
        self._degradation_events.append(event)
        perf.degradation_history.append(event)
        if len(self._degradation_events) > self._max_events:
            self._degradation_events = self._degradation_events[-self._max_events:]
