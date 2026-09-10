"""声学情绪感知（Acoustic Emotion Perception）—— 听觉增强模块。

声学情绪感知模块从语音信号中提取声学特征（语调/语速/音高/能量），
推断说话人的情绪状态，补充文本情绪分析的不足。

核心能力：
1. 声学特征情绪映射：语调↑+语速↑→兴奋；语调↓+语速↓→沮丧
2. 情绪强度估计：基于声学特征的变异程度
3. 情绪变化追踪：追踪同一说话人的情绪变化趋势
4. 多模态融合：与文本情绪分析结果融合，提升情绪识别准确度

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 SensoryFusion 解耦：产出 audio 模态 SenseSample
- 非侵入式：无语音输入时静默降级
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.perception.sensory_fusion import SenseSample, SensoryFusion
from agent.core.logger import StructuredLogger
log = StructuredLogger("acoustic_emotion")



class AcousticEmotion(str, Enum):
    HAPPY = "happy"
    EXCITED = "excited"
    CALM = "calm"
    NEUTRAL = "neutral"
    SAD = "sad"
    ANGRY = "angry"
    ANXIOUS = "anxious"
    FRUSTRATED = "frustrated"
    FEARFUL = "fearful"
    SURPRISED = "surprised"
    BORED = "bored"
    UNKNOWN = "unknown"


@dataclass
class AcousticFeatures:
    pitch_mean: float = 0.0
    pitch_range: float = 0.0
    pitch_slope: float = 0.0
    energy_mean: float = 0.0
    energy_range: float = 0.0
    speaking_rate: float = 0.0
    pause_ratio: float = 0.0
    jitter: float = 0.0
    shimmer: float = 0.0
    harmonicity: float = 0.0
    duration_ms: float = 0.0


@dataclass
class AcousticEmotionResult:
    emotion: AcousticEmotion = AcousticEmotion.UNKNOWN
    intensity: float = 0.5
    confidence: float = 0.0
    features: AcousticFeatures = field(default_factory=AcousticFeatures)
    valence: float = 0.0
    arousal: float = 0.0
    dominance: float = 0.0
    emotion_trend: str = "stable"
    timestamp: float = field(default_factory=time.time)

    def to_text(self) -> str:
        parts = [f"声学情绪={self.emotion.value}", f"强度={self.intensity:.2f}", f"置信度={self.confidence:.2f}"]
        if self.valence != 0.0:
            valence_label = "积极" if self.valence > 0 else "消极"
            parts.append(f"效价={valence_label}({self.valence:.2f})")
        if self.arousal != 0.0:
            arousal_label = "高唤醒" if self.arousal > 0 else "低唤醒"
            parts.append(f"唤醒={arousal_label}({self.arousal:.2f})")
        if self.emotion_trend != "stable":
            parts.append(f"趋势={self.emotion_trend}")
        return "；".join(parts)


class AcousticEmotionPerceiver:
    """声学情绪感知器：从声学特征推断情绪状态。"""

    def __init__(self, enabled: bool = True) -> None:
        self._enabled = enabled
        self._perception_count = 0
        self._emotion_history: list[AcousticEmotionResult] = []
        self._max_history = 50
        self._pitch_baseline = 150.0
        self._energy_baseline = 0.3
        self._rate_baseline = 4.0

    def perceive(self, features: AcousticFeatures) -> AcousticEmotionResult:
        if not self._enabled:
            return AcousticEmotionResult()

        self._perception_count += 1

        valence, arousal, dominance = self._compute_vad(features)
        emotion = self._map_emotion(valence, arousal, dominance, features)
        intensity = self._compute_intensity(features)
        confidence = self._compute_confidence(features, emotion)
        trend = self._compute_trend(emotion)

        result = AcousticEmotionResult(
            emotion=emotion,
            intensity=intensity,
            confidence=confidence,
            features=features,
            valence=valence,
            arousal=arousal,
            dominance=dominance,
            emotion_trend=trend,
        )

        self._emotion_history.append(result)
        if len(self._emotion_history) > self._max_history:
            self._emotion_history = self._emotion_history[-self._max_history:]

        return result

    def perceive_raw(self, raw: dict[str, Any]) -> AcousticEmotionResult:
        features = AcousticFeatures(
            pitch_mean=float(raw.get("pitch_mean", 0.0)),
            pitch_range=float(raw.get("pitch_range", 0.0)),
            pitch_slope=float(raw.get("pitch_slope", 0.0)),
            energy_mean=float(raw.get("energy_mean", 0.0)),
            energy_range=float(raw.get("energy_range", 0.0)),
            speaking_rate=float(raw.get("speaking_rate", 0.0)),
            pause_ratio=float(raw.get("pause_ratio", 0.0)),
            jitter=float(raw.get("jitter", 0.0)),
            shimmer=float(raw.get("shimmer", 0.0)),
            harmonicity=float(raw.get("harmonicity", 0.0)),
            duration_ms=float(raw.get("duration_ms", 0.0)),
        )
        return self.perceive(features)

    def to_sample(self, result: AcousticEmotionResult) -> SenseSample:
        return SenseSample(
            modality="audio",
            content=result.to_text(),
            confidence=result.confidence,
            metadata={
                "emotion": result.emotion.value,
                "intensity": result.intensity,
                "valence": result.valence,
                "arousal": result.arousal,
                "trend": result.emotion_trend,
            },
        )

    def feed(self, result: AcousticEmotionResult, fusion: SensoryFusion) -> None:
        fusion.add(self.to_sample(result))

    def _compute_vad(self, f: AcousticFeatures) -> tuple[float, float, float]:
        pitch_dev = (f.pitch_mean - self._pitch_baseline) / self._pitch_baseline if self._pitch_baseline else 0.0
        energy_dev = (f.energy_mean - self._energy_baseline) / self._energy_baseline if self._energy_baseline else 0.0
        rate_dev = (f.speaking_rate - self._rate_baseline) / self._rate_baseline if self._rate_baseline else 0.0

        valence = 0.0
        valence += pitch_dev * 0.3
        valence += f.pitch_slope * 0.2
        valence -= f.jitter * 0.2

        arousal = 0.0
        arousal += abs(pitch_dev) * 0.3
        arousal += abs(energy_dev) * 0.3
        arousal += abs(rate_dev) * 0.2
        arousal += f.energy_range * 0.2

        dominance = 0.0
        dominance += energy_dev * 0.4
        dominance += rate_dev * 0.3
        dominance += pitch_dev * 0.3

        return (
            max(-1.0, min(1.0, valence)),
            max(-1.0, min(1.0, arousal)),
            max(-1.0, min(1.0, dominance)),
        )

    def _map_emotion(
        self,
        valence: float,
        arousal: float,
        dominance: float,
        features: AcousticFeatures,
    ) -> AcousticEmotion:
        if arousal > 0.5:
            if valence > 0.3:
                if features.speaking_rate > self._rate_baseline * 1.3:
                    return AcousticEmotion.EXCITED
                return AcousticEmotion.HAPPY
            if valence < -0.3:
                if dominance > 0.2:
                    return AcousticEmotion.ANGRY
                if features.pitch_range > 50:
                    return AcousticEmotion.FEARFUL
                return AcousticEmotion.FRUSTRATED
            return AcousticEmotion.ANXIOUS

        if arousal < -0.3:
            if valence < -0.3:
                return AcousticEmotion.SAD
            if valence > 0.1:
                return AcousticEmotion.CALM
            return AcousticEmotion.BORED

        if valence > 0.3:
            return AcousticEmotion.HAPPY
        if valence < -0.3:
            return AcousticEmotion.SAD

        if features.pitch_range > 80:
            return AcousticEmotion.SURPRISED

        return AcousticEmotion.NEUTRAL

    def _compute_intensity(self, features: AcousticFeatures) -> float:
        pitch_dev = abs(features.pitch_mean - self._pitch_baseline) / self._pitch_baseline if self._pitch_baseline else 0.0
        energy_dev = abs(features.energy_mean - self._energy_baseline) / self._energy_baseline if self._energy_baseline else 0.0
        rate_dev = abs(features.speaking_rate - self._rate_baseline) / self._rate_baseline if self._rate_baseline else 0.0
        raw = (pitch_dev + energy_dev + rate_dev) / 3.0
        return min(1.0, raw)

    def _compute_confidence(self, features: AcousticFeatures, emotion: AcousticEmotion) -> float:
        base = 0.5
        if features.pitch_mean > 0:
            base += 0.1
        if features.energy_mean > 0:
            base += 0.1
        if features.speaking_rate > 0:
            base += 0.1
        if features.duration_ms > 500:
            base += 0.1
        if emotion == AcousticEmotion.NEUTRAL:
            base = min(base, 0.7)
        return min(1.0, base)

    def _compute_trend(self, current_emotion: AcousticEmotion) -> str:
        if len(self._emotion_history) < 2:
            return "stable"
        prev = self._emotion_history[-1].emotion
        if prev == current_emotion:
            return "stable"
        negative_emotions = {AcousticEmotion.SAD, AcousticEmotion.ANGRY, AcousticEmotion.ANXIOUS, AcousticEmotion.FRUSTRATED, AcousticEmotion.FEARFUL}
        positive_emotions = {AcousticEmotion.HAPPY, AcousticEmotion.EXCITED, AcousticEmotion.CALM}
        if prev in positive_emotions and current_emotion in negative_emotions:
            return "deteriorating"
        if prev in negative_emotions and current_emotion in positive_emotions:
            return "improving"
        return "changing"

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    @property
    def emotion_history(self) -> list[AcousticEmotionResult]:
        return list(self._emotion_history)

    @property
    def current_emotion(self) -> AcousticEmotion:
        if self._emotion_history:
            return self._emotion_history[-1].emotion
        return AcousticEmotion.UNKNOWN

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "perception_count": self._perception_count,
            "current_emotion": self.current_emotion.value,
            "history_size": len(self._emotion_history),
        }
