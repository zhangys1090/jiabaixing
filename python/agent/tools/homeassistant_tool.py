from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)
import logging
logger = logging.getLogger(__name__)


HA_CONTROL_DEF = ToolDefinition(
    name="ha_control",
    description="Home Assistant 智能家居控制。支持控制灯光、开关、气候、媒体播放器等设备。适用场景：用户要求开灯/关灯、调节温度、控制家电、查看设备状态。不适用：非智能家居操作。",
    category=ToolCategory.IOT,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["turn_on", "turn_off", "toggle", "set_state", "get_state", "list_devices", "call_service"]),
        ToolParameterDef(name="entity_id", type="string", required=False, description="实体ID（如 light.living_room）"),
        ToolParameterDef(name="domain", type="string", required=False, description="设备域（light/switch/climate/media_player/cover/fan/humidifier）"),
        ToolParameterDef(name="service_data", type="string", required=False, description="服务参数（JSON格式，如 brightness, temperature）"),
        ToolParameterDef(name="area", type="string", required=False, description="区域/房间名称过滤"),
    ],
    risk_level="medium",
)

HA_SCENE_DEF = ToolDefinition(
    name="ha_scene",
    description="Home Assistant 场景和自动化管理。支持激活场景、查看自动化、触发自动化。适用场景：一键切换场景（回家/离家/睡眠模式）、管理自动化规则。",
    category=ToolCategory.IOT,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["activate", "list_scenes", "list_automations", "trigger_automation", "automation_status"]),
        ToolParameterDef(name="entity_id", type="string", required=False, description="场景或自动化实体ID"),
    ],
    risk_level="low",
)

HA_SENSOR_DEF = ToolDefinition(
    name="ha_sensor",
    description="Home Assistant 传感器数据查询。支持查看温度、湿度、电量、运动检测等传感器数据。适用场景：查看室内温度、湿度、空气质量、能耗统计。",
    category=ToolCategory.IOT,
    parameters=[
        ToolParameterDef(name="action", type="string", description="操作类型", enum=["get", "history", "list", "aggregate"]),
        ToolParameterDef(name="entity_id", type="string", required=False, description="传感器实体ID"),
        ToolParameterDef(name="area", type="string", required=False, description="区域过滤"),
        ToolParameterDef(name="device_class", type="string", required=False, description="设备类型过滤（temperature/humidity/power/motion/battery）"),
        ToolParameterDef(name="hours", type="number", required=False, description="历史数据时间范围（小时）"),
    ],
    risk_level="low",
)


@dataclass
class HAEntity:
    entity_id: str = ""
    state: str = ""
    attributes: dict[str, Any] = field(default_factory=dict)
    last_changed: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "entity_id": self.entity_id,
            "state": self.state,
            "attributes": self.attributes,
            "last_changed": self.last_changed,
        }


class HomeAssistantClient:
    _instance: HomeAssistantClient | None = None

    def __init__(self) -> None:
        self._base_url = os.getenv("HA_BASE_URL", "").rstrip("/")
        self._token = os.getenv("HA_TOKEN", "")
        self._cache: dict[str, HAEntity] = {}
        self._cache_ts: float = 0.0
        self._cache_ttl: float = 30.0

    @classmethod
    def get_instance(cls) -> HomeAssistantClient:
        if cls._instance is None:
            cls._instance = HomeAssistantClient()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def is_configured(self) -> bool:
        return bool(self._base_url and self._token)

    async def _request(self, method: str, path: str, body: dict | None = None) -> dict[str, Any]:
        try:
            import httpx
        except ImportError:
            try:
                from urllib.request import Request, urlopen
                from urllib.error import URLError
                import json as _json
                url = f"{self._base_url}{path}"
                headers = {
                    "Authorization": f"Bearer {self._token}",
                    "Content-Type": "application/json",
                }
                data = _json.dumps(body).encode() if body else None
                req = Request(url, data=data, headers=headers, method=method)
                try:
                    with urlopen(req, timeout=10) as resp:
                        return _json.loads(resp.read().decode())
                except URLError as e:
                    return {"error": str(e)}
            except Exception as e:
                logger.warning("homeassistant_tool 异常处理", error=str(e))
                return {"error": str(e)}

        url = f"{self._base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                if method == "GET":
                    r = await client.get(url, headers=headers)
                elif method == "POST":
                    r = await client.post(url, headers=headers, json=body or {})
                else:
                    return {"error": f"Unsupported method: {method}"}
                return r.json()
            except Exception as e:
                logger.warning("homeassistant_tool 异常处理", error=str(e))
                return {"error": str(e)}

    async def get_states(self) -> list[HAEntity]:
        now = time.time()
        if self._cache and now - self._cache_ts < self._cache_ttl:
            return list(self._cache.values())

        data = await self._request("GET", "/api/states")
        if "error" in data:
            return []

        entities: list[HAEntity] = []
        for item in data if isinstance(data, list) else []:
            entity = HAEntity(
                entity_id=item.get("entity_id", ""),
                state=item.get("state", ""),
                attributes=item.get("attributes", {}),
                last_changed=item.get("last_changed", ""),
            )
            entities.append(entity)
            self._cache[entity.entity_id] = entity
        self._cache_ts = time.time()
        return entities

    async def get_state(self, entity_id: str) -> HAEntity | None:
        if entity_id in self._cache and time.time() - self._cache_ts < self._cache_ttl:
            return self._cache.get(entity_id)
        data = await self._request("GET", f"/api/states/{entity_id}")
        if "error" in data:
            return None
        entity = HAEntity(
            entity_id=data.get("entity_id", entity_id),
            state=data.get("state", ""),
            attributes=data.get("attributes", {}),
            last_changed=data.get("last_changed", ""),
        )
        self._cache[entity.entity_id] = entity
        return entity

    async def call_service(self, domain: str, service: str, service_data: dict | None = None) -> dict[str, Any]:
        body = service_data or {}
        return await self._request("POST", f"/api/services/{domain}/{service}", body)

    async def get_history(self, entity_id: str, hours: int = 24) -> list[dict[str, Any]]:
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - hours * 3600))
        data = await self._request("GET", f"/api/history/period/{timestamp}?filter_entity_id={entity_id}")
        if isinstance(data, list) and data and isinstance(data[0], list):
            return data[0]
        return []

    def invalidate_cache(self) -> None:
        self._cache.clear()
        self._cache_ts = 0.0


def _get_client() -> HomeAssistantClient:
    return HomeAssistantClient.get_instance()


def _parse_service_data(raw: str) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}


async def ha_control_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    client = _get_client()

    if not client.is_configured():
        return ToolResult(
            success=False,
            error="Home Assistant 未配置。请设置环境变量 HA_BASE_URL 和 HA_TOKEN。",
            duration=time.time() - start,
        )

    if action == "list_devices":
        entities = await client.get_states()
        area = str(params.get("area", "")).lower()
        domain = str(params.get("domain", "")).lower()
        filtered = entities
        if domain:
            filtered = [e for e in filtered if e.entity_id.startswith(f"{domain}.")]
        if area:
            filtered = [e for e in filtered if area in e.attributes.get("friendly_name", "").lower() or area in str(e.attributes.get("area", "")).lower()]
        if not filtered:
            return ToolResult(success=True, output="未找到匹配设备", duration=time.time() - start)
        lines = []
        for e in filtered:
            friendly = e.attributes.get("friendly_name", e.entity_id)
            lines.append(f"• {e.entity_id} = {e.state} ({friendly})")
        return ToolResult(success=True, output=f"共 {len(filtered)} 个设备:\n" + "\n".join(lines), duration=time.time() - start)

    elif action in ("turn_on", "turn_off", "toggle"):
        entity_id = str(params.get("entity_id", ""))
        if not entity_id:
            return ToolResult(success=False, error="缺少 entity_id", duration=time.time() - start)
        domain = entity_id.split(".")[0]
        service_data = _parse_service_data(str(params.get("service_data", "")))
        service_data["entity_id"] = entity_id
        result = await client.call_service(domain, action, service_data)
        if "error" in result:
            return ToolResult(success=False, error=f"操作失败: {result['error']}", duration=time.time() - start)
        client.invalidate_cache()
        icon = "💡" if domain == "light" else "🔌"
        return ToolResult(success=True, output=f"{icon} {entity_id} → {action}", duration=time.time() - start)

    elif action == "set_state":
        entity_id = str(params.get("entity_id", ""))
        service_data = _parse_service_data(str(params.get("service_data", "")))
        if not entity_id:
            return ToolResult(success=False, error="缺少 entity_id", duration=time.time() - start)
        domain = entity_id.split(".")[0]
        service = "turn_on"
        service_data["entity_id"] = entity_id
        result = await client.call_service(domain, service, service_data)
        if "error" in result:
            return ToolResult(success=False, error=f"设置失败: {result['error']}", duration=time.time() - start)
        client.invalidate_cache()
        return ToolResult(success=True, output=f"✅ {entity_id} 状态已更新", duration=time.time() - start)

    elif action == "get_state":
        entity_id = str(params.get("entity_id", ""))
        if not entity_id:
            return ToolResult(success=False, error="缺少 entity_id", duration=time.time() - start)
        entity = await client.get_state(entity_id)
        if not entity:
            return ToolResult(success=False, error=f"实体不存在: {entity_id}", duration=time.time() - start)
        friendly = entity.attributes.get("friendly_name", entity_id)
        return ToolResult(
            success=True,
            output=f"{entity_id} ({friendly})\n状态: {entity.state}\n属性: {json.dumps(entity.attributes, ensure_ascii=False, indent=2)}",
            duration=time.time() - start,
        )

    elif action == "call_service":
        domain = str(params.get("domain", ""))
        entity_id = str(params.get("entity_id", ""))
        service_data = _parse_service_data(str(params.get("service_data", "")))
        if not domain:
            return ToolResult(success=False, error="缺少 domain", duration=time.time() - start)
        if entity_id:
            service_data["entity_id"] = entity_id
        service = str(params.get("service_data", "")).split(".")[1] if "." in str(params.get("service_data", "")) else "turn_on"
        result = await client.call_service(domain, service, service_data)
        if "error" in result:
            return ToolResult(success=False, error=f"调用失败: {result['error']}", duration=time.time() - start)
        client.invalidate_cache()
        return ToolResult(success=True, output=f"✅ 服务 {domain}.{service} 已调用", duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}", duration=time.time() - start)


async def ha_scene_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    client = _get_client()

    if not client.is_configured():
        return ToolResult(success=False, error="Home Assistant 未配置", duration=time.time() - start)

    if action == "list_scenes":
        entities = await client.get_states()
        scenes = [e for e in entities if e.entity_id.startswith("scene.")]
        if not scenes:
            return ToolResult(success=True, output="暂无场景", duration=time.time() - start)
        lines = [f"🎬 {e.entity_id} — {e.attributes.get('friendly_name', '')}" for e in scenes]
        return ToolResult(success=True, output=f"共 {len(scenes)} 个场景:\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "list_automations":
        entities = await client.get_states()
        autos = [e for e in entities if e.entity_id.startswith("automation.")]
        if not autos:
            return ToolResult(success=True, output="暂无自动化", duration=time.time() - start)
        lines = [f"⚙️ {e.entity_id} = {e.state} — {e.attributes.get('friendly_name', '')}" for e in autos]
        return ToolResult(success=True, output=f"共 {len(autos)} 个自动化:\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "activate":
        entity_id = str(params.get("entity_id", ""))
        if not entity_id:
            return ToolResult(success=False, error="缺少 entity_id", duration=time.time() - start)
        result = await client.call_service("scene", "turn_on", {"entity_id": entity_id})
        if "error" in result:
            return ToolResult(success=False, error=f"激活失败: {result['error']}", duration=time.time() - start)
        client.invalidate_cache()
        return ToolResult(success=True, output=f"🎬 场景 {entity_id} 已激活", duration=time.time() - start)

    elif action == "trigger_automation":
        entity_id = str(params.get("entity_id", ""))
        if not entity_id:
            return ToolResult(success=False, error="缺少 entity_id", duration=time.time() - start)
        result = await client.call_service("automation", "trigger", {"entity_id": entity_id})
        if "error" in result:
            return ToolResult(success=False, error=f"触发失败: {result['error']}", duration=time.time() - start)
        client.invalidate_cache()
        return ToolResult(success=True, output=f"⚙️ 自动化 {entity_id} 已触发", duration=time.time() - start)

    elif action == "automation_status":
        entity_id = str(params.get("entity_id", ""))
        if not entity_id:
            return ToolResult(success=False, error="缺少 entity_id", duration=time.time() - start)
        entity = await client.get_state(entity_id)
        if not entity:
            return ToolResult(success=False, error=f"自动化不存在: {entity_id}", duration=time.time() - start)
        return ToolResult(success=True, output=f"{entity_id} 状态: {entity.state}", duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}", duration=time.time() - start)


async def ha_sensor_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    action = str(params.get("action", ""))
    client = _get_client()

    if not client.is_configured():
        return ToolResult(success=False, error="Home Assistant 未配置", duration=time.time() - start)

    if action == "list":
        entities = await client.get_states()
        device_class = str(params.get("device_class", "")).lower()
        area = str(params.get("area", "")).lower()
        sensors = [e for e in entities if e.entity_id.startswith("sensor.")]
        if device_class:
            sensors = [s for s in sensors if s.attributes.get("device_class", "").lower() == device_class]
        if area:
            sensors = [s for s in sensors if area in s.attributes.get("friendly_name", "").lower()]
        if not sensors:
            return ToolResult(success=True, output="未找到匹配传感器", duration=time.time() - start)
        lines = [f"📊 {s.entity_id} = {s.state} {s.attributes.get('unit_of_measurement', '')} ({s.attributes.get('friendly_name', '')})" for s in sensors]
        return ToolResult(success=True, output=f"共 {len(sensors)} 个传感器:\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "get":
        entity_id = str(params.get("entity_id", ""))
        if not entity_id:
            return ToolResult(success=False, error="缺少 entity_id", duration=time.time() - start)
        entity = await client.get_state(entity_id)
        if not entity:
            return ToolResult(success=False, error=f"传感器不存在: {entity_id}", duration=time.time() - start)
        unit = entity.attributes.get("unit_of_measurement", "")
        friendly = entity.attributes.get("friendly_name", entity_id)
        return ToolResult(success=True, output=f"{friendly}: {entity.state} {unit}", duration=time.time() - start)

    elif action == "history":
        entity_id = str(params.get("entity_id", ""))
        hours = int(params.get("hours", 24))
        if not entity_id:
            return ToolResult(success=False, error="缺少 entity_id", duration=time.time() - start)
        history = await client.get_history(entity_id, hours)
        if not history:
            return ToolResult(success=True, output=f"无最近 {hours} 小时数据", duration=time.time() - start)
        lines = []
        for entry in history[:20]:
            ts = entry.get("last_changed", "")[11:19]
            state = entry.get("state", "")
            lines.append(f"  {ts} → {state}")
        return ToolResult(success=True, output=f"{entity_id} 最近 {hours}h ({len(history)} 条):\n" + "\n".join(lines), duration=time.time() - start)

    elif action == "aggregate":
        entities = await client.get_states()
        device_class = str(params.get("device_class", "")).lower()
        sensors = [e for e in entities if e.entity_id.startswith("sensor.")]
        if device_class:
            sensors = [s for s in sensors if s.attributes.get("device_class", "").lower() == device_class]
        if not sensors:
            return ToolResult(success=True, output="未找到匹配传感器", duration=time.time() - start)
        summary_parts: list[str] = []
        for s in sensors:
            friendly = s.attributes.get("friendly_name", s.entity_id)
            unit = s.attributes.get("unit_of_measurement", "")
            summary_parts.append(f"{friendly}: {s.state}{unit}")
        return ToolResult(success=True, output="; ".join(summary_parts), duration=time.time() - start)

    return ToolResult(success=False, error=f"未知操作: {action}", duration=time.time() - start)
