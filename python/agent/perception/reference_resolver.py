"""多模态 @引用 解析器 —— U4 宪法/人格/上下文引用增强（文档 3 §五）。

把上下文 / 用户输入中的 ``@截图区域`` / ``@设备状态`` / ``@某感知样本`` 等多模态引用，
解析为 ``FusedPerception.structured`` 中的具体感知片段，使 LLM 能精确引用五感融合内容。

设计要点（遵循 AGENTS.md §0.1：Agent 核心逻辑在 Python）：
- 解析核心落在 Python 端（感知融合数据所在），TS 侧 ``ContextReferenceResolver``
  仅通过注入 provider 委托本模块解析，自身不持有融合数据，避免双端重复实现。
- 支持三类引用：
  1. 具名多模态类型：``@截图区域`` → visual，``@设备状态`` → environment ……
  2. 直接感知通道名：``@visual`` / ``@environment`` / ``@audio`` ……
  3. 指定样本：``@visual#0`` / ``@环境#1``（通道名 + ``#`` + 索引）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from agent.perception.sensory_fusion import FusedPerception, VALID_MODALITIES

# 具名多模态引用 → 感知通道
MULTIMODAL_REFERENCE_TYPES: dict[str, str] = {
    "截图区域": "visual",
    "截图": "visual",
    "视觉": "visual",
    "屏幕": "visual",
    "设备状态": "environment",
    "环境": "environment",
    "设备": "environment",
    "声音": "audio",
    "音频": "audio",
    "界面": "uia",
    "UI": "uia",
    "文字": "text",
    "文本": "text",
    "OCR": "ocr",
    "动作结果": "proprioception",
    "本体": "proprioception",
}

# 提取 @引用 token（不含 @ 符号）。CJK + 拉丁字母数字 + 下划线，可选 #索引。
_REF_TOKEN_RE = re.compile(
    r"@([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]*(?:#\d+)?)"
)


@dataclass
class ResolvedReference:
    """单条已解析的多模态 @引用。"""

    token: str  # 完整 @引用（含 @）
    kind: str  # "named" | "modality" | "sample" | "unresolved"
    modality: str | None  # 命中的感知通道
    content: str  # 实际引用内容
    confidence: float  # 该引用的置信度
    source_index: int  # 命中的样本索引（-1 表示整通道聚合）


@dataclass
class ReferenceResolution:
    """一次解析的完整结果。"""

    text: str  # 将 @引用 替换为 [ref#N] 标记后的纯净文本
    references: list[ResolvedReference]
    resolved_count: int
    unresolved: list[str]  # 无法解析、仍原样保留在文本中的 @引用

    @property
    def resolved_content(self) -> str:
        """可拼入提示词的多模态引用内容块。"""
        if not self.references:
            return ""
        blocks: list[str] = []
        for i, ref in enumerate(self.references):
            header = f"[@引用 #{i + 1}] {ref.token}"
            if ref.modality:
                header += f" (通道={ref.modality}, 置信度={ref.confidence:.2f})"
            blocks.append(f"{header}\n{ref.content}")
        return "\n\n".join(blocks)


def parse_reference_tokens(text: str) -> list[str]:
    """提取文本中所有多模态 @引用 token（不含 @ 符号），保持出现顺序。"""
    return _REF_TOKEN_RE.findall(text)


def _modality_for_token(token: str) -> tuple[str | None, int]:
    """根据 token 推断感知通道与样本索引。

    返回 ``(modality, sample_index)``：``sample_index=-1`` 表示整通道聚合；
    ``modality=None`` 表示该 token 无法识别为感知引用。
    """
    # 1) 具名类型（截图区域 → visual …）
    if token in MULTIMODAL_REFERENCE_TYPES:
        return MULTIMODAL_REFERENCE_TYPES[token], -1
    # 2) 指定样本语法：通道名#索引
    if "#" in token:
        base, _, idx = token.partition("#")
        if base in VALID_MODALITIES and idx.isdigit():
            return base, int(idx)
    # 3) 直接通道名
    if token in VALID_MODALITIES:
        return token, -1
    return None, -1


class PerceptionReferenceResolver:
    """将文本中的多模态 @引用 解析到 ``FusedPerception.structured`` 的具体片段。"""

    def resolve(
        self,
        text: str,
        fused: FusedPerception | None = None,
        structured: dict[str, Any] | None = None,
    ) -> ReferenceResolution:
        if structured is None:
            structured = fused.structured if fused is not None else {}
        tokens = parse_reference_tokens(text)
        references: list[ResolvedReference] = []
        unresolved: list[str] = []
        cleaned = text

        # 去重但保持顺序
        seen: set[str] = set()
        ordered: list[str] = []
        for t in tokens:
            if t not in seen:
                seen.add(t)
                ordered.append(t)

        for token in ordered:
            modality, idx = _modality_for_token(token)
            if modality is None:
                unresolved.append("@" + token)
                continue
            samples = structured.get(modality)
            if not samples:
                unresolved.append("@" + token)
                continue
            ref = self._build_reference("@" + token, modality, samples, idx)
            references.append(ref)
            # 用 [ref#N] 标记替换原文中的 @引用（仅替换首个出现，避免误伤）
            cleaned = cleaned.replace("@" + token, f"[ref#{len(references)}]", 1)

        return ReferenceResolution(
            text=cleaned,
            references=references,
            resolved_count=len(references),
            unresolved=unresolved,
        )

    def _build_reference(
        self,
        token: str,
        modality: str,
        samples: list[dict[str, Any]],
        idx: int,
    ) -> ResolvedReference:
        if idx >= 0:
            sample = samples[min(idx, len(samples) - 1)]
            return ResolvedReference(
                token=token,
                kind="sample",
                modality=modality,
                content=str(sample.get("content", "")),
                confidence=round(float(sample.get("confidence", 0.0)), 4),
                source_index=idx,
            )
        # 整通道聚合：拼接该通道下全部样本
        parts = [
            f"[{modality}#{i}] {s.get('content', '')}"
            for i, s in enumerate(samples)
        ]
        avg_conf = (
            sum(float(s.get("confidence", 0.0)) for s in samples) / len(samples)
            if samples
            else 0.0
        )
        return ResolvedReference(
            token=token,
            kind="named" if token[1:] in MULTIMODAL_REFERENCE_TYPES else "modality",
            modality=modality,
            content="\n".join(parts),
            confidence=round(avg_conf, 4),
            source_index=-1,
        )
