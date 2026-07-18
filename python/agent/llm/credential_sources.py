"""凭据来源发现模块，从环境变量自动发现 API Key。

提供 CredentialDiscovery 类，用于从环境变量中自动发现各 LLM 提供商的凭据，
支持单 Key、编号后缀多 Key 和逗号分隔多 Key 等模式。
"""
from __future__ import annotations

import os
from typing import Any

from agent.llm.credential_pool import CredentialEntry


class CredentialDiscovery:
    """从环境变量自动发现 LLM 提供商凭据。

    支持的环境变量模式：
        - 单 Key: ``{PROVIDER}_API_KEY``
        - 编号后缀: ``{PROVIDER}_API_KEY_2``, ``{PROVIDER}_API_KEY_3`` ...
        - 逗号分隔: ``{PROVIDER}_API_KEYS="key1,key2,key3"``

    Attributes:
        SUPPORTED_PROVIDERS: 支持的提供商名称列表。

    Usage:
        entries = CredentialDiscovery.discover("openai")
        all_entries = CredentialDiscovery.discover_all()
    """

    SUPPORTED_PROVIDERS: list[str] = [
        "openai",
        "anthropic",
        "google",
        "azure",
        "deepseek",
        "mistral",
        "cohere",
        "groq",
    ]

    @classmethod
    def discover(
        cls,
        provider_name: str,
        env: dict[str, str] | None = None,
    ) -> list[CredentialEntry]:
        """发现指定 provider 的凭据。

        按以下顺序检查环境变量：
        1. ``{PROVIDER}_API_KEY`` （支持逗号分隔多 Key）
        2. ``{PROVIDER}_API_KEY_2``, ``{PROVIDER}_API_KEY_3`` ... （编号后缀）
        3. ``{PROVIDER}_API_KEYS`` （逗号分隔多 Key）

        Args:
            provider_name: 提供商名称（不区分大小写）。
            env: 环境变量字典，默认使用 os.environ。

        Returns:
            list[CredentialEntry]: 发现的凭据条目列表，已去重。
        """
        if env is None:
            env = dict(os.environ)

        prefix = provider_name.upper()
        seen: set[str] = set()
        keys: list[str] = []

        # 1. 主变量 {PROVIDER}_API_KEY（支持逗号分隔）
        main_key = f"{prefix}_API_KEY"
        value = env.get(main_key, "").strip()
        if value:
            for k in value.split(","):
                k = k.strip()
                if k and k not in seen:
                    keys.append(k)
                    seen.add(k)

        # 2. 编号后缀 {PROVIDER}_API_KEY_2, _3, ...
        i = 2
        while True:
            suffixed_key = f"{main_key}_{i}"
            v = env.get(suffixed_key, "").strip()
            if not v:
                break
            if v not in seen:
                keys.append(v)
                seen.add(v)
            i += 1

        # 3. 逗号分隔变量 {PROVIDER}_API_KEYS
        multi_key = f"{prefix}_API_KEYS"
        multi_value = env.get(multi_key, "").strip()
        if multi_value:
            for k in multi_value.split(","):
                k = k.strip()
                if k and k not in seen:
                    keys.append(k)
                    seen.add(k)

        return [
            CredentialEntry(key=k, label=f"{provider_name}-{idx}")
            for idx, k in enumerate(keys, 1)
        ]

    @classmethod
    def discover_all(
        cls,
        env: dict[str, str] | None = None,
    ) -> dict[str, list[CredentialEntry]]:
        """发现所有 SUPPORTED_PROVIDERS 的凭据。

        Args:
            env: 环境变量字典，默认使用 os.environ。

        Returns:
            dict[str, list[CredentialEntry]]: 提供商名称 -> 凭据条目列表。
                仅包含发现到凭据的提供商。
        """
        result: dict[str, list[CredentialEntry]] = {}
        for provider in cls.SUPPORTED_PROVIDERS:
            entries = cls.discover(provider, env=env)
            if entries:
                result[provider] = entries
        return result
