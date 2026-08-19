"""委派系统测试 — P0 审计产物验证（delegate_tool + async_delegation）"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from agent.tools.delegate_tool import (
    DelegateStatus,
    DelegateRole,
    SubAgentDelegator,
    DelegateResult,
    delegate_task_executor,
)
from agent.tools.async_delegation import (
    AsyncDelegator,
    DelegationSpec,
    DelegationStatus,
    DelegationResult as AsyncDelegationResult,
    AgentCapability,
)


class TestDelegateStatus:
    def test_status_values(self):
        assert DelegateStatus.PENDING.value == "pending"
        assert DelegateStatus.RUNNING.value == "running"
        assert DelegateStatus.COMPLETED.value == "completed"
        assert DelegateStatus.FAILED.value == "failed"
        assert DelegateStatus.CANCELLED.value == "cancelled"


class TestDelegateRole:
    def test_role_values(self):
        assert DelegateRole.LEAF.value == "leaf"
        assert DelegateRole.ORCHESTRATOR.value == "orchestrator"

    def test_orchestrator_can_delegate(self):
        delegator = SubAgentDelegator(role=DelegateRole.ORCHESTRATOR)
        assert delegator.can_delegate is True

    def test_leaf_cannot_delegate(self):
        delegator = SubAgentDelegator(role=DelegateRole.LEAF)
        assert delegator.can_delegate is False

    def test_deep_spawn_cannot_delegate(self):
        delegator = SubAgentDelegator(
            role=DelegateRole.ORCHESTRATOR,
            spawn_depth=SubAgentDelegator.MAX_SPAWN_DEPTH + 1,
        )
        assert delegator.can_delegate is False


class TestSubAgentDelegator:
    def test_init_default(self):
        delegator = SubAgentDelegator()
        assert delegator._role == DelegateRole.ORCHESTRATOR
        assert delegator._spawn_depth == 0

    def test_init_with_role(self):
        delegator = SubAgentDelegator(role=DelegateRole.LEAF)
        assert delegator._role == DelegateRole.LEAF

    def test_init_with_spawn_depth(self):
        delegator = SubAgentDelegator(spawn_depth=2)
        assert delegator._spawn_depth == 2

    @pytest.mark.asyncio
    async def test_delegate_leaf_blocked(self):
        delegator = SubAgentDelegator(role=DelegateRole.LEAF)
        delegator.set_llm(_make_llm())
        result = await delegator.delegate(
            task_description="测试任务",
            context="测试上下文",
        )
        assert result.status == DelegateStatus.FAILED
        assert "leaf" in result.result_text.lower()

    def test_set_llm(self):
        delegator = SubAgentDelegator()
        llm = _make_llm()
        delegator.set_llm(llm)
        assert delegator._llm is not None


class TestDelegateResult:
    def test_result_creation_completed(self):
        result = DelegateResult(
            task_id="task_1",
            status=DelegateStatus.COMPLETED,
            result_text="任务完成",
            duration_ms=1000,
            sub_agent_id="agent_1",
        )
        assert result.status == DelegateStatus.COMPLETED
        assert result.sub_agent_id == "agent_1"
        assert result.result_text == "任务完成"

    def test_result_creation_failed(self):
        result = DelegateResult(
            task_id="task_2",
            status=DelegateStatus.FAILED,
            result_text="执行失败",
            duration_ms=500,
            sub_agent_id="agent_2",
        )
        assert result.status == DelegateStatus.FAILED


class TestAsyncDelegation:
    def test_delegation_spec_creation(self):
        spec = DelegationSpec(
            agent="orchestrator",
            task="测试任务",
            timeout=60,
        )
        assert spec.agent == "orchestrator"
        assert spec.task == "测试任务"
        assert spec.timeout == 60

    def test_delegation_status_values(self):
        assert DelegationStatus.PENDING.value == "pending"
        assert DelegationStatus.RUNNING.value == "running"
        assert DelegationStatus.COMPLETED.value == "completed"
        assert DelegationStatus.FAILED.value == "failed"

    def test_async_result_creation(self):
        spec = DelegationSpec(agent="test_agent", task="测试")
        result = AsyncDelegationResult(
            id="deleg_1",
            spec=spec,
            status=DelegationStatus.COMPLETED,
            result="执行成功",
        )
        assert result.status == DelegationStatus.COMPLETED
        assert result.result == "执行成功"

    @pytest.mark.asyncio
    async def test_pause_resume(self):
        await AsyncDelegator.resume_spawn()
        assert AsyncDelegator.is_spawn_paused() is False
        await AsyncDelegator.pause_spawn()
        assert AsyncDelegator.is_spawn_paused() is True
        await AsyncDelegator.resume_spawn()
        assert AsyncDelegator.is_spawn_paused() is False


class TestDelegateTaskExecutor:
    @pytest.mark.asyncio
    async def test_empty_description(self):
        result = await delegate_task_executor({"task_description": ""})
        assert result.success is False
        assert "不能为空" in result.error

    @pytest.mark.asyncio
    async def test_with_description(self):
        result = await delegate_task_executor({
            "task_description": "搜索文档",
            "context": "用户需要找到API文档",
            "timeout": 30,
        })
        assert isinstance(result.success, bool)


def _make_llm():
    llm = AsyncMock()
    llm.chat.return_value = {"content": "任务执行完成"}
    return llm
