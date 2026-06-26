from __future__ import annotations

import time
from typing import Any

from agent.core.logger import StructuredLogger
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
    """

    # 质量评分权重
    WEIGHT_RESPONSE = 0.35
    WEIGHT_STEPS = 0.25
    WEIGHT_RECOVERY = 0.20
    WEIGHT_EFFICIENCY = 0.20

    # 响应长度阈值（字符数）
    MIN_RESPONSE_LENGTH = 10
    GOOD_RESPONSE_LENGTH = 100

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
        quality = self._compute_quality_score(
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
        )

    def _extract_response(self, context: LoopContext) -> str:
        """从上下文中提取最终响应文本。"""
        # 优先取最后一条 assistant 消息
        for msg in reversed(context.messages):
            if msg.get("role") == "assistant" and msg.get("content"):
                return msg["content"]

        # 降级：取最后一个成功的步骤结果
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
    ) -> float:
        """计算多维度加权质量评分 (0.0 ~ 1.0)。

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

        log.debug(
            "Quality score computed",
            response=round(resp_score, 3),
            steps=round(step_score, 3),
            recovery=round(recovery_score, 3),
            efficiency=round(efficiency_score, 3),
            total=round(quality, 3),
        )

        return max(0.0, min(1.0, quality))

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

        # 检查是否有重试成功的记录（retry_count > 0 且最终成功）
        retried_and_succeeded = sum(
            1 for r in all_results
            if r.success and getattr(r, "retry_count", 0) > 0
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
