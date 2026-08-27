"""P0-1: 反事实推理引擎测试。"""

from __future__ import annotations

import pytest

from agent.reasoning.counterfactual import (
    CounterfactualEngine,
    CounterfactualReport,
    DecisionNode,
    DecisionImportance,
    RegretAnalysis,
)


def test_analyze_empty_path():
    engine = CounterfactualEngine()
    import asyncio
    report = asyncio.get_event_loop().run_until_complete(
        engine.analyze("test problem", best_path=[])
    )
    assert report.total_decisions == 0
    assert report.analyzed_decisions == 0


def test_analyze_with_decisions():
    path = [
        DecisionNode(node_id="n1", thought="选择方案A", score=0.8, depth=0, importance=DecisionImportance.HIGH),
        DecisionNode(node_id="n2", thought="执行步骤1", score=0.7, depth=1, importance=DecisionImportance.MEDIUM),
        DecisionNode(node_id="n3", thought="选择方案B", score=0.6, depth=2, importance=DecisionImportance.CRITICAL),
    ]
    engine = CounterfactualEngine()
    import asyncio
    report = asyncio.get_event_loop().run_until_complete(
        engine.analyze("如何优化性能", best_path=path)
    )
    assert report.total_decisions == 3
    assert report.analyzed_decisions >= 1
    assert report.report_id.startswith("cf_")


def test_select_key_decisions():
    path = [
        DecisionNode(node_id="n1", thought="low", score=0.3, depth=0, importance=DecisionImportance.LOW),
        DecisionNode(node_id="n2", thought="high", score=0.9, depth=1, importance=DecisionImportance.HIGH),
        DecisionNode(node_id="n3", thought="critical", score=0.7, depth=2, importance=DecisionImportance.CRITICAL),
    ]
    engine = CounterfactualEngine()
    key = engine._select_key_decisions(path)
    assert any(n.importance == DecisionImportance.CRITICAL for n in key)
    assert any(n.importance == DecisionImportance.HIGH for n in key)
