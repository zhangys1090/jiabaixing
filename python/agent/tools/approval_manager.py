from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.core.logger import StructuredLogger
from agent.security.runtime_posture import PostureDecision, RuntimePosture, decide

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

    def __init__(
        self,
        auto_approve_low_risk: bool = False,
        auto_approve_all: bool = False,
        posture: RuntimePosture | None = None,
        safety_net: Any | None = None,
    ) -> None:
        self._pending: dict[str, dict[str, Any]] = {}
        # 规划阶段预览审批请求的索引：tool_name -> pending request id，
        # 执行阶段 request_approval 命中同一工具时复用该请求（规划预览一次、执行即放行）。
        self._preview_by_tool: dict[str, str] = {}
        self._auto_approve_low_risk = auto_approve_low_risk
        self._auto_approve_all = auto_approve_all
        # 默认 CONFIRM：不介入既有 auto_approve_* 流程，保证向后兼容。
        self._posture = posture if posture is not None else RuntimePosture.CONFIRM
        # 紧急锁定：开启后所有工具调用（含 critical）一律拒绝。
        self._lockdown = False
        self._listeners: list[_ApprovalCallback] = []
        # SafetyNet 集成：agent_native + 有还原点 → 可自动批准 high 风险操作
        self._safety_net = safety_net

    def set_lockdown(self, enabled: bool) -> None:
        """开启/解除紧急锁定（供管理面调用）。"""
        self._lockdown = bool(enabled)
        if self._lockdown:
            # 防御纵深：锁定时强制 SAFE 姿态
            self._posture = RuntimePosture.SAFE
        log.warning("运行时锁定状态已变更", lockdown=self._lockdown)

    @property
    def lockdown(self) -> bool:
        return self._lockdown

    def on_request(self, callback: _ApprovalCallback) -> None:
        self._listeners.append(callback)

    def set_posture(self, posture: RuntimePosture) -> None:
        """运行时切换安全姿态（供 CLI/HTTP 入口调用）。"""
        self._posture = posture
        log.info("运行时安全姿态已切换", posture=posture.value)

    @property
    def posture(self) -> RuntimePosture:
        return self._posture

    #: 无论何种自动批准配置，critical 风险操作始终需要显式审批（安全硬底线）。
    # 仅 critical 永不放行（符合 R1-A 运行时安全姿态设计：critical 永远需要显式审批）。
    # 注意：high 在 auto_approve_all 模式下应被自动批准（见 test_confirm_posture_is_backward_compatible /
    # test_T03_critical_never_auto_approved），故不在此集合内。
    _NEVER_AUTO_APPROVE_RISKS = frozenset({"critical"})

    async def request_approval(self, tool_name: str, params: dict[str, Any], risk_level: str) -> ApprovalResponse:
        # 紧急锁定：任何工具调用（含 critical）一律拒绝，立即生效。
        if self._lockdown:
            log.warning("锁定状态下拒绝工具调用", tool=tool_name, risk=risk_level)
            return ApprovalResponse(approved=False, reason="系统已锁定（lockdown），所有工具调用被拒绝")

        # 修复 T-03：即便 auto_approve_all/auto_approve_low_risk 开启，critical 风险也不自动放行，
        # 必须走正常审批流（有监听器则等待确认，无监听器则超时拒绝）。
        force_review = risk_level in self._NEVER_AUTO_APPROVE_RISKS

        # 运行时安全姿态优先裁决（CONFIRM 不介入，交回下方既有流程，保证向后兼容）。
        if self._posture is not RuntimePosture.CONFIRM:
            decision = decide(self._posture, risk_level)
            if decision is PostureDecision.ALLOW:
                log.info("姿态放行工具调用", tool=tool_name, risk=risk_level, posture=self._posture.value)
                return ApprovalResponse(approved=True)
            if decision is PostureDecision.DENY:
                reason = f"{self._posture.value} 姿态下拒绝 {risk_level} 风险操作"
                log.warning("姿态拒绝工具调用", tool=tool_name, risk=risk_level, posture=self._posture.value)
                return ApprovalResponse(approved=False, reason=reason)
            # PostureDecision.REVIEW → 落入下方正常审批流

        # 非交互式环境：自动批准所有工具调用（critical 除外）
        if self._auto_approve_all and not force_review:
            log.info("自动批准工具调用(免审批)", tool=tool_name, risk=risk_level)
            return ApprovalResponse(approved=True)

        # 低风险工具：自动批准
        if self._auto_approve_low_risk and risk_level == "low":
            log.info("自动批准低风险工具", tool=tool_name)
            return ApprovalResponse(approved=True)

        # SafetyNet 自动批准：agent_native 模型 + 有还原点 → high 风险可自动批准
        if self._safety_net and risk_level == "high":
            try:
                agent_native = params.get("_agent_native", False)
                if agent_native and self._safety_net.can_auto_approve(risk_level, agent_native=True):
                    log.info("SafetyNet 自动批准高风险操作", tool=tool_name, risk=risk_level, agent_native=True)
                    return ApprovalResponse(approved=True, reason="safety_net_checkpoint_active")
            except Exception as e:
                log.warning("SafetyNet 自动批准检查失败", error=str(e))

        import asyncio
        timeout_sec = self._REQUEST_TIMEOUT_MS / 1000

        # 规划阶段预览：若已为该工具推送过计划内审批请求，则复用同一请求，
        # 使前端「规划预览时的一次确认」直接作用于执行阶段（必须在新建请求之前）。
        preview_id = self._preview_by_tool.pop(tool_name, None)
        if preview_id and preview_id in self._pending:
            preview_entry = self._pending[preview_id]
            if preview_entry["request"].status == "pending":
                preview_entry["request"].params = params
                log.info("复用规划阶段预览的审批请求", tool=tool_name, id=preview_id)
                try:
                    return await asyncio.wait_for(preview_entry["_future"], timeout=timeout_sec)
                except asyncio.TimeoutError:
                    preview_entry["request"].status = "rejected"
                    preview_entry["request"].reason = "审批超时"
                    return ApprovalResponse(approved=False, reason="审批超时，已自动拒绝")

        _id = f"approval_{uuid.uuid4().hex}"
        request = ApprovalRequest(
            id=_id, tool_name=tool_name, params=params,
            risk_level=risk_level, timestamp=time.time(), status="pending",
        )

        import asyncio
        loop = asyncio.get_running_loop()
        done_future = loop.create_future()

        def _resolve(resp: ApprovalResponse) -> None:
            if not done_future.done():
                done_future.set_result(resp)

        self._pending[_id] = {"resolve": _resolve, "request": request, "_future": done_future}

        for listener in self._listeners:
            try:
                listener(request)
            except Exception as _listener_exc:
                # D2（审计 §1.7）：监听器通知失败此前静默吞掉，
                # 后果是审批请求推不到前端/桌面端，用户看不到弹窗，
                # 只能等到 _REQUEST_TIMEOUT_MS 超时被自动拒绝，且全程无任何信号。
                log.error(
                    "审批监听器通知失败，该通道用户可能收不到审批请求",
                    tool=tool_name,
                    id=_id,
                    listener=getattr(listener, "__qualname__", repr(listener)),
                    error=str(_listener_exc),
                )

        log.info("等待用户审批", tool=tool_name, risk=risk_level, id=_id)

        try:
            return await asyncio.wait_for(done_future, timeout=timeout_sec)
        except asyncio.TimeoutError:
            entry = self._pending.pop(_id, None)
            if entry and entry["request"].status == "pending":
                entry["request"].status = "rejected"
                entry["request"].reason = "审批超时"
                log.warning("审批超时自动拒绝", tool=tool_name, id=_id)
            return ApprovalResponse(approved=False, reason="审批超时，已自动拒绝")

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

    async def preview_plan_approvals(self, plan: Any) -> list[str]:
        """规划阶段把「需审批」步骤作为预览请求推给前端确认 UI。

        仅在当前配置会真正走到人工审批时推送（CONFIRM 姿态且非 auto_approve_all），
        避免低风险/自动批准残留过期请求。返回的 preview id 会在执行阶段被
        ``request_approval`` 复用，实现「规划预览一次、执行即放行」。

        Returns:
            成功推送的预览请求 id 列表。
        """
        if self._auto_approve_all or self._posture != RuntimePosture.CONFIRM:
            return []
        import asyncio

        ids: list[str] = []
        for step in getattr(plan, "steps", []):
            if not getattr(step, "requires_approval", False):
                continue
            tool_name = getattr(step, "tool_name", None)
            if not tool_name or tool_name in self._preview_by_tool:
                continue
            _id = f"approval_preview_{uuid.uuid4().hex}"
            request = ApprovalRequest(
                id=_id,
                tool_name=tool_name,
                params=getattr(step, "tool_params", {}) or {},
                risk_level=getattr(step, "risk_level", "high"),
                timestamp=time.time(),
                status="pending",
            )
            loop = asyncio.get_running_loop()
            done_future = loop.create_future()

            def _resolve(resp: ApprovalResponse) -> None:
                if not done_future.done():
                    done_future.set_result(resp)

            self._pending[_id] = {"resolve": _resolve, "request": request, "_future": done_future}
            self._preview_by_tool[tool_name] = _id
            for listener in self._listeners:
                try:
                    listener(request)
                except Exception as _listener_exc:
                    log.error(
                        "审批预览监听器通知失败",
                        tool=tool_name,
                        id=_id,
                        listener=getattr(listener, "__qualname__", repr(listener)),
                        error=str(_listener_exc),
                    )
            ids.append(_id)
        if ids:
            log.info("已推送规划阶段待审批预览", count=len(ids))
        return ids
