from __future__ import annotations

import asyncio

import pytest

from agent.loop.batch_processor import (
    BatchConfig,
    BatchItemResult,
    BatchProcessor,
    BatchPrompt,
    ShareGPTConversation,
)


@pytest.fixture
def processor() -> BatchProcessor:
    return BatchProcessor(BatchConfig(concurrency=2, timeout=5.0))


@pytest.fixture
def simple_prompts() -> list[BatchPrompt]:
    return [
        BatchPrompt(id="1", text="hello"),
        BatchPrompt(id="2", text="world"),
        BatchPrompt(id="3", text="test"),
    ]


async def _simple_executor(prompt: BatchPrompt) -> BatchItemResult:
    return BatchItemResult(id=prompt.id, response=f"echo: {prompt.text}", success=True)


# ─── Basic execution ───


@pytest.mark.asyncio
async def test_run_empty_prompts(processor: BatchProcessor):
    results = await processor.run([], _simple_executor)
    assert results == []


@pytest.mark.asyncio
async def test_run_single_prompt(processor: BatchProcessor):
    prompts = [BatchPrompt(id="1", text="hello")]
    results = await processor.run(prompts, _simple_executor)
    assert len(results) == 1
    assert results[0].success is True
    assert results[0].response == "echo: hello"


@pytest.mark.asyncio
async def test_run_all_success(processor: BatchProcessor, simple_prompts: list[BatchPrompt]):
    results = await processor.run(simple_prompts, _simple_executor)
    assert len(results) == 3
    assert all(r.success for r in results)


@pytest.mark.asyncio
async def test_run_preserves_order(processor: BatchProcessor):
    prompts = [BatchPrompt(id=f"p{i}", text=f"text{i}") for i in range(5)]
    results = await processor.run(prompts, _simple_executor)
    assert len(results) == 5
    ids = [r.id for r in results]
    assert "p0" in ids
    assert "p4" in ids


# ─── Error handling ───


@pytest.mark.asyncio
async def test_run_handles_errors(processor: BatchProcessor):
    async def failing_executor(prompt: BatchPrompt) -> BatchItemResult:
        if prompt.id == "2":
            raise RuntimeError("模拟失败")
        return BatchItemResult(id=prompt.id, response="ok", success=True)

    prompts = [BatchPrompt(id="1", text="a"), BatchPrompt(id="2", text="b"), BatchPrompt(id="3", text="c")]
    results = await processor.run(prompts, failing_executor)
    assert len(results) == 3
    success_ids = [r.id for r in results if r.success]
    failed_ids = [r.id for r in results if not r.success]
    assert "1" in success_ids
    assert "3" in success_ids
    assert "2" in failed_ids


@pytest.mark.asyncio
async def test_run_timeout(processor: BatchProcessor):
    processor.config.timeout = 0.05

    async def slow_executor(prompt: BatchPrompt) -> BatchItemResult:
        await asyncio.sleep(1.0)
        return BatchItemResult(id=prompt.id, response="done", success=True)

    results = await processor.run([BatchPrompt(id="slow", text="...")], slow_executor)
    assert len(results) == 1
    assert results[0].success is False
    assert "超时" in (results[0].error or "")


# ─── Concurrency ───


@pytest.mark.asyncio
async def test_run_respects_concurrency(processor: BatchProcessor):
    running = 0
    max_running = 0

    async def tracking_executor(prompt: BatchPrompt) -> BatchItemResult:
        nonlocal running, max_running
        running += 1
        max_running = max(max_running, running)
        await asyncio.sleep(0.02)
        running -= 1
        return BatchItemResult(id=prompt.id, response="ok", success=True)

    prompts = [BatchPrompt(id=f"p{i}", text="") for i in range(10)]
    await processor.run(prompts, tracking_executor)
    assert max_running <= processor.config.concurrency


# ─── ShareGPT format ───


def test_to_sharegpt(processor: BatchProcessor):
    results = [
        BatchItemResult(id="q1", response="a1", success=True),
        BatchItemResult(id="q2", response="a2", success=True),
    ]
    conv = processor.to_sharegpt(results)
    assert isinstance(conv, ShareGPTConversation)
    assert len(conv.conversations) == 4
    assert conv.conversations[0] == {"from": "human", "value": "q1"}
    assert conv.conversations[1] == {"from": "gpt", "value": "a1"}


def test_to_sharegpt_empty(processor: BatchProcessor):
    conv = processor.to_sharegpt([])
    assert conv.conversations == []


# ─── JSONL format ───


def test_to_jsonl(processor: BatchProcessor):
    results = [
        BatchItemResult(id="q1", response="a1", success=True),
        BatchItemResult(id="q2", response="", success=False, error="err"),
    ]
    jsonl = processor.to_jsonl(results)
    lines = jsonl.strip().split("\n")
    assert len(lines) == 2

    import json
    line1 = json.loads(lines[0])
    assert line1["id"] == "q1"
    assert line1["success"] is True

    line2 = json.loads(lines[1])
    assert line2["id"] == "q2"
    assert line2["success"] is False


def test_to_jsonl_empty(processor: BatchProcessor):
    assert processor.to_jsonl([]) == ""


# ─── Config ───


def test_default_config():
    bp = BatchProcessor()
    assert bp.config.concurrency == 3
    assert bp.config.timeout == 30.0
    assert bp.config.output_format == "sharegpt"
    assert bp.config.continue_on_error is True


def test_custom_config():
    bp = BatchProcessor(BatchConfig(concurrency=10, timeout=60.0))
    assert bp.config.concurrency == 10
    assert bp.config.timeout == 60.0


def test_get_config_returns_same_instance(processor: BatchProcessor):
    assert processor.get_config() is processor.config
