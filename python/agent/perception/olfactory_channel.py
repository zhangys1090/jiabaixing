"""嗅觉通道（Olfactory Channel）—— 五感融合的嗅觉感知实现。

嗅觉通道接收来自 IoT 气体传感器（MQ-2/MQ-135 等）、空气质量 API 等输入源的数据，
转换为标准 SenseSample 灌入 SensoryFusion。

应用场景：
- 智能家居安全监控（烟雾/燃气泄漏检测）
- 空气质量感知（PM2.5/CO2/VOC 浓度）
- 工业环境监测（有害气体/易燃气体）
- 食品新鲜度检测

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python，TS 侧仅入口/透传
- 与 SensoryFusion 解耦：只产出 SenseSample
- 非侵入式：通道禁用时不影响其他感知通道
- 安全优先：危险气体浓度超阈值时自动提升置信度
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.perception.sensory_fusion import SenseSample, SensoryFusion
from agent.core.logger import log_ignored


class GasType(str, Enum):
    CO = "co"
    CO2 = "co2"
    SMOKE = "smoke"
    NATURAL_GAS = "natural_gas"
    LPG = "lpg"
    VOC = "voc"
    H2S = "h2s"
    NH3 = "nh3"
    PM25 = "pm25"
    PM10 = "pm10"
    O3 = "o3"
    NO2 = "no2"
    SO2 = "so2"
    FORMALDEHYDE = "formaldehyde"
    ALCOHOL = "alcohol"
    UNKNOWN = "unknown"


class DangerLevel(str, Enum):
    SAFE = "safe"
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"


GAS_DANGER_THRESHOLDS: dict[GasType, dict[str, float]] = {
    GasType.CO: {"low": 35.0, "moderate": 100.0, "high": 200.0, "critical": 400.0},
    GasType.CO2: {"low": 1000.0, "moderate": 2000.0, "high": 5000.0, "critical": 10000.0},
    GasType.SMOKE: {"low": 0.1, "moderate": 0.3, "high": 0.6, "critical": 1.0},
    GasType.NATURAL_GAS: {"low": 0.05, "moderate": 0.1, "high": 0.3, "critical": 1.0},
    GasType.LPG: {"low": 0.05, "moderate": 0.1, "high": 0.3, "critical": 1.0},
    GasType.VOC: {"low": 0.3, "moderate": 0.5, "high": 1.0, "critical": 3.0},
    GasType.H2S: {"low": 5.0, "moderate": 20.0, "high": 50.0, "critical": 100.0},
    GasType.NH3: {"low": 25.0, "moderate": 50.0, "high": 100.0, "critical": 300.0},
    GasType.PM25: {"low": 35.0, "moderate": 75.0, "high": 150.0, "critical": 250.0},
    GasType.PM10: {"low": 50.0, "moderate": 150.0, "high": 250.0, "critical": 420.0},
    GasType.FORMALDEHYDE: {"low": 0.08, "moderate": 0.15, "high": 0.3, "critical": 0.5},
}


@dataclass
class OlfactoryReading:
    gas_type: GasType = GasType.UNKNOWN
    concentration: float = 0.0
    unit: str = "ppm"
    danger_level: DangerLevel = DangerLevel.SAFE
    sensor_id: str = ""
    location: str = ""
    timestamp: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_text(self) -> str:
        parts = [f"气体={self.gas_type.value}", f"浓度={self.concentration:.2f}{self.unit}"]
        if self.danger_level != DangerLevel.SAFE:
            parts.append(f"危险等级={self.danger_level.value}")
        if self.location:
            parts.append(f"位置={self.location}")
        if self.sensor_id:
            parts.append(f"传感器={self.sensor_id}")
        return "；".join(parts)


@dataclass
class OlfactoryZone:
    zone_id: str
    zone_name: str = ""
    readings: dict[GasType, OlfactoryReading] = field(default_factory=dict)
    max_danger_level: DangerLevel = DangerLevel.SAFE


class OlfactoryChannel:
    """嗅觉感知通道：汇聚气体/空气质量数据，产出 olfactory 模态 SenseSample。"""

    def __init__(self, enabled: bool = True, buffer_size: int = 100) -> None:
        self._enabled = enabled
        self._buffer_size = buffer_size
        self._lock = threading.Lock()
        self._readings: list[OlfactoryReading] = []
        self._zones: dict[str, OlfactoryZone] = {}
        self._alert_callbacks: list[Any] = []

    def ingest(self, reading: OlfactoryReading) -> SenseSample | None:
        if not self._enabled:
            return None
        with self._lock:
            self._readings.append(reading)
            if len(self._readings) > self._buffer_size:
                self._readings = self._readings[-self._buffer_size:]
        self._update_zone(reading)
        if reading.danger_level in (DangerLevel.HIGH, DangerLevel.CRITICAL):
            self._fire_alert(reading)
        return self._reading_to_sample(reading)

    def ingest_raw(self, raw: dict[str, Any]) -> SenseSample | None:
        if not self._enabled:
            return None
        reading = self._parse_raw(raw)
        return self.ingest(reading)

    def ingest_many(self, readings: list[OlfactoryReading]) -> list[SenseSample]:
        out: list[SenseSample] = []
        for r in readings or []:
            s = self.ingest(r)
            if s is not None:
                out.append(s)
        return out

    def snapshot_samples(self) -> list[SenseSample]:
        with self._lock:
            return [self._reading_to_sample(r) for r in self._readings[-30:]]

    def feed(self, fusion: SensoryFusion) -> None:
        fusion.add_many(self.snapshot_samples())

    def clear(self) -> None:
        with self._lock:
            self._readings.clear()
        self._zones.clear()

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
    def current_danger_level(self) -> DangerLevel:
        max_level = DangerLevel.SAFE
        priority = {DangerLevel.SAFE: 0, DangerLevel.LOW: 1, DangerLevel.MODERATE: 2, DangerLevel.HIGH: 3, DangerLevel.CRITICAL: 4}
        with self._lock:
            for r in self._readings[-20:]:
                if priority.get(r.danger_level, 0) > priority.get(max_level, 0):
                    max_level = r.danger_level
        return max_level

    @property
    def active_alerts(self) -> list[OlfactoryReading]:
        with self._lock:
            return [r for r in self._readings if r.danger_level in (DangerLevel.HIGH, DangerLevel.CRITICAL)]

    def get_zone(self, zone_id: str) -> OlfactoryZone | None:
        return self._zones.get(zone_id)

    def register_alert_callback(self, callback: Any) -> None:
        self._alert_callbacks.append(callback)

    def _reading_to_sample(self, reading: OlfactoryReading) -> SenseSample:
        confidence = self._compute_confidence(reading)
        return SenseSample(
            modality="olfactory",
            content=reading.to_text(),
            confidence=confidence,
            metadata={
                "gas_type": reading.gas_type.value,
                "concentration": reading.concentration,
                "unit": reading.unit,
                "danger_level": reading.danger_level.value,
                "location": reading.location,
            },
        )

    def _compute_confidence(self, reading: OlfactoryReading) -> float:
        base = 0.75
        if reading.danger_level == DangerLevel.CRITICAL:
            base = 1.0
        elif reading.danger_level == DangerLevel.HIGH:
            base = 0.95
        elif reading.danger_level == DangerLevel.MODERATE:
            base = 0.85
        elif reading.danger_level == DangerLevel.LOW:
            base = 0.80
        if reading.gas_type != GasType.UNKNOWN:
            base = min(1.0, base + 0.05)
        return base

    def _update_zone(self, reading: OlfactoryReading) -> None:
        zone_id = reading.metadata.get("zone_id", reading.location or "default")
        if zone_id not in self._zones:
            self._zones[zone_id] = OlfactoryZone(zone_id=zone_id, zone_name=reading.location)
        zone = self._zones[zone_id]
        zone.readings[reading.gas_type] = reading
        priority = {DangerLevel.SAFE: 0, DangerLevel.LOW: 1, DangerLevel.MODERATE: 2, DangerLevel.HIGH: 3, DangerLevel.CRITICAL: 4}
        for r in zone.readings.values():
            if priority.get(r.danger_level, 0) > priority.get(zone.max_danger_level, 0):
                zone.max_danger_level = r.danger_level

    def _fire_alert(self, reading: OlfactoryReading) -> None:
        for cb in self._alert_callbacks:
            try:
                cb(reading)
            except Exception as _exc:
                log_ignored(None, "olfactory_channel.OlfactoryChannel._fire_alert", _exc)

    @staticmethod
    def assess_danger(gas_type: GasType, concentration: float) -> DangerLevel:
        thresholds = GAS_DANGER_THRESHOLDS.get(gas_type)
        if not thresholds:
            return DangerLevel.SAFE
        if concentration >= thresholds.get("critical", float("inf")):
            return DangerLevel.CRITICAL
        if concentration >= thresholds.get("high", float("inf")):
            return DangerLevel.HIGH
        if concentration >= thresholds.get("moderate", float("inf")):
            return DangerLevel.MODERATE
        if concentration >= thresholds.get("low", float("inf")):
            return DangerLevel.LOW
        return DangerLevel.SAFE

    def _parse_raw(self, raw: dict[str, Any]) -> OlfactoryReading:
        gas_str = raw.get("gas_type", "unknown")
        try:
            gas_type = GasType(gas_str)
        except ValueError:
            gas_type = GasType.UNKNOWN
        concentration = float(raw.get("concentration", 0.0))
        danger_level = self.assess_danger(gas_type, concentration)
        try:
            danger_level = DangerLevel(raw.get("danger_level", danger_level.value))
        except ValueError as _exc:
            log_ignored(None, "olfactory_channel.OlfactoryChannel._parse_raw", _exc)
        return OlfactoryReading(
            gas_type=gas_type,
            concentration=concentration,
            unit=raw.get("unit", "ppm"),
            danger_level=danger_level,
            sensor_id=raw.get("sensor_id", ""),
            location=raw.get("location", ""),
            metadata=raw.get("metadata", {}),
        )


_default_olfactory: OlfactoryChannel | None = None


def get_olfactory_channel() -> OlfactoryChannel:
    global _default_olfactory
    if _default_olfactory is None:
        _default_olfactory = OlfactoryChannel()
    return _default_olfactory
