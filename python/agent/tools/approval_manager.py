from __future__ import annotations

import random
import string
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("approval_manager")


@dataclass
class ApprovalRequest:
    """审批请求。

    Attributes:
        id: 请求唯一标识。
        tool_name: 工具名称。
        params: 工具调用参数。
        risk_level: 风险等级。
        timestamp: 创建时间戳。
        status: 当前状态（pending/approved/rejected）。
        reason: 拒绝原因。
    """

    id: str
    tool_name: str
    params: dict[str, Any] = field(default_factory=dict)
    risk_level: str = "low"
    timestamp: float = 0.0
    status: str = "pending"
    reason: str = ""


@dataclass
class ApprovalResponse:
    """审批响应。

    Attributes:
        approved: 是否批准。
        reason: 批准/拒绝原因。
    """

    approved: bool
    reason: str = ""


_ApprovalCallback = Callable[[ApprovalRequest], None]


class ApprovalManager:
    """工具审批管理器。

    管理高风险工具调用的审批流程，支持用户确认和超时自动拒绝。
    默认120秒超时，低风险操作可配置自动批准。

    Usage:
        manager = ApprovalManager(auto_approve_low_risk=True)
        resp = await manager.request_approval("shell_exec", params, "high")
        if not resp.approved:
            return "操作被拒绝"
    """

    _REQUEST_TIMEOUT_MS = 120_000

    def __init__(self, auto_approve_low_risk: bool = False) -> None:
        self._pending: dict[str, dict[str, Any]] = {}
        self._auto_approve_low_risk = auto_approve_low_risk
        self._listeners: list[_ApprovalCallback] = []

    def on_request(self, callback: _ApprovalCallback) -> None:
        self._listeners.append(callback)

    async def request_approval(self, tool_name: str, params: dict[str, Any], risk_level: str) -> ApprovalResponse:
        if self._auto_approve_low_risk and risk_level == "low":
            log.info("自动批准低风险工具", tool=tool_name)
            return ApprovalResponse(approved=True)

        _id = f"approval_{int(time.time() * 1000)}_{''.join(random.choices(string.ascii_lowercase + string.digits, k=6))}"
        request = ApprovalRequest(
            id=_id, tool_name=tool_name, params=params,
            risk_level=risk_level, timestamp=time.time(), status="pending",
        )

        promise: dict[str, Any] = {"resolve": None}
        future: ApprovalResponse | None = None

        def _resolve(resp: ApprovalResponse) -> None:
            nonlocal future
            future = resp

        self._pending[_id] = {"resolve": _resolve, "request": request}

        for listener in self._listeners:
            try:
                listener(request)
            except Exception:
                pass

        log.info("等待用户审批", tool=tool_name, risk=risk_level, id=_id)

        import asyncio
        start = time.time()
        timeout_sec = self._REQUEST_TIMEOUT_MS / 1000

        while future is None:
            if time.time() - start > timeout_sec:
                entry = self._pending.pop(_id, None)
                if entry and entry["request"].status == "pending":
                    entry["request"].status = "rejected"
                    entry["request"].reason = "审批超时"
                    log.warning("审批超时自动拒绝", tool=tool_name, id=_id)
                    return ApprovalResponse(approved=False, reason="审批超时，已自动拒绝")
            await asyncio.sleep(0.1)

        self._pending.pop(_id, None)
        return future

    def respond(self, request_id: str, approved: bool, reason: str = "") -> bool:
        entry = self._pending.get(request_id)
        if not entry or entry["request"].status != "pending":
            return False
        entry["request"].status = "approved" if approved else "rejected"
        entry["request"].reason = reason
        entry["resolve"](ApprovalResponse(approved=approved, reason=reason))

        prefix = "通过" if approved else "拒绝"
        log.info(f"审批{prefix}", tool=entry["request"].tool_name, id=request_id)
        return True

    def get_pending_requests(self) -> list[ApprovalRequest]:
        return [e["request"] for e in self._pending.values() if e["request"].status == "pending"]

    def pending_count(self) -> int:
        return len(self.get_pending_requests())
