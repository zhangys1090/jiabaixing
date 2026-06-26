"""GAP实现单元测试。

测试所有10个架构差距的实现是否符合验收标准。
"""

import sys
import os
import time
import unittest

# 添加项目路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestGAP01ActiveReflection(unittest.TestCase):
    """GAP-01：主动反思机制增强测试。"""

    def setUp(self):
        from agent.loop.reflection import ReflectionEngine
        self.engine = ReflectionEngine(enable_kb=False)

    def test_success_reflection(self):
        """测试成功反思功能。"""
        import asyncio

        async def test():
            result = await self.engine.reflect_on_success(
                tool_name="test_tool",
                args={"param1": "value1"},
                result="执行成功，返回数据",
            )
            return result

        result = asyncio.run(test())

        self.assertIsNotNone(result)
        self.assertTrue(hasattr(result, 'success_pattern'))
        self.assertTrue(hasattr(result, 'key_insight'))
        self.assertTrue(hasattr(result, 'reusable_tips'))
        self.assertIsInstance(result.reusable_tips, list)
        self.assertGreater(len(result.success_pattern), 0)

    def test_lightweight_reflection_success(self):
        """测试轻量级反思（成功路径）。"""
        import asyncio

        async def test():
            result = await self.engine.lightweight_reflect(
                tool_name="test_tool",
                success=True,
                args={"param": "value"},
                result="成功结果",
            )
            return result

        result = asyncio.run(test())

        self.assertIsNotNone(result)
        self.assertEqual(result.reflection_type, "success")
        self.assertGreater(len(result.quick_insight), 0)
        self.assertLess(result.duration_ms, 100)  # 确保轻量级，<100ms

    def test_lightweight_reflection_failure(self):
        """测试轻量级反思（失败路径）。"""
        import asyncio

        async def test():
            result = await self.engine.lightweight_reflect(
                tool_name="test_tool",
                success=False,
                error="测试错误",
            )
            return result

        result = asyncio.run(test())

        self.assertIsNotNone(result)
        self.assertEqual(result.reflection_type, "failure")
        self.assertIn("失败", result.quick_insight)

    def test_metrics_include_new_stats(self):
        """测试指标包含新的统计项。"""
        metrics = self.engine.get_metrics()

        self.assertTrue(hasattr(metrics, 'success_reflections'))
        self.assertTrue(hasattr(metrics, 'lightweight_reflections'))
        self.assertTrue(hasattr(metrics, 'avg_lightweight_reflection_ms'))

    def test_lightweight_reflection_performance(self):
        """测试轻量级反思性能（<500ms）。"""
        import asyncio

        async def test():
            start = time.time()
            for _ in range(10):
                await self.engine.lightweight_reflect(
                    tool_name="test_tool",
                    success=True,
                    result="测试",
                )
            return (time.time() - start) * 1000 / 10

        avg_ms = asyncio.run(test())

        self.assertLess(avg_ms, 500, f"轻量级反思平均耗时 {avg_ms:.2f}ms，超过500ms阈值")


class TestGAP02AutoEvolutionTrigger(unittest.TestCase):
    """GAP-02：自动进化触发机制测试。"""

    def test_performance_monitor_creation(self):
        """测试性能监控器创建。"""
        from agent.evolution.monitor import PerformanceMonitor, PerformanceThresholds

        config = PerformanceThresholds(
            consecutive_failures=3,
            window_size=50,
        )
        monitor = PerformanceMonitor(thresholds=config)

        self.assertIsNotNone(monitor)
        self.assertTrue(monitor.enabled)

    def test_performance_monitor_record_metric(self):
        """测试记录性能指标。"""
        from agent.evolution.monitor import PerformanceMonitor

        monitor = PerformanceMonitor()
        monitor.record_metric("test_task", success=True, duration=1.0)
        monitor.record_metric("test_task", success=False, duration=2.0)

        stats = monitor.get_metric_stats("test_task")
        self.assertEqual(stats["count"], 2)
        self.assertEqual(stats["success_count"], 1)
        self.assertEqual(stats["consecutive_failures"], 1)

    def test_consecutive_failures_alert(self):
        """测试连续失败告警。"""
        from agent.evolution.monitor import PerformanceMonitor, PerformanceThresholds

        config = PerformanceThresholds(consecutive_failures=3)
        monitor = PerformanceMonitor(thresholds=config)

        # 触发3次连续失败
        for i in range(3):
            monitor.record_metric("test_task", success=False)

        alerts = monitor.check_alerts()
        self.assertGreater(len(alerts), 0)

        # 检查是否有连续失败告警
        has_consecutive = any(
            a.type == "consecutive_failures" for a in alerts
        )
        self.assertTrue(has_consecutive)

    def test_evolution_trigger_creation(self):
        """测试进化触发器创建。"""
        from agent.evolution.trigger import (
            EvolutionTrigger,
            EvolutionTriggerConfig,
        )
        from agent.evolution.monitor import PerformanceMonitor
        from agent.evolution.v2_engine import EvolutionEngineV2

        monitor = PerformanceMonitor()
        engine = EvolutionEngineV2()
        config = EvolutionTriggerConfig(
            min_evolution_interval=60,
            max_daily_evolutions=5,
        )

        trigger = EvolutionTrigger(engine, monitor, config=config)
        self.assertIsNotNone(trigger)
        self.assertTrue(trigger.enabled)

    def test_trigger_strategy_moderate(self):
        """测试适度触发策略。"""
        from agent.evolution.trigger import (
            EvolutionTrigger,
            EvolutionTriggerConfig,
            TriggerStrategy,
        )
        from agent.evolution.monitor import PerformanceMonitor
        from agent.evolution.v2_engine import EvolutionEngineV2

        monitor = PerformanceMonitor()
        engine = EvolutionEngineV2()
        trigger = EvolutionTrigger(engine, monitor)

        trigger.set_strategy(TriggerStrategy.MODERATE.value)
        stats = trigger.get_trigger_stats()

        self.assertEqual(stats["strategy"], TriggerStrategy.MODERATE.value)


class TestGAP03ExperienceGeneralization(unittest.TestCase):
    """GAP-03：经验泛化与迁移测试。"""

    def test_generalizer_creation(self):
        """测试泛化器创建。"""
        from agent.evolution.fewshot_generalizer import FewShotGeneralizer

        generalizer = FewShotGeneralizer(
            min_experiences_for_generalization=2,
            similarity_threshold=0.3,
        )

        self.assertIsNotNone(generalizer)
        self.assertTrue(generalizer.enabled)

    def test_generalize_from_experiences(self):
        """测试从经验中泛化。"""
        from agent.evolution.fewshot_generalizer import FewShotGeneralizer
        from agent.loop.reflection_knowledge_base import ReflectionExperience

        generalizer = FewShotGeneralizer(
            min_experiences_for_generalization=2,
            similarity_threshold=0.3,
        )

        # 创建3个相似经验
        experiences = []
        for i in range(3):
            exp = ReflectionExperience(
                id=f"exp_{i}",
                type="tool_usage",
                action="file_read",
                result=f"成功读取文件 {i}",
                insight="读取文件时注意编码",
                success_rate=0.8,
                tags=["file", "read"],
            )
            experiences.append(exp)

        pattern = generalizer.generalize_from_experiences(experiences)

        self.assertIsNotNone(pattern)
        self.assertEqual(len(pattern.source_experiences), 3)
        self.assertGreater(pattern.confidence, 0)
        self.assertGreater(len(pattern.key_insights), 0)

    def test_experience_migration(self):
        """测试经验迁移。"""
        from agent.evolution.fewshot_generalizer import FewShotGeneralizer
        from agent.loop.reflection_knowledge_base import ReflectionExperience

        generalizer = FewShotGeneralizer()

        source_exp = ReflectionExperience(
            id="source_1",
            type="tool_usage",
            action="file_read",
            result="成功",
            insight="注意编码格式",
            success_rate=0.9,
            context={"domain": "text_processing"},
            tags=["file"],
        )

        target_context = {"domain": "data_analysis", "task": "read_csv"}

        migrated = generalizer.migrate_experience(source_exp, target_context)

        self.assertIsNotNone(migrated)
        self.assertIn("migrated", migrated.id)
        self.assertEqual(migrated.context, target_context)
        self.assertIn("migrated", migrated.tags)

    def test_similarity_calculation(self):
        """测试相似度计算。"""
        from agent.evolution.fewshot_generalizer import FewShotGeneralizer
        from agent.loop.reflection_knowledge_base import ReflectionExperience

        generalizer = FewShotGeneralizer()

        exp1 = ReflectionExperience(
            id="1",
            type="tool_usage",
            action="file_read",
            insight="读取文件",
            tags=["file", "read"],
        )

        exp2 = ReflectionExperience(
            id="2",
            type="tool_usage",
            action="file_write",
            insight="写入文件",
            tags=["file", "write"],
        )

        # 直接调用相似度计算（通过内部方法）
        similarity = generalizer._calculate_similarity(exp1, exp2)

        self.assertGreaterEqual(similarity, 0.0)
        self.assertLessEqual(similarity, 1.0)
        # 两个文件操作应该有一定相似度
        self.assertGreater(similarity, 0.2)


class TestGAP04AttentionFocus(unittest.TestCase):
    """GAP-04：主动上下文管理与注意力聚焦测试。"""

    def test_attention_focus_creation(self):
        """测试注意力聚焦适配器创建。"""
        from agent.context.adapters.attention_focus import (
            AttentionFocusAdapter,
            AttentionFocusConfig,
        )

        config = AttentionFocusConfig(
            compression_target_ratio=0.3,
            preserve_recent_messages=5,
        )
        adapter = AttentionFocusAdapter(config=config)

        self.assertIsNotNone(adapter)
        self.assertEqual(adapter.name, "attention_focus")
        self.assertTrue(adapter.enabled)

    def test_message_scoring(self):
        """测试消息重要性评分。"""
        from agent.context.adapters.attention_focus import AttentionFocusAdapter

        adapter = AttentionFocusAdapter()

        messages = [
            {"role": "system", "content": "你是一个助手"},
            {"role": "user", "content": "请帮我写一个Python脚本，实现文件读取功能，需要处理错误和异常情况"},
            {"role": "assistant", "content": "好的，我来帮你写。"},
            {"role": "user", "content": "好的"},
        ]

        scores = adapter.score_messages(messages)

        self.assertEqual(len(scores), len(messages))
        for score in scores:
            self.assertGreaterEqual(score.importance_score, 0.0)
            self.assertLessEqual(score.importance_score, 1.0)
            self.assertIn(score.category, ["critical", "important", "normal", "low"])

        # 系统消息应该分数较高
        system_score = scores[0]
        self.assertGreaterEqual(system_score.importance_score, 0.4)

        # 内容丰富的用户消息应该分数较高
        user_score = scores[1]
        short_user_score = scores[3]
        self.assertGreater(user_score.importance_score, short_user_score.importance_score)

    def test_message_compression(self):
        """测试消息压缩功能。"""
        from agent.context.adapters.attention_focus import AttentionFocusAdapter

        adapter = AttentionFocusAdapter()

        # 创建较多消息
        messages = []
        for i in range(20):
            if i % 5 == 0:
                content = f"这是第 {i} 条重要消息，包含关键信息和错误处理说明。"
            else:
                content = f"普通消息 {i}"
            messages.append({"role": "user", "content": content})

        # 计算原始token数
        original_tokens = sum(
            len(m["content"]) // 3 + 10 for m in messages
        )

        # 压缩到50%
        target_tokens = int(original_tokens * 0.5)
        compressed = adapter.compress_messages(messages, target_tokens)

        self.assertLess(len(compressed), len(messages))

        # 计算压缩后的token数
        compressed_tokens = sum(
            len(m["content"]) // 3 + 10 for m in compressed
        )

        # 应该接近目标token数
        self.assertLessEqual(compressed_tokens, original_tokens)

    def test_preserve_system_messages(self):
        """测试系统消息始终保留。"""
        from agent.context.adapters.attention_focus import (
            AttentionFocusAdapter,
            AttentionFocusConfig,
        )

        config = AttentionFocusConfig(preserve_system_messages=True)
        adapter = AttentionFocusAdapter(config=config)

        messages = [
            {"role": "system", "content": "系统提示1"},
            {"role": "system", "content": "系统提示2"},
            {"role": "user", "content": "用户消息"},
        ]

        compressed = adapter.compress_messages(messages, max_tokens=50)

        # 系统消息应该都保留
        system_count = sum(1 for m in compressed if m["role"] == "system")
        self.assertEqual(system_count, 2)


class TestGAP05IncrementalReplanning(unittest.TestCase):
    """GAP-05：增量重规划测试。"""

    def test_incremental_planner_creation(self):
        """测试增量规划器创建。"""
        from agent.loop.incremental_planner import IncrementalPlanner

        planner = IncrementalPlanner(max_changes_per_replan=10)

        self.assertIsNotNone(planner)
        self.assertTrue(planner.enabled)

    def test_incremental_replan(self):
        """测试增量重规划。"""
        from agent.loop.incremental_planner import (
            IncrementalPlanner,
            PlanStep,
        )

        planner = IncrementalPlanner()

        # 创建原始计划
        original_plan = [
            PlanStep(step_id="s1", description="步骤1", order=0),
            PlanStep(step_id="s2", description="步骤2", dependencies=["s1"], order=1),
            PlanStep(step_id="s3", description="步骤3", dependencies=["s2"], order=2),
            PlanStep(step_id="s4", description="步骤4", dependencies=["s3"], order=3),
        ]

        # 标记s2为已完成
        original_plan[0].status = "completed"

        # 触发s2失败，进行重规划
        result = planner.incremental_replan(
            original_plan,
            trigger_step_id="s2",
            reason="步骤2执行失败",
        )

        self.assertTrue(result.success)
        self.assertGreater(len(result.affected_steps), 0)
        self.assertGreater(result.preserved_steps, 0)

        # 应该保留已完成的步骤
        self.assertGreaterEqual(result.preserved_steps, 1)

    def test_impact_analysis(self):
        """测试影响范围分析。"""
        from agent.loop.incremental_planner import (
            IncrementalPlanner,
            PlanStep,
        )

        planner = IncrementalPlanner()

        plan = [
            PlanStep(step_id="s1", description="步骤1", order=0),
            PlanStep(step_id="s2", description="步骤2", dependencies=["s1"], order=1),
            PlanStep(step_id="s3", description="步骤3", dependencies=["s2"], order=2),
            PlanStep(step_id="s4", description="步骤4", dependencies=["s1"], order=3),
        ]

        # s1失败，应该影响s2, s3, s4
        affected = planner._analyze_impact(plan, "s1")
        self.assertIn("s1", affected)
        self.assertIn("s2", affected)
        self.assertIn("s3", affected)
        self.assertIn("s4", affected)

        # s2失败，应该影响s3，不影响s4
        affected = planner._analyze_impact(plan, "s2")
        self.assertIn("s2", affected)
        self.assertIn("s3", affected)
        self.assertNotIn("s4", affected)

    def test_preserve_completed_steps(self):
        """测试保留已完成步骤。"""
        from agent.loop.incremental_planner import (
            IncrementalPlanner,
            PlanStep,
        )

        planner = IncrementalPlanner(preserve_completed_steps=True)

        plan = [
            PlanStep(step_id="s1", description="步骤1", status="completed", order=0),
            PlanStep(step_id="s2", description="步骤2", dependencies=["s1"], status="completed", order=1),
            PlanStep(step_id="s3", description="步骤3", dependencies=["s2"], order=2),
        ]

        # s2失败，但已完成，应该不影响
        affected = planner._analyze_impact(plan, "s2")
        self.assertNotIn("s1", affected)  # s1已完成，不受影响


class TestGAP06StrategyAdapter(unittest.TestCase):
    """GAP-06：细粒度策略自适应测试。"""

    def test_strategy_adapter_creation(self):
        """测试策略适配器创建。"""
        from agent.evolution.strategy_adapter import StrategyAdapter

        adapter = StrategyAdapter(
            default_exploration_rate=0.2,
            min_usage_for_adaptation=3,
        )

        self.assertIsNotNone(adapter)
        self.assertTrue(adapter.enabled)

    def test_register_strategy(self):
        """测试注册策略。"""
        from agent.evolution.strategy_adapter import StrategyAdapter

        adapter = StrategyAdapter()

        adapter.register_strategy(
            task_type="file_operation",
            strategy_name="strategy_a",
            params={"timeout": 30},
        )

        strategies = adapter.get_strategies("file_operation")
        self.assertIn("strategy_a", strategies)

    def test_record_outcome(self):
        """测试记录结果。"""
        from agent.evolution.strategy_adapter import StrategyAdapter

        adapter = StrategyAdapter()

        adapter.register_strategy("task1", "strategy_a")

        # 记录一些结果
        for i in range(10):
            adapter.record_outcome("task1", "strategy_a", success=(i % 2 == 0))

        stats = adapter.get_strategy_stats("task1", "strategy_a")
        self.assertEqual(stats["usage_count"], 10)
        self.assertEqual(stats["success_count"], 5)
        self.assertAlmostEqual(stats["success_rate"], 0.5, delta=0.2)

    def test_get_best_strategy(self):
        """测试获取最佳策略。"""
        from agent.evolution.strategy_adapter import StrategyAdapter

        adapter = StrategyAdapter(default_exploration_rate=0.0)  # 关闭探索

        adapter.register_strategy("task1", "strategy_a")
        adapter.register_strategy("task1", "strategy_b")

        # strategy_a成功率高
        for _ in range(10):
            adapter.record_outcome("task1", "strategy_a", success=True)
        for _ in range(10):
            adapter.record_outcome("task1", "strategy_b", success=False)

        best = adapter.get_best_strategy("task1")

        self.assertIsNotNone(best)
        self.assertEqual(best.strategy_name, "strategy_a")
        self.assertGreater(best.expected_success_rate, 0.5)

    def test_strategy_params(self):
        """测试策略参数管理。"""
        from agent.evolution.strategy_adapter import StrategyAdapter

        adapter = StrategyAdapter()

        adapter.register_strategy(
            "task1", "strategy_a", params={"timeout": 30, "retry": 3}
        )

        # 获取参数
        params = adapter.get_strategy_params("task1", "strategy_a")
        self.assertEqual(params["timeout"], 30)
        self.assertEqual(params["retry"], 3)

        # 更新参数
        success = adapter.update_strategy_params(
            "task1", "strategy_a", {"timeout": 60}
        )
        self.assertTrue(success)

        params = adapter.get_strategy_params("task1", "strategy_a")
        self.assertEqual(params["timeout"], 60)
        self.assertEqual(params["retry"], 3)  # 其他参数保留


class TestGAP07MemoryCurator(unittest.TestCase):
    """GAP-07：自动化记忆策展测试。"""

    def test_curator_creation(self):
        """测试记忆策展人创建。"""
        from agent.memory.curator import MemoryCurator, CuratorConfig

        config = CuratorConfig(
            forget_threshold=0.3,
            max_memories=1000,
        )
        curator = MemoryCurator(config=config)

        self.assertIsNotNone(curator)
        self.assertTrue(curator.enabled)

    def test_importance_assessment(self):
        """测试重要性评估。"""
        from agent.memory.curator import MemoryCurator

        curator = MemoryCurator()

        # 测试不同类型的记忆
        score1 = curator.assess_importance(
            memory_id="mem1",
            memory_content="这是一条重要的错误处理经验，包含详细的解决方案和代码示例。",
            memory_type="episodic",
            metadata={"important": True},
        )

        score2 = curator.assess_importance(
            memory_id="mem2",
            memory_content="普通记忆",
            memory_type="general",
        )

        self.assertGreater(score1.total_score, score2.total_score)
        self.assertIn(score1.category, ["critical", "important", "normal", "low", "obsolete"])
        self.assertIn(score2.category, ["critical", "important", "normal", "low", "obsolete"])

    def test_usage_recording(self):
        """测试使用记录。"""
        from agent.memory.curator import MemoryCurator

        curator = MemoryCurator()

        # 记录使用
        for _ in range(5):
            curator.record_usage("mem1")

        curator.record_usage("mem2")

        # 评估重要性
        score1 = curator.assess_importance("mem1")
        score2 = curator.assess_importance("mem2")

        # 使用频率高的应该分数更高
        self.assertGreater(score1.frequency_score, score2.frequency_score)

    def test_curation(self):
        """测试策展功能。"""
        from agent.memory.curator import MemoryCurator

        curator = MemoryCurator()

        # 创建一些记忆，模拟高频访问的重要记忆
        memories = []
        for i in range(20):
            mem_id = f"mem_{i}"
            # 模拟高频使用
            for _ in range(i % 10):
                curator.record_usage(mem_id)
            memories.append({
                "id": mem_id,
                "content": f"这是一段较长的记忆内容用于测试重要性评分是否正确工作 {i}" * 3,
                "type": "episodic",
                "metadata": {"important": i < 8},
            })

        # 执行策展
        result = curator.curate(memories, force=True)

        self.assertTrue(result["curated"])
        self.assertEqual(result["total_memories"], 20)
        self.assertGreaterEqual(result["to_consolidate"], 0)
        self.assertGreaterEqual(result["to_forget"], 0)
        self.assertGreater(result["avg_importance_score"], 0)


class TestGAP08PlanQualityChecker(unittest.TestCase):
    """GAP-08：规划质量预检测试。"""

    def test_quality_checker_creation(self):
        """测试质量检查器创建。"""
        from agent.loop.plan_quality_checker import (
            PlanQualityChecker,
            QualityCheckerConfig,
        )

        config = QualityCheckerConfig(pass_threshold=0.5)
        checker = PlanQualityChecker(config=config)

        self.assertIsNotNone(checker)
        self.assertTrue(checker.enabled)

    def test_good_plan_check(self):
        """测试好计划的检查。"""
        from agent.loop.plan_quality_checker import PlanQualityChecker

        checker = PlanQualityChecker()

        good_plan = [
            {
                "id": "s1",
                "description": "读取文件",
                "tool": "file_reader",
                "dependencies": [],
            },
            {
                "id": "s2",
                "description": "处理数据",
                "tool": "data_processor",
                "dependencies": ["s1"],
            },
            {
                "id": "s3",
                "description": "验证结果",
                "tool": "result_validator",
                "dependencies": ["s2"],
            },
        ]

        result = checker.check_plan(good_plan)

        self.assertGreater(result.quality_score, 0.5)
        self.assertTrue(result.is_passed)
        self.assertGreater(result.completeness_score, 0)
        self.assertGreater(result.feasibility_score, 0)

    def test_empty_plan_check(self):
        """测试空计划的检查。"""
        from agent.loop.plan_quality_checker import PlanQualityChecker

        checker = PlanQualityChecker()

        result = checker.check_plan([])

        self.assertEqual(result.quality_score, 0.0)
        self.assertFalse(result.is_passed)
        self.assertGreater(len(result.issues), 0)

    def test_plan_with_issues(self):
        """测试有问题的计划。"""
        from agent.loop.plan_quality_checker import PlanQualityChecker

        checker = PlanQualityChecker()

        bad_plan = [
            {
                "id": "s1",
                "description": "",  # 缺少描述
                "tool": "",  # 缺少工具
                "dependencies": ["s2"],  # 循环依赖
            },
            {
                "id": "s2",
                "description": "步骤2",
                "dependencies": ["s1"],
            },
        ]

        result = checker.check_plan(bad_plan)

        self.assertGreater(len(result.issues), 0)
        # 应该有循环依赖问题
        has_cycle = any("循环依赖" in i.description for i in result.issues)
        self.assertTrue(has_cycle)

    def test_high_risk_detection(self):
        """测试高风险操作检测。"""
        from agent.loop.plan_quality_checker import PlanQualityChecker

        checker = PlanQualityChecker()

        risky_plan = [
            {
                "id": "s1",
                "description": "删除重要文件",
                "tool": "file_deleter",
            },
        ]

        result = checker.check_plan(risky_plan)

        # 应该检测到高风险
        has_risk = any("高风险" in i.description for i in result.issues)
        self.assertTrue(has_risk)


class TestGAP09LearningSignals(unittest.TestCase):
    """GAP-09：多维度学习信号测试。"""

    def test_signal_collector_creation(self):
        """测试信号收集器创建。"""
        from agent.evolution.learning_signals import (
            LearningSignalCollector,
            SignalCollectorConfig,
        )

        config = SignalCollectorConfig(max_signals=1000)
        collector = LearningSignalCollector(config=config)

        self.assertIsNotNone(collector)
        self.assertTrue(collector.enabled)

    def test_signal_recording(self):
        """测试信号记录。"""
        from agent.evolution.learning_signals import (
            LearningSignalCollector,
            SignalType,
            SignalSource,
        )

        collector = LearningSignalCollector()

        # 记录各种类型的信号
        sig_id1 = collector.record_signal(
            signal_type=SignalType.TASK_SUCCESS,
            value=1.0,
            source=SignalSource.EXECUTION,
            tags=["task1"],
        )

        sig_id2 = collector.record_signal(
            signal_type=SignalType.TASK_FAILURE,
            value=-1.0,
            source=SignalSource.EXECUTION,
            tags=["task2"],
        )

        sig_id3 = collector.record_signal(
            signal_type=SignalType.RESPONSE_TIME,
            value=0.5,
            source=SignalSource.MONITORING,
            confidence=0.8,
        )

        self.assertIsNotNone(sig_id1)
        self.assertIsNotNone(sig_id2)
        self.assertIsNotNone(sig_id3)

        stats = collector.get_stats()
        self.assertEqual(stats["total_signals_recorded"], 3)

    def test_signal_analysis(self):
        """测试信号分析。"""
        from agent.evolution.learning_signals import (
            LearningSignalCollector,
            SignalType,
        )

        collector = LearningSignalCollector()

        # 记录一些信号
        for i in range(20):
            if i < 15:
                collector.record_signal(
                    signal_type=SignalType.TASK_SUCCESS,
                    value=0.8,
                )
            else:
                collector.record_signal(
                    signal_type=SignalType.TASK_FAILURE,
                    value=-0.5,
                )

        # 分析信号
        result = collector.analyze_signals()

        self.assertGreater(result.total_signals, 0)
        self.assertGreater(result.positive_signals, 0)
        self.assertGreater(result.negative_signals, 0)
        self.assertIn(result.signal_trend, ["improving", "declining", "stable"])
        self.assertGreater(len(result.key_insights), 0)
        self.assertGreater(len(result.recommendations), 0)

    def test_signal_filtering(self):
        """测试信号过滤。"""
        from agent.evolution.learning_signals import (
            LearningSignalCollector,
            SignalType,
            SignalSource,
        )

        collector = LearningSignalCollector()

        collector.record_signal(
            signal_type=SignalType.TASK_SUCCESS,
            value=1.0,
            source=SignalSource.EXECUTION,
        )
        collector.record_signal(
            signal_type=SignalType.RESPONSE_TIME,
            value=0.5,
            source=SignalSource.MONITORING,
        )

        # 按类型过滤
        signals = collector.get_signals(signal_type=SignalType.TASK_SUCCESS)
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].signal_type, SignalType.TASK_SUCCESS)

        # 按来源过滤
        signals = collector.get_signals(source=SignalSource.MONITORING)
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].source, SignalSource.MONITORING)


class TestGAP10ReflectionApplier(unittest.TestCase):
    """GAP-10：反思结果应用闭环测试。"""

    def test_applier_creation(self):
        """测试应用管理器创建。"""
        from agent.loop.reflection_applier import (
            ReflectionApplier,
            ReflectionApplierConfig,
        )

        config = ReflectionApplierConfig(
            max_reflections=500,
            application_threshold=0.2,
        )
        applier = ReflectionApplier(config=config)

        self.assertIsNotNone(applier)
        self.assertTrue(applier.enabled)

    def test_add_reflection(self):
        """测试添加反思。"""
        from agent.loop.reflection_applier import (
            ReflectionApplier,
            ReflectionType,
        )

        applier = ReflectionApplier()

        ref_id = applier.add_reflection(
            reflection_type=ReflectionType.TOOL_FAILURE,
            content="文件读取失败，路径不存在",
            insight="使用文件操作前应先检查路径是否存在",
            actionable_items=["检查文件路径", "添加错误处理"],
            tags=["file", "error_handling"],
            priority=0.8,
        )

        self.assertIsNotNone(ref_id)

        # 获取反思
        reflection = applier.get_reflection(ref_id)
        self.assertIsNotNone(reflection)
        self.assertEqual(reflection.reflection_type, ReflectionType.TOOL_FAILURE)
        self.assertEqual(len(reflection.actionable_items), 2)

    def test_apply_reflections(self):
        """测试应用反思。"""
        from agent.loop.reflection_applier import (
            ReflectionApplier,
            ReflectionApplierConfig,
            ReflectionType,
        )

        applier = ReflectionApplier(
            config=ReflectionApplierConfig(application_threshold=0.1)
        )

        # 添加几个反思
        for i in range(5):
            applier.add_reflection(
                reflection_type=ReflectionType.SUCCESS if i % 2 == 0 else ReflectionType.TOOL_FAILURE,
                content=f"反思内容 {i}",
                insight=f"洞察 {i}",
                tags=["file", "read" if i % 2 == 0 else "write"],
                priority=0.5 + i * 0.1,
            )

        # 应用反思
        context = {"tags": ["file", "read"], "tool_name": "file_reader"}
        applied = applier.apply_reflections(context, task_type="tool_failure")

        self.assertGreater(len(applied), 0)
        self.assertLessEqual(len(applied), 5)

    def test_application_result_recording(self):
        """测试应用结果记录。"""
        from agent.loop.reflection_applier import (
            ReflectionApplier,
            ReflectionType,
        )

        applier = ReflectionApplier()

        ref_id = applier.add_reflection(
            reflection_type=ReflectionType.TOOL_FAILURE,
            content="测试反思",
            insight="测试洞察",
        )

        # 应用反思
        context = {"test": "data"}
        applier.apply_reflections(context)

        # 记录成功结果
        success = applier.record_application_result(
            ref_id, success=True, impact_score=0.8, feedback="有效"
        )
        self.assertTrue(success)

        # 检查反思状态
        reflection = applier.get_reflection(ref_id)
        self.assertEqual(reflection.application_count, 1)
        self.assertGreater(reflection.success_rate, 0)

    def test_closed_loop_metrics(self):
        """测试闭环指标。"""
        from agent.loop.reflection_applier import (
            ReflectionApplier,
            ReflectionApplierConfig,
            ReflectionType,
        )

        applier = ReflectionApplier(
            config=ReflectionApplierConfig(verification_threshold=2)
        )

        ref_id = applier.add_reflection(
            reflection_type=ReflectionType.SUCCESS,
            content="测试",
            insight="测试",
        )

        # 应用并记录多次成功
        for _ in range(3):
            applier.apply_reflections({})
            applier.record_application_result(ref_id, success=True)

        metrics = applier.get_metrics()

        self.assertGreater(metrics.total_reflections, 0)
        self.assertGreater(metrics.applied_reflections, 0)
        self.assertGreater(metrics.application_success_rate, 0)
        self.assertGreaterEqual(metrics.closed_loop_rate, 0)


def run_all_tests():
    """运行所有测试。"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # 添加所有测试类
    test_classes = [
        TestGAP01ActiveReflection,
        TestGAP02AutoEvolutionTrigger,
        TestGAP03ExperienceGeneralization,
        TestGAP04AttentionFocus,
        TestGAP05IncrementalReplanning,
        TestGAP06StrategyAdapter,
        TestGAP07MemoryCurator,
        TestGAP08PlanQualityChecker,
        TestGAP09LearningSignals,
        TestGAP10ReflectionApplier,
    ]

    for test_class in test_classes:
        tests = loader.loadTestsFromTestCase(test_class)
        suite.addTests(tests)

    # 运行测试
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # 输出总结
    print("\n" + "=" * 60)
    print("测试总结")
    print("=" * 60)
    print(f"总测试数: {result.testsRun}")
    print(f"成功: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"失败: {len(result.failures)}")
    print(f"错误: {len(result.errors)}")
    print(f"跳过: {len(result.skipped)}")

    if result.failures:
        print("\n失败的测试:")
        for test, traceback in result.failures:
            print(f"  - {test}")

    if result.errors:
        print("\n错误的测试:")
        for test, traceback in result.errors:
            print(f"  - {test}")

    return result


if __name__ == "__main__":
    result = run_all_tests()
    sys.exit(0 if result.wasSuccessful() else 1)
