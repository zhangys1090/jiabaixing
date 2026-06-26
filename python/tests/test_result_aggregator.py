from __future__ import annotations

import pytest

from agent.orchestration.result_aggregator import (
    AggregatedResult,
    ConsensusResult,
    ResultAggregator,
    ResultConflict,
    TaskDetail,
    TaskNode,
)


class MockLLM:
    """模拟LLM接口，用于测试LLM摘要生成和冲突仲裁功能。

    按顺序返回预设的响应列表，超出列表后返回空JSON。
    """

    def __init__(self, responses: list[str] | None = None) -> None:
        self._responses = responses or []
        self._call_count = 0

    async def chat(self, prompt: str, system_prompt: str = "") -> str:
        if self._call_count < len(self._responses):
            response = self._responses[self._call_count]
            self._call_count += 1
            return response
        return "{}"


def make_task_node(
    task_id: str,
    goal: str = "",
    status: str = "completed",
    error: str | None = None,
) -> TaskNode:
    """创建测试用的TaskNode实例，简化参数设置。"""
    return TaskNode(id=task_id, goal=goal, status=status, error=error)


# ═══════════════════════════════════════════════════════════════════════════
# aggregate — 基础聚合功能测试
# ═══════════════════════════════════════════════════════════════════════════


def test_aggregate_all_success():
    """所有任务成功完成时，aggregate应返回success=True且无失败任务。"""
    aggregator = ResultAggregator()
    tasks = [
        make_task_node("t1", "任务1"),
        make_task_node("t2", "任务2"),
    ]
    results = {
        "t1": {"data": "result1"},
        "t2": {"data": "result2"},
    }

    aggregated = aggregator.aggregate(results, tasks)

    assert aggregated.success is True
    assert aggregated.total_tasks == 2
    assert aggregated.completed_tasks == 2
    assert aggregated.failed_tasks == 0
    assert len(aggregated.conflicts) == 0
    assert "全部任务执行成功" in aggregated.summary


def test_aggregate_partial_failure():
    """部分任务失败时，aggregate应正确统计成功/失败/待处理任务。"""
    aggregator = ResultAggregator()
    tasks = [
        make_task_node("t1", "任务1", status="completed"),
        make_task_node("t2", "任务2", status="failed", error="执行超时"),
        make_task_node("t3", "任务3", status="pending"),
    ]
    results = {"t1": {"data": "ok"}}

    aggregated = aggregator.aggregate(results, tasks)

    assert aggregated.success is False
    assert aggregated.total_tasks == 3
    assert aggregated.completed_tasks == 1
    assert aggregated.failed_tasks == 2
    assert "部分任务执行失败" in aggregated.summary
    assert "t2" in aggregated.summary
    assert "t3" in aggregated.summary


def test_aggregate_empty_tasks():
    """空任务列表应返回success=True，各项计数为0。"""
    aggregator = ResultAggregator()
    aggregated = aggregator.aggregate({}, [])

    assert aggregated.success is True
    assert aggregated.total_tasks == 0
    assert aggregated.completed_tasks == 0
    assert aggregated.failed_tasks == 0


def test_aggregate_task_without_result():
    """状态为completed但agent_results中没有对应结果时，应标记为失败。"""
    aggregator = ResultAggregator()
    tasks = [make_task_node("t1", "任务1", status="completed")]
    results: dict[str, object] = {}

    aggregated = aggregator.aggregate(results, tasks)

    assert aggregated.success is False
    assert aggregated.failed_tasks == 1
    assert aggregated.details["t1"].error == "任务未完成 (状态: completed)"


# ═══════════════════════════════════════════════════════════════════════════
# aggregate_with_summary — LLM摘要生成测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_aggregate_with_summary_llm():
    """LLM可用时，应生成自然语言摘要并填充到llm_summary字段。"""
    llm = MockLLM(responses=["执行摘要：2个任务全部成功完成。"])
    aggregator = ResultAggregator(llm=llm)

    tasks = [
        make_task_node("t1", "数据分析"),
        make_task_node("t2", "报告生成"),
    ]
    results = {"t1": {"data": "ok"}, "t2": {"data": "ok"}}

    aggregated = await aggregator.aggregate_with_summary(results, tasks)

    assert aggregated.llm_summary == "执行摘要：2个任务全部成功完成。"


@pytest.mark.anyio
async def test_aggregate_with_summary_no_llm():
    """未传入LLM时，llm_summary字段应保持为None。"""
    aggregator = ResultAggregator()
    tasks = [make_task_node("t1", "任务1")]
    results = {"t1": {"data": "ok"}}

    aggregated = await aggregator.aggregate_with_summary(results, tasks)

    assert aggregated.llm_summary is None


@pytest.mark.anyio
async def test_aggregate_with_summary_empty_tasks():
    """空任务列表时不应调用LLM，llm_summary保持None。"""
    llm = MockLLM()
    aggregator = ResultAggregator(llm=llm)

    aggregated = await aggregator.aggregate_with_summary({}, [])

    assert aggregated.llm_summary is None


@pytest.mark.anyio
async def test_aggregate_with_summary_llm_error():
    """LLM调用失败时不应中断聚合，llm_summary保持None。"""
    class ErrorLLM:
        async def chat(self, prompt: str, system_prompt: str = "") -> str:
            raise RuntimeError("LLM unavailable")

    aggregator = ResultAggregator(llm=ErrorLLM())
    tasks = [make_task_node("t1", "任务1")]
    results = {"t1": {"data": "ok"}}

    aggregated = await aggregator.aggregate_with_summary(results, tasks)

    assert aggregated.llm_summary is None


# ═══════════════════════════════════════════════════════════════════════════
# _detect_conflicts — 冲突检测测试
# ═══════════════════════════════════════════════════════════════════════════


def test_detect_file_write_conflict():
    """两个Agent写入同一文件路径时，应检测到file_write冲突。"""
    aggregator = ResultAggregator()
    tasks = [
        make_task_node("t1", "写文件A"),
        make_task_node("t2", "写文件B"),
    ]
    results = {
        "t1": {"filePath": "/tmp/test.txt", "data": "a"},
        "t2": {"filePath": "/tmp/test.txt", "data": "b"},
    }

    conflicts = aggregator._detect_conflicts(results, tasks)

    assert len(conflicts) == 1
    assert conflicts[0].type == "file_write"
    assert conflicts[0].severity == "high"
    assert "t1" in conflicts[0].involved_tasks
    assert "t2" in conflicts[0].involved_tasks


def test_detect_goal_overlap_conflict():
    """两个Agent执行相同目标描述时，应检测到goal_overlap冲突。"""
    aggregator = ResultAggregator()
    tasks = [
        make_task_node("t1", "生成摘要"),
        make_task_node("t2", "生成摘要"),
    ]
    results = {
        "t1": {"data": "summary A"},
        "t2": {"data": "summary B"},
    }

    conflicts = aggregator._detect_conflicts(results, tasks)

    assert len(conflicts) == 1
    assert conflicts[0].type == "goal_overlap"
    assert conflicts[0].severity == "medium"


def test_detect_no_conflict():
    """不同目标且不同文件时，不应检测到任何冲突。"""
    aggregator = ResultAggregator()
    tasks = [
        make_task_node("t1", "数据分析"),
        make_task_node("t2", "报告生成"),
    ]
    results = {
        "t1": {"filePath": "/tmp/a.txt"},
        "t2": {"filePath": "/tmp/b.txt"},
    }

    conflicts = aggregator._detect_conflicts(results, tasks)

    assert len(conflicts) == 0


def test_detect_conflict_skips_non_completed():
    """非completed状态的任务不参与冲突检测。"""
    aggregator = ResultAggregator()
    tasks = [
        make_task_node("t1", "写文件A", status="failed"),
        make_task_node("t2", "写文件B", status="completed"),
    ]
    results = {
        "t1": {"filePath": "/tmp/test.txt"},
        "t2": {"filePath": "/tmp/test.txt"},
    }

    conflicts = aggregator._detect_conflicts(results, tasks)

    assert len(conflicts) == 0


def test_detect_file_write_via_path_alias():
    """支持通过filePath/path/file_path三种字段名识别文件路径冲突。"""
    aggregator = ResultAggregator()
    tasks = [
        make_task_node("t1", "写文件A"),
        make_task_node("t2", "写文件B"),
    ]
    results = {
        "t1": {"path": "/tmp/test.txt"},
        "t2": {"file_path": "/tmp/test.txt"},
    }

    conflicts = aggregator._detect_conflicts(results, tasks)

    assert len(conflicts) == 1
    assert conflicts[0].type == "file_write"


# ═══════════════════════════════════════════════════════════════════════════
# resolve_conflicts_with_llm — LLM冲突仲裁测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_resolve_conflicts_with_llm_success():
    """LLM成功仲裁时，应返回winner_task_id和resolution。"""
    llm = MockLLM(responses=[
        '{"winnerTaskId": "t2", "reasoning": "结果B更准确，基于最新数据"}',
    ])
    aggregator = ResultAggregator()

    conflicts = [
        ResultConflict(
            type="file_write",
            description="多个Agent写入同一文件: /tmp/test.txt",
            involved_tasks=["t1", "t2"],
            severity="high",
        ),
    ]

    resolutions = await aggregator.resolve_conflicts_with_llm(conflicts, llm)

    assert len(resolutions) == 1
    assert resolutions[0]["winner_task_id"] == "t2"
    assert "t2" in resolutions[0]["resolution"]


@pytest.mark.anyio
async def test_resolve_conflicts_with_llm_fallback():
    """LLM仲裁失败时，应默认选择第一个涉及的任务作为获胜方。"""
    class ErrorLLM:
        async def chat(self, prompt: str, system_prompt: str = "") -> str:
            raise RuntimeError("LLM error")

    aggregator = ResultAggregator()
    conflicts = [
        ResultConflict(
            type="goal_overlap",
            description="重复目标",
            involved_tasks=["t1", "t2"],
            severity="medium",
        ),
    ]

    resolutions = await aggregator.resolve_conflicts_with_llm(conflicts, ErrorLLM())

    assert len(resolutions) == 1
    assert resolutions[0]["winner_task_id"] == "t1"


# ═══════════════════════════════════════════════════════════════════════════
# merge_with_consensus — 置信度加权合并测试
# ═══════════════════════════════════════════════════════════════════════════


def test_merge_with_consensus_selects_highest_confidence():
    """应选择置信度最高的结果，并计算平均置信度。"""
    aggregator = ResultAggregator()
    results = [
        {"taskId": "t1", "result": {"answer": "A"}, "confidence": 0.6, "agentId": "a1"},
        {"taskId": "t2", "result": {"answer": "B"}, "confidence": 0.9, "agentId": "a2"},
        {"taskId": "t3", "result": {"answer": "C"}, "confidence": 0.3, "agentId": "a3"},
    ]

    merged = aggregator.merge_with_consensus(results)

    assert merged.selected_task_id == "t2"
    assert merged.result == {"answer": "B"}
    assert merged.selected_agent_id == "a2"
    assert abs(merged.average_confidence - 0.6) < 0.01


def test_merge_with_consensus_empty():
    """空结果列表应返回默认的ConsensusResult。"""
    aggregator = ResultAggregator()
    merged = aggregator.merge_with_consensus([])

    assert merged.selected_task_id == ""
    assert merged.result is None
    assert merged.average_confidence == 0.0


def test_merge_with_consensus_single():
    """单个结果时，应直接选中该结果，平均置信度等于其置信度。"""
    aggregator = ResultAggregator()
    results = [
        {"taskId": "t1", "result": {"answer": "X"}, "confidence": 0.8, "agentId": "a1"},
    ]

    merged = aggregator.merge_with_consensus(results)

    assert merged.selected_task_id == "t1"
    assert merged.result == {"answer": "X"}
    assert merged.average_confidence == 0.8


# ═══════════════════════════════════════════════════════════════════════════
# 静态方法测试
# ═══════════════════════════════════════════════════════════════════════════


def test_is_all_successful():
    """is_all_successful应正确反映success字段。"""
    success_result = AggregatedResult(success=True, total_tasks=3, completed_tasks=3)
    assert ResultAggregator.is_all_successful(success_result) is True

    fail_result = AggregatedResult(success=False, total_tasks=3, completed_tasks=2, failed_tasks=1)
    assert ResultAggregator.is_all_successful(fail_result) is False


def test_get_failed_details():
    """get_failed_details应返回所有status为failed的TaskDetail。"""
    result = AggregatedResult(
        success=False,
        details={
            "t1": TaskDetail(task_id="t1", status="completed"),
            "t2": TaskDetail(task_id="t2", status="failed", error="超时"),
            "t3": TaskDetail(task_id="t3", status="failed", error="权限不足"),
            "t4": TaskDetail(task_id="t4", status="completed"),
        },
    )

    failed = ResultAggregator.get_failed_details(result)

    assert len(failed) == 2
    assert failed[0].task_id in ("t2", "t3")
    assert failed[1].task_id in ("t2", "t3")


def test_build_summary_all_success():
    """全部成功时摘要应包含✅和成功文本。"""
    summary = ResultAggregator._build_summary(True, 5, 5, 0, [], 1200.0)
    assert "✅" in summary
    assert "全部任务执行成功" in summary
    assert "总任务数: 5" in summary
    assert "1200ms" in summary


def test_build_summary_partial_failure():
    """部分失败时摘要应包含⚠️和失败任务ID列表。"""
    summary = ResultAggregator._build_summary(
        False, 5, 3, 2, ["t2", "t4"], 800.0
    )
    assert "⚠️" in summary
    assert "部分任务执行失败" in summary
    assert "失败: 2" in summary
    assert "t2, t4" in summary
