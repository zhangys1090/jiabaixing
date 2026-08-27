"""五感融合（Sensory Fusion）—— 家百星"手脚五感"的核心独有能力。

``perception/`` 已经具备分散的感知通道：
- 视觉： ``VisualGrounding`` / ``ScreenWatcher``
- 文本/OCR： ``LocalOCR``
- 界面结构： ``UIAElementCache`` / ``platform_adapter``
- 听觉：由外部 ASR 注入（本项目以文本通道承载）

本模块的价值在于**把它们融合成一份统一的、带置信度与溯源的感知上下文**，
直接喂给 ``PerceptionActionLoop`` 的执行决策，从而闭合"感知 → 决策 → 行动 → 验证"回路。

设计要点：
- 与具体感知实现解耦：只消费 ``SenseSample(modality, content, confidence)``，
  避免与 OCRResult/GroundingResult 等结构形成强耦合或导入环。
- 支持加权融合（各通道可信度不同）与多策略： ``weighted`` / ``concat``。
- 产出 ``FusedPerception``，可被 ``to_prompt_context()`` 直接序列化为提示词上下文。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

# 五感通道的默认权重（可在实例化时覆盖）
# 新增 proprioception（本体感/动作结果自我感知）与 environment（环境感/真实设备状态回流），
# 二者是"手脚五感"闭环的关键新增通道，详见 docs/jiabaixing-unique-capability-enhancement.md §2.2。
DEFAULT_SENSE_WEIGHTS: dict[str, float] = {
    "visual": 1.0,
    "audio": 0.9,
    "text": 1.0,
    "uia": 1.0,
    "ocr": 0.95,
    "proprioception": 0.9,
    "environment": 0.85,
    "haptic": 0.85,
    "olfactory": 0.75,
    "gustatory": 0.70,
}

VALID_MODALITIES = (
    "visual",
    "audio",
    "text",
    "uia",
    "ocr",
    "proprioception",
    "environment",
    "haptic",
    "olfactory",
    "gustatory",
)


@dataclass
class SenseSample:
    modality: str
    content: Any
    confidence: float = 1.0
    timestamp: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.modality not in VALID_MODALITIES:
            raise ValueError(f"未知感知通道: {self.modality}，可选: {VALID_MODALITIES}")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence 必须在 [0,1] 区间")


@dataclass
class FusedPerception:
    text: str
    modalities: list[str]
    confidence: float
    sources: list[SenseSample] = field(default_factory=list)
    structured: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.modalities = sorted(set(self.modalities))


class SensoryFusion:
    def __init__(self, weights: dict[str, float] | None = None) -> None:
        self._weights = dict(DEFAULT_SENSE_WEIGHTS)
        self._MAX_WEIGHTS = 200
        if weights:
            self._weights.update(weights)
        self._samples: list[SenseSample] = []
        self._MAX_SAMPLES = 5000

    def add(self, sample: SenseSample) -> None:
        self._samples.append(sample)
        if len(self._samples) > self._MAX_SAMPLES:
            self._samples = self._samples[-self._MAX_SAMPLES * 3 // 4:]

    def add_many(self, samples: list[SenseSample]) -> None:
        self._samples.extend(samples)
        if len(self._samples) > self._MAX_SAMPLES:
            self._samples = self._samples[-self._MAX_SAMPLES * 3 // 4:]

    def clear(self) -> None:
        self._samples.clear()

    @property
    def samples(self) -> list[SenseSample]:
        return list(self._samples)

    def fuse(self, strategy: str = "weighted") -> FusedPerception:
        if not self._samples:
            return FusedPerception(text="", modalities=[], confidence=0.0)

        if strategy == "concat":
            return self._fuse_concat()
        if strategy == "weighted":
            return self._fuse_weighted()
        raise ValueError(f"未知融合策略: {strategy}")

    # ----------------------------------------------------------------- 实现
    def _fuse_concat(self) -> FusedPerception:
        parts: list[str] = []
        for s in self._samples:
            label = f"[{s.modality}]"
            parts.append(f"{label} {s.content}")
        text = "\n".join(parts)
        avg_conf = sum(s.confidence for s in self._samples) / len(self._samples)
        return FusedPerception(
            text=text,
            modalities=[s.modality for s in self._samples],
            confidence=round(avg_conf, 4),
            sources=list(self._samples),
            structured=self._build_structured(),
        )

    def _fuse_weighted(self) -> FusedPerception:
        parts: list[str] = []
        weighted_conf_sum = 0.0
        weight_sum = 0.0
        for s in self._samples:
            w = self._weights.get(s.modality, 1.0)
            weighted_conf_sum += s.confidence * w
            weight_sum += w
            # 置信度高的通道排在前面，提升提示词可读性
            parts.append((w * s.confidence, f"[{s.modality}|{s.confidence:.2f}] {s.content}"))
        parts.sort(key=lambda x: x[0], reverse=True)
        text = "\n".join(p for _, p in parts)
        fused_conf = weighted_conf_sum / weight_sum if weight_sum else 0.0
        return FusedPerception(
            text=text,
            modalities=[s.modality for s in self._samples],
            confidence=round(fused_conf, 4),
            sources=list(self._samples),
            structured=self._build_structured(),
        )

    def _build_structured(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for s in self._samples:
            out.setdefault(s.modality, []).append(
                {"content": s.content, "confidence": s.confidence, "metadata": s.metadata}
            )
        return out

    def to_prompt_context(self, strategy: str = "weighted") -> str:
        """产出可直接拼入系统/用户提示词的统一感知上下文。"""
        fused = self.fuse(strategy=strategy)
        if not fused.text:
            return ""
        header = (
            f"【多模态感知融合 | 通道={','.join(fused.modalities)} "
            f"| 综合置信度={fused.confidence:.2f}】"
        )
        return f"{header}\n{fused.text}"
