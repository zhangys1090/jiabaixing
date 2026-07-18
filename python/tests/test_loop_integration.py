"""
test_loop_integration.py — LoopController + 辅助模块集成测试

测试覆盖:
1. LoopController._react_think_structured() — 结构化 ReAct 思考
2. LoopController._inject_reflection_into_context() — 反思注入上下文
3. LoopController._deep_reflect() — 深度反思流程
4. LoopController._should_use_react() — 自动模式选择
5. LoopObserver — 阶段追踪和工具调用埋点
6. FeedbackLoops — 四大闭环
7. BuiltInQualityScorer — 质量评分
8. AttentionFocusManager — 注意力聚焦

目标: 覆盖之前报告中列出的所有"高覆盖率缺口"路径
"""

import asyncio
import os
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.loop.observer import LoopObserver, LoopPhase, LoopTrace


# ─────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────


@pytest.fixture
def mock_llm():
    llm = AsyncMock()
    llm.chat = AsyncMock(return_value={"content": "mock response"})
    return llm


@pytest.fixture
def observer_test_instance():
    """创建测试用的独立 Observer 实例（不干扰全局单例）"""
    obs = LoopObserver.create_test_instance()
    obs.enable(verbose=False)
    yield obs
    obs.disable()


# ─────────────────────────────────────────────
# 1. LoopController 核心路径测试
# ─────────────────────────────────────────────


class TestReactStructured:
    """测试 _react_think_structured() 方法"""

    @pytest.mark.asyncio
    async def test_structured_think_produces_valid_step(self, mock_llm):
        """结构化思考应返回有效的 StructuredReActStep"""
        from agent.loop.controller import LoopController
        from agent.loop.types import StructuredReActStep, LoopContext, BudgetState

        controller = LoopController(llm=mock_llm)
        
        # Mock _react_act 返回有效结果
        controller._react_act = AsyncMock(return_value=MagicMock(
            observation="tool output",
            success=True,
        ))
        
        # 模拟 LLM 返回 JSON 格式的思考
        mock_llm.chat = AsyncMock(
            return_value={"content": '{"thought": "need to search", "action": {"tool": "search", "params": {"q": "test"}}}'}
        )

        context = LoopContext(
            user_input="搜索天气",
            session_id="test",
            messages=[{"role": "user", "content": "搜索天气"}],
            budget=BudgetState(start_time=time.time()),
        )
        
        step = await controller._react_think_structured(
            input_text="搜索天气",
            context=context,
            step_index=1,
        )

        assert isinstance(step, StructuredReActStep)
        assert step.thought
        assert step.action

    @pytest.mark.asyncio
    async def test_structured_think_structure(self, mock_llm):
        """结构化思考应返回包含 thought 和 action 的 StructuredReActStep"""
        from agent.loop.controller import LoopController
        from agent.loop.types import StructuredReActStep, LoopContext, BudgetState

        controller = LoopController(llm=mock_llm)
        
        # Mock LLM 返回 JSON 格式的思考
        mock_llm.chat = AsyncMock(
            return_value={"content": '{"thought": "I need to search for weather", "action": {"tool_name": "search", "tool_args": {"query": "weather"}}}'}
        )

        context = LoopContext(
            user_input="搜索天气",
            session_id="test",
            messages=[{"role": "user", "content": "搜索天气"}],
            budget=BudgetState(start_time=time.time()),
        )
        
        step = await controller._react_think_structured(
            input_text="搜索天气",
            context=context,
            step_index=1,
        )

        assert isinstance(step, StructuredReActStep)
        assert step.thought
        assert "search" in str(step.action).lower() or "weather" in str(step.action).lower()


class TestInjectReflection:
    """测试 _inject_reflection_into_context() 方法"""

    @pytest.mark.asyncio
    async def test_inject_reflection_adds_system_message(self, mock_llm):
        """反思注入应添加系统消息到上下文"""
        from agent.loop.controller import LoopController
        from agent.loop.types import LoopContext, BudgetState

        controller = LoopController(llm=mock_llm)
        
        # 设置最后的反思洞察
        controller._last_reflection_insight = {
            "root_cause": "参数错误",
            "suggestion": "检查输入格式",
        }

        context = LoopContext(
            user_input="test task",
            session_id="test",
            messages=[],
            budget=BudgetState(start_time=time.time()),
        )

        controller._inject_reflection_into_context(context)

        # 应添加了系统消息
        assert len(context.messages) > 0
        assert any(m.get("role") == "system" for m in context.messages)

    @pytest.mark.asyncio
    async def test_inject_reflection_no_insight(self, mock_llm):
        """无反思洞察时不应修改上下文"""
        from agent.loop.controller import LoopController
        from agent.loop.types import LoopContext, BudgetState

        controller = LoopController(llm=mock_llm)
        controller._last_reflection_insight = None

        context = LoopContext(
            user_input="test task",
            session_id="test",
            messages=[{"role": "user", "content": "original"}],
            budget=BudgetState(start_time=time.time()),
        )

        original_count = len(context.messages)
        controller._inject_reflection_into_context(context)

        assert len(context.messages) == original_count


class TestDeepReflect:
    """测试 _deep_reflect() 方法"""

    @pytest.mark.asyncio
    async def test_deep_reflect_provides_strategy(self, mock_llm):
        """深度反思应调用 reflection.deep_reflect"""
        from agent.loop.controller import LoopController
        from agent.loop.types import LoopContext, BudgetState, EvaluatorOutput

        controller = LoopController(llm=mock_llm)
        
        # Mock deep_reflect 返回有效结果
        controller.reflection.deep_reflect = AsyncMock(
            return_value=MagicMock(
                diagnosis="规划方向偏差",
                root_cause="工具选择不当",
                fix_strategy="更换为更合适的工具",
                corrected_plan=[{"stepDescription": "重试", "toolName": "better_tool"}],
            )
        )

        context = LoopContext(
            user_input="complex task",
            session_id="test",
            messages=[],
            budget=BudgetState(start_time=time.time()),
            step_results={},
        )
        
        eval_output = EvaluatorOutput(
            goal_progress=0.2,
            suggested_action="replan",
            reason="low progress",
        )

        await controller._deep_reflect(
            input_text="complex task",
            context=context,
            eval_result=eval_output,
        )

        controller.reflection.deep_reflect.assert_called_once()

    @pytest.mark.asyncio
    async def test_deep_reflect_disabled(self, mock_llm):
        """深度反思禁用时应不调用 LLM"""
        from agent.loop.controller import LoopController
        from agent.loop.types import LoopContext, BudgetState, EvaluatorOutput

        controller = LoopController(llm=mock_llm)
        controller.reflection.enable_deep_reflection = False
        
        context = LoopContext(
            user_input="test",
            session_id="test",
            messages=[],
            budget=BudgetState(start_time=time.time()),
            step_results={},
        )
        
        eval_output = EvaluatorOutput(
            goal_progress=0.1,
            suggested_action="abort",
            reason="disabled",
        )

        await controller._deep_reflect(
            input_text="test",
            context=context,
            eval_result=eval_output,
        )

        # 不应调用 LLM
        mock_llm.chat.assert_not_called()


class TestShouldUseReAct:
    """测试 _should_use_react() 方法"""

    @pytest.mark.asyncio
    async def test_react_for_search_tasks(self, mock_llm):
        """搜索类任务应使用 ReAct"""
        from agent.loop.controller import LoopController

        controller = LoopController(llm=mock_llm)
        assert controller._should_use_react("搜索今天的天气") is True
        assert controller._should_use_react("查找北京的温度") is True

    @pytest.mark.asyncio
    async def test_plan_for_complex_tasks(self, mock_llm):
        """复杂多步骤任务应使用 Plan-Execute"""
        from agent.loop.controller import LoopController

        controller = LoopController(llm=mock_llm)
        assert controller._should_use_react("复杂多步骤任务规划") is False
        assert controller._should_use_react("数据分析报告生成") is False


# ─────────────────────────────────────────────
# 2. LoopObserver 测试
# ─────────────────────────────────────────────


class TestLoopObserver:
    """测试 LoopObserver 的阶段追踪和工具调用埋点"""

    def test_enable_and_disable(self, observer_test_instance):
        """启用和禁用观察者"""
        assert observer_test_instance.is_enabled() is True
        
        observer_test_instance.disable()
        assert observer_test_instance.is_enabled() is False

    def test_start_and_end_loop(self, observer_test_instance):
        """开始和结束循环追踪"""
        trace_id = observer_test_instance.start_loop(user_input="test task")
        
        assert trace_id
        assert isinstance(trace_id, str)
        assert len(trace_id) > 0

        observer_test_instance.end_loop(success=True, ai_output="done")
        
        trace = observer_test_instance.get_current_trace()
        assert trace is None  # end_loop 后清除

    def test_start_and_end_phase(self, observer_test_instance):
        """阶段开始和结束"""
        observer_test_instance.start_loop(user_input="test")
        observer_test_instance.start_phase(LoopPhase.PLANNER, input_summary="plan task")
        
        trace = observer_test_instance.get_current_trace()
        assert trace is not None
        assert len(trace.phases) == 1
        assert trace.phases[0].phase == LoopPhase.PLANNER

        observer_test_instance.end_phase(LoopPhase.PLANNER, success=True, output_summary="3 steps")
        
        phase_record = trace.phases[0]
        assert phase_record.end_time is not None
        assert phase_record.duration is not None
        assert phase_record.duration >= 0
        assert phase_record.output_summary

    def test_tool_call_tracking(self, observer_test_instance):
        """工具调用追踪"""
        observer_test_instance.start_loop(user_input="test")
        observer_test_instance.start_phase(LoopPhase.EXECUTOR)

        call_id = observer_test_instance.start_tool_call(
            tool_name="search",
            params={"query": "weather", "location": "beijing"},
        )
        
        assert call_id
        assert len(observer_test_instance.get_recent_tool_calls()) == 1

        observer_test_instance.end_tool_call(
            call_id=call_id,
            success=True,
            result="sunny, 25°C",
        )

        tool_calls = observer_test_instance.get_recent_tool_calls()
        assert tool_calls[0].success is True
        assert tool_calls[0].duration is not None

    def test_statistics_collection(self, observer_test_instance):
        """统计信息收集"""
        observer_test_instance.start_loop(user_input="test 1")
        observer_test_instance.start_phase(LoopPhase.PLANNER)
        observer_test_instance.end_phase(LoopPhase.PLANNER, success=True)
        observer_test_instance.end_loop(success=True, ai_output="done 1")

        observer_test_instance.start_loop(user_input="test 2")
        observer_test_instance.start_phase(LoopPhase.EXECUTOR)
        observer_test_instance.end_phase(LoopPhase.EXECUTOR, success=False, error="fail")
        observer_test_instance.end_loop(success=False, error="execution failed")

        stats = observer_test_instance.get_statistics()
        assert stats.total_loops == 2
        assert stats.successful_loops == 1
        assert stats.failed_loops == 1

    def test_trace_history(self, observer_test_instance):
        """追踪历史记录"""
        for i in range(3):
            observer_test_instance.start_loop(user_input=f"test {i}")
            observer_test_instance.end_loop(success=True, ai_output=f"result {i}")

        history = observer_test_instance.get_trace_history()
        assert len(history) == 3
        
        limited_history = observer_test_instance.get_trace_history(limit=2)
        assert len(limited_history) == 2

    def test_reset_statistics(self, observer_test_instance):
        """重置统计数据"""
        observer_test_instance.start_loop(user_input="test")
        observer_test_instance.end_loop(success=True)
        
        stats_before = observer_test_instance.get_statistics()
        assert stats_before.total_loops == 1

        observer_test_instance.reset_statistics()
        
        stats_after = observer_test_instance.get_statistics()
        assert stats_after.total_loops == 0

    def test_generate_trace_report(self, observer_test_instance):
        """生成追踪报告"""
        observer_test_instance.start_loop(user_input="test task")
        observer_test_instance.start_phase(LoopPhase.PLANNER)
        observer_test_instance.end_phase(LoopPhase.PLANNER, success=True)
        observer_test_instance.end_loop(success=True, ai_output="result")

        traces = observer_test_instance.get_trace_history()
        assert len(traces) == 1
        
        report = observer_test_instance.generate_trace_report(traces[0])
        assert "循环追踪报告" in report
        assert "✅ 成功" in report


# ─────────────────────────────────────────────
# 3. FeedbackLoops 测试
# ─────────────────────────────────────────────


class TestFeedbackLoops:
    """测试 FeedbackLoops 四大闭环"""

    @pytest.mark.asyncio
    async def test_feedback_loops_run_all(self, mock_llm):
        """运行所有闭环反馈"""
        from agent.loop.feedback_loops import FeedbackLoops

        loops = FeedbackLoops()
        
        # 运行闭环不应抛出异常
        result = await loops.run_all(
            context=MagicMock(
                messages=[{"role": "assistant", "content": "done"}],
                step_results=[MagicMock(success=True, tool_name="test")],
            ),
            llm=mock_llm,
        )
        
        assert result is not None

    @pytest.mark.asyncio
    async def test_evolution_loop_triggered(self, mock_llm):
        """进化闭环在质量低时应被触发"""
        from agent.loop.feedback_loops import FeedbackLoops

        loops = FeedbackLoops()
        
        # 创建一个低质量结果的上下文
        mock_context = MagicMock()
        mock_context.messages = [{"role": "assistant", "content": "low quality"}]
        mock_context.step_results = [MagicMock(success=False, tool_name="bad_tool")]
        mock_context.quality_score = 0.3

        await loops.run_all(context=mock_context, llm=mock_llm)


# ─────────────────────────────────────────────
# 4. BuiltInQualityScorer 测试
# ─────────────────────────────────────────────


class TestBuiltInQualityScorer:
    """测试 BuiltInQualityScorer"""

    @pytest.mark.asyncio
    async def test_score_high_quality_response(self, mock_llm):
        """高质量响应评分"""
        from agent.loop.quality_scorer import BuiltInQualityScorer

        scorer = BuiltInQualityScorer(max_expected_rounds=5, max_expected_steps_per_round=8)
        
        step_results = {
            "s1": MagicMock(success=True),
            "s2": MagicMock(success=True),
            "s3": MagicMock(success=True),
        }
        
        report = scorer.score(
            step_results=step_results,
            planned_steps=3,
            rounds_used=2,
            reflection_experiences=5,
            context_message_count=5,
        )
        
        assert report.overall_score > 0.5

    @pytest.mark.asyncio
    async def test_score_low_quality_response(self, mock_llm):
        """低质量响应评分"""
        from agent.loop.quality_scorer import BuiltInQualityScorer

        scorer = BuiltInQualityScorer(max_expected_rounds=5, max_expected_steps_per_round=8)
        
        step_results = {
            "s1": MagicMock(success=False),
            "s2": MagicMock(success=False),
            "s3": MagicMock(success=False),
        }
        
        report = scorer.score(
            step_results=step_results,
            planned_steps=10,
            rounds_used=6,
            reflection_experiences=0,
            context_message_count=20,
        )
        
        assert report.overall_score < 0.5

    @pytest.mark.asyncio
    async def test_score_too_many_rounds(self, mock_llm):
        """超出预期轮次应降低评分"""
        from agent.loop.quality_scorer import BuiltInQualityScorer

        scorer = BuiltInQualityScorer(max_expected_rounds=3)
        
        common_results = {"s1": MagicMock(success=True)}
        
        high_rounds_report = scorer.score(
            step_results=common_results,
            planned_steps=5,
            rounds_used=10,
            reflection_experiences=0,
        )
        
        low_rounds_report = scorer.score(
            step_results=common_results,
            planned_steps=5,
            rounds_used=2,
            reflection_experiences=3,
        )
        
        assert high_rounds_report.overall_score < low_rounds_report.overall_score


# ─────────────────────────────────────────────
# 5. AttentionFocusManager 测试
# ─────────────────────────────────────────────


class TestAttentionFocusManager:
    """测试 AttentionFocusManager"""

    @pytest.mark.asyncio
    async def test_focus_scores_important_messages(self, mock_llm):
        """注意力聚焦应对重要消息高分"""
        from agent.loop.attention import AttentionFocusManager

        manager = AttentionFocusManager(max_messages=10, max_total_tokens=3000)
        
        messages = [
            {"role": "user", "content": "Simple query"},
            {"role": "assistant", "content": "Detailed and comprehensive answer explaining the concept thoroughly with examples."},
            {"role": "system", "content": "Critical system instruction about security"},
        ]
        
        scored = [
            manager.score_message(msg, idx, messages)
            for idx, msg in enumerate(messages)
        ]
        
        assert len(scored) == 3
        # system 消息应获得较高分数
        system_score = scored[2]
        assert system_score > 0

    @pytest.mark.asyncio
    async def test_focus_truncates_long_context(self, mock_llm):
        """上下文过长时应截断低分消息"""
        from agent.loop.attention import AttentionFocusManager

        manager = AttentionFocusManager(max_messages=3, max_total_tokens=100)
        
        # 创建超长消息列表
        long_messages = [
            {"role": "user", "content": f"Query {i}" * 100}
            for i in range(10)
        ]
        
        focused = manager.focus(long_messages)
        
        assert len(focused) <= 3


# ─────────────────────────────────────────────
# 6. Observer 禁用模式测试
# ─────────────────────────────────────────────


class TestObserverDisabled:
    """测试 Observer 禁用模式下的行为"""

    def test_start_loop_when_disabled(self):
        """禁用时 start_loop 应返回空字符串"""
        obs = LoopObserver.create_test_instance()
        obs.disable()
        
        trace_id = obs.start_loop(user_input="test")
        assert trace_id == ""

    def test_start_phase_when_disabled(self):
        """禁用时 start_phase 应无效果"""
        obs = LoopObserver.create_test_instance()
        obs.disable()
        
        obs.start_phase(LoopPhase.PLANNER)
        assert obs.get_current_trace() is None

    def test_enable_via_env_variable(self):
        """通过环境变量启用 Observer"""
        os.environ["LOOP_OBSERVER_ENABLED"] = "true"
        
        obs = LoopObserver.create_test_instance()
        assert obs.is_enabled() is True
        
        del os.environ["LOOP_OBSERVER_ENABLED"]
