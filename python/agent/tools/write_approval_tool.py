"""写入审批工具——文件写入操作的审批管理。

在高风险文件操作（创建/修改/删除/重命名）前请求用户审批，
支持自动审批低风险路径和检测高风险路径模式。
WriteApprovalManager 可独立使用，不依赖 AgentEngine。

Usage:
    from agent.tools.write_approval_tool import register_write_approval_tool
    register_write_approval_tool(registry)
"""
from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
    ToolRegistry,
)


# ==================== 数据模型 ====================


class WriteAction(str, Enum):
    """写入操作类型枚举。

    Attributes:
        CREATE: 创建文件。
        MODIFY: 修改文件。
        DELETE: 删除文件。
        RENAME: 重命名文件。
    """

    CREATE = "create"
    MODIFY = "modify"
    DELETE = "delete"
    RENAME = "rename"


@dataclass
class ApprovalRequest:
    """写入审批请求。

    Attributes:
        id: 请求唯一标识。
        action: 写入操作类型。
        target_path: 目标文件路径。
        description: 操作描述。
        risk_level: 风险等级（low/medium/high）。
        created_at: 创建时间戳。
        status: 当前状态（pending/approved/denied）。
        deny_reason: 拒绝原因。
    """

    id: str = ""
    action: str = ""
    target_path: str = ""
    description: str = ""
    risk_level: str = "low"
    created_at: float = 0.0
    status: str = "pending"
    deny_reason: str = ""


# ==================== 路径模式 ====================

# 自动审批的路径后缀模式（低风险、可安全写入）
AUTO_APPROVE_PATTERNS: list[str] = [
    r"\.log$",
    r"\.tmp$",
    r"\.temp$",
    r"\.bak$",
    r"\.cache$",
    r"__pycache__[/\\]",
    r"\.pyc$",
    r"/tmp/",
    r"\\temp\\",
    r"\.git[/\\]objects",
]

# 高风险路径模式（需严格审批）
HIGH_RISK_PATTERNS: list[str] = [
    r"\.env",
    r"\.env\.",
    r"credentials",
    r"id_rsa",
    r"id_ed25519",
    r"\.pem$",
    r"\.key$",
    r"\.p12$",
    r"\.pfx$",
    r"authorized_keys",
    r"shadow$",
    r"passwd$",
    r"sudoers",
    r"\.ssh[/\\]",
    r"\.gnupg[/\\]",
    r"\.aws[/\\]credentials",
]


# ==================== WriteApprovalManager ====================


class WriteApprovalManager:
    """写入审批管理器。

    管理文件写入操作的审批流程，支持自动审批安全路径、
    高风险路径检测和用户交互式审批。可独立使用，不依赖 AgentEngine。

    Usage:
        mgr = WriteApprovalManager()
        req = mgr.request_approval("modify", "/path/to/file.py", "修改配置")
        if mgr.should_auto_approve("modify", "/path/to/file.log"):
            # 自动批准
            mgr.approve(req.id)
    """

    def __init__(self) -> None:
        self._requests: dict[str, ApprovalRequest] = {}
        self._auto_compile_patterns()

    def _auto_compile_patterns(self) -> None:
        """预编译路径匹配正则表达式。"""
        self._auto_approve_re: list[re.Pattern[str]] = [
            re.compile(p, re.IGNORECASE) for p in AUTO_APPROVE_PATTERNS
        ]
        self._high_risk_re: list[re.Pattern[str]] = [
            re.compile(p, re.IGNORECASE) for p in HIGH_RISK_PATTERNS
        ]

    def request_approval(
        self,
        action: str,
        target_path: str,
        description: str = "",
        risk_level: str = "low",
    ) -> ApprovalRequest:
        """创建写入审批请求。

        Args:
            action: 写入操作类型（create/modify/delete/rename）。
            target_path: 目标文件路径。
            description: 操作描述。
            risk_level: 风险等级（low/medium/high）。

        Returns:
            ApprovalRequest: 创建的审批请求。

        Raises:
            ValueError: action 不合法时抛出。
        """
        valid_actions = [a.value for a in WriteAction]
        if action not in valid_actions:
            raise ValueError(f"无效操作: {action}，有效值: {valid_actions}")

        # 自动判断风险等级
        effective_risk = risk_level
        if self._is_high_risk_path(target_path):
            effective_risk = "high"

        # 自动审批检查
        if self.should_auto_approve(action, target_path):
            req = ApprovalRequest(
                id=uuid.uuid4().hex[:12],
                action=action,
                target_path=target_path,
                description=description,
                risk_level=effective_risk,
                created_at=time.time(),
                status="approved",
            )
            self._requests[req.id] = req
            return req

        req = ApprovalRequest(
            id=uuid.uuid4().hex[:12],
            action=action,
            target_path=target_path,
            description=description,
            risk_level=effective_risk,
            created_at=time.time(),
            status="pending",
        )
        self._requests[req.id] = req
        return req

    def approve(self, request_id: str) -> bool:
        """批准审批请求。

        Args:
            request_id: 审批请求 ID。

        Returns:
            bool: 是否成功批准。
        """
        req = self._requests.get(request_id)
        if req is None or req.status != "pending":
            return False
        req.status = "approved"
        return True

    def deny(self, request_id: str, reason: str = "") -> bool:
        """拒绝审批请求。

        Args:
            request_id: 审批请求 ID。
            reason: 拒绝原因。

        Returns:
            bool: 是否成功拒绝。
        """
        req = self._requests.get(request_id)
        if req is None or req.status != "pending":
            return False
        req.status = "denied"
        req.deny_reason = reason
        return True

    def get_pending(self) -> list[ApprovalRequest]:
        """获取所有待审批请求。

        Returns:
            list[ApprovalRequest]: 待审批请求列表。
        """
        return [r for r in self._requests.values() if r.status == "pending"]

    def is_approved(self, request_id: str) -> bool:
        """检查指定请求是否已批准。

        Args:
            request_id: 审批请求 ID。

        Returns:
            bool: 是否已批准。
        """
        req = self._requests.get(request_id)
        return req is not None and req.status == "approved"

    def should_auto_approve(self, action: str, path: str) -> bool:
        """判断是否应自动审批。

        自动审批条件：低风险操作 + 路径匹配自动审批模式。
        高风险路径永远不自动审批。

        Args:
            action: 写入操作类型。
            path: 目标文件路径。

        Returns:
            bool: 是否应自动审批。
        """
        # 高风险路径不自动审批
        if self._is_high_risk_path(path):
            return False

        # DELETE 操作不自动审批
        if action == WriteAction.DELETE.value:
            return False

        # 匹配自动审批模式
        return any(pattern.search(path) for pattern in self._auto_approve_re)

    def _is_high_risk_path(self, path: str) -> bool:
        """判断路径是否为高风险。

        Args:
            path: 文件路径。

        Returns:
            bool: 是否为高风险路径。
        """
        return any(pattern.search(path) for pattern in self._high_risk_re)


# ==================== 全局单例 ====================

_global_write_approval_manager: WriteApprovalManager | None = None


def _get_write_approval_manager() -> WriteApprovalManager:
    """获取全局 WriteApprovalManager 单例。

    Returns:
        WriteApprovalManager: 全局唯一的 WriteApprovalManager 实例。
    """
    global _global_write_approval_manager
    if _global_write_approval_manager is None:
        _global_write_approval_manager = WriteApprovalManager()
    return _global_write_approval_manager


# ==================== 工具定义 ====================

WRITE_APPROVAL_DEF = ToolDefinition(
    name="write_approval",
    description=(
        "写入审批工具——文件写入操作前的审批管理。"
        "支持请求审批、批准/拒绝、查看待审批列表、检查审批状态。"
        "自动审批安全路径（.log/.tmp等），高风险路径（.env/credentials等）需用户确认。"
        "适用场景：文件创建/修改/删除/重命名前的安全检查。不适用：只读操作。"
    ),
    short_desc="写入操作审批",
    category=ToolCategory.COGNITION,
    tags=["approval", "write", "safety", "file"],
    scenes=["coding", "development", "work"],
    capability_level=2,
    parameters=[
        ToolParameterDef(
            name="action",
            type="string",
            required=True,
            description="操作类型",
            enum=["request", "approve", "deny", "list", "check"],
        ),
        ToolParameterDef(
            name="target_path",
            type="string",
            required=False,
            description="目标文件路径（request 时使用）",
        ),
        ToolParameterDef(
            name="description",
            type="string",
            required=False,
            description="操作描述（request 时使用）",
        ),
        ToolParameterDef(
            name="request_id",
            type="string",
            required=False,
            description="审批请求 ID（approve/deny/check 时使用）",
        ),
        ToolParameterDef(
            name="reason",
            type="string",
            required=False,
            description="拒绝原因（deny 时使用）",
        ),
    ],
    risk_level="low",
)


# ==================== 执行器 ====================


async def write_approval_executor(params: dict[str, Any]) -> ToolResult:
    """执行写入审批工具操作。

    Args:
        params: 工具参数字典，包含 action 及对应参数。

    Returns:
        ToolResult: 操作结果。
    """
    start = time.time()
    action = str(params.get("action", "")).strip()
    mgr = _get_write_approval_manager()

    if action == "request":
        target_path = str(params.get("target_path", "")).strip()
        description = str(params.get("description", "")).strip()
        if not target_path:
            return ToolResult(
                success=False, error="请求审批需要提供 target_path",
                duration=time.time() - start,
            )

        # 判断写入操作类型：默认 modify
        write_action = str(params.get("write_action", "modify")).strip()

        try:
            req = mgr.request_approval(write_action, target_path, description)
        except ValueError as e:
            return ToolResult(success=False, error=str(e), duration=time.time() - start)

        if req.status == "approved":
            return ToolResult(
                success=True,
                output=f"✅ 自动审批通过 [{req.id}]: {write_action} {target_path}",
                duration=time.time() - start,
                metadata={
                    "request_id": req.id,
                    "auto_approved": True,
                    "risk_level": req.risk_level,
                },
            )

        # 需要用户确认
        risk_label = {"low": "🟢低", "medium": "🟡中", "high": "🔴高"}.get(
            req.risk_level, "🟡中"
        )
        output = (
            f"⚠️ 需要审批 [{req.id}]: {write_action} {target_path}\n"
            f"  风险等级: {risk_label}\n"
            f"  描述: {description or '无'}\n"
            f"  状态: 等待用户确认\n\n"
            f"请使用 write_approval(action='approve', request_id='{req.id}') 批准\n"
            f"或 write_approval(action='deny', request_id='{req.id}') 拒绝"
        )
        return ToolResult(
            success=True,
            output=output,
            duration=time.time() - start,
            metadata={
                "request_id": req.id,
                "auto_approved": False,
                "wait_for_user_response": True,
                "risk_level": req.risk_level,
            },
        )

    elif action == "approve":
        request_id = str(params.get("request_id", "")).strip()
        if not request_id:
            return ToolResult(
                success=False, error="批准操作需要提供 request_id",
                duration=time.time() - start,
            )
        ok = mgr.approve(request_id)
        if not ok:
            return ToolResult(
                success=False, error=f"无法批准请求: {request_id}（不存在或已处理）",
                duration=time.time() - start,
            )
        return ToolResult(
            success=True,
            output=f"✅ 已批准请求: {request_id}",
            duration=time.time() - start,
        )

    elif action == "deny":
        request_id = str(params.get("request_id", "")).strip()
        reason = str(params.get("reason", "")).strip()
        if not request_id:
            return ToolResult(
                success=False, error="拒绝操作需要提供 request_id",
                duration=time.time() - start,
            )
        ok = mgr.deny(request_id, reason)
        if not ok:
            return ToolResult(
                success=False, error=f"无法拒绝请求: {request_id}（不存在或已处理）",
                duration=time.time() - start,
            )
        return ToolResult(
            success=True,
            output=f"❌ 已拒绝请求: {request_id}" + (f"，原因: {reason}" if reason else ""),
            duration=time.time() - start,
        )

    elif action == "list":
        pending = mgr.get_pending()
        if not pending:
            return ToolResult(
                success=True, output="暂无待审批请求",
                duration=time.time() - start,
            )
        lines: list[str] = []
        for req in pending:
            risk_label = {"low": "🟢低", "medium": "🟡中", "high": "🔴高"}.get(
                req.risk_level, "🟡中"
            )
            lines.append(
                f"  ⏳ [{req.id}] {req.action} {req.target_path} ({risk_label})"
            )
        return ToolResult(
            success=True,
            output="待审批请求:\n" + "\n".join(lines),
            duration=time.time() - start,
            metadata={"count": len(pending)},
        )

    elif action == "check":
        request_id = str(params.get("request_id", "")).strip()
        if not request_id:
            return ToolResult(
                success=False, error="检查操作需要提供 request_id",
                duration=time.time() - start,
            )
        approved = mgr.is_approved(request_id)
        status_text = "已批准 ✅" if approved else "未批准 ❌"
        return ToolResult(
            success=True,
            output=f"请求 {request_id}: {status_text}",
            duration=time.time() - start,
            metadata={"request_id": request_id, "approved": approved},
        )

    else:
        return ToolResult(
            success=False,
            error=f"未知操作: {action}，有效值: request/approve/deny/list/check",
            duration=time.time() - start,
        )


# ==================== 注册函数 ====================


def register_write_approval_tool(registry: ToolRegistry) -> None:
    """注册 write_approval 工具到工具注册中心。

    Args:
        registry: 工具注册中心实例。
    """
    registry.register(WRITE_APPROVAL_DEF, write_approval_executor)
