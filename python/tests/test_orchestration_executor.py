from __future__ import annotations

import asyncio
import time

import pytest

from agent.orchestration.executor import (
    DAGValidationError,
    OrchestrationConfig,
    OrchestrationExecutor,
    OrchestrationResult,
    TaskNode,
    TaskPriority,
    TaskStatus,
)


class MockAsyncExecutor:
    """模拟异步执行器，返回预定义结果。"""

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
        self.call_count = 0

    async def __call__(self, completed_results: dict | None = None) -> object:
        self.call_count += 1
        if self.delay_ms > 0:
            await asyncio.sleep(self.delay_ms / 1000.0)
        if self.should_fail:
            raise RuntimeError(self.error_msg)
        return self.result


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationConfig 配置测试
# ═══════════════════════════════════════════════════════════════════════════


def test_orchestration_config_defaults():
    config = OrchestrationConfig()
    assert config.max_concurrent == 5
    assert config.default_timeout_ms == 60000
    assert config.default_max_retries == 0
    assert config.fail_fast is False
    assert config.collect_results is True


def test_orchestration_config_custom():
    config = OrchestrationConfig(
        max_concurrent=3,
        default_timeout_ms=30000,
        default_max_retries=2,
        fail_fast=True,
        collect_results=False,
    )
    assert config.max_concurrent == 3
    assert config.default_timeout_ms == 30000
    assert config.default_max_retries == 2
    assert config.fail_fast is True
    assert config.collect_results is False


# ═══════════════════════════════════════════════════════════════════════════
# TaskNode 创建测试
# ═══════════════════════════════════════════════════════════════════════════


def test_task_node_defaults():
    node = TaskNode(
        task_id="t1",
        name="测试任务",
        executor=lambda x: {"ok": True},
    )
    assert node.task_id == "t1"
    assert node.name == "测试任务"
    assert node.status == TaskStatus.PENDING
    assert node.dependencies == []
    assert node.priority == TaskPriority.NORMAL
    assert node.timeout_ms == 60000
    assert node.max_retries == 0
    assert node.retry_count == 0


def test_task_node_with_dependencies():
    node = TaskNode(
        task_id="t2",
        name="依赖任务",
        executor=lambda x: {"ok": True},
        dependencies=["t1"],
        priority=TaskPriority.HIGH,
    )
    assert node.dependencies == ["t1"]
    assert node.priority == TaskPriority.HIGH


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationExecutor — 添加任务
# ═══════════════════════════════════════════════════════════════════════════


def test_add_task():
    executor = OrchestrationExecutor()
    task_id = executor.add_task("任务A", MockAsyncExecutor())

    assert task_id.startswith("task_")
    assert len(task_id) > 5


def test_add_task_with_dependencies():
    executor = OrchestrationExecutor()
    task_id = executor.add_task(
        "任务B",
        MockAsyncExecutor(),
        dependencies=["task_abc"],
    )

    task = executor.get_task(task_id)
    assert task is not None
    assert task.dependencies == ["task_abc"]


def test_add_task_with_custom_config():
    executor = OrchestrationExecutor()
    task_id = executor.add_task(
        "任务C",
        MockAsyncExecutor(),
        priority=TaskPriority.CRITICAL,
        timeout_ms=30000,
        max_retries=3,
        metadata={"key": "value"},
    )

    task = executor.get_task(task_id)
    assert task.priority == TaskPriority.CRITICAL
    assert task.timeout_ms == 30000
    assert task.max_retries == 3
    assert task.metadata == {"key": "value"}


def test_add_task_with_id():
    executor = OrchestrationExecutor()
    task_id = executor.add_task_with_id(
        "custom_id",
        "自定义ID任务",
        MockAsyncExecutor(),
    )

    assert task_id == "custom_id"
    task = executor.get_task("custom_id")
    assert task is not None
    assert task.name == "自定义ID任务"


def test_get_task_nonexistent():
    executor = OrchestrationExecutor()
    assert executor.get_task("nonexistent") is None


def test_get_all_tasks():
    executor = OrchestrationExecutor()
    executor.add_task("任务1", MockAsyncExecutor())
    executor.add_task("任务2", MockAsyncExecutor())

    all_tasks = executor.get_all_tasks()
    assert len(all_tasks) == 2


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationExecutor — 执行测试
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_single_task():
    executor = OrchestrationExecutor()
    executor.add_task("单任务", MockAsyncExecutor(result={"data": "done"}))

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 1
    assert result.failed_count == 0
    assert result.aggregated_result is not None


@pytest.mark.anyio
async def test_execute_multiple_independent_tasks():
    executor = OrchestrationExecutor(
        OrchestrationConfig(max_concurrent=3)
    )
    executor.add_task("任务A", MockAsyncExecutor(result={"task": "A"}))
    executor.add_task("任务B", MockAsyncExecutor(result={"task": "B"}))
    executor.add_task("任务C", MockAsyncExecutor(result={"task": "C"}))

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 3
    assert result.failed_count == 0
    assert len(result.aggregated_result) == 3


@pytest.mark.anyio
async def test_execute_tasks_with_dependencies():
    executor = OrchestrationExecutor()
    t1 = executor.add_task("步骤1", MockAsyncExecutor(result={"step": 1}))
    executor.add_task(
        "步骤2",
        MockAsyncExecutor(result={"step": 2}),
        dependencies=[t1],
    )

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 2


@pytest.mark.anyio
async def test_execute_dag_dependency_order():
    executor = OrchestrationExecutor()
    execution_order: list[str] = []

    async def tracking_executor(completed_results: dict | None = None) -> dict:
        nonlocal execution_order
        import asyncio as _asyncio
        task = _asyncio.current_task()
        if task:
            task_name = task.get_name()
            if task_name.startswith("task_"):
                execution_order.append(task_name)
        return {"ok": True}

    t1 = executor.add_task("步骤1", tracking_executor)
    t2 = executor.add_task("步骤2", tracking_executor, dependencies=[t1])
    t3 = executor.add_task("步骤3", tracking_executor, dependencies=[t2])

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 3


@pytest.mark.anyio
async def test_execute_task_failure():
    executor = OrchestrationExecutor()
    executor.add_task(
        "失败任务",
        MockAsyncExecutor(should_fail=True, error_msg="执行失败"),
    )

    result = await executor.execute()

    assert result.status == TaskStatus.FAILED
    assert result.failed_count == 1
    assert result.completed_count == 0


@pytest.mark.anyio
async def test_execute_partial_failure():
    executor = OrchestrationExecutor()
    executor.add_task("成功任务", MockAsyncExecutor(result={"ok": True}))
    executor.add_task(
        "失败任务",
        MockAsyncExecutor(should_fail=True, error_msg="broken"),
    )

    result = await executor.execute()

    assert result.status == TaskStatus.PARTIALLY_COMPLETED
    assert result.completed_count == 1
    assert result.failed_count == 1


@pytest.mark.anyio
async def test_execute_fail_fast():
    executor = OrchestrationExecutor(
        OrchestrationConfig(fail_fast=True)
    )
    executor.add_task(
        "失败任务",
        MockAsyncExecutor(should_fail=True, error_msg="fail fast"),
    )
    executor.add_task(
        "后续任务",
        MockAsyncExecutor(result={"ok": True}),
        dependencies=["task_00000001"],
    )

    result = await executor.execute()

    assert result.status == TaskStatus.FAILED


@pytest.mark.anyio
async def test_execute_retry():
    executor = OrchestrationExecutor()
    executor.add_task(
        "重试任务",
        MockAsyncExecutor(should_fail=True, error_msg="temp fail"),
        max_retries=2,
    )

    result = await executor.execute()

    assert result.status == TaskStatus.FAILED
    assert result.failed_count == 1


@pytest.mark.anyio
async def test_execute_retry_then_succeed():
    call_counter = {"count": 0}

    async def flaky_executor(completed_results: dict | None = None) -> dict:
        call_counter["count"] += 1
        if call_counter["count"] < 3:
            raise RuntimeError(f"临时失败 #{call_counter['count']}")
        return {"ok": True, "attempt": call_counter["count"]}

    executor = OrchestrationExecutor()
    executor.add_task("不稳定任务", flaky_executor, max_retries=3)

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert call_counter["count"] == 3


@pytest.mark.anyio
async def test_execute_task_timeout():
    executor = OrchestrationExecutor(
        OrchestrationConfig(default_timeout_ms=100)
    )
    executor.add_task(
        "超时任务",
        MockAsyncExecutor(delay_ms=5000),
    )

    result = await executor.execute()

    assert result.status == TaskStatus.FAILED
    assert result.failed_count == 1


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationExecutor — DAG 验证
# ═══════════════════════════════════════════════════════════════════════════


def test_validate_dag_valid():
    executor = OrchestrationExecutor()
    t1 = executor.add_task("任务1", MockAsyncExecutor())
    executor.add_task("任务2", MockAsyncExecutor(), dependencies=[t1])

    errors = executor.validate_dag()
    assert len(errors) == 0


def test_validate_dag_missing_dependency():
    executor = OrchestrationExecutor()
    executor.add_task(
        "任务1",
        MockAsyncExecutor(),
        dependencies=["nonexistent_task"],
    )

    errors = executor.validate_dag()
    assert len(errors) > 0
    assert any("依赖不存在" in e for e in errors)


def test_validate_dag_circular_dependency():
    executor = OrchestrationExecutor()
    t1 = executor.add_task("任务1", MockAsyncExecutor())
    t2 = executor.add_task("任务2", MockAsyncExecutor(), dependencies=[t1])
    executor.add_task("任务3", MockAsyncExecutor(), dependencies=[t2])

    executor._tasks[t1].dependencies = [t2]

    errors = executor.validate_dag()
    assert len(errors) > 0
    assert any("循环依赖" in e for e in errors)


def test_validate_dag_empty():
    executor = OrchestrationExecutor()
    errors = executor.validate_dag()
    assert len(errors) == 0


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationExecutor — 执行顺序
# ═══════════════════════════════════════════════════════════════════════════


def test_get_execution_order_valid():
    executor = OrchestrationExecutor()
    t1 = executor.add_task("任务1", MockAsyncExecutor())
    t2 = executor.add_task("任务2", MockAsyncExecutor(), dependencies=[t1])
    t3 = executor.add_task("任务3", MockAsyncExecutor(), dependencies=[t1])
    executor.add_task("任务4", MockAsyncExecutor(), dependencies=[t2, t3])

    order = executor.get_execution_order()

    assert len(order) == 3
    assert t1 in order[0]
    assert t2 in order[1] and t3 in order[1]


def test_get_execution_order_invalid_dag():
    executor = OrchestrationExecutor()
    t1 = executor.add_task("任务1", MockAsyncExecutor())
    executor._tasks[t1].dependencies = [t1]

    order = executor.get_execution_order()
    assert order == []


def test_get_execution_order_independent_tasks():
    executor = OrchestrationExecutor()
    t1 = executor.add_task("任务A", MockAsyncExecutor())
    t2 = executor.add_task("任务B", MockAsyncExecutor())
    t3 = executor.add_task("任务C", MockAsyncExecutor())

    order = executor.get_execution_order()

    assert len(order) == 1
    assert len(order[0]) == 3


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationExecutor — 重置与清除
# ═══════════════════════════════════════════════════════════════════════════


def test_reset_tasks():
    executor = OrchestrationExecutor()
    task_id = executor.add_task("任务1", MockAsyncExecutor())

    executor._tasks[task_id].status = TaskStatus.COMPLETED
    executor._tasks[task_id].result = {"ok": True}

    executor.reset()

    task = executor.get_task(task_id)
    assert task.status == TaskStatus.PENDING
    assert task.result is None
    assert task.error is None
    assert task.retry_count == 0


def test_clear_tasks():
    executor = OrchestrationExecutor()
    executor.add_task("任务1", MockAsyncExecutor())
    executor.add_task("任务2", MockAsyncExecutor())

    executor.clear()

    assert len(executor.get_all_tasks()) == 0


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationExecutor — 并发性能
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_concurrent_performance():
    executor = OrchestrationExecutor(
        OrchestrationConfig(max_concurrent=10)
    )

    for i in range(10):
        executor.add_task(
            f"任务{i}",
            MockAsyncExecutor(result={"task": i}, delay_ms=50),
        )

    start = time.time()
    result = await executor.execute()
    duration = (time.time() - start) * 1000

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 10
    assert duration < 5000


@pytest.mark.anyio
async def test_execute_sequential_with_dependencies():
    executor = OrchestrationExecutor(
        OrchestrationConfig(max_concurrent=1)
    )

    t1 = executor.add_task("步骤1", MockAsyncExecutor(result={"step": 1}, delay_ms=30))
    t2 = executor.add_task("步骤2", MockAsyncExecutor(result={"step": 2}, delay_ms=30), dependencies=[t1])
    t3 = executor.add_task("步骤3", MockAsyncExecutor(result={"step": 3}, delay_ms=30), dependencies=[t2])

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 3


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationExecutor — 边缘情况
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_execute_empty_tasks():
    executor = OrchestrationExecutor()

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 0


@pytest.mark.anyio
async def test_execute_dependency_failure_skips():
    executor = OrchestrationExecutor()
    t1 = executor.add_task(
        "失败任务",
        MockAsyncExecutor(should_fail=True, error_msg="fail"),
    )
    executor.add_task(
        "依赖任务",
        MockAsyncExecutor(result={"ok": True}),
        dependencies=[t1],
    )

    result = await executor.execute()

    assert result.status == TaskStatus.FAILED
    assert result.skipped_count == 1


@pytest.mark.anyio
async def test_execute_priority_ordering():
    executor = OrchestrationExecutor()
    execution_order: list[str] = []

    async def tracking_executor(completed_results: dict | None = None) -> dict:
        import asyncio as _asyncio
        task = _asyncio.current_task()
        if task:
            execution_order.append(task.get_name())
        return {"ok": True}

    executor.add_task("低优先级", tracking_executor, priority=TaskPriority.LOW)
    executor.add_task("高优先级", tracking_executor, priority=TaskPriority.HIGH)
    executor.add_task("关键任务", tracking_executor, priority=TaskPriority.CRITICAL)
    executor.add_task("普通任务", tracking_executor, priority=TaskPriority.NORMAL)

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 4


@pytest.mark.anyio
async def test_execute_collect_results_disabled():
    executor = OrchestrationExecutor(
        OrchestrationConfig(collect_results=False)
    )
    executor.add_task("任务1", MockAsyncExecutor(result={"data": "secret"}))

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.aggregated_result == {}


@pytest.mark.anyio
async def test_execute_completed_results_passed_to_dependent():
    executor = OrchestrationExecutor()
    t1 = executor.add_task("生产者", MockAsyncExecutor(result={"value": 42}))

    async def consumer(completed_results: dict | None = None) -> dict:
        upstream = completed_results.get(t1, {}) if completed_results else {}
        return {"consumed": upstream.get("value")}

    executor.add_task("消费者", consumer, dependencies=[t1])

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 2


# ═══════════════════════════════════════════════════════════════════════════
# OrchestrationResult 数据类测试
# ═══════════════════════════════════════════════════════════════════════════


def test_orchestration_result_defaults():
    result = OrchestrationResult(
        orchestration_id="orch_001",
        status=TaskStatus.COMPLETED,
        tasks={},
        total_duration_ms=100,
    )
    assert result.orchestration_id == "orch_001"
    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 0
    assert result.failed_count == 0
    assert result.skipped_count == 0


def test_orchestration_result_with_errors():
    result = OrchestrationResult(
        orchestration_id="orch_002",
        status=TaskStatus.FAILED,
        tasks={},
        total_duration_ms=50,
        errors=["task_1: 超时", "task_2: 依赖失败"],
    )
    assert result.status == TaskStatus.FAILED
    assert len(result.errors) == 2


# ═══════════════════════════════════════════════════════════════════════════
# TaskPriority 枚举测试
# ═══════════════════════════════════════════════════════════════════════════


def test_task_priority_order():
    assert TaskPriority.CRITICAL.value < TaskPriority.HIGH.value
    assert TaskPriority.HIGH.value < TaskPriority.NORMAL.value
    assert TaskPriority.NORMAL.value < TaskPriority.LOW.value


# ═══════════════════════════════════════════════════════════════════════════
# DAGValidationError 测试
# ═══════════════════════════════════════════════════════════════════════════


def test_dag_validation_error():
    error = DAGValidationError("循环依赖")
    assert str(error) == "循环依赖"
    assert isinstance(error, Exception)


# ═══════════════════════════════════════════════════════════════════════════
# 复杂 DAG 场景
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_complex_dag_diamond():
    executor = OrchestrationExecutor()
    t1 = executor.add_task("A", MockAsyncExecutor(result={"node": "A"}))
    t2 = executor.add_task("B", MockAsyncExecutor(result={"node": "B"}), dependencies=[t1])
    t3 = executor.add_task("C", MockAsyncExecutor(result={"node": "C"}), dependencies=[t1])
    executor.add_task("D", MockAsyncExecutor(result={"node": "D"}), dependencies=[t2, t3])

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 4


@pytest.mark.anyio
async def test_complex_dag_multi_level():
    executor = OrchestrationExecutor()
    t0 = executor.add_task("根", MockAsyncExecutor(result={"level": 0}))

    level1 = []
    for i in range(3):
        l1 = executor.add_task(
            f"L1-{i}",
            MockAsyncExecutor(result={"level": 1, "idx": i}),
            dependencies=[t0],
        )
        level1.append(l1)

    for i, dep in enumerate(level1):
        executor.add_task(
            f"L2-{i}",
            MockAsyncExecutor(result={"level": 2, "idx": i}),
            dependencies=[dep],
        )

    result = await executor.execute()

    assert result.status == TaskStatus.COMPLETED
    assert result.completed_count == 7
