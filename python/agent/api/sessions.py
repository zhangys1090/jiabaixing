from fastapi import APIRouter
from pydantic import BaseModel

from agent.persistence.session_store import SessionStore

router = APIRouter()


def _get_store() -> SessionStore:
    from agent.main import engine
    if engine and hasattr(engine, "session_store") and engine.session_store:
        return engine.session_store
    return SessionStore()


class CreateSessionRequest(BaseModel):
    user_id: str = "default"
    title: str = ""


class AddMessageRequest(BaseModel):
    role: str
    content: str


class SearchRequest(BaseModel):
    query: str
    limit: int = 20
    session_id: str | None = None
    role_filter: str | None = None


class BookmarkRequest(BaseModel):
    session_id: str
    note: str = ""
    label: str = ""


# P2-3: 会话书签内存存储
_bookmarks: dict[str, list[dict]] = {}


@router.get("")
async def list_sessions(user_id: str | None = None):
    store = _get_store()
    sessions = store.list_sessions(user_id=user_id)
    return [
        {
            "session_id": s.session_id,
            "user_id": s.user_id,
            "title": s.title,
            "created_at": s.created_at,
            "updated_at": s.updated_at,
            "message_count": len(s.messages),
        }
        for s in sessions
    ]


@router.post("")
async def create_session(req: CreateSessionRequest):
    store = _get_store()
    session = store.create_session(user_id=req.user_id, title=req.title)
    return {
        "session_id": session.session_id,
        "title": session.title,
        "created_at": session.created_at,
    }


@router.get("/{session_id}")
async def get_session(session_id: str):
    store = _get_store()
    session = store.get_session(session_id)
    if not session:
        return {"error": "session not found"}
    return {
        "session_id": session.session_id,
        "user_id": session.user_id,
        "title": session.title,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "message_count": len(session.messages),
    }


@router.get("/{session_id}/messages")
async def get_session_messages(session_id: str, limit: int | None = None):
    store = _get_store()
    messages = store.get_messages(session_id, limit=limit)
    return [
        {"role": m.role, "content": m.content, "timestamp": m.timestamp}
        for m in messages
    ]


@router.post("/{session_id}/messages")
async def add_message(session_id: str, req: AddMessageRequest):
    store = _get_store()
    ok = store.add_message(session_id, req.role, req.content)
    return {"success": ok}


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    store = _get_store()
    ok = store.delete_session(session_id)
    return {"success": ok}


@router.get("/stats/overview")
async def session_stats():
    store = _get_store()
    return store.get_stats()


@router.post("/search")
async def search_sessions(req: SearchRequest):
    store = _get_store()
    results = store.search(
        query=req.query,
        limit=req.limit,
        session_id=req.session_id,
        role_filter=req.role_filter,
    )
    return [
        {
            "session_id": r.session_id,
            "title": r.title,
            "snippet": r.snippet,
            "rank": r.rank,
            "role": r.role,
            "timestamp": r.timestamp,
        }
        for r in results
    ]


@router.post("/search/sessions")
async def search_sessions_by_query(req: SearchRequest):
    store = _get_store()
    results = store.search_sessions(query=req.query, limit=req.limit or 10)
    return results


# P2-3: 会话书签功能
@router.post("/bookmarks")
async def add_bookmark(req: BookmarkRequest):
    """添加会话书签。"""
    import time
    user_id = req.session_id.split("_")[0] if "_" in req.session_id else "default"
    bookmark = {
        "session_id": req.session_id,
        "note": req.note,
        "label": req.label,
        "created_at": time.time(),
    }
    if user_id not in _bookmarks:
        _bookmarks[user_id] = []
    # 去重
    _bookmarks[user_id] = [b for b in _bookmarks[user_id] if b["session_id"] != req.session_id]
    _bookmarks[user_id].append(bookmark)
    return {"success": True, "bookmark": bookmark}


@router.get("/bookmarks")
async def list_bookmarks(user_id: str = "default", label: str | None = None):
    """列出所有书签，支持按标签过滤。"""
    bookmarks = _bookmarks.get(user_id, [])
    if label:
        bookmarks = [b for b in bookmarks if b.get("label") == label]
    return sorted(bookmarks, key=lambda b: b.get("created_at", 0), reverse=True)


@router.delete("/bookmarks/{session_id}")
async def delete_bookmark(session_id: str):
    """删除指定会话的书签。"""
    for user_id, bookmarks in _bookmarks.items():
        _bookmarks[user_id] = [b for b in bookmarks if b["session_id"] != session_id]
    return {"success": True}


@router.get("/bookmarks/labels")
async def list_bookmark_labels(user_id: str = "default"):
    """列出所有使用的标签。"""
    bookmarks = _bookmarks.get(user_id, [])
    labels = list(set(b.get("label", "") for b in bookmarks if b.get("label")))
    return sorted(labels)


@router.get("/search/fulltext")
async def fulltext_search(query: str, limit: int = 10):
    """P2-3: 全文搜索历史对话。

    对所有会话的所有消息进行全文搜索。
    """
    store = _get_store()
    all_results = []
    sessions = store.list_sessions()
    for session in sessions:
        messages = store.get_messages(session.session_id)
        for msg in messages:
            if query.lower() in msg.content.lower():
                all_results.append({
                    "session_id": session.session_id,
                    "session_title": session.title,
                    "role": msg.role,
                    "snippet": msg.content[:200],
                    "timestamp": msg.timestamp,
                })
                if len(all_results) >= limit * 2:
                    break
        if len(all_results) >= limit:
            break
    return all_results[:limit]
