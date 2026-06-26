import pytest

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolRegistry,
    ToolResult,
    register_default_tools,
)


def test_tool_category_values():
    assert ToolCategory.MEMORY == "memory"
    assert ToolCategory.COGNITION == "cognition"
    assert ToolCategory.CODE == "code"


def test_tool_registry_register():
    registry = ToolRegistry()
    async def fn(params): return ToolResult(success=True)
    registry.register(ToolDefinition(name="test", description="测试"), fn)
    assert registry.size() == 1


def test_tool_registry_unregister():
    registry = ToolRegistry()
    async def fn(params): return ToolResult(success=True)
    registry.register(ToolDefinition(name="rm", description="删除"), fn)
    assert registry.unregister("rm") is True
    assert registry.size() == 0


def test_tool_registry_get():
    registry = ToolRegistry()
    async def fn(params): return ToolResult(success=True)
    defn = ToolDefinition(name="get_test", description="获取测试", category=ToolCategory.CODE)
    registry.register(defn, fn)
    result = registry.get("get_test")
    assert result is not None
    assert result[0].name == "get_test"


def test_tool_registry_get_definition():
    registry = ToolRegistry()
    async def fn(params): return ToolResult(success=True)
    defn = ToolDefinition(name="defn_test", description="定义测试")
    registry.register(defn, fn)
    d = registry.get_definition("defn_test")
    assert d is not None
    assert d.name == "defn_test"


def test_tool_registry_by_category():
    registry = ToolRegistry()
    async def fn(params): return ToolResult(success=True)
    registry.register(ToolDefinition(name="m1", description="", category=ToolCategory.MEMORY), fn)
    registry.register(ToolDefinition(name="c1", description="", category=ToolCategory.CODE), fn)
    registry.register(ToolDefinition(name="m2", description="", category=ToolCategory.MEMORY), fn)

    memory = registry.get_by_category(ToolCategory.MEMORY)
    assert len(memory) == 2


def test_tool_registry_all_definitions():
    registry = ToolRegistry()
    async def fn(params): return ToolResult(success=True)
    registry.register(ToolDefinition(name="a", description=""), fn)
    registry.register(ToolDefinition(name="b", description=""), fn)
    assert len(registry.get_all_definitions()) == 2


@pytest.mark.anyio
async def test_tool_registry_execute():
    registry = ToolRegistry()
    async def fn(params): return ToolResult(success=True, output="hello")
    registry.register(ToolDefinition(name="exec", description=""), fn)
    result = await registry.execute("exec", {})
    assert result.success
    assert result.output == "hello"


@pytest.mark.anyio
async def test_tool_registry_execute_not_found():
    registry = ToolRegistry()
    result = await registry.execute("missing", {})
    assert result.success is False
    assert "not found" in result.error


@pytest.mark.anyio
async def test_tool_registry_execute_error():
    registry = ToolRegistry()
    async def fn(params): raise ValueError("test error")
    registry.register(ToolDefinition(name="err", description=""), fn)
    result = await registry.execute("err", {})
    assert result.success is False
    assert "test error" in result.error


def test_tool_to_openai_tools():
    registry = ToolRegistry()
    async def fn(params): return ToolResult(success=True)
    registry.register(ToolDefinition(
        name="search",
        description="搜索",
        category=ToolCategory.NETWORK,
        parameters=[
            ToolParameterDef(name="query", description="搜索词"),
            ToolParameterDef(name="limit", type="integer", required=False, description="数量"),
        ],
    ), fn)

    tools = registry.to_openai_tools()
    assert len(tools) == 1
    assert tools[0]["type"] == "function"
    assert tools[0]["function"]["name"] == "search"
    assert "query" in tools[0]["function"]["parameters"]["properties"]


def test_register_default_tools():
    registry = ToolRegistry()
    count = register_default_tools(registry)
    assert count >= 15
    assert registry.size() == count
    assert len(registry.get_by_category(ToolCategory.MEMORY)) == 4
    assert len(registry.get_by_category(ToolCategory.COGNITION)) == 3


@pytest.mark.anyio
async def test_default_tool_execution():
    registry = ToolRegistry()
    register_default_tools(registry)
    result = await registry.execute("memory_recall", {"query": "test"})
    assert result.success
