"""MCP 资源订阅 — resources/subscribe 实时变更通知。

MCP 协议的 resources/subscribe 允许客户端订阅资源 URI，
当资源内容变更时，服务端主动推送 notifications/resources/updated 通知。

本模块提供：
- ResourceSubscription: 订阅管理器，跟踪活跃订阅
- ResourceChangeEvent: 资源变更事件数据类
- 与 MCPClient 集成的订阅/取消/通知处理

Usage:
    from agent.mcp_integration.resource_subscription import ResourceSubscriptionManager
    mgr = ResourceSubscriptionManager(mcp_client)
    await mgr.subscribe("my-server", "file:///data/config.json")
    # 当资源变更时，回调自动触发
    await mgr.unsubscribe("my-server", "file:///data/config.json")
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("resource_subscription")




@dataclass
class ResourceChangeEvent:
    """资源变更事件。

    Attributes:
        server_name: MCP 服务端名称。
        uri: 资源 URI。
        timestamp: 事件时间戳。
        action: 变更动作（updated/deleted）。
        data: 变更后的资源内容（可选）。
    """

    server_name: str = ""
    uri: str = ""
    timestamp: float = 0.0
    action: str = "updated"
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class SubscriptionEntry:
    """订阅条目。

    Attributes:
        server_name: MCP 服务端名称。
        uri: 资源 URI。
        subscribed_at: 订阅时间戳。
        callback: 变更回调函数。
        last_event_at: 最后一次收到事件的时间戳。
        event_count: 收到的事件总数。
    """

    server_name: str = ""
    uri: str = ""
    subscribed_at: float = 0.0
    callback: Callable[[ResourceChangeEvent], Awaitable[None]] | None = None
    last_event_at: float = 0.0
    event_count: int = 0


ResourceChangeCallback = Callable[[ResourceChangeEvent], Awaitable[None]]


class ResourceSubscriptionManager:
    """MCP 资源订阅管理器。

    管理 resources/subscribe 和 resources/unsubscribe 请求，
    处理 notifications/resources/updated 通知并分发到回调。

    Usage:
        mgr = ResourceSubscriptionManager(mcp_client)
        await mgr.subscribe("fs", "file:///data/config.json", on_change)
        ...
        await mgr.unsubscribe_all()
    """

    def __init__(self, mcp_client: Any) -> None:
        self._client = mcp_client
        self._subscriptions: dict[str, SubscriptionEntry] = {}
        self._global_callbacks: list[ResourceChangeCallback] = []
        self._event_queue: asyncio.Queue[ResourceChangeEvent] = asyncio.Queue()
        self._processor_task: asyncio.Task | None = None
        self._running = False

    @property
    def active_subscriptions(self) -> list[SubscriptionEntry]:
        return list(self._subscriptions.values())

    @property
    def subscription_count(self) -> int:
        return len(self._subscriptions)

    def on_change(self, callback: ResourceChangeCallback) -> None:
        """注册全局变更回调（所有资源变更都会触发）。"""
        self._global_callbacks.append(callback)

    async def subscribe(
        self,
        server_name: str,
        uri: str,
        callback: ResourceChangeCallback | None = None,
    ) -> bool:
        """订阅资源变更。

        向 MCP 服务端发送 resources/subscribe 请求，
        并注册本地回调。

        Args:
            server_name: MCP 服务端名称。
            uri: 资源 URI。
            callback: 变更回调（可选，也可通过 on_change 注册全局回调）。

        Returns:
            是否订阅成功。
        """
        key = f"{server_name}:{uri}"
        if key in self._subscriptions:
            log.debug("资源已订阅，跳过", server=server_name, uri=uri)
            return True

        try:
            request_id = self._client._request_id + 1
            self._client._request_id = request_id
            request = {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "resources/subscribe",
                "params": {"uri": uri},
            }
            response = await self._client._send_request(server_name, request)

            if "error" in response:
                log.warning(
                    "资源订阅请求失败",
                    server=server_name,
                    uri=uri,
                    error=str(response["error"]),
                )
                return False

            entry = SubscriptionEntry(
                server_name=server_name,
                uri=uri,
                subscribed_at=time.time(),
                callback=callback,
            )
            self._subscriptions[key] = entry
            log.info("资源订阅成功", server=server_name, uri=uri)
            return True

        except Exception as e:
            log.warning("资源订阅异常", server=server_name, uri=uri, error=str(e))
            return False

    async def unsubscribe(self, server_name: str, uri: str) -> bool:
        """取消资源订阅。

        Args:
            server_name: MCP 服务端名称。
            uri: 资源 URI。

        Returns:
            是否取消成功。
        """
        key = f"{server_name}:{uri}"
        if key not in self._subscriptions:
            return False

        try:
            request_id = self._client._request_id + 1
            self._client._request_id = request_id
            request = {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "resources/unsubscribe",
                "params": {"uri": uri},
            }
            await self._client._send_request(server_name, request)

        except Exception as e:
            log.warning("取消订阅请求失败", server=server_name, uri=uri, error=str(e))

        self._subscriptions.pop(key, None)
        log.info("资源订阅已取消", server=server_name, uri=uri)
        return True

    async def unsubscribe_all(self) -> None:
        """取消所有订阅。"""
        for key, entry in list(self._subscriptions.items()):
            try:
                request_id = self._client._request_id + 1
                self._client._request_id = request_id
                request = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "resources/unsubscribe",
                    "params": {"uri": entry.uri},
                }
                await self._client._send_request(entry.server_name, request)
            except Exception as _exc:
                log.debug("resource_subscription 异常处理", error=str(_exc))
                log_ignored(log, "resource_subscription.unsubscribe_all", _exc)

        self._subscriptions.clear()
        log.info("所有资源订阅已取消")

    async def handle_notification(self, notification: dict[str, Any]) -> None:
        """处理 MCP 服务端推送的资源变更通知。

        MCP 协议中，服务端通过 notifications/resources/updated
        通知客户端资源内容已变更。

        Args:
            notification: JSON-RPC 通知对象。
        """
        method = notification.get("method", "")
        if method != "notifications/resources/updated":
            return

        params = notification.get("params", {})
        uri = params.get("uri", "")
        if not uri:
            return

        event = ResourceChangeEvent(
            uri=uri,
            timestamp=time.time(),
            action="updated",
            data=params,
        )

        await self._event_queue.put(event)

    async def start_processor(self) -> None:
        """启动事件处理器。

        从事件队列中消费资源变更事件，分发到注册的回调。
        """
        if self._running:
            return
        self._running = True
        self._processor_task = asyncio.create_task(self._process_loop())
        log.info("资源订阅事件处理器启动")

    async def stop_processor(self) -> None:
        """停止事件处理器。"""
        self._running = False
        if self._processor_task is not None:
            self._processor_task.cancel()
            try:
                await self._processor_task
            except asyncio.CancelledError as _exc:
                log_ignored(log, "resource_subscription.stop_processor", _exc)
            self._processor_task = None
        log.info("资源订阅事件处理器停止")

    async def _process_loop(self) -> None:
        """事件处理循环。"""
        while self._running:
            try:
                event = await asyncio.wait_for(
                    self._event_queue.get(), timeout=1.0,
                )
                await self._dispatch_event(event)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.warning("事件处理异常", error=str(e))

    async def _dispatch_event(self, event: ResourceChangeEvent) -> None:
        """分发事件到匹配的回调。

        P1-5 增强：同时将事件发布到 EventBus（感知总线），
        使 Agent 感知系统能实时接收 MCP 资源变更通知，
        无需显式订阅即可通过 EventBus 监听。
        """
        for key, entry in self._subscriptions.items():
            if entry.uri == event.uri:
                entry.last_event_at = event.timestamp
                entry.event_count += 1
                event.server_name = entry.server_name

                if entry.callback:
                    try:
                        await entry.callback(event)
                    except Exception as e:
                        log.warning(
                            "资源变更回调异常",
                            uri=event.uri,
                            error=str(e),
                        )

        for callback in self._global_callbacks:
            try:
                await callback(event)
            except Exception as e:
                log.warning("全局回调异常", uri=event.uri, error=str(e))

        # P1-5: 将事件发布到 EventBus（感知总线）
        try:
            from agent.core.event_bus import EventBus as AgentEventBus
            bus = AgentEventBus.get_instance()
            bus.emit("mcp:resource_changed", {
                "uri": event.uri,
                "action": event.action,
                "server_name": event.server_name,
                "timestamp": event.timestamp,
                "data": event.data,
            })
            log.debug(
                "P1-5: 资源变更事件已发布到 EventBus",
                uri=event.uri,
                action=event.action,
            )
        except ImportError:
            pass
        except Exception as _exc:
            log.debug("resource_subscription 异常处理", error=str(_exc))
            log_ignored(log, "resource_subscription._dispatch_event.eventbus", _exc)

        log.debug(
            "资源变更事件已分发",
            uri=event.uri,
            action=event.action,
        )

    def get_subscription_stats(self) -> dict[str, Any]:
        """获取订阅统计信息。"""
        return {
            "active_count": len(self._subscriptions),
            "subscriptions": [
                {
                    "server": e.server_name,
                    "uri": e.uri,
                    "subscribed_at": e.subscribed_at,
                    "event_count": e.event_count,
                    "last_event_at": e.last_event_at,
                }
                for e in self._subscriptions.values()
            ],
        }
