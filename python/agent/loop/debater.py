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
    """默认辩论器 — 审查执行计划的漏洞和风险.

    支持单轮辩论（debate）、多轮辩论（multi_round_debate）、
    魔鬼代言人模式（_play_devils_advocate）和严格度调节。

    Attributes:
        llm: 可选的 LLM 实例，用于 LLM 驱动的辩论.
        _strictness: 当前严格度级别 (lenient / normal / strict).

    Usage:
        debater = DefaultDebater()
        result = await debater.debate(plan, input_text)
        # 多轮辩论
        result = await debater.multi_round_debate(plan, input_text, rounds=3)
    """

    MAX_DEBATE_ROUNDS = 3
    QUALITY_THRESHOLD = 0.7

    # 严格度配置：影响质量阈值和扣分权重
    _STRICTNESS_CONFIG: dict[str, dict[str, float]] = {
        "lenient": {"quality_threshold": 0.5, "penalty_factor": 0.7},
        "normal": {"quality_threshold": 0.7, "penalty_factor": 1.0},
        "strict": {"quality_threshold": 0.85, "penalty_factor": 1.5},
    }

    def __init__(self, llm: LLMProtocol | None = None) -> None:
        """初始化辩论器.

        Args:
            llm: 可选的 LLM 实例.
        """
        self.llm = llm
        self._strictness: str = "normal"

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

        # 步骤遗漏检测：如果用户要求多个动作但计划步骤不足
        action_keywords = ["并且", "同时", "以及", "然后", "再", "和"]
        input_lower = input_text.lower()
        action_count = sum(1 for kw in action_keywords if kw in input_text)
        if action_count >= 2 and len(plan.steps) < action_count + 1:
            vulnerabilities.append(
                f"用户需求包含至少 {action_count + 1} 个子任务，但计划只有 {len(plan.steps)} 步，可能遗漏步骤"
            )
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

        # 工具合理性检测：检查步骤描述与工具名是否匹配
        for step in plan.steps:
            if step.tool_name and step.description:
                tool_lower = step.tool_name.lower()
                desc_lower = step.description.lower()
                # 如果工具名和描述完全不相关（没有共同关键词）
                tool_words = [w for w in tool_lower.replace("_", " ").split() if len(w) > 2]
                desc_words = [w for w in desc_lower.split() if len(w) > 2]
                if tool_words and desc_words:
                    overlap = any(tw in desc_words for tw in tool_words)
                    if not overlap and len(plan.steps) > 1:
                        improvements.append(
                            f"步骤 \"{step.description}\" 使用的工具 \"{step.tool_name}\" "
                            f"与描述似乎不匹配，请确认工具选择是否合理"
                        )
                        quality_score -= 0.03

        # 超时风险评估：如果步骤很多且部分步骤缺少 max_retries
        if len(plan.steps) > 3:
            steps_no_retry = [s for s in plan.steps if s.max_retries == 0]
            if steps_no_retry:
                improvements.append(
                    f"有 {len(steps_no_retry)} 个步骤未设置重试次数，"
                    f"在长计划中可能因单步失败导致整体超时"
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

    async def multi_round_debate(
        self,
        plan: ExecutionPlan,
        input_text: str,
        rounds: int = 3,
    ) -> DebaterOutput:
        """多轮辩论：辩方 → 反辩 → 最终评判.

        每轮中，魔鬼代言人先找漏洞，辩护方再回应，最后评判。
        上一轮的评判结果会反馈到下一轮，使辩论逐步深入。

        Args:
            plan: 执行计划.
            input_text: 用户输入.
            rounds: 辩论轮数，默认 3.

        Returns:
            DebaterOutput: 最终辩论结果.
        """
        all_vulnerabilities: list[str] = []
        all_improvements: list[str] = []

        for round_idx in range(rounds):
            # 魔鬼代言人找漏洞
            vulnerabilities = self._play_devils_advocate(plan, input_text)

            # 如果有 LLM，增强魔鬼代言人
            if self.llm and vulnerabilities:
                try:
                    llm_vulns = await self._llm_devils_advocate(plan, input_text)
                    vulnerabilities.extend(llm_vulns)
                except Exception:
                    pass

            # 辩护方回应
            defenses = self._defend_plan(plan, input_text, vulnerabilities)

            # 评判
            result = self._judge_debate(vulnerabilities, defenses)

            all_vulnerabilities.extend(vulnerabilities)
            all_improvements.extend(result.improvements)

            # 如果本轮通过，可以提前结束
            if result.passed:
                return DebaterOutput(
                    passed=True,
                    vulnerabilities=all_vulnerabilities,
                    improvements=all_improvements,
                    quality_score=result.quality_score,
                    debate_rounds=round_idx + 1,
                )

        # 所有轮次都未通过
        config = self._STRICTNESS_CONFIG.get(self._strictness, self._STRICTNESS_CONFIG["normal"])
        threshold = config["quality_threshold"]

        # 重新计算最终质量分
        final_score = 0.8
        penalty_factor = config["penalty_factor"]
        final_score -= len(all_vulnerabilities) * 0.1 * penalty_factor
        final_score = max(0.0, min(1.0, final_score))

        return DebaterOutput(
            passed=final_score >= threshold,
            vulnerabilities=all_vulnerabilities,
            improvements=all_improvements,
            quality_score=final_score,
            debate_rounds=rounds,
        )

    def _play_devils_advocate(
        self,
        plan: ExecutionPlan,
        input_text: str,
    ) -> list[str]:
        """魔鬼代言人：专门找漏洞.

        从多个角度寻找计划的潜在问题，比基础规则更激进。

        Args:
            plan: 执行计划.
            input_text: 用户输入.

        Returns:
            list[str]: 发现的漏洞列表.
        """
        vulnerabilities: list[str] = []
        config = self._STRICTNESS_CONFIG.get(self._strictness, self._STRICTNESS_CONFIG["normal"])
        penalty_factor = config["penalty_factor"]

        # 1. 空计划
        if len(plan.steps) == 0:
            vulnerabilities.append("计划没有任何步骤，无法执行")
            return vulnerabilities

        # 2. 步骤遗漏
        if len(plan.steps) == 1 and not plan.simple:
            vulnerabilities.append("非简单任务只有1个步骤，极可能遗漏中间步骤")

        # 3. 步骤间缺少衔接
        step_ids = {s.step_id for s in plan.steps}
        for step in plan.steps:
            if step.input_from_step and step.input_from_step not in step_ids:
                vulnerabilities.append(
                    f"步骤 {step.step_id} 引用了不存在的上游步骤 {step.input_from_step}"
                )

        # 4. 重复步骤检测
        descriptions = [s.description.strip().lower() for s in plan.steps]
        seen: dict[str, int] = {}
        for i, desc in enumerate(descriptions):
            if desc in seen:
                vulnerabilities.append(
                    f"步骤 {plan.steps[i].step_id} 与步骤 {plan.steps[seen[desc]].step_id} "
                    f"描述重复，可能存在冗余"
                )
            else:
                seen[desc] = i

        # 5. 工具缺失
        steps_without_tool = [
            s for s in plan.steps
            if not s.tool_name
            and "分析" not in s.description
            and "思考" not in s.description
            and "总结" not in s.description
        ]
        if steps_without_tool:
            for s in steps_without_tool[:3]:  # 最多报告3个
                vulnerabilities.append(f"步骤 \"{s.description}\" 没有指定工具，执行可能不明确")

        # 6. 用户需求相关性
        input_keywords = [kw for kw in input_text.lower().split() if len(kw) > 2]
        if input_keywords:
            plan_text = " ".join(s.description.lower() for s in plan.steps)
            relevant = sum(1 for kw in input_keywords if kw in plan_text)
            if relevant < len(input_keywords) * 0.3:
                vulnerabilities.append("计划与用户需求的相关性低，可能偏离了目标")

        # 7. 严格模式额外检查
        if self._strictness == "strict":
            # 检查每个步骤是否有错误处理
            for step in plan.steps:
                if step.max_retries == 0:
                    vulnerabilities.append(
                        f"步骤 {step.step_id} 未设置重试次数，单点失败风险"
                    )

        return vulnerabilities

    async def _llm_devils_advocate(
        self,
        plan: ExecutionPlan,
        input_text: str,
    ) -> list[str]:
        """使用 LLM 增强魔鬼代言人.

        Args:
            plan: 执行计划.
            input_text: 用户输入.

        Returns:
            list[str]: LLM 发现的额外漏洞列表.
        """
        if not self.llm:
            return []

        steps = "\n".join(
            f"{i + 1}. {s.description}"
            + (f" (工具: {s.tool_name})" if s.tool_name else "")
            for i, s in enumerate(plan.steps)
        )

        prompt = (
            "你是一个极其严格的计划审查员（魔鬼代言人）。你的任务是不择手段地找出以下计划中的每一个潜在问题。\n\n"
            f"用户需求: {input_text}\n\n"
            f"执行计划:\n{steps}\n\n"
            "请列出所有你发现的漏洞和风险，每条一行，不要输出其他内容。"
        )

        try:
            response = await self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            content = response.get("content", "")
            # 按行分割，过滤空行
            vulns = [line.strip().lstrip("-•0123456789. ") for line in content.split("\n") if line.strip()]
            return [v for v in vulns if len(v) > 3][:5]  # 最多5条
        except Exception:
            return []

    def _defend_plan(
        self,
        plan: ExecutionPlan,
        input_text: str,
        vulnerabilities: list[str],
    ) -> list[str]:
        """辩护方：回应漏洞.

        为每个漏洞提供辩护或解释，说明为什么该漏洞可能不成立或已有缓解。

        Args:
            plan: 执行计划.
            input_text: 用户输入.
            vulnerabilities: 魔鬼代言人发现的漏洞.

        Returns:
            list[str]: 辩护理由列表，与 vulnerabilities 一一对应.
        """
        defenses: list[str] = []

        for vuln in vulnerabilities:
            defense = self._generate_defense(vuln, plan, input_text)
            defenses.append(defense)

        return defenses

    @staticmethod
    def _generate_defense(
        vulnerability: str,
        plan: ExecutionPlan,
        input_text: str,
    ) -> str:
        """为单个漏洞生成辩护.

        Args:
            vulnerability: 漏洞描述.
            plan: 执行计划.
            input_text: 用户输入.

        Returns:
            str: 辩护理由.
        """
        vuln_lower = vulnerability.lower()

        # 空计划无法辩护
        if "没有" in vuln_lower and "步骤" in vuln_lower:
            return "无法辩护：计划确实没有步骤"

        # 步骤遗漏辩护
        if "遗漏" in vuln_lower or "只有1" in vuln_lower:
            if plan.simple:
                return "该任务标记为简单任务，单步骤可能足够"
            return "遗漏风险存在，但可通过执行中动态补充步骤来缓解"

        # 工具缺失辩护
        if "工具" in vuln_lower and ("没有" in vuln_lower or "未指定" in vuln_lower):
            return "部分步骤可以由 LLM 直接完成，不一定需要外部工具"

        # 相关性辩护
        if "相关性" in vuln_lower or "偏离" in vuln_lower:
            return "计划步骤可能以不同措辞覆盖了用户需求，未必完全偏离"

        # 重复辩护
        if "重复" in vuln_lower:
            return "类似步骤可能是在不同上下文中执行，并非真正冗余"

        # 重试辩护
        if "重试" in vuln_lower:
            return "默认重试机制可由执行器层面提供，不一定要在计划中显式声明"

        # 默认辩护
        return "该风险在可控范围内，可通过监控和人工干预缓解"

    def _judge_debate(
        self,
        vulnerabilities: list[str],
        defenses: list[str],
    ) -> DebaterOutput:
        """最终评判：综合漏洞和辩护做出裁决.

        评估每个漏洞的辩护是否充分，辩护成功的漏洞不计入致命问题。

        Args:
            vulnerabilities: 漏洞列表.
            defenses: 辩护列表.

        Returns:
            DebaterOutput: 评判结果.
        """
        config = self._STRICTNESS_CONFIG.get(self._strictness, self._STRICTNESS_CONFIG["normal"])
        threshold = config["quality_threshold"]
        penalty_factor = config["penalty_factor"]

        quality_score = 0.9
        unmitigated: list[str] = []
        improvements: list[str] = []

        for vuln, defense in zip(vulnerabilities, defenses):
            # 判断辩护是否充分
            defense_lower = defense.lower()
            is_weak_defense = (
                "无法辩护" in defense_lower
                or "确实" in defense_lower
            )
            is_partial_defense = (
                "缓解" in defense_lower
                or "监控" in defense_lower
                or "可能" in defense_lower
            )

            if is_weak_defense:
                # 辩护失败：漏洞未被缓解
                unmitigated.append(vuln)
                quality_score -= 0.15 * penalty_factor
            elif is_partial_defense:
                # 部分辩护：风险降低但仍存在
                improvements.append(f"风险已部分缓解但建议关注: {vuln}")
                quality_score -= 0.05 * penalty_factor
            # 充分辩护：不扣分

        quality_score = max(0.0, min(1.0, quality_score))
        passed = quality_score >= threshold and len(unmitigated) == 0

        return DebaterOutput(
            passed=passed,
            vulnerabilities=unmitigated,
            improvements=improvements,
            quality_score=quality_score,
            debate_rounds=1,
        )

    def set_strictness(self, level: str) -> None:
        """设置严格度级别.

        Args:
            level: 严格度级别，可选值: lenient / normal / strict.

        Raises:
            ValueError: 当 level 不是合法值时.
        """
        valid_levels = ("lenient", "normal", "strict")
        if level not in valid_levels:
            raise ValueError(f"无效的严格度级别: {level}，可选值: {valid_levels}")
        self._strictness = level
