from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Callable


CHUNK_SIZE = 6
CHUNK_DELAY_MS = 25


@dataclass
class StreamEvent:
    event_type: str
    trace_id: str
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0


StreamCallback = Callable[[StreamEvent], None]


class StreamResponseService:
    def __init__(
        self,
        chunk_size: int = CHUNK_SIZE,
        chunk_delay_ms: int = CHUNK_DELAY_MS,
    ) -> None:
        self._chunk_size = chunk_size
        self._chunk_delay_ms = chunk_delay_ms
        self._callbacks: list[StreamCallback] = []
        self._active_streams: dict[str, bool] = {}

    def on_event(self, callback: StreamCallback) -> None:
        self._callbacks.append(callback)

    def _emit(self, event: StreamEvent) -> None:
        for cb in self._callbacks:
            try:
                cb(event)
            except Exception:
                pass

    async def stream(self, full_text: str, trace_id: str) -> None:
        self._active_streams[trace_id] = True

        self._emit(StreamEvent(
            event_type="stream_start",
            trace_id=trace_id,
            data={"totalLength": len(full_text)},
            timestamp=time.time(),
        ))

        offset = 0
        while offset < len(full_text):
            if not self._active_streams.get(trace_id, False):
                break

            chunk = full_text[offset:offset + self._chunk_size]
            offset += self._chunk_size

            self._emit(StreamEvent(
                event_type="stream_chunk",
                trace_id=trace_id,
                data={"chunk": chunk, "offset": offset},
                timestamp=time.time(),
            ))

            await asyncio.sleep(self._chunk_delay_ms / 1000.0)

        self._emit(StreamEvent(
            event_type="stream_done",
            trace_id=trace_id,
            data={"fullText": full_text},
            timestamp=time.time(),
        ))

        self._active_streams.pop(trace_id, None)

    def cancel(self, trace_id: str) -> None:
        self._active_streams[trace_id] = False

    def is_streaming(self, trace_id: str) -> bool:
        return trace_id in self._active_streams

    def collect_chunks(self, trace_id: str) -> str:
        parts: list[str] = []
        collected_trace_id: list[str] = []

        def _collector(event: StreamEvent) -> None:
            if event.trace_id == trace_id:
                collected_trace_id.append(trace_id)
                if event.event_type == "stream_chunk":
                    parts.append(event.data.get("chunk", ""))
                elif event.event_type == "stream_done":
                    parts.append(event.data.get("fullText", ""))

        self.on_event(_collector)
        return "".join(parts)
