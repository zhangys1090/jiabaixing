"""集成断层修复测试 — 验证灰度发布、记忆链路、时间预算三大模块的集成。

覆盖审计发现的断层：
1. 灰度发布: LoopController 接收 canary_manager；canary 健康端点可用
2. 记忆链路: LoopController 接收 memory_engine；planner 在 Loop 模式下检索记忆
3. 时间预算: LoopController 接收 constraints_service 并调用 resolve_adaptive_budget
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.constraints.service import ConstraintsService
from agent.core.canary_release import (
    CanaryReleaseManager,
    CanaryStrategy,
    HealthMetrics,
)
from agent.loop.controller import LoopController
from agent.loop.types import LoopContext, BudgetState


# ─────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────


@pytest.fixture
def mock_llm():
    """构造模拟 LLM Provider，避免真实 API 调用。"""
    llm = AsyncMock()
    llm.canary_manager = None
    llm.chat = AsyncMock(return_value={"content": "mock response"})
    llm.model = "mock-model"
    return llm


@pytest.fixture
def mock_memory_engine():
    """构造模拟记忆引擎，记录 search_with_context 调用。"""
    engine = AsyncMock()
    engine.search_with_context = AsyncMock(
        return_value=[
            {"content": "历史经验: 使用搜索工具查找信息", "relevance_score": 0.85}
        ]
    )
    return engine


# ─────────────────────────────────────────────
# 1. 灰度发布: LoopController 接收 canary_manager
# ─────────────────────────────────────────────


class TestLoopControllerReceivesCanaryManager:
    """验证 LoopController 正确接收并注入 canary_manager。"""

    def test_loop_controller_receives_canary_manager(self, mock_llm):
        """LoopController 应将 canary_manager 注入到 LLMProvider。

        修复断层 1.1: engine.py 创建 LoopController 时未传 canary_manager。
        """
        canary = CanaryReleaseManager()
        controller = LoopController(
            llm=mock_llm,
            canary_manager=canary,
        )
        assert controller.llm.canary_manager is canary

    def test_loop_controller_without_canary_manager(self, mock_llm):
        """未传入 canary_manager 时，LLMProvider.canary_manager 应保持 None。"""
        controller = LoopController(llm=mock_llm)
        assert controller.llm.canary_manager is None


# ─────────────────────────────────────────────
# 2. 记忆链路: LoopController 接收 memory_engine
# ─────────────────────────────────────────────


class TestLoopControllerReceivesMemoryEngine:
    """验证 LoopController 正确接收 memory_engine 并传递给 planner。"""

    def test_loop_controller_receives_memory_engine(self, mock_llm, mock_memory_engine):
        """LoopController 应将 memory_engine 传递给 planner。

        修复断层 2.1: engine.py 创建 LoopController 时未传 memory_engine。
        """
        controller = LoopController(
            llm=mock_llm,
            memory_engine=mock_memory_engine,
        )
        assert controller.planner._memory_engine is mock_memory_engine

    def test_loop_controller_without_memory_engine(self, mock_llm):
        """未传入 memory_engine 时，planner._memory_engine 应为 None。"""
        controller = LoopController(llm=mock_llm)
        assert controller.planner._memory_engine is None


# ─────────────────────────────────────────────
# 3. 时间预算: LoopController 接收 constraints_service
# ─────────────────────────────────────────────


class TestLoopControllerReceivesConstraintsService:
    """验证 LoopController 正确接收 constraints_service 并在预算解析中使用。"""

    def test_loop_controller_receives_constraints_service(self, mock_llm):
        """LoopController 应存储 constraints_service 供 _resolve_budget_max_duration 使用。

        修复断层 3.3: ConstraintsService 在 engine.py 实例化但未注入 LoopController。
        """
        constraints = ConstraintsService()
        controller = LoopController(
            llm=mock_llm,
            constraints_service=constraints,
        )
        assert controller.constraints_service is constraints

    def test_resolve_budget_uses_constraints_service(self, mock_llm):
        """_resolve_budget_max_duration 应调用 constraints_service.resolve_adaptive_budget。

        修复断层 3.1: resolve_adaptive_budget 生产代码零调用。
        """
        constraints = ConstraintsService()
        # 用 spy 监控 resolve_adaptive_budget 调用
        spy = MagicMock(wraps=constraints.resolve_adaptive_budget)
        constraints.resolve_adaptive_budget = spy

        controller = LoopController(
            llm=mock_llm,
            constraints_service=constraints,
        )
        result = controller._resolve_budget_max_duration("moderate", "分析任务")

        # resolve_adaptive_budget 应被调用
        assert spy.called
        # 返回值应为正整数（毫秒）
        assert isinstance(result, int)
        assert result > 0

    def test_resolve_budget_passes_complexity_to_trajectory(self, mock_llm):
        """_resolve_budget_max_duration 应将 complexity 传给 estimate_execution_time。

        修复断层 3.2: controller.py 调用 estimate_execution_time 未传 complexity。
        """
        constraints = ConstraintsService()
        trajectory_db = MagicMock()
        # estimate_execution_time 返回 None（样本不足），触发降级路径
        trajectory_db.estimate_execution_time = MagicMock(return_value=None)

        controller = LoopController(
            llm=mock_llm,
            trajectory_db=trajectory_db,
            constraints_service=constraints,
        )
        controller._resolve_budget_max_duration("moderate", "分析对比优化任务")

        # 验证 estimate_execution_time 被调用时传入了 complexity 参数
        call_args = trajectory_db.estimate_execution_time.call_args
        assert call_args is not None
        kwargs = call_args.kwargs
        assert "complexity" in kwargs
        assert kwargs["complexity"] is not None
        assert 0.0 <= kwargs["complexity"] <= 1.0


# ─────────────────────────────────────────────
# 4. 灰度发布: canary 健康端点可用
# ─────────────────────────────────────────────


class TestCanaryHealthEndpoint:
    """验证 /canary/strategies/{name}/health 端点不再返回 500。"""

    @pytest.mark.asyncio
    async def test_canary_health_endpoint_works(self):
        """健康端点应返回 200 + 健康指标，而非因方法名错误导致异常。

        修复断层 1.3: canary.py 调用不存在的 get_health（应为 check_health）。
        """
        from httpx import ASGITransport, AsyncClient
        from agent.main import app

        # 构造带 canary_manager 的 mock engine
        canary_manager = CanaryReleaseManager()
        await canary_manager.create_strategy(CanaryStrategy(
            name="test-health",
            stable_version="v1",
            canary_version="v2",
            canary_percentage=100,
        ))
        # 建立灰度分配并记录结果，使健康指标有样本
        await canary_manager.select_version("user-1", "test-health")
        await canary_manager.record_outcome(
            "user-1", "test-health", success=True, latency_ms=100
        )

        mock_engine = MagicMock()
        mock_engine.canary_manager = canary_manager

        # 设置 app.state.engine（生产代码在 lifespan 中设置）
        app.state.engine = mock_engine

        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                resp = await c.get("/v1/canary/strategies/test-health/health")

            assert resp.status_code == 200
            data = resp.json()
            # 不应包含 error 字段（原先因 get_health 不存在会返回 error）
            assert "error" not in data
            assert data["name"] == "test-health"
            assert "health" in data
            # 健康指标应包含 sample_count
            health = data["health"]
            assert health["sample_count"] >= 1
        finally:
            # 清理 app.state，避免影响其他测试
            if hasattr(app.state, "engine"):
                del app.state.engine


# ─────────────────────────────────────────────
# 5. 记忆链路: planner 在 Loop 模式下检索记忆
# ─────────────────────────────────────────────


class TestPlannerMemoryRetrievalActive:
    """验证 Loop 模式下 planner 真的检索记忆。"""

    @pytest.mark.asyncio
    async def test_planner_memory_retrieval_active(self, mock_llm, mock_memory_engine):
        """planner._plan_complex 应调用 memory_engine.search_with_context 检索历史经验。

        修复断层 2.1+2.2: 此前 LoopController 未传 memory_engine 给 planner，
        且 controller.py:657 引用 self._planner（拼写错误），导致记忆检索链路断裂。
        """
        controller = LoopController(
            llm=mock_llm,
            memory_engine=mock_memory_engine,
        )
        # 禁用 ToT 规划器，确保走标准规划路径（含记忆检索）
        controller.planner._tot_planner = None

        # 模拟 LLM 返回：第一次返回 "complex"（复杂度判断），第二次返回规划步骤
        mock_llm.chat = AsyncMock(
            side_effect=[
                {"content": "complex"},  # _analyze_complexity_semantic 返回
                {"content": "1: 分析数据 [search]\n2: 生成报告 [file_write]"},  # _plan_complex 返回
            ]
        )

        # 使用复杂任务文本触发 _plan_complex（含多个复杂度关键词）
        from agent.loop.types import LoopContext, BudgetState
        context = LoopContext(
            user_input="分析对比这两个方案并优化重构",
            session_id="test",
            budget=BudgetState(start_time=time.time()),
        )

        await controller.planner.plan("分析对比这两个方案并优化重构", context)

        # 验证 memory_engine.search_with_context 被调用
        mock_memory_engine.search_with_context.assert_called()
        call_kwargs = mock_memory_engine.search_with_context.call_args.kwargs
        assert "query" in call_kwargs
        assert "分析对比" in call_kwargs["query"]
