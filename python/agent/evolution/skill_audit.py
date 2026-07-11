"""Skill 安全审计（AST 审计）。

对技能代码进行静态安全分析，防止恶意代码执行：
  - AST 解析与规则扫描
  - 危险操作检测（os.system, subprocess, eval, exec 等）
  - 敏感数据访问检测（文件读写、网络请求）
  - 权限声明验证（技能只能使用声明的权限）
  - 审计报告生成（风险等级 + 修复建议）

与 SkillEngine 的关系：
  - SkillEngine 加载技能前先通过安全审计
  - 审计不通过的技能拒绝加载
  - 审计报告可供 Skill Hub 展示

集成示例::

    from agent.evolution.skill_audit import SkillAuditor

    auditor = SkillAuditor()
    report = auditor.audit_file("my_skill/skill.py")
    if report.risk_level == RiskLevel.CRITICAL:
        print("拒绝加载: 存在严重安全风险")
"""

from __future__ import annotations

import ast
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("skill_audit")


class RiskLevel(str, Enum):
    SAFE = "safe"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ViolationType(str, Enum):
    DANGEROUS_CALL = "dangerous_call"
    UNSAFE_IMPORT = "unsafe_import"
    FILE_ACCESS = "file_access"
    NETWORK_ACCESS = "network_access"
    CODE_EXECUTION = "code_execution"
    ENV_ACCESS = "env_access"
    TYPE_CONFUSION = "type_confusion"
    RESOURCE_EXHAUSTION = "resource_exhaustion"


@dataclass
class Violation:
    type: ViolationType
    risk: RiskLevel
    message: str
    line: int = 0
    col: int = 0
    code_snippet: str = ""
    fix_suggestion: str = ""


@dataclass
class AuditReport:
    file_path: str
    violations: list[Violation] = field(default_factory=list)
    risk_level: RiskLevel = RiskLevel.SAFE
    scan_time_ms: float = 0.0
    lines_scanned: int = 0
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()
        if self.violations and self.risk_level == RiskLevel.SAFE:
            self.risk_level = max(v.risk for v in self.violations)

    @property
    def is_safe(self) -> bool:
        return self.risk_level in (RiskLevel.SAFE, RiskLevel.LOW)

    @property
    def summary(self) -> str:
        counts: dict[str, int] = {}
        for v in self.violations:
            counts[v.risk.value] = counts.get(v.risk.value, 0) + 1
        parts = [f"{k}: {v}" for k, v in sorted(counts.items())]
        return f"风险={self.risk.value} | " + " | ".join(parts) if parts else f"风险={self.risk.value} | 无违规"

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_path": self.file_path,
            "risk_level": self.risk_level.value,
            "is_safe": self.is_safe,
            "violations": [
                {
                    "type": v.type.value,
                    "risk": v.risk.value,
                    "message": v.message,
                    "line": v.line,
                    "fix": v.fix_suggestion,
                }
                for v in self.violations
            ],
            "lines_scanned": self.lines_scanned,
            "scan_time_ms": round(self.scan_time_ms, 1),
        }


_DANGEROUS_CALLS: dict[str, tuple[ViolationType, RiskLevel, str]] = {
    "eval": (ViolationType.CODE_EXECUTION, RiskLevel.CRITICAL, "eval() 可执行任意代码"),
    "exec": (ViolationType.CODE_EXECUTION, RiskLevel.CRITICAL, "exec() 可执行任意代码"),
    "compile": (ViolationType.CODE_EXECUTION, RiskLevel.HIGH, "compile() 可编译任意代码"),
    "__import__": (ViolationType.UNSAFE_IMPORT, RiskLevel.HIGH, "__import__() 可导入任意模块"),
    "globals": (ViolationType.TYPE_CONFUSION, RiskLevel.MEDIUM, "globals() 访问全局命名空间"),
    "locals": (ViolationType.TYPE_CONFUSION, RiskLevel.LOW, "locals() 访问局部命名空间"),
    "vars": (ViolationType.TYPE_CONFUSION, RiskLevel.MEDIUM, "vars() 访问对象属性"),
    "getattr": (ViolationType.TYPE_CONFUSION, RiskLevel.LOW, "getattr() 动态属性访问"),
    "setattr": (ViolationType.TYPE_CONFUSION, RiskLevel.MEDIUM, "setattr() 动态属性修改"),
    "delattr": (ViolationType.TYPE_CONFUSION, RiskLevel.MEDIUM, "delattr() 动态属性删除"),
}

_UNSAFE_MODULES: dict[str, tuple[RiskLevel, str]] = {
    "subprocess": (RiskLevel.HIGH, "可执行系统命令"),
    "os": (RiskLevel.MEDIUM, "可访问操作系统功能"),
    "sys": (RiskLevel.LOW, "可访问系统参数"),
    "shutil": (RiskLevel.MEDIUM, "可执行文件操作"),
    "socket": (RiskLevel.HIGH, "可建立网络连接"),
    "http.server": (RiskLevel.HIGH, "可启动 HTTP 服务器"),
    "xml.etree": (RiskLevel.MEDIUM, "XML 解析可能存在 XXE"),
    "pickle": (RiskLevel.CRITICAL, "pickle 反序列化可执行任意代码"),
    "marshal": (RiskLevel.CRITICAL, "marshal 可执行任意代码"),
    "ctypes": (RiskLevel.CRITICAL, "ctypes 可调用 C 函数"),
}

_OS_DANGEROUS: dict[str, RiskLevel] = {
    "system": RiskLevel.CRITICAL,
    "popen": RiskLevel.HIGH,
    "execvp": RiskLevel.CRITICAL,
    "execvpe": RiskLevel.CRITICAL,
    "spawn": RiskLevel.HIGH,
    "remove": RiskLevel.MEDIUM,
    "rmdir": RiskLevel.MEDIUM,
    "unlink": RiskLevel.MEDIUM,
}

_RISK_ORDER = {
    RiskLevel.SAFE: 0,
    RiskLevel.LOW: 1,
    RiskLevel.MEDIUM: 2,
    RiskLevel.HIGH: 3,
    RiskLevel.CRITICAL: 4,
}


class SkillAuditor:
    """技能安全审计器。

    对技能代码进行 AST 级别的静态安全分析。
    """

    def __init__(self, allowed_modules: list[str] | None = None) -> None:
        self._allowed_modules = set(allowed_modules or [])
        self._allowed_files: set[str] = set()

    def set_allowed_modules(self, modules: list[str]) -> None:
        self._allowed_modules = set(modules)

    def set_allowed_files(self, patterns: list[str]) -> None:
        self._allowed_files = set(patterns)

    def audit_code(self, code: str, file_path: str = "<string>") -> AuditReport:
        start = time.monotonic()
        violations: list[Violation] = []

        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            violations.append(Violation(
                type=ViolationType.CODE_EXECUTION,
                risk=RiskLevel.HIGH,
                message=f"语法错误: {e}",
                line=e.lineno or 0,
            ))
            duration = (time.monotonic() - start) * 1000
            return AuditReport(
                file_path=file_path,
                violations=violations,
                risk_level=RiskLevel.HIGH,
                scan_time_ms=duration,
                lines_scanned=code.count("\n") + 1,
            )

        lines_scanned = code.count("\n") + 1
        violations.extend(self._check_imports(tree))
        violations.extend(self._check_calls(tree, code))
        violations.extend(self._check_attribute_access(tree))
        violations.extend(self._check_string_patterns(code))

        risk = RiskLevel.SAFE
        if violations:
            risk = max(violations, key=lambda v: _RISK_ORDER[v.risk]).risk

        duration = (time.monotonic() - start) * 1000
        return AuditReport(
            file_path=file_path,
            violations=violations,
            risk_level=risk,
            scan_time_ms=duration,
            lines_scanned=lines_scanned,
        )

    def audit_file(self, file_path: str | Path) -> AuditReport:
        path = Path(file_path)
        if not path.exists():
            return AuditReport(
                file_path=str(path),
                violations=[Violation(
                    type=ViolationType.FILE_ACCESS,
                    risk=RiskLevel.HIGH,
                    message="文件不存在",
                )],
                risk_level=RiskLevel.HIGH,
            )
        code = path.read_text(encoding="utf-8", errors="replace")
        return self.audit_code(code, str(path))

    def audit_directory(self, dir_path: str | Path) -> list[AuditReport]:
        path = Path(dir_path)
        reports = []
        for py_file in path.rglob("*.py"):
            if py_file.name.startswith("_") and py_file.name == "__init__.py":
                continue
            reports.append(self.audit_file(py_file))
        return reports

    def _check_imports(self, tree: ast.AST) -> list[Violation]:
        violations = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    module = alias.name.split(".")[0]
                    if module in _UNSAFE_MODULES:
                        risk, reason = _UNSAFE_MODULES[module]
                        violations.append(Violation(
                            type=ViolationType.UNSAFE_IMPORT,
                            risk=risk,
                            message=f"不安全导入: {alias.name} ({reason})",
                            line=node.lineno,
                            fix_suggestion=f"移除 {alias.name} 导入或添加到白名单",
                        ))
                    elif self._allowed_modules and module not in self._allowed_modules:
                        violations.append(Violation(
                            type=ViolationType.UNSAFE_IMPORT,
                            risk=RiskLevel.MEDIUM,
                            message=f"未声明导入: {alias.name}",
                            line=node.lineno,
                            fix_suggestion=f"在技能清单中声明依赖: {module}",
                        ))

            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    module = node.module.split(".")[0]
                    if module in _UNSAFE_MODULES:
                        risk, reason = _UNSAFE_MODULES[module]
                        names = ", ".join(a.name for a in node.names)
                        violations.append(Violation(
                            type=ViolationType.UNSAFE_IMPORT,
                            risk=risk,
                            message=f"不安全导入: from {node.module} import {names} ({reason})",
                            line=node.lineno,
                            fix_suggestion=f"移除 {node.module} 导入或添加到白名单",
                        ))
        return violations

    def _check_calls(self, tree: ast.AST, code: str) -> list[Violation]:
        violations = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func_name = self._get_call_name(node)
                if not func_name:
                    continue

                if func_name in _DANGEROUS_CALLS:
                    vtype, risk, msg = _DANGEROUS_CALLS[func_name]
                    violations.append(Violation(
                        type=vtype,
                        risk=risk,
                        message=f"危险调用: {func_name}() - {msg}",
                        line=node.lineno,
                        fix_suggestion=f"避免使用 {func_name}()，使用更安全的替代方案",
                    ))

                if "." in func_name:
                    parts = func_name.rsplit(".", 1)
                    if len(parts) == 2 and parts[0] == "os" and parts[1] in _OS_DANGEROUS:
                        risk = _OS_DANGEROUS[parts[1]]
                        violations.append(Violation(
                            type=ViolationType.DANGEROUS_CALL,
                            risk=risk,
                            message=f"危险 OS 调用: {func_name}()",
                            line=node.lineno,
                            fix_suggestion="使用 agent 提供的安全 API 替代",
                        ))

                    if parts[0] == "subprocess" and len(parts) == 2:
                        violations.append(Violation(
                            type=ViolationType.CODE_EXECUTION,
                            risk=RiskLevel.CRITICAL,
                            message=f"子进程调用: {func_name}()",
                            line=node.lineno,
                            fix_suggestion="使用 agent 提供的工具执行替代",
                        ))

                if func_name in ("open",) and len(node.args) >= 1:
                    if isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                        filepath = node.args[0].value
                        if any(p in filepath for p in ("/etc/", "/proc/", "/sys/", "C:\\Windows")):
                            violations.append(Violation(
                                type=ViolationType.FILE_ACCESS,
                                risk=RiskLevel.HIGH,
                                message=f"访问系统文件: {filepath}",
                                line=node.lineno,
                                fix_suggestion="仅访问技能数据目录内的文件",
                            ))
        return violations

    def _check_attribute_access(self, tree: ast.AST) -> list[Violation]:
        violations = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                if node.attr.startswith("__") and node.attr.endswith("__"):
                    dunder = node.attr
                    if dunder in ("__class__", "__subclasses__", "__bases__", "__mro__"):
                        violations.append(Violation(
                            type=ViolationType.TYPE_CONFUSION,
                            risk=RiskLevel.HIGH,
                            message=f"可疑 dunder 访问: .{dunder}",
                            line=getattr(node, "lineno", 0),
                            fix_suggestion="避免直接访问内部属性",
                        ))
        return violations

    def _check_string_patterns(self, code: str) -> list[Violation]:
        violations = []
        patterns = [
            (r"rm\s+-rf\s+/", RiskLevel.CRITICAL, "危险删除命令: rm -rf /"),
            (r"curl\s+.*\|\s*sh", RiskLevel.CRITICAL, "远程代码执行: curl | sh"),
            (r"wget\s+.*\|\s*sh", RiskLevel.CRITICAL, "远程代码执行: wget | sh"),
            (r"python\s+-c\s+", RiskLevel.HIGH, "内联 Python 执行"),
            (r"chmod\s+777", RiskLevel.HIGH, "不安全权限: chmod 777"),
            (r"sudo\s+", RiskLevel.HIGH, "sudo 提权"),
            (r"DROP\s+TABLE", RiskLevel.HIGH, "SQL 注入风险: DROP TABLE"),
        ]
        for pattern, risk, msg in patterns:
            for match in re.finditer(pattern, code, re.IGNORECASE):
                line = code[:match.start()].count("\n") + 1
                violations.append(Violation(
                    type=ViolationType.CODE_EXECUTION,
                    risk=risk,
                    message=msg,
                    line=line,
                    code_snippet=match.group(),
                    fix_suggestion="移除危险命令或使用安全替代",
                ))
        return violations

    def _get_call_name(self, node: ast.Call) -> str:
        if isinstance(node.func, ast.Name):
            return node.func.id
        if isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name):
                return f"{node.func.value.id}.{node.func.attr}"
            if isinstance(node.func.value, ast.Attribute):
                inner = self._get_attr_chain(node.func.value)
                return f"{inner}.{node.func.attr}" if inner else ""
        return ""

    def _get_attr_chain(self, node: ast.Attribute) -> str:
        if isinstance(node.value, ast.Name):
            return f"{node.value.id}.{node.attr}"
        if isinstance(node.value, ast.Attribute):
            inner = self._get_attr_chain(node.value)
            return f"{inner}.{node.attr}" if inner else ""
        return ""
