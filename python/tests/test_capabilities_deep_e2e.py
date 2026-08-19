"""家百星四大核心能力 · 深度端到端测试。

覆盖用户明确列举的四项核心能力（标题称"五大"，正文仅枚举 4 项，第 5 项
"Agent 自主编排/执行闭环"可按需补充；本套件聚焦已明确项）：

  能力 1：安全沙箱增强与持久化工作流
           - 执行隔离（子进程沙箱）、危险代码/工具拦截、运行时安全姿态裁决
           - WorkflowEngine：状态保存(save)与恢复(resume)跨存储实例一致性、
             崩溃恢复、暂停/恢复、失败策略(失败/跳过/重试)

  能力 2：多模态感知闭环
           - 跨模态编码(文本↔图像同一向量空间)与跨模态检索
           - ActionVerifier 操作验证 + 自动重试闭环(反馈机制)

  能力 3：知识沉淀与主动学习
           - KnowledgeStore/Extractor 自动归纳(事实/纠正/模式)
           - KnowledgeLifecycle 沉淀→检索→衰减维护闭环
           - EvolutionEngine 反馈驱动的工具权重/纠错规则迭代与状态持久化

  能力 4：MCP 生态集成
           - 传输层协议兼容(JSON-RPC 响应/错误/通知/Server→Client 请求/SSE endpoint)
           - MCPToolBridge 外部工具发现→注册→转发调用

设计原则：纯单元/组件级 E2E，不依赖外部 LLM/Redis/Docker/真实 MCP server；
用 fallback 编码器、内存锁、MagicMock 外部依赖保证离线可跑。
每个能力均覆盖 正常路径 / 边界条件 / 异常失败 三类鲁棒性验证。
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.evolution.types import FeedbackSignal
from agent.workflow.checkpoint_store import WorkflowStore


# ════════════════════════════════════════════════════════════════
# 共享工具
# ══════════════════════════════════════════════════════════════


def _make_png(path: Path, color: tuple[int, int, int]) -> Path:
    """生成一张纯色 PNG，供像素差异/图像编码测试使用。"""
    from PIL import Image

    Image.new("RGB", (24, 24), color).save(str(path))
    return path


class _CapturingRegistry:
    """极简工具注册表替身，捕获 register 调用并提供 handler 调用。"""

    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}
        self.params: dict[str, Any] = {}
        self.descriptions: dict[str, str] = {}
        self.registered: list[str] = []

    def register(self, name: str, handler: Any, description: str, parameters: Any) -> None:
        self.handlers[name] = handler
        self.params[name] = parameters
        self.descriptions[name] = description
        self.registered.append(name)

    def unregister(self, name: str) -> None:  # pragma: no cover - 桥接注销时使用
        self.handlers.pop(name, None)
        if name in self.registered:
            self.registered.remove(name)


class _FakeLockProvider:
    """内存锁提供者替身，使 WorkflowEngine E2E 完全离线、无 Redis/SQLite 锁依赖。"""

    def __init__(self) -> None:
        self._handles: dict[str, Any] = {}

    async def acquire(self, resource: str, ttl: float = 60.0) -> Any:
        handle = _FakeLockHandle()
        self._handles[resource] = handle
        return handle

    async def release(self, handle: Any) -> bool:
        return True

    async def extend(self, handle: Any, ttl: float = 60.0) -> bool:
        return True

    async def is_locked(self, resource: str) -> bool:
        return resource in self._handles


class _FakeLockHandle:
    def __init__(self) -> None:
        self._expired = False

    @property
    def is_expired(self) -> bool:
        return self._expired


# ════════════════════════════════════════════════════════════════
# 能力 1-a：安全沙箱 —— 执行隔离与危险拦截（正常 / 边界 / 异常）
# ══════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_sandbox_python_normal_execution():
    """正常路径：LOW 安全级别下执行无害 Python 代码，捕获 stdout。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW, timeout_ms=10000))
    r = await ex.execute_code("print('hello-sandbox')", "python")
    assert r.success is True
    assert "hello-sandbox" in r.output
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_sandbox_shell_normal_execution():
    """正常路径：shell 命令正常执行并返回输出。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW, timeout_ms=10000))
    r = await ex.execute_code("echo shell-ok", "shell")
    assert r.success is True
    assert "shell-ok" in r.output


@pytest.mark.asyncio
async def test_sandbox_forbidden_code_pattern_blocked():
    """鲁棒性(异常)：任意安全级别下 `rm -rf /` 等黑名单模式被静态拦截，不进入子进程。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW))
    r = await ex.execute_code("rm -rf /", "shell")
    assert r.success is False
    assert r.security_violations  # 必须记录违规
    assert "rm -rf" in r.error or any("rm -rf" in v for v in r.security_violations)


@pytest.mark.asyncio
async def test_sandbox_dangerous_python_blocked_at_high():
    """边界：HIGH 安全级别下 `eval(` 等受限操作为静态拦截。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.HIGH))
    r = await ex.execute_code("eval('1+1')", "python")
    assert r.success is False
    assert r.security_violations


@pytest.mark.asyncio
async def test_sandbox_dangerous_python_allowed_at_low():
    """对比：LOW 安全级别不拦截受限调用（仅黑名单生效），代码真实被执行。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW, timeout_ms=10000))
    r = await ex.execute_code("print(eval('1+1'))", "python")
    assert r.success is True
    assert "2" in r.output


@pytest.mark.asyncio
async def test_sandbox_unsupported_language():
    """边界：不支持的语言立即失败并给出明确原因，不抛未捕获异常。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW))
    r = await ex.execute_code("x = 1", "ruby")
    assert r.success is False
    assert "不支持" in r.error


@pytest.mark.asyncio
async def test_sandbox_execution_timeout():
    """鲁棒性(异常)：超时代码被终止，返回超时失败而非挂起。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW, timeout_ms=400))
    r = await ex.execute_code("import time; time.sleep(5)", "python", timeout_ms=400)
    assert r.success is False
    assert "超时" in r.error
    assert r.exit_code == -1


@pytest.mark.asyncio
async def test_sandbox_runtime_error_captured():
    """鲁棒性(异常)：代码运行期异常被捕获，exit_code 非零，错误信息透传。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    ex = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW, timeout_ms=10000))
    r = await ex.execute_code("raise ValueError('boom')", "python")
    assert r.success is False
    assert r.exit_code != 0
    assert "boom" in (r.error or "")


def test_check_tool_permission_matrix():
    """正常/边界：工具权限随安全级别变化（高危工具在中/高被禁，低放行）。"""
    from agent.sandbox.executor import SandboxConfig, SandboxExecutor, SecurityLevel

    low = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.LOW))
    med = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.MEDIUM))
    high = SandboxExecutor(SandboxConfig(security_level=SecurityLevel.HIGH))

    # 高危工具：仅 LOW 放行
    assert low.check_tool_permission("delete_file").allowed is True
    assert med.check_tool_permission("delete_file").allowed is False
    assert high.check_tool_permission("delete_file").allowed is False

    # 中危工具：仅 HIGH 禁止
    assert low.check_tool_permission("write_file").allowed is True
    assert med.check_tool_permission("write_file").allowed is True
    assert high.check_tool_permission("write_file").allowed is False


# ════════════════════════════════════════════════════════════════
# 能力 1-b：运行时安全姿态裁决矩阵
# ══════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "posture,risk,expected",
    [
        ("safe", "low", "allow"),
        ("safe", "medium", "deny"),
        ("safe", "high", "deny"),
        ("safe", "critical", "deny"),
        ("confirm", "low", "review"),
        ("confirm", "critical", "review"),
        ("auto", "low", "allow"),
        ("auto", "medium", "allow"),
        ("auto", "high", "review"),
        ("auto", "critical", "review"),
        ("yolo", "low", "allow"),
        ("yolo", "medium", "allow"),
        ("yolo", "high", "allow"),
        ("yolo", "critical", "review"),
    ],
)
def test_runtime_posture_decision_matrix(posture, risk, expected):
    """正常路径：姿态 × 风险 决策矩阵全覆盖。critical 永不被静默 ALLOW。"""
    from agent.security.runtime_posture import PostureDecision, RuntimePosture, decide

    decision = decide(RuntimePosture(posture), risk)
    assert decision == PostureDecision(expected)
    # 安全硬底线：任何姿态下 critical 都不等于 ALLOW
    assert decide(RuntimePosture(posture), "critical") != PostureDecision.ALLOW


def test_runtime_posture_parse_and_aliases():
    """边界：别名解析与严格校验。"""
    from agent.security.runtime_posture import RuntimePosture

    assert RuntimePosture.parse("safe-mode") == RuntimePosture.SAFE
    assert RuntimePosture.parse("readonly") == RuntimePosture.SAFE
    assert RuntimePosture.parse("danger") == RuntimePosture.YOLO
    assert RuntimePosture.parse("unknown-or-empty") == RuntimePosture.CONFIRM  # 回退
    assert RuntimePosture.is_valid("accept-hooks") is True
    assert RuntimePosture.is_valid("bogus") is False


# ════════════════════════════════════════════════════════════════
# 能力 1-c：持久化工作流 —— 状态保存/恢复、崩溃恢复、失败策略
# ══════════════════════════════════════════════════════════════


@pytest.fixture
def wf_store(tmp_path):
    from agent.workflow.checkpoint_store import WorkflowStore

    return WorkflowStore(db_path=str(tmp_path / "wf.db"))


@pytest.fixture
def wf_engine(tmp_path):
    from agent.workflow.engine import WorkflowEngine
    from agent.workflow.checkpoint_store import WorkflowStore

    store = WorkflowStore(db_path=str(tmp_path / "wf.db"))
    return WorkflowEngine(store=store, lock_provider=_FakeLockProvider())


def _two_step_def():
    from agent.workflow.types import StepType, new_definition, new_step

    a = new_step("step_a", StepType.LLM, prompt="RUN_A")
    b = new_step("step_b", StepType.LLM, prompt="RUN_B", depends_on=[a.id])
    return new_definition(name="wf", steps=[a, b]), a, b


@pytest.mark.asyncio
async def test_workflow_full_run_and_persistence(wf_store, tmp_path):
    """正常路径：完整运行两步骤工作流，状态落盘且可在独立存储实例中恢复。"""
    from agent.workflow.engine import WorkflowEngine
    from agent.workflow.types import StepType, new_definition, new_step

    engine = WorkflowEngine(store=wf_store, lock_provider=_FakeLockProvider())
    calls: list[str] = []

    async def llm_runner(prompt, inputs):
        calls.append(prompt)
        return {"success": True, "output": prompt}

    engine.configure_executor(llm_runner=llm_runner)

    defn, a, b = _two_step_def()
    engine._store.save_definition(defn)
    inst = await engine.start(defn.id)
    result = await engine.run(inst.id)

    assert result.status == "done"
    assert calls == ["RUN_A", "RUN_B"]  # 按依赖顺序执行

    # 状态保存/恢复：用全新 WorkflowStore 读取同一 db，验证持久化
    fresh = WorkflowStore(db_path=str(tmp_path / "wf.db"))
    reloaded = fresh.load_instance(inst.id)
    assert reloaded.status == "done"
    assert reloaded.step_states[a.id].status == "done"
    assert reloaded.step_states[b.id].status == "done"


@pytest.mark.asyncio
async def test_workflow_resume_from_paused_state(wf_engine, tmp_path):
    """恢复：模拟"已暂停且 step_a 已完成"的断点，resume 后仅续跑 step_b。"""
    from agent.workflow.types import StepStatus

    calls: list[str] = []

    async def llm_runner(prompt, inputs):
        calls.append(prompt)
        return {"success": True, "output": prompt}

    wf_engine.configure_executor(llm_runner=llm_runner)
    defn, a, b = _two_step_def()
    wf_engine._store.save_definition(defn)
    inst = await wf_engine.start(defn.id)

    # 模拟崩溃/暂停时的持久化状态：step_a 已完成，实例被标记为 paused
    wf_engine._store.update_step_state(inst.id, a.id, StepStatus.DONE, result={"ok": 1})
    wf_engine._store.update_instance_status(inst.id, "paused")

    result = await wf_engine.run(inst.id)  # run() 会 PAUSED→RUNNING 并从断点继续
    assert result.status == "done"
    assert calls == ["RUN_B"]  # step_a 不应被重复执行
    assert wf_engine.get_instance(inst.id).step_states[b.id].status == "done"


@pytest.mark.asyncio
async def test_workflow_crash_recovery(wf_engine):
    """鲁棒性：RUNNING 实例在重启后被恢复为 PAUSED，等待人工恢复。"""
    defn, a, b = _two_step_def()
    wf_engine._store.save_definition(defn)
    inst = await wf_engine.start(defn.id)
    wf_engine._store.update_instance_status(inst.id, "running")

    await wf_engine._recover_crashed_instances()
    recovered = wf_engine.get_instance(inst.id)
    assert recovered.status == "paused"


@pytest.mark.asyncio
async def test_workflow_empty_definition(wf_engine):
    """边界：零步骤工作流直接判定完成。"""
    from agent.workflow.types import new_definition

    defn = new_definition(name="empty", steps=[])
    wf_engine._store.save_definition(defn)
    inst = await wf_engine.start(defn.id)
    result = await wf_engine.run(inst.id)
    assert result.status == "done"


@pytest.mark.asyncio
async def test_workflow_step_failure_fail_policy(wf_engine):
    """失败策略：on_failure=fail → 实例 FAILED，步骤 FAILED。

    修复验证：is_all_done() 已排除 FAILED 步骤，故单步失败时实例正确收尾为 FAILED
    （此前会错误收尾为 DONE）。
    """
    from agent.workflow.types import StepType, new_definition, new_step

    async def tool_runner(name, inputs):
        return {"success": False, "error": "boom"}

    async def llm_ok(prompt, inputs):
        return {"success": True}

    wf_engine.configure_executor(llm_runner=llm_ok, tool_runner=tool_runner)
    step = new_step("t", StepType.TOOL, tool_name="x", on_failure="fail")
    defn = new_definition(name="wf", steps=[step])
    wf_engine._store.save_definition(defn)
    inst = await wf_engine.start(defn.id)
    result = await wf_engine.run(inst.id)
    assert result.step_states[step.id].status == "failed"
    assert result.status == "failed"


@pytest.mark.asyncio
async def test_workflow_partial_failure_marks_instance_failed(wf_engine):
    """多步部分失败：一步成功、一步失败(fail) → 实例 FAILED（修复验证 #1 的多步场景）。"""
    from agent.workflow.types import StepType, new_definition, new_step

    async def tool_runner(name, inputs):
        # 第二个工具必失败，第一个工具成功
        if name == "ok":
            return {"success": True}
        return {"success": False, "error": "step2 boom"}

    async def llm_ok(prompt, inputs):
        return {"success": True}

    wf_engine.configure_executor(llm_runner=llm_ok, tool_runner=tool_runner)
    s1 = new_step("s1", StepType.TOOL, tool_name="ok", on_failure="fail")
    s2 = new_step("s2", StepType.TOOL, tool_name="bad", on_failure="fail")
    defn = new_definition(name="wf", steps=[s1, s2])
    wf_engine._store.save_definition(defn)
    inst = await wf_engine.start(defn.id)
    result = await wf_engine.run(inst.id)
    assert result.step_states[s1.id].status == "done"
    assert result.step_states[s2.id].status == "failed"
    # 此前 is_all_done() 将 FAILED 计入完成，实例会错误收尾为 DONE；
    # 修复后 has_failed_steps() 分支可达，实例正确收尾为 FAILED。
    assert result.status == "failed"


@pytest.mark.asyncio
async def test_workflow_step_failure_skip_policy(wf_engine):
    """失败策略：on_failure=skip → 步骤 SKIPPED，流程仍完成。"""
    from agent.workflow.types import StepType, new_definition, new_step

    async def tool_runner(name, inputs):
        return {"success": False, "error": "boom"}

    async def llm_ok(prompt, inputs):
        return {"success": True}

    wf_engine.configure_executor(llm_runner=llm_ok, tool_runner=tool_runner)
    step = new_step("t", StepType.TOOL, tool_name="x", on_failure="skip")
    defn = new_definition(name="wf", steps=[step])
    wf_engine._store.save_definition(defn)
    inst = await wf_engine.start(defn.id)
    result = await wf_engine.run(inst.id)
    assert result.status == "done"
    assert result.step_states[step.id].status == "skipped"


@pytest.mark.asyncio
async def test_workflow_step_retry_policy(wf_engine):
    """失败策略：on_failure=retry 且 retry_count>=1 → 失败后自动重试直至成功。"""
    from agent.workflow.types import StepType, new_definition, new_step

    counter = {"n": 0}

    async def tool_runner(name, inputs):
        counter["n"] += 1
        if counter["n"] == 1:
            return {"success": False, "error": "transient"}
        return {"success": True}

    async def llm_ok(prompt, inputs):
        return {"success": True}

    wf_engine.configure_executor(llm_runner=llm_ok, tool_runner=tool_runner)
    step = new_step("t", StepType.TOOL, tool_name="x", retry_count=1, on_failure="retry")
    defn = new_definition(name="wf", steps=[step])
    wf_engine._store.save_definition(defn)
    inst = await wf_engine.start(defn.id)
    result = await wf_engine.run(inst.id)
    assert result.status == "done"
    assert counter["n"] == 2  # 第 1 次失败，第 2 次成功


@pytest.mark.asyncio
async def test_workflow_start_unknown_definition(wf_engine):
    """鲁棒性：启动不存在的定义返回 None。"""
    inst = await wf_engine.start("no-such-def")
    assert inst is None


@pytest.mark.asyncio
async def test_workflow_run_unknown_instance(wf_engine):
    """鲁棒性：运行不存在的实例返回 None。"""
    result = await wf_engine.run("no-such-instance")
    assert result is None


@pytest.mark.asyncio
async def test_workflow_concurrency_isolation(wf_engine):
    """执行隔离：同一定义并发启动两个实例，状态互不串扰。"""
    defn, a, b = _two_step_def()
    wf_engine._store.save_definition(defn)

    async def llm_ok(prompt, inputs):
        await asyncio.sleep(0.01)
        return {"success": True}

    wf_engine.configure_executor(llm_runner=llm_ok)

    i1 = await wf_engine.start(defn.id)
    i2 = await wf_engine.start(defn.id)
    assert i1.id != i2.id
    r1 = await wf_engine.run(i1.id)
    r2 = await wf_engine.run(i2.id)
    assert r1.status == "done" and r2.status == "done"
    # 步骤状态按实例隔离
    assert wf_engine.get_instance(i1.id).step_states[a.id].status == "done"
    assert wf_engine.get_instance(i2.id).step_states[a.id].status == "done"


# ════════════════════════════════════════════════════════════════
# 能力 2-a：多模态跨模态编码与检索
# ══════════════════════════════════════════════════════════════


def test_multimodal_cross_modal_encode_and_search(tmp_path):
    """正常路径：文本与图像在同一（fallback）向量空间编码，检索机制正确。"""
    from agent.memory.multimodal_encoder import (
        ModalityType,
        MultimodalEncoder,
        MultimodalEncoderConfig,
    )

    enc = MultimodalEncoder(MultimodalEncoderConfig(model_name="fallback"))
    png = _make_png(tmp_path / "img.png", (10, 20, 30))

    tv = enc.encode_text("猫")
    iv = enc.encode_image(str(png))

    assert tv.modality == ModalityType.TEXT
    assert iv.modality == ModalityType.IMAGE
    assert len(tv.vector) == 128 and len(iv.vector) == 128

    candidates = [iv, enc.encode_text("完全无关的其它文本")]
    res = enc.cross_modal_search(tv, candidates, top_k=2)
    assert len(res) <= 2
    assert all(isinstance(s, float) for _, s in res)


def test_multimodal_encoder_deterministic(tmp_path):
    """边界：相同输入产生相同向量（可缓存/去重）。"""
    from agent.memory.multimodal_encoder import (
        MultimodalEncoder,
        MultimodalEncoderConfig,
    )

    enc = MultimodalEncoder(MultimodalEncoderConfig(model_name="fallback"))
    assert enc.encode_text("abc").vector == enc.encode_text("abc").vector


def test_multimodal_encoder_empty_and_missing_inputs():
    """鲁棒性(异常)：空文本/空路径抛 ValueError，不存在图像抛 FileNotFoundError。"""
    from agent.memory.multimodal_encoder import (
        MultimodalEncoder,
        MultimodalEncoderConfig,
    )

    enc = MultimodalEncoder(MultimodalEncoderConfig(model_name="fallback"))
    with pytest.raises(ValueError):
        enc.encode_text("")
    with pytest.raises(ValueError):
        enc.encode_image("")
    with pytest.raises(FileNotFoundError):
        enc.encode_image("/path/does/not/exist.png")


def test_multimodal_cosine_zero_vector():
    """边界：零向量余弦相似度安全返回 0.0（不除零、不抛异常）。"""
    from agent.memory.multimodal_encoder import MultimodalEncoder

    assert MultimodalEncoder.cosine_similarity([], [1.0, 2.0]) == 0.0
    assert MultimodalEncoder.cosine_similarity([1.0, 2.0], []) == 0.0


def test_multimodal_cross_modal_empty_candidates():
    """边界：空候选列表检索返回空。"""
    from agent.memory.multimodal_encoder import (
        ModalityType,
        MultimodalEncoder,
        MultimodalEncoderConfig,
    )

    enc = MultimodalEncoder(MultimodalEncoderConfig(model_name="fallback"))
    q = enc.encode_text("x")
    assert enc.cross_modal_search(q, [], top_k=5) == []


def test_multimodal_dimension_mismatch_no_crash(tmp_path):
    """鲁棒性：跨维度向量检索截断到公共维度计算，不静默失败。"""
    from agent.memory.multimodal_encoder import (
        EncodedVector,
        ModalityType,
        MultimodalEncoder,
        MultimodalEncoderConfig,
    )

    enc = MultimodalEncoder(MultimodalEncoderConfig(model_name="fallback"))
    q = enc.encode_text("x")
    mismatch = EncodedVector(
        vector=[0.0] * 8, modality=ModalityType.IMAGE, content_hash="h",
        model_name="other", dimensions=8,
    )
    res = enc.cross_modal_search(q, [mismatch], top_k=1)
    assert len(res) == 1


# ════════════════════════════════════════════════════════════════
# 能力 2-b：感知闭环反馈 —— ActionVerifier 验证 + 自动重试
# ══════════════════════════════════════════════════════════════


def test_verifier_strategy_selection():
    """正常路径：验证策略自动选择（有疑问→VLM，有关注区→OCR，否则→pixel）。"""
    from agent.perception.action_verifier import ActionVerifier

    v = ActionVerifier()
    assert v._select_strategy("", "这个按钮生效了吗？") == "vlm"
    assert v._select_strategy("100,200,300,400", "") == "ocr"
    assert v._select_strategy("", "") == "pixel"


@pytest.mark.asyncio
async def test_verifier_pixel_change_detected(tmp_path):
    """正常路径：操作后截图与操作前明显不同 → 验证成功。"""
    from agent.perception.action_verifier import ActionVerifier

    pre = _make_png(tmp_path / "pre.png", (0, 0, 0))
    post = _make_png(tmp_path / "post.png", (255, 255, 255))
    v = ActionVerifier()
    r = await v.verify("点击", pre_path=str(pre), post_path=str(post), strategy="pixel")
    assert r.success is True
    assert r.method == "pixel"
    assert r.diff_ratio > 0.1


@pytest.mark.asyncio
async def test_verifier_missing_screenshot():
    """边界：缺少截图路径 → 返回失败且不抛异常。"""
    from agent.perception.action_verifier import ActionVerifier

    v = ActionVerifier()
    r = await v.verify("点击", strategy="pixel")
    assert r.success is False
    assert "截图" in r.evidence


@pytest.mark.asyncio
async def test_verifier_retry_until_exhausted(tmp_path):
    """鲁棒性(反馈闭环)：操作无效(截图无变化) → 自动重试多次，最终显式标记 retry_exhausted。

    修复验证：原 verify_with_retry 末尾的 'retry_exhausted' 分支因循环结构不可达，
    重试耗尽时仅返回最后一次验证结果（retry_suggested=True）。修复后，在最后一次尝试
    仍失败时显式返回 method='retry_exhausted'、retry_suggested=False。
    """
    from agent.perception.action_verifier import ActionVerifier, AutoRetryPolicy

    pre = _make_png(tmp_path / "pre.png", (0, 0, 0))
    post = _make_png(tmp_path / "post.png", (0, 0, 0))  # 与 pre 完全相同 → 无差异

    v = ActionVerifier(retry_policy=AutoRetryPolicy(max_retries=2, base_delay=0.0, max_delay=0.0))
    v.capture_pre_state(screenshot_path=str(pre))

    calls = {"n": 0}

    async def action_fn() -> None:
        calls["n"] += 1

    async def post_fn() -> str:
        return str(post)

    result = await v.verify_with_retry(
        "点击无效按钮",
        action_fn=action_fn,
        post_screenshot_fn=post_fn,
        strategy="pixel",
    )

    assert calls["n"] == 3  # 1 次初始尝试 + 2 次重试
    assert result.success is False
    assert result.method == "retry_exhausted"  # 修复后：显式标记重试耗尽
    assert result.retry_suggested is False


# ════════════════════════════════════════════════════
# 能力 3-a：知识存储与检索（自动归纳沉淀的底座）
# ══════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_knowledge_store_add_and_search(tmp_path):
    """正常路径：添加知识后语义检索返回相关条目且相似度 > 0.1。"""
    from agent.knowledge.knowledge_store import KnowledgeStore

    store = KnowledgeStore(db_path=str(tmp_path / "k.db"))
    await store.initialize()
    await store.add("Python is the backend language of jiabaixing", tags=["tech_stack"])
    await store.add("Cats like eating fish", tags=["fact"])

    results = await store.search("Python backend", top_k=5)
    assert len(results) >= 1
    assert results[0].entry.content.startswith("Python")
    assert results[0].score > 0.1


@pytest.mark.asyncio
async def test_knowledge_store_missing_get_and_count(tmp_path):
    """边界：未初始化即读取 → get 返回 None、count 为 0；新增后可见。"""
    from agent.knowledge.knowledge_store import KnowledgeStore

    store = KnowledgeStore(db_path=str(tmp_path / "k.db"))
    await store.initialize()
    assert await store.get("nope") is None
    assert await store.count() == 0

    kid = await store.add("observable knowledge")
    assert await store.count() == 1
    entry = await store.get(kid)
    assert entry is not None
    assert entry.content == "observable knowledge"


@pytest.mark.asyncio
async def test_knowledge_store_delete(tmp_path):
    """正常路径：删除后不可再取回。"""
    from agent.knowledge.knowledge_store import KnowledgeStore

    store = KnowledgeStore(db_path=str(tmp_path / "k.db"))
    await store.initialize()
    kid = await store.add("to delete")
    assert await store.delete(kid) is True
    assert await store.get(kid) is None


@pytest.mark.asyncio
async def test_knowledge_store_min_confidence_filter(tmp_path):
    """边界：min_confidence 过滤低置信条目（SQL 层即排除）。"""
    from agent.knowledge.knowledge_store import KnowledgeStore

    store = KnowledgeStore(db_path=str(tmp_path / "k.db"))
    await store.initialize()
    await store.add("Database backup is critical", confidence=0.9)
    await store.add("Random noise here", confidence=0.1)

    res = await store.search("backup", top_k=10, min_confidence=0.5)
    contents = [r.entry.content for r in res]
    assert "Database backup is critical" in contents
    assert "Random noise here" not in contents


# ════════════════════════════════════════════════════
# 能力 3-b：知识提取器（自动归纳 fact/correction/insight）
# ══════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_extractor_from_dialog_facts_and_corrections(tmp_path):
    """正常路径：对话中提取事实/纠正/洞察三类知识。"""
    from agent.knowledge.knowledge_extractor import KnowledgeExtractor
    from agent.knowledge.knowledge_store import KnowledgeStore

    store = KnowledgeStore(db_path=str(tmp_path / "k.db"))
    await store.initialize()
    extractor = KnowledgeExtractor(store)

    messages = [
        {"role": "user", "content": "我喜欢使用Python进行开发"},
        {"role": "user", "content": "不对应该用JSON格式输出"},
        {"role": "assistant", "content": "总结：本次采用增量更新策略"},
    ]
    ids = await extractor.extract_from_dialog(messages)
    assert len(ids) >= 3  # fact + correction + insight
    assert await store.count() >= 3


@pytest.mark.asyncio
async def test_extractor_from_operation_failure(tmp_path):
    """鲁棒性：工具失败的操作结果被归纳为 correction 知识。"""
    from agent.knowledge.knowledge_extractor import KnowledgeExtractor
    from agent.knowledge.knowledge_store import KnowledgeStore

    store = KnowledgeStore(db_path=str(tmp_path / "k.db"))
    await store.initialize()
    extractor = KnowledgeExtractor(store)

    ids = await extractor.extract_from_operation(
        "delete file", {"success": False, "error": "permission denied"},
    )
    assert len(ids) >= 1
    entry = await store.get(ids[0])
    assert "操作失败" in entry.content


@pytest.mark.asyncio
async def test_extractor_from_document_chunking(tmp_path):
    """正常路径：短文档被切分为单块并存储。"""
    from agent.knowledge.knowledge_extractor import KnowledgeExtractor
    from agent.knowledge.knowledge_store import KnowledgeStore

    store = KnowledgeStore(db_path=str(tmp_path / "k.db"))
    await store.initialize()
    extractor = KnowledgeExtractor(store)

    ids = await extractor.extract_from_document("这是一段需要沉淀的文档内容。", doc_id="d1")
    assert len(ids) == 1
    entry = await store.get(ids[0])
    assert entry.source == "document"


# ════════════════════════════════════════════════════
# 能力 3-c：知识生命周期（沉淀→检索→衰减维护闭环）
# ══════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_knowledge_lifecycle_requires_init(tmp_path):
    """鲁棒性：未初始化即摄入 → RuntimeError。"""
    from agent.knowledge.knowledge_lifecycle import KnowledgeLifecycle

    lc = KnowledgeLifecycle(db_path=str(tmp_path / "kl.db"))
    with pytest.raises(RuntimeError):
        await lc.ingest_dialog([{"role": "user", "content": "我喜欢Python"}])


@pytest.mark.asyncio
async def test_knowledge_lifecycle_ingest_dialog(tmp_path):
    """正常路径：对话摄入自动提取并落库。"""
    from agent.knowledge.knowledge_lifecycle import KnowledgeLifecycle

    lc = KnowledgeLifecycle(db_path=str(tmp_path / "kl.db"))
    await lc.initialize()
    try:
        ids = await lc.ingest_dialog([
            {"role": "user", "content": "我喜欢使用Python进行开发"},
            {"role": "user", "content": "不对应该用JSON格式输出"},
        ])
        assert len(ids) >= 1
        assert await lc.store.count() >= 1
    finally:
        await lc.close()


@pytest.mark.asyncio
async def test_knowledge_lifecycle_retrieve_english(tmp_path):
    """正常路径：英文知识可被语义检索命中（fallback 哈希向量无中文分词）。"""
    from agent.knowledge.knowledge_lifecycle import KnowledgeLifecycle

    lc = KnowledgeLifecycle(db_path=str(tmp_path / "kl.db"))
    await lc.initialize()
    try:
        await lc.add_knowledge("The backend language is Python", tags=["tech"])
        results = await lc.retrieve("Python", top_k=5)
        assert results
        assert "Python" in results[0].entry.content
    finally:
        await lc.close()


@pytest.mark.asyncio
async def test_knowledge_lifecycle_maintenance(tmp_path):
    """正常路径：run_maintenance 返回含总数与耗时的维护报告。"""
    from agent.knowledge.knowledge_lifecycle import KnowledgeLifecycle

    lc = KnowledgeLifecycle(db_path=str(tmp_path / "kl.db"))
    await lc.initialize()
    try:
        await lc.add_knowledge("维护用知识条目", tags=["t"])
        report = await lc.run_maintenance()
        assert report.total_entries >= 1
        assert report.duration_ms >= 0
    finally:
        await lc.close()


@pytest.mark.asyncio
async def test_knowledge_lifecycle_validate_boost(tmp_path):
    """正常路径：验证通过 → 知识置信度被提升。"""
    from agent.knowledge.knowledge_lifecycle import KnowledgeLifecycle

    lc = KnowledgeLifecycle(db_path=str(tmp_path / "kl.db"))
    await lc.initialize()
    try:
        kid = await lc.add_knowledge("待验证知识", confidence=0.5)
        ok = await lc.validate_knowledge(kid, verified=True)
        assert ok is True
        entry = await lc.store.get(kid)
        assert entry.confidence > 0.5
    finally:
        await lc.close()


# ════════════════════════════════════════════════════
# 能力 3-d：进化引擎（反馈驱动工具权重/纠错规则迭代 + 持久化）
# ══════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_evolution_no_plan_without_signals(tmp_path):
    """边界：无任何反馈信号时 should_evolve 返回 None（不误触发进化）。"""
    from agent.evolution.engine import EvolutionEngine

    eng = EvolutionEngine(data_dir=str(tmp_path))
    assert await eng.should_evolve() is None


@pytest.mark.asyncio
async def test_evolution_tool_failure_triggers_plan(tmp_path):
    """正常路径：连续 3 次工具失败 → 触发 TOOL_WEIGHT_ADJUSTMENT 进化计划。"""
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import EvolutionCause, EvolutionType

    eng = EvolutionEngine(data_dir=str(tmp_path))
    for _ in range(3):
        await eng.record_tool_failure("flaky_tool", error="timeout")
    plan = await eng.should_evolve()
    assert plan is not None
    assert plan.cause == EvolutionCause.TOOL_FAILURE
    assert plan.evolution_type == EvolutionType.TOOL_WEIGHT_ADJUSTMENT
    assert any(a.target == "flaky_tool" for a in plan.actions)


@pytest.mark.asyncio
async def test_evolution_low_quality_triggers_plan(tmp_path):
    """正常路径：平均质量 < 0.7 → 触发 PROMPT_OPTIMIZATION 进化计划。"""
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import EvolutionCause, EvolutionType

    eng = EvolutionEngine(data_dir=str(tmp_path))
    for _ in range(10):
        eng.collect_feedback_sync(FeedbackSignal(interaction_id="i", quality_score=0.3))
    plan = await eng.should_evolve()
    assert plan is not None
    assert plan.cause == EvolutionCause.LOW_QUALITY
    assert plan.evolution_type == EvolutionType.PROMPT_OPTIMIZATION


@pytest.mark.asyncio
async def test_evolution_execute_reduce_weight(tmp_path):
    """正常路径：执行 reduce_weight 动作 → 目标工具权重下调为原来的 0.8。"""
    from agent.evolution.engine import EvolutionEngine
    from agent.evolution.types import (
        EvolutionAction,
        EvolutionCause,
        EvolutionPlan,
        EvolutionPriority,
        EvolutionType,
    )

    eng = EvolutionEngine(data_dir=str(tmp_path))
    for _ in range(5):
        eng.collect_feedback_sync(FeedbackSignal(
            interaction_id="i", quality_score=0.9, tool_name="my_tool",
            tools_used=["my_tool"], tool_successes={"my_tool": True},
        ))
    before = eng._tool_weights["my_tool"]
    plan = EvolutionPlan(
        plan_id="evo_test",
        evolution_type=EvolutionType.TOOL_WEIGHT_ADJUSTMENT,
        priority=EvolutionPriority.MEDIUM,
        cause=EvolutionCause.TOOL_FAILURE,
        actions=[EvolutionAction(action_type="reduce_weight", target="my_tool", description="降权")],
    )
    result = await eng.execute_evolution(plan)
    assert result.success is True
    assert eng._tool_weights["my_tool"] == pytest.approx(before * 0.8)


@pytest.mark.asyncio
async def test_evolution_correction_rule_from_failure(tmp_path):
    """鲁棒性：低质量且含失败工具 → 自动生成纠错规则。"""
    from agent.evolution.engine import EvolutionEngine

    eng = EvolutionEngine(data_dir=str(tmp_path))
    eng.collect_feedback_sync(FeedbackSignal(
        interaction_id="f", quality_score=0.2, tools_used=["bad_tool"],
        tool_successes={"bad_tool": False},
    ))
    assert len(eng.get_correction_rules()) >= 1


@pytest.mark.asyncio
async def test_evolution_prompt_section_contains_rules(tmp_path):
    """正常路径：进化纠错规则可被编译进系统提示片段。"""
    from agent.evolution.engine import EvolutionEngine

    eng = EvolutionEngine(data_dir=str(tmp_path))
    eng.collect_feedback_sync(FeedbackSignal(
        interaction_id="f", quality_score=0.2, tools_used=["bad_tool"],
        tool_successes={"bad_tool": False},
    ))
    section = eng.build_evolution_prompt_section()
    assert isinstance(section, str) and section.strip()


@pytest.mark.asyncio
async def test_evolution_state_persistence(tmp_path):
    """正常路径：累计 5 条信号后状态落盘；新引擎实例可恢复工具调用统计。"""
    from agent.evolution.engine import EvolutionEngine

    eng = EvolutionEngine(data_dir=str(tmp_path))
    for i in range(5):
        eng.collect_feedback_sync(FeedbackSignal(
            interaction_id=f"i{i}", quality_score=0.8, tool_name="t",
            tools_used=["t"], tool_successes={"t": True},
        ))
    assert (tmp_path / "engine-state.json").exists()

    eng2 = EvolutionEngine(data_dir=str(tmp_path))
    assert "t" in eng2._tool_call_stats


# ════════════════════════════════════════════════════
# 能力 4-a：MCP 传输层协议兼容（JSON-RPC / SSE）
# ══════════════════════════════════════════════════


def test_mcp_jsonrpc_response_and_error():
    """正常/异常：JSON-RPC 响应完成 pending future；错误以 RuntimeError 抛出。"""
    import asyncio

    from agent.mcp.transport import HttpSseMCPTransport, MCPTransportConfig

    t = HttpSseMCPTransport(MCPTransportConfig())
    loop = asyncio.new_event_loop()

    fut = loop.create_future()
    t._pending[1] = fut
    t._handle_jsonrpc_message({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})
    assert fut.done()
    assert fut.result()["result"] == {"ok": True}

    fut_err = loop.create_future()
    t._pending[2] = fut_err
    t._handle_jsonrpc_message({"jsonrpc": "2.0", "id": 2, "error": {"code": -1, "message": "boom"}})
    assert fut_err.done()
    with pytest.raises(RuntimeError):
        fut_err.result()


def test_mcp_jsonrpc_notification_and_server_request():
    """正常：通知分发到 on_notification；Server→Client 请求分发到 on_request。"""
    from agent.mcp.transport import HttpSseMCPTransport, MCPTransportConfig

    t = HttpSseMCPTransport(MCPTransportConfig())

    received: dict = {}
    t.on_notification("notif/x", lambda p: received.update(p))
    t._handle_jsonrpc_message({"jsonrpc": "2.0", "method": "notif/x", "params": {"k": 1}})
    assert received == {"k": 1}

    got: dict = {}
    t.on_request("sampling/createMessage", lambda m: got.update(m))
    t._handle_jsonrpc_message({
        "jsonrpc": "2.0", "id": 99, "method": "sampling/createMessage", "params": {"a": 1},
    })
    assert got.get("id") == 99
    assert got.get("method") == "sampling/createMessage"


def test_mcp_sse_endpoint_extraction():
    """正常：SSE endpoint 事件提取 POST URL（相对路径经 urljoin 补全）。"""
    from agent.mcp.transport import HttpSseMCPTransport, MCPTransportConfig

    t = HttpSseMCPTransport(MCPTransportConfig(url="https://mcp.example.com/sse"))
    t._feed_raw("event: endpoint\r\ndata: /messages?session=abc\r\n\r\n")
    assert t._sse_endpoint == "https://mcp.example.com/messages?session=abc"


def test_mcp_sse_message_resolves_pending():
    """正常：SSE message 事件携带 JSON-RPC 响应 → 完成 pending future。"""
    import asyncio

    from agent.mcp.transport import HttpSseMCPTransport, MCPTransportConfig

    t = HttpSseMCPTransport(MCPTransportConfig(url="https://x/sse"))
    t._sse_endpoint = "https://x/messages"
    loop = asyncio.new_event_loop()
    fut = loop.create_future()
    t._pending[7] = fut
    t._feed_raw('event: message\r\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":1}}\r\n\r\n')
    assert fut.done()
    assert fut.result()["result"] == {"ok": 1}


def test_mcp_transport_factory():
    """正常/异常：工厂按类型创建传输；未知类型抛 ValueError。"""
    from agent.mcp.transport import (
        HttpSseMCPTransport,
        MCPTransportConfig,
        MCPTransportFactory,
        MCPTransportType,
        StdioMCPTransport,
    )

    tr = MCPTransportFactory.create(MCPTransportConfig(), "stdio")
    assert isinstance(tr, StdioMCPTransport)

    tr2 = MCPTransportFactory.create(MCPTransportConfig(), MCPTransportType.HTTP_SSE)
    assert isinstance(tr2, HttpSseMCPTransport)

    with pytest.raises(ValueError):
        MCPTransportFactory.create(MCPTransportConfig(), "bogus")


# ════════════════════════════════════════════════════
# 能力 4-b：MCP 工具桥接（发现→注册→转发调用）
# ══════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_mcp_tool_bridge_register_all_and_forward():
    """正常路径：register_all 注册工具；handler 转发到 client.call_tool。"""
    from agent.mcp_integration.mcp_client import MCPTool
    from agent.mcp_integration.mcp_tool_bridge import MCPToolBridge

    client = MagicMock()
    client.list_tools = AsyncMock(return_value=[
        MCPTool(
            name="grep", description="search text",
            input_schema={"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
            server_name="fs",
        ),
    ])
    client.call_tool = AsyncMock(return_value={"result": "ok"})

    registry = _CapturingRegistry()
    bridge = MCPToolBridge(client, registry)
    count = await bridge.register_all("fs")

    assert count == 1
    assert "mcp_fs__grep" in registry.handlers
    assert registry.descriptions["mcp_fs__grep"].startswith("[MCP]")

    res = await registry.handlers["mcp_fs__grep"]({"q": "x"})
    assert res == {"result": "ok"}
    client.call_tool.assert_awaited_with(server_name="fs", tool_name="grep", arguments={"q": "x"})


@pytest.mark.asyncio
async def test_mcp_tool_bridge_empty_schema_defaults():
    """边界：工具无 input_schema → 参数结构回退为空的 object。"""
    from agent.mcp_integration.mcp_client import MCPTool
    from agent.mcp_integration.mcp_tool_bridge import MCPToolBridge

    client = MagicMock()
    client.list_tools = AsyncMock(return_value=[
        MCPTool(name="noop", description="", input_schema=None, server_name="s"),
    ])

    registry = _CapturingRegistry()
    bridge = MCPToolBridge(client, registry)
    count = await bridge.register_all("s")

    assert count == 1
    params = registry.params["mcp_s__noop"]
    assert params == {"type": "object", "properties": {}, "required": []}


@pytest.mark.asyncio
async def test_mcp_tool_bridge_no_registry():
    """鲁棒性：注册表缺失 → register_all 安全返回 0，不抛异常。"""
    from agent.mcp_integration.mcp_client import MCPTool
    from agent.mcp_integration.mcp_tool_bridge import MCPToolBridge

    client = MagicMock()
    client.list_tools = AsyncMock(return_value=[MCPTool(name="x", server_name="s")])
    bridge = MCPToolBridge(client, None)
    assert await bridge.register_all("s") == 0


@pytest.mark.asyncio
async def test_mcp_tool_bridge_register_missing_tool():
    """边界：注册不存在的工具 → 返回 False。"""
    from agent.mcp_integration.mcp_client import MCPTool
    from agent.mcp_integration.mcp_tool_bridge import MCPToolBridge

    client = MagicMock()
    client.list_tools = AsyncMock(return_value=[MCPTool(name="exists", server_name="s")])
    registry = _CapturingRegistry()
    bridge = MCPToolBridge(client, registry)
    assert await bridge.register_tool("s", "absent") is False


@pytest.mark.asyncio
async def test_mcp_client_call_tool_not_connected():
    """鲁棒性：未连接服务端 → call_tool 返回 error 字典，list_tools 返回空。"""
    from agent.mcp_integration.mcp_client import MCPClient

    client = MCPClient()
    res = await client.call_tool("ghost", "foo", {})
    assert "error" in res
    assert await client.list_tools("ghost") == []
