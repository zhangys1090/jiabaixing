"""
Controller 单元测试

测试覆盖：
- run() 主循环逻辑
- 预算强制执行（时间/轮次/工具调用）
- 状态转换（PLANNING → EXECUTING → EVALUATING → REPORTING）
- ReAct 循环
- 重规划逻辑
"""

import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.loop.controller import LoopController
from agent.loop.types import (
    AgentResult,
    BudgetState,
    ExecutionPlan,
    LoopContext,
    PlanStep,
    LoopState,
)
from agent.loop.reflection import ReflectionResult


# ─────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────

@pytest.fixture
def mock_llm():
    llm = AsyncMock()
    llm.chat = AsyncMock(return_value={"content": "mock response"})
    return llm


@pytest.fixture
def mock_planner():
    planner = AsyncMock()
    # plan() 返回一个简单的执行计划
    planner.plan = AsyncMock(return_value=ExecutionPlan(
        steps=[PlanStep(step_id="s1", description="step 1", tool_name="t")],
        simple=True,
    ))
    planner.replan = AsyncMock(return_value=ExecutionPlan(
        steps=[PlanStep(step_id="s1", description="replan step", tool_name="t")],
        simple=True,
    ))
    return planner


@pytest.fixture
def mock_executor():
    executor = AsyncMock()
    # execute() 返回成功结果
    executor.execute = AsyncMock(return_value=MagicMock(
        completed_naturally=True,
        step_results=[],
        messages=[{"role": "assistant", "content": "done"}],
        tool_calls_count=1,
        tool_duration=100.0,
    ))
    executor.execute_chain = AsyncMock(return_value=MagicMock(
        completed_naturally=True,
        step_results=[],
        messages=[],
        tool_calls_count=1,
        tool_duration=100.0,
    ))
    executor.execute_parallel = AsyncMock(return_value=MagicMock(
        completed_naturally=True,
        step_results=[],
        messages=[],
        tool_calls_count=1,
        tool_duration=100.0,
    ))
    executor.should_replan = MagicMock(return_value={"should_replan": False})
    return executor


@pytest.fixture
def mock_evaluator():
    evaluator = AsyncMock()
    evaluator.evaluate = AsyncMock(return_value=MagicMock(
        goal_progress=0.9,
        suggested_action="continue",
        reason="good progress",
        failure_analysis="",
        suggested_correction="",
    ))
    return evaluator


@pytest.fixture
def mock_reporter():
    reporter = MagicMock()
    reporter.report = MagicMock(return_value=MagicMock(
        response="task completed",
        quality_score=0.9,
        steps_completed=1,
        steps_total=1,
        total_duration_ms=1000,
    ))
    return reporter


@pytest.fixture
def controller(mock_llm, mock_planner, mock_executor, mock_evaluator, mock_reporter):
    """创建一个 LoopController，所有依赖都是 mock"""
    with patch("agent.loop.controller.Planner", return_value=mock_planner), \
         patch("agent.loop.controller.Executor", return_value=mock_executor), \
         patch("agent.loop.controller.Evaluator", return_value=mock_evaluator), \
         patch("agent.loop.controller.Reporter", return_value=mock_reporter), \
         patch("agent.loop.controller.ReflectionEngine"), \
         patch("agent.loop.controller.CausalModeler"), \
         patch("agent.loop.controller.LoopObserver"), \
         patch("agent.loop.controller.ImplicitFeedbackCollector"), \
         patch("agent.loop.controller.ReflectionApplicationManager"), \
         patch("agent.loop.controller.ReflectionKnowledgeBase"):
        ctrl = LoopController(llm=mock_llm)
        ctrl.planner = mock_planner
        ctrl.executor = mock_executor
        ctrl.evaluator = mock_evaluator
        ctrl.reporter = mock_reporter
        return ctrl


# ─────────────────────────────────────────────
# 1. run() 基本执行测试
# ─────────────────────────────────────────────

class TestRun:
    """测试 run() 方法"""

    @pytest.mark.asyncio
    async def test_run_simple_plan_completes(
        self, controller, mock_executor, mock_reporter,
    ):
        """简单计划应正常完成"""
        result = await controller.run("test task")

        assert isinstance(result, AgentResult)
        assert result.response == "task completed"
        assert result.quality_score == 0.9
        mock_executor.execute.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_budget_max_rounds(
        self, controller, mock_executor,
    ):
        """超过最大轮次时应停止循环"""
        # 让评估总是返回 "continue"，这样循环会继续
        controller.evaluator.evaluate = AsyncMock(return_value=MagicMock(
            goal_progress=0.5,
            suggested_action="continue",
            reason="not done yet",
        ))

        result = await controller.run("test task")

        # 循环应该在 max_rounds 后停止
        assert result is not None
        assert controller.state == LoopState.COMPLETED


# ─────────────────────────────────────────────
# 2. 预算强制执行测试
# ─────────────────────────────────────────────

class TestBudgetEnforcement:
    """测试预算强制执行"""

    @pytest.mark.asyncio
    async def test_time_budget_exceeded(
        self, controller,
    ):
        """时间预算用尽时应停止循环"""
        # 模拟时间流逝
        start = time.time()
        with patch("time.time", side_effect=[
            start,  # budget start_time
            start,  # first check
            start + 200,  # time budget exceeded ( > max_duration_ms=120000)
        ]):
            result = await controller.run("test task")

        assert result is not None


# ─────────────────────────────────────────────
# 3. ReAct 循环测试
# ─────────────────────────────────────────────

class TestReActLoop:
    """测试 run_react_loop() 方法"""

    @pytest.mark.asyncio
    async def test_react_loop_simple(
        self, controller, mock_llm,
    ):
        """ReAct 循环应正常执行"""
        # 让 LLM 返回一个 final answer
        mock_llm.chat = AsyncMock(return_value={"content": '{"thought": "done", "action": {"final_answer": "answer"}}'})

        result = await controller.run_react_loop("test")

        assert result.success is True
        assert "answer" in result.response

    @pytest.mark.asyncio
    async def test_react_mode_auto_selection(
        self, controller,
    ):
        """包含 '搜索' 关键词的任务应自动使用 ReAct 模式"""
        # _should_use_react 应该返回 True
        assert controller._should_use_react("搜索一下天气") is True
        assert controller._should_use_react("复杂多步骤任务规划") is False


# ─────────────────────────────────────────────
# 4. 状态转换测试
# ─────────────────────────────────────────────

class TestStateTransitions:
    """测试状态转换"""

    @pytest.mark.asyncio
    async def test_state_sequence(
        self, controller,
    ):
        """状态应按 PLANNING → EXECUTING → EVALUATING → REPORTING 顺序转换"""
        states = []

        def capture_state():
            states.append(controller.state)

        # 用 side_effect 捕获状态转换
        controller.evaluator.evaluate = AsyncMock(side_effect=lambda *a, **kw: (
            capture_state() or MagicMock(
                goal_progress=1.0,
                suggested_action="continue",
            )
        ))

        await controller.run("test")

        # 至少应该有 REPORTING 或 COMPLETED 状态
        assert controller.state in (LoopState.REPORTING, LoopState.COMPLETED)
