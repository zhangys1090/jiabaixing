"""澄清交互集成 (Clarification Integration)。

任务模糊时主动提问，而非猜测执行。通过系统提示增强和模糊度检测，
引导 LLM 在需要时使用 clarify 工具向用户发起结构化澄清请求。

核心能力：
1. 模糊度检测：分析用户输入，判断是否需要澄清
2. 系统提示增强：在 system prompt 中注入澄清引导指令
3. Clarify 工具拦截：检测到 clarify 调用时暂停循环，返回澄清请求
4. 澄清上下文：将澄清结果注入后续对话的上下文

架构：
    User Input → AmbiguityDetector → [ambiguous]
        → enhanced_system_prompt + clarify_tool
        → LLM → clarify tool call → pause → return clarification
        → user responds → resume with context

    User Input → AmbiguityDetector → [clear]
        → normal execution

Usage:
    detector = ClarificationEngine()
    result = await detector.check_ambiguity("帮我写个东西")
    if result.is_ambiguous:
        prompt = detector.build_clarification_prompt(result)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("clarification")



class AmbiguityLevel(str, Enum):
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class AmbiguityDimension(str, Enum):
    MISSING_GOAL = "missing_goal"
    MISSING_CONTEXT = "missing_context"
    MISSING_CONSTRAINTS = "missing_constraints"
    MULTIPLE_INTERPRETATIONS = "multiple_interpretations"
    VAGUE_TERMS = "vague_terms"
    MISSING_FORMAT = "missing_format"


@dataclass
class AmbiguityResult:
    is_ambiguous: bool = False
    level: AmbiguityLevel = AmbiguityLevel.NONE
    dimensions: list[AmbiguityDimension] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    recommended_questions: list[str] = field(default_factory=list)
    confidence: float = 0.0


@dataclass
class ClarificationConfig:
    enabled: bool = True
    auto_detect: bool = True
    max_questions: int = 3
    min_input_length_for_detection: int = 5
    aggressive_mode: bool = False


class AmbiguityDetector:
    """模糊度检测器 — 基于规则和启发式算法分析用户输入的模糊程度。

    检测维度：
    - missing_goal: 缺少明确目标（"帮我做点什么"）
    - missing_context: 缺少上下文（"修复那个bug"）
    - missing_constraints: 缺少约束条件（"生成一个报告"）
    - multiple_interpretations: 多种解释（"运行一下"）
    - vague_terms: 模糊术语（"那个东西"、"上次那个"）
    - missing_format: 缺少输出格式要求
    """

    VAGUE_PATTERNS = [
        "那个", "这个", "之前那个", "上次那个", "那些",
        "东西", "什么", "怎么样", "随便", "都可以",
        "弄一下", "搞一下", "处理一下", "帮我看看",
        "不太清楚", "大概是", "应该是", "好像是",
    ]

    AMBIGUOUS_PREFIXES = [
        "帮我写", "帮我做", "帮我查", "帮我找",
        "能不能", "可以吗", "怎么样", "如何",
        "分析一下", "解释一下", "说明一下",
    ]

    MISSING_GOAL_PATTERNS = [
        "帮我做点什么", "有什么建议", "推荐一下",
        "看看有什么", "能做些什么", "有什么功能",
    ]

    def detect(self, user_input: str) -> AmbiguityResult:
        """检测用户输入的模糊程度。

        Args:
            user_input: 用户输入文本。

        Returns:
            AmbiguityResult: 模糊度分析结果。
        """
        text = user_input.strip()
        dimensions: list[AmbiguityDimension] = []
        suggestions: list[str] = []
        questions: list[str] = []

        if len(text) < 5:
            return AmbiguityResult(
                is_ambiguous=True,
                level=AmbiguityLevel.HIGH,
                dimensions=[AmbiguityDimension.MISSING_GOAL],
                suggestions=["请提供更详细的任务描述"],
                recommended_questions=["请问您具体需要我做什么？"],
                confidence=0.9,
            )

        if self._check_missing_goal(text):
            dimensions.append(AmbiguityDimension.MISSING_GOAL)
            suggestions.append("请明确您想要达成的具体目标")
            questions.append("请问您希望达成什么具体目标？")

        if self._check_missing_context(text):
            dimensions.append(AmbiguityDimension.MISSING_CONTEXT)
            suggestions.append("请提供更多上下文信息（如相关文件、环境等）")
            questions.append("能否提供更多背景信息或上下文？")

        if self._check_missing_constraints(text):
            dimensions.append(AmbiguityDimension.MISSING_CONSTRAINTS)
            suggestions.append("请说明约束条件（如时间限制、格式要求、技术栈等）")
            questions.append("有什么特别的限制或要求吗？")

        if self._check_vague_terms(text):
            dimensions.append(AmbiguityDimension.VAGUE_TERMS)
            suggestions.append("请使用更具体的术语描述，避免模糊指代")
            questions.append("您提到的'那个'具体是指什么？")

        if self._check_multiple_interpretations(text):
            dimensions.append(AmbiguityDimension.MULTIPLE_INTERPRETATIONS)
            suggestions.append("您的描述有多种理解方式，请确认具体意图")
            questions.append("我理解有几种可能，您指的是哪一种？")

        if self._check_missing_format(text):
            dimensions.append(AmbiguityDimension.MISSING_FORMAT)
            suggestions.append("请说明期望的输出格式")
            questions.append("您希望以什么格式输出结果？")

        is_ambiguous = len(dimensions) > 0

        level = AmbiguityLevel.NONE
        if is_ambiguous:
            if len(dimensions) >= 3:
                level = AmbiguityLevel.HIGH
            elif len(dimensions) >= 2:
                level = AmbiguityLevel.MEDIUM
            else:
                level = AmbiguityLevel.LOW

        confidence = min(0.95, 0.5 + len(dimensions) * 0.15)

        return AmbiguityResult(
            is_ambiguous=is_ambiguous,
            level=level,
            dimensions=dimensions,
            suggestions=suggestions,
            recommended_questions=questions[:3],
            confidence=confidence,
        )

    def _check_missing_goal(self, text: str) -> bool:
        for pattern in self.MISSING_GOAL_PATTERNS:
            if pattern in text:
                return True
        words = text.split()
        if len(words) <= 3 and not any(
            kw in text for kw in ["创建", "删除", "修改", "查询", "生成", "分析", "计算", "转换"]
        ):
            return True
        return False

    def _check_missing_context(self, text: str) -> bool:
        context_indicators = [
            "修复", "debug", "那个bug", "那个错误", "那个问题",
            "之前那个", "上次", "继续", "接着做",
        ]
        return any(ind in text for ind in context_indicators)

    def _check_missing_constraints(self, text: str) -> bool:
        action_words = ["生成", "创建", "写", "做", "构建", "开发"]
        if not any(aw in text for aw in action_words):
            return False
        constraint_keywords = [
            "用", "使用", "基于", "按照", "参考", "遵循",
            "限制", "不超过", "至少", "在", "之前", "之后",
        ]
        return not any(ck in text for ck in constraint_keywords)

    def _check_vague_terms(self, text: str) -> bool:
        return any(pattern in text for pattern in self.VAGUE_PATTERNS)

    def _check_multiple_interpretations(self, text: str) -> bool:
        ambiguous_verbs = ["运行", "执行", "处理", "操作", "管理"]
        count = sum(1 for v in ambiguous_verbs if v in text)
        if count >= 1 and len(text) < 15:
            return not any(
                kw in text for kw in ["文件", "代码", "脚本", "命令", "程序", "服务", "数据库"]
            )
        return False

    def _check_missing_format(self, text: str) -> bool:
        output_actions = ["生成", "输出", "导出", "写出", "展示", "显示", "返回"]
        if not any(oa in text for oa in output_actions):
            return False
        format_keywords = [
            "json", "csv", "表格", "列表", "报告", "文档", "markdown",
            "文本", "图表", "格式化", "json格式", "按...格式",
        ]
        return not any(fk in text for fk in format_keywords)


CLARIFICATION_SYSTEM_PROMPT = """
## 澄清引导规则

在回答用户问题前，请先判断任务是否足够清晰。如果存在以下情况，请使用 `clarify` 工具向用户发起澄清请求：

1. **目标不明确**: 用户没有说明具体要达成什么
2. **缺少上下文**: 任务需要但缺少关键背景信息
3. **缺少约束**: 任务需要但未指定技术栈、格式、限制等
4. **多种解释**: 用户的描述可以有多种理解方式
5. **模糊指代**: 用户使用了"那个"、"上次"等模糊指代

使用 `clarify` 工具时：
- 问题要具体、简洁，一次不超过 3 个问题
- 提供选项时给出 2-4 个合理选项
- 在 context 字段中说明为什么需要澄清
- 不要让用户感到被审问，保持友好语气

如果任务足够清晰，直接执行，不要过度澄清。
"""


class ClarificationEngine:
    """澄清引擎 — 集成模糊度检测和系统提示增强。

    使用方式：
    1. 在系统提示中加入澄清引导规则
    2. 在对话循环中检测 clarify 工具调用
    3. 捕获 clarify 调用后暂停循环，返回给用户
    """

    def __init__(self, config: ClarificationConfig | None = None) -> None:
        self._config = config or ClarificationConfig()
        self._detector = AmbiguityDetector()
        self._clarification_count = 0

    def enhance_system_prompt(self, base_prompt: str) -> str:
        """增强系统提示，加入澄清引导规则。

        Args:
            base_prompt: 原始系统提示。

        Returns:
            str: 增强后的系统提示。
        """
        if not self._config.enabled:
            return base_prompt

        if CLARIFICATION_SYSTEM_PROMPT.strip() in base_prompt:
            return base_prompt

        return base_prompt.rstrip() + "\n\n" + CLARIFICATION_SYSTEM_PROMPT.strip()

    def detect_ambiguity(self, user_input: str) -> AmbiguityResult:
        """检测用户输入的模糊程度。

        Args:
            user_input: 用户输入。

        Returns:
            AmbiguityResult: 模糊度分析结果。
        """
        if not self._config.auto_detect:
            return AmbiguityResult()

        if len(user_input.strip()) < self._config.min_input_length_for_detection:
            return AmbiguityResult(
                is_ambiguous=True,
                level=AmbiguityLevel.HIGH,
                dimensions=[AmbiguityDimension.MISSING_GOAL],
                suggestions=["请提供更详细的任务描述"],
                recommended_questions=["请问您具体需要我做什么？"],
                confidence=0.95,
            )

        result = self._detector.detect(user_input)

        if self._config.aggressive_mode and not result.is_ambiguous:
            if len(user_input) < 20:
                result.is_ambiguous = True
                result.level = AmbiguityLevel.LOW
                result.dimensions.append(AmbiguityDimension.MISSING_CONTEXT)
                result.suggestions.append("请提供更多详情以确保准确执行")
                result.confidence = 0.6

        return result

    def is_clarify_tool_call(self, tool_name: str) -> bool:
        """判断工具调用是否为澄清请求。

        Args:
            tool_name: 工具名称。

        Returns:
            bool: 是否为 clarify 工具调用。
        """
        return tool_name == "clarify"

    def build_clarification_context(
        self,
        ambiguity: AmbiguityResult,
        user_input: str,
    ) -> str:
        """构建澄清上下文，注入到对话中。

        Args:
            ambiguity: 模糊度分析结果。
            user_input: 原始用户输入。

        Returns:
            str: 澄清上下文文本。
        """
        if not ambiguity.is_ambiguous:
            return ""

        parts: list[str] = []
        parts.append(f"用户请求: {user_input}")
        parts.append("")
        parts.append("检测到以下模糊点：")

        dimension_labels = {
            AmbiguityDimension.MISSING_GOAL: "目标不明确",
            AmbiguityDimension.MISSING_CONTEXT: "缺少上下文",
            AmbiguityDimension.MISSING_CONSTRAINTS: "缺少约束条件",
            AmbiguityDimension.MULTIPLE_INTERPRETATIONS: "存在多种解释",
            AmbiguityDimension.VAGUE_TERMS: "使用了模糊术语",
            AmbiguityDimension.MISSING_FORMAT: "缺少输出格式要求",
        }

        for dim in ambiguity.dimensions:
            label = dimension_labels.get(dim, dim.value)
            parts.append(f"  - {label}")

        if ambiguity.suggestions:
            parts.append("")
            parts.append("建议: " + "; ".join(ambiguity.suggestions))

        return "\n".join(parts)

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "clarification_count": self._clarification_count,
            "enabled": self._config.enabled,
            "auto_detect": self._config.auto_detect,
        }
