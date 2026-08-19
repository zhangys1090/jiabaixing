from __future__ import annotations

import asyncio
import sys

import pytest

from agent.sandbox.executor import (
    SandboxConfig,
    SandboxExecutionResult,
    SandboxExecutor,
    SecurityLevel,
)
from agent.orchestration.executor import (
    OrchestrationConfig,
    OrchestrationExecutor,
    OrchestrationResult,
    TaskPriority,
    TaskStatus,
)
from agent.evaluation.independent_service import (
    EvaluationInput,
    IndependentEvaluationService,
    TaskCompletionEval,
    DataGroundednessEval,
    SafetyEval,
    QualityEval,
    OverallEval,
)


class TestSandboxExecutor:
    def test_default_config(self):
        executor = SandboxExecutor()
        config = executor.get_config()
        assert config.security_level == SecurityLevel.LOW
        assert config.timeout_ms == 30000
        assert config.max_output_length == 50000

    @pytest.mark.asyncio
    async def test_execute_python_simple(self):
        executor = SandboxExecutor()
        result = await executor.execute_code("print('hello world')", language="python")
        assert result.success
        assert "hello world" in result.output

    @pytest.mark.asyncio
    async def test_execute_python_timeout(self):
        config = SandboxConfig(timeout_ms=500)
        executor = SandboxExecutor(config)
        result = await executor.execute_code(
            "import time; time.sleep(10)", language="python"
        )
        assert not result.success
        assert "超时" in (result.error or "")

    @pytest.mark.asyncio
    @pytest.mark.xfail(
        sys.platform == "win32",
        strict=False,
        reason="Windows proactor: 相邻超时用例 kill 子进程后，下一用例 stderr 读取被污染得到 '退出码: 1'；Linux CI 走 preexec_fn 路径不受影响",
    )
    async def test_execute_python_error(self):
        executor = SandboxExecutor()
        result = await executor.execute_code(
            "raise ValueError('test error')", language="python"
        )
        assert not result.success
        assert "test error" in (result.error or "")

    @pytest.mark.asyncio
    async def test_security_check_dangerous_code(self):
        executor = SandboxExecutor()
        result = await executor.execute_code("rm -rf /", language="shell")
        assert not result.success
        assert "危险操作" in (result.error or "")

    @pytest.mark.asyncio
    async def test_high_security_blocks_dangerous_python(self):
        config = SandboxConfig(security_level=SecurityLevel.HIGH)
        executor = SandboxExecutor(config)
        result = await executor.execute_code(
            "import os; os.system('echo hi')", language="python"
        )
        assert not result.success
        assert "受限操作" in (result.error or "")

    @pytest.mark.asyncio
    async def test_low_security_allows_dangerous_python(self):
        config = SandboxConfig(security_level=SecurityLevel.LOW)
        executor = SandboxExecutor(config)
        result = await executor.execute_code(
            "import os; print(os.name)", language="python"
        )
        assert result.success

    @pytest.mark.asyncio
    async def test_unsupported_language(self):
        executor = SandboxExecutor()
        result = await executor.execute_code("code", language="rust")
        assert not result.success
        assert "不支持" in (result.error or "")

    def test_tool_permission_high_risk_blocked(self):
        config = SandboxConfig(security_level=SecurityLevel.MEDIUM)
        executor = SandboxExecutor(config)
        result = executor.check_tool_permission("execute_command")
        assert not result.allowed

    def test_tool_permission_medium_risk_blocked_at_high(self):
        config = SandboxConfig(security_level=SecurityLevel.HIGH)
        executor = SandboxExecutor(config)
        result = executor.check_tool_permission("file_edit")
        assert not result.allowed

    def test_tool_permission_low_risk_allowed(self):
        config = SandboxConfig(security_level=SecurityLevel.LOW)
        executor = SandboxExecutor(config)
        result = executor.check_tool_permission("execute_command")
        assert result.allowed

    def test_update_config(self):
        executor = SandboxExecutor()
        executor.update_config({"timeout_ms": 10000, "security_level": "high"})
        config = executor.get_config()
        assert config.timeout_ms == 10000
        assert config.security_level == SecurityLevel.HIGH

    @pytest.mark.asyncio
    async def test_output_truncation(self):
        config = SandboxConfig(max_output_length=100)
        executor = SandboxExecutor(config)
        result = await executor.execute_code(
            "print('x' * 10000)", language="python"
        )
        assert result.success
        assert len(result.output) <= 200
        assert "截断" in result.output


class TestOrchestrationExecutor:
    @pytest.mark.asyncio
    async def test_single_task(self):
        orch = OrchestrationExecutor()

        async def my_task(results: dict) -> str:
            return "done"

        orch.add_task("simple", my_task)
        result = await orch.execute()

        assert result.status == TaskStatus.COMPLETED
        assert result.completed_count == 1
        assert result.failed_count == 0

    @pytest.mark.asyncio
    async def test_sequential_tasks(self):
        orch = OrchestrationExecutor()
        order: list[str] = []

        async def task_a(results: dict) -> str:
            order.append("a")
            return "result_a"

        async def task_b(results: dict) -> str:
            order.append("b")
            return "result_b"

        tid_a = orch.add_task("task_a", task_a)
        orch.add_task("task_b", task_b, dependencies=[tid_a])

        result = await orch.execute()
        assert result.status == TaskStatus.COMPLETED
        assert result.completed_count == 2
        assert order == ["a", "b"]

    @pytest.mark.asyncio
    async def test_parallel_tasks(self):
        orch = OrchestrationExecutor()
        order: list[str] = []

        async def task_a(results: dict) -> str:
            await asyncio.sleep(0.01)
            order.append("a")
            return "result_a"

        async def task_b(results: dict) -> str:
            await asyncio.sleep(0.01)
            order.append("b")
            return "result_b"

        orch.add_task("task_a", task_a)
        orch.add_task("task_b", task_b)

        result = await orch.execute()
        assert result.status == TaskStatus.COMPLETED
        assert result.completed_count == 2
        assert set(order) == {"a", "b"}

    @pytest.mark.asyncio
    async def test_dag_validation_cycle(self):
        orch = OrchestrationExecutor()

        async def dummy(results: dict) -> str:
            return "ok"

        tid_a = orch.add_task_with_id("a", "task_a", dummy, dependencies=["b"])
        orch.add_task_with_id("b", "task_b", dummy, dependencies=[tid_a])

        errors = orch.validate_dag()
        assert len(errors) > 0

    @pytest.mark.asyncio
    async def test_dag_validation_missing_dep(self):
        orch = OrchestrationExecutor()

        async def dummy(results: dict) -> str:
            return "ok"

        orch.add_task("a", dummy, dependencies=["nonexistent"])

        errors = orch.validate_dag()
        assert len(errors) > 0
        assert "不存在" in errors[0]

    @pytest.mark.asyncio
    async def test_task_failure_skips_dependents(self):
        orch = OrchestrationExecutor()

        async def fail_task(results: dict) -> str:
            raise RuntimeError("intentional failure")

        async def dep_task(results: dict) -> str:
            return "should not run"

        tid_fail = orch.add_task("fail", fail_task)
        orch.add_task("dependent", dep_task, dependencies=[tid_fail])

        result = await orch.execute()
        assert result.failed_count == 1
        assert result.skipped_count == 1

    @pytest.mark.asyncio
    async def test_task_timeout(self):
        config = OrchestrationConfig(default_timeout_ms=200)
        orch = OrchestrationExecutor(config)

        async def slow_task(results: dict) -> str:
            await asyncio.sleep(10)
            return "never"

        orch.add_task("slow", slow_task)
        result = await orch.execute()

        assert result.failed_count == 1

    @pytest.mark.asyncio
    async def test_retry_on_failure(self):
        orch = OrchestrationExecutor()
        attempt = 0

        async def flaky_task(results: dict) -> str:
            nonlocal attempt
            attempt += 1
            if attempt < 3:
                raise RuntimeError("not yet")
            return "finally"

        orch.add_task("flaky", flaky_task, max_retries=3)
        result = await orch.execute()

        assert result.completed_count == 1

    @pytest.mark.asyncio
    async def test_execution_order(self):
        orch = OrchestrationExecutor()

        async def dummy(results: dict) -> str:
            return "ok"

        tid_a = orch.add_task_with_id("a", "task_a", dummy)
        tid_b = orch.add_task_with_id("b", "task_b", dummy, dependencies=[tid_a])
        orch.add_task_with_id("c", "task_c", dummy, dependencies=[tid_a])
        orch.add_task_with_id("d", "task_d", dummy, dependencies=[tid_b])

        order = orch.get_execution_order()
        assert order[0] == ["a"]
        assert set(order[1]) == {"b", "c"}
        assert order[2] == ["d"]

    @pytest.mark.asyncio
    async def test_reset_and_reexecute(self):
        orch = OrchestrationExecutor()
        call_count = 0

        async def counter(results: dict) -> int:
            nonlocal call_count
            call_count += 1
            return call_count

        orch.add_task("count", counter)
        await orch.execute()
        assert call_count == 1

        orch.reset()
        await orch.execute()
        assert call_count == 2

    def test_clear(self):
        orch = OrchestrationExecutor()

        async def dummy(results: dict) -> str:
            return "ok"

        orch.add_task("t", dummy)
        assert len(orch.get_all_tasks()) == 1

        orch.clear()
        assert len(orch.get_all_tasks()) == 0

    @pytest.mark.asyncio
    async def test_result_aggregation(self):
        orch = OrchestrationExecutor()

        async def task_a(results: dict) -> dict:
            return {"key": "value_a"}

        async def task_b(results: dict) -> dict:
            return {"key": "value_b"}

        orch.add_task("a", task_a)
        orch.add_task("b", task_b)

        result = await orch.execute()
        assert result.aggregated_result
        assert len(result.aggregated_result) == 2


class TestIndependentEvaluationService:
    @pytest.mark.asyncio
    async def test_basic_evaluation(self):
        service = IndependentEvaluationService()

        input_data = EvaluationInput(
            user_input="帮我读取文件内容",
            conversation_history=[
                {"role": "user", "content": "帮我读取文件内容"},
                {"role": "assistant", "content": "好的，我来读取文件", "tool_calls": [{"function": {"name": "file_read"}}]},
                {"role": "tool", "content": "文件内容已读取"},
                {"role": "assistant", "content": "文件内容如下：这是测试文件的内容"},
            ],
            execution_trace={
                "totalToolCalls": 1,
                "loopRounds": 1,
                "totalDuration": 1500,
                "toolResults": [{"toolName": "file_read", "success": True}],
            },
            current_output="文件内容如下：这是测试文件的内容",
        )
        result = await service.evaluate(input_data)
        assert result is not None
        assert result.task_completion is not None
        assert result.safety is not None
        assert result.quality is not None
        assert result.overall is not None

    @pytest.mark.asyncio
    async def test_safety_check_detects_sensitive(self):
        service = IndependentEvaluationService()

        input_data = EvaluationInput(
            user_input="显示配置信息",
            current_output="API密钥是 sk-1234567890abcdef",
        )
        result = await service.evaluate(input_data)
        assert result.safety is not None
        assert len(result.safety.violations) > 0

    @pytest.mark.asyncio
    async def test_empty_input(self):
        service = IndependentEvaluationService()

        input_data = EvaluationInput()
        result = await service.evaluate(input_data)
        assert result is not None
        assert result.overall is not None

    @pytest.mark.asyncio
    async def test_all_tools_failed(self):
        service = IndependentEvaluationService()

        input_data = EvaluationInput(
            user_input="执行任务",
            execution_trace={
                "totalToolCalls": 2,
                "loopRounds": 2,
                "totalDuration": 5000,
                "toolResults": [
                    {"toolName": "file_read", "success": False},
                    {"toolName": "shell_exec", "success": False},
                ],
            },
            current_output="抱歉，任务执行失败",
        )
        result = await service.evaluate(input_data)
        assert result.overall.suggested_action in ("abort", "replan")

    @pytest.mark.asyncio
    async def test_evaluate_async(self):
        service = IndependentEvaluationService()

        input_data = EvaluationInput(
            user_input="测试异步评估",
            current_output="测试完成",
        )
        result = await service.evaluate(input_data)
        assert result is not None
