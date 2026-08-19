"""ScreenWatcher — 屏幕变化检测。

定期截图对比，检测屏幕变化区域，生成增量变化事件。
支持像素差异检测和感知哈希对比。

Usage:
    from agent.perception.screen_watcher import ScreenWatcher
    watcher = ScreenWatcher()
    events = await watcher.check_for_changes()
"""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("screen_watcher")


@dataclass
class Rect:
    """矩形区域。

    Attributes:
        x: 左上角 x 坐标。
        y: 左上角 y 坐标。
        width: 宽度。
        height: 高度。
    """

    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0


@dataclass
class ScreenChangeEvent:
    """屏幕变化事件。

    Attributes:
        timestamp: 事件时间戳。
        changed_regions: 变化的屏幕区域列表。
        diff_score: 差异度 (0-1)。
        screenshot_path: 增量截图路径。
    """

    timestamp: float = 0.0
    changed_regions: list[Rect] = field(default_factory=list)
    diff_score: float = 0.0
    screenshot_path: str = ""


class ScreenWatcher:
    """屏幕变化检测器。

    定期截图并对比，检测屏幕变化区域。
    支持两种检测模式：
    1. pixel_diff: 像素级差异检测（精确，较慢）
    2. hash_diff: 感知哈希对比（快速，粗略）

    Usage:
        watcher = ScreenWatcher()
        await watcher.start()
        events = watcher.get_events()
        await watcher.stop()
    """

    def __init__(
        self,
        poll_interval: float = 1.0,
        diff_threshold: float = 0.02,
        detection_mode: str = "hash_diff",
        shutdown_event: asyncio.Event | None = None,
    ) -> None:
        self._poll_interval = poll_interval
        self._diff_threshold = diff_threshold
        self._detection_mode = detection_mode
        self._baseline_path: str = ""
        self._baseline_hash: str = ""
        self._events: list[ScreenChangeEvent] = []
        self._running: bool = False
        self._task: asyncio.Task | None = None
        self._screenshot_dir: str = ""
        self._shutdown_event = shutdown_event

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def event_count(self) -> int:
        return len(self._events)

    async def start(self) -> None:
        """启动屏幕变化检测。"""
        if self._running:
            return

        self._running = True
        self._screenshot_dir = os.path.join(
            os.environ.get("DATA_DIR", "data"), "screenshots", "watcher",
        )
        os.makedirs(self._screenshot_dir, exist_ok=True)

        self._baseline_path = await self._take_screenshot("baseline")
        self._baseline_hash = self._compute_hash(self._baseline_path)

        self._task = asyncio.create_task(self._poll_loop())
        log.info("ScreenWatcher 启动", interval=self._poll_interval, mode=self._detection_mode)

    async def stop(self) -> None:
        """停止屏幕变化检测。"""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError as _exc:
                log_ignored(log, "screen_watcher.stop", _exc)
            self._task = None
        log.info("ScreenWatcher 停止", events=len(self._events))

    async def check_for_changes(self) -> list[ScreenChangeEvent]:
        """手动检查屏幕变化。

        Returns:
            自上次检查以来的变化事件列表。
        """
        current_path = await self._take_screenshot("check")

        if self._detection_mode == "hash_diff":
            current_hash = self._compute_hash(current_path)
            if current_hash == self._baseline_hash:
                return []

            diff_score = self._compute_pixel_diff_ratio(self._baseline_path, current_path)
            event = ScreenChangeEvent(
                timestamp=time.time(),
                diff_score=diff_score,
                screenshot_path=current_path,
            )

            if diff_score >= self._diff_threshold:
                regions = self._detect_changed_regions(self._baseline_path, current_path)
                event.changed_regions = regions
                self._events.append(event)
                self._baseline_path = current_path
                self._baseline_hash = current_hash
                return [event]

            return []

        diff_score = self._compute_pixel_diff_ratio(self._baseline_path, current_path)
        if diff_score < self._diff_threshold:
            return []

        regions = self._detect_changed_regions(self._baseline_path, current_path)
        event = ScreenChangeEvent(
            timestamp=time.time(),
            changed_regions=regions,
            diff_score=diff_score,
            screenshot_path=current_path,
        )
        self._events.append(event)
        self._baseline_path = current_path
        self._baseline_hash = self._compute_hash(current_path)
        return [event]

    def get_events(self, limit: int = 50) -> list[ScreenChangeEvent]:
        """获取变化事件列表。

        Args:
            limit: 最大返回数量。

        Returns:
            变化事件列表（按时间倒序）。
        """
        return list(reversed(self._events[-limit:]))

    def clear_events(self) -> None:
        """清空事件列表。"""
        self._events.clear()

    async def wait_for_change(self, timeout: float = 10.0) -> ScreenChangeEvent | None:
        """等待屏幕变化。

        Args:
            timeout: 最大等待时间（秒）。

        Returns:
            变化事件或 None（超时）。
        """
        deadline = time.time() + timeout
        initial_count = len(self._events)

        while time.time() < deadline:
            events = await self.check_for_changes()
            if events:
                return events[0]
            await asyncio.sleep(self._poll_interval)

        return None

    async def _poll_loop(self) -> None:
        """后台轮询循环。

        同时监听 shutdown_event，当外部触发关闭时立即退出。
        """
        while self._running:
            try:
                if self._shutdown_event is not None and self._shutdown_event.is_set():
                    log.info("ScreenWatcher 收到 shutdown 信号，退出轮询")
                    break
                await self.check_for_changes()
            except Exception as e:
                log.warning("ScreenWatcher 轮询异常", error=str(e))

            try:
                if self._shutdown_event is not None:
                    try:
                        await asyncio.wait_for(
                            self._shutdown_event.wait(),
                            timeout=self._poll_interval,
                        )
                        log.info("ScreenWatcher shutdown 事件触发，退出轮询")
                        break
                    except asyncio.TimeoutError as _exc:
                        log_ignored(log, "screen_watcher._poll_loop.timeout", _exc)
                else:
                    await asyncio.sleep(self._poll_interval)
            except asyncio.CancelledError:
                break

    async def _take_screenshot(self, label: str = "") -> str:
        """截图并保存。

        Args:
            label: 截图标签。

        Returns:
            截图文件路径。
        """
        try:
            from agent.desktop.desktop_controller import get_desktop_controller
            controller = get_desktop_controller()
            result = controller.screenshot_full()
            if result.success:
                return result.image_path
        except Exception as _exc:
            log_ignored(log, "screen_watcher._take_screenshot", _exc)

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"watch_{label}_{timestamp}.png"
        return os.path.join(self._screenshot_dir, filename)

    def _compute_hash(self, image_path: str) -> str:
        """计算图片感知哈希。"""
        if not image_path or not os.path.exists(image_path):
            return ""

        try:
            import imagehash
            from PIL import Image
            img = Image.open(image_path)
            return str(imagehash.average_hash(img, hash_size=8))
        except ImportError as _exc:
            log_ignored(log, "screen_watcher._compute_hash", _exc)

        try:
            from PIL import Image
            img = Image.open(image_path).convert("L").resize((16, 16))
            return str(list(img.getdata())[:64])
        except Exception:
            return ""

    def _compute_pixel_diff_ratio(self, pre_path: str, post_path: str) -> float:
        """计算两张截图的像素差异率。"""
        if not pre_path or not post_path:
            return 0.0
        if not os.path.exists(pre_path) or not os.path.exists(post_path):
            return 0.0

        try:
            from PIL import Image

            img_pre = Image.open(pre_path).convert("L")
            img_post = Image.open(post_path).convert("L")

            if img_pre.size != img_post.size:
                img_post = img_post.resize(img_pre.size)

            try:
                import numpy as np
                arr_pre = np.array(img_pre, dtype=np.float32)
                arr_post = np.array(img_post, dtype=np.float32)
                diff = np.abs(arr_pre - arr_post)
                total = diff.size
                if total == 0:
                    return 0.0
                changed = np.count_nonzero(diff > 30)
                return changed / total
            except ImportError:
                pixels_pre = list(img_pre.getdata())
                pixels_post = list(img_post.getdata())
                total = len(pixels_pre)
                if total == 0:
                    return 0.0
                changed = sum(1 for a, b in zip(pixels_pre, pixels_post) if abs(a - b) > 30)
                return changed / total

        except Exception:
            return 0.0

    def _detect_changed_regions(self, pre_path: str, post_path: str) -> list[Rect]:
        """检测变化的屏幕区域（基于网格分块）。

        将截图分成 N×M 网格，对比每个网格块的差异。

        Args:
            pre_path: 操作前截图路径。
            post_path: 操作后截图路径。

        Returns:
            变化区域列表。
        """
        if not os.path.exists(pre_path) or not os.path.exists(post_path):
            return []

        try:
            from PIL import Image

            img_pre = Image.open(pre_path).convert("L")
            img_post = Image.open(post_path).convert("L")

            if img_pre.size != img_post.size:
                img_post = img_post.resize(img_pre.size)

            w, h = img_pre.size
            grid_cols = 8
            grid_rows = 6
            cell_w = w // grid_cols
            cell_h = h // grid_rows

            regions: list[Rect] = []

            try:
                import numpy as np
                arr_pre = np.array(img_pre, dtype=np.float32)
                arr_post = np.array(img_post, dtype=np.float32)

                for row in range(grid_rows):
                    for col in range(grid_cols):
                        y1 = row * cell_h
                        y2 = min((row + 1) * cell_h, h)
                        x1 = col * cell_w
                        x2 = min((col + 1) * cell_w, w)

                        block_pre = arr_pre[y1:y2, x1:x2]
                        block_post = arr_post[y1:y2, x1:x2]

                        diff = np.abs(block_pre - block_post)
                        if diff.size > 0:
                            ratio = np.count_nonzero(diff > 30) / diff.size
                            if ratio > 0.1:
                                regions.append(Rect(x=x1, y=y1, width=x2 - x1, height=y2 - y1))

            except ImportError:
                for row in range(grid_rows):
                    for col in range(grid_cols):
                        y1 = row * cell_h
                        y2 = min((row + 1) * cell_h, h)
                        x1 = col * cell_w
                        x2 = min((col + 1) * cell_w, w)

                        block_pre = list(img_pre.crop((x1, y1, x2, y2)).getdata())
                        block_post = list(img_post.crop((x1, y1, x2, y2)).getdata())

                        if block_pre and block_post:
                            changed = sum(1 for a, b in zip(block_pre, block_post) if abs(a - b) > 30)
                            ratio = changed / len(block_pre)
                            if ratio > 0.1:
                                regions.append(Rect(x=x1, y=y1, width=x2 - x1, height=y2 - y1))

            return self._merge_regions(regions)

        except Exception:
            return []

    def _merge_regions(self, regions: list[Rect], gap: int = 20) -> list[Rect]:
        """合并相邻的变化区域。

        Args:
            regions: 原始区域列表。
            gap: 合并间距阈值。

        Returns:
            合并后的区域列表。
        """
        if not regions:
            return []

        merged: list[Rect] = [regions[0]]
        for rect in regions[1:]:
            last = merged[-1]
            if (abs(rect.x - (last.x + last.width)) < gap and
                    abs(rect.y - last.y) < gap):
                new_x = min(last.x, rect.x)
                new_y = min(last.y, rect.y)
                new_w = max(last.x + last.width, rect.x + rect.width) - new_x
                new_h = max(last.y + last.height, rect.y + rect.height) - new_y
                merged[-1] = Rect(x=new_x, y=new_y, width=new_w, height=new_h)
            else:
                merged.append(rect)

        return merged
