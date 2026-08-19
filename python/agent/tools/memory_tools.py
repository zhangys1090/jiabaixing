from __future__ import annotations

from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)
from agent.core.logger import log_ignored


MEMORY_RECALL_DEF = ToolDefinition(
    name="memory_recall",
    description='搜索用户的历史记忆和背景信息。适用场景：用户提到"之前说过"、"上次聊的"、或者需要了解用户偏好/习惯/背景时。不适用：普通聊天问候、上下文中已有足够信息。',
    short_desc="搜索历史记忆",
    category=ToolCategory.MEMORY,
    tags=["memory", "recall", "search", "history"],
    scenes=["coding", "daily", "research", "comfort"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="query", type="string", description="搜索关键词"),
        ToolParameterDef(name="limit", type="number", required=False, description="返回结果数量上限"),
    ],
    risk_level="low",
)

MEMORY_SEARCH_DEF = ToolDefinition(
    name="memory_search",
    description="按条件搜索记忆。适用场景：查找特定类型的记忆、按时间范围搜索。不适用：简单关键词搜索（用 memory_recall）。",
    short_desc="按条件搜索记忆",
    category=ToolCategory.MEMORY,
    tags=["memory", "search", "filter"],
    scenes=["coding", "daily", "research"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="query", type="string", description="搜索关键词"),
        ToolParameterDef(name="scene", type="string", required=False, description="场景过滤"),
        ToolParameterDef(name="limit", type="number", required=False, description="返回结果数量上限"),
    ],
    risk_level="low",
)

MEMORY_STORE_DEF = ToolDefinition(
    name="memory_store",
    description="存储信息到记忆系统。适用场景：用户明确要求记住某些信息、重要偏好/习惯需要持久化。不适用：临时对话内容（系统自动处理）。",
    short_desc="存储信息到记忆",
    category=ToolCategory.MEMORY,
    tags=["memory", "store", "save"],
    scenes=["coding", "daily", "research", "comfort"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="content", type="string", description="要存储的内容"),
        ToolParameterDef(name="type", type="string", required=False, description="记忆类型: short_term/long_term/instant", enum=["short_term", "long_term", "instant"]),
        ToolParameterDef(name="scene", type="string", required=False, description="场景标签"),
        ToolParameterDef(name="importance", type="number", required=False, description="重要性评分 1-10"),
    ],
    risk_level="low",
)

KNOWLEDGE_QUERY_DEF = ToolDefinition(
    name="knowledge_query",
    description="查询知识库中的结构化知识。适用场景：查询已保存的文档、FAQ、专业知识。不适用：搜索对话记忆（用 memory_recall）。",
    short_desc="查询知识库",
    category=ToolCategory.MEMORY,
    tags=["memory", "knowledge", "query", "faq"],
    scenes=["coding", "research", "daily"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="query", type="string", description="查询问题"),
        ToolParameterDef(name="domain", type="string", required=False, description="知识领域"),
    ],
    risk_level="low",
)


def _get_memory_engine():
    from agent.core.engine import AgentEngine
    from agent.main import engine
    if engine and hasattr(engine, "memory") and engine.memory:
        return engine.memory
    return None


def _get_persistence():
    from agent.main import engine
    if engine and hasattr(engine, "persistence") and engine.persistence:
        return engine.persistence
    return None


async def memory_recall_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    query = str(params.get("query", ""))
    limit = int(params.get("limit", 5))

    if not query:
        return ToolResult(success=True, output="请输入搜索关键词")

    memory = _get_memory_engine()
    if not memory:
        return ToolResult(success=True, output="记忆系统暂不可用，无法召回记忆")

    try:
        results = await memory.search(query=query, limit=limit)
        if not results:
            return ToolResult(
                success=True,
                output=f"未找到与「{query}」相关的记忆",
                duration=time.time() - start,
            )

        formatted: list[str] = []
        for i, m in enumerate(results, 1):
            content = m.get("content", "")
            m_type = m.get("type", "")
            importance = m.get("importance", 0)
            formatted.append(f"{i}. [{m_type}] {content}" + (f" (重要性: {importance})" if importance else ""))

        output = f"找到 {len(results)} 条相关记忆:\n" + "\n".join(formatted)
        return ToolResult(success=True, output=output, duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"记忆召回失败: {e}")


async def memory_search_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    query = str(params.get("query", ""))
    scene = params.get("scene")
    limit = int(params.get("limit", 5))

    if not query:
        return ToolResult(success=True, output="请输入搜索关键词")

    memory = _get_memory_engine()
    if not memory:
        return ToolResult(success=True, output="记忆系统暂不可用")

    try:
        results = await memory.search(query=query, limit=limit)
        if scene:
            results = [r for r in results if r.get("scene") == scene]

        if not results:
            return ToolResult(success=True, output=f"未找到匹配的记忆", duration=time.time() - start)

        formatted = [f"{i+1}. {r.get('content', '')}" for i, r in enumerate(results)]
        output = f"找到 {len(results)} 条记忆:\n" + "\n".join(formatted)
        return ToolResult(success=True, output=output, duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"记忆搜索失败: {e}")


async def memory_store_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    content = str(params.get("content", ""))
    mem_type = str(params.get("type", "short_term"))
    scene = params.get("scene")
    importance = float(params.get("importance", 5.0))

    if not content:
        return ToolResult(success=False, error="存储内容不能为空")

    persistence = _get_persistence()
    if persistence:
        try:
            from agent.persistence.service import MemoryStoreOptions
            opts = MemoryStoreOptions(type=mem_type, scene=scene, importance=importance)
            result = await persistence.store_memory(content, opts)
            if result:
                return ToolResult(
                    success=True,
                    output=f"已存储为{mem_type}记忆",
                    duration=time.time() - start,
                )
        except Exception as _exc:
            log_ignored(None, "memory_tools.memory_store_executor", _exc)

    memory = _get_memory_engine()
    if not memory:
        return ToolResult(success=True, output="记忆系统暂不可用，内容未存储")

    try:
        if mem_type == "instant":
            await memory.store_instant(content, scene=scene)
        elif mem_type == "long_term":
            await memory.store_long_term(content, scene=scene)
        else:
            await memory.store_short_term(content, scene=scene)
        return ToolResult(
            success=True,
            output=f"已存储为{mem_type}记忆",
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"记忆存储失败: {e}")


async def knowledge_query_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    query = str(params.get("query", ""))
    domain = params.get("domain")

    if not query:
        return ToolResult(success=False, error="查询问题不能为空")

    memory = _get_memory_engine()
    if not memory:
        return ToolResult(success=True, output="知识库暂不可用")

    try:
        search_query = f"{domain} {query}" if domain else query
        results = await memory.search(query=search_query, limit=5)

        if not results:
            return ToolResult(success=True, output=f"未找到与「{query}」相关的知识", duration=time.time() - start)

        formatted = [f"{i+1}. {r.get('content', '')}" for i, r in enumerate(results)]
        output = f"找到 {len(results)} 条相关知识:\n" + "\n".join(formatted)
        return ToolResult(success=True, output=output, duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"知识查询失败: {e}")
