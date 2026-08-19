"""UIA 平台抽象层 — 跨平台 Accessibility Tree 查询。

将平台特定的 UI 元素查询逻辑抽取到独立适配器中，
通过工厂模式自动选择当前平台的实现。

支持平台：
- Windows: UI Automation (comtypes)
- macOS: Accessibility API (ApplicationServices)
- Linux/降级: OCR (pytesseract)

Usage:
    from agent.perception.platform_adapter import create_platform_adapter
    adapter = create_platform_adapter()
    elements = await adapter.query()
"""
from __future__ import annotations

import platform
from abc import ABC, abstractmethod
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("platform_adapter")


class PlatformAdapter(ABC):
    """平台适配器基类。"""

    @abstractmethod
    async def query(self) -> list[dict[str, Any]]:
        """查询当前平台的 UI 元素列表。"""

    @property
    @abstractmethod
    def name(self) -> str:
        """适配器名称。"""


class Win32UIAAdapter(PlatformAdapter):
    """Windows UI Automation 适配器。"""

    @property
    def name(self) -> str:
        return "uia"

    async def query(self) -> list[dict[str, Any]]:
        try:
            import comtypes.client
            uia = comtypes.client.CreateObject(
                "{ff48dba4-60ef-4201-aa87-3f5f29773a3d}"
            )
            root = uia.GetRootElement()
            elements: list[dict[str, Any]] = []
            self._walk(root, elements, depth=0, max_depth=5)
            return elements
        except Exception as e:
            log.warning("Win32 UIA 查询失败", error=str(e))
            return []

    def _walk(
        self, element: Any, result: list[dict[str, Any]], depth: int, max_depth: int,
    ) -> None:
        if depth > max_depth:
            return
        try:
            control_type = str(getattr(element, "CurrentControlType", ""))
            name = str(getattr(element, "CurrentName", ""))

            interactive_types = {
                "50000", "50004", "50005", "50006",
                "50009", "50013", "50014", "50015",
                "50026", "50033",
            }

            rect = getattr(element, "CurrentBoundingRectangle", None)
            bounds = ""
            if rect:
                bounds = f"({rect.left},{rect.top},{rect.right},{rect.bottom})"

            is_interactive = control_type in interactive_types
            path_parts = [control_type, name[:20]]
            elem_id = "/".join(path_parts) + f"@{bounds}"

            result.append({
                "id": elem_id,
                "type": control_type,
                "name": name,
                "bbox": bounds,
                "is_interactive": is_interactive,
            })

            children = element.GetChildren()
            if children:
                for child in children:
                    self._walk(child, result, depth + 1, max_depth)
        except Exception as _exc:
            log_ignored(log, "platform_adapter.Win32UIAAdapter._walk", _exc)


class MacOSA11yAdapter(PlatformAdapter):
    """macOS Accessibility API 适配器。"""

    @property
    def name(self) -> str:
        return "a11y"

    async def query(self) -> list[dict[str, Any]]:
        try:
            import ApplicationServices
            from AppKit import NSWorkspace

            active_app = NSWorkspace.sharedWorkspace().frontmostApplication()
            pid = active_app.processIdentifier()
            system_wide = ApplicationServices.AXUIElementCreateApplication(pid)

            elements: list[dict[str, Any]] = []
            self._walk(system_wide, elements, depth=0, max_depth=4)
            return elements
        except Exception as e:
            log.warning("macOS Accessibility 查询失败", error=str(e))
            return []

    def _walk(
        self, element: Any, result: list[dict[str, Any]], depth: int, max_depth: int,
    ) -> None:
        if depth > max_depth:
            return
        try:
            from ApplicationServices import (
                AXUIElementCopyAttributeValue,
                kAXErrorSuccess,
                kAXChildrenAttribute,
                kAXRoleAttribute,
                kAXTitleAttribute,
                kAXValueAttribute,
                kAXPositionAttribute,
                kAXSizeAttribute,
            )

            def _get_attr(el: Any, attr: str) -> Any:
                code, value = AXUIElementCopyAttributeValue(el, attr, None)
                return value if code == kAXErrorSuccess else None

            role = _get_attr(element, kAXRoleAttribute) or ""
            name = _get_attr(element, kAXTitleAttribute) or _get_attr(element, kAXValueAttribute) or ""

            interactive_roles = {
                "AXButton", "AXCheckBox", "AXPopUpButton", "AXComboBox",
                "AXTextField", "AXTextArea", "AXLink", "AXMenuItem",
            }

            pos = _get_attr(element, kAXPositionAttribute)
            size = _get_attr(element, kAXSizeAttribute)
            bounds = ""
            if pos and size:
                try:
                    x, y = pos[0], pos[1]
                    w, h = size[0], size[1]
                    bounds = f"({int(x)},{int(y)},{int(x + w)},{int(y + h)})"
                except (TypeError, IndexError) as _exc:
                    log_ignored(log, "platform_adapter.MacOSA11yAdapter._walk.bounds", _exc)

            is_interactive = role in interactive_roles
            elem_id = f"{role}/{name[:20]}@{bounds}"

            result.append({
                "id": elem_id,
                "type": role,
                "name": str(name),
                "bbox": bounds,
                "is_interactive": is_interactive,
            })

            children_val = _get_attr(element, kAXChildrenAttribute)
            if children_val:
                for child in children_val:
                    self._walk(child, result, depth + 1, max_depth)
        except Exception as _exc:
            log_ignored(log, "platform_adapter.MacOSA11yAdapter._walk", _exc)


class OcrFallbackAdapter(PlatformAdapter):
    """OCR 降级适配器 — 适用于 Linux 或无 UIA 的场景。"""

    @property
    def name(self) -> str:
        return "ocr"

    async def query(self) -> list[dict[str, Any]]:
        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            controller = get_desktop_controller()
            screenshot_result = controller.screenshot_full()
            if not screenshot_result.success:
                return []

            import pytesseract
            from PIL import Image

            img = Image.open(screenshot_result.image_path)
            data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, lang="chi_sim+eng")

            elements: list[dict[str, Any]] = []
            for i in range(len(data["text"])):
                text = data["text"][i].strip()
                if not text:
                    continue
                x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
                bounds = f"({x},{y},{x + w},{y + h})"
                elements.append({
                    "id": f"text/{text[:20]}@{bounds}",
                    "type": "text",
                    "name": text,
                    "bbox": bounds,
                    "is_interactive": True,
                })
            return elements
        except Exception as e:
            log.warning("OCR 降级查询失败", error=str(e))
            return []


class AtSpiAdapter(PlatformAdapter):
    """Linux AT-SPI 适配器 — 通过 D-Bus 访问辅助功能树。"""

    @property
    def name(self) -> str:
        return "atspi"

    async def query(self) -> list[dict[str, Any]]:
        try:
            import gi
            gi.require_version("Atspi", "2.0")
            from gi.repository import Atspi

            desktop = Atspi.get_desktop(0)
            elements: list[dict[str, Any]] = []
            self._walk(desktop, elements, depth=0, max_depth=5)
            return elements
        except Exception as e:
            log.warning("AT-SPI 查询失败，降级为 OCR", error=str(e))
            return await OcrFallbackAdapter().query()

    def _walk(
        self, node: Any, result: list[dict[str, Any]], depth: int, max_depth: int,
    ) -> None:
        if depth > max_depth:
            return
        try:
            role = str(node.get_role_name())
            name = str(node.get_name() or "")

            interactive_roles = {
                "push button", "toggle button", "check box",
                "radio button", "text", "entry", "menu item",
                "combo box", "link", "spin button",
            }

            try:
                ext = node.get_extents(0)
                bounds = f"({ext.x},{ext.y},{ext.x + ext.width},{ext.y + ext.height})"
            except Exception:
                bounds = ""

            is_interactive = role.lower() in interactive_roles
            elem_id = f"{role}/{name[:20]}@{bounds}"

            result.append({
                "id": elem_id,
                "type": role,
                "name": name,
                "bbox": bounds,
                "is_interactive": is_interactive,
            })

            child_count = node.get_child_count()
            for i in range(min(child_count, 50)):
                child = node.get_child_at_index(i)
                if child:
                    self._walk(child, result, depth + 1, max_depth)
        except Exception as _exc:
            log_ignored(log, "platform_adapter.AtSpiAdapter._walk", _exc)


def create_platform_adapter(
    force_platform: str = "",
) -> PlatformAdapter:
    """工厂方法 — 创建当前平台的适配器。

    Args:
        force_platform: 强制指定平台 (windows/macos/linux/ocr)。

    Returns:
        PlatformAdapter 实例。
    """
    system = force_platform or platform.system().lower()

    if system == "windows":
        adapter = Win32UIAAdapter()
        log.info("平台适配器选择", platform="Windows UIA")
        return adapter

    if system == "darwin" or system == "macos":
        adapter = MacOSA11yAdapter()
        log.info("平台适配器选择", platform="macOS Accessibility")
        return adapter

    if system == "linux":
        adapter = AtSpiAdapter()
        log.info("平台适配器选择", platform="Linux AT-SPI")
        return adapter

    adapter = OcrFallbackAdapter()
    log.info("平台适配器选择", platform="OCR fallback")
    return adapter
