"""长任务API端点 — Codex风格长任务提交/查询/取消/恢复。

POST   /long-task/submit     提交长任务
GET    /long-task/{id}       查询任务状态
POST   /long-task/{id}/cancel  取消任务
POST   /long-task/{id}/resume  从checkpoint恢复任务
GET    /long-task/{id}/subtasks 查询子任务列表
GET    /long-task/{id}/checkpoints 查询检查点列表
GET    /long-task/list       列出所有任务
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

router = APIRouter()


def get_engine():
    from agent.main import engine
    return engine


class SubmitRequest(BaseModel):
    task_description: str = Field(..., max_length=5000)
    mode: str = Field("decompose", pattern="^(sequential|decompose|parallel|adaptive)$")
    max_tokens: int = Field(100000, gt=0)
    max_time: float = Field(300.0, gt=0)
    max_iterations: int = Field(30, gt=0)
    sandbox_enabled: bool = True


class ResumeRequest(BaseModel):
    pass


@router.post("/submit")
async def submit_task(req: SubmitRequest):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    from agent.core.long_task import ExecutionMode, TaskBudget
    try:
        mode = ExecutionMode(req.mode)
    except ValueError:
        mode = ExecutionMode.DECOMPOSE

    budget = TaskBudget(
        max_tokens=req.max_tokens,
        max_time=req.max_time,
        max_iterations=req.max_iterations,
    )

    task_id = await engine.long_task.submit(
        task_description=req.task_description,
        mode=mode,
        budget=budget,
        sandbox_enabled=req.sandbox_enabled,
    )
    return {"task_id": task_id, "mode": req.mode, "status": "submitted"}


@router.get("/{task_id}")
async def get_task_status(task_id: str):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    progress = engine.long_task.get_status(task_id)
    if not progress:
        return JSONResponse(status_code=404, content={"error": "Task not found"})

    return {
        "task_id": progress.task_id,
        "phase": progress.phase.value,
        "progress_ratio": round(progress.progress_ratio, 3),
        "total_subtasks": progress.total_subtasks,
        "completed_subtasks": progress.completed_subtasks,
        "failed_subtasks": progress.failed_subtasks,
        "budget": {
            "token_ratio": round(progress.budget.token_ratio, 3),
            "time_ratio": round(progress.budget.time_ratio, 3),
            "iteration_ratio": round(progress.budget.iteration_ratio, 3),
            "overall_ratio": round(progress.budget.overall_ratio, 3),
            "is_exhausted": progress.budget.is_exhausted,
        },
        "elapsed": round(progress.elapsed, 1),
        "error": progress.error,
    }


@router.post("/{task_id}/cancel")
async def cancel_task(task_id: str):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    success = await engine.long_task.cancel(task_id)
    if not success:
        return JSONResponse(status_code=404, content={"error": "Task not found or already completed"})
    return {"task_id": task_id, "status": "cancelled"}


@router.post("/{task_id}/resume")
async def resume_task(task_id: str):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    success = await engine.long_task.resume(task_id)
    if not success:
        return JSONResponse(status_code=400, content={"error": "Task cannot be resumed (not paused/failed or no checkpoint)"})
    return {"task_id": task_id, "status": "resumed"}


@router.get("/{task_id}/subtasks")
async def get_subtasks(task_id: str):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    subtasks = engine.long_task.get_subtasks(task_id)
    return {
        "task_id": task_id,
        "subtasks": [
            {
                "subtask_id": st.subtask_id,
                "name": st.name,
                "status": st.status.value,
                "dependencies": st.dependencies,
                "duration": round(st.duration, 2),
                "tokens_used": st.tokens_used,
                "error": st.error,
            }
            for st in subtasks
        ],
    }


@router.get("/{task_id}/checkpoints")
async def get_checkpoints(task_id: str):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    checkpoints = engine.long_task.get_checkpoints(task_id)
    return {"task_id": task_id, "checkpoints": checkpoints}


@router.get("/list")
async def list_tasks():
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    tasks = engine.long_task.list_tasks()
    return {
        "tasks": [
            {
                "task_id": t.task_id,
                "phase": t.phase.value,
                "progress_ratio": round(t.progress_ratio, 3),
                "total_subtasks": t.total_subtasks,
                "completed_subtasks": t.completed_subtasks,
                "elapsed": round(t.elapsed, 1),
            }
            for t in tasks
        ],
    }


class SetPriorityRequest(BaseModel):
    subtask_name: str
    priority: str = Field("medium", pattern="^(critical|high|medium|low|none)$")


@router.post("/{task_id}/priority")
async def set_subtask_priority(task_id: str, req: SetPriorityRequest):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    success = engine.long_task.set_subtask_priority(
        task_id, req.subtask_name, req.priority,
    )
    if not success:
        return JSONResponse(status_code=404, content={"error": "Subtask not found"})
    return {"task_id": task_id, "subtask_name": req.subtask_name, "priority": req.priority}


@router.get("/{task_id}/persistence")
async def get_persistence_status(task_id: str):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    orch = engine.long_task
    persistence_enabled = orch._persistence is not None
    if not persistence_enabled:
        return {"task_id": task_id, "persistence_enabled": False}

    progress = orch.get_status(task_id)
    if not progress:
        return JSONResponse(status_code=404, content={"error": "Task not found"})

    return {
        "task_id": task_id,
        "persistence_enabled": True,
        "phase": progress.phase.value,
        "can_resume": progress.phase in ("paused", "failed"),
        "checkpoint_count": len(orch.get_checkpoints(task_id)),
    }


@router.post("/cleanup")
async def cleanup_completed_tasks(max_age_hours: float = 168.0):
    engine = get_engine()
    if not engine or not getattr(engine, "long_task", None):
        return JSONResponse(status_code=503, content={"error": "LongTaskOrchestrator not available"})

    orch = engine.long_task
    if not orch._persistence:
        return JSONResponse(status_code=503, content={"error": "Persistence not enabled"})

    deleted = orch._persistence.cleanup_completed(max_age_hours)
    return {"deleted": deleted, "max_age_hours": max_age_hours}
