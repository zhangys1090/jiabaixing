from __future__ import annotations

import re
from typing import Any

from agent.core.logger import StructuredLogger
from agent.llm.provider import LLMProvider
from agent.loop.types import (
    BudgetState,
    ExecutionPlan,
    LoopContext,
    PlanStep,
)
from agent.tools.registry import ToolRegistry

log = StructuredLogger("planner")


class Planner:
    def __init__(
        self,
        llm: LLMProvider,
        tool_registry: ToolRegistry | None = None,
    ) -> None:
        self.llm = llm
        self._tool_registry = tool_registry
        self._reflection_insight: str | None = None

    def set_tool_registry(self, registry: ToolRegistry) -> None:
        self._tool_registry = registry

    def inject_reflection_insight(self, insight: str) -> None:
        self._reflection_insight = insight

    async def plan(self, input_text: str, context: LoopContext) -> ExecutionPlan:
        complexity = await self._analyze_complexity_semantic(input_text)
        if complexity == "simple":
            return ExecutionPlan(
                steps=[
                    PlanStep(
                        step_id="direct",
                        description=f"直接回答: {input_text[:100]}",
                    )
                ],
                simple=True,
                reasoning="简单任务，跳过规划",
            )

        return await self._plan_complex(input_text, context, complexity)

    def _analyze_complexity(self, text: str) -> str:
        score = self._keyword_complexity_score(text)

        if score >= 3:
            return "complex"
        elif score >= 1:
            return "moderate"
        return "simple"

    async def _analyze_complexity_semantic(self, text: str) -> str:
        """语义化复杂度分析: 先用快速正则预判，仅对中等复杂度任务调用 LLM。

        优化策略（省 LLM 调用）：
        - 短文本（<15字符）且无关键词 → 直接判定 simple，不调 LLM
        - 高复杂度关键词命中 ≥3 → 直接判定 complex，不调 LLM
        - 其他情况 → 调用 LLM 精确判断
        """
        # 快速预判：超短文本直接 simple
        stripped = text.strip()
        if len(stripped) < 15 and not re.search(r'[?？!！]', stripped):
            return "simple"

        # 快速预判：高关键词命中直接 complex
        keyword_score = self._keyword_complexity_score(text)
        if keyword_score >= 3:
            return "complex"

        # 边界情况：1-2 个关键词 → 用 LLM 精确判断
        prompt = (
            "判断以下用户任务的复杂度等级。只回复一个词: simple / moderate / complex\n\n"
            "判断标准:\n"
            "- simple: 单一问题，可直接回答\n"
            "- moderate: 需要1-2步操作或简单工具调用\n"
            "- complex: 需要多步骤、多工具协作、或需要分析推理\n\n"
            f"用户任务: {text[:500]}"
        )
        try:
            result = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=True,
            )
            content = result.get("content", "").strip().lower()
            if "complex" in content:
                return "complex"
            elif "moderate" in content:
                return "moderate"
            return "simple"
        except Exception:
            return self._analyze_complexity(text)

    def _keyword_complexity_score(self, text: str) -> int:
        complex_indicators = [
            r"分析",
            r"对比",
            r"设计",
            r"实现",
            r"优化",
            r"重构",
            r"迁移",
            r"集成",
            r"部署",
            r"多个",
            r"所有",
            r"分别",
            r"步骤",
            r"流程",
            r"搜索",
            r"查找",
            r"读取",
            r"修改",
            r"执行",
            r"运行",
        ]
        return sum(1 for p in complex_indicators if re.search(p, text))

    async def _plan_complex(
        self,
        input_text: str,
        context: LoopContext,
        complexity: str,
    ) -> ExecutionPlan:
        max_steps = 5 if complexity == "complex" else 3
        tool_catalog = self._build_tool_catalog()

        system_content = (
            "你是一个任务规划专家。将用户任务分解为具体步骤。\n"
            "输出格式：每行一个步骤，格式为 '步骤ID: 描述 [工具名]'\n"
            f"最多 {max_steps} 个步骤。\n\n"
            "# 可用工具列表\n"
            "为每个步骤选择最合适的工具。如果不需要工具，可以省略 [工具名]。\n\n"
            f"{tool_catalog}"
        )

        messages = [
            {"role": "system", "content": system_content},
        ]

        if self._reflection_insight:
            messages.append({"role": "system", "content": self._reflection_insight})
            self._reflection_insight = None

        messages.append({"role": "user", "content": f"请规划以下任务：{input_text}"})

        result = await self.llm.chat(messages=messages, use_cache=False)
        content = result.get("content", "")

        steps = self._parse_steps(content, max_steps)
        if not steps:
            steps = [PlanStep(step_id="direct", description=input_text[:200])]

        steps = self._validate_tool_names(steps)

        return ExecutionPlan(
            steps=steps,
            simple=False,
            reasoning=content[:500],
            tool_call_mode="auto",
            recommended_tools=[s.tool_name for s in steps if s.tool_name],
        )

    def _build_tool_catalog(self) -> str:
        if not self._tool_registry:
            return "（工具注册表未初始化，请根据任务描述推断合适的工具名）"

        definitions = self._tool_registry.get_all_definitions()
        if not definitions:
            return "（无可用工具）"

        by_category: dict[str, list[str]] = {}
        for d in definitions:
            cat = d.category.value if hasattr(d.category, "value") else str(d.category)
            by_category.setdefault(cat, []).append(f"{d.name}: {d.description}")

        lines: list[str] = []
        for cat, tools in sorted(by_category.items()):
            lines.append(f"## {cat}")
            for t in tools:
                lines.append(f"  - {t}")
            lines.append("")

        return "\n".join(lines)

    def _validate_tool_names(self, steps: list[PlanStep]) -> list[PlanStep]:
        if not self._tool_registry:
            return steps

        valid_names = {d.name for d in self._tool_registry.get_all_definitions()}

        for step in steps:
            if step.tool_name and step.tool_name not in valid_names:
                closest = self._find_closest_tool(step.tool_name, valid_names)
                if closest:
                    log.info(
                        "Corrected tool name",
                        original=step.tool_name,
                        corrected=closest,
                    )
                    step.tool_name = closest
                else:
                    log.warning("Unknown tool, removing", tool=step.tool_name)
                    step.tool_name = None

        return steps

    def _find_closest_tool(self, name: str, valid_names: set[str]) -> str | None:
        name_lower = name.lower().replace("-", "_").replace(" ", "_")
        for valid in valid_names:
            valid_lower = valid.lower().replace("-", "_").replace(" ", "_")
            if name_lower == valid_lower:
                return valid
        for valid in valid_names:
            if name_lower in valid.lower() or valid.lower() in name_lower:
                return valid
        return None

    def _parse_steps(self, content: str, max_steps: int) -> list[PlanStep]:
        steps: list[PlanStep] = []
        lines = content.strip().split("\n")
        for line in lines:
            line = line.strip()
            if not line:
                continue

            match = re.match(
                r"(?:步骤\s*)?(\d+)[.:：)\s]+(.+?)(?:\s*\[(.+?)\])?\s*$", line
            )
            if match:
                step_num = int(match.group(1))
                desc = match.group(2).strip()
                tool = match.group(3)
                steps.append(
                    PlanStep(
                        step_id=f"step_{step_num}",
                        description=desc,
                        tool_name=tool,
                    )
                )
            elif len(steps) < max_steps and len(line) > 5:
                steps.append(
                    PlanStep(
                        step_id=f"step_{len(steps) + 1}",
                        description=line,
                    )
                )

            if len(steps) >= max_steps:
                break

        return steps

    async def replan(
        self,
        input_text: str,
        context: LoopContext,
        original_plan: ExecutionPlan,
        failed_steps: list[dict[str, Any]],
        root_cause: str | None = None,
    ) -> ExecutionPlan:
        completed_ids = {
            sr.step_id
            for sr in context.step_results.values()
            if sr.success
        }
        # 已完成步骤：保持不动（增量重规划核心）
        completed_steps = [
            s for s in original_plan.steps
            if s.step_id in completed_ids
        ]
        remaining_steps = [
            s for s in original_plan.steps
            if s.step_id not in completed_ids
        ]

        if not remaining_steps and not failed_steps:
            return original_plan

        failure_summary = "\n".join(
            f"- 步骤{f.get('step_id', '?')}: {f.get('error', '未知错误')}"
            for f in failed_steps
        )

        completed_summary = "\n".join(
            f"- 步骤{sr.step_id}: {sr.content[:150] if sr.content else '完成'}"
            for sr in context.step_results.values()
            if sr.success
        ) if context.step_results else "无"

        # 剩余步骤摘要
        remaining_summary = "\n".join(
            f"- 步骤{s.step_id}: {s.description[:100]}"
            for s in remaining_steps
        ) if remaining_steps else "无"

        tool_catalog = self._build_tool_catalog()

        messages = [
            {
                "role": "system",
                "content": (
                    "你是一个任务规划专家，正在**增量修正**执行计划。\n"
                    "已完成步骤保持不动，只补充修正后的剩余步骤。\n"
                    "=== 规则 ===\n"
                    "1. 只输出需要**新增或替换**的步骤（已完成的不输出）\n"
                    "2. 输出格式：每行一个步骤，格式为 '步骤ID: 描述 [工具名]'\n"
                    "3. 最多5个新步骤\n"
                    "4. 步骤ID请用 'incr_N' 格式（N从0开始）\n\n"
                    f"# 可用工具列表\n{tool_catalog}"
                ),
            },
        ]

        if self._reflection_insight:
            messages.append({"role": "system", "content": self._reflection_insight})
            self._reflection_insight = None

        messages.append(
            {
                "role": "user",
                "content": (
                    f"原始任务：{input_text}\n\n"
                    f"✅ 已完成步骤：\n{completed_summary}\n\n"
                    f"❌ 失败步骤：\n{failure_summary}\n\n"
                    f"⏳ 待完成步骤：\n{remaining_summary}\n\n"
                    f"根因分析：{root_cause or '未提供'}\n\n"
                    f"请只输出修正后需要执行的步骤（已完成的不输出）："
                ),
            },
        )

        result = await self.llm.chat(messages=messages, use_cache=False)
        content = result.get("content", "")

        new_steps = self._parse_steps(content, 5)
        if not new_steps:
            new_steps = remaining_steps

        new_steps = self._validate_tool_names(new_steps)

        # 增量合并：已完成步骤 + 新生成步骤
        merged_steps = list(completed_steps) + new_steps

        return ExecutionPlan(
            steps=merged_steps,
            simple=False,
            reasoning=f"增量重规划: {content[:300]}",
            tool_call_mode="auto",
            recommended_tools=[s.tool_name for s in new_steps if s.tool_name],
        )
