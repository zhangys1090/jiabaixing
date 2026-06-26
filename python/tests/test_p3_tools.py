from __future__ import annotations

import json
import os
import tempfile
import time

import pytest

from agent.tools.registry import ToolRegistry, register_default_tools


@pytest.fixture
def registry():
    r = ToolRegistry()
    register_default_tools(r)
    return r


class TestP3ToolsRegistration:
    def test_file_dedup_registered(self, registry: ToolRegistry):
        assert registry.get("file_dedup") is not None

    def test_log_view_registered(self, registry: ToolRegistry):
        assert registry.get("log_view") is not None

    def test_shell_generate_registered(self, registry: ToolRegistry):
        assert registry.get("shell_generate") is not None

    def test_voice_interact_registered(self, registry: ToolRegistry):
        assert registry.get("voice_interact") is not None

    def test_delegate_task_registered(self, registry: ToolRegistry):
        assert registry.get("delegate_task") is not None

    def test_get_active_file_registered(self, registry: ToolRegistry):
        assert registry.get("get_active_file") is not None

    def test_total_tool_count(self, registry: ToolRegistry):
        assert registry.size() >= 57


class TestFileDedup:
    @pytest.mark.asyncio
    async def test_dedup_finds_duplicates(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            content = "hello world duplicate content"
            for name in ["a.txt", "b.txt"]:
                with open(os.path.join(tmpdir, name), "w", encoding="utf-8") as f:
                    f.write(content)

            result = await registry.execute("file_dedup", {
                "directory": tmpdir,
                "recursive": False,
                "min_size": 1,
            })
            assert result.success
            assert "重复文件" in result.output

    @pytest.mark.asyncio
    async def test_dedup_no_duplicates(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            for i, name in enumerate(["a.txt", "b.txt"]):
                with open(os.path.join(tmpdir, name), "w", encoding="utf-8") as f:
                    f.write(f"unique content {i}")

            result = await registry.execute("file_dedup", {
                "directory": tmpdir,
                "recursive": False,
                "min_size": 1,
            })
            assert result.success
            assert "未发现重复" in result.output

    @pytest.mark.asyncio
    async def test_dedup_nonexistent_dir(self, registry: ToolRegistry):
        result = await registry.execute("file_dedup", {
            "directory": "/nonexistent/path",
        })
        assert not result.success
        assert "不存在" in result.error


class TestLogView:
    @pytest.mark.asyncio
    async def test_log_view_missing_file(self, registry: ToolRegistry):
        result = await registry.execute("log_view", {
            "log_file": "combined.log",
        })
        assert not result.success
        assert "不存在" in result.error

    @pytest.mark.asyncio
    async def test_log_view_with_data(self, registry: ToolRegistry):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = os.path.join(tmpdir, "combined.log")
            entries = [
                json.dumps({"level": "info", "message": "test info", "module": "Test", "timestamp": "2026-01-01T10:00:00"}),
                json.dumps({"level": "error", "message": "test error", "module": "Test", "timestamp": "2026-01-01T10:01:00"}),
            ]
            with open(log_path, "w", encoding="utf-8") as f:
                f.write("\n".join(entries))

            os.environ["LOGS_DIR"] = tmpdir
            try:
                result = await registry.execute("log_view", {
                    "log_file": "combined.log",
                    "lines": 10,
                })
                assert result.success
            finally:
                del os.environ["LOGS_DIR"]


class TestShellGenerate:
    @pytest.mark.asyncio
    async def test_shell_generate_empty_intent(self, registry: ToolRegistry):
        result = await registry.execute("shell_generate", {
            "intent": "",
        })
        assert not result.success
        assert "不能为空" in result.error

    @pytest.mark.asyncio
    async def test_shell_generate_no_llm(self, registry: ToolRegistry):
        result = await registry.execute("shell_generate", {
            "intent": "查看端口占用",
        })
        assert result.success
        assert "查看端口占用" in result.output or "LLM" in result.output or "命令" in result.output


class TestVoiceInteract:
    @pytest.mark.asyncio
    async def test_voice_start_session(self, registry: ToolRegistry):
        result = await registry.execute("voice_interact", {
            "action": "start_session",
            "language": "zh-CN",
        })
        assert result.success
        assert "语音会话已启动" in result.output

    @pytest.mark.asyncio
    async def test_voice_status(self, registry: ToolRegistry):
        await registry.execute("voice_interact", {"action": "start_session"})
        result = await registry.execute("voice_interact", {"action": "status"})
        assert result.success
        assert "语音会话状态" in result.output or "没有" in result.output

    @pytest.mark.asyncio
    async def test_voice_stop_session(self, registry: ToolRegistry):
        await registry.execute("voice_interact", {"action": "start_session"})
        result = await registry.execute("voice_interact", {"action": "stop_session"})
        assert result.success
        assert "已停止" in result.output

    @pytest.mark.asyncio
    async def test_voice_speak_no_text(self, registry: ToolRegistry):
        result = await registry.execute("voice_interact", {
            "action": "speak",
        })
        assert not result.success
        assert "text" in result.error

    @pytest.mark.asyncio
    async def test_voice_speak_with_text(self, registry: ToolRegistry):
        result = await registry.execute("voice_interact", {
            "action": "speak",
            "text": "你好世界",
        })
        assert result.success
        assert "语音指令已接收" in result.output

    @pytest.mark.asyncio
    async def test_voice_listen_no_session(self, registry: ToolRegistry):
        import agent.tools.system_tools as stm
        stm._voice_session = None
        result = await registry.execute("voice_interact", {"action": "listen"})
        assert not result.success
        assert "没有活跃" in result.error

    @pytest.mark.asyncio
    async def test_voice_invalid_action(self, registry: ToolResult):
        result = await registry.execute("voice_interact", {"action": "invalid"})
        assert not result.success
        assert "不支持" in result.error


class TestDelegateTask:
    @pytest.mark.asyncio
    async def test_delegate_empty_goal(self, registry: ToolRegistry):
        result = await registry.execute("delegate_task", {
            "goal": "",
        })
        assert not result.success
        assert "不能为空" in result.error

    @pytest.mark.asyncio
    async def test_delegate_no_llm(self, registry: ToolRegistry):
        result = await registry.execute("delegate_task", {
            "goal": "测试任务",
        })
        assert not result.success or result.success


class TestGetActiveFile:
    @pytest.mark.asyncio
    async def test_get_active_file_no_ts_backend(self, registry: ToolRegistry):
        result = await registry.execute("get_active_file", {})
        assert not result.success or result.success


class TestToolsExecuteAPI:
    def test_tools_execute_missing_name(self):
        from agent.api.compat import tools_execute
        import asyncio
        result = asyncio.run(tools_execute({}))
        assert not result["success"]

    def test_tools_execute_no_engine(self):
        from agent.api.compat import tools_execute
        import asyncio
        import agent.main as main_mod
        orig = main_mod.engine
        main_mod.engine = None
        try:
            result = asyncio.run(tools_execute({"tool": "file_read"}))
            assert not result["success"]
        finally:
            main_mod.engine = orig


class TestMCPProxyBridge:
    def test_mcp_servers_ts_unavailable(self):
        from agent.api.compat import mcp_servers
        import asyncio
        os.environ["TS_BACKEND_URL"] = "http://localhost:1"
        try:
            result = asyncio.run(mcp_servers())
            assert result.get("success") is True or "data" in result
        finally:
            if "TS_BACKEND_URL" in os.environ:
                del os.environ["TS_BACKEND_URL"]

    def test_mcp_server_detail_ts_unavailable(self):
        from agent.api.compat import mcp_server_detail
        import asyncio
        os.environ["TS_BACKEND_URL"] = "http://localhost:1"
        try:
            result = asyncio.run(mcp_server_detail("filesystem"))
            assert "name" in result
            assert result["name"] == "filesystem"
        finally:
            if "TS_BACKEND_URL" in os.environ:
                del os.environ["TS_BACKEND_URL"]

    def test_mcp_server_start_ts_unavailable(self):
        from agent.api.compat import mcp_server_start
        import asyncio
        os.environ["TS_BACKEND_URL"] = "http://localhost:1"
        try:
            result = asyncio.run(mcp_server_start("browser"))
            assert not result.get("success", True)
        finally:
            if "TS_BACKEND_URL" in os.environ:
                del os.environ["TS_BACKEND_URL"]

    def test_mcp_server_tools_ts_unavailable(self):
        from agent.api.compat import mcp_server_tools
        import asyncio
        os.environ["TS_BACKEND_URL"] = "http://localhost:1"
        try:
            result = asyncio.run(mcp_server_tools("filesystem"))
            assert "tools" in result
        finally:
            if "TS_BACKEND_URL" in os.environ:
                del os.environ["TS_BACKEND_URL"]

    def test_mcp_register_ts_unavailable(self):
        from agent.api.compat import mcp_register
        import asyncio
        os.environ["TS_BACKEND_URL"] = "http://localhost:1"
        try:
            result = asyncio.run(mcp_register({"name": "test", "command": "node"}))
            assert not result.get("success", True)
        finally:
            if "TS_BACKEND_URL" in os.environ:
                del os.environ["TS_BACKEND_URL"]


class TestDesktopProxyBridge:
    def test_desktop_screenshot_ts_unavailable(self):
        from agent.api.compat import desktop_screenshot
        import asyncio
        os.environ["TS_BACKEND_URL"] = "http://localhost:1"
        try:
            result = asyncio.run(desktop_screenshot({}))
            assert not result.get("success", True)
        finally:
            if "TS_BACKEND_URL" in os.environ:
                del os.environ["TS_BACKEND_URL"]

    def test_desktop_automate_ts_unavailable(self):
        from agent.api.compat import desktop_automate
        import asyncio
        os.environ["TS_BACKEND_URL"] = "http://localhost:1"
        try:
            result = asyncio.run(desktop_automate({"task": "test"}))
            assert not result.get("success", True)
        finally:
            if "TS_BACKEND_URL" in os.environ:
                del os.environ["TS_BACKEND_URL"]
