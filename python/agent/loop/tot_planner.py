from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from agent.loop.types import ExecutionPlan, LoopContext, PlanStep
from agent.core.logger import log_ignored


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


@dataclass
class TotConfig:
    enabled: bool = True
    enable_task_nature_analysis: bool = False
    max_candidates: int = 3


@dataclass
class CandidatePlan:
    strategy: str
    reasoning: str
    steps: list[dict[str, Any]] = field(default_factory=list)
    dependencies: dict[str, list[str]] = field(default_factory=dict)
    estimated_rounds: int = 3
    feasibility_score: float = 0.0


@dataclass
class TaskNature:
    essence: str = ""
    task_type: str = ""
    key_constraints: list[str] = field(default_factory=list)
    risk_points: list[str] = field(default_factory=list)
    recommended_strategy: str = ""
    complexity: str = "moderate"


@dataclass
class TotMeta:
    candidate_count: int = 0
    selected_rank: int = 0
    selected_strategy: str = ""
    evaluations: list[dict[str, Any]] = field(default_factory=list)


class TreeOfThoughtsPlanner:
    def __init__(
        self,
        llm: LLMProtocol | None = None,
        tot_config: TotConfig | None = None,
    ) -> None:
        self.llm = llm
        self.config = tot_config or TotConfig()

    async def plan_with_tot(
        self,
        input_text: str,
        context: LoopContext | None = None,
    ) -> tuple[ExecutionPlan, TotMeta | None]:
        if not self.config.enabled:
            return ExecutionPlan(steps=[], reasoning="ToT 已禁用"), None

        if not self.llm:
            return ExecutionPlan(steps=[], reasoning="无 LLM 可用，ToT 需要 LLM"), None

        task_nature: TaskNature | None = None
        if self.config.enable_task_nature_analysis:
            task_nature = await self._analyze_task_nature(input_text)

        candidates = await self._generate_candidates(input_text, task_nature)
        if not candidates:
            return ExecutionPlan(steps=[], reasoning="未能生成候选计划"), None

        if len(candidates) == 1:
            best = candidates[0]
            meta = TotMeta(candidate_count=1, selected_rank=0, selected_strategy=best.strategy)
            return self._candidate_to_plan(best), meta

        evaluations = await self._evaluate_candidates(candidates, input_text)
        best_idx = max(range(len(evaluations)), key=lambda i: evaluations[i].get("score", 0))
        best = candidates[best_idx]

        meta = TotMeta(
            candidate_count=len(candidates),
            selected_rank=best_idx,
            selected_strategy=best.strategy,
            evaluations=evaluations,
        )
        return self._candidate_to_plan(best), meta

    async def _analyze_task_nature(self, input_text: str) -> TaskNature:
        if not self.llm:
            return TaskNature()

        prompt = (
            f"分析以下任务的本质:\n{input_text}\n\n"
            '请用JSON格式输出:\n'
            '{\n'
            '  "essence": "任务本质",\n'
            '  "taskType": "任务类型",\n'
            '  "keyConstraints": ["约束1"],\n'
            '  "riskPoints": ["风险1"],\n'
            '  "recommendedStrategy": "推荐策略",\n'
            '  "complexity": "simple/moderate/complex"\n'
            '}'
        )
        try:
            response = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")
            json_match = re.search(r"\{[\s\S]*\}", content)
            if json_match:
                parsed = json.loads(json_match.group())
                return TaskNature(
                    essence=parsed.get("essence", ""),
                    task_type=parsed.get("taskType", ""),
                    key_constraints=parsed.get("keyConstraints", []),
                    risk_points=parsed.get("riskPoints", []),
                    recommended_strategy=parsed.get("recommendedStrategy", ""),
                    complexity=parsed.get("complexity", "moderate"),
                )
        except Exception as _exc:
            log_ignored(None, "tot_planner.TreeOfThoughtsPlanner._analyze_task_nature", _exc)
        return TaskNature()

    async def _generate_candidates(
        self,
        input_text: str,
        task_nature: TaskNature | None = None,
    ) -> list[CandidatePlan]:
        if not self.llm:
            return []

        analysis_section = ""
        if task_nature and task_nature.essence:
            analysis_section = (
                f"\n【任务本质】{task_nature.essence}\n"
                f"【任务类型】{task_nature.task_type}\n"
                f"【关键约束】{', '.join(task_nature.key_constraints) or '无'}\n"
                f"【风险点】{', '.join(task_nature.risk_points) or '无'}\n"
                f"【推荐策略】{task_nature.recommended_strategy or '无'}\n"
            )

        prompt = (
            f"为以下复杂任务生成多个候选执行计划（至少2个）。\n\n"
            f"任务: \"{input_text}\"\n"
            f"{analysis_section}\n"
            '请用以下JSON格式输出:\n'
            '{\n'
            '  "candidates": [\n'
            '    {\n'
            '      "strategy": "策略名称",\n'
            '      "reasoning": "选择此策略的推理过程",\n'
            '      "steps": [{"id": "s1", "description": "步骤描述", "toolName": "工具名(可选)"}],\n'
            '      "dependencies": {"s2": ["s1"]},\n'
            '      "estimatedRounds": 3\n'
            '    }\n'
            '  ]\n'
            '}'
        )

        try:
            response = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")
            json_match = re.search(r"\{[\s\S]*\}", content)
            if not json_match:
                return []

            parsed = json.loads(json_match.group())
            raw_candidates = parsed.get("candidates", [])

            if not raw_candidates and parsed.get("steps"):
                raw_candidates = [{
                    "strategy": "默认方案",
                    "reasoning": parsed.get("reasoning", "多步骤执行"),
                    "steps": parsed["steps"],
                    "dependencies": parsed.get("dependencies", {}),
                    "estimatedRounds": parsed.get("estimatedRounds", 4),
                }]

            candidates: list[CandidatePlan] = []
            for raw in raw_candidates[:self.config.max_candidates]:
                candidates.append(CandidatePlan(
                    strategy=raw.get("strategy", "默认"),
                    reasoning=raw.get("reasoning", ""),
                    steps=raw.get("steps", []),
                    dependencies=raw.get("dependencies", {}),
                    estimated_rounds=raw.get("estimatedRounds", 3),
                ))
            return candidates
        except Exception:
            return []

    async def _evaluate_candidates(
        self,
        candidates: list[CandidatePlan],
        input_text: str,
    ) -> list[dict[str, Any]]:
        if not self.llm:
            return [{"score": 1.0 / (i + 1)} for i in range(len(candidates))]

        candidates_text = "\n".join(
            f"候选{i + 1}: {c.strategy} - {c.reasoning}"
            for i, c in enumerate(candidates)
        )

        prompt = (
            f"请评估以下候选执行计划的可行性。\n\n"
            f"任务: \"{input_text}\"\n\n"
            f"候选计划:\n{candidates_text}\n\n"
            '请用JSON格式输出:\n'
            '{\n'
            '  "evaluations": [\n'
            '    {"candidateIndex": 0, "feasibilityScore": 0.0-1.0, "reasoning": "评估理由"},\n'
            '    {"candidateIndex": 1, "feasibilityScore": 0.0-1.0, "reasoning": "评估理由"}\n'
            '  ]\n'
            '}'
        )

        try:
            response = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")
            json_match = re.search(r"\{[\s\S]*\}", content)
            if json_match:
                parsed = json.loads(json_match.group())
                evals = parsed.get("evaluations", [])
                if evals:
                    return [{"score": e.get("feasibilityScore", 0.5), "reasoning": e.get("reasoning", "")} for e in evals]
        except Exception as _exc:
            log_ignored(None, "tot_planner.TreeOfThoughtsPlanner._evaluate_candidates", _exc)

        return [{"score": 0.5} for _ in candidates]

    @staticmethod
    def _candidate_to_plan(candidate: CandidatePlan) -> ExecutionPlan:
        steps: list[PlanStep] = []
        for i, s in enumerate(candidate.steps):
            steps.append(PlanStep(
                step_id=s.get("id", f"step_{i + 1}"),
                description=s.get("description", ""),
                tool_name=s.get("toolName"),
            ))
        return ExecutionPlan(
            steps=steps,
            reasoning=candidate.reasoning,
            simple=False,
            recommended_tools=[s.tool_name for s in steps if s.tool_name],
        )
