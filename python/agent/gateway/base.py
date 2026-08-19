"""消息平台网关基础定义。

定义了消息数据模型、平台适配器抽象基类和网关配置数据类，
是所有消息平台适配器的统一抽象层。

核心抽象:
    - Message: 跨平台统一消息数据模型
    - PlatformAdapter: 平台适配器抽象基类，定义标准接口
    - GatewayConfig: 网关运行配置
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncIterator


@dataclass
class Message:
    """跨平台统一消息数据模型。

    所有平台适配器接收到的消息都转换为此统一格式，
    便于下游 MessageDispatcher 无差别处理。

    Attributes:
        id: 消息唯一标识，默认自动生成 UUID4。
        platform: 来源平台名称（如 webhook、feishu、wechat、slack）。
        sender: 发送者标识（平台相关的用户 ID 或名称）。
        content: 消息文本内容。
        timestamp: 消息时间戳，默认当前时间。
        metadata: 平台特有的附加元数据（如飞书 app_id、Slack channel 等）。
    """

    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    platform: str = ""
    sender: str = ""
    content: str = ""
    timestamp: datetime = field(default_factory=datetime.now)
    metadata: dict[str, Any] = field(default_factory=dict)


class PlatformAdapter(ABC):
    """平台适配器抽象基类。

    定义所有消息平台适配器必须实现的标准接口，
    包括生命周期管理、消息收发和连接状态检查。

    子类需实现:
        - name: 返回平台名称
        - start(): 启动适配器
        - stop(): 停止适配器
        - send_message(): 发送消息
        - receive_message(): 接收消息流
        - is_connected(): 检查连接状态
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """返回平台适配器名称。

        Returns:
            str: 平台标识，如 "webhook"、"feishu"、"wechat"。
        """
        ...

    @abstractmethod
    async def start(self) -> None:
        """启动适配器，建立与消息平台的连接。

        Raises:
            ConnectionError: 连接失败时抛出。
        """
        ...

    @abstractmethod
    async def stop(self) -> None:
        """停止适配器，释放资源并断开连接。"""
        ...

    @abstractmethod
    async def send_message(self, chat_id: str, text: str) -> bool:
        """向指定会话发送文本消息。

        Args:
            chat_id: 目标会话标识（平台相关）。
            text: 要发送的文本内容。

        Returns:
            bool: 发送成功返回 True，失败返回 False。
        """
        ...

    @abstractmethod
    async def receive_message(self) -> AsyncIterator[Message]:
        """接收来自平台的消息流。

        返回异步迭代器，持续产出从平台接收到的消息。
        调用方通过 ``async for msg in adapter.receive_message()`` 消费。

        Yields:
            Message: 从平台接收到的统一消息对象。
        """
        ...

    @abstractmethod
    async def is_connected(self) -> bool:
        """检查适配器与平台的连接状态。

        Returns:
            bool: 已连接返回 True，否则返回 False。
        """
        ...

    @property
    def simulated(self) -> bool:
        """适配器是否处于模拟（未真实连接）模式。

        子类在进入模拟模式（缺凭证 / 缺 SDK 等无法真实连接）时，
        应调用 :meth:`_enter_simulated` 声明模拟态，而不是把
        ``_connected`` 谎报为 ``True``。默认 ``False``（真实连接模式）。
        """
        return getattr(self, "_simulated", False)

    @property
    def mode(self) -> str:
        """返回连接模式标签：``"real"`` 或 ``"simulated"``。"""
        return "simulated" if self.simulated else "real"

    def _enter_simulated(self) -> None:
        """声明进入模拟模式。

        模拟态意味着：既未真正连接平台，也不应被统计为「已连接」。
        子类在无法真实连接的降级分支调用本方法即可，无需各自重复赋值。
        """
        self._simulated = True
        self._connected = False


@dataclass
class GatewayConfig:
    """网关运行配置。

    控制网关服务器的监听地址、重连策略和平台适配器配置。

    Attributes:
        host: 监听地址，默认 "0.0.0.0"。
        port: 监听端口，默认 8765。
        max_retries: 最大重连次数，默认 3。
        reconnect_interval: 重连间隔秒数，默认 5.0。
        platforms: 各平台适配器的配置字典，key 为平台名称，value 为该平台特有配置。
    """

    host: str = "0.0.0.0"
    port: int = 8765
    max_retries: int = 3
    reconnect_interval: float = 5.0
    platforms: dict[str, dict[str, Any]] = field(default_factory=dict)
