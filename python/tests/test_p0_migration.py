import pytest
import time
from unittest.mock import AsyncMock, MagicMock

from agent.loop.causal import (
    CausalModeler,
    CausalGraph,
    CausalGraphNode,
    CausalGraphEdge,
    FailurePropagation,
    DependencyAnalysis,
    FailureImpact,
)
from agent.persistence.trajectory import (
    ExecutionRecord,
    ToolInvocationRecord,
    StateTransitionRecord,
    ContextSnapshotRecord,
    LLMOutputRecord,
    EvaluationResultRecord,
    TrajectoryDatabase,
    ExecutionStats,
)
from agent.persistence.flywheel import (
    TrajectoryFlywheel,
    TrajectoryAnalysis,
    FlywheelConfig,
    OptimizationSuggestion,
)
from agent.persistence.query import (
    TrajectoryQueryService,
    ToolSuccessRate,
)
from agent.persistence.service import (
    PersistenceService,
    TaskState,
    EvolutionMetric,
)
from agent.persistence.checkpoint import CheckpointService, CheckpointEntry


class TestCausalModeler:
    def test_init_no_llm(self):
        modeler = CausalModeler()
        assert modeler.llm is None

    def test_init_with_llm(self):
        llm = MagicMock()
        modeler = CausalModeler(llm)
        assert modeler.llm is llm

    @pytest.mark.anyio
    async def test_build_causal_model_no_llm(self):
        modeler = CausalModeler()
        graph = await modeler.build_causal_model("测试任务")
        assert isinstance(graph, CausalGraph)
        assert graph.nodes == []

    @pytest.mark.anyio
    async def test_build_causal_model_with_llm(self):
        llm = MagicMock()
        llm.chat = AsyncMock(return_value={"content": '{"nodes":[{"id":"s1","description":"步骤1","type":"action"}],"edges":[],"parallelGroups":[],"failurePropagation":[]}'})
        modeler = CausalModeler(llm)
        graph = await modeler.build_causal_model("测试任务")
        assert len(graph.nodes) == 1
        assert graph.nodes[0].id == "s1"

    @pytest.mark.anyio
    async def test_build_causal_model_invalid_json(self):
        llm = MagicMock()
        llm.chat = AsyncMock(return_value={"content": "不是JSON"})
        modeler = CausalModeler(llm)
        graph = await modeler.build_causal_model("测试任务")
        assert graph.nodes == []

    def test_analyze_dependencies(self):
        graph = CausalGraph(
            nodes=[CausalGraphNode(id="a", description="步骤A"), CausalGraphNode(id="b", description="步骤B"), CausalGraphNode(id="c", description="步骤C")],
            edges=[
                CausalGraphEdge(from_id="a", to_id="b"),
                CausalGraphEdge(from_id="b", to_id="c"),
            ],
        )
        modeler = CausalModeler()

        dep_b = modeler.analyze_dependencies(graph, "b")
        assert "a" in dep_b.depends_on
        assert "c" in dep_b.blocks

        dep_a = modeler.analyze_dependencies(graph, "a")
        assert len(dep_a.depends_on) == 0
        assert "b" in dep_a.blocks

    def test_find_parallel_groups(self):
        graph = CausalGraph(
            nodes=[CausalGraphNode(id="a", description="A"), CausalGraphNode(id="b", description="B"), CausalGraphNode(id="c", description="C")],
            edges=[CausalGraphEdge(from_id="a", to_id="c")],
        )
        modeler = CausalModeler()
        groups = modeler.find_parallel_groups(graph)
        assert len(groups) >= 1
        pair_ids = [set(g) for g in groups]
        assert any({"a", "b"} == p or {"b", "c"} == p for p in pair_ids)

    def test_get_failure_impact(self):
        graph = CausalGraph(
            nodes=[CausalGraphNode(id="a", description="A"), CausalGraphNode(id="b", description="B"), CausalGraphNode(id="c", description="C")],
            edges=[
                CausalGraphEdge(from_id="a", to_id="b"),
                CausalGraphEdge(from_id="b", to_id="c"),
            ],
            failure_propagation=[FailurePropagation(source="a", affects=["c"], reason="级联")],
        )
        modeler = CausalModeler()
        impact = modeler.get_failure_impact(graph, "a")
        assert "b" in impact.affected_steps
        assert "c" in impact.affected_steps
        assert impact.severity in ("low", "medium", "high")

    def test_get_failure_impact_no_propagation(self):
        graph = CausalGraph(nodes=[CausalGraphNode(id="a", description="A")])
        modeler = CausalModeler()
        impact = modeler.get_failure_impact(graph, "a")
        assert impact.affected_steps == []
        assert impact.severity == "low"


class TestTrajectoryDatabase:
    def test_init_creates_db(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        assert db._conn is not None
        db.close()

    def test_record_and_get_execution(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="测试输入", status="running")
        db.record_execution(rec)
        assert rec.id != ""

        fetched = db.get_execution(rec.id)
        assert fetched is not None
        assert fetched.input == "测试输入"
        assert fetched.status == "running"
        db.close()

    def test_update_execution_status(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="测试", status="running")
        db.record_execution(rec)

        db.update_execution_status(rec.id, "success", response="完成")
        fetched = db.get_execution(rec.id)
        assert fetched.status == "success"
        assert fetched.response == "完成"
        db.close()

    def test_record_tool_invocation(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="测试")
        db.record_execution(rec)

        inv = ToolInvocationRecord(
            execution_id=rec.id,
            step_index=0,
            tool_name="file_read",
            args_json='{"path": "/tmp/test"}',
            result_success=1,
            result_output="文件内容",
            duration=150,
        )
        db.record_tool_invocation(inv)

        invs = db.get_tool_invocations(rec.id)
        assert len(invs) == 1
        assert invs[0].tool_name == "file_read"
        assert invs[0].result_success == 1
        db.close()

    def test_record_state_transition(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="测试")
        db.record_execution(rec)

        tr = StateTransitionRecord(
            execution_id=rec.id,
            from_state="idle",
            to_state="planning",
            reason="开始规划",
        )
        db.record_state_transition(tr)

        transitions = db.get_state_transitions(rec.id)
        assert len(transitions) == 1
        assert transitions[0].from_state == "idle"
        assert transitions[0].to_state == "planning"
        db.close()

    def test_record_context_snapshot(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="测试")
        db.record_execution(rec)

        snap = ContextSnapshotRecord(
            execution_id=rec.id,
            phase="planning",
            step_index=0,
            snapshot_json='{"key": "value"}',
            token_count=100,
        )
        db.record_context_snapshot(snap)

        snaps = db.get_context_snapshots(rec.id)
        assert len(snaps) == 1
        assert snaps[0].phase == "planning"

        snaps_filtered = db.get_context_snapshots(rec.id, phase="planning")
        assert len(snaps_filtered) == 1

        snaps_other = db.get_context_snapshots(rec.id, phase="executing")
        assert len(snaps_other) == 0
        db.close()

    def test_record_llm_output(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="测试")
        db.record_execution(rec)

        out = LLMOutputRecord(
            execution_id=rec.id,
            step_index=0,
            prompt_tokens=100,
            completion_tokens=50,
            model_name="gpt-4",
            raw_output="输出内容",
        )
        db.record_llm_output(out)

        outputs = db.get_llm_outputs(rec.id)
        assert len(outputs) == 1
        assert outputs[0].model_name == "gpt-4"
        db.close()

    def test_record_evaluation_result(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="测试")
        db.record_execution(rec)

        ev = EvaluationResultRecord(
            execution_id=rec.id,
            step_index=0,
            phase="evaluating",
            task_completion=0.8,
            goal_progress=0.7,
            suggested_action="continue",
            safety_risk_level="low",
        )
        db.record_evaluation_result(ev)

        results = db.get_evaluation_results(rec.id)
        assert len(results) == 1
        assert results[0].goal_progress == 0.7

        results_safe = db.get_evaluation_results(rec.id, safety_risk="low")
        assert len(results_safe) == 1

        results_danger = db.get_evaluation_results(rec.id, safety_risk="high")
        assert len(results_danger) == 0
        db.close()

    def test_get_full_trace(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="完整轨迹测试")
        db.record_execution(rec)

        db.record_tool_invocation(ToolInvocationRecord(
            execution_id=rec.id, step_index=0, tool_name="search", args_json="{}",
        ))
        db.record_state_transition(StateTransitionRecord(
            execution_id=rec.id, from_state="idle", to_state="planning",
        ))

        trace = db.get_full_trace(rec.id)
        assert trace["execution"] is not None
        assert len(trace["tool_invocations"]) == 1
        assert len(trace["state_transitions"]) == 1
        db.close()

    def test_get_execution_stats(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")

        for i in range(5):
            rec = ExecutionRecord(
                input=f"测试{i}",
                status="success" if i < 3 else "failed",
                quality_overall=0.8 if i < 3 else 0.3,
                total_duration=1000 * (i + 1),
            )
            db.record_execution(rec)

        stats = db.get_execution_stats()
        assert stats.total == 5
        assert stats.success_rate == 0.6
        assert stats.avg_score > 0
        db.close()

    def test_get_execution_stats_empty(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        stats = db.get_execution_stats()
        assert stats.total == 0
        db.close()

    def test_get_recent_executions(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        for i in range(10):
            db.record_execution(ExecutionRecord(input=f"任务{i}"))

        recent = db.get_recent_executions(limit=5)
        assert len(recent) == 5
        db.close()

    def test_query_similar_tasks(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        db.record_execution(ExecutionRecord(input="分析天气数据", status="success", quality_overall=0.9))
        db.record_execution(ExecutionRecord(input="分析销售数据", status="success", quality_overall=0.8))
        db.record_execution(ExecutionRecord(input="编写代码", status="success", quality_overall=0.7))

        results = db.query_similar_tasks("分析", max_results=2)
        assert len(results) <= 2
        if results:
            assert "分析" in results[0]["execution"].input
        db.close()


class TestTrajectoryFlywheel:
    def _make_db_with_data(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        for i in range(15):
            rec = ExecutionRecord(
                input=f"任务{i}",
                status="success" if i < 10 else "failed",
                quality_overall=0.8 if i < 10 else 0.3,
                total_duration=1000 + i * 200,
                total_tool_calls=3 + i % 5,
            )
            db.record_execution(rec)
            for j in range(3):
                db.record_tool_invocation(ToolInvocationRecord(
                    execution_id=rec.id,
                    step_index=j,
                    tool_name=["file_read", "search", "code_generate"][j],
                    args_json="{}",
                    result_success=1 if (i < 10 or j != 2) else 0,
                    duration=200 + j * 100,
                    error_message=None if (i < 10 or j != 2) else "超时",
                ))
        return db

    def test_analyze(self, tmp_path):
        db = self._make_db_with_data(tmp_path)
        flywheel = TrajectoryFlywheel(db)
        analysis = flywheel.analyze()

        assert analysis.total_executions == 15
        assert 0 < analysis.success_rate < 1
        assert analysis.avg_duration > 0
        assert len(analysis.tool_stats) == 3
        db.close()

    def test_analyze_tool_stats(self, tmp_path):
        db = self._make_db_with_data(tmp_path)
        flywheel = TrajectoryFlywheel(db)
        analysis = flywheel.analyze()

        assert "file_read" in analysis.tool_stats
        assert "search" in analysis.tool_stats
        assert "code_generate" in analysis.tool_stats
        assert analysis.tool_stats["file_read"].total_calls > 0
        db.close()

    def test_get_improvement_trend_insufficient_data(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        flywheel = TrajectoryFlywheel(db)
        trend = flywheel.get_improvement_trend()
        assert trend["trend"] == "stable"

    def test_get_improvement_trend_with_data(self, tmp_path):
        db = self._make_db_with_data(tmp_path)
        flywheel = TrajectoryFlywheel(db)
        flywheel.analyze()
        flywheel.analyze()
        trend = flywheel.get_improvement_trend()
        assert "trend" in trend
        assert "data" in trend
        db.close()

    def test_apply_suggestion_not_found(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        flywheel = TrajectoryFlywheel(db)
        result = flywheel.apply_suggestion("nonexistent")
        assert result["success"] is False

    def test_config_defaults(self):
        config = FlywheelConfig()
        assert config.analysis_window_hours == 168
        assert config.min_sample_size == 10
        # P1 修复：飞轮闭环 — auto_apply 默认改为 True
        assert config.auto_apply_optimizations is True


class TestTrajectoryQueryService:
    def test_get_failed_executions(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        db.record_execution(ExecutionRecord(input="成功任务", status="success"))
        db.record_execution(ExecutionRecord(input="失败任务", status="failed"))
        db.record_execution(ExecutionRecord(input="中止任务", status="aborted"))

        svc = TrajectoryQueryService(db)
        failed = svc.get_failed_executions()
        assert len(failed) == 2
        assert all(f.status in ("failed", "aborted") for f in failed)
        db.close()

    def test_get_failed_executions_with_category(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        db.record_execution(ExecutionRecord(input="分析天气数据", status="failed"))
        db.record_execution(ExecutionRecord(input="编写代码", status="failed"))

        svc = TrajectoryQueryService(db)
        failed = svc.get_failed_executions(category="分析")
        assert len(failed) == 1
        assert "分析" in failed[0].input
        db.close()

    def test_get_tool_success_rates(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        rec = ExecutionRecord(input="测试")
        db.record_execution(rec)
        db.record_tool_invocation(ToolInvocationRecord(
            execution_id=rec.id, step_index=0, tool_name="search", args_json="{}", result_success=1,
        ))
        db.record_tool_invocation(ToolInvocationRecord(
            execution_id=rec.id, step_index=1, tool_name="search", args_json="{}", result_success=0,
        ))

        svc = TrajectoryQueryService(db)
        rates = svc.get_tool_success_rates()
        assert "search" in rates
        assert rates["search"].total == 2
        assert rates["search"].success == 1
        assert rates["search"].rate == 0.5
        db.close()

    def test_get_recent_trend(self, tmp_path):
        db = TrajectoryDatabase(tmp_path / "test.db")
        db.record_execution(ExecutionRecord(input="测试1", status="success", quality_overall=0.8))
        db.record_execution(ExecutionRecord(input="测试2", status="success", quality_overall=0.9))

        svc = TrajectoryQueryService(db)
        trends = svc.get_recent_trend(days=7)
        assert isinstance(trends, list)
        db.close()


class TestPersistenceService:
    @pytest.mark.anyio
    async def test_save_and_load_task_state(self, tmp_path):
        svc = PersistenceService(data_dir=tmp_path / "persist")
        await svc.initialize()

        task = TaskState(
            task_id="task_1",
            description="测试任务",
            status="in_progress",
        )
        await svc.save_task_state(task)

        loaded = await svc.load_task_state("task_1")
        assert loaded is not None
        assert loaded.description == "测试任务"
        assert loaded.status == "in_progress"

    @pytest.mark.anyio
    async def test_list_active_tasks(self, tmp_path):
        svc = PersistenceService(data_dir=tmp_path / "persist")
        await svc.initialize()

        await svc.save_task_state(TaskState(task_id="t1", description="进行中", status="in_progress"))
        await svc.save_task_state(TaskState(task_id="t2", description="已完成", status="completed"))
        await svc.save_task_state(TaskState(task_id="t3", description="暂停", status="paused"))

        active = await svc.list_active_tasks()
        assert len(active) == 2
        assert all(t.status in ("pending", "in_progress", "paused") for t in active)

    @pytest.mark.anyio
    async def test_update_task_status(self, tmp_path):
        svc = PersistenceService(data_dir=tmp_path / "persist")
        await svc.initialize()

        await svc.save_task_state(TaskState(task_id="t1", description="测试", status="pending"))
        result = await svc.update_task_status("t1", "completed")
        assert result is True

        loaded = await svc.load_task_state("t1")
        assert loaded.status == "completed"

    @pytest.mark.anyio
    async def test_delete_task(self, tmp_path):
        svc = PersistenceService(data_dir=tmp_path / "persist")
        await svc.initialize()

        await svc.save_task_state(TaskState(task_id="t1", description="测试"))
        assert await svc.delete_task("t1") is True
        assert await svc.load_task_state("t1") is None

    @pytest.mark.anyio
    async def test_delete_nonexistent_task(self, tmp_path):
        svc = PersistenceService(data_dir=tmp_path / "persist")
        await svc.initialize()
        assert await svc.delete_task("nonexistent") is False

    def test_evolution_metrics(self, tmp_path):
        svc = PersistenceService(data_dir=tmp_path / "persist")
        metric = EvolutionMetric(metric_type="quality", value=0.85, timestamp=time.time())
        svc.record_evolution_metric(metric)

        metrics = svc.get_evolution_metrics()
        assert len(metrics) == 1
        assert metrics[0].metric_type == "quality"
        assert metrics[0].value == 0.85

    def test_evolution_metrics_filter(self, tmp_path):
        svc = PersistenceService(data_dir=tmp_path / "persist")
        svc.record_evolution_metric(EvolutionMetric(metric_type="quality", value=0.8, timestamp=time.time()))
        svc.record_evolution_metric(EvolutionMetric(metric_type="speed", value=1.2, timestamp=time.time()))

        quality_metrics = svc.get_evolution_metrics(metric_type="quality")
        assert len(quality_metrics) == 1
        assert quality_metrics[0].metric_type == "quality"


class TestCheckpointService:
    @pytest.mark.anyio
    async def test_create_checkpoint(self, tmp_path):
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        (project_dir / "test.txt").write_text("hello", encoding="utf-8")

        svc = CheckpointService(project_root=project_dir, data_dir=tmp_path / "checkpoints")
        entry = await svc.create_checkpoint(label="测试检查点")

        assert entry.id.startswith("cp_")
        assert entry.label == "测试检查点"
        assert entry.file_count >= 1

    @pytest.mark.anyio
    async def test_list_checkpoints(self, tmp_path):
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        (project_dir / "test.txt").write_text("hello", encoding="utf-8")

        svc = CheckpointService(project_root=project_dir, data_dir=tmp_path / "checkpoints")
        await svc.create_checkpoint(label="cp1")
        await svc.create_checkpoint(label="cp2")

        checkpoints = svc.list_checkpoints()
        assert len(checkpoints) == 2

    @pytest.mark.anyio
    async def test_rollback(self, tmp_path):
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        (project_dir / "test.txt").write_text("原始内容", encoding="utf-8")

        svc = CheckpointService(project_root=project_dir, data_dir=tmp_path / "checkpoints")
        entry = await svc.create_checkpoint(label="回滚前")

        (project_dir / "test.txt").write_text("修改后内容", encoding="utf-8")

        result = await svc.rollback(entry.id)
        assert result is True
        assert (project_dir / "test.txt").read_text(encoding="utf-8") == "原始内容"

    @pytest.mark.anyio
    async def test_rollback_nonexistent(self, tmp_path):
        project_dir = tmp_path / "project"
        project_dir.mkdir()

        svc = CheckpointService(project_root=project_dir, data_dir=tmp_path / "checkpoints")
        result = await svc.rollback("nonexistent")
        assert result is False

    @pytest.mark.anyio
    async def test_max_checkpoints_prune(self, tmp_path):
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        (project_dir / "test.txt").write_text("hello", encoding="utf-8")

        svc = CheckpointService(
            project_root=project_dir,
            data_dir=tmp_path / "checkpoints",
            max_checkpoints=3,
        )

        for i in range(5):
            await svc.create_checkpoint(label=f"cp_{i}")

        checkpoints = svc.list_checkpoints()
        assert len(checkpoints) == 3


class TestLoopControllerWithTrajectory:
    @pytest.mark.anyio
    async def test_controller_with_trajectory_db(self, tmp_path):
        from agent.loop.controller import LoopController
        from agent.loop.types import AgentResult, LoopState

        db = TrajectoryDatabase(tmp_path / "test.db")
        llm = MagicMock()
        llm.chat = AsyncMock(return_value={"content": "你好！有什么可以帮你的？"})

        controller = LoopController(llm, trajectory_db=db)
        assert controller.trajectory_db is db
        assert controller.causal is not None

        result = await controller.run("你好", session_id="test_traj")
        assert isinstance(result, AgentResult)

        executions = db.get_recent_executions()
        assert len(executions) >= 1

        db.close()

    @pytest.mark.anyio
    async def test_controller_without_trajectory_db(self):
        from agent.loop.controller import LoopController
        from agent.loop.types import AgentResult

        llm = MagicMock()
        llm.chat = AsyncMock(return_value={"content": "你好"})

        controller = LoopController(llm)
        assert controller.trajectory_db is None
        result = await controller.run("你好")
        assert isinstance(result, AgentResult)
