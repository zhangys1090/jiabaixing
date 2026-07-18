"""窄腰目录（Extension Catalog）—— catalog 化窄腰核心 + 边缘能力。

对标 Hermes 的"窄腰核心 + catalog 驱动扩展"：核心只保留最小必需能力，
其余（skills / mcps / toolsets 等）以**可选目录**形式存在，默认不启用，
由环境变量显式开启。避免业务插件污染核心 tool schema（§0.3 守卫意图）。

解决的问题（原理念差距）：
  - 此前 optional-skills / optional-mcps 仅停留在 AGENTS.md 原则，未成体系。
  - 本模块提供统一的"可选能力目录"抽象：声明 → 默认禁用 → env 显式启用。

设计（对齐 AGENTS.md §0.1，Python 主实现）：
  - 纯逻辑，不依赖文件系统/网络；env 解析可注入便于测试。
  - 三种状态：builtin（始终启用）/ optional（默认禁用，需开启）/ disabled（强制关闭）。
  - 启用表达式：``AGENT_OPTIONAL_EXTENSIONS="skill:foo,mcp:bar,toolset:baz"``，
    或用 ``*`` 通配开启全部 optional。

Usage:
    cat = ExtensionCatalog()
    cat.register("skill:code_review", ExtensionState.OPTIONAL)
    cat.register("mcp:github", ExtensionState.OPTIONAL)
    cat.apply_env("skill:code_review")          # 或 EXTENSIONS_ENV
    cat.is_enabled("skill:code_review")         # True
    cat.is_enabled("mcp:github")                # False（未开启）
    cat.list_enabled()
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Iterable

from agent.core.logger import StructuredLogger

log = StructuredLogger("extension_catalog")

#: 通过该环境变量开启可选能力，逗号分隔 "kind:id" 列表，或用 * 开启全部。
EXTENSIONS_ENV = "AGENT_OPTIONAL_EXTENSIONS"


class ExtensionState(str, Enum):
    """能力状态。"""

    BUILTIN = "builtin"      # 核心内置，始终启用（不可关）
    OPTIONAL = "optional"    # 可选，默认禁用，需显式开启
    DISABLED = "disabled"    # 强制关闭（即便 env 声明也不启用）


@dataclass
class ExtensionEntry:
    """目录中的单个可选能力。"""

    ref: str                       # "kind:id"，如 "skill:code_review"
    state: ExtensionState = ExtensionState.OPTIONAL
    description: str = ""
    #: 若设置，仅在该环境变量存在（或为真）时才视作可用（如需要外部 token）。
    requires_env: str | None = None


def _parse_extensions_env(value: str | None) -> set[str]:
    """解析启用表达式 → 集合。支持 ``*`` 通配全部 optional。"""
    if not value:
        return set()
    tokens = [t.strip() for t in value.split(",") if t.strip()]
    return set(tokens)


class ExtensionCatalog:
    """窄腰能力目录：声明可选能力并按 env 解析启用状态。"""

    def __init__(self, extensions: Iterable[ExtensionEntry] | None = None) -> None:
        self._entries: dict[str, ExtensionEntry] = {}
        self._enabled_refs: set[str] = set()
        self._env_getter: Callable[[str], str | None] = lambda k: os.environ.get(k)
        for e in extensions or []:
            self._entries[e.ref] = e

    # ─── 声明 ───

    def register(
        self,
        ref: str,
        state: ExtensionState = ExtensionState.OPTIONAL,
        description: str = "",
        requires_env: str | None = None,
    ) -> None:
        """登记一个可选能力。重复 ref 覆盖。"""
        self._entries[ref] = ExtensionEntry(
            ref=ref, state=state, description=description, requires_env=requires_env
        )

    def register_many(self, entries: Iterable[ExtensionEntry]) -> None:
        for e in entries:
            self._entries[e.ref] = e

    def deregister(self, ref: str) -> None:
        self._entries.pop(ref, None)

    def entries(self) -> list[ExtensionEntry]:
        return list(self._entries.values())

    # ─── 启用解析 ───

    def apply_env(self, value: str | None, env_getter: "Callable[[str], str | None] | None" = None) -> None:
        """应用启用表达式（通常来自 EXTENSIONS_ENV）。

        Args:
            value: 启用表达式字符串；``*`` 表示开启所有 optional。
            env_getter: 可选的 env 读取函数（默认 os.environ.get），便于测试注入。
                该 getter 会被保存，供后续 is_enabled 复用，保证 requires_env
                闸门与本次启用解析使用同一环境视图。
        """
        self._env_getter = env_getter or (lambda k: os.environ.get(k))
        getter = self._env_getter
        enabled = _parse_extensions_env(value)
        self._enabled_refs.clear()
        for ref, entry in self._entries.items():
            if entry.state is ExtensionState.BUILTIN:
                self._enabled_refs.add(ref)
                continue
            if entry.state is ExtensionState.DISABLED:
                continue
            # OPTIONAL：env 含该 ref 或通配 * 才启用
            if ref in enabled or "*" in enabled:
                self._enabled_refs.add(ref)
        # 注：requires_env 闸门统一在 is_enabled() 中执行，避免状态与声明态耦合。

    # ─── 查询 ───

    def is_enabled(self, ref: str, env_getter: "Callable[[str], str | None] | None" = None) -> bool:
        entry = self._entries.get(ref)
        if entry is None:
            return False
        if entry.state is ExtensionState.DISABLED:
            return False
        getter = env_getter or self._env_getter
        # requires_env 闸门：缺少必需环境变量则不可用（builtin/optional 通用）
        if entry.requires_env and getter(entry.requires_env) in (None, "", "0", "false"):
            return False
        if entry.state is ExtensionState.BUILTIN:
            return True
        return ref in self._enabled_refs

    def is_known(self, ref: str) -> bool:
        return ref in self._entries

    def list_enabled(self) -> list[str]:
        return sorted(r for r in self._entries if self.is_enabled(r))

    def list_optional(self) -> list[str]:
        return sorted(
            r for r, e in self._entries.items() if e.state is ExtensionState.OPTIONAL
        )

    def summary(self) -> dict[str, list[str]]:
        return {
            "builtin": sorted(r for r, e in self._entries.items() if e.state is ExtensionState.BUILTIN),
            "optional": self.list_optional(),
            "disabled": sorted(r for r, e in self._entries.items() if e.state is ExtensionState.DISABLED),
            "enabled": self.list_enabled(),
        }
