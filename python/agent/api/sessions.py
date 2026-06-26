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
