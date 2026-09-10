"""MCP Progress 原语 — 长任务进度通知.

遵循 MCP 规范（2024-11-05）的 notifications/progress 方法：
MCP Server 在执行长任务时通过该方法向 Client 推送进度更新，
由 Client 订阅者消费。

模块归属：Python 端（遵循 AGENTS.md §0.1 模块归属强制表 — MCP 协议
主实现端为 Python）。

参考：
- https://spec.modelcontextprotocol.io/specification/2024-11-05/#progress
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("mcp.progress")


class MCPProgressManager:
    """MCP Progress 原语管理器.

    实现 MCP 规范的 notifications/progress 方法：Server 在执行长任务时
    向 Client 发送进度更新，由本管理器分发给已注册的订阅者。

    设计要点：
    - 订阅者可为同步或异步函数，签名为
      ``async def handler(progress_token, progress, total, message) -> None``.
    - 通过 progress_token 关联同一长任务的多次进度更新.
    - 单个订阅者异常不影响其他订阅者.
    - 支持按 progress_token 过滤订阅者（可选）.

    Attributes:
        _subscribers: 订阅者列表，每项为 (handler, token_filter) 元组.
    """

    def __init__(self) -> None:
        self._subscribers: list[tuple[Callable, str | None]] = []
        self._MAX_SUBSCRIBERS = 100

    def subscribe(
        self,
        handler: Callable,
        progress_token: str | None = None,
    ) -> None:
        """注册进度订阅者.

        Args:
            handler: 进度处理函数，签名为
                ``(progress_token, progress, total, message)``.
                可为同步或异步函数.
            progress_token: 仅订阅该 token 的进度更新；为 None 表示订阅
                所有进度更新（默认）.
        """
        self._subscribers.append((handler, progress_token))
        if len(self._subscribers) > self._MAX_SUBSCRIBERS:
            self._subscribers = self._subscribers[-self._MAX_SUBSCRIBERS * 3 // 4:]
        log.debug(
            "注册进度订阅者",
            token_filter=progress_token,
            total=len(self._subscribers),
        )

    def unsubscribe(self, handler: Callable) -> bool:
        """取消注册进度订阅者.

        Args:
            handler: 之前注册的处理函数.

        Returns:
            bool: 成功取消返回 True；handler 未注册返回 False.
        """
        before = len(self._subscribers)
        self._subscribers = [
            (h, tok) for (h, tok) in self._subscribers if h is not handler
        ]
        removed = before - len(self._subscribers)
        if removed > 0:
            log.debug(
                "取消进度订阅者",
                removed=removed,
                remaining=len(self._subscribers),
            )
        return removed > 0

    def clear_subscribers(self) -> None:
        """清空所有订阅者（测试用）."""
        self._subscribers.clear()

    def get_subscriber_count(self) -> int:
        """返回当前订阅者数量."""
        return len(self._subscribers)

    async def send_progress(
        self,
        progress_token: str,
        progress: float,
        total: float | None = None,
        message: str | None = None,
    ) -> None:
        """发送进度通知到所有匹配的订阅者.

        遵循 MCP 规范的 notifications/progress 通知：将进度更新分发给所有
        匹配 progress_token 的订阅者。单个订阅者异常会被记录但不会中断
        其他订阅者的分发。

        Args:
            progress_token: 进度令牌，关联同一长任务的多次更新.
                对应 MCP 请求中 _meta.progressToken 字段.
            progress: 当前进度值（可为绝对值或百分比）.
            total: 总进度值（可选）；提供时 progress/total 为完成比例.
            message: 人类可读的进度描述（可选）.
        """
        if not progress_token:
            raise ValueError("progress_token 不能为空")

        log.debug(
            "分发 MCP 进度",
            token=progress_token,
            progress=progress,
            total=total,
        )

        for handler, token_filter in list(self._subscribers):
            # token 过滤：订阅者指定了 token_filter 时仅匹配相同 token
            if token_filter is not None and token_filter != progress_token:
                continue
            try:
                result = handler(progress_token, progress, total, message)
                if inspect.isawaitable(result):
                    await result
            except Exception as e:
                log.warning(
                    "MCP 进度订阅者处理失败",
                    token=progress_token,
                    error=str(e),
                )

    def build_notification(
        self,
        progress_token: str,
        progress: float,
        total: float | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        """构建 MCP notifications/progress 通知 JSON-RPC 载荷.

        供 MCPServerManager 在向 Client 转发进度时使用。

        Args:
            progress_token: 进度令牌.
            progress: 当前进度值.
            total: 总进度值（可选）.
            message: 进度描述（可选）.

        Returns:
            dict: 符合 MCP 规范的 JSON-RPC 通知:
                ``{"jsonrpc": "2.0", "method": "notifications/progress",
                   "params": {"progressToken": ..., "progress": ...,
                              "total": ..., "message": ...}}``.
        """
        if not progress_token:
            raise ValueError("progress_token 不能为空")
        params: dict[str, Any] = {
            "progressToken": progress_token,
            "progress": progress,
        }
        if total is not None:
            params["total"] = total
        if message is not None:
            params["message"] = message
        return {
            "jsonrpc": "2.0",
            "method": "notifications/progress",
            "params": params,
        }


__all__ = ["MCPProgressManager"]
