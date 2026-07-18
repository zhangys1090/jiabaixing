"""MCP（Model Context Protocol）HTTP API 路由.

暴露 MCP 服务器管理、Resources、Prompts、Tools 调用等能力，使前端
和外部客户端可通过 HTTP 端点操作 MCP 服务器。

端点总览：
- GET    /mcp/servers                              列出已注册 MCP 服务器
- GET    /mcp/servers/{name}/status                获取单个服务器状态
- POST   /mcp/servers/{name}/start                 启动服务器
- POST   /mcp/servers/{name}/stop                  停止服务器
- GET    /mcp/servers/{name}/resources             列出服务器资源
- POST   /mcp/servers/{name}/resources/read        读取服务器资源
- GET    /mcp/servers/{name}/prompts               列出服务器提示
- POST   /mcp/servers/{name}/prompts/get           获取服务器提示内容
- POST   /mcp/servers/{name}/tools/call            调用服务器工具
- POST   /mcp/sampling                             触发 sampling/createMessage（P3-#2）
- POST   /mcp/logging                              发送 notifications/message 日志（P3-#2）
- POST   /mcp/progress                             发送 notifications/progress 进度（P3-#2）
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from agent.core.logger import StructuredLogger
from agent.mcp.server_manager import MCPServerConfig, MCPServerManager

log = StructuredLogger("api.mcp")

router = APIRouter(tags=["mcp"])


def _get_manager() -> MCPServerManager:
    """获取 MCPServerManager 单例.

    Returns:
        MCPServerManager: 全局单例实例.
    """
    return MCPServerManager.get_instance()


def _get_bridge():
    """从全局 engine 获取 MCPToolBridge 实例.

    MCPToolBridge 在 engine.initialize() 中创建，提供 resources/prompts
    协议方法的封装。若 engine 未就绪或 bridge 不可用则返回 None。

    Returns:
        MCPToolBridge | None: 桥接器实例或 None.
    """
    try:
        from agent.main import engine
        if engine and getattr(engine, "mcp_tool_bridge", None):
            return engine.mcp_tool_bridge
    except Exception as e:
        log.warning("Get MCPToolBridge failed", error=str(e))
    return None


# ─────────────────────────────────────────────────────────────
# 请求/响应模型
# ─────────────────────────────────────────────────────────────


class ReadResourceRequest(BaseModel):
    """读取资源请求体.

    Attributes:
        uri: 资源 URI（如 "file:///path/to/file"）.
    """

    uri: str = Field(..., description="资源 URI")


class GetPromptRequest(BaseModel):
    """获取提示请求体.

    Attributes:
        name: 提示模板名称.
        arguments: 提示参数字典（可选）.
    """

    name: str = Field(..., description="提示模板名称")
    arguments: dict[str, str] | None = Field(
        default=None, description="提示参数字典"
    )


class CallToolRequest(BaseModel):
    """调用工具请求体.

    Attributes:
        tool_name: 工具名称.
        arguments: 工具参数字典.
    """

    tool_name: str = Field(..., description="工具名称")
    arguments: dict[str, Any] = Field(
        default_factory=dict, description="工具参数字典"
    )


class RegisterServerRequest(BaseModel):
    """注册 MCP 服务器请求体.

    Attributes:
        name: 服务器唯一名称.
        command: STDIO 模式可执行命令.
        args: 命令参数列表.
        description: 描述.
        enabled: 是否启用.
        auto_start: 是否自动启动.
        transport: 传输类型 ("stdio" 或 "http+sse").
        url: HTTP/SSE 模式 SSE 端点 URL.
        tool_filtering: 是否启用工具过滤.
        allowed_tools: 允许工具列表.
        denied_tools: 禁用工具列表.
    """

    name: str = Field(..., description="服务器唯一名称")
    command: str = Field(..., description="STDIO 模式可执行命令")
    args: list[str] = Field(default_factory=list, description="命令参数列表")
    description: str = ""
    enabled: bool = True
    auto_start: bool = False
    transport: str = "stdio"
    url: str = ""
    tool_filtering: bool = False
    allowed_tools: list[str] | None = None
    denied_tools: list[str] | None = None


class SendMessageRequest(BaseModel):
    """发送原始 JSON-RPC 消息请求体.

    Attributes:
        message: 完整 JSON-RPC 请求体（必须含 method 字段）.
    """

    message: dict[str, Any] = Field(..., description="JSON-RPC 消息")


# ─────────────────────────────────────────────────────────────
# P3-#2: Sampling/Logging/Progress 请求体
# ─────────────────────────────────────────────────────────────


class SamplingMessageRequest(BaseModel):
    """sampling/createMessage 请求体.

    Attributes:
        messages: 采样消息列表，每项含 role/content.
        system_prompt: 系统提示词（可选）.
        max_tokens: 最大生成 token 数（可选）.
        model_preferences: 模型偏好提示（可选）.
        stop_sequences: 停止序列列表（可选）.
    """

    messages: list[dict[str, Any]] = Field(
        ..., description="MCP 采样消息列表"
    )
    system_prompt: str | None = Field(
        default=None, description="系统提示词"
    )
    max_tokens: int | None = Field(
        default=None, description="最大生成 token 数"
    )
    model_preferences: dict[str, Any] | None = Field(
        default=None, description="模型偏好提示"
    )
    stop_sequences: list[str] | None = Field(
        default=None, description="停止序列列表"
    )


class SendLogRequest(BaseModel):
    """notifications/message 日志请求体.

    Attributes:
        level: 日志级别（debug/info/notice/warning/error/critical）.
        logger: 日志来源标识.
        data: 日志数据.
    """

    level: str = Field(..., description="日志级别")
    logger: str = Field(default="api", description="日志来源标识")
    data: Any = Field(default=None, description="日志数据")


class SendProgressRequest(BaseModel):
    """notifications/progress 进度请求体.

    Attributes:
        progress_token: 进度令牌.
        progress: 当前进度值.
        total: 总进度值（可选）.
        message: 进度描述（可选）.
    """

    progress_token: str = Field(..., description="进度令牌")
    progress: float = Field(..., description="当前进度值")
    total: float | None = Field(default=None, description="总进度值")
    message: str | None = Field(default=None, description="进度描述")


# ─────────────────────────────────────────────────────────────
# 服务器管理端点
# ─────────────────────────────────────────────────────────────


@router.get("/mcp/servers")
async def list_servers() -> dict[str, Any]:
    """列出所有已注册的 MCP 服务器及其状态.

    Returns:
        dict: {"servers": [...]} 每个元素包含 name、running、
        initialized、transport_type 等字段.
    """
    manager = _get_manager()
    servers = []
    for cfg in manager.get_all_servers():
        status = manager.get_server_status(cfg.name)
        servers.append({
            "name": cfg.name,
            "description": cfg.description,
            "enabled": cfg.enabled,
            "auto_start": cfg.auto_start,
            "transport": cfg.transport,
            "url": cfg.url,
            "running": status["running"],
            "initialized": status["initialized"],
            "transport_type": status.get("transport_type", "stdio"),
        })
    return {"servers": servers, "total": len(servers)}


@router.get("/mcp/servers/{name}/status")
async def get_server_status(name: str) -> dict[str, Any]:
    """获取指定 MCP 服务器的详细状态.

    Args:
        name: 服务器名称.

    Returns:
        dict: 服务器状态信息.

    Raises:
        HTTPException: 服务器不存在时返回 404.
    """
    manager = _get_manager()
    cfg = manager.get_server_config(name)
    if not cfg:
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    return {"name": name, "status": manager.get_server_status(name)}


@router.post("/mcp/servers/{name}/start")
async def start_server(name: str) -> dict[str, Any]:
    """启动指定 MCP 服务器.

    Args:
        name: 服务器名称.

    Returns:
        dict: {"success": bool, "name": str}.

    Raises:
        HTTPException: 服务器不存在时返回 404.
    """
    manager = _get_manager()
    cfg = manager.get_server_config(name)
    if not cfg:
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    try:
        success = await manager.start_server(name)
        return {"success": success, "name": name}
    except Exception as e:
        log.error("Start MCP server failed", name=name, error=str(e))
        return {"success": False, "name": name, "error": str(e)}


@router.post("/mcp/servers/{name}/stop")
async def stop_server(name: str) -> dict[str, Any]:
    """停止指定 MCP 服务器.

    Args:
        name: 服务器名称.

    Returns:
        dict: {"success": bool, "name": str}.

    Raises:
        HTTPException: 服务器不存在时返回 404.
    """
    manager = _get_manager()
    cfg = manager.get_server_config(name)
    if not cfg:
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    try:
        success = manager.stop_server(name)
        return {"success": success, "name": name}
    except Exception as e:
        log.error("Stop MCP server failed", name=name, error=str(e))
        return {"success": False, "name": name, "error": str(e)}


@router.post("/mcp/servers/start-all")
async def start_all_servers() -> dict[str, Any]:
    """启动所有已启用且未运行的 MCP 服务器.

    Returns:
        dict: {"success": bool, "running": int, "total": int}.
    """
    manager = _get_manager()
    try:
        await manager.start_all_servers()
        running = manager.get_running_server_count()
        total = manager.get_server_count()
        return {"success": True, "running": running, "total": total}
    except Exception as e:
        log.error("Start all MCP servers failed", error=str(e))
        return {"success": False, "error": str(e)}


@router.get("/mcp/servers/{name}/tools")
async def list_tools(name: str) -> dict[str, Any]:
    """列出指定 MCP 服务器的可用工具.

    通过 MCPServerManager.list_tools 发送 tools/list JSON-RPC 请求。

    Args:
        name: 服务器名称.

    Returns:
        dict: {"tools": [...], "server": name}.

    Raises:
        HTTPException: 服务器不存在返回 404；列出失败返回 500.
    """
    manager = _get_manager()
    if not manager.get_server_config(name):
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    try:
        tools = await manager.list_tools(name)
        return {"tools": tools, "server": name}
    except Exception as e:
        log.error("List MCP tools failed", name=name, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/mcp/servers/{name}/message")
async def send_message(name: str, req: SendMessageRequest) -> dict[str, Any]:
    """向指定 MCP 服务器发送原始 JSON-RPC 消息（透传）.

    通过 MCPServerManager.send_message 发送完整 JSON-RPC 请求并透传响应。

    Args:
        name: 服务器名称.
        req: 含完整 JSON-RPC message 的请求体.

    Returns:
        dict: {"response": ..., "server": name}.

    Raises:
        HTTPException: 服务器不存在返回 404；发送失败返回 500.
    """
    manager = _get_manager()
    if not manager.get_server_config(name):
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    try:
        response = await manager.send_message(name, req.message)
        return {"response": response, "server": name}
    except Exception as e:
        log.error("Send MCP message failed", name=name, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/mcp/register")
async def register_server(req: RegisterServerRequest) -> dict[str, Any]:
    """注册一个新的 MCP 服务器配置.

    委托 MCPServerManager.register_server 将配置写入注册表并持久化。

    Args:
        req: 服务器配置请求体.

    Returns:
        dict: {"success": bool, "name": str}.
    """
    manager = _get_manager()
    try:
        config = MCPServerConfig(
            name=req.name,
            command=req.command,
            args=req.args,
            description=req.description,
            enabled=req.enabled,
            auto_start=req.auto_start,
            transport=req.transport,
            url=req.url,
            tool_filtering=req.tool_filtering,
            allowed_tools=req.allowed_tools,
            denied_tools=req.denied_tools,
        )
        manager.register_server(config)
        return {"success": True, "name": req.name}
    except Exception as e:
        log.error("Register MCP server failed", name=req.name, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────────────────────
# Resources 端点
# ─────────────────────────────────────────────────────────────


@router.get("/mcp/servers/{name}/resources")
async def list_resources(name: str) -> dict[str, Any]:
    """列出指定 MCP 服务器的可用资源.

    通过 MCPToolBridge.list_resources 发送 resources/list JSON-RPC 请求。

    Args:
        name: 服务器名称.

    Returns:
        dict: {"resources": [...], "server": name}.

    Raises:
        HTTPException: 服务器不存在返回 404；bridge 不可用返回 503.
    """
    manager = _get_manager()
    if not manager.get_server_config(name):
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    bridge = _get_bridge()
    if not bridge:
        raise HTTPException(status_code=503, detail="MCP Tool Bridge 不可用")
    resources = await bridge.list_resources(name)
    return {"resources": resources, "server": name}


@router.post("/mcp/servers/{name}/resources/read")
async def read_resource(name: str, req: ReadResourceRequest) -> dict[str, Any]:
    """读取指定 MCP 服务器的资源内容.

    通过 MCPToolBridge.read_resource 发送 resources/read JSON-RPC 请求。

    Args:
        name: 服务器名称.
        req: 包含 uri 的请求体.

    Returns:
        dict: {"contents": [...], "server": name, "uri": str}.

    Raises:
        HTTPException: 服务器不存在返回 404；bridge 不可用返回 503.
    """
    manager = _get_manager()
    if not manager.get_server_config(name):
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    bridge = _get_bridge()
    if not bridge:
        raise HTTPException(status_code=503, detail="MCP Tool Bridge 不可用")
    result = await bridge.read_resource(name, req.uri)
    return {"contents": result.get("contents", []), "server": name, "uri": req.uri}


# ─────────────────────────────────────────────────────────────
# Prompts 端点
# ─────────────────────────────────────────────────────────────


@router.get("/mcp/servers/{name}/prompts")
async def list_prompts(name: str) -> dict[str, Any]:
    """列出指定 MCP 服务器的可用提示模板.

    通过 MCPToolBridge.list_prompts 发送 prompts/list JSON-RPC 请求。

    Args:
        name: 服务器名称.

    Returns:
        dict: {"prompts": [...], "server": name}.

    Raises:
        HTTPException: 服务器不存在返回 404；bridge 不可用返回 503.
    """
    manager = _get_manager()
    if not manager.get_server_config(name):
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    bridge = _get_bridge()
    if not bridge:
        raise HTTPException(status_code=503, detail="MCP Tool Bridge 不可用")
    prompts = await bridge.list_prompts(name)
    return {"prompts": prompts, "server": name}


@router.post("/mcp/servers/{name}/prompts/get")
async def get_prompt(name: str, req: GetPromptRequest) -> dict[str, Any]:
    """获取指定 MCP 服务器的提示内容.

    通过 MCPToolBridge.get_prompt 发送 prompts/get JSON-RPC 请求。

    Args:
        name: 服务器名称.
        req: 包含 name 和可选 arguments 的请求体.

    Returns:
        dict: {"messages": [...], "server": name, "prompt_name": str}.

    Raises:
        HTTPException: 服务器不存在返回 404；bridge 不可用返回 503.
    """
    manager = _get_manager()
    if not manager.get_server_config(name):
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    bridge = _get_bridge()
    if not bridge:
        raise HTTPException(status_code=503, detail="MCP Tool Bridge 不可用")
    result = await bridge.get_prompt(name, req.name, req.arguments)
    return {
        "messages": result.get("messages", []),
        "server": name,
        "prompt_name": req.name,
    }


# ─────────────────────────────────────────────────────────────
# Tools 调用端点
# ─────────────────────────────────────────────────────────────


@router.post("/mcp/servers/{name}/tools/call")
async def call_tool(name: str, req: CallToolRequest) -> dict[str, Any]:
    """调用指定 MCP 服务器的工具.

    直接委托 MCPServerManager.call_tool 发送 tools/call JSON-RPC 请求，
    受服务器的 tool_filtering 配置约束。

    Args:
        name: 服务器名称.
        req: 包含 tool_name 和 arguments 的请求体.

    Returns:
        dict: {"result": Any, "server": name, "tool": str}.

    Raises:
        HTTPException: 服务器不存在返回 404；调用失败返回 500.
    """
    manager = _get_manager()
    if not manager.get_server_config(name):
        raise HTTPException(status_code=404, detail=f"MCP服务器 '{name}' 不存在")
    try:
        result = await manager.call_tool(name, req.tool_name, req.arguments)
        return {"result": result, "server": name, "tool": req.tool_name}
    except RuntimeError as e:
        error_msg = str(e)
        if "已被禁用" in error_msg or "禁用" in error_msg:
            log.warning("MCP tool disabled", name=name, tool=req.tool_name)
            raise HTTPException(status_code=403, detail=error_msg)
        log.error("Call MCP tool failed", name=name, tool=req.tool_name, error=error_msg)
        raise HTTPException(status_code=500, detail=error_msg)
    except Exception as e:
        log.error("Call MCP tool failed", name=name, tool=req.tool_name, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────────────────────
# P3-#2: Sampling/Logging/Progress 端点
# ─────────────────────────────────────────────────────────────


@router.post("/mcp/sampling")
async def mcp_sampling(req: SamplingMessageRequest) -> dict[str, Any]:
    """触发 MCP sampling/createMessage（本地直接调用）.

    通过 MCPServerManager.get_sampling_manager 直接调用 SamplingManager，
    利用项目自身的 LLMProvider 完成 LLM 推理。用于测试和外部触发采样。

    Args:
        req: 包含 messages 等字段的请求体.

    Returns:
        dict: {"result": SamplingResult, "success": bool}.

    Raises:
        HTTPException: LLMProvider 不可用或调用失败返回 500.
    """
    manager = _get_manager()
    sampling_manager = manager.get_sampling_manager()
    request_params: dict[str, Any] = {
        "messages": req.messages,
    }
    if req.system_prompt is not None:
        request_params["systemPrompt"] = req.system_prompt
    if req.max_tokens is not None:
        request_params["maxTokens"] = req.max_tokens
    if req.model_preferences is not None:
        request_params["modelPreferences"] = req.model_preferences
    if req.stop_sequences is not None:
        request_params["stopSequences"] = req.stop_sequences
    try:
        result = await sampling_manager.create_message(request_params)
        return {"result": result, "success": True}
    except Exception as e:
        log.error("MCP sampling failed", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/mcp/logging")
async def mcp_logging(req: SendLogRequest) -> dict[str, Any]:
    """发送 MCP notifications/message 日志通知.

    通过 MCPServerManager.get_logging_manager 将日志分发到所有订阅者。
    用于测试和外部触发日志分发。

    Args:
        req: 包含 level/logger/data 的请求体.

    Returns:
        dict: {"success": bool, "subscriber_count": int}.

    Raises:
        HTTPException: level 不合法返回 400；分发失败返回 500.
    """
    manager = _get_manager()
    logging_manager = manager.get_logging_manager()
    try:
        await logging_manager.send_log(req.level, req.logger, req.data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error("MCP logging failed", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "success": True,
        "subscriber_count": logging_manager.get_subscriber_count(),
    }


@router.post("/mcp/progress")
async def mcp_progress(req: SendProgressRequest) -> dict[str, Any]:
    """发送 MCP notifications/progress 进度通知.

    通过 MCPServerManager.get_progress_manager 将进度分发到所有匹配
    progress_token 的订阅者。用于测试和外部触发进度分发。

    Args:
        req: 包含 progress_token/progress/total/message 的请求体.

    Returns:
        dict: {"success": bool, "subscriber_count": int}.

    Raises:
        HTTPException: progress_token 为空返回 400；分发失败返回 500.
    """
    manager = _get_manager()
    progress_manager = manager.get_progress_manager()
    try:
        await progress_manager.send_progress(
            req.progress_token,
            req.progress,
            req.total,
            req.message,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error("MCP progress failed", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "success": True,
        "subscriber_count": progress_manager.get_subscriber_count(),
    }
