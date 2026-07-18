from __future__ import annotations

import asyncio
import time

import pytest

from agent.core.resilience import (
    CircuitState,
    RetryConfig,
    _circuits,
    get_circuit,
    resilient_call,
    with_circuit_breaker,
    with_retry,
)


class TestRetryConfig:
    def test_default_values(self):
        cfg = RetryConfig()
        assert cfg.max_retries == 3
        assert cfg.base_delay == 0.5
        assert cfg.max_delay == 30.0
        assert cfg.exponential_base == 2.0
        assert ConnectionError in cfg.retryable_exceptions
        assert TimeoutError in cfg.retryable_exceptions

    def test_custom_values(self):
        cfg = RetryConfig(max_retries=5, base_delay=1.0, max_delay=60.0)
        assert cfg.max_retries == 5
        assert cfg.base_delay == 1.0
        assert cfg.max_delay == 60.0


class TestCircuitState:
    def test_initial_state_is_closed(self):
        cs = CircuitState(name="test")
        assert cs.state == "closed"
        assert cs.failure_count == 0

    def test_record_success_resets_failure_count(self):
        cs = CircuitState(name="test", failure_count=3)
        cs.record_success()
        assert cs.failure_count == 0

    def test_record_success_half_open_to_closed(self):
        cs = CircuitState(name="test", state="half-open")
        cs.record_success()
        assert cs.state == "closed"

    def test_record_failure_increments_count(self):
        cs = CircuitState(name="test")
        cs.record_failure()
        assert cs.failure_count == 1

    def test_record_failure_opens_circuit_at_threshold(self):
        cs = CircuitState(name="test", failure_threshold=3)
        cs.record_failure()
        cs.record_failure()
        assert cs.state == "closed"
        cs.record_failure()
        assert cs.state == "open"

    def test_allow_request_closed(self):
        cs = CircuitState(name="test", state="closed")
        assert cs.allow_request() is True

    def test_allow_request_open_blocks(self):
        cs = CircuitState(name="test", state="open", last_failure_time=time.monotonic())
        assert cs.allow_request() is False

    def test_allow_request_open_transitions_to_half_open_after_timeout(self):
        cs = CircuitState(
            name="test",
            state="open",
            recovery_timeout=0.01,
            last_failure_time=time.monotonic() - 0.02,
        )
        assert cs.allow_request() is True
        assert cs.state == "half-open"

    def test_allow_request_half_open(self):
        cs = CircuitState(name="test", state="half-open")
        assert cs.allow_request() is True


class TestGetCircuit:
    def setup_method(self):
        _circuits.clear()

    def test_creates_new_circuit(self):
        circuit = get_circuit("test-new")
        assert circuit.name == "test-new"
        assert circuit.state == "closed"

    def test_returns_existing_circuit(self):
        c1 = get_circuit("test-same")
        c2 = get_circuit("test-same")
        assert c1 is c2

    def test_custom_threshold_and_timeout(self):
        circuit = get_circuit("test-custom", failure_threshold=10, recovery_timeout=60.0)
        assert circuit.failure_threshold == 10
        assert circuit.recovery_timeout == 60.0


class TestWithRetry:
    @pytest.mark.asyncio
    async def test_success_on_first_attempt(self):
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            return "ok"

        result = await with_retry(fn, config=RetryConfig(max_retries=3, base_delay=0.01))
        assert result == "ok"
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_retries_on_retryable_error(self):
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ConnectionError("fail")
            return "ok"

        result = await with_retry(fn, config=RetryConfig(max_retries=3, base_delay=0.01))
        assert result == "ok"
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_raises_after_max_retries(self):
        async def fn():
            raise ConnectionError("always fail")

        with pytest.raises(ConnectionError, match="always fail"):
            await with_retry(fn, config=RetryConfig(max_retries=2, base_delay=0.01))

    @pytest.mark.asyncio
    async def test_non_retryable_error_raises_immediately(self):
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            raise ValueError("not retryable")

        with pytest.raises(ValueError, match="not retryable"):
            await with_retry(fn, config=RetryConfig(max_retries=3, base_delay=0.01))
        assert call_count == 1


class TestWithCircuitBreaker:
    def setup_method(self):
        _circuits.clear()

    @pytest.mark.asyncio
    async def test_success_records_success(self):
        async def fn():
            return "ok"

        result = await with_circuit_breaker(fn, "test-cb")
        assert result == "ok"
        circuit = get_circuit("test-cb")
        assert circuit.state == "closed"

    @pytest.mark.asyncio
    async def test_failure_records_failure(self):
        async def fn():
            raise ConnectionError("boom")

        with pytest.raises(ConnectionError):
            await with_circuit_breaker(fn, "test-cb-fail")
        circuit = get_circuit("test-cb-fail")
        assert circuit.failure_count == 1

    @pytest.mark.asyncio
    async def test_open_circuit_returns_fallback(self):
        circuit = get_circuit("test-cb-fallback", failure_threshold=1)
        circuit.record_failure()
        circuit.record_failure()
        assert circuit.state == "open"

        async def fn():
            return "should not reach"

        result = await with_circuit_breaker(fn, "test-cb-fallback", fallback="fallback-value")
        assert result == "fallback-value"

    @pytest.mark.asyncio
    async def test_open_circuit_raises_without_fallback(self):
        circuit = get_circuit("test-cb-nofallback", failure_threshold=1)
        circuit.record_failure()
        circuit.record_failure()
        assert circuit.state == "open"

        async def fn():
            return "should not reach"

        with pytest.raises(ConnectionError, match="is open"):
            await with_circuit_breaker(fn, "test-cb-nofallback")


class TestResilientCall:
    def setup_method(self):
        _circuits.clear()

    @pytest.mark.asyncio
    async def test_retry_only(self):
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise ConnectionError("fail")
            return "ok"

        result = await resilient_call(
            fn,
            operation="test-op",
            retry_config=RetryConfig(max_retries=3, base_delay=0.01),
        )
        assert result == "ok"
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_circuit_breaker_only(self):
        async def fn():
            return "ok"

        result = await resilient_call(
            fn,
            operation="test-op",
            circuit_name="test-rc-cb",
        )
        assert result == "ok"

    @pytest.mark.asyncio
    async def test_retry_and_circuit_breaker_combined(self):
        call_count = 0

        async def fn():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise ConnectionError("fail")
            return "ok"

        result = await resilient_call(
            fn,
            operation="test-combined",
            retry_config=RetryConfig(max_retries=3, base_delay=0.01),
            circuit_name="test-combined-cb",
        )
        assert result == "ok"
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_circuit_open_with_fallback(self):
        circuit = get_circuit("test-rc-open", failure_threshold=1)
        circuit.record_failure()
        circuit.record_failure()
        assert circuit.state == "open"

        async def fn():
            return "should not reach"

        result = await resilient_call(
            fn,
            operation="test-fallback",
            circuit_name="test-rc-open",
            fallback="degraded",
            retry_config=RetryConfig(max_retries=1, base_delay=0.01),
        )
        assert result == "degraded"
