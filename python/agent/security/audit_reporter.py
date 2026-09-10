"""安全审计报告生成器（SecurityAuditReporter）。

自动化安全审计，扫描配置、检查漏洞、评估风险，生成结构化审计报告。

审计维度:
- 配置安全: 检查环境变量、密钥管理、敏感配置外泄
- 依赖安全: 检查已知漏洞（OSV集成）
- 输出安全: 检查敏感信息泄露、输出护栏有效性
- 路径安全: 检查路径穿越、文件访问控制
- 网络安全: 检查URL安全、SSL证书验证

Usage:
    from agent.security.audit_reporter import SecurityAuditReporter

    reporter = SecurityAuditReporter()
    report = reporter.run_audit()
    print(report.severity)  # LOW / MEDIUM / HIGH / CRITICAL
    print(report.findings)  # 审计发现列表
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.types import RiskLevel, BaseAuditFinding, BaseAuditReport
from enum import Enum


Severity = RiskLevel


class AuditDimension(str, Enum):
    """审计维度。"""

    CONFIG = "config"
    DEPENDENCY = "dependency"
    OUTPUT = "output"
    PATH = "path"
    NETWORK = "network"


@dataclass
class AuditFinding(BaseAuditFinding):
    """安全审计发现 — 继承 core.types.BaseAuditFinding。

    扩展字段：
        id: 发现ID。
        dimension: 审计维度。
        title: 发现标题。
        recommendation: 修复建议（覆盖基类 remediation）。
        evidence: 证据。
    """

    id: str = ""
    dimension: AuditDimension = AuditDimension.CONFIG
    title: str = ""
    recommendation: str = ""
    evidence: str = ""


@dataclass
class AuditReport(BaseAuditReport):
    """安全审计报告 — 继承 core.types.BaseAuditReport。

    扩展字段：
        report_id: 报告ID。
        severity: 整体严重级别（取最高）。
        total_findings: 发现总数。
        dimensions_checked: 已检查的维度。
        pass_count: 通过的检查数。
        fail_count: 失败/警告的检查数。
    """

    report_id: str = ""
    severity: RiskLevel = RiskLevel.LOW
    total_findings: int = 0
    dimensions_checked: list[str] = field(default_factory=list)
    pass_count: int = 0
    fail_count: int = 0


class SecurityAuditReporter:
    """安全审计报告生成器。

    自动化安全审计，扫描配置、检查漏洞、评估风险。
    """

    _SENSITIVE_ENV_KEYS = {
        "API_KEY", "SECRET", "PASSWORD", "TOKEN", "CREDENTIAL",
        "PRIVATE_KEY", "ACCESS_KEY", "AUTH",
    }

    _SENSITIVE_ENV_PATTERNS = [
        re.compile(r"(?i).*(api[_-]?key|secret|password|token|credential|private[_-]?key|access[_-]?key).*"),
        re.compile(r"(?i).*(AWS_|GCP_|AZURE_|OPENAI_|ANTHROPIC_|GEMINI_).*"),
    ]

    _DANGEROUS_CONFIG_PATTERNS = [
        (re.compile(r"(?i)allow_unsafe|disable_safety|debug_mode|no_verify"), "安全功能被禁用"),
        (re.compile(r"(?i)hardcoded|embedded.*key|inline.*secret"), "硬编码密钥"),
        (re.compile(r"(?i)0\.0\.0\.0|all_origins|allow_all"), "过于宽松的访问控制"),
    ]

    def __init__(self) -> None:
        self._findings: list[AuditFinding] = []
        self._MAX_FINDINGS = 5000
        self._finding_counter = 0

    def run_audit(
        self,
        dimensions: list[AuditDimension] | None = None,
        env_vars: dict[str, str] | None = None,
        config_values: dict[str, Any] | None = None,
    ) -> AuditReport:
        """执行完整安全审计。

        Args:
            dimensions: 审计维度列表，默认全部。
            env_vars: 环境变量字典，默认读取 os.environ。
            config_values: 配置值字典。

        Returns:
            AuditReport: 审计报告。
        """
        self._findings = []
        self._finding_counter = 0

        if dimensions is None:
            dimensions = list(AuditDimension)

        if env_vars is None:
            env_vars = dict(os.environ)

        if config_values is None:
            config_values = {}

        dim_names = []
        for dim in dimensions:
            dim_names.append(dim.value)
            if dim == AuditDimension.CONFIG:
                self._audit_config(env_vars, config_values)
            elif dim == AuditDimension.DEPENDENCY:
                self._audit_dependency()
            elif dim == AuditDimension.OUTPUT:
                self._audit_output()
            elif dim == AuditDimension.PATH:
                self._audit_path(config_values)
            elif dim == AuditDimension.NETWORK:
                self._audit_network(config_values)

        severity_order = {Severity.LOW: 0, Severity.MEDIUM: 1, Severity.HIGH: 2, Severity.CRITICAL: 3}
        overall_severity = Severity.LOW
        if self._findings:
            overall_severity = max(self._findings, key=lambda f: severity_order[f.severity]).severity

        fail_count = len(self._findings)
        pass_count = sum(1 for _ in dimensions) - len(set(f.dimension for f in self._findings))
        pass_count = max(0, pass_count) + len(dimensions)

        return AuditReport(
            report_id=f"audit-{int(time.time())}",
            generated_at=time.time(),
            severity=overall_severity,
            total_findings=len(self._findings),
            findings=self._findings,
            dimensions_checked=dim_names,
            pass_count=pass_count,
            fail_count=fail_count,
        )

    def _next_id(self) -> str:
        self._finding_counter += 1
        return f"FIND-{self._finding_counter:04d}"

    def _audit_config(self, env_vars: dict[str, str], config_values: dict[str, Any]) -> None:
        unmasked_sensitive = []
        for key, value in env_vars.items():
            for pattern in self._SENSITIVE_ENV_PATTERNS:
                if pattern.match(key) and value:
                    unmasked_sensitive.append(key)
                    break

        if unmasked_sensitive:
            self._findings.append(AuditFinding(
                id=self._next_id(),
                dimension=AuditDimension.CONFIG,
                severity=Severity.MEDIUM,
                title="环境变量中存在未脱敏的敏感密钥",
                description=f"检测到 {len(unmasked_sensitive)} 个敏感环境变量: {', '.join(unmasked_sensitive[:5])}",
                recommendation="使用密钥管理服务（如Vault/AWS Secrets Manager）存储敏感值，环境变量中仅存放引用",
                evidence=f"keys: {', '.join(unmasked_sensitive[:5])}",
            ))

        if config_values:
            for key, value in config_values.items():
                if isinstance(value, str):
                    for pattern, desc in self._DANGEROUS_CONFIG_PATTERNS:
                        if pattern.search(key) and pattern.search(value):
                            self._findings.append(AuditFinding(
                                id=self._next_id(),
                                dimension=AuditDimension.CONFIG,
                                severity=Severity.HIGH,
                                title=f"危险配置: {desc}",
                                description=f"配置项 '{key}' 匹配危险模式: {desc}",
                                recommendation="禁用危险配置或使用安全替代方案",
                                evidence=f"config: {key}",
                            ))

    def _audit_dependency(self) -> None:
        self._findings.append(AuditFinding(
            id=self._next_id(),
            dimension=AuditDimension.DEPENDENCY,
            severity=Severity.LOW,
            title="依赖安全扫描",
            description="依赖安全扫描需要集成 OSV/Trivy 等外部工具。当前为占位检查，建议在生产环境集成完整扫描。",
            recommendation="集成 OSV API 或 Trivy 进行自动化依赖漏洞扫描",
            evidence="",
        ))

    def _audit_output(self) -> None:
        self._findings.append(AuditFinding(
            id=self._next_id(),
            dimension=AuditDimension.OUTPUT,
            severity=Severity.LOW,
            title="输出护栏检查",
            description="输出护栏模块（output_guardrail.py）已存在，但需要确认是否在所有输出路径上启用。",
            recommendation="确保所有 LLM 输出路径都经过 RedactionEngine 和 output_guardrail 处理",
            evidence="",
        ))

    def _audit_path(self, config_values: dict[str, Any]) -> None:
        work_dir = config_values.get("work_dir", os.getcwd())
        temp_dir = config_values.get("temp_dir", "")

        if temp_dir and os.path.commonpath([work_dir, temp_dir]) != os.path.normpath(work_dir):
            self._findings.append(AuditFinding(
                id=self._next_id(),
                dimension=AuditDimension.PATH,
                severity=Severity.HIGH,
                title="临时目录不在工作目录范围内",
                description=f"临时目录 '{temp_dir}' 不在工作目录 '{work_dir}' 范围内，存在路径穿越风险",
                recommendation="将临时目录限制在工作目录的子目录中",
                evidence=f"work_dir={work_dir}, temp_dir={temp_dir}",
            ))

        critical_paths = config_values.get("critical_paths", [])
        if not critical_paths:
            self._findings.append(AuditFinding(
                id=self._next_id(),
                dimension=AuditDimension.PATH,
                severity=Severity.MEDIUM,
                title="未配置关键路径保护列表",
                description="未发现关键路径保护配置，系统文件可能被意外修改",
                recommendation="配置 PathSecurityGuard 的关键路径保护列表",
                evidence="critical_paths is empty",
            ))

    def _audit_network(self, config_values: dict[str, Any]) -> None:
        ssl_verify = config_values.get("ssl_verify", True)
        if ssl_verify is False:
            self._findings.append(AuditFinding(
                id=self._next_id(),
                dimension=AuditDimension.NETWORK,
                severity=Severity.HIGH,
                title="SSL证书验证已禁用",
                description="ssl_verify 设置为 False，存在中间人攻击风险",
                recommendation="启用 SSL 证书验证，或使用受信任的内部 CA",
                evidence="ssl_verify=False",
            ))

        allowed_hosts = config_values.get("allowed_hosts", config_values.get("allowed_domains", []))
        if not allowed_hosts and config_values.get("network_enabled", False):
            self._findings.append(AuditFinding(
                id=self._next_id(),
                dimension=AuditDimension.NETWORK,
                severity=Severity.MEDIUM,
                title="未配置网络访问白名单",
                description="网络功能已启用但未配置 allowed_hosts，可能访问任意外部资源",
                recommendation="配置 allowed_hosts 限制可访问的外部域名",
                evidence="allowed_hosts is empty, network_enabled=True",
            ))
