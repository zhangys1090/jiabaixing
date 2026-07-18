"""会话全文搜索工具。

将 SessionStore 的 FTS5 搜索能力暴露为工具，供 Agent 调用。
增强版支持时间范围搜索、标签过滤、相关会话查找及血缘信息展示。

集成示例::

    from agent.tools.session_search_tool import register_session_search_tool
    register_session_search_tool(registry, session_store)
"""

from __future__ import annotations

from typing import Any

from agent.core.logger import StructuredLogger
from agent.persistence.session_lineage import SessionLineageTracker
from agent.persistence.session_search_index import SessionSearchIndex
from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolExecutor,
    ToolParameterDef,
    ToolResult,
)

log = StructuredLogger("session_search_tool")

# 工具定义
SESSION_SEARCH_DEF = ToolDefinition(
    name="session_search",
    description="搜索过往对话内容，找到相关历史记录。支持中文全文搜索、时间范围过滤、标签搜索和血缘关系追踪。",
    short_desc="搜索过往对话",
    category=ToolCategory.MEMORY,
    tags=["search", "history", "session", "fts5", "lineage"],
    scenes=["daily", "research", "coding"],
    capability_level=1,
    parameters=[
        ToolParameterDef(
            name="query",
            description="搜索关键词（支持中文自然语言）",
            required=True,
            type="string",
        ),
        ToolParameterDef(
            name="limit",
            description="返回结果数量上限",
            required=False,
            type="integer",
            default=10,
        ),
        ToolParameterDef(
            name="session_id",
            description="限定搜索的会话 ID（可选，不填则搜索所有会话）",
            required=False,
            type="string",
        ),
        ToolParameterDef(
            name="time_start",
            description="搜索起始时间（Unix 时间戳，可选）",
            required=False,
            type="number",
        ),
        ToolParameterDef(
            name="time_end",
            description="搜索结束时间（Unix 时间戳，可选）",
            required=False,
            type="number",
        ),
        ToolParameterDef(
            name="session_tags",
            description="按标签过滤，逗号分隔（如 'coding,python'），匹配任一标签",
            required=False,
            type="string",
        ),
        ToolParameterDef(
            name="related_sessions",
            description="查找与指定会话 ID 相关的会话（血缘+内容相似），填入目标会话 ID",
            required=False,
            type="string",
        ),
    ],
    risk_level="low",
    permissions=[],
)


def make_session_search_executor(
    session_store: Any,
    search_index: SessionSearchIndex | None = None,
    lineage_tracker: SessionLineageTracker | None = None,
) -> ToolExecutor:
    """创建会话搜索工具执行器。

    Args:
        session_store: SessionStore 实例。
        search_index: SessionSearchIndex 实例（可选，提供增强搜索能力）。
        lineage_tracker: SessionLineageTracker 实例（可选，提供血缘追踪能力）。

    Returns:
        工具执行器函数。
    """

    async def _executor(**kwargs: Any) -> ToolResult:
        """执行会话搜索。

        Args:
            query: 搜索关键词。
            limit: 返回结果数量上限。
            session_id: 限定搜索的会话 ID（可选）。
            time_start: 搜索起始时间戳（可选）。
            time_end: 搜索结束时间戳（可选）。
            session_tags: 逗号分隔的标签列表（可选）。
            related_sessions: 查找相关会话的目标会话 ID（可选）。

        Returns:
            ToolResult 包含搜索结果。
        """
        query = kwargs.get("query", "").strip()
        limit = kwargs.get("limit", 10)
        session_id = kwargs.get("session_id")
        time_start = kwargs.get("time_start")
        time_end = kwargs.get("time_end")
        session_tags_str = kwargs.get("session_tags", "")
        related_sessions_id = kwargs.get("related_sessions")

        # 解析标签
        tags: list[str] | None = None
        if session_tags_str:
            tags = [t.strip() for t in session_tags_str.split(",") if t.strip()]

        # 时间范围参数转换
        ts: float | None = None
        te: float | None = None
        if time_start is not None:
            try:
                ts = float(time_start)
            except (ValueError, TypeError):
                return ToolResult(
                    success=False,
                    error=f"time_start 格式无效: {time_start}",
                )
        if time_end is not None:
            try:
                te = float(time_end)
            except (ValueError, TypeError):
                return ToolResult(
                    success=False,
                    error=f"time_end 格式无效: {time_end}",
                )

        try:
            # 查找相关会话模式
            if related_sessions_id:
                return await _search_related(
                    related_sessions_id, limit, search_index, lineage_tracker,
                )

            # 增强搜索模式（有 search_index 时）
            if search_index and (ts is not None or te is not None or tags):
                return await _search_enhanced(
                    query, limit, ts, te, tags, search_index, lineage_tracker,
                )

            # 基础搜索模式
            if not query:
                return ToolResult(
                    success=False,
                    error="搜索关键词不能为空",
                )

            return await _search_basic(
                query, limit, session_id, session_store, lineage_tracker,
            )

        except Exception as e:
            log.error("Session search failed", error=str(e), query=query)
            return ToolResult(
                success=False,
                error=f"搜索失败: {e}",
            )

    return _executor


async def _search_basic(
    query: str,
    limit: int,
    session_id: str | None,
    session_store: Any,
    lineage_tracker: SessionLineageTracker | None,
) -> ToolResult:
    """执行基础搜索（无时间范围/标签过滤）。

    Args:
        query: 搜索关键词。
        limit: 返回结果数量上限。
        session_id: 限定搜索的会话 ID。
        session_store: SessionStore 实例。
        lineage_tracker: 血缘追踪器实例。

    Returns:
        ToolResult: 搜索结果。
    """
    results = session_store.search(
        query=query,
        limit=limit,
        session_id=session_id,
    )

    if not results:
        return ToolResult(
            success=True,
            output=f"未找到与 '{query}' 相关的对话记录。",
            metadata={"count": 0, "query": query},
        )

    # 格式化搜索结果
    lines = [f"找到 {len(results)} 条与 '{query}' 相关的记录：\n"]
    result_data = []
    for i, r in enumerate(results, 1):
        snippet = r.snippet or r.content[:100] if hasattr(r, "content") else r.snippet
        lines.append(
            f"{i}. [{r.session_id}] {r.title}\n"
            f"   角色: {r.role} | 时间: {r.timestamp}\n"
            f"   内容: {snippet}\n"
        )

        entry: dict[str, Any] = {
            "session_id": r.session_id,
            "title": r.title,
            "snippet": r.snippet,
            "role": r.role,
            "timestamp": r.timestamp,
            "rank": r.rank,
        }

        # 附加血缘信息
        if lineage_tracker:
            lineage_info = _get_lineage_info(r.session_id, lineage_tracker)
            if lineage_info:
                entry["lineage"] = lineage_info
                lines.append(
                    f"   血缘: {lineage_info.get('summary', '')} "
                    f"| 父: {lineage_info.get('parent_id', '无')} "
                    f"| 子: {len(lineage_info.get('child_ids', []))}\n"
                )

        result_data.append(entry)

    return ToolResult(
        success=True,
        output="\n".join(lines),
        metadata={
            "count": len(results),
            "query": query,
            "results": result_data,
        },
    )


async def _search_enhanced(
    query: str,
    limit: int,
    time_start: float | None,
    time_end: float | None,
    tags: list[str] | None,
    search_index: SessionSearchIndex,
    lineage_tracker: SessionLineageTracker | None,
) -> ToolResult:
    """执行增强搜索（支持时间范围和标签过滤）。

    Args:
        query: 搜索关键词。
        limit: 返回结果数量上限。
        time_start: 起始时间戳。
        time_end: 结束时间戳。
        tags: 标签过滤列表。
        search_index: SessionSearchIndex 实例。
        lineage_tracker: 血缘追踪器实例。

    Returns:
        ToolResult: 搜索结果。
    """
    if not query:
        return ToolResult(
            success=False,
            error="搜索关键词不能为空",
        )

    results = search_index.search(
        query=query,
        limit=limit,
        time_start=time_start,
        time_end=time_end,
        tags=tags,
    )

    if not results:
        desc_parts = [f"'{query}'"]
        if time_start or time_end:
            desc_parts.append("指定时间范围")
        if tags:
            desc_parts.append(f"标签 {tags}")
        return ToolResult(
            success=True,
            output=f"未找到与 {' '.join(desc_parts)} 相关的对话记录。",
            metadata={"count": 0, "query": query, "tags": tags},
        )

    lines = [f"找到 {len(results)} 条增强搜索结果：\n"]
    result_data = []
    for i, r in enumerate(results, 1):
        lines.append(
            f"{i}. [{r['session_id']}] {r['title']}\n"
            f"   角色: {r['role']} | 时间: {r['timestamp']}\n"
            f"   内容: {r['snippet']}\n"
        )

        entry = dict(r)

        # 附加血缘信息
        if lineage_tracker:
            lineage_info = _get_lineage_info(r["session_id"], lineage_tracker)
            if lineage_info:
                entry["lineage"] = lineage_info
                lines.append(
                    f"   血缘: {lineage_info.get('summary', '')} "
                    f"| 父: {lineage_info.get('parent_id', '无')} "
                    f"| 子: {len(lineage_info.get('child_ids', []))}\n"
                )

        result_data.append(entry)

    return ToolResult(
        success=True,
        output="\n".join(lines),
        metadata={
            "count": len(results),
            "query": query,
            "time_start": time_start,
            "time_end": time_end,
            "tags": tags,
            "results": result_data,
        },
    )


async def _search_related(
    session_id: str,
    limit: int,
    search_index: SessionSearchIndex | None,
    lineage_tracker: SessionLineageTracker | None,
) -> ToolResult:
    """查找与指定会话相关的会话。

    Args:
        session_id: 目标会话 ID。
        limit: 返回结果数量上限。
        search_index: SessionSearchIndex 实例。
        lineage_tracker: 血缘追踪器实例。

    Returns:
        ToolResult: 相关会话结果。
    """
    if search_index:
        related = search_index.get_related(session_id, limit=limit)
    elif lineage_tracker:
        related = _get_related_from_lineage(session_id, lineage_tracker, limit)
    else:
        return ToolResult(
            success=False,
            error="需要 search_index 或 lineage_tracker 才能查找相关会话",
        )

    if not related:
        return ToolResult(
            success=True,
            output=f"未找到与会话 {session_id} 相关的会话。",
            metadata={"count": 0, "session_id": session_id},
        )

    lines = [f"找到 {len(related)} 个与会话 {session_id} 相关的会话：\n"]
    for i, r in enumerate(related, 1):
        rel_type = r.get("relation_type", "content")
        relevance = r.get("relevance", 0.0)
        lines.append(
            f"{i}. [{r['session_id']}] {r.get('title', '')}\n"
            f"   关系: {rel_type} | 相关度: {relevance:.1f}\n"
        )

    return ToolResult(
        success=True,
        output="\n".join(lines),
        metadata={
            "count": len(related),
            "session_id": session_id,
            "related": related,
        },
    )


def _get_lineage_info(
    session_id: str, lineage_tracker: SessionLineageTracker,
) -> dict[str, Any] | None:
    """获取会话的简要血缘信息。

    Args:
        session_id: 会话唯一标识。
        lineage_tracker: 血缘追踪器实例。

    Returns:
        dict[str, Any] | None: 血缘信息字典，不存在时返回 None。
    """
    lineage = lineage_tracker.get_lineage(session_id)
    if lineage is None:
        return None
    return {
        "parent_id": lineage.parent_id,
        "child_ids": lineage.child_ids,
        "summary": lineage.summary,
        "tags": lineage.tags,
    }


def _get_related_from_lineage(
    session_id: str,
    lineage_tracker: SessionLineageTracker,
    limit: int,
) -> list[dict[str, Any]]:
    """仅基于血缘关系获取相关会话。

    Args:
        session_id: 目标会话 ID。
        lineage_tracker: 血缘追踪器实例。
        limit: 返回结果数量上限。

    Returns:
        list[dict[str, Any]]: 相关会话列表。
    """
    related: list[dict[str, Any]] = []
    seen: set[str] = {session_id}

    # 父会话
    lineage = lineage_tracker.get_lineage(session_id)
    if lineage and lineage.parent_id:
        parent = lineage_tracker.get_lineage(lineage.parent_id)
        if parent and parent.session_id not in seen:
            seen.add(parent.session_id)
            related.append({
                "session_id": parent.session_id,
                "title": parent.summary or parent.session_id,
                "relation_type": "parent",
                "relevance": 0.9,
            })

    # 兄弟会话
    siblings = lineage_tracker.get_siblings(session_id)
    for sib in siblings:
        if sib.session_id not in seen:
            seen.add(sib.session_id)
            related.append({
                "session_id": sib.session_id,
                "title": sib.summary or sib.session_id,
                "relation_type": "sibling",
                "relevance": 0.8,
            })

    # 子会话
    children = lineage_tracker.get_children(session_id)
    for child in children:
        if child.session_id not in seen:
            seen.add(child.session_id)
            related.append({
                "session_id": child.session_id,
                "title": child.summary or child.session_id,
                "relation_type": "child",
                "relevance": 0.7,
            })

    return related[:limit]


def register_session_search_tool(
    registry: Any,
    session_store: Any,
    search_index: SessionSearchIndex | None = None,
    lineage_tracker: SessionLineageTracker | None = None,
) -> None:
    """注册会话搜索工具到工具注册表。

    Args:
        registry: ToolRegistry 实例。
        session_store: SessionStore 实例。
        search_index: SessionSearchIndex 实例（可选，提供增强搜索能力）。
        lineage_tracker: SessionLineageTracker 实例（可选，提供血缘追踪能力）。
    """
    registry.register(
        SESSION_SEARCH_DEF,
        make_session_search_executor(session_store, search_index, lineage_tracker),
    )
    log.info("Session search tool registered")
