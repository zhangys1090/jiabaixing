"""凭据持久化模块，将凭据条目安全存储到磁盘。

提供 CredentialStore 类，用于将 CredentialEntry 列表持久化到
DATA_DIR/credentials/ 目录下的 JSON 文件中。Key 在磁盘上做简单混淆（Base64 编码），
文件权限设置为 600（仅所有者可读写）。
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.llm.credential_pool import CredentialEntry
from agent.core.logger import log_ignored
import logging
logger = logging.getLogger(__name__)


class CredentialStore:
    """凭据持久化存储，将凭据条目安全保存到磁盘。

    将 CredentialEntry 列表以 JSON 格式存储到 DATA_DIR/credentials/ 目录。
    Key 在磁盘上通过 Base64 编码做简单混淆，文件权限设为 600。

    Attributes:
        _store_dir: 凭据文件存储目录。

    Usage:
        store = CredentialStore()
        entries = [CredentialEntry(key="sk-xxx", label="openai-1")]
        store.save("openai", entries)
        loaded = store.load("openai")
    """

    def __init__(self, store_dir: Path | None = None) -> None:
        """初始化凭据持久化存储。

        Args:
            store_dir: 存储目录路径，默认为 DATA_DIR/credentials/。
        """
        self._store_dir = store_dir or (DATA_DIR / "credentials")
        self._store_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _obfuscate(value: str) -> str:
        """对值做简单混淆（Base64 编码），避免明文存储。

        注意：这不是加密，仅做基础混淆以避免 Key 在磁盘上以明文出现。

        Args:
            value: 待混淆的原始值。

        Returns:
            str: Base64 编码后的字符串。
        """
        return base64.b64encode(value.encode("utf-8")).decode("ascii")

    @staticmethod
    def _deobfuscate(value: str) -> str:
        """还原混淆值（Base64 解码）。

        Args:
            value: Base64 编码的字符串。

        Returns:
            str: 还原后的原始值。解码失败时返回空字符串。
        """
        try:
            return base64.b64decode(value.encode("ascii")).decode("utf-8")
        except Exception as e:
            logger.warning("credential_persistence._decode 凭据解码失败", error=str(e))
            return ""

    def _provider_path(self, provider_name: str) -> Path:
        """获取指定 provider 的文件路径。

        Args:
            provider_name: 提供商名称。

        Returns:
            Path: JSON 文件路径。
        """
        return self._store_dir / f"{provider_name}.json"

    def save(self, provider_name: str, entries: list[CredentialEntry]) -> None:
        """保存凭据列表到 JSON 文件。

        使用原子写入（先写临时文件再重命名），Key 做混淆处理，
        文件权限设为 600。

        Args:
            provider_name: 提供商名称，用作文件名。
            entries: 凭据条目列表。
        """
        data: dict[str, Any] = {
            "provider": provider_name,
            "credentials": [
                {
                    "key": self._obfuscate(e.key),
                    "weight": e.weight,
                    "label": e.label,
                }
                for e in entries
            ],
        }
        target_path = self._provider_path(provider_name)
        tmp_path = target_path.with_suffix(".tmp")

        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        # 设置文件权限 600（仅所有者可读写）
        try:
            os.chmod(tmp_path, 0o600)
        except OSError as _exc:
            log_ignored(None, "credential_persistence.CredentialStore.save", _exc)

        tmp_path.replace(target_path)

    def load(self, provider_name: str) -> list[CredentialEntry]:
        """从文件加载凭据列表。

        Args:
            provider_name: 提供商名称。

        Returns:
            list[CredentialEntry]: 凭据条目列表。文件不存在或解析失败时返回空列表。
        """
        path = self._provider_path(provider_name)
        if not path.exists():
            return []

        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            return []

        entries: list[CredentialEntry] = []
        for item in data.get("credentials", []):
            key = self._deobfuscate(item.get("key", ""))
            if not key:
                continue
            entries.append(
                CredentialEntry(
                    key=key,
                    weight=item.get("weight", 1.0),
                    label=item.get("label", ""),
                )
            )
        return entries

    def delete(self, provider_name: str) -> bool:
        """删除指定 provider 的凭据文件。

        Args:
            provider_name: 提供商名称。

        Returns:
            bool: 是否成功删除。文件不存在时返回 False。
        """
        path = self._provider_path(provider_name)
        if path.exists():
            path.unlink()
            return True
        return False

    def list_providers(self) -> list[str]:
        """列出已存储的所有 provider。

        Returns:
            list[str]: provider 名称列表，按字母排序。
        """
        providers: list[str] = []
        for path in self._store_dir.glob("*.json"):
            providers.append(path.stem)
        return sorted(providers)
