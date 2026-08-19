"""EventBridge — 事件触发桥接。

支持四种触发方式：
1. CronTrigger: 定时触发（复用 cronjob_tools 的调度能力）
2. FileWatchTrigger: 文件变更触发（基于轮询，可选 watchdog）
3. WebhookTrigger: HTTP 触发
4. MessageTrigger: A2A / WebSocket 消息触发

Usage:
    from agent.workflow.event_bridge import EventBridge

    bridge = EventBridge()
    bridge.register_cron("workflow-123", "0 9 * * *")
    bridge.start()
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger
from agent.workflow.types import TriggerConfig, TriggerType

log = StructuredLogger("event_bridge")


@dataclass
class TriggerEvent:
    """触发事件。

    Attributes:
        type: 触发类型。
        definition_id: 关联的工作流定义 ID。
        payload: 事件载荷。
        timestamp: 事件时间戳。
    """

    type: str
    definition_id: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0


class CronScheduler:
    """简易 Cron 调度器 — 基于轮询的定时触发。

    支持 cron 表达式的基本子集：
    - 分钟 小时 日 月 星期
    - 支持 * 和数字
    - 不支持范围和步进（可后续扩展）
    """

    def __init__(self) -> None:
        self._schedules: dict[str, dict[str, Any]] = {}
        self._last_check: dict[str, int] = {}

    def register(self, definition_id: str, cron_expression: str) -> None:
        parts = cron_expression.strip().split()
        if len(parts) != 5:
            log.warning("无效 cron 表达式", expr=cron_expression)
            return
        self._schedules[definition_id] = {
            "minute": self._parse_field(parts[0], 0, 59),
            "hour": self._parse_field(parts[1], 0, 23),
            "day": self._parse_field(parts[2], 1, 31),
            "month": self._parse_field(parts[3], 1, 12),
            "weekday": self._parse_field(parts[4], 0, 6),
        }

    def unregister(self, definition_id: str) -> None:
        self._schedules.pop(definition_id, None)
        self._last_check.pop(definition_id, None)

    def check(self) -> list[str]:
        now = time.localtime()
        current_minute = (now.tm_year, now.tm_mon, now.tm_mday, now.tm_hour, now.tm_min)
        triggered = []
        for def_id, sched in self._schedules.items():
            last = self._last_check.get(def_id)
            if last == current_minute:
                continue
            if (now.tm_min in sched["minute"] and
                now.tm_hour in sched["hour"] and
                now.tm_mday in sched["day"] and
                now.tm_mon in sched["month"] and
                now.tm_wday in sched["weekday"]):
                triggered.append(def_id)
                self._last_check[def_id] = current_minute
        return triggered

    def _parse_field(self, field: str, min_val: int, max_val: int) -> set[int]:
        if field == "*":
            return set(range(min_val, max_val + 1))
        try:
            val = int(field)
            if min_val <= val <= max_val:
                return {val}
        except ValueError as _exc:
            log_ignored(log, "event_bridge._parse_field", _exc)
        return set(range(min_val, max_val + 1))


class FileWatcher:
    """文件变更检测器 — 基于轮询的文件监听。

    检测文件的 mtime 变化，触发关联的工作流。
    """

    def __init__(self, poll_interval: float = 5.0) -> None:
        self._watches: dict[str, dict[str, Any]] = {}
        self._snapshots: dict[str, dict[str, float]] = {}
        self._poll_interval = poll_interval

    def register(
        self,
        definition_id: str,
        paths: list[str],
        patterns: list[str] | None = None,
    ) -> None:
        self._watches[definition_id] = {
            "paths": paths,
            "patterns": patterns or ["*"],
        }
        self._snapshot(definition_id)

    def unregister(self, definition_id: str) -> None:
        self._watches.pop(definition_id, None)
        self._snapshots.pop(definition_id, None)

    def check(self) -> list[tuple[str, list[str]]]:
        triggered = []
        for def_id, config in self._watches.items():
            changed = self._detect_changes(def_id)
            if changed:
                triggered.append((def_id, changed))
                self._snapshot(def_id)
        return triggered

    def _snapshot(self, definition_id: str) -> None:
        config = self._watches.get(definition_id)
        if not config:
            return
        snapshot: dict[str, float] = {}
        for base_path in config["paths"]:
            p = Path(base_path)
            if p.is_file():
                try:
                    snapshot[str(p)] = p.stat().st_mtime
                except OSError as _exc:
                    log_ignored(log, "event_bridge._snapshot.file", _exc)
            elif p.is_dir():
                for child in p.rglob("*"):
                    if child.is_file():
                        try:
                            snapshot[str(child)] = child.stat().st_mtime
                        except OSError as _exc:
                            log_ignored(log, "event_bridge._snapshot.dir_child", _exc)
        self._snapshots[definition_id] = snapshot

    def _detect_changes(self, definition_id: str) -> list[str]:
        config = self._watches.get(definition_id)
        old_snapshot = self._snapshots.get(definition_id)
        if not config or not old_snapshot:
            return []
        changed = []
        for base_path in config["paths"]:
            p = Path(base_path)
            if p.is_file():
                try:
                    current_mtime = p.stat().st_mtime
                    old_mtime = old_snapshot.get(str(p), 0)
                    if current_mtime > old_mtime:
                        changed.append(str(p))
                except OSError as _exc:
                    log_ignored(log, "event_bridge._detect_changes.file", _exc)
            elif p.is_dir():
                for child in p.rglob("*"):
                    if child.is_file():
                        try:
                            current_mtime = child.stat().st_mtime
                            old_mtime = old_snapshot.get(str(child), 0)
                            if current_mtime > old_mtime:
                                changed.append(str(child))
                        except OSError as _exc:
                            log_ignored(log, "event_bridge._detect_changes.dir_child", _exc)
        return changed


class EventBridge:
    """事件触发桥接 — 统一管理所有触发源。

    轮询检查 Cron 和 FileWatch 触发器，返回触发事件列表。
    Webhook 和 Message 触发器由外部系统调用 trigger() 方法。
    """

    def __init__(self) -> None:
        self._cron = CronScheduler()
        self._file_watcher = FileWatcher()
        self._webhook_routes: dict[str, str] = {}
        self._message_patterns: dict[str, str] = {}
        self._running = False
        self._check_interval = 30.0

    def register_trigger(self, definition_id: str, trigger: TriggerConfig) -> None:
        if trigger.type == TriggerType.CRON and trigger.cron_expression:
            self._cron.register(definition_id, trigger.cron_expression)
        elif trigger.type == TriggerType.FILE and trigger.watch_paths:
            self._file_watcher.register(
                definition_id, trigger.watch_paths, trigger.watch_patterns,
            )
        elif trigger.type == TriggerType.WEBHOOK and trigger.webhook_path:
            self._webhook_routes[trigger.webhook_path] = definition_id
        elif trigger.type == TriggerType.MESSAGE and trigger.message_pattern:
            self._message_patterns[definition_id] = trigger.message_pattern

    def unregister_trigger(self, definition_id: str) -> None:
        self._cron.unregister(definition_id)
        self._file_watcher.unregister(definition_id)
        self._webhook_routes = {k: v for k, v in self._webhook_routes.items() if v != definition_id}
        self._message_patterns.pop(definition_id, None)

    def check(self) -> list[TriggerEvent]:
        events = []
        for def_id in self._cron.check():
            events.append(TriggerEvent(
                type=TriggerType.CRON,
                definition_id=def_id,
                timestamp=time.time(),
            ))
        for def_id, changed_files in self._file_watcher.check():
            events.append(TriggerEvent(
                type=TriggerType.FILE,
                definition_id=def_id,
                payload={"changed_files": changed_files},
                timestamp=time.time(),
            ))
        return events

    def trigger_webhook(self, path: str, payload: dict[str, Any] | None = None) -> TriggerEvent | None:
        definition_id = self._webhook_routes.get(path)
        if not definition_id:
            return None
        return TriggerEvent(
            type=TriggerType.WEBHOOK,
            definition_id=definition_id,
            payload=payload or {},
            timestamp=time.time(),
        )

    def trigger_message(self, message: str) -> TriggerEvent | None:
        import re
        for def_id, pattern in self._message_patterns.items():
            if re.search(pattern, message):
                return TriggerEvent(
                    type=TriggerType.MESSAGE,
                    definition_id=def_id,
                    payload={"message": message},
                    timestamp=time.time(),
                )
        return None

    async def start(self) -> None:
        self._running = True
        log.info("EventBridge 启动")

    async def stop(self) -> None:
        self._running = False
        log.info("EventBridge 停止")

    @property
    def is_running(self) -> bool:
        return self._running
