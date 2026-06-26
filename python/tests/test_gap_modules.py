"""新增模块单元测试。

测试所有差距补足模块的功能正确性。
"""

import sys
import os

# 添加项目路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import time
import unittest


class TestPerformanceMonitor(unittest.TestCase):
    """性能监控器测试。"""

    def setUp(self):
        from agent.evolution.monitor import PerformanceMonitor, PerformanceThresholds
        thresholds = PerformanceThresholds(
            consecutive_failures=3,
            window_size=50,
        )
        self.monitor = PerformanceMonitor(thresholds=thresholds)

    def test_record_metric(self):
        """测试记录指标。"""
        self.monitor.record_metric("test_metric", success=True)
        stats = self.monitor.get_metric_stats("test_metric")
        self.assertEqual(stats["count"], 1)
        self.assertEqual(stats["success_count"], 1)

    def test_consecutive_failures_alert(self):
        """测试连续失败告警。"""
        for i in range(5):
            self.monitor.record_metric("test_fail", success=False)

        alerts = self.monitor.check_alerts()
        failure_alerts = [a for a in alerts if a.type == "consecutive_failures"]
        self.assertTrue(len(failure_alerts) > 0)

    def test_success_rate_drop_alert(self):
        """测试成功率下降告警。"""
        # 前半部分全部成功
        for i in range(10):
            self.monitor.record_metric("test_rate", success=True)

        # 后半部分全部失败
        for i in range(10):
            self.monitor.record_metric("test_rate", success=False)

        alerts = self.monitor.check_alerts()
        rate_alerts = [a for a in alerts if a.type == "success_rate_drop"]
        self.assertTrue(len(rate_alerts) > 0)

    def test_baseline_update(self):
        """测试基线更新。"""
        for i in range(25):
            self.monitor.record_metric("test_baseline", success=True, duration=1.0 + i * 0.1)

        stats = self.monitor.get_metric_stats("test_baseline")
        self.assertTrue(stats["baseline"] > 0)

    def test_alert_deduplication(self):
        """测试告警去重。"""
        for i in range(10):
            self.monitor.record_metric("test_dup", success=False)

        alerts1 = self.monitor.check_alerts()
        alerts2 = self.monitor.check_alerts()
        # 第二次检查应该没有新告警（因为去重）
        self.assertEqual(len(alerts2), 0)

    def test_disable_enable(self):
        """测试启用/禁用。"""
        self.monitor.enabled = False
        self.monitor.record_metric("test_disable", success=False)
        alerts = self.monitor.check_alerts()
        self.assertEqual(len(alerts), 0)

        self.monitor.enabled = True
        for i in range(5):
            self.monitor.record_metric("test_disable", success=False)
        alerts = self.monitor.check_alerts()
        self.assertTrue(len(alerts) > 0)


class TestIncrementalPlanner(unittest.TestCase):
    """增量规划器测试。"""

    def setUp(self):
        from agent.loop.incremental_planner import IncrementalPlanner, PlanStep
        self.planner = IncrementalPlanner()
        self.original_plan = [
            PlanStep(step_id="s1", description="步骤1", tool_name="tool_a", order=0),
            PlanStep(step_id="s2", description="步骤2", tool_name="tool_b", dependencies=["s1"], order=1),
            PlanStep(step_id="s3", description="步骤3", tool_name="tool_c", dependencies=["s2"], order=2),
            PlanStep(step_id="s4", description="步骤4", tool_name="tool_d", dependencies=["s3"], order=3),
        ]

    def test_incremental_replan_basic(self):
        """测试基本增量重规划。"""
        result = self.planner.incremental_replan(
            self.original_plan,
            trigger_step_id="s2",
            reason="测试失败",
        )

        self.assertTrue(result.success)
        self.assertTrue(len(result.new_plan) > 0)
        self.assertTrue(len(result.affected_steps) > 0)
        self.assertTrue(result.preserved_steps > 0)

    def test_replan_nonexistent_step(self):
        """测试不存在的步骤触发重规划。"""
        result = self.planner.incremental_replan(
            self.original_plan,
            trigger_step_id="nonexistent",
            reason="测试",
        )

        self.assertFalse(result.success)
        self.assertEqual(len(result.new_plan), len(self.original_plan))

    def test_impact_analysis(self):
        """测试影响范围分析。"""
        result = self.planner.incremental_replan(
            self.original_plan,
            trigger_step_id="s2",
            reason="测试",
        )

        # s2失败应该影响s2, s3, s4
        affected = set(result.affected_steps)
        self.assertTrue(any("s2" in s for s in affected))
        self.assertTrue(any("s3" in s for s in affected))
        self.assertTrue(any("s4" in s for s in affected))

    def test_preserve_completed_steps(self):
        """测试保留已完成步骤。"""
        # 标记s1为已完成
        self.original_plan[0].status = "completed"

        result = self.planner.incremental_replan(
            self.original_plan,
            trigger_step_id="s2",
            reason="测试",
        )

        # s1应该被保留
        preserved_ids = [s.step_id for s in result.new_plan if s.step_id == "s1"]
        self.assertTrue(len(preserved_ids) > 0)

    def test_disabled_planner(self):
        """测试禁用的规划器。"""
        self.planner.enabled = False
        result = self.planner.incremental_replan(
            self.original_plan,
            trigger_step_id="s2",
            reason="测试",
        )

        self.assertFalse(result.success)
        self.assertEqual(result.new_plan, self.original_plan)


class TestReflectionApplier(unittest.TestCase):
    """反思应用器测试。"""

    def setUp(self):
        from agent.loop.reflection_applier import ReflectionApplier
        self.applier = ReflectionApplier()

    def test_add_reflection(self):
        """测试添加反思。"""
        ref_id = self.applier.add_reflection(
            reflection_type="tool_failure",
            content="工具调用失败",
            insight="需要检查参数",
            actionable_items=["检查参数格式", "验证权限"],
            tags=["file_read", "permission"],
            priority=0.8,
        )

        self.assertTrue(ref_id)
        ref = self.applier.get_reflection(ref_id)
        self.assertIsNotNone(ref)
        self.assertEqual(ref.reflection_type, "tool_failure")

    def test_apply_reflections(self):
        """测试应用反思。"""
        # 添加一些反思
        self.applier.add_reflection(
            reflection_type="tool_failure",
            content="文件读取失败",
            insight="检查文件路径是否正确",
            tags=["file_read", "path"],
            priority=0.7,
        )
        self.applier.add_reflection(
            reflection_type="success",
            content="任务成功完成",
            insight="按步骤执行效果好",
            tags=["planning", "success"],
            priority=0.5,
        )

        # 应用相关反思
        applied = self.applier.apply_reflections(
            context={"tags": ["file_read"], "query": "读取文件"},
            task_type="tool_failure",
        )

        self.assertTrue(len(applied) > 0)

    def test_record_application_result(self):
        """测试记录应用结果。"""
        ref_id = self.applier.add_reflection(
            reflection_type="tool_failure",
            content="测试",
            insight="测试洞察",
            priority=0.5,
        )

        # 应用反思
        self.applier.apply_reflections(context={}, task_type="tool_failure")

        # 记录成功结果
        result = self.applier.record_application_result(
            ref_id, success=True, impact_score=0.8, feedback="效果很好"
        )

        self.assertTrue(result)
        ref = self.applier.get_reflection(ref_id)
        self.assertEqual(ref.application_count, 1)
        self.assertTrue(ref.success_rate > 0)

    def test_reflection_expiration(self):
        """测试反思过期。"""
        # 添加一个反思（通过修改时间来模拟过期）
        ref_id = self.applier.add_reflection(
            reflection_type="test",
            content="测试过期",
            insight="测试",
            priority=0.1,
        )

        # 手动设置创建时间为很久以前
        ref = self.applier.get_reflection(ref_id)
        ref.created_at = time.time() - 90 * 86400  # 90天前

        # 清理过期
        self.applier._cleanup_expired()

        # 反思应该被标记为deprecated
        ref = self.applier.get_reflection(ref_id)
        self.assertEqual(ref.status, "deprecated")

    def test_get_metrics(self):
        """测试获取统计指标。"""
        # 添加一些反思
        for i in range(5):
            self.applier.add_reflection(
                reflection_type="test",
                content=f"测试{i}",
                insight=f"洞察{i}",
                priority=0.5 + i * 0.1,
            )

        metrics = self.applier.get_metrics()
        self.assertEqual(metrics.total_reflections, 5)


class TestLearningSignalCollector(unittest.TestCase):
    """学习信号收集器测试。"""

    def setUp(self):
        from agent.evolution.learning_signals import LearningSignalCollector
        self.collector = LearningSignalCollector()

    def test_record_signal(self):
        """测试记录信号。"""
        sig_id = self.collector.record_signal(
            signal_type="task_success",
            value=1.0,
            source="execution",
            tags=["test"],
        )

        self.assertTrue(sig_id)
        stats = self.collector.get_stats()
        self.assertEqual(stats["current_signals"], 1)

    def test_signal_normalization(self):
        """测试信号标准化。"""
        # 超过范围的值应该被截断
        sig_id = self.collector.record_signal(
            signal_type="test",
            value=2.0,  # 超过1.0
            source="test",
        )

        signals = self.collector.get_signals(signal_type="test")
        self.assertEqual(signals[0].value, 1.0)

        # 低于范围的值也应该被截断
        sig_id = self.collector.record_signal(
            signal_type="test_neg",
            value=-2.0,  # 低于-1.0
            source="test",
        )

        signals = self.collector.get_signals(signal_type="test_neg")
        self.assertEqual(signals[0].value, -1.0)

    def test_analyze_signals(self):
        """测试信号分析。"""
        # 添加一些正向信号
        for i in range(10):
            self.collector.record_signal(
                signal_type="task_success",
                value=0.8,
                source="execution",
            )

        # 添加一些负向信号
        for i in range(5):
            self.collector.record_signal(
                signal_type="task_failure",
                value=-0.5,
                source="execution",
            )

        result = self.collector.analyze_signals()
        self.assertTrue(result.total_signals > 0)
        self.assertTrue(result.positive_signals > 0)
        self.assertTrue(result.negative_signals > 0)
        self.assertTrue(len(result.key_insights) > 0)

    def test_signal_trend(self):
        """测试信号趋势分析。"""
        # 先添加差的信号
        for i in range(10):
            self.collector.record_signal(
                signal_type="test_trend",
                value=-0.8,
                source="test",
            )

        # 再添加好的信号
        for i in range(10):
            self.collector.record_signal(
                signal_type="test_trend",
                value=0.8,
                source="test",
            )

        result = self.collector.analyze_signals(signal_type="test_trend")
        # 趋势应该是improving
        self.assertEqual(result.signal_trend, "improving")

    def test_sampling_rate(self):
        """测试采样率。"""
        from agent.evolution.learning_signals import LearningSignalCollector as _LSC, SignalCollectorConfig
        config = SignalCollectorConfig(sampling_rate=0.1)  # 10%采样率
        collector = _LSC(config=config)

        # 记录100个信号
        for i in range(100):
            collector.record_signal("test_sample", value=1.0, source="test")

        stats = collector.get_stats()
        # 实际记录的应该远少于100
        self.assertTrue(stats["current_signals"] < 50)
        self.assertTrue(stats["signals_dropped"] > 0)


class TestMemoryCurator(unittest.TestCase):
    """记忆策展人测试。"""

    def setUp(self):
        from agent.memory.curator import MemoryCurator
        self.curator = MemoryCurator()

    def test_assess_importance(self):
        """测试重要性评估。"""
        # 先记录一些使用
        for i in range(10):
            self.curator.record_usage("mem_important")

        # 只记录一次使用
        self.curator.record_usage("mem_unimportant")

        # 评估重要性
        score_important = self.curator.assess_importance(
            "mem_important",
            memory_content="这是一个重要的记忆，包含很多有用的信息",
            memory_type="episodic",
            metadata={"important": True},
        )

        score_unimportant = self.curator.assess_importance(
            "mem_unimportant",
            memory_content="普通内容",
            memory_type="general",
            metadata={},
        )

        # 重要的记忆分数应该更高
        self.assertTrue(score_important.total_score > score_unimportant.total_score)
        self.assertEqual(score_important.category, "important")

    def test_curate_memories(self):
        """测试记忆策展。"""
        memories = []
        for i in range(20):
            memories.append({
                "id": f"mem_{i}",
                "content": f"记忆内容{i}",
                "type": "general",
                "metadata": {},
            })

        # 为一些记忆添加使用记录
        for i in range(5):
            for j in range(10):
                self.curator.record_usage(f"mem_{i}")

        # 执行策展
        result = self.curator.curate(memories, force=True)

        self.assertTrue(result["curated"])
        self.assertTrue(result["to_consolidate"] > 0)
        self.assertTrue(result["to_forget"] >= 0)

    def test_consolidate_memory(self):
        """测试巩固记忆。"""
        self.curator.consolidate_memory("mem_test")

        # 检查使用记录是否增加
        score = self.curator.assess_importance("mem_test", "", "general", {})
        self.assertTrue(score.frequency_score > 0)

    def test_forget_memory(self):
        """测试遗忘记忆。"""
        # 先添加使用记录
        self.curator.record_usage("mem_forget")
        self.curator.record_usage("mem_forget")

        # 然后遗忘
        result = self.curator.forget_memory("mem_forget")
        self.assertTrue(result)

    def test_curation_interval(self):
        """测试策展间隔。"""
        memories = [{"id": "1", "content": "test", "type": "general"}]

        # 第一次策展
        result1 = self.curator.curate(memories, force=True)
        self.assertTrue(result1["curated"])

        # 不强制执行，应该被间隔限制
        result2 = self.curator.curate(memories, force=False)
        self.assertFalse(result2["curated"])


class TestPlanQualityChecker(unittest.TestCase):
    """规划质量检查器测试。"""

    def setUp(self):
        from agent.loop.plan_quality_checker import PlanQualityChecker
        self.checker = PlanQualityChecker()

    def test_good_plan(self):
        """测试好的计划。"""
        plan = [
            {"id": "s1", "description": "读取文件", "tool": "file_read", "dependencies": []},
            {"id": "s2", "description": "分析内容", "tool": "code_analyze", "dependencies": ["s1"]},
            {"id": "s3", "description": "生成报告", "tool": "report_gen", "dependencies": ["s2"]},
        ]

        result = self.checker.check_plan(plan)

        self.assertTrue(result.is_passed)
        self.assertTrue(result.quality_score > 0.6)
        self.assertTrue(result.completeness_score > 0)

    def test_empty_plan(self):
        """测试空计划。"""
        result = self.checker.check_plan([])

        self.assertFalse(result.is_passed)
        self.assertEqual(result.quality_score, 0.0)
        self.assertTrue(len(result.issues) > 0)

    def test_plan_with_circular_dependency(self):
        """测试有循环依赖的计划。"""
        plan = [
            {"id": "s1", "description": "步骤1", "tool": "tool1", "dependencies": ["s2"]},
            {"id": "s2", "description": "步骤2", "tool": "tool2", "dependencies": ["s1"]},
        ]

        result = self.checker.check_plan(plan)

        # 应该有循环依赖的问题
        has_cycle_issue = any(
            "循环" in issue.description for issue in result.issues
        )
        self.assertTrue(has_cycle_issue)

    def test_plan_with_high_risk(self):
        """测试有高风险操作的计划。"""
        plan = [
            {"id": "s1", "description": "删除重要文件", "tool": "file_delete"},
        ]

        result = self.checker.check_plan(plan)

        has_risk_issue = any(
            "高风险" in issue.description for issue in result.issues
        )
        self.assertTrue(has_risk_issue)

    def test_plan_missing_tools(self):
        """测试缺少工具的计划。"""
        plan = [
            {"id": "s1", "description": "执行某个操作"},
            {"id": "s2", "description": "另一个操作"},
        ]

        result = self.checker.check_plan(plan)

        missing_tool_issues = [
            issue for issue in result.issues
            if "缺少执行工具" in issue.description
        ]
        self.assertTrue(len(missing_tool_issues) > 0)

    def test_disabled_checker(self):
        """测试禁用的检查器。"""
        self.checker.enabled = False
        result = self.checker.check_plan([])

        self.assertTrue(result.is_passed)
        self.assertEqual(result.quality_score, 1.0)


def run_tests():
    """运行所有测试。"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # 添加测试类
    suite.addTests(loader.loadTestsFromTestCase(TestPerformanceMonitor))
    suite.addTests(loader.loadTestsFromTestCase(TestIncrementalPlanner))
    suite.addTests(loader.loadTestsFromTestCase(TestReflectionApplier))
    suite.addTests(loader.loadTestsFromTestCase(TestLearningSignalCollector))
    suite.addTests(loader.loadTestsFromTestCase(TestMemoryCurator))
    suite.addTests(loader.loadTestsFromTestCase(TestPlanQualityChecker))

    # 运行测试
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # 输出结果
    print("\n" + "=" * 60)
    print(f"测试完成: 运行 {result.testsRun} 个测试")
    print(f"成功: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"失败: {len(result.failures)}")
    print(f"错误: {len(result.errors)}")
    print("=" * 60)

    return result


if __name__ == "__main__":
    run_tests()
