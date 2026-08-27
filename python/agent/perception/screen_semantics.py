"""V1: 屏幕语义理解引擎 — 从像素到意义的跃迁。

现有 VisualGrounding 只做"定位"（description → coordinates），
本模块补全"理解"层：将屏幕内容解析为结构化语义场景，
包括场景识别、UI元素关系图、语义区域划分。

三级理解：
1. 场景识别（Scene Recognition）：当前是什么应用/页面/对话框
2. 语义区域划分（Semantic Region）：导航栏/内容区/侧边栏/对话框/状态栏
3. UI关系图（UI Relation Graph）：元素间的父子/兄弟/空间关系

Usage:
    from agent.perception.screen_semantics import ScreenSemanticsEngine
    engine = ScreenSemanticsEngine()
    scene = await engine.analyze()
    print(scene.app_name, scene.scene_type, scene.regions)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("screen_semantics")


class SceneType(str, Enum):
    DESKTOP = "desktop"
    BROWSER = "browser"
    DIALOG = "dialog"
    FILE_MANAGER = "file_manager"
    TERMINAL = "terminal"
    EDITOR = "editor"
    SETTINGS = "settings"
    LOGIN = "login"
    CHAT = "chat"
    MEDIA_VIEWER = "media_viewer"
    NOTIFICATION = "notification"
    SPLASH = "splash"
    UNKNOWN = "unknown"


class SemanticRegionType(str, Enum):
    NAVIGATION_BAR = "navigation_bar"
    TOOLBAR = "toolbar"
    SIDEBAR = "sidebar"
    CONTENT_AREA = "content_area"
    STATUS_BAR = "status_bar"
    DIALOG = "dialog"
    TAB_BAR = "tab_bar"
    SEARCH_BAR = "search_bar"
    FORM_AREA = "form_area"
    LIST_VIEW = "list_view"
    DETAIL_PANEL = "detail_panel"
    FOOTER = "footer"
    MENU = "menu"
    TOOLTIP = "tooltip"
    UNKNOWN = "unknown"


@dataclass
class SemanticRegion:
    region_type: SemanticRegionType
    bounds: tuple[int, int, int, int]
    confidence: float = 0.8
    elements: list[dict[str, Any]] = field(default_factory=list)
    label: str = ""


@dataclass
class UIRelationNode:
    element_id: str
    control_type: str
    name: str
    bounds: tuple[int, int, int, int]
    depth: int = 0


@dataclass
class UIRelationEdge:
    source_id: str
    target_id: str
    relation: str
    confidence: float = 1.0


@dataclass
class UIRelationGraph:
    nodes: list[UIRelationNode] = field(default_factory=list)
    edges: list[UIRelationEdge] = field(default_factory=list)

    def find_by_name(self, name: str) -> list[UIRelationNode]:
        name_lower = name.lower()
        return [n for n in self.nodes if name_lower in n.name.lower()]

    def find_by_type(self, control_type: str) -> list[UIRelationNode]:
        return [n for n in self.nodes if n.control_type == control_type]

    def get_children(self, element_id: str) -> list[UIRelationNode]:
        child_ids = [e.target_id for e in self.edges if e.source_id == element_id and e.relation == "parent-child"]
        return [n for n in self.nodes if n.element_id in child_ids]

    def get_siblings(self, element_id: str) -> list[UIRelationNode]:
        sibling_ids: set[str] = set()
        for edge in self.edges:
            if edge.target_id == element_id and edge.relation == "parent-child":
                for other in self.edges:
                    if other.source_id == edge.source_id and other.relation == "parent-child" and other.target_id != element_id:
                        sibling_ids.add(other.target_id)
        return [n for n in self.nodes if n.element_id in sibling_ids]

    def get_spatial_neighbors(self, element_id: str, direction: str = "right") -> list[UIRelationNode]:
        neighbor_ids = [e.target_id for e in self.edges if e.source_id == element_id and e.relation == f"spatial-{direction}"]
        return [n for n in self.nodes if n.element_id in neighbor_ids]


@dataclass
class ScreenScene:
    app_name: str = ""
    window_title: str = ""
    scene_type: SceneType = SceneType.UNKNOWN
    scene_confidence: float = 0.0
    regions: list[SemanticRegion] = field(default_factory=list)
    relation_graph: UIRelationGraph = field(default_factory=UIRelationGraph)
    interactive_elements: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""
    timestamp: float = 0.0
    duration_ms: float = 0.0


_APP_SCENE_HINTS: dict[str, tuple[SceneType, float]] = {
    "chrome": (SceneType.BROWSER, 0.9),
    "firefox": (SceneType.BROWSER, 0.9),
    "edge": (SceneType.BROWSER, 0.9),
    "safari": (SceneType.BROWSER, 0.9),
    "explorer": (SceneType.FILE_MANAGER, 0.85),
    "finder": (SceneType.FILE_MANAGER, 0.85),
    "cmd": (SceneType.TERMINAL, 0.9),
    "powershell": (SceneType.TERMINAL, 0.9),
    "terminal": (SceneType.TERMINAL, 0.9),
    "code": (SceneType.EDITOR, 0.85),
    "vim": (SceneType.EDITOR, 0.8),
    "notepad": (SceneType.EDITOR, 0.7),
    "settings": (SceneType.SETTINGS, 0.9),
    "login": (SceneType.LOGIN, 0.85),
    "wechat": (SceneType.CHAT, 0.9),
    "telegram": (SceneType.CHAT, 0.9),
    "slack": (SceneType.CHAT, 0.85),
    "discord": (SceneType.CHAT, 0.85),
}

_INTERACTIVE_TYPES = {"button", "link", "menuitem", "tab", "checkbox", "radio", "combobox", "textbox", "slider", "scrollbar"}


class ScreenSemanticsEngine:
    """V1: 屏幕语义理解引擎.

    三级理解流水线：
    1. 场景识别：通过窗口标题+进程名推断当前场景类型
    2. 语义区域划分：将屏幕元素按空间位置归类为语义区域
    3. UI关系图构建：分析元素间的父子/兄弟/空间关系

    设计原则：
    - 渐进式：每级理解独立可用，不依赖后续级
    - 非阻塞：任何一级失败不阻断整体，降级返回部分结果
    - 可缓存：ScreenScene 可被记忆系统存储，实现跨会话场景复用
    """

    def __init__(self, llm: Any = None) -> None:
        self._llm = llm
        self._scene_cache: dict[str, ScreenScene] = {}
        self._MAX_CACHE = 50

    async def analyze(self, screenshot_path: str = "", uia_elements: list[dict[str, Any]] | None = None) -> ScreenScene:
        """全量分析：场景识别 + 区域划分 + 关系图构建.

        Args:
            screenshot_path: 截图路径（可选，用于VLM增强）
            uia_elements: UIA元素列表（可选，优先使用缓存）

        Returns:
            ScreenScene: 屏幕语义场景
        """
        start = time.monotonic()

        try:
            elements = uia_elements or await self._get_uia_elements()
        except Exception as e:
            log.warning("V1: failed to get UIA elements", error=str(e))
            elements = []

        scene_type, app_name, window_title, scene_conf = self._recognize_scene(elements)

        regions = self._partition_regions(elements)

        relation_graph = self._build_relation_graph(elements)

        interactive = [e for e in elements if e.get("control_type", "").lower() in _INTERACTIVE_TYPES or e.get("role", "").lower() in _INTERACTIVE_TYPES]

        summary = self._generate_summary(app_name, scene_type, regions, interactive)

        duration_ms = (time.monotonic() - start) * 1000

        scene = ScreenScene(
            app_name=app_name,
            window_title=window_title,
            scene_type=scene_type,
            scene_confidence=scene_conf,
            regions=regions,
            relation_graph=relation_graph,
            interactive_elements=interactive[:50],
            summary=summary,
            timestamp=time.time(),
            duration_ms=duration_ms,
        )

        cache_key = f"{app_name}:{window_title}"
        self._scene_cache[cache_key] = scene
        if len(self._scene_cache) > self._MAX_CACHE:
            oldest_key = next(iter(self._scene_cache))
            del self._scene_cache[oldest_key]

        log.info(
            "V1: screen semantics analyzed",
            app=app_name,
            scene=scene_type.value,
            confidence=scene_conf,
            regions=len(regions),
            nodes=len(relation_graph.nodes),
            edges=len(relation_graph.edges),
            duration_ms=round(duration_ms, 1),
        )

        return scene

    async def quick_scene_type(self) -> SceneType:
        """快速场景识别（仅第一级，低延迟）."""
        try:
            elements = await self._get_uia_elements()
            scene_type, _, _, _ = self._recognize_scene(elements)
            return scene_type
        except Exception:
            return SceneType.UNKNOWN

    def _recognize_scene(self, elements: list[dict[str, Any]]) -> tuple[SceneType, str, str, float]:
        """场景识别：通过窗口信息推断场景类型."""
        app_name = ""
        window_title = ""

        for elem in elements[:5]:
            if not app_name and elem.get("process_name"):
                app_name = elem["process_name"].lower()
            if not window_title and elem.get("window_title"):
                window_title = elem["window_title"]

        if not app_name and not window_title:
            return SceneType.UNKNOWN, "", "", 0.0

        for hint, (scene_type, conf) in _APP_SCENE_HINTS.items():
            if hint in app_name or hint in window_title.lower():
                return scene_type, app_name, window_title, conf

        title_lower = window_title.lower()
        if any(kw in title_lower for kw in ("保存", "打开", "另存为", "save", "open", "load")):
            return SceneType.DIALOG, app_name, window_title, 0.8
        if any(kw in title_lower for kw in ("设置", "偏好", "选项", "settings", "preferences", "options")):
            return SceneType.SETTINGS, app_name, window_title, 0.8
        if any(kw in title_lower for kw in ("登录", "注册", "login", "signin", "signup")):
            return SceneType.LOGIN, app_name, window_title, 0.8

        if elements:
            return SceneType.DESKTOP, app_name, window_title, 0.5

        return SceneType.UNKNOWN, app_name, window_title, 0.3

    def _partition_regions(self, elements: list[dict[str, Any]]) -> list[SemanticRegion]:
        """语义区域划分：将元素按空间位置归类为语义区域."""
        if not elements:
            return []

        regions: list[SemanticRegion] = []

        all_y: list[int] = []
        all_x: list[int] = []
        for elem in elements:
            bbox = elem.get("bbox", "")
            if bbox:
                try:
                    parts = [int(p) for p in bbox.strip("()").split(",")]
                    if len(parts) >= 4:
                        all_y.extend([parts[1], parts[3]])
                        all_x.extend([parts[0], parts[2]])
                except (ValueError, IndexError):
                    pass

        if not all_y or not all_x:
            return []

        min_y, max_y = min(all_y), max(all_y)
        min_x, max_x = min(all_x), max(all_x)
        screen_height = max_y - min_y if max_y > min_y else 1
        screen_width = max_x - min_x if max_x > min_x else 1

        top_threshold = min_y + int(screen_height * 0.08)
        bottom_threshold = max_y - int(screen_height * 0.06)
        left_threshold = min_x + int(screen_width * 0.2)

        top_elements = [e for e in elements if self._elem_top(e) <= top_threshold]
        if top_elements:
            regions.append(SemanticRegion(
                region_type=SemanticRegionType.NAVIGATION_BAR,
                bounds=(min_x, min_y, max_x, top_threshold),
                confidence=0.7,
                elements=top_elements,
                label="顶部导航栏",
            ))

        bottom_elements = [e for e in elements if self._elem_bottom(e) >= bottom_threshold]
        if bottom_elements:
            regions.append(SemanticRegion(
                region_type=SemanticRegionType.STATUS_BAR,
                bounds=(min_x, bottom_threshold, max_x, max_y),
                confidence=0.7,
                elements=bottom_elements,
                label="底部状态栏",
            ))

        left_elements = [e for e in elements if self._elem_right(e) <= left_threshold and self._elem_top(e) > top_threshold and self._elem_bottom(e) < bottom_threshold]
        if left_elements and len(left_elements) >= 3:
            regions.append(SemanticRegion(
                region_type=SemanticRegionType.SIDEBAR,
                bounds=(min_x, top_threshold, left_threshold, bottom_threshold),
                confidence=0.65,
                elements=left_elements,
                label="侧边栏",
            ))

        content_elements = [e for e in elements if self._elem_top(e) > top_threshold and self._elem_bottom(e) < bottom_threshold and self._elem_left(e) >= left_threshold]
        if content_elements:
            regions.append(SemanticRegion(
                region_type=SemanticRegionType.CONTENT_AREA,
                bounds=(left_threshold, top_threshold, max_x, bottom_threshold),
                confidence=0.6,
                elements=content_elements,
                label="内容区域",
            ))

        dialog_elements = [e for e in elements if e.get("control_type", "").lower() in ("window", "dialog") and e.get("name", "")]
        for dlg in dialog_elements:
            dlg_bbox = self._parse_bbox(dlg.get("bbox", ""))
            if dlg_bbox:
                regions.append(SemanticRegion(
                    region_type=SemanticRegionType.DIALOG,
                    bounds=dlg_bbox,
                    confidence=0.85,
                    elements=[dlg],
                    label=dlg.get("name", "对话框"),
                ))

        return regions

    def _build_relation_graph(self, elements: list[dict[str, Any]]) -> UIRelationGraph:
        """UI关系图构建：分析元素间的父子/兄弟/空间关系."""
        graph = UIRelationGraph()

        if not elements:
            return graph

        nodes: list[UIRelationNode] = []
        for i, elem in enumerate(elements[:200]):
            elem_id = elem.get("automation_id", "") or f"elem_{i}"
            ctrl_type = elem.get("control_type", "unknown")
            name = elem.get("name", "")
            bbox = self._parse_bbox(elem.get("bbox", ""))
            if not bbox:
                continue
            depth = elem.get("depth", 0)
            nodes.append(UIRelationNode(
                element_id=elem_id,
                control_type=ctrl_type,
                name=name,
                bounds=bbox,
                depth=depth,
            ))

        graph.nodes = nodes

        edges: list[UIRelationEdge] = []
        node_map = {n.element_id: n for n in nodes}

        depth_groups: dict[int, list[UIRelationNode]] = {}
        for n in nodes:
            depth_groups.setdefault(n.depth, []).append(n)

        for depth, group in depth_groups.items():
            if depth + 1 in depth_groups:
                children = depth_groups[depth + 1]
                for parent in group:
                    for child in children:
                        if self._is_contained(child.bounds, parent.bounds):
                            edges.append(UIRelationEdge(
                                source_id=parent.element_id,
                                target_id=child.element_id,
                                relation="parent-child",
                                confidence=0.85,
                            ))

        for depth, group in depth_groups.items():
            sorted_group = sorted(group, key=lambda n: n.bounds[0])
            for i in range(len(sorted_group) - 1):
                a = sorted_group[i]
                b = sorted_group[i + 1]
                gap = b.bounds[0] - a.bounds[2]
                if 0 <= gap < 50:
                    edges.append(UIRelationEdge(
                        source_id=a.element_id,
                        target_id=b.element_id,
                        relation="spatial-right",
                        confidence=0.7,
                    ))
                    edges.append(UIRelationEdge(
                        source_id=b.element_id,
                        target_id=a.element_id,
                        relation="spatial-left",
                        confidence=0.7,
                    ))

            sorted_by_y = sorted(group, key=lambda n: n.bounds[1])
            for i in range(len(sorted_by_y) - 1):
                a = sorted_by_y[i]
                b = sorted_by_y[i + 1]
                gap = b.bounds[1] - a.bounds[3]
                if 0 <= gap < 30:
                    edges.append(UIRelationEdge(
                        source_id=a.element_id,
                        target_id=b.element_id,
                        relation="spatial-below",
                        confidence=0.7,
                    ))

        graph.edges = edges
        return graph

    def _generate_summary(self, app_name: str, scene_type: SceneType, regions: list[SemanticRegion], interactive: list[dict[str, Any]]) -> str:
        """生成场景的自然语言摘要."""
        parts: list[str] = []
        if app_name:
            parts.append(f"应用: {app_name}")
        parts.append(f"场景: {scene_type.value}")
        if regions:
            region_desc = ", ".join(f"{r.label}({len(r.elements)}元素)" for r in regions if r.elements)
            if region_desc:
                parts.append(f"区域: {region_desc}")
        if interactive:
            btn_count = sum(1 for e in interactive if e.get("control_type", "").lower() == "button")
            link_count = sum(1 for e in interactive if e.get("control_type", "").lower() == "link")
            input_count = sum(1 for e in interactive if e.get("control_type", "").lower() in ("textbox", "combobox"))
            if btn_count:
                parts.append(f"{btn_count}个按钮")
            if link_count:
                parts.append(f"{link_count}个链接")
            if input_count:
                parts.append(f"{input_count}个输入框")
        return "；".join(parts)

    async def _get_uia_elements(self) -> list[dict[str, Any]]:
        """获取当前UIA元素列表."""
        try:
            from agent.perception.uia_cache import UIAElementCache
            cache = UIAElementCache()
            tree = await cache.refresh()
            return [e.raw for e in tree.flat_elements]
        except Exception as e:
            log.debug("V1: UIA cache unavailable", error=str(e))
            return []

    @staticmethod
    def _parse_bbox(bbox_str: str) -> tuple[int, int, int, int] | None:
        if not bbox_str:
            return None
        try:
            parts = [int(p.strip()) for p in bbox_str.strip("()").split(",")]
            if len(parts) >= 4:
                return (parts[0], parts[1], parts[2], parts[3])
        except (ValueError, IndexError):
            pass
        return None

    @staticmethod
    def _elem_top(elem: dict[str, Any]) -> int:
        bbox = ScreenSemanticsEngine._parse_bbox(elem.get("bbox", ""))
        return bbox[1] if bbox else 0

    @staticmethod
    def _elem_bottom(elem: dict[str, Any]) -> int:
        bbox = ScreenSemanticsEngine._parse_bbox(elem.get("bbox", ""))
        return bbox[3] if bbox else 0

    @staticmethod
    def _elem_left(elem: dict[str, Any]) -> int:
        bbox = ScreenSemanticsEngine._parse_bbox(elem.get("bbox", ""))
        return bbox[0] if bbox else 0

    @staticmethod
    def _elem_right(elem: dict[str, Any]) -> int:
        bbox = ScreenSemanticsEngine._parse_bbox(elem.get("bbox", ""))
        return bbox[2] if bbox else 0

    @staticmethod
    def _is_contained(inner: tuple[int, int, int, int], outer: tuple[int, int, int, int]) -> bool:
        return inner[0] >= outer[0] and inner[1] >= outer[1] and inner[2] <= outer[2] and inner[3] <= outer[3]
