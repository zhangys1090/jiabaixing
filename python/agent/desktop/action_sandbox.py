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
import sqlite3
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
from agent.core.types import RiskLevel as CoreRiskLevel, BaseCheckpoint
log = StructuredLogger("action_sandbox")


class ActionRiskLevel(str, Enum):
    """行动沙箱领域风险等级 — 与 core.types.RiskLevel 语义不同。

    ALLOWED/CAUTION/RESTRICTED/BLOCKED 描述操作可执行性，
    而 core.types.RiskLevel 描述风险严重程度。
    通过 to_core_risk_level() 映射到统一 RiskLevel。
    """

    ALLOWED = "allowed"
    CAUTION = "caution"
    RESTRICTED = "restricted"
    BLOCKED = "blocked"


_ACTION_TO_CORE_RISK: dict[ActionRiskLevel, CoreRiskLevel] = {
    ActionRiskLevel.ALLOWED: CoreRiskLevel.LOW,
    ActionRiskLevel.CAUTION: CoreRiskLevel.MEDIUM,
    ActionRiskLevel.RESTRICTED: CoreRiskLevel.HIGH,
    ActionRiskLevel.BLOCKED: CoreRiskLevel.CRITICAL,
}


def to_core_risk_level(level: ActionRiskLevel) -> CoreRiskLevel:
    """将行动沙箱风险等级映射到统一 RiskLevel。"""
    return _ACTION_TO_CORE_RISK.get(level, CoreRiskLevel.MEDIUM)


RiskLevel = ActionRiskLevel


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
class CheckpointData(BaseCheckpoint):
    """沙箱还原点 — 继承 core.types.BaseCheckpoint。"""

    action_type: str = ""
    snapshot: dict[str, Any] = field(default_factory=dict)
    rollback_data: dict[str, Any] = field(default_factory=dict)

    @property
    def checkpoint_id(self) -> str:
        return self.id


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
        self._audit_db: sqlite3.Connection | None = None
        self._init_audit_db()

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
            id=checkpoint_id,
            action_type=action_type.value,
            label=target,
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
            elif action_type == ActionType.EXECUTE.value:
                return self._rollback_process(rollback_data, target)
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
            rollback["original_type"] = (params or {}).get("original_type")
            rollback["value_name"] = (params or {}).get("value_name", "")
            rollback["key_existed"] = (params or {}).get("key_existed", True)

        elif action_type == ActionType.EXECUTE:
            rollback["spawned_pids"] = (params or {}).get("spawned_pids", [])
            rollback["command"] = target

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
        original_type = rollback_data.get("original_type")
        key_existed = rollback_data.get("key_existed", True)

        if not key_existed:
            return self._rollback_registry_delete_key(target)

        if original_value is None:
            log.warning("Registry rollback: no original value stored", key=target)
            return False

        if os.name != "nt":
            log.info("Registry rollback: non-Windows, logging only", key=target, value=original_value)
            return True

        try:
            import winreg
            key_path = target
            hive_map = {
                "HKEY_LOCAL_MACHINE": winreg.HKEY_LOCAL_MACHINE,
                "HKEY_CURRENT_USER": winreg.HKEY_CURRENT_USER,
                "HKEY_CLASSES_ROOT": winreg.HKEY_CLASSES_ROOT,
                "HKEY_USERS": winreg.HKEY_USERS,
            }
            hive_name = key_path.split("\\")[0]
            sub_key = "\\".join(key_path.split("\\")[1:])
            hive = hive_map.get(hive_name)
            if hive is None:
                log.warning("Registry rollback: unsupported hive", hive=hive_name)
                return False

            value_name = rollback_data.get("value_name", "")
            reg_type = winreg.REG_SZ
            if original_type == "REG_DWORD":
                reg_type = winreg.REG_DWORD
                original_value = int(original_value)
            elif original_type == "REG_EXPAND_SZ":
                reg_type = winreg.REG_EXPAND_SZ
            elif original_type == "REG_MULTI_SZ":
                reg_type = winreg.REG_MULTI_SZ

            try:
                hkey = winreg.OpenKey(hive, sub_key, 0, winreg.KEY_SET_VALUE)
                winreg.SetValueEx(hkey, value_name, 0, reg_type, original_value)
                winreg.CloseKey(hkey)
                log.info("Registry rollback successful", key=target, value_name=value_name)
                return True
            except OSError as e:
                log.warning("Registry rollback: failed to set value", key=target, error=str(e))
                return False

        except ImportError:
            log.info("Registry rollback: winreg not available, logging only", key=target, value=original_value)
            return True

    def _rollback_registry_delete_key(self, target: str) -> bool:
        """回滚注册表键删除：删除被创建的键。"""
        if os.name != "nt":
            return True
        try:
            import winreg
            key_path = target
            hive_map = {
                "HKEY_LOCAL_MACHINE": winreg.HKEY_LOCAL_MACHINE,
                "HKEY_CURRENT_USER": winreg.HKEY_CURRENT_USER,
                "HKEY_CLASSES_ROOT": winreg.HKEY_CLASSES_ROOT,
                "HKEY_USERS": winreg.HKEY_USERS,
            }
            hive_name = key_path.split("\\")[0]
            sub_key = "\\".join(key_path.split("\\")[1:])
            hive = hive_map.get(hive_name)
            if hive is None:
                return False
            try:
                winreg.DeleteKey(hive, sub_key)
                log.info("Registry key deleted for rollback", key=target)
                return True
            except OSError as e:
                log.warning("Registry key delete failed", key=target, error=str(e))
                return False
        except ImportError:
            return True

    def _rollback_write(self, rollback_data: dict[str, Any], target: str) -> bool:
        return self._rollback_file(rollback_data, target)

    def _rollback_process(self, rollback_data: dict[str, Any], target: str) -> bool:
        """Rollback process operation: terminate spawned child processes."""
        spawned_pids = rollback_data.get("spawned_pids", [])
        if not spawned_pids:
            log.info("Process rollback: no spawned PIDs recorded", command=target)
            return True

        terminated = 0
        for pid in spawned_pids:
            try:
                if os.name == "nt":
                    import ctypes
                    kernel32 = ctypes.windll.kernel32
                    PROCESS_TERMINATE = 0x0001
                    handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
                    if handle:
                        kernel32.TerminateProcess(handle, 1)
                        kernel32.CloseHandle(handle)
                        terminated += 1
                    else:
                        log.debug("Process rollback: PID not found", pid=pid)
                else:
                    import signal
                    os.kill(pid, signal.SIGTERM)
                    terminated += 1
            except (ProcessLookupError, PermissionError, OSError) as e:
                log.debug("Process rollback: failed to terminate PID", pid=pid, error=str(e))

        log.info("Process rollback completed", command=target, terminated=terminated, total=len(spawned_pids))
        return terminated > 0 or not spawned_pids

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
            log.debug("action_sandbox 异常处理", error=str(e))
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
            log.debug("action_sandbox 异常处理", error=str(e))
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
        self._persist_audit_entry(entry)

    def _init_audit_db(self) -> None:
        try:
            db_path = os.path.join(self._config.checkpoint_dir, "audit_log.db")
            self._audit_db = sqlite3.connect(db_path, check_same_thread=False)
            self._audit_db.execute(
                """CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL NOT NULL,
                    event TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target TEXT NOT NULL,
                    detail TEXT NOT NULL DEFAULT ''
                )"""
            )
            self._audit_db.execute(
                "CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event)"
            )
            self._audit_db.execute(
                "CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)"
            )
            self._audit_db.commit()
        except Exception as e:
            log.debug("action_sandbox 异常处理", error=str(e))
            log_ignored(log, "action_sandbox._init_audit_db", e)
            self._audit_db = None

    def _persist_audit_entry(self, entry: dict[str, Any]) -> None:
        if not self._audit_db:
            return
        try:
            self._audit_db.execute(
                "INSERT INTO audit_log (timestamp, event, action, target, detail) VALUES (?, ?, ?, ?, ?)",
                (entry["timestamp"], entry["event"], entry["action"], entry["target"], entry.get("detail", "")),
            )
            self._audit_db.commit()
        except Exception as e:
            log.debug("action_sandbox 异常处理", error=str(e))
            log_ignored(log, "action_sandbox._persist_audit_entry", e)

    def query_audit_db(
        self,
        event: str | None = None,
        action: str | None = None,
        since: float | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        if not self._audit_db:
            return []
        try:
            clauses = []
            params: list[Any] = []
            if event:
                clauses.append("event = ?")
                params.append(event)
            if action:
                clauses.append("action = ?")
                params.append(action)
            if since:
                clauses.append("timestamp >= ?")
                params.append(since)
            where = " AND ".join(clauses)
            sql = f"SELECT timestamp, event, action, target, detail FROM audit_log"
            if where:
                sql += f" WHERE {where}"
            sql += " ORDER BY timestamp DESC LIMIT ?"
            params.append(limit)
            rows = self._audit_db.execute(sql, params).fetchall()
            return [
                {"timestamp": r[0], "event": r[1], "action": r[2], "target": r[3], "detail": r[4]}
                for r in rows
            ]
        except Exception as e:
            log.debug("action_sandbox 异常处理", error=str(e))
            log_ignored(log, "action_sandbox.query_audit_db", e)
            return []

    def close(self) -> None:
        if self._audit_db:
            try:
                self._audit_db.close()
            except Exception:
                pass
            self._audit_db = None

    async def integrate_with_sandbox_audit(self) -> dict[str, Any]:
        """L7: 与沙箱审计子代理集成 — 将 ActionSandbox 审计数据注入沙箱审计报告。

        Returns:
            集成结果摘要
        """
        result: dict[str, Any] = {
            "sandbox_stats": self.get_stats(),
            "recent_blocked": [],
            "recent_rollbacks": [],
        }
        try:
            blocked_entries = self.query_audit_db(event="blocked", limit=10)
            result["recent_blocked"] = blocked_entries

            rollback_entries = self.query_audit_db(event="auto_rollback_success", limit=10)
            rollback_failed = self.query_audit_db(event="auto_rollback_failed", limit=10)
            result["recent_rollbacks"] = rollback_entries + rollback_failed
        except Exception as e:
            log.debug("action_sandbox 异常处理", error=str(e))
            log_ignored(log, "action_sandbox.integrate_with_sandbox_audit", e)
        return result
