"""SSL 证书验证模块——检查 SSL/TLS 证书有效性。

使用 ``ssl`` 标准库验证远程主机的证书，检查过期、链完整性和
自签名状态，不引入额外依赖。
"""

from __future__ import annotations

import ssl
import socket
from datetime import datetime, timezone
from typing import ClassVar
import logging
logger = logging.getLogger(__name__)


class SSLValidationError(Exception):
    """SSL 证书验证异常。

    当 SSL 证书验证不通过时抛出。

    Attributes:
        hostname: 主机名。
        reason: 失败原因。
    """

    def __init__(self, hostname: str, reason: str) -> None:
        self.hostname = hostname
        self.reason = reason
        super().__init__(f"SSL验证失败: {reason} (主机: {hostname})")


class SSLGuard:
    """SSL 证书验证守卫。

    验证远程主机的 SSL 证书是否过期、证书链是否完整以及
    是否为自签名证书。仅使用 Python 标准库 ``ssl`` 模块。

    Attributes:
        DEFAULT_TIMEOUT: 默认连接超时秒数。

    Usage:
        guard = SSLGuard()
        info = guard.validate_ssl_cert("example.com")
        if guard.is_cert_valid("example.com"):
            logger.info("证书有效")
    """

    DEFAULT_TIMEOUT: ClassVar[int] = 10

    def get_cert_info(self, hostname: str, port: int = 443) -> dict | None:
        """获取远程主机的 SSL 证书信息。

        建立到 ``hostname:port`` 的 TLS 连接，获取对端证书的
        解码信息字典。如果连接或握手失败，返回 ``None``。

        Args:
            hostname: 目标主机名。
            port: 目标端口，默认 443。

        Returns:
            dict | None: 证书信息字典，失败时返回 ``None``。
                典型键包括 ``subject``、``issuer``、``notBefore``、
                ``notAfter``、``subjectAltName`` 等。
        """
        context = ssl.create_default_context()
        try:
            with socket.create_connection(
                (hostname, port), timeout=self.DEFAULT_TIMEOUT
            ) as sock:
                with context.wrap_socket(sock, server_hostname=hostname) as tls:
                    return tls.getpeercert()
        except (ssl.SSLError, socket.error, OSError):
            return None

    def validate_ssl_cert(self, hostname: str, port: int = 443) -> dict:
        """验证远程主机的 SSL 证书。

        检查项目：
        1. 证书是否过期（比较 ``notAfter`` 与当前时间）。
        2. 证书链是否完整（能否用系统 CA 验证）。
        3. 是否自签名（subject 与 issuer 相同）。

        Args:
            hostname: 目标主机名。
            port: 目标端口，默认 443。

        Returns:
            dict: 验证结果，包含以下键：
                - ``hostname`` (str): 主机名。
                - ``valid`` (bool): 证书是否有效。
                - ``expired`` (bool): 证书是否过期。
                - ``chain_complete`` (bool): 证书链是否完整。
                - ``self_signed`` (bool): 是否自签名。
                - ``not_before`` (str | None): 证书生效时间。
                - ``not_after`` (str | None): 证书过期时间。
                - ``issuer`` ( str | None): 颁发者。
                - ``subject`` (str | None): 主题。
                - ``error`` (str | None): 错误信息（如有）。
        """
        result: dict = {
            "hostname": hostname,
            "valid": False,
            "expired": False,
            "chain_complete": False,
            "self_signed": False,
            "not_before": None,
            "not_after": None,
            "issuer": None,
            "subject": None,
            "error": None,
        }

        # 尝试用默认 CA 验证（检查链完整性）
        context_verify = ssl.create_default_context()
        try:
            with socket.create_connection(
                (hostname, port), timeout=self.DEFAULT_TIMEOUT
            ) as sock:
                with context_verify.wrap_socket(
                    sock, server_hostname=hostname
                ) as tls:
                    cert = tls.getpeercert()
                    if cert:
                        result["chain_complete"] = True
        except ssl.SSLCertVerificationError as e:
            result["error"] = f"证书链验证失败: {e.verify_message}"
        except (ssl.SSLError, socket.error, OSError) as e:
            result["error"] = f"连接失败: {e}"

        # 获取证书详情（不验证 CA，用于读取信息）
        cert = self.get_cert_info(hostname, port)
        if cert is None:
            if result["error"] is None:
                result["error"] = "无法获取证书信息"
            return result

        # 提取主题和颁发者
        result["subject"] = self._format_name(cert.get("subject", ()))
        result["issuer"] = self._format_name(cert.get("issuer", ()))

        # 检查是否过期
        not_after_str = cert.get("notAfter")
        not_before_str = cert.get("notBefore")
        now = datetime.now(timezone.utc)

        if not_after_str:
            not_after = self._parse_ssl_time(not_after_str)
            result["not_after"] = not_after_str
            if not_after and now > not_after:
                result["expired"] = True

        if not_before_str:
            result["not_before"] = not_before_str

        # 检查是否自签名（subject == issuer）
        result["self_signed"] = cert.get("subject") == cert.get("issuer")

        # 综合判定有效性：链完整 + 未过期
        result["valid"] = result["chain_complete"] and not result["expired"]

        return result

    def is_cert_valid(self, hostname: str, port: int = 443) -> bool:
        """快速检查 SSL 证书是否有效。

        等价于 ``validate_ssl_cert(hostname, port)["valid"]``，但更简洁。

        Args:
            hostname: 目标主机名。
            port: 目标端口，默认 443。

        Returns:
            bool: 证书有效返回 ``True``，否则返回 ``False``。
        """
        result = self.validate_ssl_cert(hostname, port)
        return result["valid"]

    @staticmethod
    def _parse_ssl_time(time_str: str) -> datetime | None:
        """解析 SSL 证书时间字符串。

        Args:
            time_str: SSL 证书时间字符串（如 ``"Jul  7 12:00:00 2026 GMT"``）。

        Returns:
            datetime | None: 解析后的 UTC 时间，失败返回 ``None``。
        """
        try:
            return datetime.strptime(time_str, "%b %d %H:%M:%S %Y %Z").replace(
                tzinfo=timezone.utc
            )
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _format_name(name_tuple: tuple) -> str:
        """将证书 subject/issuer 元组格式化为可读字符串。

        Args:
            name_tuple: 证书名称元组，格式为 ``((key, value), ...)`` 的嵌套结构。

        Returns:
            str: 格式化后的字符串，如 ``"CN=example.com, O=Example Inc"``。
        """
        parts: list[str] = []
        for rdn in name_tuple:
            for key, value in rdn:
                parts.append(f"{key}={value}")
        return ", ".join(parts)