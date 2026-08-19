"""测试 P1.2 上下文构建器合并。"""

from __future__ import annotations

import pytest

from agent.context.unified_context_pipeline import (
    EmotionInfo,
    SceneInfo,
    TimeContext,
    UnifiedContext,
    UnifiedContextPipeline,
    UserProfile,
)
from agent.context.llm_context_builder import (
    FilteredMemory,
    LLMContextBuilder,
    LLMContextBuilderConfig,
    LLMContextResult,
)
from agent.context.unified_context_builder import (
    ContextBuildOptions,
    ContextBuildResult,
    ContextStats,
    UnifiedContextBuilder,
)


class TestUnifiedContextPipeline:
    """测试 UnifiedContextPipeline。"""

    def test_detect_scene_coding(self):
        pipeline = UnifiedContextPipeline()
        scene = pipeline.detect_scene("帮我写一个排序函数")
        assert scene.type == "coding"
        assert scene.confidence > 0

    def test_detect_scene_analysis(self):
        pipeline = UnifiedContextPipeline()
        scene = pipeline.detect_scene("帮我分析一下这份报告的数据")
        assert scene.type == "analysis"
        assert scene.confidence > 0

    def test_detect_scene_conversation(self):
        pipeline = UnifiedContextPipeline()
        scene = pipeline.detect_scene("你好，今天怎么样")
        assert scene.type == "conversation"

    def test_detect_scene_search(self):
        pipeline = UnifiedContextPipeline()
        scene = pipeline.detect_scene("帮我搜索一下Python教程")
        assert scene.type == "search"

    def test_detect_scene_general(self):
        pipeline = UnifiedContextPipeline()
        scene = pipeline.detect_scene("嗯好的")
        assert scene.type == "general"

    def test_detect_scene_keywords(self):
        pipeline = UnifiedContextPipeline()
        scene = pipeline.detect_scene("帮我写一个函数实现排序")
        assert scene.type == "coding"
        assert len(scene.keywords) > 0

    def test_detect_emotion_happy(self):
        pipeline = UnifiedContextPipeline()
        emotion = pipeline.detect_emotion("太好了，问题解决了！")
        assert emotion.type == "happy"
        assert emotion.intensity > 0

    def test_detect_emotion_sad(self):
        pipeline = UnifiedContextPipeline()
        emotion = pipeline.detect_emotion("很失望，又失败了")
        assert emotion.type == "sad"

    def test_detect_emotion_neutral(self):
        pipeline = UnifiedContextPipeline()
        # 使用不含任何情感关键词的中性输入，验证无匹配时回退 neutral
        emotion = pipeline.detect_emotion("明白了")
        assert emotion.type == "neutral"

    def test_detect_emotion_curious(self):
        pipeline = UnifiedContextPipeline()
        emotion = pipeline.detect_emotion("为什么这个函数不工作")
        assert emotion.type == "curious"

    def test_build_time_context(self):
        pipeline = UnifiedContextPipeline()
        tc = pipeline.build_time_context()
        assert isinstance(tc, TimeContext)
        assert 0 <= tc.hour <= 23
        assert tc.time_slot in ("morning", "noon", "afternoon", "evening", "night")
        assert tc.timestamp > 0

    def test_build_user_profile(self):
        pipeline = UnifiedContextPipeline()
        profile = pipeline.build_user_profile("user_1")
        assert isinstance(profile, UserProfile)
        assert profile.expertise_level == "intermediate"

    def test_get_sovereignty_score(self):
        pipeline = UnifiedContextPipeline()
        score = pipeline.get_sovereignty_score()
        assert score == 1.0

    def test_build_context_sync(self):
        pipeline = UnifiedContextPipeline()
        ctx = pipeline.build_context_sync("帮我写代码", "user_1")
        assert isinstance(ctx, UnifiedContext)
        assert ctx.scene.type == "coding"
        assert isinstance(ctx.emotion, EmotionInfo)
        assert isinstance(ctx.time_context, TimeContext)

    def test_scene_confidence_range(self):
        pipeline = UnifiedContextPipeline()
        scene = pipeline.detect_scene("帮我写一个函数实现排序算法")
        assert 0.0 <= scene.confidence <= 1.0

    def test_emotion_intensity_range(self):
        pipeline = UnifiedContextPipeline()
        emotion = pipeline.detect_emotion("太开心了！")
        assert 0.0 <= emotion.intensity <= 1.0
        assert 0.0 <= emotion.confidence <= 1.0


class TestLLMContextBuilder:
    """测试 LLMContextBuilder。"""

    def test_basic_build(self):
        builder = LLMContextBuilder()
        raw = [
            {"content": "用户喜欢Python", "relevance": 0.8, "type": "semantic"},
            {"content": "用户喜欢简洁代码", "relevance": 0.6, "type": "semantic"},
        ]
        result = builder.build(raw, scene="coding")
        assert isinstance(result, LLMContextResult)
        assert len(result.memories) == 2

    def test_min_relevance_filter(self):
        config = LLMContextBuilderConfig(min_relevance=0.5)
        builder = LLMContextBuilder(config)
        raw = [
            {"content": "relevant", "relevance": 0.8},
            {"content": "irrelevant", "relevance": 0.1},
        ]
        result = builder.build(raw)
        assert len(result.memories) == 1
        assert result.filtered_count == 1

    def test_max_memories_limit(self):
        config = LLMContextBuilderConfig(max_memories=2)
        builder = LLMContextBuilder(config)
        raw = [
            {"content": f"memory_{i}", "relevance": 0.8 - i * 0.1}
            for i in range(5)
        ]
        result = builder.build(raw)
        assert len(result.memories) == 2

    def test_deduplication(self):
        config = LLMContextBuilderConfig(enable_deduplication=True)
        builder = LLMContextBuilder(config)
        raw = [
            {"content": "duplicate content", "relevance": 0.8},
            {"content": "duplicate content", "relevance": 0.7},
            {"content": "unique content", "relevance": 0.6},
        ]
        result = builder.build(raw)
        assert result.deduplicated_count >= 1

    def test_scene_weight_affects_scoring(self):
        builder = LLMContextBuilder()
        raw = [
            {"content": "code review tip", "relevance": 0.5, "type": "procedural"},
        ]
        result_coding = builder.build(raw, scene="coding")
        result_conversation = builder.build(raw, scene="conversation")

        assert result_coding.memories[0].relevance > result_conversation.memories[0].relevance

    def test_build_simple(self):
        builder = LLMContextBuilder()
        raw = [
            {"content": "memory 1", "relevance": 0.8, "type": "semantic"},
            {"content": "memory 2", "relevance": 0.3, "type": "episodic"},
        ]
        result = builder.build_simple(raw, scene="coding")
        assert isinstance(result, list)
        assert len(result) == 2
        assert result[0]["content"] == "memory 1"

    def test_type_weight_affects_scoring(self):
        builder = LLMContextBuilder()
        raw = [
            {"content": "procedural memory", "relevance": 0.5, "type": "procedural"},
            {"content": "general memory", "relevance": 0.5, "type": "general"},
        ]
        result = builder.build(raw)
        scores = [m.relevance for m in result.memories]
        assert scores[0] > scores[1]

    def test_empty_input(self):
        builder = LLMContextBuilder()
        result = builder.build([])
        assert len(result.memories) == 0
        assert result.total_tokens == 0

    def test_config_defaults(self):
        config = LLMContextBuilderConfig()
        assert config.max_memories == 8
        assert config.min_relevance == 0.15
        assert config.max_total_length == 2000
        assert config.enable_deduplication is True
        assert config.enable_compression is True


class TestUnifiedContextBuilder:
    """测试 UnifiedContextBuilder。"""

    def test_basic_build_sync(self):
        builder = UnifiedContextBuilder()
        result = builder.build_context_sync(
            user_input="帮我写代码",
            user_id="user_1",
        )

        assert isinstance(result, ContextBuildResult)
        assert result.status == "success"
        assert len(result.messages) > 0
        assert result.system_prompt != ""

    def test_build_without_system_prompt(self):
        builder = UnifiedContextBuilder()
        result = builder.build_context_sync(
            user_input="hello",
            user_id="user_1",
            include_system_prompt=False,
        )

        assert result.system_prompt == ""

    def test_build_without_memory(self):
        builder = UnifiedContextBuilder()
        result = builder.build_context_sync(
            user_input="hello",
            include_memory=False,
        )

        assert len(result.memories) == 0

    def test_build_includes_user_message(self):
        builder = UnifiedContextBuilder()
        result = builder.build_context_sync(
            user_input="hello world",
        )

        user_messages = [m for m in result.messages if m["role"] == "user"]
        assert len(user_messages) >= 1
        assert any("hello world" in m["content"] for m in user_messages)

    def test_build_with_history(self):
        builder = UnifiedContextBuilder()
        history = [
            {"role": "user", "content": "之前的问题"},
            {"role": "assistant", "content": "之前的回答"},
        ]
        result = builder.build_context_sync(
            user_input="新问题",
            history=history,
        )

        assert len(result.messages) >= 3

    def test_build_history_limit(self):
        builder = UnifiedContextBuilder()
        history = [{"role": "user", "content": f"msg_{i}"} for i in range(30)]
        result = builder.build_context_sync(
            user_input="new",
            history=history,
            history_limit=5,
        )

        history_messages = [
            m for m in result.messages
            if m["content"].startswith("msg_")
        ]
        assert len(history_messages) <= 5

    def test_build_scene_detection(self):
        builder = UnifiedContextBuilder()
        result = builder.build_context_sync(
            user_input="帮我写一个排序函数",
        )

        assert result.unified_context is not None
        assert result.unified_context.scene.type == "coding"

    def test_build_stats(self):
        builder = UnifiedContextBuilder()
        result = builder.build_context_sync(
            user_input="hello",
        )

        assert isinstance(result.stats, ContextStats)
        assert result.stats.total_messages > 0
        assert result.stats.build_time_ms > 0

    def test_build_count_tracking(self):
        builder = UnifiedContextBuilder()
        initial = builder.build_count

        builder.build_context_sync(user_input="msg1")
        builder.build_context_sync(user_input="msg2")

        assert builder.build_count == initial + 2

    def test_cache_hit(self):
        builder = UnifiedContextBuilder()
        builder.build_context_sync(user_input="hello")

        cache_checks_before = builder._cache_checks
        cache_hits_before = builder._cache_hits

        builder.build_context_sync(user_input="hello")

        assert builder._cache_checks == cache_checks_before + 1
        assert builder._cache_hits == cache_hits_before + 1

    def test_clear_cache(self):
        builder = UnifiedContextBuilder()
        builder.build_context_sync(user_input="hello")
        builder.clear_cache()

        assert builder.cache_hit_rate == 0.0

    def test_reset_stats(self):
        builder = UnifiedContextBuilder()
        builder.build_context_sync(user_input="hello")
        builder.reset_stats()

        assert builder.build_count == 0
        assert builder.average_build_time_ms == 0.0

    def test_singleton(self):
        UnifiedContextBuilder.reset_instance()
        b1 = UnifiedContextBuilder.get_instance()
        b2 = UnifiedContextBuilder.get_instance()
        assert b1 is b2

    def test_different_scenes(self):
        builder = UnifiedContextBuilder()
        result1 = builder.build_context_sync(user_input="帮我写代码")
        result2 = builder.build_context_sync(user_input="你好吗")

        assert result1.unified_context.scene.type == "coding"
        assert result2.unified_context.scene.type == "conversation"

    def test_no_user_input(self):
        builder = UnifiedContextBuilder()
        result = builder.build_context_sync(user_input="")

        assert result.status == "success"
        assert len(result.messages) >= 0


class TestContextBuildOptions:
    """测试 ContextBuildOptions。"""

    def test_defaults(self):
        options = ContextBuildOptions()
        assert options.include_system_prompt is True
        assert options.include_memory is True
        assert options.include_file_context is False
        assert options.resolve_references is False
        assert options.max_tokens == 4096
        assert options.history_limit == 20

    def test_custom_values(self):
        options = ContextBuildOptions(
            user_input="hello",
            user_id="user_1",
            max_tokens=2048,
            scene="coding",
        )
        assert options.user_input == "hello"
        assert options.max_tokens == 2048
        assert options.scene == "coding"
