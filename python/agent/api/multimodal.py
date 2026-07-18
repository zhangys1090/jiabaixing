"""多模态记忆 API 路由。

暴露 MemoryEngine 的多模态联合编码能力（store_multimodal / search_multimodal）
为 HTTP 端点，遵循 AGENTS.md 0.2 节"TS 侧允许的职责"中的"HTTP 入口路由"原则：
真正的跨模态向量编码在 Python 端完成，本模块仅做请求转发与结果封装。

端点:
    POST /v1/memory/multimodal/store  — 存储多模态记忆（文本 + 可选图像）
    POST /v1/memory/multimodal/search — 跨模态搜索

环境变量:
    MULTIMODAL_MODEL: 多模态编码模型名（默认 fallback，即降级哈希模式）。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()


class MultimodalStoreRequest(BaseModel):
    """多模态存储请求模型。

    Attributes:
        content: 文本内容（必填）。
        image_path: 可选的图像本地路径，提供时进行联合编码。
        memory_type: 记忆类型，默认 long_term。
        scene: 场景标签，默认 multimodal。
        emotion: 情绪标签，默认 neutral。
        metadata: 额外元数据。
    """

    content: str
    image_path: str | None = None
    memory_type: str = "long_term"
    scene: str = "multimodal"
    emotion: str = "neutral"
    metadata: dict[str, Any] = Field(default_factory=dict)


class MultimodalSearchRequest(BaseModel):
    """多模态搜索请求模型。

    Attributes:
        query: 查询文本（必填）。
        limit: 最大返回数，默认 10。
        memory_type: 可选的记忆类型过滤。
        min_relevance: 最小相关度阈值，默认 0.0。
    """

    query: str
    limit: int = 10
    memory_type: str | None = None
    min_relevance: float = 0.0


class MultimodalStoreResponse(BaseModel):
    """多模态存储响应模型。

    Attributes:
        id: 新建记忆条目的 ID；失败时为空字符串。
        success: 是否存储成功。
        model: 实际使用的编码模型名（含降级标识）。
    """

    id: str
    success: bool = True
    model: str = ""


class MultimodalSearchResponse(BaseModel):
    """多模态搜索响应模型。

    Attributes:
        results: 按相关度降序的记忆列表。
        total: 返回结果数。
        query: 原始查询文本。
    """

    results: list[dict[str, Any]] = Field(default_factory=list)
    total: int = 0
    query: str = ""


def get_memory() -> Any:
    """从全局 engine 获取 MemoryEngine 实例。

    Returns:
        MemoryEngine 实例；engine 未就绪或 memory 未初始化时返回 None。
    """
    from agent.main import engine
    if engine and getattr(engine, "memory", None):
        return engine.memory
    return None


@router.post(
    "/multimodal/store",
    response_model=MultimodalStoreResponse,
    summary="存储多模态记忆",
)
async def store_multimodal(req: MultimodalStoreRequest) -> MultimodalStoreResponse:
    """存储多模态记忆 — 文本与图像联合编码后写入存储。

    Args:
        req: 多模态存储请求。

    Returns:
        MultimodalStoreResponse: 包含新记忆 ID 与编码模型名。

    Raises:
        HTTPException: 当 memory 未初始化或 content 为空时抛出 4xx 错误。
    """
    mem = get_memory()
    if mem is None:
        raise HTTPException(status_code=503, detail="MemoryEngine 未初始化")

    if not req.content:
        raise HTTPException(status_code=400, detail="content 不能为空")

    try:
        mem_id = await mem.store_multimodal(
            content=req.content,
            image_path=req.image_path,
            memory_type=req.memory_type,
            scene=req.scene,
            emotion=req.emotion,
            metadata=req.metadata,
        )
        # 从 metadata 推断实际使用的编码模型名（取 text_model 字段）
        model_name = ""
        try:
            stats = await mem.get_stats()
            model_name = str(stats.get("multimodal_model", ""))
        except Exception:
            pass
        return MultimodalStoreResponse(
            id=mem_id, success=bool(mem_id), model=model_name
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"存储失败: {exc}")


@router.post(
    "/multimodal/search",
    response_model=MultimodalSearchResponse,
    summary="跨模态搜索记忆",
)
async def search_multimodal(req: MultimodalSearchRequest) -> MultimodalSearchResponse:
    """跨模态搜索 — 用文本查询在多模态记忆中检索最相似项。

    Args:
        req: 多模态搜索请求。

    Returns:
        MultimodalSearchResponse: 按相关度降序的记忆列表。

    Raises:
        HTTPException: 当 memory 未初始化或 query 为空时抛出 4xx 错误。
    """
    mem = get_memory()
    if mem is None:
        raise HTTPException(status_code=503, detail="MemoryEngine 未初始化")

    if not req.query:
        raise HTTPException(status_code=400, detail="query 不能为空")

    try:
        results = await mem.search_multimodal(
            query=req.query,
            limit=req.limit,
            memory_type=req.memory_type,
            min_relevance=req.min_relevance,
        )
        # 序列化为 JSON 兼容字典（去除不可序列化的字段）
        safe_results: list[dict[str, Any]] = []
        for r in results:
            safe_results.append({
                k: v for k, v in r.items()
                if isinstance(v, (str, int, float, bool, list, dict, type(None)))
            })
        return MultimodalSearchResponse(
            results=safe_results, total=len(safe_results), query=req.query
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"搜索失败: {exc}")
