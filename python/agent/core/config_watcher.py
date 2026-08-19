"""动态配置热重载 (Config Watcher)。

无需重启进程即可热重载配置变更。支持：
- 文件监控：监听配置文件变更自动重载
- 环境变量刷新：重新读取环境变量
- 配置版本管理：记录配置变更历史
- 变更回调：配置变更时通知各组件
- 原子替换：新旧配置原子切换

Usage:
    watcher = ConfigWatcher()
    watcher.watch("config.json")
    watcher.on_change(lambda old, new: apply_config(new))
    await watcher.start()
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from agent.core.logger import log_ignored


@dataclass
class ConfigSnapshot:
    version: int = 0
    timestamp: float = 0.0
    data: dict[str, Any] = field(default_factory=dict)
    source: str = ""


class ConfigWatcher:
    def __init__(self, poll_interval: float = 2.0) -> None:
        self._poll_interval = poll_interval
        self._watched_files: dict[str, float] = {}
        self._current: ConfigSnapshot = ConfigSnapshot()
        self._env_snapshots: dict[str, dict[str, Any]] = {}
        self._history: list[ConfigSnapshot] = []
        self._callbacks: list[Callable[[ConfigSnapshot, ConfigSnapshot], None]] = []
        self._lock = threading.Lock()
        self._running = False
        self._task: asyncio.Task | None = None
        self._version = 0

    @property
    def current(self) -> ConfigSnapshot:
        with self._lock:
            return deepcopy(self._current)

    def watch(self, file_path: str | Path) -> None:
        fp = str(file_path)
        self._watched_files[fp] = self._get_mtime(fp)
        self._load_file(fp)

    def watch_env(self, prefix: str = "") -> None:
        self._watched_files[f"env:{prefix}"] = time.time()
        self._env_snapshots[prefix] = self._snapshot_env(prefix)
        self._load_env(prefix)

    def on_change(self, callback: Callable[[ConfigSnapshot, ConfigSnapshot], None]) -> None:
        self._callbacks.append(callback)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError as _exc:
                log_ignored(None, "config_watcher.ConfigWatcher.stop", _exc)
            self._task = None

    async def _poll_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self._poll_interval)
            try:
                self._check_changes()
            except Exception as _exc:
                log_ignored(None, "config_watcher.ConfigWatcher._poll_loop", _exc)

    def _check_changes(self) -> None:
        changed = False
        old_snapshot = deepcopy(self._current)
        for fp, last_mtime in list(self._watched_files.items()):
            if fp.startswith("env:"):
                prefix = fp[4:]
                current_env = self._snapshot_env(prefix)
                previous_env = self._env_snapshots.get(prefix, {})
                if current_env != previous_env:
                    self._env_snapshots[prefix] = current_env
                    self._version += 1
                    self._current = ConfigSnapshot(
                        version=self._version, timestamp=time.time(),
                        data=current_env, source=f"env:{prefix}",
                    )
                    changed = True
                continue
            current_mtime = self._get_mtime(fp)
            if current_mtime > last_mtime:
                self._watched_files[fp] = current_mtime
                self._load_file(fp)
                changed = True
        if changed and self._current.version > 0:
            self._notify(old_snapshot, self._current)

    def _load_file(self, file_path: str) -> None:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._version += 1
            self._current = ConfigSnapshot(
                version=self._version, timestamp=time.time(),
                data=data, source=file_path,
            )
            self._history.append(self._current)
            if len(self._history) > 50:
                self._history = self._history[-30:]
        except Exception as _exc:
            log_ignored(None, "config_watcher.ConfigWatcher._load_file", _exc)

    def _load_env(self, prefix: str) -> None:
        data = self._snapshot_env(prefix)
        self._version += 1
        self._current = ConfigSnapshot(
            version=self._version, timestamp=time.time(),
            data=data, source=f"env:{prefix}",
        )

    def _snapshot_env(self, prefix: str) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in os.environ.items():
            if not prefix or key.startswith(prefix):
                result[key] = value
        return result

    def _notify(self, old: ConfigSnapshot, new: ConfigSnapshot) -> None:
        for cb in self._callbacks:
            try:
                cb(old, new)
            except Exception as _exc:
                log_ignored(None, "config_watcher.ConfigWatcher._notify", _exc)

    @staticmethod
    def _get_mtime(file_path: str) -> float:
        try:
            return os.path.getmtime(file_path)
        except OSError:
            return 0.0

    def get_history(self) -> list[ConfigSnapshot]:
        return list(self._history)


class ConfigReloader:
    def __init__(self, engine: Any = None) -> None:
        self._engine = engine
        self._watcher = ConfigWatcher()
        self._watcher.on_change(self._apply_config)

    @property
    def watcher(self) -> ConfigWatcher:
        return self._watcher

    async def start(self, config_files: list[str] | None = None) -> None:
        if config_files:
            for cf in config_files:
                self._watcher.watch(cf)
        self._watcher.watch_env("AGENT_")
        self._watcher.watch_env("LLM_")
        await self._watcher.start()

    async def stop(self) -> None:
        await self._watcher.stop()

    def _apply_config(self, old: ConfigSnapshot, new: ConfigSnapshot) -> None:
        if self._engine is None:
            return
        for key, value in new.data.items():
            if key.startswith("LLM_") and hasattr(self._engine, "llm"):
                provider = self._engine.llm
                if key == "LLM_TEMPERATURE":
                    try:
                        provider.temperature = float(value)
                    except (ValueError, TypeError) as _exc:
                        log_ignored(None, "config_watcher.ConfigReloader._apply_config", _exc)
                elif key == "LLM_MAX_TOKENS":
                    try:
                        provider.max_tokens = int(value)
                    except (ValueError, TypeError) as _exc:
                        log_ignored(None, "config_watcher.ConfigReloader._apply_config", _exc)
                elif key == "LLM_MODEL":
                    provider.model = str(value)
