from __future__ import annotations

import pytest

from agent.tools.builtin_toolsets import (
    AGENT_TOOLSET_MAP,
    BUILTIN_TOOLSETS,
    BASE_TOOLSET,
    CODING_TOOLSET,
    DAILY_TOOLSET,
    DESKTOP_TOOLSET,
    FULL_TOOLSET,
    MINIMAL_TOOLSET,
    NETWORK_TOOLSET,
    get_default_toolset_for_agent,
    register_builtin_toolsets,
)
from agent.tools.registry import ToolCategory, ToolDefinition, ToolParameterDef, ToolRegistry
from agent.tools.toolset_registry import get_toolset_registry, reset_toolset_registry


async def _dummy_executor(params: dict) -> None:
    pass


@pytest.fixture
def reset():
    reset_toolset_registry()
    yield
    reset_toolset_registry()


def test_all_builtin_definitions_have_id():
    for toolset in BUILTIN_TOOLSETS:
        assert toolset.id
        assert toolset.display_name
        assert toolset.description
        assert isinstance(toolset.includes, list)


def test_base_toolset_definition():
    assert BASE_TOOLSET.id == "base"
    assert len(BASE_TOOLSET.includes) == 5
    category_entries = [e for e in BASE_TOOLSET.includes if e.category is not None]
    assert len(category_entries) == 2
    name_entries = [e for e in BASE_TOOLSET.includes if e.name is not None]
    assert len(name_entries) == 3


def test_coding_toolset_extends_base():
    assert CODING_TOOLSET.id == "coding"
    assert CODING_TOOLSET.extends == "base"
    assert CODING_TOOLSET.max_tools == 20


def test_minimal_toolset_definition():
    assert MINIMAL_TOOLSET.id == "minimal"
    assert MINIMAL_TOOLSET.max_tools == 0
    assert len(MINIMAL_TOOLSET.includes) == 3


def test_full_toolset_includes_all_categories():
    assert FULL_TOOLSET.id == "full"
    categories = [e.category for e in FULL_TOOLSET.includes if e.category is not None]
    assert ToolCategory.MEMORY in categories
    assert ToolCategory.COGNITION in categories
    assert ToolCategory.FILE in categories
    assert ToolCategory.CODE in categories
    assert len(categories) == 10


def test_agent_toolset_map_complete():
    expected = ["coding", "desktop", "daily", "research", "orchestrator", "base", "minimal"]
    for key in expected:
        assert key in AGENT_TOOLSET_MAP


def test_get_default_toolset_for_agent():
    assert get_default_toolset_for_agent("coding") == "coding"
    assert get_default_toolset_for_agent("desktop") == "desktop"
    assert get_default_toolset_for_agent("unknown") == "base"


def test_register_builtin_toolsets(reset):
    registry = get_toolset_registry()
    register_builtin_toolsets()

    expected_ids = [t.id for t in BUILTIN_TOOLSETS]
    registered = registry.list()
    for id in expected_ids:
        assert id in registered


def test_builtin_toolset_resolves_with_filled_registry(reset):
    registry = get_toolset_registry()
    tool_registry = ToolRegistry()

    tool_registry.register(
        ToolDefinition(
            name="ask_clarification",
            description="澄清问题",
            category=ToolCategory.SYSTEM,
            parameters=[ToolParameterDef(name="question", type="string", description="问题")],
        ),
        _dummy_executor,
    )
    tool_registry.register(
        ToolDefinition(
            name="system_status",
            description="系统状态",
            category=ToolCategory.SYSTEM,
            parameters=[],
        ),
        _dummy_executor,
    )
    tool_registry.register(
        ToolDefinition(
            name="context_manage",
            description="上下文管理",
            category=ToolCategory.SYSTEM,
            parameters=[],
        ),
        _dummy_executor,
    )

    for cat in [ToolCategory.MEMORY, ToolCategory.COGNITION]:
        tool_registry.register(
            ToolDefinition(
                name=f"{cat.value}_tool1",
                description=f"{cat.value} tool",
                category=cat,
                parameters=[],
            ),
            _dummy_executor,
        )

    register_builtin_toolsets()
    resolved = registry.resolve("base", tool_registry)
    assert resolved is not None
    assert "ask_clarification" in resolved.tool_names
    assert "system_status" in resolved.tool_names
    assert "context_manage" in resolved.tool_names


def test_coding_inherits_base(reset):
    registry = get_toolset_registry()
    tool_registry = ToolRegistry()

    for name in [
        "ask_clarification", "system_status", "context_manage",
        "file_read", "file_write", "code_generate", "shell_exec",
        "execute_code", "preview_execution", "rollback_changes", "delegate_task",
    ]:
        cat = ToolCategory.FILE if name.startswith("file_") else ToolCategory.SYSTEM
        tool_registry.register(
            ToolDefinition(
                name=name,
                description=name,
                category=cat,
                parameters=[],
            ),
            _dummy_executor,
        )

    for cat in [ToolCategory.MEMORY, ToolCategory.COGNITION, ToolCategory.CODE]:
        tool_registry.register(
            ToolDefinition(
                name=f"{cat.value}_tool",
                description=f"{cat.value} tool",
                category=cat,
                parameters=[],
            ),
            _dummy_executor,
        )

    register_builtin_toolsets()
    resolved = registry.resolve("coding", tool_registry)
    assert resolved is not None
    assert "memory_tool" in resolved.tool_names
    assert "cognition_tool" in resolved.tool_names
    assert "code_tool" in resolved.tool_names
    assert "shell_exec" in resolved.tool_names
    assert resolved.resolved_from == ["base", "coding"]


def test_builtin_count():
    assert len(BUILTIN_TOOLSETS) == 8
