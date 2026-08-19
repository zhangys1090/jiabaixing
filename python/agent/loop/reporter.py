from __future__ import annotations

import time
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.loop.quality_scorer import BuiltInQualityScorer
from agent.loop.types import (
    AgentResult,
    LoopContext,
    ReporterOutput,
)

log = StructuredLogger("reporter")


class Reporter:
    """报告器：从 LoopContext 提取最终响应并计算多维度质量评分。

    质量评分维度（加权综合）：
      - response_completeness (35%): 响应是否存在且足够充实
      - step_success_rate (25%): 步骤成功率
      - error_recovery (20%): 错误恢复率（失败后通过反思重试成功）
      - time_efficiency (20%): 时间效率（实际耗时 vs 预算）

    额外维度（BuiltInQualityScorer）：
      - reflection_value: 反思引擎是否产出了有效经验
      - context_relevance: 注意力聚焦后的上下文集中度
    """

    WEIGHT_RESPONSE = 0.35
    WEIGHT_STEPS = 0.25
    WEIGHT_RECOVERY = 0.20
    WEIGHT_EFFICIENCY = 0.20

    MIN_RESPONSE_LENGTH = 10
    GOOD_RESPONSE_LENGTH = 100

    def __init__(self) -> None:
        self._quality_scorer = BuiltInQualityScorer()

    def report(self, context: LoopContext) -> ReporterOutput:
        last_assistant = self._extract_response(context)

        steps_completed = sum(
            1 for r in context.step_results.values() if r.success
        )
        steps_total = len(context.step_results)

        elapsed = 0.0
        if context.budget.start_time > 0:
            elapsed = (time.time() - context.budget.start_time) * 1000

        # ─── 多维度质量评分 ───
        quality, breakdown = self._compute_quality_score(
            response=last_assistant,
            steps_completed=steps_completed,
            steps_total=steps_total,
            context=context,
            elapsed_ms=elapsed,
        )

        return ReporterOutput(
            response=last_assistant,
            quality_score=quality,
            steps_completed=steps_completed,
            steps_total=steps_total,
            total_duration_ms=elapsed,
            quality_breakdown=breakdown,
        )

    def _extract_response(self, context: LoopContext) -> str:
        """从上下文中提取最终响应文本。

        多步任务时，如果最后一条 assistant 消息是工具原始输出，
        则合成面向用户的综合回答。
        """
        assistant_msgs = [
            msg for msg in context.messages
            if msg.get("role") == "assistant" and msg.get("content")
        ]

        if assistant_msgs:
            last_msg = assistant_msgs[-1]["content"]
            if len(assistant_msgs) > 1 and context.step_results:
                successful = [r for r in context.step_results.values() if r.success]
                if len(successful) > 1:
                    steps_summary = "\n".join(
                        f"- 步骤 {i+1}({r.tool_name or 'unknown'}): {r.content[:100]}"
                        for i, r in enumerate(successful)
                    )
                    return f"任务已完成，共执行 {len(successful)} 个步骤：\n{steps_summary}\n\n最终结果：{last_msg}"
            return last_msg

        if context.step_results:
            successful = [
                r for r in context.step_results.values() if r.success
            ]
            if successful:
                return successful[-1].content

        return ""

    def _compute_quality_score(
        self,
        response: str,
        steps_completed: int,
        steps_total: int,
        context: LoopContext,
        elapsed_ms: float,
    ) -> tuple[float, dict[str, float]]:
        """计算多维度加权质量评分 (0.0 ~ 1.0)。

        返回: (综合评分, 各维度得分字典)
        各维度独立计算后加权汇总，避免单一维度退化导致整体评分失真。
        """
        # 维度 1: 响应完整性 (35%)
        resp_score = self._score_response(response)

        # 维度 2: 步骤成功率 (25%)
        step_score = steps_completed / steps_total if steps_total > 0 else 0.0
        # 无步骤的纯对话任务，响应存在即视为成功
        if steps_total == 0 and response:
            step_score = 0.8

        # 维度 3: 错误恢复率 (20%)
        recovery_score = self._score_error_recovery(context)

        # 维度 4: 时间效率 (20%)
        efficiency_score = self._score_efficiency(context, elapsed_ms)

        quality = (
            self.WEIGHT_RESPONSE * resp_score
            + self.WEIGHT_STEPS * step_score
            + self.WEIGHT_RECOVERY * recovery_score
            + self.WEIGHT_EFFICIENCY * efficiency_score
        )

        breakdown = {
            "response_completeness": round(resp_score, 4),
            "step_success_rate": round(step_score, 4),
            "error_recovery": round(recovery_score, 4),
            "time_efficiency": round(efficiency_score, 4),
        }

        # F1: 接入 BuiltInQualityScorer 额外维度（反思价值 + 上下文相关性）
        try:
            reflection_experiences = 0
            if hasattr(context, '_reflection_experiences_count'):
                reflection_experiences = context._reflection_experiences_count
            extra_report = self._quality_scorer.score(
                step_results=context.step_results,
                planned_steps=len(context.plan.steps) if context.plan and context.plan.steps else 0,
                rounds_used=context.budget.rounds_used,
                reflection_experiences=reflection_experiences,
                context_message_count=len(context.messages),
            )
            if extra_report and hasattr(extra_report, 'dimensions'):
                breakdown["reflection_value"] = round(extra_report.dimensions.reflection_value, 4)
                breakdown["context_relevance"] = round(extra_report.dimensions.context_relevance, 4)
                quality = quality * 0.85 + extra_report.overall_score * 0.15
        except Exception as _exc:
            log_ignored(log, "reporter.Reporter._compute_quality_score", _exc)

        log.debug(
            "Quality score computed",
            response=round(resp_score, 3),
            steps=round(step_score, 3),
            recovery=round(recovery_score, 3),
            efficiency=round(efficiency_score, 3),
            total=round(quality, 3),
            breakdown=breakdown,
        )

        return max(0.0, min(1.0, quality)), breakdown

    def _score_response(self, response: str) -> float:
        """评分响应完整性：存在性 + 长度充实度。"""
        if not response:
            return 0.0

        resp_len = len(response.strip())
        if resp_len < self.MIN_RESPONSE_LENGTH:
            return 0.2

        if resp_len >= self.GOOD_RESPONSE_LENGTH:
            return 1.0

        # 线性插值
        ratio = (resp_len - self.MIN_RESPONSE_LENGTH) / (
            self.GOOD_RESPONSE_LENGTH - self.MIN_RESPONSE_LENGTH
        )
        return 0.4 + 0.6 * ratio

    def _score_error_recovery(self, context: LoopContext) -> float:
        """评分错误恢复率：有多少失败步骤通过重试/反思恢复了。"""
        all_results = list(context.step_results.values())
        if not all_results:
            return 1.0  # 无步骤 = 无错误 = 满分

        failed = [r for r in all_results if not r.success]
        if not failed:
            return 1.0  # 无失败 = 满分

        # StepResult 不携带 retry_count（见 agent/loop/types.py），改为从 PlanStep 映射
        # （审计 L-09：原 getattr(r, "retry_count", 0) 永远为 0，导致错误恢复维度恒为 0 分）
        retry_map: dict[str, int] = {}
        if context.plan and context.plan.steps:
            retry_map = {s.step_id: s.retry_count for s in context.plan.steps}
        retried_and_succeeded = sum(
            1 for r in all_results if r.success and retry_map.get(r.step_id, 0) > 0
        )
        total_failures = len(failed) + retried_and_succeeded
        if total_failures == 0:
            return 1.0

        recovery_rate = retried_and_succeeded / total_failures
        # 即使有未恢复的失败，也给部分分数（至少尝试了）
        base_score = 0.3 if retried_and_succeeded > 0 else 0.0
        return base_score + 0.7 * recovery_rate

    def _score_efficiency(self, context: LoopContext, elapsed_ms: float) -> float:
        """评分时间效率：实际耗时与预算的比值。"""
        budget_ms = context.budget.max_duration_ms
        if budget_ms <= 0:
            return 0.8  # 无预算限制时给默认分

        if elapsed_ms <= 0:
            return 1.0

        ratio = elapsed_ms / budget_ms
        if ratio <= 0.3:
            return 1.0  # 远低于预算
        elif ratio <= 0.7:
            return 0.8  # 合理使用
        elif ratio <= 1.0:
            return 0.5  # 接近预算上限
        else:
            return 0.2  # 超出预算

    # P1-4: 错误信息人性化翻译映射
    ERROR_TRANSLATIONS: dict[str, tuple[str, str]] = {
        "Connection refused": ("网络连接失败", "请检查网络连接后重试"),
        "Connection reset": ("网络连接被重置", "正在尝试重新连接..."),
        "timed out": ("请求超时", "服务响应较慢，已自动重试中"),
        "ConnectionError": ("网络连接异常", "请检查网络是否正常"),
        "TimeoutError": ("操作超时", "任务耗时较长，请耐心等待"),
        "permission denied": ("权限不足", "请检查文件或目录的访问权限"),
        "not found": ("资源未找到", "请确认文件或路径是否存在"),
        "file not found": ("文件未找到", "请检查文件路径是否正确"),
        "rate limit": ("请求频率过高", "请稍后再试"),
        "token limit": ("对话内容过长", "已自动压缩历史记录"),
        "invalid api key": ("API 密钥无效", "请检查 API 配置"),
        "out of memory": ("系统资源不足", "已简化处理，部分功能可能受限"),
        "disk full": ("磁盘空间不足", "请清理磁盘空间后重试"),
        "read only": ("文件为只读", "请检查文件权限"),
    }

    @classmethod
    def humanize_error(cls, error: str) -> tuple[str, str]:
        """将技术错误翻译为用户友好描述。

        Args:
            error: 原始技术错误信息。

        Returns:
            (用户友好描述, 操作建议)。
        """
        error_lower = error.lower()
        for pattern, (friendly, suggestion) in cls.ERROR_TRANSLATIONS.items():
            if pattern.lower() in error_lower:
                return friendly, suggestion
        return f"处理请求时遇到技术问题", "请稍后重试或简化您的请求"
