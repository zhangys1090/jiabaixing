"""能力驱动路由（W1/U2 最后一公里）接线测试。

验证 Loop 层各组件把 task_type 透传到 llm.chat()，触发 CapabilityAwareRouter
任务级选型，实现「单 Agent 内多模型协同」：
- Planner：复杂度分析用 cheap 模型，规划推理用 reasoning 模型
- Executor：工具参数推断用 agentic 模型
- Evaluator：深度评估用 reasoning 模型
- Controller：主 ReAct 推理透传 context.task_type
"""

from typing import Any

import pytest

from agent.loop.types import LoopContext, StepResult


class FakeLLM:
    """记录所有 chat() 调用及其 task_type 参数的假 LLM。"""

    def __init__(self, responses: list[str] | None = None) -> None:
        self._responses = list(responses or [])
        self.calls: list[dict[str, Any]] = []

    async def chat(self, messages=None, **kwargs):
        self.calls.append({"messages": messages, **kwargs})
        if self._responses:
            return {"content": self._responses.pop(0)}
        return {"content": ""}


# ─────────────────────────────────────────────
# Planner
# ─────────────────────────────────────────────

class TestPlannerTaskTypeRouting:
    @pytest.mark.asyncio
    async def test_complexity_uses_cheap_and_plan_uses_reasoning(self, monkeypatch):
        monkeypatch.setenv("TOT_PLANNER_ENABLED", "false")
        from agent.loop.planner import Planner

        fake = FakeLLM(responses=["moderate", "step1: 分析数据\nstep2: 生成报告"])
        planner = Planner(llm=fake)

        await planner.plan("分析数据并生成报告", LoopContext())

        assert len(fake.calls) >= 2
        # 第一次：复杂度分析 → cheap
        assert fake.calls[0]["task_type"] == "cheap"
        # 第二次：规划推理 → reasoning
        assert fake.calls[1]["task_type"] == "reasoning"


# ─────────────────────────────────────────────
# Executor
# ─────────────────────────────────────────────

class TestExecutorTaskTypeRouting:
    @pytest.mark.asyncio
    async def test_infer_tool_params_uses_agentic(self):
        from agent.loop.executor import Executor
        from agent.tools.registry import (
            ToolDefinition,
            ToolParameterDef,
            ToolRegistry,
            ToolResult,
        )

        async def _noop_executor(**kwargs):
            return ToolResult(success=True, output="")

        registry = ToolRegistry()
        registry.register(
            ToolDefinition(
                name="file_read",
                description="读取文件",
                parameters=[
                    ToolParameterDef(
                        name="path", type="string", required=True, description="文件路径"
                    )
                ],
            ),
            _noop_executor,
        )

        fake = FakeLLM(responses=['{"path": "/tmp/data.csv"}'])
        executor = Executor(llm=fake, tool_registry=registry)

        params = await executor._infer_tool_params(
            "file_read", "读取 /tmp/data.csv 文件", LoopContext()
        )

        assert params == {"path": "/tmp/data.csv"}
        assert fake.calls[0]["task_type"] == "agentic"


# ─────────────────────────────────────────────
# Evaluator
# ─────────────────────────────────────────────

class TestEvaluatorTaskTypeRouting:
    @pytest.mark.asyncio
    async def test_llm_evaluate_uses_reasoning(self):
        from agent.loop.evaluator import Evaluator

        eval_json = (
            '{"goalProgress": 0.5, "suggestedAction": "continue", '
            '"reason": "进行中", "qualityScore": 0.5, '
            '"factualAccuracy": 0.8, "citationAccuracy": 0.8, '
            '"relevanceScore": 0.8, "safetyFlag": false, '
            '"failureAnalysis": "", "suggestedCorrection": ""}'
        )
        fake = FakeLLM(responses=[eval_json])
        evaluator = Evaluator(llm=fake)

        ctx = LoopContext()
        ctx.step_results = {"s1": StepResult(step_id="s1", success=False, content="执行失败")}
        ctx.budget.verification_level = "full"

        await evaluator.evaluate("完成任务", ctx)

        assert len(fake.calls) == 1
        assert fake.calls[0]["task_type"] == "reasoning"


# ─────────────────────────────────────────────
# Controller（主 ReAct 推理）
# ─────────────────────────────────────────────

class TestControllerTaskTypeRouting:
    @pytest.mark.asyncio
    async def test_react_passes_context_task_type(self):
        from unittest.mock import AsyncMock, patch

        with patch("agent.loop.controller.Planner"), \
             patch("agent.loop.controller.Executor"), \
             patch("agent.loop.controller.Evaluator"), \
             patch("agent.loop.controller.Reporter"), \
             patch("agent.loop.controller.ReflectionEngine"), \
             patch("agent.loop.controller.CausalModeler"), \
             patch("agent.loop.controller.LoopObserver"), \
             patch("agent.loop.controller.ImplicitFeedbackCollector"), \
             patch("agent.loop.controller.ReflectionApplicationManager"), \
             patch("agent.loop.controller.ReflectionKnowledgeBase"):
            from agent.loop.controller import LoopController

            mock_llm = AsyncMock()
            mock_llm.chat = AsyncMock(return_value={"content": '{"thought":"t","action":{"final_answer":"done"}}'})

            ctrl = LoopController(llm=mock_llm)
            ctx = LoopContext(task_type="coding")

            await ctrl._react_think_structured("写一个函数", ctx, 0)

            kwargs = mock_llm.chat.call_args.kwargs
            assert kwargs.get("task_type") == "coding"
