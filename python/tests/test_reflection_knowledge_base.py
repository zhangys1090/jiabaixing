"""反思经验知识库单元测试。

测试ReflectionKnowledgeBase的所有公共方法，包括：
- 基础功能测试（增删改查）
- 边界条件测试
- 异常情况测试
- 持久化测试
"""

import os
import tempfile
import time
from pathlib import Path

import pytest

from agent.loop.reflection_knowledge_base import (
    ExperienceType,
    ReflectionExperience,
    ReflectionKnowledgeBase,
)


@pytest.fixture
def temp_db_path():
    """创建临时数据库文件路径。"""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        path = f.name
    yield path
    # 清理
    try:
        os.unlink(path)
    except OSError:
        pass


@pytest.fixture
def kb(temp_db_path):
    """创建测试用的知识库实例。"""
    knowledge_base = ReflectionKnowledgeBase(db_path=temp_db_path)
    yield knowledge_base
    knowledge_base.close()


@pytest.fixture
def sample_experience():
    """创建示例经验对象。"""
    return ReflectionExperience(
        type=ExperienceType.TOOL_USAGE.value,
        context={"task_type": "file_operation", "platform": "windows"},
        action="read_file",
        result="成功读取文件内容",
        reflection="文件路径需要使用绝对路径",
        insight="Windows系统下文件路径注意反斜杠转义",
        tags=["file", "read", "windows"],
    )


class TestExperienceType:
    """测试经验类型枚举。"""

    def test_all_types_exist(self):
        """测试所有经验类型都存在。"""
        assert ExperienceType.TOOL_USAGE.value == "tool_usage"
        assert ExperienceType.STRATEGY.value == "strategy"
        assert ExperienceType.PROMPT.value == "prompt"
        assert ExperienceType.ERROR_RECOVERY.value == "error_recovery"
        assert ExperienceType.PLANNING.value == "planning"

    def test_type_count(self):
        """测试经验类型数量。"""
        assert len(ExperienceType) == 6


class TestReflectionExperience:
    """测试经验数据类。"""

    def test_default_values(self):
        """测试默认值。"""
        exp = ReflectionExperience()
        assert exp.id == ""
        assert exp.type == ExperienceType.TOOL_USAGE.value
        assert exp.context == {}
        assert exp.action == ""
        assert exp.result == ""
        assert exp.reflection == ""
        assert exp.insight == ""
        assert exp.timestamp == 0.0
        assert exp.success_rate == 0.0
        assert exp.usage_count == 0
        assert exp.tags == []

    def test_custom_values(self, sample_experience):
        """测试自定义值。"""
        exp = sample_experience
        assert exp.type == "tool_usage"
        assert exp.context["task_type"] == "file_operation"
        assert exp.action == "read_file"
        assert len(exp.tags) == 3


class TestAddExperience:
    """测试添加经验功能。"""

    def test_add_experience(self, kb, sample_experience):
        """测试正常添加经验。"""
        exp_id = kb.add_experience(sample_experience)
        assert exp_id is not None
        assert len(exp_id) > 0

        # 验证能获取到
        retrieved = kb.get_experience(exp_id)
        assert retrieved is not None
        assert retrieved.id == exp_id
        assert retrieved.action == "read_file"

    def test_add_experience_auto_id(self, kb, sample_experience):
        """测试添加经验时自动生成ID。"""
        sample_experience.id = ""
        exp_id = kb.add_experience(sample_experience)
        assert exp_id != ""
        assert len(exp_id) == 32  # uuid hex长度

    def test_add_experience_auto_timestamp(self, kb, sample_experience):
        """测试添加经验时自动设置时间戳。"""
        sample_experience.timestamp = 0
        before = time.time()
        exp_id = kb.add_experience(sample_experience)
        after = time.time()

        retrieved = kb.get_experience(exp_id)
        assert retrieved is not None
        assert before <= retrieved.timestamp <= after

    def test_add_invalid_type_raises(self, kb, sample_experience):
        """测试添加无效类型的经验抛出异常。"""
        sample_experience.type = "invalid_type"
        with pytest.raises(ValueError, match="Invalid experience type"):
            kb.add_experience(sample_experience)

    def test_add_similar_experience_merges(self, kb, sample_experience):
        """测试添加相似经验时合并。"""
        exp_id1 = kb.add_experience(sample_experience)

        # 创建相似经验（相同type和action）
        similar = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="read_file",
            result="新的结果",
            insight="新的洞察",
            tags=["new_tag"],
        )

        exp_id2 = kb.add_experience(similar)

        # 应该是同一个ID（合并了）
        assert exp_id1 == exp_id2

        # 验证合并结果
        merged = kb.get_experience(exp_id1)
        assert merged is not None
        assert merged.result == "新的结果"
        assert merged.insight == "新的洞察"
        assert "new_tag" in merged.tags
        assert merged.usage_count >= 1  # 合并时增加了使用次数


class TestGetExperience:
    """测试获取经验功能。"""

    def test_get_existing_experience(self, kb, sample_experience):
        """测试获取存在的经验。"""
        exp_id = kb.add_experience(sample_experience)
        retrieved = kb.get_experience(exp_id)
        assert retrieved is not None
        assert retrieved.id == exp_id
        assert retrieved.action == sample_experience.action

    def test_get_nonexistent_experience(self, kb):
        """测试获取不存在的经验返回None。"""
        result = kb.get_experience("nonexistent_id")
        assert result is None

    def test_get_experience_fields(self, kb, sample_experience):
        """测试获取的经验所有字段正确。"""
        exp_id = kb.add_experience(sample_experience)
        retrieved = kb.get_experience(exp_id)

        assert retrieved is not None
        assert retrieved.type == sample_experience.type
        assert retrieved.context == sample_experience.context
        assert retrieved.action == sample_experience.action
        assert retrieved.result == sample_experience.result
        assert retrieved.reflection == sample_experience.reflection
        assert retrieved.insight == sample_experience.insight
        assert retrieved.tags == sample_experience.tags


class TestSearchExperiences:
    """测试搜索经验功能。"""

    @pytest.fixture
    def multiple_experiences(self, kb):
        """创建多个测试经验。"""
        exps = [
            ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action="read_file",
                result="读取文件成功",
                insight="文件操作技巧",
                tags=["file", "read"],
            ),
            ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action="write_file",
                result="写入文件成功",
                insight="文件写入注意编码",
                tags=["file", "write"],
            ),
            ReflectionExperience(
                type=ExperienceType.STRATEGY.value,
                action="divide_and_conquer",
                result="分治策略有效",
                insight="复杂任务拆分处理",
                tags=["strategy", "planning"],
            ),
            ReflectionExperience(
                type=ExperienceType.ERROR_RECOVERY.value,
                action="retry_on_timeout",
                result="重试成功",
                insight="网络超时重试机制",
                tags=["error", "network"],
            ),
        ]
        for exp in exps:
            kb.add_experience(exp)
        return exps

    def test_search_by_keyword(self, kb, multiple_experiences):
        """测试按关键词搜索。"""
        results = kb.search_experiences("文件", limit=10)
        assert len(results) >= 2  # 应该找到文件相关的

    def test_search_by_type(self, kb, multiple_experiences):
        """测试按类型过滤搜索。"""
        results = kb.search_experiences("", type="tool_usage", limit=10)
        assert len(results) == 2  # 只有2个tool_usage类型

    def test_search_empty_query(self, kb, multiple_experiences):
        """测试空查询搜索。"""
        results = kb.search_experiences("", limit=10)
        assert len(results) == 4  # 所有4个都返回

    def test_search_limit_zero(self, kb, multiple_experiences):
        """测试limit为0返回空列表。"""
        results = kb.search_experiences("文件", limit=0)
        assert results == []

    def test_search_limit_negative(self, kb, multiple_experiences):
        """测试limit为负数返回空列表。"""
        results = kb.search_experiences("文件", limit=-1)
        assert results == []

    def test_search_no_results(self, kb, multiple_experiences):
        """测试搜索无结果。"""
        results = kb.search_experiences("不存在的关键词xyz123", limit=10)
        assert len(results) == 0

    def test_search_insight_field(self, kb, multiple_experiences):
        """测试搜索insight字段。"""
        results = kb.search_experiences("重试机制", limit=10)
        assert len(results) >= 1
        assert results[0].action == "retry_on_timeout"

    def test_search_tags_field(self, kb, multiple_experiences):
        """测试搜索标签字段。"""
        results = kb.search_experiences("network", limit=10)
        assert len(results) >= 1


class TestGetTopExperiences:
    """测试获取Top经验功能。"""

    @pytest.fixture
    def scored_experiences(self, kb):
        """创建有不同成功率和使用次数的经验。"""
        exps_data = [
            ("tool_a", 0.9, 100),
            ("tool_b", 0.5, 50),
            ("tool_c", 0.1, 200),
            ("strategy_a", 0.8, 30),
        ]
        for action, success_rate, usage_count in exps_data:
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value if action.startswith("tool") else ExperienceType.STRATEGY.value,
                action=action,
                success_rate=success_rate,
                usage_count=usage_count,
            )
            kb.add_experience(exp)
        return exps_data

    def test_get_top_by_success_rate(self, kb, scored_experiences):
        """测试按成功率排序。"""
        results = kb.get_top_experiences(limit=3, sort_by="success_rate")
        assert len(results) == 3
        # 按成功率降序：0.9, 0.8, 0.5
        assert results[0].success_rate == 0.9
        assert results[1].success_rate == 0.8
        assert results[2].success_rate == 0.5

    def test_get_top_by_usage_count(self, kb, scored_experiences):
        """测试按使用次数排序。"""
        results = kb.get_top_experiences(limit=3, sort_by="usage_count")
        assert len(results) == 3
        # 按使用次数降序：200, 100, 50
        assert results[0].usage_count == 200
        assert results[1].usage_count == 100
        assert results[2].usage_count == 50

    def test_get_top_by_type(self, kb, scored_experiences):
        """测试按类型过滤。"""
        results = kb.get_top_experiences(type="tool_usage", limit=10, sort_by="success_rate")
        assert len(results) == 3  # 只有3个tool_usage
        assert all(r.type == "tool_usage" for r in results)

    def test_get_top_invalid_sort_by(self, kb):
        """测试无效的sort_by参数抛出异常。"""
        with pytest.raises(ValueError, match="Invalid sort_by"):
            kb.get_top_experiences(sort_by="invalid")

    def test_get_top_limit_zero(self, kb, scored_experiences):
        """测试limit为0返回空列表。"""
        results = kb.get_top_experiences(limit=0)
        assert results == []

    def test_get_top_limit_negative(self, kb, scored_experiences):
        """测试limit为负数返回空列表。"""
        results = kb.get_top_experiences(limit=-1)
        assert results == []


class TestUpdateSuccessRate:
    """测试更新成功率功能。"""

    def test_update_success_rate_success(self, kb, sample_experience):
        """测试成功时更新成功率。"""
        exp_id = kb.add_experience(sample_experience)
        initial_rate = kb.get_experience(exp_id).success_rate

        kb.update_success_rate(exp_id, success=True)
        updated = kb.get_experience(exp_id)

        assert updated.success_rate > initial_rate
        assert 0 <= updated.success_rate <= 1

    def test_update_success_rate_failure(self, kb, sample_experience):
        """测试失败时更新成功率。"""
        # 先设置一个较高的初始成功率
        sample_experience.success_rate = 0.8
        exp_id = kb.add_experience(sample_experience)

        kb.update_success_rate(exp_id, success=False)
        updated = kb.get_experience(exp_id)

        assert updated.success_rate < 0.8
        assert 0 <= updated.success_rate <= 1

    def test_update_success_rate_increments_usage(self, kb, sample_experience):
        """测试更新成功率时增加使用次数。"""
        exp_id = kb.add_experience(sample_experience)
        initial_usage = kb.get_experience(exp_id).usage_count

        kb.update_success_rate(exp_id, success=True)
        updated = kb.get_experience(exp_id)

        assert updated.usage_count == initial_usage + 1

    def test_update_nonexistent_experience(self, kb):
        """测试更新不存在的经验不报错。"""
        # 应该静默处理，不抛出异常
        kb.update_success_rate("nonexistent_id", success=True)

    def test_success_rate_smoothing(self, kb, sample_experience):
        """测试成功率平滑更新（指数移动平均）。"""
        exp_id = kb.add_experience(sample_experience)

        # 连续多次成功，成功率应该逐渐上升但不会立刻到1
        for i in range(10):
            kb.update_success_rate(exp_id, success=True)

        final_rate = kb.get_experience(exp_id).success_rate
        assert final_rate > 0.5
        assert final_rate < 1.0  # 因为平滑，不会立刻到1


class TestIncrementUsage:
    """测试增加使用次数功能。"""

    def test_increment_usage(self, kb, sample_experience):
        """测试正常增加使用次数。"""
        exp_id = kb.add_experience(sample_experience)
        initial = kb.get_experience(exp_id).usage_count

        kb.increment_usage(exp_id)
        updated = kb.get_experience(exp_id)

        assert updated.usage_count == initial + 1

    def test_increment_usage_multiple_times(self, kb, sample_experience):
        """测试多次增加使用次数。"""
        exp_id = kb.add_experience(sample_experience)
        initial = kb.get_experience(exp_id).usage_count

        for _ in range(5):
            kb.increment_usage(exp_id)

        updated = kb.get_experience(exp_id)
        assert updated.usage_count == initial + 5

    def test_increment_nonexistent_experience(self, kb):
        """测试增加不存在的经验不报错。"""
        kb.increment_usage("nonexistent_id")


class TestGetStats:
    """测试获取统计信息功能。"""

    def test_stats_empty(self, kb):
        """测试空知识库的统计。"""
        stats = kb.get_stats()
        assert stats["total_experiences"] == 0
        assert stats["avg_success_rate"] == 0.0
        assert stats["total_usage_count"] == 0
        assert isinstance(stats["by_type"], dict)

    def test_stats_with_data(self, kb):
        """测试有数据时的统计。"""
        # 添加一些经验（使用唯一的action避免合并）
        for i in range(5):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"stats_tool_{i}",
                success_rate=0.5 + i * 0.1,
                usage_count=i * 10,
            )
            kb.add_experience(exp)

        stats = kb.get_stats()
        assert stats["total_experiences"] == 5
        assert stats["by_type"]["tool_usage"] == 5
        assert stats["total_usage_count"] == 100  # 0+10+20+30+40
        assert 0 < stats["avg_success_rate"] < 1

    def test_stats_multiple_types(self, kb):
        """测试多种类型的统计。"""
        types = [
            ExperienceType.TOOL_USAGE,
            ExperienceType.STRATEGY,
            ExperienceType.PROMPT,
        ]
        for t in types:
            exp = ReflectionExperience(type=t.value, action=f"stats_action_{t.value}")
            kb.add_experience(exp)

        stats = kb.get_stats()
        assert stats["total_experiences"] == 3
        assert len(stats["by_type"]) == 3
        for t in types:
            assert t.value in stats["by_type"]
            assert stats["by_type"][t.value] == 1


class TestClear:
    """测试清空功能。"""

    def test_clear(self, kb, sample_experience):
        """测试清空知识库。"""
        kb.add_experience(sample_experience)
        assert kb.get_stats()["total_experiences"] == 1

        kb.clear()
        assert kb.get_stats()["total_experiences"] == 0

    def test_clear_empty(self, kb):
        """测试清空空知识库不报错。"""
        kb.clear()  # 应该不报错
        assert kb.get_stats()["total_experiences"] == 0

    def test_clear_then_add(self, kb, sample_experience):
        """测试清空后再添加。"""
        kb.add_experience(sample_experience)
        kb.clear()

        new_id = kb.add_experience(sample_experience)
        assert kb.get_experience(new_id) is not None
        assert kb.get_stats()["total_experiences"] == 1


class TestPersistence:
    """测试持久化功能。"""

    def test_data_persists_after_reinit(self, temp_db_path, sample_experience):
        """测试重新初始化后数据保留。"""
        # 第一个实例添加数据
        kb1 = ReflectionKnowledgeBase(db_path=temp_db_path)
        exp_id = kb1.add_experience(sample_experience)
        kb1.close()

        # 第二个实例读取数据
        kb2 = ReflectionKnowledgeBase(db_path=temp_db_path)
        retrieved = kb2.get_experience(exp_id)
        kb2.close()

        assert retrieved is not None
        assert retrieved.id == exp_id
        assert retrieved.action == sample_experience.action

    def test_stats_persist(self, temp_db_path):
        """测试统计信息持久化。"""
        kb1 = ReflectionKnowledgeBase(db_path=temp_db_path)
        for i in range(10):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"tool_{i}",
                success_rate=0.5,
                usage_count=i,
            )
            kb1.add_experience(exp)
        kb1.close()

        kb2 = ReflectionKnowledgeBase(db_path=temp_db_path)
        stats = kb2.get_stats()
        kb2.close()

        assert stats["total_experiences"] == 10
        assert stats["total_usage_count"] == 45  # 0+1+2+...+9

    def test_large_data_persistence(self, temp_db_path):
        """测试大量数据的持久化。"""
        kb1 = ReflectionKnowledgeBase(db_path=temp_db_path)
        for i in range(100):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"tool_{i}",
                result=f"结果_{i}",
                insight=f"洞察_{i}",
                tags=[f"tag_{i}"],
            )
            kb1.add_experience(exp)
        kb1.close()

        kb2 = ReflectionKnowledgeBase(db_path=temp_db_path)
        stats = kb2.get_stats()
        kb2.close()

        assert stats["total_experiences"] == 100


class TestCache:
    """测试缓存功能。"""

    def test_cache_hit(self, kb, sample_experience):
        """测试缓存命中。"""
        exp_id = kb.add_experience(sample_experience)

        # 第一次获取（应该加入缓存）
        _ = kb.get_experience(exp_id)
        assert exp_id in kb._cache

        # 第二次获取（应该从缓存读取）
        retrieved = kb.get_experience(exp_id)
        assert retrieved is not None
        assert retrieved.id == exp_id

    def test_cache_size_limit(self, kb):
        """测试缓存大小限制。"""
        # 添加超过缓存限制的经验
        original_max = kb.MAX_CACHE_SIZE
        kb.MAX_CACHE_SIZE = 10

        for i in range(20):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"tool_{i}",
            )
            kb.add_experience(exp)

        # 缓存大小不应超过限制
        assert len(kb._cache) <= kb.MAX_CACHE_SIZE

        kb.MAX_CACHE_SIZE = original_max

    def test_cache_lru_eviction(self, kb):
        """测试LRU淘汰策略。"""
        original_max = kb.MAX_CACHE_SIZE
        kb.MAX_CACHE_SIZE = 5

        # 添加5个经验
        exp_ids = []
        for i in range(5):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"tool_{i}",
            )
            exp_id = kb.add_experience(exp)
            exp_ids.append(exp_id)

        # 访问前两个，使其成为最近使用
        kb.get_experience(exp_ids[0])
        kb.get_experience(exp_ids[1])

        # 添加第6个，应该淘汰最久未使用的（exp_ids[2]）
        exp6 = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="tool_6",
        )
        kb.add_experience(exp6)

        # 验证：exp_ids[2] 应该被淘汰了
        assert exp_ids[2] not in kb._cache
        # 而最近使用的应该还在
        assert exp_ids[0] in kb._cache
        assert exp_ids[1] in kb._cache

        kb.MAX_CACHE_SIZE = original_max


class TestEdgeCases:
    """测试边界条件。"""

    def test_very_long_strings(self, kb):
        """测试超长字符串字段。"""
        long_string = "x" * 10000
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action=long_string,
            result=long_string,
            insight=long_string,
            reflection=long_string,
        )
        exp_id = kb.add_experience(exp)

        retrieved = kb.get_experience(exp_id)
        assert retrieved is not None
        assert len(retrieved.action) == 10000
        assert len(retrieved.result) == 10000

    def test_empty_context(self, kb):
        """测试空上下文。"""
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="test",
            context={},
        )
        exp_id = kb.add_experience(exp)
        retrieved = kb.get_experience(exp_id)
        assert retrieved.context == {}

    def test_empty_tags(self, kb):
        """测试空标签。"""
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="test",
            tags=[],
        )
        exp_id = kb.add_experience(exp)
        retrieved = kb.get_experience(exp_id)
        assert retrieved.tags == []

    def test_large_context(self, kb):
        """测试大型上下文字典。"""
        large_context = {f"key_{i}": f"value_{i}" for i in range(100)}
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="test",
            context=large_context,
        )
        exp_id = kb.add_experience(exp)
        retrieved = kb.get_experience(exp_id)
        assert len(retrieved.context) == 100

    def test_many_tags(self, kb):
        """测试大量标签。"""
        many_tags = [f"tag_{i}" for i in range(50)]
        exp = ReflectionExperience(
            type=ExperienceType.TOOL_USAGE.value,
            action="test",
            tags=many_tags,
        )
        exp_id = kb.add_experience(exp)
        retrieved = kb.get_experience(exp_id)
        assert len(retrieved.tags) == 50


class TestPerformance:
    """测试性能。"""

    def test_add_100_experiences(self, kb):
        """测试添加100条经验的性能。"""
        start = time.time()
        for i in range(100):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"tool_{i}",
                result=f"result_{i}",
                insight=f"insight_{i}",
                tags=[f"tag_{i}"],
            )
            kb.add_experience(exp)
        elapsed = time.time() - start

        assert kb.get_stats()["total_experiences"] == 100
        assert elapsed < 5.0  # 应该在5秒内完成

    def test_search_100_experiences(self, kb):
        """测试在100条经验中搜索的性能。"""
        # 先添加数据
        for i in range(100):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"tool_{i}",
                result=f"result_{i}",
                insight=f"insight_{i}",
            )
            kb.add_experience(exp)

        # 测试搜索性能
        start = time.time()
        for _ in range(10):
            kb.search_experiences("tool_50", limit=10)
        elapsed = time.time() - start

        assert elapsed < 2.0  # 10次搜索应该在2秒内完成

    def test_get_top_performance(self, kb):
        """测试获取Top经验的性能。"""
        for i in range(100):
            exp = ReflectionExperience(
                type=ExperienceType.TOOL_USAGE.value,
                action=f"tool_{i}",
                success_rate=i / 100.0,
                usage_count=i,
            )
            kb.add_experience(exp)

        start = time.time()
        for _ in range(10):
            kb.get_top_experiences(limit=10, sort_by="success_rate")
        elapsed = time.time() - start

        assert elapsed < 1.0  # 10次查询应该在1秒内完成


class TestAllExperienceTypes:
    """测试所有经验类型都能正常工作。"""

    @pytest.mark.parametrize(
        "exp_type",
        [
            ExperienceType.TOOL_USAGE,
            ExperienceType.STRATEGY,
            ExperienceType.PROMPT,
            ExperienceType.ERROR_RECOVERY,
            ExperienceType.PLANNING,
        ],
    )
    def test_all_types_add_and_get(self, kb, exp_type):
        """测试所有类型都能添加和获取。"""
        exp = ReflectionExperience(
            type=exp_type.value,
            action=f"test_{exp_type.value}",
        )
        exp_id = kb.add_experience(exp)
        retrieved = kb.get_experience(exp_id)

        assert retrieved is not None
        assert retrieved.type == exp_type.value

    @pytest.mark.parametrize(
        "exp_type",
        [
            ExperienceType.TOOL_USAGE,
            ExperienceType.STRATEGY,
            ExperienceType.PROMPT,
            ExperienceType.ERROR_RECOVERY,
            ExperienceType.PLANNING,
        ],
    )
    def test_all_types_search(self, kb, exp_type):
        """测试所有类型都能搜索到。"""
        exp = ReflectionExperience(
            type=exp_type.value,
            action=f"test_{exp_type.value}",
            result=f"result_{exp_type.value}",
        )
        kb.add_experience(exp)

        results = kb.search_experiences(exp_type.value, type=exp_type.value)
        assert len(results) >= 1
        assert results[0].type == exp_type.value
