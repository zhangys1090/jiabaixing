from __future__ import annotations

import tempfile
import os
import time

import pytest

from agent.evolution.llm_capability_detector import (
    LLMCapabilities,
    LLMCapabilityDetector,
    CapabilityDiff,
)


class MockLLM:
    def __init__(self, response_text: str = "") -> None:
        self._response = response_text
        self._call_count = 0
        self._last_messages: list[dict] = []

    async def chat(self, messages: list[dict[str, str]], **kwargs: object) -> dict[str, str]:
        self._call_count += 1
        self._last_messages = messages
        return {"content": self._response}

    @property
    def call_count(self) -> int:
        return self._call_count


class TestLLMCapabilities:
    def test_default_values(self):
        caps = LLMCapabilities()
        assert caps.provider == ""
        assert caps.context_window == 4096
        assert caps.reasoning_depth == 3
        assert caps.tool_calling_accuracy == 0.5
        assert caps.code_generation == 3
        assert caps.multi_modal is False
        assert caps.structured_output == 0.5

    def test_to_dict_and_from_dict_roundtrip(self):
        caps = LLMCapabilities(
            provider="openai",
            model_name="gpt-4",
            detected_at=1234567890.0,
            context_window=8192,
            reasoning_depth=7,
            tool_calling_accuracy=0.85,
            code_generation=8,
            multi_modal=True,
            structured_output=0.9,
            overall_score=7.5,
        )
        data = caps.to_dict()
        assert data["provider"] == "openai"
        assert data["context_window"] == 8192

        restored = LLMCapabilities.from_dict(data)
        assert restored.provider == caps.provider
        assert restored.reasoning_depth == caps.reasoning_depth
        assert restored.tool_calling_accuracy == caps.tool_calling_accuracy
        assert restored.multi_modal == caps.multi_modal
        assert restored.overall_score == caps.overall_score

    def test_from_dict_missing_fields(self):
        caps = LLMCapabilities.from_dict({})
        assert caps.provider == ""
        assert caps.context_window == 4096
        assert caps.reasoning_depth == 3

    def test_from_dict_partial(self):
        caps = LLMCapabilities.from_dict({"provider": "anthropic", "reasoning_depth": 8})
        assert caps.provider == "anthropic"
        assert caps.reasoning_depth == 8
        assert caps.context_window == 4096


class TestLLMCapabilityDetector:
    def test_creation_without_data_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            detector = LLMCapabilityDetector(data_dir=tmpdir)
            assert detector._cached_capabilities == {}

    def test_set_llm(self):
        detector = LLMCapabilityDetector()
        llm = MockLLM()
        detector.set_llm(llm)
        assert detector._llm is llm

    def test_get_cached_when_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            detector = LLMCapabilityDetector(data_dir=tmpdir)
            assert detector.get_cached("openai") is None

    def test_set_callbacks(self):
        detector = LLMCapabilityDetector()
        cb = {"on_capabilities_detected": lambda caps: None}
        detector.set_callbacks(cb)
        assert detector._callbacks is cb

    async def test_detect_without_llm_returns_none(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            detector = LLMCapabilityDetector(data_dir=tmpdir)
            result = await detector.detect("openai")
            assert result is None

    async def test_detect_high_reasoning_model(self):
        detector = LLMCapabilityDetector()
        llm = MockLLM(
            "A > B, B > C, C > D, E = B, F < C。\n"
            "推理过程：A > B = E > C > F，因此 A 大于 F。\n"
            "但也有可能 A 不一定大于 F 因为..."
        )
        detector.set_llm(llm)
        caps = await detector.detect("openai", force=True)
        assert caps is not None
        assert caps.reasoning_depth >= 5
        assert caps.provider == "openai"

    async def test_detect_caches_result(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            detector = LLMCapabilityDetector(data_dir=tmpdir)
            llm = MockLLM("A > B > C > D, so A > F")
            detector.set_llm(llm)
            caps1 = await detector.detect("openai", force=True)
            caps2 = await detector.detect("openai")
            assert caps1 is not None
            assert caps2 is not None
            assert caps2.provider == caps1.provider

    async def test_detect_tool_calling_capability(self):
        detector = LLMCapabilityDetector()
        llm = MockLLM(
            '{"tool": "search_weather", "action": "query", "function": "get_weather"}'
        )
        detector.set_llm(llm)
        caps = await detector.detect("openai", force=True)
        assert caps is not None
        assert caps.tool_calling_accuracy >= 0.5

    async def test_detect_code_generation_capability(self):
        detector = LLMCapabilityDetector()
        llm = MockLLM(
            "def is_prime(n: int) -> bool:\n"
            "    for i in range(2, int(n**0.5)+1):\n"
            "        if n % i == 0:\n"
            "            return False\n"
            "    return n > 1\n"
        )
        detector.set_llm(llm)
        caps = await detector.detect("openai", force=True)
        assert caps is not None
        assert caps.code_generation >= 5

    async def test_detect_structured_output_capability(self):
        detector = LLMCapabilityDetector()
        llm = MockLLM(
            '{"sentiment": "positive", "topic": "weather", "keywords": ["sunny", "walk"]}'
        )
        detector.set_llm(llm)
        caps = await detector.detect("openai", force=True)
        assert caps is not None
        assert caps.structured_output >= 0.5

    async def test_force_detection_bypasses_cache(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            detector = LLMCapabilityDetector(data_dir=tmpdir)
            llm = MockLLM("A > B > C > D")
            detector.set_llm(llm)
            await detector.detect("openai", force=True)
            caps = await detector.detect("openai", force=True)
            assert caps is not None

    async def test_detect_computes_overall_score(self):
        detector = LLMCapabilityDetector()
        llm = MockLLM(
            "A > B > C... result: 大于\n"
            '{"tool": "search"}\n'
            "def is_prime...\n"
            '{"sentiment": "positive"}'
        )
        detector.set_llm(llm)
        caps = await detector.detect("openai", force=True)
        assert caps is not None
        assert caps.overall_score > 0

    async def test_get_all_cached(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            detector = LLMCapabilityDetector(data_dir=tmpdir)
            llm = MockLLM("A > B > C")
            detector.set_llm(llm)
            await detector.detect("openai", force=True)
            all_caps = detector.get_all_cached()
            assert len(all_caps) >= 1

    async def test_detect_error_handling(self):
        class FailingLLM:
            async def chat(self, messages: list[dict[str, str]], **kwargs: object) -> dict[str, str]:
                raise RuntimeError("LLM unavailable")

        with tempfile.TemporaryDirectory() as tmpdir:
            detector = LLMCapabilityDetector(data_dir=tmpdir)
            detector.set_llm(FailingLLM())
            result = await detector.detect("openai", force=True)
            assert result is not None
            assert result.reasoning_depth == 3  # default fallback


class TestCapabilityDiff:
    def test_no_changes(self):
        old = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.7, code_generation=5, structured_output=0.7)
        new = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.7, code_generation=5, structured_output=0.7)
        detector = LLMCapabilityDetector()
        diff = detector.diff(old, new)
        assert diff.summary == "无显著变化"
        assert diff.changed == []

    def test_reasoning_improved(self):
        old = LLMCapabilities(reasoning_depth=3, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        new = LLMCapabilities(reasoning_depth=7, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        detector = LLMCapabilityDetector()
        diff = detector.diff(old, new)
        assert "推理能力提升" in diff.summary

    def test_reasoning_declined(self):
        old = LLMCapabilities(reasoning_depth=7, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        new = LLMCapabilities(reasoning_depth=3, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        detector = LLMCapabilityDetector()
        diff = detector.diff(old, new)
        assert "推理能力下降" in diff.summary

    def test_tool_calling_improved(self):
        old = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.4, code_generation=3, structured_output=0.5)
        new = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.8, code_generation=3, structured_output=0.5)
        detector = LLMCapabilityDetector()
        diff = detector.diff(old, new)
        assert "工具调用准确率提升" in diff.summary

    def test_code_generation_improved(self):
        old = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.5)
        new = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.5, code_generation=8, structured_output=0.5)
        detector = LLMCapabilityDetector()
        diff = detector.diff(old, new)
        assert "代码生成能力提升" in diff.summary

    def test_structured_output_improved(self):
        old = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.4)
        new = LLMCapabilities(reasoning_depth=5, tool_calling_accuracy=0.5, code_generation=3, structured_output=0.9)
        detector = LLMCapabilityDetector()
        diff = detector.diff(old, new)
        assert "结构化输出能力提升" in diff.summary


class TestCapabilityDrift:
    """W4：能力漂移监控测试。"""

    def _seeded_detector(self, old_caps: LLMCapabilities) -> LLMCapabilityDetector:
        detector = LLMCapabilityDetector(data_dir=tempfile.mkdtemp())
        detector.set_llm(MockLLM())
        old_caps.detected_at = time.time()  # 避免触发 TTL 过期导致 get_cached 返回 None
        detector._cached_capabilities["p"] = old_caps
        return detector

    def _patch_probes(self, detector: LLMCapabilityDetector, reasoning: float) -> None:
        from unittest.mock import AsyncMock

        detector._probe_reasoning = AsyncMock(return_value=reasoning)
        detector._probe_tool_calling = AsyncMock(return_value=0.8)
        detector._probe_code_generation = AsyncMock(return_value=5)
        detector._probe_structured_output = AsyncMock(return_value=0.6)
        detector._probe_vision = AsyncMock(return_value=0.0)
        detector._detect_model_family = lambda provider: "unknown"
        detector._compute_overall_score = lambda *a, **k: 5.0

    async def test_check_drift_no_baseline_returns_none(self):
        detector = LLMCapabilityDetector(data_dir=tempfile.mkdtemp())
        detector.set_llm(MockLLM())
        assert await detector.check_drift("p") is None

    async def test_check_drift_detects_change(self):
        old = LLMCapabilities(
            provider="p", model_name="p", reasoning_depth=5,
            tool_calling_accuracy=0.8, code_generation=5,
            structured_output=0.6, context_window=4096, multi_modal=False,
        )
        detector = self._seeded_detector(old)
        self._patch_probes(detector, reasoning=9)
        diff = await detector.check_drift("p")
        assert diff is not None
        assert diff.added or diff.removed or diff.changed
        assert any(c.get("field") == "reasoning_depth" for c in diff.changed)

    async def test_check_drift_no_change(self):
        old = LLMCapabilities(
            provider="p", model_name="p", reasoning_depth=5,
            tool_calling_accuracy=0.8, code_generation=5,
            structured_output=0.6, context_window=4096, multi_modal=False,
        )
        detector = self._seeded_detector(old)
        self._patch_probes(detector, reasoning=5)
        diff = await detector.check_drift("p")
        assert diff is not None
        assert not (diff.added or diff.removed or diff.changed)
