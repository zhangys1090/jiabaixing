from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any

from agent.llm.credential_pool import RotationStrategy
from agent.llm.router import ProviderConfig, ProviderManager

router = APIRouter()
core_router = APIRouter()

_llm_unavailable: bool = False
_llm_unavailable_reason: str = ""


class ChatRequest(BaseModel):
    message: str
    history: list[dict[str, str]] = []
    system_prompt: str | None = None


class ChatWithToolsRequest(BaseModel):
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] = []
    max_tokens: int = 4096
    tool_choice: str = "auto"


class StreamChatRequest(BaseModel):
    messages: list[dict[str, str]]
    system_prompt: str | None = None
    tools: list[dict[str, Any]] | None = None


class MultimodalChatRequest(BaseModel):
    message: str
    images: list[str] = []
    history: list[dict[str, str]] = []


class MultimodalCodeAnalysisRequest(BaseModel):
    user_query: str
    images: list[str]
    file_path: str | None = None


class CodeAnalyzeRequest(BaseModel):
    file_path: str
    content: str
    user_query: str


class CodeModificationPlanRequest(BaseModel):
    file_path: str
    content: str
    user_query: str


class CodeModifiedContentRequest(BaseModel):
    file_path: str
    current_content: str
    user_request: str
    file_exists: bool = True


class DevGenerateCodeRequest(BaseModel):
    user_request: str
    file_path: str | None = None
    existing_content: str | None = None


class MarkUnavailableRequest(BaseModel):
    reason: str = ""


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


# ═══════════════════════════════════════════════════════════════
# LLM 核心桥接路由 — TS LLMProvider 第一批迁移
# chat / chatWithTools / health / model-name / mark-unavailable / reset
# ═══════════════════════════════════════════════════════════════


def _get_llm():
    from agent.main import engine
    if engine and hasattr(engine, "llm"):
        return engine.llm
    return None


@core_router.post("/chat")
async def llm_chat(req: ChatRequest):
    global _llm_unavailable
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized", "content": ""}
    if _llm_unavailable:
        fallback = llm.provider_manager.get_fallback()
        if fallback:
            try:
                result = await llm.chat(
                    messages=[{"role": "user", "content": req.message}],
                    system_prompt=req.system_prompt,
                    use_cache=False,
                )
                return {"success": True, "content": result.get("content", "")}
            except Exception as e:
                return {"success": False, "error": str(e), "content": ""}
        return {"success": False, "error": _llm_unavailable_reason, "content": ""}
    messages: list[dict[str, str]] = []
    if req.system_prompt:
        messages.append({"role": "system", "content": req.system_prompt})
    for h in req.history:
        messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})
    messages.append({"role": "user", "content": req.message})
    try:
        result = await llm.chat(messages=messages, use_cache=True)
        return {"success": True, "content": result.get("content", "")}
    except Exception as e:
        _llm_unavailable = True
        return {"success": False, "error": str(e), "content": ""}


@core_router.post("/chat-with-tools")
async def llm_chat_with_tools(req: ChatWithToolsRequest):
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized"}
    try:
        if req.tools:
            result = await llm.chat_with_tools(
                messages=req.messages,
                tools=req.tools,
                tool_choice=req.tool_choice,
            )
        else:
            result = await llm.chat(messages=req.messages, use_cache=False)
        return {
            "success": True,
            "content": result.get("content", ""),
            "tool_calls": result.get("tool_calls"),
            "finish_reason": result.get("finish_reason", "stop"),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@core_router.get("/health")
async def llm_health():
    global _llm_unavailable, _llm_unavailable_reason
    llm = _get_llm()
    if not llm:
        return {"available": False, "message": "Engine not initialized"}
    if _llm_unavailable:
        return {"available": False, "message": _llm_unavailable_reason}
    try:
        ok = await llm.check_available()
        if ok:
            return {"available": True, "message": f"LLM available, model: {llm.model}"}
        _llm_unavailable = True
        _llm_unavailable_reason = "Health check failed"
        return {"available": False, "message": "LLM health check failed"}
    except Exception as e:
        _llm_unavailable = True
        _llm_unavailable_reason = str(e)
        return {"available": False, "message": str(e)}


@core_router.get("/model")
async def llm_model_name():
    llm = _get_llm()
    if not llm:
        return {"model": "unknown"}
    return {"model": llm.model}


@core_router.post("/mark-unavailable")
async def llm_mark_unavailable(req: MarkUnavailableRequest):
    global _llm_unavailable, _llm_unavailable_reason
    _llm_unavailable = True
    _llm_unavailable_reason = req.reason
    return {"success": True}


@core_router.post("/reset-availability")
async def llm_reset_availability():
    global _llm_unavailable, _llm_unavailable_reason
    _llm_unavailable = False
    _llm_unavailable_reason = ""
    return {"success": True}


# ═══════════════════════════════════════════════════════════════
# LLM 第二批桥接路由 — stream / multimodal / code
# ═══════════════════════════════════════════════════════════════


@core_router.post("/stream-chat")
async def llm_stream_chat(req: StreamChatRequest):
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized"}

    messages: list[dict[str, str]] = []
    if req.system_prompt:
        messages.append({"role": "system", "content": req.system_prompt})
    messages.extend(req.messages)

    async def _sse_generator():
        try:
            async for chunk in llm.chat_stream(
                messages=messages, tools=req.tools
            ):
                if chunk.get("done"):
                    yield f"data: [DONE]\n\n"
                else:
                    import json as _json
                    yield f"data: {_json.dumps(chunk, ensure_ascii=False)}\n\n"
        except Exception as e:
            import json as _json
            yield f"data: {_json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
            yield f"data: [DONE]\n\n"

    return StreamingResponse(
        _sse_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@core_router.post("/multimodal-chat")
async def llm_multimodal_chat(req: MultimodalChatRequest):
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized", "content": ""}
    messages: list[dict[str, Any]] = []
    for h in req.history:
        messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})
    content_parts: list[dict[str, Any]] = []
    if req.images:
        for img in req.images:
            content_parts.append({"type": "image_url", "image_url": {"url": img}})
    content_parts.append({"type": "text", "text": req.message})
    messages.append({"role": "user", "content": content_parts})
    try:
        result = await llm.chat(messages=messages, use_cache=False)
        return {"success": True, "content": result.get("content", "")}
    except Exception as e:
        return {"success": False, "error": str(e), "content": ""}


@core_router.post("/multimodal-code-analysis")
async def llm_multimodal_code_analysis(req: MultimodalCodeAnalysisRequest):
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized", "content": ""}
    content_parts: list[dict[str, Any]] = []
    for img in req.images:
        content_parts.append({"type": "image_url", "image_url": {"url": img}})
    prompt = f"分析以下代码截图，用户问题: {req.user_query}"
    if req.file_path:
        prompt += f"\n文件路径: {req.file_path}"
    content_parts.append({"type": "text", "text": prompt})
    messages = [{"role": "user", "content": content_parts}]
    try:
        result = await llm.chat(messages=messages, use_cache=False)
        return {"success": True, "content": result.get("content", "")}
    except Exception as e:
        return {"success": False, "error": str(e), "content": ""}


@core_router.post("/code-analyze")
async def llm_code_analyze(req: CodeAnalyzeRequest):
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized", "content": ""}
    system_prompt = "你是一个代码分析专家。请分析给定代码并回答用户的问题。"
    user_msg = f"文件: {req.file_path}\n\n代码内容:\n```\n{req.content}\n```\n\n问题: {req.user_query}"
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_msg},
    ]
    try:
        result = await llm.chat(messages=messages, use_cache=False)
        return {"success": True, "content": result.get("content", "")}
    except Exception as e:
        return {"success": False, "error": str(e), "content": ""}


@core_router.post("/code-modification-plan")
async def llm_code_modification_plan(req: CodeModificationPlanRequest):
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized", "content": ""}
    system_prompt = "你是一个代码修改规划专家。请根据用户需求，给出详细的代码修改计划。"
    user_msg = f"文件: {req.file_path}\n\n当前代码:\n```\n{req.content}\n```\n\n修改需求: {req.user_query}"
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_msg},
    ]
    try:
        result = await llm.chat(messages=messages, use_cache=False)
        return {"success": True, "content": result.get("content", "")}
    except Exception as e:
        return {"success": False, "error": str(e), "content": ""}


@core_router.post("/code-modified-content")
async def llm_code_modified_content(req: CodeModifiedContentRequest):
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized", "content": ""}
    if req.file_exists:
        system_prompt = "你是一个代码修改专家。请根据用户需求修改代码，只输出修改后的完整文件内容，不要包含任何解释。"
    else:
        system_prompt = "你是一个代码生成专家。请根据用户需求生成代码，只输出完整文件内容，不要包含任何解释。"
    user_msg = f"文件: {req.file_path}\n\n当前代码:\n```\n{req.current_content}\n```\n\n需求: {req.user_request}"
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_msg},
    ]
    try:
        result = await llm.chat(messages=messages, use_cache=False)
        return {"success": True, "content": result.get("content", "")}
    except Exception as e:
        return {"success": False, "error": str(e), "content": ""}


@core_router.post("/dev-generate-code")
async def llm_dev_generate_code(req: DevGenerateCodeRequest):
    llm = _get_llm()
    if not llm:
        return {"success": False, "error": "Engine not initialized", "content": ""}
    system_prompt = "你是一个专业的软件开发者。请根据需求直接生成可执行代码，不要包含多余的解释或称呼。"
    user_msg = f"需求: {req.user_request}"
    if req.file_path:
        user_msg += f"\n目标文件: {req.file_path}"
    if req.existing_content:
        user_msg += f"\n\n已有代码:\n```\n{req.existing_content}\n```"
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_msg},
    ]
    try:
        result = await llm.chat(messages=messages, use_cache=False)
        return {"success": True, "content": result.get("content", "")}
    except Exception as e:
        return {"success": False, "error": str(e), "content": ""}
