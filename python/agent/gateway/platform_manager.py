"""Gateway 平台管理器。

统一管理所有消息平台适配器的生命周期：
  - 适配器注册与发现
  - 批量启动/停止
  - 消息路由分发
  - 连接状态监控

集成示例::

    from agent.gateway.platform_manager import PlatformManager
    from agent.gateway.platforms.slack_adapter import SlackAdapter

    mgr = PlatformManager()
    mgr.register("slack", SlackAdapter(bot_token="xoxb-..."))
    await mgr.start_all()
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from agent.gateway.base import PlatformAdapter
from agent.core.logger import StructuredLogger

log = StructuredLogger("gateway.platform_manager")


@dataclass
class PlatformStatus:
    name: str = ""
    connected: bool = False
    message_count: int = 0
    error_count: int = 0
    last_error: str = ""


class PlatformManager:
    """多平台适配器管理器。"""

    def __init__(self):
        self._adapters: dict[str, PlatformAdapter] = {}
        self._statuses: dict[str, PlatformStatus] = {}
        self._message_handlers: list[Any] = []
        self._running = False

    def register(self, name: str, adapter: PlatformAdapter) -> None:
        self._adapters[name] = adapter
        self._statuses[name] = PlatformStatus(name=name)
        log.info("Platform adapter registered", platform=name)

    def unregister(self, name: str) -> None:
        self._adapters.pop(name, None)
        self._statuses.pop(name, None)

    def get_adapter(self, name: str) -> PlatformAdapter | None:
        return self._adapters.get(name)

    def list_platforms(self) -> list[str]:
        return list(self._adapters.keys())

    def add_message_handler(self, handler: Any) -> None:
        self._message_handlers.append(handler)

    async def start(self, name: str) -> bool:
        adapter = self._adapters.get(name)
        if not adapter:
            return False
        try:
            await adapter.start()
            self._statuses[name].connected = True
            log.info("Platform started", platform=name)
            return True
        except Exception as e:
            self._statuses[name].last_error = str(e)
            self._statuses[name].error_count += 1
            log.warning("Platform start failed", platform=name, error=str(e))
            return False

    async def stop(self, name: str) -> bool:
        adapter = self._adapters.get(name)
        if not adapter:
            return False
        try:
            await adapter.stop()
            self._statuses[name].connected = False
            log.info("Platform stopped", platform=name)
            return True
        except Exception as e:
            log.warning("Platform stop failed", platform=name, error=str(e))
            return False

    async def start_all(self) -> dict[str, bool]:
        results = {}
        for name in list(self._adapters.keys()):
            results[name] = await self.start(name)
        self._running = any(results.values())
        return results

    async def stop_all(self) -> dict[str, bool]:
        results = {}
        for name in list(self._adapters.keys()):
            results[name] = await self.stop(name)
        self._running = False
        return results

    async def send_message(self, platform: str, recipient: str, content: str, **kwargs: Any) -> bool:
        adapter = self._adapters.get(platform)
        if not adapter:
            return False
        try:
            await adapter.send_message(recipient, content)
            self._statuses[platform].message_count += 1
            return True
        except Exception as e:
            self._statuses[platform].error_count += 1
            self._statuses[platform].last_error = str(e)
            log.warning("Send message failed", platform=platform, error=str(e))
            return False

    async def broadcast(self, content: str, platforms: list[str] | None = None, **kwargs: Any) -> dict[str, bool]:
        targets = platforms or list(self._adapters.keys())
        results = {}
        for name in targets:
            results[name] = await self.send_message(name, "", content, **kwargs)
        return results

    async def get_status(self, name: str) -> PlatformStatus | None:
        status = self._statuses.get(name)
        if not status:
            return None
        adapter = self._adapters.get(name)
        if adapter:
            status.connected = await adapter.is_connected()
        return status

    async def get_all_statuses(self) -> dict[str, PlatformStatus]:
        for name, adapter in self._adapters.items():
            self._statuses[name].connected = await adapter.is_connected()
        return dict(self._statuses)

    @property
    def is_running(self) -> bool:
        return self._running

    def get_stats(self) -> dict[str, Any]:
        return {
            "platforms": len(self._adapters),
            "running": self._running,
            "connected": sum(1 for s in self._statuses.values() if s.connected),
            "total_messages": sum(s.message_count for s in self._statuses.values()),
            "total_errors": sum(s.error_count for s in self._statuses.values()),
        }
