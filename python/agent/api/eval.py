"""Agent 评测 API v3 — 融合 Codex + DeepSeek Harness 方法论.

API:
    POST /v1/eval/run       - 运行评测（支持 categories, pass_k, approval_policy, sandbox）
    GET  /v1/eval/status    - 查看最近评测结果（含三维评分）
    GET  /v1/eval/baseline  - 查看基线数据
    GET  /v1/eval/cases     - 列出评测用例
    GET  /v1/eval/plugins   - 查看已注册插件 [DSH]
    GET  /v1/eval/approval  - 查看审批策略 [Codex]
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from agent.core.logger import StructuredLogger

log = StructuredLogger("eval_api")

router = APIRouter(prefix="/v1/eval", tags=["evaluation"])


class EvalRunRequest(BaseModel):
    categories: list[str] = Field(default_factory=list, description="限定评测分类，空=全部")
    concurrency: int = Field(default=3, ge=1, le=10)
    pass_k: int = Field(default=1, ge=1, le=10, description="pass@k 的 k 值，1=单次运行")
    enable_regression: bool = Field(default=True, description="启用回归守护")
    approval_policy: str = Field(default="auto-edit", description="审批策略: suggest/auto-edit/full-auto [Codex]")
    sandbox_policy: str = Field(default="eval", description="沙箱策略: none/eval/tool/strict [Codex]")


class EvalRunResponse(BaseModel):
    status: str = "running"
    total_cases: int = 0
    passed: int = 0
    failed: int = 0
    pass_rate: float = 0.0
    pass_at_k_avg: float = 0.0
    avg_scores: dict[str, float] = Field(default_factory=dict)
    avg_three_axis: dict[str, float] = Field(default_factory=dict)
    category_results: dict[str, dict[str, Any]] = Field(default_factory=dict)
    reinforcement_suggestions: list[dict[str, Any]] = Field(default_factory=list)
    regression_alerts: list[dict[str, Any]] = Field(default_factory=list)
    harness_meta: dict[str, Any] = Field(default_factory=dict)


_last_report: Any = None


@router.post("/run", response_model=EvalRunResponse)
async def run_eval(req: EvalRunRequest) -> EvalRunResponse:
    global _last_report
    from agent.evaluation.agent_eval_system import AgentEvalSystem

    system = AgentEvalSystem(
        concurrency=req.concurrency,
        pass_k=req.pass_k,
        enable_regression=req.enable_regression,
        approval_policy=req.approval_policy,
        sandbox_policy=req.sandbox_policy,
    )
    categories = req.categories if req.categories else None
    report = await system.run_full_eval(categories=categories)
    _last_report = report

    return EvalRunResponse(
        status="completed",
        total_cases=report.total_cases,
        passed=report.passed,
        failed=report.failed,
        pass_rate=round(report.pass_rate, 3),
        pass_at_k_avg=report.pass_at_k_avg,
        avg_scores={
            "accuracy": report.avg_scores.accuracy,
            "safety": report.avg_scores.safety,
            "persona": report.avg_scores.persona,
            "tool_call": report.avg_scores.tool_call,
            "latency": report.avg_scores.latency,
            "overall": report.avg_scores.overall,
        },
        avg_three_axis=report.avg_three_axis,
        category_results=report.category_results,
        reinforcement_suggestions=report.reinforcement_suggestions,
        regression_alerts=[
            {
                "case_id": a.case_id,
                "dimension": a.dimension,
                "baseline": a.baseline_value,
                "current": a.current_value,
                "delta": a.delta,
                "severity": a.severity,
            }
            for a in report.regression_alerts
        ],
        harness_meta=report.harness_meta,
    )


@router.get("/status")
async def eval_status() -> dict[str, Any]:
    if _last_report is None:
        return {"status": "no_eval_run_yet"}
    return {
        "status": "completed",
        "timestamp": _last_report.timestamp,
        "total_cases": _last_report.total_cases,
        "passed": _last_report.passed,
        "failed": _last_report.failed,
        "pass_rate": round(_last_report.pass_rate, 3),
        "pass_at_k_avg": _last_report.pass_at_k_avg,
        "avg_scores": {
            "accuracy": _last_report.avg_scores.accuracy,
            "safety": _last_report.avg_scores.safety,
            "persona": _last_report.avg_scores.persona,
            "tool_call": _last_report.avg_scores.tool_call,
            "latency": _last_report.avg_scores.latency,
            "overall": _last_report.avg_scores.overall,
        },
        "reinforcement_suggestions": _last_report.reinforcement_suggestions,
        "regression_alerts": [
            {
                "case_id": a.case_id,
                "dimension": a.dimension,
                "baseline": a.baseline_value,
                "current": a.current_value,
                "delta": a.delta,
                "severity": a.severity,
            }
            for a in _last_report.regression_alerts
        ],
    }


@router.get("/baseline")
async def eval_baseline() -> dict[str, Any]:
    from agent.evaluation.agent_eval_system import RegressionGuard

    guard = RegressionGuard()
    baseline = guard.load_baseline()
    if baseline is None:
        return {"status": "no_baseline"}
    return {"status": "ok", **baseline}


@router.get("/cases")
async def eval_cases(category: str = "") -> dict[str, Any]:
    from agent.evaluation.golden_eval_set import _BUILTIN_CASES

    cases = _BUILTIN_CASES
    if category:
        cases = [c for c in cases if c.get("category") == category]
    return {
        "total": len(cases),
        "cases": [
            {
                "id": c.get("id"),
                "category": c.get("category"),
                "difficulty": c.get("difficulty"),
                "input": c.get("input", "")[:80],
            }
            for c in cases
        ],
    }


@router.get("/plugins")
async def eval_plugins() -> dict[str, Any]:
    from agent.harness.plugin_registry import PluginRegistry, PluginCategory, PluginSpec

    registry = PluginRegistry()
    registry.register(PluginSpec(
        name="three_axis_scorer", category=PluginCategory.SCORER,
        version="1.0.0", description="DeepSeek Harness 三维评分器",
    ))
    registry.register(PluginSpec(
        name="multi_scorer", category=PluginCategory.SCORER,
        version="1.0.0", description="Codex兼容五维评分器",
    ))
    registry.register(PluginSpec(
        name="assertion_validator", category=PluginCategory.ASSERTION,
        version="1.0.0", description="程序化断言验证器",
    ))
    for n in ["three_axis_scorer", "multi_scorer", "assertion_validator"]:
        registry.activate(n)

    return {
        "status": "ok",
        "plugins": registry.list_plugins(),
        "history": registry.get_change_history(),
    }


@router.get("/approval")
async def eval_approval() -> dict[str, Any]:
    from agent.harness.approval import ApprovalManager, ApprovalPolicy, RiskTier

    mgr = ApprovalManager()
    sample_tools = ["memory_search", "file_write", "shell_exec", "web_fetch"]
    decisions = []
    for tool in sample_tools:
        for policy in [ApprovalPolicy.SUGGEST, ApprovalPolicy.AUTO_EDIT, ApprovalPolicy.FULL_AUTO]:
            d = mgr.check(tool, override_policy=policy)
            decisions.append({
                "tool": d.tool_name,
                "policy": d.policy.value,
                "risk_tier": d.risk_tier.value,
                "approved": d.approved,
                "needs_confirmation": d.needs_confirmation,
                "reason": d.reason,
            })

    return {
        "status": "ok",
        "policies": ["suggest", "auto-edit", "full-auto"],
        "risk_tiers": [t.value for t in RiskTier],
        "sample_decisions": decisions,
    }
