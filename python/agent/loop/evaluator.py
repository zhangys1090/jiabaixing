from __future__ import annotations

import json
import re
from typing import Any

from agent.llm.provider import LLMProvider
from agent.loop.types import (
    EvaluatorOutput,
    LoopContext,
    StepResult,
)


class Evaluator:
    def __init__(self, llm: LLMProvider) -> None:
        self.llm = llm

    async def evaluate(
        self,
        input_text: str,
        context: LoopContext,
    ) -> EvaluatorOutput:
        step_success_rate = self._calc_step_success_rate(context)

        if not context.step_results:
            return EvaluatorOutput(
                goal_progress=0.0,
                suggested_action="continue",
                reason="尚无执行结果",
                step_success_rate=0.0,
            )

        try:
            return await self._llm_evaluate(input_text, context, step_success_rate)
        except Exception:
            return self._rule_evaluate(context, step_success_rate)

    async def _llm_evaluate(
        self,
        input_text: str,
        context: LoopContext,
        step_success_rate: float,
    ) -> EvaluatorOutput:
        steps_summary: list[str] = []
        for sid, sr in context.step_results.items():
            status = "✅" if sr.success else "❌"
            steps_summary.append(
                f"  {status} {sid}: {sr.content[:100] if sr.content else (sr.error or '无输出')}"
            )

        prompt = (
            "你是任务评估专家。请评估以下任务执行的完成度。\n\n"
            f"用户目标: {input_text}\n"
            f"已执行步骤:\n" + "\n".join(steps_summary) + "\n\n"
            "请返回 JSON:\n"
            "{\n"
            '  "goalProgress": 0.0-1.0,\n'
            '  "suggestedAction": "continue" | "replan" | "abort",\n'
            '  "reason": "评估原因",\n'
            '  "qualityScore": 0.0-1.0,\n'
            '  "failureAnalysis": "失败分析（如有）",\n'
            '  "suggestedCorrection": "修正建议（如有）"\n'
            "}"
        )

        result = await self.llm.chat(
            messages=[{"role": "user", "content": prompt}],
            use_cache=False,
        )
        content = result.get("content", "")
        parsed = self._parse_json(content)

        if parsed:
            return EvaluatorOutput(
                goal_progress=float(parsed.get("goalProgress", 0.5)),
                suggested_action=parsed.get("suggestedAction", "continue"),
                reason=parsed.get("reason", "LLM 评估"),
                quality_score=float(parsed.get("qualityScore", 0.5)),
                step_success_rate=step_success_rate,
                failure_analysis=parsed.get("failureAnalysis"),
                suggested_correction=parsed.get("suggestedCorrection"),
            )

        return self._rule_evaluate(context, step_success_rate)

    def _rule_evaluate(
        self,
        context: LoopContext,
        step_success_rate: float,
    ) -> EvaluatorOutput:
        total = len(context.step_results)
        successful = sum(1 for r in context.step_results.values() if r.success)

        if total == 0:
            progress = 0.0
        elif successful == total:
            progress = 1.0
        else:
            progress = successful / total

        if progress >= 0.8:
            action = "continue"
            reason = f"目标进展良好 ({progress:.0%})"
        elif progress >= 0.5:
            action = "continue"
            reason = f"目标进展中等 ({progress:.0%})，继续执行"
        elif progress >= 0.3:
            action = "replan"
            reason = f"目标进展不足 ({progress:.0%})，建议重新规划"
        else:
            action = "replan"
            reason = f"目标进展过低 ({progress:.0%})，需要重新规划"

        return EvaluatorOutput(
            goal_progress=progress,
            suggested_action=action,
            reason=reason,
            quality_score=progress,
            step_success_rate=step_success_rate,
        )

    def _calc_step_success_rate(self, context: LoopContext) -> float:
        if not context.step_results:
            return 0.0
        total = len(context.step_results)
        successful = sum(1 for r in context.step_results.values() if r.success)
        return successful / total

    def _parse_json(self, text: str) -> dict[str, Any] | None:
        match = re.search(r'\{[\s\S]*\}', text)
        if not match:
            return None
        try:
            return json.loads(match.group())
        except (json.JSONDecodeError, ValueError):
            return None
