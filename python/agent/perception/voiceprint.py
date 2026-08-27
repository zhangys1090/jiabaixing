"""声纹识别（Voiceprint Recognition）—— 听觉增强模块。

声纹识别模块负责从语音信号中提取说话人特征，实现：
1. 说话人辨认：识别当前说话人是谁
2. 说话人验证：验证当前说话人是否为声称的身份
3. 声纹注册：注册新说话人的声纹特征
4. 多说话人分离：区分不同说话人

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 SensoryFusion 解耦：产出 audio 模态 SenseSample
- 非侵入式：无语音输入时静默降级
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Any

from agent.perception.sensory_fusion import SenseSample, SensoryFusion
from agent.core.logger import StructuredLogger
log = StructuredLogger("voiceprint")



@dataclass
class VoiceFeatures:
    mfcc_hash: str = ""
    pitch_mean: float = 0.0
    pitch_std: float = 0.0
    energy_mean: float = 0.0
    energy_std: float = 0.0
    speaking_rate: float = 0.0
    formant_f1: float = 0.0
    formant_f2: float = 0.0
    jitter: float = 0.0
    shimmer: float = 0.0


@dataclass
class SpeakerProfile:
    speaker_id: str
    speaker_name: str = ""
    features: VoiceFeatures = field(default_factory=VoiceFeatures)
    registered_at: float = 0.0
    sample_count: int = 0
    last_seen_at: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class VoiceprintResult:
    speaker_id: str = "unknown"
    speaker_name: str = "未知"
    confidence: float = 0.0
    is_known_speaker: bool = False
    is_verified: bool = False
    features: VoiceFeatures = field(default_factory=VoiceFeatures)
    timestamp: float = field(default_factory=time.time)

    def to_text(self) -> str:
        parts = [f"说话人={self.speaker_name}({self.speaker_id})"]
        parts.append(f"置信度={self.confidence:.2f}")
        if self.is_known_speaker:
            parts.append("已知说话人")
        else:
            parts.append("未知说话人")
        if self.is_verified:
            parts.append("身份已验证")
        return "；".join(parts)


class VoiceprintRecognizer:
    """声纹识别器：说话人辨认与验证。"""

    def __init__(self, enabled: bool = True, similarity_threshold: float = 0.75) -> None:
        self._enabled = enabled
        self._similarity_threshold = similarity_threshold
        self._speakers: dict[str, SpeakerProfile] = {}
        self._recognition_count = 0
        self._known_recognition_count = 0

    def register_speaker(
        self,
        speaker_id: str,
        speaker_name: str,
        features: VoiceFeatures,
        metadata: dict[str, Any] | None = None,
    ) -> SpeakerProfile:
        existing = self._speakers.get(speaker_id)
        if existing:
            existing.sample_count += 1
            existing.last_seen_at = time.time()
            existing.features = self._merge_features(existing.features, features)
            return existing

        profile = SpeakerProfile(
            speaker_id=speaker_id,
            speaker_name=speaker_name,
            features=features,
            registered_at=time.time(),
            sample_count=1,
            last_seen_at=time.time(),
            metadata=metadata or {},
        )
        self._speakers[speaker_id] = profile
        log.info("Speaker registered", speaker_id=speaker_id, name=speaker_name)
        return profile

    def recognize(self, features: VoiceFeatures) -> VoiceprintResult:
        if not self._enabled:
            return VoiceprintResult()

        self._recognition_count += 1

        if not self._speakers:
            return VoiceprintResult(
                speaker_id="unknown",
                confidence=0.0,
                is_known_speaker=False,
                features=features,
            )

        best_id = ""
        best_name = ""
        best_similarity = 0.0

        for sid, profile in self._speakers.items():
            similarity = self._compute_similarity(features, profile.features)
            if similarity > best_similarity:
                best_similarity = similarity
                best_id = sid
                best_name = profile.speaker_name

        is_known = best_similarity >= self._similarity_threshold
        if is_known:
            self._known_recognition_count += 1
            profile = self._speakers[best_id]
            profile.last_seen_at = time.time()
            profile.sample_count += 1

        return VoiceprintResult(
            speaker_id=best_id if is_known else "unknown",
            speaker_name=best_name if is_known else "未知",
            confidence=best_similarity,
            is_known_speaker=is_known,
            is_verified=is_known and best_similarity >= 0.9,
            features=features,
        )

    def verify(self, claimed_speaker_id: str, features: VoiceFeatures) -> VoiceprintResult:
        if not self._enabled:
            return VoiceprintResult(is_verified=False)

        profile = self._speakers.get(claimed_speaker_id)
        if profile is None:
            return VoiceprintResult(
                speaker_id=claimed_speaker_id,
                confidence=0.0,
                is_known_speaker=False,
                is_verified=False,
                features=features,
            )

        similarity = self._compute_similarity(features, profile.features)
        is_verified = similarity >= self._similarity_threshold

        return VoiceprintResult(
            speaker_id=claimed_speaker_id,
            speaker_name=profile.speaker_name,
            confidence=similarity,
            is_known_speaker=True,
            is_verified=is_verified,
            features=features,
        )

    def to_sample(self, result: VoiceprintResult) -> SenseSample:
        return SenseSample(
            modality="audio",
            content=result.to_text(),
            confidence=result.confidence,
            metadata={
                "speaker_id": result.speaker_id,
                "speaker_name": result.speaker_name,
                "is_known": result.is_known_speaker,
                "is_verified": result.is_verified,
            },
        )

    def feed(self, result: VoiceprintResult, fusion: SensoryFusion) -> None:
        fusion.add(self.to_sample(result))

    def _compute_similarity(self, a: VoiceFeatures, b: VoiceFeatures) -> float:
        if not a.mfcc_hash or not b.mfcc_hash:
            score = 0.0
            if a.pitch_mean > 0 and b.pitch_mean > 0:
                pitch_diff = abs(a.pitch_mean - b.pitch_mean) / max(a.pitch_mean, b.pitch_mean)
                score += max(0, 1.0 - pitch_diff) * 0.3
            if a.formant_f1 > 0 and b.formant_f1 > 0:
                f1_diff = abs(a.formant_f1 - b.formant_f1) / max(a.formant_f1, b.formant_f1)
                score += max(0, 1.0 - f1_diff) * 0.2
            if a.speaking_rate > 0 and b.speaking_rate > 0:
                rate_diff = abs(a.speaking_rate - b.speaking_rate) / max(a.speaking_rate, b.speaking_rate)
                score += max(0, 1.0 - rate_diff) * 0.2
            if a.energy_mean > 0 and b.energy_mean > 0:
                energy_diff = abs(a.energy_mean - b.energy_mean) / max(a.energy_mean, b.energy_mean)
                score += max(0, 1.0 - energy_diff) * 0.15
            if a.jitter > 0 and b.jitter > 0:
                jitter_diff = abs(a.jitter - b.jitter) / max(a.jitter, b.jitter)
                score += max(0, 1.0 - jitter_diff) * 0.15
            return min(1.0, score)

        if a.mfcc_hash == b.mfcc_hash:
            return 1.0
        return 0.0

    def _merge_features(self, existing: VoiceFeatures, new: VoiceFeatures) -> VoiceFeatures:
        alpha = 0.3
        return VoiceFeatures(
            mfcc_hash=new.mfcc_hash or existing.mfcc_hash,
            pitch_mean=existing.pitch_mean * (1 - alpha) + new.pitch_mean * alpha,
            pitch_std=existing.pitch_std * (1 - alpha) + new.pitch_std * alpha,
            energy_mean=existing.energy_mean * (1 - alpha) + new.energy_mean * alpha,
            energy_std=existing.energy_std * (1 - alpha) + new.energy_std * alpha,
            speaking_rate=existing.speaking_rate * (1 - alpha) + new.speaking_rate * alpha,
            formant_f1=existing.formant_f1 * (1 - alpha) + new.formant_f1 * alpha,
            formant_f2=existing.formant_f2 * (1 - alpha) + new.formant_f2 * alpha,
            jitter=existing.jitter * (1 - alpha) + new.jitter * alpha,
            shimmer=existing.shimmer * (1 - alpha) + new.shimmer * alpha,
        )

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    @property
    def speaker_count(self) -> int:
        return len(self._speakers)

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "recognition_count": self._recognition_count,
            "known_recognition_count": self._known_recognition_count,
            "speaker_count": len(self._speakers),
            "similarity_threshold": self._similarity_threshold,
        }
