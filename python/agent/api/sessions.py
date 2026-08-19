from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
import threading

from agent.persistence.session_store import SessionStore
from agent.core.logger import log_ignored

router = APIRouter()


def _require_auth(api_key: str | None = None) -> str:
    """API 认证依赖 — 支持 AGENT_API_KEY 环境变量或 DashboardAuth 集成。

    - 生产环境（ENV=production/staging）：必须提供有效 API Key。
    - 开发环境：未配置 AGENT_API_KEY 时放行但打印警告。
    """
    import os
    expected_key = os.environ.get("AGENT_API_KEY", "")
    env_mode = os.environ.get("ENV", "development").lower()

    if expected_key:
        if api_key != expected_key:
            raise HTTPException(status_code=401, detail="Invalid API key")
        return "authenticated"

    if env_mode in ("production", "prod", "staging", "stage"):
        raise HTTPException(status_code=401, detail="API key required (set AGENT_API_KEY)")

    return "dev_mode"


def _api_key_header(x_api_key: str | None = Header(None, alias="X-API-Key")) -> str | None:
    return x_api_key


def get_engine():
    """获取全局引擎实例（延迟导入，避免循环依赖）。"""
    from agent.main import engine
    return engine


def _get_store() -> SessionStore:
    engine = get_engine()
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


# P2-3: 会话书签 — 委托 SessionStore 持久化
_bookmarks: dict[str, list[dict]] = {}
_bookmark_lock = threading.Lock()
_BOOKMARK_PERSIST_KEY = "__bookmarks__"


def _load_bookmarks_from_store() -> None:
    """从 SessionStore 加载书签到内存缓存。"""
    global _bookmarks
    with _bookmark_lock:
        try:
            store = _get_store()
            data = store.get_metadata(_BOOKMARK_PERSIST_KEY)
            if data and isinstance(data, dict):
                _bookmarks = data
        except Exception as _exc:
            log_ignored(None, "sessions._load_bookmarks_from_store", _exc)


def _save_bookmarks_to_store() -> None:
    """将内存中的书签持久化到 SessionStore。"""
    with _bookmark_lock:
        try:
            store = _get_store()
            store.set_metadata(_BOOKMARK_PERSIST_KEY, _bookmarks)
        except Exception as _exc:
            log_ignored(None, "sessions._save_bookmarks_to_store", _exc)


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


@router.post("/{session_id}/messages", dependencies=[Depends(lambda: _require_auth(_api_key_header()))])
async def add_message(session_id: str, req: AddMessageRequest):
    store = _get_store()
    ok = store.add_message(session_id, req.role, req.content)
    return {"success": ok}


@router.delete("/{session_id}", dependencies=[Depends(lambda: _require_auth(_api_key_header()))])
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
@router.post("/bookmarks", dependencies=[Depends(lambda: _require_auth(_api_key_header()))])
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
    with _bookmark_lock:
        if user_id not in _bookmarks:
            _bookmarks[user_id] = []
        _bookmarks[user_id] = [b for b in _bookmarks[user_id] if b["session_id"] != req.session_id]
        _bookmarks[user_id].append(bookmark)
    _save_bookmarks_to_store()
    return {"success": True, "bookmark": bookmark}


@router.get("/bookmarks")
async def list_bookmarks(user_id: str = "default", label: str | None = None):
    """列出所有书签，支持按标签过滤。"""
    with _bookmark_lock:
        bookmarks = _bookmarks.get(user_id, [])
        if label:
            bookmarks = [b for b in bookmarks if b.get("label") == label]
        result = sorted(bookmarks, key=lambda b: b.get("created_at", 0), reverse=True)
    return result


@router.delete("/bookmarks/{session_id}", dependencies=[Depends(lambda: _require_auth(_api_key_header()))])
async def delete_bookmark(session_id: str):
    """删除指定会话的书签。"""
    with _bookmark_lock:
        for user_id, bookmarks in _bookmarks.items():
            _bookmarks[user_id] = [b for b in bookmarks if b["session_id"] != session_id]
    _save_bookmarks_to_store()
    return {"success": True}


@router.get("/bookmarks/labels")
async def list_bookmark_labels(user_id: str = "default"):
    """列出所有使用的标签。"""
    with _bookmark_lock:
        bookmarks = _bookmarks.get(user_id, [])
        labels = list(set(b.get("label", "") for b in bookmarks if b.get("label")))
        result = sorted(labels)
    return result


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


# ── P0: 会话续接 (Session Continuity) ──

import time as _time

_checkpoints: dict[str, dict] = {}
_checkpoint_lock = threading.Lock()
_CHECKPOINT_PERSIST_KEY = "__checkpoints__"


def _load_checkpoints_from_store() -> None:
    """从 SessionStore 加载 checkpoint 到内存缓存。"""
    global _checkpoints
    with _checkpoint_lock:
        try:
            store = _get_store()
            data = store.get_metadata(_CHECKPOINT_PERSIST_KEY)
            if data and isinstance(data, dict):
                _checkpoints = data
        except Exception as _exc:
            log_ignored(None, "sessions._load_checkpoints_from_store", _exc)


def _save_checkpoints_to_store() -> None:
    """将内存中的 checkpoint 持久化到 SessionStore。"""
    with _checkpoint_lock:
        try:
            store = _get_store()
            store.set_metadata(_CHECKPOINT_PERSIST_KEY, _checkpoints)
        except Exception as _exc:
            log_ignored(None, "sessions._save_checkpoints_to_store", _exc)


class ResumeRequest(BaseModel):
    message: str = ""
    continue_from: int | None = None


class CheckpointResponse(BaseModel):
    session_id: str = ""
    checkpoints: list[dict] = []
    can_resume: bool = False


@router.post("/{session_id}/checkpoint", dependencies=[Depends(lambda: _require_auth(_api_key_header()))])
async def save_checkpoint(session_id: str):
    """保存会话断点，支持中断后恢复。

    保存当前会话的完整消息历史和执行状态，
    之后可通过 /resume 接口从断点继续。
    """
    store = _get_store()
    session = store.get_session(session_id)
    if not session:
        return {"error": "session not found", "session_id": session_id}

    messages = store.get_messages(session_id)
    checkpoint = {
        "session_id": session_id,
        "timestamp": _time.time(),
        "message_count": len(messages),
        "last_message": messages[-1].content[:200] if messages else "",
        "last_role": messages[-1].role if messages else "",
        "messages": [
            {"role": m.role, "content": m.content, "timestamp": m.timestamp}
            for m in messages
        ],
    }
    with _checkpoint_lock:
        _checkpoints[session_id] = checkpoint
    _save_checkpoints_to_store()
    return {
        "success": True,
        "session_id": session_id,
        "checkpoint": {
            "timestamp": checkpoint["timestamp"],
            "message_count": checkpoint["message_count"],
            "last_role": checkpoint["last_role"],
        },
    }


@router.get("/{session_id}/checkpoint")
async def get_checkpoint(session_id: str):
    """获取会话最近的断点信息。"""
    with _checkpoint_lock:
        checkpoint = _checkpoints.get(session_id)
    if not checkpoint:
        return CheckpointResponse(
            session_id=session_id,
            checkpoints=[],
            can_resume=False,
        )

    return CheckpointResponse(
        session_id=session_id,
        checkpoints=[{
            "timestamp": checkpoint["timestamp"],
            "message_count": checkpoint["message_count"],
            "last_role": checkpoint["last_role"],
        }],
        can_resume=True,
    )


@router.post("/{session_id}/resume", dependencies=[Depends(lambda: _require_auth(_api_key_header()))])
async def resume_session(session_id: str, req: ResumeRequest):
    """从断点恢复会话 — 继续执行未完成的任务。

    加载保存的断点，将历史消息注入 LLM 上下文，
    然后继续执行用户的新指令。
    """
    eng = get_engine()
    if not eng:
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=503,
            content={"detail": "Agent engine not initialized"},
        )

    with _checkpoint_lock:
        checkpoint = _checkpoints.get(session_id)
    if not checkpoint:
        return {
            "success": False,
            "reason": "no checkpoint found",
            "session_id": session_id,
        }

    history = checkpoint.get("messages", [])
    if req.continue_from is not None and req.continue_from < len(history):
        history = history[:req.continue_from]

    message = req.message or "继续上次未完成的任务"

    result = await eng.process_input(
        message=message,
        session_id=session_id,
        history=history,
    )

    return {
        "success": True,
        "session_id": session_id,
        "resumed_from": checkpoint["timestamp"],
        "history_messages": len(history),
        "content": result.get("content", ""),
        "tool_calls_made": result.get("tool_calls_made", 0),
    }


@router.delete("/{session_id}/checkpoint", dependencies=[Depends(lambda: _require_auth(_api_key_header()))])
async def delete_checkpoint(session_id: str):
    """清除会话断点。"""
    with _checkpoint_lock:
        _checkpoints.pop(session_id, None)
    _save_checkpoints_to_store()
    return {"success": True, "session_id": session_id}
