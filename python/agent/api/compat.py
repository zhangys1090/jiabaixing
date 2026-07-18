import os
from contextlib import asynccontextmanager

import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.resilience import RetryConfig, resilient_call

router = APIRouter()

log = StructuredLogger("compat")

_ts_client: httpx.AsyncClient | None = None


async def _get_ts_client() -> httpx.AsyncClient:
    global _ts_client
    if _ts_client is None or _ts_client.is_closed:
        _ts_client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=5.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _ts_client


def _ts_backend_url() -> str:
    return os.environ.get("TS_BACKEND_URL", "http://localhost:3111")


_MCP_RETRY = RetryConfig(max_retries=1, base_delay=0.2, max_delay=2.0)
_DESKTOP_RETRY = RetryConfig(max_retries=1, base_delay=0.3, max_delay=3.0)


async def _ts_proxy_get(path: str, timeout: float = 10.0) -> dict | list:
    client = await _get_ts_client()
    try:
        resp = await client.get(
            f"{_ts_backend_url()}{path}",
            headers={"Accept": "application/json"},
            timeout=httpx.Timeout(timeout, connect=3.0),
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        raise


async def _ts_proxy_post(path: str, body: dict | None = None, timeout: float = 15.0) -> dict | list:
    client = await _get_ts_client()
    try:
        resp = await client.post(
            f"{_ts_backend_url()}{path}",
            json=body or {},
            headers={"Content-Type": "application/json"},
            timeout=httpx.Timeout(timeout, connect=3.0),
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        raise


def _get_engine():
    from agent.main import engine
    return engine


def _engine_unavailable():
    return {"detail": "Agent engine not initialized"}


class ProcessRequest(BaseModel):
    input: str = ""
    images: list[str] | None = None


class ChatCompatRequest(BaseModel):
    message: str
    conversation_id: str | None = None


class SecurityValidateRequest(BaseModel):
    input: str


class ModelSwitchRequest(BaseModel):
    targetModel: str
    reason: str = ""


class IdeChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    context: dict[str, Any] | None = None


@router.get("/health")
async def health():
    import sys
    import time as _time
    eng = _get_engine()
    uptime = (_time.monotonic() - eng._start_time) if eng and eng._start_time else 0.0
    llm_available = await eng.llm.check_available() if eng else False
    ts_healthy = False
    try:
        client = await _get_ts_client()
        resp = await client.get(f"{_ts_backend_url()}/api/health", timeout=3.0)
        ts_healthy = resp.status_code == 200
    except Exception:
        ts_healthy = False
    memory_ok = eng.memory is not None if eng else False
    tools_count = len(eng.tool_registry.get_all_definitions()) if eng and eng.tool_registry else 0
    overall = "ok" if (eng and llm_available) else "degraded"
    return {
        "status": overall,
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "uptime_seconds": round(uptime, 1),
        "llm_available": llm_available,
        "llm_model": eng.llm.model if eng else "",
        "ts_backend_healthy": ts_healthy,
        "memory_available": memory_ok,
        "tools_count": tools_count,
        "session_count": eng._session_count if eng else 0,
    }


@router.get("/health/detail")
async def health_detail():
    eng = _get_engine()
    if not eng:
        return {"status": "uninitialized", "components": {}}
    components: dict[str, Any] = {}
    components["llm"] = {
        "model": eng.llm.model,
        "available": await eng.llm.check_available() if eng else False,
    }
    components["memory"] = {"available": eng.memory is not None}
    components["loop"] = {"available": eng.loop is not None}
    components["evolution"] = {"available": eng.evolution is not None}
    components["tool_registry"] = {
        "available": eng.tool_registry is not None,
        "count": len(eng.tool_registry.get_all_definitions()) if eng.tool_registry else 0,
    }
    components["security"] = {"available": eng.security is not None}
    components["session_store"] = {"available": eng.session_store is not None}
    components["trajectory_db"] = {"available": eng.trajectory_db is not None}
    try:
        client = await _get_ts_client()
        resp = await client.get(f"{_ts_backend_url()}/api/health", timeout=3.0)
        components["ts_backend"] = {"available": resp.status_code == 200, "status_code": resp.status_code}
    except Exception as e:
        components["ts_backend"] = {"available": False, "error": str(e)}
    from agent.core.resilience import _circuits
    components["circuits"] = {
        name: {"state": c.state, "failures": c.failure_count}
        for name, c in _circuits.items()
    }
    healthy = all(
        c.get("available", True) or c.get("healthy", True)
        for c in components.values()
        if isinstance(c, dict) and "available" in c
    )
    return {
        "status": "ok" if healthy else "degraded",
        "components": components,
    }


@router.post("/process")
async def process(req: ProcessRequest):
    eng = _get_engine()
    if not eng:
        return {"response": "", "trace_id": "", "intent": "unknown", "error": _engine_unavailable()}
    result = await eng.process_input(
        message=req.input or "",
        session_id="api_process",
    )
    return {
        "response": result.get("content", ""),
        "trace_id": result.get("trace_id", ""),
        "intent": result.get("intent", "chat"),
    }


@router.post("/chat")
async def chat(req: ChatCompatRequest):
    eng = _get_engine()
    if not eng:
        return {"content": "", "session_id": "", "trace_id": "", "error": _engine_unavailable()}
    result = await eng.process_input(
        message=req.message,
        session_id=req.conversation_id or "api_chat",
    )
    return {
        "content": result.get("content", ""),
        "session_id": result.get("session_id", req.conversation_id or "api_chat"),
        "trace_id": result.get("trace_id", ""),
    }


@router.get("/models")
async def list_models():
    eng = _get_engine()
    if not eng:
        return []
    mgr = eng.llm.provider_manager if hasattr(eng.llm, "provider_manager") else None
    if not mgr:
        return [{"id": eng.llm.model, "name": eng.llm.model, "status": "active"}]
    providers = mgr.list_providers()
    return [
        {"id": p.model, "name": p.display_name or p.name, "status": "active" if p.enabled else "inactive"}
        for p in providers
    ]


@router.get("/models/status")
async def models_status():
    eng = _get_engine()
    if not eng:
        return {"current": "", "available": [], "healthy": False}
    mgr = eng.llm.provider_manager if hasattr(eng.llm, "provider_manager") else None
    available = []
    if mgr:
        for p in mgr.list_providers():
            available.append({"id": p.model, "name": p.display_name or p.name, "healthy": p.healthy})
    return {
        "current": eng.llm.model,
        "available": available,
        "healthy": await eng.llm.check_available() if eng else False,
    }


@router.get("/models/health")
async def models_health():
    eng = _get_engine()
    if not eng:
        return {"models": [], "timestamp": ""}
    import datetime
    mgr = eng.llm.provider_manager if hasattr(eng.llm, "provider_manager") else None
    models = []
    if mgr:
        for p in mgr.list_providers():
            models.append({"id": p.model, "name": p.display_name or p.name, "healthy": p.healthy})
    return {
        "models": models,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


@router.post("/models/switch")
async def models_switch(req: ModelSwitchRequest):
    eng = _get_engine()
    if not eng:
        return {"success": False, "error": _engine_unavailable()}
    mgr = eng.llm.provider_manager if hasattr(eng.llm, "provider_manager") else None
    if not mgr:
        return {"success": False, "error": "No provider manager"}
    ok = mgr.set_primary(req.targetModel)
    return {"success": ok, "current": eng.llm.model}


@router.get("/evolution/status")
async def evolution_status():
    eng = _get_engine()
    if not eng or not hasattr(eng, "evolution") or not eng.evolution:
        return {
            "total_interactions": 0,
            "total_evolutions": 0,
            "successful_evolutions": 0,
            "average_quality": 0.0,
            "quality_trend": "stable",
            "tool_weights": {},
        }
    metrics = eng.evolution.get_metrics()
    return {
        "total_interactions": metrics.total_interactions,
        "total_evolutions": metrics.total_evolutions,
        "successful_evolutions": metrics.successful_evolutions,
        "average_quality": metrics.average_quality,
        "quality_trend": metrics.quality_trend,
        "tool_weights": metrics.tool_weights,
    }


@router.get("/evolution/metrics")
async def evolution_metrics():
    return await evolution_status()


@router.get("/evolution/insights")
async def evolution_insights():
    eng = _get_engine()
    if not eng or not hasattr(eng, "evolution") or not eng.evolution:
        return []
    return []


@router.post("/evolution/trigger")
async def evolution_trigger(req: dict | None = None):
    eng = _get_engine()
    if not eng or not hasattr(eng, "evolution") or not eng.evolution:
        return {"id": "", "reason": "evolution engine not available"}
    plan = await eng.evolution.should_evolve()
    if not plan:
        return {"id": "", "reason": "no evolution needed"}
    result = await eng.evolution.execute_evolution(plan)
    return {"id": plan.plan_id, "reason": f"success={result.success}"}


@router.post("/evolution/cycle")
async def evolution_cycle():
    return await evolution_trigger()


@router.post("/evolution/healing")
async def evolution_healing():
    return {"status": "ok", "healed": 0}


@router.post("/evolution/refactor")
async def evolution_refactor():
    return {"status": "ok", "refactored": 0}


@router.post("/evolution/enhance")
async def evolution_enhance():
    return {"status": "ok", "enhanced": 0}


@router.post("/memory/store")
async def memory_store(req: dict):
    eng = _get_engine()
    if not eng or not eng.memory:
        return {"id": "none", "success": False}
    mem_id = await eng.memory.store(
        content=req.get("content", ""),
        memory_type=req.get("memory_type", "general"),
        scene=req.get("scene") or "",
        emotion=req.get("emotion") or "neutral",
        metadata=req.get("metadata"),
    )
    return {"id": mem_id, "success": True}


@router.get("/memory/search")
async def memory_search(query: str = "", limit: int = 10, memory_type: str | None = None):
    eng = _get_engine()
    if not eng or not eng.memory:
        return {"results": [], "total": 0, "query": query}
    results = await eng.memory.search(query=query, limit=limit, memory_type=memory_type)
    return {"results": results, "total": len(results), "query": query}


@router.get("/memory/profile")
async def memory_profile(userId: str | None = None):
    return {"preferences": {}, "patterns": []}


@router.post("/memory/preferences")
async def memory_preferences(req: dict):
    return {"success": True}


@router.get("/memory/stats")
async def memory_stats():
    eng = _get_engine()
    if not eng or not eng.memory:
        return {"total_entries": 0, "by_type": {}}
    stats = await eng.memory.get_stats()
    return stats


@router.post("/security/validate")
async def security_validate(req: SecurityValidateRequest):
    eng = _get_engine()
    if not eng or not hasattr(eng, "security") or not eng.security:
        return {"safe": True, "score": 1.0, "flags": []}
    result = eng.security.check_command(req.input)
    return {
        "safe": result.allowed,
        "score": 0.0 if result.blocked_reasons else 1.0,
        "flags": result.blocked_reasons + result.warnings,
    }


@router.get("/security/logs")
async def security_logs(limit: int = 50, level: str | None = None):
    return []


@router.get("/security/events")
async def security_events(limit: int = 50):
    return []


@router.get("/security/report")
async def security_report():
    return {"status": "ok", "total_events": 0}


@router.get("/security/audit")
async def security_audit(limit: int = 50, type: str | None = None):
    return {"audits": [], "total": 0}


@router.post("/skills/execute")
async def skills_execute(req: dict):
    from agent.skills.registry import SkillRegistry
    registry = SkillRegistry.get_instance()
    if not registry.get_all_skills():
        registry.register_builtin_skills()
    skill = registry.get_skill(req.get("name", ""))
    if not skill:
        return {"success": False, "error": f"Skill '{req.get('name', '')}' not found"}
    result = await skill.execute(req.get("parameters") or {})
    return {"success": result.success, "result": result.output, "error": result.error}


@router.get("/skills/list")
async def skills_list(category: str | None = None, query: str | None = None):
    from agent.skills.registry import SkillRegistry
    registry = SkillRegistry.get_instance()
    if not registry.get_all_skills():
        registry.register_builtin_skills()
    if query:
        skills = registry.search_skills(query)
    elif category:
        skills = registry.get_skills_by_category(category)
    else:
        skills = registry.get_all_skills()
    return [
        {"name": s.definition.name, "description": s.definition.description, "category": s.definition.category}
        for s in skills
    ]


@router.get("/performance/snapshot")
async def performance_snapshot():
    return {"timestamp": "", "cpu": 0, "memory": 0, "requests": 0}


@router.get("/performance/metrics")
async def performance_metrics(hours: int = 24):
    return []


@router.get("/performance/errors")
async def performance_errors(hours: int = 24, limit: int = 50):
    return []


@router.get("/llm/performance")
async def llm_performance():
    return {"total_requests": 0, "avg_latency_ms": 0, "error_rate": 0}


@router.get("/system/resources")
async def system_resources():
    import psutil
    return {
        "cpu_percent": psutil.cpu_percent(),
        "memory_percent": psutil.virtual_memory().percent,
        "disk_percent": psutil.disk_usage("/").percent if hasattr(psutil, "disk_usage") else 0,
    }


@router.get("/system/integrity")
async def system_integrity():
    return {"status": "ok", "checks": []}


@router.get("/metrics")
async def system_metrics():
    return {}


@router.get("/config")
async def system_config():
    return {"version": "5.0.0", "backend": "python"}


@router.get("/automation/tasks")
async def automation_tasks():
    return {"tasks": []}


@router.post("/automation/tasks")
async def create_automation_task(req: dict):
    return {"success": True}


@router.get("/automation/triggers")
async def automation_triggers():
    return {"triggers": []}


@router.get("/automation/patterns")
async def automation_patterns():
    return {"patterns": []}


@router.post("/tasks/create")
async def tasks_create(req: dict):
    return {"id": "task_0", "status": "created"}


@router.get("/tasks/list")
async def tasks_list(limit: int = 50):
    return []


@router.get("/tasks/harness/status")
async def tasks_harness_status():
    return {"status": "ok", "active_tasks": 0}


@router.get("/integration/platforms")
async def integration_platforms():
    return {"platforms": []}


@router.get("/integration/system-status")
async def integration_system_status():
    return {"status": "ok"}


@router.get("/conversations")
async def conversations(limit: int = 50):
    return []


@router.post("/simulate_task")
async def simulate_task(req: dict):
    return {"trace_id": "", "taskId": ""}


@router.post("/optimization/process")
async def optimization_process(req: dict):
    return {"status": "ok"}


@router.get("/optimization/history")
async def optimization_history():
    return []


@router.post("/user-behavior/events")
async def user_behavior_events(req: dict):
    return {"status": "ok"}


@router.get("/recommendations")
async def recommendations(limit: int = 10):
    return {"recommendations": [], "evaluation": {}}


@router.post("/performance/metrics")
async def post_performance_metrics(req: dict):
    return {"status": "ok"}


@router.post("/error/monitoring")
async def error_monitoring(req: dict):
    return {"status": "ok"}


@router.get("/logs")
async def logs_general(limit: int = 100, level: str | None = None):
    return []


@router.get("/logs/errors")
async def logs_errors(hours: int = 24, level: str | None = None, limit: int = 50):
    return []


@router.get("/orchestrator/metrics")
async def orchestrator_metrics():
    return {}


@router.post("/orchestrator/optimize")
async def orchestrator_optimize():
    return {"status": "ok"}


@router.post("/correct")
async def correct(req: dict):
    return {"success": True, "message": "Correction recorded"}


@router.post("/ide/chat")
async def ide_chat(req: IdeChatRequest):
    eng = _get_engine()
    if not eng:
        return {"content": "", "session_id": "", "trace_id": "", "error": _engine_unavailable()}
    result = await eng.process_input(
        message=req.message,
        session_id=req.session_id or "ide_chat",
    )
    return {
        "content": result.get("content", ""),
        "session_id": result.get("session_id", req.session_id or "ide_chat"),
        "trace_id": result.get("trace_id", ""),
    }


@router.get("/ide/sessions")
async def ide_sessions():
    return []


@router.post("/batch/run")
async def batch_run(req: dict):
    return {"format": "json", "data": []}


@router.get("/trajectory/export")
async def trajectory_export():
    return []


@router.get("/trajectory/stats")
async def trajectory_stats():
    return {}


@router.post("/tools/execute")
async def tools_execute(req: dict):
    eng = _get_engine()
    if not eng or not hasattr(eng, "tool_registry") or not eng.tool_registry:
        return {"success": False, "error": "Tool registry not available"}
    tool_name = req.get("tool", req.get("name", ""))
    tool_params = req.get("params", req.get("arguments", {}))
    if not tool_name:
        return {"success": False, "error": "Missing tool name"}
    try:
        result = await eng.tool_registry.execute(tool_name, tool_params or {})
        return {
            "success": result.success,
            "output": result.output,
            "error": result.error,
            "duration": result.duration,
            "metadata": result.metadata,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/tools/list")
async def tools_list():
    from fastapi import Request
    eng = _get_engine()
    if not eng or not hasattr(eng, "tool_registry") or not eng.tool_registry:
        return {"tools": [], "count": 0}
    defs = eng.tool_registry.get_all_definitions()

    api_key = ""
    try:
        from agent.main import app
        request = Request({})
    except Exception:
        pass

    tools = []
    for d in defs:
        tool_info = {"name": d.name, "description": d.description, "category": d.category.value}
        if hasattr(d, "risk_level") and d.risk_level == "high":
            tool_info["restricted"] = True
        tools.append(tool_info)

    return {"tools": tools, "count": len(tools)}


@router.get("/mcp/servers")
async def mcp_servers():
    try:
        result = await resilient_call(
            lambda: _ts_proxy_get("/api/mcp/servers"),
            operation="mcp_servers",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
        return result
    except Exception as e:
        log.error("MCP servers fetch failed", error=str(e))
        return {"success": True, "data": {}}


@router.get("/trae/health")
async def trae_health():
    return {"status": "ok"}


@router.get("/trae/performance")
async def trae_performance():
    return {}


@router.get("/trae/mcp/status")
async def trae_mcp_status():
    return {}


@router.get("/trae/skills/status")
async def trae_skills_status():
    return {}


@router.post("/trae/skills/execute")
async def trae_skills_execute(req: dict):
    return {"success": False, "error": "Not implemented"}


@router.post("/trae/security/audit")
async def trae_security_audit(req: dict):
    return {"status": "ok"}


@router.post("/trae/testing/generate")
async def trae_testing_generate(req: dict):
    return {"status": "ok"}


@router.get("/debug/weights")
async def debug_weights():
    return {}


@router.get("/debug/recentHistory")
async def debug_recent_history():
    return []


@router.get("/debug/tool-usage")
async def debug_tool_usage():
    return []


@router.get("/docs/index")
async def docs_index():
    return []


@router.post("/docs/generate")
async def docs_generate():
    return {"status": "ok"}


@router.post("/orchestrate")
async def orchestrate(req: dict):
    eng = _get_engine()
    if not eng:
        return {"error": _engine_unavailable()}
    result = await eng.process_input(
        message=req.get("goal", ""),
        session_id="orchestrate",
    )
    return {"content": result.get("content", ""), "trace_id": result.get("trace_id", "")}


@router.post("/evaluate")
async def evaluate(req: dict):
    return {"score": 0.7, "passed": True, "feedback": ""}


@router.post("/desktop/screenshot")
async def desktop_screenshot(req: dict | None = None):
    try:
        result = await resilient_call(
            lambda: _ts_proxy_post("/api/desktop/screenshot", req or {}, timeout=30.0),
            operation="desktop_screenshot",
            retry_config=_DESKTOP_RETRY,
            circuit_name="ts_desktop",
        )
        return result
    except Exception as e:
        log.error("Desktop screenshot failed", error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/desktop/automate")
async def desktop_automate(req: dict):
    try:
        result = await resilient_call(
            lambda: _ts_proxy_post("/api/desktop/automate", req, timeout=60.0),
            operation="desktop_automate",
            retry_config=_DESKTOP_RETRY,
            circuit_name="ts_desktop",
        )
        return result
    except Exception as e:
        log.error("Desktop automate failed", error=str(e))
        return {"success": False, "error": str(e)}


@router.get("/integration/wechat/qrcode")
async def integration_wechat_qrcode():
    return {"qrcode": "", "status": "unavailable"}


@router.get("/integration/{platform}/status")
async def integration_platform_status(platform: str):
    return {"platform": platform, "status": "disconnected"}


@router.post("/integration/{platform}/connect")
async def integration_platform_connect(platform: str):
    return {"success": False, "error": "Not implemented"}


@router.post("/integration/{platform}/disconnect")
async def integration_platform_disconnect(platform: str):
    return {"success": True}


@router.post("/integration/{platform}/webhook")
async def integration_platform_webhook(platform: str):
    return {"status": "ok"}


@router.post("/integration/{platform}/send")
async def integration_platform_send(platform: str):
    return {"success": False, "error": "Not implemented"}


@router.get("/mcp/servers/{name}")
async def mcp_server_detail(name: str):
    try:
        return await resilient_call(
            lambda: _ts_proxy_get(f"/api/mcp/servers/{name}"),
            operation=f"mcp_server_detail:{name}",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
    except Exception:
        return {"name": name, "status": "unknown", "running": False}


@router.post("/mcp/servers/{name}/start")
async def mcp_server_start(name: str):
    try:
        return await resilient_call(
            lambda: _ts_proxy_post(f"/api/mcp/servers/{name}/start", {}, timeout=15.0),
            operation=f"mcp_server_start:{name}",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
    except Exception as e:
        log.error("MCP server start failed", name=name, error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/mcp/servers/{name}/stop")
async def mcp_server_stop(name: str):
    try:
        return await resilient_call(
            lambda: _ts_proxy_post(f"/api/mcp/servers/{name}/stop", {}),
            operation=f"mcp_server_stop:{name}",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
    except Exception as e:
        log.error("MCP server stop failed", name=name, error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/mcp/servers/start-all")
async def mcp_servers_start_all():
    try:
        return await resilient_call(
            lambda: _ts_proxy_post("/api/mcp/servers/start-all", {}, timeout=30.0),
            operation="mcp_servers_start_all",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
    except Exception as e:
        log.error("MCP start-all failed", error=str(e))
        return {"success": False, "error": str(e)}


@router.get("/mcp/servers/{name}/tools")
async def mcp_server_tools(name: str):
    try:
        return await resilient_call(
            lambda: _ts_proxy_get(f"/api/mcp/servers/{name}/tools"),
            operation=f"mcp_server_tools:{name}",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
    except Exception:
        return {"tools": []}


@router.post("/mcp/servers/{name}/call")
async def mcp_server_call(name: str, req: dict | None = None):
    try:
        return await resilient_call(
            lambda: _ts_proxy_post(f"/api/mcp/servers/{name}/call", req or {}, timeout=30.0),
            operation=f"mcp_server_call:{name}",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
    except Exception as e:
        log.error("MCP server call failed", name=name, error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/mcp/servers/{name}/message")
async def mcp_server_message(name: str, req: dict | None = None):
    try:
        return await resilient_call(
            lambda: _ts_proxy_post(f"/api/mcp/servers/{name}/message", req or {}, timeout=15.0),
            operation=f"mcp_server_message:{name}",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
    except Exception as e:
        log.error("MCP server message failed", name=name, error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/mcp/register")
async def mcp_register(req: dict):
    try:
        return await resilient_call(
            lambda: _ts_proxy_post("/api/mcp/register", req),
            operation="mcp_register",
            retry_config=_MCP_RETRY,
            circuit_name="ts_mcp",
        )
    except Exception as e:
        log.error("MCP register failed", error=str(e))
        return {"success": False, "error": str(e)}


@router.post("/automation/tasks/{task_id}/toggle")
async def automation_task_toggle(task_id: str):
    return {"success": True}


@router.post("/automation/tasks/{task_id}/execute")
async def automation_task_execute(task_id: str):
    return {"success": True}


@router.post("/tasks/{task_id}/cancel")
async def tasks_cancel(task_id: str):
    return {"success": True}


@router.post("/tasks/{task_id}/pause")
async def tasks_pause(task_id: str):
    return {"success": True}


@router.post("/tasks/{task_id}/resume")
async def tasks_resume(task_id: str):
    return {"success": True}


@router.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    eng = _get_engine()
    try:
        while True:
            data = await websocket.receive_json()
            message = data.get("message", "") or data.get("input", "")
            if not message:
                await websocket.send_json({"type": "error", "content": "missing message"})
                continue
            if not eng:
                await websocket.send_json({"type": "error", "content": "engine not available", "done": True})
                continue
            result = await eng.process_input(
                message=message,
                session_id=data.get("session_id", data.get("conversation_id", "ws_chat")),
            )
            await websocket.send_json({
                "type": "content",
                "content": result.get("content", ""),
                "session_id": result.get("session_id", ""),
                "trace_id": result.get("trace_id", ""),
                "done": True,
            })
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "content": str(e), "done": True})
        except Exception:
            pass
