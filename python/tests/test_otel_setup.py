"""OpenTelemetry 集成模块测试"""

import os
import pytest
from unittest.mock import patch, MagicMock


class TestOtelSetup:
    def test_is_otel_enabled_default_false(self):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("OTEL_ENABLED", None)
            from agent.infrastructure.otel_setup import is_otel_enabled
            assert is_otel_enabled() is False

    def test_is_otel_enabled_true(self):
        with patch.dict(os.environ, {"OTEL_ENABLED": "true"}):
            from agent.infrastructure.otel_setup import is_otel_enabled
            assert is_otel_enabled() is True

    def test_is_otel_enabled_false(self):
        with patch.dict(os.environ, {"OTEL_ENABLED": "false"}):
            from agent.infrastructure.otel_setup import is_otel_enabled
            assert is_otel_enabled() is False

    def test_setup_otel_disabled(self):
        with patch.dict(os.environ, {"OTEL_ENABLED": "false"}):
            import importlib
            import agent.infrastructure.otel_setup as mod
            importlib.reload(mod)
            result = mod.setup_otel()
            assert result is False

    def test_get_tracer_returns_noop_when_disabled(self):
        with patch.dict(os.environ, {"OTEL_ENABLED": "false"}):
            import importlib
            import agent.infrastructure.otel_setup as mod
            importlib.reload(mod)
            tracer = mod.get_tracer()
            assert tracer is not None
            span = tracer.start_span("test")
            assert span is not None

    def test_get_meter_returns_noop_when_disabled(self):
        with patch.dict(os.environ, {"OTEL_ENABLED": "false"}):
            import importlib
            import agent.infrastructure.otel_setup as mod
            importlib.reload(mod)
            meter = mod.get_meter()
            assert meter is not None
            counter = meter.create_counter("test")
            assert counter is not None

    def test_noop_span_context_manager(self):
        from agent.infrastructure.otel_setup import _NoOpSpan
        span = _NoOpSpan()
        with span as s:
            s.set_attribute("key", "value")
            s.add_event("event")
            assert s.is_recording() is False
            assert s.context is None

    def test_noop_counter_add(self):
        from agent.infrastructure.otel_setup import _NoOpCounter
        counter = _NoOpCounter()
        counter.add(1, {"attr": "value"})

    def test_noop_histogram_record(self):
        from agent.infrastructure.otel_setup import _NoOpHistogram
        hist = _NoOpHistogram()
        hist.record(1.5, {"attr": "value"})

    def test_traced_decorator_async(self):
        from agent.infrastructure.otel_setup import traced

        @traced("test_op")
        async def my_async_func():
            return "result"

        import asyncio
        result = asyncio.run(my_async_func())
        assert result == "result"

    def test_traced_decorator_sync(self):
        from agent.infrastructure.otel_setup import traced

        @traced("test_op")
        def my_sync_func():
            return "result"

        result = my_sync_func()
        assert result == "result"

    def test_traced_decorator_error(self):
        from agent.infrastructure.otel_setup import traced

        @traced("test_op")
        async def failing_func():
            raise ValueError("test error")

        import asyncio
        with pytest.raises(ValueError, match="test error"):
            asyncio.run(failing_func())

    def test_traced_decorator_default_name(self):
        from agent.infrastructure.otel_setup import traced

        @traced()
        async def my_named_func():
            return "ok"

        import asyncio
        result = asyncio.run(my_named_func())
        assert result == "ok"
