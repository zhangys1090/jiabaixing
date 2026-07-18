"""Tree-of-Thought 推理框架测试"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from agent.loop.tot_planner import (
    TreeOfThoughtsPlanner,
    TotConfig,
    CandidatePlan,
    TaskNature,
    TotMeta,
)
from agent.loop.types import LoopContext


def _make_llm(responses: list[dict] | None = None):
    llm = AsyncMock()
    if responses:
        llm.chat.side_effect = responses
    else:
        llm.chat.return_value = {"content": '{"candidates": []}'}
    return llm


class TestTotConfig:
    def test_default_config(self):
        config = TotConfig()
        assert config.enabled is True
        assert config.max_candidates == 3

    def test_custom_config(self):
        config = TotConfig(enabled=False, max_candidates=5)
        assert config.enabled is False
        assert config.max_candidates == 5


class TestTreeOfThoughtsPlanner:
    def test_init_default(self):
        planner = TreeOfThoughtsPlanner()
        assert planner.llm is None
        assert planner.config.enabled is True

    def test_init_with_config(self):
        config = TotConfig(enabled=False)
        planner = TreeOfThoughtsPlanner(tot_config=config)
        assert planner.config.enabled is False

    @pytest.mark.asyncio
    async def test_plan_disabled_returns_empty(self):
        config = TotConfig(enabled=False)
        planner = TreeOfThoughtsPlanner(tot_config=config)
        plan, meta = await planner.plan_with_tot("test")
        assert len(plan.steps) == 0
        assert meta is None

    @pytest.mark.asyncio
    async def test_plan_no_llm_returns_empty(self):
        planner = TreeOfThoughtsPlanner()
        plan, meta = await planner.plan_with_tot("test")
        assert len(plan.steps) == 0
        assert meta is None

    @pytest.mark.asyncio
    async def test_plan_single_candidate(self):
        llm = _make_llm([
            {"content": '{"candidates": [{"strategy": "直接分析", "reasoning": "简单任务", "steps": [{"id": "s1", "description": "分析问题"}], "estimatedRounds": 2}]}'},
        ])
        planner = TreeOfThoughtsPlanner(llm=llm)
        plan, meta = await planner.plan_with_tot("简单问题")
        assert len(plan.steps) >= 1
        assert meta is not None
        assert meta.candidate_count == 1

    @pytest.mark.asyncio
    async def test_plan_multiple_candidates_selects_best(self):
        llm = _make_llm([
            {"content": '{"candidates": [{"strategy": "策略A", "reasoning": "推理A", "steps": [{"id": "s1", "description": "步骤A"}], "estimatedRounds": 2}, {"strategy": "策略B", "reasoning": "推理B", "steps": [{"id": "s2", "description": "步骤B"}], "estimatedRounds": 3}]}'},
            {"content": '{"evaluations": [{"candidateIndex": 0, "feasibilityScore": 0.9, "reasoning": "好"}, {"candidateIndex": 1, "feasibilityScore": 0.5, "reasoning": "一般"}]}'},
        ])
        planner = TreeOfThoughtsPlanner(llm=llm)
        plan, meta = await planner.plan_with_tot("复杂问题")
        assert meta is not None
        assert meta.candidate_count == 2
        assert meta.selected_strategy == "策略A"

    @pytest.mark.asyncio
    async def test_plan_llm_failure_returns_empty(self):
        llm = _make_llm()
        llm.chat.side_effect = Exception("LLM error")
        planner = TreeOfThoughtsPlanner(llm=llm)
        plan, meta = await planner.plan_with_tot("test")
        assert len(plan.steps) == 0

    @pytest.mark.asyncio
    async def test_plan_invalid_json_returns_empty(self):
        llm = _make_llm([{"content": "not valid json"}])
        planner = TreeOfThoughtsPlanner(llm=llm)
        plan, meta = await planner.plan_with_tot("test")
        assert len(plan.steps) == 0


class TestCandidatePlan:
    def test_default_values(self):
        plan = CandidatePlan(strategy="test", reasoning="test reasoning")
        assert plan.strategy == "test"
        assert plan.steps == []
        assert plan.feasibility_score == 0.0


class TestTaskNature:
    def test_default_values(self):
        nature = TaskNature()
        assert nature.essence == ""
        assert nature.complexity == "moderate"
