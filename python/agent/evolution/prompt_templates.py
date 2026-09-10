"""模型家族专用 Prompt 模板库。

为不同 LLM 模型家族维护定制化的 Prompt 模板，
充分利用各模型的独特能力（如 Claude 的 extended thinking、
GPT-4o 的 structured output、DeepSeek 的 reasoning 等）。

Usage:
    registry = PromptTemplateRegistry()
    template = registry.get_template("claude-sonnet-4.5", "planning")
    prompt = template.render(user_input="分析代码", context=...)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("prompt_templates")



def _detect_model_family(model_name: str) -> str:
    """根据模型名称检测所属家族。

    Args:
        model_name: 模型名称（如 "claude-sonnet-4-20250514"）。

    Returns:
        str: 家族名称，如 "claude"、"gpt"、"gemini"、"deepseek"、"qwen"、"glm"。
    """
    lower = model_name.lower()
    if "claude" in lower:
        return "claude"
    if "gpt" in lower or "o1" in lower or "o3" in lower or "o4" in lower:
        return "gpt"
    if "gemini" in lower:
        return "gemini"
    if "deepseek" in lower:
        return "deepseek"
    if "qwen" in lower:
        return "qwen"
    if "glm" in lower or "chatglm" in lower:
        return "glm"
    return "generic"


@dataclass
class PromptTemplate:
    name: str
    category: str
    model_family: str
    template: str
    description: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def render(self, **kwargs: Any) -> str:
        return self.template.format(**kwargs)


class PromptTemplateRegistry:
    """Prompt 模板注册表。

    按模型家族和任务类别组织模板，支持：
    - 精确匹配：model_family + category
    - 家族回退：model_family 匹配但 category 不匹配时用 generic
    - 通用回退：所有都不匹配时用 generic 家族
    """

    def __init__(self) -> None:
        self._templates: dict[str, dict[str, PromptTemplate]] = {}
        self._register_defaults()

    def register(self, template: PromptTemplate) -> None:
        family = template.model_family
        if family not in self._templates:
            self._templates[family] = {}
        self._templates[family][template.category] = template
        log.debug("Prompt template registered", family=family, category=template.category)

    def get_template(self, model_name: str, category: str) -> PromptTemplate:
        family = _detect_model_family(model_name)
        family_templates = self._templates.get(family, {})
        if category in family_templates:
            return family_templates[category]
        if family != "generic" and "generic" in self._templates:
            generic_templates = self._templates["generic"]
            if category in generic_templates:
                return generic_templates[category]
        return self._get_fallback_template(category)

    def _get_fallback_template(self, category: str) -> PromptTemplate:
        default_templates = {
            "planning": PromptTemplate(
                name="default_planning",
                category="planning",
                model_family="generic",
                template="请将以下任务分解为可执行的步骤：\n{user_input}",
                description="通用规划模板",
            ),
            "evaluation": PromptTemplate(
                name="default_evaluation",
                category="evaluation",
                model_family="generic",
                template="请评估以下任务执行结果：\n目标：{user_input}\n结果：{result}",
                description="通用评估模板",
            ),
            "reflection": PromptTemplate(
                name="default_reflection",
                category="reflection",
                model_family="generic",
                template="请反思以下执行过程：\n{context}",
                description="通用反思模板",
            ),
            "code_generation": PromptTemplate(
                name="default_code_generation",
                category="code_generation",
                model_family="generic",
                template="请生成以下代码：\n{user_input}",
                description="通用代码生成模板",
            ),
            "tool_calling": PromptTemplate(
                name="default_tool_calling",
                category="tool_calling",
                model_family="generic",
                template="请执行以下操作：\n{user_input}",
                description="通用工具调用模板",
            ),
        }
        return default_templates.get(category, PromptTemplate(
            name="generic_fallback",
            category=category,
            model_family="generic",
            template="{user_input}",
            description="通用回退模板",
        ))

    def _register_defaults(self) -> None:
        self._register_claude_templates()
        self._register_gpt_templates()
        self._register_deepseek_templates()
        self._register_gemini_templates()
        self._register_qwen_templates()
        self._register_glm_templates()
        self._register_generic_templates()

    def _register_claude_templates(self) -> None:
        family = "claude"

        self.register(PromptTemplate(
            name="claude_planning",
            category="planning",
            model_family=family,
            template=(
                "You are a strategic planning expert. Your task is to decompose "
                "the user's request into a clear, executable plan.\n\n"
                "Think step by step about the best approach:\n"
                "1. What is the core goal?\n"
                "2. What information is needed?\n"
                "3. What tools or actions are required?\n"
                "4. What is the optimal order of execution?\n\n"
                "User request: {user_input}\n\n"
                "{context}"
                "Provide your plan as a structured JSON with reasoning, steps, and recommended tools."
            ),
            description="Claude 专用规划模板 — 利用 extended thinking 能力",
        ))

        self.register(PromptTemplate(
            name="claude_evaluation",
            category="evaluation",
            model_family=family,
            template=(
                "You are a quality assurance expert. Evaluate the execution results "
                "against the original goal. Be thorough and honest.\n\n"
                "Original goal: {user_input}\n"
                "Execution results: {result}\n\n"
                "Evaluate across these dimensions:\n"
                "- Goal completion (0.0-1.0)\n"
                "- Factual accuracy (0.0-1.0)\n"
                "- Citation accuracy (0.0-1.0)\n"
                "- Relevance (0.0-1.0)\n"
                "- Safety concerns (true/false)\n\n"
                "Return JSON with scores and detailed reasoning."
            ),
            description="Claude 专用评估模板",
        ))

        self.register(PromptTemplate(
            name="claude_reflection",
            category="reflection",
            model_family=family,
            template=(
                "You are a self-improvement analyst. Review the execution process "
                "and identify what went well and what could be improved.\n\n"
                "Execution context:\n{context}\n\n"
                "Analyze:\n"
                "1. What worked well?\n"
                "2. What failed or could be improved?\n"
                "3. What patterns can be learned?\n"
                "4. What specific changes should be made?\n\n"
                "Provide structured analysis with actionable insights."
            ),
            description="Claude 专用反思模板",
        ))

        self.register(PromptTemplate(
            name="claude_code_generation",
            category="code_generation",
            model_family=family,
            template=(
                "You are an expert software engineer. Write clean, well-documented, "
                "production-quality code. Include type hints, docstrings, and error handling.\n\n"
                "Requirements: {user_input}\n\n"
                "Follow these guidelines:\n"
                "- Use modern Python best practices\n"
                "- Include comprehensive type annotations\n"
                "- Add meaningful docstrings\n"
                "- Handle edge cases and errors\n"
                "- Write readable, maintainable code\n\n"
                "Provide the complete implementation with brief explanation."
            ),
            description="Claude 专用代码生成模板",
        ))

    def _register_gpt_templates(self) -> None:
        family = "gpt"

        self.register(PromptTemplate(
            name="gpt_planning",
            category="planning",
            model_family=family,
            template=(
                "You are a task planning assistant. Break down the user's request "
                "into concrete, executable steps. Use structured output format.\n\n"
                "User request: {user_input}\n\n"
                "{context}"
                "Output a JSON plan with: reasoning, steps (each with step_id, "
                "description, tool_name, tool_params), and recommended_tools."
            ),
            description="GPT 专用规划模板 — 利用 structured output 能力",
        ))

        self.register(PromptTemplate(
            name="gpt_evaluation",
            category="evaluation",
            model_family=family,
            template=(
                "Evaluate the following task execution:\n"
                "Goal: {user_input}\n"
                "Results: {result}\n\n"
                "Return JSON: goalProgress, qualityScore, factualAccuracy, "
                "citationAccuracy, relevanceScore, safetyFlag, suggestedAction, reason."
            ),
            description="GPT 专用评估模板 — 简洁高效",
        ))

        self.register(PromptTemplate(
            name="gpt_code_generation",
            category="code_generation",
            model_family=family,
            template=(
                "Write production-quality Python code for:\n{user_input}\n\n"
                "Include type hints, docstrings, and error handling. "
                "Use modern Python 3.11+ features where appropriate."
            ),
            description="GPT 专用代码生成模板",
        ))

    def _register_deepseek_templates(self) -> None:
        family = "deepseek"

        self.register(PromptTemplate(
            name="deepseek_planning",
            category="planning",
            model_family=family,
            template=(
                "你是一个任务规划专家。请将用户需求分解为具体的执行步骤。\n\n"
                "用户需求：{user_input}\n\n"
                "{context}"
                "请提供详细的执行计划，包括：\n"
                "1. 任务分析\n"
                "2. 步骤分解（每步含描述、工具名、参数）\n"
                "3. 推荐工具列表\n\n"
                "以 JSON 格式输出。"
            ),
            description="DeepSeek 专用规划模板 — 中文优化",
        ))

        self.register(PromptTemplate(
            name="deepseek_code_generation",
            category="code_generation",
            model_family=family,
            template=(
                "你是一个编程专家。请编写高质量的 Python 代码：\n"
                "需求：{user_input}\n\n"
                "要求：类型注解、文档字符串、错误处理、现代化代码风格。"
            ),
            description="DeepSeek 专用代码生成模板",
        ))

    def _register_gemini_templates(self) -> None:
        family = "gemini"

        self.register(PromptTemplate(
            name="gemini_planning",
            category="planning",
            model_family=family,
            template=(
                "Task: {user_input}\n\n"
                "Create a step-by-step execution plan. For each step, specify:\n"
                "- What to do\n"
                "- Which tool to use (if any)\n"
                "- Expected output\n\n"
                "{context}"
                "Output as JSON."
            ),
            description="Gemini 专用规划模板",
        ))

    def _register_qwen_templates(self) -> None:
        family = "qwen"

        self.register(PromptTemplate(
            name="qwen_planning",
            category="planning",
            model_family=family,
            template=(
                "你是一个智能助手，请将以下任务分解为可执行的步骤：\n\n"
                "任务：{user_input}\n\n"
                "{context}"
                "请返回 JSON 格式的执行计划，包含 reasoning、steps 和 recommended_tools。"
            ),
            description="Qwen 专用规划模板",
        ))

    def _register_glm_templates(self) -> None:
        family = "glm"

        self.register(PromptTemplate(
            name="glm_planning",
            category="planning",
            model_family=family,
            template=(
                "请分析并分解以下任务：\n\n"
                "任务：{user_input}\n\n"
                "{context}"
                "以 JSON 格式返回执行计划，包含 reasoning、steps 和工具推荐。"
            ),
            description="GLM 专用规划模板",
        ))

    def _register_generic_templates(self) -> None:
        family = "generic"

        self.register(PromptTemplate(
            name="generic_planning",
            category="planning",
            model_family=family,
            template=(
                "You are a task planning assistant. Break down the following task "
                "into executable steps.\n\n"
                "Task: {user_input}\n\n"
                "{context}"
                "Provide a JSON plan with: reasoning, steps (each with step_id, "
                "description, tool_name, tool_params), and recommended_tools."
            ),
            description="通用规划模板",
        ))

        self.register(PromptTemplate(
            name="generic_evaluation",
            category="evaluation",
            model_family=family,
            template=(
                "Evaluate the execution of this task:\n"
                "Goal: {user_input}\n"
                "Results: {result}\n\n"
                "Return JSON: goalProgress, qualityScore, factualAccuracy, "
                "citationAccuracy, relevanceScore, safetyFlag, suggestedAction."
            ),
            description="通用评估模板",
        ))

        self.register(PromptTemplate(
            name="generic_reflection",
            category="reflection",
            model_family=family,
            template=(
                "Review the following execution context and identify improvements:\n"
                "{context}\n\n"
                "Provide structured feedback with actionable suggestions."
            ),
            description="通用反思模板",
        ))

        self.register(PromptTemplate(
            name="generic_code_generation",
            category="code_generation",
            model_family=family,
            template=(
                "Write Python code for the following requirement:\n"
                "{user_input}\n\n"
                "Include type hints, docstrings, and error handling."
            ),
            description="通用代码生成模板",
        ))

        self.register(PromptTemplate(
            name="generic_tool_calling",
            category="tool_calling",
            model_family=family,
            template=(
                "Execute the following action using available tools:\n"
                "{user_input}\n\n"
                "Call the appropriate tools with correct parameters."
            ),
            description="通用工具调用模板",
        ))


_global_registry: PromptTemplateRegistry | None = None


def get_prompt_template_registry() -> PromptTemplateRegistry:
    global _global_registry
    if _global_registry is None:
        _global_registry = PromptTemplateRegistry()
    return _global_registry
