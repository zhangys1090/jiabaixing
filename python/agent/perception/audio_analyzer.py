"""环境音分析器（Audio Analyzer）—— 听觉增强模块。

在现有 SpeechRecognizer（语音转文字）基础上，增加：
1. 环境音分类：噪声/音乐/语音/静音/警报等
2. 声纹识别：说话人辨认与验证
3. 声学情绪感知：语调/语速/音高分析

这三个模块共同构成完整的听觉感知增强，使 jiabaixing 不仅能"听到文字"，
还能"听懂环境"和"感知情绪"。

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 SensoryFusion 解耦：产出 audio 模态 SenseSample
- 非侵入式：模块不可用时静默降级
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.perception.sensory_fusion import SenseSample, SensoryFusion
from agent.core.logger import StructuredLogger

log = StructuredLogger("audio_analyzer")


class AudioClass(str, Enum):
    SPEECH = "speech"
    MUSIC = "music"
    NOISE = "noise"
    SILENCE = "silence"
    ALARM = "alarm"
    NATURE = "nature"
    MECHANICAL = "mechanical"
    KNOCK = "knock"
    PHONE_RING = "phone_ring"
    DOORBELL = "doorbell"
    UNKNOWN = "unknown"


@dataclass
class AudioFeatures:
    rms_energy: float = 0.0
    zero_crossing_rate: float = 0.0
    spectral_centroid: float = 0.0
    spectral_bandwidth: float = 0.0
    pitch_hz: float = 0.0
    tempo_bpm: float = 0.0
    harmonicity: float = 0.0
    duration_ms: float = 0.0
    sample_rate: int = 16000
    channels: int = 1


@dataclass
class AudioAnalysisResult:
    audio_class: AudioClass = AudioClass.UNKNOWN
    confidence: float = 0.0
    features: AudioFeatures = field(default_factory=AudioFeatures)
    description: str = ""
    is_alert: bool = False
    timestamp: float = field(default_factory=time.time)

    def to_text(self) -> str:
        parts = [f"音频类型={self.audio_class.value}", f"置信度={self.confidence:.2f}"]
        if self.is_alert:
            parts.append("⚠警报")
        if self.features.rms_energy > 0:
            parts.append(f"能量={self.features.rms_energy:.2f}")
        if self.features.pitch_hz > 0:
            parts.append(f"音高={self.features.pitch_hz:.0f}Hz")
        if self.features.tempo_bpm > 0:
            parts.append(f"节拍={self.features.tempo_bpm:.0f}BPM")
        if self.description:
            parts.append(f"描述={self.description}")
        return "；".join(parts)


class AudioAnalyzer:
    """环境音分析器：对音频流进行分类和特征提取。"""

    def __init__(self, enabled: bool = True) -> None:
        self._enabled = enabled
        self._analysis_count = 0
        self._alert_keywords = ["警报", "报警", "火警", "alarm", "siren"]
        self._energy_threshold_silence = 0.01
        self._energy_threshold_loud = 0.5

    def analyze(self, features: AudioFeatures, description: str = "") -> AudioAnalysisResult:
        if not self._enabled:
            return AudioAnalysisResult(description="分析器未启用")

        self._analysis_count += 1
        audio_class = self._classify(features, description)
        confidence = self._compute_confidence(features, audio_class)
        is_alert = self._check_alert(audio_class, description)

        return AudioAnalysisResult(
            audio_class=audio_class,
            confidence=confidence,
            features=features,
            description=description,
            is_alert=is_alert,
        )

    def analyze_raw(self, raw: dict[str, Any]) -> AudioAnalysisResult:
        features = AudioFeatures(
            rms_energy=float(raw.get("rms_energy", 0.0)),
            zero_crossing_rate=float(raw.get("zero_crossing_rate", 0.0)),
            spectral_centroid=float(raw.get("spectral_centroid", 0.0)),
            spectral_bandwidth=float(raw.get("spectral_bandwidth", 0.0)),
            pitch_hz=float(raw.get("pitch_hz", 0.0)),
            tempo_bpm=float(raw.get("tempo_bpm", 0.0)),
            harmonicity=float(raw.get("harmonicity", 0.0)),
            duration_ms=float(raw.get("duration_ms", 0.0)),
        )
        return self.analyze(features, raw.get("description", ""))

    def to_sample(self, result: AudioAnalysisResult) -> SenseSample:
        return SenseSample(
            modality="audio",
            content=result.to_text(),
            confidence=result.confidence,
            metadata={
                "audio_class": result.audio_class.value,
                "is_alert": result.is_alert,
                "rms_energy": result.features.rms_energy,
                "pitch_hz": result.features.pitch_hz,
            },
        )

    def feed(self, result: AudioAnalysisResult, fusion: SensoryFusion) -> None:
        fusion.add(self.to_sample(result))

    def _classify(self, features: AudioFeatures, description: str) -> AudioClass:
        desc_lower = description.lower()

        for kw in self._alert_keywords:
            if kw in desc_lower:
                return AudioClass.ALARM

        if features.rms_energy < self._energy_threshold_silence:
            return AudioClass.SILENCE

        if features.harmonicity > 0.7 and features.tempo_bpm > 60:
            return AudioClass.MUSIC

        if features.pitch_hz > 0 and 80 < features.pitch_hz < 400 and features.harmonicity > 0.4:
            return AudioClass.SPEECH

        if features.spectral_centroid > 4000:
            return AudioClass.MECHANICAL

        if features.rms_energy > self._energy_threshold_loud:
            return AudioClass.NOISE

        return AudioClass.UNKNOWN

    def _compute_confidence(self, features: AudioFeatures, audio_class: AudioClass) -> float:
        base = 0.6
        if audio_class == AudioClass.SILENCE and features.rms_energy < self._energy_threshold_silence:
            base = 0.95
        elif audio_class == AudioClass.SPEECH and features.harmonicity > 0.5:
            base = 0.85
        elif audio_class == AudioClass.MUSIC and features.harmonicity > 0.7:
            base = 0.80
        elif audio_class == AudioClass.ALARM:
            base = 0.90
        elif audio_class == AudioClass.NOISE:
            base = 0.70
        return base

    def _check_alert(self, audio_class: AudioClass, description: str) -> bool:
        if audio_class == AudioClass.ALARM:
            return True
        desc_lower = description.lower()
        return any(kw in desc_lower for kw in self._alert_keywords)

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "analysis_count": self._analysis_count,
        }
