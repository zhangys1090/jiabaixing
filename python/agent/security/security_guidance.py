"""安全指导模块——评估操作风险并提供安全建议。

提供 SecurityGuidance 类，基于内置安全规则评估操作风险等级，
返回安全建议、最佳实践和是否需要用户确认。

不依赖 LLM，完全基于规则匹配。

内置安全规则:
- 删除文件 → HIGH, 需确认, "建议先备份再删除"
- 修改 .env → HIGH, 需确认, "包含敏感信息，修改前请确认"
- 执行 shell 命令 → MEDIUM, 需确认, "请确认命令安全性"
- 网络请求 → LOW, 不需确认, "注意不要泄露敏感信息"
- 写入系统目录 → HIGH, 需确认, "需要管理员权限，可能影响系统稳定性"
- 安装依赖 → MEDIUM, 不需确认, "建议使用虚拟环境，检查依赖安全性"
- 访问凭据 → CRITICAL, 需确认, "请确认操作必要性，避免泄露"
- 修改配置文件 → MEDIUM, 需确认, "修改前建议备份原配置"

Usage:
    sg = SecurityGuidance()
    advisory = sg.evaluate_action("删除文件", "/etc/passwd")
    if advisory.should_confirm:
        print(f"⚠️ 需要用户确认: {advisory.guidance}")
"""

from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from enum import Enum


class RiskLevel(str, Enum):
    """风险等级枚举。

    Attributes:
        LOW: 低风险，无需特殊处理。
        MEDIUM: 中等风险，需注意。
        HIGH: 高风险，建议确认后再执行。
        CRITICAL: 严重风险，必须确认后方可执行。
    """

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class SecurityAdvisory:
    """安全建议。

    Attributes:
        risk_level: 风险等级。
        action: 触发的操作描述。
        guidance: 安全指导文本。
        best_practices: 最佳实践列表。
        should_confirm: 是否需要用户确认。
        warnings: 警告信息列表。
    """

    risk_level: RiskLevel
    action: str = ""
    guidance: str = ""
    best_practices: list[str] = field(default_factory=list)
    should_confirm: bool = False
    warnings: list[str] = field(default_factory=list)


@dataclass
class _SecurityRule:
    """内置安全规则。

    Attributes:
        action_patterns: 操作名称匹配模式列表（支持 fnmatch 通配符）。
        target_patterns: 目标路径/名称匹配模式列表。
        risk_level: 风险等级。
        guidance: 安全指导文本。
        should_confirm: 是否需要用户确认。
        best_practices: 最佳实践列表。
        warnings: 警告信息列表。
    """

    action_patterns: list[str]
    target_patterns: list[str]
    risk_level: RiskLevel
    guidance: str
    should_confirm: bool
    best_practices: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _default_rules() -> list[_SecurityRule]:
    """生成内置安全规则列表。

    Returns:
        list[_SecurityRule]: 内置安全规则。
    """
    return [
        _SecurityRule(
            action_patterns=["删除文件", "delete*", "remove*", "rm*"],
            target_patterns=[],
            risk_level=RiskLevel.HIGH,
            guidance="建议先备份再删除",
            should_confirm=True,
            best_practices=[
                "删除前确认文件路径正确",
                "重要文件建议先移动到回收站",
                "使用版本控制系统避免不可逆删除",
            ],
            warnings=["删除操作不可逆"],
        ),
        _SecurityRule(
            action_patterns=["修改*", "edit*", "write*", "写入*"],
            target_patterns=["*.env", ".env*", "env/*"],
            risk_level=RiskLevel.HIGH,
            guidance="包含敏感信息，修改前请确认",
            should_confirm=True,
            best_practices=[
                "修改前备份原 .env 文件",
                "确认不会泄露密钥和令牌",
                "使用版本控制跟踪变更",
            ],
            warnings=[".env 文件通常包含 API Key 和数据库密码"],
        ),
        _SecurityRule(
            action_patterns=[
                "执行shell*", "执行命令*", "run*", "execute*",
                "shell*", "command*", "cmd*", "bash*",
            ],
            target_patterns=[],
            risk_level=RiskLevel.MEDIUM,
            guidance="请确认命令安全性",
            should_confirm=True,
            best_practices=[
                "避免使用 sudo 或管理员权限",
                "检查命令中是否包含管道和重定向",
                "确认命令来源可信",
            ],
            warnings=["Shell 命令可能影响系统安全"],
        ),
        _SecurityRule(
            action_patterns=[
                "网络请求*", "http*", "fetch*", "request*",
                "curl*", "wget*", "下载*",
            ],
            target_patterns=[],
            risk_level=RiskLevel.LOW,
            guidance="注意不要泄露敏感信息",
            should_confirm=False,
            best_practices=[
                "使用 HTTPS 而非 HTTP",
                "不要在 URL 中传递敏感参数",
                "验证响应数据的合法性",
            ],
        ),
        _SecurityRule(
            action_patterns=["写入*", "write*", "修改*"],
            target_patterns=[
                "/etc/*", "/usr/*", "/var/*", "/sys/*",
                "C:\\Windows\\*", "C:\\Program Files\\*",
                "/sbin/*", "/bin/*",
            ],
            risk_level=RiskLevel.HIGH,
            guidance="需要管理员权限，可能影响系统稳定性",
            should_confirm=True,
            best_practices=[
                "避免直接修改系统目录",
                "使用包管理器安装软件",
                "在用户目录下操作",
            ],
            warnings=["修改系统目录可能导致系统不稳定"],
        ),
        _SecurityRule(
            action_patterns=[
                "安装依赖*", "install*", "pip install*",
                "npm install*", "apt*", "yum*",
            ],
            target_patterns=[],
            risk_level=RiskLevel.MEDIUM,
            guidance="建议使用虚拟环境，检查依赖安全性",
            should_confirm=False,
            best_practices=[
                "在虚拟环境中安装依赖",
                "检查依赖的已知漏洞",
                "锁定依赖版本",
                "审查依赖的许可证",
            ],
        ),
        _SecurityRule(
            action_patterns=[
                "访问凭据*", "获取密钥*", "读取凭据*",
                "credential*", "secret*", "key*",
                "token*", "password*",
            ],
            target_patterns=[],
            risk_level=RiskLevel.CRITICAL,
            guidance="请确认操作必要性，避免泄露",
            should_confirm=True,
            best_practices=[
                "仅在必要时访问凭据",
                "不要将凭据记录到日志",
                "使用凭据管理服务而非硬编码",
                "操作完成后立即清除内存中的凭据",
            ],
            warnings=["凭据泄露可能导致严重安全事故"],
        ),
        _SecurityRule(
            action_patterns=["修改配置*", "config*", "设置*"],
            target_patterns=["*.json", "*.yaml", "*.yml", "*.toml", "*.ini", "*.cfg"],
            risk_level=RiskLevel.MEDIUM,
            guidance="修改前建议备份原配置",
            should_confirm=True,
            best_practices=[
                "修改前备份原配置文件",
                "逐步修改并验证效果",
                "记录配置变更原因",
            ],
            warnings=["配置错误可能导致服务异常"],
        ),
    ]


class SecurityGuidance:
    """安全指导系统——评估操作风险并提供安全建议。

    基于内置安全规则评估操作风险等级，返回安全建议、
    最佳实践和是否需要用户确认。不依赖 LLM。

    Attributes:
        _rules: 当前安全规则列表。
        _best_practices_db: 按类别索引的最佳实践数据库。

    Usage:
        sg = SecurityGuidance()
        advisory = sg.evaluate_action("删除文件", "/tmp/old.log")
        if advisory.should_confirm:
            print(f"需要确认: {advisory.guidance}")
    """

    def __init__(self, rules: list[_SecurityRule] | None = None) -> None:
        """初始化安全指导系统。

        Args:
            rules: 自定义安全规则列表，默认使用内置规则。
        """
        self._rules: list[_SecurityRule] = rules if rules is not None else _default_rules()
        self._best_practices_db: dict[str, list[str]] = self._build_best_practices_db()

    def evaluate_action(self, action: str, target: str = "") -> SecurityAdvisory:
        """评估操作风险并返回安全建议。

        按规则顺序匹配，返回第一个匹配规则的建议；
        若无匹配，返回 LOW 风险的默认建议。

        Args:
            action: 操作描述（如 "删除文件"、"执行命令"）。
            target: 操作目标（如文件路径、URL），可选。

        Returns:
            SecurityAdvisory: 安全建议，包含风险等级、指导和最佳实践。
        """
        action_lower = action.lower()
        target_lower = target.lower() if target else ""

        for rule in self._rules:
            action_matched = any(
                fnmatch.fnmatch(action_lower, pat.lower())
                for pat in rule.action_patterns
            )

            if not action_matched:
                continue

            # 如果规则有 target_patterns，需要目标也匹配
            if rule.target_patterns:
                if not target_lower:
                    continue
                target_matched = any(
                    fnmatch.fnmatch(target_lower, pat.lower())
                    for pat in rule.target_patterns
                )
                if not target_matched:
                    continue

            return SecurityAdvisory(
                risk_level=rule.risk_level,
                action=action,
                guidance=rule.guidance,
                best_practices=list(rule.best_practices),
                should_confirm=rule.should_confirm,
                warnings=list(rule.warnings),
            )

        # 无匹配规则，返回默认低风险建议
        return SecurityAdvisory(
            risk_level=RiskLevel.LOW,
            action=action,
            guidance="",
            best_practices=[],
            should_confirm=False,
            warnings=[],
        )

    def get_guidance(self, action: str) -> str | None:
        """获取操作的安全指导文本。

        Args:
            action: 操作描述。

        Returns:
            str | None: 安全指导文本，无匹配规则时返回 None。
        """
        advisory = self.evaluate_action(action)
        return advisory.guidance if advisory.guidance else None

    def get_best_practices(self, category: str) -> list[str]:
        """获取指定类别的最佳实践列表。

        支持的类别: deletion, credentials, shell, network,
        system_dirs, dependencies, configuration, general。

        Args:
            category: 最佳实践类别名称。

        Returns:
            list[str]: 该类别下的最佳实践列表，未知类别返回空列表。
        """
        return list(self._best_practices_db.get(category.lower(), []))

    def should_confirm(self, action: str, target: str = "") -> bool:
        """判断操作是否需要用户确认。

        Args:
            action: 操作描述。
            target: 操作目标，可选。

        Returns:
            bool: True 表示需要用户确认后再执行。
        """
        advisory = self.evaluate_action(action, target)
        return advisory.should_confirm

    @staticmethod
    def format_advisory(advisory: SecurityAdvisory) -> str:
        """格式化安全建议为可读文本。

        Args:
            advisory: 安全建议实例。

        Returns:
            str: 格式化后的安全建议文本。
        """
        risk_labels = {
            RiskLevel.LOW: "🟢 低风险",
            RiskLevel.MEDIUM: "🟡 中等风险",
            RiskLevel.HIGH: "🟠 高风险",
            RiskLevel.CRITICAL: "🔴 严重风险",
        }

        lines: list[str] = [
            f"{risk_labels.get(advisory.risk_level, '⚪ 未知风险')}: {advisory.action}"
        ]

        if advisory.guidance:
            lines.append(f"📋 指导: {advisory.guidance}")

        if advisory.should_confirm:
            lines.append("⚠️  需要用户确认")

        if advisory.best_practices:
            lines.append("✅ 最佳实践:")
            for bp in advisory.best_practices:
                lines.append(f"  • {bp}")

        if advisory.warnings:
            lines.append("🚨 警告:")
            for w in advisory.warnings:
                lines.append(f"  • {w}")

        return "\n".join(lines)

    def _build_best_practices_db(self) -> dict[str, list[str]]:
        """从安全规则中构建按类别索引的最佳实践数据库。

        Returns:
            dict[str, list[str]]: 类别名到最佳实践列表的映射。
        """
        return {
            "deletion": [
                "删除前确认文件路径正确",
                "重要文件建议先移动到回收站",
                "使用版本控制系统避免不可逆删除",
            ],
            "credentials": [
                "仅在必要时访问凭据",
                "不要将凭据记录到日志",
                "使用凭据管理服务而非硬编码",
                "操作完成后立即清除内存中的凭据",
            ],
            "shell": [
                "避免使用 sudo 或管理员权限",
                "检查命令中是否包含管道和重定向",
                "确认命令来源可信",
            ],
            "network": [
                "使用 HTTPS 而非 HTTP",
                "不要在 URL 中传递敏感参数",
                "验证响应数据的合法性",
            ],
            "system_dirs": [
                "避免直接修改系统目录",
                "使用包管理器安装软件",
                "在用户目录下操作",
            ],
            "dependencies": [
                "在虚拟环境中安装依赖",
                "检查依赖的已知漏洞",
                "锁定依赖版本",
                "审查依赖的许可证",
            ],
            "configuration": [
                "修改前备份原配置文件",
                "逐步修改并验证效果",
                "记录配置变更原因",
            ],
            "general": [
                "始终验证外部输入",
                "使用最小权限原则",
                "定期审查安全配置",
            ],
        }
