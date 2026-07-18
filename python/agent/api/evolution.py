from dataclasses import asdict
from fastapi import APIRouter
from typing import Any

from agent.evolution.types import FeedbackSignal
from agent.models.evolution import (
    EvolutionFeedbackRequest,
    EvolutionStatusResponse,
    EvolutionTriggerRequest,
    EvolutionTriggerResponse,
)

router = APIRouter()


def get_evolution():
    from agent.main import engine
    if engine and hasattr(engine, "evolution") and engine.evolution:
        return engine.evolution
    return None


@router.post("/feedback")
async def submit_feedback(req: EvolutionFeedbackRequest):
    evo = get_evolution()
    if not evo:
        return {"accepted": False, "reason": "evolution engine not available"}

    signal = FeedbackSignal(
        interaction_id=req.session_id,
        quality_score=req.quality_score,
        cause=req.cause or "",
        tool_name=req.tool_name,
        error=req.error,
        user_correction=req.user_correction or False,
        timestamp=__import__("time").time(),
    )
    await evo.collect_feedback(signal)
    return {"accepted": True}


@router.get("/status", response_model=EvolutionStatusResponse)
async def evolution_status():
    evo = get_evolution()
    if not evo:
        return EvolutionStatusResponse()

    metrics = evo.get_metrics()
    tool_weights = evo.get_tool_weights()
    recommendations = evo.get_tool_recommendations()

    top_tools = [r for r in recommendations if "tool_name" in r][:5]
    bottom_tools = [r for r in recommendations if "tool_name" in r and r.get("success_rate", 1) < 0.5][:5]

    return EvolutionStatusResponse(
        total_feedback=len(evo._feedback_history),
        total_interactions=metrics.total_interactions,
        avg_success_rate=metrics.average_quality,
        average_quality=metrics.average_quality,
        quality_trend=metrics.quality_trend,
        tool_weights=tool_weights,
        top_performing_tools=top_tools,
        bottom_performing_tools=bottom_tools,
        evolution_cycles=metrics.total_evolutions,
        last_evolution=None,
    )


@router.get("/metrics")
async def get_evolution_metrics():
    """进化引擎指标（Python 主实现，替代已删除的 TS EvolutionEngine.getMetrics）。"""
    evo = get_evolution()
    if not evo:
        return {"available": False, "metrics": {}, "tool_weights": {}}
    return {
        "available": True,
        "metrics": asdict(evo.get_metrics()),
        "tool_weights": evo.get_tool_weights(),
    }


@router.get("/insights")
async def get_evolution_insights():
    """进化引擎洞察（Python 主实现，替代已删除的 TS EvolutionEngine.getInsights）。"""
    evo = get_evolution()
    if not evo:
        return {"available": False, "insights": [], "recommendations": []}
    return {
        "available": True,
        "insights": evo.get_insights(),
        "recommendations": evo.get_tool_recommendations(),
    }


@router.get("/correction-rules")
async def get_correction_rules():
    evo = get_evolution()
    if not evo:
        return {"rules": []}
    return {"rules": evo.get_correction_rules()}


@router.get("/evolution-prompt")
async def get_evolution_prompt():
    evo = get_evolution()
    if not evo:
        return {"prompt_section": ""}
    return {"prompt_section": evo.build_evolution_prompt_section()}


@router.post("/trigger", response_model=EvolutionTriggerResponse)
async def trigger_evolution(req: EvolutionTriggerRequest):
    evo = get_evolution()
    if not evo:
        return EvolutionTriggerResponse(triggered=False, details="evolution engine not available")

    plan = await evo.should_evolve()
    if not plan:
        return EvolutionTriggerResponse(triggered=False, details="no evolution needed")

    result = await evo.execute_evolution(plan)
    return EvolutionTriggerResponse(
        triggered=True,
        details=f"plan={plan.plan_id} success={result.success} actions={result.executed_actions}/{result.total_actions}",
    )


@router.get("/skills/health")
async def skill_health():
    evo = get_evolution()
    if not evo:
        return {"total": 0, "healthy": 0, "at_risk": 0, "declining": 0, "pruned": []}
    return evo.check_skill_health()


@router.get("/skills/trends")
async def skill_quality_trends():
    evo = get_evolution()
    if not evo:
        return {}
    return evo.get_skill_quality_trends()


@router.post("/skills/prune")
async def prune_skills(quality_threshold: float = 0.4, min_uses: int = 3, declining_only: bool = True):
    evo = get_evolution()
    if not evo:
        return {"pruned": [], "reason": "evolution engine not available"}
    pruned = evo.prune_low_quality_skills(
        quality_threshold=quality_threshold,
        min_uses=min_uses,
        declining_only=declining_only,
    )
    return {"pruned": pruned, "count": len(pruned)}


@router.get("/learning-report")
async def get_learning_report(detailed: bool = False):
    """
    获取学习状态报告

    - detailed: 是否返回详细版本的报告
    """
    from agent.evolution.learning_reporter import LearningStatusReporter, UnifiedEvolutionMetrics
    from agent.loop.observer import LoopObserver
    from agent.evolution.implicit_feedback import ImplicitFeedbackCollector

    evo = get_evolution()

    # 收集各数据源
    evolution_metrics = None
    if evo:
        evolution_metrics = evo.get_metrics()

    loop_stats = LoopObserver.get_instance().get_statistics()
    feedback_stats = ImplicitFeedbackCollector.get_instance().get_statistics()

    # 构建统一指标
    metrics = LearningStatusReporter.build_metrics_from_sources(
        evolution_metrics=evolution_metrics,
        loop_stats=loop_stats,
        feedback_stats=feedback_stats,
    )

    # 生成报告
    if detailed:
        report = LearningStatusReporter.generate_report(metrics)
    else:
        report = LearningStatusReporter.generate_summary(metrics)

    return {
        "report": report,
        "detailed": detailed,
        "metrics": {
            "total_interactions": metrics.total_interactions,
            "total_optimizations": metrics.total_optimizations,
            "average_quality": metrics.average_quality_score,
            "quality_trend": metrics.quality_trend,
        },
    }


@router.get("/observer/status")
async def get_observer_status():
    """获取循环观察者状态和统计"""
    from agent.loop.observer import LoopObserver

    observer = LoopObserver.get_instance()
    stats = observer.get_statistics()

    return {
        "enabled": observer.is_enabled(),
        "statistics": {
            "total_loops": stats.total_loops,
            "successful_loops": stats.successful_loops,
            "failed_loops": stats.failed_loops,
            "average_duration_ms": stats.average_duration * 1000,
            "total_tool_calls": stats.total_tool_calls,
            "tool_success_rate": stats.tool_success_rate,
            "average_tool_duration_ms": stats.average_tool_duration * 1000,
            "phase_durations_ms": {
                phase: duration * 1000
                for phase, duration in stats.phase_durations.items()
            },
        },
    }


@router.get("/feedback/implicit")
async def get_implicit_feedback_status():
    """获取隐式反馈收集器状态和统计"""
    from agent.evolution.implicit_feedback import ImplicitFeedbackCollector

    collector = ImplicitFeedbackCollector.get_instance()
    stats = collector.get_statistics()

    return {
        "enabled": collector.is_enabled(),
        "statistics": {
            "total_signals": stats.total_signals,
            "positive_count": stats.positive_count,
            "negative_count": stats.negative_count,
            "neutral_count": stats.neutral_count,
            "by_source": stats.by_source,
            "session_count": stats.session_count,
            "average_confidence": stats.average_confidence,
            "positive_ratio": collector.get_positive_ratio(),
        },
    }
