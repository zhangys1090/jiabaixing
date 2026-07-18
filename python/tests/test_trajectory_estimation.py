"""时间预算预估功能测试 — 差距报告 #15。

测试 TrajectoryDatabase.estimate_execution_time / estimate_tool_time 方法、
百分位数线性插值、以及 ConstraintsService.resolve_adaptive_budget 的历史预估集成。

修正 TS 侧 TrajectoryDatabase.ts 的 5 个 bug：
1. taskType 参数被忽略（SQL 无 WHERE task_type=?）
2. estimateToolTime 缺 P99
3. 分位数用 Math.floor 无插值
4. 未过滤失败样本
5. 无置信度
"""
import os
import tempfile
import time

import pytest

from agent.persistence.trajectory import (
    ExecutionEstimate,
    ExecutionRecord,
    ToolDurationStats,
    ToolInvocationRecord,
    TrajectoryDatabase,
)
from agent.constraints.service import (
    AdaptiveBudgetConfig,
    BudgetAllocation,
    ConstraintsService,
)


class TestTrajectoryEstimation:
    """时间预算预估测试套件。"""

    _db_counter = 0

    def _make_db(self) -> TrajectoryDatabase:
        """创建独立临时数据库，避免测试间数据残留。

        Returns:
            TrajectoryDatabase: 使用临时路径的数据库实例。
        """
        TestTrajectoryEstimation._db_counter += 1
        tmpdir = os.path.join(tempfile.gettempdir(), "jbx_traj_est_test")
        os.makedirs(tmpdir, exist_ok=True)
        db_path = os.path.join(
            tmpdir,
            f"traj_{TestTrajectoryEstimation._db_counter}_{int(time.time() * 1000)}.db",
        )
        return TrajectoryDatabase(db_path)

    def _record_success_execution(
        self,
        db: TrajectoryDatabase,
        duration_ms: int,
        task_type: str | None = None,
        tool_calls: int = 0,
        quality: float = 0.8,
    ) -> str:
        """记录一条成功的执行记录，便于测试构造数据。

        Args:
            db: 轨迹数据库实例。
            duration_ms: 总耗时（毫秒）。
            task_type: 任务类型。
            tool_calls: 工具调用次数。
            quality: 质量评分。

        Returns:
            str: 新建的执行记录 ID。
        """
        rec = ExecutionRecord(
            input=f"test-{task_type or 'default'}-{duration_ms}",
            status="success",
            total_duration=duration_ms,
            total_tool_calls=tool_calls,
            quality_overall=quality,
            task_type=task_type,
        )
        db.record_execution(rec)
        return rec.id

    def _record_tool_invocation(
        self,
        db: TrajectoryDatabase,
        execution_id: str,
        tool_name: str,
        duration_ms: int,
        success: bool = True,
        step_index: int = 0,
    ) -> None:
        """记录一条工具调用，便于测试构造数据。

        Args:
            db: 轨迹数据库实例。
            execution_id: 所属执行记录 ID。
            tool_name: 工具名称。
            duration_ms: 耗时（毫秒）。
            success: 是否成功。
            step_index: 步骤序号。
        """
        inv = ToolInvocationRecord(
            execution_id=execution_id,
            step_index=step_index,
            tool_name=tool_name,
            args_json="{}",
            result_success=1 if success else 0,
            duration=duration_ms,
        )
        db.record_tool_invocation(inv)

    # ─── estimate_execution_time ───

    def test_estimate_execution_time_with_task_type(self):
        """测试 task_type 过滤：只使用匹配类型的执行记录（修正 TS bug #1）。"""
        db = self._make_db()
        try:
            # 记录 search 类型任务（1000-1200ms）
            for dur in [1000, 1100, 1200]:
                self._record_success_execution(db, dur, task_type="search")
            # 记录 translate 类型任务（5000-6000ms）
            for dur in [5000, 5500, 6000]:
                self._record_success_execution(db, dur, task_type="translate")

            estimate_search = db.estimate_execution_time("search")
            assert estimate_search is not None
            assert estimate_search.task_type == "search"
            # 预估应在 search 范围内（1000-1200），不应受 translate 影响
            assert estimate_search.estimated_ms < 2000
            assert estimate_search.sample_count == 3

            estimate_translate = db.estimate_execution_time("translate")
            assert estimate_translate is not None
            assert estimate_translate.estimated_ms > 4000
            assert estimate_translate.sample_count == 3
        finally:
            db.close()

    def test_estimate_execution_time_complexity_factor(self):
        """测试复杂度因子：高复杂度应给出更长的预估时间。"""
        db = self._make_db()
        try:
            for dur in [1000, 1100, 1200, 1050, 1150]:
                self._record_success_execution(
                    db, dur, task_type="default", tool_calls=3
                )

            estimate_low = db.estimate_execution_time("default", complexity=0.0)
            estimate_high = db.estimate_execution_time("default", complexity=1.0)
            assert estimate_low is not None
            assert estimate_high is not None
            # 复杂度 1.0 的预估应显著高于复杂度 0.0
            assert estimate_high.estimated_ms > estimate_low.estimated_ms
            assert estimate_low.complexity == 0.0
            assert estimate_high.complexity == 1.0
        finally:
            db.close()

    def test_estimate_execution_time_low_sample_returns_none(self):
        """测试样本不足时返回 None。"""
        db = self._make_db()
        try:
            # 只记录 2 条（< 3），应返回 None
            self._record_success_execution(db, 1000, task_type="rare")
            self._record_success_execution(db, 1100, task_type="rare")

            estimate = db.estimate_execution_time("rare")
            assert estimate is None
        finally:
            db.close()

    # ─── estimate_tool_time ───

    def test_estimate_tool_time_success_only(self):
        """测试 success_only=True 只统计成功调用（修正 TS bug #4）。"""
        db = self._make_db()
        try:
            exec_id = self._record_success_execution(db, 5000, task_type="default")
            # 3 次成功（100-300ms）
            for i, dur in enumerate([100, 200, 300]):
                self._record_tool_invocation(
                    db, exec_id, "file_read", dur, success=True, step_index=i
                )
            # 2 次失败（5000-6000ms）— 应被过滤
            for i, dur in enumerate([5000, 6000]):
                self._record_tool_invocation(
                    db, exec_id, "file_read", dur, success=False, step_index=i + 3
                )

            stats = db.estimate_tool_time("file_read", success_only=True)
            assert stats is not None
            assert stats.tool_name == "file_read"
            assert stats.sample_count == 3
            # 预估应在成功样本范围内（100-300）
            assert stats.estimated_ms < 1000
            assert stats.p99 > 0  # 修正 TS 侧缺 P99 的 bug #2
        finally:
            db.close()

    def test_estimate_tool_time_with_failures(self):
        """测试 success_only=False 包含失败调用。"""
        db = self._make_db()
        try:
            exec_id = self._record_success_execution(db, 5000, task_type="default")
            for i, dur in enumerate([100, 200, 300]):
                self._record_tool_invocation(
                    db, exec_id, "file_read", dur, success=True, step_index=i
                )
            for i, dur in enumerate([5000, 6000]):
                self._record_tool_invocation(
                    db, exec_id, "file_read", dur, success=False, step_index=i + 3
                )

            stats = db.estimate_tool_time("file_read", success_only=False)
            assert stats is not None
            assert stats.sample_count == 5  # 包含失败
            # 预估应被高耗时失败样本拉高
            assert stats.estimated_ms > 1000
            assert 0.0 <= stats.success_rate <= 1.0
        finally:
            db.close()

    # ─── _percentile 线性插值 ───

    def test_percentile_linear_interpolation(self):
        """测试百分位数使用线性插值（修正 TS 侧 Math.floor 偏差 bug #3）。"""
        # 奇数个元素
        values = [100, 200, 300, 400, 500]
        # p50 中位数 = 300
        assert TrajectoryDatabase._percentile(values, 50) == 300.0
        # p90 线性插值: rank = 0.9 * 4 = 3.6, 400 + 0.6*(500-400) = 460
        # TS 的 Math.floor(5*0.9)=4 会给出 500，是 bug
        assert TrajectoryDatabase._percentile(values, 90) == 460.0
        # 边界
        assert TrajectoryDatabase._percentile(values, 0) == 100.0
        assert TrajectoryDatabase._percentile(values, 100) == 500.0

        # 偶数个元素 — Math.floor 会偏差更大
        values4 = [100, 200, 300, 400]
        # p50: rank = 0.5 * 3 = 1.5, 200 + 0.5*(300-200) = 250
        # TS 的 Math.floor(4*0.5)=2 会给出 300，是 bug
        assert TrajectoryDatabase._percentile(values4, 50) == 250.0

    # ─── resolve_adaptive_budget 历史预估集成 ───

    def test_resolve_adaptive_budget_with_historical(self):
        """测试提供历史预估时，max_duration_ms = estimated_ms * 1.2。"""
        service = ConstraintsService()
        estimate = ExecutionEstimate(
            task_type="search",
            estimated_ms=10000,
            p50=9000,
            p90=12000,
            p99=15000,
            sample_count=50,
            confidence="high",
        )

        allocation = service.resolve_adaptive_budget(
            complexity="moderate",
            historical_estimate=estimate,
        )
        # 10000 * 1.2 = 12000
        assert allocation.max_duration_ms == 12000
        assert allocation.estimated_ms == 10000
        assert allocation.confidence == "high"

    def test_resolve_adaptive_budget_fallback_to_static(self):
        """测试无历史预估时，降级到静态 AdaptiveBudgetConfig。"""
        service = ConstraintsService()
        config = AdaptiveBudgetConfig()

        allocation = service.resolve_adaptive_budget(
            complexity="simple",
            historical_estimate=None,
        )
        assert allocation.max_duration_ms == config.simple.max_duration_ms
        # 无历史预估时，estimated_ms 和 confidence 应为默认值
        assert allocation.estimated_ms is None
        assert allocation.confidence is None
