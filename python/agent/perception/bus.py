"""
PerceptionBus — 五感统一感知总线

统一调度五感工具（视觉/听觉/情绪/场景/环境），输出标准化 PerceptionState，
注入 LoopContext 供 Plan 阶段使用。

设计原则：
- 非侵入式：感知失败不阻断主循环，静默降级
- 分级感知：light（<500ms）/ standard（<2s）/ deep（<5s）
- 统一输出：所有感知通道输出汇聚为 PerceptionState
- 可观测：每次感知输出追踪数据供 LoopObserver 记录

@module perception.bus
@version 1.0.0
@since 2026-08-06
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("perception_bus")


class PerceptionLevel(str, Enum):
    LIGHT = "light"
    STANDARD = "standard"
    DEEP = "deep"


@dataclass
class EmotionState:
    emotion_type: str = "neutral"
    intensity: float = 0.5
    potential_needs: list[str] = field(default_factory=list)
    confidence: float = 0.0


@dataclass
class SceneState:
    scene_type: str = "general"
    interaction_mode: str = "text"
    recommended_tools: list[str] = field(default_factory=list)
    confidence: float = 0.0


@dataclass
class EnvironmentState:
    os_info: str = ""
    active_window: str = ""
    network_status: str = "unknown"
    time_context: str = ""
    screen_resolution: str = ""


@dataclass
class VisualState:
    screen_description: str = ""
    interactive_elements_count: int = 0
    has_dialog: bool = False
    has_notification: bool = False


@dataclass
class AudioState:
    is_speaking: bool = False
    transcription: str = ""
    language: str = ""


@dataclass
class PerceptionState:
    emotion: EmotionState = field(default_factory=EmotionState)
    scene: SceneState = field(default_factory=SceneState)
    environment: EnvironmentState = field(default_factory=EnvironmentState)
    visual: VisualState = field(default_factory=VisualState)
    audio: AudioState = field(default_factory=AudioState)
    perception_level: PerceptionLevel = PerceptionLevel.STANDARD
    duration_ms: float = 0.0
    channels_active: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_prompt_text(self) -> str:
        parts: list[str] = []

        if self.emotion.emotion_type != "neutral" and self.emotion.confidence > 0.3:
            parts.append(
                f"用户情绪: {self.emotion.emotion_type}(强度:{self.emotion.intensity:.1f})"
            )
            if self.emotion.potential_needs:
                parts.append(f"潜在需求: {', '.join(self.emotion.potential_needs[:3])}")

        if self.scene.scene_type != "general" and self.scene.confidence > 0.3:
            parts.append(f"当前场景: {self.scene.scene_type}")
            if self.scene.recommended_tools:
                parts.append(f"推荐工具: {', '.join(self.scene.recommended_tools[:5])}")

        if self.environment.active_window:
            parts.append(f"活跃窗口: {self.environment.active_window}")
        if self.environment.os_info:
            parts.append(f"系统: {self.environment.os_info}")
        if self.environment.network_status != "unknown":
            parts.append(f"网络: {self.environment.network_status}")
        if self.environment.time_context:
            parts.append(f"时间上下文: {self.environment.time_context}")

        if self.visual.screen_description:
            parts.append(f"屏幕: {self.visual.screen_description[:200]}")
        if self.visual.has_dialog:
            parts.append("检测到对话框")
        if self.visual.has_notification:
            parts.append("检测到通知")

        if self.audio.is_speaking and self.audio.transcription:
            parts.append(f"语音输入: {self.audio.transcription[:200]}")

        if not parts:
            return ""

        return "【当前感知状态】\n" + "\n".join(f"- {p}" for p in parts)


class PerceptionBus:
    """五感统一感知总线"""

    _instance: PerceptionBus | None = None

    def __init__(
        self,
        tool_registry: Any | None = None,
        llm: Any | None = None,
        level: PerceptionLevel = PerceptionLevel.STANDARD,
    ) -> None:
        self._tool_registry = tool_registry
        self._llm = llm
        self._level = level
        self._last_state: PerceptionState | None = None
        self._perception_count = 0
        self._trajectory_db: Any = None

    @classmethod
    def get_instance(cls) -> PerceptionBus:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def set_tool_registry(self, registry: Any) -> None:
        self._tool_registry = registry

    def set_llm(self, llm: Any) -> None:
        self._llm = llm

    def set_level(self, level: PerceptionLevel) -> None:
        self._level = level

    def set_trajectory_db(self, db: Any) -> None:
        self._trajectory_db = db

    async def perceive(
        self,
        user_input: str = "",
        context: dict[str, Any] | None = None,
    ) -> PerceptionState:
        start = time.time()
        state = PerceptionState(perception_level=self._level)
        self._perception_count += 1

        channels = self._resolve_channels()
        state.channels_active = [c for c, enabled in channels.items() if enabled]

        if channels.get("emotion"):
            try:
                state.emotion = await self._perceive_emotion(user_input)
            except Exception as e:
                state.errors.append(f"emotion: {e}")
                log.debug("Emotion perception failed", error=str(e))

        if channels.get("scene"):
            try:
                state.scene = await self._perceive_scene(user_input)
            except Exception as e:
                state.errors.append(f"scene: {e}")
                log.debug("Scene perception failed", error=str(e))

        if channels.get("environment"):
            try:
                state.environment = await self._perceive_environment()
            except Exception as e:
                state.errors.append(f"environment: {e}")
                log.debug("Environment perception failed", error=str(e))

        if channels.get("visual"):
            try:
                state.visual = await self._perceive_visual()
            except Exception as e:
                state.errors.append(f"visual: {e}")
                log.debug("Visual perception failed", error=str(e))

        if channels.get("audio"):
            try:
                state.audio = await self._perceive_audio()
            except Exception as e:
                state.errors.append(f"audio: {e}")
                log.debug("Audio perception failed", error=str(e))

        state.duration_ms = (time.time() - start) * 1000
        self._last_state = state

        if self._trajectory_db:
            try:
                self._trajectory_db.save_environment_state(
                    session_id="default",
                    environment={
                        "os_info": state.environment.os_info,
                        "active_window": state.environment.active_window,
                        "network_status": state.environment.network_status,
                        "time_context": state.environment.time_context,
                        "screen_resolution": state.environment.screen_resolution,
                    },
                    emotion={
                        "emotion_type": state.emotion.emotion_type,
                        "intensity": state.emotion.intensity,
                    },
                    scene={
                        "scene_type": state.scene.scene_type,
                        "confidence": state.scene.confidence,
                    },
                )
            except Exception as _exc:
                log_ignored(log, "bus.PerceptionBus.perceive.persist_env", _exc)

        log.info(
            "Perception completed",
            channels=state.channels_active,
            duration_ms=round(state.duration_ms),
            errors=len(state.errors),
        )

        return state

    def _resolve_channels(self) -> dict[str, bool]:
        if self._level == PerceptionLevel.LIGHT:
            return {
                "emotion": True,
                "scene": False,
                "environment": False,
                "visual": False,
                "audio": False,
            }
        if self._level == PerceptionLevel.STANDARD:
            return {
                "emotion": True,
                "scene": True,
                "environment": True,
                "visual": False,
                "audio": False,
            }
        return {
            "emotion": True,
            "scene": True,
            "environment": True,
            "visual": True,
            "audio": True,
        }

    async def _perceive_emotion(self, user_input: str) -> EmotionState:
        if self._tool_registry and self._tool_registry.has("emotion_perceive"):
            result = await self._tool_registry.execute(
                "emotion_perceive", {"text": user_input}
            )
            if result.success:
                import json
                try:
                    data = json.loads(result.output) if isinstance(result.output, str) else result.output
                    return EmotionState(
                        emotion_type=data.get("type", "neutral"),
                        intensity=float(data.get("intensity", 0.5)),
                        potential_needs=data.get("potentialNeeds", []),
                        confidence=float(data.get("confidence", 0.0)),
                    )
                except (ValueError, TypeError) as _exc:
                    log_ignored(log, "bus.PerceptionBus._perceive_emotion", _exc)

        if self._llm:
            return await self._perceive_emotion_llm(user_input)

        return self._perceive_emotion_rule(user_input)

    async def _perceive_emotion_llm(self, user_input: str) -> EmotionState:
        if not user_input:
            return EmotionState()

        prompt = (
            "分析以下用户输入的情绪状态，返回JSON：\n"
            '{"type": "happy|sad|angry|anxious|frustrated|neutral|curious|confident", '
            '"intensity": 0.0-1.0, "potentialNeeds": ["need1","need2"], '
            '"confidence": 0.0-1.0}\n\n'
            f"用户输入: {user_input}"
        )
        try:
            result = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=True,
                task_type="cheap",
            )
            content = result.get("content", "")
            import json
            import re
            match = re.search(r'\{[\s\S]*\}', content)
            if match:
                data = json.loads(match.group())
                return EmotionState(
                    emotion_type=data.get("type", "neutral"),
                    intensity=float(data.get("intensity", 0.5)),
                    potential_needs=data.get("potentialNeeds", []),
                    confidence=float(data.get("confidence", 0.0)),
                )
        except Exception as e:
            log.debug("LLM emotion perception failed", error=str(e))

        return self._perceive_emotion_rule(user_input)

    @staticmethod
    def _perceive_emotion_rule(user_input: str) -> EmotionState:
        if not user_input:
            return EmotionState()

        text = user_input.lower()
        frustration_kw = ["烦", "崩溃", "跑不通", "报错", "失败", "搞不定", "damn", "frustrating"]
        angry_kw = ["气死", "愤怒", "太过分", "angry", "furious"]
        sad_kw = ["难过", "伤心", "失望", "sad", "disappointed"]
        happy_kw = ["太棒了", "成功了", "终于", "开心", "awesome", "great"]
        anxious_kw = ["着急", "担心", "焦虑", "anxious", "worried"]
        curious_kw = ["好奇", "想知道", "为什么", "how", "why", "curious"]

        for kw in frustrated_kw if False else frustration_kw:
            if kw in text:
                return EmotionState(
                    emotion_type="frustrated",
                    intensity=0.7,
                    potential_needs=["debugging_help", "emotional_support"],
                    confidence=0.6,
                )
        for kw in angry_kw:
            if kw in text:
                return EmotionState(
                    emotion_type="angry",
                    intensity=0.8,
                    potential_needs=["emotional_support", "clarification"],
                    confidence=0.6,
                )
        for kw in sad_kw:
            if kw in text:
                return EmotionState(
                    emotion_type="sad",
                    intensity=0.6,
                    potential_needs=["emotional_support"],
                    confidence=0.5,
                )
        for kw in happy_kw:
            if kw in text:
                return EmotionState(
                    emotion_type="happy",
                    intensity=0.8,
                    potential_needs=[],
                    confidence=0.7,
                )
        for kw in anxious_kw:
            if kw in text:
                return EmotionState(
                    emotion_type="anxious",
                    intensity=0.6,
                    potential_needs=["reassurance", "quick_solution"],
                    confidence=0.5,
                )
        for kw in curious_kw:
            if kw in text:
                return EmotionState(
                    emotion_type="curious",
                    intensity=0.5,
                    potential_needs=["explanation", "information"],
                    confidence=0.5,
                )

        return EmotionState()

    async def _perceive_scene(self, user_input: str) -> SceneState:
        if self._tool_registry and self._tool_registry.has("scene_perceive"):
            result = await self._tool_registry.execute(
                "scene_perceive", {"text": user_input}
            )
            if result.success:
                import json
                try:
                    data = json.loads(result.output) if isinstance(result.output, str) else result.output
                    return SceneState(
                        scene_type=data.get("type", "general"),
                        interaction_mode=data.get("interactionMode", "text"),
                        recommended_tools=data.get("recommendedTools", []),
                        confidence=float(data.get("confidence", 0.0)),
                    )
                except (ValueError, TypeError) as _exc:
                    log_ignored(log, "bus.PerceptionBus._perceive_scene", _exc)

        if self._llm:
            return await self._perceive_scene_llm(user_input)

        return self._perceive_scene_rule(user_input)

    async def _perceive_scene_llm(self, user_input: str) -> SceneState:
        if not user_input:
            return SceneState()

        prompt = (
            "分析以下用户输入的场景类型，返回JSON：\n"
            '{"type": "coding|debugging|code_review|writing|meeting|presentation|'
            "research|data_analysis|deployment|monitoring|daily|general\", "
            '"interactionMode": "text|voice|gui", '
            '"recommendedTools": ["tool1","tool2"], '
            '"confidence": 0.0-1.0}\n\n'
            f"用户输入: {user_input}"
        )
        try:
            result = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=True,
                task_type="cheap",
            )
            content = result.get("content", "")
            import json
            import re
            match = re.search(r'\{[\s\S]*\}', content)
            if match:
                data = json.loads(match.group())
                return SceneState(
                    scene_type=data.get("type", "general"),
                    interaction_mode=data.get("interactionMode", "text"),
                    recommended_tools=data.get("recommendedTools", []),
                    confidence=float(data.get("confidence", 0.0)),
                )
        except Exception as e:
            log.debug("LLM scene perception failed", error=str(e))

        return self._perceive_scene_rule(user_input)

    @staticmethod
    def _perceive_scene_rule(user_input: str) -> SceneState:
        if not user_input:
            return SceneState()

        text = user_input.lower()
        scene_rules: list[tuple[list[str], str, list[str]]] = [
            (["review", "pr", "代码审查", "审查"], "code_review", ["file_read", "code_analyze"]),
            (["debug", "调试", "报错", "bug", "错误"], "debugging", ["shell_exec", "file_read", "code_analyze"]),
            (["部署", "deploy", "发布", "上线"], "deployment", ["shell_exec", "file_read"]),
            (["监控", "monitor", "日志", "log"], "monitoring", ["shell_exec", "file_read"]),
            (["分析数据", "data analysis", "统计", "报表"], "data_analysis", ["execute_code", "file_read"]),
            (["写", "写作", "文档", "document", "write"], "writing", ["file_write", "file_read"]),
            (["搜索", "search", "查找", "查询"], "research", ["web_search", "file_read"]),
            (["代码", "code", "编程", "实现", "开发"], "coding", ["file_read", "file_write", "code_analyze", "execute_code"]),
        ]

        for keywords, scene_type, tools in scene_rules:
            if any(kw in text for kw in keywords):
                return SceneState(
                    scene_type=scene_type,
                    interaction_mode="text",
                    recommended_tools=tools,
                    confidence=0.6,
                )

        return SceneState()

    async def _perceive_environment(self) -> EnvironmentState:
        if self._tool_registry and self._tool_registry.has("environment_sense"):
            result = await self._tool_registry.execute("environment_sense", {})
            if result.success:
                import json
                try:
                    data = json.loads(result.output) if isinstance(result.output, str) else result.output
                    return EnvironmentState(
                        os_info=data.get("os", ""),
                        active_window=data.get("activeWindow", ""),
                        network_status=data.get("networkStatus", "unknown"),
                        time_context=data.get("timeContext", ""),
                        screen_resolution=data.get("screenResolution", ""),
                    )
                except (ValueError, TypeError) as _exc:
                    log_ignored(log, "bus.PerceptionBus._perceive_environment", _exc)

        return self._perceive_environment_local()

    @staticmethod
    def _perceive_environment_local() -> EnvironmentState:
        import platform
        import datetime

        os_info = f"{platform.system()} {platform.release()}".strip()
        if not os_info:
            os_info = platform.platform()

        now = datetime.datetime.now()
        hour = now.hour
        if 6 <= hour < 12:
            time_ctx = "上午(工作时间)"
        elif 12 <= hour < 14:
            time_ctx = "中午(休息时间)"
        elif 14 <= hour < 18:
            time_ctx = "下午(工作时间)"
        elif 18 <= hour < 22:
            time_ctx = "晚间(个人时间)"
        else:
            time_ctx = "深夜(休息时间)"

        weekday = now.weekday()
        if weekday < 5:
            time_ctx += " 工作日"
        else:
            time_ctx += " 周末"

        active_window = ""
        try:
            if platform.system() == "Windows":
                import ctypes
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                if hwnd:
                    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd) + 1
                    buf = ctypes.create_unicode_buffer(length)
                    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length)
                    active_window = buf.value
            elif platform.system() == "Darwin":
                try:
                    import subprocess
                    result = subprocess.run(
                        ["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
                        capture_output=True, text=True, timeout=2,
                    )
                    if result.returncode == 0:
                        active_window = result.stdout.strip()
                except Exception as _exc:
                    log_ignored(log, "bus.PerceptionBus._perceive_environment_local", _exc)
        except Exception as _exc:
            log_ignored(log, "bus.PerceptionBus._perceive_environment_local", _exc)

        network_status = "unknown"
        try:
            import socket
            socket.create_connection(("8.8.8.8", 53), timeout=2)
            network_status = "online"
        except Exception:
            network_status = "offline"

        screen_resolution = ""
        try:
            if platform.system() == "Windows":
                import ctypes
                user32 = ctypes.windll.user32
                screen_resolution = f"{user32.GetSystemMetrics(0)}x{user32.GetSystemMetrics(1)}"
            elif platform.system() == "Darwin":
                import subprocess
                result = subprocess.run(
                    ["system_profiler", "SPDisplaysDataType"],
                    capture_output=True, text=True, timeout=3,
                )
                for line in result.stdout.split("\n"):
                    if "Resolution" in line:
                        screen_resolution = line.split(":")[-1].strip()
                        break
        except Exception as _exc:
            log_ignored(log, "bus.PerceptionBus._perceive_environment_local", _exc)

        return EnvironmentState(
            os_info=os_info,
            active_window=active_window,
            network_status=network_status,
            time_context=time_ctx,
            screen_resolution=screen_resolution,
        )

    async def _perceive_visual(self) -> VisualState:
        if self._tool_registry and self._tool_registry.has("screen_parse"):
            result = await self._tool_registry.execute(
                "screen_parse", {"context": "desktop", "annotate": False}
            )
            if result.success:
                output = result.output or ""
                elem_count = 0
                has_dialog = False
                has_notification = False

                import re
                count_match = re.search(r'检测到\s*(\d+)\s*个', output)
                if count_match:
                    elem_count = int(count_match.group(1))

                dialog_kw = ["dialog", "对话框", "modal", "popup", "确认", "取消"]
                notification_kw = ["notification", "通知", "toast", "alert", "提醒"]
                output_lower = output.lower()
                has_dialog = any(kw in output_lower for kw in dialog_kw)
                has_notification = any(kw in output_lower for kw in notification_kw)

                return VisualState(
                    screen_description=output[:500],
                    interactive_elements_count=elem_count,
                    has_dialog=has_dialog,
                    has_notification=has_notification,
                )

        return VisualState()

    async def _perceive_audio(self) -> AudioState:
        return AudioState()

    def get_last_state(self) -> PerceptionState | None:
        return self._last_state

    def load_historical_state(self, session_id: str | None = None) -> PerceptionState | None:
        if not self._trajectory_db:
            return None
        try:
            saved = self._trajectory_db.load_latest_environment_state(session_id=session_id)
            if saved is None:
                return None
            return PerceptionState(
                emotion=EmotionState(
                    emotion_type=saved.get("emotion_type", "neutral"),
                    intensity=saved.get("emotion_intensity", 0.5),
                ),
                scene=SceneState(
                    scene_type=saved.get("scene_type", "general"),
                    confidence=saved.get("scene_confidence", 0.0),
                ),
                environment=EnvironmentState(
                    os_info=saved.get("os_info", ""),
                    active_window=saved.get("active_window", ""),
                    network_status=saved.get("network_status", "unknown"),
                    time_context=saved.get("time_context", ""),
                    screen_resolution=saved.get("screen_resolution", ""),
                ),
            )
        except Exception as _exc:
            log_ignored(log, "bus.PerceptionBus.load_historical_state", _exc)
            return None

    def get_statistics(self) -> dict[str, Any]:
        return {
            "perception_count": self._perception_count,
            "level": self._level.value,
            "last_duration_ms": self._last_state.duration_ms if self._last_state else 0,
        }
