from __future__ import annotations

import asyncio

import pytest
import time

from agent.orchestration.fanout import (
    FanoutConfig,
    FanoutResult,
    SubAgentFanout,
    SubTaskResult,
    TaskNode,
)


class MockExecutor:
    """模拟执行器，延时后返回预定义结果。"""

    def __init__(
        self,
        result: object = None,
        delay_ms: float = 0.0,
        should_fail: bool = False,
        error_msg: str = "mock error",
    ) -> None:
        self.result = result or {"status": "ok"}
        self.delay_ms = delay_ms
        self.should_fail = should_fail
        self.error_msg = error_msg

    async def execute(self, task: TaskNode) -> object:
        if self.delay_ms > 0:
            await asyncio.sleep(self.delay_ms / 1000.0)
        if self.should_fail:
            raise RuntimeError(self.error_msg)
        return self.result


class MockCallable:
    """可调用执行器，支持同步/异步返回。"""

    def __init__(
        self,
        result: object = None,
        delay_ms: float = 0.0,
        is_async: bool = False,
    ) -> None:
        self.result = result or {"status": "ok"}
        self.delay_ms = delay_ms
        self.is_async = is_async
        self.call_count = 0

    def __call__(self, task: TaskNode) -> object:
        self.call_count += 1
        if self.is_async:
            async def _async():
                if self.delay_ms > 0:
                    await asyncio.sleep(self.delay_ms / 1000.0)
                return self.result
            return _async()
        if self.delay_ms > 0:
            time.sleep(self.delay_ms / 1000.0)
        return self.result


# ═══════════════════════════════════════════════════════════════════════════
# TaskNode 基础测试
# ═══════════════════════════════════════════════════════════════════════════


def test_task_node_creation():
    node = TaskNode(id="1", goal="测试任务")
    assert node.id == "1"
    assert node.goal == "测试任务"
    assert node.status == "pending"
    assert node.dependencies == []
    assert node.result is None
    assert node.error is None


def test_task_node_with_dependencies():
    node = TaskNode(id="2", goal="依赖任务", dependencies=["1"])
    assert node.dependencies == ["1"]
    assert node.status == "pending"


# ═══════════════════════════════════════════════════════════════════════════
# FanoutConfig 配置测试
# ═══════════════════════════════════════════════════════════════════════════


def test_fanout_config_defaults():
    config = FanoutConfig()
    assert config.max_fanout == 5
    assert config.strategy == "adaptive"
    assert config.task_timeout_ms == 30_000.0
    assert config.continue_on_partial_failure is True


def test_fanout_config_custom():
    config = FanoutConfig(
        max_fanout=3,
        strategy="parallel",
        task_timeout_ms=10_000,
        continue_on_partial_failure=False,
    )
    assert config.max_fanout == 3
    assert config.strategy == "parallel"
    assert config.task_timeout_ms == 10_000
    assert config.continue_on_partial_failure is False


# ═══════════════════════════════════════════════════════════════════════════
# SubAgentFanout — 空任务列表
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_fanout_empty_tasks():
    fanout = SubAgentFanout()
    executor = MockExecutor()
    result = await fanout.fanout([], executor)

    assert result.all_succeeded is True
    assert result.total_count == 0
    assert result.success_count == 0
    assert result.failed_count == 0


# ═══════════════════════════════════════════════════════════════════════════
# SubAgentFanout — 并行执行
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_fanout_parallel_single_task():
    fanout = SubAgentFanout(FanoutConfig(strategy="parallel"))
    executor = MockExecutor(result={"data": "hello"})
    tasks = [TaskNode(id="1", goal="简单任务")]

    result = await fanout.fanout(tasks, executor)

    assert result.all_succeeded is True
    assert result.total_count == 1
    assert result.success_count == 1
    assert result.failed_count == 0
    assert result.sub_results[0].result == {"data": "hello"}
    assert result.sub_results[0].task_id == "1"


@pytest.mark.anyio
async def test_fanout_parallel_multiple_tasks():
    fanout = SubAgentFanout(FanoutConfig(strategy="parallel", max_fanout=3))
    executor = MockExecutor(result={"ok": True})

    tasks = [
        TaskNode(id="1", goal="任务1"),
        TaskNode(id="2", goal="任务2"),
        TaskNode(id="3", goal="任务3"),
    ]

    result = await fanout.fanout(tasks, executor)

    assert result.all_succeeded is True
    assert result.total_count == 3
    assert result.success_count == 3
    assert result.failed_count == 0
    assert len(result.sub_results) == 3


@pytest.mark.anyio
async def test_fanout_parallel_partial_failure_continue():
    fanout = SubAgentFanout(
        FanoutConfig(
            strategy="parallel",
            max_fanout=3,
            continue_on_partial_failure=True,
        )
    )

    tasks = [
        TaskNode(id="1", goal="成功任务1"),
        TaskNode(id="2", goal="失败任务"),
        TaskNode(id="3", goal="成功任务2"),
    ]

    async def selective_executor(task: TaskNode) -> object:
        if task.id == "2":
            raise RuntimeError("任务失败")
        return {"task": task.id, "ok": True}

    result = await fanout.fanout(tasks, selective_executor)

    assert result.all_succeeded is False
    assert result.total_count == 3
    assert result.success_count == 2
    assert result.failed_count == 1
    assert result.sub_results[1].success is False
    assert result.sub_results[1].error == "任务失败"


# ═══════════════════════════════════════════════════════════════════════════
# SubAgentFanout — 顺序执行
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_fanout_sequential_all_success():
    fanout = SubAgentFanout(FanoutConfig(strategy="sequential"))
    executor = MockExecutor(result={"ok": True})

    tasks = [
        TaskNode(id="1", goal="步骤1"),
        TaskNode(id="2", goal="步骤2"),
        TaskNode(id="3", goal="步骤3"),
    ]

    result = await fanout.fanout(tasks, executor)

    assert result.all_succeeded is True
    assert result.total_count == 3
    assert result.success_count == 3


@pytest.mark.anyio
async def test_fanout_sequential_fail_fast():
    fanout = SubAgentFanout(
        FanoutConfig(
            strategy="sequential",
            continue_on_partial_failure=False,
        )
    )

    tasks = [
        TaskNode(id="1", goal="步骤1"),
        TaskNode(id="2", goal="失败步骤"),
        TaskNode(id="3", goal="步骤3"),
    ]

    async def selective_executor(task: TaskNode) -> object:
        if task.id == "2":
            raise RuntimeError("步骤2失败")
        return {"task": task.id, "ok": True}

    result = await fanout.fanout(tasks, selective_executor)

    assert result.all_succeeded is False
    assert result.success_count == 1
    assert result.sub_results[1].success is False
    assert result.sub_results[1].error == "步骤2失败"


@pytest.mark.anyio
async def test_fanout_sequential_with_dependencies():
    fanout = SubAgentFanout(
        FanoutConfig(
            strategy="sequential",
            continue_on_partial_failure=False,
        )
    )

    tasks = [
        TaskNode(id="1", goal="第一步"),
        TaskNode(id="2", goal="第二步", dependencies=["1"]),
        TaskNode(id="3", goal="第三步", dependencies=["2"]),
    ]

    async def tracking_executor(task: TaskNode) -> object:
        return {"task": task.id, "deps": task.dependencies}

    result = await fanout.fanout(tasks, tracking_executor)

    assert result.all_succeeded is True
    assert result.success_count == 3


@pytest.mark.anyio
async def test_fanout_sequential_dependency_failure_blocks_dependent():
    fanout = SubAgentFanout(
        FanoutConfig(
            strategy="sequential",
            continue_on_partial_failure=False,
        )
    )

    tasks = [
        TaskNode(id="1", goal="第一步"),
        TaskNode(id="2", goal="失败步骤", dependencies=["1"]),
        TaskNode(id="3", goal="第三步", dependencies=["2"]),
    ]

    async def selective_executor(task: TaskNode) -> object:
        if task.id == "2":
            raise RuntimeError("步骤2失败")
        return {"task": task.id, "ok": True}

    result = await fanout.fanout(tasks, selective_executor)

    assert result.all_succeeded is False
    assert result.sub_results[1].success is False
    assert result.sub_results[1].error == "步骤2失败"
    # 第三个任务因依赖失败被跳过，total_count 仍为 3
    assert result.total_count == 3
    assert result.success_count == 1


# ═══════════════════════════════════════════════════════════════════════════
# SubAgentFanout — 自适应策略
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_fanout_adaptive_no_deps_uses_parallel():
    fanout = SubAgentFanout(FanoutConfig(strategy="adaptive"))
    executor = MockExecutor(result={"ok": True})

    tasks = [
        TaskNode(id="1", goal="独立任务1"),
        TaskNode(id="2", goal="独立任务2"),
    ]

    result = await fanout.fanout(tasks, executor)

    assert result.all_succeeded is True
    assert result.success_count == 2


@pytest.mark.anyio
async def test_fanout_adaptive_with_deps_uses_sequential():
    fanout = SubAgentFanout(FanoutConfig(strategy="adaptive"))
    executor = MockExecutor(result={"ok": True})

    tasks = [
        TaskNode(id="1", goal="先决任务"),
        TaskNode(id="2", goal="依赖任务", dependencies=["1"]),
    ]

    result = await fanout.fanout(tasks, executor)

    assert result.all_succeeded is True
    assert result.success_count == 2


# ═══════════════════════════════════════════════════════════════════════════
# SubAgentFanout — 超时处理
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_fanout_task_timeout():
    fanout = SubAgentFanout(
        FanoutConfig(
            strategy="parallel",
            task_timeout_ms=100.0,
            continue_on_partial_failure=True,
        )
    )

    tasks = [
        TaskNode(id="1", goal="超时任务"),
    ]

    async def slow_executor(task: TaskNode) -> object:
        await asyncio.sleep(1.0)
        return {"ok": True}

    result = await fanout.fanout(tasks, slow_executor)

    assert result.all_succeeded is False
    assert result.sub_results[0].success is False
    assert "超时" in result.sub_results[0].error


# ═══════════════════════════════════════════════════════════════════════════
# SubAgentFanout — 并发控制
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_fanout_max_concurrency_respected():
    fanout = SubAgentFanout(
        FanoutConfig(
            strategy="parallel",
            max_fanout=1,
            task_timeout_ms=5000,
        )
    )
    executor = MockExecutor(result={"ok": True}, delay_ms=50)

    tasks = [
        TaskNode(id="1", goal="任务1"),
        TaskNode(id="2", goal="任务2"),
        TaskNode(id="3", goal="任务3"),
    ]

    start = time.time()
    result = await fanout.fanout(tasks, executor)
    duration = (time.time() - start) * 1000

    assert result.all_succeeded is True
    assert result.success_count == 3
    assert duration > 100


@pytest.mark.anyio
async def test_fanout_high_concurrency():
    fanout = SubAgentFanout(
        FanoutConfig(
            strategy="parallel",
            max_fanout=10,
            task_timeout_ms=5000,
        )
    )
    executor = MockExecutor(result={"ok": True}, delay_ms=30)

    tasks = [TaskNode(id=str(i), goal=f"任务{i}") for i in range(10)]

    start = time.time()
    result = await fanout.fanout(tasks, executor)
    duration = (time.time() - start) * 1000

    assert result.all_succeeded is True
    assert result.success_count == 10
    assert duration < 2000


# ═══════════════════════════════════════════════════════════════════════════
# SubAgentFanout — 可调用执行器
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_fanout_with_callable_executor():
    fanout = SubAgentFanout(FanoutConfig(strategy="parallel"))
    callable_exec = MockCallable(result={"from_callable": True})

    tasks = [TaskNode(id="1", goal="任务1")]

    result = await fanout.fanout(tasks, callable_exec)

    assert result.all_succeeded is True
    assert result.sub_results[0].result == {"from_callable": True}


@pytest.mark.anyio
async def test_fanout_with_async_callable():
    fanout = SubAgentFanout(FanoutConfig(strategy="parallel"))
    callable_exec = MockCallable(result={"async": True}, is_async=True)

    tasks = [TaskNode(id="1", goal="异步任务")]

    result = await fanout.fanout(tasks, callable_exec)

    assert result.all_succeeded is True
    assert result.sub_results[0].result == {"async": True}


# ═══════════════════════════════════════════════════════════════════════════
# SubAgentFanout — update_config 与 parent_id
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_fanout_update_config():
    fanout = SubAgentFanout(FanoutConfig(max_fanout=5))
    fanout.update_config(FanoutConfig(max_fanout=2, strategy="parallel"))

    executor = MockExecutor()
    tasks = [
        TaskNode(id="1", goal="任务1"),
        TaskNode(id="2", goal="任务2"),
    ]

    result = await fanout.fanout(tasks, executor)

    assert result.all_succeeded is True


@pytest.mark.anyio
async def test_fanout_with_parent_id():
    fanout = SubAgentFanout()
    executor = MockExecutor()

    tasks = [TaskNode(id="1", goal="子任务")]
    result = await fanout.fanout(tasks, executor, parent_id="parent-001")

    assert result.all_succeeded is True
    assert result.sub_results[0].task_id == "1"


@pytest.mark.anyio
async def test_fanout_invalid_executor():
    fanout = SubAgentFanout()
    tasks = [TaskNode(id="1", goal="任务")]

    result = await fanout.fanout(tasks, "not_a_valid_executor")

    assert result.success_count == 0


# ═══════════════════════════════════════════════════════════════════════════
# FanoutResult 数据类测试
# ═══════════════════════════════════════════════════════════════════════════


def test_fanout_result_defaults():
    result = FanoutResult()
    assert result.all_succeeded is False
    assert result.total_count == 0
    assert result.success_count == 0
    assert result.failed_count == 0
    assert result.sub_results == []
    assert result.duration_ms == 0.0


def test_sub_task_result_creation():
    sr = SubTaskResult(
        task_id="t1",
        success=True,
        result={"data": "ok"},
        duration_ms=150.0,
        agent_id="agent-1",
    )
    assert sr.task_id == "t1"
    assert sr.success is True
    assert sr.result == {"data": "ok"}
    assert sr.duration_ms == 150.0
    assert sr.agent_id == "agent-1"
