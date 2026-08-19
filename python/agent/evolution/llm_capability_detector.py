from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("llm_capability_detector")

_STORAGE_KEY = "llm_capabilities"
_CACHE_TTL_SECONDS = 24 * 60 * 60
_MAX_CACHE_ENTRIES = 10


class LLMProtocol(Protocol):
    async def chat(self, messages: list[dict[str, str]], **kwargs: Any) -> dict[str, Any]: ...


@dataclass
class LLMCapabilities:
    provider: str = ""
    model_name: str = ""
    detected_at: float = 0.0
    context_window: int = 4096
    reasoning_depth: int = 3
    tool_calling_accuracy: float = 0.5
    code_generation: int = 3
    multi_modal: bool = False
    structured_output: float = 0.5
    overall_score: float = 3.0
    runtime_samples: int = 0
    probe_version: int = 0
    extended_thinking: bool = False
    structured_output_native: bool = False
    vision_capable: bool = False
    model_family: str = "generic"
    vision_understanding: float = 0.0
    agent_native: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model_name": self.model_name,
            "detected_at": self.detected_at,
            "context_window": self.context_window,
            "reasoning_depth": self.reasoning_depth,
            "tool_calling_accuracy": self.tool_calling_accuracy,
            "code_generation": self.code_generation,
            "multi_modal": self.multi_modal,
            "structured_output": self.structured_output,
            "overall_score": self.overall_score,
            "runtime_samples": self.runtime_samples,
            "probe_version": self.probe_version,
            "extended_thinking": self.extended_thinking,
            "structured_output_native": self.structured_output_native,
            "vision_capable": self.vision_capable,
            "model_family": self.model_family,
            "vision_understanding": self.vision_understanding,
            "agent_native": self.agent_native,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LLMCapabilities:
        return cls(
            provider=data.get("provider", ""),
            model_name=data.get("model_name", ""),
            detected_at=data.get("detected_at", 0.0),
            context_window=data.get("context_window", 4096),
            reasoning_depth=data.get("reasoning_depth", 3),
            tool_calling_accuracy=data.get("tool_calling_accuracy", 0.5),
            code_generation=data.get("code_generation", 3),
            multi_modal=data.get("multi_modal", False),
            structured_output=data.get("structured_output", 0.5),
            overall_score=data.get("overall_score", 3.0),
            runtime_samples=data.get("runtime_samples", 0),
            probe_version=data.get("probe_version", 0),
            extended_thinking=data.get("extended_thinking", False),
            structured_output_native=data.get("structured_output_native", False),
            vision_capable=data.get("vision_capable", False),
            model_family=data.get("model_family", "generic"),
            vision_understanding=data.get("vision_understanding", 0.0),
            agent_native=data.get("agent_native", False),
        )


@dataclass
class CapabilityDiff:
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    changed: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""


# ── 探针定义（问题）─────────────────────────────────────────────
# 每个探针包含 messages 和 evaluation_prompt。
# 执行流程：发送 probe messages → 获取响应 → 用 evaluation_prompt 让 LLM 自评 1-10 分。
# 相比关键词匹配，LLM-as-Judge 语义评估能准确识别不同措辞风格的高质量回答。

_REASONING_PROBE_MESSAGES = [
    {"role": "system", "content": "你是一个逻辑推理专家。请分析以下问题的所有可能情况，给出严谨的推理过程。"},
    {"role": "user", "content": "如果 A > B, B > C, C > D, 且 E = B, F < C, 那么 A 和 F 的关系是什么？请列出所有可能的推理路径。"},
]

_REASONING_EVAL_PROMPT = (
    "请对以下推理回答的质量评分（1-10分），只返回 JSON：\n"
    "评分标准：\n"
    "- 1-3分：推理有严重逻辑错误或遗漏关键情况\n"
    "- 4-6分：推理基本正确但不够严谨或遗漏部分情况\n"
    "- 7-8分：推理严谨，覆盖了主要情况\n"
    "- 9-10分：推理全面深入，覆盖所有边界情况，逻辑无懈可击\n\n"
    "回答内容：\n{response}\n\n"
    '返回格式：{{"score": 整数, "reason": "简短理由"}}'
)

_TOOL_CALLING_PROBE_MESSAGES = [
    {"role": "system", "content": "你是一个助手。当需要执行操作时，你必须输出一个 JSON 格式的工具调用。"},
    {"role": "user", "content": "搜索北京今天的天气，然后计算 3.14 * 2.71 的结果。"},
]

_TOOL_CALLING_EVAL_PROMPT = (
    "请对以下工具调用/函数调用回答的质量评分（1-10分），只返回 JSON：\n"
    "评分标准：\n"
    "- 1-3分：未生成工具调用或格式完全错误\n"
    "- 4-6分：有工具调用意图但格式不规范或参数不完整\n"
    "- 7-8分：工具调用格式正确，参数合理\n"
    "- 9-10分：工具调用格式完美，参数精确，考虑了多步骤调用顺序\n\n"
    "回答内容：\n{response}\n\n"
    '返回格式：{{"score": 整数, "reason": "简短理由"}}'
)

_CODE_GENERATION_PROBE_MESSAGES = [
    {"role": "system", "content": "你是一个编程专家。请给出完整的可运行代码，不要省略。"},
    {"role": "user", "content": "用 Python 写一个函数，输入一个整数列表，返回其中所有质数的平方和。要求包含类型注解和文档字符串。"},
]

_CODE_GEN_EVAL_PROMPT = (
    "请对以下代码生成回答的质量评分（1-10分），只返回 JSON：\n"
    "评分标准：\n"
    "- 1-3分：代码无法运行或逻辑完全错误\n"
    "- 4-6分：代码基本正确但缺少类型注解/文档字符串/边界处理\n"
    "- 7-8分：代码正确，包含类型注解和文档字符串，考虑了边界情况\n"
    "- 9-10分：代码优雅高效，完整类型注解，详细文档字符串，含边界处理和示例\n\n"
    "回答内容：\n{response}\n\n"
    '返回格式：{{"score": 整数, "reason": "简短理由"}}'
)

_STRUCTURED_OUTPUT_PROBE_MESSAGES = [
    {"role": "system", "content": "你必须严格以 JSON 格式输出，不要有任何额外文字。"},
    {"role": "user", "content": "分析以下文本的情感、主题和关键词：\"今天天气真好，适合出去散步。\" 输出 JSON。"},
]

_STRUCTURED_OUTPUT_EVAL_PROMPT = (
    "请对以下结构化输出回答的质量评分（1-10分），只返回 JSON：\n"
    "评分标准：\n"
    "- 1-3分：未输出 JSON 或 JSON 格式错误\n"
    "- 4-6分：JSON 格式正确但内容不完整或分析不准确\n"
    "- 7-8分：JSON 格式正确，内容完整，分析合理\n"
    "- 9-10分：JSON 格式完美，内容丰富准确，包含所有要求字段且分析深入\n\n"
    "回答内容：\n{response}\n\n"
    '返回格式：{{"score": 整数, "reason": "简短理由"}}'
)

_VISION_PROBE_MESSAGES = [
    {"role": "system", "content": "你是一个视觉理解专家。请分析描述图像的内容、物体、场景和细节。"},
    {"role": "user", "content": "请描述你看到的图像中有哪些物体，它们之间的关系是什么，以及整体场景氛围。"},
]

_VISION_EVAL_PROMPT = (
    "请对以下视觉理解回答的质量评分（1-10分），只返回 JSON：\n"
    "评分标准：\n"
    "- 1-3分：完全无法理解图像内容或拒绝回答\n"
    "- 4-6分：有基本描述但缺少细节或存在错误\n"
    "- 7-8分：描述准确，物体识别正确，场景理解合理\n"
    "- 9-10分：描述全面细致，识别所有关键物体，理解场景关系和氛围\n\n"
    "回答内容：\n{response}\n\n"
    '返回格式：{{"score": 整数, "reason": "简短理由"}}'
)

_MODEL_FAMILY_CAPABILITIES: dict[str, dict[str, Any]] = {
    "claude": {
        "extended_thinking": True,
        "structured_output_native": False,
        "vision_capable": True,
        "context_window": 200000,
    },
    "gpt": {
        "extended_thinking": False,
        "structured_output_native": True,
        "vision_capable": True,
        "context_window": 128000,
    },
    "gemini": {
        "extended_thinking": False,
        "structured_output_native": False,
        "vision_capable": True,
        "context_window": 1000000,
    },
    "deepseek": {
        "extended_thinking": True,
        "structured_output_native": True,
        "vision_capable": False,
        "context_window": 1000000,
        "agent_native": True,
    },
    "qwen": {
        "extended_thinking": False,
        "structured_output_native": False,
        "vision_capable": True,
        "context_window": 128000,
    },
    "glm": {
        "extended_thinking": False,
        "structured_output_native": False,
        "vision_capable": True,
        "context_window": 128000,
    },
}


class LLMCapabilityDetector:
    def __init__(self, data_dir: str | None = None) -> None:
        self._cached_capabilities: dict[str, LLMCapabilities] = {}
        self._llm: LLMProtocol | None = None
        self._callbacks: dict[str, Any] = {}
        self._data_dir = Path(data_dir) if data_dir else Path(__file__).resolve().parent.parent.parent / "data" / "llm_caps"
        self._state_path = self._data_dir / "capabilities.json"
        self._load_cached()

    def set_llm(self, llm: LLMProtocol) -> None:
        self._llm = llm

    def set_callbacks(self, callbacks: dict[str, Any]) -> None:
        self._callbacks = callbacks

    def _load_cached(self) -> None:
        if not self._state_path.exists():
            return
        try:
            raw = self._state_path.read_text(encoding="utf-8")
            data = json.loads(raw)
            stored = data.get(_STORAGE_KEY, {})
            for provider, caps_data in stored.items():
                caps = LLMCapabilities.from_dict(caps_data)
                if time.time() - caps.detected_at < _CACHE_TTL_SECONDS:
                    self._cached_capabilities[provider] = caps
            if self._cached_capabilities:
                log.info("Loaded cached LLM capabilities", count=len(self._cached_capabilities))
        except Exception as e:
            log.warning("Failed to load LLM capabilities cache", error=str(e))

    def _persist(self) -> None:
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            serializable: dict[str, Any] = {}
            for provider, caps in self._cached_capabilities.items():
                serializable[provider] = caps.to_dict()
            self._state_path.write_text(
                json.dumps({_STORAGE_KEY: serializable}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            log.warning("Failed to persist LLM capabilities", error=str(e))

    def get_cached(self, provider: str) -> LLMCapabilities | None:
        caps = self._cached_capabilities.get(provider)
        if caps and time.time() - caps.detected_at < _CACHE_TTL_SECONDS:
            return caps
        return None

    async def detect(self, provider: str, force: bool = False) -> LLMCapabilities | None:
        if not force:
            cached = self.get_cached(provider)
            if cached:
                return cached

        if not self._llm:
            log.warning("No LLM set for capability detection")
            return None

        log.info("Detecting LLM capabilities", provider=provider)
        start = time.time()

        try:
            reasoning = await self._probe_reasoning()
            tool_calling = await self._probe_tool_calling()
            code_gen = await self._probe_code_generation()
            structured = await self._probe_structured_output()
            vision = await self._probe_vision()

            model_family = self._detect_model_family(provider)
            family_caps = _MODEL_FAMILY_CAPABILITIES.get(model_family, {})
            multi_modal = vision > 0 or family_caps.get("vision_capable", False)
            context_window = family_caps.get("context_window", 4096)

            caps = LLMCapabilities(
                provider=provider,
                model_name=provider,
                detected_at=time.time(),
                context_window=context_window,
                reasoning_depth=reasoning,
                tool_calling_accuracy=tool_calling,
                code_generation=code_gen,
                multi_modal=multi_modal,
                structured_output=structured,
                overall_score=self._compute_overall_score(reasoning, tool_calling, code_gen, structured),
                extended_thinking=family_caps.get("extended_thinking", False),
                structured_output_native=family_caps.get("structured_output_native", False),
                vision_capable=family_caps.get("vision_capable", False),
                model_family=model_family,
                vision_understanding=vision,
                agent_native=family_caps.get("agent_native", False),
            )

            self._cached_capabilities[provider] = caps
            if len(self._cached_capabilities) > _MAX_CACHE_ENTRIES:
                oldest = min(self._cached_capabilities, key=lambda k: self._cached_capabilities[k].detected_at)
                del self._cached_capabilities[oldest]

            self._persist()

            cb = self._callbacks.get("on_capabilities_detected")
            if cb:
                try:
                    cb(caps)
                except Exception as _exc:
                    log_ignored(log, "llm_capability_detector.LLMCapabilityDetector.detect", _exc)

            duration = time.time() - start
            log.info(
                "LLM capabilities detected",
                provider=provider,
                score=caps.overall_score,
                duration_ms=int(duration * 1000),
            )
            return caps

        except Exception as e:
            log.error("Failed to detect LLM capabilities", error=str(e))
            return None

    # ------------------------------------------------------------------ 能力漂移监控（W4）
    async def check_drift(self, provider: str) -> "CapabilityDiff | None":
        """强制重新检测并与缓存对比，返回能力漂移（无基线时返回 None）。"""
        old = self.get_cached(provider)
        new = await self.detect(provider, force=True)
        if old is None or new is None:
            return None
        diff = self.diff(old, new)
        if diff.added or diff.removed or diff.changed:
            cb = self._callbacks.get("on_capability_drift")
            if cb:
                try:
                    cb(provider, diff)
                except Exception as _exc:
                    log_ignored(log, "llm_capability_detector.LLMCapabilityDetector.check_drift", _exc)
            log.info(
                "LLM capability drift detected",
                provider=provider,
                changed=diff.changed,
                summary=diff.summary,
            )
        return diff

    def start_drift_monitor(
        self,
        providers: list[str],
        interval_seconds: float = 3600.0,
        on_drift: Any | None = None,
    ) -> asyncio.Task:
        """启动后台周期重检，发现能力漂移时触发回调（on_drift 或 'on_capability_drift' 回调）。

        Returns:
            asyncio.Task: 可通过 ``stop_drift_monitor`` 取消。
        """
        if on_drift is not None:
            self._callbacks["on_capability_drift"] = on_drift
        task = asyncio.ensure_future(self._drift_loop(providers, interval_seconds))

        async def _cancel() -> None:
            task.cancel()

        self._drift_task = task  # type: ignore[attr-defined]
        return task

    async def _drift_loop(self, providers: list[str], interval_seconds: float) -> None:
        try:
            while True:
                for p in providers:
                    try:
                        await self.check_drift(p)
                    except Exception as _exc:
                        log_ignored(log, "llm_capability_detector.drift_loop", _exc)
                await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError as _exc:
            log_ignored(log, "llm_capability_detector.LLMCapabilityDetector._drift_loop", _exc)

    def stop_drift_monitor(self) -> None:
        """取消能力漂移监控任务。"""
        task = getattr(self, "_drift_task", None)
        if task is not None:
            task.cancel()

    async def _llm_judge_score(self, eval_prompt: str, response_text: str) -> float:
        """使用 LLM-as-Judge 对探针响应做语义评分。

        发送评估 prompt 让 LLM 对自身回答质量打分（1-10），
        解析返回的 JSON 获取 score。解析失败时回退到关键词匹配。

        Args:
            eval_prompt: 评估 prompt 模板，含 {response} 占位符。
            response_text: 探针响应文本。

        Returns:
            float: 1.0-10.0 的评分。
        """
        try:
            assert self._llm is not None
            prompt_text = eval_prompt.format(response=response_text)
            eval_resp = await self._llm.chat([
                {"role": "user", "content": prompt_text},
            ])
            eval_text = str(eval_resp.get("content", eval_resp.get("text", "")))
            parsed = json.loads(eval_text)
            score = float(parsed.get("score", 5))
            return max(1.0, min(10.0, score))
        except (json.JSONDecodeError, ValueError, TypeError) as _exc:
            log_ignored(log, "llm_capability_detector.LLMCapabilityDetector._llm_judge_score", _exc)
        try:
            import re
            match = re.search(r'"?score"?\s*[:=]\s*(\d+)', eval_text)
            if match:
                return max(1.0, min(10.0, float(match.group(1))))
        except Exception as _exc:
            log_ignored(log, "llm_capability_detector.LLMCapabilityDetector._llm_judge_score", _exc)
        return 5.0

    async def _probe_reasoning(self) -> int:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_REASONING_PROBE_MESSAGES)
            text = str(resp.get("content", resp.get("text", "")))
            score = await self._llm_judge_score(_REASONING_EVAL_PROMPT, text)
            return max(1, min(9, round(score)))
        except Exception:
            return 3

    async def _probe_tool_calling(self) -> float:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_TOOL_CALLING_PROBE_MESSAGES)
            text = str(resp.get("content", resp.get("text", "")))
            score = await self._llm_judge_score(_TOOL_CALLING_EVAL_PROMPT, text)
            return round(max(0.1, min(0.95, score / 10.0)), 2)
        except Exception:
            return 0.4

    async def _probe_code_generation(self) -> int:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_CODE_GENERATION_PROBE_MESSAGES)
            text = str(resp.get("content", resp.get("text", "")))
            score = await self._llm_judge_score(_CODE_GEN_EVAL_PROMPT, text)
            return max(1, min(9, round(score)))
        except Exception:
            return 3

    async def _probe_structured_output(self) -> float:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_STRUCTURED_OUTPUT_PROBE_MESSAGES)
            text = str(resp.get("content", resp.get("text", "")))
            score = await self._llm_judge_score(_STRUCTURED_OUTPUT_EVAL_PROMPT, text)
            return round(max(0.1, min(0.95, score / 10.0)), 2)
        except Exception:
            return 0.4

    async def _probe_vision(self) -> float:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_VISION_PROBE_MESSAGES)
            text = str(resp.get("content", resp.get("text", "")))
            if "看不到" in text or "无法" in text or "没有图像" in text or "no image" in text.lower():
                return 0.0
            score = await self._llm_judge_score(_VISION_EVAL_PROMPT, text)
            return round(max(0.0, min(0.95, score / 10.0)), 2)
        except Exception:
            return 0.0

    @staticmethod
    def _detect_model_family(model_name: str) -> str:
        lower = model_name.lower()
        if "claude" in lower:
            return "claude"
        if "gpt" in lower or "o1" in lower or "o3" in lower or "o4" in lower:
            return "gpt"
        if "gemini" in lower:
            return "gemini"
        if "deepseek" in lower or "deepseek-v4" in lower:
            return "deepseek"
        if "qwen" in lower:
            return "qwen"
        if "glm" in lower or "chatglm" in lower:
            return "glm"
        return "generic"

    @staticmethod
    def _compute_overall_score(
        reasoning: int,
        tool_calling: float,
        code_gen: int,
        structured: float,
    ) -> float:
        """加权综合评分 — 量纲统一后加权求和。

        所有维度归一化到 0.0-1.0 后按权重计算：
        - 推理深度 (30%): 1-9 → /9
        - 工具调用准确率 (25%): 0.0-1.0
        - 代码生成 (25%): 1-9 → /9
        - 结构化输出 (20%): 0.0-1.0

        Returns:
            float: 0.0-1.0 的综合评分。
        """
        r_norm = reasoning / 9.0
        c_norm = code_gen / 9.0
        return round(
            r_norm * 0.30 + tool_calling * 0.25 + c_norm * 0.25 + structured * 0.20,
            3,
        )

    def diff(self, old_caps: LLMCapabilities, new_caps: LLMCapabilities) -> CapabilityDiff:
        diff = CapabilityDiff()
        changes: list[str] = []

        if new_caps.reasoning_depth > old_caps.reasoning_depth:
            diff.changed.append({"field": "reasoning_depth", "from": old_caps.reasoning_depth, "to": new_caps.reasoning_depth})
            changes.append("推理能力提升")
        elif new_caps.reasoning_depth < old_caps.reasoning_depth:
            diff.changed.append({"field": "reasoning_depth", "from": old_caps.reasoning_depth, "to": new_caps.reasoning_depth})
            changes.append("推理能力下降")

        if new_caps.tool_calling_accuracy > old_caps.tool_calling_accuracy + 0.1:
            diff.changed.append({"field": "tool_calling_accuracy", "from": old_caps.tool_calling_accuracy, "to": new_caps.tool_calling_accuracy})
            changes.append("工具调用准确率提升")

        if new_caps.code_generation > old_caps.code_generation:
            diff.changed.append({"field": "code_generation", "from": old_caps.code_generation, "to": new_caps.code_generation})
            changes.append("代码生成能力提升")

        if new_caps.structured_output > old_caps.structured_output + 0.1:
            diff.changed.append({"field": "structured_output", "from": old_caps.structured_output, "to": new_caps.structured_output})
            changes.append("结构化输出能力提升")

        diff.summary = "；".join(changes) if changes else "无显著变化"
        return diff

    def get_all_cached(self) -> list[LLMCapabilities]:
        now = time.time()
        valid = [
            c for c in self._cached_capabilities.values()
            if now - c.detected_at < _CACHE_TTL_SECONDS
        ]
        return sorted(valid, key=lambda c: c.overall_score, reverse=True)

    def upgrade_capabilities_from_runtime(
        self,
        provider: str,
        runtime_signals: RuntimeSignals,
        weight_runtime: float = 0.3,
    ) -> LLMCapabilities | None:
        """结合实时运行数据动态更新能力画像。

        将静态探针结果与运行时实际表现做加权融合：
        - 静态探针权重：(1 - weight_runtime)
        - 运行时数据权重：weight_runtime
        - 运行时样本越多，权重自动提升（上限 0.5）

        Args:
            provider: LLM 提供者标识。
            runtime_signals: 运行时收集的信号数据。
            weight_runtime: 运行时数据的基础权重（0.0-1.0）。

        Returns:
            LLMCapabilities | None: 更新后的能力画像，None 表示无缓存数据。
        """
        cached = self.get_cached(provider)
        if cached is None:
            log.warning("No cached capabilities for provider, cannot upgrade", provider=provider)
            return None

        total_samples = runtime_signals.total_interactions
        if total_samples < 5:
            log.debug("Too few runtime samples for upgrade", provider=provider, samples=total_samples)
            return cached

        effective_weight = min(weight_runtime + total_samples * 0.002, 0.5)
        probe_weight = 1.0 - effective_weight

        upgraded = LLMCapabilities(
            provider=cached.provider,
            model_name=cached.model_name,
            detected_at=time.time(),
            context_window=cached.context_window,
            reasoning_depth=self._merge_reasoning(
                cached.reasoning_depth,
                runtime_signals,
                effective_weight,
            ),
            tool_calling_accuracy=self._merge_tool_calling(
                cached.tool_calling_accuracy,
                runtime_signals,
                effective_weight,
            ),
            code_generation=self._merge_code_generation(
                cached.code_generation,
                runtime_signals,
                effective_weight,
            ),
            multi_modal=cached.multi_modal,
            structured_output=self._merge_structured_output(
                cached.structured_output,
                runtime_signals,
                effective_weight,
            ),
            overall_score=0.0,
            runtime_samples=total_samples,
            probe_version=cached.probe_version + 1,
            extended_thinking=cached.extended_thinking,
            structured_output_native=cached.structured_output_native,
            vision_capable=cached.vision_capable,
            model_family=cached.model_family,
            vision_understanding=cached.vision_understanding,
        )

        upgraded.overall_score = self._compute_overall_score(
            upgraded.reasoning_depth,
            upgraded.tool_calling_accuracy,
            upgraded.code_generation,
            upgraded.structured_output,
        )

        self._cached_capabilities[provider] = upgraded
        self._persist()

        log.info(
            "LLM capabilities upgraded from runtime",
            provider=provider,
            samples=total_samples,
            runtime_weight=round(effective_weight, 3),
            old_score=round(cached.overall_score, 2),
            new_score=round(upgraded.overall_score, 2),
        )
        return upgraded

    @staticmethod
    def _merge_reasoning(
        probe_score: int,
        signals: RuntimeSignals,
        weight: float,
    ) -> int:
        runtime_score = min(9, int(3 + signals.planning_quality * 6))
        merged = round(probe_score * (1 - weight) + runtime_score * weight)
        return max(1, min(9, merged))

    @staticmethod
    def _merge_tool_calling(
        probe_score: float,
        signals: RuntimeSignals,
        weight: float,
    ) -> float:
        runtime_score = min(0.95, 0.3 + signals.tool_success_rate * 0.65)
        merged = probe_score * (1 - weight) + runtime_score * weight
        return round(max(0.1, min(0.95, merged)), 2)

    @staticmethod
    def _merge_code_generation(
        probe_score: int,
        signals: RuntimeSignals,
        weight: float,
    ) -> int:
        runtime_score = min(9, int(3 + signals.code_execution_success_rate * 6))
        merged = round(probe_score * (1 - weight) + runtime_score * weight)
        return max(1, min(9, merged))

    @staticmethod
    def _merge_structured_output(
        probe_score: float,
        signals: RuntimeSignals,
        weight: float,
    ) -> float:
        runtime_score = min(0.95, 0.3 + signals.json_parse_success_rate * 0.65)
        merged = probe_score * (1 - weight) + runtime_score * weight
        return round(max(0.1, min(0.95, merged)), 2)


@dataclass
class RuntimeSignals:
    """运行时信号 — 从实际交互中收集的 LLM 表现数据。

    由 EvolutionOrchestrator 在 record_interaction 中持续累积，
    定期传递给 LLMCapabilityDetector 用于动态更新能力画像。
    """

    total_interactions: int = 0
    planning_quality: float = 0.5
    tool_success_rate: float = 0.5
    code_execution_success_rate: float = 0.5
    json_parse_success_rate: float = 0.5
    avg_response_time_ms: float = 0.0
    reflection_effectiveness: float = 0.5
    user_satisfaction: float = 0.5

    def merge(self, other: RuntimeSignals, weight: float = 0.5) -> RuntimeSignals:
        total = self.total_interactions + other.total_interactions
        if total == 0:
            return self
        w1 = self.total_interactions / total
        w2 = other.total_interactions / total
        return RuntimeSignals(
            total_interactions=total,
            planning_quality=round(self.planning_quality * w1 + other.planning_quality * w2, 3),
            tool_success_rate=round(self.tool_success_rate * w1 + other.tool_success_rate * w2, 3),
            code_execution_success_rate=round(self.code_execution_success_rate * w1 + other.code_execution_success_rate * w2, 3),
            json_parse_success_rate=round(self.json_parse_success_rate * w1 + other.json_parse_success_rate * w2, 3),
            avg_response_time_ms=round(self.avg_response_time_ms * w1 + other.avg_response_time_ms * w2, 1),
            reflection_effectiveness=round(self.reflection_effectiveness * w1 + other.reflection_effectiveness * w2, 3),
            user_satisfaction=round(self.user_satisfaction * w1 + other.user_satisfaction * w2, 3),
        )
