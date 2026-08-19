"""触觉通道（Haptic Channel）—— 五感融合的触觉感知实现。

触觉通道接收来自触摸屏事件、力反馈传感器、振动传感器等触觉输入源的数据，
转换为标准 SenseSample 灌入 SensoryFusion。

应用场景：
- 移动端触摸交互（触摸位置/压力/面积/持续时间）
- 机器人触觉反馈（力矩传感器/压力分布）
- 触觉反馈设备驱动（振动马达/力反馈手套）

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


class HapticEventType(str, Enum):
    TOUCH_START = "touch_start"
    TOUCH_MOVE = "touch_move"
    TOUCH_END = "touch_end"
    PRESSURE_CHANGE = "pressure_change"
    VIBRATION = "vibration"
    FORCE_FEEDBACK = "force_feedback"
    CONTACT = "contact"
    SLIP = "slip"


@dataclass
class HapticEvent:
    event_type: HapticEventType = HapticEventType.TOUCH_START
    position_x: float = 0.0
    position_y: float = 0.0
    pressure: float = 0.0
    contact_area: float = 0.0
    duration_ms: float = 0.0
    vibration_frequency: float = 0.0
    vibration_amplitude: float = 0.0
    force_magnitude: float = 0.0
    force_direction: tuple[float, float, float] = (0.0, 0.0, 0.0)
    timestamp: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_text(self) -> str:
        parts = [f"触觉事件={self.event_type.value}"]
        if self.position_x != 0.0 or self.position_y != 0.0:
            parts.append(f"位置=({self.position_x:.1f},{self.position_y:.1f})")
        if self.pressure > 0.0:
            parts.append(f"压力={self.pressure:.2f}")
        if self.contact_area > 0.0:
            parts.append(f"接触面积={self.contact_area:.1f}")
        if self.duration_ms > 0.0:
            parts.append(f"持续={self.duration_ms:.0f}ms")
        if self.vibration_frequency > 0.0:
            parts.append(f"振动频率={self.vibration_frequency:.1f}Hz/振幅={self.vibration_amplitude:.2f}")
        if self.force_magnitude > 0.0:
            parts.append(f"力={self.force_magnitude:.2f}方向={self.force_direction}")
        return "；".join(parts)


@dataclass
class HapticZone:
    zone_id: str
    zone_name: str = ""
    active: bool = False
    last_pressure: float = 0.0
    last_contact_area: float = 0.0
    event_count: int = 0


class HapticChannel:
    """触觉感知通道：汇聚触觉事件，产出 haptic 模态 SenseSample。"""

    def __init__(self, enabled: bool = True, buffer_size: int = 200) -> None:
        self._enabled = enabled
        self._buffer_size = buffer_size
        self._lock = threading.Lock()
        self._events: list[HapticEvent] = []
        self._zones: dict[str, HapticZone] = {}
        self._pressure_threshold = 0.3
        self._vibration_threshold = 0.1

    def ingest(self, event: HapticEvent) -> SenseSample | None:
        if not self._enabled:
            return None
        with self._lock:
            self._events.append(event)
            if len(self._events) > self._buffer_size:
                self._events = self._events[-self._buffer_size:]
        self._update_zone(event)
        return self._event_to_sample(event)

    def ingest_raw(self, raw: dict[str, Any]) -> SenseSample | None:
        if not self._enabled:
            return None
        event = self._parse_raw(raw)
        return self.ingest(event)

    def ingest_many(self, events: list[HapticEvent]) -> list[SenseSample]:
        out: list[SenseSample] = []
        for e in events or []:
            s = self.ingest(e)
            if s is not None:
                out.append(s)
        return out

    def snapshot_samples(self) -> list[SenseSample]:
        with self._lock:
            return [self._event_to_sample(e) for e in self._events[-20:]]

    def feed(self, fusion: SensoryFusion) -> None:
        fusion.add_many(self.snapshot_samples())

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
        self._zones.clear()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    @property
    def event_count(self) -> int:
        with self._lock:
            return len(self._events)

    @property
    def active_zones(self) -> list[HapticZone]:
        return [z for z in self._zones.values() if z.active]

    def get_zone(self, zone_id: str) -> HapticZone | None:
        return self._zones.get(zone_id)

    def _event_to_sample(self, event: HapticEvent) -> SenseSample:
        confidence = self._compute_confidence(event)
        return SenseSample(
            modality="haptic",
            content=event.to_text(),
            confidence=confidence,
            metadata={
                "event_type": event.event_type.value,
                "pressure": event.pressure,
                "contact_area": event.contact_area,
                "duration_ms": event.duration_ms,
            },
        )

    def _compute_confidence(self, event: HapticEvent) -> float:
        base = 0.8
        if event.pressure > self._pressure_threshold:
            base = min(1.0, base + 0.1)
        if event.contact_area > 0.0:
            base = min(1.0, base + 0.05)
        if event.event_type in (HapticEventType.VIBRATION, HapticEventType.FORCE_FEEDBACK):
            base = min(1.0, base + 0.05)
        return base

    def _update_zone(self, event: HapticEvent) -> None:
        zone_id = event.metadata.get("zone_id", "default")
        if zone_id not in self._zones:
            self._zones[zone_id] = HapticZone(zone_id=zone_id, zone_name=event.metadata.get("zone_name", ""))
        zone = self._zones[zone_id]
        zone.active = event.event_type != HapticEventType.TOUCH_END
        zone.last_pressure = event.pressure
        zone.last_contact_area = event.contact_area
        zone.event_count += 1

    def _parse_raw(self, raw: dict[str, Any]) -> HapticEvent:
        etype_str = raw.get("event_type", "touch_start")
        try:
            etype = HapticEventType(etype_str)
        except ValueError:
            etype = HapticEventType.TOUCH_START
        direction = raw.get("force_direction", [0.0, 0.0, 0.0])
        if isinstance(direction, (list, tuple)) and len(direction) >= 3:
            force_dir = (float(direction[0]), float(direction[1]), float(direction[2]))
        else:
            force_dir = (0.0, 0.0, 0.0)
        return HapticEvent(
            event_type=etype,
            position_x=float(raw.get("position_x", 0.0)),
            position_y=float(raw.get("position_y", 0.0)),
            pressure=float(raw.get("pressure", 0.0)),
            contact_area=float(raw.get("contact_area", 0.0)),
            duration_ms=float(raw.get("duration_ms", 0.0)),
            vibration_frequency=float(raw.get("vibration_frequency", 0.0)),
            vibration_amplitude=float(raw.get("vibration_amplitude", 0.0)),
            force_magnitude=float(raw.get("force_magnitude", 0.0)),
            force_direction=force_dir,
            metadata=raw.get("metadata", {}),
        )


_default_haptic: HapticChannel | None = None


def get_haptic_channel() -> HapticChannel:
    global _default_haptic
    if _default_haptic is None:
        _default_haptic = HapticChannel()
    return _default_haptic
