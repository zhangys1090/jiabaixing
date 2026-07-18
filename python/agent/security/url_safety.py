"""URL 安全检查模块——防止 SSRF 和不安全 URL 访问。

验证 URL 协议、阻止私有 IP 访问和已知危险域名，
降低服务端请求伪造（SSRF）风险。
"""

from __future__ import annotations

import ipaddress
import re
from typing import ClassVar
from urllib.parse import urlparse


class URLSafetyError(Exception):
    """URL 安全违规异常。

    当 URL 不满足安全要求（如私有 IP、危险域名、非法协议）时抛出。

    Attributes:
        url: 触发违规的 URL。
        reason: 违规原因。
    """

    def __init__(self, url: str, reason: str) -> None:
        self.url = url
        self.reason = reason
        super().__init__(f"URL安全违规: {reason} (URL: {url})")


class URLSafetyGuard:
    """URL 安全检查守卫。

    验证 URL 是否安全，阻止指向私有 IP、已知危险域名和
    非 HTTP(S) 协议的请求，降低 SSRF 攻击风险。

    Attributes:
        BLOCKED_HOSTNAMES: 可配置的阻止域名列表。

    Usage:
        guard = URLSafetyGuard()
        safe_url = guard.validate_url("https://example.com/api")
        if guard.is_ssrf_risk("http://127.0.0.1/admin"):
            print("SSRF 风险!")
    """

    BLOCKED_HOSTNAMES: ClassVar[list[str]] = [
        "localhost",
        "metadata.google.internal",
        "metadata.internal",
        "169.254.169.254",
        "100.100.100.200",
        "alidns.alidns.com",
    ]

    # 允许的协议
    _ALLOWED_SCHEMES: ClassVar[frozenset[str]] = frozenset({"http", "https"})

    # 私有 IP 网段定义
    _PRIVATE_NETWORKS: ClassVar[list[ipaddress.IPv4Network | ipaddress.IPv6Network]] = [
        # IPv4 私有地址
        ipaddress.IPv4Network("127.0.0.0/8"),       # 回环地址
        ipaddress.IPv4Network("10.0.0.0/8"),         # A 类私有
        ipaddress.IPv4Network("172.16.0.0/12"),      # B 类私有
        ipaddress.IPv4Network("192.168.0.0/16"),     # C 类私有
        ipaddress.IPv4Network("169.254.0.0/16"),     # 链路本地
        ipaddress.IPv4Network("0.0.0.0/8"),          # 当前网络
        # IPv6 私有地址
        ipaddress.IPv6Network("::1/128"),            # 回环地址
        ipaddress.IPv6Network("fe80::/10"),           # 链路本地
        ipaddress.IPv6Network("fc00::/7"),            # 唯一本地地址
        ipaddress.IPv6Network("::ffff:127.0.0.0/104"),  # IPv4 映射回环
    ]

    def validate_url(self, url: str) -> str:
        """验证 URL 安全性。

        依次检查：协议是否为 HTTP(S)、主机名是否在阻止列表、
        主机名是否解析为私有 IP。任一检查不通过则抛出异常。

        Args:
            url: 待验证的 URL 字符串。

        Returns:
            str: 验证通过的原 URL。

        Raises:
            URLSafetyError: URL 不满足安全要求时抛出。
        """
        parsed = urlparse(url)

        # 检查协议
        if parsed.scheme.lower() not in self._ALLOWED_SCHEMES:
            raise URLSafetyError(
                url,
                f"不允许的协议: {parsed.scheme}，仅允许 http/https",
            )

        # 检查主机名
        hostname = parsed.hostname
        if not hostname:
            raise URLSafetyError(url, "URL 缺少主机名")

        # 检查阻止列表
        if hostname.lower() in self.BLOCKED_HOSTNAMES:
            raise URLSafetyError(url, f"主机名在阻止列表中: {hostname}")

        # 检查私有 IP
        if self.is_private_ip(hostname):
            raise URLSafetyError(url, f"主机名为私有 IP: {hostname}")

        return url

    def is_private_ip(self, hostname: str) -> bool:
        """检测主机名是否为私有 IP 地址。

        使用 ``ipaddress`` 模块判断主机名（IP 形式）是否属于
        RFC 1918 / RFC 4193 定义的私有地址范围。

        对于非 IP 形式的主机名（如域名），直接返回 ``False``。

        Args:
            hostname: 主机名字符串。

        Returns:
            bool: 是私有 IP 返回 ``True``，否则返回 ``False``。
        """
        try:
            addr = ipaddress.ip_address(hostname)
        except ValueError:
            # 不是合法 IP 地址（可能是域名）
            return False

        for network in self._PRIVATE_NETWORKS:
            if addr in network:
                return True

        return False

    def is_ssrf_risk(self, url: str) -> bool:
        """检测 URL 是否存在 SSRF 风险。

        综合判断 URL 的协议、主机名和 IP 特征，
        评估是否存在服务端请求伪造风险。

        Args:
            url: 待检测的 URL 字符串。

        Returns:
            bool: 存在 SSRF 风险返回 ``True``，否则返回 ``False``。
        """
        parsed = urlparse(url)

        # 非 HTTP(S) 协议存在风险
        if parsed.scheme.lower() not in self._ALLOWED_SCHEMES:
            return True

        hostname = parsed.hostname
        if not hostname:
            return True

        # 主机名在阻止列表中
        if hostname.lower() in self.BLOCKED_HOSTNAMES:
            return True

        # 私有 IP
        if self.is_private_ip(hostname):
            return True

        return False
