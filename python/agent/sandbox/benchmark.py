"""沙箱隔离层级性能基准测试。

测量不同沙箱层级（KERNEL/CONTAINER/PROCESS/LOGICAL）的：
- 启动延迟 (spawn latency)
- 执行吞吐 (execution throughput)
- 内存开销 (memory overhead)
- 降级检测耗时 (tier detection time)
"""
from __future__ import annotations

import asyncio
import statistics
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.sandbox.executor import (
    SandboxConfig,
    SandboxExecutor,
    SandboxTier,
    SandboxTierInfo,
    resolve_sandbox_tier,
)

log = StructuredLogger("sandbox_benchmark")


@dataclass
class TierBenchmarkResult:
    tier: SandboxTier
    available: bool
    spawn_latency_ms: list[float] = field(default_factory=list)
    execution_ms: list[float] = field(default_factory=list)
    detection_ms: float = 0.0
    error: str | None = None

    @property
    def avg_spawn_latency_ms(self) -> float:
        return statistics.mean(self.spawn_latency_ms) if self.spawn_latency_ms else 0.0

    @property
    def avg_execution_ms(self) -> float:
        return statistics.mean(self.execution_ms) if self.execution_ms else 0.0

    @property
    def p95_spawn_latency_ms(self) -> float:
        if len(self.spawn_latency_ms) < 2:
            return self.avg_spawn_latency_ms
        sorted_vals = sorted(self.spawn_latency_ms)
        idx = int(len(sorted_vals) * 0.95)
        return sorted_vals[min(idx, len(sorted_vals) - 1)]

    def to_dict(self) -> dict[str, Any]:
        return {
            "tier": self.tier.value,
            "available": self.available,
            "avg_spawn_latency_ms": round(self.avg_spawn_latency_ms, 2),
            "p95_spawn_latency_ms": round(self.p95_spawn_latency_ms, 2),
            "avg_execution_ms": round(self.avg_execution_ms, 2),
            "detection_ms": round(self.detection_ms, 2),
            "samples": len(self.spawn_latency_ms),
            "error": self.error,
        }


_BENCHMARK_CODE = "print('benchmark_ok')"
_BENCHMARK_LANGUAGE = "python"
_WARMUP_RUNS = 2
_BENCHMARK_RUNS = 5


async def benchmark_tier_detection() -> dict[SandboxTier, float]:
    results: dict[SandboxTier, float] = {}
    for tier in SandboxTier:
        start = time.time()
        try:
            await resolve_sandbox_tier(tier)
        except Exception:
            pass
        results[tier] = (time.time() - start) * 1000
    return results


async def benchmark_tier_execution(
    tier: SandboxTier,
    code: str = _BENCHMARK_CODE,
    language: str = _BENCHMARK_LANGUAGE,
    warmup: int = _WARMUP_RUNS,
    runs: int = _BENCHMARK_RUNS,
) -> TierBenchmarkResult:
    result = TierBenchmarkResult(tier=tier, available=False)

    start_detect = time.time()
    tier_info = await resolve_sandbox_tier(tier)
    result.detection_ms = (time.time() - start_detect) * 1000

    if not tier_info.available:
        result.error = f"Tier {tier.value} not available: {tier_info.reason}"
        return result

    result.available = True
    executor = SandboxExecutor(SandboxConfig(timeout_ms=10000))

    for i in range(warmup + runs):
        start_exec = time.time()
        try:
            exec_result = await executor.execute_code(
                code, language, sandbox_tier=tier,
            )
            elapsed = (time.time() - start_exec) * 1000

            if i >= warmup:
                result.spawn_latency_ms.append(elapsed - exec_result.duration_ms if exec_result.duration_ms > 0 else elapsed)
                result.execution_ms.append(exec_result.duration_ms)

            if not exec_result.success and i >= warmup:
                log.warning(
                    "Benchmark execution failed",
                    tier=tier.value,
                    run=i,
                    error=exec_result.error,
                )
        except Exception as exc:
            if i >= warmup:
                log.warning(
                    "Benchmark run exception",
                    tier=tier.value,
                    run=i,
                    error=str(exc),
                )

    return result


async def run_full_benchmark() -> dict[str, Any]:
    log.info("Starting sandbox tier benchmarks...")

    detection_results = await benchmark_tier_detection()
    log.info("Tier detection complete", results={k.value: round(v, 2) for k, v in detection_results.items()})

    tier_results: dict[str, TierBenchmarkResult] = {}
    for tier in SandboxTier:
        log.info("Benchmarking tier", tier=tier.value)
        result = await benchmark_tier_execution(tier)
        tier_results[tier.value] = result
        log.info("Tier benchmark complete", **result.to_dict())

    summary = {
        "detection_ms": {k.value: round(v, 2) for k, v in detection_results.items()},
        "tiers": {k: v.to_dict() for k, v in tier_results.items()},
        "recommendation": _generate_recommendation(tier_results),
    }

    log.info("Benchmark complete", recommendation=summary["recommendation"])
    return summary


def _generate_recommendation(
    results: dict[str, TierBenchmarkResult],
) -> str:
    available = [r for r in results.values() if r.available]
    if not available:
        return "No sandbox tier available — check environment configuration"

    best = min(available, key=lambda r: r.avg_execution_ms)
    fastest = min(available, key=lambda r: r.avg_spawn_latency_ms)

    tier_order = {SandboxTier.KERNEL.value: 0, SandboxTier.CONTAINER.value: 1, SandboxTier.PROCESS.value: 2, SandboxTier.LOGICAL.value: 3}
    strongest = min(available, key=lambda r: tier_order.get(r.tier.value, 99))

    if best.tier == strongest.tier:
        return f"Recommended: {best.tier.value} (strongest isolation + best execution time)"
    return f"Trade-off: {strongest.tier.value} (strongest) vs {fastest.tier.value} (fastest). Default: {strongest.tier.value}"
