"""SLO 健康检查端点 —— 暴露 `/v1/health/slo`。

数据来自 `agent.infrastructure.slo_collector` 单例，由 `main.MetricsMiddleware`
在每次请求完成时写入（延迟 + 是否错误）。监控/告警可轮询本端点，
当 `status == "breach"` 时触发告警，使「真实商用闭环」具备可核查证据。

Usage:
    app.include_router(slo_router, prefix="/v1")
"""

from __future__ import annotations

from fastapi import APIRouter

from agent.infrastructure.slo_collector import SLO_OBJECTIVES, get_slo_collector

router = APIRouter()


@router.get("/health/slo")
async def health_slo() -> dict:
    """返回当前 SLO 快照：成功率、P95 延迟、达标状态。"""
    collector = get_slo_collector()
    return collector.snapshot(objectives=SLO_OBJECTIVES)
