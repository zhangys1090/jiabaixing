"""开源漏洞检查模块——基于 OSV (Open Source Vulnerabilities) API 检查依赖安全性。

提供 OSVChecker 类，支持检查单个 Python 包或整个 requirements.txt
中的已知漏洞，并生成格式化报告。

OSV API 文档: https://osv.dev/docs/#tag/api

Usage:
    import asyncio
    checker = OSVChecker()
    reports = asyncio.run(checker.check_package("requests", "2.28.0"))
    for r in reports:
        print(f"{r.package}@{r.version}: {r.severity.value} - {r.summary}")
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_OSV_API_URL = "https://api.osv.dev/v1/query"
_OSV_TIMEOUT = 10.0


class VulnerabilitySeverity(str, Enum):
    """漏洞严重程度枚举。

    Attributes:
        LOW: 低危漏洞。
        MEDIUM: 中危漏洞。
        HIGH: 高危漏洞。
        CRITICAL: 严重漏洞。
    """

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


def _map_severity(severity_str: str | None) -> VulnerabilitySeverity:
    """将 OSV 返回的严重程度字符串映射为 VulnerabilitySeverity 枚举值。

    Args:
        severity_str: OSV 返回的严重程度原始字符串。

    Returns:
        VulnerabilitySeverity: 映射后的严重程度枚举值。
    """
    if not severity_str:
        return VulnerabilitySeverity.MEDIUM
    s = severity_str.upper()
    if "CRITICAL" in s:
        return VulnerabilitySeverity.CRITICAL
    if "HIGH" in s:
        return VulnerabilitySeverity.HIGH
    if "MEDIUM" in s or "MODERATE" in s:
        return VulnerabilitySeverity.MEDIUM
    if "LOW" in s:
        return VulnerabilitySeverity.LOW
    return VulnerabilitySeverity.MEDIUM


@dataclass
class VulnerabilityReport:
    """漏洞报告。

    Attributes:
        package: 受影响的包名。
        version: 受影响的版本。
        vulnerability_id: 漏洞唯一标识（如 CVE-2023-1234、GHSA-xxxx-xxxx-xxxx）。
        severity: 严重程度。
        summary: 漏洞摘要描述。
        patched_versions: 已修复的版本范围。
        url: 漏洞详情链接。
    """

    package: str
    version: str
    vulnerability_id: str = ""
    severity: VulnerabilitySeverity = VulnerabilitySeverity.MEDIUM
    summary: str = ""
    patched_versions: str = ""
    url: str = ""


class OSVChecker:
    """开源漏洞检查器——基于 OSV API 检查 Python 依赖的已知漏洞。

    支持异步和同步两种检查模式，可检查单个包或批量扫描
    requirements.txt 文件。

    Attributes:
        _timeout: HTTP 请求超时时间（秒）。

    Usage:
        checker = OSVChecker()
        # 异步检查单个包
        reports = await checker.check_package("requests", "2.28.0")
        # 批量检查 requirements.txt
        results = await checker.check_requirements("requirements.txt")
    """

    def __init__(self, timeout: float = _OSV_TIMEOUT) -> None:
        """初始化 OSV 检查器。

        Args:
            timeout: HTTP 请求超时时间（秒），默认 10 秒。
        """
        self._timeout = timeout

    async def check_package(
        self, package_name: str, version: str
    ) -> list[VulnerabilityReport]:
        """异步检查单个包的已知漏洞。

        Args:
            package_name: 包名（如 "requests"）。
            version: 版本号（如 "2.28.0"）。

        Returns:
            list[VulnerabilityReport]: 漏洞报告列表，无漏洞时为空。
        """
        payload = {
            "package": {
                "name": f"pkg:pypi/{package_name}",
                "ecosystem": "PyPI",
            },
            "version": version,
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(_OSV_API_URL, json=payload)
                resp.raise_for_status()
                data = resp.json()
        except httpx.TimeoutException:
            logger.warning("OSV 检查超时: %s@%s", package_name, version)
            return []
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "OSV 检查失败: %s@%s, HTTP %s",
                package_name,
                version,
                exc.response.status_code,
            )
            return []
        except httpx.RequestError as exc:
            logger.warning("OSV 请求错误: %s@%s, %s", package_name, version, exc)
            return []

        vulns = data.get("vulns", [])
        return [self._parse_vuln(v, package_name, version) for v in vulns]

    def check_package_sync(
        self, package_name: str, version: str
    ) -> list[VulnerabilityReport]:
        """同步检查单个包的已知漏洞。

        内部使用 httpx 同步客户端，适用于非异步上下文。

        Args:
            package_name: 包名（如 "requests"）。
            version: 版本号（如 "2.28.0"）。

        Returns:
            list[VulnerabilityReport]: 漏洞报告列表，无漏洞时为空。
        """
        payload = {
            "package": {
                "name": f"pkg:pypi/{package_name}",
                "ecosystem": "PyPI",
            },
            "version": version,
        }

        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.post(_OSV_API_URL, json=payload)
                resp.raise_for_status()
                data = resp.json()
        except httpx.TimeoutException:
            logger.warning("OSV 检查超时: %s@%s", package_name, version)
            return []
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "OSV 检查失败: %s@%s, HTTP %s",
                package_name,
                version,
                exc.response.status_code,
            )
            return []
        except httpx.RequestError as exc:
            logger.warning("OSV 请求错误: %s@%s, %s", package_name, version, exc)
            return []

        vulns = data.get("vulns", [])
        return [self._parse_vuln(v, package_name, version) for v in vulns]

    async def check_requirements(
        self, requirements_path: str
    ) -> dict[str, list[VulnerabilityReport]]:
        """异步检查 requirements.txt 中所有依赖的已知漏洞。

        逐个检查文件中解析出的包，并发执行查询。

        Args:
            requirements_path: requirements.txt 文件路径。

        Returns:
            dict[str, list[VulnerabilityReport]]: 键为 "包名==版本"，值为漏洞报告列表。
        """
        packages = self._parse_requirements(requirements_path)
        if not packages:
            return {}

        results: dict[str, list[VulnerabilityReport]] = {}
        # 并发检查所有包
        import asyncio

        tasks = [self.check_package(name, ver) for name, ver in packages]
        report_lists = await asyncio.gather(*tasks, return_exceptions=True)

        for (name, ver), reports in zip(packages, report_lists):
            key = f"{name}=={ver}"
            if isinstance(reports, Exception):
                logger.warning("检查 %s 失败: %s", key, reports)
                results[key] = []
            else:
                results[key] = reports

        return results

    def _parse_requirements(self, path: str) -> list[tuple[str, str]]:
        """解析 requirements.txt 文件，提取包名和版本。

        支持以下格式:
        - package==version
        - package>=version
        - package<=version
        - package~=version
        - package>version
        - package<version

        不支持: 行内注释、Git URL、本地路径、extras 语法。

        Args:
            path: requirements.txt 文件路径。

        Returns:
            list[tuple[str, str]]: (包名, 版本) 元组列表。
        """
        req_path = Path(path)
        if not req_path.exists():
            logger.warning("requirements 文件不存在: %s", path)
            return []

        packages: list[tuple[str, str]] = []
        # 匹配 package==version 或 package>=version 等
        pattern = re.compile(
            r"^\s*([a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)"
            r"[><=!~]+"
            r"([0-9][0-9._A-Za-z*-]*)"
        )

        try:
            content = req_path.read_text(encoding="utf-8")
        except OSError as exc:
            logger.warning("读取 requirements 文件失败: %s, %s", path, exc)
            return []

        for line in content.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            m = pattern.match(line)
            if m:
                name = m.group(1).strip()
                version = m.group(3).strip()
                packages.append((name, version))

        return packages

    @staticmethod
    def _parse_vuln(
        vuln: dict, package_name: str, version: str
    ) -> VulnerabilityReport:
        """解析 OSV API 返回的单个漏洞数据。

        Args:
            vuln: OSV API 返回的漏洞字典。
            package_name: 包名。
            version: 版本号。

        Returns:
            VulnerabilityReport: 漏洞报告。
        """
        vuln_id = vuln.get("id", "")
        summary = vuln.get("summary", "")

        # 尝试从 database_specific 获取严重程度
        severity_str: str | None = None
        severity_items = vuln.get("severity", [])
        if severity_items and isinstance(severity_items, list):
            # 优先使用 CVSS 分数
            for item in severity_items:
                if isinstance(item, dict):
                    score_str = item.get("score", "")
                    if score_str:
                        severity_str = score_str
                        break

        # 尝试从 references 获取详情链接
        url = ""
        refs = vuln.get("references", [])
        if refs and isinstance(refs, list):
            for ref in refs:
                if isinstance(ref, dict) and ref.get("type") == "ADVISORY":
                    url = ref.get("url", "")
                    break
            if not url and refs:
                url = refs[0].get("url", "") if isinstance(refs[0], dict) else ""

        # 尝试获取修复版本
        patched_versions = ""
        affected = vuln.get("affected", [])
        if affected and isinstance(affected, list):
            for aff in affected:
                if not isinstance(aff, dict):
                    continue
                ranges = aff.get("ranges", [])
                for r in ranges:
                    if not isinstance(r, dict):
                        continue
                    events = r.get("events", [])
                    for event in events:
                        if isinstance(event, dict) and "fixed" in event:
                            patched_versions = event["fixed"]
                            break
                    if patched_versions:
                        break
                if patched_versions:
                    break

        return VulnerabilityReport(
            package=package_name,
            version=version,
            vulnerability_id=vuln_id,
            severity=_map_severity(severity_str),
            summary=summary,
            patched_versions=patched_versions,
            url=url,
        )

    @staticmethod
    def format_report(reports: dict[str, list[VulnerabilityReport]]) -> str:
        """格式化漏洞检查报告为可读文本。

        Args:
            reports: check_requirements 返回的漏洞报告字典。

        Returns:
            str: 格式化后的报告文本。
        """
        if not reports:
            return "✅ 未发现已知漏洞。"

        lines: list[str] = ["🔍 开源漏洞检查报告", "=" * 50]
        total_vulns = 0

        # 按严重程度排序
        severity_order = {
            VulnerabilitySeverity.CRITICAL: 0,
            VulnerabilitySeverity.HIGH: 1,
            VulnerabilitySeverity.MEDIUM: 2,
            VulnerabilitySeverity.LOW: 3,
        }

        for pkg_key, vulns in sorted(reports.items()):
            if not vulns:
                lines.append(f"\n📦 {pkg_key}: ✅ 无已知漏洞")
                continue

            total_vulns += len(vulns)
            # 按严重程度排序
            sorted_vulns = sorted(
                vulns, key=lambda v: severity_order.get(v.severity, 99)
            )
            lines.append(f"\n📦 {pkg_key}: ⚠️ {len(vulns)} 个漏洞")

            for v in sorted_vulns:
                severity_label = {
                    VulnerabilitySeverity.CRITICAL: "🔴 严重",
                    VulnerabilitySeverity.HIGH: "🟠 高危",
                    VulnerabilitySeverity.MEDIUM: "🟡 中危",
                    VulnerabilitySeverity.LOW: "🟢 低危",
                }.get(v.severity, "⚪ 未知")

                lines.append(f"  {severity_label} [{v.vulnerability_id}]")
                if v.summary:
                    lines.append(f"    摘要: {v.summary}")
                if v.patched_versions:
                    lines.append(f"    修复版本: {v.patched_versions}")
                if v.url:
                    lines.append(f"    详情: {v.url}")

        lines.append(f"\n{'=' * 50}")
        lines.append(f"📊 总计: 检查 {len(reports)} 个包, 发现 {total_vulns} 个漏洞")

        return "\n".join(lines)
