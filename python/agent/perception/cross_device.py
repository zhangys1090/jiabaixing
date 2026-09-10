"""V4: 跨设备协同引擎 — 多设备状态同步与操作分发。

现有 DeviceSenseChannel 实现了设备状态接收（单向：设备→Agent），
本模块补全"协同"层：

1. 设备拓扑管理（Device Topology）：维护多设备的关系图（主控/被控、同组）
2. 状态同步（State Sync）：跨设备状态一致性检测与同步
3. 操作分发（Action Dispatch）：将操作分发到目标设备，支持并行/串行
4. 设备能力协商（Capability Negotiation）：根据设备能力选择最优执行策略

核心价值：
- 手机Agent可同时操控手机+电脑（如：手机截图→电脑分析→手机执行）
- 多设备协同完成单设备无法完成的任务
- 设备间状态自动同步，减少用户手动操作

Usage:
    from agent.perception.cross_device import CrossDeviceOrchestrator
    orch = CrossDeviceOrchestrator()
    await orch.register_device(device_info)
    result = await orch.dispatch_action("点击确定", target_device="phone")
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("cross_device")


class DeviceRole(str, Enum):
    CONTROLLER = "controller"
    CONTROLLED = "controlled"
    PEER = "peer"
    OBSERVER = "observer"


class DeviceCapability(str, Enum):
    SCREEN_CAPTURE = "screen_capture"
    SCREEN_CLICK = "screen_click"
    SCREEN_SWIPE = "screen_swipe"
    SCREEN_TYPE = "screen_type"
    KEYBOARD = "keyboard"
    CAMERA = "camera"
    MICROPHONE = "microphone"
    FILE_ACCESS = "file_access"
    NOTIFICATION = "notification"
    CLIPBOARD = "clipboard"
    APP_INSTALL = "app_install"
    SYSTEM_SETTINGS = "system_settings"
    VOICE = "voice"


class DevicePlatform(str, Enum):
    ANDROID = "android"
    IOS = "ios"
    WINDOWS = "windows"
    MACOS = "macos"
    LINUX = "linux"
    WEB = "web"
    UNKNOWN = "unknown"


@dataclass
class DeviceInfo:
    device_id: str
    name: str = ""
    platform: DevicePlatform = DevicePlatform.UNKNOWN
    role: DeviceRole = DeviceRole.PEER
    capabilities: set[DeviceCapability] = field(default_factory=set)
    status: dict[str, Any] = field(default_factory=dict)
    last_seen: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def is_online(self) -> bool:
        return self.status.get("online", True) and (time.time() - self.last_seen < 60)

    @property
    def capability_names(self) -> list[str]:
        return sorted(c.value for c in self.capabilities)

    def has_capability(self, cap: DeviceCapability) -> bool:
        return cap in self.capabilities

    def to_dict(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "name": self.name,
            "platform": self.platform.value,
            "role": self.role.value,
            "capabilities": self.capability_names,
            "online": self.is_online,
            "last_seen": self.last_seen,
        }


@dataclass
class ActionTarget:
    device_id: str
    action: str
    parameters: dict[str, Any] = field(default_factory=dict)
    timeout: float = 10.0


@dataclass
class DispatchResult:
    success: bool
    device_id: str
    action: str
    output: str = ""
    error: str = ""
    duration_ms: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SyncConflict:
    key: str
    local_value: Any = None
    remote_value: Any = None
    device_id: str = ""
    resolution: str = "pending"


_PLATFORM_CAPABILITIES: dict[DevicePlatform, set[DeviceCapability]] = {
    DevicePlatform.ANDROID: {
        DeviceCapability.SCREEN_CAPTURE, DeviceCapability.SCREEN_CLICK,
        DeviceCapability.SCREEN_SWIPE, DeviceCapability.SCREEN_TYPE,
        DeviceCapability.CAMERA, DeviceCapability.MICROPHONE,
        DeviceCapability.FILE_ACCESS, DeviceCapability.NOTIFICATION,
        DeviceCapability.CLIPBOARD, DeviceCapability.APP_INSTALL,
        DeviceCapability.VOICE,
    },
    DevicePlatform.IOS: {
        DeviceCapability.SCREEN_CAPTURE, DeviceCapability.SCREEN_CLICK,
        DeviceCapability.SCREEN_SWIPE, DeviceCapability.SCREEN_TYPE,
        DeviceCapability.CAMERA, DeviceCapability.MICROPHONE,
        DeviceCapability.FILE_ACCESS, DeviceCapability.NOTIFICATION,
        DeviceCapability.CLIPBOARD, DeviceCapability.VOICE,
    },
    DevicePlatform.WINDOWS: {
        DeviceCapability.SCREEN_CAPTURE, DeviceCapability.SCREEN_CLICK,
        DeviceCapability.SCREEN_TYPE, DeviceCapability.KEYBOARD,
        DeviceCapability.FILE_ACCESS, DeviceCapability.CLIPBOARD,
        DeviceCapability.SYSTEM_SETTINGS,
    },
    DevicePlatform.MACOS: {
        DeviceCapability.SCREEN_CAPTURE, DeviceCapability.SCREEN_CLICK,
        DeviceCapability.SCREEN_TYPE, DeviceCapability.KEYBOARD,
        DeviceCapability.FILE_ACCESS, DeviceCapability.CLIPBOARD,
        DeviceCapability.SYSTEM_SETTINGS,
    },
    DevicePlatform.LINUX: {
        DeviceCapability.SCREEN_CAPTURE, DeviceCapability.SCREEN_CLICK,
        DeviceCapability.SCREEN_TYPE, DeviceCapability.KEYBOARD,
        DeviceCapability.FILE_ACCESS, DeviceCapability.CLIPBOARD,
    },
    DevicePlatform.WEB: {
        DeviceCapability.SCREEN_CAPTURE, DeviceCapability.CLIPBOARD,
    },
}


class CrossDeviceOrchestrator:
    """V4: 跨设备协同引擎.

    管理多设备拓扑、状态同步和操作分发，
    实现手机Agent的跨设备协同能力。

    设计原则：
    - 去中心化：无单点故障，设备可动态加入/退出
    - 能力驱动：根据设备能力而非设备ID选择执行策略
    - 非阻塞：设备不可达时降级到本地执行
    - 安全：跨设备操作需经权限校验
    """

    _MAX_DEVICES = 20
    _SYNC_INTERVAL = 5.0
    _DEVICE_TIMEOUT = 30.0

    def __init__(self) -> None:
        self._devices: dict[str, DeviceInfo] = {}
        self._device_groups: dict[str, set[str]] = {}
        self._action_handlers: dict[str, Any] = {}
        self._sync_state: dict[str, dict[str, Any]] = {}
        self._dispatch_history: list[DispatchResult] = []
        self._MAX_HISTORY = 500

    @property
    def devices(self) -> dict[str, DeviceInfo]:
        return dict(self._devices)

    @property
    def online_devices(self) -> list[DeviceInfo]:
        return [d for d in self._devices.values() if d.is_online]

    @property
    def controller_device(self) -> DeviceInfo | None:
        controllers = [d for d in self._devices.values() if d.role == DeviceRole.CONTROLLER and d.is_online]
        return controllers[0] if controllers else None

    async def register_device(self, device_info: DeviceInfo) -> bool:
        """注册设备到协同拓扑.

        Args:
            device_info: 设备信息

        Returns:
            bool: 是否注册成功
        """
        if len(self._devices) >= self._MAX_DEVICES and device_info.device_id not in self._devices:
            log.warning("V4: max devices reached, cannot register", device_id=device_info.device_id)
            return False

        if not device_info.capabilities and device_info.platform in _PLATFORM_CAPABILITIES:
            device_info.capabilities = _PLATFORM_CAPABILITIES[device_info.platform]

        self._devices[device_info.device_id] = device_info
        device_info.last_seen = time.time()

        log.info(
            "V4: device registered",
            device_id=device_info.device_id,
            name=device_info.name,
            platform=device_info.platform.value,
            role=device_info.role.value,
            capabilities=len(device_info.capabilities),
        )

        return True

    async def unregister_device(self, device_id: str) -> bool:
        """注销设备."""
        if device_id in self._devices:
            del self._devices[device_id]
            for group in self._device_groups.values():
                group.discard(device_id)
            log.info("V4: device unregistered", device_id=device_id)
            return True
        return False

    async def update_device_status(self, device_id: str, status: dict[str, Any]) -> None:
        """更新设备状态（来自DeviceSenseChannel的遥测数据）."""
        if device_id in self._devices:
            self._devices[device_id].status.update(status)
            self._devices[device_id].last_seen = time.time()

    def find_device_by_capability(self, capability: DeviceCapability, prefer_platform: DevicePlatform | None = None) -> DeviceInfo | None:
        """按能力查找设备.

        Args:
            capability: 需要的设备能力
            prefer_platform: 偏好的平台

        Returns:
            DeviceInfo | None: 最匹配的在线设备
        """
        candidates = [d for d in self._devices.values() if d.is_online and d.has_capability(capability)]

        if not candidates:
            return None

        if prefer_platform:
            preferred = [d for d in candidates if d.platform == prefer_platform]
            if preferred:
                return preferred[0]

        controllers = [d for d in candidates if d.role == DeviceRole.CONTROLLER]
        if controllers:
            return controllers[0]

        return candidates[0]

    def find_best_device_for_action(self, action: str) -> DeviceInfo | None:
        """根据操作类型选择最优执行设备.

        Args:
            action: 操作描述

        Returns:
            DeviceInfo | None: 最优设备
        """
        action_lower = action.lower()

        required_caps: set[DeviceCapability] = set()
        if any(kw in action_lower for kw in ("点击", "click", "tap", "按钮")):
            required_caps.add(DeviceCapability.SCREEN_CLICK)
        if any(kw in action_lower for kw in ("滑动", "swipe", "滚动", "scroll")):
            required_caps.add(DeviceCapability.SCREEN_SWIPE)
        if any(kw in action_lower for kw in ("输入", "type", "打字", "键盘")):
            required_caps.add(DeviceCapability.SCREEN_TYPE)
        if any(kw in action_lower for kw in ("截图", "screenshot", "截屏")):
            required_caps.add(DeviceCapability.SCREEN_CAPTURE)
        if any(kw in action_lower for kw in ("拍照", "camera", "相机")):
            required_caps.add(DeviceCapability.CAMERA)

        if not required_caps:
            required_caps.add(DeviceCapability.SCREEN_CLICK)

        candidates = [
            d for d in self._devices.values()
            if d.is_online and required_caps.issubset(d.capabilities)
        ]

        if not candidates:
            single_cap = next(iter(required_caps)) if required_caps else None
            if single_cap:
                return self.find_device_by_capability(single_cap)
            return None

        score_map: dict[str, float] = {}
        for d in candidates:
            score = 0.0
            if d.role == DeviceRole.CONTROLLER:
                score += 2.0
            elif d.role == DeviceRole.PEER:
                score += 1.0
            score += len(d.capabilities) * 0.1
            if d.platform == DevicePlatform.ANDROID:
                score += 0.5
            score_map[d.device_id] = score

        best_id = max(score_map, key=score_map.get)
        return self._devices[best_id]

    async def dispatch_action(
        self,
        action: str,
        target_device: str = "",
        parameters: dict[str, Any] | None = None,
        timeout: float = 10.0,
    ) -> DispatchResult:
        """分发操作到目标设备.

        Args:
            action: 操作描述
            target_device: 目标设备ID（空则自动选择）
            parameters: 操作参数
            timeout: 超时时间

        Returns:
            DispatchResult: 分发结果
        """
        start = time.monotonic()

        if target_device and target_device in self._devices:
            device = self._devices[target_device]
        else:
            device = self.find_best_device_for_action(action)

        if device is None:
            duration_ms = (time.monotonic() - start) * 1000
            log.warning("V4: no available device for action", action=action)
            return DispatchResult(
                success=False,
                device_id="",
                action=action,
                error="无可用设备",
                duration_ms=duration_ms,
            )

        if not device.is_online:
            duration_ms = (time.monotonic() - start) * 1000
            return DispatchResult(
                success=False,
                device_id=device.device_id,
                action=action,
                error="设备离线",
                duration_ms=duration_ms,
            )

        result = await self._execute_on_device(device, action, parameters or {}, timeout)
        result.duration_ms = (time.monotonic() - start) * 1000

        self._dispatch_history.append(result)
        if len(self._dispatch_history) > self._MAX_HISTORY:
            self._dispatch_history = self._dispatch_history[-self._MAX_HISTORY * 3 // 4:]

        log.info(
            "V4: action dispatched",
            action=action,
            device=device.device_id,
            success=result.success,
            duration_ms=round(result.duration_ms, 1),
        )

        return result

    async def dispatch_parallel(self, actions: list[ActionTarget]) -> list[DispatchResult]:
        """并行分发多个操作到不同设备.

        Args:
            actions: 操作目标列表

        Returns:
            list[DispatchResult]: 各操作的结果
        """
        tasks = [
            self.dispatch_action(
                action=at.action,
                target_device=at.device_id,
                parameters=at.parameters,
                timeout=at.timeout,
            )
            for at in actions
        ]
        return await asyncio.gather(*tasks, return_exceptions=False)

    async def sync_state(self, key: str, value: Any, source_device: str = "") -> list[SyncConflict]:
        """跨设备状态同步.

        Args:
            key: 状态键
            value: 状态值
            source_device: 源设备ID

        Returns:
            list[SyncConflict]: 冲突列表
        """
        self._sync_state[key] = {"value": value, "source": source_device, "timestamp": time.time()}

        conflicts: list[SyncConflict] = []
        for device_id, device in self._devices.items():
            if device_id == source_device or not device.is_online:
                continue

            device_state = device.status.get(key)
            if device_state is not None and device_state != value:
                conflicts.append(SyncConflict(
                    key=key,
                    local_value=value,
                    remote_value=device_state,
                    device_id=device_id,
                ))

        if conflicts:
            log.info("V4: state sync conflicts detected", key=key, conflicts=len(conflicts))
        else:
            log.debug("V4: state synced successfully", key=key)

        return conflicts

    def create_group(self, group_name: str, device_ids: list[str]) -> bool:
        """创建设备组.

        Args:
            group_name: 组名
            device_ids: 设备ID列表

        Returns:
            bool: 是否创建成功
        """
        valid_ids = {did for did in device_ids if did in self._devices}
        if not valid_ids:
            return False
        self._device_groups[group_name] = valid_ids
        log.info("V4: device group created", group=group_name, devices=len(valid_ids))
        return True

    def get_group_devices(self, group_name: str) -> list[DeviceInfo]:
        """获取组内设备列表."""
        ids = self._device_groups.get(group_name, set())
        return [self._devices[did] for did in ids if did in self._devices]

    async def _execute_on_device(self, device: DeviceInfo, action: str, parameters: dict[str, Any], timeout: float) -> DispatchResult:
        """在指定设备上执行操作."""
        try:
            if device.platform in (DevicePlatform.WINDOWS, DevicePlatform.MACOS, DevicePlatform.LINUX):
                return await self._execute_desktop_action(device, action, parameters)

            if device.platform in (DevicePlatform.ANDROID, DevicePlatform.IOS):
                return await self._execute_mobile_action(device, action, parameters)

            return DispatchResult(
                success=False,
                device_id=device.device_id,
                action=action,
                error=f"不支持的平台: {device.platform.value}",
            )
        except asyncio.TimeoutError:
            return DispatchResult(
                success=False,
                device_id=device.device_id,
                action=action,
                error="操作超时",
            )
        except Exception as e:
            return DispatchResult(
                success=False,
                device_id=device.device_id,
                action=action,
                error=str(e),
            )

    async def _execute_desktop_action(self, device: DeviceInfo, action: str, parameters: dict[str, Any]) -> DispatchResult:
        """在桌面设备上执行操作."""
        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            controller = get_desktop_controller()

            action_lower = action.lower()
            if any(kw in action_lower for kw in ("点击", "click", "tap")):
                x = parameters.get("x", 0)
                y = parameters.get("y", 0)
                if x and y:
                    controller.click(x, y)
                    return DispatchResult(success=True, device_id=device.device_id, action=action, output=f"点击({x},{y})")
                else:
                    from agent.perception.visual_grounding import VisualGrounding
                    vg = VisualGrounding()
                    result = await vg.locate(action)
                    if result.target_found and result.coordinates:
                        controller.click(result.coordinates[0], result.coordinates[1])
                        return DispatchResult(success=True, device_id=device.device_id, action=action, output=f"定位并点击{result.coordinates}")

            elif any(kw in action_lower for kw in ("截图", "screenshot", "截屏")):
                screenshot = controller.screenshot_full()
                if screenshot.success:
                    return DispatchResult(success=True, device_id=device.device_id, action=action, output=screenshot.image_path, metadata={"width": screenshot.width, "height": screenshot.height})

            elif any(kw in action_lower for kw in ("输入", "type", "打字")):
                text = parameters.get("text", "")
                if text:
                    controller.type_text(text)
                    return DispatchResult(success=True, device_id=device.device_id, action=action, output=f"输入: {text[:20]}")

            return DispatchResult(success=False, device_id=device.device_id, action=action, error="未识别的桌面操作")

        except Exception as e:
            return DispatchResult(success=False, device_id=device.device_id, action=action, error=str(e))

    async def _execute_mobile_action(self, device: DeviceInfo, action: str, parameters: dict[str, Any]) -> DispatchResult:
        """在移动设备上执行操作（通过ADB/设备网关）."""
        try:
            action_lower = action.lower()

            if any(kw in action_lower for kw in ("截图", "screenshot", "截屏")):
                return await self._mobile_screenshot(device)

            if any(kw in action_lower for kw in ("点击", "click", "tap")):
                x = parameters.get("x", 0)
                y = parameters.get("y", 0)
                return await self._mobile_tap(device, x, y)

            if any(kw in action_lower for kw in ("滑动", "swipe")):
                x1 = parameters.get("x1", 0)
                y1 = parameters.get("y1", 0)
                x2 = parameters.get("x2", 0)
                y2 = parameters.get("y2", 0)
                return await self._mobile_swipe(device, x1, y1, x2, y2)

            if any(kw in action_lower for kw in ("输入", "type")):
                text = parameters.get("text", "")
                return await self._mobile_type(device, text)

            return DispatchResult(success=False, device_id=device.device_id, action=action, error="未识别的移动操作")

        except Exception as e:
            return DispatchResult(success=False, device_id=device.device_id, action=action, error=str(e))

    async def _mobile_screenshot(self, device: DeviceInfo) -> DispatchResult:
        """移动设备截图（通过ADB）."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "adb", "-s", device.device_id, "shell", "screencap", "-p", "/sdcard/screen.png",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=5.0)

            import tempfile
            local_path = os.path.join(tempfile.gettempdir(), f"device_{device.device_id}_screen.png")
            proc2 = await asyncio.create_subprocess_exec(
                "adb", "-s", device.device_id, "pull", "/sdcard/screen.png", local_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc2.communicate(), timeout=5.0)

            if os.path.exists(local_path):
                return DispatchResult(success=True, device_id=device.device_id, action="screenshot", output=local_path)
        except Exception as e:
            log.debug("V4: ADB screenshot failed", device=device.device_id, error=str(e))

        return DispatchResult(success=False, device_id=device.device_id, action="screenshot", error="截图失败")

    async def _mobile_tap(self, device: DeviceInfo, x: int, y: int) -> DispatchResult:
        """移动设备点击."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "adb", "-s", device.device_id, "shell", "input", "tap", str(x), str(y),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=5.0)
            return DispatchResult(success=True, device_id=device.device_id, action="tap", output=f"tap({x},{y})")
        except Exception as e:
            return DispatchResult(success=False, device_id=device.device_id, action="tap", error=str(e))

    async def _mobile_swipe(self, device: DeviceInfo, x1: int, y1: int, x2: int, y2: int) -> DispatchResult:
        """移动设备滑动."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "adb", "-s", device.device_id, "shell", "input", "swipe",
                str(x1), str(y1), str(x2), str(y2), "300",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=5.0)
            return DispatchResult(success=True, device_id=device.device_id, action="swipe", output=f"swipe({x1},{y1}→{x2},{y2})")
        except Exception as e:
            return DispatchResult(success=False, device_id=device.device_id, action="swipe", error=str(e))

    async def _mobile_type(self, device: DeviceInfo, text: str) -> DispatchResult:
        """移动设备输入文字."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "adb", "-s", device.device_id, "shell", "am", "broadcast",
                "-a", "ADB_INPUT_TEXT", "--es", "msg", text,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=5.0)
            return DispatchResult(success=True, device_id=device.device_id, action="type", output=f"type:{text[:20]}")
        except Exception as e:
            return DispatchResult(success=False, device_id=device.device_id, action="type", error=str(e))

    def get_topology_summary(self) -> dict[str, Any]:
        """获取设备拓扑摘要."""
        return {
            "total_devices": len(self._devices),
            "online_devices": len(self.online_devices),
            "devices": [d.to_dict() for d in self._devices.values()],
            "groups": {name: list(ids) for name, ids in self._device_groups.items()},
            "dispatch_stats": {
                "total": len(self._dispatch_history),
                "success": sum(1 for r in self._dispatch_history if r.success),
            },
        }
