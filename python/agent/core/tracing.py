"""OpenTelemetry跨语言追踪管理器。

为家百星Python Agent提供分布式追踪能力，支持：
- 自动生成trace_id/span_id
- 跨语言traceId传递（通过HTTP header/WS message）
- 工具调用耗时追踪
- LLM请求追踪

opentelemetry为可选依赖，缺失时graceful降级为空操作（零性能开销）。

Usage:
    from agent.core.tracing import get_tracing_manager

    mgr = get_tracing_manager()
    span = mgr.start_span("llm.chat", {"model": "gpt-4"})
    # ... do work ...
    mgr.end_span(span)

    headers = mgr.inject_trace_headers()  # => {"traceparent": "00-xxx-yyy-01"}
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


def new_trace_id() -> str:
    """生成新的分布式 trace_id（与 TracingManager 一致：32 位十六进制）。

    用于跨语言 / 跨子 Agent 的链路贯通（W8），与 OTel traceId 长度对齐。
    """
    return uuid.uuid4().hex[:32]

# 尝试导入opentelemetry，缺失时降级
_otel_available: bool = False
try:
    from opentelemetry import context, trace
    from opentelemetry.propagate import inject

    _otel_available = True
except ImportError:
    pass


@dataclass
class SpanContext:
    """追踪span上下文，记录单次追踪的开始信息和属性。

    Attributes:
        trace_id: 分布式追踪ID，跨服务唯一。
        span_id: 当前span唯一ID。
        name: span名称（如 "llm.chat"、"tool.file_read"）。
        start_time: span开始时间（time.time()）。
        attributes: span属性字典（如 model、tool_name 等）。
    """

    trace_id: str
    span_id: str
    name: str
    start_time: float
    attributes: dict[str, Any] = field(default_factory=dict)


class TracingManager:
    """OpenTelemetry追踪管理器，跨Python-TS桥接传递traceId。

    使用opentelemetry-sdk实现分布式追踪。opentelemetry为可选依赖，
    缺失时所有方法返回空/None，不影响系统运行（零性能开销）。

    Attributes:
        _service_name: 服务名称标识。
        _available: OTel SDK是否可用且已启用。

    Usage:
        mgr = TracingManager()
        span = mgr.start_span("llm.chat", {"model": "gpt-4"})
        # ... do work ...
        mgr.end_span(span)
    """

    def __init__(
        self,
        service_name: str = "jiabaixing-python",
        endpoint: str | None = None,
    ) -> None:
        """初始化TracingManager。

        当opentelemetry未安装或OTEL_ENABLED != "true"时，降级为空操作。

        Args:
            service_name: 服务名，默认 jiabaixing-python。
            endpoint: OTLP导出端点，None时从环境变量读取。
        """
        self._service_name = service_name
        self._available = False
        self._endpoint = endpoint

        if not _otel_available:
            return

        try:
            from agent.core.otel_tracer import get_tracer, init_tracer

            if os.environ.get("OTEL_ENABLED", "false").lower() == "true":
                init_tracer(service_name=service_name, endpoint=endpoint)
                self._available = True
        except Exception as exc:
            logger.debug("TracingManager初始化降级: %s", exc)

    def is_available(self) -> bool:
        """OTel是否可用且已启用。

        Returns:
            bool: 可用时返回True，降级模式返回False。
        """
        return self._available

    def start_span(
        self,
        name: str,
        attributes: dict[str, Any] | None = None,
        parent_trace_id: str | None = None,
    ) -> SpanContext:
        """开始一个追踪span。

        Args:
            name: span名称（如 "llm.chat"、"tool.file_read"）。
            attributes: span属性字典，可选。
            parent_trace_id: 父级trace_id（跨语言传递时使用），可选。

        Returns:
            SpanContext: span上下文，降级模式返回含随机ID的上下文。
        """
        now = time.time()
        attrs = dict(attributes) if attributes else {}

        if not self._available:
            return SpanContext(
                trace_id=parent_trace_id or uuid.uuid4().hex[:32],
                span_id=uuid.uuid4().hex[:16],
                name=name,
                start_time=now,
                attributes=attrs,
            )

        try:
            from agent.core.otel_tracer import get_tracer

            tracer = get_tracer()
            span = tracer.start_span(name, attributes=attrs)
            # 将OTel span存入context变量，供end_span/inject使用
            ctx = trace.set_span_in_context(span, context.get_current())
            context.attach(ctx)

            otel_span = trace.get_current_span()
            sc = otel_span.get_span_context()
            return SpanContext(
                trace_id=format(sc.trace_id, "032x"),
                span_id=format(sc.span_id, "016x"),
                name=name,
                start_time=now,
                attributes=attrs,
            )
        except Exception as exc:
            logger.debug("start_span降级: %s", exc)
            return SpanContext(
                trace_id=parent_trace_id or uuid.uuid4().hex[:32],
                span_id=uuid.uuid4().hex[:16],
                name=name,
                start_time=now,
                attributes=attrs,
            )

    def end_span(self, span: SpanContext) -> None:
        """结束一个追踪span。

        降级模式下为空操作。

        Args:
            span: 要结束的SpanContext实例。
        """
        if not self._available:
            return

        try:
            otel_span = trace.get_current_span()
            if otel_span and otel_span.is_recording():
                # 设置耗时属性
                elapsed = time.time() - span.start_time
                otel_span.set_attribute("duration_ms", round(elapsed * 1000, 2))
                otel_span.end()
        except Exception as exc:
            logger.debug("end_span降级: %s", exc)

    def get_current_trace_id(self) -> str | None:
        """获取当前上下文的trace_id。

        Returns:
            str | None: 当前trace_id，无活跃span时返回None。
        """
        if not self._available:
            return None

        try:
            otel_span = trace.get_current_span()
            if otel_span and otel_span.is_recording():
                sc = otel_span.get_span_context()
                return format(sc.trace_id, "032x")
        except Exception as exc:
            logger.debug("get_current_trace_id降级: %s", exc)
        return None

    def inject_trace_headers(self) -> dict[str, str]:
        """注入trace header到HTTP请求，实现跨语言traceId传递。

        返回W3C Trace Context格式的header字典（traceparent等），
        由TS侧PythonAgentBridge通过x-trace-id透传。

        Returns:
            dict[str, str]: 追踪header字典；降级模式返回空字典。
        """
        if not self._available:
            return {}

        try:
            carrier: dict[str, str] = {}
            inject(carrier)
            return carrier
        except Exception as exc:
            logger.debug("inject_trace_headers降级: %s", exc)
            return {}


# ── 全局单例 ──────────────────────────────

_manager_instance: TracingManager | None = None


def get_tracing_manager() -> TracingManager:
    """获取全局TracingManager单例。

    首次调用时自动初始化，后续调用返回同一实例。

    Returns:
        TracingManager: 全局追踪管理器实例。
    """
    global _manager_instance
    if _manager_instance is None:
        _manager_instance = TracingManager()
    return _manager_instance
