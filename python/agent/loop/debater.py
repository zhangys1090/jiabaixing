from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from agent.loop.types import ExecutionPlan, LoopContext, PlanStep


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


@dataclass
class DebaterOutput:
    passed: bool
    vulnerabilities: list[str] = field(default_factory=list)
    improvements: list[str] = field(default_factory=list)
    quality_score: float = 0.0
    debate_rounds: int = 1


class DefaultDebater:
    MAX_DEBATE_ROUNDS = 3
    QUALITY_THRESHOLD = 0.7

    def __init__(self, llm: LLMProtocol | None = None) -> None:
        self.llm = llm

    async def debate(
        self,
        plan: ExecutionPlan,
        input_text: str,
        context: LoopContext | None = None,
    ) -> DebaterOutput:
        if self.llm:
            try:
                return await self._llm_debate(plan, input_text)
            except Exception:
                pass
        return self._rule_based_debate(plan, input_text)

    async def _llm_debate(
        self,
        plan: ExecutionPlan,
        input_text: str,
    ) -> DebaterOutput:
        steps = "\n".join(
            f"{i + 1}. {s.description}"
            + (f" (工具: {s.tool_name})" if s.tool_name else "")
            for i, s in enumerate(plan.steps)
        )

        prompt = (
            "你是一个严格的计划审查员。你的任务是找出以下执行计划中的漏洞和风险。\n\n"
            f"用户需求: {input_text}\n\n"
            f"执行计划:\n{steps}\n\n"
            "请从以下角度审查:\n"
            "1. 步骤是否有遗漏？\n"
            "2. 工具选择是否合理？\n"
            "3. 是否有潜在的错误路径？\n"
            "4. 依赖关系是否正确？\n"
            "5. 是否有更优的执行顺序？\n\n"
            '请用JSON格式输出:\n'
            '{\n'
            '  "passed": true/false,\n'
            '  "vulnerabilities": ["漏洞1", "漏洞2"],\n'
            '  "improvements": ["建议1", "建议2"],\n'
            '  "qualityScore": 0.0-1.0\n'
            '}'
        )

        response = await self.llm.chat(  # type: ignore[union-attr]
            messages=[{"role": "user", "content": prompt}],
            use_cache=False,
        )
        content = response.get("content", "")
        json_match = re.search(r"\{[\s\S]*\}", content)
        if json_match:
            try:
                parsed = json.loads(json_match.group())
                return DebaterOutput(
                    passed=parsed.get("passed", parsed.get("qualityScore", 0) >= self.QUALITY_THRESHOLD),
                    vulnerabilities=parsed.get("vulnerabilities", []),
                    improvements=parsed.get("improvements", []),
                    quality_score=float(parsed.get("qualityScore", 0.5)),
                    debate_rounds=1,
                )
            except (json.JSONDecodeError, ValueError):
                pass

        return self._rule_based_debate(plan, input_text)

    @staticmethod
    def _rule_based_debate(
        plan: ExecutionPlan,
        input_text: str,
    ) -> DebaterOutput:
        vulnerabilities: list[str] = []
        improvements: list[str] = []
        quality_score = 0.8

        if len(plan.steps) == 0:
            vulnerabilities.append("计划没有任何步骤")
            quality_score -= 0.3
        elif len(plan.steps) == 1 and not plan.simple:
            vulnerabilities.append("非简单任务只有1个步骤，可能遗漏了中间步骤")
            quality_score -= 0.1

        steps_without_tool = [
            s for s in plan.steps
            if not s.tool_name
            and "分析" not in s.description
            and "思考" not in s.description
        ]
        if steps_without_tool and len(plan.steps) > 2:
            improvements.append(
                f"步骤 \"{steps_without_tool[0].description}\" 没有指定工具，建议明确使用什么工具"
            )
            quality_score -= 0.05

        input_keywords = input_text.lower().split()
        plan_text = " ".join(s.description.lower() for s in plan.steps)
        relevant = sum(1 for kw in input_keywords if len(kw) > 2 and kw in plan_text)
        total_kw = sum(1 for kw in input_keywords if len(kw) > 2)
        if total_kw > 0 and relevant < total_kw * 0.3:
            vulnerabilities.append("计划与用户需求的相关性较低，可能偏离了目标")
            quality_score -= 0.15

        quality_score = max(0.0, min(1.0, quality_score))

        return DebaterOutput(
            passed=quality_score >= 0.7 and len(vulnerabilities) == 0,
            vulnerabilities=vulnerabilities,
            improvements=improvements,
            quality_score=quality_score,
            debate_rounds=1,
        )
