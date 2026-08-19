from __future__ import annotations

import time
from typing import Any

from agent.tools.approval_manager import ApprovalManager
from agent.tools.registry import ToolRegistry, ToolResult
from agent.tools.risk_level import (
    HIGH_RISK_LEVELS,
    classify_risk,
    requires_approval,
)
from agent.core.logger import StructuredLogger

log = StructuredLogger("risk_precheck")


class RiskPrecheck:
    """高风险动作预检 + 人工审批层，并与规划器联动。

    闭环定位：
      Planner 生成计划 → Executor 执行前 → RiskPrecheck 介入
        → 根据工具风险等级判断是否需要人工审批（ApprovalManager）
        → 未通过则拦截；通过或低风险则放行执行。

    设计原则：
      - 复用既有 ApprovalManager 与运行时安全姿态（RuntimePosture），
        不重复实现审批/姿态裁决逻辑。
      - 低风险动作零开销直通；仅 high/critical 触发审批流。
      - 通过 ``annotate_plan`` 为计划每一步标注风险等级，实现与规划器联动。
    """

    def __init__(
        self,
        registry: ToolRegistry,
        approval_manager: ApprovalManager | None = None,
    ) -> None:
        self._registry = registry
        self._approval = approval_manager

    def requires_approval(self, name: str) -> bool:
        """该工具是否需要走人工审批。"""
        return requires_approval(classify_risk(self._registry, name))

    async def execute(self, name: str, params: dict[str, Any] | None = None) -> ToolResult:
        """预检后执行：高风险未获审批则直接拦截。"""
        params = params or {}
        definition = self._registry.get_definition(name)
        if definition is not None:
            risk = getattr(definition, "risk_level", "low")
            if requires_approval(risk) and self._approval is not None:
                resp = await self._approval.request_approval(name, params, risk)
                if not resp.approved:
                    return ToolResult(
                        success=False,
                        error=f"高风险动作被拦截（未获审批）: {resp.reason}",
                        metadata={"blocked_by": "approval", "risk_level": risk},
                    )
        return await self._registry.execute(name, params)

    def annotate_plan(self, plan: "Any") -> "Any":
        """规划器联动：为计划中的每一步标注其工具的风险等级。

        标注后，前端/CLI 可在执行前展示风险，用户可据此确认是否放行。
        """
        for step in plan.steps:
            tool_name = getattr(step, "tool_name", None)
            if tool_name:
                definition = self._registry.get_definition(tool_name)
                if definition is not None:
                    step.risk_level = getattr(definition, "risk_level", "low")
                    step.requires_approval = requires_approval(step.risk_level)
        return plan


    async def preview_plan(self, plan: "Any") -> list[str]:
        """规划阶段把待审批步骤推给前端确认 UI（委托 ApprovalManager）。

        仅在有审批管理器（人工介入）时推送；无审批管理器（直通模式）则空返回。
        """
        if self._approval is None:
            return []
        try:
            return await self._approval.preview_plan_approvals(plan)
        except Exception as exc:
            log.warning("规划阶段审批预览失败，已跳过", error=str(exc))
            return []


def plan_to_approval_requests(plan: "Any") -> list[dict]:
    """把需要人工审批的计划步骤转换为前端 ``ApprovalDialog`` 所需的请求结构。

    返回的字典形状与 ``src/frontend/.../ApprovalDialog`` 的 ``ApprovalRequest``
    接口一致（id/toolName/params/riskLevel/timestamp/status），从而让规划器
    阶段产出的「需审批」步骤直接驱动前端确认 UI。
    """
    requests: list[dict] = []
    for idx, step in enumerate(plan.steps):
        if not getattr(step, "requires_approval", False):
            continue
        requests.append(
            {
                "id": f"step-{idx}-{getattr(step, 'tool_name', 'unknown')}",
                "toolName": getattr(step, "tool_name", ""),
                "params": getattr(step, "tool_params", {}) or {},
                "riskLevel": getattr(step, "risk_level", "low"),
                "timestamp": time.time(),
                "status": "pending",
            }
        )
    return requests
