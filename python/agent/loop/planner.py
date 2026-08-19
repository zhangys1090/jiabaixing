from __future__ import annotations

import os
import re
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.llm.provider import LLMProvider
from agent.loop.types import (
    BudgetState,
    ExecutionPlan,
    LoopContext,
    PlanStep,
)
from agent.tools.registry import ToolRegistry
from agent.tools.risk_level import classify_risk, requires_approval
from agent.loop.tot_planner import TreeOfThoughtsPlanner, TotConfig
from agent.loop.incremental_planner import IncrementalPlanner

log = StructuredLogger("planner")


class Planner:
    def __init__(
        self,
        llm: LLMProvider,
        tool_registry: ToolRegistry | None = None,
        memory_engine: Any | None = None,
    ) -> None:
        self.llm = llm
        self._tool_registry = tool_registry
        self._reflection_insight: str | None = None
        self._memory_engine = memory_engine
        # P0 接线修复：接入 TreeOfThoughtsPlanner，此前完全孤立（0 调用点）
        _tot_enabled = os.environ.get("TOT_PLANNER_ENABLED", "true").lower() == "true"
        self._tot_planner: TreeOfThoughtsPlanner | None = None
        if _tot_enabled:
            self._tot_planner = TreeOfThoughtsPlanner(
                llm=llm,
                tot_config=TotConfig(
                    enabled=True,
                    enable_task_nature_analysis=True,
                    max_candidates=3,
                ),
            )
        # F2: 接入 IncrementalPlanner，replan 时增量修正而非全量重做
        self._incremental_planner = IncrementalPlanner()
        # Phase 2: 场景感知工具选择器 — 基于感知状态推荐最佳工具
        self._scene_tool_selector: Any | None = None
        if tool_registry:
            try:
                from agent.tools.scene_tool_selector import SceneToolSelector
                self._scene_tool_selector = SceneToolSelector(tool_registry)
            except Exception as _e:
                log.debug("SceneToolSelector init failed", error=str(_e))

    def set_memory_engine(self, engine: Any) -> None:
        """设置记忆引擎，用于主动检索历史经验。"""
        self._memory_engine = engine

    def set_tool_registry(self, registry: ToolRegistry) -> None:
        self._tool_registry = registry
        if self._scene_tool_selector:
            self._scene_tool_selector.set_tool_registry(registry)
        elif not self._scene_tool_selector:
            try:
                from agent.tools.scene_tool_selector import SceneToolSelector
                self._scene_tool_selector = SceneToolSelector(registry)
            except Exception as _exc:
                log_ignored(log, "planner.Planner.set_tool_registry", _exc)

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
        """语义化复杂度分析: 使用 LLM 判断任务复杂度。"""
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
                task_type="cheap",
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
        # P0 接线修复：complex 任务优先使用 Tree of Thoughts 多候选规划
        # 此前 TotPlanner 完全孤立，complex 任务的 ToT 能力从未被启用
        if complexity == "complex" and self._tot_planner is not None:
            try:
                tot_plan, tot_meta = await self._tot_planner.plan_with_tot(input_text, context)
                if tot_plan.steps:
                    log.info(
                        "ToT planning succeeded",
                        candidates=tot_meta.candidate_count if tot_meta else 0,
                        strategy=tot_meta.selected_strategy if tot_meta else "fallback",
                    )
                    return tot_plan
                log.debug("ToT returned empty plan, falling back to standard planning")
            except Exception as e:
                log.warning("ToT planning failed, falling back", error=str(e))

        max_steps = 5 if complexity == "complex" else 3
        tool_catalog = self._build_tool_catalog()

        # Phase 2: 场景感知工具推荐 — 基于感知状态推荐最佳工具
        scene_recommendation = ""
        if self._scene_tool_selector and context.perception_state:
            try:
                recommendations = self._scene_tool_selector.select(
                    input_text, context.perception_state, limit=5,
                )
                if recommendations:
                    rec_lines = ["【场景感知工具推荐】"]
                    for rec in recommendations:
                        rec_lines.append(
                            f"  - {rec.tool_name} (评分:{rec.score:.2f}, 原因:{rec.reason}, "
                            f"风险:{rec.risk_level}, 能力:L{rec.capability_level})"
                        )
                    scene_recommendation = "\n".join(rec_lines)
                    log.info(
                        "Scene-aware tool recommendation",
                        top_tool=recommendations[0].tool_name,
                        score=recommendations[0].score,
                        scene=self._scene_tool_selector._detect_scene(context.perception_state),
                    )
            except Exception as e:
                log.debug("Scene tool selection failed (non-blocking)", error=str(e))

        # P0-2: 主动记忆检索 — 在规划前注入相似任务经验
        experience_injection = ""
        if self._memory_engine:
            try:
                memories = await self._memory_engine.search_with_context(
                    query=input_text,
                    limit=3,
                    use_recency_decay=True,
                    use_knowledge_graph=False,
                )
                if memories:
                    experience_lines = ["【历史经验参考】"]
                    for m in memories[:3]:
                        content_preview = (m.get("content", "") or "")[:200]
                        score = m.get("relevance_score", 0)
                        experience_lines.append(f"  - 相关度{score:.2f}: {content_preview}")
                    experience_injection = "\n".join(experience_lines)
                    log.info(
                        "Proactive memory retrieval",
                        results=len(memories),
                        injection=len(experience_injection),
                    )
            except Exception as e:
                log.debug("Memory retrieval failed (non-blocking)", error=str(e))

        system_content = (
            "你是一个任务规划专家。将用户任务分解为具体步骤。\n"
            "输出格式：每行一个步骤，格式为 '步骤ID: 描述 [工具名]'\n"
            f"最多 {max_steps} 个步骤。\n\n"
            "# 可用工具列表\n"
            "为每个步骤选择最合适的工具。如果不需要工具，可以省略 [工具名]。\n\n"
            f"{tool_catalog}"
        )

        if experience_injection:
            system_content += f"\n\n{experience_injection}"

        if scene_recommendation:
            system_content += f"\n\n{scene_recommendation}"

        messages = [
            {"role": "system", "content": system_content},
        ]

        if self._reflection_insight:
            messages.append({"role": "system", "content": self._reflection_insight})
            self._reflection_insight = None

        messages.append({"role": "user", "content": f"请规划以下任务：{input_text}"})

        result = await self.llm.chat(messages=messages, use_cache=False, task_type="reasoning")
        content = result.get("content", "")

        steps = self._parse_steps(content, max_steps)
        if not steps:
            steps = [PlanStep(step_id="direct", description=input_text[:200])]

        steps = self._validate_tool_names(steps)
        steps = self._annotate_risk(steps)

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

    def _annotate_risk(self, steps: list[PlanStep]) -> list[PlanStep]:
        """规划阶段即按风险拆分「需审批/可自动」步骤。

        依据工具注册中心的风险等级为每一步标注 ``risk_level`` 与
        ``requires_approval``，使前端确认 UI 与执行前审批流可在生成阶段
        拿到完整的待审批清单，而非等到执行时才逐个拦截。
        """
        if not self._tool_registry:
            return steps
        for step in steps:
            if not step.tool_name:
                continue
            risk = classify_risk(self._tool_registry, step.tool_name)
            step.risk_level = risk
            step.requires_approval = requires_approval(risk)
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
        # F2: 优先使用增量重规划 — 仅修正受影响部分，保留已完成步骤
        completed_ids = {
            sr.step_id
            for sr in context.step_results.values()
            if sr.success
        }
        if completed_ids and self._incremental_planner:
            try:
                changed_step_id = failed_steps[0].get("step_id", "") if failed_steps else ""
                # 类型适配：将 types.PlanStep 转为 incremental_planner.PlanStep
                from agent.loop.incremental_planner import PlanStep as IncrPlanStep
                incr_steps = [
                    IncrPlanStep(
                        step_id=s.step_id,
                        description=s.description,
                        tool_name=s.tool_name or "",
                        params=s.tool_params or {},
                        status="completed" if s.step_id in completed_ids else "pending",
                    )
                    for s in original_plan.steps
                ]
                incr_result = self._incremental_planner.incremental_replan(
                    original_plan=incr_steps,
                    trigger_step_id=changed_step_id,
                    reason=root_cause or "步骤失败",
                )
                if incr_result.success and incr_result.new_plan:
                    new_steps = [
                        PlanStep(
                            step_id=ps.step_id,
                            description=ps.description,
                            tool_name=ps.tool_name,
                            tool_params=ps.params,
                        )
                        for ps in incr_result.new_plan
                        if ps.status != "completed"
                    ]
                    if new_steps:
                        log.info(
                            "Incremental replan succeeded",
                            changes=len(incr_result.changes),
                            new_steps=len(new_steps),
                        )
                        return ExecutionPlan(
                            steps=self._annotate_risk(new_steps),
                            reasoning=f"增量重规划：{len(incr_result.changes)} 处变更",
                        )
            except Exception as e:
                log.debug("Incremental replan failed, falling back to full", error=str(e))

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

        result = await self.llm.chat(messages=messages, use_cache=False, task_type="reasoning")
        content = result.get("content", "")

        new_steps = self._parse_steps(content, 5)
        if not new_steps:
            new_steps = remaining_steps

        new_steps = self._validate_tool_names(new_steps)
        new_steps = self._annotate_risk(new_steps)

        # 增量合并：已完成步骤 + 新生成步骤
        merged_steps = list(completed_steps) + new_steps

        return ExecutionPlan(
            steps=merged_steps,
            simple=False,
            reasoning=f"增量重规划: {content[:300]}",
            tool_call_mode="auto",
            recommended_tools=[s.tool_name for s in new_steps if s.tool_name],
        )
