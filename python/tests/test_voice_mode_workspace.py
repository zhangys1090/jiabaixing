"""voice_mode_tool 和 workspace 模块的单元测试。"""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import time

import pytest

from agent.tools.registry import ToolCategory, ToolRegistry, ToolResult


# ==================== Workspace 模块直接加载 ====================
# agent.persistence.__init__.py 会触发 redis 等重度依赖，
# 这里使用 importlib 直接加载 workspace 模块文件，避免导入链问题。


def _import_workspace_module():
    """直接加载 workspace 模块，绕过 agent.persistence.__init__ 的依赖链。"""
    module_path = os.path.join(
        os.path.dirname(__file__), "..", "agent", "persistence", "workspace.py"
    )
    module_path = os.path.normpath(module_path)

    # 先确保 agent.config 可用（workspace.py 依赖）
    if "agent" not in sys.modules:
        import agent  # noqa: F401
    if "agent.config" not in sys.modules:
        import agent.config  # noqa: F401

    spec = importlib.util.spec_from_file_location(
        "agent.persistence.workspace", module_path
    )
    module = importlib.util.module_from_spec(spec)
    # 注册到 sys.modules，使模块内的 from agent.config import 正常工作
    sys.modules["agent.persistence.workspace"] = module
    spec.loader.exec_module(module)
    return module


_ws_module = _import_workspace_module()
WorkspaceConfig = _ws_module.WorkspaceConfig
WorkspaceManager = _ws_module.WorkspaceManager


# ==================== VoiceModeTool 测试 ====================


class TestVoiceModeState:
    """VoiceModeState 枚举测试。"""

    def test_enum_values(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        assert VoiceModeState.INACTIVE == "inactive"
        assert VoiceModeState.LISTENING == "listening"
        assert VoiceModeState.PROCESSING == "processing"
        assert VoiceModeState.SPEAKING == "speaking"

    def test_enum_is_str(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        assert isinstance(VoiceModeState.INACTIVE, str)


class TestVoiceConfig:
    """VoiceConfig 数据类测试。"""

    def test_default_values(self) -> None:
        from agent.tools.voice_mode_tool import VoiceConfig

        config = VoiceConfig()
        assert config.language == "zh-CN"
        assert config.tts_engine == "edge-tts"
        assert config.stt_engine == "whisper"
        assert config.auto_detect_language is True
        assert config.voice_name == ""

    def test_custom_values(self) -> None:
        from agent.tools.voice_mode_tool import VoiceConfig

        config = VoiceConfig(
            language="en-US",
            tts_engine="system",
            stt_engine="google",
            auto_detect_language=False,
            voice_name="en-US-JennyNeural",
        )
        assert config.language == "en-US"
        assert config.tts_engine == "system"
        assert config.voice_name == "en-US-JennyNeural"


class TestVoiceModeManager:
    """VoiceModeManager 核心逻辑测试。"""

    def _make_manager(self) -> "VoiceModeManager":
        from agent.tools.voice_mode_tool import VoiceModeManager, VoiceConfig

        return VoiceModeManager(config=VoiceConfig())

    def test_initial_state_is_inactive(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        assert manager.get_state() == VoiceModeState.INACTIVE

    @pytest.mark.asyncio
    async def test_start_listening_transitions_state(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        result = await manager.start_listening()
        assert result is None
        assert manager.get_state() == VoiceModeState.LISTENING

    @pytest.mark.asyncio
    async def test_stop_listening_without_text(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        await manager.start_listening()
        text = await manager.stop_listening()
        assert text == ""
        assert manager.get_state() == VoiceModeState.PROCESSING

    @pytest.mark.asyncio
    async def test_stop_listening_when_not_listening(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        text = await manager.stop_listening()
        assert text == ""
        assert manager.get_state() == VoiceModeState.INACTIVE

    @pytest.mark.asyncio
    async def test_process_voice_input_with_text(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        result = await manager.process_voice_input(text_input="你好世界")
        assert result["text"] == "你好世界"
        assert result["state"] == VoiceModeState.PROCESSING.value
        assert "response" in result

    @pytest.mark.asyncio
    async def test_process_voice_input_with_audio_data(self) -> None:
        manager = self._make_manager()
        audio = b"fake_audio_data"
        result = await manager.process_voice_input(audio_data=audio)
        assert "音频数据" in result["text"]
        assert str(len(audio)) in result["text"]

    @pytest.mark.asyncio
    async def test_process_voice_input_activates_session(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        assert manager.get_state() == VoiceModeState.INACTIVE
        await manager.process_voice_input(text_input="test")
        assert manager.get_state() == VoiceModeState.PROCESSING

    @pytest.mark.asyncio
    async def test_speak_with_empty_text(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        await manager.start_listening()
        await manager.speak("")
        # 空文本不应改变状态
        assert manager.get_state() == VoiceModeState.LISTENING

    @pytest.mark.asyncio
    async def test_speak_sets_speaking_state(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        await manager.start_listening()
        await manager.speak("测试语音")
        # speak 会尝试 TTS，失败后降级
        state = manager.get_state()
        # 可能是 SPEAKING（TTS 失败但状态已设置）或 LISTENING（降级回退）
        assert state in (VoiceModeState.SPEAKING, VoiceModeState.LISTENING)

    def test_set_and_get_config(self) -> None:
        from agent.tools.voice_mode_tool import VoiceConfig

        manager = self._make_manager()
        new_config = VoiceConfig(language="ja-JP", voice_name="ja-JP-NanamiNeural")
        manager.set_config(new_config)
        got = manager.get_config()
        assert got.language == "ja-JP"
        assert got.voice_name == "ja-JP-NanamiNeural"

    def test_get_status(self) -> None:
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        status = manager.get_status()
        assert status["state"] == VoiceModeState.INACTIVE.value
        assert "config" in status
        assert "available" in status
        assert "turn_count" in status

    @pytest.mark.asyncio
    async def test_state_machine_full_cycle(self) -> None:
        """测试完整状态机循环：INACTIVE → LISTENING → PROCESSING → SPEAKING → LISTENING"""
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        assert manager.get_state() == VoiceModeState.INACTIVE

        await manager.start_listening()
        assert manager.get_state() == VoiceModeState.LISTENING

        await manager.process_voice_input(text_input="你好")
        assert manager.get_state() == VoiceModeState.PROCESSING

        # speak 后状态变为 SPEAKING，然后降级为 LISTENING
        await manager.speak("你好，有什么可以帮你？")
        final_state = manager.get_state()
        assert final_state in (VoiceModeState.SPEAKING, VoiceModeState.LISTENING)

    @pytest.mark.asyncio
    async def test_start_listening_from_speaking(self) -> None:
        """从 SPEAKING 状态可以回到 LISTENING"""
        from agent.tools.voice_mode_tool import VoiceModeState

        manager = self._make_manager()
        await manager.start_listening()
        await manager.process_voice_input(text_input="test")
        # 模拟进入 SPEAKING
        manager._state = VoiceModeState.SPEAKING
        await manager.start_listening()
        assert manager.get_state() == VoiceModeState.LISTENING


class TestVoiceModeToolRegistration:
    """voice_mode 工具注册测试。"""

    def test_register_voice_mode_tool(self) -> None:
        from agent.tools.voice_mode_tool import register_voice_mode_tool

        registry = ToolRegistry()
        register_voice_mode_tool(registry)
        assert registry.has("voice_mode")

    def test_voice_mode_tool_definition(self) -> None:
        from agent.tools.voice_mode_tool import register_voice_mode_tool

        registry = ToolRegistry()
        register_voice_mode_tool(registry)
        defn = registry.get_definition("voice_mode")
        assert defn is not None
        assert defn.category == ToolCategory.PERCEPTION
        assert defn.risk_level == "low"
        assert defn.capability_level == 2

        # 验证参数定义
        param_names = [p.name for p in defn.parameters]
        assert "action" in param_names
        assert "text" in param_names
        assert "language" in param_names

        # action 参数应有 enum
        action_param = next(p for p in defn.parameters if p.name == "action")
        assert action_param.required is True
        assert action_param.enum == ["start", "stop", "speak", "status"]


class TestVoiceModeExecutor:
    """voice_mode 工具执行器测试。"""

    @pytest.mark.asyncio
    async def test_start_action(self) -> None:
        import agent.tools.voice_mode_tool as mod
        mod._manager = None

        result = await mod.voice_mode_executor({"action": "start"})
        assert result.success is True
        assert "listening" in result.output.lower() or "LISTENING" in result.output

    @pytest.mark.asyncio
    async def test_stop_action(self) -> None:
        import agent.tools.voice_mode_tool as mod
        mod._manager = None

        await mod.voice_mode_executor({"action": "start"})
        result = await mod.voice_mode_executor({"action": "stop"})
        assert result.success is True

    @pytest.mark.asyncio
    async def test_speak_action_without_text(self) -> None:
        import agent.tools.voice_mode_tool as mod
        mod._manager = None

        result = await mod.voice_mode_executor({"action": "speak"})
        assert result.success is False
        assert "text" in result.error.lower()

    @pytest.mark.asyncio
    async def test_status_action(self) -> None:
        import agent.tools.voice_mode_tool as mod
        mod._manager = None

        result = await mod.voice_mode_executor({"action": "status"})
        assert result.success is True
        assert "状态" in result.output

    @pytest.mark.asyncio
    async def test_invalid_action(self) -> None:
        import agent.tools.voice_mode_tool as mod
        mod._manager = None

        result = await mod.voice_mode_executor({"action": "invalid"})
        assert result.success is False
        assert "不支持" in result.error

    @pytest.mark.asyncio
    async def test_language_update(self) -> None:
        import agent.tools.voice_mode_tool as mod
        mod._manager = None

        result = await mod.voice_mode_executor({
            "action": "status",
            "language": "en-US",
        })
        assert result.success is True
        status = result.metadata
        assert status["config"]["language"] == "en-US"


# ==================== Workspace 测试 ====================


class TestWorkspaceConfig:
    """WorkspaceConfig 数据类测试。"""

    def test_default_values(self) -> None:
        ws = WorkspaceConfig()
        assert ws.id == ""
        assert ws.name == ""
        assert ws.path == ""
        assert ws.description == ""
        assert ws.created_at == 0.0
        assert ws.last_active == 0.0
        assert ws.settings == {}

    def test_custom_values(self) -> None:
        ws = WorkspaceConfig(
            id="abc123",
            name="test-project",
            path="/tmp/test",
            description="测试项目",
            settings={"key": "value"},
        )
        assert ws.id == "abc123"
        assert ws.name == "test-project"
        assert ws.settings["key"] == "value"


class TestWorkspaceManager:
    """WorkspaceManager 核心逻辑测试。"""

    _counter: int = 0

    def _make_manager(self) -> WorkspaceManager:
        TestWorkspaceManager._counter += 1
        tmpdir = os.path.join(
            tempfile.gettempdir(),
            f"jbx_ws_test_{TestWorkspaceManager._counter}_{int(time.time()*1000)}",
        )
        os.makedirs(tmpdir, exist_ok=True)
        from pathlib import Path
        return WorkspaceManager(data_dir=Path(tmpdir))

    def test_create_workspace(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("demo", "/tmp/demo", "演示项目")

        assert isinstance(ws, WorkspaceConfig)
        assert ws.name == "demo"
        assert ws.description == "演示项目"
        assert ws.id != ""
        assert ws.created_at > 0

    def test_create_workspace_dedup_by_path(self) -> None:
        manager = self._make_manager()
        ws1 = manager.create_workspace("first", "/tmp/demo")
        ws2 = manager.create_workspace("second", "/tmp/demo")
        # 同一路径应返回已有工作区
        assert ws1.id == ws2.id

    def test_get_workspace(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("test", "/tmp/test")
        got = manager.get_workspace(ws.id)
        assert got is not None
        assert got.name == "test"

    def test_get_workspace_not_found(self) -> None:
        manager = self._make_manager()
        assert manager.get_workspace("nonexistent") is None

    def test_get_workspace_by_path(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("test", "/tmp/findme")
        found = manager.get_workspace_by_path("/tmp/findme")
        assert found is not None
        assert found.id == ws.id

    def test_get_workspace_by_path_normalized(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("test", "C:/Users/test/project")
        # normpath 会规范化路径
        found = manager.get_workspace_by_path("C:/Users/test/project")
        assert found is not None
        assert found.id == ws.id

    def test_list_workspaces(self) -> None:
        manager = self._make_manager()
        manager.create_workspace("ws1", "/tmp/ws1")
        time.sleep(0.01)
        manager.create_workspace("ws2", "/tmp/ws2")

        workspaces = manager.list_workspaces()
        assert len(workspaces) == 2
        # 按 last_active 降序
        assert workspaces[0].last_active >= workspaces[1].last_active

    def test_switch_workspace(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("switch-test", "/tmp/switch-test")
        switched = manager.switch_workspace(ws.id)

        assert switched is not None
        assert switched.id == ws.id
        assert manager.get_active_workspace() is not None
        assert manager.get_active_workspace().id == ws.id

    def test_switch_nonexistent_workspace(self) -> None:
        manager = self._make_manager()
        result = manager.switch_workspace("nonexistent")
        assert result is None

    def test_get_active_workspace_none(self) -> None:
        manager = self._make_manager()
        assert manager.get_active_workspace() is None

    def test_update_workspace(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("update-test", "/tmp/update-test")
        updated = manager.update_workspace(ws.id, name="updated-name", description="新描述")

        assert updated is not None
        assert updated.name == "updated-name"
        assert updated.description == "新描述"

    def test_update_workspace_protected_fields(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("protect-test", "/tmp/protect-test")
        original_id = ws.id
        original_created = ws.created_at

        manager.update_workspace(ws.id, id="hacked", created_at=0.0, name="new-name")
        assert ws.id == original_id
        assert ws.created_at == original_created
        assert ws.name == "new-name"

    def test_update_nonexistent_workspace(self) -> None:
        manager = self._make_manager()
        result = manager.update_workspace("nonexistent", name="test")
        assert result is None

    def test_delete_workspace(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("delete-test", "/tmp/delete-test")
        assert manager.delete_workspace(ws.id) is True
        assert manager.get_workspace(ws.id) is None

    def test_delete_nonexistent_workspace(self) -> None:
        manager = self._make_manager()
        assert manager.delete_workspace("nonexistent") is False

    def test_delete_active_workspace_clears_active(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("active-del", "/tmp/active-del")
        manager.switch_workspace(ws.id)
        assert manager.get_active_workspace() is not None

        manager.delete_workspace(ws.id)
        assert manager.get_active_workspace() is None

    def test_export_workspace(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("export-test", "/tmp/export-test", "导出测试")
        exported = manager.export_workspace(ws.id)

        assert exported["id"] == ws.id
        assert exported["name"] == "export-test"
        assert exported["description"] == "导出测试"

    def test_export_nonexistent_workspace(self) -> None:
        manager = self._make_manager()
        exported = manager.export_workspace("nonexistent")
        assert exported == {}

    def test_import_workspace_new(self) -> None:
        manager = self._make_manager()
        data = {
            "name": "imported",
            "path": "/tmp/imported",
            "description": "导入的工作区",
        }
        ws = manager.import_workspace(data)

        assert ws.name == "imported"
        assert ws.path == os.path.normpath("/tmp/imported")

    def test_import_workspace_existing_path_updates(self) -> None:
        manager = self._make_manager()
        manager.create_workspace("original", "/tmp/same-path", "原始描述")

        data = {
            "name": "updated-import",
            "path": "/tmp/same-path",
            "description": "更新描述",
        }
        ws = manager.import_workspace(data)

        assert ws.name == "updated-import"
        assert ws.description == "更新描述"

    def test_persistence_round_trip(self) -> None:
        """测试数据持久化：创建 → 重新加载 → 验证。"""
        TestWorkspaceManager._counter += 1
        tmpdir = os.path.join(
            tempfile.gettempdir(),
            f"jbx_ws_persist_{TestWorkspaceManager._counter}_{int(time.time()*1000)}",
        )
        os.makedirs(tmpdir, exist_ok=True)
        from pathlib import Path
        data_dir = Path(tmpdir)

        manager1 = WorkspaceManager(data_dir=data_dir)
        ws = manager1.create_workspace("persist-test", "/tmp/persist", "持久化测试")
        manager1.switch_workspace(ws.id)

        # 重新加载
        manager2 = WorkspaceManager(data_dir=data_dir)
        loaded = manager2.get_workspace(ws.id)
        assert loaded is not None
        assert loaded.name == "persist-test"
        assert loaded.description == "持久化测试"

        active = manager2.get_active_workspace()
        assert active is not None
        assert active.id == ws.id

    def test_get_workspace_context_nonexistent(self) -> None:
        manager = self._make_manager()
        ctx = manager.get_workspace_context("nonexistent")
        assert "error" in ctx

    def test_get_workspace_context_path_not_exists(self) -> None:
        manager = self._make_manager()
        ws = manager.create_workspace("no-path", "/nonexistent/path/12345")
        ctx = manager.get_workspace_context(ws.id)

        assert ctx["path_exists"] is False
        assert ctx["project_type"] is None

    def test_get_workspace_context_existing_path(self) -> None:
        """测试真实路径的上下文检测。"""
        manager = self._make_manager()

        # 使用当前项目路径
        project_root = os.path.normpath(
            os.path.join(os.path.dirname(__file__), "..")
        )
        ws = manager.create_workspace("current-project", project_root)
        ctx = manager.get_workspace_context(ws.id)

        assert ctx["path_exists"] is True
        # 项目有 pyproject.toml，应检测到 python
        assert ctx["project_type"] is not None or ctx["hints"] is not None

    def test_auto_detect_workspace_valid_path(self) -> None:
        """测试自动检测当前项目路径。"""
        manager = self._make_manager()

        project_root = os.path.normpath(
            os.path.join(os.path.dirname(__file__), "..")
        )
        ws = manager.auto_detect_workspace(project_root)

        assert ws is not None
        assert ws.name != ""

    def test_auto_detect_workspace_invalid_path(self) -> None:
        manager = self._make_manager()
        ws = manager.auto_detect_workspace("/nonexistent/path/12345")
        assert ws is None

    def test_auto_detect_workspace_dedup(self) -> None:
        """同一路径自动检测两次不会创建重复工作区。"""
        manager = self._make_manager()

        project_root = os.path.normpath(
            os.path.join(os.path.dirname(__file__), "..")
        )
        ws1 = manager.auto_detect_workspace(project_root)
        ws2 = manager.auto_detect_workspace(project_root)

        assert ws1 is not None
        assert ws2 is not None
        assert ws1.id == ws2.id
