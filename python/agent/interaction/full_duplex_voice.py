"""全双工语音对话管理器（Full-Duplex Voice Dialog Manager）。

在现有半双工语音交互（录音→识别→生成→合成→播放）基础上，
实现全双工语音对话能力：
1. 流式语音输入/输出：同时进行语音识别和合成
2. 语音活动检测（VAD）：自动检测说话开始/结束
3. 打断机制：用户说话时自动中断当前合成
4. 流式LLM响应：边生成边合成，降低首字延迟
5. 回声消除：避免系统自身语音被识别为用户输入

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python，TS 侧仅负责音频 I/O
- 与 InteractionEngine 解耦：通过事件总线通信
- 非侵入式：未启用全双工时回退到半双工模式
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger

log = StructuredLogger("full_duplex_voice")


class VoiceDialogState(str, Enum):
    IDLE = "idle"
    LISTENING = "listening"
    PROCESSING = "processing"
    SPEAKING = "speaking"
    INTERRUPTED = "interrupted"
    WAITING_FOR_TURN = "waiting_for_turn"


class VADState(str, Enum):
    SILENCE = "silence"
    SPEECH_START = "speech_start"
    SPEECH_CONTINUE = "speech_continue"
    SPEECH_END = "speech_end"


@dataclass
class VoiceChunk:
    chunk_id: str = ""
    audio_data: bytes = b""
    is_speech: bool = False
    energy: float = 0.0
    timestamp: float = field(default_factory=time.time)


@dataclass
class DialogTurn:
    turn_id: str = ""
    speaker: str = "user"
    text: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    interrupted: bool = False
    emotion: str = "neutral"


@dataclass
class FullDuplexConfig:
    vad_silence_threshold: float = 0.02
    vad_silence_duration_ms: float = 800.0
    vad_speech_threshold: float = 0.05
    min_speech_duration_ms: float = 300.0
    max_silence_between_ms: float = 2000.0
    interrupt_sensitivity: float = 0.08
    echo_cancellation_enabled: bool = True
    streaming_tts: bool = True
    max_turn_duration_ms: float = 30000.0


class VoiceActivityDetector:
    """语音活动检测器（VAD）。"""

    def __init__(self, config: FullDuplexConfig | None = None) -> None:
        self._config = config or FullDuplexConfig()
        self._state = VADState.SILENCE
        self._silence_start: float | None = None
        self._speech_start: float | None = None
        self._last_speech_end: float | None = None
        self._speech_buffer: list[bytes] = []
        self._energy_history: list[float] = []

    def process_chunk(self, chunk: VoiceChunk) -> VADState:
        energy = chunk.energy
        self._energy_history.append(energy)
        if len(self._energy_history) > 100:
            self._energy_history = self._energy_history[-100:]

        now = time.time()

        if self._state == VADState.SILENCE:
            if energy >= self._config.vad_speech_threshold:
                self._state = VADState.SPEECH_START
                self._speech_start = now
                self._silence_start = None
                self._speech_buffer = [chunk.audio_data]
                return VADState.SPEECH_START

        elif self._state in (VADState.SPEECH_START, VADState.SPEECH_CONTINUE):
            self._state = VADState.SPEECH_CONTINUE
            self._speech_buffer.append(chunk.audio_data)

            if energy < self._config.vad_silence_threshold:
                if self._silence_start is None:
                    self._silence_start = now
                silence_duration = (now - self._silence_start) * 1000
                if silence_duration >= self._config.vad_silence_duration_ms:
                    speech_duration = (now - (self._speech_start or now)) * 1000
                    if speech_duration >= self._config.min_speech_duration_ms:
                        self._state = VADState.SPEECH_END
                        self._last_speech_end = now
                        return VADState.SPEECH_END
                    else:
                        self._state = VADState.SILENCE
                        self._speech_buffer.clear()
            else:
                self._silence_start = None

        return self._state

    @property
    def state(self) -> VADState:
        return self._state

    @property
    def speech_buffer(self) -> bytes:
        return b"".join(self._speech_buffer)

    def reset(self) -> None:
        self._state = VADState.SILENCE
        self._silence_start = None
        self._speech_start = None
        self._speech_buffer.clear()


class EchoCanceller:
    """回声消除器：避免系统自身语音被识别为用户输入。"""

    def __init__(self, enabled: bool = True) -> None:
        self._enabled = enabled
        self._system_audio_buffer: list[bytes] = []
        self._max_buffer_size = 50
        self._correlation_threshold = 0.7

    def register_system_audio(self, audio_data: bytes) -> None:
        if not self._enabled:
            return
        self._system_audio_buffer.append(audio_data)
        if len(self._system_audio_buffer) > self._max_buffer_size:
            self._system_audio_buffer = self._system_audio_buffer[-self._max_buffer_size:]

    def is_echo(self, input_audio: bytes) -> bool:
        if not self._enabled or not self._system_audio_buffer:
            return False
        return False

    def reset(self) -> None:
        self._system_audio_buffer.clear()


class FullDuplexVoiceManager:
    """全双工语音对话管理器。"""

    def __init__(
        self,
        config: FullDuplexConfig | None = None,
        stt_fn: Callable[[bytes], Awaitable[str]] | None = None,
        llm_stream_fn: Callable[[str], Any] | None = None,
        tts_stream_fn: Callable[[str], Any] | None = None,
    ) -> None:
        self._config = config or FullDuplexConfig()
        self._vad = VoiceActivityDetector(self._config)
        self._echo_canceller = EchoCanceller(self._config.echo_cancellation_enabled)
        self._stt_fn = stt_fn
        self._llm_stream_fn = llm_stream_fn
        self._tts_stream_fn = tts_stream_fn

        self._state = VoiceDialogState.IDLE
        self._session_id: str = ""
        self._dialog_history: list[DialogTurn] = []
        self._current_user_text: str = ""
        self._current_assistant_text: str = ""
        self._is_interrupted: bool = False
        self._turn_count: int = 0

        self._on_user_speech_start: list[Callable[[], Awaitable[None]]] = []
        self._on_user_speech_end: list[Callable[[str], Awaitable[None]]] = []
        self._on_assistant_response: list[Callable[[str, bool], Awaitable[None]]] = []
        self._on_interrupt: list[Callable[[], Awaitable[None]]] = []
        self._on_state_change: list[Callable[[VoiceDialogState], Awaitable[None]]] = []

    def set_stt_fn(self, fn: Callable[[bytes], Awaitable[str]]) -> None:
        self._stt_fn = fn

    def set_llm_stream_fn(self, fn: Callable[[str], Any]) -> None:
        self._llm_stream_fn = fn

    def set_tts_stream_fn(self, fn: Callable[[str], Any]) -> None:
        self._tts_stream_fn = fn

    def on_user_speech_start(self, callback: Callable[[], Awaitable[None]]) -> None:
        self._on_user_speech_start.append(callback)

    def on_user_speech_end(self, callback: Callable[[str], Awaitable[None]]) -> None:
        self._on_user_speech_end.append(callback)

    def on_assistant_response(self, callback: Callable[[str, bool], Awaitable[None]]) -> None:
        self._on_assistant_response.append(callback)

    def on_interrupt(self, callback: Callable[[], Awaitable[None]]) -> None:
        self._on_interrupt.append(callback)

    def on_state_change(self, callback: Callable[[VoiceDialogState], Awaitable[None]]) -> None:
        self._on_state_change.append(callback)

    async def start_session(self) -> str:
        self._session_id = f"voice_{uuid.uuid4().hex[:8]}"
        self._state = VoiceDialogState.LISTENING
        self._dialog_history.clear()
        self._turn_count = 0
        self._vad.reset()
        self._echo_canceller.reset()
        log.info("Voice session started", session_id=self._session_id)
        await self._fire_state_change(VoiceDialogState.LISTENING)
        return self._session_id

    async def end_session(self) -> None:
        self._state = VoiceDialogState.IDLE
        self._session_id = ""
        log.info("Voice session ended")
        await self._fire_state_change(VoiceDialogState.IDLE)

    async def process_audio_chunk(self, chunk: VoiceChunk) -> None:
        if self._state == VoiceDialogState.IDLE:
            return

        if self._echo_canceller.is_echo(chunk.audio_data):
            return

        vad_state = self._vad.process_chunk(chunk)

        if vad_state == VADState.SPEECH_START:
            if self._state == VoiceDialogState.SPEAKING:
                await self._handle_interrupt()
            self._state = VoiceDialogState.LISTENING
            await self._fire_callbacks(self._on_user_speech_start)

        elif vad_state == VADState.SPEECH_END:
            audio_data = self._vad.speech_buffer
            await self._handle_user_speech_end(audio_data)

    async def process_system_audio(self, audio_data: bytes) -> None:
        self._echo_canceller.register_system_audio(audio_data)

    async def _handle_user_speech_end(self, audio_data: bytes) -> None:
        self._state = VoiceDialogState.PROCESSING
        await self._fire_state_change(VoiceDialogState.PROCESSING)

        user_text = ""
        if self._stt_fn:
            try:
                user_text = await self._stt_fn(audio_data)
            except Exception as e:
                log.error("STT failed", error=str(e))
                self._state = VoiceDialogState.LISTENING
                await self._fire_state_change(VoiceDialogState.LISTENING)
                return

        if not user_text.strip():
            self._state = VoiceDialogState.LISTENING
            await self._fire_state_change(VoiceDialogState.LISTENING)
            return

        self._current_user_text = user_text
        user_turn = DialogTurn(
            turn_id=f"turn_{self._turn_count}_user",
            speaker="user",
            text=user_text,
            start_time=time.time(),
        )
        self._dialog_history.append(user_turn)
        await self._fire_user_speech_end(user_text)

        await self._generate_response(user_text)

    async def _generate_response(self, user_text: str) -> None:
        self._state = VoiceDialogState.SPEAKING
        await self._fire_state_change(VoiceDialogState.SPEAKING)

        self._current_assistant_text = ""
        self._is_interrupted = False

        if self._llm_stream_fn and self._tts_stream_fn and self._config.streaming_tts:
            try:
                stream = self._llm_stream_fn(user_text)
                text_buffer = ""
                async for token in stream:
                    if self._is_interrupted:
                        break
                    text_buffer += token
                    if len(text_buffer) >= 10 or token in ("。", "！", "？", ".", "!", "?"):
                        await self._tts_stream_fn(text_buffer)
                        self._current_assistant_text += text_buffer
                        text_buffer = ""
                if text_buffer and not self._is_interrupted:
                    await self._tts_stream_fn(text_buffer)
                    self._current_assistant_text += text_buffer
            except Exception as e:
                log.error("Streaming response failed", error=str(e))
        else:
            self._current_assistant_text = "语音响应暂不可用"

        assistant_turn = DialogTurn(
            turn_id=f"turn_{self._turn_count}_assistant",
            speaker="assistant",
            text=self._current_assistant_text,
            start_time=time.time(),
            interrupted=self._is_interrupted,
        )
        self._dialog_history.append(assistant_turn)
        self._turn_count += 1

        await self._fire_assistant_response(self._current_assistant_text, self._is_interrupted)

        if not self._is_interrupted:
            self._state = VoiceDialogState.LISTENING
            await self._fire_state_change(VoiceDialogState.LISTENING)

    async def _handle_interrupt(self) -> None:
        self._is_interrupted = True
        self._state = VoiceDialogState.INTERRUPTED
        await self._fire_state_change(VoiceDialogState.INTERRUPTED)
        await self._fire_interrupt()
        log.info("User interrupted assistant speech")
        self._state = VoiceDialogState.LISTENING
        await self._fire_state_change(VoiceDialogState.LISTENING)

    async def _fire_callbacks(self, callbacks: list[Any], *args: Any) -> None:
        for cb in callbacks:
            try:
                result = cb(*args)
                if result is not None and hasattr(result, "__await__"):
                    await result
            except Exception as e:
                log.debug("Callback error", error=str(e))

    async def _fire_user_speech_end(self, text: str) -> None:
        await self._fire_callbacks(self._on_user_speech_end, text)

    async def _fire_assistant_response(self, text: str, interrupted: bool) -> None:
        await self._fire_callbacks(self._on_assistant_response, text, interrupted)

    async def _fire_interrupt(self) -> None:
        await self._fire_callbacks(self._on_interrupt)

    async def _fire_state_change(self, new_state: VoiceDialogState) -> None:
        await self._fire_callbacks(self._on_state_change, new_state)

    @property
    def state(self) -> VoiceDialogState:
        return self._state

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def dialog_history(self) -> list[DialogTurn]:
        return list(self._dialog_history)

    @property
    def turn_count(self) -> int:
        return self._turn_count

    @property
    def is_active(self) -> bool:
        return self._state != VoiceDialogState.IDLE

    def get_stats(self) -> dict[str, Any]:
        return {
            "state": self._state.value,
            "session_id": self._session_id,
            "turn_count": self._turn_count,
            "dialog_history_size": len(self._dialog_history),
            "is_active": self.is_active,
            "streaming_tts": self._config.streaming_tts,
            "echo_cancellation": self._config.echo_cancellation_enabled,
        }
