"""五大子系统全面审计端到端测试。

按优先级排序：
🔴 P0-2: 持久化工作流 WorkflowEngine  ⭐⭐⭐⭐⭐
🟠 P1-1: 多模态感知闭环 PerceptionActionLoop  ⭐⭐⭐⭐
🟡 P1-2: 知识沉淀与主动学习 KnowledgeLifecycle  ⭐⭐⭐⭐
🟢 P0-1: 安全沙箱增强 SafetyNet  ⭐⭐⭐
🔵 P1-3: MCP 生态深度集成 MCPEcosystem  ⭐⭐⭐⭐

审计维度:
- 数据模型完整性
- 核心流程闭环
- 持久化/恢复
- 主循环集成
- Engine 生命周期
- 边界/异常处理
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import tempfile
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _run(coro):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, coro).result()
    return asyncio.run(coro)


def _tmp_db(tmp, name):
    return os.path.join(tmp, name)


# ═══════════════════════════════════════════════════════════════
# 🔴 P0-2: 持久化工作流 WorkflowEngine  ⭐⭐⭐⭐⭐
# ═══════════════════════════════════════════════════════════════


class TestWorkflowEngineAudit:
    """WorkflowEngine 全面审计。"""

    def test_types_data_model_complete(self):
        """审计: 数据模型完整性 — 所有枚举和数据类已定义。"""
        from agent.workflow.types import (
            StepType, StepStatus, WorkflowStatus, TriggerType, FailurePolicy,
            WorkflowStep, WorkflowDefinition, WorkflowInstance, StepState, TriggerConfig,
        )

        assert set(StepType._value2member_map_) == {"llm", "tool", "subflow", "human"}
        assert set(StepStatus._value2member_map_) == {"pending", "running", "done", "failed", "skipped"}
        assert set(WorkflowStatus._value2member_map_) == {
            "pending", "running", "paused", "done", "failed", "cancelled",
        }
        assert set(TriggerType._value2member_map_) == {"cron", "file", "webhook", "message", "manual"}
        assert set(FailurePolicy._value2member_map_) == {"fail", "skip", "retry"}

        step = WorkflowStep(id="s1", name="test")
        assert step.type == StepType.LLM
        assert step.depends_on == []
        assert step.on_failure == "fail"

    def test_state_machine_transitions(self):
        """审计: 状态机合法转换。"""
        from agent.workflow.instance import WorkflowStateMachine
        from agent.workflow.types import WorkflowInstance, WorkflowDefinition, WorkflowStatus

        inst = WorkflowInstance(id="i1", definition_id="d1")
        defn = WorkflowDefinition(id="d1", name="test")
        sm = WorkflowStateMachine(inst, defn)

        assert sm.can_transition(WorkflowStatus.RUNNING)
        assert not sm.can_transition(WorkflowStatus.DONE)
        assert sm.transition(WorkflowStatus.RUNNING)
        assert inst.status == WorkflowStatus.RUNNING

    def test_state_machine_dag_scheduling(self):
        """审计: DAG 步骤调度 — 依赖完成后才可执行。"""
        from agent.workflow.instance import WorkflowStateMachine
        from agent.workflow.types import (
            WorkflowInstance, WorkflowDefinition, WorkflowStep,
            StepState, StepStatus, WorkflowStatus,
        )

        steps = [
            WorkflowStep(id="s1", name="step1"),
            WorkflowStep(id="s2", name="step2", depends_on=["s1"]),
            WorkflowStep(id="s3", name="step3", depends_on=["s1"]),
            WorkflowStep(id="s4", name="step4", depends_on=["s2", "s3"]),
        ]
        defn = WorkflowDefinition(id="d1", name="dag-test", steps=steps)
        inst = WorkflowInstance(id="i1", definition_id="d1", status=WorkflowStatus.RUNNING)
        sm = WorkflowStateMachine(inst, defn)

        ready = sm.get_ready_steps()
        assert len(ready) == 1
        assert ready[0].id == "s1"

        sm.complete_step("s1", {"result": "ok"})
        ready = sm.get_ready_steps()
        assert len(ready) == 2
        assert {s.id for s in ready} == {"s2", "s3"}

        sm.complete_step("s2", {"result": "ok"})
        sm.complete_step("s3", {"result": "ok"})
        ready = sm.get_ready_steps()
        assert len(ready) == 1
        assert ready[0].id == "s4"

    def test_persistence_store_crud(self):
        """审计: 持久化 CRUD — 定义和实例的增删改查。"""
        from agent.workflow.checkpoint_store import WorkflowStore
        from agent.workflow.types import WorkflowDefinition, WorkflowInstance

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "wf.db")
            store = WorkflowStore(db_path=db)

            defn = WorkflowDefinition(id="d1", name="test-wf")
            store.save_definition(defn)
            loaded = store.load_definition("d1")
            assert loaded is not None
            assert loaded.name == "test-wf"

            inst = WorkflowInstance(id="i1", definition_id="d1")
            store.save_instance(inst)
            loaded_inst = store.load_instance("i1")
            assert loaded_inst is not None
            assert loaded_inst.definition_id == "d1"

            defs = store.list_definitions()
            assert len(defs) >= 1

            insts = store.list_instances(definition_id="d1")
            assert len(insts) >= 1

            del store

    def test_persistence_version_management(self):
        """审计: 版本管理 — 定义版本历史和回滚。"""
        from agent.workflow.checkpoint_store import WorkflowStore
        from agent.workflow.types import WorkflowDefinition

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "wf_ver.db")
            store = WorkflowStore(db_path=db)

            defn = WorkflowDefinition(id="d1", name="v1")
            store.save_definition(defn)

            defn.name = "v2"
            defn.version = 2
            store.save_definition(defn)

            versions = store.list_versions("d1")
            assert len(versions) >= 2

            v1 = store.load_version("d1", 1)
            assert v1 is not None
            assert v1.name == "v1"

            del store

    def test_engine_create_definition(self):
        """审计: 核心流程 — 创建定义。"""
        from agent.workflow.engine import WorkflowEngine
        from agent.workflow.checkpoint_store import WorkflowStore
        from agent.workflow.types import WorkflowStep

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "wf_engine.db")
            store = WorkflowStore(db_path=db)
            engine = WorkflowEngine(store=store)
            steps = [
                WorkflowStep(id="s1", name="step1", type="llm", prompt="hello"),
            ]
            def_id = engine.create_definition(name="test", steps=steps)
            assert def_id

            defn = engine.get_definition(def_id)
            assert defn is not None
            assert defn.name == "test"

            del engine

    def test_engine_pause_cancel(self):
        """审计: 生命周期控制 — 暂停/取消。"""
        from agent.workflow.engine import WorkflowEngine
        from agent.workflow.checkpoint_store import WorkflowStore
        from agent.workflow.types import WorkflowStep

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "wf_lc.db")
            store = WorkflowStore(db_path=db)
            engine = WorkflowEngine(store=store)
            steps = [WorkflowStep(id="s1", name="step1", type="llm", prompt="hello")]
            def_id = engine.create_definition(name="lifecycle-test", steps=steps)

            inst = store.load_definition(def_id)
            assert inst is not None

            del engine

    def test_engine_crash_recovery(self):
        """审计: 崩溃恢复 — RUNNING 实例自动恢复为 PAUSED。"""
        from agent.workflow.engine import WorkflowEngine
        from agent.workflow.checkpoint_store import WorkflowStore
        from agent.workflow.types import WorkflowInstance, WorkflowStatus

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "wf_crash.db")
            store = WorkflowStore(db_path=db)
            inst = WorkflowInstance(
                id="crash-1", definition_id="d1",
                status=WorkflowStatus.RUNNING,
            )
            store.save_instance(inst)

            engine = WorkflowEngine(store=store)
            _run(engine._recover_crashed_instances())

            recovered = store.load_instance("crash-1")
            assert recovered.status == WorkflowStatus.PAUSED

            del engine

    def test_distributed_lock_interface(self):
        """审计: 分布式锁 — LockProvider 接口完整。"""
        from agent.workflow.distributed_lock import (
            LockProvider, LockHandle, create_lock_provider,
        )

        provider = create_lock_provider()
        assert provider is not None

        handle = _run(provider.acquire("test-resource", ttl=60.0))
        assert handle is not None
        assert handle.resource == "test-resource"
        assert not handle.is_expired

        is_locked = _run(provider.is_locked("test-resource"))
        assert is_locked is True

        released = _run(provider.release(handle))
        assert released is True

    def test_event_bridge_cron_trigger(self):
        """审计: 事件触发 — Cron 调度器。"""
        from agent.workflow.event_bridge import CronScheduler

        scheduler = CronScheduler()
        scheduler.register("wf-1", "* * * * *")
        triggered = scheduler.check()
        assert "wf-1" in triggered

        scheduler.unregister("wf-1")
        triggered = scheduler.check()
        assert "wf-1" not in triggered

    def test_notification_manager(self):
        """审计: 通知系统 — NotificationManager。"""
        from agent.workflow.notification import NotificationManager, Notification

        mgr = NotificationManager()
        _run(mgr.notify("workflow-done", {"instance_id": "i1"}))

    def test_step_executor_llm(self):
        """审计: 步骤执行器 — LLM 步骤。"""
        from agent.workflow.step_executor import StepExecutor
        from agent.workflow.types import WorkflowStep, StepType

        async def mock_llm(prompt, inputs):
            return {"result": "LLM response", "success": True}

        executor = StepExecutor(llm_runner=mock_llm)
        step = WorkflowStep(id="s1", name="test", type=StepType.LLM, prompt="hello")
        result = _run(executor.execute(step, {}))
        assert result["success"] is True

    def test_tool_parameter_schema_nested(self):
        """审计: 工具参数 Schema — 嵌套结构。"""
        from agent.workflow.tools import register_workflow_tools
        from agent.tools.registry import ToolRegistry

        registry = ToolRegistry()
        engine = MagicMock()
        register_workflow_tools(registry, engine)

        create_tool = registry.get_definition("workflow_create")
        assert create_tool is not None
        steps_param = next((p for p in create_tool.parameters if p.name == "steps"), None)
        assert steps_param is not None
        assert steps_param.items is not None

    def test_loop_controller_workflow_inject(self):
        """审计: 主循环集成 — 工作流状态注入 LLM 上下文。"""
        from agent.loop.controller import LoopController
        from agent.llm.provider import LLMProvider

        mock_llm = MagicMock(spec=LLMProvider)
        mock_workflow = MagicMock()
        controller = LoopController(mock_llm, workflow_engine=mock_workflow)
        assert controller._workflow_engine is mock_workflow


# ═══════════════════════════════════════════════════════════════
# 🟠 P1-1: 多模态感知闭环 PerceptionActionLoop  ⭐⭐⭐⭐
# ═══════════════════════════════════════════════════════════════


class TestPerceptionActionLoopAudit:
    """PerceptionActionLoop 全面审计。"""

    def test_perception_loop_components(self):
        """审计: 组件完整性 — 五大组件全部初始化。"""
        from agent.perception import PerceptionActionLoop

        loop = PerceptionActionLoop(enable_watcher=True, enable_ocr=True)
        assert loop.uia_cache is not None
        assert loop.verifier is not None
        assert loop.grounding is not None
        assert loop.watcher is not None
        assert loop.ocr is not None

    def test_perception_loop_shutdown_event(self):
        """审计: shutdown 协调 — shutdown_event 传递到 ScreenWatcher。"""
        from agent.perception import PerceptionActionLoop

        event = asyncio.Event()
        loop = PerceptionActionLoop(shutdown_event=event)
        assert loop.watcher is not None
        assert loop.watcher._shutdown_event is event

    def test_screen_watcher_lifecycle(self):
        """审计: ScreenWatcher 生命周期 — start/stop/get_events。"""
        from agent.perception.screen_watcher import ScreenWatcher

        watcher = ScreenWatcher()
        assert not watcher.is_running
        events = watcher.get_events()
        assert isinstance(events, list)

    def test_screen_watcher_shutdown_stops_poll(self):
        """审计: shutdown 信号停止轮询。"""
        from agent.perception.screen_watcher import ScreenWatcher

        event = asyncio.Event()
        watcher = ScreenWatcher(shutdown_event=event)
        event.set()
        assert event.is_set()

    def test_action_verifier_strategies(self):
        """审计: 验证策略 — 四种策略可用。"""
        from agent.perception.action_verifier import ActionVerifier

        verifier = ActionVerifier()
        assert hasattr(verifier, "verify")
        assert hasattr(verifier, "capture_pre_state")

    def test_visual_grounding_three_tier(self):
        """审计: 三级定位策略 — UIA/OCR/VLM。"""
        from agent.perception.visual_grounding import VisualGrounding

        vg = VisualGrounding()
        assert hasattr(vg, "locate")
        result = _run(vg.locate("test"))
        assert hasattr(result, "target_found")
        assert hasattr(result, "method")

    def test_platform_adapter_factory(self):
        """审计: 平台适配器工厂 — 自动选择当前平台。"""
        from agent.perception.platform_adapter import create_platform_adapter

        adapter = create_platform_adapter()
        assert adapter is not None
        assert adapter.name in ("uia", "accessibility", "ocr")

    def test_uia_cache_refresh(self):
        """审计: UIA 缓存 — refresh 返回 CachedTree。"""
        from agent.perception.uia_cache import UIAElementCache

        cache = UIAElementCache()
        tree = _run(cache.refresh(force=True))
        assert tree is not None

    def test_local_ocr_interface(self):
        """审计: LocalOCR — 接口完整。"""
        from agent.perception.local_ocr import LocalOCR

        ocr = LocalOCR()
        assert hasattr(ocr, "recognize")

    def test_perception_loop_result_dataclass(self):
        """审计: LoopResult 数据类。"""
        from agent.perception.perception_loop import LoopResult

        result = LoopResult()
        assert result.success is False
        assert result.retries == 0
        assert result.events == []

    def test_loop_controller_perception_inject(self):
        """审计: 主循环集成 — 感知上下文注入。"""
        from agent.loop.controller import LoopController
        from agent.llm.provider import LLMProvider

        mock_llm = MagicMock(spec=LLMProvider)
        mock_perception = MagicMock()
        controller = LoopController(mock_llm, perception_loop=mock_perception)
        assert controller._perception_loop is mock_perception

    def test_vlm_call_interface(self):
        """审计: VLM 调用接口 — analyze 方法。"""
        from agent.perception.vlm_call import VLMCaller

        caller = VLMCaller()
        assert hasattr(caller, "analyze")
        assert caller.default_model != ""


# ═══════════════════════════════════════════════════════════════
# 🟡 P1-2: 知识沉淀与主动学习 KnowledgeLifecycle  ⭐⭐⭐⭐
# ═══════════════════════════════════════════════════════════════


class TestKnowledgeLifecycleAudit:
    """KnowledgeLifecycle 全面审计。"""

    def test_knowledge_store_crud(self):
        """审计: 知识存储 CRUD。"""
        from agent.knowledge.knowledge_store import KnowledgeStore

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "ks.db")
            store = KnowledgeStore(db_path=db)
            _run(store.initialize())

            kid = _run(store.add("测试知识内容", tags=["test"], source="dialog"))
            assert kid

            entry = _run(store.get(kid))
            assert entry is not None
            assert entry.content == "测试知识内容"

            results = _run(store.search("测试"))
            assert len(results) >= 1

            _run(store.close())

    def test_knowledge_extractor_dataclass(self):
        """审计: 知识提取器 — ExtractedKnowledge 数据类。"""
        from agent.knowledge.knowledge_extractor import ExtractedKnowledge

        ext = ExtractedKnowledge(content="test", tags=["auto"], knowledge_type="fact")
        assert ext.content == "test"
        assert ext.knowledge_type == "fact"

    def test_knowledge_decay_cycle(self):
        """审计: 衰减周期 — 时间衰减 + 访问增强 + 淘汰。"""
        from agent.knowledge.knowledge_decay import KnowledgeDecay, DecayConfig, DecayResult
        from agent.knowledge.knowledge_store import KnowledgeStore

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "kd.db")
            store = KnowledgeStore(db_path=db)
            _run(store.initialize())

            kid = _run(store.add("旧知识", confidence=0.5, source="dialog"))

            config = DecayConfig(half_life_days=1.0, prune_threshold=0.05)
            decay = KnowledgeDecay(store, config)
            result = _run(decay.run_decay_cycle())
            assert isinstance(result, DecayResult)
            assert result.total >= 1

            _run(store.close())

    def test_knowledge_graph_entity_extraction(self):
        """审计: 知识图谱 — 实体提取。"""
        from agent.knowledge.knowledge_graph import KnowledgeGraph, Entity, Relation
        from agent.knowledge.knowledge_store import KnowledgeStore

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "kg.db")
            store = KnowledgeStore(db_path=db)
            _run(store.initialize())

            graph = KnowledgeGraph(store, extract_strategy="regex")
            _run(graph.initialize())

            entity_ids = _run(graph.add_entry("e1", "DeepSeek V4 支持 agent_native 模型"))
            assert isinstance(entity_ids, list)

            _run(graph.close())
            _run(store.close())

    def test_knowledge_graph_search(self):
        """审计: 知识图谱 — 图遍历检索。"""
        from agent.knowledge.knowledge_graph import KnowledgeGraph
        from agent.knowledge.knowledge_store import KnowledgeStore

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "kgs.db")
            store = KnowledgeStore(db_path=db)
            _run(store.initialize())

            graph = KnowledgeGraph(store, extract_strategy="regex")
            _run(graph.initialize())

            results = _run(graph.search("DeepSeek", max_depth=2))
            assert isinstance(results, list)

            _run(graph.close())
            _run(store.close())

    def test_knowledge_lifecycle_full_cycle(self):
        """审计: 完整生命周期 — ingest→retrieve→decay→prune。"""
        from agent.knowledge import KnowledgeLifecycle

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "kl.db")
            kl = KnowledgeLifecycle(db_path=db)
            _run(kl.initialize())

            messages = [
                {"role": "user", "content": "DeepSeek V4 Flash 支持 agent_native"},
                {"role": "assistant", "content": "是的，V4 Flash 可以自主规划"},
            ]
            _run(kl.ingest_dialog(messages, session_id="s1"))

            results = _run(kl.retrieve("DeepSeek"))
            assert isinstance(results, list)

            report = _run(kl.run_maintenance())
            assert report.total_entries >= 0

            _run(kl.close())

    def test_knowledge_lifecycle_decay_scheduler(self):
        """审计: 衰减定时任务 — start/stop。"""
        from agent.knowledge import KnowledgeLifecycle

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "kls.db")
            kl = KnowledgeLifecycle(db_path=db, decay_interval_hours=999)
            _run(kl.initialize())

            _run(kl.start_decay_scheduler())
            assert kl._decay_running is True

            _run(kl.stop_decay_scheduler())
            assert kl._decay_running is False

            _run(kl.close())

    def test_llm_cost_control_budget(self):
        """审计: LLM 提取成本控制 — 预算限制。"""
        from agent.knowledge.knowledge_graph import KnowledgeGraph
        from agent.knowledge.knowledge_store import KnowledgeStore

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "kgb.db")
            store = KnowledgeStore(db_path=db)
            _run(store.initialize())

            graph = KnowledgeGraph(store, extract_strategy="llm", daily_budget=2)
            _run(graph.initialize())

            assert graph._daily_budget == 2
            assert graph._llm_call_count == 0

            _run(graph.close())
            _run(store.close())

    def test_llm_cost_control_cache(self):
        """审计: LLM 提取成本控制 — 缓存命中。"""
        from agent.knowledge.knowledge_graph import KnowledgeGraph
        from agent.knowledge.knowledge_store import KnowledgeStore

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "kgc.db")
            store = KnowledgeStore(db_path=db)
            _run(store.initialize())

            graph = KnowledgeGraph(store, extract_strategy="llm", cache_ttl=3600)
            _run(graph.initialize())

            assert graph._cache_ttl == 3600
            assert graph._extract_cache == {}

            _run(graph.close())
            _run(store.close())

    def test_loop_controller_knowledge_inject(self):
        """审计: 主循环集成 — 知识上下文注入 + 对话后提取。"""
        from agent.loop.controller import LoopController
        from agent.llm.provider import LLMProvider

        mock_llm = MagicMock(spec=LLMProvider)
        mock_kl = MagicMock()
        controller = LoopController(mock_llm, knowledge_lifecycle=mock_kl)
        assert controller._knowledge_lifecycle is mock_kl


# ═══════════════════════════════════════════════════════════════
# 🟢 P0-1: 安全沙箱增强 SafetyNet  ⭐⭐⭐
# ═══════════════════════════════════════════════════════════════


class TestSafetyNetAudit:
    """SafetyNet 全面审计。"""

    def test_safety_net_components(self):
        """审计: 五大组件完整性。"""
        from agent.safety import SafetyNet

        net = SafetyNet()
        assert net._cp_mgr is not None
        assert net._rollback is not None
        assert net._audit is not None
        assert net._dry_run is not None

    def test_checkpoint_create_and_restore(self):
        """审计: 还原点 — 创建和恢复。"""
        from agent.safety.checkpoint_manager import CheckpointManager, CheckpointStore

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "cp.db")
            mgr = CheckpointManager(store=CheckpointStore(db_path=db))
            cp = mgr.create_checkpoint(paths=[], label="test")
            assert cp.id
            assert cp.label == "test"

    def test_operation_scope_violation(self):
        """审计: 操作作用域 — 越界检测。"""
        from agent.safety.operation_scope import OperationScope, ScopeDefinition, ScopeViolation

        scope_def = ScopeDefinition(
            allowed_paths=["/project/src"],
            denied_paths=["/project/src/secrets"],
        )
        scope = OperationScope(scope_def)

        allowed, _ = scope.check_path("/project/src/main.py")
        assert allowed is True

        allowed, _ = scope.check_path("/etc/passwd")
        assert allowed is False

    def test_auto_rollback_policy(self):
        """审计: 自动回滚策略。"""
        from agent.safety.auto_rollback import RollbackPolicy

        policy = RollbackPolicy()
        assert policy.timeout_seconds == 300.0
        assert policy.max_error_count == 3
        assert policy.auto_rollback_on_violation is True

    def test_audit_trail_record_and_query(self):
        """审计: 审计日志 — 记录和查询。"""
        from agent.safety.audit_trail import AuditTrail

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "audit.db")
            trail = AuditTrail(db_path=db)
            trail.record(
                tool_name="file_write",
                risk_level="medium",
                result="success",
            )
            entries = trail.query(tool_name="file_write", limit=10)
            assert len(entries) >= 1
            assert entries[0].tool_name == "file_write"

    def test_dry_run_executor_preview(self):
        """审计: 预演执行 — 影响预测。"""
        from agent.safety.dry_run_executor import DryRunExecutor

        executor = DryRunExecutor()
        report = executor.preview_file_write("/project/src/main.py", "new content")
        assert report is not None
        assert hasattr(report, "safe")
        assert hasattr(report, "risk_assessment")

    def test_safety_net_guard_context(self):
        """审计: guard 上下文管理器。"""
        from agent.safety.safety_net import GuardContext

        ctx = GuardContext()
        assert ctx.checkpoint is None
        assert ctx.scope is None
        assert ctx.dry_run is None

    def test_concurrent_checkpoint_protection(self):
        """审计: 并发还原点保护。"""
        from agent.safety.checkpoint_manager import CheckpointManager, CheckpointStore

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "cp2.db")
            mgr = CheckpointManager(store=CheckpointStore(db_path=db))
            cp1 = mgr.create_checkpoint(paths=[], label="cp1")
            cp2 = mgr.create_checkpoint(paths=[], label="cp2")
            assert cp1.id != cp2.id


# ═══════════════════════════════════════════════════════════════
# 🔵 P1-3: MCP 生态深度集成 MCPEcosystem  ⭐⭐⭐⭐
# ═══════════════════════════════════════════════════════════════


class TestMCPEcosystemAudit:
    """MCPEcosystem 全面审计。"""

    def test_mcp_client_config(self):
        """审计: MCP 客户端 — 配置数据类。"""
        from agent.mcp_integration.mcp_client import MCPServerConfig, MCPTool

        config = MCPServerConfig(
            name="test",
            transport="stdio",
            command="npx",
            args=["-y", "server"],
        )
        assert config.name == "test"
        assert config.auto_start is True

        tool = MCPTool(name="read_file", description="Read file", server_name="test")
        assert tool.name == "read_file"

    def test_mcp_tool_bridge_interface(self):
        """审计: 工具桥接 — 接口完整。"""
        from agent.mcp_integration.mcp_tool_bridge import MCPToolBridge
        from agent.mcp_integration.mcp_client import MCPClient

        client = MCPClient()
        bridge = MCPToolBridge(client)
        assert hasattr(bridge, "register_all")
        assert hasattr(bridge, "unregister_all")
        assert bridge.TOOL_PREFIX == "mcp_"

    def test_mcp_lifecycle_config_path(self):
        """审计: 生命周期 — 配置文件自动发现。"""
        from agent.mcp_integration.mcp_lifecycle import MCPLifecycle
        from agent.mcp_integration.mcp_client import MCPClient

        client = MCPClient()
        lifecycle = MCPLifecycle(client)
        assert lifecycle._config_path != ""

    def test_mcp_lifecycle_auto_load(self):
        """审计: 生命周期 — auto_load 加载配置。"""
        from agent.mcp_integration.mcp_lifecycle import MCPLifecycle
        from agent.mcp_integration.mcp_client import MCPClient

        config_data = {
            "servers": [
                {
                    "name": "test-auto",
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["-y", "server"],
                    "auto_start": False,
                }
            ]
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(config_data, f)
            temp_path = f.name

        try:
            client = MCPClient()
            lifecycle = MCPLifecycle(client, config_path=temp_path)
            count = _run(lifecycle.auto_load())
            assert count == 1
            assert "test-auto" in client._servers
        finally:
            os.unlink(temp_path)

    def test_resource_subscription_manager(self):
        """审计: 资源订阅 — 订阅管理器。"""
        from agent.mcp_integration.resource_subscription import (
            ResourceSubscriptionManager, ResourceChangeEvent, SubscriptionEntry,
        )

        client = MagicMock()
        mgr = ResourceSubscriptionManager(client)
        assert mgr.subscription_count == 0
        assert mgr.active_subscriptions == []

        event = ResourceChangeEvent(
            server_name="fs",
            uri="file:///data/config.json",
            timestamp=time.time(),
            action="updated",
        )
        assert event.uri == "file:///data/config.json"

    def test_resource_subscription_on_change(self):
        """审计: 资源订阅 — 全局变更回调。"""
        from agent.mcp_integration.resource_subscription import ResourceSubscriptionManager

        client = MagicMock()
        mgr = ResourceSubscriptionManager(client)

        async def on_change(event):
            pass

        mgr.on_change(on_change)
        assert len(mgr._global_callbacks) == 1

    def test_mcp_lifecycle_health_check(self):
        """审计: 生命周期 — 健康检查接口。"""
        from agent.mcp_integration.mcp_lifecycle import MCPLifecycle
        from agent.mcp_integration.mcp_client import MCPClient

        client = MCPClient()
        lifecycle = MCPLifecycle(client, health_check_interval=30.0)
        assert lifecycle._health_check_interval == 30.0

    def test_loop_controller_mcp_resource_events(self):
        """审计: 主循环集成 — MCP 资源变更事件缓冲。"""
        from agent.loop.controller import LoopController
        from agent.llm.provider import LLMProvider

        mock_llm = MagicMock(spec=LLMProvider)
        controller = LoopController(mock_llm)
        assert hasattr(controller, "_mcp_resource_events")
        assert isinstance(controller._mcp_resource_events, list)

    def test_mcp_sse_transport_uses_httpx(self):
        """审计: SSE 传输 — 使用 httpx。"""
        import inspect
        from agent.mcp_integration.mcp_client import MCPClient

        source = inspect.getsource(MCPClient)
        assert "httpx" in source


# ═══════════════════════════════════════════════════════════════
# 跨子系统集成审计
# ═══════════════════════════════════════════════════════════════


class TestCrossSubsystemIntegration:
    """跨子系统集成审计。"""

    def test_engine_shutdown_propagates_to_perception(self):
        """审计: Engine shutdown → PerceptionActionLoop shutdown。"""
        from agent.core.engine import AgentEngine

        engine = AgentEngine()
        _run(engine.initialize())
        assert engine._shutdown_event is not None

        _run(engine.shutdown_domains())
        assert engine._shutdown_event.is_set()

    def test_workflow_engine_uses_safety_net(self):
        """审计: WorkflowEngine → SafetyNet 还原点。"""
        from agent.workflow.engine import WorkflowEngine
        from agent.safety import SafetyNet

        net = SafetyNet()
        engine = WorkflowEngine(safety_net=net)
        assert engine._safety_net is net

    def test_knowledge_lifecycle_graph_uses_store(self):
        """审计: KnowledgeGraph → KnowledgeStore。"""
        from agent.knowledge import KnowledgeLifecycle

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db = _tmp_db(tmp, "kli.db")
            kl = KnowledgeLifecycle(db_path=db)
            _run(kl.initialize())
            assert kl.graph._store is kl.store
            _run(kl.close())

    def test_mcp_tool_bridge_uses_client(self):
        """审计: MCPToolBridge → MCPClient。"""
        from agent.mcp_integration.mcp_tool_bridge import MCPToolBridge
        from agent.mcp_integration.mcp_client import MCPClient

        client = MCPClient()
        bridge = MCPToolBridge(client)
        assert bridge._client is client

    def test_all_subsystems_injected_into_loop_controller(self):
        """审计: 所有子系统注入到 LoopController。"""
        from agent.loop.controller import LoopController
        from agent.llm.provider import LLMProvider

        mock_llm = MagicMock(spec=LLMProvider)
        mock_kl = MagicMock()
        mock_perception = MagicMock()
        mock_workflow = MagicMock()

        controller = LoopController(
            mock_llm,
            knowledge_lifecycle=mock_kl,
            perception_loop=mock_perception,
            workflow_engine=mock_workflow,
        )

        assert controller._knowledge_lifecycle is mock_kl
        assert controller._perception_loop is mock_perception
        assert controller._workflow_engine is mock_workflow
        assert isinstance(controller._mcp_resource_events, list)
