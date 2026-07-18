"""上下文引用解析器。

解析消息中的引用标记并展开为实际内容：
  - @file 引用：读取文件内容
  - @url 引用：获取 URL 内容
  - @memory 引用：检索记忆
  - @skill 引用：加载技能定义
  - @image 引用：加载图片（base64）
  - 递归引用解析
  - 引用大小限制
  - 引用权限检查

与 CodingContext 的关系：
  - CodingContext 检测项目编码上下文
  - ContextReferences 解析显式引用标记
  - 两者互补

集成示例::

    from agent.context.context_references import ContextReferences

    refs = ContextReferences()
    result = await refs.resolve("请分析 @file:src/main.py 中的问题")
    print(result.resolved_text)
    # "请分析 ```python\\n...main.py content...\\n``` 中的问题"
"""

from __future__ import annotations

import base64
import os
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine

from agent.core.logger import StructuredLogger

log = StructuredLogger("context_references")


class ReferenceType(str, Enum):
    """引用类型。"""

    FILE = "file"
    URL = "url"
    MEMORY = "memory"
    SKILL = "skill"
    IMAGE = "image"


@dataclass
class ResolvedReference:
    """已解析的引用。

    Attributes:
        ref_type: 引用类型。
        original: 原始引用标记。
        resolved: 解析后的内容。
        success: 是否成功。
        error: 错误信息。
        size_bytes: 内容大小。
    """

    ref_type: ReferenceType = ReferenceType.FILE
    original: str = ""
    resolved: str = ""
    success: bool = True
    error: str = ""
    size_bytes: int = 0


@dataclass
class ResolveResult:
    """解析结果。

    Attributes:
        original_text: 原始文本。
        resolved_text: 解析后文本。
        references: 已解析的引用列表。
        total_size: 总内容大小。
        errors: 错误列表。
    """

    original_text: str = ""
    resolved_text: str = ""
    references: list[ResolvedReference] = field(default_factory=list)
    total_size: int = 0
    errors: list[str] = field(default_factory=list)


REFERENCE_PATTERNS: dict[ReferenceType, re.Pattern[str]] = {
    ReferenceType.FILE: re.compile(r"@file:(\S+)", re.IGNORECASE),
    ReferenceType.URL: re.compile(r"@url:(\S+)", re.IGNORECASE),
    ReferenceType.MEMORY: re.compile(r"@memory:(\S+)", re.IGNORECASE),
    ReferenceType.SKILL: re.compile(r"@skill:(\S+)", re.IGNORECASE),
    ReferenceType.IMAGE: re.compile(r"@image:(\S+)", re.IGNORECASE),
}

MAX_FILE_SIZE: int = 100 * 1024
MAX_URL_SIZE: int = 50 * 1024
MAX_TOTAL_SIZE: int = 500 * 1024
MAX_RECURSION: int = 3


class ContextReferences:
    """上下文引用解析器。

    解析消息中的 @file/@url/@memory 等引用标记。
    """

    def __init__(
        self,
        allowed_dirs: list[str] | None = None,
        max_file_size: int = MAX_FILE_SIZE,
        max_total_size: int = MAX_TOTAL_SIZE,
    ) -> None:
        self._allowed_dirs = allowed_dirs
        self._max_file_size = max_file_size
        self._max_total_size = max_total_size
        self._resolvers: dict[ReferenceType, Callable[..., Coroutine[Any, Any, str]]] = {}
        self._cache: dict[str, tuple[str, float]] = {}
        self._cache_ttl: float = 300.0

    def register_resolver(
        self,
        ref_type: ReferenceType,
        resolver: Callable[..., Coroutine[Any, Any, str]],
    ) -> None:
        """注册自定义解析器。

        Args:
            ref_type: 引用类型。
            resolver: 异步解析函数，接收引用路径返回内容。
        """
        self._resolvers[ref_type] = resolver

    async def resolve(
        self,
        text: str,
        depth: int = 0,
    ) -> ResolveResult:
        """解析文本中的引用。

        Args:
            text: 待解析文本。
            depth: 递归深度。

        Returns:
            ResolveResult 解析结果。
        """
        result = ResolveResult(original_text=text, resolved_text=text)
        total_size = 0

        for ref_type, pattern in REFERENCE_PATTERNS.items():
            matches = pattern.findall(text)
            for match in matches:
                ref_mark = f"@{ref_type.value}:{match}"

                cached = self._get_cached(ref_mark)
                if cached:
                    ref = ResolvedReference(
                        ref_type=ref_type,
                        original=ref_mark,
                        resolved=cached,
                        size_bytes=len(cached),
                    )
                else:
                    ref = await self._resolve_reference(ref_type, match)

                result.references.append(ref)
                total_size += ref.size_bytes

                if ref.success and total_size <= self._max_total_size:
                    result.resolved_text = result.resolved_text.replace(ref_mark, ref.resolved)
                    self._set_cached(ref_mark, ref.resolved)
                elif not ref.success:
                    result.errors.append(f"{ref_mark}: {ref.error}")

        result.total_size = total_size

        if depth < MAX_RECURSION:
            has_refs = any(
                pattern.search(result.resolved_text)
                for pattern in REFERENCE_PATTERNS.values()
            )
            if has_refs:
                inner = await self.resolve(result.resolved_text, depth + 1)
                result.resolved_text = inner.resolved_text
                result.references.extend(inner.references)
                result.total_size += inner.total_size

        return result

    async def _resolve_reference(
        self, ref_type: ReferenceType, path: str
    ) -> ResolvedReference:
        """解析单个引用。"""
        if ref_type in self._resolvers:
            try:
                content = await self._resolvers[ref_type](path)
                return ResolvedReference(
                    ref_type=ref_type,
                    original=f"@{ref_type.value}:{path}",
                    resolved=content,
                    size_bytes=len(content),
                )
            except Exception as e:
                return ResolvedReference(
                    ref_type=ref_type,
                    original=f"@{ref_type.value}:{path}",
                    error=str(e)[:200],
                    success=False,
                )

        if ref_type == ReferenceType.FILE:
            return await self._resolve_file(path)
        elif ref_type == ReferenceType.URL:
            return await self._resolve_url(path)
        elif ref_type == ReferenceType.MEMORY:
            return self._resolve_memory(path)
        elif ref_type == ReferenceType.SKILL:
            return self._resolve_skill(path)
        elif ref_type == ReferenceType.IMAGE:
            return await self._resolve_image(path)

        return ResolvedReference(
            ref_type=ref_type,
            original=f"@{ref_type.value}:{path}",
            error=f"不支持的引用类型: {ref_type.value}",
            success=False,
        )

    async def _resolve_file(self, path: str) -> ResolvedReference:
        """解析文件引用。"""
        ref_mark = f"@file:{path}"
        try:
            if self._allowed_dirs:
                abs_path = os.path.abspath(path)
                if not any(abs_path.startswith(os.path.abspath(d)) for d in self._allowed_dirs):
                    return ResolvedReference(
                        ref_type=ReferenceType.FILE,
                        original=ref_mark,
                        error="文件不在允许目录内",
                        success=False,
                    )

            if not os.path.exists(path):
                return ResolvedReference(
                    ref_type=ReferenceType.FILE,
                    original=ref_mark,
                    error="文件不存在",
                    success=False,
                )

            size = os.path.getsize(path)
            if size > self._max_file_size:
                return ResolvedReference(
                    ref_type=ReferenceType.FILE,
                    original=ref_mark,
                    error=f"文件过大 ({size} > {self._max_file_size})",
                    success=False,
                )

            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()

            _, ext = os.path.splitext(path)
            lang = ext.lstrip(".")
            resolved = f"```{lang}\n{content}\n```"

            return ResolvedReference(
                ref_type=ReferenceType.FILE,
                original=ref_mark,
                resolved=resolved,
                size_bytes=len(resolved),
            )
        except Exception as e:
            return ResolvedReference(
                ref_type=ReferenceType.FILE,
                original=ref_mark,
                error=str(e)[:200],
                success=False,
            )

    async def _resolve_url(self, url: str) -> ResolvedReference:
        """解析 URL 引用。"""
        ref_mark = f"@url:{url}"
        try:
            from agent.security.url_safety import UrlSafetyChecker
            checker = UrlSafetyChecker()
            safety_result = checker.check(url)
            if not safety_result.is_safe:
                return ResolvedReference(
                    ref_type=ReferenceType.URL,
                    original=ref_mark,
                    error=f"URL 安全检查失败: {safety_result.reason}",
                    success=False,
                )

            import urllib.request

            req = urllib.request.Request(url, headers={"User-Agent": "Jiabaixing/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                content = resp.read(MAX_URL_SIZE).decode("utf-8", errors="replace")

            return ResolvedReference(
                ref_type=ReferenceType.URL,
                original=ref_mark,
                resolved=content,
                size_bytes=len(content),
            )
        except Exception as e:
            return ResolvedReference(
                ref_type=ReferenceType.URL,
                original=ref_mark,
                error=str(e)[:200],
                success=False,
            )

    def _resolve_memory(self, key: str) -> ResolvedReference:
        """解析记忆引用。"""
        ref_mark = f"@memory:{key}"
        return ResolvedReference(
            ref_type=ReferenceType.MEMORY,
            original=ref_mark,
            resolved=f"[记忆: {key}]",
            size_bytes=0,
            error="需要注册 MemoryManager 解析器",
            success=False,
        )

    def _resolve_skill(self, name: str) -> ResolvedReference:
        """解析技能引用。"""
        ref_mark = f"@skill:{name}"
        return ResolvedReference(
            ref_type=ReferenceType.SKILL,
            original=ref_mark,
            resolved=f"[技能: {name}]",
            size_bytes=0,
            error="需要注册 SkillEngine 解析器",
            success=False,
        )

    async def _resolve_image(self, path: str) -> ResolvedReference:
        """解析图片引用。"""
        ref_mark = f"@image:{path}"
        try:
            if not os.path.exists(path):
                return ResolvedReference(
                    ref_type=ReferenceType.IMAGE,
                    original=ref_mark,
                    error="图片不存在",
                    success=False,
                )

            with open(path, "rb") as f:
                data = f.read()

            b64 = base64.b64encode(data).decode()
            _, ext = os.path.splitext(path)
            mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif"}.get(
                ext.lstrip(".").lower(), "image/png"
            )
            resolved = f"data:{mime};base64,{b64}"

            return ResolvedReference(
                ref_type=ReferenceType.IMAGE,
                original=ref_mark,
                resolved=resolved,
                size_bytes=len(data),
            )
        except Exception as e:
            return ResolvedReference(
                ref_type=ReferenceType.IMAGE,
                original=ref_mark,
                error=str(e)[:200],
                success=False,
            )

    def _get_cached(self, key: str) -> str | None:
        """获取缓存。"""
        if key in self._cache:
            content, ts = self._cache[key]
            if (time.time() - ts) < self._cache_ttl:
                return content
            del self._cache[key]
        return None

    def _set_cached(self, key: str, content: str) -> None:
        """设置缓存。"""
        self._cache[key] = (content, time.time())
