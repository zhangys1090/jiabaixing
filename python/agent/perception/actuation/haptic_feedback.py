"""触觉反馈驱动（Haptic Feedback Driver）—— 执行层的触觉反馈接口。

触觉反馈驱动负责将高层触觉反馈命令（振动/力反馈等）
转换为底层设备驱动指令，支持多种反馈设备：
- 振动马达（移动端/手柄）
- 力反馈手套
- 触觉显示器
- 仿真端（虚拟触觉反馈，用于测试）

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python，TS 侧仅入口/透传
- 与 ActuationBus 解耦：只消费 ActuationCommand，产出执行结果
- 非侵入式：无硬件设备时降级为仿真模式
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("haptic_feedback_driver")


class HapticFeedbackType(str, Enum):
    VIBRATE = "vibrate"
    FORCE_FEEDBACK = "force_feedback"
    TEXTURE = "texture"
    TEMPERATURE = "temperature"
    PULSE = "pulse"
    RAMP = "ramp"


class HapticDevice(str, Enum):
    VIBRATION_MOTOR = "vibration_motor"
    FORCE_GLOVE = "force_glove"
    HAPTIC_DISPLAY = "haptic_display"
    GAMEPAD = "gamepad"
    SIMULATION = "simulation"


@dataclass
class HapticFeedbackAction:
    feedback_type: HapticFeedbackType = HapticFeedbackType.VIBRATE
    intensity: float = 0.5
    frequency: float = 150.0
    duration_ms: float = 200.0
    pattern: list[float] = field(default_factory=list)
    force_magnitude: float = 0.0
    force_direction: tuple[float, float, float] = (0.0, 0.0, 0.0)
    zone_id: str = "default"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class HapticFeedbackResult:
    success: bool = False
    feedback_type: HapticFeedbackType = HapticFeedbackType.VIBRATE
    detail: str = ""
    duration_ms: float = 0.0
    error: str | None = None


class HapticFeedbackDriver:
    """触觉反馈驱动：将触觉反馈命令转换为设备驱动指令。"""

    def __init__(self, device: HapticDevice = HapticDevice.SIMULATION) -> None:
        self._device = device
        self._execution_count = 0
        self._success_count = 0
        self._device_executor: Callable[[HapticFeedbackAction], Awaitable[HapticFeedbackResult]] | None = None
        self._max_intensity = 1.0
        self._max_frequency = 500.0
        self._max_duration_ms = 5000.0

    def set_device(self, device: HapticDevice) -> None:
        self._device = device

    def set_device_executor(
        self, executor: Callable[[HapticFeedbackAction], Awaitable[HapticFeedbackResult]]
    ) -> None:
        self._device_executor = executor

    def set_limits(
        self,
        max_intensity: float = 1.0,
        max_frequency: float = 500.0,
        max_duration_ms: float = 5000.0,
    ) -> None:
        self._max_intensity = max_intensity
        self._max_frequency = max_frequency
        self._max_duration_ms = max_duration_ms

    async def execute(self, command: Any) -> HapticFeedbackResult:
        from agent.perception.actuation.actuation_bus import ActuationCommand
        if isinstance(command, ActuationCommand):
            action = self._command_to_action(command)
        elif isinstance(command, HapticFeedbackAction):
            action = command
        else:
            return HapticFeedbackResult(success=False, detail="未知命令类型")

        action = self._clamp_action(action)

        self._execution_count += 1
        start = time.time()

        result = await self._dispatch(action)
        result.duration_ms = (time.time() - start) * 1000

        if result.success:
            self._success_count += 1

        return result

    async def _dispatch(self, action: HapticFeedbackAction) -> HapticFeedbackResult:
        if self._device_executor:
            try:
                return await self._device_executor(action)
            except Exception as e:
                log.debug("haptic_feedback 异常处理", error=str(e))
                return HapticFeedbackResult(
                    success=False,
                    feedback_type=action.feedback_type,
                    error=str(e),
                )

        if self._device == HapticDevice.SIMULATION:
            return self._execute_simulation(action)

        log.info("Haptic device execution", feedback=action.feedback_type.value, device=self._device.value)
        return HapticFeedbackResult(
            success=True,
            feedback_type=action.feedback_type,
            detail=f"{self._device.value} 执行: {action.feedback_type.value}",
        )

    def _execute_simulation(self, action: HapticFeedbackAction) -> HapticFeedbackResult:
        return HapticFeedbackResult(
            success=True,
            feedback_type=action.feedback_type,
            detail=(
                f"仿真触觉反馈: type={action.feedback_type.value}, "
                f"intensity={action.intensity:.2f}, "
                f"frequency={action.frequency:.1f}Hz, "
                f"duration={action.duration_ms:.0f}ms, "
                f"zone={action.zone_id}"
            ),
        )

    def _clamp_action(self, action: HapticFeedbackAction) -> HapticFeedbackAction:
        action.intensity = min(action.intensity, self._max_intensity)
        action.frequency = min(action.frequency, self._max_frequency)
        action.duration_ms = min(action.duration_ms, self._max_duration_ms)
        return action

    def _command_to_action(self, command: Any) -> HapticFeedbackAction:
        from agent.perception.actuation.actuation_bus import ActuationType
        type_map = {
            ActuationType.HAPTIC_VIBRATE: HapticFeedbackType.VIBRATE,
            ActuationType.HAPTIC_FORCE_FEEDBACK: HapticFeedbackType.FORCE_FEEDBACK,
        }
        feedback_type = type_map.get(command.action_type, HapticFeedbackType.VIBRATE)
        direction = command.parameters.get("force_direction", [0.0, 0.0, 0.0])
        if isinstance(direction, (list, tuple)) and len(direction) >= 3:
            force_dir = (float(direction[0]), float(direction[1]), float(direction[2]))
        else:
            force_dir = (0.0, 0.0, 0.0)
        return HapticFeedbackAction(
            feedback_type=feedback_type,
            intensity=float(command.parameters.get("intensity", 0.5)),
            frequency=float(command.parameters.get("frequency", 150.0)),
            duration_ms=float(command.parameters.get("duration_ms", 200.0)),
            pattern=command.parameters.get("pattern", []),
            force_magnitude=float(command.parameters.get("force_magnitude", 0.0)),
            force_direction=force_dir,
            zone_id=command.parameters.get("zone_id", "default"),
            metadata=command.metadata,
        )

    @property
    def device(self) -> HapticDevice:
        return self._device

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "device": self._device.value,
            "execution_count": self._execution_count,
            "success_count": self._success_count,
            "success_rate": (
                round(self._success_count / self._execution_count, 3)
                if self._execution_count > 0 else 0.0
            ),
        }
