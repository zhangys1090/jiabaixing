"""元认知引擎 (Meta-Cognition Engine) — 让 Agent 感知自己的认知状态。

核心能力:
  - 置信度评估: 评估自己对结果的置信度
  - 知识缺口识别: 对比任务需求 vs 已有知识/工具能力
  - 求助决策: 不确定时主动提问，而非编造答案

这是减少幻觉的关键机制——"知道自己不知道什么"。

Usage:
    engine = MetaCognitionEngine(llm=provider, tool_registry=registry)
    assessment = await engine.assess_confidence(task, result)
    gaps = await engine.identify_knowledge_gaps(task)
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent.core.logger import StructuredLogger

log = StructuredLogger("meta_cognition")


class ConfidenceDimension(str, Enum):
    INFORMATION_SUFFICIENCY = "information_sufficiency"
    DOMAIN_FAMILIARITY = "domain_familiarity"
    CONSISTENCY = "consistency"
    TOOL_RELIABILITY = "tool_reliability"
    EVIDENCE_STRENGTH = "evidence_strength"


class GapType(str, Enum):
    MISSING_INFORMATION = "missing_information"
    UNKNOWN_DOMAIN = "unknown_domain"
    INSUFFICIENT_TOOL = "insufficient_tool"
    AMBIGUOUS_REQUIREMENT = "ambiguous_requirement"
    CONFLICTING_EVIDENCE = "conflicting_evidence"


@dataclass
class DimensionScore:
    dimension: ConfidenceDimension
    score: float = 0.5
    reason: str = ""


@dataclass
class ConfidenceAssessment:
    assessment_id: str = ""
    overall_confidence: float = 0.5
    dimensions: list[DimensionScore] = field(default_factory=list)
    should_seek_help: bool = False
    help_reason: str = ""
    suggested_action: str = ""


@dataclass
class KnowledgeGap:
    gap_type: GapType
    description: str
    severity: float = 0.5
    suggested_action: str = ""
    relevant_tools: list[str] = field(default_factory=list)


@dataclass
class MetaCognitionResult:
    result_id: str = ""
    confidence: ConfidenceAssessment = field(default_factory=ConfidenceAssessment)
    gaps: list[KnowledgeGap] = field(default_factory=list)
    self_awareness_notes: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


_SEEK_HELP_THRESHOLD = 0.4
_GAP_SEVERITY_THRESHOLD = 0.5

_KNOWN_DOMAINS: dict[str, float] = {
    "python": 0.9, "javascript": 0.85, "typescript": 0.85,
    "react": 0.8, "fastapi": 0.8, "flask": 0.75,
    "database": 0.7, "sql": 0.7, "docker": 0.7,
    "git": 0.8, "linux": 0.7, "windows": 0.6,
    "web": 0.75, "api": 0.8, "security": 0.6,
    "math": 0.5, "physics": 0.3, "medicine": 0.1,
    "law": 0.1, "finance": 0.3,
    "quantum": 0.1, "量子": 0.1, "投资": 0.3, "portfolio": 0.3,
}


class MetaCognitionEngine:
    """元认知引擎 — Agent 的自知之明。

    Args:
        llm: LLM 提供者实例。
        tool_registry: 工具注册表（可选，用于工具能力评估）。
        known_domains: 已知领域及其熟悉度 {domain: familiarity_score}。
        seek_help_threshold: 置信度低于此阈值时建议寻求帮助。
    """

    def __init__(
        self,
        llm: LLMProtocol | None = None,
        tool_registry: Any = None,
        known_domains: dict[str, float] | None = None,
        seek_help_threshold: float = _SEEK_HELP_THRESHOLD,
    ) -> None:
        self._llm = llm
        self._tool_registry = tool_registry
        self._known_domains = known_domains or dict(_KNOWN_DOMAINS)
        self._seek_help_threshold = seek_help_threshold
        self._assessment_history: list[ConfidenceAssessment] = []
        self._max_history = 50

    async def assess_confidence(
        self,
        task: str,
        result: str = "",
        tool_calls: list[dict[str, Any]] | None = None,
        context: dict[str, Any] | None = None,
    ) -> ConfidenceAssessment:
        start = time.time()
        assessment_id = f"mc_{uuid.uuid4().hex[:12]}"
        ctx = context or {}
        tool_calls = tool_calls or []

        dimensions: list[DimensionScore] = []

        info_score = self._assess_information_sufficiency(task, result, ctx)
        dimensions.append(info_score)

        domain_score = self._assess_domain_familiarity(task, ctx)
        dimensions.append(domain_score)

        consistency_score = await self._assess_consistency(task, result)
        dimensions.append(consistency_score)

        tool_score = self._assess_tool_reliability(tool_calls)
        dimensions.append(tool_score)

        evidence_score = self._assess_evidence_strength(result, tool_calls)
        dimensions.append(evidence_score)

        weights = {
            ConfidenceDimension.INFORMATION_SUFFICIENCY: 0.25,
            ConfidenceDimension.DOMAIN_FAMILIARITY: 0.20,
            ConfidenceDimension.CONSISTENCY: 0.25,
            ConfidenceDimension.TOOL_RELIABILITY: 0.15,
            ConfidenceDimension.EVIDENCE_STRENGTH: 0.15,
        }

        overall = sum(
            d.score * weights.get(d.dimension, 0.2)
            for d in dimensions
        )

        should_seek_help = overall < self._seek_help_threshold
        help_reason = ""
        suggested_action = ""

        if should_seek_help:
            low_dims = [d for d in dimensions if d.score < 0.5]
            if low_dims:
                worst = min(low_dims, key=lambda d: d.score)
                help_reason = f"置信度低({overall:.2f})，主要因为: {worst.reason}"
                suggested_action = f"建议: 补充{worst.dimension.value}方面的信息"
            else:
                help_reason = f"综合置信度低({overall:.2f})，建议寻求更多信息"
                suggested_action = "建议: 向用户确认需求或搜索相关信息"

        assessment = ConfidenceAssessment(
            assessment_id=assessment_id,
            overall_confidence=overall,
            dimensions=dimensions,
            should_seek_help=should_seek_help,
            help_reason=help_reason,
            suggested_action=suggested_action,
        )

        self._assessment_history.append(assessment)
        if len(self._assessment_history) > self._max_history:
            self._assessment_history = self._assessment_history[-self._max_history:]

        log.info(
            "元认知评估完成",
            assessment_id=assessment_id,
            confidence=round(overall, 3),
            seek_help=should_seek_help,
            duration_ms=round((time.time() - start) * 1000, 1),
        )
        return assessment

    async def identify_knowledge_gaps(
        self,
        task: str,
        available_tools: set[str] | None = None,
        context: dict[str, Any] | None = None,
    ) -> list[KnowledgeGap]:
        gaps: list[KnowledgeGap] = []
        task_lower = task.lower()

        for domain, familiarity in self._known_domains.items():
            if domain in task_lower and familiarity < 0.5:
                gaps.append(KnowledgeGap(
                    gap_type=GapType.UNKNOWN_DOMAIN,
                    description=f"任务涉及低熟悉度领域: {domain} (熟悉度={familiarity:.1f})",
                    severity=1.0 - familiarity,
                    suggested_action=f"搜索{domain}领域相关知识或咨询专家",
                ))

        if self._llm:
            llm_gaps = await self._identify_gaps_via_llm(task)
            gaps.extend(llm_gaps)

        if available_tools and self._tool_registry:
            tool_gaps = self._identify_tool_gaps(task, available_tools)
            gaps.extend(tool_gaps)

        ambiguous_patterns = ["还是", "或者", "是否", "or", "whether", "either"]
        if any(p in task_lower for p in ambiguous_patterns):
            gaps.append(KnowledgeGap(
                gap_type=GapType.AMBIGUOUS_REQUIREMENT,
                description="任务需求存在歧义，需要用户澄清",
                severity=0.6,
                suggested_action="向用户提问以澄清歧义",
            ))

        gaps.sort(key=lambda g: g.severity, reverse=True)
        return gaps

    async def decide_seek_help(
        self,
        assessment: ConfidenceAssessment,
        gaps: list[KnowledgeGap] | None = None,
    ) -> tuple[bool, str]:
        if assessment.should_seek_help:
            return True, assessment.help_reason

        if gaps:
            critical_gaps = [g for g in gaps if g.severity >= _GAP_SEVERITY_THRESHOLD]
            if critical_gaps:
                descriptions = [g.description for g in critical_gaps[:3]]
                return True, f"存在严重知识缺口: {'; '.join(descriptions)}"

        return False, ""

    def _assess_information_sufficiency(
        self, task: str, result: str, context: dict[str, Any],
    ) -> DimensionScore:
        has_result = bool(result and len(result) > 20)
        has_context = bool(context)
        context_richness = min(1.0, len(str(context)) / 500.0) if has_context else 0.0

        score = 0.3
        if has_result:
            score += 0.3
        if has_context:
            score += 0.2
        score += context_richness * 0.2

        reason = ""
        if not has_result:
            reason = "缺少执行结果"
        elif not has_context:
            reason = "缺少上下文信息"
        else:
            reason = "信息和上下文较充分"

        return DimensionScore(
            dimension=ConfidenceDimension.INFORMATION_SUFFICIENCY,
            score=min(1.0, score),
            reason=reason,
        )

    def _assess_domain_familiarity(
        self, task: str, context: dict[str, Any],
    ) -> DimensionScore:
        task_lower = task.lower()
        max_familiarity = 0.3
        matched_domain = ""

        for domain, familiarity in self._known_domains.items():
            if domain in task_lower and familiarity > max_familiarity:
                max_familiarity = familiarity
                matched_domain = domain

        reason = f"领域熟悉度={max_familiarity:.1f}" if matched_domain else "未匹配到已知领域"

        return DimensionScore(
            dimension=ConfidenceDimension.DOMAIN_FAMILIARITY,
            score=max_familiarity,
            reason=reason,
        )

    async def _assess_consistency(
        self, task: str, result: str,
    ) -> DimensionScore:
        if not result or not self._llm:
            return DimensionScore(
                dimension=ConfidenceDimension.CONSISTENCY,
                score=0.5,
                reason="无法评估一致性（缺少结果或LLM）",
            )

        prompt = (
            f"任务: {task}\n结果: {result[:500]}\n\n"
            f"请评估结果是否与任务一致、逻辑是否自洽。\n"
            f"输出0-1的一致性评分和简要原因，格式: SCORE:0.X REASON:xxx"
        )

        try:
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=128,
            )
            content = resp.get("content", "") if isinstance(resp, dict) else str(resp)

            import re
            score_match = re.search(r'SCORE:\s*(0\.\d+)', content)
            reason_match = re.search(r'REASON:\s*(.+)', content)

            score = float(score_match.group(1)) if score_match else 0.7
            reason = reason_match.group(1).strip() if reason_match else "LLM一致性评估"
        except Exception:
            score = 0.6
            reason = "一致性评估失败，使用默认值"

        return DimensionScore(
            dimension=ConfidenceDimension.CONSISTENCY,
            score=score,
            reason=reason,
        )

    def _assess_tool_reliability(
        self, tool_calls: list[dict[str, Any]],
    ) -> DimensionScore:
        if not tool_calls:
            return DimensionScore(
                dimension=ConfidenceDimension.TOOL_RELIABILITY,
                score=0.5,
                reason="无工具调用",
            )

        success_count = sum(1 for tc in tool_calls if tc.get("success", True))
        total = len(tool_calls)
        success_rate = success_count / total

        reason = f"工具调用成功率={success_rate:.1%}({success_count}/{total})"
        return DimensionScore(
            dimension=ConfidenceDimension.TOOL_RELIABILITY,
            score=success_rate,
            reason=reason,
        )

    def _assess_evidence_strength(
        self, result: str, tool_calls: list[dict[str, Any]],
    ) -> DimensionScore:
        has_tool_evidence = any(tc.get("success", True) and tc.get("result") for tc in tool_calls)
        result_length = len(result) if result else 0

        score = 0.3
        if has_tool_evidence:
            score += 0.4
        if result_length > 100:
            score += 0.2
        if result_length > 500:
            score += 0.1

        reason = "有工具结果支撑" if has_tool_evidence else "缺少工具结果支撑"

        return DimensionScore(
            dimension=ConfidenceDimension.EVIDENCE_STRENGTH,
            score=min(1.0, score),
            reason=reason,
        )

    async def _identify_gaps_via_llm(self, task: str) -> list[KnowledgeGap]:
        if not self._llm:
            return []

        prompt = (
            f"分析以下任务，识别完成该任务可能缺少的知识或能力：\n\n{task}\n\n"
            f"按格式输出每个缺口（每行一个）：\n"
            f"GAP: [缺口描述] | TYPE: [missing_info/unknown_domain/insufficient_tool] | ACTION: [建议行动]"
        )

        try:
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=256,
            )
            content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
        except Exception:
            return []

        gaps: list[KnowledgeGap] = []
        type_map = {
            "missing_info": GapType.MISSING_INFORMATION,
            "unknown_domain": GapType.UNKNOWN_DOMAIN,
            "insufficient_tool": GapType.INSUFFICIENT_TOOL,
        }

        for line in content.split("\n"):
            if "GAP:" not in line:
                continue
            parts = {}
            for segment in line.split("|"):
                key, _, val = segment.strip().partition(":")
                parts[key.strip().upper()] = val.strip()

            description = parts.get("GAP", "")
            if not description:
                continue

            gap_type_str = parts.get("TYPE", "missing_info").lower()
            gap_type = type_map.get(gap_type_str, GapType.MISSING_INFORMATION)
            action = parts.get("ACTION", "")

            gaps.append(KnowledgeGap(
                gap_type=gap_type,
                description=description,
                severity=0.5,
                suggested_action=action,
            ))

        return gaps[:5]

    def _identify_tool_gaps(
        self, task: str, available_tools: set[str],
    ) -> list[KnowledgeGap]:
        gaps: list[KnowledgeGap] = []
        task_lower = task.lower()

        tool_needs: dict[str, list[str]] = {
            "web_search": ["搜索", "查找", "search", "find", "look up"],
            "code_execution": ["运行", "执行", "计算", "run", "execute", "calculate"],
            "file_operation": ["文件", "读取", "写入", "file", "read", "write"],
            "database": ["数据库", "查询", "database", "query", "sql"],
        }

        for tool_name, keywords in tool_needs.items():
            if any(kw in task_lower for kw in keywords):
                if tool_name not in available_tools:
                    gaps.append(KnowledgeGap(
                        gap_type=GapType.INSUFFICIENT_TOOL,
                        description=f"任务需要 {tool_name} 但该工具不可用",
                        severity=0.7,
                        suggested_action=f"安装或启用 {tool_name} 工具",
                        relevant_tools=[tool_name],
                    ))

        return gaps
