"""工具调用反馈收集器，为Evolution引擎提供训练数据。

收集工具调用的成功/失败/耗时/用户评价等数据，
聚合为进化引擎可消费的训练样本。

@module feedback_collector
@version 0.1.0
@since 2026-08-02
"""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("feedback_collector")


# 内存缓冲区大小阈值，达到此数量触发 flush
_BUFFER_FLUSH_SIZE = 100

# 定时 flush 间隔（秒）
_FLUSH_INTERVAL_SEC = 30


@dataclass
class ToolCallRecord:
    """工具调用记录。

    Attributes:
        tool_name: 工具名称。
        success: 是否成功。
        duration: 执行耗时（秒）。
        error: 错误信息，成功时为 None。
        context_hash: 调用上下文摘要的哈希值。
        timestamp: 调用时间戳。
    """

    tool_name: str
    success: bool
    duration: float
    error: str | None = None
    context_hash: str = ""
    timestamp: float = 0.0


@dataclass
class UserFeedbackRecord:
    """用户评价记录。

    Attributes:
        tool_name: 工具名称。
        rating: 评分（1-5）。
        comment: 评价内容。
        timestamp: 评价时间戳。
    """

    tool_name: str
    rating: int
    comment: str = ""
    timestamp: float = 0.0


@dataclass
class ToolAggregatedStats:
    """工具聚合统计。

    Attributes:
        tool_name: 工具名称。
        total_calls: 总调用次数。
        success_count: 成功次数。
        avg_duration: 平均耗时（秒）。
        failure_rate: 失败率（0-1）。
        avg_rating: 平均用户评分。
        rating_count: 评分数量。
    """

    tool_name: str = ""
    total_calls: int = 0
    success_count: int = 0
    avg_duration: float = 0.0
    failure_rate: float = 0.0
    avg_rating: float = 0.0
    rating_count: int = 0


class FeedbackCollector:
    """工具调用反馈收集器，为Evolution引擎提供训练数据。

    收集工具调用的成功/失败/耗时/用户评价等数据，
    聚合为进化引擎可消费的训练样本。

    Attributes:
        _store: 反馈数据存储（SQLite）。
        _buffer: 内存缓冲区（批量写入）。

    Usage:
        collector = FeedbackCollector()
        collector.record_tool_call("file_read", True, 0.5)
        stats = collector.get_aggregated_stats()
    """

    _instance: FeedbackCollector | None = None

    def __init__(self, db_path: str | None = None) -> None:
        if db_path is None:
            data_dir = Path(__file__).resolve().parent.parent.parent / "data" / "feedback"
            data_dir.mkdir(parents=True, exist_ok=True)
            db_path = str(data_dir / "feedback.db")
        self._db_path = db_path
        self._buffer: list[ToolCallRecord] = []
        self._feedback_buffer: list[UserFeedbackRecord] = []
        self._last_flush_time = time.time()
        self._flush_task: asyncio.Task | None = None
        self._MAX_BUFFER = 5000
        self._MAX_FEEDBACK_BUFFER = 5000
        self._init_db()

    @classmethod
    def get_instance(cls, db_path: str | None = None) -> FeedbackCollector:
        """获取单例实例。

        Args:
            db_path: 数据库文件路径，为 None 时使用默认路径。

        Returns:
            FeedbackCollector: 单例实例。
        """
        if cls._instance is None:
            cls._instance = cls(db_path=db_path)
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """重置单例实例（测试用）。"""
        cls._instance = None

    def _init_db(self) -> None:
        """初始化SQLite数据库表结构。"""
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS tool_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool_name TEXT NOT NULL,
                    success INTEGER NOT NULL,
                    duration REAL NOT NULL,
                    error TEXT,
                    context_hash TEXT DEFAULT '',
                    timestamp REAL NOT NULL
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_tool_calls_name
                ON tool_calls(tool_name)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_tool_calls_ts
                ON tool_calls(timestamp)
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS user_feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool_name TEXT NOT NULL,
                    rating INTEGER NOT NULL,
                    comment TEXT DEFAULT '',
                    timestamp REAL NOT NULL
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_user_feedback_name
                ON user_feedback(tool_name)
            """)

    def record_tool_call(
        self,
        tool_name: str,
        success: bool,
        duration: float,
        error: str | None = None,
        context_summary: str = "",
    ) -> None:
        """记录单次工具调用。

        Args:
            tool_name: 工具名称。
            success: 是否成功。
            duration: 执行耗时（秒）。
            error: 错误信息，成功时为 None。
            context_summary: 调用上下文摘要。
        """
        context_hash = hashlib.md5(context_summary.encode()).hexdigest()[:12] if context_summary else ""
        record = ToolCallRecord(
            tool_name=tool_name,
            success=success,
            duration=duration,
            error=error,
            context_hash=context_hash,
            timestamp=time.time(),
        )
        self._buffer.append(record)
        if len(self._buffer) > self._MAX_BUFFER:
            self._buffer = self._buffer[-self._MAX_BUFFER * 3 // 4:]
        if len(self._buffer) >= _BUFFER_FLUSH_SIZE:
            self.flush()

    def record_user_feedback(
        self,
        tool_name: str,
        rating: int,
        comment: str = "",
    ) -> None:
        """记录用户对工具结果的评价。

        Args:
            tool_name: 工具名称。
            rating: 评分（1-5）。
            comment: 评价内容。
        """
        rating = max(1, min(5, rating))
        record = UserFeedbackRecord(
            tool_name=tool_name,
            rating=rating,
            comment=comment,
            timestamp=time.time(),
        )
        self._feedback_buffer.append(record)
        if len(self._feedback_buffer) > self._MAX_FEEDBACK_BUFFER:
            self._feedback_buffer = self._feedback_buffer[-self._MAX_FEEDBACK_BUFFER * 3 // 4:]
        self._flush_feedback()
        log.debug("用户评价已记录", tool=tool_name, rating=rating)

    def flush(self) -> None:
        """将内存缓冲区的工具调用记录批量写入磁盘。"""
        if not self._buffer:
            return
        records = self._buffer[:]
        self._buffer.clear()
        self._last_flush_time = time.time()
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.executemany(
                    "INSERT INTO tool_calls (tool_name, success, duration, error, context_hash, timestamp) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    [
                        (r.tool_name, int(r.success), r.duration, r.error, r.context_hash, r.timestamp)
                        for r in records
                    ],
                )
            log.debug("工具调用缓冲区已flush", count=len(records))
        except Exception as e:
            log.warning("flush工具调用记录失败", error=str(e))
            self._buffer.extend(records)

    def _flush_feedback(self) -> None:
        """将用户评价缓冲区写入磁盘。"""
        if not self._feedback_buffer:
            return
        records = self._feedback_buffer[:]
        self._feedback_buffer.clear()
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.executemany(
                    "INSERT INTO user_feedback (tool_name, rating, comment, timestamp) "
                    "VALUES (?, ?, ?, ?)",
                    [(r.tool_name, r.rating, r.comment, r.timestamp) for r in records],
                )
        except Exception as e:
            log.warning("flush用户评价记录失败", error=str(e))
            self._feedback_buffer.extend(records)

    def maybe_flush(self) -> None:
        """检查是否需要定时flush。"""
        if time.time() - self._last_flush_time >= _FLUSH_INTERVAL_SEC:
            self.flush()

    def get_training_data(self, tool_name: str, limit: int = 100) -> list[dict[str, Any]]:
        """获取指定工具的训练数据。

        Args:
            tool_name: 工具名称。
            limit: 最大返回条数。

        Returns:
            训练样本列表，每项包含调用结果和用户评价。
        """
        self.flush()
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    "SELECT tool_name, success, duration, error, context_hash, timestamp "
                    "FROM tool_calls WHERE tool_name = ? ORDER BY timestamp DESC LIMIT ?",
                    (tool_name, limit),
                ).fetchall()
                result = [dict(r) for r in rows]
                for item in result:
                    item["success"] = bool(item["success"])
                feedback_rows = conn.execute(
                    "SELECT rating, comment, timestamp FROM user_feedback "
                    "WHERE tool_name = ? ORDER BY timestamp DESC LIMIT ?",
                    (tool_name, limit),
                ).fetchall()
                result.append({"user_feedback": [dict(r) for r in feedback_rows]})
                return result
        except Exception as e:
            log.warning("获取训练数据失败", tool=tool_name, error=str(e))
            return []

    def get_aggregated_stats(self) -> list[ToolAggregatedStats]:
        """获取所有工具的聚合统计。

        Returns:
            按工具名称聚合的统计列表。
        """
        self.flush()
        try:
            with sqlite3.connect(self._db_path) as conn:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    "SELECT tool_name, "
                    "COUNT(*) AS total_calls, "
                    "SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS success_count, "
                    "AVG(duration) AS avg_duration "
                    "FROM tool_calls GROUP BY tool_name"
                ).fetchall()
                rating_rows = conn.execute(
                    "SELECT tool_name, AVG(rating) AS avg_rating, COUNT(*) AS rating_count "
                    "FROM user_feedback GROUP BY tool_name"
                ).fetchall()
                rating_map = {r["tool_name"]: dict(r) for r in rating_rows}
                stats_list: list[ToolAggregatedStats] = []
                for row in rows:
                    calls = row["total_calls"]
                    successes = row["success_count"]
                    failure_rate = (calls - successes) / calls if calls > 0 else 0.0
                    rating_info = rating_map.get(row["tool_name"], {})
                    stats_list.append(ToolAggregatedStats(
                        tool_name=row["tool_name"],
                        total_calls=calls,
                        success_count=successes,
                        avg_duration=round(row["avg_duration"] or 0.0, 4),
                        failure_rate=round(failure_rate, 4),
                        avg_rating=round(rating_info.get("avg_rating", 0.0), 2),
                        rating_count=rating_info.get("rating_count", 0),
                    ))
                return stats_list
        except Exception as e:
            log.warning("获取聚合统计失败", error=str(e))
            return []

    def export_for_evolution(self) -> dict[str, Any]:
        """导出为Evolution引擎可消费的格式。

        Returns:
            包含工具权重调整建议和训练摘要的字典。
        """
        stats_list = self.get_aggregated_stats()
        weight_adjustments: dict[str, float] = {}
        for stats in stats_list:
            if stats.total_calls < 2:
                continue
            success_rate = stats.success_count / stats.total_calls
            duration_penalty = min(stats.avg_duration / 10.0, 0.3)
            rating_bonus = (stats.avg_rating - 3.0) / 5.0 if stats.rating_count > 0 else 0.0
            weight = max(0.1, min(1.5, success_rate - duration_penalty + rating_bonus))
            weight_adjustments[stats.tool_name] = round(weight, 3)
        return {
            "weight_adjustments": weight_adjustments,
            "tool_stats": [
                {
                    "tool_name": s.tool_name,
                    "total_calls": s.total_calls,
                    "success_rate": round(s.success_count / s.total_calls, 3) if s.total_calls > 0 else 0.0,
                    "avg_duration": s.avg_duration,
                    "failure_rate": s.failure_rate,
                    "avg_rating": s.avg_rating,
                }
                for s in stats_list
            ],
            "export_timestamp": time.time(),
        }

    def close(self) -> None:
        """关闭收集器，flush剩余缓冲区。"""
        self.flush()
        self._flush_feedback()
