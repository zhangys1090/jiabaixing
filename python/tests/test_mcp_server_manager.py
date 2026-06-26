from __future__ import annotations

import pytest

from agent.mcp.server_manager import MCPServerConfig, MCPServerManager


# ═══════════════════════════════════════════════════════════════
# MCPServerConfig tests
# ═══════════════════════════════════════════════════════════════


class TestMCPServerConfig:
    def test_default_config(self):
        config = MCPServerConfig(
            name="test",
            command="echo",
            args=["hello"],
        )
        assert config.name == "test"
        assert config.command == "echo"
        assert config.args == ["hello"]
        assert config.enabled is True
        assert config.auto_start is False
        assert config.tool_filtering is False

    def test_config_with_tool_filtering(self):
        config = MCPServerConfig(
            name="test",
            command="echo",
            args=[],
            tool_filtering=True,
            allowed_tools=["tool_a", "tool_b"],
            denied_tools=["tool_c"],
        )
        assert config.tool_filtering is True
        assert config.allowed_tools == ["tool_a", "tool_b"]
        assert config.denied_tools == ["tool_c"]


# ═══════════════════════════════════════════════════════════════
# MCPServerManager tests
# ═══════════════════════════════════════════════════════════════


class TestMCPServerManager:
    def setup_method(self):
        MCPServerManager.reset_instance()

    def test_singleton(self):
        m1 = MCPServerManager.get_instance()
        m2 = MCPServerManager.get_instance()
        assert m1 is m2

    def test_reset_instance(self):
        m1 = MCPServerManager.get_instance()
        MCPServerManager.reset_instance()
        m2 = MCPServerManager.get_instance()
        assert m1 is not m2

    def test_default_servers_registered(self):
        manager = MCPServerManager()
        servers = manager.get_all_servers()
        names = [s.name for s in servers]
        assert "filesystem" in names
        assert "sqlite" in names
        assert "browser" in names
        assert "cron" in names

    def test_register_custom_server(self):
        manager = MCPServerManager()
        config = MCPServerConfig(
            name="custom-server",
            command="custom-cmd",
            args=["--flag"],
            description="自定义服务器",
        )
        manager.register_server(config)
        retrieved = manager.get_server_config("custom-server")
        assert retrieved is not None
        assert retrieved.command == "custom-cmd"

    def test_unregister_server(self):
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="to-remove",
            command="cmd",
            args=[],
        ))
        assert manager.get_server_config("to-remove") is not None
        manager.unregister_server("to-remove")
        assert manager.get_server_config("to-remove") is None

    def test_get_server_config_not_found(self):
        manager = MCPServerManager()
        assert manager.get_server_config("nonexistent") is None

    def test_get_running_servers_empty(self):
        manager = MCPServerManager()
        assert manager.get_running_servers() == []

    def test_get_server_count(self):
        manager = MCPServerManager()
        assert manager.get_server_count() >= 4  # 4 default servers

    def test_get_running_server_count(self):
        manager = MCPServerManager()
        assert manager.get_running_server_count() == 0

    def test_server_status_not_running(self):
        manager = MCPServerManager()
        status = manager.get_server_status("filesystem")
        assert status["running"] is False
        assert status["initialized"] is False

    def test_get_all_server_status(self):
        manager = MCPServerManager()
        statuses = manager.get_all_server_status()
        assert "filesystem" in statuses
        assert "sqlite" in statuses

    def test_server_health_not_running(self):
        manager = MCPServerManager()
        health = manager.get_server_health("filesystem")
        assert health["running"] is False
        assert health["healthy"] is False

    def test_get_all_server_health(self):
        manager = MCPServerManager()
        health = manager.get_all_server_health()
        assert "filesystem" in health

    def test_stop_server_not_running(self):
        manager = MCPServerManager()
        assert manager.stop_server("nonexistent") is False

    def test_filter_tools_no_filtering(self):
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="test",
            command="echo",
            args=[],
            tool_filtering=False,
        ))
        tools = [{"name": "a"}, {"name": "b"}, {"name": "c"}]
        filtered = manager.filter_tools("test", tools)
        assert len(filtered) == 3

    def test_filter_tools_allowed(self):
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="test",
            command="echo",
            args=[],
            tool_filtering=True,
            allowed_tools=["a", "c"],
        ))
        tools = [{"name": "a"}, {"name": "b"}, {"name": "c"}]
        filtered = manager.filter_tools("test", tools)
        assert len(filtered) == 2
        names = [t["name"] for t in filtered]
        assert "a" in names
        assert "c" in names
        assert "b" not in names

    def test_filter_tools_denied(self):
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="test",
            command="echo",
            args=[],
            tool_filtering=True,
            denied_tools=["b"],
        ))
        tools = [{"name": "a"}, {"name": "b"}, {"name": "c"}]
        filtered = manager.filter_tools("test", tools)
        assert len(filtered) == 2
        names = [t["name"] for t in filtered]
        assert "a" in names
        assert "c" in names

    def test_filter_tools_denied_priority(self):
        manager = MCPServerManager()
        manager.register_server(MCPServerConfig(
            name="test",
            command="echo",
            args=[],
            tool_filtering=True,
            allowed_tools=["a", "b"],
            denied_tools=["b"],
        ))
        tools = [{"name": "a"}, {"name": "b"}]
        filtered = manager.filter_tools("test", tools)
        assert len(filtered) == 1
        assert filtered[0]["name"] == "a"

    def test_register_message_handler(self):
        manager = MCPServerManager()
        received: list[dict] = []

        def handler(msg: dict):
            received.append(msg)

        manager.register_message_handler("test", handler)
        assert "test" in manager._message_handlers

    def test_unregister_message_handler(self):
        manager = MCPServerManager()
        manager.register_message_handler("test", lambda msg: None)
        manager.unregister_message_handler("test")
        assert "test" not in manager._message_handlers

    def test_event_handling(self):
        manager = MCPServerManager()
        received: list[dict] = []

        def handler(data):
            received.append(data)

        manager.on("serverStarted", handler)
        manager._emit("serverStarted", {"name": "test"})
        assert len(received) == 1
        assert received[0]["name"] == "test"

    def test_stop_all_servers_empty(self):
        manager = MCPServerManager()
        manager.stop_all_servers()
        assert manager.get_running_server_count() == 0

    @pytest.mark.asyncio
    async def test_call_tool_not_running(self):
        manager = MCPServerManager()
        with pytest.raises(RuntimeError, match="未运行"):
            await manager.call_tool("nonexistent", "test_tool", {})

    @pytest.mark.asyncio
    async def test_list_tools_not_running(self):
        manager = MCPServerManager()
        with pytest.raises(RuntimeError, match="未运行"):
            await manager.list_tools("nonexistent")

    def test_reload_config(self):
        manager = MCPServerManager()
        manager.reload_config()
        assert manager.get_server_count() >= 4
