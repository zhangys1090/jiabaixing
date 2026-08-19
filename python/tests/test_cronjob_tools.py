"""Cronjob 定时任务工具测试 — P0 审计产物验证"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from agent.tools.cronjob_tools import (
    CronjobManager,
    CronjobBlueprint,
    register_cronjob_tools,
)


class TestCronjobBlueprint:
    def test_blueprint_creation(self):
        bp = CronjobBlueprint(
            name="每日备份",
            schedule="0 2 * * *",
            task="备份数据库到远程存储",
        )
        assert bp.name == "每日备份"
        assert bp.schedule == "0 2 * * *"
        assert bp.task == "备份数据库到远程存储"
        assert bp.enabled is True

    def test_blueprint_defaults(self):
        bp = CronjobBlueprint(
            name="测试",
            schedule="*/5 * * * *",
            task="检查健康状态",
        )
        assert bp.id != ""  # auto-generated
        assert bp.enabled is True
        assert bp.max_retries == 2  # default

    def test_blueprint_disabled(self):
        bp = CronjobBlueprint(
            name="禁用任务",
            schedule="0 0 * * *",
            task="不执行",
            enabled=False,
        )
        assert bp.enabled is False

    def test_blueprint_with_retries(self):
        bp = CronjobBlueprint(
            name="重试任务",
            schedule="0 * * * *",
            task="重试3次",
            max_retries=3,
        )
        assert bp.max_retries == 3


class TestCronjobManager:
    @pytest.fixture(autouse=True)
    def _reset_manager(self):
        CronjobManager._instance = None

    def test_singleton(self):
        m1 = CronjobManager.get_instance()
        m2 = CronjobManager.get_instance()
        assert m1 is m2

    def test_register_blueprint(self):
        manager = CronjobManager.get_instance()
        bp = CronjobBlueprint(
            name="测试任务",
            schedule="0 * * * *",
            task="执行测试",
        )
        bid = manager.register(bp)
        assert bid != ""
        blueprints = manager.list_blueprints()
        bp_ids = [b.id for b in blueprints]
        assert bid in bp_ids

    def test_list_blueprints_empty(self):
        manager = CronjobManager.get_instance()
        blueprints = manager.list_blueprints()
        assert isinstance(blueprints, list)

    def test_list_blueprints_with_entries(self):
        manager = CronjobManager.get_instance()
        bp1 = CronjobBlueprint(name="任务1", schedule="0 * * * *", task="task1")
        bp2 = CronjobBlueprint(name="任务2", schedule="*/30 * * * *", task="task2")
        manager.register(bp1)
        manager.register(bp2)
        blueprints = manager.list_blueprints()
        assert len(blueprints) >= 2

    def test_unregister_blueprint(self):
        manager = CronjobManager.get_instance()
        bp = CronjobBlueprint(name="待删除", schedule="0 * * * *", task="删除")
        bid = manager.register(bp)
        ok = manager.unregister(bid)
        assert ok is True
        bp_ids_after = [b.id for b in manager.list_blueprints()]
        assert bid not in bp_ids_after

    def test_unregister_nonexistent(self):
        manager = CronjobManager.get_instance()
        ok = manager.unregister("nonexistent_id")
        assert ok is False

    def test_get_blueprint(self):
        manager = CronjobManager.get_instance()
        bp = CronjobBlueprint(name="获取测试", schedule="0 * * * *", task="get")
        bid = manager.register(bp)
        retrieved = manager.get_blueprint(bid)
        assert retrieved is not None
        assert retrieved.name == "获取测试"

    def test_get_nonexistent_blueprint(self):
        manager = CronjobManager.get_instance()
        retrieved = manager.get_blueprint("nonexistent_id")
        assert retrieved is None

    def test_enable_disable_blueprint(self):
        manager = CronjobManager.get_instance()
        bp = CronjobBlueprint(name="开关测试", schedule="0 * * * *", task="toggle")
        bid = manager.register(bp)
        manager.disable(bid)
        bp = manager.get_blueprint(bid)
        assert bp.enabled is False
        manager.enable(bid)
        bp = manager.get_blueprint(bid)
        assert bp.enabled is True


class TestCronjobToolRegistration:
    def test_register_cronjob_tools(self):
        registry = MagicMock()
        register_cronjob_tools(registry)
        assert registry.register.call_count == 3
