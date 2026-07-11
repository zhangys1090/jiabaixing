"""批量轨迹生成器。

批量生成执行轨迹（trajectory），用于训练数据、评估和回放：
  - 从历史会话批量提取轨迹
  - 支持多种输出格式（ShareGPT / JSONL / Alpaca）
  - 质量过滤（最低质量分、最短轮次等）
  - 去重与匿名化
  - 并行生成 + 进度回调

与 TrajectoryDB 的关系：
  - 从 TrajectoryDB 读取历史 ExecutionRecord
  - 转换为目标格式并写出
  - 可用于 fine-tune 数据准备

集成示例::

    from agent.persistence.batch_trajectory import BatchTrajectoryGenerator

    gen = BatchTrajectoryGenerator()
    result = await gen.generate(
        output_path="./training_data.jsonl",
        format="sharegpt",
        min_quality=0.7,
        limit=1000,
    )
    print(f"生成 {result.count} 条轨迹")
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Coroutine

from agent.core.logger import StructuredLogger

log = StructuredLogger("batch_trajectory")


@dataclass
class TrajectorySample:
    """单条轨迹样本。

    Attributes:
        id: 唯一标识。
        messages: 消息列表（role + content）。
        metadata: 附加元数据（质量分、轮次等）。
        quality: 综合质量评分。
        session_id: 来源会话 ID。
        created_at: 创建时间戳。
    """

    id: str = ""
    messages: list[dict[str, str]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    quality: float = 0.0
    session_id: str = ""
    created_at: int = 0


@dataclass
class BatchTrajectoryConfig:
    """批量轨迹生成配置。

    Attributes:
        format: 输出格式（sharegpt / jsonl / alpaca）。
        min_quality: 最低质量分过滤阈值。
        min_rounds: 最少对话轮次。
        limit: 最大生成数量。
        deduplicate: 是否去重。
        anonymize: 是否匿名化用户 ID。
        concurrency: 并发读取数。
        continue_on_error: 遇到错误是否继续。
    """

    format: str = "sharegpt"
    min_quality: float = 0.0
    min_rounds: int = 1
    limit: int = 1000
    deduplicate: bool = True
    anonymize: bool = True
    concurrency: int = 5
    continue_on_error: bool = True


@dataclass
class BatchTrajectoryResult:
    """批量轨迹生成结果。

    Attributes:
        count: 实际生成数量。
        skipped: 跳过数量（质量不足 / 去重）。
        errors: 错误数量。
        duration_ms: 总耗时（毫秒）。
        output_path: 输出文件路径。
    """

    count: int = 0
    skipped: int = 0
    errors: int = 0
    duration_ms: int = 0
    output_path: str = ""


class BatchTrajectoryGenerator:
    """批量轨迹生成器。

    从历史会话数据批量生成训练轨迹，支持质量过滤、去重和多种输出格式。
    """

    def __init__(self) -> None:
        self._seen_hashes: set[str] = set()
        self._progress_callback: Callable[[int, int], Coroutine[Any, Any, None]] | None = None

    def set_progress_callback(
        self, callback: Callable[[int, int], Coroutine[Any, Any, None]]
    ) -> None:
        """设置进度回调。

        Args:
            callback: 回调函数，参数为 (current, total)。
        """
        self._progress_callback = callback

    async def generate(
        self,
        output_path: str | Path,
        config: BatchTrajectoryConfig | None = None,
        records: list[Any] | None = None,
    ) -> BatchTrajectoryResult:
        """批量生成轨迹并写入文件。

        Args:
            output_path: 输出文件路径。
            config: 生成配置，默认使用 BatchTrajectoryConfig()。
            records: 可选的预加载记录列表，若为 None 则从 TrajectoryDB 读取。

        Returns:
            BatchTrajectoryResult 生成结果统计。
        """
        start = time.time()
        cfg = config or BatchTrajectoryConfig()
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        if records is None:
            records = await self._load_records(cfg)

        samples: list[TrajectorySample] = []
        skipped = 0
        errors = 0
        seen = self._seen_hashes if cfg.deduplicate else set()

        sem = asyncio.Semaphore(cfg.concurrency)

        async def _process(idx: int, record: Any) -> TrajectorySample | None:
            async with sem:
                try:
                    sample = self._record_to_sample(record, cfg)
                    if sample is None:
                        return None
                    if sample.quality < cfg.min_quality:
                        return None
                    if len(sample.messages) < cfg.min_rounds * 2:
                        return None
                    if cfg.deduplicate:
                        h = self._hash_sample(sample)
                        if h in seen:
                            return None
                        seen.add(h)
                    return sample
                except Exception as e:
                    if not cfg.continue_on_error:
                        raise
                    log.warning("Record processing failed", idx=idx, error=str(e))
                    return None

        tasks = [_process(i, r) for i, r in enumerate(records[: cfg.limit])]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for i, result in enumerate(results):
            if isinstance(result, Exception):
                errors += 1
                continue
            if result is None:
                skipped += 1
                continue
            samples.append(result)
            if self._progress_callback:
                await self._progress_callback(i + 1, len(tasks))

        await self._write_samples(path, samples, cfg)

        duration_ms = int((time.time() - start) * 1000)
        log.info(
            "Batch trajectory generation complete",
            count=len(samples),
            skipped=skipped,
            errors=errors,
            duration_ms=duration_ms,
        )

        return BatchTrajectoryResult(
            count=len(samples),
            skipped=skipped,
            errors=errors,
            duration_ms=duration_ms,
            output_path=str(path),
        )

    async def _load_records(self, config: BatchTrajectoryConfig) -> list[Any]:
        """从 TrajectoryDB 加载历史记录。"""
        try:
            from agent.persistence.database import get_sync_connection

            conn = get_sync_connection()
            cursor = conn.execute(
                "SELECT id, user_id, input, response, quality_overall, "
                "loop_rounds, total_tool_calls, total_duration, created_at "
                "FROM executions ORDER BY created_at DESC LIMIT ?",
                (config.limit * 2,),
            )
            rows = cursor.fetchall()
            conn.close()
            return rows
        except Exception as e:
            log.warning("Failed to load records from TrajectoryDB", error=str(e))
            return []

    def _record_to_sample(
        self, record: Any, config: BatchTrajectoryConfig
    ) -> TrajectorySample | None:
        """将数据库记录转换为轨迹样本。"""
        try:
            if isinstance(record, tuple | list):
                rid, user_id, inp, resp, quality, rounds, tool_calls, duration, created = record
            elif hasattr(record, "input"):
                rid = getattr(record, "id", "")
                user_id = getattr(record, "user_id", None)
                inp = getattr(record, "input", "")
                resp = getattr(record, "response", "")
                quality = getattr(record, "quality_overall", 0.0)
                rounds = getattr(record, "loop_rounds", 0)
                created = getattr(record, "created_at", 0)
            else:
                return None

            if not inp or not resp:
                return None

            uid = user_id or "anonymous"
            if config.anonymize and user_id:
                uid = hashlib.sha256(user_id.encode()).hexdigest()[:12]

            messages = [
                {"role": "user", "content": inp},
                {"role": "assistant", "content": resp},
            ]

            return TrajectorySample(
                id=str(rid) or uuid.uuid4().hex[:12],
                messages=messages,
                metadata={
                    "quality": quality or 0.0,
                    "rounds": rounds or 0,
                    "duration_ms": duration if isinstance(record, tuple | list) else 0,
                },
                quality=quality or 0.0,
                session_id=uid,
                created_at=created or int(time.time()),
            )
        except Exception:
            return None

    def _hash_sample(self, sample: TrajectorySample) -> str:
        """计算样本哈希用于去重。"""
        content = json.dumps(sample.messages, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(content.encode()).hexdigest()

    async def _write_samples(
        self, path: Path, samples: list[TrajectorySample], config: BatchTrajectoryConfig
    ) -> None:
        """将样本写入文件。"""
        fmt = config.format.lower()

        def _to_sharegpt(s: TrajectorySample) -> dict[str, Any]:
            return {
                "conversations": s.messages,
                "id": s.id,
                "metadata": s.metadata,
            }

        def _to_alpaca(s: TrajectorySample) -> dict[str, Any]:
            user_msg = next(
                (m["content"] for m in s.messages if m["role"] == "user"), ""
            )
            asst_msg = next(
                (m["content"] for m in s.messages if m["role"] == "assistant"), ""
            )
            return {
                "instruction": user_msg,
                "output": asst_msg,
                "id": s.id,
            }

        lines: list[str] = []
        for sample in samples:
            if fmt == "sharegpt":
                obj = _to_sharegpt(sample)
            elif fmt == "alpaca":
                obj = _to_alpaca(sample)
            else:
                obj = {
                    "id": sample.id,
                    "messages": sample.messages,
                    "quality": sample.quality,
                    "session_id": sample.session_id,
                    "metadata": sample.metadata,
                }
            lines.append(json.dumps(obj, ensure_ascii=False))

        await asyncio.to_thread(path.write_text, "\n".join(lines), encoding="utf-8")
