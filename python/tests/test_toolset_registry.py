from __future__ import annotations

import pytest

from agent.tools.registry import ToolCategory, ToolDefinition, ToolParameterDef, ToolRegistry
from agent.tools.toolset_registry import (
    ResolvedToolset,
    ToolsetDefinition,
    ToolsetEntry,
    ToolsetRegistry,
    get_toolset_registry,
    reset_toolset_registry,
)


async def _dummy_executor(params: dict) -> None:
    pass


@pytest.fixture
def tool_registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        ToolDefinition(
            name="file_read",
            description="读取文件",
            category=ToolCategory.FILE,
            parameters=[ToolParameterDef(name="path", type="string", description="文件路径")],
        ),
        _dummy_executor,
    )
    registry.register(
        ToolDefinition(
            name="file_write",
            description="写入文件",
            category=ToolCategory.FILE,
            parameters=[ToolParameterDef(name="path", type="string", description="文件路径")],
        ),
        _dummy_executor,
    )
    registry.register(
        ToolDefinition(
            name="memory_store",
            description="存储记忆",
            category=ToolCategory.MEMORY,
            parameters=[ToolParameterDef(name="content", type="string", description="内容")],
        ),
        _dummy_executor,
    )
    registry.register(
        ToolDefinition(
            name="shell_exec",
            description="执行命令",
            category=ToolCategory.SYSTEM,
            parameters=[ToolParameterDef(name="command", type="string", description="命令")],
        ),
        _dummy_executor,
    )
    return registry


@pytest.fixture
def ts_registry() -> ToolsetRegistry:
    return ToolsetRegistry()


# ─── Registration ───


def test_register_toolset(ts_registry: ToolsetRegistry):
    definition = ToolsetDefinition(
        id="test",
        display_name="测试工具集",
        description="用于测试",
        includes=[ToolsetEntry(name="file_read")],
    )
    ts_registry.register(definition)
    assert ts_registry.get("test") is not None
    assert ts_registry.get("test").display_name == "测试工具集"


def test_register_overwrites(ts_registry: ToolsetRegistry):
    ts_registry.register(ToolsetDefinition(
        id="test", display_name="第一版", description="",
        includes=[ToolsetEntry(name="file_read")],
    ))
    ts_registry.register(ToolsetDefinition(
        id="test", display_name="第二版", description="",
        includes=[ToolsetEntry(name="file_write")],
    ))
    assert ts_registry.get("test").display_name == "第二版"


def test_list_toolsets(ts_registry: ToolsetRegistry):
    ts_registry.register(ToolsetDefinition(
        id="a", display_name="A", description="",
        includes=[ToolsetEntry(name="file_read")],
    ))
    ts_registry.register(ToolsetDefinition(
        id="b", display_name="B", description="",
        includes=[ToolsetEntry(name="file_write")],
    ))
    ids = ts_registry.list()
    assert "a" in ids
    assert "b" in ids


# ─── Resolve by name ───


def test_resolve_by_name(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="files",
        display_name="文件工具",
        description="文件操作",
        includes=[ToolsetEntry(name="file_read"), ToolsetEntry(name="file_write")],
    ))

    resolved = ts_registry.resolve("files", tool_registry)
    assert resolved is not None
    assert "file_read" in resolved.tool_names
    assert "file_write" in resolved.tool_names
    assert resolved.id == "files"


def test_resolve_by_category(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="file_category",
        display_name="文件分类",
        description="所有文件工具",
        includes=[ToolsetEntry(category=ToolCategory.FILE)],
    ))

    resolved = ts_registry.resolve("file_category", tool_registry)
    assert resolved is not None
    assert "file_read" in resolved.tool_names
    assert "file_write" in resolved.tool_names


def test_resolve_nonexistent_tool_warns(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="bad",
        display_name="坏工具集",
        description="引用了不存在的工具",
        includes=[ToolsetEntry(name="nonexistent_tool")],
    ))

    resolved = ts_registry.resolve("bad", tool_registry)
    assert resolved is not None
    assert "nonexistent_tool" not in resolved.tool_names


# ─── Excludes ───


def test_resolve_excludes(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="safe_files",
        display_name="安全文件",
        description="只读文件工具",
        includes=[ToolsetEntry(category=ToolCategory.FILE)],
        excludes=["file_write"],
    ))

    resolved = ts_registry.resolve("safe_files", tool_registry)
    assert resolved is not None
    assert "file_read" in resolved.tool_names
    assert "file_write" not in resolved.tool_names


# ─── Inheritance ───


def test_resolve_extends(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="base",
        display_name="基础工具",
        description="",
        includes=[ToolsetEntry(name="file_read")],
    ))
    ts_registry.register(ToolsetDefinition(
        id="extended",
        display_name="扩展工具",
        description="",
        includes=[ToolsetEntry(name="file_write")],
        extends="base",
    ))

    resolved = ts_registry.resolve("extended", tool_registry)
    assert resolved is not None
    assert "file_read" in resolved.tool_names
    assert "file_write" in resolved.tool_names
    assert "base" in resolved.resolved_from
    assert "extended" in resolved.resolved_from


def test_resolve_extends_chain(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="base", display_name="基础", description="",
        includes=[ToolsetEntry(name="file_read")],
    ))
    ts_registry.register(ToolsetDefinition(
        id="mid", display_name="中间", description="",
        includes=[ToolsetEntry(name="file_write")],
        extends="base",
    ))
    ts_registry.register(ToolsetDefinition(
        id="top", display_name="顶层", description="",
        includes=[ToolsetEntry(name="shell_exec")],
        extends="mid",
    ))

    resolved = ts_registry.resolve("top", tool_registry)
    assert resolved is not None
    assert "file_read" in resolved.tool_names
    assert "file_write" in resolved.tool_names
    assert "shell_exec" in resolved.tool_names
    assert resolved.resolved_from == ["base", "mid", "top"]


# ─── Max tools ───


def test_resolve_max_tools(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="limited",
        display_name="限制工具",
        description="",
        includes=[ToolsetEntry(category=ToolCategory.FILE), ToolsetEntry(name="shell_exec")],
        max_tools=2,
    ))

    resolved = ts_registry.resolve("limited", tool_registry)
    assert resolved is not None
    assert len(resolved.tool_names) <= 2


# ─── Cache ───


def test_resolve_caches_result(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="cached", display_name="缓存", description="",
        includes=[ToolsetEntry(name="file_read")],
    ))

    resolved1 = ts_registry.resolve("cached", tool_registry)
    resolved2 = ts_registry.resolve("cached", tool_registry)
    assert resolved1 is resolved2


def test_invalidate_cache(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="to_invalidate", display_name="待失效", description="",
        includes=[ToolsetEntry(name="file_read")],
    ))

    ts_registry.resolve("to_invalidate", tool_registry)
    ts_registry.invalidate_cache("to_invalidate")

    assert "to_invalidate" not in ts_registry._resolved_cache


def test_invalidate_all_cache(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="a", display_name="A", description="",
        includes=[ToolsetEntry(name="file_read")],
    ))
    ts_registry.register(ToolsetDefinition(
        id="b", display_name="B", description="",
        includes=[ToolsetEntry(name="file_write")],
    ))

    ts_registry.resolve("a", tool_registry)
    ts_registry.resolve("b", tool_registry)
    ts_registry.invalidate_cache()

    assert len(ts_registry._resolved_cache) == 0


# ─── Resolve to OpenAI ───


def test_resolve_to_openai(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="openai_test",
        display_name="OpenAI测试",
        description="",
        includes=[ToolsetEntry(name="file_read")],
    ))

    tools = ts_registry.resolve_to_openai("openai_test", tool_registry)
    assert len(tools) == 1
    assert tools[0]["function"]["name"] == "file_read"


def test_resolve_to_openai_empty(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    tools = ts_registry.resolve_to_openai("nonexistent", tool_registry)
    assert tools == []


# ─── Global singleton ───


def test_get_toolset_registry_singleton():
    reset_toolset_registry()
    ts1 = get_toolset_registry()
    ts2 = get_toolset_registry()
    assert ts1 is ts2


def test_reset_toolset_registry():
    reset_toolset_registry()
    ts1 = get_toolset_registry()
    reset_toolset_registry()
    ts2 = get_toolset_registry()
    assert ts1 is not ts2


# ─── Resolve nonexistent ───


def test_resolve_nonexistent_id(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    resolved = ts_registry.resolve("nonexistent", tool_registry)
    assert resolved is None


# ─── Display name ───


def test_resolved_display_name(ts_registry: ToolsetRegistry, tool_registry: ToolRegistry):
    ts_registry.register(ToolsetDefinition(
        id="display_test",
        display_name="显示名称测试",
        description="",
        includes=[ToolsetEntry(name="file_read")],
    ))

    resolved = ts_registry.resolve("display_test", tool_registry)
    assert resolved is not None
    assert resolved.display_name == "显示名称测试"
