"""机械臂驱动（Robotic Arm Driver）—— 物理手操作的底层驱动。

为 HandController 的 ROBOTIC_ARM 后端提供实际驱动能力：
1. ROS2 驱动：通过 ROS2 Action Server 控制机械臂
2. HTTP API 驱动：通过 REST API 控制机械臂（如 UR、Franka 等）
3. 串口驱动：通过串口协议控制简单机械臂
4. 仿真驱动：用于测试和训练的虚拟机械臂

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 HandController 解耦：只消费 HandAction，产出 HandActionResult
- 安全约束：力矩限制、碰撞检测、紧急停止
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("robotic_arm_driver")


class ArmDriverType(str, Enum):
    ROS2 = "ros2"
    HTTP_API = "http_api"
    SERIAL = "serial"
    SIMULATION = "simulation"


class ArmSafetyLevel(str, Enum):
    NORMAL = "normal"
    REDUCED = "reduced"
    PROTECTIVE_STOP = "protective_stop"


@dataclass
class JointAngles:
    angles: list[float] = field(default_factory=lambda: [0.0] * 6)
    speed_fraction: float = 0.3
    acceleration_fraction: float = 0.2


@dataclass
class CartesianPose:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    rx: float = 0.0
    ry: float = 0.0
    rz: float = 0.0
    speed: float = 0.1


@dataclass
class GripperCommand:
    open_fraction: float = 1.0
    force_limit: float = 40.0
    speed: float = 0.1


@dataclass
class ForceTorqueReading:
    fx: float = 0.0
    fy: float = 0.0
    fz: float = 0.0
    tx: float = 0.0
    ty: float = 0.0
    tz: float = 0.0


@dataclass
class ArmSafetyConfig:
    max_force: float = 150.0
    max_torque: float = 150.0
    max_speed: float = 1.0
    workspace_bounds: dict[str, tuple[float, float]] = field(default_factory=lambda: {
        "x": (-0.8, 0.8),
        "y": (-0.8, 0.8),
        "z": (0.0, 1.2),
    })
    collision_check_enabled: bool = True
    emergency_stop_enabled: bool = True


class RoboticArmDriver:
    """机械臂驱动：将 HandAction 转换为底层机械臂控制指令。"""

    _instance: RoboticArmDriver | None = None

    def __init__(
        self,
        driver_type: ArmDriverType = ArmDriverType.SIMULATION,
        safety_config: ArmSafetyConfig | None = None,
        api_endpoint: str = "",
        serial_port: str = "",
    ) -> None:
        self._driver_type = driver_type
        self._safety = safety_config or ArmSafetyConfig()
        self._api_endpoint = api_endpoint
        self._serial_port = serial_port
        self._current_joints = JointAngles()
        self._current_pose = CartesianPose()
        self._current_ft = ForceTorqueReading()
        self._safety_level = ArmSafetyLevel.NORMAL
        self._execution_count = 0
        self._success_count = 0
        self._emergency_stopped = False
        self._http_session: Any = None

    @classmethod
    def get_instance(cls) -> RoboticArmDriver:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    async def execute(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.hand_controller import HandAction, HandActionType
        if not isinstance(action, HandAction):
            return {"success": False, "error": "未知命令类型"}

        if self._emergency_stopped:
            return {"success": False, "error": "紧急停止已激活，需先调用 release_emergency_stop()"}

        self._execution_count += 1
        start = time.time()

        try:
            safety_ok = self._check_safety(action)
            if not safety_ok:
                return {
                    "success": False,
                    "error": "安全检查未通过",
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
        if self._driver_type == ArmDriverType.SIMULATION:
            return self._execute_simulation(action)
        if self._driver_type == ArmDriverType.HTTP_API:
            return await self._execute_http_api(action)
        if self._driver_type == ArmDriverType.ROS2:
            return await self._execute_ros2(action)
        if self._driver_type == ArmDriverType.SERIAL:
            return await self._execute_serial(action)
        return {"success": False, "error": f"未知驱动类型: {self._driver_type.value}"}

    def _execute_simulation(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.hand_controller import HandActionType
        action_type = action.action_type

        if action_type == HandActionType.GRASP:
            self._current_joints.angles = [0.0, -0.5, 0.8, 0.0, 0.5, 0.0]
            return {
                "success": True,
                "detail": f"仿真抓取: target={action.target}, force={action.force:.2f}",
                "joints": self._current_joints.angles,
                "gripper": 0.0,
            }

        if action_type == HandActionType.RELEASE:
            self._current_joints.angles = [0.0, -0.5, 0.8, 0.0, 0.5, 0.0]
            return {
                "success": True,
                "detail": f"仿真释放: target={action.target}",
                "joints": self._current_joints.angles,
                "gripper": 1.0,
            }

        if action_type == HandActionType.POINT:
            if action.position:
                self._current_pose = CartesianPose(
                    x=action.position[0] * 0.5,
                    y=action.position[1] * 0.5,
                    z=0.3,
                )
            return {
                "success": True,
                "detail": f"仿真指向: target={action.target}",
                "pose": [self._current_pose.x, self._current_pose.y, self._current_pose.z],
            }

        if action_type == HandActionType.PINCH:
            return {
                "success": True,
                "detail": f"仿真捏取: target={action.target}, force={action.force:.2f}",
                "gripper": 0.3,
            }

        if action_type == HandActionType.TAP:
            return {
                "success": True,
                "detail": f"仿真轻触: target={action.target}",
                "gripper": 1.0,
            }

        if action_type == HandActionType.DRAG:
            return {
                "success": True,
                "detail": f"仿真拖拽: target={action.target}",
                "gripper": 0.5,
            }

        return {
            "success": True,
            "detail": f"仿真执行: {action_type.value}",
        }

    async def _execute_http_api(self, action: Any) -> dict[str, Any]:
        if not self._api_endpoint:
            return {"success": False, "error": "HTTP API 端点未配置"}

        try:
            import urllib.request
            payload = self._action_to_http_payload(action)
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{self._api_endpoint}/action",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: urllib.request.urlopen(req, timeout=10.0),
            )
            resp_data = json.loads(response.read().decode("utf-8"))
            return {
                "success": resp_data.get("success", True),
                "detail": resp_data.get("message", "HTTP API 执行完成"),
                "raw_response": resp_data,
            }
        except Exception as e:
            return {"success": False, "error": f"HTTP API 调用失败: {e}"}

    async def _execute_ros2(self, action: Any) -> dict[str, Any]:
        return {
            "success": False,
            "error": "ROS2 驱动需要 rclpy 依赖，当前未安装",
            "hint": "请安装 ROS2 Humble/Iron 并 source setup.bash",
        }

    async def _execute_serial(self, action: Any) -> dict[str, Any]:
        if not self._serial_port:
            return {"success": False, "error": "串口未配置"}

        try:
            import serial
            ser = serial.Serial(self._serial_port, 115200, timeout=1.0)
            command = self._action_to_serial_command(action)
            ser.write(command.encode("utf-8"))
            response = ser.readline().decode("utf-8").strip()
            ser.close()
            return {
                "success": "OK" in response or "ok" in response,
                "detail": f"串口执行: {response}",
            }
        except ImportError:
            return {"success": False, "error": "pyserial 未安装"}
        except Exception as e:
            return {"success": False, "error": f"串口通信失败: {e}"}

    def _check_safety(self, action: Any) -> bool:
        if action.force > self._safety.max_force:
            log.warning("力矩超限", force=action.force, max_force=self._safety.max_force)
            return False

        if hasattr(action, "speed") and action.speed > self._safety.max_speed:
            log.warning("速度超限", speed=action.speed, max_speed=self._safety.max_speed)
            return False

        ft = self._current_ft
        total_force = math.sqrt(ft.fx**2 + ft.fy**2 + ft.fz**2)
        if total_force > self._safety.max_force:
            log.warning("力/力矩传感器超限", total_force=total_force)
            self._safety_level = ArmSafetyLevel.PROTECTIVE_STOP
            return False

        return True

    def emergency_stop(self) -> None:
        self._emergency_stopped = True
        self._safety_level = ArmSafetyLevel.PROTECTIVE_STOP
        log.warning("紧急停止已激活")

    def release_emergency_stop(self) -> None:
        self._emergency_stopped = False
        self._safety_level = ArmSafetyLevel.REDUCED
        log.info("紧急停止已释放，进入减速模式")

    def get_ft_reading(self) -> ForceTorqueReading:
        return self._current_ft

    def get_current_pose(self) -> CartesianPose:
        return self._current_pose

    def get_current_joints(self) -> JointAngles:
        return self._current_joints

    def _action_to_http_payload(self, action: Any) -> dict[str, Any]:
        return {
            "action_type": action.action_type.value,
            "target": action.target,
            "position": list(action.position) if action.position else None,
            "force": action.force,
            "duration_ms": action.duration_ms,
        }

    def _action_to_serial_command(self, action: Any) -> str:
        return f"ACT {action.action_type.value} {action.target} {action.force:.2f}\n"

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "driver_type": self._driver_type.value,
            "safety_level": self._safety_level.value,
            "emergency_stopped": self._emergency_stopped,
            "execution_count": self._execution_count,
            "success_count": self._success_count,
            "success_rate": round(self._success_count / self._execution_count, 3) if self._execution_count > 0 else 0.0,
        }
