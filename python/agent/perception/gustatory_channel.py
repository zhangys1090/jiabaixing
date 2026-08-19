"""味觉通道（Gustatory Channel）—— 五感融合的味觉感知实现。

味觉通道接收来自电子舌传感器、食品数据库 API 等输入源的数据，
转换为标准 SenseSample 灌入 SensoryFusion。

应用场景：
- 智能厨房（菜品味道分析/调味建议）
- 食品质量检测（新鲜度/成分分析）
- 饮食健康管理（营养成分/过敏原检测）
- 食品工业品控

五基本味维度（五原味）：
- 酸（sour）/ 甜（sweet）/ 苦（bitter）/ 咸（salty）/ 鲜（umami）

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python，TS 侧仅入口/透传
- 与 SensoryFusion 解耦：只产出 SenseSample
- 非侵入式：通道禁用时不影响其他感知通道
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.perception.sensory_fusion import SenseSample, SensoryFusion
from agent.core.logger import log_ignored


class TasteDimension(str, Enum):
    SOUR = "sour"
    SWEET = "sweet"
    BITTER = "bitter"
    SALTY = "salty"
    UMAMI = "umami"


class FoodFreshness(str, Enum):
    FRESH = "fresh"
    GOOD = "good"
    FAIR = "fair"
    POOR = "poor"
    SPOILED = "spoiled"


class AllergenType(str, Enum):
    PEANUT = "peanut"
    TREE_NUT = "tree_nut"
    MILK = "milk"
    EGG = "egg"
    WHEAT = "wheat"
    SOY = "soy"
    FISH = "fish"
    SHELLFISH = "shellfish"
    GLUTEN = "gluten"


@dataclass
class TasteProfile:
    sour: float = 0.0
    sweet: float = 0.0
    bitter: float = 0.0
    salty: float = 0.0
    umami: float = 0.0

    def to_dict(self) -> dict[str, float]:
        return {
            "sour": self.sour,
            "sweet": self.sweet,
            "bitter": self.bitter,
            "salty": self.salty,
            "umami": self.umami,
        }

    def dominant(self) -> TasteDimension:
        scores = {
            TasteDimension.SOUR: self.sour,
            TasteDimension.SWEET: self.sweet,
            TasteDimension.BITTER: self.bitter,
            TasteDimension.SALTY: self.salty,
            TasteDimension.UMAMI: self.umami,
        }
        return max(scores, key=scores.get)

    def intensity(self) -> float:
        return max(self.sour, self.sweet, self.bitter, self.salty, self.umami)

    def balance_score(self) -> float:
        values = [self.sour, self.sweet, self.bitter, self.salty, self.umami]
        active = [v for v in values if v > 0.1]
        if len(active) <= 1:
            return 0.3
        avg = sum(active) / len(active)
        variance = sum((v - avg) ** 2 for v in active) / len(active)
        return max(0.0, min(1.0, 1.0 - variance))


@dataclass
class GustatoryReading:
    taste_profile: TasteProfile = field(default_factory=TasteProfile)
    food_name: str = ""
    freshness: FoodFreshness = FoodFreshness.FRESH
    temperature: float = 20.0
    allergens: list[AllergenType] = field(default_factory=list)
    nutrition: dict[str, float] = field(default_factory=dict)
    sensor_id: str = ""
    location: str = ""
    timestamp: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_text(self) -> str:
        parts: list[str] = []
        if self.food_name:
            parts.append(f"食品={self.food_name}")
        tp = self.taste_profile
        active_tastes = []
        for dim in TasteDimension:
            val = getattr(tp, dim.value, 0.0)
            if val > 0.1:
                active_tastes.append(f"{dim.value}={val:.1f}")
        if active_tastes:
            parts.append(f"味觉=[{', '.join(active_tastes)}]")
        if self.freshness != FoodFreshness.FRESH:
            parts.append(f"新鲜度={self.freshness.value}")
        if self.temperature != 20.0:
            parts.append(f"温度={self.temperature:.1f}°C")
        if self.allergens:
            allergen_names = [a.value for a in self.allergens]
            parts.append(f"过敏原=[{', '.join(allergen_names)}]")
        if self.nutrition:
            nutr_parts = [f"{k}={v:.1f}" for k, v in list(self.nutrition.items())[:5]]
            parts.append(f"营养=[{', '.join(nutr_parts)}]")
        return "；".join(parts) if parts else "味觉读数=空"


class GustatoryChannel:
    """味觉感知通道：汇聚味觉/食品数据，产出 gustatory 模态 SenseSample。"""

    def __init__(self, enabled: bool = True, buffer_size: int = 50) -> None:
        self._enabled = enabled
        self._buffer_size = buffer_size
        self._lock = threading.Lock()
        self._readings: list[GustatoryReading] = []
        self._allergen_alerts: list[GustatoryReading] = []

    def ingest(self, reading: GustatoryReading) -> SenseSample | None:
        if not self._enabled:
            return None
        with self._lock:
            self._readings.append(reading)
            if len(self._readings) > self._buffer_size:
                self._readings = self._readings[-self._buffer_size:]
        if reading.allergens:
            self._allergen_alerts.append(reading)
        return self._reading_to_sample(reading)

    def ingest_raw(self, raw: dict[str, Any]) -> SenseSample | None:
        if not self._enabled:
            return None
        reading = self._parse_raw(raw)
        return self.ingest(reading)

    def ingest_many(self, readings: list[GustatoryReading]) -> list[SenseSample]:
        out: list[SenseSample] = []
        for r in readings or []:
            s = self.ingest(r)
            if s is not None:
                out.append(s)
        return out

    def snapshot_samples(self) -> list[SenseSample]:
        with self._lock:
            return [self._reading_to_sample(r) for r in self._readings[-20:]]

    def feed(self, fusion: SensoryFusion) -> None:
        fusion.add_many(self.snapshot_samples())

    def clear(self) -> None:
        with self._lock:
            self._readings.clear()
        self._allergen_alerts.clear()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    @property
    def reading_count(self) -> int:
        with self._lock:
            return len(self._readings)

    @property
    def allergen_alerts(self) -> list[GustatoryReading]:
        return list(self._allergen_alerts)

    @property
    def latest_taste_profile(self) -> TasteProfile | None:
        with self._lock:
            if self._readings:
                return self._readings[-1].taste_profile
        return None

    def _reading_to_sample(self, reading: GustatoryReading) -> SenseSample:
        confidence = self._compute_confidence(reading)
        return SenseSample(
            modality="gustatory",
            content=reading.to_text(),
            confidence=confidence,
            metadata={
                "food_name": reading.food_name,
                "freshness": reading.freshness.value,
                "taste_profile": reading.taste_profile.to_dict(),
                "allergens": [a.value for a in reading.allergens],
                "temperature": reading.temperature,
            },
        )

    def _compute_confidence(self, reading: GustatoryReading) -> float:
        base = 0.70
        intensity = reading.taste_profile.intensity()
        if intensity > 0.5:
            base = min(1.0, base + 0.1)
        if reading.food_name:
            base = min(1.0, base + 0.05)
        if reading.freshness in (FoodFreshness.POOR, FoodFreshness.SPOILED):
            base = min(1.0, base + 0.1)
        if reading.allergens:
            base = min(1.0, base + 0.05)
        return base

    def _parse_raw(self, raw: dict[str, Any]) -> GustatoryReading:
        taste_data = raw.get("taste_profile", {})
        taste_profile = TasteProfile(
            sour=float(taste_data.get("sour", 0.0)),
            sweet=float(taste_data.get("sweet", 0.0)),
            bitter=float(taste_data.get("bitter", 0.0)),
            salty=float(taste_data.get("salty", 0.0)),
            umami=float(taste_data.get("umami", 0.0)),
        )
        freshness_str = raw.get("freshness", "fresh")
        try:
            freshness = FoodFreshness(freshness_str)
        except ValueError:
            freshness = FoodFreshness.FRESH
        allergens: list[AllergenType] = []
        for a_str in raw.get("allergens", []):
            try:
                allergens.append(AllergenType(a_str))
            except ValueError as _exc:
                log_ignored(None, "gustatory_channel.GustatoryChannel._parse_raw", _exc)
        nutrition = raw.get("nutrition", {})
        if isinstance(nutrition, dict):
            nutrition = {k: float(v) for k, v in nutrition.items() if isinstance(v, (int, float))}
        return GustatoryReading(
            taste_profile=taste_profile,
            food_name=raw.get("food_name", ""),
            freshness=freshness,
            temperature=float(raw.get("temperature", 20.0)),
            allergens=allergens,
            nutrition=nutrition,
            sensor_id=raw.get("sensor_id", ""),
            location=raw.get("location", ""),
            metadata=raw.get("metadata", {}),
        )


_default_gustatory: GustatoryChannel | None = None


def get_gustatory_channel() -> GustatoryChannel:
    global _default_gustatory
    if _default_gustatory is None:
        _default_gustatory = GustatoryChannel()
    return _default_gustatory
