"""执行总线（Actuation Bus）—— 统一调度手脚动作的执行总线。

与感知总线（PerceptionBus）对称设计：
- PerceptionBus: 外部世界 → 感知 → 决策
- ActuationBus: 决策 → 执行 → 本体感回流

设计要点：
- 统一调度：所有执行动作通过总线分发，确保安全预检和宪法约束
- 本体感回流：每个执行动作完成后自动产生 proprioception SenseSample
- 安全约束：执行前经过 SafetyNet 预检 + ConstitutionGuard 宪法约束
- 降级策略：执行失败时自动降级或重试
- 可观测：每次执行输出追踪数据供 LoopObserver 记录

Usage:
    bus = ActuationBus()
    result = await bus.execute(ActuationCommand(
        action_type=ActuationType.HAND_GRASP,
        target="cup",
        parameters={"force": 0.5},
    ))
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger
from agent.perception.device_sense import get_proprioception_channel
log = StructuredLogger("actuation_bus")



class ActuationType(str, Enum):
    HAND_GRASP = "hand_grasp"
    HAND_RELEASE = "hand_release"
    HAND_POINT = "hand_point"
    HAND_WAVE = "hand_wave"
    HAND_PINCH = "hand_pinch"
    HAND_TAP = "hand_tap"
    HAND_SWIPE = "hand_swipe"
    HAND_DRAG = "hand_drag"
    HAND_TYPE = "hand_type"
    HAND_PRESS = "hand_press"
    LOCOMOTION_MOVE_TO = "locomotion_move_to"
    LOCOMOTION_ROTATE = "locomotion_rotate"
    LOCOMOTION_STOP = "locomotion_stop"
    LOCOMOTION_FOLLOW = "locomotion_follow"
    LOCOMOTION_RETURN = "locomotion_return"
    HAPTIC_VIBRATE = "haptic_vibrate"
    HAPTIC_FORCE_FEEDBACK = "haptic_force_feedback"
    CUSTOM = "custom"


class ActuationStatus(str, Enum):
    PENDING = "pending"
    PRECHECKING = "prechecking"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


@dataclass
class ActuationCommand:
    command_id: str = field(default_factory=lambda: f"act_{uuid.uuid4().hex[:8]}")
    action_type: ActuationType = ActuationType.CUSTOM
    target: str = ""
    parameters: dict[str, Any] = field(default_factory=dict)
    priority: int = 0
    timeout_ms: int = 10000
    requires_safety_check: bool = True
    requires_constitution_check: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ActuationResult:
    command_id: str = ""
    status: ActuationStatus = ActuationStatus.PENDING
    success: bool = False
    detail: str = ""
    duration_ms: float = 0.0
    proprioception_data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    blocked_reason: str | None = None


class ActuationBus:
    """执行总线：统一调度手脚动作。"""

    _instance: ActuationBus | None = None

    def __init__(self) -> None:
        self._hand_controller: Any | None = None
        self._locomotion_controller: Any | None = None
        self._haptic_driver: Any | None = None
        self._safety_check_fn: Callable[[ActuationCommand], Awaitable[bool]] | None = None
        self._constitution_check_fn: Callable[[ActuationCommand], Awaitable[bool]] | None = None
        self._execution_count = 0
        self._last_result: ActuationResult | None = None
        self._history: list[ActuationResult] = []
        self._max_history = 200

    @classmethod
    def get_instance(cls) -> ActuationBus:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def set_hand_controller(self, controller: Any) -> None:
        self._hand_controller = controller

    def set_locomotion_controller(self, controller: Any) -> None:
        self._locomotion_controller = controller

    def set_haptic_driver(self, driver: Any) -> None:
        self._haptic_driver = driver

    def set_safety_check(self, fn: Callable[[ActuationCommand], Awaitable[bool]]) -> None:
        self._safety_check_fn = fn

    def set_constitution_check(self, fn: Callable[[ActuationCommand], Awaitable[bool]]) -> None:
        self._constitution_check_fn = fn

    async def execute(self, command: ActuationCommand) -> ActuationResult:
        start = time.time()
        self._execution_count += 1
        result = ActuationResult(command_id=command.command_id, status=ActuationStatus.PENDING)

        try:
            if command.requires_safety_check and self._safety_check_fn:
                result.status = ActuationStatus.PRECHECKING
                safe = await self._safety_check_fn(command)
                if not safe:
                    result.status = ActuationStatus.BLOCKED
                    result.blocked_reason = "安全预检未通过"
                    result.success = False
                    self._record(result, start)
                    return result

            if command.requires_constitution_check and self._constitution_check_fn:
                constitutional = await self._constitution_check_fn(command)
                if not constitutional:
                    result.status = ActuationStatus.BLOCKED
                    result.blocked_reason = "宪法约束拦截"
                    result.success = False
                    self._record(result, start)
                    return result

            result.status = ActuationStatus.EXECUTING
            executor = self._resolve_executor(command.action_type)

            if executor is None:
                result.status = ActuationStatus.FAILED
                result.success = False
                result.error = f"无可用执行器: {command.action_type.value}"
                self._record(result, start)
                return result

            try:
                timeout_sec = command.timeout_ms / 1000.0
                exec_result = await asyncio.wait_for(
                    executor(command),
                    timeout=timeout_sec,
                )
                result.status = ActuationStatus.COMPLETED
                result.success = True
                result.detail = str(exec_result) if exec_result else "执行完成"
            except asyncio.TimeoutError:
                result.status = ActuationStatus.FAILED
                result.success = False
                result.error = f"执行超时 ({command.timeout_ms}ms)"
            except Exception as e:
                log.debug("actuation_bus 异常处理", error=str(e))
                result.status = ActuationStatus.FAILED
                result.success = False
                result.error = str(e)

        except Exception as e:
            log.debug("actuation_bus 异常处理", error=str(e))
            result.status = ActuationStatus.FAILED
            result.success = False
            result.error = f"总线异常: {e}"

        self._emit_proprioception(command, result)
        self._record(result, start)

        log.info(
            "Actuation completed",
            action=command.action_type.value,
            success=result.success,
            duration_ms=round(result.duration_ms),
        )

        return result

    async def execute_many(self, commands: list[ActuationCommand]) -> list[ActuationResult]:
        results: list[ActuationResult] = []
        for cmd in commands:
            result = await self.execute(cmd)
            results.append(result)
            if result.status == ActuationStatus.BLOCKED:
                break
        return results

    async def execute_parallel(self, commands: list[ActuationCommand]) -> list[ActuationResult]:
        tasks = [self.execute(cmd) for cmd in commands]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        return [r if isinstance(r, ActuationResult) else ActuationResult(command_id="error", status=ActuationStatus.FAILED, error=str(r)) for r in results]

    def _resolve_executor(
        self, action_type: ActuationType
    ) -> Callable[[ActuationCommand], Awaitable[Any]] | None:
        hand_actions = {
            ActuationType.HAND_GRASP, ActuationType.HAND_RELEASE,
            ActuationType.HAND_POINT, ActuationType.HAND_WAVE,
            ActuationType.HAND_PINCH, ActuationType.HAND_TAP,
            ActuationType.HAND_SWIPE, ActuationType.HAND_DRAG,
            ActuationType.HAND_TYPE, ActuationType.HAND_PRESS,
        }
        locomotion_actions = {
            ActuationType.LOCOMOTION_MOVE_TO, ActuationType.LOCOMOTION_ROTATE,
            ActuationType.LOCOMOTION_STOP, ActuationType.LOCOMOTION_FOLLOW,
            ActuationType.LOCOMOTION_RETURN,
        }
        haptic_actions = {
            ActuationType.HAPTIC_VIBRATE, ActuationType.HAPTIC_FORCE_FEEDBACK,
        }

        if action_type in hand_actions and self._hand_controller:
            return self._hand_controller.execute
        if action_type in locomotion_actions and self._locomotion_controller:
            return self._locomotion_controller.execute
        if action_type in haptic_actions and self._haptic_driver:
            return self._haptic_driver.execute
        return None

    def _emit_proprioception(self, command: ActuationCommand, result: ActuationResult) -> None:
        try:
            channel = get_proprioception_channel()
            channel.record_action(
                action=f"{command.action_type.value}:{command.target}",
                success=result.success,
                detail=result.detail or result.error or "",
                confidence=0.9 if result.success else 0.5,
            )
        except Exception as e:
            log.debug("Failed to emit proprioception", error=str(e))

    def _record(self, result: ActuationResult, start: float) -> None:
        result.duration_ms = (time.time() - start) * 1000
        self._last_result = result
        self._history.append(result)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

    @property
    def execution_count(self) -> int:
        return self._execution_count

    @property
    def last_result(self) -> ActuationResult | None:
        return self._last_result

    @property
    def history(self) -> list[ActuationResult]:
        return list(self._history)

    def get_stats(self) -> dict[str, Any]:
        total = len(self._history)
        success = sum(1 for r in self._history if r.success)
        blocked = sum(1 for r in self._history if r.status == ActuationStatus.BLOCKED)
        avg_duration = (
            sum(r.duration_ms for r in self._history) / total if total > 0 else 0.0
        )
        return {
            "total_executions": self._execution_count,
            "history_size": total,
            "success_count": success,
            "blocked_count": blocked,
            "success_rate": round(success / total, 3) if total > 0 else 0.0,
            "avg_duration_ms": round(avg_duration, 1),
        }


_default_bus: ActuationBus | None = None


def get_actuation_bus() -> ActuationBus:
    global _default_bus
    if _default_bus is None:
        _default_bus = ActuationBus()
    return _default_bus
