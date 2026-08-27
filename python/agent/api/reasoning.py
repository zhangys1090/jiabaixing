"""推理 + 对齐 API 路由。

端点:
  POST /v1/reasoning/analyze    — 反事实推理分析
  POST /v1/reasoning/kernel     — 统一推理内核
  POST /v1/alignment/check      — 宪法检查
  POST /v1/alignment/red-team   — 红队测试
  POST /v1/verification/hallucination — 幻觉检测
  POST /v1/budget/allocate      — 自适应Token预算
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("api_reasoning")

router = APIRouter(tags=["reasoning", "alignment", "verification"])


class CounterfactualRequest(BaseModel):
    problem: str = Field(..., description="问题描述")
    best_path: list[dict[str, Any]] = Field(default_factory=list, description="最佳推理路径")
    pruned_candidates: dict[str, list[dict[str, Any]]] | None = Field(None, description="被剪枝的候选分支")


class CounterfactualResponse(BaseModel):
    report_id: str
    total_decisions: int
    analyzed_decisions: int
    regretful_decisions: int
    max_regret: float
    avg_regret: float
    insights: list[str]
    duration_ms: float


@router.post("/reasoning/analyze", response_model=CounterfactualResponse)
async def counterfactual_analysis(req: CounterfactualRequest) -> Any:
    from agent.reasoning.counterfactual import CounterfactualEngine, DecisionNode, DecisionImportance

    engine = CounterfactualEngine()
    path = [
        DecisionNode(
            node_id=n.get("node_id", f"n_{i}"),
            thought=n.get("thought", ""),
            score=n.get("score", 0.5),
            depth=n.get("depth", i),
            importance=DecisionImportance(n.get("importance", "medium")),
        )
        for i, n in enumerate(req.best_path)
    ]

    report = await engine.analyze(
        problem=req.problem,
        best_path=path,
        pruned_candidates=req.pruned_candidates,
    )

    return CounterfactualResponse(
        report_id=report.report_id,
        total_decisions=report.total_decisions,
        analyzed_decisions=report.analyzed_decisions,
        regretful_decisions=report.regretful_decisions,
        max_regret=round(report.max_regret, 4),
        avg_regret=round(report.avg_regret, 4),
        insights=report.insights,
        duration_ms=round(report.duration_ms, 1),
    )


class KernelReasonRequest(BaseModel):
    problem: str = Field(..., description="问题")
    force_strategy: str | None = Field(None, description="强制推理策略")
    context: dict[str, Any] | None = Field(None, description="上下文")


class KernelReasonResponse(BaseModel):
    result_id: str
    strategy_used: str
    complexity_level: str
    conclusion: str
    confidence: float
    verified: bool
    steps_count: int
    duration_ms: float


@router.post("/reasoning/kernel", response_model=KernelReasonResponse)
async def kernel_reason(req: KernelReasonRequest) -> Any:
    from agent.reasoning.kernel import ReasoningKernel, ReasoningStrategy

    engine = ReasoningKernel()
    force = ReasoningStrategy(req.force_strategy) if req.force_strategy else None

    result = await engine.reason(
        problem=req.problem,
        context=req.context,
        force_strategy=force,
    )

    return KernelReasonResponse(
        result_id=result.result_id,
        strategy_used=result.strategy_used.value,
        complexity_level=result.complexity.level.value,
        conclusion=result.conclusion[:500],
        confidence=round(result.confidence, 3),
        verified=result.verified,
        steps_count=len(result.steps),
        duration_ms=round(result.duration_ms, 1),
    )


class ConstitutionCheckRequest(BaseModel):
    output: str = Field(..., description="LLM输出文本")
    context: dict[str, Any] | None = Field(None, description="上下文信息")
    available_tools: list[str] | None = Field(None, description="可用工具列表")


class ConstitutionCheckResponse(BaseModel):
    check_id: str
    total_rules: int
    passed_rules: int
    failed_rules: int
    compliance_rate: float
    is_compliant: bool
    violations_count: int
    severity_summary: dict[str, int]


@router.post("/alignment/check", response_model=ConstitutionCheckResponse)
async def constitution_check(req: ConstitutionCheckRequest) -> Any:
    from agent.alignment.constitution_checker import ConstitutionChecker

    checker = ConstitutionChecker()
    result = checker.check(
        output=req.output,
        context=req.context,
        available_tools=set(req.available_tools) if req.available_tools else None,
    )

    return ConstitutionCheckResponse(
        check_id=result.check_id,
        total_rules=result.total_rules,
        passed_rules=result.passed_rules,
        failed_rules=result.failed_rules,
        compliance_rate=round(result.compliance_rate, 3),
        is_compliant=result.is_compliant,
        violations_count=len(result.violations),
        severity_summary=result.severity_summary,
    )


class RedTeamRequest(BaseModel):
    categories: list[str] | None = Field(None, description="限制测试类别")
    max_prompts: int | None = Field(None, description="最大测试数量")


class RedTeamResponse(BaseModel):
    report_id: str
    total_attacks: int
    passed_attacks: int
    failed_attacks: int
    safety_score: float
    category_scores: dict[str, float]
    critical_failures_count: int
    duration_ms: float


@router.post("/alignment/red-team", response_model=RedTeamResponse)
async def red_team_test(req: RedTeamRequest) -> Any:
    from agent.alignment.red_team import RedTeamSuite, AttackCategory

    suite = RedTeamSuite()
    categories = {AttackCategory(c) for c in req.categories} if req.categories else None

    report = await suite.run(categories=categories, max_prompts=req.max_prompts)

    return RedTeamResponse(
        report_id=report.report_id,
        total_attacks=report.total_attacks,
        passed_attacks=report.passed_attacks,
        failed_attacks=report.failed_attacks,
        safety_score=round(report.safety_score, 3),
        category_scores=report.category_scores,
        critical_failures_count=len(report.critical_failures),
        duration_ms=round(report.duration_ms, 1),
    )


class HallucinationDetectRequest(BaseModel):
    output: str = Field(..., description="LLM输出文本")
    tool_results: list[dict[str, Any]] | None = Field(None, description="工具调用结果")
    context: dict[str, Any] | None = Field(None, description="上下文")


class HallucinationDetectResponse(BaseModel):
    detection_id: str
    overall_confidence: float
    overall_level: str
    pattern_signals: int
    consistency_score: float
    fact_check_pass_rate: float
    segments_count: int
    duration_ms: float


@router.post("/verification/hallucination", response_model=HallucinationDetectResponse)
async def hallucination_detect(req: HallucinationDetectRequest) -> Any:
    from agent.verification.hallucination_detector import HallucinationDetector

    detector = HallucinationDetector()
    result = await detector.detect(
        output=req.output,
        tool_results=req.tool_results,
        context=req.context,
    )

    return HallucinationDetectResponse(
        detection_id=result.detection_id,
        overall_confidence=round(result.overall_confidence, 3),
        overall_level=result.overall_level.value,
        pattern_signals=result.pattern_signals,
        consistency_score=round(result.consistency_score, 3),
        fact_check_pass_rate=round(result.fact_check_pass_rate, 3),
        segments_count=len(result.segments),
        duration_ms=round(result.duration_ms, 1),
    )


class BudgetAllocateRequest(BaseModel):
    max_tokens: int = Field(128000, description="总Token预算")
    scene: str = Field("general", description="场景类型")
    memory_hit_rate: float = Field(0.5, description="记忆命中率")
    tool_call_frequency: float = Field(0.3, description="工具调用频率")
    conversation_turns: int = Field(1, description="对话轮次")


class BudgetAllocateResponse(BaseModel):
    total_budget: int
    scene: str
    allocation: dict[str, int]
    warnings: list[str]
    utilization_forecast: float
    decisions_count: int


@router.post("/budget/allocate", response_model=BudgetAllocateResponse)
async def budget_allocate(req: BudgetAllocateRequest) -> Any:
    from agent.context.adaptive_budget import (
        AdaptiveTokenBudgetEngine,
        HistoryStats,
    )

    engine = AdaptiveTokenBudgetEngine(max_tokens=req.max_tokens)
    stats = HistoryStats(
        memory_hit_rate=req.memory_hit_rate,
        tool_call_frequency=req.tool_call_frequency,
        conversation_turns=req.conversation_turns,
    )

    result = engine.allocate(scene=req.scene, history_stats=stats)

    return BudgetAllocateResponse(
        total_budget=result.total_budget,
        scene=result.scene,
        allocation={
            "system_prompt": result.allocation.system_prompt,
            "memory": result.allocation.memory,
            "history": result.allocation.history,
            "dynamic_context": result.allocation.dynamic_context,
            "tool_results": result.allocation.tool_results,
            "reserve": result.allocation.reserve,
        },
        warnings=result.warnings,
        utilization_forecast=round(result.utilization_forecast, 3),
        decisions_count=len(result.decisions),
    )
