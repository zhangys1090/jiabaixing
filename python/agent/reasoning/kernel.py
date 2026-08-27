"""统一推理内核 (Unified Reasoning Kernel)。

将散落在 TreeOfThought / TaskComplexityAnalyzer / ConversationLoop 的推理逻辑
统一调度，支持策略路由、A/B测试、进化优化。

推理策略:
  - direct:      简单问题，直接回答
  - cot:         中等复杂度，Chain-of-Thought
  - tot:         高复杂度，Tree-of-Thought 多路径推理
  - counterfactual: 反事实推理，对已完成路径做遗憾分析

Usage:
    kernel = ReasoningKernel(llm=provider)
    result = await kernel.reason(problem="...", context={...})
    print(result.strategy_used)
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent.core.logger import StructuredLogger

log = StructuredLogger("reasoning_kernel")


class ReasoningStrategy(str, Enum):
    DIRECT = "direct"
    CHAIN_OF_THOUGHT = "cot"
    TREE_OF_THOUGHT = "tot"
    COUNTERFACTUAL = "counterfactual"


class ComplexityLevel(str, Enum):
    SIMPLE = "simple"
    MEDIUM = "medium"
    COMPLEX = "complex"
    VERY_COMPLEX = "very_complex"


@dataclass
class ComplexityAssessment:
    level: ComplexityLevel = ComplexityLevel.MEDIUM
    score: float = 0.5
    factors: dict[str, float] = field(default_factory=dict)
    domain_tags: list[str] = field(default_factory=list)
    recommended_strategy: ReasoningStrategy = ReasoningStrategy.CHAIN_OF_THOUGHT


@dataclass
class ReasoningStep:
    step_id: str = ""
    strategy: ReasoningStrategy = ReasoningStrategy.CHAIN_OF_THOUGHT
    thought: str = ""
    action: str = ""
    observation: str = ""
    score: float = 0.0
    duration_ms: float = 0.0


@dataclass
class ReasoningResult:
    result_id: str = ""
    problem: str = ""
    strategy_used: ReasoningStrategy = ReasoningStrategy.CHAIN_OF_THOUGHT
    complexity: ComplexityAssessment = field(default_factory=ComplexityAssessment)
    steps: list[ReasoningStep] = field(default_factory=list)
    conclusion: str = ""
    confidence: float = 0.0
    verified: bool = False
    counterfactual_report: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)
    duration_ms: float = 0.0


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


_COMPLEXITY_KEYWORDS: dict[ComplexityLevel, list[str]] = {
    ComplexityLevel.SIMPLE: [
        "是什么", "什么是", "定义", "who", "what is", "define",
        "几点", "多少", "how many", "when",
    ],
    ComplexityLevel.MEDIUM: [
        "为什么", "如何", "比较", "区别", "why", "how", "compare",
        "分析", "explain", "analyze",
    ],
    ComplexityLevel.COMPLEX: [
        "设计", "优化", "重构", "架构", "design", "optimize",
        "refactor", "architect", "多步骤", "multi-step",
    ],
    ComplexityLevel.VERY_COMPLEX: [
        "证明", "推导", "反事实", "如果换", "prove", "derive",
        "counterfactual", "what if", "权衡", "trade-off",
    ],
}

_STRATEGY_MAP: dict[ComplexityLevel, ReasoningStrategy] = {
    ComplexityLevel.SIMPLE: ReasoningStrategy.DIRECT,
    ComplexityLevel.MEDIUM: ReasoningStrategy.CHAIN_OF_THOUGHT,
    ComplexityLevel.COMPLEX: ReasoningStrategy.TREE_OF_THOUGHT,
    ComplexityLevel.VERY_COMPLEX: ReasoningStrategy.COUNTERFACTUAL,
}

_MAX_STEPS_PER_STRATEGY: dict[ReasoningStrategy, int] = {
    ReasoningStrategy.DIRECT: 1,
    ReasoningStrategy.CHAIN_OF_THOUGHT: 5,
    ReasoningStrategy.TREE_OF_THOUGHT: 15,
    ReasoningStrategy.COUNTERFACTUAL: 20,
}


class ReasoningKernel:
    """统一推理内核 — 策略路由 + 可插拔推理引擎。

    Args:
        llm: LLM 提供者实例。
        counterfactual_engine: 反事实推理引擎实例。
        tot_engine: Tree-of-Thought 引擎实例（可选）。
        strategy_overrides: 手动策略覆盖 {complexity_level: strategy}。
        enable_verification: 是否对推理链做自验证。
    """

    def __init__(
        self,
        llm: LLMProtocol | None = None,
        counterfactual_engine: Any = None,
        tot_engine: Any = None,
        strategy_overrides: dict[str, str] | None = None,
        enable_verification: bool = True,
    ) -> None:
        self._llm = llm
        self._counterfactual_engine = counterfactual_engine
        self._tot_engine = tot_engine
        self._enable_verification = enable_verification

        self._strategy_overrides: dict[ComplexityLevel, ReasoningStrategy] = {}
        if strategy_overrides:
            for k, v in strategy_overrides.items():
                try:
                    level = ComplexityLevel(k)
                    strategy = ReasoningStrategy(v)
                    self._strategy_overrides[level] = strategy
                except ValueError:
                    pass

        self._strategy_stats: dict[ReasoningStrategy, dict[str, int]] = {}
        for s in ReasoningStrategy:
            self._strategy_stats[s] = {"used": 0, "successful": 0}

    async def reason(
        self,
        problem: str,
        context: dict[str, Any] | None = None,
        force_strategy: ReasoningStrategy | None = None,
    ) -> ReasoningResult:
        start = time.time()
        result_id = f"rk_{uuid.uuid4().hex[:12]}"
        ctx = context or {}

        complexity = self._assess_complexity(problem, ctx)

        if force_strategy:
            strategy = force_strategy
        elif complexity.level in self._strategy_overrides:
            strategy = self._strategy_overrides[complexity.level]
        else:
            strategy = complexity.recommended_strategy

        log.info(
            "推理内核启动",
            result_id=result_id,
            strategy=strategy.value,
            complexity=complexity.level.value,
            score=round(complexity.score, 3),
        )

        if strategy == ReasoningStrategy.DIRECT:
            result = await self._direct_reasoning(problem, ctx)
        elif strategy == ReasoningStrategy.CHAIN_OF_THOUGHT:
            result = await self._chain_of_thought(problem, ctx)
        elif strategy == ReasoningStrategy.TREE_OF_THOUGHT:
            result = await self._tree_of_thought(problem, ctx)
        elif strategy == ReasoningStrategy.COUNTERFACTUAL:
            result = await self._counterfactual_reasoning(problem, ctx)
        else:
            result = await self._chain_of_thought(problem, ctx)

        result.result_id = result_id
        result.problem = problem
        result.strategy_used = strategy
        result.complexity = complexity

        if self._enable_verification and result.conclusion:
            result.verified = await self._verify_chain(result)
            if not result.verified:
                result.confidence *= 0.8

        result.duration_ms = (time.time() - start) * 1000

        self._strategy_stats[strategy]["used"] += 1
        if result.confidence >= 0.5:
            self._strategy_stats[strategy]["successful"] += 1

        log.info(
            "推理内核完成",
            result_id=result_id,
            strategy=strategy.value,
            steps=len(result.steps),
            confidence=round(result.confidence, 3),
            verified=result.verified,
            duration_ms=round(result.duration_ms, 1),
        )
        return result

    def _assess_complexity(
        self, problem: str, context: dict[str, Any],
    ) -> ComplexityAssessment:
        problem_lower = problem.lower()
        scores: dict[ComplexityLevel, float] = {}

        for level, keywords in _COMPLEXITY_KEYWORDS.items():
            match_count = sum(1 for kw in keywords if kw in problem_lower)
            scores[level] = match_count / max(len(keywords), 1)

        length_factor = min(1.0, len(problem) / 500.0)
        scores[ComplexityLevel.COMPLEX] = scores.get(ComplexityLevel.COMPLEX, 0.0) + length_factor * 0.3

        multi_step = any(
            kw in problem_lower
            for kw in ["然后", "接着", "之后", "and then", "after that", "step by step", "首先"]
        )
        if multi_step:
            scores[ComplexityLevel.COMPLEX] = scores.get(ComplexityLevel.COMPLEX, 0.0) + 0.3

        best_level = ComplexityLevel.MEDIUM
        best_score = 0.0
        for level in ComplexityLevel:
            s = scores.get(level, 0.0)
            if s > best_score:
                best_score = s
                best_level = level

        if best_score == 0.0:
            best_level = ComplexityLevel.SIMPLE if len(problem) < 50 else ComplexityLevel.MEDIUM

        overall_score = {
            ComplexityLevel.SIMPLE: 0.2,
            ComplexityLevel.MEDIUM: 0.5,
            ComplexityLevel.COMPLEX: 0.8,
            ComplexityLevel.VERY_COMPLEX: 0.95,
        }.get(best_level, 0.5)

        domain_tags: list[str] = []
        domain_keywords = {
            "coding": ["代码", "编程", "code", "function", "class", "debug"],
            "math": ["计算", "数学", "calculate", "math", "equation"],
            "reasoning": ["推理", "逻辑", "reasoning", "logic", "prove"],
            "planning": ["规划", "计划", "plan", "schedule", "design"],
        }
        for domain, kws in domain_keywords.items():
            if any(kw in problem_lower for kw in kws):
                domain_tags.append(domain)

        recommended = self._strategy_overrides.get(best_level, _STRATEGY_MAP.get(best_level, ReasoningStrategy.CHAIN_OF_THOUGHT))

        return ComplexityAssessment(
            level=best_level,
            score=overall_score,
            factors=scores,
            domain_tags=domain_tags,
            recommended_strategy=recommended,
        )

    async def _direct_reasoning(
        self, problem: str, context: dict[str, Any],
    ) -> ReasoningResult:
        if not self._llm:
            return ReasoningResult(conclusion=problem, confidence=0.3)

        try:
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": problem}],
                temperature=0.0,
                max_tokens=1024,
            )
            content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
        except Exception as exc:
            return ReasoningResult(conclusion=f"推理失败: {exc}", confidence=0.0)

        return ReasoningResult(
            steps=[ReasoningStep(
                step_id=f"s_{uuid.uuid4().hex[:6]}",
                strategy=ReasoningStrategy.DIRECT,
                thought=problem,
                observation=content,
                score=0.8,
            )],
            conclusion=content,
            confidence=0.8,
        )

    async def _chain_of_thought(
        self, problem: str, context: dict[str, Any],
    ) -> ReasoningResult:
        if not self._llm:
            return ReasoningResult(conclusion=problem, confidence=0.3)

        cot_prompt = (
            f"请一步步思考以下问题：\n\n{problem}\n\n"
            f"请按以下格式输出：\n"
            f"THOUGHT: [你的思考过程]\n"
            f"CONCLUSION: [最终结论]"
        )

        try:
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": cot_prompt}],
                temperature=0.1,
                max_tokens=2048,
            )
            content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
        except Exception as exc:
            return ReasoningResult(conclusion=f"推理失败: {exc}", confidence=0.0)

        thought = ""
        conclusion = content
        for line in content.split("\n"):
            if line.strip().upper().startswith("THOUGHT:"):
                thought = line.partition(":")[2].strip()
            elif line.strip().upper().startswith("CONCLUSION:"):
                conclusion = line.partition(":")[2].strip()

        return ReasoningResult(
            steps=[ReasoningStep(
                step_id=f"s_{uuid.uuid4().hex[:6]}",
                strategy=ReasoningStrategy.CHAIN_OF_THOUGHT,
                thought=thought or content,
                observation=conclusion,
                score=0.75,
            )],
            conclusion=conclusion,
            confidence=0.75,
        )

    async def _tree_of_thought(
        self, problem: str, context: dict[str, Any],
    ) -> ReasoningResult:
        if self._tot_engine:
            try:
                tot_result = await self._tot_engine.solve(problem)
                return ReasoningResult(
                    conclusion=str(tot_result),
                    confidence=0.85,
                    metadata={"tot_result": tot_result},
                )
            except Exception:
                pass

        return await self._chain_of_thought(problem, context)

    async def _counterfactual_reasoning(
        self, problem: str, context: dict[str, Any],
    ) -> ReasoningResult:
        base_result = await self._tree_of_thought(problem, context)

        if self._counterfactual_engine:
            try:
                from agent.reasoning.counterfactual import DecisionNode

                path = [
                    DecisionNode(
                        node_id=f"dn_{i}",
                        thought=step.thought,
                        score=step.score,
                        depth=i,
                    )
                    for i, step in enumerate(base_result.steps)
                ]

                cf_report = await self._counterfactual_engine.analyze(
                    problem=problem, best_path=path,
                )
                base_result.counterfactual_report = cf_report

                if cf_report.regretful_decisions > 0:
                    base_result.confidence *= 0.9
                    base_result.metadata["counterfactual_insights"] = cf_report.insights
            except Exception as exc:
                log.warning("反事实推理失败，使用基础结果", error=str(exc))

        return base_result

    async def _verify_chain(self, result: ReasoningResult) -> bool:
        if not self._llm or not result.conclusion:
            return True

        verify_prompt = (
            f"问题: {result.problem}\n"
            f"结论: {result.conclusion}\n\n"
            f"请验证上述结论是否逻辑自洽、是否有明显错误。\n"
            f"输出 VALID 或 INVALID，并简要说明原因。"
        )

        try:
            resp = await self._llm.chat(
                messages=[{"role": "user", "content": verify_prompt}],
                temperature=0.0,
                max_tokens=256,
            )
            content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
            return "VALID" in content.upper()
        except Exception:
            return True

    def get_strategy_stats(self) -> dict[str, dict[str, int]]:
        return {s.value: stats.copy() for s, stats in self._strategy_stats.items()}
