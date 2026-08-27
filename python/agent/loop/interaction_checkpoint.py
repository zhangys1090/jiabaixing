"""交互中断与恢复 — 用户中断后从最近检查点恢复执行。

设计目标：
1. 检查点保存：在关键执行节点保存上下文快照
2. 中断检测：检测用户中断信号（取消/超时/异常）
3. 恢复执行：从最近检查点恢复，不丢失上下文和中间结果
4. 状态一致性：恢复后确保执行状态一致

检查点策略：
  - 每个规划步骤完成后自动保存
  - 工具调用前/后保存
  - 反思/验证阶段保存
  - 用户可手动触发保存

恢复策略：
  - 从最近检查点恢复上下文
  - 重新执行当前步骤（幂等工具可直接跳过）
  - 继续后续步骤

Usage:
    checkpoint_mgr = InteractionCheckpoint(data_dir="/path/to/data")
    cp_id = checkpoint_mgr.save("step_3", context, step_results)
    # 用户中断...
    restored = checkpoint_mgr.restore(cp_id)
    if restored:
        context = restored.context
        # 继续执行
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
from agent.core.types import BaseCheckpoint
log = StructuredLogger("interaction_checkpoint")



class CheckpointStatus(str, Enum):
    ACTIVE = "active"
    RESTORED = "restored"
    EXPIRED = "expired"
    CORRUPTED = "corrupted"


@dataclass
class CheckpointData(BaseCheckpoint):
    """交互还原点 — 继承 core.types.BaseCheckpoint。"""

    session_id: str = ""
    step_id: str = ""
    status: CheckpointStatus = CheckpointStatus.ACTIVE

    context_snapshot: dict[str, Any] = field(default_factory=dict)
    step_results: dict[str, Any] = field(default_factory=dict)
    messages: list[dict[str, str]] = field(default_factory=list)
    plan_snapshot: dict[str, Any] = field(default_factory=dict)
    budget_snapshot: dict[str, Any] = field(default_factory=dict)
    perception_snapshot: dict[str, Any] = field(default_factory=dict)

    @property
    def checkpoint_id(self) -> str:
        return self.id


@dataclass
class RestoreResult:
    success: bool
    checkpoint_id: str
    context_snapshot: dict[str, Any] = field(default_factory=dict)
    step_results: dict[str, Any] = field(default_factory=dict)
    messages: list[dict[str, str]] = field(default_factory=list)
    plan_snapshot: dict[str, Any] = field(default_factory=dict)
    budget_snapshot: dict[str, Any] = field(default_factory=dict)
    perception_snapshot: dict[str, Any] = field(default_factory=dict)
    restore_time_ms: float = 0.0
    error: str = ""


class InteractionCheckpoint:
    def __init__(
        self,
        data_dir: str | None = None,
        max_checkpoints: int = 50,
        ttl_seconds: float = 86400.0,
    ) -> None:
        self._data_dir = Path(data_dir) if data_dir else Path(
            os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent.parent / "data"))
        ) / "checkpoints"
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._max_checkpoints = max_checkpoints
        self._ttl_seconds = ttl_seconds

        self._checkpoints: dict[str, CheckpointData] = {}
        self._session_checkpoints: dict[str, list[str]] = {}
        self._counter = 0

        self._load_existing_checkpoints()

    def save(
        self,
        step_id: str,
        context: Any = None,
        step_results: dict[str, Any] | None = None,
        session_id: str = "default",
        plan: Any = None,
        messages: list[dict[str, str]] | None = None,
    ) -> str:
        self._counter += 1
        checkpoint_id = f"cp_{int(time.time())}_{self._counter:04d}"

        context_snapshot = self._serialize_context(context)
        step_results_snapshot = self._serialize_step_results(step_results)
        messages_snapshot = list(messages) if messages else []
        plan_snapshot = self._serialize_plan(plan)
        budget_snapshot = self._serialize_budget(context)
        perception_snapshot = self._serialize_perception(context)

        checkpoint = CheckpointData(
            id=checkpoint_id,
            session_id=session_id,
            step_id=step_id,
            timestamp=time.time(),
            context_snapshot=context_snapshot,
            step_results=step_results_snapshot,
            messages=messages_snapshot,
            plan_snapshot=plan_snapshot,
            budget_snapshot=budget_snapshot,
            perception_snapshot=perception_snapshot,
        )

        self._checkpoints[checkpoint_id] = checkpoint

        if session_id not in self._session_checkpoints:
            self._session_checkpoints[session_id] = []
        self._session_checkpoints[session_id].append(checkpoint_id)

        self._enforce_limits(session_id)
        self._persist_checkpoint(checkpoint)

        log.debug(
            "Checkpoint saved",
            checkpoint_id=checkpoint_id,
            session_id=session_id,
            step_id=step_id,
        )

        return checkpoint_id

    def restore(self, checkpoint_id: str) -> RestoreResult:
        start = time.time()

        checkpoint = self._checkpoints.get(checkpoint_id)
        if not checkpoint:
            persisted = self._load_checkpoint(checkpoint_id)
            if persisted:
                checkpoint = persisted
                self._checkpoints[checkpoint_id] = checkpoint
            else:
                return RestoreResult(
                    success=False,
                    checkpoint_id=checkpoint_id,
                    error=f"Checkpoint {checkpoint_id} not found",
                )

        if checkpoint.status == CheckpointStatus.EXPIRED:
            return RestoreResult(
                success=False,
                checkpoint_id=checkpoint_id,
                error="Checkpoint has expired",
            )

        if time.time() - checkpoint.timestamp > self._ttl_seconds:
            checkpoint.status = CheckpointStatus.EXPIRED
            return RestoreResult(
                success=False,
                checkpoint_id=checkpoint_id,
                error="Checkpoint TTL exceeded",
            )

        checkpoint.status = CheckpointStatus.RESTORED

        restore_time_ms = (time.time() - start) * 1000

        log.info(
            "Checkpoint restored",
            checkpoint_id=checkpoint_id,
            session_id=checkpoint.session_id,
            step_id=checkpoint.step_id,
            restore_time_ms=round(restore_time_ms, 2),
        )

        return RestoreResult(
            success=True,
            checkpoint_id=checkpoint_id,
            context_snapshot=checkpoint.context_snapshot,
            step_results=checkpoint.step_results,
            messages=checkpoint.messages,
            plan_snapshot=checkpoint.plan_snapshot,
            budget_snapshot=checkpoint.budget_snapshot,
            perception_snapshot=checkpoint.perception_snapshot,
            restore_time_ms=restore_time_ms,
        )

    def restore_latest(self, session_id: str = "default") -> RestoreResult:
        cp_ids = self._session_checkpoints.get(session_id, [])
        if not cp_ids:
            return RestoreResult(
                success=False,
                checkpoint_id="",
                error=f"No checkpoints found for session {session_id}",
            )

        for cp_id in reversed(cp_ids):
            cp = self._checkpoints.get(cp_id)
            if cp and cp.status == CheckpointStatus.ACTIVE:
                return self.restore(cp_id)

        return RestoreResult(
            success=False,
            checkpoint_id="",
            error="No active checkpoints found",
        )

    def get_checkpoint_info(self, checkpoint_id: str) -> dict[str, Any] | None:
        cp = self._checkpoints.get(checkpoint_id)
        if not cp:
            return None
        return {
            "checkpoint_id": cp.checkpoint_id,
            "session_id": cp.session_id,
            "step_id": cp.step_id,
            "timestamp": cp.timestamp,
            "status": cp.status.value,
            "num_step_results": len(cp.step_results),
            "num_messages": len(cp.messages),
            "has_plan": bool(cp.plan_snapshot),
            "has_perception": bool(cp.perception_snapshot),
        }

    def list_checkpoints(self, session_id: str | None = None) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []

        if session_id:
            cp_ids = self._session_checkpoints.get(session_id, [])
            for cp_id in cp_ids:
                info = self.get_checkpoint_info(cp_id)
                if info:
                    results.append(info)
        else:
            for cp_id, cp in self._checkpoints.items():
                results.append({
                    "checkpoint_id": cp.checkpoint_id,
                    "session_id": cp.session_id,
                    "step_id": cp.step_id,
                    "timestamp": cp.timestamp,
                    "status": cp.status.value,
                })

        results.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
        return results

    def cleanup_expired(self) -> int:
        now = time.time()
        expired_ids = [
            cp_id for cp_id, cp in self._checkpoints.items()
            if now - cp.timestamp > self._ttl_seconds
        ]

        for cp_id in expired_ids:
            self._checkpoints[cp_id].status = CheckpointStatus.EXPIRED
            self._remove_checkpoint_file(cp_id)

        return len(expired_ids)

    def get_stats(self) -> dict[str, Any]:
        total = len(self._checkpoints)
        active = sum(1 for cp in self._checkpoints.values() if cp.status == CheckpointStatus.ACTIVE)
        restored = sum(1 for cp in self._checkpoints.values() if cp.status == CheckpointStatus.RESTORED)
        expired = sum(1 for cp in self._checkpoints.values() if cp.status == CheckpointStatus.EXPIRED)

        return {
            "total_checkpoints": total,
            "active": active,
            "restored": restored,
            "expired": expired,
            "sessions": len(self._session_checkpoints),
        }

    def _serialize_context(self, context: Any) -> dict[str, Any]:
        if context is None:
            return {}

        snapshot: dict[str, Any] = {}

        for attr in ("state", "perception_state", "current_step_index", "replan_count"):
            if hasattr(context, attr):
                value = getattr(context, attr)
                try:
                    json.dumps(value)
                    snapshot[attr] = value
                except (TypeError, ValueError):
                    snapshot[attr] = str(value)

        return snapshot

    def _serialize_step_results(self, step_results: dict[str, Any] | None) -> dict[str, Any]:
        if not step_results:
            return {}

        serialized: dict[str, Any] = {}
        for key, value in step_results.items():
            try:
                if hasattr(value, "__dict__"):
                    data = {}
                    for attr in ("success", "content", "error", "tool_name", "duration_ms"):
                        if hasattr(value, attr):
                            v = getattr(value, attr)
                            if isinstance(v, str) and len(v) > 500:
                                v = v[:500] + "..."
                            data[attr] = v
                    serialized[key] = data
                else:
                    json.dumps(value)
                    serialized[key] = value
            except (TypeError, ValueError):
                serialized[key] = str(value)[:500]

        return serialized

    def _serialize_plan(self, plan: Any) -> dict[str, Any]:
        if plan is None:
            return {}

        if hasattr(plan, "to_dict"):
            try:
                return plan.to_dict()
            except Exception as _exc:
                log.debug("interaction_checkpoint 异常处理", error=str(_exc))
                log_ignored(log, "interaction_checkpoint.InteractionCheckpoint._serialize_plan", _exc)

        if isinstance(plan, dict):
            return plan

        snapshot: dict[str, Any] = {}
        for attr in ("steps", "goal", "strategy"):
            if hasattr(plan, attr):
                value = getattr(plan, attr)
                try:
                    json.dumps(value)
                    snapshot[attr] = value
                except (TypeError, ValueError):
                    snapshot[attr] = str(value)

        return snapshot

    def _serialize_budget(self, context: Any) -> dict[str, Any]:
        if not context or not hasattr(context, "budget"):
            return {}

        budget = context.budget
        snapshot: dict[str, Any] = {}

        for attr in ("tokens_used", "token_limit", "start_time", "max_duration_ms"):
            if hasattr(budget, attr):
                snapshot[attr] = getattr(budget, attr)

        return snapshot

    def _serialize_perception(self, context: Any) -> dict[str, Any]:
        if not context or not hasattr(context, "perception_state"):
            return {}

        ps = context.perception_state
        if ps is None:
            return {}

        snapshot: dict[str, Any] = {}
        for attr in ("scene", "emotion", "environment"):
            if hasattr(ps, attr):
                value = getattr(ps, attr)
                try:
                    json.dumps(value)
                    snapshot[attr] = value
                except (TypeError, ValueError):
                    snapshot[attr] = str(value)

        return snapshot

    def _enforce_limits(self, session_id: str) -> None:
        cp_ids = self._session_checkpoints.get(session_id, [])
        while len(cp_ids) > self._max_checkpoints:
            oldest_id = cp_ids.pop(0)
            self._checkpoints.pop(oldest_id, None)
            self._remove_checkpoint_file(oldest_id)

    def _persist_checkpoint(self, checkpoint: CheckpointData) -> None:
        try:
            path = self._data_dir / f"{checkpoint.checkpoint_id}.json"
            data = {
                "checkpoint_id": checkpoint.checkpoint_id,
                "session_id": checkpoint.session_id,
                "step_id": checkpoint.step_id,
                "timestamp": checkpoint.timestamp,
                "status": checkpoint.status.value,
                "context_snapshot": checkpoint.context_snapshot,
                "step_results": checkpoint.step_results,
                "messages": checkpoint.messages,
                "plan_snapshot": checkpoint.plan_snapshot,
                "budget_snapshot": checkpoint.budget_snapshot,
                "perception_snapshot": checkpoint.perception_snapshot,
            }
            with open(str(path), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log.debug("interaction_checkpoint 异常处理", error=str(e))
            log_ignored(log, "interaction_checkpoint._persist_checkpoint", e)

    def _load_checkpoint(self, checkpoint_id: str) -> CheckpointData | None:
        try:
            path = self._data_dir / f"{checkpoint_id}.json"
            if not path.exists():
                return None

            with open(str(path), "r", encoding="utf-8") as f:
                data = json.load(f)

            return CheckpointData(
                id=data["checkpoint_id"],
                session_id=data.get("session_id", "default"),
                step_id=data.get("step_id", ""),
                timestamp=data.get("timestamp", 0),
                status=CheckpointStatus(data.get("status", "active")),
                context_snapshot=data.get("context_snapshot", {}),
                step_results=data.get("step_results", {}),
                messages=data.get("messages", []),
                plan_snapshot=data.get("plan_snapshot", {}),
                budget_snapshot=data.get("budget_snapshot", {}),
                perception_snapshot=data.get("perception_snapshot", {}),
            )
        except Exception as e:
            log.debug("interaction_checkpoint 异常处理", error=str(e))
            log_ignored(log, "interaction_checkpoint._load_checkpoint", e)
            return None

    def _load_existing_checkpoints(self) -> None:
        try:
            for path in self._data_dir.glob("cp_*.json"):
                try:
                    with open(str(path), "r", encoding="utf-8") as f:
                        data = json.load(f)
                    cp_id = data.get("checkpoint_id", "")
                    if cp_id:
                        cp = CheckpointData(
                            id=cp_id,
                            session_id=data.get("session_id", "default"),
                            step_id=data.get("step_id", ""),
                            timestamp=data.get("timestamp", 0),
                            status=CheckpointStatus(data.get("status", "active")),
                            context_snapshot=data.get("context_snapshot", {}),
                            step_results=data.get("step_results", {}),
                            messages=data.get("messages", []),
                            plan_snapshot=data.get("plan_snapshot", {}),
                            budget_snapshot=data.get("budget_snapshot", {}),
                            perception_snapshot=data.get("perception_snapshot", {}),
                        )
                        self._checkpoints[cp_id] = cp
                        sid = cp.session_id
                        if sid not in self._session_checkpoints:
                            self._session_checkpoints[sid] = []
                        self._session_checkpoints[sid].append(cp_id)
                except Exception as e:
                    log.debug("interaction_checkpoint 异常处理", error=str(e))
                    log_ignored(log, "interaction_checkpoint._load_existing_checkpoints.loop", e)
                    continue
        except Exception as e:
            log.debug("interaction_checkpoint 异常处理", error=str(e))
            log_ignored(log, "interaction_checkpoint._load_existing_checkpoints", e)

    def _remove_checkpoint_file(self, checkpoint_id: str) -> None:
        try:
            path = self._data_dir / f"{checkpoint_id}.json"
            if path.exists():
                path.unlink()
        except Exception as e:
            log.debug("interaction_checkpoint 异常处理", error=str(e))
            log_ignored(log, "interaction_checkpoint._remove_checkpoint_file", e)
