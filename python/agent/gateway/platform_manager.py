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
    mgr.register("slack", SlackAdapter(bot_token=os.environ["SLACK_BOT_TOKEN"]))
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
    simulated: bool = False
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
        log.debug("Platform adapter registered", platform=name)

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
            # 诚实化：connected 以适配器真实连接态为准，模拟态不计为已连接
            self._statuses[name].connected = await adapter.is_connected()
            self._statuses[name].simulated = adapter.simulated
            if adapter.simulated:
                log.warning("Platform started in SIMULATED mode (not connected)", platform=name)
            else:
、                log.debug("Platform started", platform=name)
            return True
        except Exception as e:
            log.debug("platform_manager 异常处理", error=str(e))
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
            # 诚实化：返回适配器的真实发送结果，不谎报成功
            ok = await adapter.send_message(recipient, content, **kwargs)
            if ok:
                self._statuses[platform].message_count += 1
            else:
                # 模拟态/未连接：发送未真实送达，不计入成功消息数
                log.warning(
                    "Send returned False (message not actually delivered)",
                    platform=platform,
                    simulated=adapter.simulated,
                )
            return ok
        except Exception as e:
            log.debug("platform_manager 异常处理", error=str(e))
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
            status.simulated = adapter.simulated
        return status

    async def get_all_statuses(self) -> dict[str, PlatformStatus]:
        for name, adapter in self._adapters.items():
            self._statuses[name].connected = await adapter.is_connected()
            self._statuses[name].simulated = adapter.simulated
        return dict(self._statuses)

    @property
    def is_running(self) -> bool:
        return self._running

    def get_stats(self) -> dict[str, Any]:
        return {
            "platforms": len(self._adapters),
            "running": self._running,
            "connected": sum(1 for s in self._statuses.values() if s.connected),
            "simulated": sum(1 for s in self._statuses.values() if s.simulated),
            "total_messages": sum(s.message_count for s in self._statuses.values()),
            "total_errors": sum(s.error_count for s in self._statuses.values()),
        }
