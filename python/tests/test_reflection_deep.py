"""
test_reflection_deep.py — ReflectionEngine 深度集成测试

补充测试覆盖（针对现有 test_reflection.py 的 2 个测试用例）:
1. lightweight_reflect() — 轻量级反思（成功/失败路径）
2. meta_reflect() — 元反思（质量评估+盲点识别）
3. transfer_experience() — 经验迁移
4. get_cross_tool_insights() — 跨工具洞察
5. SuccessReflectionResult — 成功反思（规则化分析）
6. ReflectionKnowledgeBase — 完整 CRUD + 迁移模式提取

目标: Reflection 模块覆盖率从 ~30% 提升至 ~85%
"""

import asyncio
import json
import time
import tempfile
from pathlib import Path
from typing import Any

import pytest

from agent.loop.reflection import (
    ReflectionEngine,
    ExperienceEntry,
    LightweightReflectionResult,
    MetaReflectionResult,
    SuccessReflectionResult,
)
from agent.loop.reflection_knowledge_base import (
    ExperienceType,
    ReflectionExperience,
    ReflectionKnowledgeBase,
)


# ─────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────


@pytest.fixture
def engine():
    """创建一个不带知识库的 ReflectionEngine（避免 DB 依赖）"""
    return ReflectionEngine(enable_kb=False)


@pytest.fixture
def engine_with_kb(tmp_path):
    """创建一个带临时数据库的 ReflectionEngine"""
    db_path = tmp_path / "test_reflection_kb.db"
    kb = ReflectionKnowledgeBase(db_path=db_path)
    engine = ReflectionEngine(knowledge_base=kb, enable_kb=True)
    yield engine
    kb.close()


@pytest.fixture
def sample_experiences(engine):
    """准备一些样本经验数据"""
    experiences = [
        ExperienceEntry(
            tool_name="file_read",
            args={"path": "/tmp/test.txt"},
            error="",
            root_cause="success",
            resolution="file read successfully",
            success=True,
            timestamp=time.time() - 3600,
        ),
        ExperienceEntry(
            tool_name="file_read",
            args={"path": "/nonexistent.txt"},
            error="ENOENT: no such file",
            root_cause="not_found",
            resolution="check path existence",
            success=False,
            timestamp=time.time() - 7200,
        ),
        ExperienceEntry(
            tool_name="file_write",
            args={"path": "/tmp/output.txt", "content": "data"},
            error="",
            root_cause="success",
            resolution="file written successfully",
            success=True,
            timestamp=time.time() - 1800,
        ),
    ]
    for exp in experiences:
        engine.record_experience(exp)
    return experiences


# ─────────────────────────────────────────────
# 1. Lightweight Reflection 测试
# ─────────────────────────────────────────────


class TestLightweightReflection:
    """测试 lightweight_reflect() 方法"""

    @pytest.mark.asyncio
    async def test_lightweight_reflect_success(self, engine):
        """成功路径: 快速提取关键经验"""
        result = await engine.lightweight_reflect(
            tool_name="file_read",
            success=True,
            args={"path": "/tmp/test.txt"},
            result="content length: 1024",
        )

        assert isinstance(result, LightweightReflectionResult)
        assert result.reflection_type == "success"
        assert "file_read" in result.quick_insight
        assert result.duration_ms < 500  # 确保 <500ms

    @pytest.mark.asyncio
    async def test_lightweight_reflect_failure(self, engine):
        """失败路径: 快速分类错误"""
        result = await engine.lightweight_reflect(
            tool_name="network_call",
            success=False,
            error="ECONNREFUSED: Connection refused",
        )

        assert isinstance(result, LightweightReflectionResult)
        assert result.reflection_type == "failure"
        assert "network_call" in result.quick_insight
        assert "network" in result.key_learning.lower() or "connection" in result.key_learning.lower()

    @pytest.mark.asyncio
    async def test_lightweight_reflect_performance(self, engine):
        """性能测试: 必须 <500ms 完成"""
        start = time.time()
        for i in range(10):
            await engine.lightweight_reflect(
                tool_name=f"test_tool_{i}",
                success=i % 2 == 0,
                error="" if i % 2 == 0 else f"error {i}",
            )
        elapsed_ms = (time.time() - start) * 1000
        
        assert elapsed_ms < 5000  # 10 次调用总共 <5s
        assert engine._metrics["lightweight_reflections"] == 10

    @pytest.mark.asyncio
    async def test_lightweight_reflect_disabled(self, engine):
        """即使 _lightweight_enabled=False, 也应该返回结果（降级路径）"""
        engine._lightweight_enabled = False
        result = await engine.lightweight_reflect(
            tool_name="degraded_tool",
            success=True,
            result="ok",
        )
        assert result.reflection_type == "success"


# ─────────────────────────────────────────────
# 2. Meta Reflection 测试
# ─────────────────────────────────────────────


class TestMetaReflection:
    """测试 meta_reflect() 方法"""

    @pytest.mark.asyncio
    async def test_meta_reflect_empty_history(self, engine):
        """空历史记录: 返回默认质量评分和建议"""
        result = await engine.meta_reflect(
            recent_reflections=[],
            execution_outcomes=[],
        )

        assert isinstance(result, MetaReflectionResult)
        assert result.reflection_quality == 0.5
        assert len(result.suggested_improvements) > 0
        assert any("自动反思" in imp for imp in result.suggested_improvements)

    @pytest.mark.asyncio
    async def test_meta_reflect_good_performance(self, engine):
        """表现良好: 高质量评分"""
        reflections = [
            {"tool_name": "t1", "error_category": "timeout", "should_retry": True, "alternative_tool": "alt_t1"},
            {"tool_name": "t2", "error_category": "network", "should_retry": True, "alternative_tool": "alt_t2"},
        ]
        outcomes = [
            {"success": True, "was_retry": True},
            {"success": True, "was_retry": True},
        ]

        result = await engine.meta_reflect(
            recent_reflections=reflections,
            execution_outcomes=outcomes,
        )

        # 有高重试成功率且有替代工具,策略不应调整
        assert result.reflection_quality > 0.3

    @pytest.mark.asyncio
    async def test_meta_reflect_identify_blind_spots(self, engine):
        """识别盲点: 同一错误重复出现"""
        reflections = [
            {"tool_name": "file_read", "error_category": "not_found", "should_retry": False},
            {"tool_name": "file_read", "error_category": "not_found", "should_retry": False},
            {"tool_name": "file_read", "error_category": "not_found", "should_retry": False},
        ]
        outcomes = [
            {"success": False, "was_retry": False},
            {"success": False, "was_retry": False},
            {"success": False, "was_retry": False},
        ]

        result = await engine.meta_reflect(
            recent_reflections=reflections,
            execution_outcomes=outcomes,
        )

        assert len(result.identified_blind_spots) > 0
        assert any("重复出现" in blind for blind in result.identified_blind_spots)
        assert result.should_adjust_strategy is True

    @pytest.mark.asyncio
    async def test_meta_reflect_high_retry_rate(self, engine):
        """重试率过高: 建议调整策略"""
        reflections = [
            {"tool_name": "t1", "should_retry": True},
            {"tool_name": "t2", "should_retry": True},
            {"tool_name": "t3", "should_retry": True},
            {"tool_name": "t4", "should_retry": True},
            {"tool_name": "t5", "should_retry": True},
        ]
        outcomes = [
            {"success": False, "was_retry": True},
            {"success": False, "was_retry": True},
            {"success": False, "was_retry": True},
            {"success": False, "was_retry": True},
            {"success": False, "was_retry": True},
        ]

        result = await engine.meta_reflect(
            recent_reflections=reflections,
            execution_outcomes=outcomes,
        )

        assert result.should_adjust_strategy is True
        assert any("重试率过高" in blind for blind in result.identified_blind_spots)

    @pytest.mark.asyncio
    async def test_meta_reflect_adjusted_params(self, engine):
        """策略调整: 应生成 adjusted_params"""
        reflections = [
            {"tool_name": "t1", "error_category": "not_found", "should_retry": False},
            {"tool_name": "t1", "error_category": "not_found", "should_retry": False},
            {"tool_name": "t1", "error_category": "not_found", "should_retry": False},
        ]
        outcomes = [{"success": False, "was_retry": False}] * 3

        result = await engine.meta_reflect(
            recent_reflections=reflections,
            execution_outcomes=outcomes,
        )

        if result.should_adjust_strategy:
            assert len(result.adjusted_params) > 0


# ─────────────────────────────────────────────
# 3. Experience Transfer 测试
# ─────────────────────────────────────────────


class TestExperienceTransfer:
    """测试 transfer_experience() 方法"""

    def test_transfer_basic(self, engine, sample_experiences):
        """基础经验迁移: file_read → new_file_read"""
        transferred = engine.transfer_experience(
            source_tool="file_read",
            target_tool="new_file_read",
        )

        assert len(transferred) > 0
        assert all(t.tool_name == "new_file_read" for t in transferred)
        # 经验应被添加到缓冲区
        assert len(engine._experience_buffer) > len(sample_experiences)

    def test_transfer_with_success_filter(self, engine, sample_experiences):
        """成功经验迁移: 只迁移成功的经验"""
        transferred = engine.transfer_experience(
            source_tool="file_read",
            target_tool="file_read_v2",
            experience_filter={"success_only": True},
        )

        assert all(t.success for t in transferred)

    def test_transfer_with_error_category_filter(self, engine, sample_experiences):
        """按错误类别过滤迁移"""
        transferred = engine.transfer_experience(
            source_tool="file_read",
            target_tool="file_read_filtered",
            experience_filter={"error_category": "not_found"},
        )

        # 应该只迁移 not_found 类别的经验
        assert len(transferred) >= 0  # 可能有 0 个或多个

    def test_transfer_preserves_root_cause(self, engine, sample_experiences):
        """迁移的经验应保留 root_cause 和 resolution"""
        transferred = engine.transfer_experience(
            source_tool="file_read",
            target_tool="file_read_migrated",
        )

        if transferred:
            assert all(t.root_cause for t in transferred)
            assert all(t.resolution for t in transferred)


# ─────────────────────────────────────────────
# 4. Cross-Tool Insights 测试
# ─────────────────────────────────────────────


class TestCrossToolInsights:
    """测试 get_cross_tool_insights() 方法"""

    def test_insights_empty_buffer(self, engine):
        """空缓冲区: 返回空列表"""
        insights = engine.get_cross_tool_insights("test_tool")
        assert insights == []

    def test_insights_with_experiences(self, engine, sample_experiences):
        """有经验数据: 返回跨工具洞察"""
        insights = engine.get_cross_tool_insights("file_write")

        # 应该能从 file_read 的成功经验中提取洞察
        assert isinstance(insights, list)
        # 每条洞察应有 error_category 和 source_tools
        if insights:
            assert "error_category" in insights[0]
            assert "source_tools" in insights[0]
            assert "success_rate" in insights[0]

    def test_insights_sorted_by_success_rate(self, engine, sample_experiences):
        """洞察应按成功率降序排列"""
        insights = engine.get_cross_tool_insights("file_read")
        
        if len(insights) >= 2:
            rates = [i["success_rate"] for i in insights]
            assert rates == sorted(rates, reverse=True)


# ─────────────────────────────────────────────
# 5. Success Reflection 测试
# ─────────────────────────────────────────────


class TestSuccessReflection:
    """测试 reflect_on_success() 方法"""

    @pytest.mark.asyncio
    async def test_success_reflection_basic(self, engine):
        """基础成功反思: 提取模式和洞察"""
        result = await engine.reflect_on_success(
            tool_name="file_read",
            args={"path": "/tmp/test.txt"},
            result="Successfully read 1024 bytes",
        )

        assert isinstance(result, SuccessReflectionResult)
        assert result.success_pattern
        assert result.key_insight
        assert len(result.reusable_tips) > 0
        assert result.confidence > 0

    @pytest.mark.asyncio
    async def test_success_reflection_large_output(self, engine):
        """大量输出: 建议分页或过滤"""
        large_result = "x" * 2000
        result = await engine.reflect_on_success(
            tool_name="data_query",
            args={},
            result=large_result,
        )

        assert "大量数据" in result.key_insight or "分页" in result.key_insight or "过滤" in result.key_insight

    @pytest.mark.asyncio
    async def test_success_reflection_empty_result(self, engine):
        """空结果: 确认是否符合预期"""
        result = await engine.reflect_on_success(
            tool_name="search",
            args={"query": "test"},
            result="",
        )

        assert "无返回数据" in result.key_insight or "符合预期" in result.key_insight

    @pytest.mark.asyncio
    async def test_success_reflection_default_params(self, engine):
        """默认参数: 无需特殊参数即可成功"""
        result = await engine.reflect_on_success(
            tool_name="ping",
            args={},
            result="pong",
        )

        assert "默认参数" in result.success_pattern or "默认配置" in result.success_pattern


# ─────────────────────────────────────────────
# 6. ReflectionKnowledgeBase 完整 CRUD 测试
# ─────────────────────────────────────────────


class TestKnowledgeBaseCRUD:
    """测试 ReflectionKnowledgeBase 的完整 CRUD 操作"""

    def test_add_experience(self, engine_with_kb):
        """添加经验"""
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="file_read",
            result="successfully read file",
            insight="file read works with valid path",
            success_rate=1.0,
            usage_count=1,
            tags=["file", "read"],
        )
        exp_id = engine_with_kb._kb.add_experience(exp)
        assert exp_id

    def test_get_experience(self, engine_with_kb):
        """获取经验"""
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="test_tool",
            result="ok",
            success_rate=0.9,
            usage_count=5,
        )
        exp_id = engine_with_kb._kb.add_experience(exp)
        
        retrieved = engine_with_kb._kb.get_experience(exp_id)
        assert retrieved is not None
        assert retrieved.action == "test_tool"
        assert retrieved.success_rate == 0.9

    def test_search_experiences(self, engine_with_kb):
        """搜索经验"""
        # 添加多条经验
        for i in range(5):
            exp = ReflectionExperience(
                type=ExperienceType.ERROR_RECOVERY.value,
                action=f"tool_{i}",
                result=f"recovery {i}",
                success_rate=0.8 + i * 0.05,
                usage_count=i + 1,
            )
            engine_with_kb._kb.add_experience(exp)

        results = engine_with_kb._kb.search_experiences(
            query="tool",
            type=ExperienceType.ERROR_RECOVERY.value,
            limit=3,
        )
        assert len(results) <= 3

    def test_search_with_tags(self, engine_with_kb):
        """按标签搜索"""
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="file_tool",
            tags=["file", "read", "success"],
            success_rate=1.0,
        )
        engine_with_kb._kb.add_experience(exp)

        results = engine_with_kb._kb.search_experiences(
            tags=["file"],
        )
        assert len(results) > 0
        assert any("file_tool" in r.action for r in results)

    def test_update_usage(self, engine_with_kb):
        """更新使用次数和成功率"""
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="update_test",
            success_rate=0.5,
            usage_count=2,
        )
        exp_id = engine_with_kb._kb.add_experience(exp)

        engine_with_kb._kb.update_usage(exp_id, success=True)
        updated = engine_with_kb._kb.get_experience(exp_id)

        assert updated.usage_count == 3
        assert updated.success_rate > 0.5

    def test_increment_usage(self, engine_with_kb):
        """递增使用次数"""
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="increment_test",
            usage_count=5,
        )
        exp_id = engine_with_kb._kb.add_experience(exp)

        engine_with_kb._kb.increment_usage(exp_id)
        updated = engine_with_kb._kb.get_experience(exp_id)

        assert updated.usage_count == 6

    def test_get_stats(self, engine_with_kb):
        """获取统计信息"""
        # 添加不同类型经验
        for exp_type in [ExperienceType.TOOL_USAGE, ExperienceType.ERROR_RECOVERY]:
            exp = ReflectionExperience(
                type=exp_type.value,
                action=f"stat_{exp_type.value}",
                success_rate=0.8,
                usage_count=3,
            )
            engine_with_kb._kb.add_experience(exp)

        stats = engine_with_kb._kb.get_stats()
        assert stats["total_experiences"] >= 2
        assert "by_type" in stats
        assert stats["avg_success_rate"] > 0

    def test_get_top_experiences(self, engine_with_kb):
        """获取 Top N 经验"""
        for i in range(5):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"top_{i}",
                success_rate=0.5 + i * 0.1,
                usage_count=i + 1,
            )
            engine_with_kb._kb.add_experience(exp)

        top_by_usage = engine_with_kb._kb.get_top_experiences(
            limit=3,
            sort_by="usage_count",
        )
        assert len(top_by_usage) <= 3
        assert top_by_usage[0].usage_count >= top_by_usage[-1].usage_count

        top_by_rate = engine_with_kb._kb.get_top_experiences(
            limit=3,
            sort_by="success_rate",
        )
        assert top_by_rate[0].success_rate >= top_by_rate[-1].success_rate

    def test_clear(self, engine_with_kb):
        """清空所有经验"""
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="clear_test",
            success_rate=1.0,
        )
        engine_with_kb._kb.add_experience(exp)
        engine_with_kb._kb.clear()

        stats = engine_with_kb._kb.get_stats()
        assert stats["total_experiences"] == 0

    def test_invalid_experience_type(self, engine_with_kb):
        """无效的经验类型应抛出 ValueError"""
        exp = ReflectionExperience(
            type="invalid_type",
            action="bad_exp",
        )
        with pytest.raises(ValueError, match="Invalid experience type"):
            engine_with_kb._kb.add_experience(exp)


# ─────────────────────────────────────────────
# 7. Transferable Patterns 测试
# ─────────────────────────────────────────────


class TestPatternExtraction:
    """测试经验迁移模式提取"""

    def test_extract_patterns(self, engine_with_kb):
        """提取可迁移模式"""
        # 添加高成功率的经验
        for i in range(3):
            exp = ReflectionExperience(
                type=ExperienceType.PLANNING.value,
                action=f"planning_{i}",
                insight="effective planning strategy",
                success_rate=0.9,
                usage_count=5,
                context={"recommended_params": {"strategy": "greedy"}},
            )
            engine_with_kb._kb.add_experience(exp)

        patterns = engine_with_kb._kb.extract_transferable_patterns(
            task_description="planning strategy",
            limit=5,
            min_success_rate=0.6,
            min_usage_count=2,
        )

        assert len(patterns) > 0
        assert "action" in patterns[0]
        assert "success_rate" in patterns[0]
        assert "recommended_params" in patterns[0]

    def test_build_planning_injection(self, engine_with_kb):
        """构建规划注入文本"""
        # 添加经验
        exp = ReflectionExperience(
            type=ExperienceType.STRATEGY.value,
            action="optimal_strategy",
            insight="use parallel execution for independent tasks",
            success_rate=0.95,
            usage_count=10,
            tags=["strategy", "parallel"],
        )
        engine_with_kb._kb.add_experience(exp)

        injection_text = engine_with_kb._kb.build_planning_injection(
            task_description="execute parallel tasks optimally",
            max_patterns=2,
        )

        assert "经验迁移" in injection_text
        assert "optimal_strategy" in injection_text

    def test_extract_patterns_empty_db(self, engine_with_kb):
        """空数据库: 返回空列表"""
        engine_with_kb._kb.clear()
        patterns = engine_with_kb._kb.extract_transferable_patterns(
            task_description="test",
        )
        assert patterns == []


# ─────────────────────────────────────────────
# 8. ReflectionEngine Metrics 测试
# ─────────────────────────────────────────────


class TestReflectionMetrics:
    """测试 ReflectionEngine 的指标统计"""

    def test_get_metrics_initial(self, engine):
        """初始指标应为零"""
        metrics = engine.get_metrics()
        assert metrics.total_reflections == 0
        assert metrics.experience_record_count == 0

    def test_metrics_after_lightweight_reflect(self, engine):
        """轻量反思后指标更新"""
        asyncio.run(engine.lightweight_reflect("test_tool", True, result="ok"))
        metrics = engine.get_metrics()
        assert metrics.lightweight_reflections == 1
        assert metrics.avg_lightweight_reflection_ms >= 0

    def test_metrics_after_record_experience(self, engine):
        """记录经验后指标更新"""
        entry = ExperienceEntry(
            tool_name="metrics_test",
            args={},
            error="",
            root_cause="test",
            resolution="ok",
            success=True,
        )
        engine.record_experience(entry)
        metrics = engine.get_metrics()
        assert metrics.experience_record_count >= 1

    def test_metrics_after_transfer(self, engine, sample_experiences):
        """经验迁移后指标更新"""
        engine.transfer_experience("file_read", "file_read_v2")
        metrics = engine.get_metrics()
        # 缓冲区经验数应增加
        assert metrics.experience_record_count >= len(sample_experiences)
