"""U4 多模态 @引用 解析测试。"""
from __future__ import annotations

import pytest

from agent.perception.reference_resolver import (
    MULTIMODAL_REFERENCE_TYPES,
    PerceptionReferenceResolver,
    ResolvedReference,
    parse_reference_tokens,
)
from agent.perception.sensory_fusion import FusedPerception


def _fused() -> FusedPerception:
    return FusedPerception(
        text="[visual] 按钮[提交]位于(120,340)\n[environment] 设备A在线,电量78%",
        modalities=["visual", "environment"],
        confidence=0.9,
        structured={
            "visual": [
                {"content": "按钮[提交]位于(120,340)", "confidence": 0.92},
                {"content": "弹窗标题=确认删除", "confidence": 0.88},
            ],
            "environment": [
                {"content": "设备A在线,电量78%", "confidence": 0.99},
            ],
        },
    )


def test_parse_reference_tokens_extracts_cjk_and_modality():
    text = "参考 @截图区域 与 @visual#1 以及 @设备状态 再决定"
    tokens = parse_reference_tokens(text)
    assert "截图区域" in tokens
    assert "visual#1" in tokens
    assert "设备状态" in tokens
    assert len(tokens) == 3


def test_named_reference_maps_to_modality_and_aggregates():
    res = PerceptionReferenceResolver().resolve("看看 @截图区域 然后点击", fused=_fused())
    assert res.resolved_count == 1
    ref = res.references[0]
    assert ref.token == "@截图区域"
    assert ref.modality == "visual"
    assert ref.kind == "named"
    assert "按钮[提交]" in ref.content
    assert "弹窗标题" in ref.content
    # 原文 @引用 被替换为 [ref#N] 标记
    assert "@截图区域" not in res.text
    assert "[ref#1]" in res.text


def test_direct_modality_reference():
    res = PerceptionReferenceResolver().resolve("@environment", fused=_fused())
    assert res.resolved_count == 1
    assert res.references[0].modality == "environment"
    assert "设备A在线" in res.references[0].content


def test_specific_sample_index_reference():
    res = PerceptionReferenceResolver().resolve("@visual#1", fused=_fused())
    assert res.resolved_count == 1
    ref = res.references[0]
    assert ref.kind == "sample"
    assert ref.source_index == 1
    assert "确认删除" in ref.content
    assert "按钮[提交]" not in ref.content  # 仅命中第 2 个样本


def test_unresolved_token_kept_in_text():
    res = PerceptionReferenceResolver().resolve(
        "关注 @不存在通道 和 @visual", fused=_fused()
    )
    assert res.resolved_count == 1  # 仅 visual 成功
    assert "@不存在通道" in res.unresolved
    assert "@不存在通道" in res.text  # 原样保留


def test_resolve_with_structured_dict_only():
    structured = {"audio": [{"content": "语音:打开灯", "confidence": 0.7}]}
    res = PerceptionReferenceResolver().resolve("@声音", structured=structured)
    assert res.resolved_count == 1
    assert res.references[0].modality == "audio"
    assert "打开灯" in res.references[0].content


def test_resolved_content_block_formats_all_refs():
    res = PerceptionReferenceResolver().resolve(
        "@截图区域 @设备状态", fused=_fused()
    )
    block = res.resolved_content
    assert "[@引用 #1] @截图区域" in block
    assert "[@引用 #2] @设备状态" in block
    assert "通道=visual" in block
    assert "通道=environment" in block


def test_multimodal_reference_types_registry_complete():
    assert MULTIMODAL_REFERENCE_TYPES["截图区域"] == "visual"
    assert MULTIMODAL_REFERENCE_TYPES["设备状态"] == "environment"
    assert MULTIMODAL_REFERENCE_TYPES["动作结果"] == "proprioception"
