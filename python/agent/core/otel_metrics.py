"""OpenTelemetry Metrics 初始化与预定义指标。

为家百星 Python Agent 提供 Meter 初始化、全局获取与预定义业务指标。
当 OTEL_ENABLED != "true" 时，所有指标优雅降级为 NoOp，不抛异常。

注意:
    OTEL_ENABLED 默认 false，是为了开发环境友好（避免本地启动时连接
    Prometheus/OTLP collector 的噪声日志与超时等待）。生产部署时必须
    显式设置 OTEL_ENABLED=true，并在部署文档中明确标注。相关接线点
    已在生产代码中就位（如 LLMProvider._do_chat_via_litellm 会调用
    llm_tokens_counter().add(...)，OTel 未启用时为 NoOp 不影响主流程）。

预定义指标:
    - jiabaixing_loop_iterations (Counter): Loop 迭代次数
    - jiabaixing_tool_calls (Counter): 工具调用次数
    - jiabaixing_llm_tokens (Counter): LLM Token 消耗
    - jiabaixing_loop_duration (Histogram): Loop 执行耗时
    - jiabaixing_tool_duration (Histogram): 工具执行耗时
    - jiabaixing_active_sessions (ObservableGauge): 活跃会话数

环境变量:
    OTEL_ENABLED: 是否启用 OTel（"true" 启用，其他禁用）。

Usage:
    from agent.core.otel_metrics import loop_iterations_counter, loop_duration_histogram
logger = logging.getLogger(__name__)

    loop_iterations_counter().add(1, {"status": "success"})
    loop_duration_histogram().record(1.23)
"""
from __future__ import annotations

import logging
import os
from typing import Iterable, Optional

from opentelemetry import metrics
from opentelemetry.metrics import CallbackOptions, Meter, MeterProvider, Observation


# 模块常量
OTEL_ENABLED_DEFAULT: bool = False
"""默认未启用 OTel，需通过环境变量 OTEL_ENABLED=true 显式开启。"""

OTEL_SERVICE_NAME: str = "jiabaixing-agent-python"
"""默认服务名。"""

# 全局 meter 实例（单例）
_meter_instance: Optional[Meter] = None
"""全局 meter 单例，由 init_metrics 设置。"""

_meter_provider_instance: Optional[MeterProvider] = None
"""全局 MeterProvider 实例，由 init_metrics 设置。"""

# 预定义指标缓存（单例）
_loop_iterations_counter: Optional[metrics.Counter] = None
_tool_calls_counter: Optional[metrics.Counter] = None
_llm_tokens_counter: Optional[metrics.Counter] = None
_loop_duration_histogram: Optional[metrics.Histogram] = None
_tool_duration_histogram: Optional[metrics.Histogram] = None
_active_sessions_gauge: Optional[metrics.ObservableGauge] = None

# ObservableGauge 回调数据源
_active_sessions_value: int = 0
"""当前活跃会话数，由 set_active_sessions 更新，供 ObservableGauge 回调读取。"""


def _is_otel_enabled() -> bool:
    """检查 OTel 是否启用。

    Returns:
        bool: 当环境变量 OTEL_ENABLED 为 "true"（不区分大小写）时返回 True。
    """
    return os.environ.get("OTEL_ENABLED", str(OTEL_ENABLED_DEFAULT)).lower() == "true"


def _observe_active_sessions(options: CallbackOptions = None) -> Iterable[Observation]:
    """ObservableGauge 回调：返回当前活跃会话数。

    由 MetricReader 周期性调用（OTel 启用时），读取模块级 _active_sessions_value。

    Args:
        options: 回调选项（由 OTel SDK 注入，包含超时等信息）。

    Yields:
        Observation: 包含当前活跃会话数的观测值。
    """
    yield Observation(_active_sessions_value)


def set_active_sessions(count: int) -> None:
    """更新活跃会话数（供 ObservableGauge 回调读取）。

    Args:
        count: 当前活跃会话数。
    """
    global _active_sessions_value
    _active_sessions_value = count


def init_metrics(endpoint: str | None = None) -> MeterProvider:
    """初始化 MeterProvider 并设置全局 meter。

    当 OTEL_ENABLED != "true" 时返回 NoOp MeterProvider，不抛异常。
    启用时，创建 PrometheusMetricReader + MeterProvider + Resource。

    Args:
        endpoint: Prometheus 导出端点（预留参数，当前由 PrometheusMetricReader
            通过 prometheus_client 默认配置暴露）。默认 None。

    Returns:
        MeterProvider: 已初始化的 MeterProvider；未启用时返回 NoOp MeterProvider。
    """
    global _meter_instance, _meter_provider_instance

    # 重置指标缓存，确保切换状态时重新创建
    _reset_metrics_cache()

    if not _is_otel_enabled():
        # 未启用：返回 NoOp MeterProvider，确保不抛异常
        _meter_provider_instance = metrics.NoOpMeterProvider()
        _meter_instance = metrics.NoOpMeter(__name__)
        logger.info("OTel metrics disabled (OTEL_ENABLED != true), using NoOp")
        return _meter_provider_instance

    # 延迟导入，避免未启用时引入 SDK 依赖
    from opentelemetry.exporter.prometheus import PrometheusMetricReader
    from opentelemetry.sdk.metrics import MeterProvider as SDKMeterProvider
    from opentelemetry.sdk.resources import Resource

    svc_name = os.environ.get("OTEL_SERVICE_NAME", OTEL_SERVICE_NAME)

    # 创建 Resource — 标识服务来源
    resource = Resource.create(
        {
            "service.name": svc_name,
            "service.version": "0.1.0",
            "deployment.environment": os.environ.get("DEPLOYMENT_ENV", "development"),
        }
    )

    # 创建 Prometheus Metric Reader（不启动 HTTP 服务器，由调用方按需启动）
    metric_reader = PrometheusMetricReader()

    # 创建 MeterProvider
    provider = SDKMeterProvider(resource=resource, metric_readers=[metric_reader])
    _meter_provider_instance = provider

    # 设置全局 MeterProvider
    metrics.set_meter_provider(provider)

    _meter_instance = metrics.get_meter(__name__)
    logger.info(
        "OTel metrics initialized",
        extra={"service": svc_name, "endpoint": endpoint or "default"},
    )
    return _meter_provider_instance


def get_meter() -> Meter:
    """获取全局 meter 单例。

    首次调用时自动触发 init_metrics() 初始化。
    后续调用返回同一实例。

    Returns:
        Meter: 全局 meter 实例；未启用时返回 NoOp meter。
    """
    global _meter_instance
    if _meter_instance is None:
        init_metrics()
    return _meter_instance


def _reset_metrics_cache() -> None:
    """重置预定义指标缓存（仅用于状态切换时重新创建指标）。"""
    global _loop_iterations_counter, _tool_calls_counter, _llm_tokens_counter
    global _loop_duration_histogram, _tool_duration_histogram, _active_sessions_gauge
    _loop_iterations_counter = None
    _tool_calls_counter = None
    _llm_tokens_counter = None
    _loop_duration_histogram = None
    _tool_duration_histogram = None
    _active_sessions_gauge = None


def _reset_meter_for_testing() -> None:
    """重置全局 meter 与指标缓存（仅用于测试）。"""
    global _meter_instance, _meter_provider_instance
    _meter_instance = None
    _meter_provider_instance = None
    _reset_metrics_cache()


def loop_iterations_counter() -> metrics.Counter:
    """获取 Loop 迭代次数 Counter 单例。

    指标名: jiabaixing_loop_iterations
    描述: Loop 迭代次数

    Returns:
        metrics.Counter: Counter 实例；OTel 未启用时返回 NoOp Counter。
    """
    global _loop_iterations_counter
    if _loop_iterations_counter is None:
        _loop_iterations_counter = get_meter().create_counter(
            name="jiabaixing_loop_iterations",
            description="Loop 迭代次数",
        )
    return _loop_iterations_counter


def tool_calls_counter() -> metrics.Counter:
    """获取工具调用次数 Counter 单例。

    指标名: jiabaixing_tool_calls
    描述: 工具调用次数

    Returns:
        metrics.Counter: Counter 实例；OTel 未启用时返回 NoOp Counter。
    """
    global _tool_calls_counter
    if _tool_calls_counter is None:
        _tool_calls_counter = get_meter().create_counter(
            name="jiabaixing_tool_calls",
            description="工具调用次数",
        )
    return _tool_calls_counter


def llm_tokens_counter() -> metrics.Counter:
    """获取 LLM Token 消耗 Counter 单例。

    指标名: jiabaixing_llm_tokens
    描述: LLM Token 消耗

    Returns:
        metrics.Counter: Counter 实例；OTel 未启用时返回 NoOp Counter。
    """
    global _llm_tokens_counter
    if _llm_tokens_counter is None:
        _llm_tokens_counter = get_meter().create_counter(
            name="jiabaixing_llm_tokens",
            description="LLM Token 消耗",
        )
    return _llm_tokens_counter


def loop_duration_histogram() -> metrics.Histogram:
    """获取 Loop 执行耗时 Histogram 单例。

    指标名: jiabaixing_loop_duration
    描述: Loop 执行耗时（秒）

    Returns:
        metrics.Histogram: Histogram 实例；OTel 未启用时返回 NoOp Histogram。
    """
    global _loop_duration_histogram
    if _loop_duration_histogram is None:
        _loop_duration_histogram = get_meter().create_histogram(
            name="jiabaixing_loop_duration",
            description="Loop 执行耗时",
        )
    return _loop_duration_histogram


def tool_duration_histogram() -> metrics.Histogram:
    """获取工具执行耗时 Histogram 单例。

    指标名: jiabaixing_tool_duration
    描述: 工具执行耗时（秒）

    Returns:
        metrics.Histogram: Histogram 实例；OTel 未启用时返回 NoOp Histogram。
    """
    global _tool_duration_histogram
    if _tool_duration_histogram is None:
        _tool_duration_histogram = get_meter().create_histogram(
            name="jiabaixing_tool_duration",
            description="工具执行耗时",
        )
    return _tool_duration_histogram


def active_sessions_gauge() -> metrics.ObservableGauge:
    """获取活跃会话数 ObservableGauge 单例。

    指标名: jiabaixing_active_sessions
    描述: 活跃会话数

    通过 set_active_sessions(count) 更新值，由 MetricReader 周期性拉取。

    Returns:
        metrics.ObservableGauge: ObservableGauge 实例；OTel 未启用时返回 NoOp。
    """
    global _active_sessions_gauge
    if _active_sessions_gauge is None:
        _active_sessions_gauge = get_meter().create_observable_gauge(
            name="jiabaixing_active_sessions",
            description="活跃会话数",
            callbacks=[_observe_active_sessions],
        )
    return _active_sessions_gauge
