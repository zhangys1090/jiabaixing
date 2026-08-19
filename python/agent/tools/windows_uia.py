"""审计 P2-4：Windows UIA 自动化桥接。

基于 Windows UI Automation (UIA) 提供精确的桌面自动化能力。
相比 pyautogui 的图像识别，UIA 直接操作 UI 元素树，更可靠更快速。

集成了 desktop_automate 现有能力，作为其增强层。

Usage:
    from agent.tools.windows_uia import UIAEngine

    engine = UIAEngine()
    elements = await engine.find_elements(name="确定", control_type="Button")
    if elements:
        await engine.click(elements[0])
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("windows_uia")

# UIA 控制类型常量（不依赖 uiautomation 包时使用常量字符串）
UIA_CONTROL_TYPES = {
    "Button": "Button",
    "Edit": "Edit",
    "Text": "Text",
    "Window": "Window",
    "MenuItem": "MenuItem",
    "CheckBox": "CheckBox",
    "RadioButton": "RadioButton",
    "ComboBox": "ComboBox",
    "List": "List",
    "ListItem": "ListItem",
    "Tree": "Tree",
    "TreeItem": "TreeItem",
    "Tab": "Tab",
    "TabItem": "TabItem",
    "ToolBar": "ToolBar",
    "StatusBar": "StatusBar",
    "Table": "Table",
    "Hyperlink": "Hyperlink",
    "Image": "Image",
    "Document": "Document",
    "Pane": "Pane",
    "Group": "Group",
    "TitleBar": "TitleBar",
    "MenuBar": "MenuBar",
    "ScrollBar": "ScrollBar",
    "DataGrid": "DataGrid",
    "DataItem": "DataItem",
    "Header": "Header",
    "HeaderItem": "HeaderItem",
    "SplitButton": "SplitButton",
    "Calendar": "Calendar",
    "Custom": "Custom",
    "SemanticZoom": "SemanticZoom",
    "AppBar": "AppBar",
    "Thumb": "Thumb",
}


class UIAAction(str, Enum):
    CLICK = "click"
    DOUBLE_CLICK = "double_click"
    RIGHT_CLICK = "right_click"
    SET_TEXT = "set_text"
    GET_TEXT = "get_text"
    SCROLL = "scroll"
    FOCUS = "focus"
    INVOKE = "invoke"
    SELECT = "select"
    EXPAND = "expand"
    COLLAPSE = "collapse"


@dataclass
class UIAElement:
    """UIA 元素描述。"""
    name: str = ""
    control_type: str = ""
    automation_id: str = ""
    class_name: str = ""
    rect: dict[str, int] = field(default_factory=lambda: {"x": 0, "y": 0, "w": 0, "h": 0})
    is_enabled: bool = True
    is_visible: bool = True
    value: str = ""
    children_count: int = 0


@dataclass
class UIAQuery:
    """UIA 元素查询条件。"""
    name: str | None = None
    name_contains: str | None = None
    control_type: str | None = None
    automation_id: str | None = None
    class_name: str | None = None
    is_enabled: bool | None = None
    max_depth: int = 5
    timeout: float = 10.0


class UIAEngine:
    """Windows UIA 自动化引擎。

    封装 UIA 操作，提供高层次的桌面自动化接口。
    当 uiautomation 包不可用时，自动降级到 pyautogui 模式。
    """

    _instance: UIAEngine | None = None

    @classmethod
    def get_instance(cls) -> UIAEngine:
        if cls._instance is None:
            cls._instance = UIAEngine()
        return cls._instance

    def __init__(self) -> None:
        self._uia = None
        self._fallback = False
        self._try_init_uia()

    def _try_init_uia(self) -> None:
        try:
            import uiautomation
            self._uia = uiautomation
            log.info("UIA 引擎初始化成功", mode="native")
        except ImportError:
            self._fallback = True
            log.warning("uiautomation 未安装，降级到 pyautogui 模式")

    @property
    def is_available(self) -> bool:
        return self._uia is not None

    async def find_elements(self, query: UIAQuery) -> list[UIAElement]:
        """查找匹配的 UI 元素。"""
        if self._fallback:
            return await self._find_elements_fallback(query)

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._find_elements_sync, query)

    def _find_elements_sync(self, query: UIAQuery) -> list[UIAElement]:
        if not self._uia:
            return []

        results: list[UIAElement] = []
        try:
            root = self._uia.GetRootControl()
            self._search_tree(root, query, results, depth=0)
        except Exception as e:
            log.error("UIA 搜索失败", error=str(e))
        return results

    def _search_tree(
        self, control: Any, query: UIAQuery, results: list[UIAElement], depth: int
    ) -> None:
        if depth > query.max_depth:
            return

        try:
            element = self._control_to_element(control)
            if self._matches(element, query):
                results.append(element)
        except Exception as _exc:
            log_ignored(log, "windows_uia.UIAEngine._search_tree", _exc)

        try:
            children = control.GetChildren()
            for child in children:
                self._search_tree(child, query, results, depth + 1)
        except Exception as _exc:
            log_ignored(log, "windows_uia.UIAEngine._search_tree", _exc)

    def _control_to_element(self, control: Any) -> UIAElement:
        return UIAElement(
            name=getattr(control, "Name", ""),
            control_type=getattr(control, "ControlTypeName", ""),
            automation_id=getattr(control, "AutomationId", ""),
            class_name=getattr(control, "ClassName", ""),
            rect=self._get_rect(control),
            is_enabled=getattr(control, "IsEnabled", False),
            is_visible=not getattr(control, "IsOffscreen", True),
            value=getattr(control, "GetValuePattern", lambda: type("V", (), {"Value": ""})().Value)().Value if hasattr(control, "GetValuePattern") else "",
            children_count=self._safe_children_count(control),
        )

    def _safe_children_count(self, control: Any) -> int:
        try:
            get_children = getattr(control, "GetChildren", None)
            if callable(get_children):
                return len(get_children())
        except Exception as _exc:
            log_ignored(log, "windows_uia.UIAEngine._safe_children_count", _exc)
        return 0

    def _get_rect(self, control: Any) -> dict[str, int]:
        try:
            rect = control.BoundingRectangle
            return {"x": rect.left, "y": rect.top, "w": rect.width(), "h": rect.height()}
        except Exception as _exc:
            log_ignored(log, "windows_uia.UIAEngine._get_rect", _exc)
            return {"x": 0, "y": 0, "w": 0, "h": 0}

    def _matches(self, element: UIAElement, query: UIAQuery) -> bool:
        if query.name is not None and element.name != query.name:
            return False
        if query.name_contains is not None and query.name_contains not in element.name:
            return False
        if query.control_type is not None and element.control_type != query.control_type:
            return False
        if query.automation_id is not None and element.automation_id != query.automation_id:
            return False
        if query.class_name is not None and element.class_name != query.class_name:
            return False
        if query.is_enabled is not None and element.is_enabled != query.is_enabled:
            return False
        return True

    async def _find_elements_fallback(self, query: UIAQuery) -> list[UIAElement]:
        """pyautogui 降级模式：返回空列表，让调用方使用图像识别。"""
        log.debug("UIA 降级模式：搜索不可用", query=str(query))
        return []

    async def click(self, element: UIAElement) -> bool:
        """点击 UI 元素。"""
        if self._fallback:
            return await self._click_fallback(element)

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._click_sync, element)

    def _click_sync(self, element: UIAElement) -> bool:
        if not self._uia:
            return False
        try:
            x = element.rect["x"] + element.rect["w"] // 2
            y = element.rect["y"] + element.rect["h"] // 2
            self._uia.Click(x, y)
            return True
        except Exception as e:
            log.error("UIA 点击失败", error=str(e))
            return False

    async def _click_fallback(self, element: UIAElement) -> bool:
        try:
            import pyautogui
            x = element.rect["x"] + element.rect["w"] // 2
            y = element.rect["y"] + element.rect["h"] // 2
            pyautogui.click(x, y)
            return True
        except ImportError:
            return False

    async def set_text(self, element: UIAElement, text: str) -> bool:
        """设置文本输入框内容。"""
        if self._fallback:
            return await self._set_text_fallback(element, text)

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._set_text_sync, element, text)

    def _set_text_sync(self, element: UIAElement, text: str) -> bool:
        if not self._uia:
            return False
        try:
            controls = self._uia.GetRootControl().GetChildren()
            for ctrl in controls:
                if ctrl.Name == element.name and ctrl.ControlTypeName == element.control_type:
                    if hasattr(ctrl, "GetValuePattern"):
                        vp = ctrl.GetValuePattern()
                        vp.SetValue(text)
                        return True
            return False
        except Exception as e:
            log.error("UIA 设置文本失败", error=str(e))
            return False

    async def _set_text_fallback(self, element: UIAElement, text: str) -> bool:
        try:
            import pyautogui
            x = element.rect["x"] + element.rect["w"] // 2
            y = element.rect["y"] + element.rect["h"] // 2
            pyautogui.click(x, y)
            await asyncio.sleep(0.3)
            pyautogui.hotkey("ctrl", "a")
            pyautogui.write(text)
            return True
        except ImportError:
            return False

    async def get_active_window_title(self) -> str:
        """获取当前活动窗口标题。"""
        if self._fallback:
            try:
                import pyautogui
                return pyautogui.getActiveWindowTitle() or ""
            except ImportError:
                return ""

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._get_active_window_title_sync)

    def _get_active_window_title_sync(self) -> str:
        if not self._uia:
            return ""
        try:
            return self._uia.GetForegroundControl().Name
        except Exception as _exc:
            log_ignored(log, "windows_uia.UIAEngine._get_active_window_title_sync", _exc)
            return ""

    async def get_element_tree(self, max_depth: int = 3) -> list[UIAElement]:
        """获取当前窗口的 UI 元素树。"""
        query = UIAQuery(max_depth=max_depth)
        return await self.find_elements(query)

    async def wait_for_element(
        self, query: UIAQuery, timeout: float = 10.0
    ) -> UIAElement | None:
        """等待元素出现。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            elements = await self.find_elements(query)
            if elements:
                return elements[0]
            await asyncio.sleep(0.5)
        return None


# ==================== 工具定义 ====================

from agent.tools.registry import ToolCategory, ToolDefinition, ToolParameterDef, ToolResult


UIA_FIND_DEF = ToolDefinition(
    name="uia_find",
    description="通过 Windows UIA 查找 UI 元素。适用场景：精确点击按钮、读取文本框内容、查找窗口元素。比图像识别更可靠。",
    short_desc="UIA查找元素",
    category=ToolCategory.SYSTEM,
    tags=["uia", "windows", "automation", "desktop"],
    scenes=["desktop", "automation"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="name", type="string", required=False, description="元素名称"),
        ToolParameterDef(name="name_contains", type="string", required=False, description="名称包含关键词"),
        ToolParameterDef(name="control_type", type="string", required=False, description="控制类型（Button/Edit/Window等）"),
    ],
    risk_level="medium",
)

UIA_CLICK_DEF = ToolDefinition(
    name="uia_click",
    description="通过 Windows UIA 点击 UI 元素。先 uia_find 定位，再 uia_click 点击。",
    short_desc="UIA点击",
    category=ToolCategory.SYSTEM,
    tags=["uia", "click", "windows", "desktop"],
    scenes=["desktop", "automation"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="name", type="string", required=True, description="要点击的元素名称"),
        ToolParameterDef(name="control_type", type="string", required=False, description="控制类型"),
    ],
    risk_level="medium",
)

UIA_GET_TEXT_DEF = ToolDefinition(
    name="uia_get_text",
    description="通过 Windows UIA 读取 UI 元素文本。适用场景：读取窗口内容、获取文本框的值。",
    short_desc="UIA读取文本",
    category=ToolCategory.SYSTEM,
    tags=["uia", "text", "read", "windows"],
    scenes=["desktop", "automation"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="name", type="string", required=False, description="元素名称"),
        ToolParameterDef(name="control_type", type="string", required=False, description="控制类型"),
    ],
    risk_level="low",
)


async def uia_find_executor(params: dict[str, Any]) -> ToolResult:
    import time as _time
    start = _time.time()
    name = params.get("name")
    name_contains = params.get("name_contains")
    control_type = params.get("control_type")

    engine = UIAEngine.get_instance()
    query = UIAQuery(
        name=name,
        name_contains=name_contains,
        control_type=control_type,
    )
    elements = await engine.find_elements(query)

    if not elements:
        return ToolResult(
            success=True,
            output="未找到匹配的 UI 元素",
            duration=_time.time() - start,
            metadata={"count": 0},
        )

    lines = []
    for i, el in enumerate(elements[:20], 1):
        rect = el.rect
        lines.append(
            f"{i}. [{el.control_type}] {el.name} | "
            f"pos=({rect['x']},{rect['y']}) size=({rect['w']}x{rect['h']}) | "
            f"enabled={el.is_enabled}"
        )

    return ToolResult(
        success=True,
        output=f"找到 {len(elements)} 个元素:\n" + "\n".join(lines),
        duration=_time.time() - start,
        metadata={"count": len(elements), "elements": [{"name": e.name, "type": e.control_type} for e in elements[:5]]},
    )


async def uia_click_executor(params: dict[str, Any]) -> ToolResult:
    import time as _time
    start = _time.time()
    name = str(params.get("name", ""))
    control_type = params.get("control_type")

    if not name:
        return ToolResult(success=False, error="元素名称不能为空")

    engine = UIAEngine.get_instance()
    query = UIAQuery(name=name, control_type=control_type)
    elements = await engine.find_elements(query)

    if not elements:
        return ToolResult(success=False, error=f"未找到元素: {name}")

    success = await engine.click(elements[0])
    return ToolResult(
        success=success,
        output=f"已点击 [{elements[0].control_type}] {elements[0].name}" if success else "点击失败",
        duration=_time.time() - start,
    )


async def uia_get_text_executor(params: dict[str, Any]) -> ToolResult:
    import time as _time
    start = _time.time()
    name = params.get("name")
    control_type = params.get("control_type")

    engine = UIAEngine.get_instance()
    query = UIAQuery(name=name, name_contains=None, control_type=control_type)
    elements = await engine.find_elements(query)

    if not elements:
        return ToolResult(success=False, error="未找到匹配元素")

    texts = [el.value for el in elements if el.value]
    combined = "\n---\n".join(texts) if texts else ""

    return ToolResult(
        success=True,
        output=combined[:5000] if combined else f"找到 {len(elements)} 个元素，但无文本内容",
        duration=_time.time() - start,
        metadata={"count": len(elements), "text_count": len(texts)},
    )


def register_uia_tools(registry: Any) -> None:
    """注册 UIA 工具到工具注册中心。"""
    registry.register(UIA_FIND_DEF, uia_find_executor)
    registry.register(UIA_CLICK_DEF, uia_click_executor)
    registry.register(UIA_GET_TEXT_DEF, uia_get_text_executor)
