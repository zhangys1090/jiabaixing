"""辩论驱动规划 + 六层 Harness 激活。

设计目标：
1. 辩论驱动规划：将 DefaultDebater 辩论器集成到规划流程中，
   实现规划-辩论-精炼的完整闭环
2. 六层 Harness 激活：将现有六大 Harness 层级连通为运行时强制执行的完整链路
3. 辩论结果持久化：记录辩论过程和结果，供后续规划参考

六层 Harness 架构：
  L1 - 安全沙箱 (Safety Sandbox): 高风险动作拦截 + 人工审批
  L2 - 辩论审查 (Debate Review): 计划辩论 + 质量门控
  L3 - 因果建模 (Causal Modeling): 依赖分析 + 失败影响评估
  L4 - 反思应用 (Reflection Application): 经验复用 + 策略优化
  L5 - 进化闭环 (Evolution Closed Loop): 进化-验证-反馈闭环
  L6 - 元决策 (Meta Decision): 决策策略自适应选择

辩论驱动规划流程：
  PlanScheduler.schedule()
    → PlanDraft (初始规划)
      → DebateHarness.review() (辩论审查)
        → 辩论通过 → 执行
        → 辩论未通过 → 精炼 → 再次辩论（最多 N 轮）
          → 仍未通过 → 升级到 MCTS 搜索

Usage:
    harness = DebateHarness(debater=debater, meta_decision=meta_engine)
    result = await harness.review(plan, input_text, context)
    if result.approved:
        # 执行计划
    else:
        # 精炼或重规划
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent.core.logger import StructuredLogger
log = StructuredLogger("debate_harness")



class HarnessLevel(str, Enum):
    L1_SAFETY = "l1_safety"
    L2_DEBATE = "l2_debate"
    L3_CAUSAL = "l3_causal"
    L4_REFLECTION = "l4_reflection"
    L5_EVOLUTION = "l5_evolution"
    L6_META_DECISION = "l6_meta_decision"


class DebateVerdict(str, Enum):
    APPROVED = "approved"
    NEEDS_REFINEMENT = "needs_refinement"
    REJECTED = "rejected"
    ESCALATE = "escalate"


@dataclass
class HarnessCheckResult:
    level: HarnessLevel
    passed: bool
    score: float = 0.0
    issues: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


@dataclass
class DebateReviewResult:
    verdict: DebateVerdict = DebateVerdict.APPROVED
    quality_score: float = 0.0
    vulnerabilities: list[str] = field(default_factory=list)
    improvements: list[str] = field(default_factory=list)
    debate_rounds: int = 0
    refined_plan: Any | None = None
    harness_results: list[HarnessCheckResult] = field(default_factory=list)
    total_duration_ms: float = 0.0
    escalated: bool = False
    escalation_reason: str = ""


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


_DEBATE_MAX_ROUNDS = 3
_QUALITY_THRESHOLD_APPROVE = 0.7
_QUALITY_THRESHOLD_REFINE = 0.4


class DebateHarness:
    def __init__(
        self,
        debater: Any | None = None,
        meta_decision: Any | None = None,
        causal_modeler: Any | None = None,
        reflection_engine: Any | None = None,
        evolution_closed_loop: Any | None = None,
        risk_precheck: Any | None = None,
        max_debate_rounds: int = _DEBATE_MAX_ROUNDS,
    ) -> None:
        self._debater = debater
        self._meta_decision = meta_decision
        self._causal_modeler = causal_modeler
        self._reflection_engine = reflection_engine
        self._evolution_closed_loop = evolution_closed_loop
        self._risk_precheck = risk_precheck
        self._max_debate_rounds = max_debate_rounds
        self._review_history: list[DebateReviewResult] = []
        self._max_history = 100

    async def review(
        self,
        plan: Any,
        input_text: str,
        context: Any | None = None,
    ) -> DebateReviewResult:
        start = time.time()
        harness_results: list[HarnessCheckResult] = []

        l1_result = await self._check_l1_safety(plan, context)
        harness_results.append(l1_result)
        if not l1_result.passed:
            return self._build_result(
                DebateVerdict.REJECTED, 0.0, harness_results, start,
                issues=l1_result.issues,
            )

        l2_result = await self._check_l2_debate(plan, input_text, context)
        harness_results.append(l2_result)

        l3_result = await self._check_l3_causal(plan, context)
        harness_results.append(l3_result)

        l4_result = await self._check_l4_reflection(plan, input_text, context)
        harness_results.append(l4_result)

        l5_result = self._check_l5_evolution(plan)
        harness_results.append(l5_result)

        l6_result = self._check_l6_meta_decision(plan, context)
        harness_results.append(l6_result)

        overall_score = self._aggregate_scores(harness_results)
        all_issues = []
        all_improvements = []
        for r in harness_results:
            all_issues.extend(r.issues)
            all_improvements.extend(r.recommendations)

        verdict = self._determine_verdict(overall_score, l2_result, all_issues)
        escalated = False
        escalation_reason = ""

        if verdict == DebateVerdict.NEEDS_REFINEMENT and self._debater:
            refined_plan = await self._refine_through_debate(
                plan, input_text, context,
            )
            if refined_plan is not None:
                return self._build_result(
                    DebateVerdict.APPROVED,
                    overall_score,
                    harness_results,
                    start,
                    improvements=all_improvements,
                    refined_plan=refined_plan,
                    debate_rounds=self._max_debate_rounds,
                )
            else:
                escalated = True
                escalation_reason = "辩论精炼未通过，升级到 MCTS 搜索"

        result = self._build_result(
            verdict, overall_score, harness_results, start,
            issues=all_issues,
            improvements=all_improvements,
            escalated=escalated,
            escalation_reason=escalation_reason,
        )

        self._review_history.append(result)
        if len(self._review_history) > self._max_history:
            self._review_history = self._review_history[-self._max_history:]

        return result

    async def _check_l1_safety(self, plan: Any, context: Any | None = None) -> HarnessCheckResult:
        start = time.time()
        issues: list[str] = []
        recommendations: list[str] = []

        if self._risk_precheck and hasattr(self._risk_precheck, "annotate_plan"):
            try:
                self._risk_precheck.annotate_plan(plan)
                for step in plan.steps:
                    if getattr(step, "risk_level", "low") in ("critical",):
                        issues.append(f"步骤 {step.step_id} 风险等级为 critical，需要人工审批")
                        recommendations.append(f"建议对步骤 {step.step_id} 设置人工确认")
            except Exception as e:
                log.debug("L1 safety check failed", error=str(e))

        critical_steps = [
            s for s in plan.steps
            if getattr(s, "risk_level", "low") in ("critical", "high")
        ]
        if critical_steps and not issues:
            issues.append(f"存在 {len(critical_steps)} 个高风险步骤")

        score = max(0.0, 1.0 - len(issues) * 0.3)
        return HarnessCheckResult(
            level=HarnessLevel.L1_SAFETY,
            passed=len(issues) == 0,
            score=score,
            issues=issues,
            recommendations=recommendations,
            duration_ms=(time.time() - start) * 1000,
        )

    async def _check_l2_debate(
        self,
        plan: Any,
        input_text: str,
        context: Any | None = None,
    ) -> HarnessCheckResult:
        start = time.time()
        issues: list[str] = []
        recommendations: list[str] = []
        quality_score = 0.8

        if self._debater:
            try:
                if hasattr(self._debater, "multi_round_debate"):
                    debate_result = await self._debater.multi_round_debate(
                        plan, input_text, rounds=min(self._max_debate_rounds, 2),
                    )
                else:
                    debate_result = await self._debater.debate(plan, input_text, context)

                quality_score = debate_result.quality_score
                issues.extend(debate_result.vulnerabilities)
                recommendations.extend(debate_result.improvements)

            except Exception as e:
                log.debug("L2 debate check failed", error=str(e))
                quality_score = 0.6

        return HarnessCheckResult(
            level=HarnessLevel.L2_DEBATE,
            passed=quality_score >= _QUALITY_THRESHOLD_APPROVE and len(issues) == 0,
            score=quality_score,
            issues=issues,
            recommendations=recommendations,
            duration_ms=(time.time() - start) * 1000,
        )

    async def _check_l3_causal(self, plan: Any, context: Any | None = None) -> HarnessCheckResult:
        start = time.time()
        issues: list[str] = []
        recommendations: list[str] = []
        score = 0.9

        if self._causal_modeler and hasattr(self._causal_modeler, "build_graph"):
            try:
                graph = await self._causal_modeler.build_graph(plan)
                if hasattr(graph, "cycles") and graph.cycles:
                    issues.append(f"因果图存在 {len(graph.cycles)} 个循环依赖")
                    score -= 0.2
                if hasattr(graph, "orphan_nodes") and graph.orphan_nodes:
                    recommendations.append(f"存在 {len(graph.orphan_nodes)} 个孤立节点")
                    score -= 0.1
            except Exception as e:
                log.debug("L3 causal check failed", error=str(e))

        return HarnessCheckResult(
            level=HarnessLevel.L3_CAUSAL,
            passed=len(issues) == 0,
            score=max(0.0, score),
            issues=issues,
            recommendations=recommendations,
            duration_ms=(time.time() - start) * 1000,
        )

    async def _check_l4_reflection(
        self,
        plan: Any,
        input_text: str,
        context: Any | None = None,
    ) -> HarnessCheckResult:
        start = time.time()
        recommendations: list[str] = []
        score = 0.8

        if self._reflection_engine and hasattr(self._reflection_engine, "_experience_buffer"):
            try:
                experiences = self._reflection_engine._experience_buffer
                relevant = [
                    e for e in experiences[-20:]
                    if any(kw in input_text.lower() for kw in
                           getattr(e, "error", "").lower().split() +
                           getattr(e, "tool_name", "").lower().split())
                ]
                if relevant:
                    for exp in relevant[:3]:
                        fix = getattr(exp, "fix_suggestion", "")
                        if fix:
                            recommendations.append(f"历史经验: {fix[:100]}")
                    score = min(1.0, score + 0.1)
            except Exception as e:
                log.debug("L4 reflection check failed", error=str(e))

        return HarnessCheckResult(
            level=HarnessLevel.L4_REFLECTION,
            passed=True,
            score=score,
            recommendations=recommendations,
            duration_ms=(time.time() - start) * 1000,
        )

    def _check_l5_evolution(self, plan: Any) -> HarnessCheckResult:
        start = time.time()
        recommendations: list[str] = []
        score = 0.8

        if self._evolution_closed_loop:
            try:
                metrics = self._evolution_closed_loop.get_effectiveness_metrics()
                if metrics.effectiveness_rate < 0.3:
                    recommendations.append("进化有效率偏低，建议检查进化策略")
                    score -= 0.1
                if metrics.rolled_back_cycles > metrics.total_cycles * 0.3:
                    recommendations.append("回滚率偏高，建议降低进化激进程度")
                    score -= 0.1
            except Exception as e:
                log.debug("L5 evolution check failed", error=str(e))

        return HarnessCheckResult(
            level=HarnessLevel.L5_EVOLUTION,
            passed=True,
            score=max(0.0, score),
            recommendations=recommendations,
            duration_ms=(time.time() - start) * 1000,
        )

    def _check_l6_meta_decision(self, plan: Any, context: Any | None = None) -> HarnessCheckResult:
        start = time.time()
        recommendations: list[str] = []
        score = 0.8

        if self._meta_decision and hasattr(self._meta_decision, "get_stats"):
            try:
                stats = self._meta_decision.get_stats()
                strategy_stats = stats.get("strategy_stats", {})
                for name, s in strategy_stats.items():
                    if s.get("total", 0) > 5 and s.get("success_rate", 0) < 0.4:
                        recommendations.append(
                            f"策略 {name} 成功率偏低({s['success_rate']:.0%})，建议调整"
                        )
                        score -= 0.05
            except Exception as e:
                log.debug("L6 meta decision check failed", error=str(e))

        return HarnessCheckResult(
            level=HarnessLevel.L6_META_DECISION,
            passed=True,
            score=max(0.0, score),
            recommendations=recommendations,
            duration_ms=(time.time() - start) * 1000,
        )

    def _aggregate_scores(self, results: list[HarnessCheckResult]) -> float:
        if not results:
            return 0.5
        weights = {
            HarnessLevel.L1_SAFETY: 2.0,
            HarnessLevel.L2_DEBATE: 1.5,
            HarnessLevel.L3_CAUSAL: 1.0,
            HarnessLevel.L4_REFLECTION: 0.8,
            HarnessLevel.L5_EVOLUTION: 0.6,
            HarnessLevel.L6_META_DECISION: 0.5,
        }
        total_weight = 0.0
        weighted_sum = 0.0
        for r in results:
            w = weights.get(r.level, 1.0)
            weighted_sum += r.score * w
            total_weight += w
        return weighted_sum / total_weight if total_weight > 0 else 0.5

    def _determine_verdict(
        self,
        overall_score: float,
        debate_result: HarnessCheckResult,
        issues: list[str],
    ) -> DebateVerdict:
        if not debate_result.passed and debate_result.score < 0.3:
            return DebateVerdict.REJECTED
        if overall_score >= _QUALITY_THRESHOLD_APPROVE and not issues:
            return DebateVerdict.APPROVED
        if overall_score >= _QUALITY_THRESHOLD_REFINE:
            return DebateVerdict.NEEDS_REFINEMENT
        return DebateVerdict.ESCALATE

    async def _refine_through_debate(
        self,
        plan: Any,
        input_text: str,
        context: Any | None = None,
    ) -> Any | None:
        if not self._debater:
            return None

        try:
            if hasattr(self._debater, "multi_round_debate"):
                result = await self._debater.multi_round_debate(
                    plan, input_text, rounds=self._max_debate_rounds,
                )
            else:
                result = await self._debater.debate(plan, input_text, context)

            if result.passed and result.quality_score >= _QUALITY_THRESHOLD_APPROVE:
                if result.improvements:
                    for step in plan.steps:
                        for imp in result.improvements:
                            if step.tool_name and step.tool_name in imp:
                                step.description = f"{step.description} (改进: {imp[:50]})"
                return plan

        except Exception as e:
            log.warning("Debate refinement failed", error=str(e))

        return None

    def _build_result(
        self,
        verdict: DebateVerdict,
        quality_score: float,
        harness_results: list[HarnessCheckResult],
        start_time: float,
        issues: list[str] | None = None,
        improvements: list[str] | None = None,
        refined_plan: Any | None = None,
        debate_rounds: int = 0,
        escalated: bool = False,
        escalation_reason: str = "",
    ) -> DebateReviewResult:
        return DebateReviewResult(
            verdict=verdict,
            quality_score=quality_score,
            vulnerabilities=issues or [],
            improvements=improvements or [],
            debate_rounds=debate_rounds,
            refined_plan=refined_plan,
            harness_results=harness_results,
            total_duration_ms=(time.time() - start_time) * 1000,
            escalated=escalated,
            escalation_reason=escalation_reason,
        )

    def get_review_history(self, limit: int = 10) -> list[DebateReviewResult]:
        return self._review_history[-limit:]
