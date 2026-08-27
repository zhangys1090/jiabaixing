"""金丝雀发布 + 动态优先级 API 路由。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from agent.core.logger import StructuredLogger

log = StructuredLogger("api.canary")

router = APIRouter(tags=["canary"])


class CreateStrategyRequest(BaseModel):
    name: str = Field(..., max_length=100)
    description: str = Field(default="", max_length=500)
    canary_percentage: float = Field(default=10.0, ge=0.0, le=100.0)
    success_threshold: float = Field(default=0.95, ge=0.0, le=1.0)
    duration_seconds: int = Field(default=300, ge=10, le=86400)


@router.get("/canary/strategies")
async def list_strategies(request: Request):
    engine = request.app.state.engine if hasattr(request.app.state, "engine") else None
    if not engine or not engine.canary_manager:
        return {"strategies": []}
    try:
        strategies = engine.canary_manager.list_strategies()
        return {"strategies": strategies}
    except Exception as e:
        log.error("List strategies failed", error=str(e))
        return {"strategies": [], "error": str(e)}


@router.post("/canary/strategies")
async def create_strategy(req: CreateStrategyRequest, request: Request):
    engine = request.app.state.engine if hasattr(request.app.state, "engine") else None
    if not engine or not engine.canary_manager:
        return {"success": False, "error": "Canary manager not available"}
    try:
        from agent.core.canary_release import CanaryStrategy
        strategy = CanaryStrategy(
            name=req.name,
            description=req.description,
            canary_percentage=req.canary_percentage,
            success_threshold=req.success_threshold,
            duration_seconds=req.duration_seconds,
        )
        await engine.canary_manager.create_strategy(strategy)
        return {"success": True, "name": strategy.name}
    except Exception as e:
        log.error("Create strategy failed", error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/canary/strategies/{name}/promote")
async def promote_strategy(name: str, request: Request):
    engine = request.app.state.engine if hasattr(request.app.state, "engine") else None
    if not engine or not engine.canary_manager:
        return {"success": False, "error": "Canary manager not available"}
    try:
        await engine.canary_manager.promote(name)
        return {"success": True, "name": name, "action": "promote"}
    except Exception as e:
        log.debug("canary 异常处理", error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/canary/strategies/{name}/rollback")
async def rollback_strategy(name: str, request: Request):
    engine = request.app.state.engine if hasattr(request.app.state, "engine") else None
    if not engine or not engine.canary_manager:
        return {"success": False, "error": "Canary manager not available"}
    try:
        await engine.canary_manager.rollback(name)
        return {"success": True, "name": name, "action": "rollback"}
    except Exception as e:
        log.debug("canary 异常处理", error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/canary/strategies/{name}/pause")
async def pause_strategy(name: str, request: Request):
    engine = request.app.state.engine if hasattr(request.app.state, "engine") else None
    if not engine or not engine.canary_manager:
        return {"success": False, "error": "Canary manager not available"}
    try:
        await engine.canary_manager.pause(name)
        return {"success": True, "name": name, "action": "pause"}
    except Exception as e:
        log.debug("canary 异常处理", error=str(e))
        return {"success": False, "error": str(e)}


@router.get("/canary/strategies/{name}/health")
async def strategy_health(name: str, request: Request):
    engine = request.app.state.engine if hasattr(request.app.state, "engine") else None
    if not engine or not engine.canary_manager:
        return {"error": "Canary manager not available"}
    try:
        health = engine.canary_manager.check_health(name)
        return {"name": name, "health": health}
    except Exception as e:
        log.debug("canary 异常处理", error=str(e))
        return {"error": str(e)}


@router.post("/priority/score")
async def score_task(request: Request):
    engine = request.app.state.engine if hasattr(request.app.state, "engine") else None
    if not engine or not engine.priority_scorer:
        return {"error": "Priority scorer not available"}
    try:
        from agent.core.dynamic_priority import TaskInfo
        body = await request.json()
        task = TaskInfo(
            title=body.get("title", ""),
            due_date=body.get("due_date"),
            tags=body.get("tags", []),
            base_priority=body.get("base_priority", 2),
            assignee_count=body.get("assignee_count", 1),
        )
        result = engine.priority_scorer.score(task)
        return {
            "title": result.task_title,
            "total": result.total,
            "urgency": result.urgency,
            "impact": result.impact,
            "wait_time": result.wait_time,
            "base": result.base,
            "priority_level": result.priority_level.name,
        }
    except Exception as e:
        log.error("Score task failed", error=str(e))
        return {"error": str(e)}


@router.post("/priority/rank")
async def rank_tasks(request: Request):
    engine = request.app.state.engine if hasattr(request.app.state, "engine") else None
    if not engine or not engine.priority_scorer:
        return {"error": "Priority scorer not available"}
    try:
        from agent.core.dynamic_priority import TaskInfo
        body = await request.json()
        tasks = []
        for item in body.get("tasks", []):
            tasks.append(TaskInfo(
                title=item.get("title", ""),
                due_date=item.get("due_date"),
                tags=item.get("tags", []),
                base_priority=item.get("base_priority", 2),
                assignee_count=item.get("assignee_count", 1),
            ))
        results = engine.priority_scorer.rank(tasks)
        return {
            "ranked": [
                {
                    "title": r.task_title,
                    "total": r.total,
                    "priority_level": r.priority_level.name,
                }
                for r in results
            ]
        }
    except Exception as e:
        log.error("Rank tasks failed", error=str(e))
        return {"error": str(e)}
