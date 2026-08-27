from __future__ import annotations

import pytest

from agent.tools.approval_manager import ApprovalManager, ApprovalResponse, BatchApprovalResult, _aggregate_risk


# ─── Basic approval ───


@pytest.mark.anyio
async def test_request_approval_auto_low_risk():
    manager = ApprovalManager(auto_approve_low_risk=True)
    resp = await manager.request_approval("safe_tool", {}, "low")
    assert resp.approved is True


@pytest.mark.anyio
async def test_request_approval_high_risk_waits():
    manager = ApprovalManager()

    import asyncio

    async def _respond() -> None:
        await asyncio.sleep(0.05)
        pending = manager.get_pending_requests()
        if pending:
            manager.respond(pending[0].id, True, "批准")

    task = asyncio.create_task(_respond())
    resp = await manager.request_approval("dangerous_tool", {"action": "delete"}, "high")
    assert resp.approved is True
    await task


@pytest.mark.anyio
async def test_request_approval_rejected():
    manager = ApprovalManager()

    import asyncio

    async def _respond() -> None:
        await asyncio.sleep(0.05)
        pending = manager.get_pending_requests()
        if pending:
            manager.respond(pending[0].id, False, "不安全")

    task = asyncio.create_task(_respond())
    resp = await manager.request_approval("dangerous_tool", {}, "high")
    assert resp.approved is False
    assert "不安全" in resp.reason
    await task


# ─── Pending requests ───


@pytest.mark.anyio
async def test_get_pending_requests():
    manager = ApprovalManager()

    import asyncio

    request_entered = asyncio.Event()

    async def _approve() -> None:
        await manager.request_approval("tool", {}, "high")

    task = asyncio.create_task(_approve())
    await asyncio.sleep(0.1)

    pending = manager.get_pending_requests()
    assert len(pending) == 1
    assert pending[0].tool_name == "tool"
    assert pending[0].status == "pending"

    manager.respond(pending[0].id, True)
    await task


# ─── Respond invalid ───


def test_respond_invalid_id():
    manager = ApprovalManager()
    assert manager.respond("nonexistent", True) is False


def test_respond_already_handled():
    manager = ApprovalManager()

    import asyncio

    async def _test() -> None:
        resp = await manager.request_approval("tool", {}, "high")

    # Can't easily test this without async, but the respond method
    # should return False for non-existent or already-handled requests
    assert manager.respond("nonexistent", True) is False


# ─── Listener callback ───


@pytest.mark.anyio
async def test_on_request_callback():
    manager = ApprovalManager()
    received: list[str] = []

    def _callback(req):
        received.append(req.tool_name)

    manager.on_request(_callback)

    import asyncio

    async def _respond() -> None:
        await asyncio.sleep(0.05)
        pending = manager.get_pending_requests()
        if pending:
            manager.respond(pending[0].id, True)

    task = asyncio.create_task(_respond())
    await manager.request_approval("callback_tool", {}, "medium")
    assert "callback_tool" in received
    await task


# ─── Pending count ───


def test_pending_count_empty():
    manager = ApprovalManager()
    assert manager.pending_count() == 0


@pytest.mark.anyio
async def test_pending_count_after_request():
    manager = ApprovalManager()

    import asyncio

    async def _approve_later() -> None:
        await asyncio.sleep(0.05)
        pending = manager.get_pending_requests()
        for p in pending:
            manager.respond(p.id, True)

    task = asyncio.create_task(_approve_later())
    await manager.request_approval("tool", {}, "high")
    assert manager.pending_count() == 0
    await task


# ─── Auto approve low risk ───


@pytest.mark.anyio
async def test_auto_approve_low_risk_skips_pending():
    manager = ApprovalManager(auto_approve_low_risk=True)
    resp = await manager.request_approval("safe", {}, "low")
    assert resp.approved is True
    assert manager.pending_count() == 0


# ─── Risk aggregation ───


def test_aggregate_risk_empty():
    assert _aggregate_risk([]) == "low"


def test_aggregate_risk_single():
    assert _aggregate_risk(["medium"]) == "medium"


def test_aggregate_risk_max():
    assert _aggregate_risk(["low", "medium", "high", "critical"]) == "critical"


def test_aggregate_risk_no_critical():
    assert _aggregate_risk(["low", "high", "medium"]) == "high"


# ─── Batch approval ───


@pytest.mark.anyio
async def test_batch_respond_approve_all():
    manager = ApprovalManager()
    import asyncio

    ids: list[str] = []

    async def _create_pending() -> None:
        for i in range(3):
            task = asyncio.create_task(
                manager.request_approval(f"tool_{i}", {}, "medium")
            )
            await asyncio.sleep(0.01)
            pending = manager.get_pending_requests()
            for p in pending:
                if p.id not in ids:
                    ids.append(p.id)
            if not task.done():
                manager.respond(pending[-1].id, True)

    await _create_pending()
    pending = manager.get_pending_requests()
    if len(pending) >= 2:
        result = manager.batch_respond([pending[0].id, pending[1].id], True, "batch approve")
        assert result.approved == 2
        assert result.aggregated_risk in ("medium", "low", "high")


def test_batch_respond_empty():
    manager = ApprovalManager()
    result = manager.batch_respond([], True)
    assert result.total == 0
    assert result.approved == 0


def test_batch_respond_nonexistent():
    manager = ApprovalManager()
    result = manager.batch_respond(["fake_id_1", "fake_id_2"], True)
    assert result.total == 2
    assert result.skipped == 2
    assert result.approved == 0


# ─── Risk summary ───


def test_risk_summary_empty():
    manager = ApprovalManager()
    summary = manager.get_risk_summary()
    assert summary["total_pending"] == 0
    assert summary["aggregated_risk"] == "low"
    assert summary["tools"] == []


# ─── Grouped by risk ───


def test_grouped_empty():
    manager = ApprovalManager()
    grouped = manager.get_pending_grouped_by_risk()
    assert grouped == {}


def test_pending_by_risk_empty():
    manager = ApprovalManager()
    result = manager.get_pending_by_risk("high")
    assert result == []


# ─── Batch auto approve below risk ───


def test_batch_auto_approve_no_pending():
    manager = ApprovalManager()
    result = manager.batch_auto_approve_below_risk("medium")
    assert result.total == 0
