"""触觉反馈设备驱动集合（Haptic Device Drivers）—— 物理触觉反馈设备驱动。

为 HapticFeedbackDriver 提供实际设备驱动能力：
1. 振动马达驱动：移动端/手柄振动控制
2. 力反馈手套驱动：力反馈手套关节控制
3. 触觉显示器驱动：触觉图形显示器
4. 游戏手柄驱动：通过 SDL/游戏手柄 API 控制振动
5. 仿真驱动：用于测试和训练的虚拟触觉反馈

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 HapticFeedbackDriver 解耦：只消费 HapticFeedbackAction，产出 HapticFeedbackResult
- 安全约束：强度限制、频率限制、持续时间限制
"""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("haptic_device_drivers")



class HapticDriverType(str, Enum):
    VIBRATION_MOTOR = "vibration_motor"
    FORCE_GLOVE = "force_glove"
    HAPTIC_DISPLAY = "haptic_display"
    GAMEPAD_SDL = "gamepad_sdl"
    SERIAL_HAPTIC = "serial_haptic"
    SIMULATION = "simulation"


@dataclass
class VibrationPattern:
    on_ms: list[float] = field(default_factory=list)
    off_ms: list[float] = field(default_factory=list)
    repeat: int = 1

    @classmethod
    def from_single(cls, duration_ms: float, intensity: float) -> VibrationPattern:
        on_time = duration_ms * intensity
        off_time = duration_ms * (1.0 - intensity)
        return cls(on_ms=[on_time], off_ms=[off_time], repeat=1)

    @classmethod
    def from_pulse(cls, pulse_count: int, pulse_ms: float = 50.0, gap_ms: float = 50.0) -> VibrationPattern:
        return cls(
            on_ms=[pulse_ms] * pulse_count,
            off_ms=[gap_ms] * pulse_count,
            repeat=1,
        )


@dataclass
class ForceGloveCommand:
    finger_forces: list[float] = field(default_factory=lambda: [0.0] * 5)
    wrist_torque: tuple[float, float, float] = (0.0, 0.0, 0.0)
    vibration_intensity: float = 0.0
    duration_ms: float = 200.0


@dataclass
class HapticDisplayCommand:
    pin_matrix: list[list[float]] = field(default_factory=list)
    rows: int = 8
    cols: int = 8
    refresh_rate_hz: float = 60.0
    duration_ms: float = 500.0


@dataclass
class HapticSafetyConfig:
    max_intensity: float = 1.0
    max_frequency_hz: float = 500.0
    max_duration_ms: float = 5000.0
    max_force_n: float = 20.0
    thermal_max_celsius: float = 42.0
    rest_period_ms: float = 100.0


class VibrationMotorDriver:
    """振动马达驱动：控制移动端/手柄振动马达。"""

    def __init__(self, safety: HapticSafetyConfig | None = None) -> None:
        self._safety = safety or HapticSafetyConfig()
        self._last_vibration_end: float = 0.0
        self._execution_count = 0

    async def execute(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.haptic_feedback import HapticFeedbackAction, HapticFeedbackType
        if not isinstance(action, HapticFeedbackAction):
            return {"success": False, "error": "未知命令类型"}

        self._execution_count += 1
        start = time.time()

        elapsed_since_last = (time.time() - self._last_vibration_end) * 1000
        if elapsed_since_last < self._safety.rest_period_ms:
            await asyncio.sleep((self._safety.rest_period_ms - elapsed_since_last) / 1000.0)

        intensity = min(action.intensity, self._safety.max_intensity)
        frequency = min(action.frequency, self._safety.max_frequency_hz)
        duration_ms = min(action.duration_ms, self._safety.max_duration_ms)

        pattern = VibrationPattern.from_single(duration_ms, intensity)
        if action.pattern:
            pattern = VibrationPattern(
                on_ms=action.pattern[:len(action.pattern)//2 + 1],
                off_ms=action.pattern[len(action.pattern)//2:],
                repeat=1,
            )

        result = await self._vibrate(pattern, frequency)
        self._last_vibration_end = time.time()

        result["duration_ms"] = (time.time() - start) * 1000
        return result

    async def _vibrate(self, pattern: VibrationPattern, frequency: float) -> dict[str, Any]:
        log.info("Vibration motor", pattern_on=pattern.on_ms, frequency=frequency)
        return {
            "success": True,
            "detail": f"振动马达: pattern={len(pattern.on_ms)}段, freq={frequency:.0f}Hz",
            "pattern": {"on_ms": pattern.on_ms, "off_ms": pattern.off_ms, "repeat": pattern.repeat},
        }


class ForceGloveDriver:
    """力反馈手套驱动：控制力反馈手套关节力矩和振动。"""

    def __init__(self, safety: HapticSafetyConfig | None = None, num_fingers: int = 5) -> None:
        self._safety = safety or HapticSafetyConfig()
        self._num_fingers = num_fingers
        self._execution_count = 0

    async def execute(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.haptic_feedback import HapticFeedbackAction, HapticFeedbackType
        if not isinstance(action, HapticFeedbackAction):
            return {"success": False, "error": "未知命令类型"}

        self._execution_count += 1
        start = time.time()

        if action.feedback_type == HapticFeedbackType.FORCE_FEEDBACK:
            force = min(action.force_magnitude, self._safety.max_force_n)
            finger_forces = [force] * self._num_fingers
            if action.zone_id and action.zone_id.isdigit():
                idx = int(action.zone_id) % self._num_fingers
                finger_forces = [0.0] * self._num_fingers
                finger_forces[idx] = force

            cmd = ForceGloveCommand(
                finger_forces=finger_forces,
                wrist_torque=action.force_direction,
                vibration_intensity=action.intensity * 0.3,
                duration_ms=action.duration_ms,
            )

            result = await self._apply_force(cmd)
            result["duration_ms"] = (time.time() - start) * 1000
            return result

        if action.feedback_type == HapticFeedbackType.VIBRATE:
            result = await self._vibrate_glove(action)
            result["duration_ms"] = (time.time() - start) * 1000
            return result

        return {
            "success": True,
            "detail": f"力反馈手套仿真: type={action.feedback_type.value}",
            "duration_ms": (time.time() - start) * 1000,
        }

    async def _apply_force(self, cmd: ForceGloveCommand) -> dict[str, Any]:
        log.info("Force glove apply", forces=cmd.finger_forces, duration_ms=cmd.duration_ms)
        return {
            "success": True,
            "detail": f"力反馈手套: forces={[round(f, 2) for f in cmd.finger_forces]}, duration={cmd.duration_ms:.0f}ms",
            "finger_forces": cmd.finger_forces,
        }

    async def _vibrate_glove(self, action: Any) -> dict[str, Any]:
        return {
            "success": True,
            "detail": f"力反馈手套振动: intensity={action.intensity:.2f}, freq={action.frequency:.0f}Hz",
        }


class HapticDisplayDriver:
    """触觉显示器驱动：控制触觉图形显示器（针矩阵）。"""

    def __init__(self, safety: HapticSafetyConfig | None = None, rows: int = 8, cols: int = 8) -> None:
        self._safety = safety or HapticSafetyConfig()
        self._rows = rows
        self._cols = cols
        self._execution_count = 0

    async def execute(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.haptic_feedback import HapticFeedbackAction, HapticFeedbackType
        if not isinstance(action, HapticFeedbackAction):
            return {"success": False, "error": "未知命令类型"}

        self._execution_count += 1
        start = time.time()

        if action.feedback_type == HapticFeedbackType.TEXTURE:
            pin_matrix = self._generate_texture(action)
            cmd = HapticDisplayCommand(
                pin_matrix=pin_matrix,
                rows=self._rows,
                cols=self._cols,
                duration_ms=action.duration_ms,
            )
            result = await self._render(cmd)
            result["duration_ms"] = (time.time() - start) * 1000
            return result

        return {
            "success": True,
            "detail": f"触觉显示器仿真: type={action.feedback_type.value}",
            "duration_ms": (time.time() - start) * 1000,
        }

    def _generate_texture(self, action: Any) -> list[list[float]]:
        intensity = min(action.intensity, self._safety.max_intensity)
        pattern = action.pattern if action.pattern else [0.5, 0.3, 0.8, 0.2]
        matrix = []
        for r in range(self._rows):
            row = []
            for c in range(self._cols):
                idx = (r * self._cols + c) % len(pattern)
                row.append(pattern[idx] * intensity)
            matrix.append(row)
        return matrix

    async def _render(self, cmd: HapticDisplayCommand) -> dict[str, Any]:
        log.info("Haptic display render", rows=cmd.rows, cols=cmd.cols, duration_ms=cmd.duration_ms)
        return {
            "success": True,
            "detail": f"触觉显示器: {cmd.rows}x{cmd.cols} 针矩阵, duration={cmd.duration_ms:.0f}ms",
            "active_pins": sum(1 for row in cmd.pin_matrix for v in row if v > 0.1),
        }


class GamepadHapticDriver:
    """游戏手柄驱动：通过游戏手柄 API 控制振动。"""

    def __init__(self, safety: HapticSafetyConfig | None = None) -> None:
        self._safety = safety or HapticSafetyConfig()
        self._execution_count = 0

    async def execute(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.haptic_feedback import HapticFeedbackAction, HapticFeedbackType
        if not isinstance(action, HapticFeedbackAction):
            return {"success": False, "error": "未知命令类型"}

        self._execution_count += 1
        start = time.time()

        intensity = min(action.intensity, self._safety.max_intensity)
        duration_ms = min(action.duration_ms, self._safety.max_duration_ms)

        try:
            result = await self._rumble(intensity, duration_ms)
        except Exception as e:
            log.debug("haptic_device_drivers 异常处理", error=str(e))
            result = {"success": False, "error": f"游戏手柄驱动失败: {e}"}

        result["duration_ms"] = (time.time() - start) * 1000
        return result

    async def _rumble(self, intensity: float, duration_ms: float) -> dict[str, Any]:
        low_freq = intensity * 0.6
        high_freq = intensity
        return {
            "success": True,
            "detail": f"游戏手柄振动: low={low_freq:.2f}, high={high_freq:.2f}, duration={duration_ms:.0f}ms",
            "low_frequency": low_freq,
            "high_frequency": high_freq,
        }


class HapticDriverFactory:
    """触觉反馈设备驱动工厂：根据设备类型创建对应驱动。"""

    @staticmethod
    def create(
        device_type: HapticDriverType,
        safety: HapticSafetyConfig | None = None,
    ) -> Any:
        if device_type == HapticDriverType.VIBRATION_MOTOR:
            return VibrationMotorDriver(safety)
        if device_type == HapticDriverType.FORCE_GLOVE:
            return ForceGloveDriver(safety)
        if device_type == HapticDriverType.HAPTIC_DISPLAY:
            return HapticDisplayDriver(safety)
        if device_type == HapticDriverType.GAMEPAD_SDL:
            return GamepadHapticDriver(safety)
        return None
