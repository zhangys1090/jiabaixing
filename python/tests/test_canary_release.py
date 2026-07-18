"""灰度发布机制（Canary Release）测试。

覆盖策略管理、用户分桶、健康监测和手动控制四大核心能力。
"""
from __future__ import annotations

import pytest

from agent.core.canary_release import (
    BucketAssignment,
    CanaryReleaseManager,
    CanaryStrategy,
    HealthMetrics,
    ReleaseStatus,
    RolloutStrategy,
)


class TestCanaryStrategy:
    """灰度策略 CRUD 测试。"""

    async def test_create_strategy(self):
        """创建策略后应可在列表中查到，且百分比 > 0 时状态为 CANARY。"""
        manager = CanaryReleaseManager()
        strategy = CanaryStrategy(
            name="v2-rollout",
            stable_version="gpt-4o-mini",
            canary_version="gpt-4o",
            canary_percentage=10,
        )
        await manager.create_strategy(strategy)
        assert len(manager.list_strategies()) == 1
        assert manager.get_status("v2-rollout") == ReleaseStatus.CANARY

    async def test_update_strategy(self):
        """更新策略字段后应反映到列表返回的对象中。"""
        manager = CanaryReleaseManager()
        strategy = CanaryStrategy(
            name="v2-rollout",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=10,
        )
        await manager.create_strategy(strategy)
        updated = await manager.update_strategy("v2-rollout", {"canary_percentage": 20})
        assert updated.canary_percentage == 20
        assert manager.list_strategies()[0].canary_percentage == 20

    async def test_delete_strategy(self):
        """删除策略后列表为空，查询状态应抛出 KeyError。"""
        manager = CanaryReleaseManager()
        strategy = CanaryStrategy(name="test", stable_version="v1", canary_version="v2")
        await manager.create_strategy(strategy)
        await manager.delete_strategy("test")
        assert len(manager.list_strategies()) == 0
        with pytest.raises(KeyError):
            manager.get_status("test")


class TestBucketAssignment:
    """用户分桶测试。"""

    async def test_select_version_consistent_for_same_user(self):
        """同一用户多次调用 select_version 应得到一致的分桶结果。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test", stable_version="v1", canary_version="v2", canary_percentage=50,
        ))
        results = [await manager.select_version("user-123", "test") for _ in range(10)]
        assert all(r.is_canary == results[0].is_canary for r in results)
        assert all(r.hash_bucket == results[0].hash_bucket for r in results)

    async def test_select_version_distributes_by_percentage(self):
        """50% 灰度时，1000 个用户的灰度命中数应在 400~600 之间。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test", stable_version="v1", canary_version="v2", canary_percentage=50,
        ))
        canary_count = 0
        for i in range(1000):
            assignment = await manager.select_version(f"user-{i}", "test")
            if assignment.is_canary:
                canary_count += 1
        # 50% 灰度，允许 ±10% 偏差（SHA-256 分布均匀）
        assert 400 <= canary_count <= 600

    async def test_select_version_zero_percentage_always_stable(self):
        """canary_percentage=0 时，所有用户都应命中稳定版本。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test", stable_version="v1", canary_version="v2", canary_percentage=0,
        ))
        for i in range(100):
            assignment = await manager.select_version(f"user-{i}", "test")
            assert not assignment.is_canary
            assert assignment.selected_version == "v1"

    async def test_select_version_full_percentage_always_canary(self):
        """canary_percentage=100 时，所有用户都应命中灰度版本。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test", stable_version="v1", canary_version="v2", canary_percentage=100,
        ))
        for i in range(100):
            assignment = await manager.select_version(f"user-{i}", "test")
            assert assignment.is_canary
            assert assignment.selected_version == "v2"


class TestHealthMonitoring:
    """健康监测测试。"""

    async def test_record_outcome_updates_metrics(self):
        """record_outcome 应正确更新错误率、平均延迟和样本数。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test", stable_version="v1", canary_version="v2", canary_percentage=100,
        ))
        # 先建立 canary 分配（is_canary=True）
        await manager.select_version("user-1", "test")
        await manager.record_outcome("user-1", "test", success=True, latency_ms=100)
        await manager.record_outcome("user-1", "test", success=False, latency_ms=200)
        metrics = manager.check_health("test")
        assert metrics.sample_count == 2
        assert metrics.error_rate == 0.5
        assert metrics.avg_latency == 150.0

    async def test_auto_rollback_on_high_error_rate(self):
        """AUTO 模式下错误率超阈值应自动回滚。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=100,
            rollout_strategy=RolloutStrategy.AUTO,
            error_threshold=0.05,
        ))
        await manager.select_version("user-1", "test")
        # 记录 6 次失败（超过最小样本数 5）
        for _ in range(6):
            await manager.record_outcome("user-1", "test", success=False, latency_ms=100)
        assert manager.get_status("test") == ReleaseStatus.ROLLED_BACK

    async def test_auto_rollback_on_high_latency(self):
        """AUTO 模式下平均延迟超阈值应自动回滚。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=100,
            rollout_strategy=RolloutStrategy.AUTO,
            latency_threshold=1000.0,
        ))
        await manager.select_version("user-1", "test")
        # 记录 6 次高延迟成功请求
        for _ in range(6):
            await manager.record_outcome("user-1", "test", success=True, latency_ms=1500)
        assert manager.get_status("test") == ReleaseStatus.ROLLED_BACK

    async def test_no_rollback_within_thresholds(self):
        """AUTO 模式下指标在阈值内不应触发回滚。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=100,
            rollout_strategy=RolloutStrategy.AUTO,
            error_threshold=0.05,
            latency_threshold=2000.0,
        ))
        await manager.select_version("user-1", "test")
        for _ in range(6):
            await manager.record_outcome("user-1", "test", success=True, latency_ms=100)
        assert manager.get_status("test") == ReleaseStatus.CANARY


class TestManualControl:
    """手动控制测试。"""

    async def test_promote_switches_all_to_canary(self):
        """promote 后所有用户都应命中灰度版本，状态为 PROMOTED。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test", stable_version="v1", canary_version="v2", canary_percentage=0,
        ))
        await manager.promote("test")
        assert manager.get_status("test") == ReleaseStatus.PROMOTED
        for i in range(10):
            assignment = await manager.select_version(f"user-{i}", "test")
            assert assignment.is_canary

    async def test_rollback_switches_all_to_stable(self):
        """rollback 后所有用户都应命中稳定版本，状态为 ROLLED_BACK。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test", stable_version="v1", canary_version="v2", canary_percentage=100,
        ))
        await manager.rollback("test")
        assert manager.get_status("test") == ReleaseStatus.ROLLED_BACK
        for i in range(10):
            assignment = await manager.select_version(f"user-{i}", "test")
            assert not assignment.is_canary

    async def test_pause_stops_canary_assignment(self):
        """pause 后灰度分配停止，所有用户命中稳定版本，状态为 PAUSED。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="test", stable_version="v1", canary_version="v2", canary_percentage=100,
        ))
        await manager.pause("test")
        assert manager.get_status("test") == ReleaseStatus.PAUSED
        for i in range(10):
            assignment = await manager.select_version(f"user-{i}", "test")
            assert not assignment.is_canary
