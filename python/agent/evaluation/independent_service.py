from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from agent.core.types import RiskLevel
from agent.security.sensitive_detector import (
    CheckScene,
    check_sensitive_info,
)
from agent.core.logger import log_ignored
import logging
logger = logging.getLogger(__name__)


@dataclass
class TaskCompletionEval:
    completed: bool = False
    confidence: float = 0.0
    reason: str = ""


@dataclass
class DataGroundednessEval:
    grounded: bool = False
    confidence: float = 0.0
    reason: str = ""


@dataclass
class SafetyEval:
    safe: bool = True
    risk_level: str = "none"
    violations: list[str] = field(default_factory=list)
    sanitized_output: str | None = None


@dataclass
class QualityEval:
    overall: float = 0.5
    accuracy: float = 0.5
    usefulness: float = 0.5
    friendliness: float = 0.5
    efficiency: float = 0.5
    details: str = ""


@dataclass
class OverallEval:
    suggested_action: str = "continue"
    goal_progress: float = 0.5
    summary: str = ""


@dataclass
class StepEvaluation:
    all_passed: bool = True
    failed_count: int = 0
    total_count: int = 0
    failed_tools: list[str] = field(default_factory=list)


@dataclass
class IndependentEvaluationResult:
    task_completion: TaskCompletionEval = field(default_factory=TaskCompletionEval)
    data_groundedness: DataGroundednessEval = field(default_factory=DataGroundednessEval)
    safety: SafetyEval = field(default_factory=SafetyEval)
    quality: QualityEval = field(default_factory=QualityEval)
    overall: OverallEval = field(default_factory=OverallEval)


@dataclass
class EvaluationInput:
    user_input: str = ""
    conversation_history: list[dict[str, Any]] = field(default_factory=list)
    execution_trace: dict[str, Any] | None = None
    current_output: str | None = None


@dataclass
class JudgeScore:
    judge_name: str = ""
    score: float = 0.0
    reasoning: str = ""
    passed: bool = False


@dataclass
class ConsensusResult:
    final_score: float = 0.0
    consensus_reached: bool = False
    judge_scores: list[JudgeScore] = field(default_factory=list)
    strategy: str = "weighted_average"
    agreement: float = 0.0


class LLMProtocol(Protocol):
    async def chat(self, prompt: str, system_prompt: str | None = None) -> str: ...


@dataclass
class IndependentEvaluationServiceDeps:
    llm: LLMProtocol | None = None
    enable_llm_evaluation: bool = False
    judges: list[Any] | None = None
    consensus_strategy: str = "weighted_average"


_ACK_PATTERNS = [
    re.compile(r"^好的?"),
    re.compile(r"好的[，,]?\s*(我|我们|这)"),
    re.compile(r"^收到"),
    re.compile(r"^明白"),
    re.compile(r"^了解"),
    re.compile(r"开始.+(执行|处理|操作)"),
]

_ERROR_MARKERS = ["抱歉", "无法", "失败", "错误", "error", "failed"]


class IndependentEvaluationService:
    def __init__(self, deps: IndependentEvaluationServiceDeps | None = None) -> None:
        self.deps = deps or IndependentEvaluationServiceDeps()

    async def evaluate(self, input_data: EvaluationInput) -> IndependentEvaluationResult:
        rule_eval = self._rule_based_evaluate(input_data)

        llm_eval: PartialResult = {}
        if self.deps.enable_llm_evaluation and self.deps.llm:
            try:
                llm_eval = await self._llm_deep_evaluate(input_data)
            except Exception as _exc:
                logger.warning("independent_service 异常处理", error=str(_exc))
                log_ignored(None, "independent_service.IndependentEvaluationService.evaluate", _exc)

        return self._merge_results(rule_eval, llm_eval)

    async def evaluate_with_consensus(
        self, input_data: EvaluationInput
    ) -> tuple[IndependentEvaluationResult, ConsensusResult | None]:
        evaluation = await self.evaluate(input_data)

        if not self.deps.judges or len(self.deps.judges) < 2:
            return evaluation, None

        judge_scores = await self._collect_judge_scores(input_data)
        consensus = self._aggregate_consensus(judge_scores)

        if consensus.consensus_reached:
            evaluation.quality.overall = consensus.final_score / 100
            evaluation.quality.details += (
                f" [共识评分: {consensus.final_score:.1f}, "
                f"一致性: {consensus.agreement * 100:.0f}%]"
            )

        return evaluation, consensus

    def _rule_based_evaluate(self, input_data: EvaluationInput) -> IndependentEvaluationResult:
        step_eval = self._evaluate_step_results(input_data)
        task_completion = self._evaluate_task_completion(input_data)
        data_groundedness = self._evaluate_data_groundedness(input_data)
        safety = self._evaluate_safety(input_data)
        quality = self._evaluate_quality(input_data)
        overall = self._calculate_overall(
            task_completion, data_groundedness, safety, quality, step_eval
        )

        return IndependentEvaluationResult(
            task_completion=task_completion,
            data_groundedness=data_groundedness,
            safety=safety,
            quality=quality,
            overall=overall,
        )

    def _evaluate_step_results(self, input_data: EvaluationInput) -> StepEvaluation:
        tool_results: list[dict[str, Any]] = []
        if input_data.execution_trace and "toolResults" in input_data.execution_trace:
            tool_results = input_data.execution_trace["toolResults"]

        if not tool_results:
            return StepEvaluation()

        failed_count = 0
        failed_tools: list[str] = []

        for result in tool_results:
            if not result.get("success", True):
                failed_count += 1
                failed_tools.append(result.get("toolName", "unknown"))

        return StepEvaluation(
            all_passed=failed_count == 0,
            failed_count=failed_count,
            total_count=len(tool_results),
            failed_tools=failed_tools,
        )

    def _evaluate_task_completion(self, input_data: EvaluationInput) -> TaskCompletionEval:
        last_output = (
            input_data.current_output
            or self._get_last_assistant_content(input_data.conversation_history)
            or ""
        )

        has_tool_results = False
        if input_data.execution_trace and "toolResults" in input_data.execution_trace:
            tool_results = input_data.execution_trace["toolResults"]
            has_tool_results = any(r.get("success") for r in tool_results)

        has_tool_calls = (
            input_data.execution_trace is not None
            and input_data.execution_trace.get("totalToolCalls", 0) > 0
        )

        is_ack_only = self._is_acknowledgment_response(last_output)

        has_final_output = bool(
            (self._has_final_assistant_message(input_data.conversation_history) and not is_ack_only)
            or (input_data.current_output and len(input_data.current_output) > 0 and not is_ack_only)
            or has_tool_results
        )

        confidence = 0.5
        reason = "未检测到明确的任务完成信号"

        if has_tool_results:
            confidence = 0.8
            reason = "工具执行成功，任务可能已完成"
        elif has_final_output:
            has_error_markers = any(m in last_output.lower() for m in _ERROR_MARKERS)
            if has_error_markers:
                confidence = 0.4
                reason = "检测到可能的错误信息"
            elif len(last_output) > 50:
                confidence = 0.7
                reason = "检测到合理长度的输出"
            else:
                confidence = 0.5
                reason = "有输出但较短"
        elif is_ack_only:
            confidence = 0.2
            reason = "仅检测到确认响应，未见实际执行"

        return TaskCompletionEval(
            completed=has_final_output and confidence >= 0.5,
            confidence=confidence,
            reason=reason,
        )

    def _is_acknowledgment_response(self, output: str) -> bool:
        if not output:
            return False
        return any(p.search(output) for p in _ACK_PATTERNS)

    def _evaluate_data_groundedness(self, input_data: EvaluationInput) -> DataGroundednessEval:
        has_tool_calls = (
            input_data.execution_trace is not None
            and input_data.execution_trace.get("totalToolCalls", 0) > 0
        )
        has_tool_messages = any(m.get("role") == "tool" for m in input_data.conversation_history)

        grounded = has_tool_calls or has_tool_messages
        confidence = 0.6 if grounded else 0.3

        return DataGroundednessEval(
            grounded=grounded,
            confidence=confidence,
            reason="有工具调用记录，输出可能基于工具数据" if grounded else "无工具调用记录，输出可能基于模型知识",
        )

    def _evaluate_safety(self, input_data: EvaluationInput) -> SafetyEval:
        output_to_check = (
            input_data.current_output
            or self._get_last_assistant_content(input_data.conversation_history)
            or ""
        )

        result = check_sensitive_info(output_to_check, CheckScene.OUTPUT)
        violations = [f"{v.name} (风险: {v.risk.value})" for v in result.violations]

        return SafetyEval(
            safe=result.safe,
            risk_level=result.risk_level.value,
            violations=violations,
            sanitized_output=result.sanitized_output,
        )

    def _evaluate_quality(self, input_data: EvaluationInput) -> QualityEval:
        overall = 0.7
        efficiency = 0.8

        if input_data.execution_trace:
            loop_rounds = input_data.execution_trace.get("loopRounds", 0)
            total_duration = input_data.execution_trace.get("totalDuration", 0)

            if loop_rounds > 3:
                penalty = 0.1 * (loop_rounds - 3)
                overall -= penalty
                efficiency -= penalty

            if total_duration > 30000:
                efficiency -= 0.2
            elif total_duration > 15000:
                efficiency -= 0.1

        overall = max(0.1, min(1.0, overall))
        efficiency = max(0.1, min(1.0, efficiency))

        details = "无执行轨迹数据"
        if input_data.execution_trace:
            details = (
                f"轮次={input_data.execution_trace.get('loopRounds', 0)} "
                f"工具={input_data.execution_trace.get('totalToolCalls', 0)} "
                f"时长={input_data.execution_trace.get('totalDuration', 0)}ms"
            )

        return QualityEval(
            overall=overall,
            accuracy=max(0.1, overall * 0.9),
            usefulness=max(0.1, overall * 0.95),
            friendliness=max(0.1, 0.8),
            efficiency=efficiency,
            details=details,
        )

    def _calculate_overall(
        self,
        task_completion: TaskCompletionEval,
        data_groundedness: DataGroundednessEval,
        safety: SafetyEval,
        quality: QualityEval,
        step_eval: StepEvaluation,
    ) -> OverallEval:
        suggested_action = "continue"
        goal_progress = 0.5
        summary = "需要进一步评估"

        if safety.risk_level == "critical":
            suggested_action = "abort"
            goal_progress = 0.1
            summary = "检测到严重安全风险，建议中止"
        elif safety.risk_level == "high":
            suggested_action = "replan"
            goal_progress = 0.3
            summary = "检测到高风险内容，建议重新规划"
        elif not step_eval.all_passed:
            if step_eval.failed_count == step_eval.total_count:
                suggested_action = "abort"
                goal_progress = 0
                summary = f"所有工具调用失败 ({', '.join(step_eval.failed_tools)})"
            else:
                suggested_action = "replan"
                goal_progress = 0.4
                summary = f"部分工具调用失败: {step_eval.failed_count}/{step_eval.total_count} ({', '.join(step_eval.failed_tools)})"
        elif not task_completion.completed:
            goal_progress = task_completion.confidence * 0.6
            if task_completion.confidence < 0.3:
                suggested_action = "replan"
                summary = "任务进展不明确，建议重新规划"
            else:
                summary = "任务进行中，继续执行"
        elif task_completion.completed and quality.overall >= 0.7:
            goal_progress = 0.7 + (task_completion.confidence * 0.3)
            summary = "任务基本完成，质量良好"

        return OverallEval(
            suggested_action=suggested_action,
            goal_progress=max(0.0, min(1.0, goal_progress)),
            summary=summary,
        )

    async def _llm_deep_evaluate(self, input_data: EvaluationInput) -> PartialResult:
        if not self.deps.llm:
            return {}

        conversation_summary = "\n".join(
            f"{m.get('role', 'unknown')}: {str(m.get('content', ''))[:200]}"
            for m in input_data.conversation_history
        )

        system_prompt = (
            "你是一个独立的 AI 评估专家，负责客观评估另一个 AI 的执行结果。\n"
            "请从以下维度进行严格评估：\n"
            "1. taskCompletion: 任务是否完成\n"
            "2. dataGroundedness: 回答是否基于工具数据\n"
            "3. safety: 是否存在安全风险\n"
            "4. quality: 质量评分\n"
            "5. overall: 整体建议\n\n"
            "请用严格的 JSON 格式回答，不要包含其他内容。"
        )

        exec_info = "无执行轨迹信息"
        if input_data.execution_trace:
            exec_info = (
                f"- 工具调用: {input_data.execution_trace.get('totalToolCalls', 0)}次\n"
                f"- 执行轮次: {input_data.execution_trace.get('loopRounds', 0)}轮\n"
                f"- 总耗时: {input_data.execution_trace.get('totalDuration', 0)}ms"
            )

        current_output = input_data.current_output or self._get_last_assistant_content(input_data.conversation_history) or "(无输出)"

        prompt = (
            f'评估以下 AI 执行结果。\n\n'
            f'用户输入: "{input_data.user_input}"\n\n'
            f'对话历史:\n{conversation_summary}\n\n'
            f'执行信息:\n{exec_info}\n\n'
            f'当前输出: "{current_output[:500]}"\n\n'
            f'请用以下 JSON 格式回答:\n'
            f'{{\n'
            f'  "taskCompletion": {{"completed": true, "confidence": 0.9, "reason": "任务目标已达成"}},\n'
            f'  "dataGroundedness": {{"grounded": true, "confidence": 0.8, "reason": "回答引用了工具返回的数据"}},\n'
            f'  "safety": {{"safe": true, "riskLevel": "none", "violations": []}},\n'
            f'  "quality": {{"overall": 0.85, "accuracy": 0.9, "usefulness": 0.85, "friendliness": 0.8, "efficiency": 0.9, "details": "质量良好"}},\n'
            f'  "overall": {{"suggestedAction": "continue", "goalProgress": 0.9, "summary": "整体评估良好"}}\n'
            f'}}'
        )

        response = await self.deps.llm.chat(prompt, system_prompt)
        json_match = re.search(r"\{[\s\S]*\}", response)
        if not json_match:
            return {}

        try:
            parsed = json.loads(json_match.group())
            return self._parse_llm_result(parsed)
        except (json.JSONDecodeError, TypeError):
            return {}

    def _parse_llm_result(self, parsed: dict[str, Any]) -> PartialResult:
        result: PartialResult = {}

        tc = parsed.get("taskCompletion")
        if tc and isinstance(tc, dict):
            result["task_completion"] = TaskCompletionEval(
                completed=tc.get("completed", False),
                confidence=float(tc.get("confidence", 0.5)),
                reason=str(tc.get("reason", "")),
            )

        dg = parsed.get("dataGroundedness")
        if dg and isinstance(dg, dict):
            result["data_groundedness"] = DataGroundednessEval(
                grounded=dg.get("grounded", False),
                confidence=float(dg.get("confidence", 0.3)),
                reason=str(dg.get("reason", "")),
            )

        sf = parsed.get("safety")
        if sf and isinstance(sf, dict):
            result["safety"] = SafetyEval(
                safe=sf.get("safe", True),
                risk_level=str(sf.get("riskLevel", "none")),
                violations=sf.get("violations", []),
            )

        ql = parsed.get("quality")
        if ql and isinstance(ql, dict):
            result["quality"] = QualityEval(
                overall=float(ql.get("overall", 0.5)),
                accuracy=float(ql.get("accuracy", 0.5)),
                usefulness=float(ql.get("usefulness", 0.5)),
                friendliness=float(ql.get("friendliness", 0.5)),
                efficiency=float(ql.get("efficiency", 0.5)),
                details=str(ql.get("details", "")),
            )

        ov = parsed.get("overall")
        if ov and isinstance(ov, dict):
            result["overall"] = OverallEval(
                suggested_action=str(ov.get("suggestedAction", "continue")),
                goal_progress=float(ov.get("goalProgress", 0.5)),
                summary=str(ov.get("summary", "")),
            )

        return result

    def _merge_results(
        self,
        rule_eval: IndependentEvaluationResult,
        llm_eval: PartialResult,
    ) -> IndependentEvaluationResult:
        return IndependentEvaluationResult(
            task_completion=llm_eval.get("task_completion", rule_eval.task_completion),
            data_groundedness=llm_eval.get("data_groundedness", rule_eval.data_groundedness),
            safety=llm_eval.get("safety", rule_eval.safety),
            quality=llm_eval.get("quality", rule_eval.quality),
            overall=llm_eval.get("overall", rule_eval.overall),
        )

    def _has_final_assistant_message(self, messages: list[dict[str, Any]]) -> bool:
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            if msg.get("role") == "assistant":
                tool_calls = msg.get("tool_calls")
                if not tool_calls or len(tool_calls) == 0:
                    return True
        return False

    def _get_last_assistant_content(self, messages: list[dict[str, Any]]) -> str | None:
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            if msg.get("role") == "assistant" and msg.get("content"):
                return str(msg["content"])
        return None

    async def _collect_judge_scores(self, input_data: EvaluationInput) -> list[JudgeScore]:
        scores: list[JudgeScore] = []
        judges = self.deps.judges or []

        prompt = self._build_judge_prompt(input_data)

        for judge in judges:
            try:
                response = await judge.chat(prompt)
                parsed = self._parse_judge_response(response)
                scores.append(JudgeScore(
                    judge_name=getattr(judge, "name", "unknown"),
                    score=parsed.get("score", 50),
                    reasoning=parsed.get("reasoning", ""),
                    passed=parsed.get("score", 50) >= 60,
                ))
            except Exception as e:
                logger.warning("independent_service.judge 评分失败", judge=getattr(judge, "name", "unknown"), error=str(e))
                scores.append(JudgeScore(
                    judge_name=getattr(judge, "name", "unknown"),
                    score=50,
                    reasoning="评分失败",
                    passed=False,
                ))

        return scores

    def _aggregate_consensus(self, judge_scores: list[JudgeScore]) -> ConsensusResult:
        strategy = self.deps.consensus_strategy
        scores = [j.score for j in judge_scores]
        pass_votes = sum(1 for j in judge_scores if j.passed)

        final_score: float
        agreement: float

        if strategy == "majority_vote":
            if pass_votes >= len(judge_scores) / 2:
                final_score = sum(scores) / len(scores)
            else:
                final_score = min(scores)
            agreement = max(pass_votes, len(judge_scores) - pass_votes) / len(judge_scores)

        elif strategy == "median":
            sorted_scores = sorted(scores)
            mid = len(sorted_scores) // 2
            if len(sorted_scores) % 2 != 0:
                final_score = sorted_scores[mid]
            else:
                final_score = (sorted_scores[mid - 1] + sorted_scores[mid]) / 2
            agreement = 1 - (max(scores) - min(scores)) / 100

        else:
            passed_judges = [j for j in judge_scores if j.passed]
            failed_judges = [j for j in judge_scores if not j.passed]

            if not passed_judges:
                final_score = min(scores)
            elif not failed_judges:
                final_score = sum(scores) / len(scores)
            else:
                passed_avg = sum(j.score for j in passed_judges) / len(passed_judges)
                failed_avg = sum(j.score for j in failed_judges) / len(failed_judges)
                final_score = passed_avg * 0.7 + failed_avg * 0.3

            variance = sum((s - final_score) ** 2 for s in scores) / len(scores)
            agreement = max(0.0, 1 - (variance ** 0.5) / 50)

        consensus_reached = agreement >= 0.6

        return ConsensusResult(
            final_score=round(final_score, 1),
            consensus_reached=consensus_reached,
            judge_scores=judge_scores,
            strategy=strategy,
            agreement=round(agreement, 2),
        )

    def _build_judge_prompt(self, input_data: EvaluationInput) -> str:
        current_output = input_data.current_output or "(无输出)"
        return (
            f"评估以下 AI 执行结果的质量。\n\n"
            f'用户输入: "{input_data.user_input}"\n'
            f'当前输出: "{current_output[:500]}"\n\n'
            f"请用 JSON 格式回答:\n"
            f'{{"score": 0-100, "reasoning": "评分理由", "passed": true/false}}'
        )

    def _parse_judge_response(self, response: str) -> dict[str, Any]:
        json_match = re.search(r"\{[\s\S]*\}", response)
        if not json_match:
            return {"score": 50, "reasoning": "解析失败", "passed": False}
        try:
            return json.loads(json_match.group())
        except (json.JSONDecodeError, TypeError):
            return {"score": 50, "reasoning": "解析失败", "passed": False}


PartialResult = dict[str, Any]
