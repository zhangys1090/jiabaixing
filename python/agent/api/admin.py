"""R1 管理面 HTTP API。

暴露运行时安全状态（R1-A 姿态 / 锁定）与插件信任（R1-B）的查看与改写端点，
全部委托给 `RuntimeSecurityController`（它负责把写入推送到真实运行时执行器）。

挂载前缀：/v1/admin

安全：敏感改写端点受 `AGENT_ADMIN_TOKEN` 保护；未配置该环境变量时按开发模式放行
（仅记录警告），便于本地联调。生产环境必须设置 `AGENT_ADMIN_TOKEN`。
"""

from __future__ import annotations

import hmac
import os
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from agent.plugins.trust import TrustLevel, parse_trust_level
from agent.security.runtime_control import get_controller
from agent.security.runtime_posture import RuntimePosture

router = APIRouter()

ADMIN_TOKEN_ENV = "AGENT_ADMIN_TOKEN"


def _require_admin(
    authorization: str | None = Header(default=None),
    x_admin_token: str | None = Header(default=None),
) -> None:
    """敏感管理操作的前置校验。未配置令牌则放行（开发模式）。"""
    expected = os.environ.get(ADMIN_TOKEN_ENV)
    if not expected:
        return
    provided = authorization or ""
    if provided.lower().startswith("bearer "):
        provided = provided[7:]
    provided = provided or (x_admin_token or "")
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="未授权：管理操作需要有效的管理员令牌")


# ── R1-A 运行时姿态 ──


class PostureSetRequest(BaseModel):
    posture: str


@router.get("/runtime/posture")
async def get_posture() -> dict[str, Any]:
    c = get_controller()
    return {
        "posture": c.effective_posture().value,
        "source": c.posture_source(),
        "default_from_env": c.default_posture().value,
        "lockdown": c.is_lockdown(),
        "decisions": c.decisions(),
    }


@router.post("/runtime/posture", dependencies=[Depends(_require_admin)])
async def set_posture(req: PostureSetRequest) -> dict[str, Any]:
    if not RuntimePosture.is_valid(req.posture):
        raise HTTPException(status_code=400, detail=f"无效姿态: {req.posture!r}")
    posture = RuntimePosture.parse(req.posture)
    c = get_controller()
    c.set_posture(posture)
    return {
        "posture": c.effective_posture().value,
        "source": c.posture_source(),
        "decisions": c.decisions(),
    }


@router.get("/runtime/lockdown")
async def get_lockdown() -> dict[str, bool]:
    return {"lockdown": get_controller().is_lockdown()}


class LockdownRequest(BaseModel):
    enabled: bool


@router.post("/runtime/lockdown", dependencies=[Depends(_require_admin)])
async def set_lockdown(req: LockdownRequest) -> dict[str, Any]:
    c = get_controller()
    c.set_lockdown(req.enabled)
    return {"lockdown": c.is_lockdown(), "posture": c.effective_posture().value}


# ── R1-B 插件信任 ──


@router.get("/plugins/trust")
async def list_trust() -> dict[str, Any]:
    return {"plugins": get_controller().list_plugin_trust()}


class TrustSetRequest(BaseModel):
    plugin: str
    trust_level: str


@router.post("/plugins/trust", dependencies=[Depends(_require_admin)])
async def set_trust(req: TrustSetRequest) -> dict[str, Any]:
    level = parse_trust_level(req.trust_level)
    try:
        entry = get_controller().set_plugin_trust(req.plugin, level)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return entry
