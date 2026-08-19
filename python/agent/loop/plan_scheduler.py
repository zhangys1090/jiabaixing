"""统一规划调度器 — 统一调度 Planner / ToT / Incremental 三大规划器。

设计目标：
1. 统一入口：所有规划请求经 PlanScheduler 调度，消除散落调用
2. 规划器互连：ToT 多候选 → 主 Planner 精炼 → Incremental 增量修正
3. 感知驱动：接收 PerceptionState，影响规划策略选择
4. 复杂度自适应：根据任务复杂度和感知状态自动选择规划路径

规划路径：
- simple → 直接执行（无规划）
- moderate → 主 Planner 单步规划
- complex → ToT 多候选 → 评分 → 最优方案 → 主 Planner 精炼
- replan → Incremental 增量修正（保留已完成步骤）

互连协议：
- ToT 输出 CandidatePlan → 转换为 ExecutionPlan → 主 Planner 可精炼
- 主 Planner 输出 ExecutionPlan → 执行后失败 → Incremental 增量修正
- PerceptionState → 注入规划上下文 → 影响工具选择和步骤编排

Usage:
    scheduler = PlanScheduler(llm=llm, tool_registry=registry)
    plan = await scheduler.schedule(input_text, context)
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.loop.types import (
    ExecutionPlan,
    LoopContext,
    PlanStep,
)
from agent.tools.registry import ToolRegistry
from agent.llm.provider import LLMProvider

log = StructuredLogger("plan_scheduler")


class PlanStrategy(str, Enum):
    DIRECT = "direct"
    SINGLE_PASS = "single_pass"
    TOT_REFINE = "tot_refine"
    INCREMENTAL = "incremental"


@dataclass
class ScheduleDecision:
    strategy: PlanStrategy
    complexity: str
    perception_influenced: bool = False
    tot_candidates: int = 0
    refine_rounds: int = 0
    duration_ms: float = 0.0


@dataclass
class PlanSchedulerConfig:
    tot_enabled: bool = True
    tot_max_candidates: int = 3
    refine_enabled: bool = True
    refine_max_rounds: int = 1
    perception_injection_enabled: bool = True
    max_steps_simple: int = 1
    max_steps_moderate: int = 3
    max_steps_complex: int = 5


class PlanScheduler:
    def __init__(
        self,
        llm: LLMProvider,
        tool_registry: ToolRegistry | None = None,
        memory_engine: Any | None = None,
        config: PlanSchedulerConfig | None = None,
    ) -> None:
        self._llm = llm
        self._tool_registry = tool_registry
        self._memory_engine = memory_engine
        self._config = config or PlanSchedulerConfig(
            tot_enabled=os.environ.get("PLAN_TOT_ENABLED", "true").lower() == "true",
        )

        self._planner: Any | None = None
        self._tot_planner: Any | None = None
        self._incremental_planner: Any | None = None
        self._scene_tool_selector: Any | None = None
        self._last_decision: ScheduleDecision | None = None

        self._init_sub_planners()
        self._init_scene_tool_selector()

    def _init_sub_planners(self) -> None:
        try:
            from agent.loop.planner import Planner
            self._planner = Planner(
                llm=self._llm,
                tool_registry=self._tool_registry,
                memory_engine=self._memory_engine,
            )
        except Exception as e:
            log.warning("Planner init failed", error=str(e))

        if self._config.tot_enabled:
            try:
                from agent.loop.tot_planner import TreeOfThoughtsPlanner, TotConfig
                self._tot_planner = TreeOfThoughtsPlanner(
                    llm=self._llm,
                    tot_config=TotConfig(
                        enabled=True,
                        enable_task_nature_analysis=True,
                        max_candidates=self._config.tot_max_candidates,
                    ),
                )
            except Exception as e:
                log.warning("ToT Planner init failed", error=str(e))

        try:
            from agent.loop.incremental_planner import IncrementalPlanner
            self._incremental_planner = IncrementalPlanner()
        except Exception as e:
            log.warning("IncrementalPlanner init failed", error=str(e))

    def _init_scene_tool_selector(self) -> None:
        if self._tool_registry:
            try:
                from agent.tools.scene_tool_selector import SceneToolSelector
                self._scene_tool_selector = SceneToolSelector(self._tool_registry)
            except Exception as e:
                log.debug("SceneToolSelector init failed", error=str(e))

    def set_tool_registry(self, registry: ToolRegistry) -> None:
        self._tool_registry = registry
        if self._planner:
            self._planner.set_tool_registry(registry)
        if self._scene_tool_selector:
            self._scene_tool_selector.set_tool_registry(registry)

    def set_memory_engine(self, engine: Any) -> None:
        self._memory_engine = engine
        if self._planner:
            self._planner.set_memory_engine(engine)

    def inject_reflection_insight(self, insight: str) -> None:
        if self._planner:
            self._planner.inject_reflection_insight(insight)

    @property
    def last_decision(self) -> ScheduleDecision | None:
        return self._last_decision

    async def schedule(
        self,
        input_text: str,
        context: LoopContext,
    ) -> ExecutionPlan:
        start = time.time()

        complexity = await self._assess_complexity(input_text, context)

        perception_text = ""
        if self._config.perception_injection_enabled and context.perception_state:
            perception_text = context.perception_state.to_prompt_text() if hasattr(context.perception_state, "to_prompt_text") else ""

        if complexity == "simple":
            decision = ScheduleDecision(
                strategy=PlanStrategy.DIRECT,
                complexity=complexity,
                perception_influenced=bool(perception_text),
                duration_ms=(time.time() - start) * 1000,
            )
            self._last_decision = decision
            return ExecutionPlan(
                steps=[PlanStep(step_id="direct", description=f"直接回答: {input_text[:100]}")],
                simple=True,
                reasoning="简单任务，跳过规划",
            )

        if complexity == "moderate":
            plan = await self._plan_single_pass(input_text, context, perception_text)
            decision = ScheduleDecision(
                strategy=PlanStrategy.SINGLE_PASS,
                complexity=complexity,
                perception_influenced=bool(perception_text),
                duration_ms=(time.time() - start) * 1000,
            )
            self._last_decision = decision
            return plan

        plan = await self._plan_tot_refine(input_text, context, perception_text)
        decision = ScheduleDecision(
            strategy=PlanStrategy.TOT_REFINE,
            complexity=complexity,
            perception_influenced=bool(perception_text),
            tot_candidates=self._config.tot_max_candidates,
            refine_rounds=self._config.refine_max_rounds if self._config.refine_enabled else 0,
            duration_ms=(time.time() - start) * 1000,
        )
        self._last_decision = decision
        return plan

    async def replan(
        self,
        input_text: str,
        context: LoopContext,
        original_plan: ExecutionPlan,
        failed_steps: list[dict[str, Any]],
        root_cause: str | None = None,
    ) -> ExecutionPlan:
        start = time.time()

        if self._incremental_planner and self._planner:
            plan = await self._planner.replan(
                input_text, context, original_plan, failed_steps, root_cause,
            )
        else:
            plan = await self._fallback_replan(
                input_text, context, original_plan, failed_steps, root_cause,
            )

        decision = ScheduleDecision(
            strategy=PlanStrategy.INCREMENTAL,
            complexity="replan",
            duration_ms=(time.time() - start) * 1000,
        )
        self._last_decision = decision
        return plan

    async def _assess_complexity(
        self,
        input_text: str,
        context: LoopContext,
    ) -> str:
        if context.perception_state:
            scene = getattr(context.perception_state, "scene", None)
            if scene and hasattr(scene, "scene_type"):
                complex_scenes = {"multi_step", "automation", "debugging", "refactoring"}
                if scene.scene_type in complex_scenes:
                    return "complex"
            emotion = getattr(context.perception_state, "emotion", None)
            if emotion and hasattr(emotion, "emotion_type"):
                uncertain_emotions = {"frustrated", "anxious"}
                if emotion.emotion_type in uncertain_emotions:
                    pass

        if self._scene_tool_selector and context.perception_state:
            try:
                recommendations = self._scene_tool_selector.select(
                    input_text, context.perception_state, limit=3,
                )
                if recommendations:
                    top_risk = recommendations[0].risk_level
                    if top_risk in ("high", "critical"):
                        return "complex"
                    if len(recommendations) > 1 and all(r.capability_level >= 2 for r in recommendations[:2]):
                        return "complex"
            except Exception as _exc:
                log_ignored(log, "plan_scheduler.PlanScheduler._assess_complexity", _exc)

        if self._planner:
            try:
                return await self._planner._analyze_complexity_semantic(input_text)
            except Exception as _exc:
                log_ignored(log, "plan_scheduler.PlanScheduler._assess_complexity", _exc)

        return self._keyword_complexity(input_text)

    def _keyword_complexity(self, text: str) -> str:
        import re
        complex_indicators = [
            r"分析", r"对比", r"设计", r"实现", r"优化", r"重构",
            r"迁移", r"集成", r"部署", r"多个", r"所有", r"分别",
            r"步骤", r"流程", r"搜索", r"查找", r"读取", r"修改",
            r"执行", r"运行",
        ]
        score = sum(1 for p in complex_indicators if re.search(p, text))
        if score >= 3:
            return "complex"
        elif score >= 1:
            return "moderate"
        return "simple"

    async def _plan_single_pass(
        self,
        input_text: str,
        context: LoopContext,
        perception_text: str,
    ) -> ExecutionPlan:
        if self._planner is None:
            return ExecutionPlan(
                steps=[PlanStep(step_id="direct", description=input_text[:200])],
                simple=True,
            )

        if perception_text and self._planner._reflection_insight is None:
            self._planner.inject_reflection_insight(
                f"【感知上下文】{perception_text[:500]}"
            )

        return await self._planner.plan(input_text, context)

    async def _plan_tot_refine(
        self,
        input_text: str,
        context: LoopContext,
        perception_text: str,
    ) -> ExecutionPlan:
        if self._tot_planner is None or self._planner is None:
            return await self._plan_single_pass(input_text, context, perception_text)

        try:
            tot_plan, tot_meta = await self._tot_planner.plan_with_tot(input_text, context)

            if tot_plan and tot_plan.steps:
                log.info(
                    "ToT planning succeeded",
                    candidates=tot_meta.candidate_count if tot_meta else 0,
                    strategy=tot_meta.selected_strategy if tot_meta else "fallback",
                )

                if self._config.refine_enabled and self._planner:
                    refined = await self._refine_plan(tot_plan, input_text, context, perception_text)
                    if refined and refined.steps:
                        return refined

                return tot_plan

        except Exception as e:
            log.warning("ToT planning failed, falling back", error=str(e))

        return await self._plan_single_pass(input_text, context, perception_text)

    async def _refine_plan(
        self,
        tot_plan: ExecutionPlan,
        input_text: str,
        context: LoopContext,
        perception_text: str,
    ) -> ExecutionPlan | None:
        try:
            steps_summary = "\n".join(
                f"- 步骤{s.step_id}: {s.description} [{s.tool_name or '无工具'}]"
                for s in tot_plan.steps
            )

            refine_prompt = (
                f"以下是由 Tree-of-Thoughts 生成的初始规划，请精炼优化：\n\n"
                f"原始任务: {input_text[:300]}\n\n"
                f"初始规划:\n{steps_summary}\n\n"
            )

            if perception_text:
                refine_prompt += f"当前感知状态:\n{perception_text[:300]}\n\n"

            refine_prompt += (
                "请检查并优化：\n"
                "1. 步骤顺序是否合理\n"
                "2. 工具选择是否最优\n"
                "3. 是否有冗余步骤\n"
                "4. 感知信息是否已被充分利用\n\n"
                "输出精炼后的步骤列表，格式: 步骤ID: 描述 [工具名]"
            )

            result = await self._llm.chat(
                messages=[{"role": "user", "content": refine_prompt}],
                use_cache=True,
                task_type="reasoning",
            )
            content = result.get("content", "")

            if content.strip():
                refined_steps = self._planner._parse_steps(content, len(tot_plan.steps) + 2)
                if refined_steps:
                    refined_steps = self._planner._validate_tool_names(refined_steps)
                    refined_steps = self._planner._annotate_risk(refined_steps)
                    return ExecutionPlan(
                        steps=refined_steps,
                        reasoning=f"ToT精炼: {content[:500]}",
                        tool_call_mode="auto",
                        recommended_tools=[s.tool_name for s in refined_steps if s.tool_name],
                    )

        except Exception as e:
            log.debug("Plan refinement failed", error=str(e))

        return None

    async def _fallback_replan(
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

        system_msg = (
            "你是任务重规划专家。以下任务执行中部分步骤失败，请重新规划剩余步骤。\n"
            f"失败步骤:\n{failure_summary}\n"
            f"根因: {root_cause or '未知'}\n"
            f"已完成步骤: {len(completed_steps)} 个\n"
            "输出格式: 步骤ID: 描述 [工具名]"
        )

        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": f"请重新规划: {input_text[:300]}"},
        ]

        try:
            result = await self._llm.chat(messages=messages, use_cache=False, task_type="reasoning")
            content = result.get("content", "")
            steps = self._planner._parse_steps(content, 5) if self._planner else []
            if not steps:
                steps = [PlanStep(step_id="retry", description=input_text[:200])]
            if self._planner:
                steps = self._planner._validate_tool_names(steps)
                steps = self._planner._annotate_risk(steps)
            return ExecutionPlan(
                steps=steps,
                reasoning=f"重规划: {content[:500]}",
                tool_call_mode="auto",
                recommended_tools=[s.tool_name for s in steps if s.tool_name],
            )
        except Exception as e:
            log.warning("Fallback replan failed", error=str(e))
            return original_plan
