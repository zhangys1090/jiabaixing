from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from agent.core.logger import StructuredLogger

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
        )


@dataclass
class CapabilityDiff:
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    changed: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""


_REASONING_PROBE = {
    "messages": [
        {"role": "system", "content": "你是一个逻辑推理专家。请分析以下问题的所有可能情况，给出严谨的推理过程。"},
        {"role": "user", "content": "如果 A > B, B > C, C > D, 且 E = B, F < C, 那么 A 和 F 的关系是什么？请列出所有可能的推理路径。"},
    ],
    "expected_keywords": ["大于", "可能", "不一定", "无法确定"],
    "min_keywords": 2,
}

_TOOL_CALLING_PROBE = {
    "messages": [
        {"role": "system", "content": "你是一个助手。当需要执行操作时，你必须输出一个 JSON 格式的工具调用。"},
        {"role": "user", "content": "搜索北京今天的天气，然后计算 3.14 * 2.71 的结果。"},
    ],
    "expected_json_keys": ["tool", "name", "action", "function"],
    "min_keywords": 1,
}

_CODE_GENERATION_PROBE = {
    "messages": [
        {"role": "system", "content": "你是一个编程专家。请给出完整的可运行代码，不要省略。"},
        {"role": "user", "content": "用 Python 写一个函数，输入一个整数列表，返回其中所有质数的平方和。要求包含类型注解和文档字符串。"},
    ],
    "expected_keywords": ["def", "return", "is_prime", "sqrt", "for"],
    "min_keywords": 3,
}

_STRUCTURED_OUTPUT_PROBE = {
    "messages": [
        {"role": "system", "content": "你必须严格以 JSON 格式输出，不要有任何额外文字。"},
        {"role": "user", "content": "分析以下文本的情感、主题和关键词：\"今天天气真好，适合出去散步。\" 输出 JSON。"},
    ],
    "expected_json_keys": ["sentiment", "topic", "keywords"],
    "min_keywords": 2,
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

            caps = LLMCapabilities(
                provider=provider,
                model_name=provider,
                detected_at=time.time(),
                context_window=4096,
                reasoning_depth=reasoning,
                tool_calling_accuracy=tool_calling,
                code_generation=code_gen,
                multi_modal=False,
                structured_output=structured,
                overall_score=(reasoning + tool_calling * 10 + code_gen + structured * 10) / 4,
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
                except Exception:
                    pass

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

    async def _probe_reasoning(self) -> int:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_REASONING_PROBE["messages"])
            text = str(resp.get("content", resp.get("text", "")))
            matched = sum(1 for kw in _REASONING_PROBE["expected_keywords"] if kw in text)
            if matched >= _REASONING_PROBE["min_keywords"]:
                return min(5 + matched, 9)
            return 3
        except Exception:
            return 3

    async def _probe_tool_calling(self) -> float:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_TOOL_CALLING_PROBE["messages"])
            text = str(resp.get("content", resp.get("text", "")))
            matched = sum(1 for kw in _TOOL_CALLING_PROBE["expected_json_keys"] if kw.lower() in text.lower())
            if matched >= _TOOL_CALLING_PROBE["min_keywords"]:
                return min(0.5 + matched * 0.15, 0.95)
            return 0.4
        except Exception:
            return 0.4

    async def _probe_code_generation(self) -> int:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_CODE_GENERATION_PROBE["messages"])
            text = str(resp.get("content", resp.get("text", "")))
            matched = sum(1 for kw in _CODE_GENERATION_PROBE["expected_keywords"] if kw in text)
            if matched >= _CODE_GENERATION_PROBE["min_keywords"]:
                return min(3 + matched, 9)
            return 3
        except Exception:
            return 3

    async def _probe_structured_output(self) -> float:
        try:
            assert self._llm is not None
            resp = await self._llm.chat(_STRUCTURED_OUTPUT_PROBE["messages"])
            text = str(resp.get("content", resp.get("text", "")))
            matched = sum(1 for kw in _STRUCTURED_OUTPUT_PROBE["expected_json_keys"] if kw.lower() in text.lower())
            if matched >= _STRUCTURED_OUTPUT_PROBE["min_keywords"]:
                return min(0.5 + matched * 0.15, 0.95)
            return 0.4
        except Exception:
            return 0.4

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
