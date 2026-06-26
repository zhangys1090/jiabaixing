from __future__ import annotations

import time

import pytest

from agent.orchestration.agent_factory import (
    AgentConfig,
    AgentFactory,
    AgentScene,
    BaseAgent,
    MultiAgentOrchestrator,
    TaskComplexity,
    TaskComplexityAnalyzer,
)


def _fresh_factory() -> AgentFactory:
    AgentFactory.reset_instance()
    return AgentFactory()


# ─── AgentScene ───


def test_agent_scene_values():
    assert AgentScene.CODING == "coding"
    assert AgentScene.FILE == "file"
    assert AgentScene.DESKTOP == "desktop"
    assert AgentScene.MEMORY == "memory"
    assert AgentScene.NETWORK == "network"


# ─── BaseAgent ───


@pytest.mark.anyio
async def test_base_agent_execute():
    agent = BaseAgent(AgentConfig(scene=AgentScene.CODING, name="test_agent"))
    result = await agent.execute("test task")
    assert result["status"] == "completed"
    assert result["agent"] == "test_agent"


@pytest.mark.anyio
async def test_base_agent_stats():
    agent = BaseAgent(AgentConfig(scene=AgentScene.CODING, name="stats_agent"))
    await agent.execute("task1")
    await agent.execute("task2")

    stats = agent.get_stats()
    assert stats["task_count"] == 2
    assert stats["success_count"] == 2
    assert stats["success_rate"] == 1.0


@pytest.mark.anyio
async def test_base_agent_failure():
    class FailingExecutor:
        async def execute(self, task: str, context=None):
            raise RuntimeError("execution failed")

    agent = BaseAgent(
        AgentConfig(scene=AgentScene.CODING, name="fail_agent"),
        executor=FailingExecutor(),
    )

    with pytest.raises(RuntimeError):
        await agent.execute("fail task")

    stats = agent.get_stats()
    assert stats["failure_count"] == 1
    assert stats["success_count"] == 0


# ─── AgentFactory ───


def test_create_agent():
    factory = _fresh_factory()
    agent = factory.create_agent(AgentScene.CODING, "code_agent")
    assert agent.name == "code_agent"
    assert agent.scene == AgentScene.CODING


def test_create_agent_cached():
    factory = _fresh_factory()
    agent1 = factory.create_agent(AgentScene.CODING, "cached")
    agent2 = factory.create_agent(AgentScene.CODING, "cached")
    assert agent1 is agent2


def test_create_all_agents():
    factory = _fresh_factory()
    agents = factory.create_all_agents()
    assert len(agents) == len(AgentScene)


def test_select_agent_by_goal_coding():
    factory = _fresh_factory()
    agent = factory.select_agent_by_goal("帮我写一个Python函数")
    assert agent.scene == AgentScene.CODING


def test_select_agent_by_goal_file():
    factory = _fresh_factory()
    agent = factory.select_agent_by_goal("搜索文件中的关键字")
    assert agent.scene == AgentScene.FILE


def test_select_agent_by_goal_desktop():
    factory = _fresh_factory()
    agent = factory.select_agent_by_goal("截取屏幕截图")
    assert agent.scene == AgentScene.DESKTOP


def test_select_agent_by_goal_memory():
    factory = _fresh_factory()
    agent = factory.select_agent_by_goal("记住我的偏好设置")
    assert agent.scene == AgentScene.MEMORY


def test_select_agent_by_goal_network():
    factory = _fresh_factory()
    agent = factory.select_agent_by_goal("发送网络请求爬虫抓取")
    assert agent.scene == AgentScene.NETWORK


def test_select_agent_by_goal_default():
    factory = _fresh_factory()
    agent = factory.select_agent_by_goal("hello world")
    assert agent.scene == AgentScene.CODING


def test_get_agent():
    factory = _fresh_factory()
    factory.create_agent(AgentScene.CODING, "my_agent")
    agent = factory.get_agent("coding_my_agent")
    assert agent is not None
    assert agent.name == "my_agent"


def test_get_agent_nonexistent():
    factory = _fresh_factory()
    assert factory.get_agent("nonexistent") is None


def test_clear():
    factory = _fresh_factory()
    factory.create_agent(AgentScene.CODING, "temp")
    factory.clear()
    assert len(factory.get_all_agents()) == 0


def test_register_executor():
    factory = _fresh_factory()

    class MockExecutor:
        async def execute(self, task: str, context=None):
            return {"mock": True}

    factory.register_executor(AgentScene.CODING, MockExecutor())
    agent = factory.create_agent(AgentScene.CODING, "exec_agent")
    assert agent._executor is not None


# ─── TaskComplexityAnalyzer ───


def test_complexity_simple():
    analyzer = TaskComplexityAnalyzer()
    result = analyzer.analyze("帮我写个函数")
    assert result.complexity == "simple"
    assert result.estimated_steps == 1
    assert result.parallelizable is False


def test_complexity_medium():
    analyzer = TaskComplexityAnalyzer()
    result = analyzer.analyze("创建一个新文件")
    assert result.complexity == "medium"
    assert result.estimated_steps == 2


def test_complexity_complex():
    analyzer = TaskComplexityAnalyzer()
    result = analyzer.analyze("重构整个模块")
    assert result.complexity == "complex"
    assert result.parallelizable is True


def test_complexity_very_complex():
    analyzer = TaskComplexityAnalyzer()
    result = analyzer.analyze("同时并行处理多个任务")
    assert result.complexity == "very_complex"
    assert result.estimated_steps == 5
    assert result.parallelizable is True


# ─── MultiAgentOrchestrator ───


@pytest.mark.anyio
async def test_process_simple_goal():
    factory = _fresh_factory()
    orchestrator = MultiAgentOrchestrator(factory)
    result = await orchestrator.process_goal("帮我写个函数")
    assert result.success is True
    assert result.total_tasks == 1
    assert result.completed_tasks == 1


@pytest.mark.anyio
async def test_process_complex_goal():
    factory = _fresh_factory()
    orchestrator = MultiAgentOrchestrator(factory)
    result = await orchestrator.process_goal("同时并行处理代码重构和文件搜索")
    assert result.total_tasks >= 1


@pytest.mark.anyio
async def test_process_goal_history():
    factory = _fresh_factory()
    orchestrator = MultiAgentOrchestrator(factory)
    await orchestrator.process_goal("任务1")
    await orchestrator.process_goal("任务2")

    history = orchestrator.get_history()
    assert len(history) == 2


@pytest.mark.anyio
async def test_process_goal_stats():
    factory = _fresh_factory()
    orchestrator = MultiAgentOrchestrator(factory)
    await orchestrator.process_goal("任务1")
    await orchestrator.process_goal("任务2")

    stats = orchestrator.get_stats()
    assert stats["total_goals"] == 2
    assert stats["success_rate"] == 1.0


@pytest.mark.anyio
async def test_process_goal_with_failing_agent():
    factory = _fresh_factory()

    class FailingExecutor:
        async def execute(self, task: str, context=None):
            raise RuntimeError("agent failed")

    factory.register_executor(AgentScene.CODING, FailingExecutor())
    orchestrator = MultiAgentOrchestrator(factory)
    result = await orchestrator.process_goal("帮我写代码")
    assert result.success is False
    assert result.failed_tasks == 1
