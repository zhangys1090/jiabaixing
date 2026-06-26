from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any

from agent.scheduler.cron import CronJob, CronJobScheduler, BlueprintCatalog, BlueprintEntry

router = APIRouter()


def _get_scheduler() -> CronJobScheduler:
    return CronJobScheduler.get_instance()


def _get_catalog() -> BlueprintCatalog:
    return BlueprintCatalog.get_instance()


class CreateJobRequest(BaseModel):
    name: str
    schedule: str
    command: str
    args: list[str] = []
    timeout: int = 60_000
    enabled: bool = True


class InstantiateBlueprintRequest(BaseModel):
    blueprint_id: str
    params: dict[str, str] | None = None
    schedule_override: str | None = None
    enabled: bool = True


class RegisterBlueprintRequest(BaseModel):
    id: str
    name: str
    description: str = ""
    category: str = "general"
    schedule: str = "every:1h"
    command: str = ""
    args: list[str] = []
    params: list[dict[str, Any]] = []
    tags: list[str] = []
    author: str = "user"
    version: str = "1.0.0"


@router.get("/jobs")
async def list_jobs():
    scheduler = _get_scheduler()
    return [j.to_dict() for j in scheduler.get_jobs()]


@router.post("/jobs")
async def create_job(req: CreateJobRequest):
    scheduler = _get_scheduler()
    job = CronJob(
        id=f"cron_{int(__import__('time').time())}",
        name=req.name,
        schedule=req.schedule,
        command=req.command,
        args=req.args,
        timeout=req.timeout,
        enabled=req.enabled,
    )
    scheduler.register(job)
    return {"success": True, "job_id": job.id}


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    scheduler = _get_scheduler()
    scheduler.unregister(job_id)
    return {"success": True}


@router.post("/jobs/{job_id}/toggle")
async def toggle_job(job_id: str):
    scheduler = _get_scheduler()
    job = scheduler.get_job(job_id)
    if not job:
        return {"success": False, "error": "Job not found"}
    job.enabled = not job.enabled
    return {"success": True, "enabled": job.enabled}


@router.get("/blueprints")
async def list_blueprints(category: str | None = None):
    catalog = _get_catalog()
    entries = catalog.list_entries(category=category)
    return [e.to_dict() for e in entries]


@router.get("/blueprints/{blueprint_id}")
async def get_blueprint(blueprint_id: str):
    catalog = _get_catalog()
    entry = catalog.get(blueprint_id)
    if not entry:
        return {"error": "Blueprint not found"}
    return entry.to_dict()


@router.post("/blueprints")
async def register_blueprint(req: RegisterBlueprintRequest):
    catalog = _get_catalog()
    from agent.scheduler.cron import BlueprintParam
    params = [
        BlueprintParam(
            name=p.get("name", ""),
            type=p.get("type", "string"),
            required=p.get("required", True),
            default=p.get("default", ""),
            description=p.get("description", ""),
        )
        for p in req.params
    ]
    entry = BlueprintEntry(
        id=req.id,
        name=req.name,
        description=req.description,
        category=req.category,
        schedule=req.schedule,
        command=req.command,
        args=req.args,
        params=params,
        tags=req.tags,
        author=req.author,
        version=req.version,
    )
    catalog.register(entry)
    return {"success": True, "blueprint_id": req.id}


@router.delete("/blueprints/{blueprint_id}")
async def delete_blueprint(blueprint_id: str):
    catalog = _get_catalog()
    removed = catalog.unregister(blueprint_id)
    return {"success": removed}


@router.post("/blueprints/instantiate")
async def instantiate_blueprint(req: InstantiateBlueprintRequest):
    catalog = _get_catalog()
    scheduler = _get_scheduler()
    job = catalog.instantiate(
        blueprint_id=req.blueprint_id,
        param_values=req.params,
        schedule_override=req.schedule_override,
    )
    if not job:
        return {"success": False, "error": "Blueprint not found"}
    job.enabled = req.enabled
    scheduler.register(job)
    return {"success": True, "job_id": job.id, "command": job.command}


@router.get("/blueprints/search/{query}")
async def search_blueprints(query: str):
    catalog = _get_catalog()
    results = catalog.search(query)
    return [e.to_dict() for e in results]
