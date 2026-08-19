"""能力驱动的 LLM 路由（Capability-Aware Router）。

家百星"LLM 底座"的关键增强：把 ``LLMCapabilityDetector`` 检测出的模型能力，
转化为**任务级**的模型/Provider 选型决策，而非仅按配置优先级（ ``get_primary`` ）。

这是家百星区别于"单一模型代理"的独有能力之一：
- 编码任务 -> 自动选 code_generation 高且 tool_calling_accuracy 高的模型
- 复杂推理任务 -> 自动选 reasoning_depth 高的模型
- 多模态任务 -> 自动筛选 multi_modal=True 的模型
- 长上下文任务 -> 自动按 context_window 过滤
- 成本敏感任务 -> 按 cost_tier 过滤与降权

设计上保持对既有架构零侵入：
- ``CapabilityAwareRouter`` 独立可测，不依赖 ProviderManager 实例。
- 通过 ``ProviderManager.set_capability_router(...)`` 可选挂载，未挂载时行为不变。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar

from agent.evolution.llm_capability_detector import LLMCapabilities


@dataclass
class TaskRequirement:
    """一次 Agent 任务对模型能力的诉求（权重 0-1，数值越大越重要）。"""

    needs_reasoning: float = 0.0
    needs_tool_calling: float = 0.0
    needs_code_generation: float = 0.0
    needs_structured_output: float = 0.0
    needs_multi_modal: bool = False
    min_context_window: int = 0
    # 当设置时：仅允许 cost_tier <= max_cost_tier 的 Provider，并对高 cost 降权
    max_cost_tier: float | None = None
    preferred_provider: str | None = None

    # 常用预设，避免调用方手写权重（非 dataclass 字段）
    _PRESETS: ClassVar[dict[str, "TaskRequirement"]] = {}

    @classmethod
    def from_task_type(cls, task_type: str) -> "TaskRequirement":
        presets = {
            "coding": cls(
                needs_reasoning=0.4,
                needs_tool_calling=0.6,
                needs_code_generation=1.0,
                needs_structured_output=0.3,
            ),
            "reasoning": cls(needs_reasoning=1.0, needs_structured_output=0.4),
            "agentic": cls(
                needs_reasoning=0.6,
                needs_tool_calling=1.0,
                needs_code_generation=0.4,
                needs_structured_output=0.5,
            ),
            "vision": cls(needs_multi_modal=True, needs_reasoning=0.4),
            "cheap": cls(max_cost_tier=3.0, needs_reasoning=0.2),
            "long_context": cls(min_context_window=64_000, needs_reasoning=0.3),
        }
        return presets.get(task_type, cls())

    def active_weights(self) -> dict[str, float]:
        w = {
            "reasoning": self.needs_reasoning,
            "tool": self.needs_tool_calling,
            "code": self.needs_code_generation,
            "structured": self.needs_structured_output,
        }
        return {k: v for k, v in w.items() if v > 0}


@dataclass
class ScoredProvider:
    provider: str
    capabilities: LLMCapabilities
    score: float
    reasons: list[str] = field(default_factory=list)


class CapabilityAwareRouter:
    """根据 ``LLMCapabilities`` 为任务挑选最合适的 Provider。"""

    def __init__(self, detector: Any | None = None) -> None:
        self._detector = detector
        # provider_name -> (LLMCapabilities, cost_tier)
        self._registry: dict[str, tuple[LLMCapabilities, float | None]] = {}
        # provider_name -> 动态权重覆写因子（0-1）；由进化联动在能力漂移时写入（U2×U3）
        self._weight_overrides: dict[str, float] = {}

    # ------------------------------------------------------------------ 动态权重覆写
    def override_provider_weight(self, provider: str, factor: float) -> None:
        """设置 Provider 的动态权重覆写因子（0-1）。因子 < 1 会按比例降低其评分。"""
        if factor < 0.0 or factor > 1.0:
            raise ValueError("权重因子必须在 0-1 之间")
        self._weight_overrides[provider] = float(factor)

    def set_provider_degraded(self, provider: str, degraded: bool = True) -> None:
        """将 Provider 标记为能力降级（U2×U3 漂移自愈）：因子降到 0.25 或清除。"""
        if degraded:
            self._weight_overrides[provider] = 0.25
        else:
            self._weight_overrides.pop(provider, None)

    def clear_override(self, provider: str) -> None:
        self._weight_overrides.pop(provider, None)

    def get_override(self, provider: str) -> float | None:
        return self._weight_overrides.get(provider)

    def clear_all_overrides(self) -> None:
        self._weight_overrides.clear()

    # ------------------------------------------------------------------ 注册
    def register(self, provider: str, caps: LLMCapabilities, cost_tier: float | None = None) -> None:
        self._registry[provider] = (caps, cost_tier)

    def register_from_detector(self, providers: list[str], force: bool = False) -> None:
        """借助注入的 ``LLMCapabilityDetector`` 自动检测并注册能力（含成本档位自动推导）。"""
        if self._detector is None:
            raise RuntimeError("CapabilityAwareRouter 未注入 LLMCapabilityDetector")
        import asyncio

        async def _run() -> None:
            for p in providers:
                caps = await self._detector.detect(p, force=force)
                if caps is not None:
                    self.register_auto_cost(p, caps, caps.model_name)

        try:
            asyncio.run(_run())
        except RuntimeError:
            # 已在事件循环中（如作为 Agent 运行的一部分），降级为同步缓存注册
            for p in providers:
                cached = self._detector.get_cached(p)
                if cached is not None:
                    self.register_auto_cost(p, cached, cached.model_name)

    @staticmethod
    def cost_tier_from_pricing(model_name: str, pricing: dict[str, dict[str, float]] | None = None) -> float:
        """由模型单价推导 0-10 成本档位（输出单价越高档位越高）。

        映射：output_price_per_1M / 7.5，封顶 10。未知模型默认 5.0（中性）。
        """
        if pricing is None:
            try:
                from agent.llm.credential_pool import _MODEL_PRICING as pricing  # 懒加载，避免重导入
            except Exception:
                pricing = None
        if not pricing or model_name not in pricing:
            return 5.0
        output_price = pricing[model_name].get("output", 0.0)
        return min(10.0, float(output_price) * 1_000_000 / 7.5)

    def register_auto_cost(
        self,
        provider: str,
        caps: LLMCapabilities,
        model_name: str,
        pricing: dict[str, dict[str, float]] | None = None,
    ) -> None:
        """注册能力并依据单价自动推导 cost_tier（W5）。"""
        cost_tier = self.cost_tier_from_pricing(model_name, pricing)
        self.register(provider, caps, cost_tier=cost_tier)

    def __contains__(self, provider: str) -> bool:
        return provider in self._registry

    # ------------------------------------------------------------------ 评分
    def score(self, provider: str, caps: LLMCapabilities, req: TaskRequirement) -> ScoredProvider | None:
        cost_tier = self._registry[provider][1]
        reasons: list[str] = []

        # 硬约束：多模态
        if req.needs_multi_modal and not caps.multi_modal:
            return ScoredProvider(provider, caps, 0.0, ["不满足多模态要求"])
        # 硬约束：上下文窗口
        if req.min_context_window and caps.context_window < req.min_context_window:
            return ScoredProvider(provider, caps, 0.0, [f"上下文不足 {caps.context_window}<{req.min_context_window}"])
        # 硬约束：成本上限
        if req.max_cost_tier is not None and cost_tier is not None and cost_tier > req.max_cost_tier:
            return ScoredProvider(provider, caps, 0.0, [f"成本档位 {cost_tier} 超上限 {req.max_cost_tier}"])

        weights = req.active_weights()
        if not weights:
            # 无软权重诉求：仅校验硬约束通过即为满分
            return ScoredProvider(provider, caps, 1.0, ["无软性能力诉求，硬约束通过"])

        # 归一化各项能力到 0-1
        comp = {
            "reasoning": min(caps.reasoning_depth, 10) / 10.0,
            "tool": caps.tool_calling_accuracy,
            "code": min(caps.code_generation, 10) / 10.0,
            "structured": caps.structured_output,
        }
        total_w = sum(weights.values())
        score = sum(comp[k] * w for k, w in weights.items()) / total_w

        # 偏好 Provider 轻微加权（不压倒能力）
        if req.preferred_provider == provider:
            score = min(1.0, score + 0.05)
            reasons.append("用户/上游偏好")

        # 成本降权：cost_tier 越高，分数越低
        if req.max_cost_tier is not None and cost_tier is not None:
            penalty = (cost_tier / 10.0) * 0.1
            score = max(0.0, score - penalty)
            reasons.append(f"成本档位 {cost_tier} 轻微降权")

        for k, w in weights.items():
            reasons.append(f"{k} 能力 {comp[k]:.2f} x 权重 {w:.2f}")

        # 动态权重覆写（U2×U3）：能力漂移时由进化联动降低该 Provider 评分
        override = self._weight_overrides.get(provider)
        if override is not None and override != 1.0:
            score = score * override
            reasons.append(f"动态权重覆写 x{override:.2f}（漂移自愈）")

        return ScoredProvider(provider, caps, round(score, 4), reasons)

    # ------------------------------------------------------------------ 选型
    def rank(self, req: TaskRequirement) -> list[ScoredProvider]:
        out: list[ScoredProvider] = []
        for provider, (caps, _cost) in self._registry.items():
            scored = self.score(provider, caps, req)
            if scored is not None and scored.score > 0.0:
                out.append(scored)
        out.sort(key=lambda s: s.score, reverse=True)
        return out

    def select(self, req: TaskRequirement, candidates: list[str] | None = None) -> ScoredProvider | None:
        pool = candidates if candidates is not None else list(self._registry.keys())
        best: ScoredProvider | None = None
        for provider in pool:
            if provider not in self._registry:
                continue
            caps, _ = self._registry[provider]
            scored = self.score(provider, caps, req)
            if scored is None or scored.score <= 0.0:
                continue
            if best is None or scored.score > best.score:
                best = scored
        return best
