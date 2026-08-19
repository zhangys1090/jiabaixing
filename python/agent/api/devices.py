"""设备遥测入口（W3）：接收 TS 设备网关推送的真实设备状态，灌入环境感通道。

TS 侧 ``DeviceManager`` 仅作入口/透传（AGENTS.md §0.1），通过 ``PythonAgentBridge``
POST 到本端点；Python 端把载荷写入进程级 ``DeviceSenseChannel``，进而可被
``SensoryFusion`` / ``PerceptionActionLoop`` 消费，闭合 "真实世界 → 感知 → 决策" 回路。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from agent.perception.device_sense import ingest_device_telemetry

devices_router = APIRouter(tags=["devices"])


@devices_router.post("/devices/telemetry")
async def post_device_telemetry(request: Request) -> dict[str, Any]:
    payload = await request.json()
    statuses: list[dict[str, Any]] | None = None
    if isinstance(payload, dict):
        statuses = payload.get("statuses")  # type: ignore[assignment]
    elif isinstance(payload, list):
        statuses = payload  # type: ignore[assignment]
    if not statuses:
        return {"ok": True, "ingested": 0, "devices": 0}

    samples = ingest_device_telemetry(statuses)
    device_ids = {s.metadata.get("device_id") for s in samples if s.metadata.get("device_id")}
    return {"ok": True, "ingested": len(samples), "devices": len(device_ids)}
