"""P3-#2 MCP Sampling/Logging/Progress 三类原语单元测试.

覆盖范围：
- MCPSamplingManager: create_message 成功/失败、消息格式转换、stop_reason 映射、
  provider 注入与解析（set_provider/set_provider_factory/engine 回退）.
- MCPLoggingManager: 6 个日志级别分发、非法级别校验、订阅/退订、
  级别过滤、同步/异步订阅者、订阅者异常隔离、build_notification.
- MCPProgressManager: 进度通知全字段/最小字段、空 token 校验、订阅/退订、
  token 过滤、同步/异步订阅者、订阅者异常隔离、build_notification.
- MCPServerManager 集成: 三个 Manager 访问器、_dispatch_incoming_method
  对 sampling/logging/progress 的分发、_send_response 写入 stdin.
- 传输层扩展: BaseMCPTransport._handle_jsonrpc_message 处理 Server→Client
  请求（id+method）、StdioMCPTransport/HttpSseMCPTransport.send_response.
- HTTP API 端点: POST /mcp/sampling、POST /mcp/logging、POST /mcp/progress.

遵循测试规范：
- 异步测试使用 ``pytest.mark.asyncio``.
- 单例测试使用 ``MCPServerManager.reset_instance()`` 隔离.
- 不依赖真实 LLM 与真实 MCP 服务器，使用 AsyncMock/MagicMock 模拟.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent.api.mcp import router as mcp_router
from agent.mcp.logging import (
    LOG_LEVEL_CRITICAL,
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_ERROR,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_WARNING,
    MCPLoggingManager,
    VALID_LOG_LEVELS,
)
from agent.mcp.progress import MCPProgressManager
from agent.mcp.sampling import (
    MCPSamplingManager,
    STOP_REASON_END_TURN,
    STOP_REASON_MAX_TOKENS,
    STOP_REASON_STOP_SEQUENCE,
)
from agent.mcp.server_manager import (
    METHOD_NOTIFICATION_LOG,
    METHOD_NOTIFICATION_PROGRESS,
    METHOD_SAMPLING_CREATE,
    MCPServerManager,
)
from agent.mcp.transport import (
    HttpSseMCPTransport,
    MCPTransportConfig,
    StdioMCPTransport,
)


# ═══════════════════════════════════════════════════════════════
# MCPSamplingManager 单元测试
# ═══════════════════════════════════════════════════════════════


class TestMCPSamplingManager:
    """Sampling 原语管理器测试."""

    @pytest.mark.asyncio
    async def test_create_message_success(self) -> None:
        """成功调用 LLM 并返回符合 MCP 规范的 SamplingResult."""
        manager = MCPSamplingManager()
        # 模拟 LLMProvider
        mock_provider = MagicMock()
        mock_provider.model = "openai/gpt-4"
        mock_provider.chat = AsyncMock(return_value={
            "content": "Hello from LLM",
            "role": "assistant",
            "finish_reason": "stop",
            "model": "openai/gpt-4",
        })
        manager.set_provider(mock_provider)

        request = {
            "messages": [
                {"role": "user", "content": "你好"},
            ],
            "systemPrompt": "你是助手",
            "maxTokens": 100,
        }
        result = await manager.create_message(request)

        assert result["role"] == "assistant"
        assert result["content"]["type"] == "text"
        assert result["content"]["text"] == "Hello from LLM"
        assert result["model"] == "openai/gpt-4"
        assert result["stopReason"] == STOP_REASON_END_TURN
        # 验证 provider.chat 调用参数
        mock_provider.chat.assert_awaited_once()
        call_kwargs = mock_provider.chat.call_args.kwargs
        assert call_kwargs["messages"] == [{"role": "user", "content": "你好"}]
        assert call_kwargs["system_prompt"] == "你是助手"
        assert call_kwargs["use_cache"] is False

    @pytest.mark.asyncio
    async def test_create_message_with_dict_content(self) -> None:
        """MCP 消息的 content 为 {"type": "text", "text": ...} 对象时正确转换."""
        manager = MCPSamplingManager()
        mock_provider = MagicMock()
        mock_provider.model = "openai/gpt-4"
        mock_provider.chat = AsyncMock(return_value={
            "content": "OK",
            "role": "assistant",
            "finish_reason": "stop",
        })
        manager.set_provider(mock_provider)

        request = {
            "messages": [
                {"role": "user", "content": {"type": "text", "text": "用对象表达的 content"}},
            ],
        }
        await manager.create_message(request)

        call_kwargs = mock_provider.chat.call_args.kwargs
        assert call_kwargs["messages"] == [
            {"role": "user", "content": "用对象表达的 content"}
        ]

    @pytest.mark.asyncio
    async def test_create_message_missing_messages_raises(self) -> None:
        """缺少 messages 字段时抛出 ValueError."""
        manager = MCPSamplingManager()
        mock_provider = MagicMock()
        manager.set_provider(mock_provider)

        with pytest.raises(ValueError, match="messages"):
            await manager.create_message({"systemPrompt": "x"})

    @pytest.mark.asyncio
    async def test_create_message_empty_messages_raises(self) -> None:
        """messages 为空列表时抛出 ValueError."""
        manager = MCPSamplingManager()
        mock_provider = MagicMock()
        manager.set_provider(mock_provider)

        with pytest.raises(ValueError, match="messages"):
            await manager.create_message({"messages": []})

    @pytest.mark.asyncio
    async def test_create_message_non_dict_raises(self) -> None:
        """request 非 dict 时抛出 ValueError."""
        manager = MCPSamplingManager()
        with pytest.raises(ValueError, match="dict"):
            await manager.create_message("not a dict")  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_create_message_no_provider_raises(self) -> None:
        """LLMProvider 不可用时抛出 RuntimeError."""
        manager = MCPSamplingManager()
        # 显式让 _resolve_provider 返回 None，避免依赖全局 engine 状态
        manager._resolve_provider = lambda: None  # type: ignore[assignment]
        with pytest.raises(RuntimeError, match="LLMProvider 不可用"):
            await manager.create_message({"messages": [{"role": "user", "content": "x"}]})

    @pytest.mark.asyncio
    async def test_create_message_provider_failure_propagates(self) -> None:
        """LLM 调用失败时抛出 RuntimeError 并包装原始异常."""
        manager = MCPSamplingManager()
        mock_provider = MagicMock()
        mock_provider.model = "openai/gpt-4"
        mock_provider.chat = AsyncMock(side_effect=RuntimeError("网络错误"))
        manager.set_provider(mock_provider)

        with pytest.raises(RuntimeError, match="LLM 调用失败"):
            await manager.create_message({"messages": [{"role": "user", "content": "x"}]})

    @pytest.mark.asyncio
    async def test_create_message_stop_reason_max_tokens(self) -> None:
        """finish_reason='length' 映射为 stopReason='maxTokens'."""
        manager = MCPSamplingManager()
        mock_provider = MagicMock()
        mock_provider.model = "openai/gpt-4"
        mock_provider.chat = AsyncMock(return_value={
            "content": "x",
            "finish_reason": "length",
        })
        manager.set_provider(mock_provider)

        result = await manager.create_message({"messages": [{"role": "user", "content": "x"}]})
        assert result["stopReason"] == STOP_REASON_MAX_TOKENS

    @pytest.mark.asyncio
    async def test_create_message_stop_reason_stop_sequence(self) -> None:
        """finish_reason='stop' 且提供 stopSequences 时映射为 stopSequence."""
        manager = MCPSamplingManager()
        mock_provider = MagicMock()
        mock_provider.model = "openai/gpt-4"
        mock_provider.chat = AsyncMock(return_value={
            "content": "x",
            "finish_reason": "stop",
        })
        manager.set_provider(mock_provider)

        result = await manager.create_message({
            "messages": [{"role": "user", "content": "x"}],
            "stopSequences": ["END"],
        })
        assert result["stopReason"] == STOP_REASON_STOP_SEQUENCE

    @pytest.mark.asyncio
    async def test_set_provider_factory(self) -> None:
        """set_provider_factory 注册的工厂返回值被用作 provider."""
        manager = MCPSamplingManager()
        mock_provider = MagicMock()
        mock_provider.model = "factory-model"
        mock_provider.chat = AsyncMock(return_value={
            "content": "from factory",
            "finish_reason": "stop",
        })
        manager.set_provider_factory(lambda: mock_provider)

        result = await manager.create_message({"messages": [{"role": "user", "content": "x"}]})
        assert result["content"]["text"] == "from factory"
        assert result["model"] == "factory-model"

    @pytest.mark.asyncio
    async def test_create_message_falls_back_to_provider_model(self) -> None:
        """LLM 响应未携带 model 字段时回退到 provider.model."""
        manager = MCPSamplingManager()
        mock_provider = MagicMock()
        mock_provider.model = "provider-model"
        mock_provider.chat = AsyncMock(return_value={
            "content": "x",
            "finish_reason": "stop",
            # 不返回 model
        })
        manager.set_provider(mock_provider)

        result = await manager.create_message({"messages": [{"role": "user", "content": "x"}]})
        assert result["model"] == "provider-model"


# ═══════════════════════════════════════════════════════════════
# MCPLoggingManager 单元测试
# ═══════════════════════════════════════════════════════════════


class TestMCPLoggingManager:
    """Logging 原语管理器测试."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("level", sorted(VALID_LOG_LEVELS))
    async def test_send_log_all_levels(self, level: str) -> None:
        """6 个日志级别都能正确分发到订阅者."""
        manager = MCPLoggingManager()
        received: list[tuple[str, str, Any]] = []
        manager.subscribe(lambda lvl, log, data: received.append((lvl, log, data)))

        await manager.send_log(level, "test-logger", {"msg": "hello"})

        assert len(received) == 1
        assert received[0] == (level, "test-logger", {"msg": "hello"})

    @pytest.mark.asyncio
    async def test_send_log_invalid_level_raises(self) -> None:
        """非法级别抛出 ValueError."""
        manager = MCPLoggingManager()
        with pytest.raises(ValueError, match="非法日志级别"):
            await manager.send_log("trace", "test", None)

    @pytest.mark.asyncio
    async def test_send_log_to_async_handler(self) -> None:
        """异步订阅者被正确 await."""
        manager = MCPLoggingManager()
        received: list[tuple[str, str, Any]] = []

        async def handler(level: str, logger_name: str, data: Any) -> None:
            received.append((level, logger_name, data))

        manager.subscribe(handler)
        await manager.send_log(LOG_LEVEL_INFO, "async", {"k": "v"})
        assert received == [(LOG_LEVEL_INFO, "async", {"k": "v"})]

    @pytest.mark.asyncio
    async def test_subscribe_min_level_filter(self) -> None:
        """订阅者 min_level 过滤低于阈值的日志."""
        manager = MCPLoggingManager()
        received: list[str] = []
        manager.subscribe(
            lambda lvl, log, data: received.append(lvl),
            min_level=LOG_LEVEL_WARNING,
        )

        # 低于 warning 的级别不应分发
        await manager.send_log(LOG_LEVEL_DEBUG, "test", None)
        await manager.send_log(LOG_LEVEL_INFO, "test", None)
        await manager.send_log(LOG_LEVEL_NOTICE, "test", None)
        # >= warning 的级别应分发
        await manager.send_log(LOG_LEVEL_WARNING, "test", None)
        await manager.send_log(LOG_LEVEL_ERROR, "test", None)
        await manager.send_log(LOG_LEVEL_CRITICAL, "test", None)

        assert received == [LOG_LEVEL_WARNING, LOG_LEVEL_ERROR, LOG_LEVEL_CRITICAL]

    @pytest.mark.asyncio
    async def test_subscribe_invalid_min_level_raises(self) -> None:
        """非法 min_level 抛出 ValueError."""
        manager = MCPLoggingManager()
        with pytest.raises(ValueError, match="非法日志级别"):
            manager.subscribe(lambda *args: None, min_level="trace")

    @pytest.mark.asyncio
    async def test_subscriber_exception_isolation(self) -> None:
        """单个订阅者异常不影响其他订阅者."""
        manager = MCPLoggingManager()
        received: list[str] = []

        def bad_handler(level: str, logger_name: str, data: Any) -> None:
            raise RuntimeError("subscriber failure")

        def good_handler(level: str, logger_name: str, data: Any) -> None:
            received.append(level)

        manager.subscribe(bad_handler)
        manager.subscribe(good_handler)

        # bad_handler 抛异常不应中断 good_handler
        await manager.send_log(LOG_LEVEL_INFO, "test", None)
        assert received == [LOG_LEVEL_INFO]

    @pytest.mark.asyncio
    async def test_unsubscribe(self) -> None:
        """unsubscribe 成功取消订阅."""
        manager = MCPLoggingManager()
        received: list[str] = []
        handler = lambda lvl, log, data: received.append(lvl)  # noqa: E731
        manager.subscribe(handler)
        assert manager.get_subscriber_count() == 1

        await manager.send_log(LOG_LEVEL_INFO, "test", None)
        assert received == [LOG_LEVEL_INFO]

        assert manager.unsubscribe(handler) is True
        assert manager.get_subscriber_count() == 0
        # 取消后再发送不应触发 handler
        await manager.send_log(LOG_LEVEL_INFO, "test", None)
        assert received == [LOG_LEVEL_INFO]  # 仍是 1 条

    def test_unsubscribe_not_registered(self) -> None:
        """unsubscribe 未注册的 handler 返回 False."""
        manager = MCPLoggingManager()
        assert manager.unsubscribe(lambda *args: None) is False

    def test_clear_subscribers(self) -> None:
        """clear_subscribers 清空所有订阅者."""
        manager = MCPLoggingManager()
        manager.subscribe(lambda *args: None)
        manager.subscribe(lambda *args: None)
        assert manager.get_subscriber_count() == 2
        manager.clear_subscribers()
        assert manager.get_subscriber_count() == 0

    def test_build_notification_valid(self) -> None:
        """build_notification 返回符合 MCP 规范的 JSON-RPC 通知."""
        manager = MCPLoggingManager()
        notification = manager.build_notification(
            LOG_LEVEL_ERROR, "my-logger", {"err": "fail"}
        )
        assert notification["jsonrpc"] == "2.0"
        assert notification["method"] == "notifications/message"
        assert notification["params"] == {
            "level": LOG_LEVEL_ERROR,
            "logger": "my-logger",
            "data": {"err": "fail"},
        }

    def test_build_notification_invalid_level(self) -> None:
        """build_notification 非法级别抛出 ValueError."""
        manager = MCPLoggingManager()
        with pytest.raises(ValueError):
            manager.build_notification("trace", "x", None)


# ═══════════════════════════════════════════════════════════════
# MCPProgressManager 单元测试
# ═══════════════════════════════════════════════════════════════


class TestMCPProgressManager:
    """Progress 原语管理器测试."""

    @pytest.mark.asyncio
    async def test_send_progress_full_fields(self) -> None:
        """带全字段的进度通知被正确分发."""
        manager = MCPProgressManager()
        received: list[tuple[str, float, float | None, str | None]] = []
        manager.subscribe(
            lambda token, progress, total, message: received.append(
                (token, progress, total, message)
            )
        )

        await manager.send_progress("task-1", 0.5, 1.0, "half done")

        assert received == [("task-1", 0.5, 1.0, "half done")]

    @pytest.mark.asyncio
    async def test_send_progress_minimal_fields(self) -> None:
        """仅必填字段的进度通知被正确分发."""
        manager = MCPProgressManager()
        received: list[tuple[str, float, float | None, str | None]] = []
        manager.subscribe(
            lambda token, progress, total, message: received.append(
                (token, progress, total, message)
            )
        )

        await manager.send_progress("task-2", 0.3)

        assert received == [("task-2", 0.3, None, None)]

    @pytest.mark.asyncio
    async def test_send_progress_empty_token_raises(self) -> None:
        """空 progress_token 抛出 ValueError."""
        manager = MCPProgressManager()
        with pytest.raises(ValueError, match="progress_token"):
            await manager.send_progress("", 0.5)

    @pytest.mark.asyncio
    async def test_send_progress_to_async_handler(self) -> None:
        """异步订阅者被正确 await."""
        manager = MCPProgressManager()
        received: list[tuple[str, float]] = []

        async def handler(token: str, progress: float, total, message) -> None:
            received.append((token, progress))

        manager.subscribe(handler)
        await manager.send_progress("async-task", 0.7)
        assert received == [("async-task", 0.7)]

    @pytest.mark.asyncio
    async def test_subscribe_token_filter(self) -> None:
        """progress_token 过滤：仅匹配相同 token 的订阅者收到通知."""
        manager = MCPProgressManager()
        received_a: list[str] = []
        received_b: list[str] = []
        received_all: list[str] = []

        manager.subscribe(
            lambda token, p, t, m: received_a.append(token),
            progress_token="task-A",
        )
        manager.subscribe(
            lambda token, p, t, m: received_b.append(token),
            progress_token="task-B",
        )
        manager.subscribe(
            lambda token, p, t, m: received_all.append(token),
        )

        await manager.send_progress("task-A", 0.1)
        await manager.send_progress("task-B", 0.2)
        await manager.send_progress("task-C", 0.3)

        # task-A 仅 A 和 all 收到
        assert received_a == ["task-A"]
        assert received_b == ["task-B"]
        assert received_all == ["task-A", "task-B", "task-C"]

    @pytest.mark.asyncio
    async def test_subscriber_exception_isolation(self) -> None:
        """单个订阅者异常不影响其他订阅者."""
        manager = MCPProgressManager()
        received: list[str] = []

        def bad_handler(token: str, progress: float, total, message) -> None:
            raise RuntimeError("subscriber failure")

        def good_handler(token: str, progress: float, total, message) -> None:
            received.append(token)

        manager.subscribe(bad_handler)
        manager.subscribe(good_handler)

        await manager.send_progress("task", 0.5)
        assert received == ["task"]

    @pytest.mark.asyncio
    async def test_unsubscribe(self) -> None:
        """unsubscribe 成功取消订阅."""
        manager = MCPProgressManager()
        received: list[str] = []
        handler = lambda token, p, t, m: received.append(token)  # noqa: E731
        manager.subscribe(handler)
        assert manager.get_subscriber_count() == 1

        await manager.send_progress("task", 0.1)
        assert received == ["task"]

        assert manager.unsubscribe(handler) is True
        assert manager.get_subscriber_count() == 0
        await manager.send_progress("task", 0.2)
        assert received == ["task"]  # 仍是 1 条

    def test_build_notification_full(self) -> None:
        """build_notification 返回符合 MCP 规范的 JSON-RPC 通知（全字段）."""
        manager = MCPProgressManager()
        notification = manager.build_notification("tok", 0.5, 1.0, "half")
        assert notification["jsonrpc"] == "2.0"
        assert notification["method"] == "notifications/progress"
        assert notification["params"] == {
            "progressToken": "tok",
            "progress": 0.5,
            "total": 1.0,
            "message": "half",
        }

    def test_build_notification_minimal(self) -> None:
        """build_notification 仅必填字段时 params 不含可选字段."""
        manager = MCPProgressManager()
        notification = manager.build_notification("tok", 0.3)
        assert notification["params"] == {
            "progressToken": "tok",
            "progress": 0.3,
        }
        # 不应包含 total/message 键
        assert "total" not in notification["params"]
        assert "message" not in notification["params"]

    def test_build_notification_empty_token_raises(self) -> None:
        """build_notification 空 token 抛出 ValueError."""
        manager = MCPProgressManager()
        with pytest.raises(ValueError, match="progress_token"):
            manager.build_notification("", 0.5)


# ═══════════════════════════════════════════════════════════════
# MCPServerManager 集成测试
# ═══════════════════════════════════════════════════════════════


class TestMCPServerManagerIntegration:
    """三个原语 Manager 与 MCPServerManager 的集成测试."""

    def setup_method(self) -> None:
        """每个测试前重置单例，避免状态泄漏."""
        MCPServerManager.reset_instance()

    def teardown_method(self) -> None:
        MCPServerManager.reset_instance()

    def test_manager_accessors(self) -> None:
        """三个 Manager 访问器返回正确类型的实例."""
        manager = MCPServerManager()
        assert isinstance(manager.get_sampling_manager(), MCPSamplingManager)
        assert isinstance(manager.get_logging_manager(), MCPLoggingManager)
        assert isinstance(manager.get_progress_manager(), MCPProgressManager)

    def test_reset_instance_clears_subscribers(self) -> None:
        """reset_instance 清空 logging/progress 订阅者."""
        manager = MCPServerManager()
        manager.get_logging_manager().subscribe(lambda *args: None)
        manager.get_progress_manager().subscribe(lambda *args: None)
        assert manager.get_logging_manager().get_subscriber_count() == 1
        assert manager.get_progress_manager().get_subscriber_count() == 1

        MCPServerManager.reset_instance()
        new_manager = MCPServerManager()
        assert new_manager.get_logging_manager().get_subscriber_count() == 0
        assert new_manager.get_progress_manager().get_subscriber_count() == 0

    @pytest.mark.asyncio
    async def test_dispatch_logging_routes_to_manager(self) -> None:
        """_dispatch_incoming_method 对 notifications/message 分发到 LoggingManager."""
        manager = MCPServerManager()
        received: list[tuple[str, str, Any]] = []
        manager.get_logging_manager().subscribe(
            lambda lvl, log, data: received.append((lvl, log, data))
        )

        message = {
            "jsonrpc": "2.0",
            "method": METHOD_NOTIFICATION_LOG,
            "params": {
                "level": LOG_LEVEL_WARNING,
                "logger": "server-x",
                "data": {"warn": "low disk"},
            },
        }
        await manager._dispatch_incoming_method("server-x", message)

        assert received == [(LOG_LEVEL_WARNING, "server-x", {"warn": "low disk"})]

    @pytest.mark.asyncio
    async def test_dispatch_logging_default_logger_name(self) -> None:
        """params.logger 缺失时使用 server name 作为 logger 名."""
        manager = MCPServerManager()
        received: list[str] = []
        manager.get_logging_manager().subscribe(
            lambda lvl, log, data: received.append(log)
        )

        message = {
            "jsonrpc": "2.0",
            "method": METHOD_NOTIFICATION_LOG,
            "params": {"level": LOG_LEVEL_INFO, "data": "x"},  # 缺 logger
        }
        await manager._dispatch_incoming_method("server-y", message)
        assert received == ["server-y"]

    @pytest.mark.asyncio
    async def test_dispatch_progress_routes_to_manager(self) -> None:
        """_dispatch_incoming_method 对 notifications/progress 分发到 ProgressManager."""
        manager = MCPServerManager()
        received: list[tuple[str, float, float | None, str | None]] = []
        manager.get_progress_manager().subscribe(
            lambda token, p, t, m: received.append((token, p, t, m))
        )

        message = {
            "jsonrpc": "2.0",
            "method": METHOD_NOTIFICATION_PROGRESS,
            "params": {
                "progressToken": "task-1",
                "progress": 0.5,
                "total": 1.0,
                "message": "half done",
            },
        }
        await manager._dispatch_incoming_method("server-x", message)

        assert received == [("task-1", 0.5, 1.0, "half done")]

    @pytest.mark.asyncio
    async def test_dispatch_sampling_calls_manager_and_send_response(self) -> None:
        """_dispatch_incoming_method 对 sampling/createMessage 调用 SamplingManager
        并通过 _send_response 回写 JSON-RPC 响应到 stdin."""
        manager = MCPServerManager()
        # 注入 mock provider
        mock_provider = MagicMock()
        mock_provider.model = "openai/gpt-4"
        mock_provider.chat = AsyncMock(return_value={
            "content": "hello",
            "finish_reason": "stop",
        })
        manager.get_sampling_manager().set_provider(mock_provider)

        # 构造一个 mock 的 stdio server_proc
        mock_proc = MagicMock()
        mock_proc.process.stdin = MagicMock()
        manager._processes["test-server"] = mock_proc

        message = {
            "jsonrpc": "2.0",
            "id": 42,
            "method": METHOD_SAMPLING_CREATE,
            "params": {
                "messages": [{"role": "user", "content": "hi"}],
            },
        }
        await manager._dispatch_incoming_method("test-server", message)

        # 验证 stdin 被写入响应
        mock_proc.process.stdin.write.assert_called_once()
        written_bytes = mock_proc.process.stdin.write.call_args.args[0]
        response = json.loads(written_bytes.decode("utf-8"))
        assert response["jsonrpc"] == "2.0"
        assert response["id"] == 42
        assert response["result"]["role"] == "assistant"
        assert response["result"]["content"]["text"] == "hello"
        assert response["result"]["stopReason"] == STOP_REASON_END_TURN

    @pytest.mark.asyncio
    async def test_dispatch_sampling_failure_sends_error_response(self) -> None:
        """sampling 处理失败时回送 JSON-RPC error 响应."""
        manager = MCPServerManager()
        # 显式让 _resolve_provider 返回 None，触发 create_message 抛 RuntimeError
        manager.get_sampling_manager()._resolve_provider = lambda: None  # type: ignore[assignment]
        mock_proc = MagicMock()
        mock_proc.process.stdin = MagicMock()
        manager._processes["test-server"] = mock_proc

        message = {
            "jsonrpc": "2.0",
            "id": "req-1",
            "method": METHOD_SAMPLING_CREATE,
            "params": {"messages": [{"role": "user", "content": "hi"}]},
        }
        await manager._dispatch_incoming_method("test-server", message)

        mock_proc.process.stdin.write.assert_called_once()
        written_bytes = mock_proc.process.stdin.write.call_args.args[0]
        response = json.loads(written_bytes.decode("utf-8"))
        assert response["id"] == "req-1"
        assert "error" in response
        assert response["error"]["code"] == -32603

    @pytest.mark.asyncio
    async def test_dispatch_unknown_method_no_op(self) -> None:
        """分发未知方法不应抛异常."""
        manager = MCPServerManager()
        message = {
            "jsonrpc": "2.0",
            "method": "some/unknown/method",
            "params": {},
        }
        # 不应抛异常
        await manager._dispatch_incoming_method("server", message)

    @pytest.mark.asyncio
    async def test_send_response_via_transport(self) -> None:
        """_send_response 优先走 transport.send_response 路径（HTTP/SSE 场景）."""
        manager = MCPServerManager()
        mock_transport = MagicMock()
        mock_transport.send_response = MagicMock()
        manager._transports["http-server"] = mock_transport

        await manager._send_response(
            "http-server", 99, result={"role": "assistant"}
        )

        mock_transport.send_response.assert_called_once_with(
            99, result={"role": "assistant"}, error=None
        )

    @pytest.mark.asyncio
    async def test_send_response_no_server_logs_warning(self) -> None:
        """服务器未运行时 _send_response 不抛异常（仅记录日志）."""
        manager = MCPServerManager()
        # 不应抛异常
        await manager._send_response("nonexistent", 1, result={"x": 1})


# ═══════════════════════════════════════════════════════════════
# 传输层扩展测试（Server→Client 请求路由 + send_response）
# ═══════════════════════════════════════════════════════════════


class TestTransportServerToClient:
    """传输层对 Server→Client 请求与 send_response 的支持."""

    def test_handle_jsonrpc_message_dispatches_server_to_client_request(self) -> None:
        """BaseMCPTransport._handle_jsonrpc_message 对 id+method 消息分发到
        on_request 注册的处理器."""
        config = MCPTransportConfig(command="echo")
        transport = StdioMCPTransport(config)
        received: list[dict] = []
        transport.on_request(
            METHOD_SAMPLING_CREATE,
            lambda message: received.append(message),
        )

        message = {
            "jsonrpc": "2.0",
            "id": 7,
            "method": METHOD_SAMPLING_CREATE,
            "params": {"messages": []},
        }
        transport._handle_jsonrpc_message(message)

        assert len(received) == 1
        assert received[0] == message

    def test_handle_jsonrpc_message_dispatches_notification(self) -> None:
        """BaseMCPTransport._handle_jsonrpc_message 对 method-only 消息分发到
        on_notification 注册的处理器."""
        config = MCPTransportConfig(command="echo")
        transport = StdioMCPTransport(config)
        received: list[dict] = []
        transport.on_notification(
            METHOD_NOTIFICATION_LOG,
            lambda params: received.append(params),
        )

        message = {
            "jsonrpc": "2.0",
            "method": METHOD_NOTIFICATION_LOG,
            "params": {"level": "info", "logger": "x", "data": "y"},
        }
        transport._handle_jsonrpc_message(message)

        assert received == [{"level": "info", "logger": "x", "data": "y"}]

    @pytest.mark.asyncio
    async def test_handle_jsonrpc_message_response_path_unchanged(self) -> None:
        """id+result 消息仍走响应路径（完成 pending future）."""
        config = MCPTransportConfig(command="echo")
        transport = StdioMCPTransport(config)
        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        transport._pending[1] = future

        message = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
        transport._handle_jsonrpc_message(message)

        assert future.done()
        assert future.result() == message

    def test_handle_jsonrpc_message_request_handler_exception_logged(self) -> None:
        """on_request 处理器抛异常时被捕获并记录（不影响后续消息）."""
        config = MCPTransportConfig(command="echo")
        transport = StdioMCPTransport(config)

        def bad_handler(message: dict) -> None:
            raise RuntimeError("handler failure")

        transport.on_request(METHOD_SAMPLING_CREATE, bad_handler)
        # 不应抛异常
        transport._handle_jsonrpc_message({
            "jsonrpc": "2.0",
            "id": 1,
            "method": METHOD_SAMPLING_CREATE,
            "params": {},
        })

    def test_stdio_send_response_writes_to_stdin(self) -> None:
        """StdioMCPTransport.send_response 将响应 JSON 写入子进程 stdin."""
        config = MCPTransportConfig(command="echo")
        transport = StdioMCPTransport(config)
        # 模拟已启动状态
        mock_process = MagicMock()
        mock_process.stdin = MagicMock()
        transport._process = mock_process

        transport.send_response(42, result={"role": "assistant"})

        mock_process.stdin.write.assert_called_once()
        written = mock_process.stdin.write.call_args.args[0]
        response = json.loads(written.decode("utf-8"))
        assert response["jsonrpc"] == "2.0"
        assert response["id"] == 42
        assert response["result"] == {"role": "assistant"}

    def test_stdio_send_response_with_error(self) -> None:
        """StdioMCPTransport.send_response 错误响应正确序列化."""
        config = MCPTransportConfig(command="echo")
        transport = StdioMCPTransport(config)
        mock_process = MagicMock()
        mock_process.stdin = MagicMock()
        transport._process = mock_process

        transport.send_response(99, error={"code": -32603, "message": "fail"})

        written = mock_process.stdin.write.call_args.args[0]
        response = json.loads(written.decode("utf-8"))
        assert response["id"] == 99
        assert response["error"] == {"code": -32603, "message": "fail"}
        assert "result" not in response

    def test_stdio_send_response_not_started_no_raise(self) -> None:
        """StdioMCPTransport 未启动时 send_response 不抛异常."""
        config = MCPTransportConfig(command="echo")
        transport = StdioMCPTransport(config)
        # 不应抛异常
        transport.send_response(1, result={"x": 1})

    @pytest.mark.asyncio
    async def test_http_sse_send_response_schedules_post(self) -> None:
        """HttpSseMCPTransport.send_response 通过 _post_notification 异步 POST.

        send_response 内部使用 asyncio.create_task 调度异步发送，
        需在事件循环中运行并让出控制权以触发任务执行。
        """
        config = MCPTransportConfig(url="http://example/sse")
        transport = HttpSseMCPTransport(config)
        transport._sse_endpoint = "http://example/msg"

        # 用 mock 替换 _post_notification 验证调度
        post_calls: list[dict] = []

        async def fake_post(message: dict) -> None:
            post_calls.append(message)

        transport._post_notification = fake_post  # type: ignore[assignment]

        transport.send_response(7, result={"ok": True})
        # 让出控制权使 create_task 调度的协程得以执行
        await asyncio.sleep(0)

        # 验证 _post_notification 被调用且消息体符合 JSON-RPC 响应格式
        assert len(post_calls) == 1
        assert post_calls[0]["jsonrpc"] == "2.0"
        assert post_calls[0]["id"] == 7
        assert post_calls[0]["result"] == {"ok": True}

    @pytest.mark.asyncio
    async def test_http_sse_send_response_posts_to_endpoint(self) -> None:
        """HttpSseMCPTransport.send_response 实际 POST 响应到 SSE 端点."""
        config = MCPTransportConfig(url="http://example/sse")
        transport = HttpSseMCPTransport(config)
        transport._sse_endpoint = "http://example/msg"

        # 模拟 httpx 客户端：必须显式设置 is_closed=False，
        # 否则 _ensure_client 会判定客户端已关闭而新建真实 httpx 客户端
        mock_client = MagicMock()
        mock_client.is_closed = False
        mock_client.post = AsyncMock()
        transport._client = mock_client

        transport.send_response(11, result={"role": "assistant"})
        # 让 create_task 执行：sleep(0) 让出一次控制权
        await asyncio.sleep(0)

        mock_client.post.assert_awaited_once()
        call_args = mock_client.post.call_args
        assert call_args.args[0] == "http://example/msg"
        posted = call_args.kwargs["json"]
        assert posted["id"] == 11
        assert posted["result"] == {"role": "assistant"}

    def test_on_request_registers_handler(self) -> None:
        """on_request 注册的处理器存入 _request_handlers."""
        config = MCPTransportConfig(command="echo")
        transport = StdioMCPTransport(config)
        handler = lambda msg: None  # noqa: E731
        transport.on_request("custom/method", handler)
        assert transport._request_handlers["custom/method"] is handler


# ═══════════════════════════════════════════════════════════════
# HTTP API 端点测试
# ═══════════════════════════════════════════════════════════════


class TestHTTPEndpoints:
    """POST /mcp/sampling、POST /mcp/logging、POST /mcp/progress 测试."""

    @pytest.fixture(autouse=True)
    def setup_manager(self) -> None:
        """每个测试前重置 MCPServerManager 单例."""
        MCPServerManager.reset_instance()

    @pytest.fixture
    def app(self) -> FastAPI:
        """提供挂载了 mcp_router 的 FastAPI app."""
        application = FastAPI()
        application.include_router(mcp_router, prefix="/v1")
        return application

    def test_post_logging_success(self, app: FastAPI) -> None:
        """POST /mcp/logging 成功分发日志到订阅者."""
        manager = MCPServerManager.get_instance()
        received: list[tuple[str, str, Any]] = []
        manager.get_logging_manager().subscribe(
            lambda lvl, log, data: received.append((lvl, log, data))
        )

        client = TestClient(app)
        response = client.post("/v1/mcp/logging", json={
            "level": "info",
            "logger": "api-test",
            "data": {"event": "test"},
        })

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["subscriber_count"] == 1
        assert received == [("info", "api-test", {"event": "test"})]

    def test_post_logging_invalid_level(self, app: FastAPI) -> None:
        """POST /mcp/logging 非法级别返回 400."""
        client = TestClient(app)
        response = client.post("/v1/mcp/logging", json={
            "level": "trace",
            "logger": "x",
            "data": None,
        })
        assert response.status_code == 400

    def test_post_progress_success(self, app: FastAPI) -> None:
        """POST /mcp/progress 成功分发进度到订阅者."""
        manager = MCPServerManager.get_instance()
        received: list[tuple[str, float, float | None, str | None]] = []
        manager.get_progress_manager().subscribe(
            lambda token, p, t, m: received.append((token, p, t, m))
        )

        client = TestClient(app)
        response = client.post("/v1/mcp/progress", json={
            "progress_token": "api-task",
            "progress": 0.75,
            "total": 1.0,
            "message": "three quarters",
        })

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        assert body["subscriber_count"] == 1
        assert received == [("api-task", 0.75, 1.0, "three quarters")]

    def test_post_progress_empty_token(self, app: FastAPI) -> None:
        """POST /mcp/progress 空 token 返回 400."""
        client = TestClient(app)
        response = client.post("/v1/mcp/progress", json={
            "progress_token": "",
            "progress": 0.5,
        })
        assert response.status_code == 400

    def test_post_sampling_success(self, app: FastAPI) -> None:
        """POST /mcp/sampling 成功调用 SamplingManager.create_message."""
        manager = MCPServerManager.get_instance()
        # 注入 mock provider
        mock_provider = MagicMock()
        mock_provider.model = "openai/gpt-4"
        mock_provider.chat = AsyncMock(return_value={
            "content": "API response",
            "finish_reason": "stop",
        })
        manager.get_sampling_manager().set_provider(mock_provider)

        client = TestClient(app)
        response = client.post("/v1/mcp/sampling", json={
            "messages": [{"role": "user", "content": "hi"}],
            "system_prompt": "be helpful",
            "max_tokens": 50,
        })

        assert response.status_code == 200
        body = response.json()
        assert body["success"] is True
        result = body["result"]
        assert result["role"] == "assistant"
        assert result["content"]["text"] == "API response"
        assert result["model"] == "openai/gpt-4"
        # 验证 provider.chat 被调用
        mock_provider.chat.assert_awaited_once()

    def test_post_sampling_no_provider_returns_500(self, app: FastAPI) -> None:
        """POST /mcp/sampling 在 LLMProvider 不可用时返回 500."""
        client = TestClient(app)
        response = client.post("/v1/mcp/sampling", json={
            "messages": [{"role": "user", "content": "hi"}],
        })
        assert response.status_code == 500

    def test_post_sampling_missing_messages_returns_422(self, app: FastAPI) -> None:
        """POST /mcp/sampling 缺少 messages 字段返回 422（Pydantic 校验失败）."""
        client = TestClient(app)
        response = client.post("/v1/mcp/sampling", json={
            "system_prompt": "x",
        })
        assert response.status_code == 422
