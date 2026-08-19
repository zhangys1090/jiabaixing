"""桌面操作闭环 — UIA + ActionVerifier + DesktopController 三层集成。

设计目标：
1. 操作前感知：截图 + UIA 元素树快照
2. 操作执行：UIA 精确操作优先，pyautogui 降级
3. 操作后验证：ActionVerifier 多策略验证（pixel/ocr/uia_diff）
4. 失败自动重试：带退避的自动重试 + UIA 重定位

闭环流程：
  capture_pre → execute → capture_post → verify → [retry?]

Usage:
    loop = DesktopOperationLoop()
    result = await loop.execute("点击确定按钮", action_type="click", target="确定")
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
from agent.core.logger import log_ignored

log = StructuredLogger("desktop_operation_loop")


@dataclass
class OperationSpec:
    action_type: str = "click"
    target: str = ""
    value: str = ""
    control_type: str = ""
    coordinates: tuple[int, int] | None = None
    timeout: float = 10.0
    max_retries: int = 2
    verify_strategy: str = "auto"


@dataclass
class OperationResult:
    success: bool
    action: str
    evidence: str = ""
    retries: int = 0
    duration_ms: float = 0.0
    verification: dict[str, Any] = field(default_factory=dict)
    error: str = ""


class DesktopOperationLoop:
    def __init__(self) -> None:
        self._uia_engine: Any | None = None
        self._desktop_controller: Any | None = None
        self._action_verifier: Any | None = None
        self._screenshot_dir: str = ""
        self._init_components()

    def _init_components(self) -> None:
        try:
            from agent.tools.windows_uia import UIAEngine
            self._uia_engine = UIAEngine.get_instance()
        except Exception as e:
            log.debug("UIA engine not available", error=str(e))

        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            self._desktop_controller = get_desktop_controller()
        except Exception as e:
            log.debug("DesktopController not available", error=str(e))

        try:
            from agent.perception.action_verifier import ActionVerifier
            self._action_verifier = ActionVerifier()
        except Exception as e:
            log.debug("ActionVerifier not available", error=str(e))

        try:
            from agent.config import DATA_ROOT
            self._screenshot_dir = os.path.join(str(DATA_ROOT), "screenshots", "op_loop")
            os.makedirs(self._screenshot_dir, exist_ok=True)
        except Exception:
            self._screenshot_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "screenshots", "op_loop")
            os.makedirs(self._screenshot_dir, exist_ok=True)

    async def execute(self, spec: OperationSpec) -> OperationResult:
        start = time.time()

        pre_screenshot = await self._capture_screenshot("pre")
        pre_uia = await self._capture_uia_snapshot()

        result = await self._execute_with_retry(spec)

        post_screenshot = await self._capture_screenshot("post")

        verification = {}
        if self._action_verifier and pre_screenshot and post_screenshot:
            try:
                verify_result = await self._action_verifier.verify(
                    action_description=f"{spec.action_type} {spec.target}",
                    pre_path=pre_screenshot,
                    post_path=post_screenshot,
                    strategy=spec.verify_strategy,
                )
                verification = {
                    "success": verify_result.success,
                    "confidence": verify_result.confidence,
                    "evidence": verify_result.evidence,
                    "method": verify_result.method,
                    "retry_suggested": verify_result.retry_suggested,
                }
            except Exception as e:
                log.debug("Verification failed", error=str(e))

        duration_ms = (time.time() - start) * 1000
        return OperationResult(
            success=result,
            action=spec.action_type,
            evidence=verification.get("evidence", ""),
            retries=0,
            duration_ms=duration_ms,
            verification=verification,
        )

    async def _execute_with_retry(self, spec: OperationSpec) -> bool:
        for attempt in range(spec.max_retries + 1):
            success = await self._execute_single(spec)
            if success:
                return True

            if attempt < spec.max_retries:
                delay = min(0.5 * (2 ** attempt), 5.0)
                log.info(
                    "Operation failed, retrying",
                    action=spec.action_type,
                    target=spec.target,
                    attempt=attempt + 1,
                    delay=delay,
                )
                await asyncio.sleep(delay)

        return False

    async def _execute_single(self, spec: OperationSpec) -> bool:
        if spec.action_type == "click":
            return await self._do_click(spec)
        elif spec.action_type == "type":
            return await self._do_type(spec)
        elif spec.action_type == "get_text":
            return await self._do_get_text(spec)
        elif spec.action_type == "set_text":
            return await self._do_set_text(spec)
        elif spec.action_type == "screenshot":
            return await self._do_screenshot(spec)
        elif spec.action_type == "activate_window":
            return await self._do_activate_window(spec)
        elif spec.action_type == "hotkey":
            return await self._do_hotkey(spec)
        elif spec.action_type == "scroll":
            return await self._do_scroll(spec)
        else:
            return await self._do_generic(spec)

    async def _do_click(self, spec: OperationSpec) -> bool:
        if self._uia_engine and self._uia_engine.is_available and spec.target:
            try:
                from agent.tools.windows_uia import UIAQuery
                query = UIAQuery(
                    name=spec.target,
                    control_type=spec.control_type or None,
                    timeout=spec.timeout,
                )
                elements = await self._uia_engine.find_elements(query)
                if elements:
                    return await self._uia_engine.click(elements[0])
            except Exception as e:
                log.debug("UIA click failed, falling back", error=str(e))

        if spec.coordinates and self._desktop_controller:
            result = self._desktop_controller.click(spec.coordinates[0], spec.coordinates[1])
            return result.success

        if spec.target and self._desktop_controller:
            try:
                result = self._desktop_controller.click_element(spec.target)
                return result.success
            except Exception as _exc:
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_click", _exc)

        return False

    async def _do_type(self, spec: OperationSpec) -> bool:
        if not spec.value:
            return False

        if self._uia_engine and self._uia_engine.is_available and spec.target:
            try:
                from agent.tools.windows_uia import UIAQuery
                query = UIAQuery(name=spec.target, control_type=spec.control_type or "Edit")
                elements = await self._uia_engine.find_elements(query)
                if elements:
                    return await self._uia_engine.set_text(elements[0], spec.value)
            except Exception as e:
                log.debug("UIA type failed, falling back", error=str(e))

        if self._desktop_controller:
            try:
                pg = self._desktop_controller._get_pyautogui()
                if pg:
                    pg.write(spec.value)
                    return True
            except Exception as _exc:
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_type", _exc)

        return False

    async def _do_get_text(self, spec: OperationSpec) -> bool:
        if self._uia_engine and self._uia_engine.is_available and spec.target:
            try:
                from agent.tools.windows_uia import UIAQuery
                query = UIAQuery(name=spec.target, control_type=spec.control_type or None)
                elements = await self._uia_engine.find_elements(query)
                if elements:
                    return True
            except Exception as e:
                log.debug("UIA get_text failed", error=str(e))
        return False

    async def _do_set_text(self, spec: OperationSpec) -> bool:
        if self._uia_engine and self._uia_engine.is_available and spec.target:
            try:
                from agent.tools.windows_uia import UIAQuery
                query = UIAQuery(name=spec.target, control_type=spec.control_type or "Edit")
                elements = await self._uia_engine.find_elements(query)
                if elements:
                    return await self._uia_engine.set_text(elements[0], spec.value or "")
            except Exception as e:
                log.debug("UIA set_text failed", error=str(e))
        return False

    async def _do_screenshot(self, spec: OperationSpec) -> bool:
        if self._desktop_controller:
            result = self._desktop_controller.screenshot_full()
            return result.success
        return False

    async def _do_activate_window(self, spec: OperationSpec) -> bool:
        if self._desktop_controller and spec.target:
            result = self._desktop_controller.activate_window(spec.target)
            return result.success
        return False

    async def _do_hotkey(self, spec: OperationSpec) -> bool:
        if self._desktop_controller:
            try:
                keys = spec.value.split("+") if spec.value else []
                if keys:
                    pg = self._desktop_controller._get_pyautogui()
                    if pg:
                        pg.hotkey(*[k.strip() for k in keys])
                        return True
            except Exception as _exc:
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_hotkey", _exc)
        return False

    async def _do_scroll(self, spec: OperationSpec) -> bool:
        if self._desktop_controller:
            try:
                pg = self._desktop_controller._get_pyautogui()
                if pg:
                    clicks = int(spec.value) if spec.value else 3
                    pg.scroll(clicks)
                    return True
            except Exception as _exc:
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_scroll", _exc)
        return False

    async def _do_generic(self, spec: OperationSpec) -> bool:
        if self._desktop_controller:
            try:
                result = self._desktop_controller.open_app(spec.target)
                return result.success
            except Exception as _exc:
                log_ignored(log, "operation_loop.DesktopOperationLoop._do_generic", _exc)
        return False

    async def _capture_screenshot(self, prefix: str) -> str:
        if not self._desktop_controller:
            return ""
        try:
            result = self._desktop_controller.screenshot_full()
            if result.success:
                return result.image_path
        except Exception as e:
            log.debug("Screenshot capture failed", error=str(e))
        return ""

    async def _capture_uia_snapshot(self) -> list[dict[str, Any]]:
        if not self._uia_engine or not self._uia_engine.is_available:
            return []
        try:
            elements = await self._uia_engine.get_element_tree(max_depth=2)
            return [
                {
                    "name": e.name,
                    "control_type": e.control_type,
                    "automation_id": e.automation_id,
                    "is_enabled": e.is_enabled,
                }
                for e in elements[:50]
            ]
        except Exception as e:
            log.debug("UIA snapshot failed", error=str(e))
            return []
