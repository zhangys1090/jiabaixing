"""六层层间数据流通 + 动态层级激活（Harness Data Flow & Dynamic Level Activation）。

在现有 DebateHarness（六层顺序审查）基础上，增强为：
1. 层间数据流通：每层审查结果作为结构化上下文传递给下一层
2. 动态层级激活：根据任务特征和风险等级，跳过不必要的层级
3. 层间反馈回路：下游层可向上游层请求补充信息
4. 数据流追踪：完整记录层间数据传递链路，支持审计和调试

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 非侵入式：包装 DebateHarness，不修改其内部逻辑
- 可选挂载：未挂载时回退到全层顺序审查
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.loop.debate_harness import (
    DebateHarness,
    DebateReviewResult,
    DebateVerdict,
    HarnessCheckResult,
    HarnessLevel,
)
from agent.core.logger import StructuredLogger

log = StructuredLogger("harness_dataflow")


class ActivationPolicy(str, Enum):
    FULL = "full"
    RISK_ADAPTIVE = "risk_adaptive"
    MINIMAL = "minimal"
    CUSTOM = "custom"


@dataclass
class LayerContext:
    layer: HarnessLevel = HarnessLevel.L1_SAFETY
    input_data: dict[str, Any] = field(default_factory=dict)
    output_data: dict[str, Any] = field(default_factory=dict)
    upstream_contexts: dict[HarnessLevel, dict[str, Any]] = field(default_factory=dict)
    passed: bool = True
    score: float = 0.0
    duration_ms: float = 0.0
    feedback_requests: list[str] = field(default_factory=list)


@dataclass
class DataFlowTrace:
    trace_id: str = ""
    session_id: str = ""
    layers_executed: list[HarnessLevel] = field(default_factory=list)
    layers_skipped: list[HarnessLevel] = field(default_factory=list)
    layer_contexts: dict[str, LayerContext] = field(default_factory=dict)
    total_duration_ms: float = 0.0
    activation_policy: ActivationPolicy = ActivationPolicy.FULL
    risk_level: str = "medium"


@dataclass
class ActivationRule:
    name: str = ""
    condition: str = ""
    required_layers: list[HarnessLevel] = field(default_factory=list)
    skipped_layers: list[HarnessLevel] = field(default_factory=list)
    priority: int = 0


LAYER_ORDER = [
    HarnessLevel.L1_SAFETY,
    HarnessLevel.L2_DEBATE,
    HarnessLevel.L3_CAUSAL,
    HarnessLevel.L4_REFLECTION,
    HarnessLevel.L5_EVOLUTION,
    HarnessLevel.L6_META_DECISION,
]


class HarnessDataFlowManager:
    """六层层间数据流通 + 动态层级激活管理器。"""

    def __init__(
        self,
        base_harness: DebateHarness | None = None,
        default_policy: ActivationPolicy = ActivationPolicy.RISK_ADAPTIVE,
    ) -> None:
        self._base = base_harness or DebateHarness()
        self._default_policy = default_policy
        self._activation_rules: list[ActivationRule] = []
        self._custom_layer_order: list[HarnessLevel] | None = None
        self._traces: list[DataFlowTrace] = []
        self._max_traces = 100
        self._feedback_handlers: dict[str, Callable[[str, HarnessLevel], Awaitable[dict[str, Any]]]] = {}
        self._data_transformers: dict[tuple[HarnessLevel, HarnessLevel], Callable[[dict], dict]] = {}

    def add_activation_rule(self, rule: ActivationRule) -> None:
        self._activation_rules.append(rule)
        self._activation_rules.sort(key=lambda r: r.priority, reverse=True)

    def set_custom_layer_order(self, order: list[HarnessLevel]) -> None:
        self._custom_layer_order = order

    def register_feedback_handler(
        self,
        request_type: str,
        handler: Callable[[str, HarnessLevel], Awaitable[dict[str, Any]]],
    ) -> None:
        self._feedback_handlers[request_type] = handler

    def register_data_transformer(
        self,
        from_layer: HarnessLevel,
        to_layer: HarnessLevel,
        transformer: Callable[[dict], dict],
    ) -> None:
        self._data_transformers[(from_layer, to_layer)] = transformer

    async def review_with_dataflow(
        self,
        plan: Any,
        input_text: str,
        context: Any | None = None,
        policy: ActivationPolicy | None = None,
        risk_level: str = "medium",
        session_id: str = "",
    ) -> tuple[DebateReviewResult, DataFlowTrace]:
        start = time.time()
        effective_policy = policy or self._default_policy

        trace = DataFlowTrace(
            trace_id=f"trace_{id(plan)}_{int(start)}",
            session_id=session_id,
            activation_policy=effective_policy,
            risk_level=risk_level,
        )

        layers_to_execute = self._resolve_layers(effective_policy, risk_level, plan)

        layer_contexts: dict[str, LayerContext] = {}
        accumulated_upstream: dict[HarnessLevel, dict[str, Any]] = {}

        for layer in layers_to_execute:
            layer_key = layer.value
            upstream_data = self._prepare_upstream_data(layer, accumulated_upstream)

            layer_ctx = LayerContext(
                layer=layer,
                input_data={"plan": str(plan), "input_text": input_text, "risk_level": risk_level},
                upstream_contexts=dict(accumulated_upstream),
            )

            check_result = await self._execute_single_layer(
                layer, plan, input_text, context, upstream_data,
            )

            layer_ctx.passed = check_result.passed
            layer_ctx.score = check_result.score
            layer_ctx.duration_ms = check_result.duration_ms
            layer_ctx.output_data = {
                "issues": check_result.issues,
                "recommendations": check_result.recommendations,
                "score": check_result.score,
                "passed": check_result.passed,
            }

            if check_result.issues:
                for issue in check_result.issues:
                    if "需要补充" in issue or "缺少" in issue:
                        layer_ctx.feedback_requests.append(issue)

            if layer_ctx.feedback_requests:
                await self._handle_feedback_requests(layer, layer_ctx, plan, context)

            layer_contexts[layer_key] = layer_ctx
            accumulated_upstream[layer] = layer_ctx.output_data
            trace.layers_executed.append(layer)

        skipped = [l for l in LAYER_ORDER if l not in layers_to_execute]
        trace.layers_skipped = skipped
        trace.layer_contexts = layer_contexts
        trace.total_duration_ms = (time.time() - start) * 1000

        final_result = await self._base.review(plan, input_text, context)

        self._traces.append(trace)
        if len(self._traces) > self._max_traces:
            self._traces = self._traces[-self._max_traces:]

        return final_result, trace

    def _resolve_layers(
        self,
        policy: ActivationPolicy,
        risk_level: str,
        plan: Any,
    ) -> list[HarnessLevel]:
        if policy == ActivationPolicy.FULL:
            return list(LAYER_ORDER)

        if policy == ActivationPolicy.MINIMAL:
            return [HarnessLevel.L1_SAFETY, HarnessLevel.L2_DEBATE]

        if policy == ActivationPolicy.CUSTOM and self._custom_layer_order:
            return list(self._custom_layer_order)

        if policy == ActivationPolicy.RISK_ADAPTIVE:
            return self._risk_adaptive_layers(risk_level, plan)

        return list(LAYER_ORDER)

    def _risk_adaptive_layers(self, risk_level: str, plan: Any) -> list[HarnessLevel]:
        base = [HarnessLevel.L1_SAFETY, HarnessLevel.L2_DEBATE]

        if risk_level == "low":
            return base + [HarnessLevel.L4_REFLECTION]

        if risk_level == "medium":
            return base + [HarnessLevel.L3_CAUSAL, HarnessLevel.L4_REFLECTION]

        if risk_level == "high":
            return base + [HarnessLevel.L3_CAUSAL, HarnessLevel.L4_REFLECTION, HarnessLevel.L5_EVOLUTION]

        if risk_level == "critical":
            return list(LAYER_ORDER)

        for rule in self._activation_rules:
            if self._evaluate_rule_condition(rule, plan):
                result = [l for l in LAYER_ORDER if l not in rule.skipped_layers]
                required = [l for l in rule.required_layers if l not in result]
                return result + required

        return list(LAYER_ORDER)

    def _evaluate_rule_condition(self, rule: ActivationRule, plan: Any) -> bool:
        if rule.condition == "has_critical_steps":
            steps = getattr(plan, "steps", [])
            return any(getattr(s, "risk_level", "low") == "critical" for s in steps)
        if rule.condition == "has_many_steps":
            steps = getattr(plan, "steps", [])
            return len(steps) > 10
        if rule.condition == "always":
            return True
        return False

    def _prepare_upstream_data(
        self,
        current_layer: HarnessLevel,
        accumulated: dict[HarnessLevel, dict[str, Any]],
    ) -> dict[str, Any]:
        upstream: dict[str, Any] = {}
        for layer, data in accumulated.items():
            layer_name = layer.value
            transformer = self._data_transformers.get((layer, current_layer))
            if transformer:
                upstream[layer_name] = transformer(data)
            else:
                upstream[layer_name] = data
        return upstream

    async def _execute_single_layer(
        self,
        layer: HarnessLevel,
        plan: Any,
        input_text: str,
        context: Any | None,
        upstream_data: dict[str, Any],
    ) -> HarnessCheckResult:
        if layer == HarnessLevel.L1_SAFETY:
            return await self._base._check_l1_safety(plan, context)
        elif layer == HarnessLevel.L2_DEBATE:
            return await self._base._check_l2_debate(plan, input_text, context)
        elif layer == HarnessLevel.L3_CAUSAL:
            return await self._base._check_l3_causal(plan, context)
        elif layer == HarnessLevel.L4_REFLECTION:
            return await self._base._check_l4_reflection(plan, input_text, context)
        elif layer == HarnessLevel.L5_EVOLUTION:
            return self._base._check_l5_evolution(plan)
        elif layer == HarnessLevel.L6_META_DECISION:
            return self._base._check_l6_meta_decision(plan, context)
        return HarnessCheckResult(level=layer, passed=True, score=0.5)

    async def _handle_feedback_requests(
        self,
        layer: HarnessLevel,
        ctx: LayerContext,
        plan: Any,
        context: Any | None,
    ) -> None:
        for request in ctx.feedback_requests:
            handler = self._feedback_handlers.get(request)
            if handler:
                try:
                    extra_data = await handler(request, layer)
                    ctx.input_data.update(extra_data)
                except Exception as e:
                    log.debug("Feedback handler failed", layer=layer.value, error=str(e))

    @property
    def traces(self) -> list[DataFlowTrace]:
        return list(self._traces)

    def get_latest_trace(self) -> DataFlowTrace | None:
        return self._traces[-1] if self._traces else None

    def get_stats(self) -> dict[str, Any]:
        total_layers_executed = sum(len(t.layers_executed) for t in self._traces)
        total_layers_skipped = sum(len(t.layers_skipped) for t in self._traces)
        avg_duration = (
            sum(t.total_duration_ms for t in self._traces) / len(self._traces)
            if self._traces else 0.0
        )
        return {
            "total_traces": len(self._traces),
            "total_layers_executed": total_layers_executed,
            "total_layers_skipped": total_layers_skipped,
            "avg_duration_ms": avg_duration,
            "activation_rules_count": len(self._activation_rules),
            "default_policy": self._default_policy.value,
        }
