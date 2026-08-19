"""MoA 多模型聚合器（Mixture-of-Agents Aggregator）。

将多个 LLM 的输出聚合，提升回答质量和鲁棒性：
  - 并行调用多个模型生成候选回答
  - 聚合策略：投票/级联/加权合并/自洽筛选
  - 自动选择最优回答或合并多源信息
  - 成本控制：仅对关键问题启用 MoA

与 AuxiliaryLLMClient 的区别：
  - AuxiliaryLLMClient: 分流非核心任务到廉价模型（降低成本）
  - MoAAggregator: 聚合多模型输出提升质量（增加成本但提升可靠性）

集成示例::

    from agent.llm.moa_aggregator import MoAAggregator, AggregationStrategy

    moa = MoAAggregator(provider)
    result = await moa.aggregate(
        messages=[{"role": "user", "content": "解释量子计算"}],
        models=["openai/gpt-4o-mini", "anthropic/claude-3-haiku-20240307"],
        strategy=AggregationStrategy.CONSENSUS,
    )
    print(result.best_answer)
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, TYPE_CHECKING

from agent.core.logger import StructuredLogger

if TYPE_CHECKING:
    from agent.llm.provider import LLMProvider

log = StructuredLogger("moa_aggregator")


class AggregationStrategy(str, Enum):
    VOTING = "voting"
    CASCADE = "cascade"
    WEIGHTED_MERGE = "weighted_merge"
    CONSENSUS = "consensus"
    BEST_OF_N = "best_of_n"


@dataclass
class ModelResponse:
    model: str
    content: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    duration_ms: float = 0.0
    success: bool = True
    error: str = ""


@dataclass
class ModelWeight:
    model: str
    weight: float
    cost_per_call: float = 0.0


@dataclass
class AggregationResult:
    best_answer: str
    best_model: str
    strategy: str
    candidates: list[ModelResponse] = field(default_factory=list)
    merged_answer: str = ""
    consensus_score: float = 0.0
    total_cost_usd: float = 0.0
    total_duration_ms: float = 0.0


_DEFAULT_WEIGHTS: dict[str, float] = {
    "openai/gpt-4o-mini": 0.9,
    "anthropic/claude-3-haiku-20240307": 0.85,
    "gemini/gemini-2.0-flash": 0.8,
    "deepseek/deepseek-chat": 0.75,
    "deepseek/deepseek-v4-flash": 0.85,
    "deepseek/deepseek-v4-pro": 0.90,
    "ollama/qwen2.5": 0.6,
}


class MoAAggregator:
    """MoA 多模型聚合器。

    并行调用多个模型，通过聚合策略选择或合并最优回答。
    """

    def __init__(self, provider: Any = None) -> None:
        self._provider = provider
        self._weights: dict[str, float] = dict(_DEFAULT_WEIGHTS)
        self._default_models: list[str] = [
            "openai/gpt-4o-mini",
            "anthropic/claude-3-haiku-20240307",
        ]

    def set_weights(self, weights: dict[str, float]) -> None:
        self._weights.update(weights)

    def set_default_models(self, models: list[str]) -> None:
        self._default_models = models

    async def _call_model(
        self,
        messages: list[dict[str, str]],
        model: str,
        max_tokens: int = 1000,
        temperature: float = 0.7,
    ) -> ModelResponse:
        start = time.monotonic()
        try:
            provider = self._provider
            if provider is None:
                from agent.llm.provider import LLMProvider
                provider = LLMProvider()

            response = await provider.chat(
                messages=messages,
                model=model,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            content = response if isinstance(response, str) else str(response)
            duration = (time.monotonic() - start) * 1000

            return ModelResponse(
                model=model,
                content=content,
                input_tokens=sum(len(m.get("content", "")) for m in messages) // 4,
                output_tokens=len(content) // 4,
                duration_ms=duration,
                success=True,
            )
        except Exception as e:
            duration = (time.monotonic() - start) * 1000
            log.error("MoA 模型调用失败", model=model, error=str(e))
            return ModelResponse(model=model, content="", duration_ms=duration, success=False, error=str(e))

    async def _call_parallel(
        self,
        messages: list[dict[str, str]],
        models: list[str],
        max_tokens: int = 1000,
        temperature: float = 0.7,
    ) -> list[ModelResponse]:
        tasks = [self._call_model(messages, m, max_tokens, temperature) for m in models]
        return await asyncio.gather(*tasks)

    def _compute_consensus(self, responses: list[ModelResponse]) -> tuple[float, str]:
        successful = [r for r in responses if r.success and r.content.strip()]
        if len(successful) <= 1:
            return 0.0, successful[0].content if successful else ""

        contents = [r.content.strip() for r in successful]
        similarity_scores: list[float] = []
        for i in range(len(contents)):
            score = 0.0
            for j in range(len(contents)):
                if i != j:
                    common = len(set(contents[i].split()) & set(contents[j].split()))
                    total = len(set(contents[i].split()) | set(contents[j].split()))
                    score += common / total if total > 0 else 0
            similarity_scores.append(score / (len(contents) - 1))

        best_idx = similarity_scores.index(max(similarity_scores))
        avg_sim = sum(similarity_scores) / len(similarity_scores)
        return avg_sim, contents[best_idx]

    def _voting_select(self, responses: list[ModelResponse]) -> tuple[str, str, float]:
        successful = [r for r in responses if r.success and r.content.strip()]
        if not successful:
            return "", "", 0.0

        if len(successful) == 1:
            return successful[0].content, successful[0].model, 1.0

        first_lines = [r.content.strip().split("\n")[0] for r in successful]
        counter = Counter(first_lines)
        most_common_line, count = counter.most_common(1)[0]
        consensus = count / len(successful)

        for r in successful:
            if r.content.strip().split("\n")[0] == most_common_line:
                return r.content, r.model, consensus

        return successful[0].content, successful[0].model, consensus

    def _weighted_merge(self, responses: list[ModelResponse]) -> str:
        successful = [r for r in responses if r.success and r.content.strip()]
        if not successful:
            return ""
        if len(successful) == 1:
            return successful[0].content

        sections: list[str] = []
        for r in successful:
            weight = self._weights.get(r.model, 0.5)
            marker = f"[{r.model} (权重:{weight:.1f})]"
            sections.append(f"{marker}\n{r.content.strip()}\n")

        return "\n---\n".join(sections)

    async def aggregate(
        self,
        messages: list[dict[str, str]],
        models: list[str] | None = None,
        strategy: AggregationStrategy = AggregationStrategy.CONSENSUS,
        max_tokens: int = 1000,
        temperature: float = 0.7,
    ) -> AggregationResult:
        model_list = models or self._default_models
        start = time.monotonic()

        if strategy == AggregationStrategy.CASCADE:
            return await self._cascade(messages, model_list, max_tokens, temperature)

        responses = await self._call_parallel(messages, model_list, max_tokens, temperature)
        total_cost = sum(r.cost_usd for r in responses)
        duration = (time.monotonic() - start) * 1000

        if strategy == AggregationStrategy.VOTING:
            best_content, best_model, consensus = self._voting_select(responses)
            return AggregationResult(
                best_answer=best_content,
                best_model=best_model,
                strategy=strategy.value,
                candidates=responses,
                consensus_score=consensus,
                total_cost_usd=total_cost,
                total_duration_ms=duration,
            )

        elif strategy == AggregationStrategy.CONSENSUS:
            consensus, best_content = self._compute_consensus(responses)
            best_model = next((r.model for r in responses if r.success and r.content.strip() == best_content), model_list[0])
            return AggregationResult(
                best_answer=best_content,
                best_model=best_model,
                strategy=strategy.value,
                candidates=responses,
                consensus_score=consensus,
                total_cost_usd=total_cost,
                total_duration_ms=duration,
            )

        elif strategy == AggregationStrategy.WEIGHTED_MERGE:
            merged = self._weighted_merge(responses)
            best = next((r for r in responses if r.success), responses[0])
            return AggregationResult(
                best_answer=best.content,
                best_model=best.model,
                strategy=strategy.value,
                candidates=responses,
                merged_answer=merged,
                total_cost_usd=total_cost,
                total_duration_ms=duration,
            )

        elif strategy == AggregationStrategy.BEST_OF_N:
            successful = [r for r in responses if r.success and r.content.strip()]
            if successful:
                best = max(successful, key=lambda r: self._weights.get(r.model, 0.5) * len(r.content))
            else:
                best = responses[0]
            return AggregationResult(
                best_answer=best.content,
                best_model=best.model,
                strategy=strategy.value,
                candidates=responses,
                total_cost_usd=total_cost,
                total_duration_ms=duration,
            )

        best = next((r for r in responses if r.success), responses[0])
        return AggregationResult(
            best_answer=best.content,
            best_model=best.model,
            strategy=strategy.value,
            candidates=responses,
            total_cost_usd=total_cost,
            total_duration_ms=duration,
        )

    async def _cascade(
        self,
        messages: list[dict[str, str]],
        models: list[str],
        max_tokens: int,
        temperature: float,
    ) -> AggregationResult:
        start = time.monotonic()
        responses: list[ModelResponse] = []
        current_messages = list(messages)

        for model in models:
            resp = await self._call_model(current_messages, model, max_tokens, temperature)
            responses.append(resp)
            if resp.success and resp.content.strip():
                current_messages = list(messages) + [
                    {"role": "assistant", "content": resp.content},
                    {"role": "user", "content": "请改进上述回答，使其更准确、更完整。"},
                ]

        best = next((r for r in reversed(responses) if r.success), responses[-1])
        total_cost = sum(r.cost_usd for r in responses)
        duration = (time.monotonic() - start) * 1000

        return AggregationResult(
            best_answer=best.content,
            best_model=best.model,
            strategy=AggregationStrategy.CASCADE.value,
            candidates=responses,
            total_cost_usd=total_cost,
            total_duration_ms=duration,
        )
