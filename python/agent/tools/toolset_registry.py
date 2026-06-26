from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import ToolCategory, ToolRegistry

log = StructuredLogger("toolset_registry")


@dataclass
class ToolsetEntry:
    """工具集条目——单个包含规则。

    Attributes:
        name: 工具名称，为None时匹配所有工具。
        category: 工具分类，为None时匹配所有分类。
    """

    name: str | None = None
    category: ToolCategory | None = None


@dataclass
class ToolsetDefinition:
    """工具集定义——按场景预组装的工具包。

    Attributes:
        id: 唯一标识。
        display_name: 显示名称。
        description: 描述。
        includes: 包含的工具列表（名称或分类）。
        excludes: 排除的工具名称列表。
        extends: 继承的父工具集ID。
        max_tools: 最大工具数限制，0表示不限制。
    """

    id: str
    display_name: str
    description: str
    includes: list[ToolsetEntry] = field(default_factory=list)
    excludes: list[str] = field(default_factory=list)
    extends: str | None = None
    max_tools: int = 0


@dataclass
class ResolvedToolset:
    """解析后的工具集——已展开所有继承和分类。

    Attributes:
        id: 工具集ID。
        display_name: 显示名称。
        tool_names: 最终解析出的工具名称列表。
        resolved_from: 解析链（包含继承的父工具集）。
    """

    id: str
    display_name: str
    tool_names: list[str]
    resolved_from: list[str]


class ToolsetRegistry:
    """工具集注册中心。

    管理工具集的注册、继承和解析。支持按名称/分类包含工具、
    按名称排除工具、继承父工具集和工具数量上限。

    Usage:
        registry = ToolsetRegistry()
        registry.register(ToolsetDefinition(
            id="code", display_name="编码工具", description="...",
            includes=[ToolsetEntry(category=ToolCategory.CODE)],
        ))
        resolved = registry.resolve("code", tool_registry)
    """
    def __init__(self) -> None:
        self._definitions: dict[str, ToolsetDefinition] = {}
        self._resolved_cache: dict[str, ResolvedToolset] = {}

    def register(self, definition: ToolsetDefinition) -> None:
        if definition.id in self._definitions:
            log.debug(f"工具集已存在，覆盖: {definition.id}")
        self._definitions[definition.id] = definition
        self._resolved_cache.pop(definition.id, None)
        log.info(f"注册工具集: {definition.id} ({definition.display_name})")

    def get(self, id: str) -> ToolsetDefinition | None:
        return self._definitions.get(id)

    def list(self) -> list[str]:
        return list(self._definitions.keys())

    def resolve(self, id: str, tool_registry: ToolRegistry) -> ResolvedToolset | None:
        if id in self._resolved_cache:
            return self._resolved_cache[id]

        definition = self._definitions.get(id)
        if not definition:
            log.warning(f"工具集不存在: {id}")
            return None

        resolved_from: list[str] = []
        tool_name_set: set[str] = set()

        if definition.extends:
            parent = self.resolve(definition.extends, tool_registry)
            if parent:
                resolved_from.extend(parent.resolved_from)
                for name in parent.tool_names:
                    tool_name_set.add(name)

        resolved_from.append(definition.id)

        for entry in definition.includes:
            if entry.name:
                if tool_registry.has(entry.name):
                    tool_name_set.add(entry.name)
                else:
                    log.warning(f"工具集 {id} 引用了不存在的工具: {entry.name}")
            elif entry.category:
                tools = tool_registry.get_by_category(entry.category)
                for t in tools:
                    tool_name_set.add(t.name)

        for name in definition.excludes:
            tool_name_set.discard(name)

        tool_names = list(tool_name_set)

        if definition.max_tools and definition.max_tools > 0 and len(tool_names) > definition.max_tools:
            tool_names = tool_names[:definition.max_tools]

        resolved = ResolvedToolset(
            id=definition.id,
            display_name=definition.display_name,
            tool_names=tool_names,
            resolved_from=resolved_from,
        )

        self._resolved_cache[id] = resolved
        return resolved

    def resolve_to_openai(self, id: str, tool_registry: ToolRegistry) -> list[dict[str, Any]]:
        resolved = self.resolve(id, tool_registry)
        if not resolved:
            return []

        all_openai_tools = tool_registry.to_openai_tools()
        name_set = set(resolved.tool_names)

        return [
            t for t in all_openai_tools
            if t.get("function", {}).get("name") in name_set
        ]

    def invalidate_cache(self, id: str | None = None) -> None:
        if id:
            self._resolved_cache.pop(id, None)
        else:
            self._resolved_cache.clear()


_global_toolset_registry: ToolsetRegistry | None = None


def get_toolset_registry() -> ToolsetRegistry:
    global _global_toolset_registry
    if _global_toolset_registry is None:
        _global_toolset_registry = ToolsetRegistry()
    return _global_toolset_registry


def reset_toolset_registry() -> None:
    global _global_toolset_registry
    _global_toolset_registry = None
