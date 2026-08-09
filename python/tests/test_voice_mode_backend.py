"""语音对话模式后端测试（D2/D3 真实后端验证）。

验证点：
- 状态机流转（INACTIVE→LISTENING→PROCESSING→SPEAKING→LISTENING）。
- speak()：edge-tts 可用时返回音频路径并写入 last_audio_path；
  无引擎时优雅降级为 None（不抛错），状态回到 LISTENING。
- transcribe()：无 whisper/faster-whisper 时返回 None（前端 STT 边界）。
- executor 的 speak action 如实回传 audio_path / backend_tts 元数据。

说明：本机（Windows 开发机）未安装 edge_tts / pyttsx3 / whisper，
因此“无引擎降级”与“无 STT”是真实可测路径；edge-tts 成功路径通过
monkeypatch `_speak_edge_tts` 模拟（不依赖网络）。
"""

import os
import tempfile

import pytest

from agent.tools.voice_mode_tool import (
    VoiceConfig,
    VoiceModeManager,
    VoiceModeState,
    voice_mode_executor,
)


# ==================== 状态机 ====================


def test_state_initial_is_inactive():
    mgr = VoiceModeManager()
    assert mgr.get_state() == VoiceModeState.INACTIVE


async def test_start_listening_transitions_to_listening():
    mgr = VoiceModeManager()
    await mgr.start_listening()
    assert mgr.get_state() == VoiceModeState.LISTENING


async def test_stop_listening_transitions_to_processing():
    mgr = VoiceModeManager()
    await mgr.start_listening()
    text = await mgr.stop_listening()
    assert mgr.get_state() == VoiceModeState.PROCESSING
    assert text == ""  # 无前端文本时为空串


async def test_stop_listening_when_not_listening_returns_empty():
    mgr = VoiceModeManager()
    # 未在 LISTENING 时 stop，直接返回空串，不改状态
    text = await mgr.stop_listening()
    assert text == ""
    assert mgr.get_state() == VoiceModeState.INACTIVE


async def test_process_voice_input_transitions_to_processing():
    mgr = VoiceModeManager()
    result = await mgr.process_voice_input(text_input="你好")
    assert mgr.get_state() == VoiceModeState.PROCESSING
    assert result["text"] == "你好"
    assert result["state"] == "processing"
    assert "response" in result


async def test_process_voice_input_from_inactive_starts_session():
    mgr = VoiceModeManager()
    # 从 INACTIVE 直接调用，应自动进入 LISTENING 再 PROCESSING
    result = await mgr.process_voice_input(text_input="测试")
    assert result["state"] == "processing"
    assert mgr.get_state() == VoiceModeState.PROCESSING


# ==================== speak() 降级（真实：无引擎） ====================


async def test_speak_degrades_cleanly_when_no_engine(monkeypatch):
    """本机无 edge_tts/pyttsx3 时，speak 返回 None 且不抛错。"""
    mgr = VoiceModeManager()
    await mgr.start_listening()
    # 确保不会真的去网络请求 edge_tts：monkeypatch 让其抛 ImportError
    async def _raise_import(*a, **k):
        raise ImportError("edge-tts not installed (simulated)")

    monkeypatch.setattr(mgr, "_speak_edge_tts", _raise_import)

    # 系统 TTS 在 Windows 上依赖 pyttsx3，未安装也会失败 → 走降级分支
    path = await mgr.speak("你好世界")
    assert path is None
    # 降级后状态应回到 LISTENING（不卡在 SPEAKING）
    assert mgr.get_state() == VoiceModeState.LISTENING
    assert mgr.last_audio_path() is None


async def test_speak_empty_text_returns_none():
    mgr = VoiceModeManager()
    assert await mgr.speak("") is None
    assert await mgr.speak("   ") is None


# ==================== speak() 成功路径（模拟 edge-tts） ====================


async def test_speak_returns_audio_path_when_edge_tts_ok(monkeypatch):
    mgr = VoiceModeManager()
    await mgr.start_listening()

    tmp = tempfile.mkdtemp()
    fake_path = os.path.join(tmp, "voice_mode_test.mp3")
    with open(fake_path, "w", encoding="utf-8") as f:
        f.write("fake-audio")

    async def _fake_edge(*a, **k):
        # 模拟 edge-tts 成功合成并返回路径（不触网）
        mgr._state = VoiceModeState.LISTENING
        return fake_path

    monkeypatch.setattr(mgr, "_speak_edge_tts", _fake_edge)

    path = await mgr.speak("合成这段文本")
    assert path == fake_path
    assert mgr.last_audio_path() == fake_path
    # 成功后状态回到 LISTENING
    assert mgr.get_state() == VoiceModeState.LISTENING


# ==================== transcribe()（真实：无 STT 引擎） ====================


async def test_transcribe_returns_none_without_whisper(monkeypatch):
    """无 faster-whisper / whisper 时返回 None，不抛错。"""
    import builtins

    mgr = VoiceModeManager()

    original_import = builtins.__import__

    # 即便有人误装了 whisper，也强制两条 import 都失败，验证优雅降级
    def _patched_import(name, *args, **kwargs):
        if name in ("faster_whisper", "whisper"):
            raise ImportError(f"{name} not available (simulated)")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _patched_import)

    result = await mgr.transcribe(b"fake-audio-bytes")
    assert result is None


async def test_transcribe_empty_audio_returns_none():
    mgr = VoiceModeManager()
    assert await mgr.transcribe(b"") is None
    assert await mgr.transcribe(None) is None


async def test_transcribe_passes_file_path_not_bytes(monkeypatch):
    """回归（2026-08）：transcribe 必须把音频落盘为临时文件再传路径给 whisper，
    而不能直接传裸 bytes —— whisper/faster_whisper 的 transcribe() 接收文件路径
    或二进制流，传裸 bytes 会运行时报错。本测试用 stub whisper 断言收到的是路径。
    """
    import builtins
    import types

    class _FakeWhisperModel:
        def transcribe(self, path):
            assert isinstance(path, str), "whisper 必须接收文件路径，而非裸 bytes"
            with open(path, "rb") as f:
                data = f.read()
            assert data == b"\x00\x01fakeaudio", "应从临时文件读回原始音频字节"
            return {"text": "你好世界"}

    class _FakeWhisper(types.ModuleType):
        def load_model(self, _name):
            return _FakeWhisperModel()

    original_import = builtins.__import__
    fake_whisper = _FakeWhisper("whisper")

    def _patched_import(name, *args, **kwargs):
        if name == "faster_whisper":
            raise ImportError("faster_whisper not available (simulated)")
        if name == "whisper":
            return fake_whisper
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _patched_import)

    mgr = VoiceModeManager()
    result = await mgr.transcribe(b"\x00\x01fakeaudio")
    assert result == "你好世界"


# ==================== is_available ====================


async def test_is_available_realistic(monkeypatch):
    """本机无 edge_tts/pyttsx3 时应为 False（真实可测）。"""
    mgr = VoiceModeManager()

    async def _raise_import(*a, **k):
        raise ImportError("edge-tts not installed (simulated)")

    monkeypatch.setattr(mgr, "_speak_edge_tts", _raise_import)

    # is_available 走 edge_tts import（真实缺失） + 系统 TTS（Windows pyttsx3 缺失）
    available = mgr.is_available()
    assert available is False


# ==================== executor 集成 ====================


async def test_executor_speak_action_surfaces_audio_path(monkeypatch):
    from agent.tools.voice_mode_tool import _get_manager

    mgr = VoiceModeManager()
    await mgr.start_listening()
    monkeypatch.setattr("agent.tools.voice_mode_tool._get_manager", lambda: mgr)

    tmp = tempfile.mkdtemp()
    fake_path = os.path.join(tmp, "voice_mode_exec.mp3")
    with open(fake_path, "w", encoding="utf-8") as f:
        f.write("fake")

    async def _fake_edge(*a, **k):
        mgr._state = VoiceModeState.LISTENING
        return fake_path

    monkeypatch.setattr(mgr, "_speak_edge_tts", _fake_edge)

    result = await voice_mode_executor({"action": "speak", "text": "你好执行器"})
    assert result.success is True
    assert result.metadata["audio_path"] == fake_path
    assert result.metadata["backend_tts"] is True
    assert "后端已合成音频文件" in result.output


async def test_executor_speak_action_no_audio_when_degraded(monkeypatch):
    from agent.tools.voice_mode_tool import _get_manager

    mgr = VoiceModeManager()
    await mgr.start_listening()
    monkeypatch.setattr("agent.tools.voice_mode_tool._get_manager", lambda: mgr)

    async def _raise_import(*a, **k):
        raise ImportError("edge-tts not installed (simulated)")

    monkeypatch.setattr(mgr, "_speak_edge_tts", _raise_import)

    result = await voice_mode_executor({"action": "speak", "text": "降级文本"})
    assert result.success is True
    assert result.metadata["audio_path"] is None
    assert result.metadata["backend_tts"] is False
    assert "未产出后端音频文件" in result.output


async def test_executor_speak_requires_text():
    result = await voice_mode_executor({"action": "speak"})
    assert result.success is False
    assert "text" in result.error


async def test_executor_start_and_status():
    start = await voice_mode_executor({"action": "start"})
    assert start.success is True
    assert start.metadata["state"] == "listening"

    status = await voice_mode_executor({"action": "status"})
    assert status.success is True
    assert "state" in status.metadata
    assert status.metadata["state"] == "listening"


async def test_executor_unsupported_action():
    result = await voice_mode_executor({"action": "bogus"})
    assert result.success is False
    assert "不支持" in result.error
