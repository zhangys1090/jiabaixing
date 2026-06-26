from __future__ import annotations

from fastapi import APIRouter, Query

router = APIRouter(tags=["trajectory"])


@router.get("/stats")
async def get_stats():
    from agent.main import engine
    if not engine or not engine.trajectory_db:
        return {"total": 0, "success_rate": 0.0, "avg_duration": 0.0, "avg_score": 0.0}
    stats = engine.trajectory_db.get_execution_stats()
    return {
        "total": stats.total,
        "success_rate": round(stats.success_rate, 4),
        "avg_duration": round(stats.avg_duration, 2),
        "avg_score": round(stats.avg_score, 4),
    }


@router.get("/executions")
async def list_executions(limit: int = Query(default=20, ge=1, le=100)):
    from agent.main import engine
    if not engine or not engine.trajectory_db:
        return []
    executions = engine.trajectory_db.get_recent_executions(limit)
    return [
        {
            "id": e.id,
            "input": e.input[:200],
            "status": e.status,
            "quality_overall": e.quality_overall,
            "loop_rounds": e.loop_rounds,
            "total_tool_calls": e.total_tool_calls,
            "total_duration": e.total_duration,
            "created_at": e.created_at,
        }
        for e in executions
    ]


@router.get("/executions/{exec_id}")
async def get_execution(exec_id: str):
    from agent.main import engine
    if not engine or not engine.trajectory_db:
        return {"error": "trajectory database not available"}
    trace = engine.trajectory_db.get_full_trace(exec_id)
    if trace["execution"] is None:
        return {"error": "execution not found"}
    exec_rec = trace["execution"]
    return {
        "execution": {
            "id": exec_rec.id,
            "input": exec_rec.input,
            "response": exec_rec.response,
            "status": exec_rec.status,
            "quality_overall": exec_rec.quality_overall,
            "loop_rounds": exec_rec.loop_rounds,
            "total_tool_calls": exec_rec.total_tool_calls,
            "total_duration": exec_rec.total_duration,
            "created_at": exec_rec.created_at,
        },
        "tool_invocations": [
            {
                "step_index": inv.step_index,
                "tool_name": inv.tool_name,
                "result_success": inv.result_success,
                "error_message": inv.error_message,
                "duration": inv.duration,
            }
            for inv in trace["tool_invocations"]
        ],
        "state_transitions": [
            {
                "from_state": tr.from_state,
                "to_state": tr.to_state,
                "reason": tr.reason,
            }
            for tr in trace["state_transitions"]
        ],
    }


@router.get("/flywheel/analysis")
async def flywheel_analysis():
    from agent.main import engine
    if not engine or not engine.flywheel:
        return {"error": "flywheel not available"}
    analysis = engine.flywheel.analyze()
    return {
        "total_executions": analysis.total_executions,
        "success_rate": round(analysis.success_rate, 4),
        "avg_duration": round(analysis.avg_duration, 2),
        "avg_tool_calls": round(analysis.avg_tool_calls, 2),
        "avg_quality_score": round(analysis.avg_quality_score, 4),
        "common_failure_patterns": analysis.common_failure_patterns,
        "common_success_patterns": analysis.common_success_patterns,
        "bottlenecks": analysis.bottlenecks[:5],
        "optimization_suggestions": [
            {
                "id": s.id,
                "type": s.type,
                "priority": s.priority,
                "description": s.description,
                "estimated_improvement": s.estimated_improvement,
                "confidence": s.confidence,
            }
            for s in analysis.optimization_suggestions[:5]
        ],
    }


@router.get("/flywheel/trend")
async def flywheel_trend():
    from agent.main import engine
    if not engine or not engine.flywheel:
        return {"trend": "unknown", "data": []}
    return engine.flywheel.get_improvement_trend()


@router.get("/query/tool-success-rates")
async def tool_success_rates():
    from agent.main import engine
    if not engine or not engine.trajectory_db:
        return {}
    from agent.persistence.query import TrajectoryQueryService
    svc = TrajectoryQueryService(engine.trajectory_db)
    rates = svc.get_tool_success_rates()
    return {
        name: {"total": r.total, "success": r.success, "rate": round(r.rate, 4)}
        for name, r in rates.items()
    }


@router.get("/query/daily-trend")
async def daily_trend(days: int = Query(default=7, ge=1, le=30)):
    from agent.main import engine
    if not engine or not engine.trajectory_db:
        return []
    from agent.persistence.query import TrajectoryQueryService
    svc = TrajectoryQueryService(engine.trajectory_db)
    trends = svc.get_recent_trend(days)
    return [
        {
            "date": t.date,
            "avg_score": round(t.avg_score, 4),
            "avg_duration": round(t.avg_duration, 2),
            "count": t.count,
        }
        for t in trends
    ]
