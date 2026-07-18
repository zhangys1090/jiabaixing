"""消息平台网关框架测试。

覆盖:
    - Message 数据模型
    - PlatformAdapter ABC 抽象约束
    - GatewayConfig 配置数据类
    - MessageDispatcher 消息分发
    - WebhookAdapter HTTP Webhook 适配器
    - APIServerAdapter HTTP API 服务端适配器
"""

from __future__ import annotations

import asyncio
import pytest
from datetime import datetime
from typing import AsyncIterator

from agent.gateway.base import GatewayConfig, Message, PlatformAdapter
from agent.gateway.dispatcher import MessageDispatcher
from agent.gateway.platform_manager import PlatformManager
from agent.gateway.platforms.relay_adapter import RelayAdapter


# ---------- 测试用 Mock 适配器 ----------


class MockAdapter(PlatformAdapter):
    """用于测试的 Mock 适配器。"""

    def __init__(self, adapter_name: str = "mock") -> None:
        self._name = adapter_name
        self._connected = False
        self._sent: list[tuple[str, str]] = []
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._started = False
        self._stopped = False

    @property
    def name(self) -> str:
        return self._name

    async def start(self) -> None:
        self._started = True
        self._connected = True

    async def stop(self) -> None:
        self._stopped = True
        self._connected = False

    async def send_message(self, chat_id: str, text: str) -> bool:
        if not self._connected:
            return False
        self._sent.append((chat_id, text))
        return True

    async def receive_message(self) -> AsyncIterator[Message]:
        while self._connected:
            try:
                msg = await asyncio.wait_for(self._queue.get(), timeout=0.5)
                yield msg
            except asyncio.TimeoutError:
                continue

    async def is_connected(self) -> bool:
        return self._connected

    async def enqueue(self, content: str, sender: str = "tester") -> None:
        """辅助方法：向队列放入消息。"""
        msg = Message(
            platform=self._name,
            sender=sender,
            content=content,
        )
        await self._queue.put(msg)


# ---------- Message 测试 ----------


class TestMessage:
    """Message 数据模型测试。"""

    def test_default_values(self) -> None:
        """默认值应正确生成。"""
        msg = Message()
        assert msg.id  # 非空 UUID
        assert msg.platform == ""
        assert msg.sender == ""
        assert msg.content == ""
        assert isinstance(msg.timestamp, datetime)
        assert msg.metadata == {}

    def test_custom_values(self) -> None:
        """自定义值应正确设置。"""
        now = datetime.now()
        msg = Message(
            id="test-123",
            platform="feishu",
            sender="user_a",
            content="你好",
            timestamp=now,
            metadata={"channel": "general"},
        )
        assert msg.id == "test-123"
        assert msg.platform == "feishu"
        assert msg.sender == "user_a"
        assert msg.content == "你好"
        assert msg.timestamp == now
        assert msg.metadata["channel"] == "general"

    def test_unique_ids(self) -> None:
        """每次创建的 id 应唯一。"""
        ids = {Message().id for _ in range(100)}
        assert len(ids) == 100


# ---------- GatewayConfig 测试 ----------


class TestGatewayConfig:
    """GatewayConfig 配置数据类测试。"""

    def test_default_config(self) -> None:
        """默认配置值应正确。"""
        config = GatewayConfig()
        assert config.host == "0.0.0.0"
        assert config.port == 8765
        assert config.max_retries == 3
        assert config.reconnect_interval == 5.0
        assert config.platforms == {}

    def test_custom_config(self) -> None:
        """自定义配置应正确设置。"""
        config = GatewayConfig(
            host="127.0.0.1",
            port=9999,
            max_retries=5,
            reconnect_interval=10.0,
            platforms={"feishu": {"app_id": "x"}},
        )
        assert config.host == "127.0.0.1"
        assert config.port == 9999
        assert config.max_retries == 5
        assert config.reconnect_interval == 10.0
        assert "feishu" in config.platforms


# ---------- PlatformAdapter ABC 测试 ----------


class TestPlatformAdapterABC:
    """PlatformAdapter 抽象基类约束测试。"""

    def test_cannot_instantiate_abc(self) -> None:
        """不能直接实例化抽象基类。"""
        with pytest.raises(TypeError):
            PlatformAdapter()  # type: ignore

    def test_must_implement_abstract_methods(self) -> None:
        """子类必须实现所有抽象方法。"""

        class IncompleteAdapter(PlatformAdapter):
            @property
            def name(self) -> str:
                return "incomplete"

        with pytest.raises(TypeError):
            IncompleteAdapter()  # type: ignore


# ---------- MessageDispatcher 测试 ----------


class TestMessageDispatcher:
    """MessageDispatcher 消息分发中心测试。"""

    @pytest.mark.asyncio
    async def test_register_and_list_adapters(self) -> None:
        """注册适配器后应可列出。"""
        dispatcher = MessageDispatcher()
        adapter = MockAdapter("test_adapter")
        dispatcher.register_adapter("test_adapter", adapter)
        assert "test_adapter" in dispatcher.list_adapters()

    @pytest.mark.asyncio
    async def test_unregister_adapter(self) -> None:
        """注销适配器后应不可列出。"""
        dispatcher = MessageDispatcher()
        adapter = MockAdapter("to_remove")
        dispatcher.register_adapter("to_remove", adapter)
        dispatcher.unregister_adapter("to_remove")
        assert "to_remove" not in dispatcher.list_adapters()

    @pytest.mark.asyncio
    async def test_get_adapter(self) -> None:
        """应能按名称获取适配器。"""
        dispatcher = MessageDispatcher()
        adapter = MockAdapter("findable")
        dispatcher.register_adapter("findable", adapter)
        result = dispatcher.get_adapter("findable")
        assert result is adapter

    @pytest.mark.asyncio
    async def test_get_adapter_not_found(self) -> None:
        """获取不存在的适配器应返回 None。"""
        dispatcher = MessageDispatcher()
        assert dispatcher.get_adapter("nonexistent") is None

    @pytest.mark.asyncio
    async def test_dispatch_without_handler(self) -> None:
        """未设置 handler 时分发应返回提示文本。"""
        dispatcher = MessageDispatcher()
        msg = Message(platform="test", content="hello")
        result = await dispatcher.dispatch(msg)
        assert "未设置" in result

    @pytest.mark.asyncio
    async def test_dispatch_with_handler(self) -> None:
        """设置 handler 后分发应调用 handler。"""

        async def handler(m: Message) -> str:
            return f"echo: {m.content}"

        dispatcher = MessageDispatcher()
        dispatcher.set_handler(handler)
        msg = Message(platform="test", content="hello")
        result = await dispatcher.dispatch(msg)
        assert result == "echo: hello"

    @pytest.mark.asyncio
    async def test_dispatch_handler_exception(self) -> None:
        """handler 抛出异常时应返回错误信息。"""

        async def bad_handler(m: Message) -> str:
            raise ValueError("boom")

        dispatcher = MessageDispatcher()
        dispatcher.set_handler(bad_handler)
        msg = Message(platform="test", content="hello")
        result = await dispatcher.dispatch(msg)
        assert "消息处理失败" in result
        assert "boom" in result

    @pytest.mark.asyncio
    async def test_broadcast(self) -> None:
        """广播应向所有已连接适配器发送消息。"""
        dispatcher = MessageDispatcher()
        a1 = MockAdapter("a1")
        a2 = MockAdapter("a2")
        await a1.start()
        await a2.start()
        dispatcher.register_adapter("a1", a1)
        dispatcher.register_adapter("a2", a2)

        results = await dispatcher.broadcast("announcement")
        assert results["a1"] is True
        assert results["a2"] is True
        assert ("", "announcement") in a1._sent
        assert ("", "announcement") in a2._sent

    @pytest.mark.asyncio
    async def test_broadcast_disconnected(self) -> None:
        """未连接的适配器广播应失败。"""
        dispatcher = MessageDispatcher()
        adapter = MockAdapter("offline")
        # 不调用 start()，_connected 为 False
        dispatcher.register_adapter("offline", adapter)
        results = await dispatcher.broadcast("msg")
        assert results["offline"] is False

    @pytest.mark.asyncio
    async def test_register_overwrite(self) -> None:
        """注册同名适配器应覆盖旧实例。"""
        dispatcher = MessageDispatcher()
        a1 = MockAdapter("dup")
        a2 = MockAdapter("dup")
        dispatcher.register_adapter("dup", a1)
        dispatcher.register_adapter("dup", a2)
        assert dispatcher.get_adapter("dup") is a2


# ---------- WebhookAdapter 测试 ----------


class TestWebhookAdapter:
    """WebhookAdapter HTTP Webhook 适配器测试。"""

    def test_name_property(self) -> None:
        """name 属性应返回 'webhook'。"""
        from agent.gateway.platforms.webhook_adapter import WebhookAdapter

        adapter = WebhookAdapter()
        assert adapter.name == "webhook"

    @pytest.mark.asyncio
    async def test_send_message_returns_false(self) -> None:
        """Webhook 适配器不支持主动发送消息。"""
        from agent.gateway.platforms.webhook_adapter import WebhookAdapter

        adapter = WebhookAdapter()
        result = await adapter.send_message("chat1", "hello")
        assert result is False

    @pytest.mark.asyncio
    async def test_start_and_is_connected(self) -> None:
        """启动后连接状态应为 True。"""
        from agent.gateway.platforms.webhook_adapter import WebhookAdapter

        adapter = WebhookAdapter(port=19001)
        await adapter.start()
        assert await adapter.is_connected() is True
        await adapter.stop()
        assert await adapter.is_connected() is False

    @pytest.mark.asyncio
    async def test_webhook_endpoint_receives_message(self) -> None:
        """Webhook 端点应接收入站消息并入队。"""
        import httpx
        from agent.gateway.platforms.webhook_adapter import WebhookAdapter

        adapter = WebhookAdapter(port=19002)
        await adapter.start()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"http://127.0.0.1:19002/webhook/webhook",
                    json={"content": "test message", "sender": "tester"},
                    timeout=5.0,
                )
                assert resp.status_code == 200
                body = resp.json()
                assert body["status"] == "ok"
                assert "message_id" in body

            # 从队列消费消息
            msg = await asyncio.wait_for(adapter._queue.get(), timeout=2.0)
            assert msg.content == "test message"
            assert msg.sender == "tester"
            assert msg.platform == "webhook"
        finally:
            await adapter.stop()

    @pytest.mark.asyncio
    async def test_webhook_missing_content_returns_400(self) -> None:
        """缺少 content 字段应返回 400。"""
        import httpx
        from agent.gateway.platforms.webhook_adapter import WebhookAdapter

        adapter = WebhookAdapter(port=19003)
        await adapter.start()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"http://127.0.0.1:19003/webhook/webhook",
                    json={"sender": "tester"},
                    timeout=5.0,
                )
                assert resp.status_code == 400
        finally:
            await adapter.stop()

    @pytest.mark.asyncio
    async def test_health_endpoint(self) -> None:
        """健康检查端点应返回正常状态。"""
        import httpx
        from agent.gateway.platforms.webhook_adapter import WebhookAdapter

        adapter = WebhookAdapter(port=19004)
        await adapter.start()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"http://127.0.0.1:19004/health",
                    timeout=5.0,
                )
                assert resp.status_code == 200
                body = resp.json()
                assert body["status"] == "healthy"
        finally:
            await adapter.stop()


# ---------- APIServerAdapter 测试 ----------


class TestAPIServerAdapter:
    """APIServerAdapter HTTP API 服务端适配器测试。"""

    def test_name_property(self) -> None:
        """name 属性应返回 'api_server'。"""
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        adapter = APIServerAdapter()
        assert adapter.name == "api_server"

    @pytest.mark.asyncio
    async def test_start_and_is_connected(self) -> None:
        """启动后连接状态应为 True。"""
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        adapter = APIServerAdapter(port=19011)
        await adapter.start()
        assert await adapter.is_connected() is True
        await adapter.stop()
        assert await adapter.is_connected() is False

    @pytest.mark.asyncio
    async def test_chat_endpoint_async(self) -> None:
        """异步 /chat 端点应接受消息。"""
        import httpx
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        adapter = APIServerAdapter(port=19012)
        await adapter.start()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"http://127.0.0.1:19012/chat",
                    json={"message": "hello", "sender": "user1"},
                    timeout=5.0,
                )
                assert resp.status_code == 200
                body = resp.json()
                assert body["status"] == "accepted"
                assert "message_id" in body

            # 从队列消费消息
            msg = await asyncio.wait_for(adapter._queue.get(), timeout=2.0)
            assert msg.content == "hello"
            assert msg.sender == "user1"
            assert msg.platform == "api_server"
        finally:
            await adapter.stop()

    @pytest.mark.asyncio
    async def test_chat_endpoint_sync(self) -> None:
        """同步 /chat 端点应等待处理结果后返回。"""
        import httpx
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        adapter = APIServerAdapter(port=19013)
        await adapter.start()

        async def process_and_respond() -> None:
            """从队列取出消息并通过 send_message 返回响应。"""
            msg = await asyncio.wait_for(adapter._queue.get(), timeout=5.0)
            await adapter.send_message(msg.id, f"reply: {msg.content}")

        try:
            # 并发启动消费任务
            task = asyncio.create_task(process_and_respond())

            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"http://127.0.0.1:19013/chat",
                    json={"message": "hello", "sync": True, "request_id": "sync-test-1"},
                    timeout=10.0,
                )
                assert resp.status_code == 200
                body = resp.json()
                assert body["status"] == "ok"
                assert body["response"] == "reply: hello"

            await task
        finally:
            await adapter.stop()

    @pytest.mark.asyncio
    async def test_chat_missing_content_returns_400(self) -> None:
        """缺少 message 字段应返回 400。"""
        import httpx
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        adapter = APIServerAdapter(port=19014)
        await adapter.start()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"http://127.0.0.1:19014/chat",
                    json={"sender": "user1"},
                    timeout=5.0,
                )
                assert resp.status_code == 400
        finally:
            await adapter.stop()

    @pytest.mark.asyncio
    async def test_health_endpoint(self) -> None:
        """健康检查端点应返回正常状态。"""
        import httpx
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        adapter = APIServerAdapter(port=19015)
        await adapter.start()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"http://127.0.0.1:19015/health",
                    timeout=5.0,
                )
                assert resp.status_code == 200
                body = resp.json()
                assert body["status"] == "healthy"
        finally:
            await adapter.stop()

    @pytest.mark.asyncio
    async def test_adapters_endpoint(self) -> None:
        """/adapters 端点应返回适配器状态。"""
        import httpx
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        adapter = APIServerAdapter(port=19016)
        await adapter.start()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"http://127.0.0.1:19016/adapters",
                    timeout=5.0,
                )
                assert resp.status_code == 200
                body = resp.json()
                assert body["adapter"] == "api_server"
                assert body["connected"] is True
        finally:
            await adapter.stop()

    @pytest.mark.asyncio
    async def test_send_message_no_pending(self) -> None:
        """向不存在的请求发送响应应返回 False。"""
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        adapter = APIServerAdapter()
        result = await adapter.send_message("nonexistent", "text")
        assert result is False


# ---------- 集成测试：Dispatcher + Adapters ----------


class TestGatewayIntegration:
    """网关集成测试：Dispatcher 与 Adapters 联动。"""

    @pytest.mark.asyncio
    async def test_dispatcher_with_webhook(self) -> None:
        """Dispatcher 应能分发来自 Webhook 的消息。"""
        import httpx
        from agent.gateway.platforms.webhook_adapter import WebhookAdapter

        dispatcher = MessageDispatcher()

        async def handler(msg: Message) -> str:
            return f"processed: {msg.content}"

        dispatcher.set_handler(handler)

        adapter = WebhookAdapter(port=19021)
        await adapter.start()
        dispatcher.register_adapter("webhook", adapter)

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"http://127.0.0.1:19021/webhook/webhook",
                    json={"content": "integration test"},
                    timeout=5.0,
                )
                assert resp.status_code == 200

            # 消费消息并分发
            msg = await asyncio.wait_for(adapter._queue.get(), timeout=2.0)
            result = await dispatcher.dispatch(msg)
            assert result == "processed: integration test"
        finally:
            await adapter.stop()

    @pytest.mark.asyncio
    async def test_full_pipeline_api_server(self) -> None:
        """完整 API Server 管线测试：入站 -> 处理 -> 响应。"""
        import httpx
        from agent.gateway.platforms.api_server_adapter import APIServerAdapter

        dispatcher = MessageDispatcher()

        async def handler(msg: Message) -> str:
            return f"AI: {msg.content}"

        dispatcher.set_handler(handler)

        adapter = APIServerAdapter(port=19022)
        await adapter.start()
        dispatcher.register_adapter("api_server", adapter)

        async def consume_and_respond() -> None:
            """消费消息：分发处理后回写响应。"""
            msg = await asyncio.wait_for(adapter._queue.get(), timeout=5.0)
            result = await dispatcher.dispatch(msg)
            await adapter.send_message(msg.id, result)

        try:
            task = asyncio.create_task(consume_and_respond())

            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"http://127.0.0.1:19022/chat",
                    json={"message": "hello world", "sync": True},
                    timeout=10.0,
                )
                assert resp.status_code == 200
                body = resp.json()
                assert body["response"] == "AI: hello world"

            await task
        finally:
            await adapter.stop()


# ---------- PlatformManager 测试 ----------


class TestPlatformManager:
    """多平台适配器管理器测试（填补此前零覆盖盲区）。"""

    def _make_mgr(self) -> PlatformManager:
        mgr = PlatformManager()
        mgr.register("alpha", MockAdapter("alpha"))
        mgr.register("beta", MockAdapter("beta"))
        return mgr

    def test_register_and_lookup(self) -> None:
        mgr = self._make_mgr()
        assert mgr.get_adapter("alpha") is not None
        assert mgr.get_adapter("beta") is not None
        assert "alpha" in mgr.list_platforms()
        assert "beta" in mgr.list_platforms()

    async def test_register_creates_status(self) -> None:
        mgr = PlatformManager()
        mgr.register("alpha", MockAdapter("alpha"))
        status = await mgr.get_status("alpha")
        assert status is not None
        assert status.name == "alpha"
        assert status.connected is False

    async def test_unregister_removes(self) -> None:
        mgr = self._make_mgr()
        mgr.unregister("alpha")
        assert mgr.get_adapter("alpha") is None
        assert "alpha" not in mgr.list_platforms()
        assert await mgr.get_status("alpha") is None

    def test_get_adapter_unknown(self) -> None:
        mgr = PlatformManager()
        assert mgr.get_adapter("nope") is None

    def test_add_message_handler(self) -> None:
        mgr = PlatformManager()
        handler = lambda m: None  # noqa: E731
        mgr.add_message_handler(handler)
        assert handler in mgr._message_handlers

    async def test_start_all_marks_connected(self) -> None:
        mgr = self._make_mgr()
        results = await mgr.start_all()
        assert results == {"alpha": True, "beta": True}
        assert mgr.is_running is True
        assert (await mgr.get_status("alpha")).connected is True
        assert (await mgr.get_status("beta")).connected is True

    async def test_start_unknown_returns_false(self) -> None:
        mgr = PlatformManager()
        assert await mgr.start("ghost") is False

    async def test_stop_unknown_returns_false(self) -> None:
        mgr = PlatformManager()
        assert await mgr.stop("ghost") is False

    async def test_send_message_routes_to_adapter(self) -> None:
        mgr = self._make_mgr()
        await mgr.start_all()
        ok = await mgr.send_message("alpha", "u1", "hello")
        assert ok is True
        assert ("u1", "hello") in mgr.get_adapter("alpha")._sent
        assert (await mgr.get_status("alpha")).message_count == 1
        assert (await mgr.get_status("alpha")).error_count == 0

    async def test_send_message_unknown_platform_false(self) -> None:
        mgr = PlatformManager()
        assert await mgr.send_message("ghost", "u", "x") is False

    async def test_send_message_records_error_on_adapter_failure(self) -> None:
        class FailingAdapter(MockAdapter):
            async def send_message(self, chat_id: str, text: str) -> bool:
                raise RuntimeError("boom")

        mgr = PlatformManager()
        mgr.register("fail", FailingAdapter("fail"))
        await mgr.start("fail")
        assert await mgr.send_message("fail", "u", "x") is False
        assert (await mgr.get_status("fail")).error_count == 1

    async def test_broadcast_to_all(self) -> None:
        mgr = self._make_mgr()
        await mgr.start_all()
        results = await mgr.broadcast("hi all")
        assert results == {"alpha": True, "beta": True}

    async def test_broadcast_specific_platforms(self) -> None:
        mgr = self._make_mgr()
        await mgr.start_all()
        results = await mgr.broadcast("hi", platforms=["alpha"])
        assert results == {"alpha": True}

    async def test_stop_all_sets_running_false(self) -> None:
        mgr = self._make_mgr()
        await mgr.start_all()
        assert mgr.is_running is True
        await mgr.stop_all()
        assert mgr.is_running is False

    def test_get_stats_aggregation(self) -> None:
        mgr = self._make_mgr()
        stats = mgr.get_stats()
        assert stats["platforms"] == 2
        assert stats["running"] is False
        assert stats["connected"] == 0
        assert stats["total_messages"] == 0
        assert stats["total_errors"] == 0

    async def test_get_all_statuses_reflects_connection(self) -> None:
        mgr = self._make_mgr()
        mgr.get_adapter("alpha")._connected = True
        all_status = await mgr.get_all_statuses()
        assert all_status["alpha"].connected is True
        assert all_status["beta"].connected is False


# ---------- RelayAdapter 测试 ----------


class TestRelayAdapter:
    """WebSocket 中继适配器测试（填补此前零覆盖盲区）。"""

    def test_name_is_relay(self) -> None:
        assert RelayAdapter().name == "relay"

    async def test_initially_disconnected(self) -> None:
        a = RelayAdapter()
        assert await a.is_connected() is False

    def test_get_stats_structure(self) -> None:
        a = RelayAdapter()
        s = a.get_stats()
        assert s["connected"] is False
        assert "session_id" in s
        assert s["reconnect_count"] == 0
        assert s["sent"] == 0
        assert s["received"] == 0
        assert s["errors"] == 0

    async def test_start_without_url_enters_simulate_mode(self) -> None:
        a = RelayAdapter()  # 无 relay_url
        await a.start()
        assert await a.is_connected() is True  # 模拟模式

    async def test_send_message_in_simulate_mode_returns_true(self) -> None:
        a = RelayAdapter()
        await a.start()
        ok = await a.send_message("chat1", "payload")
        assert ok is True
        assert a.get_stats()["sent"] == 1

    async def test_stop_is_safe_when_not_started(self) -> None:
        a = RelayAdapter()
        await a.stop()  # 不应抛异常
        assert await a.is_connected() is False

    def test_encode_decode_roundtrip_small_uncompressed(self) -> None:
        a = RelayAdapter(compression=False)
        data = {"type": "message", "content": "你好", "n": 1}
        enc = a._encode(data)
        assert isinstance(enc, str)
        assert a._decode(enc) == data

    def test_encode_decode_roundtrip_large_gzip(self) -> None:
        a = RelayAdapter(compression=True)
        data = {"content": "x" * 5000, "meta": {"a": 1}}
        enc = a._encode(data)
        assert isinstance(enc, bytes)  # 超过 1KB 触发 gzip
        assert a._decode(enc) == data

    def test_decode_plain_bytes(self) -> None:
        import json

        a = RelayAdapter()
        raw = json.dumps({"x": 2}).encode()
        assert a._decode(raw) == {"x": 2}

    def test_decode_gzip_bytes(self) -> None:
        import gzip
        import json

        a = RelayAdapter()
        raw = gzip.compress(json.dumps({"x": 1}).encode())
        assert a._decode(raw) == {"x": 1}
