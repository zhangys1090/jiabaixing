"""D6 Authority 交叉验证端点（Risk 1: delegation 元数据真实性）

TS delegated 路径只拿到 decisionId（跨进程不传 Decision 语义）。
本路由提供 Python FINAL Authority 的落盘 Decision/Evidence 记录查询，
供 TS 侧（AuthoritySignature 校验之外）对 decisionId↔goalId↔action
绑定做交叉验证——Python 不可伪造（HMAC 之外的第二道独立数据源）。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from agent.core.memory_authority import MemoryAuthority

router = APIRouter()


def _store() -> MemoryAuthority:
    return MemoryAuthority.getInstance()


@router.get("/authority/decisions/{decision_id}")
async def get_decision(decision_id: str) -> Any:
    record = _store().get_decision(decision_id)
    if record is None:
        return JSONResponse(status_code=404, content={
            "error": "decision not found",
            "decisionId": decision_id,
            "hint": "Decision 由 Python DecisionAuthority 裁决时落盘；"
                    "未知 decisionId 意味着未经 Python FINAL Authority 裁决",
        })
    return {"decision": record, "verified": True}


@router.get("/authority/goals/{goal_id}/decisions")
async def get_goal_decisions(goal_id: str) -> Any:
    return {"goalId": goal_id, "decisions": _store().get_decisions_for_goal(goal_id)}


@router.get("/authority/goals/{goal_id}/evidence")
async def get_goal_evidence(goal_id: str) -> Any:
    return {"goalId": goal_id, "evidence": _store().get_evidence_for_goal(goal_id)}


@router.get("/authority/goals/{goal_id}/beliefs")
async def get_goal_beliefs(goal_id: str) -> Any:
    return {"goalId": goal_id, "beliefUpdates": _store().get_belief_history_for_goal(goal_id)}
