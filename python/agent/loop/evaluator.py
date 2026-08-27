from __future__ import annotations

import json
import re
from typing import Any

from agent.llm.provider import LLMProvider
import logging
from agent.loop.types import (
    EvaluatorOutput,
    LoopContext,
    StepResult,
)
logger = logging.getLogger(__name__)


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

        all_success = all(sr.success for sr in context.step_results.values())
        if all_success and len(context.step_results) >= 1:
            rule_result = self._rule_evaluate(context, step_success_rate)
            rule_result.reason = f"快速通道：全部 {len(context.step_results)} 步骤成功"
            return rule_result

        # agent_native 模型：轻量验证 — 跳过 LLM 评估，直接走规则评估
        # 原生 Agent 模型工具调用准确率高，无需每轮消耗 LLM 调用做深度验证
        if getattr(context.budget, "verification_level", "full") == "light":
            return self._rule_evaluate(context, step_success_rate)

        try:
            return await self._llm_evaluate(input_text, context, step_success_rate)
        except Exception as e:
            logger.warning("evaluator.evaluate LLM评估失败，降级为规则评估", error=str(e))
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
            "你是任务评估专家。请从以下维度评估任务执行质量：\n\n"
            "1. **目标完成度 (goalProgress)**: 0.0-1.0\n"
            "2. **建议动作 (suggestedAction)**: 'continue' | 'replan' | 'abort'\n"
            "3. **质量评分 (qualityScore)**: 0.0-1.0 综合质量\n"
            "4. **事实准确性 (factualAccuracy)**: 0.0-1.0 回答中事实的正确性\n"
            "5. **引用准确性 (citationAccuracy)**: 0.0-1.0 引用来源的准确性\n"
            "6. **相关性评分 (relevanceScore)**: 0.0-1.0 回复与用户意图的相关性\n"
            "7. **安全标记 (safetyFlag)**: true/false 是否包含不安全内容\n"
            "8. **失败分析 (failureAnalysis)**: 如有失败说明原因\n"
            "9. **修正建议 (suggestedCorrection)**: 如有改进建议\n\n"
            f"用户目标: {input_text}\n"
            f"已执行步骤:\n" + "\n".join(steps_summary) + "\n\n"
            "请返回 JSON:\n"
            "{\n"
            '  "goalProgress": 0.0-1.0,\n'
            '  "suggestedAction": "continue" | "replan" | "abort",\n'
            '  "reason": "评估原因",\n'
            '  "qualityScore": 0.0-1.0,\n'
            '  "factualAccuracy": 0.0-1.0,\n'
            '  "citationAccuracy": 0.0-1.0,\n'
            '  "relevanceScore": 0.0-1.0,\n'
            '  "safetyFlag": true/false,\n'
            '  "failureAnalysis": "失败分析（如有）",\n'
            '  "suggestedCorrection": "修正建议（如有）"\n'
            "}"
        )

        result = await self.llm.chat(
            messages=[{"role": "user", "content": prompt}],
            use_cache=False,
            task_type="reasoning",
        )
        content = result.get("content", "")
        parsed = self._parse_json(content)

        if parsed:
            all_content = " ".join(
                sr.content or "" for sr in context.step_results.values()
            )
            safety_flag = bool(parsed.get("safetyFlag", False)) or self._check_safety_keywords(
                all_content + " " + input_text
            )
            return EvaluatorOutput(
                goal_progress=float(parsed.get("goalProgress", 0.5)),
                suggested_action=parsed.get("suggestedAction", "continue"),
                reason=parsed.get("reason", "LLM 评估"),
                quality_score=float(parsed.get("qualityScore", 0.5)),
                step_success_rate=step_success_rate,
                failure_analysis=parsed.get("failureAnalysis"),
                suggested_correction=parsed.get("suggestedCorrection"),
                factual_accuracy=float(parsed.get("factualAccuracy", 0.5)),
                citation_accuracy=float(parsed.get("citationAccuracy", 0.5)),
                relevance_score=float(parsed.get("relevanceScore", 0.7)),
                safety_flag=safety_flag,
                evaluation_dimensions={
                    "factual_accuracy": float(parsed.get("factualAccuracy", 0.5)),
                    "citation_accuracy": float(parsed.get("citationAccuracy", 0.5)),
                    "relevance": float(parsed.get("relevanceScore", 0.7)),
                    "safety": 0.0 if safety_flag else 1.0,
                },
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

        all_content = " ".join(
            r.content or "" for r in context.step_results.values()
        )
        factual_estimate = min(1.0, 0.4 + step_success_rate * 0.5)
        citation_estimate = 0.0
        relevance_estimate = 0.7 if progress > 0.3 else 0.4
        safety_flag = self._check_safety_keywords(all_content + " " + context.user_input)

        return EvaluatorOutput(
            goal_progress=progress,
            suggested_action=action,
            reason=reason,
            quality_score=progress,
            step_success_rate=step_success_rate,
            factual_accuracy=factual_estimate,
            citation_accuracy=citation_estimate,
            relevance_score=relevance_estimate,
            safety_flag=safety_flag,
            failure_analysis=self._analyze_failures(context),
            suggested_correction=self._suggest_correction(action, context),
            evaluation_dimensions={
                "factual_accuracy": factual_estimate,
                "citation_accuracy": citation_estimate,
                "relevance": relevance_estimate,
                "safety": 0.0 if safety_flag else 1.0,
            },
        )

    @staticmethod
    def _check_safety_keywords(text: str) -> bool:
        """检查文本中是否包含不安全内容关键词。

        Args:
            text: 待检查的文本。

        Returns:
            bool: True 表示检测到不安全内容。
        """
        dangerous_patterns = [
            "rm -rf", "DROP TABLE", "DELETE FROM", "format c:",
            "eval(", "exec(", "__import__", "os.system",
            "subprocess", "shell=True", "sudo ", "chmod 777",
            "wget http", "curl http", "base64 -d", "decode",
            "password", "secret", "token", "api_key",
        ]
        text_lower = text.lower()
        return any(pattern.lower() in text_lower for pattern in dangerous_patterns)

    @staticmethod
    def _analyze_failures(context: LoopContext) -> str | None:
        """分析步骤执行中的失败原因。

        Args:
            context: 循环上下文。

        Returns:
            str | None: 失败分析文本，无失败时返回 None。
        """
        failures = [
            (sid, sr.error or sr.content[:100])
            for sid, sr in context.step_results.items()
            if not sr.success
        ]
        if not failures:
            return None
        if len(failures) == 1:
            return f"步骤 {failures[0][0]} 执行失败: {failures[0][1]}"
        parts = [f"{sid}: {err[:80]}" for sid, err in failures[:3]]
        return f"多个步骤失败 ({len(failures)}个): " + "; ".join(parts)

    @staticmethod
    def _suggest_correction(action: str, context: LoopContext) -> str | None:
        """根据评估结果生成修正建议。

        Args:
            action: 建议动作。
            context: 循环上下文。

        Returns:
            str | None: 修正建议文本，无需修正时返回 None。
        """
        if action == "continue":
            return None
        if action == "replan":
            failures = [
                sid for sid, sr in context.step_results.items()
                if not sr.success
            ]
            if failures:
                return f"建议重试失败步骤: {', '.join(failures[:3])}，或调整工具参数"
            return "建议重新规划，当前步骤策略可能不适合任务目标"
        if action == "abort":
            return "任务无法完成，建议检查前置条件或输入参数"
        return None

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
