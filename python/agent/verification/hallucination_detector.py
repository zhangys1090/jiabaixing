"""幻觉检测器 (Hallucination Detector) — A1 幻觉检测升级。

从仅基于正则模式升级为三层检测架构：
  Layer 1: 模式检测（正则） — 快速、低成本、高召回
  Layer 2: 自一致性检查（LLM） — 对关键事实独立采样N次，比较一致性
  Layer 3: 事实核查链 — 追溯输出中的数据到工具调用结果

每段输出附带置信度标签: high / medium / low

Usage:
    detector = HallucinationDetector(llm=provider)
    result = await detector.detect(output, tool_results=results)
    print(result.overall_confidence)
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent.core.logger import StructuredLogger

log = StructuredLogger("hallucination_detector")


class ConfidenceLevel(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class DetectionLayer(str, Enum):
    PATTERN = "pattern"
    SELF_CONSISTENCY = "self_consistency"
    FACT_CHECK = "fact_check"


@dataclass
class HallucinationSignal:
    layer: DetectionLayer
    description: str
    evidence: str
    confidence_impact: float = 0.0
    segment: str = ""


@dataclass
class SegmentConfidence:
    segment: str
    confidence: float = 1.0
    level: ConfidenceLevel = ConfidenceLevel.HIGH
    signals: list[HallucinationSignal] = field(default_factory=list)


@dataclass
class FactTrace:
    claim: str
    source_tool: str = ""
    source_result: str = ""
    verified: bool = False
    mismatch_detail: str = ""


@dataclass
class HallucinationDetectionResult:
    detection_id: str = ""
    overall_confidence: float = 1.0
    overall_level: ConfidenceLevel = ConfidenceLevel.HIGH
    segments: list[SegmentConfidence] = field(default_factory=list)
    signals: list[HallucinationSignal] = field(default_factory=list)
    fact_traces: list[FactTrace] = field(default_factory=list)
    pattern_signals: int = 0
    consistency_score: float = 1.0
    fact_check_pass_rate: float = 1.0
    duration_ms: float = 0.0


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


_FABRICATED_URL_PATTERN = re.compile(r'https?://[^\s<>"\']+', re.IGNORECASE)
_NUMERIC_CLAIM_PATTERN = re.compile(r'(?:是|为|=|equals?\s*)\s*(\d+(?:\.\d+)?)\s*(?:%|个|次|MB|GB|ms|秒|分钟)?')
_FILE_PATH_PATTERN = re.compile(r'(?:^|\s|["\'])(/[a-zA-Z0-9_./-]+(?:\.[a-zA-Z0-9]+)?)(?:\s|["\']|$)')
_EXECUTION_CLAIM_PATTERN = re.compile(r'(?:执行了|ran|executed|运行了|输出结果[:：])', re.IGNORECASE)

_TRUSTED_DOMAINS = frozenset({
    "github.com", "npmjs.com", "pypi.org", "docs.python.org",
    "developer.mozilla.org", "stackoverflow.com", "wikipedia.org",
    "microsoft.com", "openai.com", "anthropic.com", "localhost",
})

_SELF_CONSISTENCY_SAMPLES = 3
_SELF_CONSISTENCY_THRESHOLD = 0.7
_FACT_MATCH_THRESHOLD = 0.6


class HallucinationDetector:
    """三层幻觉检测器。

    Args:
        llm: LLM 提供者实例（Layer 2/3 需要）。
        consistency_samples: 自一致性采样次数。
        consistency_threshold: 一致性低于此阈值视为可疑。
    """

    def __init__(
        self,
        llm: LLMProtocol | None = None,
        consistency_samples: int = _SELF_CONSISTENCY_SAMPLES,
        consistency_threshold: float = _SELF_CONSISTENCY_THRESHOLD,
    ) -> None:
        self._llm = llm
        self._consistency_samples = consistency_samples
        self._consistency_threshold = consistency_threshold

    async def detect(
        self,
        output: str,
        tool_results: list[dict[str, Any]] | None = None,
        context: dict[str, Any] | None = None,
    ) -> HallucinationDetectionResult:
        start = time.time()
        detection_id = f"hd_{uuid.uuid4().hex[:12]}"

        all_signals: list[HallucinationSignal] = []

        pattern_signals = self._detect_patterns(output)
        all_signals.extend(pattern_signals)

        consistency_score = 1.0
        if self._llm:
            consistency_signals, consistency_score = await self._check_self_consistency(output)
            all_signals.extend(consistency_signals)

        fact_traces: list[FactTrace] = []
        fact_check_pass_rate = 1.0
        if tool_results:
            fact_traces, fact_check_pass_rate = self._check_facts(output, tool_results)

        segments = self._compute_segment_confidences(output, all_signals)

        total_impact = sum(s.confidence_impact for s in all_signals)
        overall_confidence = max(0.0, min(1.0, 1.0 - total_impact))

        if overall_confidence >= 0.8:
            overall_level = ConfidenceLevel.HIGH
        elif overall_confidence >= 0.5:
            overall_level = ConfidenceLevel.MEDIUM
        else:
            overall_level = ConfidenceLevel.LOW

        duration_ms = (time.time() - start) * 1000
        result = HallucinationDetectionResult(
            detection_id=detection_id,
            overall_confidence=overall_confidence,
            overall_level=overall_level,
            segments=segments,
            signals=all_signals,
            fact_traces=fact_traces,
            pattern_signals=len(pattern_signals),
            consistency_score=consistency_score,
            fact_check_pass_rate=fact_check_pass_rate,
            duration_ms=duration_ms,
        )

        log.info(
            "幻觉检测完成",
            detection_id=detection_id,
            confidence=round(overall_confidence, 3),
            level=overall_level.value,
            signals=len(all_signals),
            duration_ms=round(duration_ms, 1),
        )
        return result

    def _detect_patterns(self, output: str) -> list[HallucinationSignal]:
        signals: list[HallucinationSignal] = []

        for match in _FABRICATED_URL_PATTERN.finditer(output):
            url = match.group(0)
            domain = url.split("//")[1].split("/")[0].split(":")[0] if "//" in url else ""
            if not any(d in domain for d in _TRUSTED_DOMAINS):
                signals.append(HallucinationSignal(
                    layer=DetectionLayer.PATTERN,
                    description=f"非可信域名URL: {url}",
                    evidence=url,
                    confidence_impact=0.15,
                    segment=url,
                ))

        for match in _FILE_PATH_PATTERN.finditer(output):
            path = match.group(1)
            suspicious_extensions = {".xyz",".abc",".secret",".internal"}
            if any(path.endswith(ext) for ext in suspicious_extensions):
                signals.append(HallucinationSignal(
                    layer=DetectionLayer.PATTERN,
                    description=f"可疑文件路径: {path}",
                    evidence=path,
                    confidence_impact=0.2,
                    segment=path,
                ))

        for match in _EXECUTION_CLAIM_PATTERN.finditer(output):
            start_pos = match.start()
            context_end = min(start_pos + 100, len(output))
            segment = output[start_pos:context_end]
            if "工具" not in segment and "tool" not in segment.lower():
                signals.append(HallucinationSignal(
                    layer=DetectionLayer.PATTERN,
                    description="声称执行但未引用工具调用",
                    evidence=segment[:80],
                    confidence_impact=0.25,
                    segment=segment[:80],
                ))

        return signals

    async def _check_self_consistency(
        self, output: str,
    ) -> tuple[list[HallucinationSignal], float]:
        if not self._llm:
            return [], 1.0

        numeric_claims = _NUMERIC_CLAIM_PATTERN.findall(output)
        if not numeric_claims:
            return [], 1.0

        signals: list[HallucinationSignal] = []
        consistent_count = 0
        total_checks = 0

        for claim_value in numeric_claims[:5]:
            prompt = (
                f"请独立验证以下数值是否合理，不需要重复我的问题：\n"
                f"数值: {claim_value}\n"
                f"上下文: {output[:500]}\n\n"
                f"请直接输出你认为合理的数值（仅输出数字）："
            )

            responses: list[str] = []
            for _ in range(self._consistency_samples):
                try:
                    resp = await self._llm.chat(
                        messages=[{"role": "user", "content": prompt}],
                        temperature=0.7,
                        max_tokens=50,
                    )
                    content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
                    responses.append(content.strip())
                except Exception:
                    pass

            if not responses:
                continue

            numeric_responses: list[float] = []
            for r in responses:
                try:
                    num = float(re.search(r'(\d+(?:\.\d+)?)', r).group(1))
                    numeric_responses.append(num)
                except (ValueError, AttributeError):
                    pass

            if not numeric_responses:
                continue

            total_checks += 1
            avg = sum(numeric_responses) / len(numeric_responses)
            try:
                original = float(claim_value)
                if original == 0:
                    relative_diff = 0.0 if avg == 0 else 1.0
                else:
                    relative_diff = abs(avg - original) / abs(original)

                if relative_diff < 0.2:
                    consistent_count += 1
                else:
                    signals.append(HallucinationSignal(
                        layer=DetectionLayer.SELF_CONSISTENCY,
                        description=f"数值{claim_value}自一致性低(平均{avg:.2f}, 偏差{relative_diff:.1%})",
                        evidence=f"original={claim_value}, avg={avg:.2f}, samples={numeric_responses}",
                        confidence_impact=0.2,
                        segment=claim_value,
                    ))
            except ValueError:
                pass

        consistency_score = consistent_count / total_checks if total_checks > 0 else 1.0
        if consistency_score < self._consistency_threshold:
            signals.append(HallucinationSignal(
                layer=DetectionLayer.SELF_CONSISTENCY,
                description=f"整体自一致性低: {consistency_score:.2f}",
                evidence=f"consistent={consistent_count}/{total_checks}",
                confidence_impact=0.3 * (1.0 - consistency_score),
            ))

        return signals, consistency_score

    def _check_facts(
        self,
        output: str,
        tool_results: list[dict[str, Any]],
    ) -> tuple[list[FactTrace], float]:
        traces: list[FactTrace] = []
        verified_count = 0

        for tr in tool_results:
            tool_name = tr.get("tool", "unknown")
            result_content = str(tr.get("result", ""))

            if not result_content or len(result_content) < 5:
                continue

            key_fragments = self._extract_key_fragments(result_content)
            for fragment in key_fragments:
                if fragment in output:
                    traces.append(FactTrace(
                        claim=fragment[:80],
                        source_tool=tool_name,
                        source_result=result_content[:100],
                        verified=True,
                    ))
                    verified_count += 1
                else:
                    traces.append(FactTrace(
                        claim=fragment[:80],
                        source_tool=tool_name,
                        source_result=result_content[:100],
                        verified=False,
                        mismatch_detail="工具结果未出现在输出中",
                    ))

        output_claims = _NUMERIC_CLAIM_PATTERN.findall(output)
        for claim in output_claims[:10]:
            already_traced = any(t.claim.startswith(claim) and t.verified for t in traces)
            if not already_traced:
                found_in_result = any(claim in str(tr.get("result", "")) for tr in tool_results)
                if found_in_result:
                    traces.append(FactTrace(
                        claim=claim, source_tool="tool_result",
                        verified=True,
                    ))
                    verified_count += 1
                else:
                    traces.append(FactTrace(
                        claim=claim, verified=False,
                        mismatch_detail="数值声明无法追溯到工具结果",
                    ))

        total_meaningful = sum(1 for t in traces if t.verified or t.mismatch_detail)
        pass_rate = verified_count / total_meaningful if total_meaningful > 0 else 1.0

        return traces, pass_rate

    def _extract_key_fragments(self, text: str, max_fragments: int = 5) -> list[str]:
        fragments: list[str] = []
        for match in _NUMERIC_CLAIM_PATTERN.finditer(text):
            fragments.append(match.group(0))
            if len(fragments) >= max_fragments:
                break

        words = text.split()
        for w in words:
            if len(w) >= 8 and w not in fragments:
                fragments.append(w)
                if len(fragments) >= max_fragments * 2:
                    break

        return fragments[:max_fragments * 2]

    def _compute_segment_confidences(
        self,
        output: str,
        signals: list[HallucinationSignal],
    ) -> list[SegmentConfidence]:
        lines = output.split("\n")
        segments: list[SegmentConfidence] = []

        for line in lines:
            if not line.strip():
                continue

            confidence = 1.0
            line_signals: list[HallucinationSignal] = []

            for signal in signals:
                if signal.segment and signal.segment in line:
                    confidence -= signal.confidence_impact
                    line_signals.append(signal)

            confidence = max(0.0, min(1.0, confidence))

            if confidence >= 0.8:
                level = ConfidenceLevel.HIGH
            elif confidence >= 0.5:
                level = ConfidenceLevel.MEDIUM
            else:
                level = ConfidenceLevel.LOW

            segments.append(SegmentConfidence(
                segment=line[:100],
                confidence=confidence,
                level=level,
                signals=line_signals,
            ))

        return segments
