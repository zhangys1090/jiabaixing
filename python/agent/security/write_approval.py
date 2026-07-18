"""文件写入审批工具。

在 Agent 执行文件写入操作前进行审批检查：
  - 写入路径白名单/黑名单
  - 危险路径检测（系统目录/配置文件）
  - 覆盖保护（已有文件是否允许覆盖）
  - 审批模式（自动/手动/禁用）
  - 审批日志

与 PathSecurity 的关系：
  - PathSecurity 做路径遍历防护
  - WriteApproval 做写入语义审批
  - 两者组合提供完整写入安全

集成示例::

    from agent.security.write_approval import WriteApproval, ApprovalMode

    approval = WriteApproval(mode=ApprovalMode.AUTO)
    result = approval.check_write("/project/src/main.py", content="...")
    if result.approved:
        write_file(result.path, result.content)
    else:
        print(result.reason)
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("write_approval")


class ApprovalMode(str, Enum):
    """审批模式。"""

    AUTO = "auto"
    MANUAL = "manual"
    DISABLED = "disabled"


class WriteVerdict(str, Enum):
    """写入判定。"""

    APPROVED = "approved"
    DENIED = "denied"
    NEEDS_REVIEW = "needs_review"


@dataclass
class WriteCheckResult:
    """写入检查结果。

    Attributes:
        path: 目标路径。
        verdict: 判定。
        reason: 原因。
        risk_level: 风险等级（0-10）。
        approved_path: 审批后的安全路径。
    """

    path: str = ""
    verdict: WriteVerdict = WriteVerdict.DENIED
    reason: str = ""
    risk_level: int = 0
    approved_path: str = ""


@dataclass
class ApprovalEntry:
    """审批日志条目。"""

    path: str = ""
    verdict: WriteVerdict = WriteVerdict.DENIED
    reason: str = ""
    timestamp: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()


DANGEROUS_PATHS: list[str] = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/System",
    "/Library",
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\ProgramData",
]

DANGEROUS_EXTENSIONS: list[str] = [
    ".exe",
    ".bat",
    ".cmd",
    ".ps1",
    ".sh",
    ".dll",
    ".sys",
    ".vbs",
    ".wsf",
]

DANGEROUS_FILENAMES: list[str] = [
    ".env",
    ".ssh",
    ".gitconfig",
    ".npmrc",
    ".pypirc",
    "credentials",
    "secrets",
    "id_rsa",
    "id_ed25519",
]


class WriteApproval:
    """文件写入审批工具。

    在执行文件写入前进行安全审批检查。
    """

    def __init__(
        self,
        mode: ApprovalMode = ApprovalMode.AUTO,
        allowed_dirs: list[str] | None = None,
        blocked_dirs: list[str] | None = None,
        allow_overwrite: bool = True,
        max_risk_level: int = 5,
    ) -> None:
        self._mode = mode
        self._allowed_dirs = allowed_dirs or []
        self._blocked_dirs = blocked_dirs or []
        self._allow_overwrite = allow_overwrite
        self._max_risk_level = max_risk_level
        self._audit: list[ApprovalEntry] = []
        self._max_audit = 500

    @property
    def mode(self) -> ApprovalMode:
        return self._mode

    def check_write(
        self,
        path: str,
        content: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> WriteCheckResult:
        """检查写入操作。

        Args:
            path: 目标路径。
            content: 写入内容。
            metadata: 附加元数据。

        Returns:
            WriteCheckResult 检查结果。
        """
        if self._mode == ApprovalMode.DISABLED:
            result = WriteCheckResult(
                path=path,
                verdict=WriteVerdict.APPROVED,
                approved_path=path,
            )
            self._record(result, metadata)
            return result

        risk = 0
        reasons: list[str] = []

        risk_r, reason_r = self._check_dangerous_path(path)
        risk += risk_r
        if reason_r:
            reasons.append(reason_r)

        risk_e, reason_e = self._check_dangerous_extension(path)
        risk += risk_e
        if reason_e:
            reasons.append(reason_e)

        risk_n, reason_n = self._check_dangerous_filename(path)
        risk += risk_n
        if reason_n:
            reasons.append(reason_n)

        risk_b, reason_b = self._check_blocked_dirs(path)
        risk += risk_b
        if reason_b:
            reasons.append(reason_b)

        risk_w, reason_w = self._check_allowed_dirs(path)
        risk += risk_w
        if reason_w:
            reasons.append(reason_w)

        risk_o, reason_o = self._check_overwrite(path)
        risk += risk_o
        if reason_o:
            reasons.append(reason_o)

        if risk > self._max_risk_level:
            verdict = WriteVerdict.DENIED
        elif risk > self._max_risk_level // 2:
            verdict = WriteVerdict.NEEDS_REVIEW if self._mode == ApprovalMode.MANUAL else WriteVerdict.APPROVED
        else:
            verdict = WriteVerdict.APPROVED

        reason = "; ".join(reasons) if reasons else "OK"

        result = WriteCheckResult(
            path=path,
            verdict=verdict,
            reason=reason,
            risk_level=risk,
            approved_path=path if verdict != WriteVerdict.DENIED else "",
        )
        self._record(result, metadata)
        return result

    def get_audit_log(self, limit: int = 100) -> list[ApprovalEntry]:
        """获取审批日志。"""
        return self._audit[-limit:]

    def _check_dangerous_path(self, path: str) -> tuple[int, str]:
        """检查危险路径。"""
        abs_path = os.path.abspath(path)
        for dp in DANGEROUS_PATHS:
            dp_abs = os.path.abspath(dp)
            if abs_path == dp_abs or abs_path.startswith(dp_abs + os.sep):
                return 8, f"系统目录: {dp}"
        return 0, ""

    def _check_dangerous_extension(self, path: str) -> tuple[int, str]:
        """检查危险扩展名。"""
        _, ext = os.path.splitext(path)
        if ext.lower() in DANGEROUS_EXTENSIONS:
            return 9, f"危险扩展名: {ext}"
        return 0, ""

    def _check_dangerous_filename(self, path: str) -> tuple[int, str]:
        """检查危险文件名。"""
        basename = os.path.basename(path).lower()
        for dn in DANGEROUS_FILENAMES:
            if dn in basename:
                return 7, f"敏感文件: {dn}"
        return 0, ""

    def _check_blocked_dirs(self, path: str) -> tuple[int, str]:
        """检查黑名单目录。"""
        abs_path = os.path.abspath(path)
        for bd in self._blocked_dirs:
            bd_abs = os.path.abspath(bd)
            if abs_path == bd_abs or abs_path.startswith(bd_abs + os.sep):
                return 10, f"黑名单目录: {bd}"
        return 0, ""

    def _check_allowed_dirs(self, path: str) -> tuple[int, str]:
        """检查白名单目录。"""
        if not self._allowed_dirs:
            return 0, ""
        abs_path = os.path.abspath(path)
        for ad in self._allowed_dirs:
            ad_abs = os.path.abspath(ad)
            if abs_path == ad_abs or abs_path.startswith(ad_abs + os.sep):
                return 0, ""
        return 6, "不在白名单目录内"

    def _check_overwrite(self, path: str) -> tuple[int, str]:
        """检查覆盖。"""
        if not self._allow_overwrite and os.path.exists(path):
            return 5, "文件已存在（覆盖保护）"
        return 0, ""

    def _record(self, result: WriteCheckResult, metadata: dict[str, Any] | None) -> None:
        """记录审批日志。"""
        entry = ApprovalEntry(
            path=result.path,
            verdict=result.verdict,
            reason=result.reason,
            metadata=metadata or {},
        )
        self._audit.append(entry)
        if len(self._audit) > self._max_audit:
            self._audit = self._audit[-self._max_audit:]
