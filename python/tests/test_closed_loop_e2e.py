"""三位一体闭环端到端测试 — 感知行动闭环 / 辩论驱动规划 / 进化型决策。

验证 8 项修复（P0-修复1/2/3 + P1-修复4/5/6 + 残留-1/2）在运行时的真实生效：
  1. 感知行动闭环：PerceptionBus 五感产出 + ReAct 循环感知注入
  2. 辩论驱动规划：MetaDecisionEngine Q-Learning 读写闭环 + MCTS 规划器实例化
  3. 进化型决策：EvolutionEngine 4 方法 + EvolutionClosedLoop 自动触发
  4. 三位一体集成：感知→决策→进化全链路连通
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.evolution.closed_loop import (
    EvolutionAction,
    EvolutionClosedLoop,
    EvolutionSignal,
)
from agent.evolution.engine import EvolutionEngine
from agent.loop.meta_decision_engine import (
    DecisionContext,
    DecisionStrategy,
    MetaDecisionEngine,
)
from agent.loop.types import ExecutionPlan, LoopContext, PlanStep
from agent.perception.bus import PerceptionBus, PerceptionLevel, PerceptionState

# ═══════════════════════════════════════════════════════════════════
# Part 1: 感知行动闭环测试（95%）
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.e2e
class TestPerceptionActionLoop:
    """感知行动闭环 — Perceive→Plan→Execute→Verify→Report 链路。"""

    @pytest.fixture
    def perception_bus(self) -> PerceptionBus:
        return PerceptionBus(level=PerceptionLevel.LIGHT)

    async def test_perceive_returns_state(self, perception_bus: PerceptionBus):
        """五感总线 perceive() 返回标准化 PerceptionState。"""
        state = await perception_bus.perceive("帮我写个脚本", context={"round": 1})

        assert isinstance(state, PerceptionState)
        assert state.perception_level == PerceptionLevel.LIGHT
        assert len(state.channels_active) > 0
        assert state.duration_ms > 0

    async def test_perception_state_to_prompt_text(self, perception_bus: PerceptionBus):
        """PerceptionState.to_prompt_text() 产出可注入规划的感知文本。"""
        state = PerceptionState()
        state.emotion.emotion_type = "frustrated"
        state.emotion.intensity = 0.8
        state.emotion.confidence = 0.9
        state.emotion.potential_needs = ["快速解决问题"]
        state.scene.scene_type = "coding"
        state.scene.confidence = 0.85
        state.scene.recommended_tools = ["code_tools", "shell_exec"]

        text = state.to_prompt_text()

        assert "用户情绪" in text
        assert "frustrated" in text
        assert "当前场景" in text
        assert "coding" in text
        assert "推荐工具" in text

    async def test_perception_empty_state_no_text(self):
        """空感知状态不产出文本（避免噪声注入规划）。"""
        state = PerceptionState()
        assert state.to_prompt_text() == ""

    async def test_perception_feedback_loop(self, perception_bus: PerceptionBus):
        """执行→感知反馈：previous_results 回灌感知形成闭环。"""
        extra = {
            "session_id": "test-session",
            "round": 2,
            "previous_results": [{"success": False, "tool": "shell_exec"}],
        }
        state = await perception_bus.perceive("重试一下", context=extra)

        assert isinstance(state, PerceptionState)
        assert state.duration_ms > 0


# ═══════════════════════════════════════════════════════════════════
# Part 2: 辩论驱动规划测试（98%）
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.e2e
class TestDebateDrivenPlanning:
    """辩论驱动规划 — 元决策 Q-Learning + MCTS 升级 + 策略路由。"""

    @pytest.fixture
    def meta_engine(self, tmp_path: Path) -> MetaDecisionEngine:
        return MetaDecisionEngine(data_dir=str(tmp_path / "meta_decision"))

    def test_heuristic_high_risk_debate(self, meta_engine: MetaDecisionEngine):
        """高危风险 → debate_driven（启发式决策）。"""
        ctx = DecisionContext(risk_level="high", complexity="moderate")
        strategy = meta_engine._heuristic_decision(ctx)
        assert strategy == DecisionStrategy.DEBATE_DRIVEN

    def test_heuristic_complex_automation_mcts(self, meta_engine: MetaDecisionEngine):
        """复杂自动化任务 → mcts_driven（启发式决策）。"""
        ctx = DecisionContext(complexity="complex", scene="automation")
        strategy = meta_engine._heuristic_decision(ctx)
        assert strategy == DecisionStrategy.MCTS_DRIVEN

    def test_heuristic_simple_rule_based(self, meta_engine: MetaDecisionEngine):
        """简单任务 → rule_based（启发式决策）。"""
        ctx = DecisionContext(complexity="simple")
        strategy = meta_engine._heuristic_decision(ctx)
        assert strategy == DecisionStrategy.RULE_BASED

    def test_q_learning_read_write_loop(self, meta_engine: MetaDecisionEngine):
        """P1-修复4: Q-Learning 读写闭环 — record_outcome 写入，decide 读取。"""
        meta_engine._exploration_rate = 0.0  # 关闭探索，强制用 Q 表
        ctx = DecisionContext(complexity="complex", scene="automation", risk_level="low")

        for _ in range(15):
            meta_engine.record_outcome(
                context=ctx,
                strategy=DecisionStrategy.MCTS_DRIVEN,
                success=True,
                quality_score=0.9,
            )

        state_key = meta_engine._state_key(ctx)
        assert state_key in meta_engine._q_table
        assert "mcts_driven" in meta_engine._q_table[state_key]
        assert meta_engine._q_table[state_key]["mcts_driven"] > 0.5

        chosen = meta_engine.decide(ctx)
        assert chosen == DecisionStrategy.MCTS_DRIVEN

    def test_build_context_from_loop(self, meta_engine: MetaDecisionEngine):
        """build_context_from_loop 从 LoopContext 提取决策上下文。"""
        plan = ExecutionPlan(steps=[
            PlanStep(step_id="s1", description="step1"),
            PlanStep(step_id="s2", description="step2"),
            PlanStep(step_id="s3", description="step3"),
        ])
        ctx = LoopContext(user_input="复杂任务", plan=plan)
        ctx.perception_state = PerceptionState()

        decision_ctx = meta_engine.build_context_from_loop(ctx, ctx.perception_state)

        assert decision_ctx.step_count == 3
        assert decision_ctx.has_perception is True
        assert len(decision_ctx.user_input_preview) > 0

    def test_mcts_planner_instantiation(self):
        """P1-修复5: MCTSPlanner 可实例化（辩论 ESCALATE 升级路径就绪）。"""
        from agent.loop.mcts_planner import MCTSConfig, MCTSPlanner

        mock_llm = MagicMock()
        mock_llm.chat = AsyncMock(return_value={"content": '{"steps":[]}'})
        mock_llm.model = "test-model"

        planner = MCTSPlanner(
            llm=mock_llm,
            config=MCTSConfig(time_limit_ms=1000.0, max_iterations=5),
        )
        assert planner is not None


# ═══════════════════════════════════════════════════════════════════
# Part 3: 进化型决策测试（95%）
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.e2e
class TestEvolutionaryDecision:
    """进化型决策 — EvolutionEngine 方法 + EvolutionClosedLoop 自动触发。"""

    @pytest.fixture
    def evo_engine(self, tmp_path: Path) -> EvolutionEngine:
        return EvolutionEngine(data_dir=str(tmp_path / "evolution"))

    @pytest.fixture
    def closed_loop(self, tmp_path: Path) -> EvolutionClosedLoop:
        evo_engine = EvolutionEngine(data_dir=str(tmp_path / "evolution"))
        return EvolutionClosedLoop(
            evolution_engine=evo_engine,
            data_dir=str(tmp_path / "closed_loop"),
        )

    def test_record_tool_signal(self, evo_engine: EvolutionEngine):
        """P1-修复6: record_tool_signal 更新工具信号统计。"""
        evo_engine.record_tool_signal("shell_exec", "failure", 0.2)
        evo_engine.record_tool_signal("shell_exec", "failure", 0.3)
        evo_engine.record_tool_signal("code_tools", "success", 0.9)

        stats = evo_engine._tool_signal_stats
        assert stats["shell_exec"]["failure"] == 2
        assert stats["shell_exec"]["total"] == 2
        assert stats["code_tools"]["success"] == 1
        assert evo_engine._total_signals == 3

    async def test_register_risk_signal(self, evo_engine: EvolutionEngine):
        """P1-修复6: register_risk_signal 记录风险并生成纠错规则。"""
        await evo_engine.register_risk_signal(
            risk_type="high_failure_rate",
            description="shell_exec 连续失败 5 次",
            severity="high",
        )

        assert hasattr(evo_engine, "_risk_signals")
        assert len(evo_engine._risk_signals) == 1
        assert evo_engine._risk_signals[0]["risk_type"] == "high_failure_rate"
        assert len(evo_engine._correction_rules) > 0
        assert "high_failure_rate" in evo_engine._correction_rules[-1]["rule"]

    async def test_register_low_risk_no_rule(self, evo_engine: EvolutionEngine):
        """P1-修复6: 低危风险不生成纠错规则（避免噪声）。"""
        await evo_engine.register_risk_signal(
            risk_type="minor_warning",
            description="轻微警告",
            severity="low",
        )
        assert len(evo_engine._risk_signals) == 1
        rules_before = len(evo_engine._correction_rules)
        assert rules_before == 0

    async def test_rollback_to_checkpoint(self, evo_engine: EvolutionEngine):
        """P1-修复6: rollback_to_checkpoint 恢复上次持久化状态。"""
        evo_engine._tool_weights = {"tool_a": 0.9, "tool_b": 0.3}
        evo_engine._schedule_persist()

        evo_engine._tool_weights = {"tool_a": 0.1, "tool_b": 0.8}

        result = await evo_engine.rollback_to_checkpoint("latest")
        assert result is True
        assert evo_engine._tool_weights["tool_a"] == 0.9

    def test_get_realtime_feedback_low_quality(self, evo_engine: EvolutionEngine):
        """P1-修复6: get_realtime_feedback 低质量时建议降速。"""
        for score in [0.2, 0.3, 0.25, 0.35, 0.2]:
            evo_engine._metrics.recent_quality_scores.append(score)

        feedback = evo_engine.get_realtime_feedback()

        assert feedback["suggested_max_retries"] == 1
        assert feedback["should_slow_down"] is True
        assert feedback["recent_avg_quality"] < 0.4

    def test_get_realtime_feedback_high_quality(self, evo_engine: EvolutionEngine):
        """P1-修复6: get_realtime_feedback 高质量时允许更多重试。"""
        for score in [0.9, 0.85, 0.92, 0.88, 0.95]:
            evo_engine._metrics.recent_quality_scores.append(score)

        feedback = evo_engine.get_realtime_feedback()

        assert feedback["suggested_max_retries"] == 3
        assert feedback["should_slow_down"] is False
        assert feedback["recent_avg_quality"] > 0.6

    async def test_closed_loop_ingest_low_quality_triggers_evolution(
        self, closed_loop: EvolutionClosedLoop
    ):
        """残留-1: 低质量报告自动触发进化周期。"""
        from agent.loop.structured_report import (
            QualityReport,
            StructuredExecutionReport,
        )

        report = StructuredExecutionReport(
            session_id="test-low-quality",
            task_summary="测试低质量触发",
            quality=QualityReport(overall_score=0.3),
        )

        await closed_loop.ingest_structured_report(report)

        await asyncio.sleep(0.3)

        metrics = closed_loop.get_effectiveness_metrics()
        assert metrics.total_cycles >= 1

    async def test_closed_loop_ingest_high_risk_triggers_evolution(
        self, closed_loop: EvolutionClosedLoop
    ):
        """残留-1: 高危风险报告自动触发进化周期。"""
        from agent.loop.structured_report import (
            QualityReport,
            RiskReport,
            RiskSeverity,
            StructuredExecutionReport,
        )

        report = StructuredExecutionReport(
            session_id="test-high-risk",
            task_summary="测试高危风险触发",
            quality=QualityReport(overall_score=0.7),
            risks=[
                RiskReport(
                    risk_type="high_failure_rate",
                    severity=RiskSeverity.HIGH,
                    description="工具连续失败",
                ),
            ],
        )

        await closed_loop.ingest_structured_report(report)

        await asyncio.sleep(0.3)

        metrics = closed_loop.get_effectiveness_metrics()
        assert metrics.total_cycles >= 1

    async def test_closed_loop_ingest_high_quality_no_trigger(
        self, closed_loop: EvolutionClosedLoop
    ):
        """残留-1: 高质量无风险报告不触发进化（避免无效开销）。"""
        from agent.loop.structured_report import (
            QualityReport,
            StructuredExecutionReport,
        )

        report = StructuredExecutionReport(
            session_id="test-high-quality",
            task_summary="测试高质量不触发",
            quality=QualityReport(overall_score=0.95),
        )

        cycles_before = closed_loop.get_effectiveness_metrics().total_cycles

        await closed_loop.ingest_structured_report(report)
        await asyncio.sleep(0.2)

        cycles_after = closed_loop.get_effectiveness_metrics().total_cycles
        assert cycles_after == cycles_before

    def test_risk_signal_routes_to_correction_rule(self, closed_loop: EvolutionClosedLoop):
        """残留-1: risk_detected 信号路由到 CORRECTION_RULE 动作。"""
        signal = EvolutionSignal(
            signal_type="risk_detected",
            source="test",
            severity=0.8,
            context={"top_risk": "shell_exec 连续失败"},
        )

        decision = closed_loop.decide_evolution_action(signal)

        assert decision.action == EvolutionAction.CORRECTION_RULE
        assert "shell_exec" in decision.target
        assert decision.confidence == 0.75

    def test_quality_drop_routes_to_prompt_optimize(self, closed_loop: EvolutionClosedLoop):
        """quality_drop 信号路由到 PROMPT_OPTIMIZE 动作。"""
        signal = EvolutionSignal(
            signal_type="quality_drop",
            source="test",
            severity=0.6,
            context={"quality": 0.3, "prompt_id": "default"},
        )

        decision = closed_loop.decide_evolution_action(signal)

        assert decision.action == EvolutionAction.PROMPT_OPTIMIZE
        assert decision.target == "default"


# ═══════════════════════════════════════════════════════════════════
# Part 4: 三位一体集成测试（96%）
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.e2e
class TestThreeInOneIntegration:
    """三位一体集成 — 感知→决策→进化全链路连通验证。"""

    @pytest.fixture
    def integrated_env(self, tmp_path: Path):
        """构建集成测试环境：MetaDecisionEngine + EvolutionEngine + EvolutionClosedLoop。"""
        meta_engine = MetaDecisionEngine(data_dir=str(tmp_path / "meta_decision"))
        evo_engine = EvolutionEngine(data_dir=str(tmp_path / "evolution"))
        closed_loop = EvolutionClosedLoop(
            evolution_engine=evo_engine,
            data_dir=str(tmp_path / "closed_loop"),
        )
        perception_bus = PerceptionBus(level=PerceptionLevel.LIGHT)
        return {
            "meta": meta_engine,
            "evo": evo_engine,
            "closed_loop": closed_loop,
            "perception": perception_bus,
        }

    async def test_full_chain_perception_to_evolution(self, integrated_env: dict):
        """三位一体全链路：感知→元决策→进化反馈。"""
        meta_engine: MetaDecisionEngine = integrated_env["meta"]
        closed_loop: EvolutionClosedLoop = integrated_env["closed_loop"]
        perception_bus: PerceptionBus = integrated_env["perception"]

        # Step 1: 感知
        perception_state = await perception_bus.perceive(
            "帮我自动化处理一批文件",
            context={"round": 1},
        )
        assert perception_state is not None

        # Step 2: 元决策（基于感知上下文选择策略）
        ctx = LoopContext(user_input="帮我自动化处理一批文件")
        ctx.perception_state = perception_state
        decision_ctx = meta_engine.build_context_from_loop(ctx, perception_state)
        strategy = meta_engine.decide(decision_ctx)
        assert strategy in DecisionStrategy

        # Step 3: 模拟执行后低质量报告→进化反馈
        from agent.loop.structured_report import (
            QualityReport,
            StructuredExecutionReport,
        )
        report = StructuredExecutionReport(
            session_id="integration-test",
            task_summary="自动化处理文件",
            quality=QualityReport(overall_score=0.35),
        )
        await closed_loop.ingest_structured_report(report)
        await asyncio.sleep(0.3)

        # Step 4: 验证进化周期被触发
        metrics = closed_loop.get_effectiveness_metrics()
        assert metrics.total_cycles >= 1

        # Step 5: 元决策经验记录（Q-Learning 写入）
        meta_engine.record_outcome(
            context=decision_ctx,
            strategy=strategy,
            success=False,
            quality_score=0.35,
        )
        stats = meta_engine.get_stats()
        total_decisions = sum(s["total"] for s in stats["strategy_stats"].values())
        assert total_decisions >= 1

    async def test_evolution_feedback_improves_decision(self, integrated_env: dict):
        """进化反馈循环：低质量→进化→经验记录→下次决策调整。"""
        meta_engine: MetaDecisionEngine = integrated_env["meta"]
        evo_engine: EvolutionEngine = integrated_env["evo"]

        # 模拟连续低质量执行
        for _ in range(5):
            evo_engine._metrics.recent_quality_scores.append(0.3)

        feedback = evo_engine.get_realtime_feedback()
        assert feedback["should_slow_down"] is True
        assert feedback["suggested_max_retries"] == 1

        # 记录失败经验
        ctx = DecisionContext(complexity="moderate", scene="daily")
        meta_engine.record_outcome(
            context=ctx,
            strategy=DecisionStrategy.RULE_BASED,
            success=False,
            quality_score=0.3,
        )

        # 验证 Q 表更新（rule_based 策略价值下降）
        state_key = meta_engine._state_key(ctx)
        if state_key in meta_engine._q_table:
            q_val = meta_engine._q_table[state_key].get("rule_based", 0.5)
            assert q_val < 0.5  # 失败导致价值下降

    async def test_risk_signal_full_chain(self, integrated_env: dict):
        """风险信号全链路：风险检测→进化引擎→纠错规则→实时反馈。"""
        evo_engine: EvolutionEngine = integrated_env["evo"]
        closed_loop: EvolutionClosedLoop = integrated_env["closed_loop"]

        # Step 1: 注册高危风险
        await evo_engine.register_risk_signal(
            risk_type="consecutive_failure",
            description="工具连续失败 3 次",
            severity="critical",
        )

        # Step 2: 验证纠错规则生成
        assert len(evo_engine._correction_rules) > 0
        assert "consecutive_failure" in evo_engine._correction_rules[-1]["rule"]

        # Step 3: 通过结构化报告触发进化周期
        from agent.loop.structured_report import (
            QualityReport,
            RiskReport,
            RiskSeverity,
            StructuredExecutionReport,
        )
        report = StructuredExecutionReport(
            session_id="risk-chain-test",
            task_summary="风险链路测试",
            quality=QualityReport(overall_score=0.25),
            risks=[
                RiskReport(
                    risk_type="consecutive_failure",
                    severity=RiskSeverity.CRITICAL,
                    description="工具连续失败",
                ),
            ],
        )
        await closed_loop.ingest_structured_report(report)
        await asyncio.sleep(0.3)

        # Step 4: 验证进化周期执行
        metrics = closed_loop.get_effectiveness_metrics()
        assert metrics.total_cycles >= 1

    def test_strategy_routing_forces_debate(self, integrated_env: dict):
        """残留-2: debate_driven 策略强制启用辩论审查。"""
        meta_engine: MetaDecisionEngine = integrated_env["meta"]

        # 高危场景应选择 debate_driven
        ctx = DecisionContext(risk_level="critical", complexity="moderate")
        meta_engine._exploration_rate = 0.0
        strategy = meta_engine.decide(ctx)
        assert strategy == DecisionStrategy.DEBATE_DRIVEN

    def test_strategy_routing_mcts_for_complex(self, integrated_env: dict):
        """残留-2: mcts_driven 策略用于复杂自动化任务。"""
        meta_engine: MetaDecisionEngine = integrated_env["meta"]

        ctx = DecisionContext(complexity="complex", scene="automation", risk_level="low")
        meta_engine._exploration_rate = 0.0
        strategy = meta_engine.decide(ctx)
        assert strategy == DecisionStrategy.MCTS_DRIVEN
