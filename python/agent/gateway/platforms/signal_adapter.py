"""Signal 平台适配器。

通过 signal-cli REST API 接入 Signal：
  - 监听入站 Signal 消息
  - 支持私聊和群组消息
  - 端到端加密通信

集成示例::

    from agent.gateway.platforms.signal_adapter import SignalAdapter

    adapter = SignalAdapter(phone_number="+1234567890", api_url="http://localhost:8080")
    await adapter.start()
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, AsyncIterator

from agent.gateway.base import Message, PlatformAdapter
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("gateway.signal_adapter")


class SignalAdapter(PlatformAdapter):
    """Signal 平台适配器。

    通过 signal-cli-rest-api 接入 Signal 私信和群组。

    Attributes:
        _phone_number: Signal 注册手机号.
        _api_url: signal-cli REST API 地址.
        _queue: 入站消息队列.
        _connected: 连接状态.
    """

    def __init__(
        self,
        phone_number: str = "",
        api_url: str = "http://localhost:8080",
    ) -> None:
        self._phone_number = phone_number
        self._api_url = api_url.rstrip("/")
        self._queue: asyncio.Queue[Message] = asyncio.Queue()
        self._connected: bool = False
        self._poll_task: asyncio.Task | None = None

    @property
    def name(self) -> str:
        return "signal"

    async def start(self) -> None:
        if not self._phone_number:
            log.warning("Signal 手机号未配置，适配器以模拟模式运行（不会真实连接）")
            self._enter_simulated()
            return

        try:
            import httpx

            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(
                    f"{self._api_url}/v1/about",
                )
                if resp.status_code != 200:
                    raise ConnectionError(f"signal-cli API 不可用: {resp.status_code}")

            self._poll_task = asyncio.create_task(self._poll_messages())
            self._connected = True
            log.info("Signal 适配器已启动")
        except ImportError:
            log.warning("httpx 未安装，Signal 适配器以模拟模式运行（不会真实连接）")
            self._enter_simulated()
        except Exception as e:
            log.error("Signal 适配器启动失败", error=str(e))
            self._connected = False

    async def _poll_messages(self) -> None:
        try:
            import httpx

            async with httpx.AsyncClient(timeout=30.0) as client:
                while self._connected:
                    try:
                        resp = await client.get(
                            f"{self._api_url}/v1/receive/{self._phone_number}",
                        )
                        if resp.status_code == 200:
                            messages = resp.json()
                            for msg_data in messages if isinstance(messages, list) else [messages]:
                                await self._process_signal_message(msg_data)
                    except Exception as _exc:
                        log.debug("signal_adapter 异常处理", error=str(_exc))
                        log_ignored(log, "signal_adapter.SignalAdapter._poll_messages", _exc)
                    await asyncio.sleep(2)
        except asyncio.CancelledError as _exc:
            log_ignored(log, "signal_adapter.SignalAdapter._poll_messages", _exc)

    async def _process_signal_message(self, msg_data: dict) -> None:
        try:
            envelope = msg_data.get("envelope", {})
            source = envelope.get("source", "")
            source_number = envelope.get("sourceNumber", source)
            group_info = envelope.get("dataMessage", {}).get("groupInfo", {})
            chat_id = group_info.get("groupId", source_number) if group_info else source_number

            data_msg = envelope.get("dataMessage", {})
            content = data_msg.get("message", "")
            if not content:
                return

            msg = Message(
                id=str(uuid.uuid4()),
                platform="signal",
                chat_id=chat_id,
                sender=source_number,
                content=content,
                metadata={
                    "source": source,
                    "timestamp": data_msg.get("timestamp", 0),
                    "is_group": bool(group_info),
                    "group_id": group_info.get("groupId", ""),
                },
            )
            await self._queue.put(msg)
        except Exception as e:
            log.error("Signal 消息处理失败", error=str(e))

    async def stop(self) -> None:
        self._connected = False
        if self._poll_task:
            self._poll_task.cancel()
            self._poll_task = None
        log.info("Signal 适配器已停止")

    async def send_message(self, chat_id: str, text: str) -> bool:
        if not self._phone_number:
            # 诚实化：模拟态（未配置手机号 / 未安装 httpx）未真实发送
            log.warning("Signal 适配器未连接，消息未真实发送", chat_id=chat_id)
            return False

        try:
            import httpx

            payload = {
                "message": text,
                "account": self._phone_number,
            }

            if chat_id.startswith("+"):
                payload["recipient"] = chat_id
            else:
                payload["groupId"] = chat_id

            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{self._api_url}/v2/send",
                    json=payload,
                )
                return resp.status_code == 201
        except Exception as e:
            log.error("Signal 发送失败", chat_id=chat_id, error=str(e))
            return False

    async def receive_message(self) -> AsyncIterator[Message]:
        while self._connected:
            try:
                msg = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                yield msg
            except asyncio.TimeoutError:
                continue

    async def is_connected(self) -> bool:
        return self._connected
