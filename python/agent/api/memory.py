from fastapi import APIRouter
from fastapi.responses import JSONResponse

from agent.models.memory import (
    MemoryItem,
    MemorySearchRequest,
    MemorySearchResponse,
    MemoryStatsResponse,
    MemoryStoreRequest,
    MemoryStoreResponse,
)

router = APIRouter()


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
