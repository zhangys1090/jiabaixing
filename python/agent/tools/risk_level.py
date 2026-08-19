from __future__ import annotations

from agent.tools.registry import ToolRegistry

# 需要人工审批的风险等级（与 ToolRegistry.risk_level 约定保持一致）
HIGH_RISK_LEVELS = frozenset({"high", "critical"})


def classify_risk(registry: ToolRegistry | None, tool_name: str) -> str:
    """根据工具注册中心返回某工具的风险等级；未知工具按 low 处理。"""
    if registry is not None:
        definition = registry.get_definition(tool_name)
        if definition is not None:
            risk = getattr(definition, "risk_level", "")
            if risk:
                return risk
    return "low"


def requires_approval(risk_level: str) -> bool:
    """风险等级是否需要走人工审批（high/critical）。"""
    return risk_level in HIGH_RISK_LEVELS
