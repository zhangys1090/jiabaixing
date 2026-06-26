from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("batch_processor")


@dataclass
class BatchConfig:
    """批处理配置。

    Attributes:
        concurrency: 并发数。
        timeout: 单个任务超时（秒）。
        output_format: 输出格式（sharegpt/jsonl）。
        continue_on_error: 遇到错误是否继续处理下一个。
    """

    concurrency: int = 3
    timeout: float = 30.0
    output_format: str = "sharegpt"
    continue_on_error: bool = True


@dataclass
class BatchPrompt:
    """批处理提示条。

    Attributes:
        id: 唯一标识。
        text: 提示文本。
        system_prompt: 系统提示。
        metadata: 附加元数据。
    """

    id: str
    text: str
    system_prompt: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class BatchItemResult:
    """批处理单个任务结果。

    Attributes:
        id: 任务ID。
        response: 响应文本。
        success: 是否成功。
        duration: 耗时（秒）。
        error: 错误信息。
        metadata: 附加元数据。
    """

    id: str
    response: str = ""
    success: bool = False
    duration: float = 0.0
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ShareGPTConversation:
    """ShareGPT格式对话。

    Attributes:
        conversations: 对话轮次列表，每轮包含from/value。
    """

    conversations: list[dict[str, str]] = field(default_factory=list)


class BatchProcessor:
    """批处理引擎——并行执行任务，支持超时控制和错误处理。

    使用信号量控制并发数，支持ShareGPT和JSONL两种输出格式。

    Usage:
        config = BatchConfig(concurrency=5, timeout=30, output_format="jsonl")
        processor = BatchProcessor(config)
        prompts = [BatchPrompt(id="1", text="..."), BatchPrompt(id="2", text="...")]
        results = await processor.run(prompts, my_executor)
    """
    def __init__(self, config: BatchConfig | None = None) -> None:
        self._config = config or BatchConfig()

    @property
    def config(self) -> BatchConfig:
        return self._config

    async def run(
        self,
        prompts: list[BatchPrompt],
        executor,
    ) -> list[BatchItemResult]:
        if not prompts:
            return []

        results: list[BatchItemResult] = []
        queue = list(prompts)
        running = 0
        done_event = asyncio.Event()

        log.info(f"批处理启动: {len(prompts)} 个任务, 并发数 {self._config.concurrency}")

        async def try_next() -> None:
            nonlocal running

            if not queue and running == 0:
                success_count = sum(1 for r in results if r.success)
                log.info(f"批处理完成: {success_count}/{len(results)} 成功")
                done_event.set()
                return

            while running < self._config.concurrency and queue:
                prompt = queue.pop(0)
                running += 1

                async def execute_one(p: BatchPrompt) -> None:
                    nonlocal running
                    import time
                    start = time.monotonic()
                    try:
                        result = await asyncio.wait_for(
                            executor(p),
                            timeout=self._config.timeout,
                        )
                        result.duration = time.monotonic() - start
                        results.append(result)
                    except asyncio.TimeoutError:
                        results.append(BatchItemResult(
                            id=p.id,
                            success=False,
                            error="执行超时",
                            duration=self._config.timeout,
                        ))
                    except Exception as err:
                        results.append(BatchItemResult(
                            id=p.id,
                            success=False,
                            error=str(err),
                            duration=time.monotonic() - start,
                        ))
                    finally:
                        running -= 1
                        await try_next()

                asyncio.create_task(execute_one(prompt))

        await try_next()
        await done_event.wait()
        return results

    def to_sharegpt(self, results: list[BatchItemResult]) -> ShareGPTConversation:
        conversations: list[dict[str, str]] = []
        for r in results:
            conversations.append({"from": "human", "value": r.id})
            conversations.append({"from": "gpt", "value": r.response})
        return ShareGPTConversation(conversations=conversations)

    def to_jsonl(self, results: list[BatchItemResult]) -> str:
        lines = []
        for r in results:
            lines.append(json.dumps({
                "id": r.id,
                "response": r.response,
                "success": r.success,
            }, ensure_ascii=False))
        return "\n".join(lines)

    def get_config(self) -> BatchConfig:
        return self._config
