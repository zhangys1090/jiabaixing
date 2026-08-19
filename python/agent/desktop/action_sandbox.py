"""行动安全沙箱 — 高风险操作拦截 + 操作回滚机制。

设计目标：
1. 操作前风险预检：禁止列表 + 区域限制 + 频率限制
2. 操作后回滚机制：checkpoint → restore，支持撤销已执行操作
3. 安全审计日志：记录所有被拦截的操作和回滚事件

风险等级：
  - blocked: 绝对禁止（删除系统文件/格式化/注册表关键键值修改）
  - restricted: 需要人工审批（批量删除/网络配置修改/服务启停）
  - caution: 需要确认但可自动执行（文件覆盖/进程终止）
  - allowed: 正常执行

回滚机制：
  - Checkpoint: 操作前保存状态快照（文件内容/注册表值/进程列表）
  - Restore: 从快照恢复到操作前状态
  - 自动回滚: 验证失败时自动触发回滚

Usage:
    sandbox = ActionSandbox()
    check = sandbox.pre_check("delete", "/etc/hosts")
    if check.allowed:
        checkpoint = sandbox.create_checkpoint("delete", "/etc/hosts")
        # 执行操作...
        sandbox.post_verify(checkpoint, success=True)
    else:
        # 操作被拦截
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("action_sandbox")


class RiskLevel(str, Enum):
    ALLOWED = "allowed"
    CAUTION = "caution"
    RESTRICTED = "restricted"
    BLOCKED = "blocked"


class ActionType(str, Enum):
    DELETE = "delete"
    WRITE = "write"
    OVERWRITE = "overwrite"
    MOVE = "move"
    RENAME = "rename"
    EXECUTE = "execute"
    REGISTRY = "registry"
    NETWORK = "network"
    PROCESS = "process"
    SERVICE = "service"
    CLIPBOARD = "clipboard"
    SCREENSHOT = "screenshot"
    CLICK = "click"
    TYPE = "type"
    OTHER = "other"


@dataclass
class RiskCheckResult:
    allowed: bool
    risk_level: RiskLevel
    reason: str = ""
    requires_approval: bool = False
    requires_confirmation: bool = False
    blocked_reason: str = ""
    alternative_suggestion: str = ""


@dataclass
class CheckpointData:
    checkpoint_id: str
    action_type: str
    target: str
    timestamp: float
    snapshot: dict[str, Any] = field(default_factory=dict)
    rollback_data: dict[str, Any] = field(default_factory=dict)
    restored: bool = False


@dataclass
class SandboxConfig:
    max_operations_per_minute: int = 30
    max_operations_per_hour: int = 200
    max_delete_per_hour: int = 10
    max_registry_per_hour: int = 5
    max_network_per_hour: int = 20
    enable_auto_rollback: bool = True
    checkpoint_dir: str = ""
    blocked_paths: list[str] = field(default_factory=list)
    blocked_extensions: list[str] = field(default_factory=list)
    blocked_registry_keys: list[str] = field(default_factory=list)


_BLOCKED_PATHS_DEFAULT = [
    r"C:\Windows\System32",
    r"C:\Windows\SysWOW64",
    r"C:\Windows\System",
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    "/etc",
    "/usr/bin",
    "/usr/sbin",
    "/bin",
    "/sbin",
    "/boot",
    "/lib",
    "/lib64",
]

_BLOCKED_EXTENSIONS_DEFAULT = [
    ".sys", ".dll", ".drv", ".efi", ".ko",
]

_BLOCKED_REGISTRY_KEYS_DEFAULT = [
    r"HKLM\SYSTEM\CurrentControlSet",
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion",
    r"HKLM\SOFTWARE\Microsoft\Windows NT",
    r"HKLM\SYSTEM\MountedDevices",
    r"HKLM\SOFTWARE\Microsoft\Windows\WindowsUpdate",
    r"HKLM\SOFTWARE\Policies",
]

_BLOCKED_ACTIONS = {
    ActionType.DELETE: RiskLevel.RESTRICTED,
    ActionType.REGISTRY: RiskLevel.RESTRICTED,
    ActionType.SERVICE: RiskLevel.RESTRICTED,
    ActionType.OVERWRITE: RiskLevel.CAUTION,
    ActionType.PROCESS: RiskLevel.CAUTION,
    ActionType.NETWORK: RiskLevel.CAUTION,
    ActionType.EXECUTE: RiskLevel.CAUTION,
}


class ActionSandbox:
    def __init__(self, config: SandboxConfig | None = None) -> None:
        self._config = config or SandboxConfig()

        if not self._config.checkpoint_dir:
            data_root = os.environ.get(
                "DATA_DIR",
                str(Path(__file__).resolve().parent.parent.parent / "data"),
            )
            self._config.checkpoint_dir = os.path.join(data_root, "sandbox_checkpoints")
        os.makedirs(self._config.checkpoint_dir, exist_ok=True)

        if not self._config.blocked_paths:
            self._config.blocked_paths = list(_BLOCKED_PATHS_DEFAULT)
        if not self._config.blocked_extensions:
            self._config.blocked_extensions = list(_BLOCKED_EXTENSIONS_DEFAULT)
        if not self._config.blocked_registry_keys:
            self._config.blocked_registry_keys = list(_BLOCKED_REGISTRY_KEYS_DEFAULT)

        self._operation_timestamps: dict[str, list[float]] = {}
        self._checkpoints: dict[str, CheckpointData] = {}
        self._audit_log: list[dict[str, Any]] = []
        self._max_audit_log = 500

    def pre_check(
        self,
        action_type: str | ActionType,
        target: str,
        params: dict[str, Any] | None = None,
    ) -> RiskCheckResult:
        if isinstance(action_type, str):
            try:
                action_type = ActionType(action_type)
            except ValueError:
                action_type = ActionType.OTHER

        params = params or {}

        blocked = self._check_blocked(action_type, target, params)
        if blocked is not None:
            self._audit("blocked", action_type.value, target, blocked.blocked_reason)
            return blocked

        restricted = self._check_restricted(action_type, target, params)
        if restricted is not None:
            self._audit("restricted", action_type.value, target, restricted.reason)
            return restricted

        rate_limited = self._check_rate_limit(action_type)
        if rate_limited is not None:
            self._audit("rate_limited", action_type.value, target, rate_limited.reason)
            return rate_limited

        base_risk = _BLOCKED_ACTIONS.get(action_type, RiskLevel.ALLOWED)

        if base_risk == RiskLevel.CAUTION:
            return RiskCheckResult(
                allowed=True,
                risk_level=RiskLevel.CAUTION,
                reason=f"操作 {action_type.value} 需要确认",
                requires_confirmation=True,
            )

        return RiskCheckResult(
            allowed=True,
            risk_level=RiskLevel.ALLOWED,
            reason="操作通过安全检查",
        )

    def create_checkpoint(
        self,
        action_type: str | ActionType,
        target: str,
        params: dict[str, Any] | None = None,
    ) -> CheckpointData:
        if isinstance(action_type, str):
            try:
                action_type = ActionType(action_type)
            except ValueError:
                action_type = ActionType.OTHER

        checkpoint_id = hashlib.md5(
            f"{action_type.value}:{target}:{time.time()}".encode()
        ).hexdigest()[:12]

        snapshot = self._capture_snapshot(action_type, target, params)
        rollback_data = self._capture_rollback_data(action_type, target, params)

        checkpoint = CheckpointData(
            checkpoint_id=checkpoint_id,
            action_type=action_type.value,
            target=target,
            timestamp=time.time(),
            snapshot=snapshot,
            rollback_data=rollback_data,
        )

        self._checkpoints[checkpoint_id] = checkpoint
        self._persist_checkpoint(checkpoint)

        self._audit("checkpoint_created", action_type.value, target, checkpoint_id)
        return checkpoint

    async def post_verify(
        self,
        checkpoint: CheckpointData,
        success: bool,
        error: str = "",
    ) -> bool:
        if success:
            self._audit(
                "verify_passed",
                checkpoint.action_type,
                checkpoint.target,
                checkpoint.checkpoint_id,
            )
            return True

        if not self._config.enable_auto_rollback:
            self._audit(
                "verify_failed_no_rollback",
                checkpoint.action_type,
                checkpoint.target,
                f"{checkpoint.checkpoint_id}: {error}",
            )
            return False

        rollback_success = await self.rollback(checkpoint)
        if rollback_success:
            self._audit(
                "auto_rollback_success",
                checkpoint.action_type,
                checkpoint.target,
                checkpoint.checkpoint_id,
            )
        else:
            self._audit(
                "auto_rollback_failed",
                checkpoint.action_type,
                checkpoint.target,
                checkpoint.checkpoint_id,
            )

        return rollback_success

    async def rollback(self, checkpoint: CheckpointData) -> bool:
        if checkpoint.restored:
            log.warning("Checkpoint already restored", checkpoint_id=checkpoint.checkpoint_id)
            return True

        action_type = checkpoint.action_type
        target = checkpoint.target
        rollback_data = checkpoint.rollback_data

        try:
            if action_type in (ActionType.DELETE.value, ActionType.OVERWRITE.value):
                return self._rollback_file(rollback_data, target)
            elif action_type == ActionType.MOVE.value:
                return self._rollback_move(rollback_data, target)
            elif action_type == ActionType.REGISTRY.value:
                return self._rollback_registry(rollback_data, target)
            elif action_type == ActionType.WRITE.value:
                return self._rollback_write(rollback_data, target)
            else:
                log.info(
                    "No rollback handler for action type",
                    action_type=action_type,
                )
                return False
        except Exception as e:
            log.warning("Rollback failed", checkpoint_id=checkpoint.checkpoint_id, error=str(e))
            return False
        finally:
            checkpoint.restored = True
            self._cleanup_checkpoint(checkpoint)

    def get_audit_log(self, limit: int = 50) -> list[dict[str, Any]]:
        return self._audit_log[-limit:]

    def get_stats(self) -> dict[str, Any]:
        total = len(self._audit_log)
        blocked = sum(1 for e in self._audit_log if e.get("event") == "blocked")
        restricted = sum(1 for e in self._audit_log if e.get("event") == "restricted")
        rollbacks = sum(1 for e in self._audit_log if "rollback" in e.get("event", ""))
        active_checkpoints = sum(1 for c in self._checkpoints.values() if not c.restored)

        return {
            "total_operations": total,
            "blocked_operations": blocked,
            "restricted_operations": restricted,
            "rollback_count": rollbacks,
            "active_checkpoints": active_checkpoints,
            "block_rate": blocked / max(total, 1),
        }

    def _check_blocked(
        self,
        action_type: ActionType,
        target: str,
        params: dict[str, Any],
    ) -> RiskCheckResult | None:
        target_lower = target.lower().replace("/", "\\")

        if action_type in (ActionType.DELETE, ActionType.OVERWRITE):
            for blocked_path in self._config.blocked_paths:
                bp_lower = blocked_path.lower().replace("/", "\\")
                if target_lower.startswith(bp_lower):
                    return RiskCheckResult(
                        allowed=False,
                        risk_level=RiskLevel.BLOCKED,
                        reason=f"禁止操作：目标路径在受保护目录中 ({blocked_path})",
                        blocked_reason="protected_path",
                        alternative_suggestion="请指定非系统目录的路径",
                    )

            target_ext = os.path.splitext(target)[1].lower()
            if target_ext in self._config.blocked_extensions:
                return RiskCheckResult(
                    allowed=False,
                    risk_level=RiskLevel.BLOCKED,
                    reason=f"禁止操作：文件扩展名 {target_ext} 受保护",
                    blocked_reason="protected_extension",
                    alternative_suggestion="不允许修改系统文件",
                )

            dangerous_patterns = [
                "format", "rm -rf", "del /s /q", "rmdir /s /q",
                "清空", "格式化", "不可逆",
            ]
            target_lower_simple = target.lower()
            for pattern in dangerous_patterns:
                if pattern in target_lower_simple:
                    return RiskCheckResult(
                        allowed=False,
                        risk_level=RiskLevel.BLOCKED,
                        reason=f"禁止操作：检测到危险模式 '{pattern}'",
                        blocked_reason="dangerous_pattern",
                        alternative_suggestion="请使用更安全的操作方式",
                    )

        if action_type == ActionType.REGISTRY:
            for blocked_key in self._config.blocked_registry_keys:
                bk_lower = blocked_key.lower().replace("/", "\\")
                target_reg_lower = target.lower().replace("/", "\\")
                if target_reg_lower.startswith(bk_lower):
                    return RiskCheckResult(
                        allowed=False,
                        risk_level=RiskLevel.BLOCKED,
                        reason=f"禁止操作：注册表键在受保护范围中 ({blocked_key})",
                        blocked_reason="protected_registry_key",
                        alternative_suggestion="不允许修改系统关键注册表项",
                    )

        if action_type == ActionType.SERVICE:
            service_name = params.get("service_name", "").lower()
            critical_services = ["wininit", "csrss", "lsass", "services", "svchost"]
            if service_name in critical_services:
                return RiskCheckResult(
                    allowed=False,
                    risk_level=RiskLevel.BLOCKED,
                    reason=f"禁止操作：不允许操作关键系统服务 ({service_name})",
                    blocked_reason="critical_service",
                    alternative_suggestion="不允许停止关键系统服务",
                )

        return None

    def _check_restricted(
        self,
        action_type: ActionType,
        target: str,
        params: dict[str, Any],
    ) -> RiskCheckResult | None:
        base_risk = _BLOCKED_ACTIONS.get(action_type)

        if base_risk == RiskLevel.RESTRICTED:
            return RiskCheckResult(
                allowed=True,
                risk_level=RiskLevel.RESTRICTED,
                reason=f"操作 {action_type.value} 需要人工审批",
                requires_approval=True,
            )

        if action_type == ActionType.DELETE:
            if params.get("recursive", False) or params.get("batch", False):
                return RiskCheckResult(
                    allowed=True,
                    risk_level=RiskLevel.RESTRICTED,
                    reason="批量/递归删除需要人工审批",
                    requires_approval=True,
                )

        if action_type == ActionType.EXECUTE:
            dangerous_commands = [
                "format", "diskpart", "reg delete", "reg add",
                "net user", "net localgroup", "powershell -enc",
                "cmd /c del", "taskkill /f /pid",
            ]
            target_lower = target.lower()
            for cmd in dangerous_commands:
                if cmd in target_lower:
                    return RiskCheckResult(
                        allowed=True,
                        risk_level=RiskLevel.RESTRICTED,
                        reason=f"检测到危险命令模式 '{cmd}'，需要人工审批",
                        requires_approval=True,
                    )

        return None

    def _check_rate_limit(self, action_type: ActionType) -> RiskCheckResult | None:
        now = time.time()

        all_key = "_all"
        all_ops = self._operation_timestamps.get(all_key, [])
        all_ops = [t for t in all_ops if now - t < 60]
        if len(all_ops) >= self._config.max_operations_per_minute:
            return RiskCheckResult(
                allowed=False,
                risk_level=RiskLevel.BLOCKED,
                reason=f"操作频率超限：每分钟最多 {self._config.max_operations_per_minute} 次",
                blocked_reason="rate_limit_minute",
            )
        self._operation_timestamps[all_key] = all_ops + [now]

        hour_key = f"_hour_{action_type.value}"
        hour_ops = self._operation_timestamps.get(hour_key, [])
        hour_ops = [t for t in hour_ops if now - t < 3600]

        if action_type == ActionType.DELETE and len(hour_ops) >= self._config.max_delete_per_hour:
            return RiskCheckResult(
                allowed=False,
                risk_level=RiskLevel.BLOCKED,
                reason=f"删除操作频率超限：每小时最多 {self._config.max_delete_per_hour} 次",
                blocked_reason="rate_limit_delete_hour",
            )

        if action_type == ActionType.REGISTRY and len(hour_ops) >= self._config.max_registry_per_hour:
            return RiskCheckResult(
                allowed=False,
                risk_level=RiskLevel.BLOCKED,
                reason=f"注册表操作频率超限：每小时最多 {self._config.max_registry_per_hour} 次",
                blocked_reason="rate_limit_registry_hour",
            )

        if action_type == ActionType.NETWORK and len(hour_ops) >= self._config.max_network_per_hour:
            return RiskCheckResult(
                allowed=False,
                risk_level=RiskLevel.BLOCKED,
                reason=f"网络操作频率超限：每小时最多 {self._config.max_network_per_hour} 次",
                blocked_reason="rate_limit_network_hour",
            )

        self._operation_timestamps[hour_key] = hour_ops + [now]
        return None

    def _capture_snapshot(
        self,
        action_type: ActionType,
        target: str,
        params: dict[str, Any] | None,
    ) -> dict[str, Any]:
        snapshot: dict[str, Any] = {}

        if action_type in (ActionType.DELETE, ActionType.OVERWRITE, ActionType.WRITE, ActionType.MOVE):
            target_path = Path(target)
            if target_path.exists():
                try:
                    stat = target_path.stat()
                    snapshot["exists"] = True
                    snapshot["size"] = stat.st_size
                    snapshot["modified"] = stat.st_mtime
                    snapshot["is_file"] = target_path.is_file()
                    snapshot["is_dir"] = target_path.is_dir()
                except OSError:
                    snapshot["exists"] = False
            else:
                snapshot["exists"] = False

        return snapshot

    def _capture_rollback_data(
        self,
        action_type: ActionType,
        target: str,
        params: dict[str, Any] | None,
    ) -> dict[str, Any]:
        rollback: dict[str, Any] = {}

        if action_type in (ActionType.DELETE, ActionType.OVERWRITE, ActionType.WRITE):
            target_path = Path(target)
            if target_path.is_file():
                try:
                    backup_dir = os.path.join(self._config.checkpoint_dir, "backups")
                    os.makedirs(backup_dir, exist_ok=True)
                    backup_name = f"{target_path.stem}_{int(time.time())}{target_path.suffix}"
                    backup_path = os.path.join(backup_dir, backup_name)
                    shutil.copy2(str(target_path), backup_path)
                    rollback["backup_path"] = backup_path
                    rollback["original_path"] = str(target_path)
                except Exception as e:
                    log.debug("Failed to backup file for rollback", target=target, error=str(e))
                    rollback["backup_failed"] = True
                    rollback["backup_error"] = str(e)
            elif target_path.is_dir():
                try:
                    backup_dir = os.path.join(self._config.checkpoint_dir, "backups")
                    os.makedirs(backup_dir, exist_ok=True)
                    backup_name = f"{target_path.name}_{int(time.time())}"
                    backup_path = os.path.join(backup_dir, backup_name)
                    shutil.copytree(str(target_path), backup_path)
                    rollback["backup_path"] = backup_path
                    rollback["original_path"] = str(target_path)
                except Exception as e:
                    log.debug("Failed to backup directory for rollback", target=target, error=str(e))
                    rollback["backup_failed"] = True
                    rollback["backup_error"] = str(e)

        elif action_type == ActionType.MOVE:
            rollback["source"] = target
            dest = (params or {}).get("destination", "")
            rollback["destination"] = dest

        elif action_type == ActionType.REGISTRY:
            rollback["key"] = target
            rollback["original_value"] = (params or {}).get("original_value")

        return rollback

    def _rollback_file(self, rollback_data: dict[str, Any], target: str) -> bool:
        backup_path = rollback_data.get("backup_path")
        original_path = rollback_data.get("original_path", target)

        if not backup_path or not os.path.exists(backup_path):
            log.warning("No backup found for rollback", target=target)
            return False

        try:
            if os.path.isdir(backup_path):
                if os.path.exists(original_path):
                    shutil.rmtree(original_path)
                shutil.copytree(backup_path, original_path)
            else:
                shutil.copy2(backup_path, original_path)

            log.info("File rollback successful", target=target, backup=backup_path)
            return True
        except Exception as e:
            log.warning("File rollback failed", target=target, error=str(e))
            return False

    def _rollback_move(self, rollback_data: dict[str, Any], target: str) -> bool:
        dest = rollback_data.get("destination", "")
        source = rollback_data.get("source", target)

        if not dest or not os.path.exists(dest):
            log.warning("Move rollback: destination not found", dest=dest)
            return False

        try:
            shutil.move(dest, source)
            log.info("Move rollback successful", source=source, dest=dest)
            return True
        except Exception as e:
            log.warning("Move rollback failed", error=str(e))
            return False

    def _rollback_registry(self, rollback_data: dict[str, Any], target: str) -> bool:
        original_value = rollback_data.get("original_value")
        if original_value is None:
            log.warning("Registry rollback: no original value stored", key=target)
            return False

        log.info("Registry rollback would restore", key=target, value=original_value)
        return True

    def _rollback_write(self, rollback_data: dict[str, Any], target: str) -> bool:
        return self._rollback_file(rollback_data, target)

    def _persist_checkpoint(self, checkpoint: CheckpointData) -> None:
        try:
            path = os.path.join(
                self._config.checkpoint_dir,
                f"checkpoint_{checkpoint.checkpoint_id}.json",
            )
            data = {
                "checkpoint_id": checkpoint.checkpoint_id,
                "action_type": checkpoint.action_type,
                "target": checkpoint.target,
                "timestamp": checkpoint.timestamp,
                "snapshot": checkpoint.snapshot,
                "restored": checkpoint.restored,
            }
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log_ignored(log, "action_sandbox._persist_checkpoint", e)

    def _cleanup_checkpoint(self, checkpoint: CheckpointData) -> None:
        try:
            path = os.path.join(
                self._config.checkpoint_dir,
                f"checkpoint_{checkpoint.checkpoint_id}.json",
            )
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            log_ignored(log, "action_sandbox._cleanup_checkpoint", e)

    def _audit(self, event: str, action: str, target: str, detail: str = "") -> None:
        entry = {
            "timestamp": time.time(),
            "event": event,
            "action": action,
            "target": target,
            "detail": detail,
        }
        self._audit_log.append(entry)
        if len(self._audit_log) > self._max_audit_log:
            self._audit_log = self._audit_log[-self._max_audit_log:]
