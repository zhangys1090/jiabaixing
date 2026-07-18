from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.persistence.database import get_sync_connection


@dataclass
class ExecutionRecord:
    """执行记录——一次完整的Agent交互执行。

    Attributes:
        id: 唯一标识。
        user_id: 用户ID。
        input: 用户输入。
        response: Agent响应。
        intent: 识别的意图。
        status: 执行状态（success/failed）。
        quality_overall: 综合质量评分。
        loop_rounds: 循环轮次。
        total_tool_calls: 工具调用总数。
        total_duration: 总耗时（毫秒）。
        created_at: 创建时间戳。
        updated_at: 更新时间戳。
        task_type: 任务类型标识（用于时间预算预估分类）。
    """

    id: str = ""
    user_id: str | None = None
    input: str = ""
    response: str | None = None
    intent: str | None = None
    status: str = "failed"
    quality_overall: float | None = None
    loop_rounds: int = 0
    total_tool_calls: int = 0
    total_duration: int = 0
    created_at: int = 0
    updated_at: int = 0
    task_type: str | None = None


@dataclass
class ToolInvocationRecord:
    """工具调用记录——单次工具执行详情。

    Attributes:
        id: 记录ID。
        execution_id: 所属执行记录ID。
        step_index: 执行步骤序号。
        tool_name: 工具名称。
        args_json: 参数JSON。
        result_success: 是否成功（0/1）。
        result_output: 输出结果。
        duration: 耗时（毫秒）。
        error_message: 错误信息。
        created_at: 创建时间戳。
    """

    id: int | None = None
    execution_id: str = ""
    step_index: int = 0
    tool_name: str = ""
    args_json: str = ""
    result_success: int = 0
    result_output: str | None = None
    duration: int = 0
    error_message: str | None = None
    created_at: int = 0


@dataclass
class StateTransitionRecord:
    """状态转换记录——Agent状态机转换历史。

    Attributes:
        id: 记录ID。
        execution_id: 所属执行记录ID。
        from_state: 源状态。
        to_state: 目标状态。
        reason: 转换原因。
        created_at: 创建时间戳。
    """

    id: int | None = None
    execution_id: str = ""
    from_state: str = ""
    to_state: str = ""
    reason: str | None = None
    created_at: int = 0


@dataclass
class ContextSnapshotRecord:
    """上下文快照记录——执行过程中的上下文状态。

    Attributes:
        id: 记录ID。
        execution_id: 所属执行记录ID。
        phase: 执行阶段。
        step_index: 步骤序号。
        snapshot_json: 快照JSON。
        token_count: Token数量。
        duration_ms: 耗时（毫秒）。
        created_at: 创建时间戳。
    """

    id: int | None = None
    execution_id: str = ""
    phase: str = ""
    step_index: int = 0
    snapshot_json: str = ""
    token_count: int | None = None
    duration_ms: int | None = None
    created_at: int = 0


@dataclass
class LLMOutputRecord:
    """LLM输出记录——模型调用详情。

    Attributes:
        id: 记录ID。
        execution_id: 所属执行记录ID。
        step_index: 步骤序号。
        prompt_tokens: 提示词Token数。
        completion_tokens: 补全Token数。
        model_name: 模型名称。
        raw_output: 原始输出。
        duration_ms: 耗时（毫秒）。
        created_at: 创建时间戳。
    """

    id: int | None = None
    execution_id: str = ""
    step_index: int = 0
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    model_name: str | None = None
    raw_output: str | None = None
    duration_ms: int | None = None
    created_at: int = 0


@dataclass
class EvaluationResultRecord:
    """评估结果记录——执行质量评估详情。

    Attributes:
        id: 记录ID。
        execution_id: 所属执行记录ID。
        step_index: 步骤序号。
        phase: 评估阶段。
        task_completion: 任务完成度。
        data_groundedness: 数据准确性。
        safety_risk_level: 安全风险等级。
        suggested_action: 建议操作。
        goal_progress: 目标进度。
        summary: 评估摘要。
        created_at: 创建时间戳。
    """

    id: int | None = None
    execution_id: str = ""
    step_index: int = 0
    phase: str = ""
    task_completion: float | None = None
    data_groundedness: float | None = None
    safety_risk_level: str | None = None
    suggested_action: str | None = None
    goal_progress: float | None = None
    summary: str | None = None
    created_at: int = 0


@dataclass
class ExecutionStats:
    """执行统计——聚合统计数据。

    Attributes:
        total: 总执行次数。
        success_rate: 成功率。
        avg_duration: 平均耗时。
        avg_score: 平均评分。
    """

    total: int = 0
    success_rate: float = 0.0
    avg_duration: float = 0.0
    avg_score: float = 0.0


@dataclass
class ExecutionEstimate:
    """执行时间预估结果——基于历史数据预测单次任务耗时。

    修正 TS 侧 TrajectoryDatabase.estimateExecutionTime 的缺陷：
    - 增加置信度字段（TS 侧无置信度）。
    - task_type 真正参与 SQL 过滤（TS 侧参数被忽略）。

    Attributes:
        task_type: 任务类型标识。
        estimated_ms: 预估耗时（毫秒，已按复杂度调整）。
        p50: 50 分位数（中位数）。
        p90: 90 分位数。
        p99: 99 分位数。
        sample_count: 样本数量。
        confidence: 置信度（low/medium/high）。
        complexity: 复杂度因子（0.0-1.0），None 表示未应用复杂度调整。
    """

    task_type: str
    estimated_ms: int
    p50: int
    p90: int
    p99: int
    sample_count: int
    confidence: str
    complexity: float | None = None


@dataclass
class ToolDurationStats:
    """工具执行耗时统计——单工具的历史调用耗时分布。

    修正 TS 侧 TrajectoryDatabase.estimateToolTime 的缺陷：
    - 增加 P99 分位数（TS 侧仅返回 p50/p90）。
    - 增加成功率字段。
    - 支持 success_only 过滤失败样本（TS 侧未过滤）。

    Attributes:
        tool_name: 工具名称。
        estimated_ms: 预估耗时（毫秒，平均值）。
        p50: 50 分位数。
        p90: 90 分位数。
        p99: 99 分位数。
        sample_count: 样本数量。
        success_rate: 成功率（0-1）。
    """

    tool_name: str
    estimated_ms: int
    p50: int
    p90: int
    p99: int
    sample_count: int
    success_rate: float


class TrajectoryDatabase:
    """轨迹数据库——持久化Agent执行轨迹和统计数据。

    基于SQLite存储执行记录、工具调用、状态转换、上下文快照、
    LLM输出和评估结果。支持CRUD操作和统计分析。

    Usage:
        db = TrajectoryDatabase()
        execution_id = db.save_execution(input_text, response_text, status="success")
        records = db.query_executions(limit=10)
        stats = db.get_stats()
    """
    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DATA_DIR / "trajectory.db"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn: sqlite3.Connection | None = None
        self._connect()

    def _connect(self) -> None:
        try:
            self._conn = get_sync_connection(db_path=str(self._path), check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._init_tables()
        except Exception:
            self._conn = None

    def _init_tables(self) -> None:
        if not self._conn:
            return
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS executions (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                input TEXT NOT NULL,
                response TEXT,
                intent TEXT,
                status TEXT NOT NULL DEFAULT 'failed',
                quality_overall REAL,
                loop_rounds INTEGER DEFAULT 0,
                total_tool_calls INTEGER DEFAULT 0,
                total_duration INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tool_invocations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                tool_name TEXT NOT NULL,
                args_json TEXT NOT NULL,
                result_success INTEGER NOT NULL DEFAULT 0,
                result_output TEXT,
                duration INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS state_transitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL,
                from_state TEXT NOT NULL,
                to_state TEXT NOT NULL,
                reason TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS context_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL,
                phase TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL,
                token_count INTEGER,
                duration_ms INTEGER,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS llm_outputs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                model_name TEXT,
                raw_output TEXT,
                duration_ms INTEGER,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS evaluation_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                phase TEXT NOT NULL,
                task_completion REAL,
                data_groundedness REAL,
                safety_risk_level TEXT,
                suggested_action TEXT,
                goal_progress REAL,
                summary TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_tool_inv_exec ON tool_invocations(execution_id);
            CREATE INDEX IF NOT EXISTS idx_tool_inv_name ON tool_invocations(tool_name);
            CREATE INDEX IF NOT EXISTS idx_state_trans_exec ON state_transitions(execution_id);
            CREATE INDEX IF NOT EXISTS idx_ctx_snap_exec ON context_snapshots(execution_id);
            CREATE INDEX IF NOT EXISTS idx_ctx_snap_phase ON context_snapshots(phase);
            CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status);
            CREATE INDEX IF NOT EXISTS idx_exec_created ON executions(created_at);
            CREATE INDEX IF NOT EXISTS idx_llm_out_exec ON llm_outputs(execution_id);
            CREATE INDEX IF NOT EXISTS idx_eval_res_exec ON evaluation_results(execution_id);
            CREATE INDEX IF NOT EXISTS idx_eval_res_safety ON evaluation_results(safety_risk_level);
        """)

        try:
            self._conn.execute("ALTER TABLE executions ADD COLUMN embedding TEXT")
        except sqlite3.OperationalError:
            pass

        # P2 #15: 为时间预算预估新增 task_type 列（向后兼容，旧库自动补列）
        try:
            self._conn.execute("ALTER TABLE executions ADD COLUMN task_type TEXT")
        except sqlite3.OperationalError:
            pass

        # 为 task_type 过滤创建索引，加速 estimate_execution_time 查询
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_exec_task_type ON executions(task_type)"
        )

        self._conn.commit()

    def record_execution(self, rec: ExecutionRecord) -> None:
        if not self._conn:
            return
        now = int(time.time() * 1000)
        if not rec.id:
            rec.id = f"exec_{uuid.uuid4().hex}"
        if not rec.created_at:
            rec.created_at = now
        if not rec.updated_at:
            rec.updated_at = now

        self._conn.execute(
            """INSERT OR REPLACE INTO executions
               (id, user_id, input, response, intent, status, quality_overall,
                loop_rounds, total_tool_calls, total_duration, created_at, updated_at, task_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                rec.id, rec.user_id, rec.input, rec.response, rec.intent,
                rec.status, rec.quality_overall, rec.loop_rounds,
                rec.total_tool_calls, rec.total_duration, rec.created_at, rec.updated_at,
                rec.task_type,
            ),
        )
        self._conn.commit()

    def update_execution_status(
        self, exec_id: str, status: str, response: str | None = None
    ) -> None:
        if not self._conn:
            return
        # 仅当 response 非 None 时才覆盖已有响应，避免清空历史响应（审计 M-08）
        if response is None:
            self._conn.execute(
                """UPDATE executions SET status=?, updated_at=? WHERE id=?""",
                (status, int(time.time() * 1000), exec_id),
            )
        else:
            self._conn.execute(
                """UPDATE executions SET status=?, response=?, updated_at=? WHERE id=?""",
                (status, response, int(time.time() * 1000), exec_id),
            )
        self._conn.commit()

    def record_tool_invocation(self, inv: ToolInvocationRecord) -> None:
        if not self._conn:
            return
        if not inv.created_at:
            inv.created_at = int(time.time() * 1000)
        self._conn.execute(
            """INSERT INTO tool_invocations
               (execution_id, step_index, tool_name, args_json, result_success,
                result_output, duration, error_message, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                inv.execution_id, inv.step_index, inv.tool_name, inv.args_json,
                inv.result_success, inv.result_output, inv.duration,
                inv.error_message, inv.created_at,
            ),
        )
        self._conn.commit()

    def record_state_transition(self, tr: StateTransitionRecord) -> None:
        if not self._conn:
            return
        if not tr.created_at:
            tr.created_at = int(time.time() * 1000)
        self._conn.execute(
            """INSERT INTO state_transitions
               (execution_id, from_state, to_state, reason, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (tr.execution_id, tr.from_state, tr.to_state, tr.reason, tr.created_at),
        )
        self._conn.commit()

    def record_context_snapshot(self, snap: ContextSnapshotRecord) -> None:
        if not self._conn:
            return
        if not snap.created_at:
            snap.created_at = int(time.time() * 1000)
        self._conn.execute(
            """INSERT INTO context_snapshots
               (execution_id, phase, step_index, snapshot_json, token_count, duration_ms, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                snap.execution_id, snap.phase, snap.step_index,
                snap.snapshot_json, snap.token_count, snap.duration_ms, snap.created_at,
            ),
        )
        self._conn.commit()

    def record_llm_output(self, out: LLMOutputRecord) -> None:
        if not self._conn:
            return
        if not out.created_at:
            out.created_at = int(time.time() * 1000)
        self._conn.execute(
            """INSERT INTO llm_outputs
               (execution_id, step_index, prompt_tokens, completion_tokens,
                model_name, raw_output, duration_ms, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                out.execution_id, out.step_index, out.prompt_tokens,
                out.completion_tokens, out.model_name, out.raw_output,
                out.duration_ms, out.created_at,
            ),
        )
        self._conn.commit()

    def record_evaluation_result(self, rec: EvaluationResultRecord) -> None:
        if not self._conn:
            return
        if not rec.created_at:
            rec.created_at = int(time.time() * 1000)
        self._conn.execute(
            """INSERT INTO evaluation_results
               (execution_id, step_index, phase, task_completion, data_groundedness,
                safety_risk_level, suggested_action, goal_progress, summary, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                rec.execution_id, rec.step_index, rec.phase,
                rec.task_completion, rec.data_groundedness,
                rec.safety_risk_level, rec.suggested_action,
                rec.goal_progress, rec.summary, rec.created_at,
            ),
        )
        self._conn.commit()

    def get_execution(self, exec_id: str) -> ExecutionRecord | None:
        if not self._conn:
            return None
        row = self._conn.execute(
            "SELECT * FROM executions WHERE id=?", (exec_id,)
        ).fetchone()
        return self._row_to_execution(row) if row else None

    def get_tool_invocations(self, exec_id: str) -> list[ToolInvocationRecord]:
        if not self._conn:
            return []
        rows = self._conn.execute(
            "SELECT * FROM tool_invocations WHERE execution_id=? ORDER BY step_index, id",
            (exec_id,),
        ).fetchall()
        return [self._row_to_tool_invocation(r) for r in rows]

    def get_state_transitions(self, exec_id: str) -> list[StateTransitionRecord]:
        if not self._conn:
            return []
        rows = self._conn.execute(
            "SELECT * FROM state_transitions WHERE execution_id=? ORDER BY id",
            (exec_id,),
        ).fetchall()
        return [self._row_to_state_transition(r) for r in rows]

    def get_context_snapshots(
        self, exec_id: str, phase: str | None = None
    ) -> list[ContextSnapshotRecord]:
        if not self._conn:
            return []
        if phase:
            rows = self._conn.execute(
                "SELECT * FROM context_snapshots WHERE execution_id=? AND phase=? ORDER BY step_index, id",
                (exec_id, phase),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM context_snapshots WHERE execution_id=? ORDER BY step_index, id",
                (exec_id,),
            ).fetchall()
        return [self._row_to_context_snapshot(r) for r in rows]

    def get_llm_outputs(self, exec_id: str) -> list[LLMOutputRecord]:
        if not self._conn:
            return []
        rows = self._conn.execute(
            "SELECT * FROM llm_outputs WHERE execution_id=? ORDER BY step_index, id",
            (exec_id,),
        ).fetchall()
        return [self._row_to_llm_output(r) for r in rows]

    def get_evaluation_results(
        self, exec_id: str, safety_risk: str | None = None
    ) -> list[EvaluationResultRecord]:
        if not self._conn:
            return []
        if safety_risk:
            rows = self._conn.execute(
                "SELECT * FROM evaluation_results WHERE execution_id=? AND safety_risk_level=? ORDER BY step_index, id",
                (exec_id, safety_risk),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM evaluation_results WHERE execution_id=? ORDER BY step_index, id",
                (exec_id,),
            ).fetchall()
        return [self._row_to_eval_result(r) for r in rows]

    def get_recent_executions(self, limit: int = 50) -> list[ExecutionRecord]:
        if not self._conn:
            return []
        rows = self._conn.execute(
            "SELECT * FROM executions ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [self._row_to_execution(r) for r in rows]

    def get_traces_by_date_range(
        self, start_ms: int, end_ms: int
    ) -> list[ExecutionRecord]:
        if not self._conn:
            return []
        rows = self._conn.execute(
            "SELECT * FROM executions WHERE created_at>=? AND created_at<=? ORDER BY created_at DESC",
            (start_ms, end_ms),
        ).fetchall()
        return [self._row_to_execution(r) for r in rows]

    def get_full_trace(self, exec_id: str) -> dict[str, Any]:
        return {
            "execution": self.get_execution(exec_id),
            "tool_invocations": self.get_tool_invocations(exec_id),
            "state_transitions": self.get_state_transitions(exec_id),
            "context_snapshots": self.get_context_snapshots(exec_id),
            "llm_outputs": self.get_llm_outputs(exec_id),
            "evaluation_results": self.get_evaluation_results(exec_id),
        }

    def get_execution_stats(self) -> ExecutionStats:
        if not self._conn:
            return ExecutionStats()
        total_row = self._conn.execute("SELECT COUNT(*) as cnt FROM executions").fetchone()
        total = total_row["cnt"] if total_row else 0
        if total == 0:
            return ExecutionStats()

        success_row = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM executions WHERE status='success'"
        ).fetchone()
        success_count = success_row["cnt"] if success_row else 0

        avg_dur_row = self._conn.execute(
            "SELECT AVG(total_duration) as avg FROM executions WHERE total_duration>0"
        ).fetchone()
        avg_duration = avg_dur_row["avg"] if avg_dur_row and avg_dur_row["avg"] else 0.0

        avg_score_row = self._conn.execute(
            "SELECT AVG(quality_overall) as avg FROM executions WHERE quality_overall IS NOT NULL"
        ).fetchone()
        avg_score = avg_score_row["avg"] if avg_score_row and avg_score_row["avg"] else 0.0

        return ExecutionStats(
            total=total,
            success_rate=success_count / total,
            avg_duration=avg_duration,
            avg_score=avg_score,
        )

    def query_similar_tasks(
        self,
        query: str,
        include_failed: bool = False,
        max_results: int = 5,
        min_quality: float = 0.7,
    ) -> list[dict[str, Any]]:
        if not self._conn:
            return []

        status_filter = "" if include_failed else "AND status='success'"
        quality_filter = f"AND quality_overall>={min_quality}" if min_quality > 0 else ""
        keyword = f"%{query.split()[0]}%"

        rows = self._conn.execute(
            f"SELECT * FROM executions WHERE input LIKE ? {status_filter} {quality_filter} ORDER BY created_at DESC LIMIT ?",
            (keyword, max_results * 2),
        ).fetchall()

        scored: list[dict[str, Any]] = []
        for row in rows:
            execution = self._row_to_execution(row)
            relevance = 0.5
            if execution.input:
                relevance += self._cosine_similarity_text(query, execution.input) * 0.35
            tool_invocations = self.get_tool_invocations(execution.id)
            scored.append({
                "execution": execution,
                "tool_invocations": tool_invocations,
                "relevance_score": relevance,
            })

        scored.sort(key=lambda x: x["relevance_score"], reverse=True)
        return scored[:max_results]

    def estimate_execution_time(
        self,
        task_type: str | None,
        complexity: float | None = None,
        limit: int = 200,
    ) -> ExecutionEstimate | None:
        """基于历史数据预估任务执行时间。

        修正 TS 侧 TrajectoryDatabase.estimateExecutionTime 的 bug：
        - TS 侧 SQL 无 `WHERE task_type = ?`，taskType 参数被完全忽略；
          本实现使用 `WHERE (?1 IS NULL OR task_type = ?1)` 真正按类型过滤。
        - TS 侧分位数用 `Math.floor` 无插值，本实现使用线性插值。
        - TS 侧无置信度字段，本实现返回 low/medium/high 置信度。

        Args:
            task_type: 任务类型标识；传入 None 表示不按类型过滤（使用全部样本）。
            complexity: 任务复杂度（0.0-1.0），传入 None 表示不应用复杂度调整。
            limit: 最多采样的历史记录数，默认 200。

        Returns:
            ExecutionEstimate | None: 样本不足（<3）时返回 None，否则返回预估结果。

        Raises:
            sqlite3.Error: 数据库查询异常时向上抛出（调用方可 try/except 降级）。
        """
        if not self._conn:
            return None

        rows = self._conn.execute(
            """SELECT total_duration, total_tool_calls
               FROM executions
               WHERE status = 'success' AND total_duration > 0
                 AND (?1 IS NULL OR task_type = ?1)
               ORDER BY created_at DESC
               LIMIT ?2""",
            (task_type, limit),
        ).fetchall()

        if len(rows) < 3:
            return None

        durations = sorted(r["total_duration"] for r in rows)
        n = len(durations)

        avg_duration = sum(durations) / n
        estimated_ms = avg_duration

        if complexity is not None and 0.0 <= complexity <= 1.0:
            # 复杂度因子：0.5（简单）到 2.0（复杂）
            complexity_factor = 0.5 + complexity * 1.5
            estimated_ms = avg_duration * complexity_factor

            # 工具调用因子：当历史样本含工具调用时，叠加复杂度修正
            avg_tool_calls = sum(r["total_tool_calls"] for r in rows) / n
            if avg_tool_calls > 0:
                tool_call_factor = 1 + complexity * 0.3
                estimated_ms *= tool_call_factor

        # 置信度：基于样本量
        if n < 10:
            confidence = "low"
        elif n < 50:
            confidence = "medium"
        else:
            confidence = "high"

        return ExecutionEstimate(
            task_type=task_type or "all",
            estimated_ms=int(round(estimated_ms)),
            p50=int(round(self._percentile(durations, 50))),
            p90=int(round(self._percentile(durations, 90))),
            p99=int(round(self._percentile(durations, 99))),
            sample_count=n,
            confidence=confidence,
            complexity=complexity,
        )

    def estimate_tool_time(
        self,
        tool_name: str,
        success_only: bool = True,
        limit: int = 100,
    ) -> ToolDurationStats | None:
        """按工具名预估单次工具调用耗时。

        修正 TS 侧 TrajectoryDatabase.estimateToolTime 的 bug：
        - TS 侧仅返回 p50/p90，本实现补齐 p99。
        - TS 侧未过滤失败样本，本实现支持 success_only 参数。
        - TS 侧分位数用 `Math.floor` 无插值，本实现使用线性插值。
        - TS 侧无成功率字段，本实现返回 success_rate。

        Args:
            tool_name: 工具名称。
            success_only: True 时仅统计成功调用（result_success=1），
                False 时包含所有调用（含失败）。默认 True。
            limit: 最多采样的历史记录数，默认 100。

        Returns:
            ToolDurationStats | None: 样本不足（<2）时返回 None，否则返回统计结果。

        Raises:
            sqlite3.Error: 数据库查询异常时向上抛出。
        """
        if not self._conn:
            return None

        if success_only:
            rows = self._conn.execute(
                """SELECT duration, result_success FROM tool_invocations
                   WHERE tool_name = ? AND duration > 0 AND result_success = 1
                   ORDER BY created_at DESC
                   LIMIT ?""",
                (tool_name, limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """SELECT duration, result_success FROM tool_invocations
                   WHERE tool_name = ? AND duration > 0
                   ORDER BY created_at DESC
                   LIMIT ?""",
                (tool_name, limit),
            ).fetchall()

        if len(rows) < 2:
            return None

        durations = sorted(r["duration"] for r in rows)
        n = len(durations)
        avg = sum(durations) / n

        # 成功率：基于本次采样计算
        success_count = sum(1 for r in rows if r["result_success"] == 1)
        success_rate = success_count / n if n > 0 else 0.0

        return ToolDurationStats(
            tool_name=tool_name,
            estimated_ms=int(round(avg)),
            p50=int(round(self._percentile(durations, 50))),
            p90=int(round(self._percentile(durations, 90))),
            p99=int(round(self._percentile(durations, 99))),
            sample_count=n,
            success_rate=success_rate,
        )

    @staticmethod
    def _percentile(sorted_values: list[int], p: float) -> float:
        """计算分位数（线性插值法）。

        修正 TS 侧 `Math.floor(n * p/100)` 无插值的偏差：
        - TS 侧对 n=5、p=90 给出 values[4]（即 max），偏差大；
        - 本实现按 rank = (p/100) * (n-1) 做线性插值，与 numpy 默认一致。

        Args:
            sorted_values: 已升序排序的数值列表。
            p: 百分位数（0-100）。

        Returns:
            float: 分位数值。空列表返回 0.0。
        """
        if not sorted_values:
            return 0.0
        n = len(sorted_values)
        if n == 1:
            return float(sorted_values[0])

        # 边界处理
        if p <= 0:
            return float(sorted_values[0])
        if p >= 100:
            return float(sorted_values[-1])

        # 线性插值：rank ∈ [0, n-1]
        rank = (p / 100.0) * (n - 1)
        lower = int(rank)
        upper = min(lower + 1, n - 1)
        frac = rank - lower
        return float(sorted_values[lower] + frac * (sorted_values[upper] - sorted_values[lower]))

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    @staticmethod
    def _cosine_similarity_text(a: str, b: str) -> float:
        a_words = set(a.lower().split())
        b_words = set(b.lower().split())
        if not a_words or not b_words:
            return 0.0
        intersection = a_words & b_words
        return len(intersection) / (len(a_words) ** 0.5 * len(b_words) ** 0.5)

    @staticmethod
    def _row_to_execution(row: sqlite3.Row) -> ExecutionRecord:
        # task_type 列可能不存在于旧库，使用 keys() 兜底
        keys = row.keys() if hasattr(row, "keys") else []
        task_type = row["task_type"] if "task_type" in keys else None
        return ExecutionRecord(
            id=row["id"],
            user_id=row["user_id"],
            input=row["input"],
            response=row["response"],
            intent=row["intent"],
            status=row["status"],
            quality_overall=row["quality_overall"],
            loop_rounds=row["loop_rounds"],
            total_tool_calls=row["total_tool_calls"],
            total_duration=row["total_duration"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            task_type=task_type,
        )

    @staticmethod
    def _row_to_tool_invocation(row: sqlite3.Row) -> ToolInvocationRecord:
        return ToolInvocationRecord(
            id=row["id"],
            execution_id=row["execution_id"],
            step_index=row["step_index"],
            tool_name=row["tool_name"],
            args_json=row["args_json"],
            result_success=row["result_success"],
            result_output=row["result_output"],
            duration=row["duration"],
            error_message=row["error_message"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _row_to_state_transition(row: sqlite3.Row) -> StateTransitionRecord:
        return StateTransitionRecord(
            id=row["id"],
            execution_id=row["execution_id"],
            from_state=row["from_state"],
            to_state=row["to_state"],
            reason=row["reason"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _row_to_context_snapshot(row: sqlite3.Row) -> ContextSnapshotRecord:
        return ContextSnapshotRecord(
            id=row["id"],
            execution_id=row["execution_id"],
            phase=row["phase"],
            step_index=row["step_index"],
            snapshot_json=row["snapshot_json"],
            token_count=row["token_count"],
            duration_ms=row["duration_ms"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _row_to_llm_output(row: sqlite3.Row) -> LLMOutputRecord:
        return LLMOutputRecord(
            id=row["id"],
            execution_id=row["execution_id"],
            step_index=row["step_index"],
            prompt_tokens=row["prompt_tokens"],
            completion_tokens=row["completion_tokens"],
            model_name=row["model_name"],
            raw_output=row["raw_output"],
            duration_ms=row["duration_ms"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _row_to_eval_result(row: sqlite3.Row) -> EvaluationResultRecord:
        return EvaluationResultRecord(
            id=row["id"],
            execution_id=row["execution_id"],
            step_index=row["step_index"],
            phase=row["phase"],
            task_completion=row["task_completion"],
            data_groundedness=row["data_groundedness"],
            safety_risk_level=row["safety_risk_level"],
            suggested_action=row["suggested_action"],
            goal_progress=row["goal_progress"],
            summary=row["summary"],
            created_at=row["created_at"],
        )
