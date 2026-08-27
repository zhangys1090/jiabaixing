"""移动控制器（Locomotion Controller）—— 执行层的移动动作接口。

移动控制器负责将高层移动命令（移动到/旋转/停止/跟随/返回等）
转换为底层执行指令，并支持多种执行后端：
- 轮式机器人（通过 ROS/HTTP API）
- 足式机器人（步态规划）
- 无人机（飞控指令）
- 仿真端（虚拟移动，用于测试和训练）

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python，TS 侧仅入口/透传
- 与 ActuationBus 解耦：只消费 ActuationCommand，产出执行结果
- 安全约束：移动动作必须经过碰撞检测和安全边界检查
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from agent.core.logger import StructuredLogger
log = StructuredLogger("locomotion_controller")



class LocomotionType(str, Enum):
    MOVE_TO = "move_to"
    ROTATE = "rotate"
    STOP = "stop"
    FOLLOW = "follow"
    RETURN_HOME = "return_home"
    PATROL = "patrol"
    DOCK = "dock"
    UNDOCK = "undock"


class LocomotionBackend(str, Enum):
    WHEELED = "wheeled"
    LEGGED = "legged"
    AERIAL = "aerial"
    SIMULATION = "simulation"


@dataclass
class Position3D:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def distance_to(self, other: Position3D) -> float:
        return math.sqrt(
            (self.x - other.x) ** 2
            + (self.y - other.y) ** 2
            + (self.z - other.z) ** 2
        )

    def to_tuple(self) -> tuple[float, float, float]:
        return (self.x, self.y, self.z)


@dataclass
class Orientation:
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0


@dataclass
class LocomotionAction:
    action_type: LocomotionType = LocomotionType.MOVE_TO
    target_position: Position3D = field(default_factory=Position3D)
    target_orientation: Orientation = field(default_factory=Orientation)
    speed: float = 0.5
    max_speed: float = 1.0
    follow_target_id: str = ""
    follow_distance: float = 1.0
    patrol_waypoints: list[Position3D] = field(default_factory=list)
    safety_boundary: list[Position3D] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class LocomotionResult:
    success: bool = False
    action_type: LocomotionType = LocomotionType.MOVE_TO
    detail: str = ""
    duration_ms: float = 0.0
    current_position: Position3D = field(default_factory=Position3D)
    current_orientation: Orientation = field(default_factory=Orientation)
    distance_traveled: float = 0.0
    error: str | None = None


class LocomotionController:
    """移动控制器：将高层移动命令转换为底层执行。"""

    def __init__(self, backend: LocomotionBackend = LocomotionBackend.SIMULATION) -> None:
        self._backend = backend
        self._execution_count = 0
        self._success_count = 0
        self._current_position = Position3D()
        self._current_orientation = Orientation()
        self._home_position = Position3D()
        self._backend_executor: Callable[[LocomotionAction], Awaitable[LocomotionResult]] | None = None
        self._collision_check_fn: Callable[[Position3D], bool] | None = None
        self._boundary_check_fn: Callable[[Position3D], bool] | None = None

    def set_backend(self, backend: LocomotionBackend) -> None:
        self._backend = backend

    def set_backend_executor(
        self, executor: Callable[[LocomotionAction], Awaitable[LocomotionResult]]
    ) -> None:
        self._backend_executor = executor

    def set_collision_check(self, fn: Callable[[Position3D], bool]) -> None:
        self._collision_check_fn = fn

    def set_boundary_check(self, fn: Callable[[Position3D], bool]) -> None:
        self._boundary_check_fn = fn

    def set_home_position(self, position: Position3D) -> None:
        self._home_position = position

    def set_current_position(self, position: Position3D) -> None:
        self._current_position = position

    async def execute(self, command: Any) -> LocomotionResult:
        from agent.perception.actuation.actuation_bus import ActuationCommand
        if isinstance(command, ActuationCommand):
            action = self._command_to_action(command)
        elif isinstance(command, LocomotionAction):
            action = command
        else:
            return LocomotionResult(success=False, detail="未知命令类型")

        self._execution_count += 1
        start = time.time()

        if action.action_type == LocomotionType.MOVE_TO:
            if self._collision_check_fn and not self._collision_check_fn(action.target_position):
                return LocomotionResult(
                    success=False,
                    action_type=action.action_type,
                    detail="碰撞检测未通过",
                    duration_ms=(time.time() - start) * 1000,
                    current_position=self._current_position,
                )
            if self._boundary_check_fn and not self._boundary_check_fn(action.target_position):
                return LocomotionResult(
                    success=False,
                    action_type=action.action_type,
                    detail="超出安全边界",
                    duration_ms=(time.time() - start) * 1000,
                    current_position=self._current_position,
                )

        result = await self._dispatch(action)
        result.duration_ms = (time.time() - start) * 1000

        if result.success:
            self._success_count += 1
            self._current_position = result.current_position
            self._current_orientation = result.current_orientation

        return result

    async def _dispatch(self, action: LocomotionAction) -> LocomotionResult:
        if self._backend_executor:
            try:
                return await self._backend_executor(action)
            except Exception as e:
                log.debug("locomotion_controller 异常处理", error=str(e))
                return LocomotionResult(
                    success=False,
                    action_type=action.action_type,
                    error=str(e),
                )

        if self._backend == LocomotionBackend.SIMULATION:
            return self._execute_simulation(action)

        log.info("Locomotion backend execution", action=action.action_type.value, backend=self._backend.value)
        return LocomotionResult(
            success=True,
            action_type=action.action_type,
            detail=f"{self._backend.value} 执行: {action.action_type.value}",
            current_position=action.target_position,
            current_orientation=action.target_orientation,
        )

    def _execute_simulation(self, action: LocomotionAction) -> LocomotionResult:
        if action.action_type == LocomotionType.MOVE_TO:
            distance = self._current_position.distance_to(action.target_position)
            self._current_position = action.target_position
            self._current_orientation = action.target_orientation
            return LocomotionResult(
                success=True,
                action_type=action.action_type,
                detail=f"仿真移动到 ({action.target_position.x:.1f}, {action.target_position.y:.1f}, {action.target_position.z:.1f})",
                current_position=self._current_position,
                current_orientation=self._current_orientation,
                distance_traveled=distance,
            )
        elif action.action_type == LocomotionType.ROTATE:
            self._current_orientation = action.target_orientation
            return LocomotionResult(
                success=True,
                action_type=action.action_type,
                detail=f"仿真旋转到 yaw={action.target_orientation.yaw:.1f}",
                current_position=self._current_position,
                current_orientation=self._current_orientation,
            )
        elif action.action_type == LocomotionType.STOP:
            return LocomotionResult(
                success=True,
                action_type=action.action_type,
                detail="仿真停止",
                current_position=self._current_position,
                current_orientation=self._current_orientation,
            )
        elif action.action_type == LocomotionType.RETURN_HOME:
            distance = self._current_position.distance_to(self._home_position)
            self._current_position = self._home_position
            return LocomotionResult(
                success=True,
                action_type=action.action_type,
                detail="仿真返回原点",
                current_position=self._current_position,
                distance_traveled=distance,
            )
        elif action.action_type == LocomotionType.FOLLOW:
            return LocomotionResult(
                success=True,
                action_type=action.action_type,
                detail=f"仿真跟随目标: {action.follow_target_id}",
                current_position=self._current_position,
            )
        elif action.action_type == LocomotionType.PATROL:
            return LocomotionResult(
                success=True,
                action_type=action.action_type,
                detail=f"仿真巡逻: {len(action.patrol_waypoints)} 个航点",
                current_position=self._current_position,
            )
        elif action.action_type == LocomotionType.DOCK:
            return LocomotionResult(
                success=True,
                action_type=action.action_type,
                detail="仿真对接",
                current_position=self._current_position,
            )
        elif action.action_type == LocomotionType.UNDOCK:
            return LocomotionResult(
                success=True,
                action_type=action.action_type,
                detail="仿真解除对接",
                current_position=self._current_position,
            )

        return LocomotionResult(
            success=False,
            action_type=action.action_type,
            error=f"未知移动动作: {action.action_type.value}",
        )

    def _command_to_action(self, command: Any) -> LocomotionAction:
        from agent.perception.actuation.actuation_bus import ActuationType
        type_map = {
            ActuationType.LOCOMOTION_MOVE_TO: LocomotionType.MOVE_TO,
            ActuationType.LOCOMOTION_ROTATE: LocomotionType.ROTATE,
            ActuationType.LOCOMOTION_STOP: LocomotionType.STOP,
            ActuationType.LOCOMOTION_FOLLOW: LocomotionType.FOLLOW,
            ActuationType.LOCOMOTION_RETURN: LocomotionType.RETURN_HOME,
        }
        action_type = type_map.get(command.action_type, LocomotionType.MOVE_TO)
        target_pos = command.parameters.get("target_position", {})
        position = Position3D(
            x=float(target_pos.get("x", 0.0)),
            y=float(target_pos.get("y", 0.0)),
            z=float(target_pos.get("z", 0.0)),
        )
        target_orient = command.parameters.get("target_orientation", {})
        orientation = Orientation(
            yaw=float(target_orient.get("yaw", 0.0)),
            pitch=float(target_orient.get("pitch", 0.0)),
            roll=float(target_orient.get("roll", 0.0)),
        )
        return LocomotionAction(
            action_type=action_type,
            target_position=position,
            target_orientation=orientation,
            speed=float(command.parameters.get("speed", 0.5)),
            max_speed=float(command.parameters.get("max_speed", 1.0)),
            follow_target_id=command.parameters.get("follow_target_id", ""),
            follow_distance=float(command.parameters.get("follow_distance", 1.0)),
            metadata=command.metadata,
        )

    @property
    def current_position(self) -> Position3D:
        return self._current_position

    @property
    def current_orientation(self) -> Orientation:
        return self._current_orientation

    @property
    def backend(self) -> LocomotionBackend:
        return self._backend

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "backend": self._backend.value,
            "execution_count": self._execution_count,
            "success_count": self._success_count,
            "success_rate": (
                round(self._success_count / self._execution_count, 3)
                if self._execution_count > 0 else 0.0
            ),
            "current_position": self._current_position.to_tuple(),
        }
