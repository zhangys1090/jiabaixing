"""P0-3: 幻觉检测器测试。"""

from __future__ import annotations

from agent.verification.hallucination_detector import (
    HallucinationDetector,
    HallucinationDetectionResult,
    ConfidenceLevel,
    DetectionLayer,
)


def test_detect_clean_output():
    import asyncio
    detector = HallucinationDetector()
    result = asyncio.get_event_loop().run_until_complete(
        detector.detect("这是一个正常的回答。")
    )
    assert result.overall_confidence >= 0.8
    assert result.overall_level == ConfidenceLevel.HIGH


def test_detect_suspicious_url():
    import asyncio
    detector = HallucinationDetector()
    result = asyncio.get_event_loop().run_until_complete(
        detector.detect("请访问 https://unknown-secret-api.internal/v2/data 获取信息。")
    )
    assert result.pattern_signals > 0
    assert any(s.layer == DetectionLayer.PATTERN for s in result.signals)


def test_detect_execution_claim_without_tool():
    import asyncio
    detector = HallucinationDetector()
    result = asyncio.get_event_loop().run_until_complete(
        detector.detect("执行了代码并输出结果：42")
    )
    assert result.pattern_signals > 0


def test_fact_check_with_tool_results():
    import asyncio
    detector = HallucinationDetector()
    tool_results = [
        {"tool": "calculator", "result": "42", "success": True},
    ]
    result = asyncio.get_event_loop().run_until_complete(
        detector.detect("计算结果是 42", tool_results=tool_results)
    )
    assert result.fact_check_pass_rate > 0


def test_segment_confidences():
    import asyncio
    detector = HallucinationDetector()
    result = asyncio.get_event_loop().run_until_complete(
        detector.detect("正常内容\n访问 https://fake-url.internal\n更多正常内容")
    )
    assert len(result.segments) >= 2
