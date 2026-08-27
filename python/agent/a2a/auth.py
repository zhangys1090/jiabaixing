"""A2A 运行时鉴权拦截器.

在远程 Agent 调用前后执行鉴权检查：
1. 出站：调用 remote_agent.invoke() 前校验目标 AgentCard 的 auth 配置，
   并按需注入鉴权头（X-API-Key / Authorization: Bearer xxx / JWT）.
2. 入站：收到远程请求时校验来源凭据是否匹配自身鉴权配置.

支持 4 种鉴权类型：
- none:    无鉴权（默认，配置缺失时降级到此）
- api-key: API Key 校验（X-API-Key 头）
- bearer:  Bearer Token 校验（Authorization: Bearer xxx）
- jwt:     JWT 签名校验（HS256，密钥从环境变量 A2A_JWT_SECRET 读取）

环境变量（用于自身鉴权配置，影响入站校验与出站凭据注入）：
- A2A_AUTH_TYPE:      自身鉴权类型（none / api-key / bearer / jwt）
- A2A_API_KEY:        自身 API Key
- A2A_BEARER_TOKEN:   自身 Bearer Token
- A2A_JWT_SECRET:     JWT 签名密钥

遵循 AGENTS.md 架构原则: A2A 协议主实现端为 Python，鉴权拦截器在 Python 端运行.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Dict, Optional

import jwt

from agent.a2a.types import A2AAgentCard, A2AAuthConfig, A2AAuthType
logger = logging.getLogger(__name__)



# 标准鉴权头名称
HEADER_API_KEY = "X-API-Key"
HEADER_AUTHORIZATION = "Authorization"
# Bearer Token 前缀
BEARER_PREFIX = "Bearer "
# JWT 默认算法
JWT_ALGORITHM = "HS256"
# JWT 默认过期时间（秒）—— 出站签发的 JWT 默认 1 小时过期
DEFAULT_JWT_TTL_SECONDS = 3600


class A2AAuthInterceptor:
    """A2A 运行时鉴权拦截器.

    在远程 Agent 调用前后执行鉴权检查：
    1. 出站：调用 remote_agent.invoke() 前校验目标 AgentCard 的 auth 配置
    2. 入站：收到远程请求时校验来源凭据

    支持 4 种鉴权类型：
    - none: 无鉴权（默认）
    - api_key: API Key 校验（X-API-Key 头）
    - bearer: Bearer Token 校验（Authorization: Bearer xxx）
    - jwt: JWT 签名校验（HS256，密钥从环境变量 A2A_JWT_SECRET 读取）

    Attributes:
        _self_auth: 自身鉴权配置（用于入站校验）.
        _outbound_api_key: 出站调用的 API Key（默认复用 self_auth.api_key）.
        _outbound_bearer_token: 出站调用的 Bearer Token（默认复用 self_auth.bearer_token）.
        _outbound_jwt_secret: 出站 JWT 签名密钥（默认复用 self_auth.jwt_secret）.

    Usage:
        interceptor = A2AAuthInterceptor.from_env()
        # 出站：注入凭据
        headers = interceptor.verify_outbound(target_card, headers)
        # 入站：校验
        ok = interceptor.verify_inbound(request.headers, self_card.get_auth_config())
    """

    def __init__(
        self,
        self_auth: Optional[A2AAuthConfig] = None,
        outbound_api_key: Optional[str] = None,
        outbound_bearer_token: Optional[str] = None,
        outbound_jwt_secret: Optional[str] = None,
    ) -> None:
        """初始化 A2A 鉴权拦截器.

        Args:
            self_auth: 自身鉴权配置（用于入站校验）. None 表示无鉴权.
            outbound_api_key: 出站 API Key. None 则回退到 self_auth.api_key.
            outbound_bearer_token: 出站 Bearer Token. None 则回退到 self_auth.bearer_token.
            outbound_jwt_secret: 出站 JWT 密钥. None 则回退到 self_auth.jwt_secret.
        """
        self._self_auth: A2AAuthConfig = self_auth or A2AAuthConfig(type=A2AAuthType.NONE)
        # 出站凭据默认复用自身凭据（对称密钥假设）；调用方可显式覆盖
        self._outbound_api_key: Optional[str] = outbound_api_key or self._self_auth.api_key
        self._outbound_bearer_token: Optional[str] = (
            outbound_bearer_token or self._self_auth.bearer_token
        )
        self._outbound_jwt_secret: Optional[str] = (
            outbound_jwt_secret or self._self_auth.jwt_secret
        )
        logger.info(
            "A2AAuthInterceptor 初始化: self_type=%s",
            self._self_auth.type.value,
        )

    @property
    def self_auth(self) -> A2AAuthConfig:
        """返回自身鉴权配置（含凭据，仅供入站校验使用，不对外发布）.

        Returns:
            A2AAuthConfig: 自身鉴权配置.
        """
        return self._self_auth

    # ───────────────────────────────────────────────────────────
    # 工厂方法
    # ───────────────────────────────────────────────────────────

    @classmethod
    def from_env(cls) -> "A2AAuthInterceptor":
        """从环境变量构造鉴权拦截器.

        读取的环境变量:
        - A2A_AUTH_TYPE: 鉴权类型（none/api-key/bearer/jwt，默认 none）
        - A2A_API_KEY: API Key
        - A2A_BEARER_TOKEN: Bearer Token
        - A2A_JWT_SECRET: JWT 签名密钥

        Returns:
            A2AAuthInterceptor: 拦截器实例.
        """
        auth_type = A2AAuthType.parse(os.environ.get("A2A_AUTH_TYPE", "none"))
        api_key = os.environ.get("A2A_API_KEY") or None
        bearer_token = os.environ.get("A2A_BEARER_TOKEN") or None
        jwt_secret = os.environ.get("A2A_JWT_SECRET") or None

        return cls(
            self_auth=A2AAuthConfig(
                type=auth_type,
                api_key=api_key,
                bearer_token=bearer_token,
                jwt_secret=jwt_secret,
            )
        )

    # ───────────────────────────────────────────────────────────
    # 出站：注入凭据
    # ───────────────────────────────────────────────────────────

    def verify_outbound(
        self,
        target_card: A2AAgentCard,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, str]:
        """出站调用前注入鉴权头.

        根据目标 AgentCard 声明的 authentication.type 注入相应凭据：
        - none:    不注入
        - api-key: 注入 X-API-Key 头
        - bearer:  注入 Authorization: Bearer xxx 头
        - jwt:     签发 JWT 并注入 Authorization: Bearer <jwt> 头

        若目标所需的凭据未配置，则记录 warning 并返回原始 headers（不注入），
        由远程 Agent 决定是否拒绝；遵循"配置缺失时降级"原则。

        Args:
            target_card: 目标 Agent 的 AgentCard.
            headers: 已有的请求头. None 则使用空字典.

        Returns:
            Dict[str, str]: 注入鉴权头后的请求头（副本，不修改入参）.
        """
        merged: Dict[str, str] = dict(headers or {})
        target_auth = target_card.get_auth_config()

        if target_auth.type == A2AAuthType.NONE:
            return merged

        if target_auth.type == A2AAuthType.API_KEY:
            if self._outbound_api_key:
                merged[HEADER_API_KEY] = self._outbound_api_key
            else:
                logger.warning(
                    "A2A 出站鉴权: 目标 %s 要求 api-key，但本地未配置 A2A_API_KEY",
                    target_card.id,
                )
            return merged

        if target_auth.type in (A2AAuthType.BEARER, A2AAuthType.OAUTH2):
            if self._outbound_bearer_token:
                merged[HEADER_AUTHORIZATION] = f"{BEARER_PREFIX}{self._outbound_bearer_token}"
            else:
                logger.warning(
                    "A2A 出站鉴权: 目标 %s 要求 bearer，但本地未配置 A2A_BEARER_TOKEN",
                    target_card.id,
                )
            return merged

        if target_auth.type == A2AAuthType.JWT:
            if self._outbound_jwt_secret:
                token = self._sign_jwt(self._outbound_jwt_secret)
                merged[HEADER_AUTHORIZATION] = f"{BEARER_PREFIX}{token}"
            else:
                logger.warning(
                    "A2A 出站鉴权: 目标 %s 要求 jwt，但本地未配置 A2A_JWT_SECRET",
                    target_card.id,
                )
            return merged

        # 未知类型，不注入
        logger.warning(
            "A2A 出站鉴权: 目标 %s 使用未知鉴权类型 %s，跳过注入",
            target_card.id,
            target_auth.type.value,
        )
        return merged

    # ───────────────────────────────────────────────────────────
    # 入站：校验凭据
    # ───────────────────────────────────────────────────────────

    def verify_inbound(
        self,
        request_headers: Dict[str, str],
        expected_auth: A2AAuthConfig,
    ) -> bool:
        """入站请求鉴权校验.

        根据自身鉴权配置校验请求头中的凭据：
        - none:    始终通过
        - api-key: 校验 X-API-Key 头是否等于 self_api_key
        - bearer:  校验 Authorization: Bearer xxx 中的 token 是否等于 self_bearer_token
        - jwt:     校验 Authorization: Bearer xxx 中的 JWT 签名是否有效

        Args:
            request_headers: 请求头字典（键大小写不敏感）.
            expected_auth: 期望的鉴权配置（通常为自身鉴权配置）.

        Returns:
            bool: 校验通过返回 True，否则 False.
        """
        if expected_auth.type == A2AAuthType.NONE:
            return True

        if expected_auth.type == A2AAuthType.API_KEY:
            provided = _get_header(request_headers, HEADER_API_KEY)
            return self._verify_api_key(provided, expected_auth.api_key)

        if expected_auth.type in (A2AAuthType.BEARER, A2AAuthType.OAUTH2):
            token = _extract_bearer_token(request_headers)
            return self._verify_bearer(token, expected_auth.bearer_token)

        if expected_auth.type == A2AAuthType.JWT:
            token = _extract_bearer_token(request_headers)
            return self._verify_jwt(token, expected_auth.jwt_secret)

        # 未知类型，拒绝（保守策略）
        logger.warning(
            "A2A 入站鉴权: 未知鉴权类型 %s，拒绝请求",
            expected_auth.type.value,
        )
        return False

    # ───────────────────────────────────────────────────────────
    # 私有校验方法
    # ───────────────────────────────────────────────────────────

    def _verify_api_key(
        self, provided: Optional[str], expected: Optional[str]
    ) -> bool:
        """校验 API Key.

        使用 hmac.compare_digest 进行恒定时间比较，防止时序攻击。

        Args:
            provided: 请求方提供的 API Key.
            expected: 期望的 API Key.

        Returns:
            bool: 校验通过返回 True.
        """
        if not expected:
            # 自身未配置 API Key，但要求 api-key 鉴权 — 配置错误，拒绝
            logger.warning("A2A 入站鉴权: 要求 api-key 但自身未配置 A2A_API_KEY")
            return False
        if not provided:
            return False
        return _safe_str_eq(provided, expected)

    def _verify_bearer(
        self, token: Optional[str], expected: Optional[str]
    ) -> bool:
        """校验 Bearer Token.

        Args:
            token: 请求方提供的 Bearer Token（已从 Authorization 头提取）.
            expected: 期望的 Bearer Token.

        Returns:
            bool: 校验通过返回 True.
        """
        if not expected:
            logger.warning("A2A 入站鉴权: 要求 bearer 但自身未配置 A2A_BEARER_TOKEN")
            return False
        if not token:
            return False
        return _safe_str_eq(token, expected)

    def _verify_jwt(self, token: Optional[str], secret: Optional[str]) -> bool:
        """校验 JWT 签名.

        使用 PyJWT 库验证 HS256 签名。校验失败（签名错误/过期/格式错误）均返回 False。

        Args:
            token: 请求方提供的 JWT（已从 Authorization 头提取）.
            secret: JWT 签名密钥.

        Returns:
            bool: 校验通过返回 True.
        """
        if not secret:
            logger.warning("A2A 入站鉴权: 要求 jwt 但自身未配置 A2A_JWT_SECRET")
            return False
        if not token:
            return False
        try:
            jwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
            return True
        except jwt.ExpiredSignatureError:
            logger.warning("A2A 入站鉴权: JWT 已过期")
            return False
        except jwt.InvalidTokenError as e:
            logger.warning("A2A 入站鉴权: JWT 校验失败 — %s", e)
            return False
        except Exception as e:
            # 防御性编程：捕获所有异常，避免鉴权模块崩溃影响主流程
            logger.warning("A2A 入站鉴权: JWT 校验异常 — %s", e)
            return False

    def _sign_jwt(
        self,
        secret: str,
        ttl_seconds: int = DEFAULT_JWT_TTL_SECONDS,
        subject: str = "a2a-outbound",
    ) -> str:
        """签发一个出站 JWT.

        Args:
            secret: 签名密钥.
            ttl_seconds: 过期时间（秒）.
            subject: JWT subject 声明.

        Returns:
            str: 编码后的 JWT 字符串.
        """
        now = int(time.time())
        payload = {
            "sub": subject,
            "iat": now,
            "exp": now + ttl_seconds,
        }
        return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


# ═══════════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════════


def _get_header(headers: Dict[str, str], name: str) -> Optional[str]:
    """大小写不敏感地获取请求头.

    Args:
        headers: 请求头字典.
        name: 期望的头名称.

    Returns:
        Optional[str]: 头值，不存在返回 None.
    """
    name_lower = name.lower()
    for k, v in headers.items():
        if k.lower() == name_lower:
            return v
    return None


def _extract_bearer_token(headers: Dict[str, str]) -> Optional[str]:
    """从 Authorization 头提取 Bearer Token.

    Args:
        headers: 请求头字典.

    Returns:
        Optional[str]: Bearer Token，不存在或格式错误返回 None.
    """
    auth_header = _get_header(headers, HEADER_AUTHORIZATION)
    if not auth_header:
        return None
    if not auth_header.startswith(BEARER_PREFIX):
        return None
    token = auth_header[len(BEARER_PREFIX):].strip()
    return token or None


def _safe_str_eq(a: str, b: str) -> bool:
    """恒定时间字符串比较，防止时序攻击.

    Args:
        a: 字符串 a.
        b: 字符串 b.

    Returns:
        bool: 相等返回 True.
    """
    import hmac as _hmac

    return _hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
