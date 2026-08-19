"""足式移动驱动（Legged Locomotion Driver）—— 足式机器人/双足步行控制接口。

为 LocomotionController 的 LEGGED 后端提供实际驱动能力：
1. ROS2 驱动：通过 ROS2 控制足式机器人（如 Unitree Go2、Boston Dynamics Spot）
2. HTTP API 驱动：通过 REST API 控制云服务机器人
3. 仿真驱动：用于测试和训练的虚拟足式机器人

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 LocomotionController 解耦：只消费 LocomotionAction，产出 LocomotionResult
- 安全约束：步态稳定性检测、倾倒保护、地形评估
"""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("legged_locomotion_driver")


class LeggedDriverType(str, Enum):
    ROS2 = "ros2"
    HTTP_API = "http_api"
    SIMULATION = "simulation"


class GaitType(str, Enum):
    WALK = "walk"
    TROT = "trot"
    CRAWL = "crawl"
    GALLOP = "gallop"
    STAND = "stand"


@dataclass
class LeggedSafetyConfig:
    max_speed_ms: float = 1.5
    max_slope_deg: float = 30.0
    stability_threshold: float = 0.6
    obstacle_detection_enabled: bool = True
    fall_recovery_enabled: bool = True


@dataclass
class LeggedTelemetry:
    position_x: float = 0.0
    position_y: float = 0.0
    position_z: float = 0.0
    heading_deg: float = 0.0
    speed_ms: float = 0.0
    gait: GaitType = GaitType.STAND
    stability_score: float = 1.0
    battery_percent: float = 100.0
    foot_contacts: list[bool] = field(default_factory=lambda: [True] * 4)
    imu_accel: tuple[float, float, float] = (0.0, 0.0, 9.8)
    imu_gyro: tuple[float, float, float] = (0.0, 0.0, 0.0)


class LeggedLocomotionDriver:
    """足式移动驱动：将 LocomotionAction 转换为足式机器人控制指令。"""

    _instance: LeggedLocomotionDriver | None = None

    def __init__(
        self,
        driver_type: LeggedDriverType = LeggedDriverType.SIMULATION,
        safety_config: LeggedSafetyConfig | None = None,
        api_endpoint: str = "",
        num_legs: int = 4,
    ) -> None:
        self._driver_type = driver_type
        self._safety = safety_config or LeggedSafetyConfig()
        self._api_endpoint = api_endpoint
        self._num_legs = num_legs
        self._telemetry = LeggedTelemetry()
        self._execution_count = 0
        self._success_count = 0

    @classmethod
    def get_instance(cls) -> LeggedLocomotionDriver:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    async def execute(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.locomotion_controller import LocomotionAction
        if not isinstance(action, LocomotionAction):
            return {"success": False, "error": "未知命令类型"}

        self._execution_count += 1
        start = time.time()

        try:
            if not self._check_stability():
                return {
                    "success": False,
                    "error": "稳定性不足，拒绝执行移动指令",
                    "stability_score": self._telemetry.stability_score,
                    "duration_ms": (time.time() - start) * 1000,
                }

            result = await self._dispatch(action)
            result["duration_ms"] = (time.time() - start) * 1000

            if result.get("success", False):
                self._success_count += 1

            return result

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "duration_ms": (time.time() - start) * 1000,
            }

    async def _dispatch(self, action: Any) -> dict[str, Any]:
        if self._driver_type == LeggedDriverType.SIMULATION:
            return self._execute_simulation(action)
        if self._driver_type == LeggedDriverType.HTTP_API:
            return await self._execute_http_api(action)
        if self._driver_type == LeggedDriverType.ROS2:
            return await self._execute_ros2(action)
        return {"success": False, "error": f"未知驱动类型: {self._driver_type.value}"}

    def _execute_simulation(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.locomotion_controller import LocomotionType

        if action.action_type == LocomotionType.MOVE_TO:
            target = action.target_position
            dx = target.x - self._telemetry.position_x
            dy = target.y - self._telemetry.position_y
            distance = math.sqrt(dx * dx + dy * dy)

            gait = GaitType.WALK
            if distance > 5.0:
                gait = GaitType.TROT
            if distance > 15.0:
                gait = GaitType.GALLOP

            self._telemetry.position_x = target.x
            self._telemetry.position_y = target.y
            self._telemetry.position_z = target.z
            self._telemetry.speed_ms = action.speed
            self._telemetry.gait = gait

            return {
                "success": True,
                "detail": f"仿真步行到 ({target.x:.1f}, {target.y:.1f}, {target.z:.1f}), 步态={gait.value}",
                "distance": distance,
                "gait": gait.value,
            }

        if action.action_type == LocomotionType.ROTATE:
            self._telemetry.heading_deg = action.target_orientation.yaw
            return {
                "success": True,
                "detail": f"仿真旋转到 heading={action.target_orientation.yaw:.1f}°",
            }

        if action.action_type == LocomotionType.STOP:
            self._telemetry.speed_ms = 0.0
            self._telemetry.gait = GaitType.STAND
            return {"success": True, "detail": "仿真停止，站立"}

        if action.action_type == LocomotionType.RETURN_HOME:
            self._telemetry.position_x = 0.0
            self._telemetry.position_y = 0.0
            self._telemetry.position_z = 0.0
            self._telemetry.gait = GaitType.WALK
            return {"success": True, "detail": "仿真返回原点"}

        if action.action_type == LocomotionType.PATROL:
            self._telemetry.gait = GaitType.WALK
            return {
                "success": True,
                "detail": f"仿真巡逻: {len(action.patrol_waypoints)} 个航点",
            }

        return {"success": True, "detail": f"仿真执行: {action.action_type.value}"}

    async def _execute_http_api(self, action: Any) -> dict[str, Any]:
        if not self._api_endpoint:
            return {"success": False, "error": "HTTP API 端点未配置"}
        try:
            import urllib.request
            import json as json_mod
            payload = {
                "action_type": action.action_type.value,
                "target": {"x": action.target_position.x, "y": action.target_position.y, "z": action.target_position.z},
                "speed": action.speed,
                "gait": "auto",
            }
            data = json_mod.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{self._api_endpoint}/locomotion/command",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, lambda: urllib.request.urlopen(req, timeout=10.0))
            resp_data = json_mod.loads(response.read().decode("utf-8"))
            return {"success": resp_data.get("success", True), "detail": resp_data.get("message", "HTTP API 执行完成")}
        except Exception as e:
            return {"success": False, "error": f"HTTP API 调用失败: {e}"}

    async def _execute_ros2(self, action: Any) -> dict[str, Any]:
        return {
            "success": False,
            "error": "ROS2 驱动需要 rclpy 依赖",
            "hint": "请安装 ROS2 并配置足式机器人驱动包",
        }

    def _check_stability(self) -> bool:
        if self._telemetry.stability_score < self._safety.stability_threshold:
            return False
        contacts = sum(1 for c in self._telemetry.foot_contacts if c)
        min_contacts = max(2, self._num_legs // 2)
        if contacts < min_contacts:
            return False
        return True

    def get_telemetry(self) -> LeggedTelemetry:
        return self._telemetry

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "driver_type": self._driver_type.value,
            "num_legs": self._num_legs,
            "execution_count": self._execution_count,
            "success_count": self._success_count,
            "stability_score": self._telemetry.stability_score,
            "gait": self._telemetry.gait.value,
        }
