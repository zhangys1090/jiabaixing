from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine


class RequestQueue:
    def __init__(self, max_concurrent: int = 3) -> None:
        self._sem = asyncio.Semaphore(max_concurrent)
        self._pending: int = 0
        self._completed: int = 0

    async def submit(self, fn: Callable[..., Coroutine], *args: Any, **kwargs: Any) -> Any:
        async with self._sem:
            self._pending += 1
            try:
                result = await fn(*args, **kwargs)
                self._completed += 1
                return result
            finally:
                self._pending -= 1

    @property
    def pending(self) -> int:
        return self._pending

    @property
    def completed(self) -> int:
        return self._completed
