"""UIAElementCache — UI 元素树缓存与差异检测。

缓存 Windows UI Automation / macOS Accessibility 控件树，
避免重复查询，支持增量差异检测（新增/删除/属性变更的元素）。

P3: 平台特定查询逻辑已抽取到 platform_adapter.py，
UIAElementCache 通过 PlatformAdapter 统一调用。

Usage:
    from agent.perception.uia_cache import UIAElementCache
    cache = UIAElementCache()
    tree = await cache.refresh()
    diff = cache.diff(previous_tree)
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any
from agent.core.logger import StructuredLogger

log = StructuredLogger("uia_cache")




@dataclass
class UIAElementNode:
    """UI 元素节点。

    Attributes:
        id: 元素唯一标识（由路径+类型+名称生成）。
        control_type: 控件类型（Button/Edit/MenuItem 等）。
        name: 元素名称。
        bounds: 元素边界 (x1, y1, x2, y2)。
        is_interactive: 是否可交互。
        children: 子元素列表。
        raw: 原始数据字典。
    """

    id: str = ""
    control_type: str = ""
    name: str = ""
    bounds: str = ""
    is_interactive: bool = False
    children: list[UIAElementNode] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class TreeDiff:
    """UI 元素树差异。

    Attributes:
        added: 新增的元素列表。
        removed: 删除的元素列表。
        changed: 属性变更的元素列表。
        unchanged_count: 未变化的元素数量。
    """

    added: list[UIAElementNode] = field(default_factory=list)
    removed: list[UIAElementNode] = field(default_factory=list)
    changed: list[dict[str, Any]] = field(default_factory=list)
    unchanged_count: int = 0


@dataclass
class CachedTree:
    """缓存的 UI 元素树快照。

    Attributes:
        root: 根节点。
        flat_elements: 扁平化的可交互元素列表。
        timestamp: 快照时间戳。
        source: 数据来源（uia/ocr/dom）。
    """

    root: UIAElementNode = field(default_factory=UIAElementNode)
    flat_elements: list[UIAElementNode] = field(default_factory=list)
    timestamp: float = 0.0
    source: str = "unknown"


class UIAElementCache:
    """UI 元素树缓存管理器。

    缓存 Accessibility Tree 查询结果，支持：
    - 增量刷新：只查询变化部分
    - 差异检测：对比前后两棵树的差异
    - 缓存失效：窗口切换/焦点变更时自动刷新

    Usage:
        cache = UIAElementCache()
        tree = await cache.refresh()
        diff = cache.diff(cache._previous_tree)
    """

    def __init__(self, max_cache_age: float = 5.0, platform_adapter: Any = None) -> None:
        self._current_tree: CachedTree | None = None
        self._previous_tree: CachedTree | None = None
        self._max_cache_age = max_cache_age
        self._last_window_title: str = ""
        self._invalidation_count: int = 0
        if platform_adapter is not None:
            self._adapter = platform_adapter
        else:
            from agent.perception.platform_adapter import create_platform_adapter
            self._adapter = create_platform_adapter()

    @property
    def current(self) -> CachedTree | None:
        return self._current_tree

    @property
    def is_stale(self) -> bool:
        if self._current_tree is None:
            return True
        age = time.time() - self._current_tree.timestamp
        return age > self._max_cache_age

    async def refresh(self, force: bool = False) -> CachedTree:
        """刷新 UI 元素树缓存。

        Args:
            force: 是否强制刷新（忽略缓存有效期）。

        Returns:
            CachedTree: 最新的 UI 元素树快照。
        """
        if not force and not self.is_stale and self._current_tree is not None:
            return self._current_tree

        self._previous_tree = self._current_tree

        elements, source = await self._query_accessibility_tree()

        root = self._build_tree(elements)
        flat = self._flatten_interactive(root)

        self._current_tree = CachedTree(
            root=root,
            flat_elements=flat,
            timestamp=time.time(),
            source=source,
        )

        log.info(
            "UIA缓存刷新",
            source=source,
            total=len(elements),
            interactive=len(flat),
            forced=force,
        )

        return self._current_tree

    def diff(self, old: CachedTree | None = None) -> TreeDiff:
        """对比两棵 UI 元素树的差异。

        Args:
            old: 旧树快照，默认使用 _previous_tree。

        Returns:
            TreeDiff: 差异结果。
        """
        if old is None:
            old = self._previous_tree

        if old is None or self._current_tree is None:
            return TreeDiff()

        old_map = {e.id: e for e in old.flat_elements}
        new_map = {e.id: e for e in self._current_tree.flat_elements}

        added = [e for eid, e in new_map.items() if eid not in old_map]
        removed = [e for eid, e in old_map.items() if eid not in new_map]

        changed: list[dict[str, Any]] = []
        unchanged = 0

        for eid in old_map:
            if eid in new_map:
                old_e = old_map[eid]
                new_e = new_map[eid]
                if old_e.bounds != new_e.bounds or old_e.name != new_e.name:
                    changed.append({
                        "id": eid,
                        "field": "bounds" if old_e.bounds != new_e.bounds else "name",
                        "old": old_e.bounds if old_e.bounds != new_e.bounds else old_e.name,
                        "new": new_e.bounds if old_e.bounds != new_e.bounds else new_e.name,
                    })
                else:
                    unchanged += 1

        return TreeDiff(
            added=added,
            removed=removed,
            changed=changed,
            unchanged_count=unchanged,
        )

    def invalidate(self) -> None:
        """手动失效缓存（窗口切换/焦点变更时调用）。"""
        self._invalidation_count += 1
        if self._current_tree is not None:
            self._previous_tree = self._current_tree
            self._current_tree = None
        log.info("UIA缓存手动失效", total_invalidations=self._invalidation_count)

    def find_by_name(self, name: str, fuzzy: bool = True) -> list[UIAElementNode]:
        """按名称查找元素。

        Args:
            name: 目标名称。
            fuzzy: 是否模糊匹配（子串包含），默认 True。

        Returns:
            匹配的元素列表。
        """
        if self._current_tree is None:
            return []

        results: list[UIAElementNode] = []
        for elem in self._current_tree.flat_elements:
            if fuzzy:
                if name.lower() in elem.name.lower():
                    results.append(elem)
            else:
                if elem.name == name:
                    results.append(elem)
        return results

    def find_by_type(self, control_type: str) -> list[UIAElementNode]:
        """按控件类型查找元素。

        Args:
            control_type: 控件类型（如 Button/Edit）。

        Returns:
            匹配的元素列表。
        """
        if self._current_tree is None:
            return []

        return [
            elem for elem in self._current_tree.flat_elements
            if elem.control_type.lower() == control_type.lower()
        ]

    def get_interactive_count(self) -> int:
        """获取当前缓存中可交互元素数量。"""
        if self._current_tree is None:
            return 0
        return len(self._current_tree.flat_elements)

    async def _query_accessibility_tree(self) -> tuple[list[dict[str, Any]], str]:
        """查询 Accessibility Tree，通过 PlatformAdapter 统一调用。"""
        elements = await self._adapter.query()
        return elements, self._adapter.name

    def _build_tree(self, elements: list[dict[str, Any]]) -> UIAElementNode:
        """从扁平元素列表构建树结构。

        Args:
            elements: 扁平元素列表。

        Returns:
            UIAElementNode: 根节点。
        """
        root = UIAElementNode(id="root", control_type="Root", name="Desktop")

        nodes: list[UIAElementNode] = []
        for elem in elements:
            node = UIAElementNode(
                id=elem.get("id", ""),
                control_type=elem.get("type", ""),
                name=elem.get("name", ""),
                bounds=elem.get("bbox", ""),
                is_interactive=elem.get("is_interactive", False),
                raw=elem,
            )
            nodes.append(node)

        root.children = nodes
        return root

    def _flatten_interactive(self, node: UIAElementNode) -> list[UIAElementNode]:
        """递归提取所有可交互元素。

        Args:
            node: 树节点。

        Returns:
            可交互元素列表。
        """
        result: list[UIAElementNode] = []
        if node.is_interactive and node.id != "root":
            result.append(node)
        for child in node.children:
            result.extend(self._flatten_interactive(child))
        return result
