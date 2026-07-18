# -*- coding: utf-8 -*-
"""业务逻辑审计报告回归测试（对应 docs/BUSINESS_LOGIC_AUDIT.md §7）。

本文件逐一验证审计发现并已修复的 19 个确定性/可隔离缺陷。
每个测试方法名以审计编号（L-/M-/A-/T-/V-/E-/S-）开头，便于与审计报告对应。

运行方式（在 python/ 目录下）：
    python -m pytest tests/test_business_logic_audit_fixes.py -v
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


# ---------------------------------------------------------------------------
# L-01: EvalGate.check() 返回类型错误（原返回 EvalGate 自身而非 EvalGateResult）
# ---------------------------------------------------------------------------
def test_L01_eval_gate_check_returns_result_not_gate():
    from agent.evaluation.eval_gate import EvalGate, EvalGateResult

    gate = EvalGate()
    report = SimpleNamespace(
        summary=SimpleNamespace(
            pass_rate=1.0, average_score=0.95, total=10, passed=10
        )
    )
    result = gate.check(report)
    # 修复后必须返回 EvalGateResult 实例，且可正确访问 .passed
    assert isinstance(result, EvalGateResult)
    assert not isinstance(result, EvalGate)  # 旧 bug：返回了 EvalGate(...) 自身
    assert result.passed is True


# ---------------------------------------------------------------------------
# A-01: MCP 初始化握手缺少 "id" 字段，导致 JSON-RPC 请求被当作通知处理
# ---------------------------------------------------------------------------
def test_A01_mcp_initialize_includes_id():
    from agent.mcp.server_manager import MCPServerManager

    MCPServerManager.reset_instance()
    mgr = MCPServerManager()

    captured: dict[str, list[dict]] = {"calls": []}

    async def fake_send(name, message):
        captured["calls"].append(message)
        return {"jsonrpc": "2.0", "result": {"serverInfo": {}, "capabilities": {}}}

    mgr.send_message = fake_send
    mgr._processes["test"] = MagicMock(initialized=False, server_info=None, capabilities=None)

    ok = asyncio.run(mgr._initialize_server("test"))
    assert ok is True

    init_msgs = [m for m in captured["calls"] if m.get("method") == "initialize"]
    assert init_msgs, "initialize 请求未发送"
    init_msg = init_msgs[0]
    # 修复后 initialize 必须是带 id 的 JSON-RPC 请求（旧 bug 缺 id → 被当作通知）
    assert "id" in init_msg and init_msg["id"] == 1
    assert init_msg["jsonrpc"] == "2.0"


# ---------------------------------------------------------------------------
# M-01: MemoryStore.search() 空查询 / 通配符导致 FTS5 MATCH "" 崩溃
# ---------------------------------------------------------------------------
def test_M01_memory_search_empty_query_no_crash(tmp_path):
    from agent.memory.store import MemoryStore

    store = MemoryStore(db_path=tmp_path / "mem.db")
    # 旧 bug：fts_query 为空时执行 MATCH "" 触发 sqlite3.OperationalError
    assert store.search("") == []
    assert store.search("*") == []
    assert store.search("   ") == []


# ---------------------------------------------------------------------------
# T-07: ToolRegistry.execute() 在 TOOL_EXECUTE_TIMEOUT<=0 时 wait_for(timeout=0)
#       会立即抛 TimeoutError，导致所有工具调用“假超时”失败
# ---------------------------------------------------------------------------
def test_T07_registry_timeout_zero_runs_tool(tmp_path, monkeypatch):
    import asyncio as _asyncio

    from agent.tools.registry import ToolDefinition, ToolRegistry, ToolResult

    # 确保 agent.config 上存在该属性（生产环境必然存在）
    import agent.config as cfg

    monkeypatch.setattr(cfg, "TOOL_EXECUTE_TIMEOUT", 0)

    reg = ToolRegistry()

    async def slow_executor(params):
        await _asyncio.sleep(0.05)
        return ToolResult(success=True, output="ok")

    reg.register(ToolDefinition(name="slow", description="d"), slow_executor)
    result = _asyncio.run(reg.execute("slow", {}))
    assert result.success is True  # 旧 bug：timeout=0 立即失败，success=False


# ---------------------------------------------------------------------------
# L-12: LLMCache 缓存键缺失 system_prompt / temperature / tools 维度，
#       不同系统提示或带工具/不带工具的请求命中同一缓存键返回错误答案
# ---------------------------------------------------------------------------
def test_L12_cache_key_distinguishes_system_prompt_and_tools():
    from agent.llm.cache import LLMCache

    c = LLMCache()
    msgs = [{"role": "user", "content": "hi"}]

    c.set(msgs, "respA", model="m", system_prompt="sysA")
    # 不同 system_prompt 必须是缓存未命中
    assert c.get(msgs, model="m", system_prompt="sysB") is None
    # 相同 system_prompt 命中
    assert c.get(msgs, model="m", system_prompt="sysA") == "respA"

    # 不同 tools 必须是缓存未命中
    c.set(msgs, "respB", model="m", system_prompt="sysA", tools=[{"name": "t1"}])
    assert c.get(msgs, model="m", system_prompt="sysA", tools=[{"name": "t2"}]) is None
    assert c.get(msgs, model="m", system_prompt="sysA", tools=[{"name": "t1"}]) == "respB"


# ---------------------------------------------------------------------------
# M-07 / M-10: TrajectoryDatabase.record_execution 使用 uuid[:8] 截断 ID，
#        导致 ID 碰撞及级联删除风险（修复后使用完整 32 位 hex）
# ---------------------------------------------------------------------------
def test_M07_record_execution_full_uuid_no_collision(tmp_path):
    from agent.persistence.trajectory import ExecutionRecord, TrajectoryDatabase

    db = TrajectoryDatabase(db_path=tmp_path / "traj.db")
    r1 = ExecutionRecord(id="", input="a")
    r2 = ExecutionRecord(id="", input="b")
    db.record_execution(r1)
    db.record_execution(r2)

    # 修复后：exec_ + 32 位 hex = 37 字符（旧 bug 为 13 字符）
    assert r1.id.startswith("exec_")
    assert len(r1.id) == 5 + 32
    assert r1.id != r2.id

    count = db._conn.execute(
        "SELECT COUNT(*) FROM executions WHERE id IN (?,?)", (r1.id, r2.id)
    ).fetchone()[0]
    assert count == 2


# ---------------------------------------------------------------------------
# M-08: update_execution_status(response=None) 仍把响应列覆盖为 NULL，
#       清空历史响应（修复后 response=None 时只更新状态）
# ---------------------------------------------------------------------------
def test_M08_update_execution_status_none_response_keeps_response(tmp_path):
    from agent.persistence.trajectory import ExecutionRecord, TrajectoryDatabase

    db = TrajectoryDatabase(db_path=tmp_path / "traj2.db")
    rec = ExecutionRecord(
        id="exec_test", input="x", response="original response", status="running"
    )
    db.record_execution(rec)

    db.update_execution_status("exec_test", "completed", response=None)
    row = db._conn.execute(
        "SELECT response, status FROM executions WHERE id=?", ("exec_test",)
    ).fetchone()
    assert row[0] == "original response"  # 旧 bug：被覆盖为 NULL
    assert row[1] == "completed"


# ---------------------------------------------------------------------------
# V-01: 无 LLM 时 evaluate_goal_progress 误判为“已达成目标”
# ---------------------------------------------------------------------------
def test_V01_goal_progress_no_llm_not_achieved():
    from agent.verification.service import VerificationService, VerificationServiceDeps

    svc = VerificationService(deps=VerificationServiceDeps(llm=None))
    # 正常输出（不含任何错误指示词：抱歉/无法/失败/错误/error/failed），长度 >= 10
    prog = asyncio.run(
        svc.evaluate_goal_progress(
            "完成任务", "今日天气晴朗，项目推进顺利，已按计划达成预期目标。"
        )
    )
    assert prog.achieved is False  # 旧 bug：误判 achieved=True
    assert prog.progress == 0.0


# ---------------------------------------------------------------------------
# V-02: _llm_evaluate_goal 在 LLM 返回不含 JSON / 缺字段时误判为成功
# ---------------------------------------------------------------------------
def test_V02_llm_goal_eval_no_json_returns_not_achieved():
    from agent.verification.service import VerificationService, VerificationServiceDeps

    class FakeLLM:
        async def chat(self, prompt, system_prompt=None):
            return "抱歉，我无法回答这个问题，回复中不含任何 JSON 结构。"

    svc = VerificationService(deps=VerificationServiceDeps(llm=FakeLLM()))
    prog = asyncio.run(
        svc.evaluate_goal_progress(
            "任务", "另一段正常输出内容用于触发 LLM 评估路径的回归测试。"
        )
    )
    assert prog.achieved is False  # 解析失败时不得默认成功


def test_V02_llm_goal_eval_missing_fields_defaults():
    from agent.verification.service import VerificationService, VerificationServiceDeps

    class FakeLLM:
        async def chat(self, prompt, system_prompt=None):
            return '{"progress": 0.5}'  # 缺 achieved 字段

    svc = VerificationService(deps=VerificationServiceDeps(llm=FakeLLM()))
    prog = asyncio.run(
        svc.evaluate_goal_progress(
            "任务", "又一段正常输出内容用于验证缺字段默认值行为的回归测试。"
        )
    )
    assert prog.achieved is False  # 缺字段时默认未达成
    assert prog.progress == 0.5


# ---------------------------------------------------------------------------
# E-01: 进化回滚验证使用错误的差值（交互计数 − 时间戳）恒为负，
#        导致回滚判断永不触发（修复后基于快照时的交互计数差值）
# ---------------------------------------------------------------------------
def test_E01_rollback_uses_interaction_count_diff():
    from agent.evolution.orchestrator import EvolutionOrchestrator
    from agent.evolution.types import RollbackSnapshot

    orch = EvolutionOrchestrator()
    orch._interaction_count = 100
    # 回滚标记 rolled_back 仅在存在 evolution_engine 时设置（属正常降级逻辑）
    orch._evolution_engine = MagicMock()
    snap = RollbackSnapshot(
        cycle_id="c1", timestamp=time.time(), avg_quality=0.9,
        avg_response_time_ms=0.0, interaction_count=10,
    )
    orch._pending_rollbacks["c1"] = snap

    asyncio.run(orch._check_pending_rollbacks(0.5))  # 当前质量远低于基线
    assert snap.rolled_back is True
    assert "c1" not in orch._pending_rollbacks


def test_E01_rollback_gate_respects_verification_window():
    from agent.evolution.orchestrator import EvolutionOrchestrator
    from agent.evolution.types import RollbackSnapshot

    orch = EvolutionOrchestrator()
    orch._interaction_count = 12
    # 差值 2 < _VERIFICATION_INTERACTIONS(5) → 尚未到验证窗口
    snap = RollbackSnapshot(
        cycle_id="c2", timestamp=time.time(), avg_quality=0.9,
        avg_response_time_ms=0.0, interaction_count=10,
    )
    orch._pending_rollbacks["c2"] = snap

    asyncio.run(orch._check_pending_rollbacks(0.1))
    assert "c2" in orch._pending_rollbacks  # 不应被验证/回滚
    assert getattr(snap, "rolled_back", False) is False


# ---------------------------------------------------------------------------
# S-01: 调度器仅支持 every:Nx，hourly/daily/weekly/monthly/cron 表达式永不执行
# ---------------------------------------------------------------------------
def test_S01_parse_interval_supports_keywords_and_cron():
    from agent.scheduler.cron import _parse_interval

    assert _parse_interval("hourly") == 3600
    assert _parse_interval("daily") == 86400
    assert _parse_interval("weekly") == 86400 * 7
    assert _parse_interval("monthly") == 86400 * 30
    assert _parse_interval("every:30m") == 1800
    # cron: 下次零点应为正数秒
    delta = _parse_interval("cron:0 0 * * *")
    assert isinstance(delta, int) and delta > 0
    # 无法识别的规则返回 None（由 register 告警，而非静默永不执行）
    assert _parse_interval("bogus-schedule") is None


# ---------------------------------------------------------------------------
# S-02: 调度器崩溃恢复 —— 持久化为 running 的任务重启后被 _tick 永久跳过
# ---------------------------------------------------------------------------
def test_S02_cron_load_resets_running_to_idle(tmp_path):
    import time

    from agent.scheduler.cron import CronJob, CronJobScheduler

    data_dir = tmp_path / "cron"
    data_dir.mkdir()
    jobs_file = data_dir / "jobs.json"
    jobs = [
        {
            "id": "j1",
            "name": "t",
            "schedule": "every:1h",
            "command": "echo hi",
            "enabled": True,
            "status": "running",  # 模拟崩溃时持久化的状态
            "last_run": None,
            "next_run": time.time() - 10,
            "args": [],
        }
    ]
    jobs_file.write_text(json.dumps(jobs), encoding="utf-8")

    sched = CronJobScheduler(data_dir=data_dir)
    job = sched.get_job("j1")
    assert job is not None
    assert job.status == "idle"  # 修复后：running → idle 以便重新调度


# ---------------------------------------------------------------------------
# S-03: 调度器命令注入扫描仅覆盖 command，args 可注入任意命令
# ---------------------------------------------------------------------------
def test_S03_cron_run_job_blocks_injection_in_args(tmp_path):
    from agent.scheduler.cron import CronJob, CronJobScheduler

    sched = CronJobScheduler(data_dir=tmp_path / "cron3")
    job = CronJob(
        id="jx", name="x", schedule="every:1h", command="echo", args=["; rm -rf /"]
    )
    result = asyncio.run(sched._run_job(job))
    assert result.exit_code == -1
    assert "Injection blocked" in result.stderr


# ---------------------------------------------------------------------------
# L-02: executor._retry_with_backoff 使用伪造 context（无 budget/plan 等属性），
#        导致 _execute_step 内 AttributeError；且 result 未预置，max_retries==0 时未绑定
# ---------------------------------------------------------------------------
def test_L02_retry_with_backoff_uses_real_context():
    from agent.loop.executor import Executor
    from agent.loop.robustness import ErrorType
    from agent.loop.types import BudgetState, LoopContext, PlanStep, StepResult

    llm = MagicMock()
    rb = MagicMock()
    rb.config.retry_config.max_retries = 3
    exec = Executor(llm, robustness_manager=rb)

    context = LoopContext(budget=BudgetState())
    step = PlanStep(step_id="s1", description="d", retry_count=0, max_retries=3, tool_name="t")

    captured: dict[str, object] = {}

    async def fake_execute_step(s, c):
        # 旧 bug 传入的伪造 ctx 没有 budget/plan 属性，这里会抛 AttributeError
        assert hasattr(c, "budget") and hasattr(c, "plan")
        captured["ctx"] = c
        return StepResult(step_id=s.step_id, success=True)

    exec._execute_step = fake_execute_step
    result = asyncio.run(exec._retry_with_backoff(step, ErrorType.RETRYABLE, context))

    assert result.success is True
    assert captured["ctx"] is context  # 必须复用真实 context 对象
    assert step.retry_count == 1


# ---------------------------------------------------------------------------
# L-03: executor 反思路径反思结果未预置，回退分支直接访问 reflection.corrected_args
#        在 reflection 为 None 时触发 AttributeError（修复后预置 + 守卫）
# ---------------------------------------------------------------------------
def test_L03_retry_with_reflection_none_guard():
    from agent.loop.executor import Executor
    from agent.loop.reflection import ReflectionResult
    from agent.loop.robustness import ErrorType
    from agent.loop.types import BudgetState, LoopContext, PlanStep, StepResult

    llm = MagicMock()
    rb = MagicMock()
    rb.enabled = True
    rb.config.enable_reflection = True
    rb.config.max_reflection_retries = 1
    rb.config.enable_metrics = False
    rb.has_tool_alternatives.return_value = False
    rb.get_tool_alternatives.return_value = []

    exec = Executor(llm, robustness_manager=rb)
    refl = MagicMock()
    # should_retry=False → 通用反思路径直接 break，进入回退分支
    refl.reflect = AsyncMock(
        return_value=ReflectionResult(
            should_retry=False, corrected_args=None, alternative_tool=None, root_cause="x"
        )
    )
    exec._reflection = refl
    exec._get_dynamic_max_retries = lambda: 1  # 避免触碰真实进化编排器

    step = PlanStep(step_id="s1", description="d", retry_count=0, max_retries=2, tool_name="t")
    failed = StepResult(step_id="s1", success=False, error="boom")
    ctx = LoopContext(budget=BudgetState())
    exec._execute_step = AsyncMock(return_value=StepResult(step_id="s1", success=True))

    # 旧 bug：回退分支 `if reflection.corrected_args` 在 reflection 为 None 时抛 AttributeError
    result = asyncio.run(exec._retry_with_reflection(step, failed, ctx))
    assert result.success is False  # reflect 明确说不要重试


# ---------------------------------------------------------------------------
# L-09: reporter._score_error_recovery 用 getattr(r,"retry_count",0) 永远为 0，
#        导致“错误恢复”维度恒为 0 分（修复后从 PlanStep.retry_count 映射）
# ---------------------------------------------------------------------------
def test_L09_reporter_error_recovery_uses_plan_retry_count():
    from agent.loop.reporter import Reporter
    from agent.loop.types import (
        BudgetState,
        ExecutionPlan,
        LoopContext,
        PlanStep,
        StepResult,
    )

    step1 = PlanStep(step_id="s1", description="d1", retry_count=0, max_retries=2)
    step2 = PlanStep(step_id="s2", description="d2", retry_count=2, max_retries=3)  # 重试后成功
    plan = ExecutionPlan(steps=[step1, step2])
    ctx = LoopContext(plan=plan, budget=BudgetState())
    ctx.step_results = {
        "s1": StepResult(step_id="s1", success=False),  # 失败
        "s2": StepResult(step_id="s2", success=True),  # 重试后恢复
    }

    score = Reporter()._score_error_recovery(ctx)
    # 旧 bug：retried_and_succeeded 恒为 0 → score==0.0；修复后应 > 0.3
    assert score > 0.3


# ===========================================================================
# Wave 1 修复回归测试（T-01/T-03/T-08/E-02/E-03/E-04）
# ===========================================================================


def _make_conversation_loop(permission_guard=None, approval_manager=None, tool_registry=None):
    """构造一个仅用于 _execute_tool 单测的 ConversationLoop（llm 用哑对象）。"""
    from agent.core.conversation_loop import ConversationLoop

    return ConversationLoop(
        llm=MagicMock(),
        tool_registry=tool_registry,
        permission_guard=permission_guard,
        approval_manager=approval_manager,
    )


def _register_tool(registry, name, *, risk_level="low", permissions=None, output="ok", metadata=None):
    """在给定 registry 上注册一个返回固定结果的工具。"""
    from agent.tools.registry import ToolDefinition, ToolResult

    async def _executor(_params=None):
        return ToolResult(success=True, output=output, metadata=dict(metadata or {}))

    registry.register(
        ToolDefinition(
            name=name,
            description=f"test tool {name}",
            risk_level=risk_level,
            permissions=list(permissions or []),
        ),
        _executor,
    )


# ---------------------------------------------------------------------------
# T-01: 权限检查以错误签名 check(name, params) 调用 → TypeError 被 except:pass 吞掉，
#        且把返回对象当布尔（恒 truthy）→ 权限从不生效。修复后按正确签名调用并能硬拒。
# ---------------------------------------------------------------------------
def test_T01_permission_denied_actually_blocks_tool():
    from agent.core.turn_types import ToolCall
    from agent.tools.permission_guard import PermissionCheckResult
    from agent.tools.registry import ToolRegistry

    registry = ToolRegistry()
    _register_tool(registry, "danger_tool", risk_level="high", output="SHOULD_NOT_RUN")

    executed = {"ran": False}
    real_execute = registry.execute

    async def _spy_execute(name, params=None):
        executed["ran"] = True
        return await real_execute(name, params)

    registry.execute = _spy_execute

    # 守卫：拒绝且非"需确认"
    guard = MagicMock()
    guard.check = MagicMock(
        return_value=PermissionCheckResult(allowed=False, reason="缺少权限", needs_confirmation=False)
    )

    loop = _make_conversation_loop(permission_guard=guard, tool_registry=registry)
    tc = ToolCall(id="c1", name="danger_tool", arguments="{}")
    result = asyncio.run(loop._execute_tool(tc))

    # 守卫必须被以正确的 4 参数签名调用（tool_name, required, risk, ctx）
    assert guard.check.called
    args = guard.check.call_args.args
    assert args[0] == "danger_tool"
    assert args[2] == "high"  # risk 来自工具定义，而非硬编码
    # 硬拒后工具不得执行
    assert result.success is False
    assert result.error == "permission_denied"
    assert executed["ran"] is False


def test_T01_permission_check_typeerror_falls_back_and_denies_on_error():
    """旧式守卫抛非 TypeError 异常时应按拒绝处理，而非静默放行。"""
    from agent.core.turn_types import ToolCall
    from agent.tools.registry import ToolRegistry

    registry = ToolRegistry()
    _register_tool(registry, "t", risk_level="low")

    guard = MagicMock()
    guard.check = MagicMock(side_effect=RuntimeError("boom"))

    loop = _make_conversation_loop(permission_guard=guard, tool_registry=registry)
    result = asyncio.run(loop._execute_tool(ToolCall(id="c", name="t", arguments="{}")))
    assert result.success is False
    assert result.error == "permission_denied"


# ---------------------------------------------------------------------------
# T-03: 审批风险等级历史被硬编码为 low/medium（依 _auto_approve_low_risk 猜测），
#        而非取自工具定义。修复后 risk 取自 ToolDefinition，且 critical 永不自动放行。
# ---------------------------------------------------------------------------
def test_T03_approval_uses_tool_defined_risk_level():
    from agent.core.turn_types import ToolCall
    from agent.tools.registry import ToolRegistry

    registry = ToolRegistry()
    _register_tool(registry, "risky", risk_level="high", output="done")

    approval = MagicMock()

    async def _req(tool_name, params, risk_level):
        _req.captured_risk = risk_level
        return SimpleNamespace(approved=True, reason="")

    _req.captured_risk = None
    approval.request_approval = _req

    loop = _make_conversation_loop(approval_manager=approval, tool_registry=registry)
    asyncio.run(loop._execute_tool(ToolCall(id="c", name="risky", arguments="{}")))
    # 修复前恒为 low/medium；修复后应为工具声明的 high
    assert _req.captured_risk == "high"


def test_T03_critical_never_auto_approved():
    from agent.tools.approval_manager import ApprovalManager

    mgr = ApprovalManager(auto_approve_all=True, auto_approve_low_risk=True)
    # critical 即使开启 auto_approve_all 也不得立即放行 → 无监听器时超时拒绝
    mgr._REQUEST_TIMEOUT_MS = 50
    resp = asyncio.run(mgr.request_approval("rm_rf", {}, "critical"))
    assert resp.approved is False

    # 对照：非 critical 在 auto_approve_all 下应立即放行
    resp_ok = asyncio.run(mgr.request_approval("ls", {}, "high"))
    assert resp_ok.approved is True


# ---------------------------------------------------------------------------
# T-08: registry 写入的 metadata（truncated/original_chars/exit_code 等）在转换为
#        turn_types.ToolResult 时丢失。修复后新增 metadata 字段并透传。
# ---------------------------------------------------------------------------
def test_T08_tool_result_metadata_propagated():
    from agent.core.turn_types import ToolCall, ToolResult
    from agent.tools.registry import ToolRegistry

    # 数据类新增字段
    assert "metadata" in ToolResult.__dataclass_fields__

    registry = ToolRegistry()
    _register_tool(
        registry, "reader", output="content",
        metadata={"truncated": True, "original_chars": 12345, "exit_code": 0},
    )
    loop = _make_conversation_loop(tool_registry=registry)
    result = asyncio.run(loop._execute_tool(ToolCall(id="c", name="reader", arguments="{}")))
    assert result.metadata.get("truncated") is True
    assert result.metadata.get("original_chars") == 12345
    assert result.metadata.get("exit_code") == 0


# ---------------------------------------------------------------------------
# E-02: orchestrator 误调用不存在的 plan_evolution/execute（AttributeError 被吞），
#        V2 引擎从不执行。修复后调用真实公开 API trigger_evolution(V2EvolutionCause)。
# ---------------------------------------------------------------------------
def test_E02_v2_public_api_is_trigger_evolution():
    from agent.evolution.v2_engine import EvolutionEngineV2

    assert hasattr(EvolutionEngineV2, "trigger_evolution")
    # 历史误用的方法不应存在（防止回归到错误 API）
    assert not hasattr(EvolutionEngineV2, "plan_evolution")


def test_E02_orchestrator_triggers_v2_with_cause_object():
    from agent.evolution.orchestrator import EvolutionOrchestrator
    from agent.evolution.v2_engine import V2EvolutionCause, V2EvolutionResult

    orch = EvolutionOrchestrator()

    captured = {}

    async def _trigger(cause):
        captured["cause"] = cause
        return V2EvolutionResult(plan_id="p1", success=True, executed_actions=2, validation_passed=True)

    v2 = MagicMock()
    v2.trigger_evolution = _trigger
    orch._evolution_engine_v2 = v2
    orch._evolution_engine = None  # 仅测 V2 分支

    orch._detect_v2_evolution_cause = lambda: {
        "type": "LOW_QUALITY", "description": "test", "context": {"k": "v"}, "timestamp": 1.0,
    }

    asyncio.run(orch._trigger_optimization_cycle("test"))

    assert "cause" in captured, "trigger_evolution 未被调用"
    assert isinstance(captured["cause"], V2EvolutionCause)
    assert captured["cause"].type == "LOW_QUALITY"
    assert captured["cause"].context == {"k": "v"}


# ---------------------------------------------------------------------------
# E-03: SelfModificationEngine._execute_action 从不调用 assess_action_safety，
#        受保护路径可被 LLM 生成的计划改写/删除。修复后执行前强制安全评估。
# ---------------------------------------------------------------------------
def test_E03_safety_boundary_blocks_forbidden_delete(tmp_path):
    from agent.evolution.v2_engine import SelfModificationEngine, V2EvolutionAction

    engine = SelfModificationEngine()
    # 删除入口文件应被安全边界拦截
    action = V2EvolutionAction(type="DELETE_FILE", target="agent/main.py", description="del entry")
    ok = asyncio.run(engine._execute_action(action))
    assert ok is False


def test_E03_safety_boundary_blocks_forbidden_path(tmp_path):
    from agent.evolution.v2_engine import SelfModificationEngine, V2EvolutionAction

    engine = SelfModificationEngine()
    victim = tmp_path / "node_modules" / "x.py"
    victim.parent.mkdir(parents=True)
    victim.write_text("x = 1", encoding="utf-8")
    action = V2EvolutionAction(
        type="MODIFY_FILE", target=str(victim), content="y = 2", description="modify vendor"
    )
    ok = asyncio.run(engine._execute_action(action))
    assert ok is False
    # 文件内容未被改动
    assert victim.read_text(encoding="utf-8") == "x = 1"


# ---------------------------------------------------------------------------
# E-04: _validate_evolution 恒返回 passed=True（质量门失效）。修复后对改动的
#        .py 做 AST 语法检查、.json 做结构检查，坏改动会被判定失败。
# ---------------------------------------------------------------------------
def test_E04_validate_rejects_bad_python(tmp_path):
    from agent.evolution.v2_engine import (
        EvolutionEngineV2,
        V2EvolutionAction,
        V2EvolutionPlan,
    )

    bad = tmp_path / "broken.py"
    bad.write_text("def f(:\n    pass", encoding="utf-8")  # 语法错误
    plan = V2EvolutionPlan(
        id="p", actions=[V2EvolutionAction(type="MODIFY_FILE", target=str(bad), content="")]
    )
    engine = EvolutionEngineV2()
    res = asyncio.run(engine._validate_evolution(plan))
    assert res["passed"] is False
    assert "语法错误" in res["details"]


def test_E04_validate_passes_good_python_and_json(tmp_path):
    from agent.evolution.v2_engine import (
        EvolutionEngineV2,
        V2EvolutionAction,
        V2EvolutionPlan,
    )

    good_py = tmp_path / "ok.py"
    good_py.write_text("def f():\n    return 1\n", encoding="utf-8")
    good_json = tmp_path / "cfg.json"
    good_json.write_text('{"a": 1}', encoding="utf-8")
    plan = V2EvolutionPlan(
        id="p",
        actions=[
            V2EvolutionAction(type="MODIFY_FILE", target=str(good_py), content=""),
            V2EvolutionAction(type="UPDATE_CONFIG", target=str(good_json), content=""),
        ],
    )
    engine = EvolutionEngineV2()
    res = asyncio.run(engine._validate_evolution(plan))
    assert res["passed"] is True


def test_E04_validate_rejects_bad_json(tmp_path):
    from agent.evolution.v2_engine import (
        EvolutionEngineV2,
        V2EvolutionAction,
        V2EvolutionPlan,
    )

    bad_json = tmp_path / "cfg.json"
    bad_json.write_text('{"a": 1', encoding="utf-8")  # 缺右括号
    plan = V2EvolutionPlan(
        id="p", actions=[V2EvolutionAction(type="UPDATE_CONFIG", target=str(bad_json), content="")]
    )
    engine = EvolutionEngineV2()
    res = asyncio.run(engine._validate_evolution(plan))
    assert res["passed"] is False
    assert "JSON" in res["details"]


# ---------------------------------------------------------------------------
# C-01: 约束预算只"报告"不"强制"——check_budget 达硬上限仍返回 within_budget=True，
#        且无调用方据结果停止循环。修复后达硬上限返回 within_budget=False。
# ---------------------------------------------------------------------------
def test_C01_check_budget_hard_limit_blocks():
    from agent.constraints.service import BudgetState, ConstraintsService

    svc = ConstraintsService()
    # 轮次达硬上限
    res = svc.check_budget(BudgetState(rounds_used=10, hard_round_limit=8))
    assert res.within_budget is False
    assert res.hard_limit_exceeded is True
    # token 达硬上限
    res2 = svc.check_budget(BudgetState(tokens_used=99999, token_hard_limit=8000))
    assert res2.within_budget is False
    # 未达上限 → 仍在预算内
    res3 = svc.check_budget(BudgetState(rounds_used=2, tokens_used=100))
    assert res3.within_budget is True


# ---------------------------------------------------------------------------
# C-02: execute_hooks 吞异常 → HARD 约束失效。修复后钩子抛异常按 fail-safe 拒
#        绝继续（proceed=False），且任一钩子 proceed=False 整体即为 False。
# ---------------------------------------------------------------------------
def test_C02_execute_hooks_failsafe_on_exception():
    from agent.constraints.service import (
        ConstraintsService,
        HookContext,
        LifecycleEvent,
    )

    svc = ConstraintsService()

    async def bad_hook(ctx):
        raise ValueError("boom")

    svc.register_hook(LifecycleEvent.BEFORE_TOOL_CALL, bad_hook)
    result = asyncio.run(
        svc.execute_hooks(
            LifecycleEvent.BEFORE_TOOL_CALL,
            HookContext(event=LifecycleEvent.BEFORE_TOOL_CALL),
        )
    )
    # 修复前异常被 except:pass 吞掉 → proceed=True（约束失效）；修复后 fail-safe 拒绝
    assert result.proceed is False
    assert "ValueError" in (result.reason or "")


def test_C02_execute_hooks_respects_non_proceed():
    from agent.constraints.service import (
        ConstraintsService,
        HookContext,
        HookResult,
        LifecycleEvent,
    )

    svc = ConstraintsService()

    async def block(ctx):
        return HookResult(proceed=False, reason="policy")

    svc.register_hook(LifecycleEvent.BEFORE_TOOL_CALL, block)
    result = asyncio.run(
        svc.execute_hooks(
            LifecycleEvent.BEFORE_TOOL_CALL,
            HookContext(event=LifecycleEvent.BEFORE_TOOL_CALL),
        )
    )
    assert result.proceed is False


# ---------------------------------------------------------------------------
# E-05: 进化建议持久化用户偏好与"禁止存敏感信息"冲突。修复后：敏感（MEDIUM+）
#        阻止持久化；检测器异常 fail-safe 阻止；snippet 脱敏（邮箱/电话/身份证）。
# ---------------------------------------------------------------------------
def test_E05_nudge_blocks_sensitive_input():
    from agent.evolution.engine import EvolutionEngine
    from agent.security import sensitive_detector as sd
    from agent.security.sensitive_detector import RiskLevel

    orig = sd.check_sensitive_info

    class _Med:
        risk_level = RiskLevel.MEDIUM

    sd.check_sensitive_info = lambda text, scene: _Med()
    try:
        eng = EvolutionEngine()
        # 含敏感模式（身份证号）的偏好表达 → MEDIUM+ → 阻止持久化（返回 None）
        out = eng.nudge_knowledge_persistence("我喜欢用工号 110101199003071234 登录", [])
        assert out is None
    finally:
        sd.check_sensitive_info = orig


def test_E05_nudge_redacts_snippet_on_low_risk():
    from agent.evolution.engine import EvolutionEngine
    from agent.security import sensitive_detector as sd
    from agent.security.sensitive_detector import RiskLevel

    orig = sd.check_sensitive_info

    class _Low:
        risk_level = RiskLevel.LOW

    sd.check_sensitive_info = lambda text, scene: _Low()
    try:
        eng = EvolutionEngine()
        out = eng.nudge_knowledge_persistence(
            "我喜欢喝咖啡，联系我 foo@bar.com", []
        )
        assert out is not None
        # 修复后 snippet 脱敏：邮箱被替换为 [邮箱]
        assert "[邮箱]" in out
        assert "foo@bar.com" not in out
    finally:
        sd.check_sensitive_info = orig


# ---------------------------------------------------------------------------
# E-06: 反馈 cause 词汇与引擎不一致 → 工具失败进化不触发。修复后
#        record_tool_failure 写入 TOOL_FAILURE 信号，should_evolve 的
#        TOOL_FAILURE 过滤路径生效。
# ---------------------------------------------------------------------------
def test_E06_tool_failure_feedback_triggers_evolution():
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import EvolutionCause

    eng = EvolutionEngine()
    # should_evolve 需要 recent_quality_scores 非空，否则早返回 None
    eng._metrics.recent_quality_scores = [0.9, 0.9, 0.9]
    # 记录 3 次工具失败（达到 should_evolve 的 >=3 触发阈值）
    for i in range(3):
        asyncio.run(eng.record_tool_failure("flaky_tool", f"err{i}"))

    failures = [
        f for f in eng._feedback_history if f.cause == EvolutionCause.TOOL_FAILURE
    ]
    assert len(failures) >= 3
    plan = asyncio.run(eng.should_evolve())
    assert plan is not None
    assert plan.cause == EvolutionCause.TOOL_FAILURE


# ---------------------------------------------------------------------------
# T-06: 成本预算不拦截——chat() 预估成本但从不拦截。修复后 CostGuard.check_budget
#        超预算（日预算或单请求预算）返回 False，provider 据此拒绝。
# ---------------------------------------------------------------------------
def test_T06_cost_guard_blocks_over_budget():
    from agent.llm.credential_pool import CostGuard

    cg = CostGuard(daily_budget_usd=1.0, per_request_budget_usd=0.05)
    # 小额通过；超单请求预算（>0.05）拒绝
    assert cg.check_budget(0.001) is True
    assert cg.check_budget(1.0) is False
    # 累计超日预算后即便小额也拒绝
    cg.record_usage("gpt-4o", 2_000_000, 2_000_000)
    assert cg.check_budget(0.001) is False


# ---------------------------------------------------------------------------
# M-02: 写后不失效搜索缓存——store 写入新记忆后搜索缓存（TTL 5 分钟）不失效，
#        新记忆最长 5 分钟内不可见。修复后 store 立即清除搜索缓存。
# ---------------------------------------------------------------------------
def test_M02_store_invalidates_search_cache():
    from agent.memory.engine import MemoryEngine

    eng = MemoryEngine()
    fake_store = MagicMock()
    fake_store.store.return_value = "mem-1"
    fake_redis = MagicMock()
    eng._store = fake_store
    eng._redis_cache = fake_redis  # 非 None → 走缓存路径

    asyncio.run(eng.store("hello world", memory_type="short_term"))

    # 修复前：搜索缓存不失效 → 新记忆不可见；修复后必须清除搜索缓存
    assert fake_redis.delete_by_prefix.called
    # 单条记忆缓存也要写入
    assert fake_redis.set.called


# ---------------------------------------------------------------------------
# M-03: MemoryCurator 忘记/巩固是空操作 + 字段名错误。修复后 curate() 真正
#        调用 consolidate（update_memory_type）与 forget（delete），且用 memory_type。
# ---------------------------------------------------------------------------
def test_M03_curate_consolidates_high_importance():
    from agent.memory.curator import CuratorConfig, MemoryCurator

    fake_store = MagicMock()
    curator = MemoryCurator(
        config=CuratorConfig(consolidation_threshold=0.0, forget_threshold=0.0),
        memory=SimpleNamespace(_store=fake_store),
    )
    memories = [
        {"id": "m1", "memory_type": "episodic", "content": "x" * 60, "metadata": {}},
    ]
    result = curator.curate(memories, force=True)
    # 高重要度记忆应被真正合并（调用 store.update_memory_type）
    assert result["curated"] is True
    assert "m1" in result["consolidated_ids"]
    assert fake_store.update_memory_type.called
    assert not fake_store.delete.called  # 未达忘记阈值


def test_M03_curate_forgets_low_importance():
    from agent.memory.curator import CuratorConfig, MemoryCurator

    fake_store = MagicMock()
    curator = MemoryCurator(
        config=CuratorConfig(consolidation_threshold=1.0, forget_threshold=0.3),
        memory=SimpleNamespace(_store=fake_store),
    )
    memories = [
        {"id": "m2", "memory_type": "general", "content": "y", "metadata": {}},
    ]
    result = curator.curate(memories, force=True)
    # 低重要度记忆应被真正删除（调用 store.delete）
    assert "m2" in result["forgotten_ids"]
    assert fake_store.delete.called
    assert not fake_store.update_memory_type.called


# ---------------------------------------------------------------------------
# A-07: 禁用工具返回 500 → 修复后禁用工具被拦截（抛出 RuntimeError，由上层转 403）。
# ---------------------------------------------------------------------------
def test_A07_disabled_tool_blocked():
    from agent.mcp.server_manager import MCPServerManager

    MCPServerManager.reset_instance()
    mgr = MCPServerManager()
    mgr._servers["s1"] = SimpleNamespace(
        tool_filtering=True, denied_tools={"evil"}, allowed_tools=None
    )
    # 修复前禁用工具仍被调用并返回 500；修复后被拦截
    with pytest.raises(RuntimeError):
        asyncio.run(mgr.call_tool("s1", "evil", {}))


# ---------------------------------------------------------------------------
# L-13: 语义缓存误命中——短中文查询相似度计算误命中无关缓存。修复后中文查询
#        阈值提升至 0.85，完全不同的问题不应误命中。
# ---------------------------------------------------------------------------
def test_L13_semantic_cache_no_false_hit():
    from agent.llm.prompt_cache import PrefixCacheEntry, PromptCacheManager

    mgr = PromptCacheManager(enabled=True, similarity_threshold=0.7, min_word_count=1)
    entry = PrefixCacheEntry(
        key="pfx_abc",
        prefix_hash="h",
        user_input="今天天气怎么样",
        value="<cache>晴天</cache>",
        created_at=time.time(),
        ttl_ms=300_000,
    )
    # 完全不同的问题 → 不应误命中（修复前阈值过低会误命中）
    assert mgr._try_semantic_match([entry], "帮我写一首关于春天的诗") is None
    # 近似问题（高相似度）应命中——验证的是"匹配分支存在"而非误命中
    near = PrefixCacheEntry(
        key="pfx_def",
        prefix_hash="h",
        user_input="今天天气怎么样呀",
        value="<cache>晴天</cache>",
        created_at=time.time(),
        ttl_ms=300_000,
    )
    # 近似查询需要 store 中有 exact 条目才能返回；这里仅保证不误命中不同问题
    assert mgr._try_semantic_match([near], "明天股市会涨吗") is None
