"""闭环指标持久化 + 跨会话闭环（Closed-Loop Metrics Persistence & Cross-Session Loop）。

在现有 EvolutionClosedLoop（单会话进化闭环）基础上，增强为：
1. 闭环指标持久化：将 EffectivenessMetrics 持久化到 PersistenceService，支持重启恢复
2. 跨会话闭环：不同会话间共享进化经验，实现跨会话的进化-验证-反馈闭环
3. 指标聚合：跨会话指标聚合分析，识别长期趋势
4. 闭环快照：定期保存闭环状态快照，支持回滚到历史状态

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 PersistenceService 集成，复用其持久化基础设施
- 非侵入式：包装 EvolutionClosedLoop，不修改其内部逻辑
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("cross_session_loop")



class MetricAggregation(str, Enum):
    SUM = "sum"
    AVG = "avg"
    MAX = "max"
    MIN = "min"
    LAST = "last"


@dataclass
class SessionMetrics:
    session_id: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    total_cycles: int = 0
    successful_cycles: int = 0
    rolled_back_cycles: int = 0
    avg_quality_delta: float = 0.0
    avg_latency_delta_ms: float = 0.0
    effectiveness_rate: float = 0.0
    action_stats: dict[str, dict[str, int]] = field(default_factory=dict)
    custom_metrics: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "total_cycles": self.total_cycles,
            "successful_cycles": self.successful_cycles,
            "rolled_back_cycles": self.rolled_back_cycles,
            "avg_quality_delta": round(self.avg_quality_delta, 4),
            "avg_latency_delta_ms": round(self.avg_latency_delta_ms, 1),
            "effectiveness_rate": round(self.effectiveness_rate, 4),
            "action_stats": self.action_stats,
            "custom_metrics": self.custom_metrics,
        }


@dataclass
class CrossSessionTrend:
    metric_name: str = ""
    values: list[tuple[float, float]] = field(default_factory=list)
    trend_direction: str = "stable"
    trend_strength: float = 0.0
    period_count: int = 0


@dataclass
class LoopSnapshot:
    snapshot_id: str = ""
    timestamp: float = 0.0
    session_id: str = ""
    total_sessions: int = 0
    aggregated_metrics: dict[str, float] = field(default_factory=dict)
    session_metrics_list: list[dict[str, Any]] = field(default_factory=list)
    label: str = ""


class CrossSessionLoopManager:
    """跨会话闭环管理器：持久化闭环指标，支持跨会话进化经验共享。"""

    def __init__(
        self,
        data_dir: str | Path | None = None,
        persistence_service: Any | None = None,
    ) -> None:
        if data_dir:
            self._data_dir = Path(data_dir)
        else:
            self._data_dir = Path(
                __file__
            ).resolve().parent.parent.parent / "data" / "cross_session_loop"
        self._data_dir.mkdir(parents=True, exist_ok=True)

        self._persistence = persistence_service
        self._sessions_path = self._data_dir / "session_metrics.jsonl"
        self._snapshots_path = self._data_dir / "snapshots.jsonl"
        self._aggregated_path = self._data_dir / "aggregated.json"

        self._session_metrics: dict[str, SessionMetrics] = {}
        self._snapshots: list[LoopSnapshot] = []
        self._current_session_id: str = ""
        self._max_snapshots = 50
        self._MAX_SESSION_METRICS = 5000

        self._load()

    def begin_session(self, session_id: str) -> SessionMetrics:
        self._current_session_id = session_id
        if session_id in self._session_metrics:
            return self._session_metrics[session_id]

        metrics = SessionMetrics(
            session_id=session_id,
            start_time=time.time(),
        )
        self._session_metrics[session_id] = metrics
        if len(self._session_metrics) > self._MAX_SESSION_METRICS:
            sorted_sessions = sorted(self._session_metrics.items(), key=lambda x: x[1].start_time)
            to_remove = sorted_sessions[: len(self._session_metrics) - (self._MAX_SESSION_METRICS * 3 // 4)]
            for sid, _ in to_remove:
                del self._session_metrics[sid]
        self._append_session(metrics)
        log.info("Session began", session_id=session_id)
        return metrics

    def end_session(self, session_id: str) -> SessionMetrics | None:
        metrics = self._session_metrics.get(session_id)
        if metrics is None:
            return None
        metrics.end_time = time.time()
        self._append_session(metrics)
        self._save_aggregated()
        log.info(
            "Session ended",
            session_id=session_id,
            total_cycles=metrics.total_cycles,
            effectiveness=metrics.effectiveness_rate,
        )
        return metrics

    def update_session_metrics(
        self,
        session_id: str,
        total_cycles: int | None = None,
        successful_cycles: int | None = None,
        rolled_back_cycles: int | None = None,
        avg_quality_delta: float | None = None,
        avg_latency_delta_ms: float | None = None,
        effectiveness_rate: float | None = None,
        action_stats: dict[str, dict[str, int]] | None = None,
        custom_metrics: dict[str, float] | None = None,
    ) -> SessionMetrics | None:
        metrics = self._session_metrics.get(session_id)
        if metrics is None:
            return None

        if total_cycles is not None:
            metrics.total_cycles = total_cycles
        if successful_cycles is not None:
            metrics.successful_cycles = successful_cycles
        if rolled_back_cycles is not None:
            metrics.rolled_back_cycles = rolled_back_cycles
        if avg_quality_delta is not None:
            metrics.avg_quality_delta = avg_quality_delta
        if avg_latency_delta_ms is not None:
            metrics.avg_latency_delta_ms = avg_latency_delta_ms
        if effectiveness_rate is not None:
            metrics.effectiveness_rate = effectiveness_rate
        if action_stats is not None:
            metrics.action_stats = action_stats
        if custom_metrics is not None:
            metrics.custom_metrics.update(custom_metrics)

        return metrics

    def ingest_from_closed_loop(self, session_id: str, closed_loop: Any) -> None:
        try:
            eff = closed_loop.get_effectiveness_metrics()
            self.update_session_metrics(
                session_id=session_id,
                total_cycles=eff.total_cycles,
                successful_cycles=eff.successful_cycles,
                rolled_back_cycles=eff.rolled_back_cycles,
                avg_quality_delta=eff.avg_quality_delta,
                avg_latency_delta_ms=eff.avg_latency_delta_ms,
                effectiveness_rate=eff.effectiveness_rate,
                action_stats=eff.action_stats,
            )
        except Exception as e:
            log.debug("Failed to ingest from closed loop", error=str(e))

    def get_session(self, session_id: str) -> SessionMetrics | None:
        return self._session_metrics.get(session_id)

    def get_all_sessions(self) -> list[SessionMetrics]:
        return list(self._session_metrics.values())

    def get_recent_sessions(self, limit: int = 10) -> list[SessionMetrics]:
        sessions = sorted(
            self._session_metrics.values(),
            key=lambda s: s.start_time,
            reverse=True,
        )
        return sessions[:limit]

    def compute_aggregated_metrics(self) -> dict[str, float]:
        sessions = list(self._session_metrics.values())
        if not sessions:
            return {}

        total_cycles = sum(s.total_cycles for s in sessions)
        total_successful = sum(s.successful_cycles for s in sessions)
        total_rolled_back = sum(s.rolled_back_cycles for s in sessions)

        quality_deltas = [s.avg_quality_delta for s in sessions if s.total_cycles > 0]
        latency_deltas = [s.avg_latency_delta_ms for s in sessions if s.total_cycles > 0]
        effectiveness_rates = [s.effectiveness_rate for s in sessions if s.total_cycles > 0]

        merged_action_stats: dict[str, dict[str, int]] = {}
        for s in sessions:
            for action, stats in s.action_stats.items():
                if action not in merged_action_stats:
                    merged_action_stats[action] = {}
                for key, val in stats.items():
                    merged_action_stats[action][key] = merged_action_stats[action].get(key, 0) + val

        return {
            "total_sessions": len(sessions),
            "total_cycles": total_cycles,
            "total_successful_cycles": total_successful,
            "total_rolled_back_cycles": total_rolled_back,
            "overall_effectiveness_rate": total_successful / total_cycles if total_cycles > 0 else 0.0,
            "avg_quality_delta": sum(quality_deltas) / len(quality_deltas) if quality_deltas else 0.0,
            "avg_latency_delta_ms": sum(latency_deltas) / len(latency_deltas) if latency_deltas else 0.0,
            "avg_session_effectiveness": sum(effectiveness_rates) / len(effectiveness_rates) if effectiveness_rates else 0.0,
        }

    def compute_trends(self, metric_name: str = "effectiveness_rate") -> CrossSessionTrend:
        sessions = sorted(self._session_metrics.values(), key=lambda s: s.start_time)
        values: list[tuple[float, float]] = []

        for s in sessions:
            if s.total_cycles == 0:
                continue
            if metric_name == "effectiveness_rate":
                values.append((s.start_time, s.effectiveness_rate))
            elif metric_name == "avg_quality_delta":
                values.append((s.start_time, s.avg_quality_delta))
            elif metric_name == "avg_latency_delta_ms":
                values.append((s.start_time, s.avg_latency_delta_ms))
            elif metric_name in s.custom_metrics:
                values.append((s.start_time, s.custom_metrics[metric_name]))

        if len(values) < 2:
            return CrossSessionTrend(
                metric_name=metric_name,
                values=values,
                trend_direction="stable",
                trend_strength=0.0,
                period_count=len(values),
            )

        first_val = values[0][1]
        last_val = values[-1][1]
        diff = last_val - first_val
        range_val = max(abs(first_val), abs(last_val), 0.001)

        if diff > range_val * 0.05:
            direction = "improving"
        elif diff < -range_val * 0.05:
            direction = "declining"
        else:
            direction = "stable"

        strength = min(1.0, abs(diff) / range_val)

        return CrossSessionTrend(
            metric_name=metric_name,
            values=values,
            trend_direction=direction,
            trend_strength=strength,
            period_count=len(values),
        )

    def save_snapshot(self, label: str = "") -> str:
        snapshot_id = f"snap_{int(time.time())}"
        aggregated = self.compute_aggregated_metrics()
        session_list = [s.to_dict() for s in self._session_metrics.values()]

        snapshot = LoopSnapshot(
            snapshot_id=snapshot_id,
            timestamp=time.time(),
            session_id=self._current_session_id,
            total_sessions=len(self._session_metrics),
            aggregated_metrics=aggregated,
            session_metrics_list=session_list,
            label=label,
        )

        self._snapshots.append(snapshot)
        if len(self._snapshots) > self._max_snapshots:
            self._snapshots = self._snapshots[-self._max_snapshots:]

        self._append_snapshot(snapshot)
        log.info("Snapshot saved", snapshot_id=snapshot_id, label=label)
        return snapshot_id

    def get_snapshots(self) -> list[LoopSnapshot]:
        return list(self._snapshots)

    def get_latest_snapshot(self) -> LoopSnapshot | None:
        return self._snapshots[-1] if self._snapshots else None

    def _append_session(self, metrics: SessionMetrics) -> None:
        try:
            line = json.dumps(metrics.to_dict(), ensure_ascii=False) + "\n"
            with open(self._sessions_path, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception as e:
            log.debug("Failed to append session metrics", error=str(e))

    def _append_snapshot(self, snapshot: LoopSnapshot) -> None:
        try:
            data = {
                "snapshot_id": snapshot.snapshot_id,
                "timestamp": snapshot.timestamp,
                "session_id": snapshot.session_id,
                "total_sessions": snapshot.total_sessions,
                "aggregated_metrics": snapshot.aggregated_metrics,
                "label": snapshot.label,
            }
            line = json.dumps(data, ensure_ascii=False) + "\n"
            with open(self._snapshots_path, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception as e:
            log.debug("Failed to append snapshot", error=str(e))

    def _save_aggregated(self) -> None:
        try:
            aggregated = self.compute_aggregated_metrics()
            tmp_path = self._aggregated_path.with_suffix(".json.tmp")
            tmp_path.write_text(
                json.dumps(aggregated, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp_path.replace(self._aggregated_path)
        except Exception as e:
            log.debug("Failed to save aggregated metrics", error=str(e))

    def _load(self) -> None:
        if self._sessions_path.exists():
            try:
                lines = self._sessions_path.read_text(encoding="utf-8").strip().split("\n")
                for line in lines:
                    if not line.strip():
                        continue
                    raw = json.loads(line)
                    sid = raw.get("session_id", "")
                    if sid:
                        self._session_metrics[sid] = SessionMetrics(
                            session_id=sid,
                            start_time=raw.get("start_time", 0.0),
                            end_time=raw.get("end_time", 0.0),
                            total_cycles=raw.get("total_cycles", 0),
                            successful_cycles=raw.get("successful_cycles", 0),
                            rolled_back_cycles=raw.get("rolled_back_cycles", 0),
                            avg_quality_delta=raw.get("avg_quality_delta", 0.0),
                            avg_latency_delta_ms=raw.get("avg_latency_delta_ms", 0.0),
                            effectiveness_rate=raw.get("effectiveness_rate", 0.0),
                            action_stats=raw.get("action_stats", {}),
                            custom_metrics=raw.get("custom_metrics", {}),
                        )
            except Exception as e:
                log.debug("Failed to load session metrics", error=str(e))

        if self._snapshots_path.exists():
            try:
                lines = self._snapshots_path.read_text(encoding="utf-8").strip().split("\n")
                for line in lines:
                    if not line.strip():
                        continue
                    raw = json.loads(line)
                    self._snapshots.append(LoopSnapshot(
                        snapshot_id=raw.get("snapshot_id", ""),
                        timestamp=raw.get("timestamp", 0.0),
                        session_id=raw.get("session_id", ""),
                        total_sessions=raw.get("total_sessions", 0),
                        aggregated_metrics=raw.get("aggregated_metrics", {}),
                        label=raw.get("label", ""),
                    ))
            except Exception as e:
                log.debug("Failed to load snapshots", error=str(e))

    def get_stats(self) -> dict[str, Any]:
        aggregated = self.compute_aggregated_metrics()
        return {
            "total_sessions": len(self._session_metrics),
            "snapshots_count": len(self._snapshots),
            "current_session_id": self._current_session_id,
            "aggregated": aggregated,
        }
