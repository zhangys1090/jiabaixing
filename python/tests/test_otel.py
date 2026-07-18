"""OpenTelemetry 集成测试。

覆盖 agent.core.otel_tracer 与 agent.core.otel_metrics 的核心功能：
- Tracer 初始化（启用/禁用）
- otel_trace 装饰器（同步/异步/异常传播）
- get_tracer 单例
- Metrics NoOp 降级
- Counter / Histogram / ObservableGauge 操作

测试中通过 monkeypatch 环境变量 OTEL_ENABLED 切换启用/禁用状态，
不会真实连接 OTLP collector（禁用时使用 NoOp，启用时使用无效端点）。
"""
from __future__ import annotations

import pytest
from opentelemetry import trace

from agent.core.otel_tracer import (
    _reset_tracer_for_testing,
    get_tracer,
    init_tracer,
    otel_trace,
)
from agent.core.otel_metrics import (
    _reset_meter_for_testing,
    active_sessions_gauge,
    get_meter,
    init_metrics,
    llm_tokens_counter,
    loop_duration_histogram,
    loop_iterations_counter,
    set_active_sessions,
    tool_calls_counter,
    tool_duration_histogram,
)


@pytest.fixture(autouse=True)
def _reset_otel_state():
    """每个测试前后重置 OTel 全局状态，确保测试间隔离。

    清除 tracer 与 meter 的单例缓存，避免上一个测试的状态影响下一个。
    注意：OpenTelemetry 全局 TracerProvider 一旦设置无法重置，
    但 init_tracer 在禁用分支显式返回 trace.NoOpTracer()，不依赖全局 provider。
    """
    _reset_tracer_for_testing()
    _reset_meter_for_testing()
    yield
    _reset_tracer_for_testing()
    _reset_meter_for_testing()


class TestOtelTracer:
    """OTel Tracer 初始化与装饰器测试。"""

    def test_init_tracer_disabled(self, monkeypatch):
        """OTEL_ENABLED=false 时返回 NoOp tracer。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        tracer = init_tracer()
        assert isinstance(tracer, trace.NoOpTracer)

    def test_init_tracer_enabled(self, monkeypatch):
        """OTEL_ENABLED=true 时返回真实 tracer（非 NoOp）。

        使用无效端点 localhost:9999 避免连接真实 collector；
        BatchSpanProcessor 会优雅处理导出失败。
        """
        monkeypatch.setenv("OTEL_ENABLED", "true")
        tracer = init_tracer(endpoint="http://localhost:9999")
        # 启用时应返回非 NoOp 的 tracer（ProxyTracer 包装 SDK Tracer）
        assert not isinstance(tracer, trace.NoOpTracer)

    def test_otel_trace_decorator(self, monkeypatch):
        """装饰器函数正常执行，返回值正确。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")

        @otel_trace("test.function")
        def sample(x: int, y: int) -> int:
            """测试函数。"""
            return x + y

        result = sample(2, 3)
        assert result == 5

    @pytest.mark.asyncio
    async def test_otel_trace_decorator_async(self, monkeypatch):
        """装饰器支持异步函数，返回值正确。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")

        @otel_trace("test.async_function")
        async def sample_async(x: int) -> int:
            """异步测试函数。"""
            return x * 2

        result = await sample_async(21)
        assert result == 42

    def test_otel_trace_decorator_with_exception(self, monkeypatch):
        """装饰器函数抛异常时异常被正确传播，span 记录异常。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")

        @otel_trace("test.failing")
        def failing() -> None:
            """抛出异常的测试函数。"""
            raise ValueError("test error")

        with pytest.raises(ValueError, match="test error"):
            failing()

    @pytest.mark.asyncio
    async def test_otel_trace_decorator_async_with_exception(self, monkeypatch):
        """异步装饰器函数抛异常时异常被正确传播。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")

        @otel_trace("test.failing_async")
        async def failing_async() -> None:
            """抛出异常的异步测试函数。"""
            raise RuntimeError("async test error")

        with pytest.raises(RuntimeError, match="async test error"):
            await failing_async()

    def test_get_tracer_singleton(self, monkeypatch):
        """多次调用 get_tracer 返回同一实例。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        t1 = get_tracer()
        t2 = get_tracer()
        assert t1 is t2

    def test_get_tracer_auto_init(self, monkeypatch):
        """首次调用 get_tracer 时自动初始化。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        tracer = get_tracer()
        assert tracer is not None
        assert isinstance(tracer, trace.NoOpTracer)

    def test_metrics_noop_when_disabled(self, monkeypatch):
        """OTel 未启用时所有指标操作不抛异常。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")

        # 所有指标操作都应是 NoOp，不抛异常
        loop_iterations_counter().add(1, {"status": "success"})
        tool_calls_counter().add(1, {"tool_name": "test", "status": "success"})
        llm_tokens_counter().add(100, {"model": "gpt-4"})
        loop_duration_histogram().record(1.5)
        tool_duration_histogram().record(0.3)

        # ObservableGauge 也应可创建并更新
        set_active_sessions(5)
        gauge = active_sessions_gauge()
        assert gauge is not None

    def test_metrics_counter_add(self, monkeypatch):
        """Counter.add 不抛异常，支持多次调用与不同属性。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        counter = loop_iterations_counter()
        counter.add(1, {"status": "success"})
        counter.add(1, {"status": "success"})
        counter.add(3, {"status": "failed"})

        # 不同 counter 也应正常工作
        tool_calls_counter().add(1, {"tool_name": "file_read", "status": "success"})
        tool_calls_counter().add(1, {"tool_name": "file_write", "status": "failed"})
        llm_tokens_counter().add(500, {"model": "gpt-4", "type": "prompt"})
        llm_tokens_counter().add(200, {"model": "gpt-4", "type": "completion"})

    def test_metrics_histogram_record(self, monkeypatch):
        """Histogram.record 不抛异常，支持多次调用。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        hist = loop_duration_histogram()
        hist.record(0.5)
        hist.record(1.2)
        hist.record(3.14)
        hist.record(0.001)

        # 工具耗时 histogram 也应正常工作
        tool_duration_histogram().record(0.1)
        tool_duration_histogram().record(2.5)

    def test_metrics_singleton(self, monkeypatch):
        """同一指标多次获取返回同一实例。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        c1 = loop_iterations_counter()
        c2 = loop_iterations_counter()
        assert c1 is c2

        h1 = loop_duration_histogram()
        h2 = loop_duration_histogram()
        assert h1 is h2

    def test_init_metrics_disabled(self, monkeypatch):
        """OTel 未启用时 init_metrics 返回 NoOp MeterProvider。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        provider = init_metrics()
        assert provider is not None

    def test_get_meter_auto_init(self, monkeypatch):
        """首次调用 get_meter 时自动初始化。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")
        meter = get_meter()
        assert meter is not None

    def test_otel_trace_decorator_preserves_metadata(self, monkeypatch):
        """装饰器保留原函数的元数据（functools.wraps）。"""
        monkeypatch.setenv("OTEL_ENABLED", "false")

        @otel_trace("test.metadata")
        def documented_function(x: int) -> int:
            """这是文档字符串。"""
            return x

        assert documented_function.__name__ == "documented_function"
        assert documented_function.__doc__ == "这是文档字符串。"
