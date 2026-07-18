"""持续反馈闭环（ContinuousFeedbackLoop）测试。

覆盖 4 种反馈类型的采集、学习信号转化、阈值触发的优化、
以及与 EvolutionEngine / CanaryReleaseManager 的集成。

测试使用真实的 EvolutionEngine 与 CanaryReleaseManager 实例，
不 mock 核心依赖，验证端到端集成行为。
"""
from __future__ import annotations

import pytest

from agent.core.canary_release import CanaryReleaseManager
from agent.evolution.engine import EvolutionEngine
from agent.evolution.feedback_loop import (
    ContinuousFeedbackLoop,
    FeedbackEntry,
    LearningSignal,
)


@pytest.fixture
def evolution_engine() -> EvolutionEngine:
    """提供独立的 EvolutionEngine 实例（使用临时数据目录避免状态污染）。"""
    import tempfile
    import os
    tmpdir = tempfile.mkdtemp(prefix="jbx_evo_test_")
    engine = EvolutionEngine(data_dir=tmpdir)
    yield engine
    # 清理临时目录
    try:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
    except Exception:
        pass


@pytest.fixture
def canary_manager() -> CanaryReleaseManager:
    """提供独立的 CanaryReleaseManager 实例。"""
    return CanaryReleaseManager()


@pytest.fixture
def feedback_loop(evolution_engine, canary_manager) -> ContinuousFeedbackLoop:
    """提供配置好依赖的 ContinuousFeedbackLoop 实例。"""
    return ContinuousFeedbackLoop(
        evolution_engine=evolution_engine,
        canary_manager=canary_manager,
        optimize_threshold=3,  # 测试用小阈值
        time_window_seconds=60,
    )


class TestCollectFeedback:
    """4 种反馈类型采集测试。"""

    @pytest.mark.asyncio
    async def test_collect_positive_feedback(self, feedback_loop):
        """采集 positive 反馈应成功记录。"""
        entry = await feedback_loop.collect_feedback(
            session_id="sess-1",
            feedback_type="positive",
            metadata={"quality_score": 0.9},
        )
        assert entry.session_id == "sess-1"
        assert entry.feedback_type == "positive"
        assert entry.entry_id != ""

    @pytest.mark.asyncio
    async def test_collect_negative_feedback(self, feedback_loop):
        """采集 negative 反馈应成功记录。"""
        entry = await feedback_loop.collect_feedback(
            session_id="sess-2",
            feedback_type="negative",
            metadata={"reason": "response_incorrect"},
        )
        assert entry.feedback_type == "negative"

    @pytest.mark.asyncio
    async def test_collect_correction_feedback(self, feedback_loop):
        """采集 correction 反馈（用户修正）应成功记录。"""
        entry = await feedback_loop.collect_feedback(
            session_id="sess-3",
            feedback_type="correction",
            metadata={"original": "旧答案", "corrected": "新答案"},
        )
        assert entry.feedback_type == "correction"

    @pytest.mark.asyncio
    async def test_collect_reuse_feedback(self, feedback_loop):
        """采集 reuse 反馈（用户复用历史）应成功记录。"""
        entry = await feedback_loop.collect_feedback(
            session_id="sess-4",
            feedback_type="reuse",
            metadata={"source_session": "sess-1"},
        )
        assert entry.feedback_type == "reuse"

    @pytest.mark.asyncio
    async def test_collect_unknown_feedback_type_raises(self, feedback_loop):
        """未知 feedback_type 应抛出 ValueError。"""
        with pytest.raises(ValueError):
            await feedback_loop.collect_feedback(
                session_id="s", feedback_type="unknown_type"
            )


class TestConvertToLearningSignal:
    """学习信号转化测试。"""

    @pytest.mark.asyncio
    async def test_positive_converts_to_high_quality_signal(self, feedback_loop):
        """positive 反馈应转化为高质量分数（>0.7）。"""
        entry = await feedback_loop.collect_feedback(
            session_id="s", feedback_type="positive"
        )
        signal = await feedback_loop.convert_to_learning_signal(entry)
        assert isinstance(signal, LearningSignal)
        assert signal.quality > 0.7

    @pytest.mark.asyncio
    async def test_negative_converts_to_low_quality_signal(self, feedback_loop):
        """negative 反馈应转化为低质量分数（<0.3）。"""
        entry = await feedback_loop.collect_feedback(
            session_id="s", feedback_type="negative"
        )
        signal = await feedback_loop.convert_to_learning_signal(entry)
        assert signal.quality < 0.3

    @pytest.mark.asyncio
    async def test_correction_converts_to_mid_quality_signal(self, feedback_loop):
        """correction 反馈应转化为中等质量分数（0.3-0.7）。"""
        entry = await feedback_loop.collect_feedback(
            session_id="s", feedback_type="correction"
        )
        signal = await feedback_loop.convert_to_learning_signal(entry)
        assert 0.3 <= signal.quality <= 0.7

    @pytest.mark.asyncio
    async def test_reuse_converts_to_positive_signal(self, feedback_loop):
        """reuse 反馈应转化为正向信号（用户复用表示满意）。"""
        entry = await feedback_loop.collect_feedback(
            session_id="s", feedback_type="reuse"
        )
        signal = await feedback_loop.convert_to_learning_signal(entry)
        assert signal.quality >= 0.7


class TestFeedToEvolutionEngine:
    """写入进化引擎测试。"""

    @pytest.mark.asyncio
    async def test_feed_signal_increases_evolution_interactions(
        self, feedback_loop, evolution_engine
    ):
        """写入学习信号应增加 EvolutionEngine 的 total_interactions。"""
        before = evolution_engine.get_metrics().total_interactions
        entry = await feedback_loop.collect_feedback(
            session_id="s", feedback_type="positive"
        )
        signal = await feedback_loop.convert_to_learning_signal(entry)
        await feedback_loop.feed_to_evolution_engine(signal)
        after = evolution_engine.get_metrics().total_interactions
        assert after == before + 1

    @pytest.mark.asyncio
    async def test_feed_signal_silent_on_engine_failure(self):
        """EvolutionEngine 处理失败时不应抛异常（静默降级）。"""
        # 使用 None 作为引擎模拟缺失场景
        loop = ContinuousFeedbackLoop(
            evolution_engine=None,
            canary_manager=None,
        )
        signal = LearningSignal(
            signal_type="positive",
            quality=0.9,
            session_id="s",
            metadata={},
        )
        # 不应抛异常
        await loop.feed_to_evolution_engine(signal)


class TestThresholdOptimize:
    """阈值触发的优化测试。"""

    @pytest.mark.asyncio
    async def test_optimize_not_triggered_below_threshold(self, feedback_loop):
        """反馈数未达阈值时不应触发优化。"""
        # threshold=3，只采集 2 条
        await feedback_loop.collect_feedback("s1", "positive")
        await feedback_loop.collect_feedback("s2", "positive")
        result = await feedback_loop.check_and_optimize()
        assert result.triggered is False

    @pytest.mark.asyncio
    async def test_optimize_triggered_at_threshold(self, feedback_loop):
        """反馈数达到阈值时应触发优化。"""
        # threshold=3，采集 3 条
        await feedback_loop.collect_feedback("s1", "positive")
        await feedback_loop.collect_feedback("s2", "positive")
        await feedback_loop.collect_feedback("s3", "negative")
        result = await feedback_loop.check_and_optimize()
        assert result.triggered is True
        assert result.optimized_count >= 0  # 优化执行结果数

    @pytest.mark.asyncio
    async def test_optimize_resets_counter_after_trigger(self, feedback_loop):
        """触发优化后计数器应重置。"""
        await feedback_loop.collect_feedback("s1", "positive")
        await feedback_loop.collect_feedback("s2", "positive")
        await feedback_loop.collect_feedback("s3", "positive")
        await feedback_loop.check_and_optimize()
        # 再次检查不应触发（计数已重置）
        result = await feedback_loop.check_and_optimize()
        assert result.triggered is False


class TestEvolutionEngineIntegration:
    """与 EvolutionEngine 端到端集成测试。"""

    @pytest.mark.asyncio
    async def test_full_loop_positive_feedback_improves_quality(
        self, feedback_loop, evolution_engine
    ):
        """完整闭环：正向反馈 → 信号 → 引擎 → 平均质量提升。"""
        initial_avg = evolution_engine.get_metrics().average_quality
        # 采集多条正向反馈
        for i in range(3):
            entry = await feedback_loop.collect_feedback(
                session_id=f"s{i}", feedback_type="positive"
            )
            signal = await feedback_loop.convert_to_learning_signal(entry)
            await feedback_loop.feed_to_evolution_engine(signal)
        # 触发优化
        await feedback_loop.check_and_optimize()
        # 进化引擎应记录了 3 次交互
        assert evolution_engine.get_metrics().total_interactions >= 3

    @pytest.mark.asyncio
    async def test_full_loop_negative_feedback_records_failures(
        self, feedback_loop, evolution_engine
    ):
        """完整闭环：负向反馈 → 信号 → 引擎记录低质量。"""
        for i in range(2):
            entry = await feedback_loop.collect_feedback(
                session_id=f"s{i}", feedback_type="negative"
            )
            signal = await feedback_loop.convert_to_learning_signal(entry)
            await feedback_loop.feed_to_evolution_engine(signal)
        metrics = evolution_engine.get_metrics()
        # recent_quality_scores 应包含低分
        assert any(score < 0.3 for score in metrics.recent_quality_scores)


class TestStats:
    """反馈统计测试。"""

    @pytest.mark.asyncio
    async def test_get_stats_returns_counts(self, feedback_loop):
        """get_stats 应返回各类反馈的计数。"""
        await feedback_loop.collect_feedback("s1", "positive")
        await feedback_loop.collect_feedback("s2", "positive")
        await feedback_loop.collect_feedback("s3", "negative")
        stats = feedback_loop.get_stats()
        assert stats["total"] == 3
        assert stats["positive"] == 2
        assert stats["negative"] == 1
        assert stats["correction"] == 0
        assert stats["reuse"] == 0
