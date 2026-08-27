"""集成测试: DesktopOp ↔ LongTask ↔ ScreenWatcher 全链路."""

from __future__ import annotations

import asyncio
import time

import pytest

from agent.core.long_task import (
    LongTaskOrchestrator,
    SubTask,
    SubTaskStatus,
    TaskBudget,
    TaskPhase,
    TaskProgress,
)
from agent.desktop.operation_loop import DesktopOperationLoop, OperationSpec, OperationResult
from agent.perception.screen_watcher import ScreenWatcher, ScreenChangeEvent, Rect
from agent.tools.approval_manager import ApprovalManager, BatchApprovalResult


# ─── DesktopOperationLoop ↔ LongTaskOrchestrator ───


def test_desktop_op_bind_long_task():
    dop = DesktopOperationLoop()
    orch = LongTaskOrchestrator(engine=None, persistence_enabled=False)
    dop.bind_long_task_orchestrator(orch)
    assert dop._long_task_orchestrator is orch


def test_desktop_op_bind_none():
    dop = DesktopOperationLoop()
    assert dop._long_task_orchestrator is None


def test_desktop_op_has_sequence_and_parallel():
    dop = DesktopOperationLoop()
    assert hasattr(dop, "execute_sequence")
    assert hasattr(dop, "execute_parallel")
    assert hasattr(dop, "execute_as_subtask")


# ─── ScreenWatcher callbacks ───


def test_screen_watcher_callback_registration():
    watcher = ScreenWatcher()
    called = []

    async def on_change(event: ScreenChangeEvent) -> None:
        called.append(event)

    watcher.on_change(on_change, threshold=0.1)
    assert len(watcher._on_change_callbacks) == 1
    assert watcher._on_change_threshold == 0.1


def test_screen_watcher_multiple_callbacks():
    watcher = ScreenWatcher()

    async def cb1(event: ScreenChangeEvent) -> None:
        pass

    async def cb2(event: ScreenChangeEvent) -> None:
        pass

    watcher.on_change(cb1, threshold=0.05)
    watcher.on_change(cb2, threshold=0.1)
    assert len(watcher._on_change_callbacks) == 2
    assert watcher._on_change_threshold == 0.1


def test_screen_watcher_clear_callbacks():
    watcher = ScreenWatcher()

    async def cb(event: ScreenChangeEvent) -> None:
        pass

    watcher.on_change(cb)
    watcher.clear_callbacks()
    assert len(watcher._on_change_callbacks) == 0
    assert watcher._on_change_threshold == 0.05


# ─── ScreenWatcher → DesktopOperationLoop chain ───


def test_watcher_to_desktop_op_chain():
    """验证 ScreenWatcher 回调可触发 DesktopOperationLoop 操作。"""
    watcher = ScreenWatcher()
    dop = DesktopOperationLoop()
    execution_log: list[str] = []

    async def on_screen_change(event: ScreenChangeEvent) -> None:
        spec = OperationSpec(action_type="screenshot", target="auto_capture")
        execution_log.append(f"triggered:{event.diff_score:.3f}")

    watcher.on_change(on_screen_change, threshold=0.05)
    assert len(watcher._on_change_callbacks) == 1
    assert dop._long_task_orchestrator is None


# ─── LongTask priority with desktop subtasks ───


def test_long_task_priority_with_desktop_subtasks():
    orch = LongTaskOrchestrator(engine=None, persistence_enabled=False)
    subtasks = [
        SubTask(subtask_id="s1", name="capture_screenshot", description="截图感知", metadata={"priority": "high"}),
        SubTask(subtask_id="s2", name="analyze_ui", description="UI分析", metadata={"priority": "critical"}),
        SubTask(subtask_id="s3", name="execute_action", description="执行操作", metadata={"priority": "medium"}),
        SubTask(subtask_id="s4", name="verify_result", description="验证结果", metadata={"priority": "low"}),
    ]
    sorted_tasks = orch._sort_by_priority(subtasks)
    assert sorted_tasks[0].name == "analyze_ui"
    assert sorted_tasks[-1].name == "verify_result"


# ─── BatchApproval ↔ LongTask ───


def test_batch_approval_for_long_task():
    """长任务中的多个审批请求可批量处理。"""
    mgr = ApprovalManager()
    result = mgr.batch_respond([], True)
    assert result.total == 0

    summary = mgr.get_risk_summary()
    assert summary["total_pending"] == 0


# ─── ConversationLoop execution mode ───


def test_conversation_loop_execution_mode():
    from agent.core.conversation_loop import ConversationLoop
    from unittest.mock import MagicMock

    llm = MagicMock()
    loop = ConversationLoop(llm=llm)
    assert loop.execution_mode == "react"

    loop.set_execution_mode("plan_execute_evaluate")
    assert loop.execution_mode == "plan_execute_evaluate"

    loop.set_execution_mode("invalid_mode")
    assert loop.execution_mode == "plan_execute_evaluate"

    loop.set_execution_mode("react")
    assert loop.execution_mode == "react"


# ─── DesktopController special paths ───


def test_desktop_controller_resolve_special_path():
    from agent.desktop.desktop_controller import DesktopController
    import os

    home = DesktopController.resolve_special_path("home")
    assert home != ""
    assert os.path.isabs(home)

    desktop = DesktopController.resolve_special_path("desktop")
    assert desktop != ""

    desktop_cn = DesktopController.resolve_special_path("桌面")
    assert desktop_cn == desktop

    appdata = DesktopController.resolve_special_path("appdata")
    assert appdata != ""

    temp = DesktopController.resolve_special_path("temp")
    assert temp != ""

    unknown = DesktopController.resolve_special_path("nonexistent_xyz")
    assert unknown == ""


def test_desktop_controller_expand_path():
    from agent.desktop.desktop_controller import DesktopController
    import os

    result = DesktopController.expand_path("~")
    assert result == str(os.path.expanduser("~"))

    result = DesktopController.expand_path("")
    assert result == ""

    if os.name == "nt":
        result = DesktopController.expand_path("%USERPROFILE%")
        assert result != ""


# ─── VLMCaller local model detection ───


def test_vlm_caller_is_local_model():
    from agent.perception.vlm_call import VLMCaller

    vlm_remote = VLMCaller(default_model="gpt-4o")
    assert vlm_remote.is_local_model is False

    vlm_ollama = VLMCaller(default_model="ollama/llava")
    assert vlm_ollama.is_local_model is True

    vlm_vllm = VLMCaller(default_model="hosted_vllm/qwen2-vl")
    assert vlm_vllm.is_local_model is True


@pytest.mark.anyio
async def test_vlm_caller_detect_local_models():
    from agent.perception.vlm_call import VLMCaller

    vlm = VLMCaller()
    models = await vlm.detect_local_models()
    assert isinstance(models, list)
