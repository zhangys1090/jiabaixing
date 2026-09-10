"""设备遥测入口（W3）：接收 TS 设备网关推送的真实设备状态，灌入环境感通道。

TS 侧 ``DeviceManager`` 仅做入口/透传（AGENTS.md §0.1），通过 ``PythonAgentBridge``
POST 到本端点；Python 端把载荷写入进程级 ``DeviceSenseChannel``，进而可被
``SensoryFusion`` / ``PerceptionActionLoop`` 消费，闭合 "真实世界 → 感知 → 决策" 回路。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from agent.perception.device_sense import ingest_device_telemetry
import logging
logger = logging.getLogger(__name__)

devices_router = APIRouter(tags=["devices"])

_MAX_STATUSES = 500


class DeviceTelemetryRequest(BaseModel):
    statuses: list[dict[str, Any]] = Field(default_factory=list)


@devices_router.post("/devices/telemetry")
async def post_device_telemetry(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception as e:
        logger.warning("devices.post_device_telemetry JSON解析失败", error=str(e))
        return {"ok": False, "error": "invalid JSON", "ingested": 0, "devices": 0}
    statuses: list[dict[str, Any]] | None = None
    if isinstance(payload, dict):
        statuses = payload.get("statuses")
    elif isinstance(payload, list):
        statuses = payload
    if not statuses:
        return {"ok": True, "ingested": 0, "devices": 0}
    if len(statuses) > _MAX_STATUSES:
        statuses = statuses[:_MAX_STATUSES]

    samples = ingest_device_telemetry(statuses)
    device_ids = {s.metadata.get("device_id") for s in samples if s.metadata.get("device_id")}
    return {"ok": True, "ingested": len(samples), "devices": len(device_ids)}
