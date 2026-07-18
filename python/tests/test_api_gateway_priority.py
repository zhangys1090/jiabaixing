"""API 网关中间件 + 动态优先级评分 + 金丝雀发布集成测试。"""

import asyncio
import time
import pytest

from agent.infrastructure.api_gateway import ApiGatewayMiddleware, TokenBucket
from agent.core.dynamic_priority import DynamicPriorityScorer, TaskInfo, Priority, ScorerConfig
from agent.core.canary_release import (
    CanaryReleaseManager,
    CanaryStrategy,
    RolloutStrategy,
    ReleaseStatus,
)


class TestTokenBucket:
    @pytest.mark.asyncio
    async def test_consume_within_capacity(self):
        bucket = TokenBucket(capacity=10, refill_rate=1.0)
        result = await bucket.consume(1)
        assert result is True

    @pytest.mark.asyncio
    async def test_consume_exceeds_capacity(self):
        bucket = TokenBucket(capacity=2, refill_rate=0.0, tokens=2.0)
        assert await bucket.consume(1) is True
        assert await bucket.consume(1) is True
        assert await bucket.consume(1) is False

    @pytest.mark.asyncio
    async def test_refill_over_time(self):
        bucket = TokenBucket(capacity=10, refill_rate=100.0, tokens=0.0)
        bucket.last_refill = time.monotonic() - 0.1
        result = await bucket.consume(1)
        assert result is True


class TestApiGatewayMiddleware:
    def test_middleware_instantiation(self):
        mw = ApiGatewayMiddleware(app=None)
        assert mw._require_api_key is False

    def test_middleware_with_api_keys(self):
        mw = ApiGatewayMiddleware(
            app=None,
            api_keys={"test-key": "admin"},
            require_api_key=True,
        )
        assert mw._require_api_key is True
        assert "test-key" in mw._api_keys

    def test_public_paths(self):
        mw = ApiGatewayMiddleware(app=None)
        assert "/" in mw._public_paths
        assert "/v1/metrics" in mw._public_paths

    def test_get_stats(self):
        mw = ApiGatewayMiddleware(app=None)
        stats = mw.get_stats()
        assert "total_clients" in stats
        assert "request_counts" in stats


class TestDynamicPriorityScorer:
    def test_scorer_instantiation(self):
        scorer = DynamicPriorityScorer()
        assert scorer is not None

    def test_score_basic_task(self):
        scorer = DynamicPriorityScorer()
        task = TaskInfo(title="测试任务", tags=["bug"], base_priority=Priority.HIGH)
        result = scorer.score(task)
        assert result.total > 0
        assert result.task_title == "测试任务"

    def test_urgent_task_scores_higher(self):
        scorer = DynamicPriorityScorer()
        urgent = TaskInfo(title="紧急", due_date=time.time() + 3600, base_priority=Priority.CRITICAL)
        normal = TaskInfo(title="普通", due_date=time.time() + 86400 * 7, base_priority=Priority.LOW)
        urgent_score = scorer.score(urgent)
        normal_score = scorer.score(normal)
        assert urgent_score.total > normal_score.total

    def test_overdue_task_max_urgency(self):
        scorer = DynamicPriorityScorer()
        overdue = TaskInfo(title="过期", due_date=time.time() - 3600)
        result = scorer.score(overdue)
        assert result.urgency == 1.0

    def test_no_due_date(self):
        scorer = DynamicPriorityScorer()
        task = TaskInfo(title="无截止日期")
        result = scorer.score(task)
        assert result.urgency == 0.3

    def test_impact_from_tags(self):
        scorer = DynamicPriorityScorer()
        high_impact = TaskInfo(title="高影响", tags=["a", "b", "c", "d", "e"])
        low_impact = TaskInfo(title="低影响", tags=[])
        high_score = scorer.score(high_impact)
        low_score = scorer.score(low_impact)
        assert high_score.impact > low_score.impact

    def test_rank_multiple_tasks(self):
        scorer = DynamicPriorityScorer()
        tasks = [
            TaskInfo(title="低优先", base_priority=Priority.LOW),
            TaskInfo(title="高优先", base_priority=Priority.CRITICAL, due_date=time.time() + 3600),
            TaskInfo(title="中优先", base_priority=Priority.MEDIUM),
        ]
        ranked = scorer.rank(tasks)
        assert ranked[0].task_title == "高优先"
        assert ranked[-1].task_title == "低优先"

    def test_priority_levels(self):
        scorer = DynamicPriorityScorer()
        critical = TaskInfo(title="c", due_date=time.time() - 1, tags=["a"] * 5, base_priority=Priority.CRITICAL)
        result = scorer.score(critical)
        assert result.priority_level in (Priority.HIGH, Priority.CRITICAL)

    def test_get_score_from_cache(self):
        scorer = DynamicPriorityScorer()
        task = TaskInfo(title="缓存测试")
        scorer.score(task)
        cached = scorer.get_score("缓存测试")
        assert cached is not None
        assert cached.task_title == "缓存测试"

    def test_clear_cache(self):
        scorer = DynamicPriorityScorer()
        scorer.score(TaskInfo(title="t1"))
        scorer.clear_cache()
        assert scorer.get_score("t1") is None

    def test_custom_config(self):
        config = ScorerConfig(w_urgency=0.5, w_impact=0.3, w_wait_time=0.1, w_base=0.1)
        scorer = DynamicPriorityScorer(config)
        task = TaskInfo(title="自定义", due_date=time.time() + 3600)
        result = scorer.score(task)
        assert result.total > 0


class TestProductionRateLimit:
    """生产限流配置验证测试。"""

    @pytest.mark.asyncio
    async def test_production_capacity_100(self):
        """验证生产配置 capacity=100 时正常请求不被限流。"""
        bucket = TokenBucket(capacity=100, refill_rate=10.0)
        for _ in range(50):
            assert await bucket.consume() is True

    @pytest.mark.asyncio
    async def test_production_burst_protection(self):
        """验证生产配置下突发流量超过容量时被限流。"""
        bucket = TokenBucket(capacity=100, refill_rate=10.0)
        for _ in range(100):
            await bucket.consume()
        assert await bucket.consume() is False

    @pytest.mark.asyncio
    async def test_production_refill_rate(self):
        """验证生产配置下令牌补充速率为 10/s。"""
        bucket = TokenBucket(capacity=100, refill_rate=10.0, tokens=0.0)
        bucket.last_refill = time.monotonic() - 1.0
        assert await bucket.consume() is True
        assert await bucket.consume() is True

    def test_middleware_production_config(self):
        """验证中间件生产配置正确。"""
        mw = ApiGatewayMiddleware(
            app=None,
            rate_limit_capacity=100,
            rate_limit_refill=10.0,
        )
        assert mw._rate_limit_capacity == 100
        assert mw._rate_limit_refill == 10.0

    def test_middleware_disabled_when_capacity_zero(self):
        """验证 capacity=0 时限流禁用。"""
        mw = ApiGatewayMiddleware(
            app=None,
            rate_limit_capacity=0,
        )
        assert mw._rate_limit_capacity == 0


class TestCanaryStagingVerification:
    """金丝雀发布 staging 验证测试。"""

    @pytest.mark.asyncio
    async def test_canary_create_and_select_version(self):
        """验证创建策略并分配版本。"""
        manager = CanaryReleaseManager()
        strategy = CanaryStrategy(
            name="v2-rollout",
            stable_version="gpt-4o-mini",
            canary_version="gpt-4o",
            canary_percentage=10,
            rollout_strategy=RolloutStrategy.MANUAL,
        )
        await manager.create_strategy(strategy)

        assignment = await manager.select_version("user-123", "v2-rollout")
        assert assignment.selected_version in ("gpt-4o-mini", "gpt-4o")

    @pytest.mark.asyncio
    async def test_canary_stable_hash_assignment(self):
        """验证同一用户始终分配到同一版本（哈希稳定性）。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="stable-hash-test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=50,
        ))

        results = set()
        for _ in range(10):
            assignment = await manager.select_version("user-abc", "stable-hash-test")
            results.add(assignment.selected_version)
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_canary_auto_rollback_on_errors(self):
        """验证 AUTO 模式下错误率超阈值自动回滚。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="auto-rollback-test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=50,
            rollout_strategy=RolloutStrategy.AUTO,
            error_threshold=0.3,
        ))

        assignment = await manager.select_version("user-x", "auto-rollback-test")
        assert assignment.is_canary is True

        for _ in range(5):
            await manager.record_outcome("user-x", "auto-rollback-test", success=False, latency_ms=100.0)

        status = manager.get_status("auto-rollback-test")
        assert status == ReleaseStatus.ROLLED_BACK

    @pytest.mark.asyncio
    async def test_canary_promote_to_full(self):
        """验证全量发布。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="promote-test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=10,
        ))

        await manager.promote("promote-test")
        status = manager.get_status("promote-test")
        assert status == ReleaseStatus.PROMOTED

        assignment = await manager.select_version("user-y", "promote-test")
        assert assignment.selected_version == "v2"

    @pytest.mark.asyncio
    async def test_canary_rollback(self):
        """验证手动回滚。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="rollback-test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=50,
        ))

        await manager.rollback("rollback-test")
        status = manager.get_status("rollback-test")
        assert status == ReleaseStatus.ROLLED_BACK

        assignment = await manager.select_version("user-z", "rollback-test")
        assert assignment.selected_version == "v1"

    @pytest.mark.asyncio
    async def test_canary_pause_and_resume(self):
        """验证暂停和恢复。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="pause-test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=30,
        ))

        await manager.pause("pause-test")
        assert manager.get_status("pause-test") == ReleaseStatus.PAUSED

        assignment = await manager.select_version("user-w", "pause-test")
        assert assignment.selected_version == "v1"

        await manager.update_strategy("pause-test", {"canary_percentage": 50})
        assert manager.get_status("pause-test") == ReleaseStatus.CANARY

    @pytest.mark.asyncio
    async def test_canary_health_metrics(self):
        """验证健康指标统计。"""
        manager = CanaryReleaseManager()
        await manager.create_strategy(CanaryStrategy(
            name="health-test",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=100,
        ))

        await manager.select_version("user-h1", "health-test")
        await manager.record_outcome("user-h1", "health-test", success=True, latency_ms=150.0)
        await manager.record_outcome("user-h1", "health-test", success=True, latency_ms=200.0)
        await manager.record_outcome("user-h1", "health-test", success=False, latency_ms=500.0)

        metrics = manager.check_health("health-test")
        assert metrics.sample_count == 3
        assert abs(metrics.error_rate - 1 / 3) < 0.01
        assert metrics.avg_latency > 0
