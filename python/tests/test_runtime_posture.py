"""运行时安全姿态 RuntimePosture 测试。

覆盖：
- 纯决策矩阵 decide() 的 姿态 × 风险 全组合
- 字符串/环境变量解析
- ApprovalManager 集成：ALLOW/DENY/REVIEW 三条路径 + critical 硬底线 + 向后兼容
"""

from __future__ import annotations

import asyncio

import pytest

from agent.security.runtime_posture import (
    PostureDecision,
    RuntimePosture,
    decide,
)
from agent.tools.approval_manager import ApprovalManager


# ─── 决策矩阵（纯函数） ───

_EXPECTED = {
    RuntimePosture.SAFE: {
        "low": PostureDecision.ALLOW,
        "medium": PostureDecision.DENY,
        "high": PostureDecision.DENY,
        "critical": PostureDecision.DENY,
    },
    RuntimePosture.CONFIRM: {
        "low": PostureDecision.REVIEW,
        "medium": PostureDecision.REVIEW,
        "high": PostureDecision.REVIEW,
        "critical": PostureDecision.REVIEW,
    },
    RuntimePosture.AUTO: {
        "low": PostureDecision.ALLOW,
        "medium": PostureDecision.ALLOW,
        "high": PostureDecision.REVIEW,
        "critical": PostureDecision.REVIEW,
    },
    RuntimePosture.YOLO: {
        "low": PostureDecision.ALLOW,
        "medium": PostureDecision.ALLOW,
        "high": PostureDecision.ALLOW,
        "critical": PostureDecision.REVIEW,
    },
}


@pytest.mark.parametrize("posture", list(RuntimePosture))
@pytest.mark.parametrize("risk", ["low", "medium", "high", "critical"])
def test_decision_matrix(posture: RuntimePosture, risk: str) -> None:
    assert decide(posture, risk) is _EXPECTED[posture][risk]


def test_critical_never_silently_allowed() -> None:
    """critical 在任何姿态下都不会被静默 ALLOW（硬底线）。"""
    for posture in RuntimePosture:
        assert decide(posture, "critical") is not PostureDecision.ALLOW


def test_unknown_risk_treated_as_high() -> None:
    """未知/空风险等级按 high 保守处理。"""
    assert decide(RuntimePosture.YOLO, "weird") is _EXPECTED[RuntimePosture.YOLO]["high"]
    assert decide(RuntimePosture.YOLO, None) is _EXPECTED[RuntimePosture.YOLO]["high"]
    assert decide(RuntimePosture.SAFE, "") is _EXPECTED[RuntimePosture.SAFE]["high"]


# ─── 解析 ───

def test_parse_valid_and_alias() -> None:
    assert RuntimePosture.parse("safe") is RuntimePosture.SAFE
    assert RuntimePosture.parse("YOLO") is RuntimePosture.YOLO
    assert RuntimePosture.parse(" Auto ") is RuntimePosture.AUTO
    assert RuntimePosture.parse("safe-mode") is RuntimePosture.SAFE
    assert RuntimePosture.parse("accept-hooks") is RuntimePosture.AUTO


def test_parse_invalid_falls_back_to_confirm() -> None:
    assert RuntimePosture.parse(None) is RuntimePosture.CONFIRM
    assert RuntimePosture.parse("") is RuntimePosture.CONFIRM
    assert RuntimePosture.parse("nonsense") is RuntimePosture.CONFIRM


def test_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_RUNTIME_POSTURE", "yolo")
    assert RuntimePosture.from_env() is RuntimePosture.YOLO
    monkeypatch.delenv("AGENT_RUNTIME_POSTURE", raising=False)
    assert RuntimePosture.from_env() is RuntimePosture.CONFIRM


# ─── ApprovalManager 集成 ───

@pytest.mark.anyio
async def test_safe_posture_allows_read_denies_write() -> None:
    mgr = ApprovalManager(posture=RuntimePosture.SAFE)
    ok = await mgr.request_approval("read_file", {}, "low")
    assert ok.approved is True
    blocked = await mgr.request_approval("write_file", {"path": "x"}, "medium")
    assert blocked.approved is False
    assert "safe" in blocked.reason and "medium" in blocked.reason


@pytest.mark.anyio
async def test_yolo_posture_allows_high_but_reviews_critical() -> None:
    mgr = ApprovalManager(posture=RuntimePosture.YOLO)
    high = await mgr.request_approval("shell_exec", {"cmd": "ls"}, "high")
    assert high.approved is True

    # critical 仍走审批流（硬底线）：用监听器即时批准以避免超时。
    async def _respond() -> None:
        await asyncio.sleep(0.05)
        pending = mgr.get_pending_requests()
        if pending:
            mgr.respond(pending[0].id, True, "人工确认")

    task = asyncio.create_task(_respond())
    crit = await mgr.request_approval("rm_rf", {"path": "/"}, "critical")
    assert crit.approved is True
    await task


@pytest.mark.anyio
async def test_auto_posture_reviews_high() -> None:
    mgr = ApprovalManager(posture=RuntimePosture.AUTO)
    # medium 直接放行
    assert (await mgr.request_approval("edit", {}, "medium")).approved is True

    # high 走审批：监听器拒绝
    async def _respond() -> None:
        await asyncio.sleep(0.05)
        pending = mgr.get_pending_requests()
        if pending:
            mgr.respond(pending[0].id, False, "人工拒绝")

    task = asyncio.create_task(_respond())
    high = await mgr.request_approval("deploy", {}, "high")
    assert high.approved is False
    await task


@pytest.mark.anyio
async def test_confirm_posture_is_backward_compatible() -> None:
    """默认 CONFIRM + auto_approve_all：行为与引入姿态前一致。"""
    mgr = ApprovalManager(auto_approve_all=True)  # 默认 posture=CONFIRM
    assert mgr.posture is RuntimePosture.CONFIRM
    # 非 critical 立即放行（auto_approve_all 生效，姿态不介入）
    assert (await mgr.request_approval("any_tool", {}, "high")).approved is True


@pytest.mark.anyio
async def test_set_posture_switches_at_runtime() -> None:
    mgr = ApprovalManager(posture=RuntimePosture.YOLO)
    assert (await mgr.request_approval("shell_exec", {}, "high")).approved is True
    mgr.set_posture(RuntimePosture.SAFE)
    assert (await mgr.request_approval("shell_exec", {}, "high")).approved is False
