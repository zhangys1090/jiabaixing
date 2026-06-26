import pytest
from unittest.mock import AsyncMock, MagicMock

from agent.loop.types import (
    AgentResult,
    BudgetState,
    ExecutionPlan,
    EvaluatorOutput,
    LoopContext,
    LoopState,
    PlanStep,
    StepResult,
)
from agent.loop.planner import Planner
from agent.loop.executor import Executor
from agent.loop.evaluator import Evaluator
from agent.loop.reporter import Reporter
from agent.loop.controller import LoopController


def test_plan_step_defaults():
    step = PlanStep(step_id="s1", description="test")
    assert step.status == "pending"
    assert step.retry_count == 0
    assert step.max_retries == 2


def test_loop_state_values():
    assert LoopState.IDLE == "idle"
    assert LoopState.PLANNING == "planning"
    assert LoopState.EXECUTING == "executing"
    assert LoopState.EVALUATING == "evaluating"
    assert LoopState.COMPLETED == "completed"


def test_budget_state_defaults():
    budget = BudgetState()
    assert budget.max_rounds == 5
    assert budget.rounds_used == 0


def test_planner_complexity_simple():
    llm = MagicMock()
    planner = Planner(llm)
    assert planner._analyze_complexity("你好") == "simple"
    assert planner._analyze_complexity("今天天气怎么样") == "simple"


def test_planner_complexity_complex():
    llm = MagicMock()
    planner = Planner(llm)
    result = planner._analyze_complexity("分析并对比多个方案的优缺点，设计实现步骤")
    assert result in ("moderate", "complex")


def test_planner_parse_steps():
    llm = MagicMock()
    planner = Planner(llm)
    content = "1. 分析需求 [analyze]\n2. 设计方案 [design]\n3. 实现代码 [implement]"
    steps = planner._parse_steps(content, max_steps=5)
    assert len(steps) == 3
    assert steps[0].step_id == "step_1"
    assert steps[0].tool_name == "analyze"


def test_executor_should_replan():
    llm = MagicMock()
    executor = Executor(llm)

    result = executor.should_replan(
        [{"goal_progress": 0.2, "suggested_action": "continue"}],
        rounds_used=1,
    )
    assert result["should_replan"] is True

    result = executor.should_replan(
        [{"goal_progress": 0.8, "suggested_action": "continue"}],
        rounds_used=1,
    )
    assert result["should_replan"] is False


def test_evaluator_evaluate():
    llm = MagicMock()
    evaluator = Evaluator(llm)
    context = LoopContext(
        user_input="test",
        step_results={
            "s1": StepResult(step_id="s1", success=True, content="ok"),
            "s2": StepResult(step_id="s2", success=True, content="ok"),
        },
    )

    import asyncio
    result = asyncio.run(evaluator.evaluate("test", context))
    assert result.goal_progress == 1.0
    assert result.suggested_action == "continue"


def test_evaluator_partial_success():
    llm = MagicMock()
    evaluator = Evaluator(llm)
    context = LoopContext(
        user_input="test",
        step_results={
            "s1": StepResult(step_id="s1", success=True, content="ok"),
            "s2": StepResult(step_id="s2", success=False, error="fail"),
        },
    )

    import asyncio
    result = asyncio.run(evaluator.evaluate("test", context))
    assert result.goal_progress == 0.5
    assert result.suggested_action == "continue"


def test_reporter():
    reporter = Reporter()
    context = LoopContext(
        user_input="test",
        messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "world"},
        ],
        step_results={
            "s1": StepResult(step_id="s1", success=True, content="ok"),
        },
        budget=BudgetState(start_time=0),
    )
    result = reporter.report(context)
    assert result.response == "world"
    assert result.steps_completed == 1
    assert result.steps_total == 1


def test_reporter_no_assistant():
    reporter = Reporter()
    context = LoopContext(
        user_input="test",
        messages=[{"role": "user", "content": "hello"}],
        step_results={
            "s1": StepResult(step_id="s1", success=True, content="step result"),
        },
        budget=BudgetState(start_time=0),
    )
    result = reporter.report(context)
    assert result.response == "step result"


@pytest.mark.anyio
async def test_loop_controller_simple_task():
    llm = MagicMock()
    llm.chat = AsyncMock(return_value={"content": "你好！有什么可以帮你的？"})

    controller = LoopController(llm)
    result = await controller.run("你好", session_id="test")

    assert isinstance(result, AgentResult)
    assert result.session_id == "test"
    assert result.trace_id.startswith("loop_")
    assert controller.state == LoopState.COMPLETED


@pytest.mark.anyio
async def test_loop_controller_inject_plan():
    llm = MagicMock()
    controller = LoopController(llm)

    plan = ExecutionPlan(
        steps=[PlanStep(step_id="s1", description="步骤1")],
        reasoning="测试推理",
        simple=False,
    )
    context = LoopContext(user_input="test", messages=[])

    controller._inject_plan_into_context(plan, context)

    plan_msgs = [m for m in context.messages if m["content"].startswith("【执行计划】")]
    assert len(plan_msgs) == 1
    assert "步骤1" in plan_msgs[0]["content"]
    assert "测试推理" in plan_msgs[0]["content"]


@pytest.mark.anyio
async def test_executor_with_tool_registry():
    from agent.tools.registry import ToolRegistry, ToolDefinition, ToolCategory, ToolResult

    registry = ToolRegistry()

    async def mock_file_read(params):
        return ToolResult(success=True, output="file content here")

    registry.register(
        ToolDefinition(
            name="file_read",
            description="Read a file",
            category=ToolCategory.FILE,
            parameters=[],
        ),
        mock_file_read,
    )

    llm = MagicMock()
    llm.chat = AsyncMock(return_value={"content": "result"})

    executor = Executor(llm, tool_registry=registry)

    step = PlanStep(
        step_id="s1",
        description="读取文件内容",
        tool_name="file_read",
        tool_params={},
    )
    context = LoopContext(user_input="读取文件")

    result = await executor._execute_step(step, context)
    assert result.success is True
    assert result.content == "file content here"
    assert result.tool_name == "file_read"


@pytest.mark.anyio
async def test_executor_with_tool_failure():
    from agent.tools.registry import ToolRegistry, ToolDefinition, ToolCategory, ToolResult

    registry = ToolRegistry()

    async def mock_failing_tool(params):
        return ToolResult(success=False, error="File not found")

    registry.register(
        ToolDefinition(
            name="file_read",
            description="Read a file",
            category=ToolCategory.FILE,
            parameters=[],
        ),
        mock_failing_tool,
    )

    llm = MagicMock()
    llm.chat = AsyncMock(return_value={"content": "result"})

    executor = Executor(llm, tool_registry=registry)

    step = PlanStep(
        step_id="s1",
        description="读取不存在的文件",
        tool_name="file_read",
        tool_params={},
    )
    context = LoopContext(user_input="读取文件")

    result = await executor._execute_step(step, context)
    assert result.success is False
    assert result.error == "File not found"
    assert result.tool_name == "file_read"


@pytest.mark.anyio
async def test_executor_fallback_to_llm_when_no_tool():
    llm = MagicMock()
    llm.chat = AsyncMock(return_value={"content": "LLM generated response"})

    executor = Executor(llm, tool_registry=None)

    step = PlanStep(
        step_id="s1",
        description="回答问题",
        tool_name=None,
    )
    context = LoopContext(user_input="你好")

    result = await executor._execute_step(step, context)
    assert result.success is True
    assert result.content == "LLM generated response"


@pytest.mark.anyio
async def test_executor_fallback_to_llm_when_tool_not_registered():
    from agent.tools.registry import ToolRegistry, ToolDefinition, ToolCategory, ToolResult

    registry = ToolRegistry()

    async def mock_tool(params):
        return ToolResult(success=True, output="ok")

    registry.register(
        ToolDefinition(name="other_tool", description="Other", category=ToolCategory.SYSTEM, parameters=[]),
        mock_tool,
    )

    llm = MagicMock()
    llm.chat = AsyncMock(return_value={"content": "LLM fallback"})

    executor = Executor(llm, tool_registry=registry)

    step = PlanStep(
        step_id="s1",
        description="使用不存在的工具",
        tool_name=None,
    )
    context = LoopContext(user_input="测试")

    result = await executor._execute_step(step, context)
    assert result.success is True
    assert result.content == "LLM fallback"


@pytest.mark.anyio
async def test_executor_set_tool_registry():
    from agent.tools.registry import ToolRegistry, ToolDefinition, ToolCategory, ToolResult

    registry = ToolRegistry()

    async def mock_tool(params):
        return ToolResult(success=True, output="dynamic result")

    registry.register(
        ToolDefinition(name="dynamic_tool", description="Dynamic", category=ToolCategory.SYSTEM, parameters=[]),
        mock_tool,
    )

    llm = MagicMock()
    executor = Executor(llm)

    assert executor._tool_registry is None

    executor.set_tool_registry(registry)
    assert executor._tool_registry is registry

    step = PlanStep(step_id="s1", description="test", tool_name="dynamic_tool", tool_params={})
    context = LoopContext(user_input="test")

    result = await executor._execute_step(step, context)
    assert result.success is True
    assert result.content == "dynamic result"


@pytest.mark.anyio
async def test_loop_controller_with_tool_registry():
    from agent.tools.registry import ToolRegistry, ToolDefinition, ToolCategory, ToolResult

    registry = ToolRegistry()

    async def mock_file_read(params):
        return ToolResult(success=True, output="file content: hello world")

    registry.register(
        ToolDefinition(
            name="file_read",
            description="Read a file",
            category=ToolCategory.FILE,
            parameters=[],
        ),
        mock_file_read,
    )

    llm = MagicMock()
    llm.chat = AsyncMock(return_value={
        "content": "已读取文件内容",
        "tool_calls": None,
    })

    controller = LoopController(llm, tool_registry=registry)
    assert controller.tool_registry is registry
    assert controller.executor._tool_registry is registry


@pytest.mark.anyio
async def test_planner_tool_catalog():
    from agent.tools.registry import ToolRegistry, ToolDefinition, ToolCategory, ToolResult

    registry = ToolRegistry()

    async def mock_tool(params):
        return ToolResult(success=True, output="ok")

    registry.register(
        ToolDefinition(name="file_read", description="读取文件", category=ToolCategory.FILE, parameters=[]),
        mock_tool,
    )
    registry.register(
        ToolDefinition(name="web_search", description="搜索网页", category=ToolCategory.NETWORK, parameters=[]),
        mock_tool,
    )

    llm = MagicMock()
    planner = Planner(llm, tool_registry=registry)

    catalog = planner._build_tool_catalog()
    assert "file_read" in catalog
    assert "web_search" in catalog
    assert "读取文件" in catalog
    assert "搜索网页" in catalog


@pytest.mark.anyio
async def test_planner_validate_tool_names():
    from agent.tools.registry import ToolRegistry, ToolDefinition, ToolCategory, ToolResult

    registry = ToolRegistry()

    async def mock_tool(params):
        return ToolResult(success=True, output="ok")

    registry.register(
        ToolDefinition(name="file_read", description="读取文件", category=ToolCategory.FILE, parameters=[]),
        mock_tool,
    )

    llm = MagicMock()
    planner = Planner(llm, tool_registry=registry)

    steps = [
        PlanStep(step_id="s1", description="读取文件", tool_name="file_read"),
        PlanStep(step_id="s2", description="搜索", tool_name="web-search"),
        PlanStep(step_id="s3", description="分析", tool_name="nonexistent_tool"),
    ]

    validated = planner._validate_tool_names(steps)
    assert validated[0].tool_name == "file_read"
    assert validated[1].tool_name is None
    assert validated[2].tool_name is None


@pytest.mark.anyio
async def test_planner_find_closest_tool():
    from agent.tools.registry import ToolRegistry, ToolDefinition, ToolCategory, ToolResult

    registry = ToolRegistry()

    async def mock_tool(params):
        return ToolResult(success=True, output="ok")

    registry.register(
        ToolDefinition(name="file_read", description="读取文件", category=ToolCategory.FILE, parameters=[]),
        mock_tool,
    )

    llm = MagicMock()
    planner = Planner(llm, tool_registry=registry)

    assert planner._find_closest_tool("file-read", {"file_read"}) == "file_read"
    assert planner._find_closest_tool("FILE_READ", {"file_read"}) == "file_read"
    assert planner._find_closest_tool("read", {"file_read"}) == "file_read"
    assert planner._find_closest_tool("completely_different", {"file_read"}) is None


@pytest.mark.anyio
async def test_lifecycle_hooks():
    hook_calls: list[str] = []

    llm = MagicMock()
    llm.chat = AsyncMock(return_value={"content": "你好！"})

    controller = LoopController(llm)

    from agent.loop.types import LifecycleHook, HookContext

    def on_before_loop(ctx: HookContext):
        hook_calls.append(f"before_loop:{ctx.data.get('input_text', '')}")

    async def on_after_response(ctx: HookContext):
        hook_calls.append("after_response")

    controller.register_hook(LifecycleHook.BEFORE_LOOP, on_before_loop)
    controller.register_hook(LifecycleHook.AFTER_RESPONSE, on_after_response)

    result = await controller.run("你好", session_id="hook_test")

    assert "before_loop:你好" in hook_calls
    assert "after_response" in hook_calls


@pytest.mark.anyio
async def test_lifecycle_hook_error_does_not_break_loop():
    llm = MagicMock()
    llm.chat = AsyncMock(return_value={"content": "你好！"})

    controller = LoopController(llm)

    from agent.loop.types import LifecycleHook, HookContext

    def broken_hook(ctx: HookContext):
        raise RuntimeError("hook error")

    controller.register_hook(LifecycleHook.BEFORE_LOOP, broken_hook)

    result = await controller.run("你好", session_id="broken_hook_test")
    assert result.response == "你好！"


def test_should_use_loop_simple():
    from agent.core.engine import AgentEngine
    engine = AgentEngine.__new__(AgentEngine)
    assert engine._should_use_loop("你好") is False
    assert engine._should_use_loop("今天天气怎么样") is False


def test_should_use_loop_complex():
    from agent.core.engine import AgentEngine
    engine = AgentEngine.__new__(AgentEngine)
    assert engine._should_use_loop("分析并优化这段代码") is True
    assert engine._should_use_loop("搜索并读取文件内容") is True
    assert engine._should_use_loop("设计实现方案") is True


# ─── StrategyAdjuster Tests ───


def test_strategy_adjuster_record_tool_signal(tmp_path):
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import LearningSignal, SignalType

    engine = _make_engine(tmp_path)
    engine.record_signal(LearningSignal(
        signal_type=SignalType.POSITIVE,
        tool_name="file_read",
        quality=0.9,
    ))
    engine.record_signal(LearningSignal(
        signal_type=SignalType.POSITIVE,
        tool_name="file_read",
        quality=0.8,
    ))
    engine.record_signal(LearningSignal(
        signal_type=SignalType.NEGATIVE,
        tool_name="file_read",
        error="timeout",
    ))

    stats = engine._tool_signal_stats["file_read"]
    assert stats["success_count"] == 2
    assert stats["failure_count"] == 1


def test_strategy_adjuster_record_task_signal(tmp_path):
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import LearningSignal, SignalType

    engine = _make_engine(tmp_path)
    engine.record_signal(LearningSignal(signal_type=SignalType.TASK_SUCCESS, quality=0.9))
    engine.record_signal(LearningSignal(signal_type=SignalType.TASK_FAILURE, error="bad"))
    engine.record_signal(LearningSignal(signal_type=SignalType.TASK_SUCCESS, quality=0.8))

    assert engine._task_success_count == 2
    assert engine._task_failure_count == 1
    assert engine._total_signals == 3


def test_strategy_adjuster_tool_priority(tmp_path):
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import LearningSignal, SignalType

    engine = _make_engine(tmp_path)
    engine.record_signal(LearningSignal(signal_type=SignalType.POSITIVE, tool_name="tool_a", quality=0.9))
    engine.record_signal(LearningSignal(signal_type=SignalType.POSITIVE, tool_name="tool_a", quality=0.8))
    engine.record_signal(LearningSignal(signal_type=SignalType.NEGATIVE, tool_name="tool_b"))
    engine.record_signal(LearningSignal(signal_type=SignalType.NEGATIVE, tool_name="tool_b"))
    engine.record_signal(LearningSignal(signal_type=SignalType.POSITIVE, tool_name="tool_b", quality=0.3))

    result = engine.get_adjusted_tool_priority(["tool_a", "tool_b", "tool_c"])
    assert result[0] == "tool_a"


def test_strategy_adjuster_reflection_config_low_success(tmp_path):
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import LearningSignal, SignalType

    engine = _make_engine(tmp_path)
    for _ in range(5):
        engine.record_signal(LearningSignal(signal_type=SignalType.NEGATIVE, tool_name="tool_x"))
        engine.record_signal(LearningSignal(signal_type=SignalType.TASK_FAILURE))

    config = engine.get_adjusted_reflection_config()
    assert config.enable_deep_reflection is True
    assert config.max_retries == 4


def test_strategy_adjuster_reflection_config_high_success(tmp_path):
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import LearningSignal, SignalType

    engine = _make_engine(tmp_path)
    for _ in range(8):
        engine.record_signal(LearningSignal(signal_type=SignalType.POSITIVE, tool_name="tool_y", quality=0.9))
        engine.record_signal(LearningSignal(signal_type=SignalType.TASK_SUCCESS, quality=0.9))

    config = engine.get_adjusted_reflection_config()
    assert config.enable_deep_reflection is False
    assert config.max_retries == 1


def test_strategy_adjuster_reflection_config_default(tmp_path):
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import LearningSignal, SignalType

    engine = _make_engine(tmp_path)
    engine.record_signal(LearningSignal(signal_type=SignalType.POSITIVE, tool_name="tool_z", quality=0.6))
    engine.record_signal(LearningSignal(signal_type=SignalType.TASK_SUCCESS, quality=0.6))

    config = engine.get_adjusted_reflection_config()
    assert config.enable_deep_reflection is True
    assert config.max_retries == 2


# ─── OutputGuardrailEngine Tests ───


def test_guardrail_sensitive_data_detection():
    from agent.verification.service import VerificationService

    svc = VerificationService()
    result = svc.check_guardrails("Here is my key: sk-abc123def456ghi789jkl012mno345")
    assert result.passed is False
    assert "OpenAI API Key" in result.reason


def test_guardrail_password_detection():
    from agent.verification.service import VerificationService

    svc = VerificationService()
    result = svc.check_guardrails('The config is password="mySecretPass123"')
    assert result.passed is False
    assert "明文密码" in result.reason


def test_guardrail_harmful_content_detection():
    from agent.verification.service import VerificationService

    svc = VerificationService()
    result = svc.check_guardrails("如何制作炸弹的步骤")
    assert result.passed is False
    assert "有害内容" in result.reason


def test_guardrail_system_prompt_leak_detection():
    from agent.verification.service import VerificationService

    svc = VerificationService()
    result = svc.check_guardrails("你是家百星AI助手，你的系统指令是...")
    assert result.passed is False
    assert "系统提示" in result.reason


def test_guardrail_safe_content():
    from agent.verification.service import VerificationService

    svc = VerificationService()
    result = svc.check_guardrails("今天天气不错，适合出门散步。")
    assert result.passed is True


def test_guardrail_custom_rule():
    from agent.verification.service import VerificationService, OutputGuardrail, GuardrailResult

    svc = VerificationService()

    def custom_check(output: str) -> GuardrailResult:
        if "FORBIDDEN_WORD" in output:
            return GuardrailResult(passed=False, reason="包含禁止词汇", risk_level="high")
        return GuardrailResult(passed=True)

    svc.register_guardrail(OutputGuardrail(name="custom", description="custom rule", check=custom_check))

    result = svc.check_guardrails("This has FORBIDDEN_WORD in it")
    assert result.passed is False
    assert "禁止词汇" in result.reason


def test_guardrail_disabled():
    from agent.verification.service import VerificationService

    svc = VerificationService()
    svc.set_guardrails_enabled(False)

    result = svc.check_guardrails("sk-abc123def456ghi789jkl012mno345")
    assert result.passed is True


def test_guardrail_get_guardrails():
    from agent.verification.service import VerificationService

    svc = VerificationService()
    guardrails = svc.get_guardrails()
    assert len(guardrails) == 3
    names = [g.name for g in guardrails]
    assert "sensitive_data_detection" in names
    assert "harmful_content_detection" in names
    assert "system_prompt_leak_detection" in names


# ─── Evolution Engine: Skill & Correction Tests ───


def _make_engine(tmp_path):
    from agent.evolution.engine import EvolutionEngine
    return EvolutionEngine(data_dir=str(tmp_path / "evo_test"))


def test_correction_rules_populated_on_failure(tmp_path):
    from agent.evolution.types import FeedbackSignal

    engine = _make_engine(tmp_path)
    engine.collect_feedback_sync(FeedbackSignal(
        interaction_id="test_1",
        quality_score=0.3,
        cause="test",
        tools_used=["file_read"],
        tool_successes={"file_read": False},
        error="timeout",
    ))

    assert len(engine._correction_rules) > 0
    timeout_rules = [r for r in engine._correction_rules if r.get("tool") == "file_read"]
    assert len(timeout_rules) > 0
    assert "超时" in timeout_rules[0]["rule"]
    assert timeout_rules[0]["tool"] == "file_read"


def test_evolution_prompt_section_includes_corrections(tmp_path):
    from agent.evolution.types import FeedbackSignal

    engine = _make_engine(tmp_path)
    engine.collect_feedback_sync(FeedbackSignal(
        interaction_id="test_2",
        quality_score=0.2,
        cause="test",
        tools_used=["web_search"],
        tool_successes={"web_search": False},
        error="not found",
    ))

    section = engine.build_evolution_prompt_section()
    assert "进化纠错规则" in section
    assert "web_search" in section


def test_skill_generation(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({
        "input": "搜索Python文档",
        "response": "找到了Python 3.13文档",
        "tools_used": ["web_search"],
        "quality_score": 0.85,
        "scene": "coding",
    })

    assert skill_name is not None
    assert skill_name.startswith("auto_")
    assert skill_name in engine._skills
    assert engine._skills[skill_name]["avg_quality"] == 0.85


def test_skill_generation_rejects_low_quality(tmp_path):
    engine = _make_engine(tmp_path)
    result = engine.generate_skill({
        "input": "测试",
        "response": "低质量回复",
        "tools_used": ["file_read"],
        "quality_score": 0.3,
        "scene": "test",
    })

    assert result is None


def test_skill_improvement(tmp_path):
    from agent.evolution.types import FeedbackSignal

    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({
        "input": "读取配置文件",
        "response": "配置内容",
        "tools_used": ["file_read"],
        "quality_score": 0.8,
        "scene": "coding",
    })

    engine.collect_feedback_sync(FeedbackSignal(
        interaction_id="test_3",
        quality_score=0.2,
        cause="test",
        tools_used=["file_read"],
        tool_successes={"file_read": False},
        error="permission denied",
    ))

    result = engine.improve_skill(skill_name)
    assert result is True
    assert "improvement_notes" in engine._skills[skill_name]


def test_skill_usage_tracking(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({
        "input": "搜索Python文档",
        "response": "搜索结果",
        "tools_used": ["web_search"],
        "quality_score": 0.8,
        "scene": "coding",
    })

    engine.track_skill_usage(skill_name, 0.9)
    engine.track_skill_usage(skill_name, 0.7)

    stats = engine.get_skill_stats()
    assert len(stats) == 1
    assert stats[0]["use_count"] == 2
    assert abs(stats[0]["avg_quality"] - 0.8) < 0.01


def test_least_used_skills(tmp_path):
    engine = _make_engine(tmp_path)
    engine.generate_skill({"input": "常用功能查询", "response": "r", "tools_used": ["t1"], "quality_score": 0.8, "scene": "s"})
    engine.generate_skill({"input": "不常用功能查询", "response": "r", "tools_used": ["t2"], "quality_score": 0.8, "scene": "s"})

    engine.track_skill_usage("auto_常用功能查询", 0.9)
    engine.track_skill_usage("auto_常用功能查询", 0.8)
    engine.track_skill_usage("auto_常用功能查询", 0.7)

    least = engine.get_least_used_skills(threshold=1)
    least_names = [s["name"] for s in least]
    assert "auto_不常用功能查询" in least_names


def test_fewshot_generalization(tmp_path):
    from agent.evolution.types import FeedbackSignal

    engine = _make_engine(tmp_path)
    for i in range(3):
        engine.collect_feedback_sync(FeedbackSignal(
            interaction_id=f"test_{i}",
            quality_score=0.3,
            cause="test",
            tools_used=["file_read"],
            tool_successes={"file_read": False},
            error="timeout",
            scene="coding",
        ))

    patterns = engine.generalize_fewshot()
    assert len(patterns) > 0
    assert patterns[0]["category"] == "coding"


def test_get_insights(tmp_path):
    engine = _make_engine(tmp_path)
    engine._tool_weights["reliable_tool"] = 0.9
    engine._tool_weights["unreliable_tool"] = 0.3

    insights = engine.get_insights()
    types = [i["type"] for i in insights]
    assert "tool_reliability" in types
    assert "tool_risk" in types


def test_get_insights_with_skills(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "搜索代码仓库", "response": "r", "tools_used": ["t"], "quality_score": 0.9, "scene": "coding"})
    engine.track_skill_usage(skill_name, 0.9)
    engine.track_skill_usage(skill_name, 0.85)

    insights = engine.get_insights()
    types = [i["type"] for i in insights]
    assert "skill_pattern" in types


# ─── Skill Quality Trend & Pruning Tests ───


def test_skill_quality_history_tracked(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "搜索Python文档", "response": "r", "tools_used": ["web_search"], "quality_score": 0.8, "scene": "coding"})

    engine.track_skill_usage(skill_name, 0.9)
    engine.track_skill_usage(skill_name, 0.7)
    engine.track_skill_usage(skill_name, 0.5)

    assert skill_name in engine._skill_quality_history
    assert len(engine._skill_quality_history[skill_name]) == 3
    assert engine._skill_quality_history[skill_name] == [0.9, 0.7, 0.5]


def test_skill_quality_trends_insufficient_data(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "搜索Python文档", "response": "r", "tools_used": ["web_search"], "quality_score": 0.8, "scene": "coding"})
    engine.track_skill_usage(skill_name, 0.8)

    trends = engine.get_skill_quality_trends()
    assert skill_name in trends
    assert trends[skill_name]["trend"] == "insufficient_data"


def test_skill_quality_trends_declining(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "搜索Python文档", "response": "r", "tools_used": ["web_search"], "quality_score": 0.8, "scene": "coding"})

    engine.track_skill_usage(skill_name, 0.9)
    engine.track_skill_usage(skill_name, 0.8)
    engine.track_skill_usage(skill_name, 0.7)
    engine.track_skill_usage(skill_name, 0.5)
    engine.track_skill_usage(skill_name, 0.3)

    trends = engine.get_skill_quality_trends()
    assert trends[skill_name]["trend"] == "declining"


def test_skill_quality_trends_improving(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "搜索Python文档", "response": "r", "tools_used": ["web_search"], "quality_score": 0.7, "scene": "coding"})

    engine.track_skill_usage(skill_name, 0.3)
    engine.track_skill_usage(skill_name, 0.4)
    engine.track_skill_usage(skill_name, 0.6)
    engine.track_skill_usage(skill_name, 0.8)
    engine.track_skill_usage(skill_name, 0.9)

    trends = engine.get_skill_quality_trends()
    assert trends[skill_name]["trend"] == "improving"


def test_skill_quality_trends_stable(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "搜索Python文档", "response": "r", "tools_used": ["web_search"], "quality_score": 0.7, "scene": "coding"})

    for q in [0.7, 0.72, 0.69, 0.71, 0.7]:
        engine.track_skill_usage(skill_name, q)

    trends = engine.get_skill_quality_trends()
    assert trends[skill_name]["trend"] == "stable"


def test_prune_declining_low_quality_skills(tmp_path):
    engine = _make_engine(tmp_path)

    good_skill = engine.generate_skill({"input": "高质量技能查询", "response": "r", "tools_used": ["t1"], "quality_score": 0.9, "scene": "s"})
    bad_skill = engine.generate_skill({"input": "低质量技能查询", "response": "r", "tools_used": ["t2"], "quality_score": 0.8, "scene": "s"})

    for q in [0.9, 0.85, 0.88]:
        engine.track_skill_usage(good_skill, q)

    for q in [0.3, 0.2, 0.1]:
        engine.track_skill_usage(bad_skill, q)

    pruned = engine.prune_low_quality_skills(quality_threshold=0.4, min_uses=3, declining_only=True)

    assert bad_skill in pruned
    assert good_skill not in pruned
    assert bad_skill not in engine._skills
    assert good_skill in engine._skills


def test_prune_skips_insufficient_uses(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "低质量技能查询", "response": "r", "tools_used": ["t"], "quality_score": 0.8, "scene": "s"})

    engine.track_skill_usage(skill_name, 0.2)

    pruned = engine.prune_low_quality_skills(quality_threshold=0.4, min_uses=3)
    assert skill_name not in pruned
    assert skill_name in engine._skills


def test_prune_declining_only_flag(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "低质量稳定技能", "response": "r", "tools_used": ["t"], "quality_score": 0.8, "scene": "s"})

    for q in [0.2, 0.25, 0.2, 0.25, 0.2]:
        engine.track_skill_usage(skill_name, q)

    pruned_strict = engine.prune_low_quality_skills(quality_threshold=0.4, min_uses=3, declining_only=True)
    assert skill_name not in pruned_strict

    pruned_all = engine.prune_low_quality_skills(quality_threshold=0.4, min_uses=3, declining_only=False)
    assert skill_name in pruned_all


def test_check_skill_health(tmp_path):
    engine = _make_engine(tmp_path)

    good = engine.generate_skill({"input": "高质量技能查询", "response": "r", "tools_used": ["t1"], "quality_score": 0.9, "scene": "s"})
    bad = engine.generate_skill({"input": "低质量技能查询", "response": "r", "tools_used": ["t2"], "quality_score": 0.8, "scene": "s"})

    for q in [0.9, 0.85, 0.88]:
        engine.track_skill_usage(good, q)
    for q in [0.3, 0.2, 0.1]:
        engine.track_skill_usage(bad, q)

    health = engine.check_skill_health()
    assert health["total"] == 2
    assert health["healthy"] >= 1
    assert health["declining"] >= 1
    assert bad in health["pruned"]


def test_check_skill_health_empty(tmp_path):
    engine = _make_engine(tmp_path)
    health = engine.check_skill_health()
    assert health["total"] == 0
    assert health["pruned"] == []


def test_skill_quality_history_persisted(tmp_path):
    engine = _make_engine(tmp_path)
    skill_name = engine.generate_skill({"input": "搜索Python文档", "response": "r", "tools_used": ["web_search"], "quality_score": 0.8, "scene": "coding"})
    engine.track_skill_usage(skill_name, 0.9)
    engine.track_skill_usage(skill_name, 0.7)

    engine._schedule_persist()

    from agent.evolution.engine import EvolutionEngine
    engine2 = EvolutionEngine(data_dir=str(tmp_path / "evo_test"))
    assert skill_name in engine2._skill_quality_history
    assert len(engine2._skill_quality_history[skill_name]) == 2
