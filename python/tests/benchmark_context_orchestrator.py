"""
Unified Context Orchestrator - Performance Benchmark

Tests performance across different scenarios.
Supports P50/P95/P99 percentile statistics.
"""

from __future__ import annotations

import asyncio
import gc
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any

# Add project path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agent.context import UnifiedContextOrchestrator, ContextBuildRequest
from agent.context.adapters import (
    ContextAssemblerComponent,
    FileContextComponent,
    MemoryRetrievalComponent,
    PersonaComponent,
    SystemPromptComponent,
    TokenBudgetComponent,
)


@dataclass
class BenchmarkResult:
    """Benchmark result"""

    name: str
    iterations: int
    total_time_ms: float = 0.0
    avg_time_ms: float = 0.0
    min_time_ms: float = 0.0
    max_time_ms: float = 0.0
    p50_ms: float = 0.0
    p95_ms: float = 0.0
    p99_ms: float = 0.0
    memory_before_kb: float = 0.0
    memory_after_kb: float = 0.0
    memory_delta_kb: float = 0.0
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "iterations": self.iterations,
            "total_time_ms": round(self.total_time_ms, 3),
            "avg_time_ms": round(self.avg_time_ms, 3),
            "min_time_ms": round(self.min_time_ms, 3),
            "max_time_ms": round(self.max_time_ms, 3),
            "p50_ms": round(self.p50_ms, 3),
            "p95_ms": round(self.p95_ms, 3),
            "p99_ms": round(self.p99_ms, 3),
            "memory_delta_kb": round(self.memory_delta_kb, 2),
            "extra": self.extra,
        }


def get_memory_usage() -> float:
    """Get current memory usage in KB"""
    try:
        import psutil
        process = psutil.Process()
        return process.memory_info().rss / 1024
    except ImportError:
        return 0.0


def calculate_percentiles(times: list[float]) -> tuple[float, float, float]:
    """Calculate percentiles"""
    if not times:
        return 0.0, 0.0, 0.0

    sorted_times = sorted(times)
    n = len(sorted_times)

    p50_idx = int(n * 0.5)
    p95_idx = int(n * 0.95)
    p99_idx = int(n * 0.99)

    p50 = sorted_times[min(p50_idx, n - 1)]
    p95 = sorted_times[min(p95_idx, n - 1)]
    p99 = sorted_times[min(p99_idx, n - 1)]

    return p50, p95, p99


async def benchmark_async(
    name: str,
    func,
    iterations: int = 100,
    warmup: int = 10,
    measure_memory: bool = True,
) -> BenchmarkResult:
    """Run async benchmark

    Args:
        name: Test name
        func: Async function to test
        iterations: Number of iterations
        warmup: Number of warmup iterations
        measure_memory: Whether to measure memory

    Returns:
        BenchmarkResult: Test result
    """
    result = BenchmarkResult(name=name, iterations=iterations)

    # Warmup
    for _ in range(warmup):
        await func()

    # Memory measurement (before)
    if measure_memory:
        gc.collect()
        result.memory_before_kb = get_memory_usage()

    # Formal test
    times: list[float] = []

    for i in range(iterations):
        start = time.perf_counter()
        await func()
        elapsed = (time.perf_counter() - start) * 1000  # Convert to ms
        times.append(elapsed)

    # Memory measurement (after)
    if measure_memory:
        gc.collect()
        result.memory_after_kb = get_memory_usage()
        result.memory_delta_kb = result.memory_after_kb - result.memory_before_kb

    # Calculate statistics
    result.total_time_ms = sum(times)
    result.avg_time_ms = result.total_time_ms / iterations
    result.min_time_ms = min(times)
    result.max_time_ms = max(times)
    result.p50_ms, result.p95_ms, result.p99_ms = calculate_percentiles(times)

    return result


def create_orchestrator(
    component_count: int = 6,
    use_cache: bool = True,
) -> UnifiedContextOrchestrator:
    """Create test orchestrator

    Args:
        component_count: Number of components
        use_cache: Whether to use cache

    Returns:
        UnifiedContextOrchestrator: Orchestrator instance
    """
    orchestrator = UnifiedContextOrchestrator(
        use_cache=use_cache,
        cache_max_size=200,
        cache_ttl=600,
        enabled=True,
    )

    # Register components
    components = [
        SystemPromptComponent(),
        PersonaComponent(),
        MemoryRetrievalComponent(),
        FileContextComponent(),
        TokenBudgetComponent(),
        ContextAssemblerComponent(),
    ]

    for i in range(min(component_count, len(components))):
        orchestrator.register_component(components[i])

    return orchestrator


async def run_all_benchmarks():
    """Run all benchmarks"""
    results: list[BenchmarkResult] = []

    print("=" * 70)
    print("  Unified Context Orchestrator - Performance Benchmark")
    print("=" * 70)
    print()

    # --- Test 1: Orchestrator initialization ---
    print("Test 1: Orchestrator initialization")
    print("-" * 50)

    async def bench_init():
        orch = UnifiedContextOrchestrator(use_cache=True)
        orch.register_component(SystemPromptComponent())
        return orch

    result = await benchmark_async("init_orchestrator", bench_init, iterations=100)
    results.append(result)
    print(f"  Avg: {result.avg_time_ms:.3f} ms")
    print(f"  Min: {result.min_time_ms:.3f} ms")
    print(f"  Max: {result.max_time_ms:.3f} ms")
    print()

    # --- Test 2: Empty request (minimal overhead) ---
    print("Test 2: Empty request (minimal overhead)")
    print("-" * 50)

    orch_empty = UnifiedContextOrchestrator(use_cache=False, enabled=True)

    async def bench_empty():
        request = ContextBuildRequest(user_input="test")
        return await orch_empty.build_context(request)

    result = await benchmark_async("empty_request", bench_empty, iterations=200)
    results.append(result)
    print(f"  Avg: {result.avg_time_ms:.3f} ms")
    print(f"  P50: {result.p50_ms:.3f} ms")
    print(f"  P95: {result.p95_ms:.3f} ms")
    print(f"  P99: {result.p99_ms:.3f} ms")
    print()

    # --- Test 3: Single component ---
    print("Test 3: Single component build")
    print("-" * 50)

    orch_single = create_orchestrator(component_count=1, use_cache=False)

    async def bench_single():
        request = ContextBuildRequest(user_input="test")
        return await orch_single.build_context(request)

    result = await benchmark_async("single_component", bench_single, iterations=200)
    results.append(result)
    print(f"  Avg: {result.avg_time_ms:.3f} ms")
    print(f"  P50: {result.p50_ms:.3f} ms")
    print(f"  P95: {result.p95_ms:.3f} ms")
    print()

    # --- Test 4: Full components (cache miss) ---
    print("Test 4: Full components build (cache miss)")
    print("-" * 50)

    orch_full = create_orchestrator(component_count=6, use_cache=False)
    counter = 0

    async def bench_full_miss():
        nonlocal counter
        counter += 1
        request = ContextBuildRequest(user_input=f"test_{counter}")
        return await orch_full.build_context(request)

    result = await benchmark_async("full_components_miss", bench_full_miss, iterations=100)
    results.append(result)
    print(f"  Avg: {result.avg_time_ms:.3f} ms")
    print(f"  P50: {result.p50_ms:.3f} ms")
    print(f"  P95: {result.p95_ms:.3f} ms")
    print(f"  P99: {result.p99_ms:.3f} ms")
    print()

    # --- Test 5: Full components (cache hit) ---
    print("Test 5: Full components build (cache hit)")
    print("-" * 50)

    orch_cache = create_orchestrator(component_count=6, use_cache=True)
    # Warmup cache
    warmup_request = ContextBuildRequest(user_input="cache_test")
    await orch_cache.build_context(warmup_request)

    async def bench_cache_hit():
        request = ContextBuildRequest(user_input="cache_test")
        return await orch_cache.build_context(request)

    result = await benchmark_async("full_components_hit", bench_cache_hit, iterations=500)
    results.append(result)
    cache_stats = orch_cache.get_cache_stats()
    print(f"  Avg: {result.avg_time_ms:.3f} ms")
    print(f"  P50: {result.p50_ms:.3f} ms")
    print(f"  P95: {result.p95_ms:.3f} ms")
    print(f"  P99: {result.p99_ms:.3f} ms")
    print(f"  Cache hit rate: {cache_stats.get('hit_rate', 0):.2%}")
    print()

    # --- Test 6: Different component counts ---
    print("Test 6: Performance by component count")
    print("-" * 50)

    for count in [1, 2, 3, 4, 5, 6]:
        orch = create_orchestrator(component_count=count, use_cache=False)
        req_counter = 0

        async def bench_n():
            nonlocal req_counter
            req_counter += 1
            request = ContextBuildRequest(user_input=f"test_{req_counter}")
            return await orch.build_context(request)

        result = await benchmark_async(f"{count}_components", bench_n, iterations=100)
        results.append(result)
        print(f"  {count} components: {result.avg_time_ms:.3f} ms (avg)")

    print()

    # --- Test 7: Different history sizes ---
    print("Test 7: Performance by history size")
    print("-" * 50)

    orch_hist = create_orchestrator(component_count=6, use_cache=False)

    for hist_count in [0, 5, 10, 20, 50]:
        history = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"message {i}"}
            for i in range(hist_count)
        ]
        req_counter = 0

        async def bench_hist():
            nonlocal req_counter
            req_counter += 1
            request = ContextBuildRequest(
                user_input=f"test_{req_counter}",
                history=list(history),
            )
            return await orch_hist.build_context(request)

        result = await benchmark_async(f"{hist_count}_history", bench_hist, iterations=50)
        results.append(result)
        print(f"  {hist_count:3d} history msgs: {result.avg_time_ms:.3f} ms (avg)")

    print()

    # --- Test 8: Memory usage ---
    print("Test 8: Memory usage")
    print("-" * 50)

    gc.collect()
    mem_before = get_memory_usage()

    # Create many orchestrator instances
    orchestrators = []
    for i in range(100):
        orch = create_orchestrator(component_count=6, use_cache=True)
        # Fill some cache
        for j in range(10):
            req = ContextBuildRequest(user_input=f"test_{i}_{j}")
            await orch.build_context(req)
        orchestrators.append(orch)

    gc.collect()
    mem_after = get_memory_usage()

    print(f"  100 orchestrators memory: {mem_after - mem_before:.1f} KB")
    print(f"  Avg per instance: {(mem_after - mem_before) / 100:.1f} KB")
    print()

    # Cleanup
    del orchestrators
    gc.collect()

    # --- Test 9: Cache size impact ---
    print("Test 9: Performance by cache size")
    print("-" * 50)

    for cache_size in [10, 50, 100, 200, 500]:
        orch = UnifiedContextOrchestrator(
            use_cache=True,
            cache_max_size=cache_size,
            cache_ttl=600,
            enabled=True,
        )
        orch.register_component(SystemPromptComponent())
        orch.register_component(ContextAssemblerComponent())

        # Fill cache
        for i in range(cache_size):
            req = ContextBuildRequest(user_input=f"fill_{i}")
            await orch.build_context(req)

        # Test cache hits
        hit_counter = 0

        async def bench_cache_size():
            nonlocal hit_counter
            hit_counter += 1
            request = ContextBuildRequest(user_input=f"fill_{hit_counter % cache_size}")
            return await orch.build_context(request)

        result = await benchmark_async(
            f"cache_size_{cache_size}",
            bench_cache_size,
            iterations=200,
            measure_memory=False,
        )
        results.append(result)
        print(f"  Cache size {cache_size:3d}: {result.avg_time_ms:.3f} ms (avg)")

    print()

    # --- Summary ---
    print("=" * 70)
    print("  Performance Benchmark Summary")
    print("=" * 70)
    print()

    key_results = [r for r in results if r.name in [
        "empty_request",
        "single_component",
        "full_components_miss",
        "full_components_hit",
    ]]

    print(f"{'Test':<30} {'Avg(ms)':<15} {'P95(ms)':<12} {'P99(ms)':<12}")
    print("-" * 70)
    for r in key_results:
        print(f"{r.name:<30} {r.avg_time_ms:<15.3f} {r.p95_ms:<12.3f} {r.p99_ms:<12.3f}")

    print()
    print("Performance benchmark completed successfully!")
    print()

    return results


if __name__ == "__main__":
    asyncio.run(run_all_benchmarks())
