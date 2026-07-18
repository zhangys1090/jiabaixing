"""语音对话模式工具——VoiceMode 状态机管理 + TTS/STT 接口定义。

与现有 voice_interact（system_tools.py）的差异：
- voice_interact: 单次 TTS/STT 调用，无状态机概念
- voice_mode: 完整的语音对话状态机（INACTIVE→LISTENING→PROCESSING→SPEAKING→LISTENING），
  支持持续对话循环、配置热更新、前端协作录音接口

核心价值：接口定义 + 状态管理。实际录音/播放由前端（Electron/浏览器）完成，
Python 端负责状态协调和 TTS 合成。

Usage:
    from agent.tools.voice_mode_tool import register_voice_mode_tool
    register_voice_mode_tool(registry)
"""
from __future__ import annotations

import asyncio
import os
import platform
import subprocess
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
    ToolRegistry,
)


# ==================== 枚举与数据类 ====================


class VoiceModeState(str, Enum):
    """语音对话模式状态枚举。

    定义语音对话的完整状态机流转：
    INACTIVE → LISTENING → PROCESSING → SPEAKING → LISTENING → ... → INACTIVE

    Attributes:
        INACTIVE: 语音模式未激活。
        LISTENING: 正在录音/等待用户语音输入。
        PROCESSING: 正在处理语音输入（STT + LLM 推理）。
        SPEAKING: 正在播报 TTS 响应。
    """

    INACTIVE = "inactive"
    LISTENING = "listening"
    PROCESSING = "processing"
    SPEAKING = "speaking"


@dataclass
class VoiceConfig:
    """语音对话配置。

    Attributes:
        language: 语音语言代码，如 "zh-CN"、"en-US"。
        tts_engine: TTS 引擎名称，默认 "edge-tts"。
        stt_engine: STT 引擎名称，默认 "whisper"。
        auto_detect_language: 是否自动检测语音语言。
        voice_name: TTS 语音角色名称，如 "zh-CN-XiaoxiaoNeural"。
    """

    language: str = "zh-CN"
    tts_engine: str = "edge-tts"
    stt_engine: str = "whisper"
    auto_detect_language: bool = True
    voice_name: str = ""


# ==================== 语音对话管理器 ====================


class VoiceModeManager:
    """语音对话模式管理器。

    管理语音对话的完整状态机生命周期，协调前端录音与
    Python 端 TTS/STT 处理。核心职责是状态管理和接口定义，
    实际录音由前端完成。

    状态机流转：
        INACTIVE → LISTENING（start_listening）
        LISTENING → INACTIVE（stop_listening）
        任意状态 → PROCESSING（process_voice_input）
        PROCESSING → SPEAKING（speak）
        SPEAKING → LISTENING（自动回到监听）

    Usage:
        manager = VoiceModeManager()
        await manager.start_listening()
        text = await manager.stop_listening()
        result = await manager.process_voice_input(text_input=text)
        await manager.speak(result["response"])
    """

    def __init__(self, config: VoiceConfig | None = None) -> None:
        self._config = config or VoiceConfig()
        self._state = VoiceModeState.INACTIVE
        self._listening_text: str = ""
        self._session_start: float | None = None
        self._turn_count: int = 0

    async def start_listening(self) -> str | None:
        """开始录音（状态管理+接口定义）。

        将状态切换为 LISTENING，实际录音需要前端配合。
        Python 端仅做状态管理，不直接操作麦克风。

        Returns:
            str | None: 当前不支持直接录音，返回 None。
        """
        if self._state == VoiceModeState.INACTIVE:
            self._state = VoiceModeState.LISTENING
            self._session_start = time.time()
            self._turn_count = 0
            self._listening_text = ""
        elif self._state in (VoiceModeState.SPEAKING, VoiceModeState.PROCESSING):
            self._state = VoiceModeState.LISTENING
            self._listening_text = ""

        return None

    async def stop_listening(self) -> str:
        """停止录音并返回识别文本。

        停止 LISTENING 状态，返回通过前端录音获取的文本。
        如果前端未提供识别文本，返回空字符串。

        Returns:
            str: 识别到的文本，或空字符串。
        """
        if self._state != VoiceModeState.LISTENING:
            return ""

        self._state = VoiceModeState.PROCESSING
        return self._listening_text

    async def speak(self, text: str) -> None:
        """语音合成（使用 edge-tts 或系统 TTS）。

        优先尝试 edge-tts（免费），回退到系统 TTS（macOS say /
        Windows pyttsx3），最终降级为无操作。

        Args:
            text: 需要合成语音的文本内容。
        """
        if not text:
            return

        self._state = VoiceModeState.SPEAKING
        self._turn_count += 1

        try:
            await self._speak_edge_tts(text)
            return
        except Exception:
            pass

        try:
            self._speak_system_tts(text)
            return
        except Exception:
            pass

        # 降级：无 TTS 引擎可用，仅更新状态
        self._state = VoiceModeState.LISTENING

    async def process_voice_input(
        self,
        audio_data: bytes | None = None,
        text_input: str | None = None,
    ) -> dict[str, Any]:
        """处理语音输入。

        接收来自前端的音频数据或 STT 文本，更新状态机，
        返回处理结果。

        Args:
            audio_data: 来自前端的音频二进制数据（可选，暂不处理）。
            text_input: 来自 STT 的识别文本（可选）。

        Returns:
            dict[str, Any]: 包含 text、response、state 的处理结果。
                - text: 输入文本
                - response: 语音模式的状态信息（实际 LLM 响应由调用方处理）
                - state: 当前状态机状态
        """
        if self._state == VoiceModeState.INACTIVE:
            self._state = VoiceModeState.LISTENING
            self._session_start = time.time()
            self._turn_count = 0

        self._state = VoiceModeState.PROCESSING

        recognized_text = text_input or ""

        if audio_data and not text_input:
            # 音频数据暂由前端 STT 处理，Python 端仅记录
            recognized_text = f"[收到音频数据 {len(audio_data)} 字节，需前端 STT 处理]"

        self._listening_text = recognized_text

        result: dict[str, Any] = {
            "text": recognized_text,
            "response": (
                f"语音模式处理中（状态: {self._state.value}，轮次: {self._turn_count}）。"
                f"实际 LLM 响应由调用方处理。"
            ),
            "state": self._state.value,
        }

        return result

    def get_state(self) -> VoiceModeState:
        """获取当前语音模式状态。

        Returns:
            VoiceModeState: 当前状态机状态。
        """
        return self._state

    def set_config(self, config: VoiceConfig) -> None:
        """更新语音配置。

        Args:
            config: 新的语音配置实例。
        """
        self._config = config

    def get_config(self) -> VoiceConfig:
        """获取当前语音配置。

        Returns:
            VoiceConfig: 当前配置实例。
        """
        return self._config

    def is_available(self) -> bool:
        """检查语音功能是否可用（edge-tts 或系统 TTS）。

        Returns:
            bool: 至少有一个 TTS 引擎可用时返回 True。
        """
        try:
            import edge_tts  # noqa: F401
            return True
        except ImportError:
            pass

        system = platform.system().lower()
        if system == "darwin":
            try:
                subprocess.run(
                    ["which", "say"],
                    capture_output=True,
                    timeout=2,
                )
                return True
            except Exception:
                pass

        if system == "windows":
            try:
                import pyttsx3  # noqa: F401
                return True
            except ImportError:
                pass

        return False

    def get_status(self) -> dict[str, Any]:
        """获取语音模式完整状态信息。

        Returns:
            dict[str, Any]: 包含状态、配置、可用性等信息。
        """
        return {
            "state": self._state.value,
            "available": self.is_available(),
            "config": {
                "language": self._config.language,
                "tts_engine": self._config.tts_engine,
                "stt_engine": self._config.stt_engine,
                "auto_detect_language": self._config.auto_detect_language,
                "voice_name": self._config.voice_name,
            },
            "session_start": self._session_start,
            "turn_count": self._turn_count,
        }

    # ==================== 私有方法 ====================

    async def _speak_edge_tts(self, text: str) -> None:
        """使用 edge-tts 进行语音合成。

        Args:
            text: 待合成文本。

        Raises:
            ImportError: edge-tts 未安装。
            Exception: 合成过程中出错。
        """
        import edge_tts  # noqa: F401 — 延迟导入
        from pathlib import Path

        voice_name = self._config.voice_name
        if not voice_name:
            voice_map: dict[str, str] = {
                "zh-CN": "zh-CN-XiaoxiaoNeural",
                "en-US": "en-US-JennyNeural",
                "ja-JP": "ja-JP-NanamiNeural",
            }
            voice_name = voice_map.get(self._config.language, "zh-CN-XiaoxiaoNeural")

        communicate = edge_tts.Communicate(text, voice_name)
        audio_dir = Path(os.environ.get("DATA_DIR", "data")) / "voice_mode"
        audio_dir.mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        audio_file = audio_dir / f"voice_mode_{timestamp}.mp3"
        await communicate.save(str(audio_file))

        # 合成完成后回到 LISTENING 状态
        self._state = VoiceModeState.LISTENING

    def _speak_system_tts(self, text: str) -> None:
        """使用系统 TTS 进行语音合成。

        macOS 使用 say 命令，Windows 使用 pyttsx3。

        Args:
            text: 待合成文本。

        Raises:
            RuntimeError: 系统 TTS 不可用。
        """
        system = platform.system().lower()

        if system == "darwin":
            subprocess.run(["say", text], check=True, timeout=10)
            self._state = VoiceModeState.LISTENING
            return

        if system == "windows":
            import pyttsx3  # noqa: F401 — 延迟导入
            engine = pyttsx3.init()
            engine.say(text)
            engine.runAndWait()
            self._state = VoiceModeState.LISTENING
            return

        raise RuntimeError(f"系统 {system} 无可用的 TTS 引擎")


# ==================== 全局单例 ====================

_manager: VoiceModeManager | None = None


def _get_manager() -> VoiceModeManager:
    """获取全局 VoiceModeManager 单例。

    Returns:
        VoiceModeManager: 语音对话管理器实例。
    """
    global _manager
    if _manager is None:
        _manager = VoiceModeManager()
    return _manager


# ==================== 工具定义 ====================

VOICE_MODE_DEF = ToolDefinition(
    name="voice_mode",
    description=(
        "语音对话模式管理。管理语音对话状态机（INACTIVE→LISTENING→PROCESSING→SPEAKING），"
        "支持开始录音(start)、停止录音(stop)、语音合成(speak)、查询状态(status)。"
        "与 voice_interact 的区别：voice_mode 提供完整的对话状态机和配置管理，"
        "适用于持续语音对话场景；voice_interact 是单次调用，适用于简单的语音合成/识别。"
        "适用场景：语音助手持续对话、语音控制交互。"
        "不适用：单次文字转语音（用voice_interact的speak）。"
    ),
    short_desc="语音对话模式状态机",
    category=ToolCategory.PERCEPTION,
    tags=["voice", "tts", "stt", "dialog", "conversation", "perception"],
    scenes=["daily", "desktop"],
    capability_level=2,
    parameters=[
        ToolParameterDef(
            name="action",
            type="string",
            required=True,
            description="操作类型：start=开始录音、stop=停止录音、speak=语音合成、status=查询状态",
            enum=["start", "stop", "speak", "status"],
        ),
        ToolParameterDef(
            name="text",
            type="string",
            required=False,
            description="speak操作时要转为语音的文本内容",
        ),
        ToolParameterDef(
            name="language",
            type="string",
            required=False,
            description="语音语言代码，如 zh-CN、en-US",
        ),
    ],
    risk_level="low",
)


# ==================== 工具执行器 ====================


async def voice_mode_executor(params: dict[str, Any]) -> ToolResult:
    """语音对话模式工具执行器。

    根据 action 参数调度到对应的 VoiceModeManager 方法。

    Args:
        params: 工具参数字典，包含 action / text / language。

    Returns:
        ToolResult: 工具执行结果。
    """
    start = time.time()
    action = str(params.get("action", "")).strip()
    text = str(params.get("text", "")).strip()
    language = str(params.get("language", "")).strip()

    manager = _get_manager()

    # 更新语言配置
    if language:
        config = manager.get_config()
        config.language = language

    if action == "start":
        result = await manager.start_listening()
        available = manager.is_available()
        output_parts = [
            f"语音对话模式已启动，状态: {manager.get_state().value}",
        ]
        if not available:
            output_parts.append("警告: 未检测到可用的 TTS 引擎（edge-tts 或系统 TTS）")
        output_parts.append("提示: 实际录音需要前端配合，Python 端仅做状态管理")

        return ToolResult(
            success=True,
            output="\n".join(output_parts),
            duration=time.time() - start,
            metadata={
                "state": manager.get_state().value,
                "available": available,
                "recording_supported": result is not None,
            },
        )

    if action == "stop":
        recognized = await manager.stop_listening()
        state = manager.get_state()

        if not recognized:
            return ToolResult(
                success=True,
                output=f"录音已停止，未获取到识别文本（状态: {state.value}）。请通过 text_input 参数提供 STT 识别结果。",
                duration=time.time() - start,
                metadata={"state": state.value, "text": ""},
            )

        return ToolResult(
            success=True,
            output=f"录音已停止，识别文本: \"{recognized}\"（状态: {state.value}）",
            duration=time.time() - start,
            metadata={"state": state.value, "text": recognized},
        )

    if action == "speak":
        if not text:
            return ToolResult(
                success=False,
                error="speak 操作需要提供 text 参数",
                duration=time.time() - start,
            )

        state_before = manager.get_state().value
        try:
            await manager.speak(text)
            state_after = manager.get_state().value
            return ToolResult(
                success=True,
                output=f"语音合成完成（状态: {state_before} → {state_after}）: \"{text[:50]}\"",
                duration=time.time() - start,
                metadata={
                    "state": state_after,
                    "engine": manager.get_config().tts_engine,
                    "text_length": len(text),
                },
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"语音合成失败: {e}",
                duration=time.time() - start,
            )

    if action == "status":
        status = manager.get_status()
        lines = [
            f"语音对话模式状态:",
            f"  状态: {status['state']}",
            f"  TTS 可用: {'是' if status['available'] else '否'}",
            f"  语言: {status['config']['language']}",
            f"  TTS 引擎: {status['config']['tts_engine']}",
            f"  STT 引擎: {status['config']['stt_engine']}",
            f"  对话轮次: {status['turn_count']}",
        ]
        return ToolResult(
            success=True,
            output="\n".join(lines),
            duration=time.time() - start,
            metadata=status,
        )

    return ToolResult(
        success=False,
        error=f"不支持的操作: {action}。支持: start, stop, speak, status",
        duration=time.time() - start,
    )


# ==================== 注册函数 ====================


def register_voice_mode_tool(registry: ToolRegistry) -> None:
    """注册 voice_mode 工具到工具注册中心。

    Args:
        registry: 工具注册中心实例。
    """
    registry.register(VOICE_MODE_DEF, voice_mode_executor)
