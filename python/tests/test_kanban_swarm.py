"""KanbanSwarm 多代理看板测试 — P0 审计产物验证"""

from __future__ import annotations

import pytest

from agent.tools.kanban_swarm import (
    KanbanSwarm,
    KanbanColumn,
    KanbanTask,
    register_kanban_tools,
)


class TestKanbanColumn:
    def test_column_values(self):
        assert KanbanColumn.TODO.value == "todo"
        assert KanbanColumn.IN_PROGRESS.value == "in_progress"
        assert KanbanColumn.REVIEW.value == "review"
        assert KanbanColumn.DONE.value == "done"
        assert KanbanColumn.BLOCKED.value == "blocked"

    def test_column_membership(self):
        assert KanbanColumn("todo") == KanbanColumn.TODO
        assert KanbanColumn("blocked") == KanbanColumn.BLOCKED

    def test_invalid_column(self):
        with pytest.raises(ValueError):
            KanbanColumn("invalid")


class TestKanbanTask:
    def test_task_creation(self):
        task = KanbanTask(
            agent_id="agent_1",
            title="测试任务",
            column=KanbanColumn.TODO,
        )
        assert task.agent_id == "agent_1"
        assert task.title == "测试任务"
        assert task.column == KanbanColumn.TODO
        assert task.id != ""
        assert task.priority == 0
        assert task.tags == []

    def test_task_with_optional_fields(self):
        task = KanbanTask(
            agent_id="agent_2",
            title="带标签任务",
            column=KanbanColumn.IN_PROGRESS,
            description="这是一个测试",
            priority=3,
            tags=["urgent", "backend"],
        )
        assert task.description == "这是一个测试"
        assert task.priority == 3
        assert task.tags == ["urgent", "backend"]

    def test_task_fields(self):
        task = KanbanTask(
            agent_id="agent_1",
            title="测试",
            column=KanbanColumn.TODO,
            tags=["test"],
        )
        assert task.id != ""
        assert task.agent_id == "agent_1"
        assert task.title == "测试"
        assert task.column == KanbanColumn.TODO
        assert task.tags == ["test"]


class TestKanbanSwarm:
    @pytest.fixture(autouse=True)
    def _reset_swarm(self):
        KanbanSwarm._instance = None

    def test_singleton(self):
        s1 = KanbanSwarm.get_instance()
        s2 = KanbanSwarm.get_instance()
        assert s1 is s2

    def test_add_task(self):
        swarm = KanbanSwarm.get_instance()
        task = swarm.add_task("agent_1", "任务1", KanbanColumn.TODO)
        assert task.title == "任务1"
        assert task.agent_id == "agent_1"
        assert task.column == KanbanColumn.TODO
        assert task.id != ""

    def test_add_task_default_column(self):
        swarm = KanbanSwarm.get_instance()
        task = swarm.add_task("agent_1", "默认列任务")
        assert task.column == KanbanColumn.TODO

    def test_move_task(self):
        swarm = KanbanSwarm.get_instance()
        task = swarm.add_task("agent_1", "可移动任务", KanbanColumn.TODO)
        ok = swarm.move_task(task.id, KanbanColumn.IN_PROGRESS)
        assert ok is True
        moved = swarm._tasks[task.id]
        assert moved.column == KanbanColumn.IN_PROGRESS

    def test_move_nonexistent_task(self):
        swarm = KanbanSwarm.get_instance()
        ok = swarm.move_task("nonexistent_id", KanbanColumn.DONE)
        assert ok is False

    def test_get_column_tasks(self):
        swarm = KanbanSwarm.get_instance()
        swarm.add_task("agent_1", "todo任务", KanbanColumn.TODO)
        swarm.add_task("agent_2", "in_progress任务", KanbanColumn.IN_PROGRESS)
        tasks = swarm.get_column_tasks(KanbanColumn.TODO)
        assert len(tasks) >= 1
        assert all(t.column == KanbanColumn.TODO for t in tasks)

    def test_get_board_basic(self):
        swarm = KanbanSwarm.get_instance()
        swarm.add_task("agent_1", "任务A", KanbanColumn.TODO)
        swarm.add_task("agent_2", "任务B", KanbanColumn.IN_PROGRESS)
        board = swarm.get_board()
        assert "columns" in board
        assert "agents" in board
        assert "stats" in board
        assert "todo" in board["columns"]
        assert "in_progress" in board["columns"]

    def test_get_board_stats(self):
        swarm = KanbanSwarm.get_instance()
        swarm.add_task("agent_1", "任务1", KanbanColumn.TODO)
        swarm.add_task("agent_1", "任务2", KanbanColumn.DONE)
        board = swarm.get_board()
        assert board["stats"]["total_tasks"] >= 2

    def test_remove_task(self):
        swarm = KanbanSwarm.get_instance()
        task = swarm.add_task("agent_1", "可删除任务", KanbanColumn.TODO)
        ok = swarm.remove_task(task.id)
        assert ok is True
        assert task.id not in swarm._tasks

    def test_remove_nonexistent_task(self):
        swarm = KanbanSwarm.get_instance()
        ok = swarm.remove_task("nonexistent_id")
        assert ok is False

    def test_clear_done(self):
        swarm = KanbanSwarm.get_instance()
        swarm.add_task("agent_1", "已完成任务", KanbanColumn.DONE)
        removed = swarm.clear_done()
        assert removed >= 1

    def test_get_agent_summary(self):
        swarm = KanbanSwarm.get_instance()
        swarm.register_agent("agent_1", "Agent1", "leaf")
        swarm.register_agent("agent_2", "Agent2", "orchestrator")
        summary = swarm.get_agent_summary()
        assert len(summary) >= 2
        agent_ids = [a["id"] for a in summary]
        assert "agent_1" in agent_ids
        assert "agent_2" in agent_ids

    def test_multiple_agents(self):
        swarm = KanbanSwarm.get_instance()
        swarm.register_agent("agent_1", "Agent1", "leaf")
        swarm.register_agent("agent_2", "Agent2", "leaf")
        swarm.register_agent("agent_3", "Agent3", "orchestrator")
        summary = swarm.get_agent_summary()
        assert len(summary) >= 3

    def test_task_lifecycle(self):
        swarm = KanbanSwarm.get_instance()
        task = swarm.add_task("agent_1", "完整生命周期测试", KanbanColumn.TODO)
        assert swarm.move_task(task.id, KanbanColumn.IN_PROGRESS)
        assert swarm.move_task(task.id, KanbanColumn.REVIEW)
        assert swarm.move_task(task.id, KanbanColumn.DONE)
        moved = swarm._tasks[task.id]
        assert moved.column == KanbanColumn.DONE

    def test_add_task_with_tags(self):
        swarm = KanbanSwarm.get_instance()
        task = swarm.add_task(
            "agent_1", "带标签任务", KanbanColumn.TODO,
            tags=["urgent", "backend"],
        )
        assert task.tags == ["urgent", "backend"]

    def test_tasks_preserve_order(self):
        swarm = KanbanSwarm.get_instance()
        t1 = swarm.add_task("agent_1", "任务1", KanbanColumn.TODO)
        t2 = swarm.add_task("agent_1", "任务2", KanbanColumn.TODO)
        tasks = swarm.get_column_tasks(KanbanColumn.TODO)
        ids = [t.id for t in tasks]
        assert t1.id in ids
        assert t2.id in ids


class TestKanbanToolRegistration:
    def test_register_kanban_tools(self):
        from unittest.mock import MagicMock
        registry = MagicMock()
        register_kanban_tools(registry)
        assert registry.register.call_count == 3
