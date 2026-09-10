from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.llm.provider import LLMProvider
from agent.loop.reflection_knowledge_base import (
    ExperienceType,
    ReflectionExperience,
    ReflectionKnowledgeBase,
)
from agent.core.otel_tracer import otel_trace
from opentelemetry import trace as _otel_trace_api
log = StructuredLogger("reflection")


ERROR_CATEGORIES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"ENOENT|not found|找不到|不存在", re.I), "not_found"),
    (re.compile(r"EACCES|EPERM|permission|权限|拒绝访问", re.I), "permission"),
    (re.compile(r"timeout|ETIMEDOUT|超时", re.I), "timeout"),
    (re.compile(r"network|ECONNREFUSED|网络|连接", re.I), "network"),
    (re.compile(r"syntax|parse|语法|解析", re.I), "syntax"),
    (re.compile(r"empty|null|空", re.I), "empty"),
]


@dataclass
class ReflectionResult:
    root_cause: str
    corrected_args: dict[str, Any] | None = None
    alternative_tool: str | None = None
    should_retry: bool = True


@dataclass
class DeepReflectionResult:
    diagnosis: str
    root_cause: str
    fix_strategy: str
    corrected_plan: list[dict[str, Any]] | None = None


@dataclass
class TaskReflectionInput:
    user_input: str
    task_goal: str
    execution_trace: list[dict[str, Any]] = field(default_factory=list)
    failures: list[dict[str, Any]] = field(default_factory=list)
    goal_progress: float = 0.0
    rounds_used: int = 0


@dataclass
class TaskReflectionResult:
    task_diagnosis: str
    root_cause: str
    strategy_adjustment: str
    corrected_plan: list[dict[str, Any]] | None = None
    lessons_learned: str = ""
    confidence: float = 0.5


@dataclass
class ExperienceEntry:
    tool_name: str
    args: dict[str, Any]
    error: str
    root_cause: str
    resolution: str
    success: bool
    timestamp: float = 0.0


@dataclass
class TaskReflectionExperience:
    user_input: str
    task_goal: str
    task_diagnosis: str
    root_cause: str
    strategy_adjustment: str
    lessons_learned: str
    confidence: float
    success: bool
    timestamp: float = 0.0


@dataclass
class SuccessReflectionResult:
    """成功反思结果。

    总结成功经验，提取可复用的模式和最佳实践。
    """
    success_pattern: str
    key_insight: str
    reusable_tips: list[str] = field(default_factory=list)
    confidence: float = 0.8


@dataclass
class LightweightReflectionResult:
    """轻量级反思结果。

    每轮执行后的快速反思，不阻塞主流程。
    """
    reflection_type: str  # "success" | "failure" | "partial"
    quick_insight: str
    key_learning: str = ""
    duration_ms: float = 0.0


@dataclass
class ReflectionMetrics:
    total_reflections: int = 0
    retry_success_rate: float = 0.0
    deep_reflection_success_rate: float = 0.0
    experience_reuse_rate: float = 0.0
    experience_record_count: int = 0
    task_reflections: int = 0
    task_reflection_success_rate: float = 0.0
    success_reflections: int = 0
    lightweight_reflections: int = 0
    avg_lightweight_reflection_ms: float = 0.0
    meta_reflections: int = 0
    meta_reflection_improvements: int = 0


@dataclass
class MetaReflectionResult:
    reflection_quality: float
    identified_blind_spots: list[str]
    suggested_improvements: list[str]
    should_adjust_strategy: bool
    adjusted_params: dict[str, Any]


class ReflectionEngine:
    def __init__(
        self,
        llm: LLMProvider | None = None,
        enable_deep_reflection: bool = True,
        max_experience_records: int = 100,
        knowledge_base: Optional[ReflectionKnowledgeBase] = None,
        enable_kb: bool | None = None,
    ) -> None:
        if llm is None:
            from agent.llm.provider import LLMProvider as _LP
            llm = _LP()
        self.llm = llm
        self.enable_deep_reflection = enable_deep_reflection
        self.max_experience_records = max_experience_records
        self._experience_buffer: list[ExperienceEntry] = []
        self._task_reflection_buffer: list[TaskReflectionExperience] = []
        self._MAX_METRICS = 500
        self._metrics = {
            "total_reflections": 0,
            "deep_reflections": 0,
            "deep_reflection_successes": 0,
            "experience_reuses": 0,
            "task_reflections": 0,
            "task_reflection_successes": 0,
            # 新增：成功反思统计
            "success_reflections": 0,
            "lightweight_reflections": 0,
            "lightweight_reflection_total_ms": 0.0,
        }

        # 轻量级反思配置 — P0 修复：默认启用，确保每轮自动反思实际生效
        self._lightweight_enabled = os.environ.get("LIGHTWEIGHT_REFLECTION_ENABLED", "true").lower() == "true"
        self._lightweight_max_ms = float(os.environ.get("LIGHTWEIGHT_REFLECTION_MAX_MS", "500"))

        # 反思知识库（可选）
        self._kb = knowledge_base
        if enable_kb is not None:
            self._kb_enabled = enable_kb
        else:
            # P0 修复：默认启用反思知识库，提升经验复用率
            self._kb_enabled = os.environ.get("REFLECTION_KB_ENABLED", "true").lower() == "true"
        self._logger = StructuredLogger("reflection_engine")

        if self._kb_enabled and not self._kb:
            try:
                self._kb = ReflectionKnowledgeBase()
                self._logger.info("Reflection knowledge base initialized")
            except Exception as e:
                self._logger.warning("Failed to initialize knowledge base", error=str(e))
                self._kb = None

        # 情景记忆存储（可选，由 engine.py 注入）
        self._episodic_store: Any = None

    @otel_trace("loop.reflection")
    async def reflect(
        self,
        tool_name: str,
        args: dict[str, Any],
        error: str,
        context: dict[str, Any] | None = None,
    ) -> ReflectionResult:
        self._metrics["total_reflections"] += 1
        ctx = context or {}
        similar = self.get_relevant_experiences(tool_name, error, 3)

        # OTel span 属性：反思类型
        try:
            _otel_trace_api.get_current_span().set_attribute("reflection_type", "failure")
        except Exception as _exc:
            log.warning("reflection 异常处理", error=str(_exc))
            log_ignored(None, "reflection.ReflectionEngine.reflect", _exc)

        prompt = self._build_reflect_prompt(tool_name, args, error, ctx, similar)
        try:
            response = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")
            parsed = self._parse_json_response(content)

            if parsed:
                if similar:
                    self._metrics["experience_reuses"] += 1
                # OTel span 属性：反思成功
                try:
                    _otel_trace_api.get_current_span().set_attribute("success", True)
                except Exception as _exc:
                    log.warning("reflection 异常处理", error=str(_exc))
                    log_ignored(None, "reflection.ReflectionEngine.reflect", _exc)
                return ReflectionResult(
                    root_cause=parsed.get("rootCause", f"{tool_name} 执行失败"),
                    corrected_args=parsed.get("correctedArgs"),
                    alternative_tool=parsed.get("alternativeTool"),
                    should_retry=parsed.get("shouldRetry", True),
                )

            # 存储失败反思到情景记忆
            if self._episodic_store:
                try:
                    self._episodic_store.store(
                        content=f"失败反思: {tool_name} → {error[:100]}",
                        scene="work",
                        emotion="sad",
                        importance=6.0,
                        tags=["reflection_failure", tool_name],
                        metadata={"tool_name": tool_name, "error": error[:200]},
                    )
                except Exception as _exc:
                    log.warning("reflection 异常处理", error=str(_exc))
                    log_ignored(None, "reflection.ReflectionEngine.reflect", _exc)

            return self._fallback_reflect(tool_name, error)
        except Exception as _exc:
            log.warning("reflection 异常被捕获", error=str(_exc))
            # OTel span 属性：反思失败
            try:
                _otel_trace_api.get_current_span().set_attribute("success", False)
            except Exception as _exc:
                log.warning("reflection 异常处理", error=str(_exc))
                log_ignored(None, "reflection.ReflectionEngine.reflect", _exc)
            return self._fallback_reflect(tool_name, error)

    @otel_trace("loop.reflection")
    async def deep_reflect(
        self,
        user_input: str,
        trajectory: list[dict[str, Any]],
        eval_result: dict[str, Any],
    ) -> DeepReflectionResult:
        if not self.enable_deep_reflection:
            return DeepReflectionResult(
                diagnosis="深度反思已禁用",
                root_cause="未启用深度反思",
                fix_strategy="启用 enable_deep_reflection 以获取深度分析",
            )

        self._metrics["deep_reflections"] += 1
        prompt = self._build_deep_reflect_prompt(user_input, trajectory, eval_result)

        # OTel span 属性：反思类型
        try:
            _otel_trace_api.get_current_span().set_attribute("reflection_type", "deep")
        except Exception as _exc:
            log.warning("reflection 异常处理", error=str(_exc))
            log_ignored(None, "reflection.ReflectionEngine.deep_reflect", _exc)

        try:
            response = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")
            parsed = self._parse_json_response(content)

            if parsed and parsed.get("diagnosis"):
                self._metrics["deep_reflection_successes"] += 1
                # OTel span 属性：深度反思成功
                try:
                    _otel_trace_api.get_current_span().set_attribute("success", True)
                except Exception as _exc:
                    log.warning("reflection 异常处理", error=str(_exc))
                    log_ignored(None, "reflection.ReflectionEngine.deep_reflect", _exc)
                return DeepReflectionResult(
                    diagnosis=parsed.get("diagnosis", "未知诊断"),
                    root_cause=parsed.get("rootCause", "未知"),
                    fix_strategy=parsed.get("fixStrategy", "重新规划"),
                    corrected_plan=parsed.get("correctedPlan"),
                )

            return self._fallback_deep_reflect(trajectory, eval_result)
        except Exception as _exc:
            log.warning("reflection 异常被捕获", error=str(_exc))
            # OTel span 属性：深度反思失败
            try:
                _otel_trace_api.get_current_span().set_attribute("success", False)
            except Exception as _exc:
                log.warning("reflection 异常处理", error=str(_exc))
                log_ignored(None, "reflection.ReflectionEngine.deep_reflect", _exc)
            return self._fallback_deep_reflect(trajectory, eval_result)

    async def reflect_on_task_failure(
        self,
        task_input: TaskReflectionInput,
    ) -> TaskReflectionResult:
        self._metrics["task_reflections"] += 1
        prompt = self._build_task_reflect_prompt(task_input)

        try:
            response = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")
            parsed = self._parse_json_response(content)

            if parsed and parsed.get("taskDiagnosis"):
                self._metrics["task_reflection_successes"] += 1
                result = TaskReflectionResult(
                    task_diagnosis=parsed.get("taskDiagnosis", "诊断"),
                    root_cause=parsed.get("rootCause", "未知根因"),
                    strategy_adjustment=parsed.get("strategyAdjustment", "调整策略"),
                    corrected_plan=parsed.get("correctedPlan"),
                    lessons_learned=parsed.get("lessonsLearned", ""),
                    confidence=float(parsed.get("confidence", 0.5)),
                )
                self._record_task_experience(task_input, result, True)
                return result

            return self._fallback_task_reflect(task_input)
        except Exception as _exc:
            log.warning("reflection 异常被捕获", error=str(_exc))
            return self._fallback_task_reflect(task_input)

    async def reflect_on_success(
        self,
        tool_name: str,
        args: dict[str, Any],
        result: str,
        context: dict[str, Any] | None = None,
    ) -> SuccessReflectionResult:
        """对成功执行进行反思，总结成功经验。

        从成功的工具执行中提取可复用的模式和最佳实践。
        轻量级实现，优先使用规则化分析，LLM作为增强。

        Args:
            tool_name: 工具名称。
            args: 工具参数。
            result: 执行结果。
            context: 上下文信息。

        Returns:
            SuccessReflectionResult: 成功反思结果。
        """
        self._metrics["success_reflections"] += 1
        ctx = context or {}

        # 快速路径：规则化分析（不调用LLM，确保<500ms）
        pattern = self._extract_success_pattern(tool_name, args, result)
        insight = self._generate_success_insight(tool_name, args, result)
        tips = self._generate_reusable_tips(tool_name, args, result)

        # 记录成功经验到知识库
        self._record_success_experience(tool_name, args, result, pattern, insight)

        # 存储成功反思到情景记忆
        if self._episodic_store:
            try:
                self._episodic_store.store(
                    content=f"成功经验: {tool_name} → {insight[:100]}",
                    scene="work",
                    emotion="happy",
                    importance=7.0,
                    tags=["reflection_success", tool_name],
                    metadata={"tool_name": tool_name, "pattern": pattern, "tips_count": len(tips)},
                )
            except Exception as _exc:
                log.warning("reflection 异常处理", error=str(_exc))
                log_ignored(None, "reflection.ReflectionEngine.reflect_on_success", _exc)

        return SuccessReflectionResult(
            success_pattern=pattern,
            key_insight=insight,
            reusable_tips=tips,
            confidence=0.7,
        )

    async def lightweight_reflect(
        self,
        tool_name: str,
        success: bool,
        args: dict[str, Any] | None = None,
        result: str = "",
        error: str = "",
        context: dict[str, Any] | None = None,
    ) -> LightweightReflectionResult:
        """轻量级反思，每轮执行后调用。

        设计目标：<500ms完成，不阻塞主流程。
        优先使用规则化分析，必要时才调用LLM。

        Args:
            tool_name: 工具名称。
            success: 是否成功。
            args: 工具参数。
            result: 成功结果。
            error: 错误信息。
            context: 上下文。

        Returns:
            LightweightReflectionResult: 轻量级反思结果。
        """
        start_time = time.time()
        self._metrics["lightweight_reflections"] += 1

        reflection_type = "success" if success else "failure"
        quick_insight = ""
        key_learning = ""

        if success:
            # 成功路径：快速提取关键经验
            quick_insight = f"{tool_name} 执行成功"
            key_learning = self._extract_quick_learning(tool_name, args or {}, result)
        else:
            # 失败路径：快速分类错误
            error_category = self._categorize_error(error)
            quick_insight = f"{tool_name} 执行失败: {error_category}"
            key_learning = f"错误类型: {error_category}，建议检查相关参数或权限"

        duration_ms = (time.time() - start_time) * 1000
        self._metrics["lightweight_reflection_total_ms"] += duration_ms

        return LightweightReflectionResult(
            reflection_type=reflection_type,
            quick_insight=quick_insight,
            key_learning=key_learning,
            duration_ms=duration_ms,
        )

    def _extract_success_pattern(self, tool_name: str, args: dict[str, Any], result: str) -> str:
        """从成功执行中提取模式。

        Args:
            tool_name: 工具名。
            args: 参数。
            result: 结果。

        Returns:
            str: 成功模式描述。
        """
        if not args:
            return f"{tool_name} 默认参数执行成功"

        # 简单的模式提取：识别关键参数
        key_params = []
        for k, v in args.items():
            if v and not isinstance(v, (dict, list)):
                key_params.append(f"{k}={str(v)[:30]}")

        if key_params:
            return f"{tool_name} 使用参数 {', '.join(key_params[:3])} 成功"
        return f"{tool_name} 执行成功"

    def _generate_success_insight(self, tool_name: str, args: dict[str, Any], result: str) -> str:
        """生成成功洞察。

        Args:
            tool_name: 工具名。
            args: 参数。
            result: 结果。

        Returns:
            str: 洞察描述。
        """
        result_length = len(result) if result else 0
        if result_length > 1000:
            return f"{tool_name} 返回大量数据（{result_length}字符），建议后续使用分页或过滤参数"
        elif result_length == 0:
            return f"{tool_name} 执行成功但无返回数据，确认是否符合预期"
        else:
            return f"{tool_name} 执行正常，参数配置合理"

    def _generate_reusable_tips(self, tool_name: str, args: dict[str, Any], result: str) -> list[str]:
        """生成可复用的技巧。

        Args:
            tool_name: 工具名。
            args: 参数。
            result: 结果。

        Returns:
            list[str]: 技巧列表。
        """
        tips = []
        if args:
            tips.append(f"使用 {tool_name} 时可参考参数格式: {list(args.keys())[:5]}")
        tips.append(f"{tool_name} 是可靠的工具，优先考虑使用")
        return tips

    def _extract_quick_learning(self, tool_name: str, args: dict[str, Any], result: str) -> str:
        """提取快速学习点。

        Args:
            tool_name: 工具名。
            args: 参数。
            result: 结果。

        Returns:
            str: 快速学习点。
        """
        if args:
            param_count = len(args)
            return f"{tool_name} 成功使用 {param_count} 个参数，可作为后续参考"
        return f"{tool_name} 默认配置即可正常工作"

    def _record_success_experience(
        self,
        tool_name: str,
        args: dict[str, Any],
        result: str,
        pattern: str,
        insight: str,
    ) -> None:
        """记录成功经验到知识库。

        Args:
            tool_name: 工具名。
            args: 参数。
            result: 结果。
            pattern: 成功模式。
            insight: 洞察。
        """
        if self._kb_enabled and self._kb:
            try:
                exp = ReflectionExperience(
                    type=ExperienceType.TOOL_USAGE.value,
                    context={"tool_name": tool_name, "args": args, "result_length": len(result)},
                    action=tool_name,
                    result=pattern,
                    reflection="成功执行分析",
                    insight=insight,
                    success_rate=1.0,
                    usage_count=1,
                    tags=[tool_name, "success", "best_practice"],
                )
                self._kb.add_experience(exp)
            except Exception as e:
                self._logger.debug("Failed to record success experience", error=str(e))

    def record_experience(self, entry: ExperienceEntry) -> None:
        entry.timestamp = time.time()
        self._experience_buffer.append(entry)
        if len(self._experience_buffer) > self.max_experience_records:
            self._experience_buffer.pop(0)

        # 同时记录到知识库
        if self._kb_enabled and self._kb:
            try:
                exp = ReflectionExperience(
                    type=ExperienceType.ERROR_RECOVERY.value,
                    context={"tool_name": entry.tool_name, "args": entry.args},
                    action=entry.tool_name,
                    result=entry.resolution,
                    reflection=entry.root_cause,
                    insight=f"{entry.tool_name} 错误处理: {entry.root_cause}",
                    success_rate=1.0 if entry.success else 0.0,
                    usage_count=1,
                    tags=[entry.tool_name, "error_recovery"],
                )
                self._kb.add_experience(exp)
            except Exception as e:
                self._logger.warning("Failed to record experience to kb", error=str(e))

    def get_relevant_experiences(
        self,
        tool_name: str,
        error: str | None = None,
        limit: int = 5,
    ) -> list[ExperienceEntry]:
        # 优先从知识库获取经验
        kb_experiences = []
        if self._kb_enabled and self._kb:
            try:
                kb_results = self._kb.search_experiences(
                    query=tool_name,
                    type=ExperienceType.ERROR_RECOVERY.value,
                    limit=limit,
                )
                # 转换为ExperienceEntry格式
                for exp in kb_results:
                    kb_experiences.append(
                        ExperienceEntry(
                            tool_name=exp.action,
                            args=exp.context.get("args", {}),
                            error=exp.context.get("error", ""),
                            root_cause=exp.reflection,
                            resolution=exp.result,
                            success=exp.success_rate > 0.5,
                            timestamp=exp.timestamp,
                        )
                    )
            except Exception as e:
                self._logger.warning("Failed to get experiences from kb", error=str(e))

        # 从本地缓冲区获取
        error_category = self._categorize_error(error) if error else None

        scored: list[tuple[ExperienceEntry, float]] = []
        for e in self._experience_buffer:
            if e.tool_name != tool_name:
                continue
            score = 1.0
            if error and e.error == error:
                score += 3.0
            elif error_category and self._categorize_error(e.error) == error_category:
                score += 2.0
            if e.timestamp > 0:
                age_days = (time.time() - e.timestamp) / 86400
                score += max(0.0, 1.0 - age_days / 30)
            scored.append((e, score))

        scored.sort(key=lambda x: x[1], reverse=True)
        buffer_results = [s[0] for s in scored[:limit]]

        # 合并结果，优先使用知识库的经验
        all_results = kb_experiences + buffer_results
        # 去重（按tool_name和root_cause）
        seen = set()
        unique_results = []
        for exp in all_results:
            key = (exp.tool_name, exp.root_cause)
            if key not in seen:
                seen.add(key)
                unique_results.append(exp)
            if len(unique_results) >= limit:
                break

        return unique_results

    def transfer_experience(
        self,
        source_tool: str,
        target_tool: str,
        experience_filter: dict[str, Any] | None = None,
    ) -> list[ExperienceEntry]:
        """经验迁移: 将一个工具的经验迁移到另一个相似工具。

        当新工具没有足够经验时，可以从相似工具迁移经验，
        提供初始的错误恢复策略和参数修正建议。

        Args:
            source_tool: 源工具名。
            target_tool: 目标工具名。
            experience_filter: 经验过滤条件。

        Returns:
            迁移后的经验列表（已调整工具名）。
        """
        source_experiences = [
            e for e in self._experience_buffer
            if e.tool_name == source_tool
        ]

        if experience_filter:
            filtered = []
            for e in source_experiences:
                match = True
                if "success_only" in experience_filter and experience_filter["success_only"]:
                    match = match and e.success
                if "error_category" in experience_filter:
                    cat = self._categorize_error(e.error)
                    match = match and cat == experience_filter["error_category"]
                if match:
                    filtered.append(e)
            source_experiences = filtered

        transferred = []
        for e in source_experiences:
            new_entry = ExperienceEntry(
                tool_name=target_tool,
                args=e.args,
                error=e.error,
                root_cause=e.root_cause,
                resolution=e.resolution,
                success=e.success,
                timestamp=time.time(),
            )
            transferred.append(new_entry)
            self._experience_buffer.append(new_entry)

        if len(self._experience_buffer) > self.max_experience_records:
            self._experience_buffer = self._experience_buffer[-self.max_experience_records:]

        self._logger.info(
            "Experience transferred",
            source=source_tool,
            target=target_tool,
            count=len(transferred),
        )

        return transferred

    def get_cross_tool_insights(
        self,
        tool_name: str,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        """获取跨工具经验洞察: 从其他工具的成功经验中提取可复用模式。

        Args:
            tool_name: 当前工具名。
            limit: 返回洞察数量上限。

        Returns:
            跨工具洞察列表。
        """
        other_experiences = [
            e for e in self._experience_buffer
            if e.tool_name != tool_name and e.success
        ]

        error_patterns: dict[str, list[ExperienceEntry]] = {}
        for e in other_experiences:
            cat = self._categorize_error(e.error)
            if cat not in error_patterns:
                error_patterns[cat] = []
            error_patterns[cat].append(e)

        insights = []
        for cat, entries in error_patterns.items():
            if not entries:
                continue
            success_entries = [e for e in entries if e.success]
            if not success_entries:
                continue
            resolutions = list(set(e.resolution for e in success_entries[:3]))
            insights.append({
                "error_category": cat,
                "source_tools": list(set(e.tool_name for e in success_entries)),
                "common_resolutions": resolutions,
                "success_rate": len(success_entries) / len(entries),
                "sample_count": len(entries),
            })

        insights.sort(key=lambda x: x["success_rate"], reverse=True)
        return insights[:limit]

    async def meta_reflect(
        self,
        recent_reflections: list[dict[str, Any]],
        execution_outcomes: list[dict[str, Any]],
    ) -> MetaReflectionResult:
        """元反思: 反思反思本身，评估反思质量并改进反思策略。

        分析最近的反思记录和执行结果，判断反思是否有效，
        识别反思盲点，提出改进建议。

        Args:
            recent_reflections: 最近的反思记录列表。
            execution_outcomes: 对应的执行结果列表。

        Returns:
            MetaReflectionResult: 元反思结果。
        """
        self._metrics["meta_reflections"] = self._metrics.get("meta_reflections", 0) + 1
        if len(self._metrics) > self._MAX_METRICS:
            oldest_keys = list(self._metrics.keys())[: len(self._metrics) - (self._MAX_METRICS * 3 // 4)]
            for k in oldest_keys:
                del self._metrics[k]

        if not recent_reflections:
            return MetaReflectionResult(
                reflection_quality=0.5,
                identified_blind_spots=[],
                suggested_improvements=["缺乏反思记录，建议启用自动反思"],
                should_adjust_strategy=False,
                adjusted_params={},
            )

        retry_count = sum(1 for r in recent_reflections if r.get("should_retry"))
        success_after_retry = sum(
            1 for o in execution_outcomes
            if o.get("success") and o.get("was_retry")
        )
        retry_rate = retry_count / len(recent_reflections) if recent_reflections else 0
        retry_effectiveness = success_after_retry / retry_count if retry_count > 0 else 0

        same_error_repeat = 0
        error_sequences: dict[str, int] = {}
        for r in recent_reflections:
            err_key = f"{r.get('tool_name', '')}:{r.get('error_category', '')}"
            error_sequences[err_key] = error_sequences.get(err_key, 0) + 1
        same_error_repeat = sum(1 for v in error_sequences.values() if v > 2)

        quality = 0.5
        if retry_rate > 0 and retry_effectiveness > 0.5:
            quality += 0.2
        if same_error_repeat == 0:
            quality += 0.1
        if retry_rate > 0.8:
            quality -= 0.2
        quality = max(0.0, min(1.0, quality))

        blind_spots = []
        improvements = []

        if same_error_repeat > 0:
            blind_spots.append(f"同一类错误重复出现{same_error_repeat}次，反思未有效预防")
            improvements.append("增加预防性反思，在执行前检查已知失败模式")

        if retry_rate > 0.8:
            blind_spots.append("重试率过高，反思可能未找到真正根因")
            improvements.append("深化根因分析，考虑使用deep_reflect替代基础反思")

        if retry_effectiveness < 0.3 and retry_count > 0:
            blind_spots.append("重试成功率低，参数修正可能无效")
            improvements.append("改进参数修正策略，考虑使用LLM重新生成完整参数")

        if not any(r.get("alternative_tool") for r in recent_reflections):
            blind_spots.append("从未建议替代工具，反思视野可能过窄")
            improvements.append("在反思中增加工具替代分析")

        should_adjust = quality < 0.4 or len(blind_spots) >= 2

        adjusted_params = {}
        if should_adjust:
            if retry_rate > 0.8:
                adjusted_params["enable_deep_reflection"] = True
            if same_error_repeat > 0:
                adjusted_params["max_retries"] = 1
                adjusted_params["skip_known_failures"] = True
            if retry_effectiveness < 0.3:
                adjusted_params["regenerate_params_on_retry"] = True

        if improvements:
            self._metrics["meta_reflection_improvements"] = self._metrics.get("meta_reflection_improvements", 0) + 1

        return MetaReflectionResult(
            reflection_quality=quality,
            identified_blind_spots=blind_spots,
            suggested_improvements=improvements,
            should_adjust_strategy=should_adjust,
            adjusted_params=adjusted_params,
        )

    def get_metrics(self) -> ReflectionMetrics:
        buf = self._experience_buffer
        retry_success_rate = (
            sum(1 for e in buf if e.success) / len(buf) if buf else 0.0
        )
        deep_rate = (
            self._metrics["deep_reflection_successes"]
            / self._metrics["deep_reflections"]
            if self._metrics["deep_reflections"] > 0
            else 0.0
        )
        reuse_rate = (
            self._metrics["experience_reuses"]
            / self._metrics["total_reflections"]
            if self._metrics["total_reflections"] > 0
            else 0.0
        )
        task_rate = (
            self._metrics["task_reflection_successes"]
            / self._metrics["task_reflections"]
            if self._metrics["task_reflections"] > 0
            else 0.0
        )
        avg_lightweight_ms = (
            self._metrics["lightweight_reflection_total_ms"]
            / self._metrics["lightweight_reflections"]
            if self._metrics["lightweight_reflections"] > 0
            else 0.0
        )
        return ReflectionMetrics(
            total_reflections=self._metrics["total_reflections"],
            retry_success_rate=retry_success_rate,
            deep_reflection_success_rate=deep_rate,
            experience_reuse_rate=reuse_rate,
            experience_record_count=len(buf),
            task_reflections=self._metrics["task_reflections"],
            task_reflection_success_rate=task_rate,
            success_reflections=self._metrics["success_reflections"],
            lightweight_reflections=self._metrics["lightweight_reflections"],
            avg_lightweight_reflection_ms=avg_lightweight_ms,
        )

    def _build_reflect_prompt(
        self,
        tool_name: str,
        args: dict[str, Any],
        error: str,
        context: dict[str, Any],
        similar: list[ExperienceEntry],
    ) -> str:
        parts = [
            "你是反思引擎。工具执行失败，请分析根因并给出修正建议。",
            "",
            f"工具: {tool_name}",
            f"参数: {json.dumps(args, ensure_ascii=False)}",
            f"错误: {error}",
        ]
        if context.get("traceId"):
            parts.append(f"上下文: traceId={context['traceId']}, loopCount={context.get('loopCount', 0)}")

        if similar:
            parts.append("")
            parts.append("历史相似经验:")
            for exp in similar:
                parts.append(f"  - 工具={exp.tool_name}, 错误={exp.error}, 根因={exp.root_cause}, 解决={exp.resolution}")

        parts.append("")
        parts.append('请返回 JSON:')
        parts.append('{')
        parts.append('  "rootCause": "根因分析",')
        parts.append('  "correctedArgs": {} 或 null,')
        parts.append('  "alternativeTool": "替代工具名" 或 null,')
        parts.append('  "shouldRetry": true/false')
        parts.append('}')
        return "\n".join(parts)

    def _build_deep_reflect_prompt(
        self,
        user_input: str,
        trajectory: list[dict[str, Any]],
        eval_result: dict[str, Any],
    ) -> str:
        parts = [
            "你是深度反思引擎。任务执行后进展不足，请分析整条轨迹并给出修正计划。",
            "",
            f"用户目标: {user_input}",
            f"目标进度: {eval_result.get('goalProgress', 0)}",
            f"建议动作: {eval_result.get('suggestedAction', '')}",
            f"原因: {eval_result.get('reason', '')}",
            "",
            "执行轨迹:",
        ]
        for step in trajectory:
            line = f"  - 工具={step.get('toolName', '')}, 成功={step.get('success', False)}"
            if step.get("error"):
                line += f", 错误={step['error']}"
            if step.get("output"):
                line += f", 输出={str(step['output'])[:100]}"
            parts.append(line)

        parts.append("")
        parts.append('请返回 JSON:')
        parts.append('{')
        parts.append('  "diagnosis": "诊断",')
        parts.append('  "rootCause": "根因",')
        parts.append('  "fixStrategy": "修复策略",')
        parts.append('  "correctedPlan": [{"stepDescription":"步骤","toolName":"工具","args":{}}]')
        parts.append('}')
        return "\n".join(parts)

    def _build_task_reflect_prompt(self, task_input: TaskReflectionInput) -> str:
        parts = [
            "你是任务级反思引擎。整个任务执行失败，请进行全局诊断。",
            "",
            f"用户输入: {task_input.user_input}",
            f"任务目标: {task_input.task_goal}",
            f"目标进度: {task_input.goal_progress}",
            f"已用轮次: {task_input.rounds_used}",
            "",
            "执行轨迹:",
        ]
        for step in task_input.execution_trace:
            line = f"  - 工具={step.get('toolName', '')}, 成功={step.get('success', False)}"
            if step.get("error"):
                line += f", 错误={step['error']}"
            parts.append(line)

        parts.append("")
        parts.append("失败点:")
        for fail in task_input.failures:
            parts.append(f"  - 工具={fail.get('toolName', '')}, 错误={fail.get('error', '')}, 步骤={fail.get('stepDescription', '')}")

        parts.append("")
        parts.append('请返回 JSON:')
        parts.append('{')
        parts.append('  "taskDiagnosis": "任务诊断",')
        parts.append('  "rootCause": "根因",')
        parts.append('  "strategyAdjustment": "策略调整",')
        parts.append('  "correctedPlan": [{"stepDescription":"步骤","toolName":"工具","args":{}}],')
        parts.append('  "lessonsLearned": "经验教训",')
        parts.append('  "confidence": 0.0-1.0')
        parts.append('}')
        return "\n".join(parts)

    def _fallback_reflect(self, tool_name: str, error: str) -> ReflectionResult:
        category = self._categorize_error(error)
        root_cause = f"{tool_name}: 执行失败"
        should_retry = True

        if category == "not_found":
            root_cause = f"{tool_name}: 资源不存在"
            should_retry = False
        elif category == "permission":
            root_cause = f"{tool_name}: 权限不足"
            should_retry = False
        elif category in ("timeout", "network"):
            root_cause = f"{tool_name}: 网络/超时错误，可重试"
            should_retry = True
        elif category == "empty":
            root_cause = f"{tool_name}: 参数为空"
            should_retry = False

        return ReflectionResult(
            root_cause=root_cause,
            should_retry=should_retry,
        )

    def _fallback_deep_reflect(
        self,
        trajectory: list[dict[str, Any]],
        eval_result: dict[str, Any],
    ) -> DeepReflectionResult:
        failed_steps = [s for s in trajectory if not s.get("success", True)]
        root_cause = (
            f"步骤 {failed_steps[0].get('toolName', '?')} 失败: {failed_steps[0].get('error', '未知')}"
            if failed_steps
            else "目标进度不足，可能规划方向偏差"
        )
        return DeepReflectionResult(
            diagnosis="深度反思失败，使用规则化分析",
            root_cause=root_cause,
            fix_strategy="重新规划执行路径",
        )

    def _fallback_task_reflect(
        self,
        task_input: TaskReflectionInput,
    ) -> TaskReflectionResult:
        root_cause = (
            f"主要失败: {task_input.failures[0].get('toolName', '')} - {task_input.failures[0].get('error', '')}"
            if task_input.failures
            else "目标进度不足"
        )
        result = TaskReflectionResult(
            task_diagnosis="LLM 不可用，降级为规则化分析",
            root_cause=root_cause,
            strategy_adjustment="重新分析用户意图并调整执行策略",
            confidence=0.3,
        )
        self._record_task_experience(task_input, result, False)
        return result

    def _record_task_experience(
        self,
        task_input: TaskReflectionInput,
        result: TaskReflectionResult,
        success: bool,
    ) -> None:
        entry = TaskReflectionExperience(
            user_input=task_input.user_input,
            task_goal=task_input.task_goal,
            task_diagnosis=result.task_diagnosis,
            root_cause=result.root_cause,
            strategy_adjustment=result.strategy_adjustment,
            lessons_learned=result.lessons_learned,
            confidence=result.confidence,
            success=success,
            timestamp=time.time(),
        )
        self._task_reflection_buffer.append(entry)
        if len(self._task_reflection_buffer) > self.max_experience_records:
            self._task_reflection_buffer.pop(0)

        # 同时记录到知识库
        if self._kb_enabled and self._kb:
            try:
                exp = ReflectionExperience(
                    type=ExperienceType.PLANNING.value,
                    context={
                        "user_input": task_input.user_input,
                        "task_goal": task_input.task_goal,
                        "goal_progress": task_input.goal_progress,
                        "rounds_used": task_input.rounds_used,
                    },
                    action=result.strategy_adjustment[:100] if result.strategy_adjustment else "default_strategy",
                    result=result.task_diagnosis,
                    reflection=result.root_cause,
                    insight=result.lessons_learned,
                    success_rate=1.0 if success else 0.0,
                    usage_count=1,
                    tags=["task_reflection", "planning"],
                )
                self._kb.add_experience(exp)
            except Exception as e:
                self._logger.warning("Failed to record task experience to kb", error=str(e))

    def _categorize_error(self, error: str) -> str:
        for pattern, category in ERROR_CATEGORIES:
            if pattern.search(error):
                return category
        return "unknown"

    def _parse_json_response(self, text: str) -> dict[str, Any] | None:
        json_match = re.search(r'\{[\s\S]*\}', text)
        if not json_match:
            return None
        try:
            return json.loads(json_match.group())
        except (json.JSONDecodeError, ValueError):
            return None
