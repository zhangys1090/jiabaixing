"""LongTaskOrchestrator 升级功能测试 — L4优先级调度 + L5跨会话持久化 + SubTaskRetryPolicy + TASK_TEMPLATES."""

from __future__ import annotations

import os
import tempfile
import time

import pytest

from agent.core.long_task import (
    ExecutionMode,
    LongTaskOrchestrator,
    SubTask,
    SubTaskRetryPolicy,
    SubTaskStatus,
    TaskBudget,
    TaskPersistenceStore,
    TaskPhase,
    TaskProgress,
    TASK_TEMPLATES,
    match_template,
)


# ─── SubTaskRetryPolicy ───


def test_retry_policy_should_retry_timeout():
    policy = SubTaskRetryPolicy()
    assert policy.should_retry("timeout error", 0) is True
    assert policy.should_retry("connection refused", 1) is True
    assert policy.should_retry("rate_limit exceeded", 0) is True


def test_retry_policy_should_not_retry_permission():
    policy = SubTaskRetryPolicy()
    assert policy.should_retry("permission denied", 0) is False
    assert policy.should_retry("auth failed", 0) is False
    assert policy.should_retry("not_found error", 0) is False


def test_retry_policy_max_retries():
    policy = SubTaskRetryPolicy(max_retries=2)
    assert policy.should_retry("timeout", 0) is True
    assert policy.should_retry("timeout", 1) is True
    assert policy.should_retry("timeout", 2) is False


def test_retry_policy_get_delay():
    policy = SubTaskRetryPolicy(backoff_base=2.0)
    assert policy.get_delay(0) == 2.0
    assert policy.get_delay(1) == 4.0
    assert policy.get_delay(2) == 8.0


def test_retry_policy_chinese_keywords():
    policy = SubTaskRetryPolicy()
    assert policy.should_retry("临时错误", 0) is True
    assert policy.should_retry("权限不足", 0) is False


# ─── TASK_TEMPLATES ───


def test_templates_exist():
    assert "refactor" in TASK_TEMPLATES
    assert "feature" in TASK_TEMPLATES
    assert "debug" in TASK_TEMPLATES
    assert "migration" in TASK_TEMPLATES
    assert "document" in TASK_TEMPLATES


def test_match_template_refactor():
    result = match_template("重构认证模块")
    assert result is not None
    assert len(result) > 0
    assert any(s["name"] == "analyze" for s in result)


def test_match_template_feature():
    result = match_template("添加OAuth2登录功能")
    assert result is not None
    assert len(result) > 0


def test_match_template_debug():
    result = match_template("修复内存泄漏问题")
    assert result is not None


def test_match_template_no_match():
    result = match_template("随便说点什么xyz")
    assert result is None


def test_template_has_dependencies():
    for name, steps in TASK_TEMPLATES.items():
        for step in steps:
            assert "name" in step
            assert "description" in step
            assert "dependencies" in step


# ─── TaskPersistenceStore ───


def test_persistence_init():
    with tempfile.TemporaryDirectory() as td:
        store = TaskPersistenceStore(db_path=os.path.join(td, "test.db"))
        assert os.path.exists(store.db_path)


def test_persistence_save_and_load():
    with tempfile.TemporaryDirectory() as td:
        store = TaskPersistenceStore(db_path=os.path.join(td, "test.db"))
        progress = TaskProgress(
            task_id="task_001",
            phase=TaskPhase.RUNNING,
            budget=TaskBudget(max_tokens=100000, max_time=300, max_iterations=30),
            started_at=time.time(),
            updated_at=time.time(),
            total_subtasks=3,
            completed_subtasks=1,
        )
        subtasks = [
            SubTask(subtask_id="st_1", name="analyze", description="Analyze code", status=SubTaskStatus.COMPLETED),
            SubTask(subtask_id="st_2", name="plan", description="Plan refactor", status=SubTaskStatus.RUNNING, dependencies=["st_1"]),
            SubTask(subtask_id="st_3", name="execute", description="Execute refactor", status=SubTaskStatus.PENDING, dependencies=["st_2"], metadata={"priority": "high"}),
        ]
        store.save_task(progress, subtasks)

        loaded = store.load_all_tasks()
        assert "task_001" in loaded
        lp, ls = loaded["task_001"]
        assert lp.task_id == "task_001"
        assert lp.phase == TaskPhase.RUNNING
        assert lp.total_subtasks == 3
        assert lp.completed_subtasks == 1
        assert len(ls) == 3
        assert ls[0].status == SubTaskStatus.COMPLETED
        assert ls[1].dependencies == ["st_1"]
        assert ls[2].metadata == {"priority": "high"}


def test_persistence_delete():
    with tempfile.TemporaryDirectory() as td:
        store = TaskPersistenceStore(db_path=os.path.join(td, "test.db"))
        progress = TaskProgress(
            task_id="task_del",
            phase=TaskPhase.COMPLETED,
            budget=TaskBudget(),
            started_at=time.time(),
            updated_at=time.time(),
        )
        store.save_task(progress)
        assert "task_del" in store.load_all_tasks()
        store.delete_task("task_del")
        assert "task_del" not in store.load_all_tasks()


def test_persistence_cleanup():
    with tempfile.TemporaryDirectory() as td:
        store = TaskPersistenceStore(db_path=os.path.join(td, "test.db"))
        old_time = time.time() - 200 * 3600
        progress = TaskProgress(
            task_id="task_old",
            phase=TaskPhase.COMPLETED,
            budget=TaskBudget(),
            started_at=old_time,
            updated_at=old_time,
        )
        store.save_task(progress)
        deleted = store.cleanup_completed(max_age_hours=168.0)
        assert deleted == 1
        assert "task_old" not in store.load_all_tasks()


def test_persistence_budget_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        store = TaskPersistenceStore(db_path=os.path.join(td, "test.db"))
        budget = TaskBudget(max_tokens=200000, max_time=600, max_iterations=50, tokens_used=5000, time_used=10.5, iterations_used=3)
        progress = TaskProgress(
            task_id="task_budget",
            phase=TaskPhase.RUNNING,
            budget=budget,
            started_at=time.time(),
            updated_at=time.time(),
        )
        store.save_task(progress)
        loaded = store.load_all_tasks()
        lp = loaded["task_budget"][0]
        assert lp.budget.max_tokens == 200000
        assert lp.budget.max_time == 600
        assert lp.budget.tokens_used == 5000
        assert lp.budget.time_used == 10.5
        assert lp.budget.iterations_used == 3


# ─── LongTaskOrchestrator with priority ───


def test_orchestrator_has_priority_scorer():
    orch = LongTaskOrchestrator(engine=None, persistence_enabled=False)
    assert orch._priority_scorer is not None


def test_orchestrator_sort_by_priority():
    orch = LongTaskOrchestrator(engine=None, persistence_enabled=False)
    subtasks = [
        SubTask(subtask_id="s1", name="low_task", description="Low priority", metadata={"priority": "low"}),
        SubTask(subtask_id="s2", name="critical_task", description="Critical priority", metadata={"priority": "critical"}),
        SubTask(subtask_id="s3", name="medium_task", description="Medium priority", metadata={"priority": "medium"}),
    ]
    sorted_tasks = orch._sort_by_priority(subtasks)
    assert sorted_tasks[0].name == "critical_task"
    assert sorted_tasks[-1].name == "low_task"


def test_orchestrator_set_subtask_priority():
    orch = LongTaskOrchestrator(engine=None, persistence_enabled=False)
    orch._tasks["t1"] = TaskProgress(task_id="t1", phase=TaskPhase.RUNNING, budget=TaskBudget(), started_at=time.time(), updated_at=time.time())
    orch._subtasks["t1"] = [
        SubTask(subtask_id="s1", name="analyze", description="Analyze"),
        SubTask(subtask_id="s2", name="execute", description="Execute"),
    ]
    assert orch.set_subtask_priority("t1", "analyze", "critical") is True
    assert orch._subtasks["t1"][0].metadata["priority"] == "critical"
    assert orch.set_subtask_priority("t1", "nonexistent", "high") is False


def test_orchestrator_persistence_disabled():
    orch = LongTaskOrchestrator(engine=None, persistence_enabled=False)
    assert orch._persistence is None


# ─── SubTask metadata ───


def test_subtask_metadata_none():
    st = SubTask(subtask_id="x", name="y", description="z")
    assert st.metadata is None


def test_subtask_metadata_with_data():
    st = SubTask(
        subtask_id="x", name="y", description="z",
        metadata={"priority": "high", "tags": ["urgent", "backend"]},
    )
    assert st.metadata["priority"] == "high"
    assert "urgent" in st.metadata["tags"]


# ─── TaskBudget ───


def test_budget_not_exhausted():
    budget = TaskBudget(max_tokens=100000, max_time=300, max_iterations=30)
    assert budget.is_exhausted is False


def test_budget_exhausted_tokens():
    budget = TaskBudget(max_tokens=100000, max_time=300, max_iterations=30, tokens_used=150000)
    assert budget.is_exhausted is True


def test_budget_ratios():
    budget = TaskBudget(max_tokens=100000, max_time=300, max_iterations=30, tokens_used=50000, time_used=150, iterations_used=15)
    assert abs(budget.token_ratio - 0.5) < 0.01
    assert abs(budget.time_ratio - 0.5) < 0.01
    assert abs(budget.iteration_ratio - 0.5) < 0.01
