"""生产环境指标采集器（ProductionMetricsCollector）。

基于 OpenTelemetry Meter 采集关键业务指标，作为现有 otel_metrics 模块之上的
高层封装。复用已有指标原语（tool_calls_counter / llm_tokens_counter /
tool_duration_histogram / set_active_sessions），新增业务侧缺失的指标：
- agent_request_total: 请求总数（按 user_id/intent/status 标签）
- agent_request_duration: 请求耗时直方图
- agent_llm_cost_total: LLM 成本
- agent_user_satisfaction: 用户满意度（点赞/点踩）
- agent_error_total: 错误总数（按 error_type 标签）

当 OTEL_ENABLED != "true" 时，所有操作优雅降级为 NoOp，不抛异常。

Usage:
    from agent.core.production_metrics import get_production_metrics_collector
logger = logging.getLogger(__name__)

    collector = get_production_metrics_collector()
    collector.record_request(user_id="u1", intent="chat", status="success", duration_ms=120.0)
    collector.record_tool_call(tool_name="file_read", success=True, duration_ms=15.0)
    collector.record_llm_usage(model="gpt-4o", prompt_tokens=100, completion_tokens=50, cost=0.01)
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

from opentelemetry import metrics

# 复用现有 otel_metrics 原语，避免重复造轮子
from agent.core.otel_metrics import (
    llm_tokens_counter,
    set_active_sessions as _otel_set_active_sessions,
    tool_calls_counter,
    tool_duration_histogram,
)


# 全局采集器单例
_collector_instance: Optional["ProductionMetricsCollector"] = None
"""全局 ProductionMetricsCollector 单例，由 get_production_metrics_collector 设置。"""
_instance_lock = threading.Lock()

# 预定义业务指标缓存
_request_counter: Optional[metrics.Counter] = None
_request_duration_histogram: Optional[metrics.Histogram] = None
_llm_cost_counter: Optional[metrics.Counter] = None
_user_satisfaction_counter: Optional[metrics.Counter] = None
_error_counter: Optional[metrics.Counter] = None
_metrics_lock = threading.Lock()


def _reset_collector_for_testing() -> None:
    """重置全局采集器与业务指标缓存（仅用于测试）。

    清除单例缓存，便于测试间隔离。
    """
    global _collector_instance
    global _request_counter, _request_duration_histogram
    global _llm_cost_counter, _user_satisfaction_counter, _error_counter
    _collector_instance = None
    _request_counter = None
    _request_duration_histogram = None
    _llm_cost_counter = None
    _user_satisfaction_counter = None
    _error_counter = None


def _request_total_counter() -> metrics.Counter:
    """获取请求总数 Counter 单例。

    指标名: agent_request_total
    描述: 请求总数（按 user_id/intent/status 标签）

    Returns:
        metrics.Counter: Counter 实例；OTel 未启用时返回 NoOp Counter。
    """
    global _request_counter
    if _request_counter is None:
        with _metrics_lock:
            if _request_counter is None:
                _request_counter = metrics.get_meter(__name__).create_counter(
                    name="agent_request_total",
                    description="请求总数（按 user_id/intent/status 标签）",
                )
    return _request_counter


def _request_duration_histogram() -> metrics.Histogram:
    """获取请求耗时 Histogram 单例。

    指标名: agent_request_duration
    描述: 请求耗时直方图（毫秒）

    Returns:
        metrics.Histogram: Histogram 实例；OTel 未启用时返回 NoOp Histogram。
    """
    global _request_duration_histogram
    if _request_duration_histogram is None:
        with _metrics_lock:
            if _request_duration_histogram is None:
                _request_duration_histogram = metrics.get_meter(__name__).create_histogram(
                    name="agent_request_duration",
                    description="请求耗时直方图（毫秒）",
                )
    return _request_duration_histogram


def _llm_cost_counter() -> metrics.Counter:
    """获取 LLM 成本 Counter 单例。

    指标名: agent_llm_cost_total
    描述: LLM 调用成本累计（美元）

    Returns:
        metrics.Counter: Counter 实例；OTel 未启用时返回 NoOp Counter。
    """
    global _llm_cost_counter
    if _llm_cost_counter is None:
        with _metrics_lock:
            if _llm_cost_counter is None:
                _llm_cost_counter = metrics.get_meter(__name__).create_counter(
                    name="agent_llm_cost_total",
                    description="LLM 调用成本累计（美元）",
                )
    return _llm_cost_counter


def _user_satisfaction_counter() -> metrics.Counter:
    """获取用户满意度 Counter 单例。

    指标名: agent_user_satisfaction
    描述: 用户满意度反馈（按 feedback_type 标签：positive/negative）

    Returns:
        metrics.Counter: Counter 实例；OTel 未启用时返回 NoOp Counter。
    """
    global _user_satisfaction_counter
    if _user_satisfaction_counter is None:
        with _metrics_lock:
            if _user_satisfaction_counter is None:
                _user_satisfaction_counter = metrics.get_meter(__name__).create_counter(
                    name="agent_user_satisfaction",
                    description="用户满意度反馈（点赞/点踩）",
                )
    return _user_satisfaction_counter


def _error_total_counter() -> metrics.Counter:
    """获取错误总数 Counter 单例。

    指标名: agent_error_total
    描述: 错误总数（按 error_type 标签）

    Returns:
        metrics.Counter: Counter 实例；OTel 未启用时返回 NoOp Counter。
    """
    global _error_counter
    if _error_counter is None:
        with _metrics_lock:
            if _error_counter is None:
                _error_counter = metrics.get_meter(__name__).create_counter(
                    name="agent_error_total",
                    description="错误总数（按 error_type 标签）",
                )
    return _error_counter


class ProductionMetricsCollector:
    """生产环境指标采集器。

    作为 OpenTelemetry Meter 的高层业务封装，提供面向业务语义的指标采集方法。
    所有方法在 OTel 未启用时为 NoOp，不抛异常，不影响主流程。

    设计原则:
        - 复用现有 otel_metrics 原语，不重复造轮子
        - 防御性编程：所有外部输入做边界处理
        - 失败静默：埋点失败不影响业务主流程

    Usage:
        collector = ProductionMetricsCollector()
        collector.record_request(user_id="u1", intent="chat", status="success", duration_ms=120.0)
    """

    def record_request(
        self,
        user_id: str,
        intent: str,
        status: str,
        duration_ms: float,
    ) -> None:
        """记录一次请求的指标。

        同时更新请求总数 Counter（带标签）和请求耗时直方图。

        Args:
            user_id: 用户标识（用于标签，可为空）。
            intent: 请求意图（如 "chat"/"tool_call"/"multi_agent"）。
            status: 请求状态（如 "success"/"failed"/"blocked"）。
            duration_ms: 请求耗时（毫秒）。
        """
        try:
            labels = {
                "user_id": user_id or "anonymous",
                "intent": intent or "unknown",
                "status": status or "unknown",
            }
            _request_total_counter().add(1, labels)
            _request_duration_histogram().record(max(0.0, float(duration_ms)))
        except Exception as exc:
            logger.debug("record_request 失败（已忽略）: %s", exc)

    def record_tool_call(
        self,
        tool_name: str,
        success: bool,
        duration_ms: float,
    ) -> None:
        """记录一次工具调用的指标。

        复用 otel_metrics 的 tool_calls_counter（带 success 标签）和
        tool_duration_histogram。

        Args:
            tool_name: 工具名称。
            success: 调用是否成功。
            duration_ms: 调用耗时（毫秒）。
        """
        try:
            tool_calls_counter().add(
                1,
                {
                    "tool_name": tool_name or "unknown",
                    "success": str(bool(success)),
                },
            )
            tool_duration_histogram().record(
                max(0.0, float(duration_ms)) / 1000.0
            )
        except Exception as exc:
            logger.debug("record_tool_call 失败（已忽略）: %s", exc)

    def record_llm_usage(
        self,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        cost: float,
    ) -> None:
        """记录 LLM 调用的用量与成本。

        复用 otel_metrics 的 llm_tokens_counter 记录 prompt/completion token，
        新增 llm_cost_counter 记录成本（负成本截断为 0）。

        Args:
            model: 实际调用的模型名。
            prompt_tokens: 输入 token 数。
            completion_tokens: 输出 token 数。
            cost: 本次调用成本（美元）。
        """
        try:
            pt = max(0, int(prompt_tokens))
            ct = max(0, int(completion_tokens))
            if pt > 0:
                llm_tokens_counter().add(pt, {"model": model, "type": "prompt"})
            if ct > 0:
                llm_tokens_counter().add(ct, {"model": model, "type": "completion"})
            safe_cost = max(0.0, float(cost))
            if safe_cost > 0:
                _llm_cost_counter().add(safe_cost, {"model": model})
        except Exception as exc:
            logger.debug("record_llm_usage 失败（已忽略）: %s", exc)

    def record_user_feedback(
        self,
        session_id: str,
        feedback_type: str,
    ) -> None:
        """记录用户反馈（点赞/点踩）。

        Args:
            session_id: 会话标识（用于标签）。
            feedback_type: 反馈类型（"positive"/"negative"/"neutral"）。
        """
        try:
            _user_satisfaction_counter().add(
                1,
                {
                    "session_id": session_id or "unknown",
                    "feedback_type": feedback_type or "neutral",
                },
            )
        except Exception as exc:
            logger.debug("record_user_feedback 失败（已忽略）: %s", exc)

    def record_error(
        self,
        error_type: str,
        error_message: str,
    ) -> None:
        """记录一次错误。

        Args:
            error_type: 错误类型（如 "ValueError"/"TimeoutError"）。
            error_message: 错误信息（用于日志，不作为标签避免高基数）。
        """
        try:
            _error_total_counter().add(
                1,
                {"error_type": error_type or "UnknownError"},
            )
            if error_message:
                logger.debug("错误埋点: %s - %s", error_type, error_message[:200])
        except Exception as exc:
            logger.debug("record_error 失败（已忽略）: %s", exc)

    def set_active_sessions(self, count: int) -> None:
        """更新活跃会话数 gauge。

        复用 otel_metrics.set_active_sessions（ObservableGauge 回调读取）。

        Args:
            count: 当前活跃会话数。
        """
        try:
            _otel_set_active_sessions(max(0, int(count)))
        except Exception as exc:
            logger.debug("set_active_sessions 失败（已忽略）: %s", exc)


def get_production_metrics_collector() -> ProductionMetricsCollector:
    """获取全局采集器单例。

    首次调用时创建实例，后续返回同一实例。

    Returns:
        ProductionMetricsCollector: 全局采集器实例。
    """
    global _collector_instance
    if _collector_instance is None:
        with _instance_lock:
            if _collector_instance is None:
                _collector_instance = ProductionMetricsCollector()
    return _collector_instance
