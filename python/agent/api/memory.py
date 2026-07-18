from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any

from agent.models.memory import (
    MemoryItem,
    MemorySearchRequest,
    MemorySearchResponse,
    MemoryStatsResponse,
    MemoryStoreRequest,
    MemoryStoreResponse,
)

router = APIRouter()


class StoreTypedRequest(BaseModel):
    content: str
    scene: str = ""
    emotion: str = "neutral"


class StoreFeedbackRequest(BaseModel):
    trace_id: str | None = None
    tool_name: str | None = None
    feedback_type: str = "success"
    rating: float | None = None
    message: str | None = None
    user_id: str | None = None
    timestamp: float | None = None


class StoreEpisodicRequest(BaseModel):
    content: str
    importance: float | None = None
    tags: list[str] | None = None
    scene: str | None = None


class HybridRetrievalRequest(BaseModel):
    query: str
    scene: str | None = None
    emotion: str | None = None
    top_k: int = 10


class UpdateMemoryRequest(BaseModel):
    memory_id: str
    content: str | None = None
    scene: str | None = None
    emotion: str | None = None
    metadata: dict[str, Any] | None = None


class RetrieveContextRequest(BaseModel):
    query: str
    user_id: str | None = None
    limit: int = 10


class QueryRecentFeedbackRequest(BaseModel):
    hours: int = 24


def get_memory():
    from agent.main import engine
    if engine and engine.memory:
        return engine.memory
    return None


@router.get("/search", response_model=MemorySearchResponse)
async def search_memory(query: str, limit: int = 10, memory_type: str | None = None):
    mem = get_memory()
    if not mem:
        return MemorySearchResponse(results=[], total=0, query=query)
    results = await mem.search(query=query, limit=limit, memory_type=memory_type)
    items = [MemoryItem(**r) for r in results]
    return MemorySearchResponse(results=items, total=len(items), query=query)


@router.post("/store", response_model=MemoryStoreResponse)
async def store_memory(req: MemoryStoreRequest):
    mem = get_memory()
    if not mem:
        return MemoryStoreResponse(id="none", success=False)
    mem_id = await mem.store(
        content=req.content,
        memory_type=req.memory_type,
        scene=req.scene,
        emotion=req.emotion,
        metadata=req.metadata,
    )
    return MemoryStoreResponse(id=mem_id, success=True)


@router.get("/stats", response_model=MemoryStatsResponse)
async def memory_stats():
    mem = get_memory()
    if not mem:
        return MemoryStatsResponse()
    stats = await mem.get_stats()
    return MemoryStatsResponse(**stats)


# ═══════════════════════════════════════════════════════════════
# Memory 桥接路由 — TS MemoryEngine 迁移
# store-short-term / store-long-term / store-instant / store-feedback
# store-episodic / hybrid-retrieval / user-profile / update
# retrieve-context / query-recent-feedback
# ═══════════════════════════════════════════════════════════════


@router.post("/store-short-term")
async def store_short_term(req: StoreTypedRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "id": "", "error": "Engine not initialized"}
    try:
        mem_id = await mem.store_short_term(
            content=req.content, scene=req.scene, emotion=req.emotion
        )
        return {"success": True, "id": mem_id}
    except Exception as e:
        return {"success": False, "id": "", "error": str(e)}


@router.post("/store-long-term")
async def store_long_term(req: StoreTypedRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "id": "", "error": "Engine not initialized"}
    try:
        mem_id = await mem.store_long_term(
            content=req.content, scene=req.scene, emotion=req.emotion
        )
        return {"success": True, "id": mem_id}
    except Exception as e:
        return {"success": False, "id": "", "error": str(e)}


@router.post("/store-instant")
async def store_instant(req: StoreTypedRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "id": "", "error": "Engine not initialized"}
    try:
        mem_id = await mem.store_instant(
            content=req.content, scene=req.scene, emotion=req.emotion
        )
        return {"success": True, "id": mem_id}
    except Exception as e:
        return {"success": False, "id": "", "error": str(e)}


@router.post("/store-feedback")
async def store_feedback(req: StoreFeedbackRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "error": "Engine not initialized"}
    try:
        data = {
            "feedback_type": req.feedback_type,
        }
        if req.trace_id:
            data["trace_id"] = req.trace_id
        if req.tool_name:
            data["tool_name"] = req.tool_name
        if req.rating is not None:
            data["rating"] = req.rating
        if req.message:
            data["message"] = req.message
        if req.user_id:
            data["user_id"] = req.user_id
        if req.timestamp is not None:
            data["timestamp"] = req.timestamp
        import json
        content = json.dumps(data, ensure_ascii=False)
        await mem.store(content=content, memory_type="feedback_signal", scene="user_feedback")
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/store-episodic")
async def store_episodic(req: StoreEpisodicRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "id": "", "error": "Engine not initialized"}
    try:
        options: dict[str, Any] = {}
        if req.importance is not None:
            options["importance"] = req.importance
        if req.tags:
            options["tags"] = req.tags
        if req.scene:
            options["scene"] = req.scene
        if hasattr(mem, "store_episodic"):
            result = await mem.store_episodic(content=req.content, **options)
            ep_id = result if isinstance(result, str) else getattr(result, "id", "episodic")
        else:
            ep_id = await mem.store(
                content=req.content,
                memory_type="episodic",
                scene=req.scene or "episodic",
            )
        return {"success": True, "id": ep_id}
    except Exception as e:
        return {"success": False, "id": "", "error": str(e)}


@router.post("/hybrid-retrieval")
async def hybrid_retrieval(req: HybridRetrievalRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "results": [], "error": "Engine not initialized"}
    try:
        results = await mem.search_with_context(
            query=req.query,
            scene=req.scene,
            limit=req.top_k,
        )
        items = []
        for r in results:
            items.append({
                "id": r.get("id", ""),
                "type": r.get("memory_type", "short_term"),
                "content": r.get("content", ""),
                "timestamp": r.get("timestamp", 0),
                "scene": r.get("scene", ""),
                "emotion": r.get("emotion", "neutral"),
                "relevanceScore": r.get("relevance", 0.0),
                "decayScore": r.get("decay_score", 1.0),
            })
        return {"success": True, "results": items}
    except Exception as e:
        return {"success": False, "results": [], "error": str(e)}


@router.get("/user-profile")
async def user_profile():
    mem = get_memory()
    if not mem:
        return {"success": False, "profile": {}, "error": "Engine not initialized"}
    try:
        profile = mem.get_user_profile()
        if hasattr(profile, "to_dict"):
            return {"success": True, "profile": profile.to_dict()}
        if hasattr(profile, "__dict__"):
            return {"success": True, "profile": profile.__dict__}
        return {"success": True, "profile": profile}
    except Exception as e:
        return {"success": False, "profile": {}, "error": str(e)}


@router.post("/update")
async def update_memory(req: UpdateMemoryRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "error": "Engine not initialized"}
    try:
        await mem.update(
            memory_id=req.memory_id,
            content=req.content,
            scene=req.scene,
            emotion=req.emotion,
            metadata=req.metadata,
        )
        return {"success": True}
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/retrieve-context")
async def retrieve_context(req: RetrieveContextRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "results": [], "error": "Engine not initialized"}
    try:
        results = await mem.search(query=req.query, limit=req.limit, user_id=req.user_id)
        items = []
        for r in results:
            items.append({
                "id": r.get("id", ""),
                "type": r.get("memory_type", "short_term"),
                "content": r.get("content", ""),
                "timestamp": r.get("timestamp", 0),
                "scene": r.get("scene", ""),
                "emotion": r.get("emotion", "neutral"),
                "relevanceScore": r.get("relevance", 0.0),
            })
        return {"success": True, "results": items}
    except Exception as e:
        return {"success": False, "results": [], "error": str(e)}


@router.post("/query-recent-feedback")
async def query_recent_feedback(req: QueryRecentFeedbackRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "results": [], "error": "Engine not initialized"}
    try:
        results = await mem.search(
            query="",
            limit=1000,
            memory_type="feedback_signal",
        )
        import time
        cutoff = time.time() - req.hours * 3600
        filtered = [r for r in results if r.get("timestamp", 0) >= cutoff]
        return {"success": True, "results": filtered}
    except Exception as e:
        return {"success": False, "results": [], "error": str(e)}


# ═══════════════════════════════════════════════════════════════
# Memory 高级特性路由 — 衰减/做梦/知识图谱/加密/traceId
# ═══════════════════════════════════════════════════════════════


class DecayScoreRequest(BaseModel):
    memory_type: str
    timestamp: float
    access_count: int = 0
    importance: float = 5.0


class StoreEncryptedRequest(BaseModel):
    content: str
    memory_type: str = "long_term"
    scene: str = ""
    emotion: str = "neutral"


class StoreWithTraceRequest(BaseModel):
    content: str
    trace_id: str
    memory_type: str = "short_term"
    scene: str = ""
    emotion: str = "neutral"


class SearchByTraceRequest(BaseModel):
    trace_id: str


@router.post("/decay-score")
async def calculate_decay_score(req: DecayScoreRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "error": "Engine not initialized"}
    try:
        score = mem.calculate_decay_score(
            memory_type=req.memory_type,
            timestamp=req.timestamp,
            access_count=req.access_count,
            importance=req.importance,
        )
        return {"success": True, "decay_score": score}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/update-decay-scores")
async def update_decay_scores(batch_size: int = 100):
    mem = get_memory()
    if not mem:
        return {"success": False, "error": "Engine not initialized", "updated": 0}
    try:
        updated = await mem.update_decay_scores(batch_size)
        return {"success": True, "updated": updated}
    except Exception as e:
        return {"success": False, "error": str(e), "updated": 0}


@router.post("/dream")
async def perform_dream():
    mem = get_memory()
    if not mem:
        return {"success": False, "error": "Engine not initialized"}
    try:
        stats = await mem.perform_dream()
        return {"success": True, "stats": stats}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/dream-stats")
async def dream_stats():
    mem = get_memory()
    if not mem:
        return {"success": False, "error": "Engine not initialized"}
    try:
        return {"success": True, "stats": mem.get_dream_stats()}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/knowledge-graph")
async def knowledge_graph(limit: int = 100):
    mem = get_memory()
    if not mem:
        return {"success": False, "nodes": [], "edges": [], "error": "Engine not initialized"}
    try:
        graph = await mem.build_knowledge_graph(limit)
        return {"success": True, "nodes": graph["nodes"], "edges": graph["edges"]}
    except Exception as e:
        return {"success": False, "nodes": [], "edges": [], "error": str(e)}


@router.post("/store-encrypted")
async def store_encrypted(req: StoreEncryptedRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "id": "", "error": "Engine not initialized"}
    try:
        mem_id = await mem.store_encrypted(
            content=req.content,
            memory_type=req.memory_type,
            scene=req.scene,
            emotion=req.emotion,
        )
        return {"success": True, "id": mem_id}
    except Exception as e:
        return {"success": False, "id": "", "error": str(e)}


@router.post("/store-with-trace")
async def store_with_trace(req: StoreWithTraceRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "id": "", "error": "Engine not initialized"}
    try:
        mem_id = await mem.store_with_trace(
            content=req.content,
            trace_id=req.trace_id,
            memory_type=req.memory_type,
            scene=req.scene,
            emotion=req.emotion,
        )
        return {"success": True, "id": mem_id}
    except Exception as e:
        return {"success": False, "id": "", "error": str(e)}


@router.post("/search-by-trace")
async def search_by_trace(req: SearchByTraceRequest):
    mem = get_memory()
    if not mem:
        return {"success": False, "results": [], "error": "Engine not initialized"}
    try:
        results = await mem.search_by_trace(req.trace_id)
        return {"success": True, "results": results}
    except Exception as e:
        return {"success": False, "results": [], "error": str(e)}
