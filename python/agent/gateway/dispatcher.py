"""消息分发中心。

MessageDispatcher 是所有平台适配器的注册与消息路由中心，
负责将入站消息分发到 AgentEngine 处理，以及向所有平台广播出站消息。

典型用法:
    dispatcher = MessageDispatcher()
    dispatcher.register_adapter("webhook", webhook_adapter)
    result = await dispatcher.dispatch(message)
    await dispatcher.broadcast("系统公告")
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine

from agent.gateway.base import Message, PlatformAdapter
from agent.gateway.mirror import MessageMirror
from agent.gateway.pairing import PairingAuth
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("gateway.dispatcher")


class MessageDispatcher:
    """消息分发中心，管理平台适配器注册与消息路由。

    职责:
        1. 注册/注销平台适配器
        2. 将入站消息路由到处理回调（AgentEngine）
        3. 向所有已注册平台广播消息
        4. 查询已注册适配器信息
        5. 消息镜像（跨会话同步）
        6. DM 配对授权检查

    Attributes:
        _adapters: 已注册的平台适配器映射，key 为适配器名称。
        _handler: 消息处理回调，由外部通过 set_handler() 注入。
        _mirror: 消息镜像管理器。
        _pairing: DM 配对授权管理器。
    """

    def __init__(self) -> None:
        """初始化消息分发中心。"""
        self._adapters: dict[str, PlatformAdapter] = {}
        self._handler: Callable[[Message], Coroutine[Any, Any, str]] | None = None
        self._mirror = MessageMirror()
        self._pairing = PairingAuth()
        self._mirror.set_send_function(self._mirror_send)

    @property
    def mirror(self) -> MessageMirror:
        return self._mirror

    @property
    def pairing(self) -> PairingAuth:
        return self._pairing

    async def _mirror_send(self, target_chat: str, content: str) -> bool:
        """镜像发送回调（供 MessageMirror.set_send_function 使用）。

        target_chat 格式为 ``platform#chat_id``：
          - 按 platform 在已注册适配器中查找（注册名应与 adapter.name 一致）；
          - 找到则调用其 ``send_message(chat_id, content)``；
          - 未找到匹配适配器时返回 False 并记录告警，不抛异常。

        MirrorRule 的 target_chats 形如 ``["matrix#general", "whatsapp#team"]``，
        因此用 '#' 前的 platform 段定位适配器，'#' 后的段作为目标会话。
        """
        if "#" in target_chat:
            platform, chat_id = target_chat.split("#", 1)
        else:
            platform, chat_id = "", target_chat

        adapter = self._adapters.get(platform) if platform else None
        if adapter is None and platform:
            # 退化匹配：名称包含 platform 段者优先
            for name, ad in self._adapters.items():
                if platform in name:
                    adapter = ad
                    break

        if adapter is None:
            log.warning("镜像目标无匹配适配器", target=target_chat, platform=platform)
            return False

        try:
            return await adapter.send_message(chat_id, content)
        except Exception as e:
            log.error("镜像发送失败", target=target_chat, error=str(e))
            return False

    def set_handler(
        self, handler: Callable[[Message], Coroutine[Any, Any, str]]
    ) -> None:
        """设置消息处理回调。

        回调接收 Message 并返回处理结果文本。
        通常设置为 AgentEngine.process_input 的包装。

        Args:
            handler: 异步处理函数，签名 async (Message) -> str。
        """
        self._handler = handler

    def register_adapter(self, name: str, adapter: PlatformAdapter) -> None:
        """注册平台适配器。

        若同名适配器已存在，先调用其 stop() 方法停止旧实例。

        Args:
            name: 适配器注册名称，需与 adapter.name 一致。
            adapter: PlatformAdapter 实例。
        """
        if name in self._adapters:
            log.warning("覆盖已有适配器", name=name)
            # 同步调用 stop 可能不安全，但注册通常在启动前完成
            try:
                asyncio.get_event_loop().create_task(self._adapters[name].stop())
            except RuntimeError as _exc:
                log_ignored(log, "dispatcher.MessageDispatcher.register_adapter", _exc)
        self._adapters[name] = adapter
        log.info("适配器已注册", name=name, adapter_type=type(adapter).__name__)

    def unregister_adapter(self, name: str) -> None:
        """注销平台适配器。

        Args:
            name: 要注销的适配器名称。
        """
        adapter = self._adapters.pop(name, None)
        if adapter is not None:
            try:
                asyncio.get_event_loop().create_task(adapter.stop())
            except RuntimeError as _exc:
                log_ignored(log, "dispatcher.MessageDispatcher.unregister_adapter", _exc)
            log.info("适配器已注销", name=name)
        else:
            log.warning("注销不存在的适配器", name=name)

    async def dispatch(self, message: Message) -> str:
        """将入站消息路由到处理回调。

        若未设置 handler，返回默认提示文本。

        Args:
            message: 入站统一消息对象。

        Returns:
            str: 处理结果文本。

        Raises:
            RuntimeError: 处理回调抛出异常时，捕获并返回错误信息。
        """
        log.info(
            "消息分发",
            platform=message.platform,
            sender=message.sender,
            content_len=len(message.content),
        )
        if self._handler is None:
            log.warning("未设置消息处理回调，消息被丢弃")
            return "[gateway] 未设置消息处理回调"
        try:
            result = await self._handler(message)
            return result
        except Exception as e:
            log.error("消息处理失败", error=str(e), platform=message.platform)
            return f"[gateway] 消息处理失败: {e}"

    async def broadcast(self, text: str) -> dict[str, bool]:
        """向所有已注册平台广播消息。

        对每个适配器尝试发送广播消息到默认会话。
        某些适配器可能不支持默认会话，此时 send_message 返回 False。

        Args:
            text: 要广播的文本内容。

        Returns:
            dict[str, bool]: 各适配器的发送结果，key 为适配器名称，value 为是否成功。
        """
        results: dict[str, bool] = {}
        for name, adapter in self._adapters.items():
            try:
                connected = await adapter.is_connected()
                if not connected:
                    log.warning("适配器未连接，跳过广播", name=name)
                    results[name] = False
                    continue
                # 广播使用空字符串作为 chat_id，适配器自行决定默认目标
                ok = await adapter.send_message("", text)
                results[name] = ok
            except Exception as e:
                log.error("广播失败", name=name, error=str(e))
                results[name] = False
        return results

    def get_adapter(self, name: str) -> PlatformAdapter | None:
        """按名称获取已注册的适配器。

        Args:
            name: 适配器注册名称。

        Returns:
            PlatformAdapter | None: 适配器实例，不存在则返回 None。
        """
        return self._adapters.get(name)

    def list_adapters(self) -> list[str]:
        """列出所有已注册适配器的名称。

        Returns:
            list[str]: 适配器名称列表。
        """
        return list(self._adapters.keys())

    async def start_consuming(self) -> None:
        """A-02: 启动消费循环——从所有适配器的 receive_message() 读取消息并 dispatch。

        每个适配器启动一个独立的消费协程，将入站消息路由到 handler。
        必须在 set_handler() 之后调用，否则消息被丢弃。
        """
        if self._handler is None:
            log.warning("start_consuming called but no handler set; messages will be dropped")

        for name, adapter in self._adapters.items():
            try:
                connected = await adapter.is_connected()
                if not connected:
                    await adapter.start()
            except Exception as exc:
                log.warning("适配器启动失败，跳过消费", name=name, error=str(exc))
                continue

            asyncio.create_task(self._consume_adapter(name, adapter))
            log.info("适配器消费循环已启动", name=name)

    async def _consume_adapter(self, name: str, adapter: PlatformAdapter) -> None:
        """A-02: 单个适配器的消费循环。"""
        try:
            async for message in adapter.receive_message():
                try:
                    result = await self.dispatch(message)
                    if result and hasattr(adapter, "send_message"):
                        try:
                            await adapter.send_message(message.chat_id, result)
                        except Exception as _exc:
                            log_ignored(log, "dispatcher.MessageDispatcher._consume_adapter", _exc)
                except Exception as exc:
                    log.error("消费循环处理消息失败", adapter=name, error=str(exc))
        except asyncio.CancelledError:
            log.info("适配器消费循环被取消", adapter=name)
        except Exception as exc:
            log.error("适配器消费循环异常退出", adapter=name, error=str(exc))
