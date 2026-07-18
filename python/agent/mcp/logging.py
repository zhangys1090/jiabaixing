"""MCP Logging 原语 — Server 向 Client 发送日志通知.

遵循 MCP 规范（2024-11-05）的 notifications/message 方法：
MCP Server 通过该方法向 Client 推送 6 个级别的日志消息（debug/info/
notice/warning/error/critical），由 Client 订阅者消费。

模块归属：Python 端（遵循 AGENTS.md §0.1 模块归属强制表 — MCP 协议
主实现端为 Python）。

参考：
- https://spec.modelcontextprotocol.io/specification/2024-11-05/#logging
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("mcp.logging")

# MCP 规范定义的 6 个日志级别（自低至高）
LOG_LEVEL_DEBUG = "debug"
LOG_LEVEL_INFO = "info"
LOG_LEVEL_NOTICE = "notice"
LOG_LEVEL_WARNING = "warning"
LOG_LEVEL_ERROR = "error"
LOG_LEVEL_CRITICAL = "critical"

# 允许的日志级别集合
VALID_LOG_LEVELS = frozenset({
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_WARNING,
    LOG_LEVEL_ERROR,
    LOG_LEVEL_CRITICAL,
})

# 日志级别排序（用于级别过滤）
_LOG_LEVEL_ORDER: dict[str, int] = {
    LOG_LEVEL_DEBUG: 10,
    LOG_LEVEL_INFO: 20,
    LOG_LEVEL_NOTICE: 30,
    LOG_LEVEL_WARNING: 40,
    LOG_LEVEL_ERROR: 50,
    LOG_LEVEL_CRITICAL: 60,
}


class MCPLoggingManager:
    """MCP Logging 原语管理器.

    实现 MCP 规范的 notifications/message 方法：Server 向 Client 发送
    日志消息，由本管理器分发给已注册的订阅者。

    设计要点：
    - 支持 6 个日志级别：debug/info/notice/warning/error/critical.
    - 订阅者可为同步或异步函数，签名为
      ``async def handler(level: str, logger_name: str, data: Any) -> None``.
    - 支持最小级别过滤：仅分发给级别 ≥ subscriber.min_level 的订阅者.
    - 单个订阅者异常不影响其他订阅者.

    Attributes:
        _subscribers: 订阅者列表，每项为 (handler, min_level) 元组.
    """

    def __init__(self) -> None:
        self._subscribers: list[tuple[Callable, str]] = []

    def subscribe(
        self, handler: Callable, min_level: str = LOG_LEVEL_DEBUG
    ) -> None:
        """注册日志订阅者.

        Args:
            handler: 日志处理函数，签名为 ``(level, logger_name, data)``.
                可为同步或异步函数.
            min_level: 最小日志级别，低于此级别的消息不会分发给该订阅者.
                默认为 debug（接收所有级别）.

        Raises:
            ValueError: min_level 不在 VALID_LOG_LEVELS 中.
        """
        if min_level not in VALID_LOG_LEVELS:
            raise ValueError(
                f"非法日志级别: {min_level}，允许值: {sorted(VALID_LOG_LEVELS)}"
            )
        self._subscribers.append((handler, min_level))
        log.debug(
            "注册日志订阅者",
            min_level=min_level,
            total=len(self._subscribers),
        )

    def unsubscribe(self, handler: Callable) -> bool:
        """取消注册日志订阅者.

        Args:
            handler: 之前注册的处理函数.

        Returns:
            bool: 成功取消返回 True；handler 未注册返回 False.
        """
        before = len(self._subscribers)
        self._subscribers = [
            (h, lvl) for (h, lvl) in self._subscribers if h is not handler
        ]
        removed = before - len(self._subscribers)
        if removed > 0:
            log.debug("取消日志订阅者", removed=removed, remaining=len(self._subscribers))
        return removed > 0

    def clear_subscribers(self) -> None:
        """清空所有订阅者（测试用）."""
        self._subscribers.clear()

    def get_subscriber_count(self) -> int:
        """返回当前订阅者数量."""
        return len(self._subscribers)

    async def send_log(
        self,
        level: str,
        logger: str,
        data: Any,
    ) -> None:
        """发送日志通知到所有订阅者.

        遵循 MCP 规范的 notifications/message 通知：将日志分发给所有
        级别匹配的订阅者。单个订阅者异常会被记录但不会中断其他订阅者
        的分发。

        Args:
            level: 日志级别，必须为 VALID_LOG_LEVELS 中的一个.
            logger: 日志来源标识（通常为 server 名或 logger 名）.
            data: 日志数据，可为任意 JSON 可序列化对象.

        Raises:
            ValueError: level 不在 VALID_LOG_LEVELS 中.
        """
        if level not in VALID_LOG_LEVELS:
            raise ValueError(
                f"非法日志级别: {level}，允许值: {sorted(VALID_LOG_LEVELS)}"
            )

        # 内部日志记录（便于排查）
        log.debug("分发 MCP 日志", level=level, logger=logger)

        target_level_value = _LOG_LEVEL_ORDER[level]
        for handler, min_level in list(self._subscribers):
            min_level_value = _LOG_LEVEL_ORDER.get(min_level, 0)
            if target_level_value < min_level_value:
                continue  # 低于订阅者最小级别，跳过
            try:
                result = handler(level, logger, data)
                if inspect.isawaitable(result):
                    await result
            except Exception as e:
                # 单个订阅者异常不影响其他订阅者
                log.warning(
                    "MCP 日志订阅者处理失败",
                    level=level,
                    logger_name=logger,
                    error=str(e),
                )

    def build_notification(
        self,
        level: str,
        logger: str,
        data: Any,
    ) -> dict[str, Any]:
        """构建 MCP notifications/message 通知 JSON-RPC 载荷.

        供 MCPServerManager 在向 Client 转发日志时使用。

        Args:
            level: 日志级别.
            logger: 日志来源标识.
            data: 日志数据.

        Returns:
            dict: 符合 MCP 规范的 JSON-RPC 通知:
                ``{"jsonrpc": "2.0", "method": "notifications/message",
                   "params": {"level": ..., "logger": ..., "data": ...}}``.

        Raises:
            ValueError: level 不在 VALID_LOG_LEVELS 中.
        """
        if level not in VALID_LOG_LEVELS:
            raise ValueError(
                f"非法日志级别: {level}，允许值: {sorted(VALID_LOG_LEVELS)}"
            )
        return {
            "jsonrpc": "2.0",
            "method": "notifications/message",
            "params": {
                "level": level,
                "logger": logger,
                "data": data,
            },
        }


__all__ = [
    "MCPLoggingManager",
    "VALID_LOG_LEVELS",
    "LOG_LEVEL_DEBUG",
    "LOG_LEVEL_INFO",
    "LOG_LEVEL_NOTICE",
    "LOG_LEVEL_WARNING",
    "LOG_LEVEL_ERROR",
    "LOG_LEVEL_CRITICAL",
]
