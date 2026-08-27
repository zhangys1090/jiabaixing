"""MCP 传输层 — STDIO 与 HTTP/SSE 双通道抽象.

遵循 AGENTS.md: MCP 协议主实现端为 Python，与 agent/llm/transports.py 对称。
修正 TS 侧 SSE 8 个 bug（详见 _parse_sse_line/_dispatch_event 内注释）。
"""

from __future__ import annotations

import asyncio
import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable
from urllib.parse import urljoin

import httpx

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("mcp.transport")

DEFAULT_REQUEST_TIMEOUT: float = 30.0  # 默认请求超时（秒）


class MCPTransportType(str, Enum):
    """MCP 传输层类型枚举. STDIO=子进程+行分隔; HTTP_SSE=httpx+SSE 流."""

    STDIO = "stdio"
    HTTP_SSE = "http+sse"


@dataclass
class MCPTransportConfig:
    """MCP 传输层配置.

    Attributes:
        command: STDIO 模式可执行命令.
        args: STDIO 模式命令参数.
        env: STDIO 模式环境变量.
        url: HTTP/SSE 模式 SSE 端点 URL.
        headers: HTTP/SSE 模式额外请求头.
        timeout: 请求超时（秒）.
    """

    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] | None = None
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    timeout: float = DEFAULT_REQUEST_TIMEOUT


class BaseMCPTransport(ABC):
    """MCP 传输层抽象基类，定义统一接口.

    Attributes:
        _config: 传输层配置.
        _message_id: 自增消息 ID 计数器.
        _pending: 等待响应的 future 映射.
        _notification_handlers: 通知处理器映射.
        _request_handlers: Server→Client 请求处理器映射（P3-#2）.
    """

    def __init__(self, config: MCPTransportConfig) -> None:
        self._config = config
        self._message_id: int = 0
        self._pending: dict[int | str, asyncio.Future[dict]] = {}
        self._notification_handlers: dict[str, Callable[[dict], None]] = {}
        # P3-#2: Server→Client 请求处理器（如 sampling/createMessage）
        self._request_handlers: dict[str, Callable[[dict], None]] = {}

    @property
    def is_running(self) -> bool:
        """传输层是否运行中（子类覆写）."""
        return False

    @abstractmethod
    async def start(self) -> None:
        """启动传输层. Raises: RuntimeError: 启动失败."""

    @abstractmethod
    async def stop(self) -> None:
        """停止传输层，释放资源."""

    @abstractmethod
    async def send_request(self, method: str, params: Any = None) -> dict:
        """发送 JSON-RPC 请求并等待响应.

        Args:
            method: JSON-RPC 方法名.
            params: 请求参数.
        Returns:
            dict: 完整 JSON-RPC 响应.
        Raises:
            RuntimeError: 未启动或通信失败.
            TimeoutError: 请求超时.
        """

    @abstractmethod
    def send_notification(self, method: str, params: Any = None) -> None:
        """发送 JSON-RPC 通知（无 id，不等待响应）.

        Args:
            method: JSON-RPC 方法名.
            params: 通知参数.
        """

    def send_response(
        self,
        msg_id: int | str,
        result: Any = None,
        error: dict | None = None,
    ) -> None:
        """发送 JSON-RPC 响应（用于 Server→Client 请求的回包）.

        默认实现为 no-op，子类应覆写以提供具体发送逻辑。

        Args:
            msg_id: 服务器请求的 id.
            result: 成功结果（与 error 互斥）.
            error: 错误对象（与 result 互斥）.
        """
        log.warning("BaseMCPTransport.send_response 未被子类覆写")

    def on_notification(self, method: str, handler: Callable[[dict], None]) -> None:
        """注册通知处理器. Args: method: 方法名; handler: 回调函数."""
        self._notification_handlers[method] = handler

    def on_request(self, method: str, handler: Callable[[dict], None]) -> None:
        """注册 Server→Client 请求处理器（P3-#2）.

        用于处理服务器主动向 Client 发起的 JSON-RPC 请求（如
        sampling/createMessage），与 on_notification 区别在于：请求
        携带 id，处理器需通过 send_response 回送响应。

        Args:
            method: JSON-RPC 方法名（如 "sampling/createMessage"）.
            handler: 回调函数，签名为 ``(message: dict) -> None``，
                传入完整 JSON-RPC 消息（含 id/params）.
        """
        self._request_handlers[method] = handler

    def _reject_all_pending(self, reason: str) -> None:
        """拒绝所有等待中的 future（连接关闭时调用）."""
        for future in self._pending.values():
            if not future.done():
                future.set_exception(RuntimeError(reason))
        self._pending.clear()

    def _handle_jsonrpc_message(self, message: dict) -> None:
        """处理收到的 JSON-RPC 消息（响应/通知/Server→Client 请求）.

        分三类：
        1. 响应：含 id 且含 result/error —— 完成 pending future.
        2. Server→Client 请求：含 id 且含 method（无 result/error）
           —— 分发到 ``_request_handlers``.
        3. 通知：仅含 method（无 id） —— 分发到 ``_notification_handlers``.
        """
        if "id" in message and ("result" in message or "error" in message):
            msg_id = message["id"]
            future = self._pending.pop(msg_id, None)
            if future and not future.done():
                if message.get("error"):
                    err = message["error"]
                    future.set_exception(
                        RuntimeError(f"MCP错误 {err.get('code')}: {err.get('message')}")
                    )
                else:
                    future.set_result(message)
        elif "id" in message and "method" in message:
            # P3-#2: Server→Client 请求（如 sampling/createMessage）
            handler = self._request_handlers.get(message["method"])
            if handler:
                try:
                    handler(message)
                except Exception as e:
                    log.error(f"Server→Client 请求处理失败 [{message['method']}]: {e}")
        elif "method" in message:
            handler = self._notification_handlers.get(message["method"])
            if handler:
                try:
                    handler(message.get("params", {}))
                except Exception as e:
                    log.error(f"通知处理失败 [{message['method']}]: {e}")


class StdioMCPTransport(BaseMCPTransport):
    """STDIO 传输层 — 子进程 + 行分隔 JSON-RPC.

    复用 server_manager.py stdio 逻辑: stdin 写 JSON-RPC+\\n, stdout 按行读取.

    Attributes:
        _process: 子进程实例.
        _stdout_task: stdout 读取协程.
        _stderr_task: stderr 读取协程.
    """

    def __init__(self, config: MCPTransportConfig) -> None:
        super().__init__(config)
        self._process: asyncio.subprocess.Process | None = None
        self._stdout_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def start(self) -> None:
        """启动子进程，建立 stdin/stdout 管道. Raises: RuntimeError: 启动失败."""
        process_env = dict(os.environ)
        if self._config.env:
            process_env.update(self._config.env)
        self._process = await asyncio.create_subprocess_exec(
            self._config.command, *self._config.args,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=process_env,
        )
        self._stdout_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        log.info(f"StdioMCPTransport 已启动 (PID: {self._process.pid})")

    async def stop(self) -> None:
        """停止子进程，清理资源."""
        if self._process:
            try:
                self._process.stdin.close()
            except Exception as _exc:
                log.debug("transport 异常处理", error=str(_exc))
                log_ignored(log, "transport.StdioMCPTransport.stop", _exc)
            try:
                self._process.kill()
            except Exception as _exc:
                log.debug("transport 异常处理", error=str(_exc))
                log_ignored(log, "transport.StdioMCPTransport.stop", _exc)
            self._process = None
        for task in (self._stdout_task, self._stderr_task):
            if task and not task.done():
                task.cancel()
        self._stdout_task = None
        self._stderr_task = None
        self._reject_all_pending("StdioMCPTransport 已关闭")

    async def send_request(self, method: str, params: Any = None) -> dict:
        """发送 JSON-RPC 请求到子进程 stdin，等待 stdout 响应.

        Args:
            method: JSON-RPC 方法名.
            params: 请求参数.
        Returns:
            dict: 完整 JSON-RPC 响应.
        Raises:
            RuntimeError: 未启动或写入失败.
            TimeoutError: 请求超时.
        """
        if not self._process or not self._process.stdin:
            raise RuntimeError("StdioMCPTransport 未启动")
        self._message_id += 1
        msg_id = self._message_id
        message = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
        future: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[msg_id] = future
        json_str = json.dumps(message, ensure_ascii=False) + "\n"
        try:
            self._process.stdin.write(json_str.encode("utf-8"))
        except Exception as e:
            log.debug("transport 异常处理", error=str(e))
            self._pending.pop(msg_id, None)
            raise RuntimeError(f"StdioMCPTransport 写入失败: {e}")
        try:
            return await asyncio.wait_for(future, timeout=self._config.timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise TimeoutError(f"StdioMCPTransport 请求超时: {method} (id={msg_id})")

    def send_notification(self, method: str, params: Any = None) -> None:
        """发送 JSON-RPC 通知到子进程 stdin（不等待响应）."""
        if not self._process or not self._process.stdin:
            log.warning("StdioMCPTransport 未启动，无法发送通知")
            return
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        json_str = json.dumps(message, ensure_ascii=False) + "\n"
        try:
            self._process.stdin.write(json_str.encode("utf-8"))
        except Exception as e:
            log.error(f"StdioMCPTransport 通知发送失败: {e}")

    def send_response(
        self,
        msg_id: int | str,
        result: Any = None,
        error: dict | None = None,
    ) -> None:
        """向子进程 stdin 写入 JSON-RPC 响应（用于 Server→Client 请求）.

        Args:
            msg_id: 服务器请求的 id.
            result: 成功结果（与 error 互斥）.
            error: 错误对象（与 result 互斥）.
        """
        if not self._process or not self._process.stdin:
            log.warning("StdioMCPTransport 未启动，无法发送响应")
            return
        response: dict[str, Any] = {"jsonrpc": "2.0", "id": msg_id}
        if error is not None:
            response["error"] = error
        else:
            response["result"] = result
        json_str = json.dumps(response, ensure_ascii=False) + "\n"
        try:
            self._process.stdin.write(json_str.encode("utf-8"))
        except Exception as e:
            log.error(f"StdioMCPTransport 响应发送失败: {e}")

    async def _read_stdout(self) -> None:
        """从子进程 stdout 按行读取 JSON-RPC 消息."""
        assert self._process and self._process.stdout
        while True:
            try:
                line = await self._process.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    self._handle_jsonrpc_message(json.loads(text))
                except json.JSONDecodeError as _exc:
                    log_ignored(log, "transport.StdioMCPTransport._read_stdout", _exc)
            except Exception as _exc:
                log.debug("transport 异常处理", error=str(_exc))
                break

    async def _read_stderr(self) -> None:
        """从子进程 stderr 读取日志信息."""
        assert self._process and self._process.stderr
        while True:
            try:
                line = await self._process.stderr.readline()
                if not line:
                    break
                msg = line.decode("utf-8", errors="replace").strip()
                if msg:
                    log.debug(f"StdioMCPTransport stderr: {msg[:200]}")
            except Exception as _exc:
                log.debug("transport 异常处理", error=str(_exc))
                break


class HttpSseMCPTransport(BaseMCPTransport):
    """HTTP/SSE 传输层 — httpx.AsyncClient + Server-Sent Events 流.

    修正 TS 侧 SSE 实现的全部 8 个 bug，提供正确的 SSE 状态机:
    event:/data:/空行 三状态转移；endpoint 事件提取 POST URL；多行 data 用
    \\n 拼接；httpx.Timeout(read=None) 避免误杀 SSE 长连接。

    Attributes:
        _client: httpx.AsyncClient 实例（惰性创建）.
        _sse_endpoint: 从 endpoint 事件提取的 POST URL.
        _sse_task: SSE 流消费协程.
        _buffer: SSE 原始数据缓冲区.
        _event_type: 当前事件类型（状态机状态）.
        _data_lines: 当前事件的 data 行累积.
    """

    def __init__(self, config: MCPTransportConfig) -> None:
        super().__init__(config)
        self._client: httpx.AsyncClient | None = None
        self._sse_endpoint: str = ""
        self._sse_task: asyncio.Task | None = None
        self._buffer: str = ""
        self._event_type: str = ""
        self._data_lines: list[str] = []
        self._MAX_DATA_LINES = 10000

    @property
    def is_running(self) -> bool:
        return self._client is not None and not self._client.is_closed

    async def _ensure_client(self) -> httpx.AsyncClient:
        """惰性创建 httpx.AsyncClient，配置 SSE 友好的超时.

        Returns:
            httpx.AsyncClient: 客户端实例.
        """
        if self._client is None or self._client.is_closed:
            # 修正 TS bug #7: read=None 避免 SSE 长连接被误杀
            timeout = httpx.Timeout(
                read=None,
                write=self._config.timeout,
                connect=self._config.timeout,
                pool=self._config.timeout,
            )
            self._client = httpx.AsyncClient(timeout=timeout)
        return self._client

    async def start(self) -> None:
        """启动 HTTP/SSE 传输层: 创建客户端并开始消费 SSE 流.

        Raises:
            RuntimeError: 配置 URL 为空.
        """
        if not self._config.url:
            raise RuntimeError("HttpSseMCPTransport 配置 url 不能为空")
        await self._ensure_client()
        self._sse_task = asyncio.create_task(self._consume_sse_stream())
        log.info(f"HttpSseMCPTransport 已启动: {self._config.url}")

    async def stop(self) -> None:
        """停止传输层: 取消 SSE 流任务并关闭客户端."""
        if self._sse_task and not self._sse_task.done():
            self._sse_task.cancel()
            try:
                await self._sse_task
            except asyncio.CancelledError as _exc:
                log_ignored(log, "transport.HttpSseMCPTransport.stop", _exc)
        self._sse_task = None
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        self._client = None
        self._reject_all_pending("HttpSseMCPTransport 已关闭")

    async def send_request(self, method: str, params: Any = None) -> dict:
        """发送 JSON-RPC 请求: POST 到 _sse_endpoint，等待 SSE 流推送响应.

        Args:
            method: JSON-RPC 方法名.
            params: 请求参数.
        Returns:
            dict: 完整的 JSON-RPC 响应.
        Raises:
            RuntimeError: SSE 端点未就绪或 POST 失败.
            TimeoutError: 请求超时.
        """
        if not self._sse_endpoint:
            raise RuntimeError("HttpSseMCPTransport 的 SSE 端点尚未就绪")
        client = await self._ensure_client()
        self._message_id += 1
        msg_id = self._message_id
        message = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
        future: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[msg_id] = future
        try:
            # 修正 TS bug #3: POST 到 _sse_endpoint 而非 config.url
            response = await client.post(self._sse_endpoint, json=message)
            if response.status_code >= 400:
                self._pending.pop(msg_id, None)
                raise RuntimeError(f"HttpSseMCPTransport POST 失败: {response.status_code}")
        except httpx.HTTPError as e:
            self._pending.pop(msg_id, None)
            raise RuntimeError(f"HttpSseMCPTransport 通信失败: {e}")
        try:
            return await asyncio.wait_for(future, timeout=self._config.timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise TimeoutError(f"HttpSseMCPTransport 请求超时: {method} (id={msg_id})")

    def send_notification(self, method: str, params: Any = None) -> None:
        """发送 JSON-RPC 通知: POST 到 _sse_endpoint（不等待响应）."""
        if not self._sse_endpoint:
            log.warning("HttpSseMCPTransport 的 SSE 端点尚未就绪，无法发送通知")
            return
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        asyncio.create_task(self._post_notification(message))

    def send_response(
        self,
        msg_id: int | str,
        result: Any = None,
        error: dict | None = None,
    ) -> None:
        """向 _sse_endpoint POST JSON-RPC 响应（用于 Server→Client 请求）.

        Args:
            msg_id: 服务器请求的 id.
            result: 成功结果（与 error 互斥）.
            error: 错误对象（与 result 互斥）.
        """
        if not self._sse_endpoint:
            log.warning("HttpSseMCPTransport 的 SSE 端点尚未就绪，无法发送响应")
            return
        response: dict[str, Any] = {"jsonrpc": "2.0", "id": msg_id}
        if error is not None:
            response["error"] = error
        else:
            response["result"] = result
        asyncio.create_task(self._post_notification(response))

    async def _post_notification(self, message: dict) -> None:
        """异步发送通知 POST 请求."""
        try:
            client = await self._ensure_client()
            await client.post(self._sse_endpoint, json=message)
        except Exception as e:
            log.error(f"HttpSseMCPTransport 通知发送失败: {e}")

    async def _consume_sse_stream(self) -> None:
        """消费 SSE 流: GET config.url 并逐行解析事件."""
        client = await self._ensure_client()
        try:
            async with client.stream("GET", self._config.url) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    self._parse_sse_line(line)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.error(f"HttpSseMCPTransport SSE 流中断: {e}")
            self._reject_all_pending("SSE 流连接中断")

    def _feed_raw(self, chunk: str) -> None:
        """喂入原始 SSE 数据块（测试用）. 按 \\n 分割为完整行."""
        self._buffer += chunk
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self._parse_sse_line(line)

    def _parse_sse_line(self, line: str) -> None:
        """解析单行 SSE 数据，驱动状态机.

        状态转移: event: → _event_type; data: → _data_lines; 空行 → 分发重置;
        : 开头 → 注释. 修正 TS bug #5: \\r 统一去除.
        """
        line = line.rstrip("\r")  # 修正 TS bug #5: 去除 \r\n 中的 \r 残留
        if line == "":
            self._dispatch_event()
            return
        if line.startswith(":"):
            return  # SSE 注释
        if ":" in line:
            field, _, value = line.partition(":")
            if value.startswith(" "):
                value = value[1:]  # SSE 规范: 去除一个前导空格
        else:
            field = line
            value = ""
        if field == "event":
            self._event_type = value
        elif field == "data":
            self._data_lines.append(value)

    def _dispatch_event(self) -> None:
        """分发当前累积的 SSE 事件并重置状态.

        - endpoint 事件: 提取 POST URL 存入 _sse_endpoint（修正 TS bug #1, #3）
        - message 事件: 多行 data 用 \\n 拼接后解析 JSON（修正 TS bug #2）
        """
        if not self._event_type and not self._data_lines:
            return
        data = "\n".join(self._data_lines)  # 修正 TS bug #2: 多行 data 拼接
        event_type = self._event_type or "message"
        if event_type == "endpoint":
            self._sse_endpoint = self._resolve_url(data)  # 修正 TS bug #1, #3
            log.debug(f"HttpSseMCPTransport 提取 SSE 端点: {self._sse_endpoint}")
        elif event_type == "message":
            self._handle_sse_message(data)
        self._event_type = ""
        self._data_lines = []

    def _resolve_url(self, path: str) -> str:
        """将 endpoint 数据解析为完整 URL（相对路径用 urljoin 拼接）."""
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return urljoin(self._config.url, path)

    def _handle_sse_message(self, data: str) -> None:
        """处理 SSE message 事件: 解析 JSON 并分发到 future 或通知处理器."""
        try:
            message = json.loads(data)
        except json.JSONDecodeError as e:
            log.error(f"HttpSseMCPTransport JSON 解析失败: {e}")
            return
        self._handle_jsonrpc_message(message)


_TRANSPORT_REGISTRY: dict[MCPTransportType, type[BaseMCPTransport]] = {
    MCPTransportType.STDIO: StdioMCPTransport,
    MCPTransportType.HTTP_SSE: HttpSseMCPTransport,
}


class MCPTransportFactory:
    """MCP 传输层工厂 — 根据类型创建对应的传输实例."""

    @staticmethod
    def create(config: MCPTransportConfig, transport_type: MCPTransportType | str) -> BaseMCPTransport:
        """创建传输层实例. Raises: ValueError: 未知的传输类型."""
        if isinstance(transport_type, str):
            try:
                transport_type = MCPTransportType(transport_type)
            except ValueError:
                raise ValueError(f"未知的 MCP 传输类型: {transport_type}")
        cls = _TRANSPORT_REGISTRY.get(transport_type)
        if cls is None:
            raise ValueError(f"未知的 MCP 传输类型: {transport_type}")
        return cls(config)
