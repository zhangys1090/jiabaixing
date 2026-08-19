"""用户反馈 HTTP API 路由。

提供用户提交反馈、修正和查看统计的端点，将反馈接入
ContinuousFeedbackLoop + ProductionMetricsCollector 形成闭环。

端点:
    POST /api/feedback           — 用户提交反馈（点赞/点踩/复用）
    POST /api/feedback/correction — 用户提交修正
    GET  /api/feedback/stats      — 反馈统计
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Request

from agent.core.logger import StructuredLogger
from agent.core.production_metrics import get_production_metrics_collector

log = StructuredLogger("api.feedback")

router = APIRouter(tags=["feedback"])


def _get_engine(request: Request):
    """从 app.state 获取 engine 实例（可能为 None）。"""
    return getattr(request.app.state, "engine", None)


@router.post("/feedback")
async def submit_feedback(request: Request):
    """用户提交反馈（点赞/点踩/复用）。

    请求体:
        {
            "session_id": "sess-xxx",
            "feedback_type": "positive" | "negative" | "reuse",
            "metadata": {}  // 可选
        }

    Returns:
        dict: {"success": bool, "entry_id": str}
    """
    engine = _get_engine(request)
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        # 仅 JSON 解析失败返回 invalid JSON body；其余异常如实抛出由中间件记录（审计 E-02）
        return {"success": False, "error": "invalid JSON body"}

    session_id = body.get("session_id", "")
    feedback_type = body.get("feedback_type", "")
    metadata = body.get("metadata") or {}

    # 合法反馈类型：positive/negative/reuse（correction 走独立端点）
    valid_types = {"positive", "negative", "reuse"}
    if feedback_type not in valid_types:
        return {
            "success": False,
            "error": f"feedback_type 必须是 {sorted(valid_types)} 之一",
        }

    # 记录到生产埋点
    try:
        get_production_metrics_collector().record_user_feedback(
            session_id=session_id, feedback_type=feedback_type
        )
    except Exception as e:
        log.warning("record_user_feedback 失败（已忽略）", error=str(e))

    # 写入持续反馈闭环
    entry_id = ""
    if engine and getattr(engine, "feedback_loop", None):
        try:
            entry = await engine.feedback_loop.collect_feedback(
                session_id=session_id,
                feedback_type=feedback_type,
                metadata=metadata,
            )
            # 转化为学习信号并写入进化引擎
            signal = await engine.feedback_loop.convert_to_learning_signal(entry)
            await engine.feedback_loop.feed_to_evolution_engine(signal)
            # 检查是否达到优化阈值
            await engine.feedback_loop.check_and_optimize()
            entry_id = entry.entry_id
        except ValueError as e:
            return {"success": False, "error": str(e)}
        except Exception as e:
            log.error("反馈闭环处理失败", error=str(e))
            return {"success": False, "error": str(e)}

    return {"success": True, "entry_id": entry_id}


@router.post("/feedback/correction")
async def submit_correction(request: Request):
    """用户提交修正（用户修改了 AI 输出）。

    请求体:
        {
            "session_id": "sess-xxx",
            "original": "AI 原始输出",
            "corrected": "用户修正后的内容",
            "metadata": {}  // 可选
        }

    Returns:
        dict: {"success": bool, "entry_id": str}
    """
    engine = _get_engine(request)
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        # 仅 JSON 解析失败返回 invalid JSON body；其余异常如实抛出由中间件记录（审计 E-02）
        return {"success": False, "error": "invalid JSON body"}

    session_id = body.get("session_id", "")
    original = body.get("original", "")
    corrected = body.get("corrected", "")
    metadata = body.get("metadata") or {}
    # 将修正前后内容塞入 metadata，供学习信号转化使用
    metadata["original"] = original
    metadata["corrected"] = corrected

    # 记录到生产埋点（修正视为 negative 反馈信号）
    try:
        get_production_metrics_collector().record_user_feedback(
            session_id=session_id, feedback_type="correction"
        )
    except Exception as e:
        log.warning("record_user_feedback 失败（已忽略）", error=str(e))

    entry_id = ""
    if engine and getattr(engine, "feedback_loop", None):
        try:
            entry = await engine.feedback_loop.collect_feedback(
                session_id=session_id,
                feedback_type="correction",
                metadata=metadata,
            )
            signal = await engine.feedback_loop.convert_to_learning_signal(entry)
            await engine.feedback_loop.feed_to_evolution_engine(signal)
            await engine.feedback_loop.check_and_optimize()
            entry_id = entry.entry_id
        except ValueError as e:
            return {"success": False, "error": str(e)}
        except Exception as e:
            log.error("修正反馈闭环处理失败", error=str(e))
            return {"success": False, "error": str(e)}

    return {"success": True, "entry_id": entry_id}


@router.get("/feedback/stats")
async def feedback_stats(request: Request):
    """获取反馈统计。

    Returns:
        dict: 反馈计数统计 + 进化引擎指标（如有）。
    """
    engine = _get_engine(request)
    stats: dict = {"feedback": {}}

    if engine and getattr(engine, "feedback_loop", None):
        try:
            stats["feedback"] = engine.feedback_loop.get_stats()
        except Exception as e:
            log.warning("get_stats 失败", error=str(e))

    # 附带进化引擎的整体指标
    if engine and getattr(engine, "evolution", None):
        try:
            metrics = engine.evolution.get_metrics()
            stats["evolution"] = {
                "total_interactions": metrics.total_interactions,
                "total_evolutions": metrics.total_evolutions,
                "successful_evolutions": metrics.successful_evolutions,
                "average_quality": round(metrics.average_quality, 3),
                "quality_trend": metrics.quality_trend,
            }
        except Exception as e:
            log.warning("get_metrics 失败", error=str(e))

    return stats
