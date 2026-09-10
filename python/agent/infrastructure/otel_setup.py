"""OpenTelemetry 集成模块 — 为 Python 后端提供分布式追踪和指标采集。

支持 OTLP gRPC 导出器 + Prometheus 指标端点，与 TS 侧 OTel 共享 traceId。
所有操作均具备优雅降级：OTel 不可用时记录日志、返回 NoOp 对象，
不抛出异常，确保调用方逻辑不被中断。

环境变量:
    OTEL_ENABLED: 是否启用 OTel（默认 false）
    OTEL_SERVICE_NAME: 服务名称（默认 jiabaixing-python）
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP gRPC 端点（默认 http://localhost:4317）
    OTEL_PROMETHEUS_PORT: Prometheus 指标端口（默认 9464）
"""

from __future__ import annotations

import os
import logging
from typing import Any, Optional

from agent.core.logger import StructuredLogger
log = StructuredLogger("otel_setup")


_otel_initialized: bool = False
_tracer: Any = None
_meter: Any = None


def is_otel_enabled() -> bool:
    """判断 OTel 是否启用。

    Returns:
        bool: 启用返回 True，否则 False。
    """
    return os.environ.get("OTEL_ENABLED", "false").lower() == "true"


def setup_otel() -> bool:
    """初始化 OpenTelemetry SDK，配置 TracerProvider 和 MeterProvider。

    启用条件:
        1. OTEL_ENABLED=true
        2. opentelemetry-sdk 已安装

    Returns:
        bool: 初始化成功返回 True，否则 False。
    """
    global _otel_initialized, _tracer, _meter

    if _otel_initialized:
        return True

    if not is_otel_enabled():
        log.debug("OTel disabled (set OTEL_ENABLED=true to enable)")
        return False

    try:
        from opentelemetry import trace, metrics
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.resources import Resource

        service_name = os.environ.get("OTEL_SERVICE_NAME", "jiabaixing-python")
        resource = Resource.create({
            "service.name": service_name,
            "service.version": "5.0.0",
            "deployment.environment": os.environ.get("NODE_ENV", "development"),
        })

        # TracerProvider
        tracer_provider = TracerProvider(resource=resource)

        try:
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
            otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
            otlp_exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)
            tracer_provider.add_span_processor(BatchSpanProcessor(otlp_exporter))
            log.info("OTLP trace exporter configured", endpoint=otlp_endpoint)
        except Exception as exc:
            log.warning("OTLP trace exporter setup failed, using default", error=str(exc))

        trace.set_tracer_provider(tracer_provider)
        _tracer = trace.get_tracer(service_name, "5.0.0")

        # MeterProvider
        meter_provider = MeterProvider(resource=resource)

        try:
            from opentelemetry.exporter.prometheus import PrometheusMetricReader
            prom_port = int(os.environ.get("OTEL_PROMETHEUS_PORT", "9464"))
            prom_reader = PrometheusMetricReader(port=prom_port)
            meter_provider = MeterProvider(resource=resource, metric_readers=[prom_reader])
            log.info("Prometheus metric reader configured", port=prom_port)
        except Exception as exc:
            log.warning("Prometheus metric reader setup failed, using default", error=str(exc))

        metrics.set_meter_provider(meter_provider)
        _meter = metrics.get_meter(service_name, "5.0.0")

        _otel_initialized = True
        log.debug("OpenTelemetry initialized", service=service_name)
        return True

    except ImportError as exc:
        log.warning("OpenTelemetry SDK not installed, tracing disabled", error=str(exc))
        return False
    except Exception as exc:
        log.warning("OpenTelemetry setup failed", error=str(exc))
        return False


def get_tracer() -> Any:
    """获取全局 Tracer 实例。

    Returns:
        Tracer 实例；未初始化时返回 NoOp tracer。
    """
    global _tracer
    if _tracer is not None:
        return _tracer

    if is_otel_enabled():
        setup_otel()
        if _tracer is not None:
            return _tracer

    try:
        from opentelemetry import trace
        return trace.get_tracer(__name__)
    except ImportError:
        return _NoOpTracer()


def get_meter() -> Any:
    """获取全局 Meter 实例。

    Returns:
        Meter 实例；未初始化时返回 NoOp meter。
    """
    global _meter
    if _meter is not None:
        return _meter

    if is_otel_enabled():
        setup_otel()
        if _meter is not None:
            return _meter

    try:
        from opentelemetry import metrics
        return metrics.get_meter(__name__)
    except ImportError:
        return _NoOpMeter()


class _NoOpTracer:
    """OTel 不可用时的 NoOp Tracer。"""

    def start_span(self, name: str, **kwargs: Any) -> _NoOpSpan:
        return _NoOpSpan()

    def start_as_current_span(self, name: str, **kwargs: Any) -> _NoOpSpan:
        return _NoOpSpan()


class _NoOpSpan:
    """OTel 不可用时的 NoOp Span。"""

    def __enter__(self) -> _NoOpSpan:
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    def set_attribute(self, key: str, value: Any) -> None:
        pass

    def add_event(self, name: str, attributes: dict | None = None) -> None:
        pass

    def record_exception(self, exception: Exception, **kwargs: Any) -> None:
        pass

    def is_recording(self) -> bool:
        return False

    @property
    def context(self) -> None:
        return None


class _NoOpMeter:
    """OTel 不可用时的 NoOp Meter。"""

    def create_counter(self, name: str, **kwargs: Any) -> _NoOpCounter:
        return _NoOpCounter()

    def create_histogram(self, name: str, **kwargs: Any) -> _NoOpHistogram:
        return _NoOpHistogram()

    def create_up_down_counter(self, name: str, **kwargs: Any) -> _NoOpUpDownCounter:
        return _NoOpUpDownCounter()

    def create_observable_counter(self, name: str, **kwargs: Any) -> _NoOpCounter:
        return _NoOpCounter()

    def create_observable_gauge(self, name: str, **kwargs: Any) -> _NoOpCounter:
        return _NoOpCounter()


class _NoOpCounter:
    def add(self, amount: int | float, attributes: dict | None = None) -> None:
        pass


class _NoOpHistogram:
    def record(self, amount: int | float, attributes: dict | None = None) -> None:
        pass


class _NoOpUpDownCounter:
    def add(self, amount: int | float, attributes: dict | None = None) -> None:
        pass


def traced(name: str | None = None):
    """装饰器：为函数自动创建 OTel Span。

    Args:
        name: Span 名称，默认使用函数名。

    Usage:
        @traced("llm_call")
        async def call_llm(prompt: str) -> str:
            ...
    """
    def decorator(func):
        import functools

        span_name = name or func.__name__

        @functools.wraps(func)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            tracer = get_tracer()
            with tracer.start_span(span_name) as span:
                span.set_attribute("function.name", func.__name__)
                span.set_attribute("function.module", func.__module__ or "")
                try:
                    result = await func(*args, **kwargs)
                    span.set_attribute("function.result", "ok")
                    return result
                except Exception as exc:
                    log.debug("otel_setup 异常处理", error=str(exc))
                    span.set_attribute("function.result", "error")
                    span.set_attribute("error.type", type(exc).__name__)
                    span.record_exception(exc)
                    raise

        @functools.wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            tracer = get_tracer()
            with tracer.start_span(span_name) as span:
                span.set_attribute("function.name", func.__name__)
                span.set_attribute("function.module", func.__module__ or "")
                try:
                    result = func(*args, **kwargs)
                    span.set_attribute("function.result", "ok")
                    return result
                except Exception as exc:
                    log.debug("otel_setup 异常处理", error=str(exc))
                    span.set_attribute("function.result", "error")
                    span.set_attribute("error.type", type(exc).__name__)
                    span.record_exception(exc)
                    raise

        import asyncio
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper

    return decorator
