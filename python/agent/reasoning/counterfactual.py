"""反事实推理引擎 (Counterfactual Reasoning Engine)。

D3 路线图缺口补齐：对已完成推理的最佳路径，在每个关键决策点
生成"如果选择另一条路会怎样"的假设分支，量化遗憾值（regret）。

核心流程：
  1. 接收 TreeOfThought / ReAct 的推理路径 + 被剪枝的候选分支
  2. 对最佳路径的每个决策节点，重新展开被剪枝分支
  3. 用 LLM 评估假设分支的预期结果
  4. 计算 regret = score(alternative) - score(actual)
  5. 输出 CounterfactualReport

Usage:
    engine = CounterfactualEngine(llm=provider)
    report = await engine.analyze(problem, best_path, pruned_candidates)
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent.core.logger import StructuredLogger

log = StructuredLogger("counterfactual")


class DecisionImportance(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class DecisionNode:
    node_id: str = ""
    thought: str = ""
    score: float = 0.0
    depth: int = 0
    chosen_branch_id: str = ""
    pruned_branches: list[dict[str, Any]] = field(default_factory=list)
    importance: DecisionImportance = DecisionImportance.MEDIUM


@dataclass
class CounterfactualBranch:
    branch_id: str = ""
    decision_node_id: str = ""
    alternative_thought: str = ""
    predicted_outcome: str = ""
    predicted_score: float = 0.0
    confidence: float = 0.0
    reasoning: str = ""


@dataclass
class RegretAnalysis:
    decision_node_id: str = ""
    actual_score: float = 0.0
    best_alternative_score: float = 0.0
    regret: float = 0.0
    is_regretful: bool = False
    alternative_branch: CounterfactualBranch | None = None


@dataclass
class CounterfactualReport:
    report_id: str = ""
    problem: str = ""
    total_decisions: int = 0
    analyzed_decisions: int = 0
    regretful_decisions: int = 0
    max_regret: float = 0.0
    avg_regret: float = 0.0
    analyses: list[RegretAnalysis] = field(default_factory=list)
    insights: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


_REGRET_THRESHOLD = 0.15
_MAX_DECISIONS_TO_ANALYZE = 8
_CONFIDENCE_THRESHOLD = 0.4


class CounterfactualEngine:
    """反事实推理引擎。

    对推理路径的关键决策点执行反事实分析，量化遗憾值，
    帮助 Agent 理解"如果换一种做法会怎样"。

    Args:
        llm: LLM 提供者实例。
        regret_threshold: 遗憾值超过此阈值视为 regretful。
        max_decisions: 最多分析的决策点数量。
    """

    def __init__(
        self,
        llm: LLMProtocol | None = None,
        regret_threshold: float = _REGRET_THRESHOLD,
        max_decisions: int = _MAX_DECISIONS_TO_ANALYZE,
    ) -> None:
        self._llm = llm
        self._regret_threshold = regret_threshold
        self._max_decisions = max_decisions

    async def analyze(
        self,
        problem: str,
        best_path: list[DecisionNode],
        pruned_candidates: dict[str, list[dict[str, Any]]] | None = None,
    ) -> CounterfactualReport:
        start = time.time()
        report_id = f"cf_{uuid.uuid4().hex[:12]}"

        if not best_path:
            return CounterfactualReport(
                report_id=report_id, problem=problem, duration_ms=0.0,
            )

        key_decisions = self._select_key_decisions(best_path)
        pruned_candidates = pruned_candidates or {}

        analyses: list[RegretAnalysis] = []
        for decision in key_decisions[: self._max_decisions]:
            alternatives = pruned_candidates.get(decision.node_id, decision.pruned_branches)
            if not alternatives:
                cf_branch = await self._generate_counterfactual(problem, decision)
                if cf_branch is None:
                    continue
                alternatives = [{"thought": cf_branch.alternative_thought, "score": cf_branch.predicted_score}]

            analysis = await self._analyze_decision(problem, decision, alternatives)
            analyses.append(analysis)

        regretful = [a for a in analyses if a.is_regretful]
        all_regrets = [a.regret for a in analyses]
        insights = self._generate_insights(analyses, problem)

        duration_ms = (time.time() - start) * 1000
        report = CounterfactualReport(
            report_id=report_id,
            problem=problem,
            total_decisions=len(best_path),
            analyzed_decisions=len(analyses),
            regretful_decisions=len(regretful),
            max_regret=max(all_regrets) if all_regrets else 0.0,
            avg_regret=sum(all_regrets) / len(all_regrets) if all_regrets else 0.0,
            analyses=analyses,
            insights=insights,
            duration_ms=duration_ms,
        )

        log.info(
            "反事实推理完成",
            report_id=report_id,
            analyzed=len(analyses),
            regretful=len(regretful),
            max_regret=round(report.max_regret, 3),
            duration_ms=round(duration_ms, 1),
        )
        return report

    def _select_key_decisions(self, path: list[DecisionNode]) -> list[DecisionNode]:
        scored = sorted(path, key=lambda n: n.score, reverse=True)
        high_importance = [n for n in path if n.importance in (DecisionImportance.HIGH, DecisionImportance.CRITICAL)]
        candidates = high_importance if high_importance else scored[: self._max_decisions]
        return candidates[: self._max_decisions]

    async def _generate_counterfactual(
        self, problem: str, decision: DecisionNode,
    ) -> CounterfactualBranch | None:
        if self._llm is None:
            return None

        prompt = (
            f"问题: {problem}\n\n"
            f"当前决策: {decision.thought}\n"
            f"当前评分: {decision.score:.2f}\n\n"
            f"请提出一个完全不同的替代方案，并预测其结果。\n"
            f"按以下格式输出:\n"
            f"ALTERNATIVE: [替代方案描述]\n"
            f"PREDICTED_OUTCOME: [预期结果]\n"
            f"PREDICTED_SCORE: [0-10的评分]\n"
            f"CONFIDENCE: [0-1的置信度]\n"
            f"REASONING: [推理过程]"
        )

        try:
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
                max_tokens=512,
            )
            content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
            return self._parse_counterfactual(content, decision)
        except Exception as exc:
            log.warning("反事实生成失败", node_id=decision.node_id, error=str(exc))
            return None

    def _parse_counterfactual(self, content: str, decision: DecisionNode) -> CounterfactualBranch | None:
        parts: dict[str, str] = {}
        for line in content.split("\n"):
            if ":" in line:
                key, _, val = line.partition(":")
                parts[key.strip().upper()] = val.strip()

        alt_thought = parts.get("ALTERNATIVE", "")
        if not alt_thought:
            return None

        try:
            predicted_score = float(parts.get("PREDICTED_SCORE", "5"))
            predicted_score = max(0.0, min(10.0, predicted_score)) / 10.0
        except ValueError:
            predicted_score = 0.5

        try:
            confidence = float(parts.get("CONFIDENCE", "0.5"))
            confidence = max(0.0, min(1.0, confidence))
        except ValueError:
            confidence = 0.5

        return CounterfactualBranch(
            branch_id=f"cfb_{uuid.uuid4().hex[:8]}",
            decision_node_id=decision.node_id,
            alternative_thought=alt_thought,
            predicted_outcome=parts.get("PREDICTED_OUTCOME", ""),
            predicted_score=predicted_score,
            confidence=confidence,
            reasoning=parts.get("REASONING", ""),
        )

    async def _analyze_decision(
        self,
        problem: str,
        decision: DecisionNode,
        alternatives: list[dict[str, Any]],
    ) -> RegretAnalysis:
        best_alt_score = 0.0
        best_branch: CounterfactualBranch | None = None

        for alt in alternatives:
            alt_thought = alt.get("thought", "")
            alt_score = alt.get("score", 0.5)
            if isinstance(alt_score, (int, float)) and alt_score > 1:
                alt_score = alt_score / 10.0

            if self._llm and not alt.get("predicted_outcome"):
                cf = await self._generate_counterfactual(problem, decision)
                if cf and cf.predicted_score > best_alt_score:
                    best_alt_score = cf.predicted_score
                    best_branch = cf
            elif alt_score > best_alt_score:
                best_alt_score = alt_score
                best_branch = CounterfactualBranch(
                    branch_id=f"cfb_{uuid.uuid4().hex[:8]}",
                    decision_node_id=decision.node_id,
                    alternative_thought=alt_thought,
                    predicted_score=alt_score,
                )

        regret = best_alt_score - decision.score
        is_regretful = regret > self._regret_threshold

        return RegretAnalysis(
            decision_node_id=decision.node_id,
            actual_score=decision.score,
            best_alternative_score=best_alt_score,
            regret=regret,
            is_regretful=is_regretful,
            alternative_branch=best_branch,
        )

    def _generate_insights(self, analyses: list[RegretAnalysis], problem: str) -> list[str]:
        insights: list[str] = []
        regretful = [a for a in analyses if a.is_regretful]

        if not regretful:
            insights.append("当前推理路径的所有关键决策均优于替代方案，路径质量良好。")
        else:
            insights.append(
                f"发现 {len(regretful)}/{len(analyses)} 个决策点存在更优替代方案（遗憾值>{self._regret_threshold:.0%}）。"
            )
            for a in regretful:
                if a.alternative_branch:
                    insights.append(
                        f"决策节点 {a.decision_node_id}: 替代方案\"{a.alternative_branch.alternative_thought[:50]}\" "
                        f"可能更优（遗憾值={a.regret:.3f}）。"
                    )

        high_regret = [a for a in analyses if a.regret > 0.3]
        if high_regret:
            insights.append(
                f"⚠️ {len(high_regret)} 个决策的遗憾值>0.3，建议重新评估这些决策点。"
            )

        return insights
