"""SafetyNet — 安全沙箱统一入口。

整合 CheckpointManager、OperationScope、AutoRollback、AuditTrail、DryRunExecutor
为统一的安全沙箱服务。

核心流程：
1. 操作前：创建还原点 + 预演检查 + 作用域校验
2. 操作中：实时监控作用域违反 + 超时检测
3. 操作后：审计记录 + 自动回滚（如需要）

与 agent_native 的协同：
- agent_native 模型 + SafetyNet → 可自动批准 high 风险操作
- 非 agent_native 模型 → 走传统审批流程

Usage:
    from agent.safety import SafetyNet

    net = SafetyNet()
    async with net.guard(paths=["/project"], label="重构") as ctx:
        # ctx.checkpoint — 还原点信息
        # ctx.scope — 操作作用域
        # 操作失败自动回滚
        await do_something()
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from agent.safety.checkpoint_manager import CheckpointManager, Checkpoint
from agent.safety.operation_scope import OperationScope, ScopeDefinition, ScopeViolation
from agent.safety.auto_rollback import AutoRollback, RollbackPolicy, RollbackRecord
from agent.safety.audit_trail import AuditTrail, AuditEntry
from agent.safety.dry_run_executor import DryRunExecutor, ImpactReport
from agent.core.logger import StructuredLogger

log = StructuredLogger("safety_net")



@dataclass
class GuardContext:
    """guard 上下文 — 在 async with 块内可用。

    Attributes:
        checkpoint: 创建的还原点。
        scope: 操作作用域。
        dry_run: 预演报告（如启用）。
    """

    checkpoint: Checkpoint | None = None
    scope: OperationScope | None = None
    dry_run: ImpactReport | None = None


class SafetyNet:
    """安全沙箱 — 统一入口。

    整合五大组件：
    - CheckpointManager: 还原点管理
    - OperationScope: 操作作用域
    - AutoRollback: 自动回滚
    - AuditTrail: 审计日志
    - DryRunExecutor: 预演执行

    Usage:
        net = SafetyNet()
        async with net.guard(paths=["/project"], label="重构") as ctx:
            # 安全操作...
            pass
    """

    def __init__(
        self,
        checkpoint_manager: CheckpointManager | None = None,
        rollback_policy: RollbackPolicy | None = None,
        scope_definition: ScopeDefinition | None = None,
        audit_trail: AuditTrail | None = None,
        dry_run_enabled: bool = True,
    ) -> None:
        self._cp_mgr = checkpoint_manager or CheckpointManager()
        self._rollback = AutoRollback(self._cp_mgr, rollback_policy)
        self._scope_def = scope_definition
        self._audit = audit_trail or AuditTrail()
        self._dry_run = DryRunExecutor()
        self._dry_run_enabled = dry_run_enabled

    @asynccontextmanager
    async def guard(
        self,
        paths: list[str] | None = None,
        label: str = "",
        trigger: str = "pre-batch",
        scope_definition: ScopeDefinition | None = None,
        dry_run: bool | None = None,
    ) -> AsyncGenerator[GuardContext, None]:
        """安全保护上下文 — 操作前创建还原点，失败时自动回滚。

        Args:
            paths: 需要保护的路径列表。
            label: 还原点标签。
            trigger: 触发原因。
            scope_definition: 操作作用域定义（覆盖实例级定义）。
            dry_run: 是否启用预演（覆盖实例级设置）。

        Yields:
            GuardContext: 包含还原点、作用域、预演报告的上下文。
        """
        ctx = GuardContext()

        scope_def = scope_definition or self._scope_def
        if scope_def:
            ctx.scope = OperationScope(scope_def)

        should_dry_run = dry_run if dry_run is not None else self._dry_run_enabled
        if should_dry_run and paths:
            ctx.dry_run = self._dry_run.preview_batch(
                [{"type": "file_write", "path": p} for p in paths],
                scope=ctx.scope,
            )

        async with self._rollback.guard(paths=paths, label=label, trigger=trigger, scope=ctx.scope) as rollback_guard:
            ctx.checkpoint = rollback_guard.checkpoint
            try:
                yield ctx
            except Exception as _exc:
                log.debug("safety_net 异常处理", error=str(_exc))
                if ctx.checkpoint:
                    self._audit.record(
                        tool_name="safety_net_guard",
                        risk_level="high",
                        result="rolled_back",
                        checkpoint_id=ctx.checkpoint.id,
                        error="操作异常，自动回滚",
                    )
                raise

    def create_checkpoint(
        self,
        paths: list[str] | None = None,
        label: str = "",
        trigger: str = "manual",
    ) -> Checkpoint:
        """手动创建还原点。"""
        return self._cp_mgr.create_checkpoint(paths=paths, label=label, trigger=trigger)

    def restore_checkpoint(self, checkpoint_id: str) -> dict[str, Any]:
        """手动恢复到还原点。"""
        record = self._rollback.manual_rollback(checkpoint_id, reason="手动恢复")
        self._audit.record(
            tool_name="safety_net_restore",
            risk_level="high",
            result="rolled_back" if record.success else "failed",
            checkpoint_id=checkpoint_id,
            rollback_id=record.id,
        )
        return {
            "success": record.success,
            "restored_files": record.restored_files,
            "errors": record.errors,
        }

    def preview_operation(
        self,
        operations: list[dict[str, Any]],
        scope: OperationScope | None = None,
    ) -> ImpactReport:
        """预演操作，返回影响报告。"""
        return self._dry_run.preview_batch(operations, scope=scope)

    def record_audit(
        self,
        tool_name: str,
        params: dict[str, Any] | None = None,
        risk_level: str = "low",
        result: str = "success",
        **kwargs: Any,
    ) -> AuditEntry:
        """记录审计日志。"""
        return self._audit.record(
            tool_name=tool_name,
            params=params,
            risk_level=risk_level,
            result=result,
            **kwargs,
        )

    def query_audit(self, **kwargs: Any) -> list[AuditEntry]:
        """查询审计日志。"""
        return self._audit.query(**kwargs)

    def audit_stats(self, since: float | None = None) -> dict[str, Any]:
        """获取审计统计。"""
        return self._audit.stats(since)

    def list_checkpoints(self, limit: int = 20) -> list[Checkpoint]:
        """列出最近的还原点。"""
        return self._cp_mgr.list_checkpoints(limit)

    def cleanup(self, days: int = 30) -> int:
        """清理过期的还原点。"""
        return self._cp_mgr.cleanup(days)

    @property
    def checkpoint_manager(self) -> CheckpointManager:
        return self._cp_mgr

    @property
    def audit_trail(self) -> AuditTrail:
        return self._audit

    @property
    def rollback_engine(self) -> AutoRollback:
        return self._rollback

    def can_auto_approve(self, risk_level: str, agent_native: bool = False) -> bool:
        """判断是否可以自动批准操作。

        agent_native 模型 + 有还原点 → 可自动批准 high 风险操作。
        非 agent_native 模型 → 仍需审批。

        Args:
            risk_level: 风险等级。
            agent_native: 是否为 agent_native 模型。

        Returns:
            bool: 是否可以自动批准。
        """
        if risk_level in ("low", "medium"):
            return True
        if risk_level == "high" and agent_native:
            return True
        return False
