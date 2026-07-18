"""MCPToolBridge Resources/Prompts 协议方法单元测试。

测试覆盖 MCP 标准协议的 resources/list、resources/read、prompts/list、
prompts/get 四个方法。通过 unittest.mock.AsyncMock 替换 _send_jsonrpc
内部方法，不依赖真实 MCP Server。

测试用例覆盖：
- 正常成功场景
- 空列表场景
- 服务器不存在场景（_send_jsonrpc 抛异常）
- 超时场景（_send_jsonrpc 抛 TimeoutError）
- 资源不存在场景
- 二进制资源（base64 blob）场景
- 带参数的提示获取场景
- 服务器错误场景
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from agent.tools.mcp_tool_bridge import MCPToolBridge


@pytest.fixture
def bridge() -> MCPToolBridge:
    """构造无真实 provider 的 MCPToolBridge 实例。

    _send_jsonrpc 将在具体测试用例中被 AsyncMock 替换，因此不需要
    真实的 MCPProvider 实现。
    """
    return MCPToolBridge()


# ─── list_resources ───


@pytest.mark.asyncio
async def test_list_resources_success(bridge: MCPToolBridge):
    """成功返回资源列表。"""
    mock_response = {
        "result": {
            "resources": [
                {
                    "uri": "file:///docs/readme.md",
                    "name": "readme",
                    "description": "项目说明文档",
                    "mimeType": "text/markdown",
                },
                {
                    "uri": "file:///config/app.json",
                    "name": "app_config",
                    "description": "应用配置",
                    "mimeType": "application/json",
                },
            ]
        }
    }
    bridge._send_jsonrpc = AsyncMock(return_value=mock_response)

    resources = await bridge.list_resources("filesystem")

    assert len(resources) == 2
    assert resources[0]["uri"] == "file:///docs/readme.md"
    assert resources[0]["name"] == "readme"
    assert resources[0]["mimeType"] == "text/markdown"
    assert resources[1]["uri"] == "file:///config/app.json"
    bridge._send_jsonrpc.assert_awaited_once_with("filesystem", "resources/list", {})


@pytest.mark.asyncio
async def test_list_resources_empty(bridge: MCPToolBridge):
    """服务器返回空资源列表。"""
    bridge._send_jsonrpc = AsyncMock(
        return_value={"result": {"resources": []}}
    )

    resources = await bridge.list_resources("filesystem")

    assert resources == []


@pytest.mark.asyncio
async def test_list_resources_server_not_found(bridge: MCPToolBridge):
    """服务器不存在时 _send_jsonrpc 抛异常，应返回空列表。"""
    bridge._send_jsonrpc = AsyncMock(
        side_effect=RuntimeError("MCP服务器未运行: unknown")
    )

    resources = await bridge.list_resources("unknown")

    assert resources == []


@pytest.mark.asyncio
async def test_list_resources_timeout(bridge: MCPToolBridge):
    """超时时 _send_jsonrpc 抛 TimeoutError，应返回空列表。"""
    bridge._send_jsonrpc = AsyncMock(side_effect=asyncio.TimeoutError())

    resources = await bridge.list_resources("filesystem")

    assert resources == []


# ─── read_resource ───


@pytest.mark.asyncio
async def test_read_resource_success(bridge: MCPToolBridge):
    """成功读取文本资源。"""
    mock_response = {
        "result": {
            "contents": [
                {
                    "uri": "file:///docs/readme.md",
                    "mimeType": "text/markdown",
                    "text": "# 项目说明\n\n这是家百星项目。",
                }
            ]
        }
    }
    bridge._send_jsonrpc = AsyncMock(return_value=mock_response)

    result = await bridge.read_resource("filesystem", "file:///docs/readme.md")

    assert "contents" in result
    assert len(result["contents"]) == 1
    content = result["contents"][0]
    assert content["uri"] == "file:///docs/readme.md"
    assert content["mimeType"] == "text/markdown"
    assert "# 项目说明" in content["text"]
    bridge._send_jsonrpc.assert_awaited_once_with(
        "filesystem", "resources/read", {"uri": "file:///docs/readme.md"}
    )


@pytest.mark.asyncio
async def test_read_resource_not_found(bridge: MCPToolBridge):
    """资源不存在时服务器返回空 contents。"""
    bridge._send_jsonrpc = AsyncMock(
        return_value={"result": {"contents": []}}
    )

    result = await bridge.read_resource("filesystem", "file:///not/exist")

    assert result == {"contents": []}


@pytest.mark.asyncio
async def test_read_resource_with_blob(bridge: MCPToolBridge):
    """读取二进制资源（base64 blob）。"""
    mock_response = {
        "result": {
            "contents": [
                {
                    "uri": "file:///images/logo.png",
                    "mimeType": "image/png",
                    "blob": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                }
            ]
        }
    }
    bridge._send_jsonrpc = AsyncMock(return_value=mock_response)

    result = await bridge.read_resource("filesystem", "file:///images/logo.png")

    assert len(result["contents"]) == 1
    content = result["contents"][0]
    assert content["uri"] == "file:///images/logo.png"
    assert content["mimeType"] == "image/png"
    assert "blob" in content
    assert content["blob"].startswith("iVBOR")


# ─── list_prompts ───


@pytest.mark.asyncio
async def test_list_prompts_success(bridge: MCPToolBridge):
    """成功返回提示列表。"""
    mock_response = {
        "result": {
            "prompts": [
                {
                    "name": "code_review",
                    "description": "代码审查提示",
                    "arguments": [
                        {
                            "name": "code",
                            "description": "待审查的代码",
                            "required": True,
                        }
                    ],
                },
                {
                    "name": "summarize",
                    "description": "文本摘要提示",
                    "arguments": [],
                },
            ]
        }
    }
    bridge._send_jsonrpc = AsyncMock(return_value=mock_response)

    prompts = await bridge.list_prompts("assistant")

    assert len(prompts) == 2
    assert prompts[0]["name"] == "code_review"
    assert prompts[0]["description"] == "代码审查提示"
    assert len(prompts[0]["arguments"]) == 1
    assert prompts[0]["arguments"][0]["name"] == "code"
    assert prompts[0]["arguments"][0]["required"] is True
    assert prompts[1]["name"] == "summarize"
    bridge._send_jsonrpc.assert_awaited_once_with("assistant", "prompts/list", {})


@pytest.mark.asyncio
async def test_list_prompts_empty(bridge: MCPToolBridge):
    """服务器返回空提示列表。"""
    bridge._send_jsonrpc = AsyncMock(
        return_value={"result": {"prompts": []}}
    )

    prompts = await bridge.list_prompts("assistant")

    assert prompts == []


@pytest.mark.asyncio
async def test_list_prompts_server_not_found(bridge: MCPToolBridge):
    """服务器不存在时 _send_jsonrpc 抛异常，应返回空列表。"""
    bridge._send_jsonrpc = AsyncMock(
        side_effect=RuntimeError("MCP服务器未运行: unknown")
    )

    prompts = await bridge.list_prompts("unknown")

    assert prompts == []


# ─── get_prompt ───


@pytest.mark.asyncio
async def test_get_prompt_success(bridge: MCPToolBridge):
    """成功获取提示内容。"""
    mock_response = {
        "result": {
            "messages": [
                {
                    "role": "user",
                    "content": {
                        "type": "text",
                        "text": "请审查以下代码：\n```python\nprint('hello')\n```",
                    },
                }
            ]
        }
    }
    bridge._send_jsonrpc = AsyncMock(return_value=mock_response)

    result = await bridge.get_prompt("assistant", "code_review")

    assert "messages" in result
    assert len(result["messages"]) == 1
    message = result["messages"][0]
    assert message["role"] == "user"
    assert message["content"]["type"] == "text"
    assert "请审查以下代码" in message["content"]["text"]
    bridge._send_jsonrpc.assert_awaited_once_with(
        "assistant", "prompts/get", {"name": "code_review"}
    )


@pytest.mark.asyncio
async def test_get_prompt_with_arguments(bridge: MCPToolBridge):
    """带参数获取提示内容。"""
    mock_response = {
        "result": {
            "messages": [
                {
                    "role": "user",
                    "content": {
                        "type": "text",
                        "text": "请总结以下文本：\n家百星是多功能AI助手。",
                    },
                }
            ]
        }
    }
    bridge._send_jsonrpc = AsyncMock(return_value=mock_response)

    result = await bridge.get_prompt(
        "assistant",
        "summarize",
        arguments={"text": "家百星是多功能AI助手。"},
    )

    assert len(result["messages"]) == 1
    assert result["messages"][0]["role"] == "user"
    bridge._send_jsonrpc.assert_awaited_once_with(
        "assistant",
        "prompts/get",
        {"name": "summarize", "arguments": {"text": "家百星是多功能AI助手。"}},
    )


@pytest.mark.asyncio
async def test_get_prompt_not_found(bridge: MCPToolBridge):
    """提示不存在时服务器返回空 messages。"""
    bridge._send_jsonrpc = AsyncMock(
        return_value={"result": {"messages": []}}
    )

    result = await bridge.get_prompt("assistant", "nonexistent")

    assert result == {"messages": []}


@pytest.mark.asyncio
async def test_get_prompt_server_error(bridge: MCPToolBridge):
    """服务器错误时 _send_jsonrpc 抛异常，应返回空 messages。"""
    bridge._send_jsonrpc = AsyncMock(
        side_effect=RuntimeError("MCP服务器内部错误")
    )

    result = await bridge.get_prompt("assistant", "code_review")

    assert result == {"messages": []}


# ─── 边界场景 ───


@pytest.mark.asyncio
async def test_list_resources_result_not_dict(bridge: MCPToolBridge):
    """服务器返回非字典 result 时应返回空列表（防御性）。"""
    bridge._send_jsonrpc = AsyncMock(
        return_value={"result": "invalid"}
    )

    resources = await bridge.list_resources("filesystem")

    assert resources == []


@pytest.mark.asyncio
async def test_read_resource_response_not_dict(bridge: MCPToolBridge):
    """服务器返回非字典响应时应返回空 contents（防御性）。"""
    bridge._send_jsonrpc = AsyncMock(return_value=None)

    result = await bridge.read_resource("filesystem", "file:///x")

    assert result == {"contents": []}


@pytest.mark.asyncio
async def test_get_prompt_no_arguments_omits_arguments_field(bridge: MCPToolBridge):
    """不传 arguments 时请求参数中不应包含 arguments 字段。"""
    bridge._send_jsonrpc = AsyncMock(
        return_value={"result": {"messages": []}}
    )

    await bridge.get_prompt("assistant", "summarize")

    call_args = bridge._send_jsonrpc.call_args
    assert call_args.args == ("assistant", "prompts/get", {"name": "summarize"})
    assert "arguments" not in call_args.args[2]
