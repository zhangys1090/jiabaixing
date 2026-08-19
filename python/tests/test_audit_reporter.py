"""测试 SecurityAuditReporter 安全审计报告生成器。"""

from __future__ import annotations

from agent.security.audit_reporter import (
    AuditDimension,
    AuditFinding,
    AuditReport,
    SecurityAuditReporter,
    Severity,
)


def test_run_audit_all_dimensions():
    reporter = SecurityAuditReporter()
    report = reporter.run_audit()

    assert isinstance(report, AuditReport)
    assert report.report_id.startswith("audit-")
    assert report.total_findings >= 0
    assert report.generated_at > 0
    assert len(report.dimensions_checked) >= 3


def test_run_audit_specific_dimensions():
    reporter = SecurityAuditReporter()
    report = reporter.run_audit(dimensions=[AuditDimension.CONFIG, AuditDimension.NETWORK])

    assert AuditDimension.CONFIG.value in report.dimensions_checked
    assert AuditDimension.NETWORK.value in report.dimensions_checked
    assert AuditDimension.PATH.value not in report.dimensions_checked


def test_audit_config_sensitive_env_vars():
    reporter = SecurityAuditReporter()
    env_vars = {
        "PATH": "/usr/bin",
        "HOME": "/home/user",
        "OPENAI_API_KEY": "sk-not-real-key",
        "DATABASE_PASSWORD": "secret123",
        "ANTHROPIC_SECRET": "anth-secret",
    }

    report = reporter.run_audit(dimensions=[AuditDimension.CONFIG], env_vars=env_vars)

    config_findings = [f for f in report.findings if f.dimension == AuditDimension.CONFIG]
    assert len(config_findings) >= 1


def test_audit_config_no_sensitive_vars():
    reporter = SecurityAuditReporter()
    env_vars = {
        "PATH": "/usr/bin",
        "HOME": "/home/user",
        "USER": "test",
        "LANG": "en_US.UTF-8",
    }

    report = reporter.run_audit(dimensions=[AuditDimension.CONFIG], env_vars=env_vars)

    config_findings = [f for f in report.findings if f.dimension == AuditDimension.CONFIG]
    assert len(config_findings) == 0


def test_audit_network_ssl_verify_disabled():
    reporter = SecurityAuditReporter()
    config = {"ssl_verify": False}

    report = reporter.run_audit(dimensions=[AuditDimension.NETWORK], config_values=config)

    network_findings = [f for f in report.findings if f.dimension == AuditDimension.NETWORK]
    disabled = [f for f in network_findings if "SSL" in f.title]
    assert len(disabled) >= 1


def test_audit_network_ssl_verify_enabled():
    reporter = SecurityAuditReporter()
    config = {"ssl_verify": True}

    report = reporter.run_audit(dimensions=[AuditDimension.NETWORK], config_values=config)

    network_findings = [f for f in report.findings if f.dimension == AuditDimension.NETWORK]
    disabled = [f for f in network_findings if "SSL" in f.title]
    assert len(disabled) == 0


def test_audit_network_no_allowed_hosts():
    reporter = SecurityAuditReporter()
    config = {"network_enabled": True, "allowed_hosts": [], "allowed_domains": []}

    report = reporter.run_audit(dimensions=[AuditDimension.NETWORK], config_values=config)

    network_findings = [f for f in report.findings if f.dimension == AuditDimension.NETWORK]
    host_findings = [f for f in network_findings if "白名单" in f.title]
    assert len(host_findings) >= 1


def test_audit_path_outside_work_dir():
    reporter = SecurityAuditReporter()
    config = {"work_dir": "/app/data", "temp_dir": "/tmp/agent"}

    report = reporter.run_audit(dimensions=[AuditDimension.PATH], config_values=config)

    path_findings = [f for f in report.findings if f.dimension == AuditDimension.PATH]
    outside = [f for f in path_findings if "不在工作目录" in f.title]
    assert len(outside) >= 1


def test_audit_path_inside_work_dir():
    reporter = SecurityAuditReporter()
    config = {"work_dir": "/app/data", "temp_dir": "/app/data/temp"}

    report = reporter.run_audit(dimensions=[AuditDimension.PATH], config_values=config)

    path_findings = [f for f in report.findings if f.dimension == AuditDimension.PATH]
    outside = [f for f in path_findings if "不在工作目录" in f.title]
    assert len(outside) == 0


def test_audit_path_no_critical_paths():
    reporter = SecurityAuditReporter()
    config = {"work_dir": "/app", "critical_paths": []}

    report = reporter.run_audit(dimensions=[AuditDimension.PATH], config_values=config)

    path_findings = [f for f in report.findings if f.dimension == AuditDimension.PATH]
    critical = [f for f in path_findings if "关键路径" in f.title]
    assert len(critical) >= 1


def test_report_severity_no_findings():
    reporter = SecurityAuditReporter()
    report = reporter.run_audit(dimensions=[AuditDimension.CONFIG], env_vars={"PATH": "/usr/bin"})

    assert report.severity == Severity.LOW


def test_report_severity_with_high_finding():
    reporter = SecurityAuditReporter()
    config = {"ssl_verify": False, "network_enabled": True}

    report = reporter.run_audit(dimensions=[AuditDimension.NETWORK], config_values=config)

    assert report.severity == Severity.HIGH


def test_report_contains_all_fields():
    reporter = SecurityAuditReporter()
    report = reporter.run_audit()

    assert report.report_id != ""
    assert report.generated_at > 0
    assert isinstance(report.severity, Severity)
    assert isinstance(report.total_findings, int)
    assert isinstance(report.findings, list)
    assert isinstance(report.dimensions_checked, list)
    assert isinstance(report.pass_count, int)
    assert isinstance(report.fail_count, int)


def test_finding_has_all_fields():
    reporter = SecurityAuditReporter()
    report = reporter.run_audit(
        dimensions=[AuditDimension.NETWORK],
        env_vars={"PATH": "/usr/bin"},
        config_values={"ssl_verify": False},
    )

    for finding in report.findings:
        assert finding.id.startswith("FIND-")
        assert isinstance(finding.dimension, AuditDimension)
        assert isinstance(finding.severity, Severity)
        assert finding.title != ""
        assert finding.description != ""
        assert finding.recommendation != ""


def test_audit_dependency_dimension():
    reporter = SecurityAuditReporter()
    report = reporter.run_audit(dimensions=[AuditDimension.DEPENDENCY])

    dep_findings = [f for f in report.findings if f.dimension == AuditDimension.DEPENDENCY]
    assert len(dep_findings) >= 1


def test_audit_output_dimension():
    reporter = SecurityAuditReporter()
    report = reporter.run_audit(dimensions=[AuditDimension.OUTPUT])

    output_findings = [f for f in report.findings if f.dimension == AuditDimension.OUTPUT]
    assert len(output_findings) >= 1


def test_default_env_vars():
    reporter = SecurityAuditReporter()
    report = reporter.run_audit(dimensions=[AuditDimension.CONFIG])

    assert isinstance(report, AuditReport)
