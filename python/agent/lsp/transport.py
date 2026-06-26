from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("lsp.transport")


@dataclass
class JsonRpcRequest:
    id: int | str
    method: str
    params: Any = None
    jsonrpc: str = "2.0"


@dataclass
class JsonRpcNotification:
    method: str
    params: Any = None
    jsonrpc: str = "2.0"


@dataclass
class JsonRpcResponse:
    id: int | str
    result: Any = None
    error: dict | None = None
    jsonrpc: str = "2.0"


class LspTransport:
    def __init__(self, request_timeout: float = 30.0) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._message_id: int = 0
        self._pending: dict[int | str, asyncio.Future[Any]] = {}
        self._buffer: str = ""
        self._request_timeout: float = request_timeout
        self._notification_handlers: dict[str, Callable[[dict], None]] = {}
        self._on_error: Callable[[Exception], None] | None = None
        self._on_exit: Callable[[int | None], None] | None = None

    async def start(
        self,
        command: str,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        import os

        process_env = dict(os.environ)
        if env:
            process_env.update(env)

        self._process = await asyncio.create_subprocess_exec(
            command,
            *(args or []),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=process_env,
        )

        asyncio.create_task(self._read_stdout())
        asyncio.create_task(self._read_stderr())

    async def stop(self) -> None:
        if self._process:
            try:
                self._process.stdin.close()
            except Exception:
                pass
            try:
                self._process.kill()
            except Exception:
                pass
            self._process = None

        for future in self._pending.values():
            if not future.done():
                future.set_exception(RuntimeError("传输层已关闭"))
        self._pending.clear()

    async def send_request(self, method: str, params: Any = None) -> Any:
        if not self._process or not self._process.stdin:
            raise RuntimeError("传输层未启动")

        self._message_id += 1
        msg_id = self._message_id

        future: asyncio.Future[Any] = asyncio.get_event_loop().create_future()
        self._pending[msg_id] = future

        message = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "method": method,
            "params": params,
        }
        self._send_message(message)

        try:
            return await asyncio.wait_for(future, timeout=self._request_timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise TimeoutError(f"请求超时: {method} (id={msg_id})")

    def send_notification(self, method: str, params: Any = None) -> None:
        if not self._process or not self._process.stdin:
            log.warning("传输层未启动，无法发送通知")
            return

        message = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        self._send_message(message)

    def on_notification(self, method: str, handler: Callable[[dict], None]) -> None:
        self._notification_handlers[method] = handler

    def set_on_error(self, handler: Callable[[Exception], None]) -> None:
        self._on_error = handler

    def set_on_exit(self, handler: Callable[[int | None], None]) -> None:
        self._on_exit = handler

    def _send_message(self, message: dict) -> None:
        content = json.dumps(message, ensure_ascii=False)
        header = f"Content-Length: {len(content.encode('utf-8'))}\r\n\r\n"
        try:
            self._process.stdin.write((header + content).encode("utf-8"))
        except Exception as e:
            log.error(f"发送消息失败: {e}")

    async def _read_stdout(self) -> None:
        assert self._process and self._process.stdout
        while True:
            try:
                line = await self._process.stdout.readline()
                if not line:
                    break
                self._buffer += line.decode("utf-8", errors="replace")
                self._try_parse_messages()
            except Exception as e:
                log.error(f"读取stdout失败: {e}")
                if self._on_error:
                    self._on_error(e)
                break

    async def _read_stderr(self) -> None:
        assert self._process and self._process.stderr
        while True:
            try:
                line = await self._process.stderr.readline()
                if not line:
                    break
                log.debug(f"stderr: {line.decode('utf-8', errors='replace').strip()}")
            except Exception:
                break

    def _try_parse_messages(self) -> None:
        while True:
            header_end = self._buffer.find("\r\n\r\n")
            if header_end == -1:
                break

            header = self._buffer[:header_end]
            match = re.search(r"Content-Length:\s*(\d+)", header, re.IGNORECASE)
            if not match:
                self._buffer = self._buffer[header_end + 4:]
                continue

            content_length = int(match.group(1))
            body_start = header_end + 4
            body_end = body_start + content_length

            if len(self._buffer) < body_end:
                break

            body = self._buffer[body_start:body_end]
            self._buffer = self._buffer[body_end:]

            try:
                message = json.loads(body)
                self._handle_message(message)
            except json.JSONDecodeError as e:
                log.error(f"解析消息失败: {e}")

    def _handle_message(self, message: dict) -> None:
        if "id" in message and ("result" in message or "error" in message):
            msg_id = message["id"]
            future = self._pending.pop(msg_id, None)
            if future and not future.done():
                if message.get("error"):
                    err = message["error"]
                    future.set_exception(
                        RuntimeError(f"LSP错误 {err.get('code')}: {err.get('message')}")
                    )
                else:
                    future.set_result(message.get("result"))
        elif "method" in message:
            handler = self._notification_handlers.get(message["method"])
            if handler:
                try:
                    handler(message.get("params", {}))
                except Exception as e:
                    log.error(f"通知处理失败 [{message['method']}]: {e}")
