"""旁路 LLM 客户端（Auxiliary LLM Client）。

将非核心任务（视觉分析、摘要生成、分类判断、格式转换等）
分流到廉价模型，降低主模型上下文占用和成本。

核心价值：
  - 视觉分析 → haiku/flash（成本 -90%）
  - 摘要生成 → haiku/flash（不占主模型上下文）
  - 分类判断 → haiku/flash（快速低延迟）
  - 格式转换 → haiku/flash（简单任务无需强模型）

与主 LLMProvider 的关系：
  - LLMProvider 负责核心对话（用户直接交互）
  - AuxiliaryClient 负责旁路任务（系统内部调用）

集成示例::

    from agent.llm.auxiliary_client import AuxiliaryLLMClient

    aux = AuxiliaryLLMClient(main_provider)
    summary = await aux.summarize("很长的文本...", max_tokens=100)
    category = await aux.classify("用户消息", categories=["bug", "feature", "question"])
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, TYPE_CHECKING
from agent.core.logger import StructuredLogger


if TYPE_CHECKING:
    from agent.llm.provider import LLMProvider

log = StructuredLogger("auxiliary_client")



class AuxiliaryTask(str, Enum):
    SUMMARIZE = "summarize"
    CLASSIFY = "classify"
    EXTRACT = "extract"
    TRANSLATE = "translate"
    FORMAT = "format"
    VISION = "vision"
    EMBEDDING_TEXT = "embedding_text"


@dataclass
class AuxiliaryModelConfig:
    model: str
    max_tokens: int
    temperature: float = 0.3
    cost_per_m_input: float = 0.0
    cost_per_m_output: float = 0.0


AUX_MODELS: dict[AuxiliaryTask, AuxiliaryModelConfig] = {
    AuxiliaryTask.SUMMARIZE: AuxiliaryModelConfig(
        model="anthropic/claude-3-haiku-20240307",
        max_tokens=200,
        temperature=0.3,
        cost_per_m_input=0.25,
        cost_per_m_output=1.25,
    ),
    AuxiliaryTask.CLASSIFY: AuxiliaryModelConfig(
        model="anthropic/claude-3-haiku-20240307",
        max_tokens=50,
        temperature=0.1,
        cost_per_m_input=0.25,
        cost_per_m_output=1.25,
    ),
    AuxiliaryTask.EXTRACT: AuxiliaryModelConfig(
        model="anthropic/claude-3-haiku-20240307",
        max_tokens=300,
        temperature=0.2,
        cost_per_m_input=0.25,
        cost_per_m_output=1.25,
    ),
    AuxiliaryTask.TRANSLATE: AuxiliaryModelConfig(
        model="anthropic/claude-3-haiku-20240307",
        max_tokens=1000,
        temperature=0.3,
        cost_per_m_input=0.25,
        cost_per_m_output=1.25,
    ),
    AuxiliaryTask.FORMAT: AuxiliaryModelConfig(
        model="anthropic/claude-3-haiku-20240307",
        max_tokens=500,
        temperature=0.1,
        cost_per_m_input=0.25,
        cost_per_m_output=1.25,
    ),
    AuxiliaryTask.VISION: AuxiliaryModelConfig(
        model="gemini/gemini-2.0-flash",
        max_tokens=300,
        temperature=0.3,
        cost_per_m_input=0.10,
        cost_per_m_output=0.40,
    ),
    AuxiliaryTask.EMBEDDING_TEXT: AuxiliaryModelConfig(
        model="anthropic/claude-3-haiku-20240307",
        max_tokens=100,
        temperature=0.0,
        cost_per_m_input=0.25,
        cost_per_m_output=1.25,
    ),
}

_SUMMARIZE_PROMPT = """请用 {max_sentences} 句话总结以下内容，保留关键信息：

{content}

摘要："""

_CLASSIFY_PROMPT = """请将以下内容分类到最匹配的类别中。

可选类别：{categories}

内容：{content}

只回答类别名称，不要解释。"""

_EXTRACT_PROMPT = """从以下内容中提取{target}。

内容：{content}

提取结果（JSON格式）："""

_TRANSLATE_PROMPT = """将以下内容翻译为{target_lang}，保持原文语气和格式：

{content}

翻译："""


@dataclass
class AuxiliaryResult:
    success: bool
    output: str = ""
    model: str = ""
    task: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    duration_ms: float = 0.0


@dataclass
class AuxiliaryStats:
    total_calls: int = 0
    total_cost_usd: float = 0.0
    by_task: dict[str, int] = field(default_factory=lambda: {})
    by_model: dict[str, int] = field(default_factory=lambda: {})


class AuxiliaryLLMClient:
    """旁路 LLM 客户端。

    将非核心任务分流到廉价模型，降低主模型成本和上下文占用。
    """

    def __init__(self, main_provider: Any = None) -> None:
        self._provider = main_provider
        self._stats = AuxiliaryStats()
        self._custom_models: dict[AuxiliaryTask, AuxiliaryModelConfig] = {}

    def set_model(self, task: AuxiliaryTask, config: AuxiliaryModelConfig) -> None:
        self._custom_models[task] = config

    def _get_config(self, task: AuxiliaryTask) -> AuxiliaryModelConfig:
        return self._custom_models.get(task, AUX_MODELS.get(task, AUX_MODELS[AuxiliaryTask.SUMMARIZE]))

    async def _call(self, task: AuxiliaryTask, prompt: str, max_tokens: int | None = None) -> AuxiliaryResult:
        config = self._get_config(task)
        model = config.model
        tokens = max_tokens or config.max_tokens
        start = time.monotonic()

        try:
            if self._provider is not None:
                response = await self._provider.chat(
                    messages=[{"role": "user", "content": prompt}],
                    model=model,
                    max_tokens=tokens,
                    temperature=config.temperature,
                )
                output = response if isinstance(response, str) else str(response)
                input_tokens = len(prompt) // 4
                output_tokens = len(output) // 4
            else:
                from agent.llm.provider import LLMProvider
                provider = LLMProvider()
                response = await provider.chat(
                    messages=[{"role": "user", "content": prompt}],
                    model=model,
                    max_tokens=tokens,
                    temperature=config.temperature,
                )
                output = response if isinstance(response, str) else str(response)
                input_tokens = len(prompt) // 4
                output_tokens = len(output) // 4

            cost = (
                input_tokens * config.cost_per_m_input / 1_000_000
                + output_tokens * config.cost_per_m_output / 1_000_000
            )
            duration = (time.monotonic() - start) * 1000

            self._stats.total_calls += 1
            self._stats.total_cost_usd += cost
            self._stats.by_task[task.value] = self._stats.by_task.get(task.value, 0) + 1
            self._stats.by_model[model] = self._stats.by_model.get(model, 0) + 1

            return AuxiliaryResult(
                success=True,
                output=output,
                model=model,
                task=task.value,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=cost,
                duration_ms=duration,
            )
        except Exception as e:
            log.debug("auxiliary_client 异常处理", error=str(e))
            duration = (time.monotonic() - start) * 1000
            log.error("旁路 LLM 调用失败", task=task.value, model=model, error=str(e))
            return AuxiliaryResult(
                success=False,
                output="",
                model=model,
                task=task.value,
                duration_ms=duration,
            )

    async def summarize(self, content: str, max_sentences: int = 3, max_tokens: int = 200) -> AuxiliaryResult:
        prompt = _SUMMARIZE_PROMPT.format(content=content[:4000], max_sentences=max_sentences)
        return await self._call(AuxiliaryTask.SUMMARIZE, prompt, max_tokens)

    async def classify(self, content: str, categories: list[str], max_tokens: int = 50) -> AuxiliaryResult:
        prompt = _CLASSIFY_PROMPT.format(content=content[:2000], categories=", ".join(categories))
        result = await self._call(AuxiliaryTask.CLASSIFY, prompt, max_tokens)
        if result.success:
            chosen = result.output.strip()
            if chosen not in categories:
                for cat in categories:
                    if cat.lower() in chosen.lower():
                        result.output = cat
                        break
                else:
                    result.output = categories[0] if categories else chosen
        return result

    async def extract(self, content: str, target: str, max_tokens: int = 300) -> AuxiliaryResult:
        prompt = _EXTRACT_PROMPT.format(content=content[:4000], target=target)
        return await self._call(AuxiliaryTask.EXTRACT, prompt, max_tokens)

    async def translate(self, content: str, target_lang: str = "English", max_tokens: int = 1000) -> AuxiliaryResult:
        prompt = _TRANSLATE_PROMPT.format(content=content[:4000], target_lang=target_lang)
        return await self._call(AuxiliaryTask.TRANSLATE, prompt, max_tokens)

    async def format_content(self, content: str, format_type: str = "markdown", max_tokens: int = 500) -> AuxiliaryResult:
        prompt = f"将以下内容格式化为{format_type}，保持信息完整：\n\n{content[:4000]}\n\n格式化结果："
        return await self._call(AuxiliaryTask.FORMAT, prompt, max_tokens)

    def get_stats(self) -> AuxiliaryStats:
        return self._stats
