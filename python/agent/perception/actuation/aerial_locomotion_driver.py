"""空中移动驱动（Aerial Locomotion Driver）—— 无人机/飞行器控制接口。

为 LocomotionController 的 AERIAL 后端提供实际驱动能力：
1. MAVLink 驱动：通过 MAVLink 协议控制无人机（ArduPilot/PX4）
2. HTTP API 驱动：通过 REST API 控制云服务无人机
3. DJI SDK 驱动：通过 DJI Mobile/Onboard SDK 控制大疆无人机
4. 仿真驱动：用于测试和训练的虚拟无人机

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 与 LocomotionController 解耦：只消费 LocomotionAction，产出 LocomotionResult
- 安全约束：地理围栏、高度限制、低电量返航、禁飞区检测
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("aerial_locomotion_driver")


class AerialDriverType(str, Enum):
    MAVLINK = "mavlink"
    HTTP_API = "http_api"
    DJI_SDK = "dji_sdk"
    SIMULATION = "simulation"


class FlightMode(str, Enum):
    STABILIZE = "stabilize"
    ALT_HOLD = "alt_hold"
    LOITER = "loiter"
    AUTO = "auto"
    GUIDED = "guided"
    RTL = "rtl"
    LAND = "land"


@dataclass
class GeoPosition:
    latitude: float = 0.0
    longitude: float = 0.0
    altitude_m: float = 0.0

    def distance_to(self, other: GeoPosition) -> float:
        R = 6371000.0
        dlat = math.radians(other.latitude - self.latitude)
        dlon = math.radians(other.longitude - self.longitude)
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(math.radians(self.latitude)) * math.cos(math.radians(other.latitude)) *
             math.sin(dlon / 2) ** 2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c


@dataclass
class AerialSafetyConfig:
    max_altitude_m: float = 120.0
    min_altitude_m: float = 1.0
    max_distance_m: float = 500.0
    max_speed_ms: float = 10.0
    geofence_enabled: bool = True
    geofence_center: GeoPosition = field(default_factory=GeoPosition)
    geofence_radius_m: float = 500.0
    no_fly_zones: list[tuple[GeoPosition, float]] = field(default_factory=list)
    low_battery_rtl_threshold: float = 20.0
    emergency_land_enabled: bool = True


@dataclass
class AerialTelemetry:
    position: GeoPosition = field(default_factory=GeoPosition)
    heading_deg: float = 0.0
    speed_ms: float = 0.0
    vertical_speed_ms: float = 0.0
    battery_percent: float = 100.0
    gps_satellites: int = 0
    flight_mode: FlightMode = FlightMode.STABILIZE
    armed: bool = False
    timestamp: float = 0.0


class AerialLocomotionDriver:
    """空中移动驱动：将 LocomotionAction 转换为无人机控制指令。"""

    _instance: AerialLocomotionDriver | None = None

    def __init__(
        self,
        driver_type: AerialDriverType = AerialDriverType.SIMULATION,
        safety_config: AerialSafetyConfig | None = None,
        api_endpoint: str = "",
        connection_string: str = "udp:127.0.0.1:14550",
    ) -> None:
        self._driver_type = driver_type
        self._safety = safety_config or AerialSafetyConfig()
        self._api_endpoint = api_endpoint
        self._connection_string = connection_string
        self._telemetry = AerialTelemetry(timestamp=time.time())
        self._home_position = GeoPosition()
        self._execution_count = 0
        self._success_count = 0

    @classmethod
    def get_instance(cls) -> AerialLocomotionDriver:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    async def execute(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.locomotion_controller import LocomotionAction, LocomotionType
        if not isinstance(action, LocomotionAction):
            return {"success": False, "error": "未知命令类型"}

        if self._telemetry.battery_percent < self._safety.low_battery_rtl_threshold:
            log.warning("低电量，自动返航", battery=self._telemetry.battery_percent)
            return await self._execute_rtl()

        self._execution_count += 1
        start = time.time()

        try:
            safety_ok = self._check_safety(action)
            if not safety_ok:
                return {
                    "success": False,
                    "error": "安全检查未通过（地理围栏/高度/禁飞区）",
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
        from agent.perception.actuation.locomotion_controller import LocomotionType

        if self._driver_type == AerialDriverType.SIMULATION:
            return self._execute_simulation(action)

        if self._driver_type == AerialDriverType.MAVLINK:
            return await self._execute_mavlink(action)

        if self._driver_type == AerialDriverType.HTTP_API:
            return await self._execute_http_api(action)

        if self._driver_type == AerialDriverType.DJI_SDK:
            return await self._execute_dji_sdk(action)

        return {"success": False, "error": f"未知驱动类型: {self._driver_type.value}"}

    def _execute_simulation(self, action: Any) -> dict[str, Any]:
        from agent.perception.actuation.locomotion_controller import LocomotionType

        if action.action_type == LocomotionType.MOVE_TO:
            target = action.target_position
            self._telemetry.position = GeoPosition(
                latitude=target.x * 0.00001 + self._home_position.latitude,
                longitude=target.y * 0.00001 + self._home_position.longitude,
                altitude_m=target.z,
            )
            self._telemetry.speed_ms = action.speed
            return {
                "success": True,
                "detail": f"仿真飞行到 ({target.x:.1f}, {target.y:.1f}, {target.z:.1f})",
                "position": {
                    "lat": self._telemetry.position.latitude,
                    "lon": self._telemetry.position.longitude,
                    "alt": self._telemetry.position.altitude_m,
                },
            }

        if action.action_type == LocomotionType.ROTATE:
            self._telemetry.heading_deg = action.target_orientation.yaw
            return {
                "success": True,
                "detail": f"仿真旋转到 heading={action.target_orientation.yaw:.1f}°",
                "heading": self._telemetry.heading_deg,
            }

        if action.action_type == LocomotionType.STOP:
            self._telemetry.speed_ms = 0.0
            self._telemetry.vertical_speed_ms = 0.0
            return {"success": True, "detail": "仿真悬停"}

        if action.action_type == LocomotionType.RETURN_HOME:
            self._telemetry.position = self._home_position
            self._telemetry.position.altitude_m = self._safety.max_altitude_m * 0.5
            return {"success": True, "detail": "仿真返航"}

        if action.action_type == LocomotionType.PATROL:
            return {
                "success": True,
                "detail": f"仿真巡逻: {len(action.patrol_waypoints)} 个航点",
            }

        return {"success": True, "detail": f"仿真执行: {action.action_type.value}"}

    async def _execute_mavlink(self, action: Any) -> dict[str, Any]:
        try:
            from pymavlink import mavutil
        except ImportError:
            return {
                "success": False,
                "error": "pymavlink 未安装",
                "hint": "pip install pymavlink",
            }
        return {"success": False, "error": "MAVLink 驱动尚未完全实现"}

    async def _execute_http_api(self, action: Any) -> dict[str, Any]:
        if not self._api_endpoint:
            return {"success": False, "error": "HTTP API 端点未配置"}

        try:
            import urllib.request
            payload = {
                "action_type": action.action_type.value,
                "target": {
                    "x": action.target_position.x,
                    "y": action.target_position.y,
                    "z": action.target_position.z,
                },
                "speed": action.speed,
            }
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{self._api_endpoint}/flight/command",
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
                "detail": resp_data.get("message", "HTTP API 飞行指令已发送"),
            }
        except Exception as e:
            return {"success": False, "error": f"HTTP API 调用失败: {e}"}

    async def _execute_dji_sdk(self, action: Any) -> dict[str, Any]:
        return {
            "success": False,
            "error": "DJI SDK 驱动需要 dji-sdk 依赖",
            "hint": "请安装 DJI Mobile SDK 或 Onboard SDK",
        }

    async def _execute_rtl(self) -> dict[str, Any]:
        self._telemetry.position = self._home_position
        self._telemetry.flight_mode = FlightMode.RTL
        return {"success": True, "detail": "低电量自动返航", "rtl": True}

    def _check_safety(self, action: Any) -> bool:
        from agent.perception.actuation.locomotion_controller import LocomotionType

        if action.action_type == LocomotionType.MOVE_TO:
            alt = action.target_position.z
            if alt > self._safety.max_altitude_m or alt < self._safety.min_altitude_m:
                log.warning("高度超限", altitude=alt, max=self._safety.max_altitude_m, min=self._safety.min_altitude_m)
                return False

            if action.speed > self._safety.max_speed_ms:
                log.warning("速度超限", speed=action.speed, max=self._safety.max_speed_ms)
                return False

            if self._safety.geofence_enabled:
                target_geo = GeoPosition(
                    latitude=action.target_position.x * 0.00001 + self._home_position.latitude,
                    longitude=action.target_position.y * 0.00001 + self._home_position.longitude,
                )
                dist = self._safety.geofence_center.distance_to(target_geo)
                if dist > self._safety.geofence_radius_m:
                    log.warning("超出地理围栏", distance=dist, max=self._safety.geofence_radius_m)
                    return False

                for nfz_center, nfz_radius in self._safety.no_fly_zones:
                    if nfz_center.distance_to(target_geo) < nfz_radius:
                        log.warning("进入禁飞区")
                        return False

        return True

    def set_home_position(self, position: GeoPosition) -> None:
        self._home_position = position

    def get_telemetry(self) -> AerialTelemetry:
        self._telemetry.timestamp = time.time()
        return self._telemetry

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "driver_type": self._driver_type.value,
            "execution_count": self._execution_count,
            "success_count": self._success_count,
            "battery": self._telemetry.battery_percent,
            "flight_mode": self._telemetry.flight_mode.value,
            "armed": self._telemetry.armed,
        }
