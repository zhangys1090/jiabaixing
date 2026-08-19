"""Debater 辩论式推理测试 — P0 接入验证"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from agent.loop.debater import (
    DefaultDebater,
    DebaterOutput,
)
from agent.loop.types import LoopContext, ExecutionPlan, PlanStep


def _make_llm(responses: list[dict] | None = None):
    llm = AsyncMock()
    if responses:
        llm.chat.side_effect = responses
    else:
        llm.chat.return_value = {"content": '{"passed": true, "qualityScore": 0.85}'}
    return llm


def _make_context():
    ctx = MagicMock(spec=LoopContext)
    ctx.metadata = {}
    ctx.input_text = "test input"
    ctx.user_id = "test_user"
    return ctx


def _make_plan(steps: int = 2):
    plan = MagicMock(spec=ExecutionPlan)
    plan.simple = False
    plan.steps = [MagicMock(spec=PlanStep) for _ in range(steps)]
    for i, step in enumerate(plan.steps):
        step.description = f"步骤{i+1}"
        step.action = f"action_{i+1}"
    plan.description = "测试计划"
    return plan


class TestDebaterOutput:
    def test_output_creation_passed(self):
        output = DebaterOutput(
            passed=True,
            quality_score=8.5,
            vulnerabilities=[],
            improvements=[],
        )
        assert output.passed is True
        assert output.quality_score == 8.5
        assert output.vulnerabilities == []
        assert output.improvements == []

    def test_output_creation_failed(self):
        output = DebaterOutput(
            passed=False,
            quality_score=3.0,
            vulnerabilities=["步骤2缺少回滚方案"],
            improvements=["增加回滚步骤"],
        )
        assert output.passed is False
        assert output.quality_score == 3.0
        assert len(output.vulnerabilities) == 1
        assert len(output.improvements) == 1


class TestDefaultDebater:
    @pytest.mark.asyncio
    async def test_debate_passes_with_high_score(self):
        llm = _make_llm([
            {"content": '{"passed": true, "qualityScore": 0.9, "vulnerabilities": [], "improvements": []}'},
        ])
        debater = DefaultDebater(llm=llm)
        plan = _make_plan(2)
        ctx = _make_context()

        result = await debater.debate(plan, "测试输入", ctx)
        assert result.passed is True
        assert result.quality_score == 0.9
        assert result.vulnerabilities == []

    @pytest.mark.asyncio
    async def test_debate_fails_with_low_score(self):
        llm = _make_llm([
            {"content": '{"passed": false, "qualityScore": 0.3, "vulnerabilities": ["风险1"], "improvements": ["改进1"]}'},
        ])
        debater = DefaultDebater(llm=llm)
        plan = _make_plan(3)
        ctx = _make_context()

        result = await debater.debate(plan, "测试输入", ctx)
        assert result.passed is False
        assert result.quality_score == 0.3
        assert len(result.vulnerabilities) == 1
        assert len(result.improvements) == 1

    @pytest.mark.asyncio
    async def test_debate_with_vulnerabilities(self):
        llm = _make_llm([
            {"content": '{"passed": false, "qualityScore": 0.4, "vulnerabilities": ["缺乏错误处理", "没有超时机制"], "improvements": ["添加try/except", "设置超时"]}'},
        ])
        debater = DefaultDebater(llm=llm)
        plan = _make_plan(2)
        ctx = _make_context()

        result = await debater.debate(plan, "复杂任务", ctx)
        assert result.passed is False
        assert len(result.vulnerabilities) == 2
        assert len(result.improvements) == 2

    @pytest.mark.asyncio
    async def test_debate_simple_plan_skips(self):
        llm = _make_llm()
        debater = DefaultDebater(llm=llm)
        plan = _make_plan(1)
        plan.simple = True
        ctx = _make_context()

        result = await debater.debate(plan, "简单任务", ctx)
        assert result.passed is True
        assert result.quality_score >= 0

    @pytest.mark.asyncio
    async def test_debate_preserves_metadata(self):
        llm = _make_llm([
            {"content": '{"passed": true, "qualityScore": 0.75, "vulnerabilities": [], "improvements": ["优化步骤顺序"]}'},
        ])
        debater = DefaultDebater(llm=llm)
        plan = _make_plan(2)
        ctx = _make_context()

        result = await debater.debate(plan, "测试", ctx)
        assert result.quality_score == 0.75
        assert "优化步骤顺序" in result.improvements
