from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any

from agent.llm.credential_pool import RotationStrategy
from agent.llm.router import ProviderConfig, ProviderManager

router = APIRouter()


class ProviderCreateRequest(BaseModel):
    name: str
    display_name: str = ""
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    priority: int = 0
    enabled: bool = True
    extra: dict[str, Any] | None = None


class CredentialPoolSetupRequest(BaseModel):
    api_keys: list[str]
    strategy: RotationStrategy = RotationStrategy.FILL_FIRST


class BudgetUpdateRequest(BaseModel):
    daily_budget_usd: float
    per_request_budget_usd: float | None = None


class ProviderResponse(BaseModel):
    name: str
    display_name: str
    base_url: str
    model: str
    enabled: bool
    priority: int
    healthy: bool | None = None


def _get_manager() -> ProviderManager:
    from agent.main import engine
    if engine and hasattr(engine, "llm") and hasattr(engine.llm, "provider_manager"):
        return engine.llm.provider_manager
    return ProviderManager()


@router.get("")
async def list_providers():
    mgr = _get_manager()
    providers = mgr.list_providers()
    return [
        ProviderResponse(
            name=p.name,
            display_name=p.display_name,
            base_url=p.base_url,
            model=p.model,
            enabled=p.enabled,
            priority=p.priority,
            healthy=p.healthy,
        )
        for p in providers
    ]


@router.post("")
async def register_provider(req: ProviderCreateRequest):
    mgr = _get_manager()
    cfg = ProviderConfig(
        name=req.name,
        display_name=req.display_name,
        base_url=req.base_url,
        api_key=req.api_key,
        model=req.model,
        priority=req.priority,
        enabled=req.enabled,
        extra=req.extra,
    )
    mgr.register(cfg)
    return {"success": True, "name": req.name}


@router.delete("/{name}")
async def unregister_provider(name: str):
    mgr = _get_manager()
    removed = mgr.unregister(name)
    return {"success": removed}


@router.post("/{name}/primary")
async def set_primary(name: str):
    mgr = _get_manager()
    ok = mgr.set_primary(name)
    return {"success": ok}


@router.get("/cache/stats")
async def cache_stats():
    from agent.main import engine
    if engine and hasattr(engine, "llm"):
        return engine.llm.get_cache_stats()
    return {"size": 0, "enabled": False}


@router.delete("/cache")
async def clear_cache():
    from agent.main import engine
    if engine and hasattr(engine, "llm"):
        engine.llm.cache.clear()
    return {"success": True}


@router.post("/credentials/pool")
async def setup_credential_pool(req: CredentialPoolSetupRequest):
    from agent.main import engine
    if not engine or not hasattr(engine, "llm"):
        return {"success": False, "detail": "Engine not initialized"}
    engine.llm.setup_credential_pool(req.api_keys, req.strategy)
    return {"success": True, "key_count": len(req.api_keys), "strategy": req.strategy}


@router.get("/credentials/stats")
async def credential_stats():
    from agent.main import engine
    if engine and hasattr(engine, "llm"):
        return engine.llm.get_credential_stats()
    return {"provider": "unknown", "total": 0, "available": 0}


@router.get("/cost/stats")
async def cost_stats():
    from agent.main import engine
    if engine and hasattr(engine, "llm"):
        return engine.llm.get_cost_stats()
    return {"total_cost_usd": 0, "daily_budget_usd": 0}


@router.put("/cost/budget")
async def update_budget(req: BudgetUpdateRequest):
    from agent.main import engine
    if not engine or not hasattr(engine, "llm"):
        return {"success": False, "detail": "Engine not initialized"}
    engine.llm.cost_guard.set_daily_budget(req.daily_budget_usd)
    if req.per_request_budget_usd is not None:
        engine.llm.cost_guard._per_request_budget = req.per_request_budget_usd
    return {"success": True, "daily_budget_usd": req.daily_budget_usd}


@router.get("/cost/alert")
async def cost_alert():
    from agent.main import engine
    if engine and hasattr(engine, "llm"):
        alert = engine.llm.cost_guard.check_budget_alert()
        return {
            "level": alert.level.value,
            "message": alert.message,
            "spent_usd": alert.spent_usd,
            "budget_usd": alert.budget_usd,
            "pct": round(alert.pct, 4),
        }
    return {"level": "normal", "message": "Engine not initialized"}


class CostEstimateRequest(BaseModel):
    model: str
    estimated_input_tokens: int
    estimated_output_tokens: int | None = None


@router.post("/cost/estimate")
async def estimate_cost(req: CostEstimateRequest):
    from agent.main import engine
    if engine and hasattr(engine, "llm"):
        estimate = engine.llm.cost_guard.estimate_request_cost(
            model=req.model,
            estimated_input_tokens=req.estimated_input_tokens,
            estimated_output_tokens=req.estimated_output_tokens,
        )
        return {
            "model": estimate.model,
            "estimated_input_tokens": estimate.estimated_input_tokens,
            "estimated_output_tokens": estimate.estimated_output_tokens,
            "estimated_cost_usd": estimate.estimated_cost_usd,
            "within_budget": estimate.within_budget,
        }
    return {"error": "Engine not initialized"}


@router.get("/cost/models")
async def list_priced_models():
    from agent.llm.credential_pool import CostGuard
    return {"models": CostGuard.list_priced_models()}


@router.get("/cost/model/{model}/pricing")
async def get_model_pricing(model: str):
    from agent.llm.credential_pool import CostGuard
    pricing = CostGuard.get_model_pricing(model)
    if pricing:
        return {"model": model, "input_per_million": pricing["input"] * 1_000_000, "output_per_million": pricing["output"] * 1_000_000}
    return {"model": model, "pricing": "unknown"}


@router.post("/prompt-cache/cleanup")
async def cleanup_prompt_cache():
    from agent.main import engine
    if engine and hasattr(engine, "llm"):
        removed = engine.llm.prompt_cache.cleanup()
        return {"removed": removed}
    return {"removed": 0}


class TransportInfoRequest(BaseModel):
    provider_name: str | None = None


@router.get("/transport/info")
async def transport_info(provider_name: str | None = None):
    from agent.main import engine
    if not engine or not hasattr(engine, "llm"):
        return {"active_transport": None, "available_types": []}

    from agent.llm.transports import TransportType
    available = [t.value for t in TransportType]

    transport = engine.llm._resolve_transport()
    if transport:
        return {
            "active_transport": transport.transport_type.value,
            "available_types": available,
            "model": engine.llm.model,
        }

    return {
        "active_transport": "litellm",
        "available_types": available,
        "model": engine.llm.model,
    }


@router.post("/transport/switch")
async def switch_transport(provider_name: str, transport_type: str):
    from agent.main import engine
    if not engine or not hasattr(engine, "llm"):
        return {"success": False, "detail": "Engine not initialized"}

    from agent.llm.transports import TransportType
    try:
        tt = TransportType(transport_type)
    except ValueError:
        return {"success": False, "detail": f"Unknown transport: {transport_type}"}

    provider = engine.llm.provider_manager._providers.get(provider_name)
    if not provider:
        return {"success": False, "detail": f"Provider '{provider_name}' not found"}

    provider.extra["transport"] = transport_type
    cache_key = f"{provider.name}:{transport_type}"
    if cache_key in engine.llm._transport_cache:
        del engine.llm._transport_cache[cache_key]
    cache_key_auto = f"{provider.name}:auto"
    if cache_key_auto in engine.llm._transport_cache:
        del engine.llm._transport_cache[cache_key_auto]

    return {"success": True, "provider": provider_name, "transport": transport_type}
