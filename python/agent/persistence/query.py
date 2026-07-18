from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.persistence.trajectory import (
    ExecutionRecord,
    ToolDurationStats,
    ToolInvocationRecord,
    TrajectoryDatabase,
)


@dataclass
class ToolSuccessRate:
    """工具成功率统计。

    Attributes:
        total: 总调用次数。
        success: 成功次数。
        rate: 成功率（0-1）。
    """

    total: int = 0
    success: int = 0
    rate: float = 0.0


@dataclass
class HourlyQuality:
    """小时级质量统计。

    Attributes:
        hour: 小时（0-23）。
        avg_score: 平均评分。
        count: 调用次数。
    """

    hour: int = 0
    avg_score: float = 0.0
    count: int = 0


@dataclass
class DailyTrend:
    """日趋势统计。

    Attributes:
        date: 日期字符串。
        avg_score: 平均评分。
        avg_duration: 平均耗时。
        count: 执行次数。
    """

    date: str = ""
    avg_score: float = 0.0
    avg_duration: float = 0.0
    count: int = 0


class TrajectoryQueryService:
    """轨迹查询服务——提供统计分析查询功能。

    基于轨迹数据库提供工具成功率、质量趋势、错误模式等分析查询。

    Usage:
        db = TrajectoryDatabase()
        query = TrajectoryQueryService(db)
        rates = query.get_tool_success_rates()
        trends = query.get_daily_quality_trends(days=7)
    """
    def __init__(self, db: TrajectoryDatabase) -> None:
        self.db = db

    def get_failed_executions(
        self,
        category: str | None = None,
        limit: int = 50,
    ) -> list[ExecutionRecord]:
        recent = self.db.get_recent_executions(1000)
        failed = [e for e in recent if e.status in ("failed", "aborted")]

        if category:
            cat_lower = category.lower()
            failed = [e for e in failed if cat_lower in e.input.lower()]

        return failed[:limit]

    def get_tool_success_rates(
        self,
        since_ms: int | None = None,
    ) -> dict[str, ToolSuccessRate]:
        cutoff = since_ms or int((time.time() - 7 * 86400) * 1000)
        recent = self.db.get_recent_executions(1000)
        exec_ids = {e.id for e in recent if e.created_at >= cutoff}

        if not exec_ids:
            return {}

        raw_stats: dict[str, dict[str, int]] = {}
        for exec_id in exec_ids:
            for inv in self.db.get_tool_invocations(exec_id):
                name = inv.tool_name
                if name not in raw_stats:
                    raw_stats[name] = {"total": 0, "success": 0}
                raw_stats[name]["total"] += 1
                if inv.result_success == 1:
                    raw_stats[name]["success"] += 1

        result: dict[str, ToolSuccessRate] = {}
        for name, s in raw_stats.items():
            rate = s["success"] / s["total"] if s["total"] > 0 else 0.0
            result[name] = ToolSuccessRate(total=s["total"], success=s["success"], rate=rate)

        return result

    def get_average_quality_by_hour(self) -> list[HourlyQuality]:
        recent = self.db.get_recent_executions(500)
        scored = [e for e in recent if e.quality_overall is not None]

        if not scored:
            return [HourlyQuality(hour=h) for h in range(24)]

        buckets: dict[int, dict[str, float]] = {}
        for exec_rec in scored:
            dt = time.localtime(exec_rec.created_at / 1000)
            hour = dt.tm_hour
            if hour not in buckets:
                buckets[hour] = {"total": 0.0, "count": 0.0}
            buckets[hour]["total"] += exec_rec.quality_overall or 0
            buckets[hour]["count"] += 1

        return [
            HourlyQuality(
                hour=h,
                avg_score=buckets[h]["total"] / buckets[h]["count"] if h in buckets else 0.0,
                count=int(buckets[h]["count"]) if h in buckets else 0,
            )
            for h in range(24)
        ]

    def get_recent_trend(self, days: int = 7) -> list[DailyTrend]:
        cutoff_ms = int((time.time() - days * 86400) * 1000)
        recent = self.db.get_recent_executions(1000)

        day_buckets: dict[str, dict[str, Any]] = {}
        for exec_rec in recent:
            if exec_rec.created_at < cutoff_ms:
                continue
            dt = time.localtime(exec_rec.created_at / 1000)
            date_str = time.strftime("%Y-%m-%d", dt)

            if date_str not in day_buckets:
                day_buckets[date_str] = {"total_score": 0.0, "total_duration": 0, "count": 0}
            day_buckets[date_str]["count"] += 1
            day_buckets[date_str]["total_duration"] += exec_rec.total_duration
            if exec_rec.quality_overall is not None:
                day_buckets[date_str]["total_score"] += exec_rec.quality_overall

        result: list[DailyTrend] = []
        for date_str, b in sorted(day_buckets.items()):
            result.append(DailyTrend(
                date=date_str,
                avg_score=b["total_score"] / b["count"] if b["count"] > 0 else 0.0,
                avg_duration=b["total_duration"] / b["count"] if b["count"] > 0 else 0.0,
                count=b["count"],
            ))

        return result

    def get_tool_duration_percentiles(
        self,
        success_only: bool = True,
        limit_per_tool: int = 100,
    ) -> dict[str, ToolDurationStats]:
        """获取所有工具的执行耗时百分位统计。

        P2 #15: 遍历近期执行记录中的工具调用，按工具名聚合后调用
        TrajectoryDatabase.estimate_tool_time 获取每个工具的 p50/p90/p99
        耗时分布。用于时间预算预估和工具性能监控。

        Args:
            success_only: True 时仅统计成功调用，False 时包含失败调用。
            limit_per_tool: 每个工具最多采样的历史记录数。

        Returns:
            dict[str, ToolDurationStats]: 工具名到耗时统计的映射；
                样本不足（<2）的工具不包含在结果中。
        """
        recent = self.db.get_recent_executions(1000)
        tool_names: set[str] = set()
        for exec_rec in recent:
            for inv in self.db.get_tool_invocations(exec_rec.id):
                tool_names.add(inv.tool_name)

        result: dict[str, ToolDurationStats] = {}
        for name in tool_names:
            stats = self.db.estimate_tool_time(
                name,
                success_only=success_only,
                limit=limit_per_tool,
            )
            if stats is not None:
                result[name] = stats

        return result
