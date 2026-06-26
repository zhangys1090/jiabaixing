from __future__ import annotations

import pytest
import tempfile

from agent.evolution.llm_capability_detector import LLMCapabilities
from agent.evolution.strategy_adapter import (
    StrategyAdapter,
    StrategyConfig,
    PromptStrategy,
    PlanningStrategy,
    ToolUseStrategy,
    ReflectionStrategy,
    ExecutionStrategy,
)


class TestPromptStrategy:
    def test_default(self):
        s = PromptStrategy()
        assert s.reasoning_freedom == "structured"
        assert s.enable_chain_of_thought is False
        assert s.enable_few_shot is True
        assert s.max_examples == 3


class TestPlanningStrategy:
    def test_default(self):
        s = PlanningStrategy()
        assert s.enable_tot is False
        assert s.enable_causal_modeling is False
        assert s.max_plan_depth == 3


class TestToolUseStrategy:
    def test_default(self):
        s = ToolUseStrategy()
        assert s.tool_chain_complexity == "simple"
        assert s.enable_tool_chaining is False
        assert s.max_tool_calls_per_round == 3


class TestReflectionStrategy:
    def test_default(self):
        s = ReflectionStrategy()
        assert s.depth == "shallow"
        assert s.enable_deep_reflection is False
        assert s.max_retries == 1


class TestExecutionStrategy:
    def test_default(self):
        s = ExecutionStrategy()
        assert s.enable_adaptive_control is False
        assert s.risk_assessment_threshold == 0.5


class TestStrategyConfig:
    def test_default(self):
        config = StrategyConfig()
        assert config.version == "1.0.0"
        assert config.prompt is not None
        assert config.planning is not None
        assert config.tool_use is not None
        assert config.reflection is not None
        assert config.execution is not None

    def test_to_dict_and_from_dict_roundtrip(self):
        config = StrategyConfig(
            prompt=PromptStrategy(reasoning_freedom="open", enable_chain_of_thought=True, max_examples=5),
            planning=PlanningStrategy(enable_tot=True, enable_causal_modeling=True, max_plan_depth=6, enable_debate=True),
            tool_use=ToolUseStrategy(tool_chain_complexity="complex", enable_tool_chaining=True, max_tool_calls_per_round=8, enable_parallel_tools=True),
            reflection=ReflectionStrategy(depth="deep", enable_deep_reflection=True, max_retries=4),
            execution=ExecutionStrategy(enable_adaptive_control=True, risk_assessment_threshold=0.9, enable_parallel_execution=True),
            applied_at=1234567890.0,
            llm_overall_score=8.0,
        )
        data = config.to_dict()
        assert data["prompt"]["reasoning_freedom"] == "open"
        assert data["planning"]["enable_tot"] is True
        assert data["tool_use"]["tool_chain_complexity"] == "complex"
        assert data["reflection"]["depth"] == "deep"
        assert data["execution"]["enable_adaptive_control"] is True

        restored = StrategyConfig.from_dict(data)
        assert restored.prompt.reasoning_freedom == "open"
        assert restored.planning.enable_tot is True
        assert restored.tool_use.tool_chain_complexity == "complex"
        assert restored.reflection.depth == "deep"
        assert restored.execution.enable_adaptive_control is True
        assert restored.llm_overall_score == 8.0

    def test_from_dict_missing_fields(self):
        config = StrategyConfig.from_dict({})
        assert config.version == "1.0.0"
        assert config.prompt.reasoning_freedom == "structured"
        assert config.planning.max_plan_depth == 3


class TestStrategyAdapter:
    def test_creation(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            adapter = StrategyAdapter(data_dir=tmpdir)
            assert adapter.get_current_config() is None

    def test_get_default_config(self):
        adapter = StrategyAdapter()
        config = adapter.get_default_config()
        assert config is not None
        assert config.prompt.enable_few_shot is True

    def test_set_callbacks(self):
        adapter = StrategyAdapter()
        cb = {"on_strategy_adapted": lambda config: None}
        adapter.set_callbacks(cb)
        assert adapter._callbacks is cb

    async def test_adapt_low_capability_model(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(
            provider="low-model",
            reasoning_depth=2,
            tool_calling_accuracy=0.3,
            code_generation=2,
            structured_output=0.3,
        )
        config = await adapter.adapt(caps)
        assert config is not None
        assert config.prompt.reasoning_freedom == "structured"
        assert config.prompt.enable_chain_of_thought is False
        assert config.planning.enable_tot is False
        assert config.planning.max_plan_depth == 3
        assert config.tool_use.tool_chain_complexity == "simple"
        assert config.tool_use.max_tool_calls_per_round == 3
        assert config.reflection.depth == "shallow"
        assert config.reflection.max_retries == 1

    async def test_adapt_medium_capability_model(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(
            provider="medium-model",
            reasoning_depth=5,
            tool_calling_accuracy=0.6,
            code_generation=5,
            structured_output=0.6,
        )
        config = await adapter.adapt(caps)
        assert config is not None
        assert config.prompt.reasoning_freedom == "guided"
        assert config.prompt.enable_chain_of_thought is True
        assert config.planning.max_plan_depth == 4
        assert config.tool_use.tool_chain_complexity == "simple"
        assert config.reflection.max_retries == 2

    async def test_adapt_high_capability_model(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(
            provider="high-model",
            reasoning_depth=8,
            tool_calling_accuracy=0.9,
            code_generation=8,
            structured_output=0.9,
        )
        config = await adapter.adapt(caps)
        assert config is not None
        assert config.prompt.reasoning_freedom == "open"
        assert config.prompt.enable_chain_of_thought is True
        assert config.prompt.max_examples == 5
        assert config.planning.enable_tot is True
        assert config.planning.enable_causal_modeling is True
        assert config.planning.enable_dynamic_replanning is True
        assert config.planning.enable_debate is True
        assert config.planning.max_plan_depth == 6
        assert config.tool_use.tool_chain_complexity == "complex"
        assert config.tool_use.enable_tool_chaining is True
        assert config.tool_use.enable_parallel_tools is True
        assert config.tool_use.max_tool_calls_per_round == 8
        assert config.reflection.depth == "deep"
        assert config.reflection.enable_deep_reflection is True
        assert config.reflection.max_retries == 4
        assert config.execution.enable_adaptive_control is True
        assert config.execution.risk_assessment_threshold == 0.9
        assert config.execution.enable_parallel_execution is True

    async def test_adapt_updates_history(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.6, code_generation=5, structured_output=0.6)
        await adapter.adapt(caps)
        history = adapter.get_adaptation_history()
        assert len(history) == 1
        assert history[0]["provider"] == ""

    async def test_adapt_sets_current_config(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.6, code_generation=5, structured_output=0.6)
        await adapter.adapt(caps)
        config = adapter.get_current_config()
        assert config is not None
        assert config.prompt.enable_chain_of_thought is True

    async def test_build_prompt_very_high_reasoning(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=9, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        config = await adapter.adapt(caps)
        assert config.prompt.reasoning_freedom == "open"
        assert config.prompt.max_examples == 5

    async def test_build_planning_edge_cases(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=4, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        config = await adapter.adapt(caps)
        assert config.planning.enable_tot is False
        assert config.planning.max_plan_depth == 4

    async def test_build_tool_use_moderate(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.75, code_generation=5, structured_output=0.5)
        config = await adapter.adapt(caps)
        assert config.tool_use.tool_chain_complexity == "moderate"
        assert config.tool_use.enable_tool_chaining is True
        assert config.tool_use.max_tool_calls_per_round == 5

    async def test_build_reflection_very_high(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=9, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        config = await adapter.adapt(caps)
        assert config.reflection.max_retries == 4
        assert config.reflection.enable_self_correction is True

    async def test_build_reflection_low(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=2, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        config = await adapter.adapt(caps)
        assert config.reflection.enable_self_correction is False

    async def test_build_execution_adaptive(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=7, tool_calling_accuracy=0.8, code_generation=5, structured_output=0.5)
        config = await adapter.adapt(caps)
        assert config.execution.enable_adaptive_control is True
        assert config.execution.risk_assessment_threshold == 0.9
        assert config.execution.enable_parallel_execution is True

    async def test_build_execution_low(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=2, tool_calling_accuracy=0.3, code_generation=3, structured_output=0.5)
        config = await adapter.adapt(caps)
        assert config.execution.enable_adaptive_control is False
        assert config.execution.risk_assessment_threshold == 0.8
        assert config.execution.enable_parallel_execution is False

    async def test_adaptation_history_limit(self):
        adapter = StrategyAdapter()
        caps = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.6, code_generation=5, structured_output=0.6)
        for _ in range(60):
            await adapter.adapt(caps)
        history = adapter.get_adaptation_history()
        assert len(history) <= 50
