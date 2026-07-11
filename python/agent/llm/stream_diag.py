"""流式传输诊断器。

对流式 LLM 响应进行实时诊断和监控：
  - 首字延迟（Time To First Token, TTFT）测量
  - 吞吐量（tokens/s）实时计算
  - 分块间隔异常检测（卡顿/断流）
  - 流中断自动恢复建议
  - 诊断报告生成

与 StreamResponseService 的关系：
  - 包装在流式传输管道中，透明采集指标
  - 不影响正常流式输出
  - 诊断数据供 Dashboard 和 OTEL 上报

集成示例::

    from agent.llm.stream_diag import StreamDiagnostics

    diag = StreamDiagnostics()
    diag.mark_request_start("trace-123")
    # ... 收到第一个 chunk ...
    diag.mark_first_token("trace-123")
    # ... 流结束 ...
    report = diag.mark_stream_end("trace-123")
    print(f"TTFT: {report.ttft_ms}ms, 吞吐: {report.tokens_per_sec} tok/s")
"""

from __future__ import annotations

import statistics
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("stream_diag")


@dataclass
class StreamDiagReport:
    """流式传输诊断报告。

    Attributes:
        trace_id: 追踪 ID。
        ttft_ms: 首字延迟（毫秒）。
        total_tokens: 总 token 数。
        total_duration_ms: 总耗时（毫秒）。
        tokens_per_sec: 吞吐量（tokens/s）。
        chunk_count: 分块数量。
        chunk_intervals_ms: 分块间隔列表（毫秒）。
        max_interval_ms: 最大分块间隔。
        stall_count: 卡顿次数（间隔超过阈值）。
        stall_threshold_ms: 卡顿判定阈值。
        was_interrupted: 是否发生中断。
        provider: 提供商名称。
        model: 模型名称。
        timestamp: 报告时间戳。
    """

    trace_id: str = ""
    ttft_ms: float = 0.0
    total_tokens: int = 0
    total_duration_ms: float = 0.0
    tokens_per_sec: float = 0.0
    chunk_count: int = 0
    chunk_intervals_ms: list[float] = field(default_factory=list)
    max_interval_ms: float = 0.0
    stall_count: int = 0
    stall_threshold_ms: float = 500.0
    was_interrupted: bool = False
    provider: str = ""
    model: str = ""
    timestamp: float = 0.0

    @property
    def avg_interval_ms(self) -> float:
        """平均分块间隔。"""
        return statistics.mean(self.chunk_intervals_ms) if self.chunk_intervals_ms else 0.0

    @property
    def p95_interval_ms(self) -> float:
        """P95 分块间隔。"""
        if not self.chunk_intervals_ms:
            return 0.0
        sorted_intervals = sorted(self.chunk_intervals_ms)
        idx = int(len(sorted_intervals) * 0.95)
        return sorted_intervals[min(idx, len(sorted_intervals) - 1)]

    @property
    def health_status(self) -> str:
        """健康状态判定。"""
        if self.was_interrupted:
            return "interrupted"
        if self.stall_count > 3:
            return "degraded"
        if self.ttft_ms > 5000:
            return "slow_start"
        if self.tokens_per_sec > 0 and self.tokens_per_sec < 10:
            return "low_throughput"
        return "healthy"

    def to_dict(self) -> dict[str, Any]:
        """转换为字典。"""
        return {
            "trace_id": self.trace_id,
            "ttft_ms": round(self.ttft_ms, 1),
            "total_tokens": self.total_tokens,
            "total_duration_ms": round(self.total_duration_ms, 1),
            "tokens_per_sec": round(self.tokens_per_sec, 1),
            "chunk_count": self.chunk_count,
            "max_interval_ms": round(self.max_interval_ms, 1),
            "avg_interval_ms": round(self.avg_interval_ms, 1),
            "p95_interval_ms": round(self.p95_interval_ms, 1),
            "stall_count": self.stall_count,
            "health": self.health_status,
            "provider": self.provider,
            "model": self.model,
        }


@dataclass
class _StreamState:
    """流式传输内部状态。"""

    request_start: float = 0.0
    first_token_time: float = 0.0
    last_chunk_time: float = 0.0
    chunk_count: int = 0
    total_tokens: int = 0
    chunk_times: list[float] = field(default_factory=list)
    interrupted: bool = False
    provider: str = ""
    model: str = ""


class StreamDiagnostics:
    """流式传输诊断器。

    对流式 LLM 响应进行实时诊断，采集 TTFT、吞吐量、卡顿等指标。
    """

    DEFAULT_STALL_THRESHOLD_MS = 500.0

    def __init__(self, stall_threshold_ms: float = DEFAULT_STALL_THRESHOLD_MS) -> None:
        self._states: dict[str, _StreamState] = {}
        self._reports: list[StreamDiagReport] = []
        self._stall_threshold_ms = stall_threshold_ms
        self._max_reports = 1000

    def mark_request_start(
        self, trace_id: str, provider: str = "", model: str = ""
    ) -> None:
        """标记流式请求开始。

        Args:
            trace_id: 追踪 ID。
            provider: 提供商名称。
            model: 模型名称。
        """
        self._states[trace_id] = _StreamState(
            request_start=time.time(),
            provider=provider,
            model=model,
        )

    def mark_first_token(self, trace_id: str, token_count: int = 1) -> None:
        """标记收到第一个 token。

        Args:
            trace_id: 追踪 ID。
            token_count: 本 chunk 的 token 数。
        """
        state = self._states.get(trace_id)
        if state is None:
            return
        now = time.time()
        if state.first_token_time == 0.0:
            state.first_token_time = now
        state.total_tokens += token_count
        state.chunk_count += 1
        state.last_chunk_time = now
        state.chunk_times.append(now)

    def mark_chunk(self, trace_id: str, token_count: int = 1) -> None:
        """标记收到一个 chunk（非首 chunk）。

        Args:
            trace_id: 追踪 ID。
            token_count: 本 chunk 的 token 数。
        """
        state = self._states.get(trace_id)
        if state is None:
            return
        now = time.time()
        if state.first_token_time == 0.0:
            state.first_token_time = now
        state.total_tokens += token_count
        state.chunk_count += 1
        state.last_chunk_time = now
        state.chunk_times.append(now)

    def mark_interrupted(self, trace_id: str) -> None:
        """标记流中断。

        Args:
            trace_id: 追踪 ID。
        """
        state = self._states.get(trace_id)
        if state:
            state.interrupted = True

    def mark_stream_end(self, trace_id: str) -> StreamDiagReport:
        """标记流结束并生成诊断报告。

        Args:
            trace_id: 追踪 ID。

        Returns:
            StreamDiagReport 诊断报告。
        """
        state = self._states.pop(trace_id, None)
        if state is None:
            return StreamDiagReport(trace_id=trace_id)

        now = time.time()
        ttft_ms = 0.0
        if state.first_token_time > 0 and state.request_start > 0:
            ttft_ms = (state.first_token_time - state.request_start) * 1000

        total_duration_ms = 0.0
        if state.request_start > 0:
            total_duration_ms = (now - state.request_start) * 1000

        tokens_per_sec = 0.0
        if total_duration_ms > 0:
            tokens_per_sec = state.total_tokens / (total_duration_ms / 1000)

        intervals_ms: list[float] = []
        for i in range(1, len(state.chunk_times)):
            interval = (state.chunk_times[i] - state.chunk_times[i - 1]) * 1000
            intervals_ms.append(interval)

        stall_count = sum(1 for iv in intervals_ms if iv > self._stall_threshold_ms)
        max_interval = max(intervals_ms) if intervals_ms else 0.0

        report = StreamDiagReport(
            trace_id=trace_id,
            ttft_ms=ttft_ms,
            total_tokens=state.total_tokens,
            total_duration_ms=total_duration_ms,
            tokens_per_sec=tokens_per_sec,
            chunk_count=state.chunk_count,
            chunk_intervals_ms=intervals_ms,
            max_interval_ms=max_interval,
            stall_count=stall_count,
            stall_threshold_ms=self._stall_threshold_ms,
            was_interrupted=state.interrupted,
            provider=state.provider,
            model=state.model,
            timestamp=now,
        )

        self._reports.append(report)
        if len(self._reports) > self._max_reports:
            self._reports = self._reports[-self._max_reports:]

        log.info(
            "Stream diag report",
            trace_id=trace_id,
            ttft_ms=round(ttft_ms, 1),
            tokens_per_sec=round(tokens_per_sec, 1),
            health=report.health_status,
            stall_count=stall_count,
        )

        return report

    def get_recent_reports(self, limit: int = 50) -> list[StreamDiagReport]:
        """获取最近的诊断报告。

        Args:
            limit: 最大返回数量。

        Returns:
            最近的诊断报告列表。
        """
        return self._reports[-limit:]

    def get_summary(self) -> dict[str, Any]:
        """获取诊断汇总统计。

        Returns:
            汇总统计字典。
        """
        if not self._reports:
            return {"total_streams": 0}

        ttfts = [r.ttft_ms for r in self._reports if r.ttft_ms > 0]
        throughputs = [r.tokens_per_sec for r in self._reports if r.tokens_per_sec > 0]
        stalls = [r.stall_count for r in self._reports]
        interrupted = sum(1 for r in self._reports if r.was_interrupted)

        return {
            "total_streams": len(self._reports),
            "avg_ttft_ms": round(statistics.mean(ttfts), 1) if ttfts else 0,
            "p95_ttft_ms": round(sorted(ttfts)[int(len(ttfts) * 0.95)], 1) if ttfts else 0,
            "avg_throughput": round(statistics.mean(throughputs), 1) if throughputs else 0,
            "total_stalls": sum(stalls),
            "total_interrupted": interrupted,
            "healthy_rate": round(
                sum(1 for r in self._reports if r.health_status == "healthy")
                / len(self._reports),
                3,
            ),
        }
