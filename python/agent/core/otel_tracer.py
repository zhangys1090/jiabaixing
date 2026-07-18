"""OpenTelemetry Tracer 初始化与装饰器。

为家百星 Python Agent 提供 Tracer 初始化、全局获取与方法级 span 装饰器。
当 OTEL_ENABLED != "true" 时，所有操作优雅降级为 NoOp，不抛异常。

环境变量:
    OTEL_ENABLED: 是否启用 OTel（"true" 启用，其他禁用）。
    OTEL_SERVICE_NAME: 服务名（默认 jiabaixing-agent-python）。
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP gRPC 端点（默认 http://localhost:4317）。

Usage:
    from agent.core.otel_tracer import otel_trace, get_tracer

    @otel_trace("loop.execute")
    async def execute(self, ...):
        ...

    tracer = get_tracer()
    with tracer.start_as_current_span("custom") as span:
        ...
"""
from __future__ import annotations

import functools
import inspect
import logging
import os
from typing import Any, Callable, Optional, TypeVar

from opentelemetry import trace

logger = logging.getLogger(__name__)

# 模块常量
OTEL_ENABLED_DEFAULT: bool = False
"""默认未启用 OTel，需通过环境变量 OTEL_ENABLED=true 显式开启。"""

OTEL_SERVICE_NAME: str = "jiabaixing-agent-python"
"""默认服务名，可通过环境变量 OTEL_SERVICE_NAME 覆盖。"""

OTEL_EXPORTER_OTLP_ENDPOINT: str = "http://localhost:4317"
"""默认 OTLP gRPC 端点，可通过环境变量 OTEL_EXPORTER_OTLP_ENDPOINT 覆盖。"""

# 全局 tracer 实例（单例）
_tracer_instance: Optional[trace.Tracer] = None

F = TypeVar("F", bound=Callable[..., Any])


def _is_otel_enabled() -> bool:
    """检查 OTel 是否启用。

    Returns:
        bool: 当环境变量 OTEL_ENABLED 为 "true"（不区分大小写）时返回 True。
    """
    return os.environ.get("OTEL_ENABLED", str(OTEL_ENABLED_DEFAULT)).lower() == "true"


def init_tracer(service_name: str | None = None, endpoint: str | None = None) -> trace.Tracer:
    """初始化 Tracer 并设置全局 TracerProvider。

    当 OTEL_ENABLED != "true" 时返回 NoOp tracer，不抛异常。
    启用时，创建 TracerProvider + OTLP gRPC Exporter + BatchSpanProcessor，
    并附带 Resource（service.name / service.version / deployment.environment）。

    Args:
        service_name: 服务名，默认从 OTEL_SERVICE_NAME 环境变量读取，
            再退回到模块常量 OTEL_SERVICE_NAME。
        endpoint: OTLP gRPC 端点，默认从 OTEL_EXPORTER_OTLP_ENDPOINT 环境变量读取，
            再退回到模块常量 OTEL_EXPORTER_OTLP_ENDPOINT。

    Returns:
        trace.Tracer: 已初始化的 tracer；未启用时返回 NoOp tracer。

    Raises:
        Exception: 仅在 OTel 启用且初始化失败时抛出；未启用时永不抛异常。
    """
    global _tracer_instance

    if not _is_otel_enabled():
        # 未启用：返回 NoOp tracer，确保不抛异常
        _tracer_instance = trace.NoOpTracer()
        logger.info("OTel tracer disabled (OTEL_ENABLED != true), using NoOp")
        return _tracer_instance

    svc_name = service_name or os.environ.get("OTEL_SERVICE_NAME", OTEL_SERVICE_NAME)
    otlp_endpoint = endpoint or os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT", OTEL_EXPORTER_OTLP_ENDPOINT
    )

    # 延迟导入，避免未启用时引入 SDK 依赖
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    # 创建 Resource — 标识服务来源
    resource = Resource.create(
        {
            "service.name": svc_name,
            "service.version": "0.1.0",
            "deployment.environment": os.environ.get("DEPLOYMENT_ENV", "development"),
        }
    )

    # 创建 TracerProvider
    provider = TracerProvider(resource=resource)

    # 创建 OTLP gRPC Exporter 并添加 BatchSpanProcessor
    # insecure=True 允许连接本地无 TLS 的 collector
    exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))

    # 设置全局 TracerProvider
    # 注意：set_tracer_provider 只能调用一次，重复调用会被忽略并记录日志
    trace.set_tracer_provider(provider)

    _tracer_instance = trace.get_tracer(__name__)
    logger.info(
        "OTel tracer initialized",
        extra={"service": svc_name, "endpoint": otlp_endpoint},
    )
    return _tracer_instance


def get_tracer() -> trace.Tracer:
    """获取全局 tracer 单例。

    首次调用时自动触发 init_tracer() 初始化。
    后续调用返回同一实例。

    Returns:
        trace.Tracer: 全局 tracer 实例。
    """
    global _tracer_instance
    if _tracer_instance is None:
        return init_tracer()
    return _tracer_instance


def _reset_tracer_for_testing() -> None:
    """重置全局 tracer 实例（仅用于测试）。

    清除缓存的 tracer 单例，便于测试间隔离。
    注意：OpenTelemetry 全局 TracerProvider 一旦设置无法重置，
    此函数只清除模块级缓存。
    """
    global _tracer_instance
    _tracer_instance = None


def otel_trace(name: str | None = None) -> Callable[[F], F]:
    """方法装饰器：自动创建 span 包裹被装饰函数。

    支持同步函数与异步函数。当 OTel 未启用时，函数仍正常执行（NoOp tracer
    的 start_as_current_span 是无操作上下文管理器）。

    装饰器行为:
        - 创建名为 `name`（或默认 `module.qualname`）的 span
        - 设置 span 属性：function.name、function.args_count
        - 函数抛异常时调用 span.record_exception() 并重新抛出
        - 正常返回时设置 span 状态为 OK

    Args:
        name: span 名称，默认使用 `module.qualname`。

    Returns:
        Callable[[F], F]: 装饰器函数。

    Usage:
        @otel_trace("loop.execute")
        async def execute(self, plan, context):
            ...
    """
    def decorator(func: F) -> F:
        span_name = name or f"{func.__module__}.{func.__qualname__}"

        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                """异步函数包装器：在 span 上下文中执行原函数。"""
                tracer = get_tracer()
                with tracer.start_as_current_span(span_name) as span:
                    span.set_attribute("function.name", func.__name__)
                    span.set_attribute("function.args_count", len(args))
                    try:
                        result = await func(*args, **kwargs)
                        return result
                    except Exception as exc:
                        span.record_exception(exc)
                        raise
            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            """同步函数包装器：在 span 上下文中执行原函数。"""
            tracer = get_tracer()
            with tracer.start_as_current_span(span_name) as span:
                span.set_attribute("function.name", func.__name__)
                span.set_attribute("function.args_count", len(args))
                try:
                    return func(*args, **kwargs)
                except Exception as exc:
                    span.record_exception(exc)
                    raise
        return sync_wrapper  # type: ignore[return-value]

    return decorator
