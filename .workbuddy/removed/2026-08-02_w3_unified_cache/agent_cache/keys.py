"""缓存键构建工具。

提供统一的缓存键生成策略，确保不同模块使用一致的键格式。
"""

from __future__ import annotations

import hashlib
import json


class CacheKeyBuilder:
    """缓存键构建工具。

    提供统一的键生成方法，支持命名空间前缀、哈希摘要和结构化键。

    Usage:
        builder = CacheKeyBuilder(namespace="llm")

        # 从字符串生成键
        key = builder.from_string("gpt-4", "hello world")

        # 从结构体生成键
        key = builder.from_dict("completion", {"model": "gpt-4", "prompt": "hello"})

        # 带命名空间的键
        key = builder.namespaced("responses", "abc123")
    """

    _SEPARATOR = ":"

    def __init__(self, namespace: str = "") -> None:
        """初始化键构建器。

        Args:
            namespace: 命名空间前缀。
        """
        self._namespace = namespace

    @property
    def namespace(self) -> str:
        """命名空间。"""
        return self._namespace

    def from_string(self, category: str, content: str) -> str:
        """从字符串内容生成缓存键。

        使用 SHA256 哈希摘要缩短键长度。

        Args:
            category: 类别（如 "completion", "embedding"）。
            content: 内容字符串。

        Returns:
            缓存键，格式为 "namespace:category:sha256"。
        """
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
        return self._build(category, digest)

    def from_dict(self, category: str, data: dict) -> str:
        """从字典生成缓存键。

        使用 JSON 序列化 + SHA256 确保键的确定性。

        Args:
            category: 类别。
            data: 字典数据。

        Returns:
            缓存键。
        """
        serialized = json.dumps(data, sort_keys=True, ensure_ascii=False, default=str)
        return self.from_string(category, serialized)

    def from_args(self, category: str, *args, **kwargs) -> str:
        """从位置参数和关键字参数生成缓存键。

        Args:
            category: 类别。
            *args: 位置参数。
            **kwargs: 关键字参数。

        Returns:
            缓存键。
        """
        data = {"args": args, "kwargs": kwargs}
        return self.from_dict(category, data)

    def namespaced(self, category: str, identifier: str) -> str:
        """生成带命名空间的缓存键（不哈希）。

        Args:
            category: 类别。
            identifier: 标识符。

        Returns:
            缓存键，格式为 "namespace:category:identifier"。
        """
        return self._build(category, identifier)

    def prefix(self, category: str = "") -> str:
        """生成缓存键前缀。

        Args:
            category: 类别，空字符串表示所有类别。

        Returns:
            前缀字符串，格式为 "namespace:category:" 或 "namespace:"。
        """
        parts = [self._namespace] if self._namespace else []
        if category:
            parts.append(category)
        prefix = self._SEPARATOR.join(parts)
        return f"{prefix}{self._SEPARATOR}" if prefix else ""

    def _build(self, category: str, suffix: str) -> str:
        """构建完整键。

        Args:
            category: 类别。
            suffix: 键后缀。

        Returns:
            完整键。
        """
        parts = [self._namespace] if self._namespace else []
        parts.append(category)
        parts.append(suffix)
        return self._SEPARATOR.join(parts)

    @staticmethod
    def parse(key: str) -> dict[str, str]:
        """解析缓存键为组成部分。

        Args:
            key: 缓存键。

        Returns:
            包含 namespace, category, suffix 的字典。
        """
        parts = key.split(CacheKeyBuilder._SEPARATOR)
        if len(parts) == 2:
            return {"namespace": "", "category": parts[0], "suffix": parts[1]}
        elif len(parts) >= 3:
            return {"namespace": parts[0], "category": parts[1], "suffix": parts[2]}
        return {"namespace": "", "category": "", "suffix": key}
