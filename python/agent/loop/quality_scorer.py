from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class QualityDimensions:
    """多维质量评分的各个维度。"""
    tool_success_rate: float = 0.0       # 工具执行成功率
    plan_completion_rate: float = 0.0    # 计划完成率
    efficiency_score: float = 0.5        # 效率评分（轮数/步骤越少越好）
    reflection_value: float = 0.0        # 反思价值（是否有有效反思产出）
    context_relevance: float = 0.5       # 上下文相关性（注意力聚焦得分）


@dataclass
class QualityReport:
    """综合质量报告。"""
    overall_score: float = 0.0
    dimensions: QualityDimensions = field(default_factory=QualityDimensions)
    weights: dict[str, float] = field(default_factory=lambda: {
        "tool_success_rate": 0.30,
        "plan_completion_rate": 0.25,
        "efficiency_score": 0.20,
        "reflection_value": 0.10,
        "context_relevance": 0.15,
    })
    breakdown: dict[str, float] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)


class BuiltInQualityScorer:
    """内置多维质量评分器。

    不依赖 LLM，基于以下维度自动计算质量分：
    1. 工具成功率 (30%) — 各步骤工具执行的成功率
    2. 计划完成率 (25%) — 实际执行步数 / 计划步数
    3. 效率评分 (20%) — 轮数和步骤数越少的归一化评分
    4. 反思价值 (10%) — 反思引擎是否产出了有效经验/替代方案
    5. 上下文相关性 (15%) — 注意力聚焦后的上下文集中度
    """

    def __init__(
        self,
        max_expected_rounds: int = 5,
        max_expected_steps_per_round: int = 8,
    ) -> None:
        self.max_expected_rounds = max_expected_rounds
        self.max_expected_steps = max_expected_steps_per_round

    def score(
        self,
        *,
        step_results: dict[str, Any],
        planned_steps: int = 0,
        rounds_used: int = 1,
        reflection_experiences: int = 0,
        context_message_count: int = 0,
        attention_scores: list[float] | None = None,
    ) -> QualityReport:
        dims = QualityDimensions()

        # 1. 工具成功率
        if step_results:
            successes = sum(1 for r in step_results.values() if getattr(r, 'success', False))
            dims.tool_success_rate = successes / len(step_results)
        else:
            dims.tool_success_rate = 0.0

        # 2. 计划完成率
        if planned_steps > 0:
            actual_steps = len(step_results)
            ratio = actual_steps / planned_steps
            dims.plan_completion_rate = min(1.0, max(0.0, 1.0 - abs(ratio - 1.0)))
        else:
            dims.plan_completion_rate = 0.5

        # 3. 效率评分
        steps_per_round = len(step_results) / max(rounds_used, 1)
        if steps_per_round <= self.max_expected_steps:
            round_efficiency = 1.0 - (rounds_used / max(self.max_expected_rounds, 1))
        else:
            round_efficiency = 0.3
        dims.efficiency_score = max(0.0, min(1.0, round_efficiency))

        # 4. 反思价值
        dims.reflection_value = min(1.0, reflection_experiences / 10.0)

        # 5. 上下文相关性
        if attention_scores and len(attention_scores) > 0:
            dims.context_relevance = sum(attention_scores) / len(attention_scores)
        elif context_message_count <= 10:
            dims.context_relevance = 1.0 - (context_message_count / 50.0)
        else:
            dims.context_relevance = max(0.0, 1.0 - (context_message_count - 10) / 40.0)

        # 加权总分
        w = {"tool_success_rate": 0.30, "plan_completion_rate": 0.25,
             "efficiency_score": 0.20, "reflection_value": 0.10,
             "context_relevance": 0.15}
        overall = (
            dims.tool_success_rate * w["tool_success_rate"]
            + dims.plan_completion_rate * w["plan_completion_rate"]
            + dims.efficiency_score * w["efficiency_score"]
            + dims.reflection_value * w["reflection_value"]
            + dims.context_relevance * w["context_relevance"]
        )

        report = QualityReport(
            overall_score=round(overall, 4),
            dimensions=dims,
            weights=w,
            breakdown={
                "tool_success_rate": round(dims.tool_success_rate, 4),
                "plan_completion_rate": round(dims.plan_completion_rate, 4),
                "efficiency_score": round(dims.efficiency_score, 4),
                "reflection_value": round(dims.reflection_value, 4),
                "context_relevance": round(dims.context_relevance, 4),
            },
        )
        return report
