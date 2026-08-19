"""统一健康检查 API。

提供系统各组件健康状态的聚合视图，支持：
- LLM Provider 可用性
- 熔断器状态
- 连接池状态
- 缓存命中率
- 速率限制器状态
- 背压负载等级
- 子系统依赖状态
- 内存/CPU 使用率

API:
    GET  /health           - 基础健康检查（200/503）
    GET  /health/detailed  - 详细健康报告
    GET  /health/ready     - 就绪检查（所有组件就绪）
    GET  /health/live      - 存活检查（进程存活）
"""

from __future__ import annotations

import asyncio
import os
import platform
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


class ComponentStatus(BaseModel):
    name: str = ""
    status: str = "healthy"
    latency_ms: float = 0.0
    message: str = ""
    last_checked: float = 0.0
    extra: dict[str, Any] = Field(default_factory=dict)


class HealthResponse(BaseModel):
    status: str = "healthy"
    uptime_seconds: float = 0.0
    version: str = ""
    components: list[ComponentStatus] = Field(default_factory=list)
    system: dict[str, Any] = Field(default_factory=dict)


class DetailedHealthResponse(BaseModel):
    status: str = "healthy"
    uptime_seconds: float = 0.0
    version: str = ""
    timestamp: float = 0.0
    components: list[ComponentStatus] = Field(default_factory=list)
    system: dict[str, Any] = Field(default_factory=dict)
    circuit_breakers: list[dict[str, Any]] = Field(default_factory=list)
    cache_stats: dict[str, Any] = Field(default_factory=dict)
    rate_limiter_stats: dict[str, Any] = Field(default_factory=dict)
    backpressure_stats: dict[str, Any] = Field(default_factory=dict)
    connection_pools: list[dict[str, Any]] = Field(default_factory=list)


class HealthChecker:
    def __init__(self, engine: Any = None) -> None:
        self._engine = engine
        self._start_time = time.time()
        self._version = os.environ.get("APP_VERSION", "dev")
        self._checks: dict[str, Any] = {}

    def register(self, name: str, check_fn: Any) -> None:
        self._checks[name] = check_fn

    async def check_component(self, name: str, check_fn: Any) -> ComponentStatus:
        start = time.time()
        try:
            result = await asyncio.wait_for(check_fn(), timeout=5.0)
            latency = (time.time() - start) * 1000
            if isinstance(result, dict):
                return ComponentStatus(
                    name=name,
                    status=result.get("status", "healthy"),
                    latency_ms=round(latency, 2),
                    message=result.get("message", ""),
                    last_checked=time.time(),
                    extra=result.get("extra", {}),
                )
            return ComponentStatus(
                name=name,
                status="healthy" if result else "degraded",
                latency_ms=round(latency, 2),
                last_checked=time.time(),
            )
        except asyncio.TimeoutError:
            return ComponentStatus(
                name=name, status="degraded", latency_ms=5000.0,
                message="Health check timed out", last_checked=time.time(),
            )
        except Exception as e:
            return ComponentStatus(
                name=name, status="unhealthy",
                latency_ms=(time.time() - start) * 1000,
                message=str(e), last_checked=time.time(),
            )

    async def check_all(self) -> list[ComponentStatus]:
        if not self._checks:
            return []
        tasks = {
            name: asyncio.create_task(self.check_component(name, fn))
            for name, fn in self._checks.items()
        }
        results = []
        for name, task in tasks.items():
            try:
                results.append(await task)
            except Exception:
                results.append(ComponentStatus(
                    name=name, status="unhealthy",
                    message="Check failed unexpectedly",
                ))
        return results

    async def basic_health(self) -> HealthResponse:
        components = await self.check_all()
        overall = "healthy"
        unhealthy_count = sum(1 for c in components if c.status == "unhealthy")
        degraded_count = sum(1 for c in components if c.status == "degraded")
        if unhealthy_count > 0:
            overall = "unhealthy"
        elif degraded_count > 0:
            overall = "degraded"
        return HealthResponse(
            status=overall,
            uptime_seconds=round(time.time() - self._start_time, 1),
            version=self._version,
            components=components,
            system=self._get_system_info(),
        )

    async def detailed_health(self) -> DetailedHealthResponse:
        components = await self.check_all()
        overall = "healthy"
        unhealthy_count = sum(1 for c in components if c.status == "unhealthy")
        if unhealthy_count > 0:
            overall = "unhealthy"
        return DetailedHealthResponse(
            status=overall,
            uptime_seconds=round(time.time() - self._start_time, 1),
            version=self._version,
            timestamp=time.time(),
            components=components,
            system=self._get_system_info(),
            circuit_breakers=self._get_circuit_breaker_stats(),
            cache_stats=self._get_cache_stats(),
            rate_limiter_stats=self._get_rate_limiter_stats(),
            backpressure_stats=self._get_backpressure_stats(),
            connection_pools=self._get_connection_pool_stats(),
        )

    def _get_system_info(self) -> dict[str, Any]:
        try:
            import psutil
            mem = psutil.virtual_memory()
            cpu = psutil.cpu_percent(interval=0.1)
            return {
                "python_version": platform.python_version(),
                "platform": platform.platform(),
                "cpu_percent": cpu,
                "memory_used_percent": mem.percent,
                "memory_available_gb": round(mem.available / (1024**3), 2),
                "pid": os.getpid(),
            }
        except ImportError:
            return {
                "python_version": platform.python_version(),
                "platform": platform.platform(),
                "pid": os.getpid(),
            }

    def _get_circuit_breaker_stats(self) -> list[dict[str, Any]]:
        if self._engine is None:
            return []
        try:
            provider = getattr(self._engine, "_llm_provider", None)
            if provider is None:
                return []
            registry = getattr(provider, "_circuit_registry", None)
            if registry is None:
                return []
            stats = registry.all_stats()
            return [
                {"name": n, "state": s.state.value,
                 "failure_count": s.failure_count,
                 "total_failures": s.total_failures,
                 "total_successes": s.total_successes}
                for n, s in stats.items()
            ]
        except Exception:
            return []

    def _get_cache_stats(self) -> dict[str, Any]:
        if self._engine is None:
            return {}
        try:
            provider = getattr(self._engine, "_llm_provider", None)
            if provider is None:
                return {}
            tc = getattr(provider, "tiered_cache", None)
            if tc is None:
                return {"l1_size": getattr(provider.cache, "size", 0)}
            return tc.stats()
        except Exception:
            return {}

    def _get_rate_limiter_stats(self) -> dict[str, Any]:
        if self._engine is None:
            return {}
        try:
            provider = getattr(self._engine, "_llm_provider", None)
            if provider is None:
                return {}
            rl = getattr(provider, "rate_limiter", None)
            if rl is None:
                return {}
            return rl.stats()
        except Exception:
            return {}

    def _get_backpressure_stats(self) -> dict[str, Any]:
        if self._engine is None:
            return {}
        try:
            bp = getattr(self._engine, "backpressure", None)
            if bp is None:
                return {}
            return {
                "load_level": str(bp._current_load),
                "active_requests": bp._active,
                "queue_depth": bp._queue_depth,
                "accepted": bp._accepted,
                "rejected": bp._rejected,
            }
        except Exception:
            return {}

    def _get_connection_pool_stats(self) -> list[dict[str, Any]]:
        if self._engine is None:
            return []
        try:
            provider = getattr(self._engine, "_llm_provider", None)
            if provider is None:
                return []
            pm = getattr(provider, "_connection_pool", None)
            if pm is None:
                return []
            stats = pm.all_stats()
            return [{"base_url": url, **s.__dict__} for url, s in stats.items()]
        except Exception:
            return []


_HEALTH_CHECKER: HealthChecker | None = None


def get_health_checker() -> HealthChecker:
    global _HEALTH_CHECKER
    if _HEALTH_CHECKER is None:
        _HEALTH_CHECKER = HealthChecker()
    return _HEALTH_CHECKER


def set_engine_for_health(engine: Any) -> None:
    checker = get_health_checker()
    checker._engine = engine


def create_health_router(engine: Any = None) -> APIRouter:
    if engine:
        set_engine_for_health(engine)
    router = APIRouter(tags=["health"])

    @router.get("/health")
    async def health():
        return await get_health_checker().basic_health()

    @router.get("/health/detailed")
    async def health_detailed():
        return await get_health_checker().detailed_health()

    @router.get("/health/ready")
    async def health_ready():
        result = await get_health_checker().basic_health()
        if result.status == "unhealthy":
            raise HTTPException(status_code=503, detail="Service not ready")
        return {"status": "ready", "uptime_seconds": result.uptime_seconds}

    @router.get("/health/live")
    async def health_live():
        return {"status": "alive"}

    return router


def register_default_checks(engine: Any) -> None:
    checker = get_health_checker()
    checker._engine = engine

    async def check_llm() -> dict[str, Any]:
        provider = getattr(engine, "llm", None)
        if provider is None:
            return {"status": "unhealthy", "message": "LLM provider not initialized"}
        try:
            available = await provider.check_available()
            return {
                "status": "healthy" if available else "degraded",
                "message": "LLM provider available" if available else "LLM provider check failed",
                "extra": {"model": getattr(provider, "model", "unknown")},
            }
        except Exception as e:
            return {"status": "unhealthy", "message": str(e)}

    async def check_memory() -> dict[str, Any]:
        try:
            import psutil
            mem = psutil.virtual_memory()
            if mem.percent > 90:
                return {"status": "degraded", "message": f"Memory usage high: {mem.percent}%"}
            return {"status": "healthy", "message": f"Memory OK: {mem.percent}%"}
        except ImportError:
            return {"status": "healthy", "message": "psutil not available"}

    async def check_subsystems() -> dict[str, Any]:
        # D1（审计 §1.7）：关键子系统降级此前对 /health 不可见，此处接入 engine 降级报告。
        # 关键（critical）子系统降级 → unhealthy；普通降级 → degraded；否则 healthy。
        return await subsystems_health(engine)

    async def check_ignored_exceptions() -> dict[str, Any]:
        # P2-1：全仓 352 处 `except: pass` 已改写为 log_ignored 记账，
        # 此处把计数暴露给 /health —— 「可观测」由计数器承载而非日志级别。
        return ignored_exceptions_health()

    checker.register("llm", check_llm)
    checker.register("memory", check_memory)
    checker.register("subsystems", check_subsystems)
    checker.register("ignored_exceptions", check_ignored_exceptions)


# 单站点忽略次数超过该阈值即视为可疑（某处在反复吞异常），上报 degraded。
IGNORED_EXC_SITE_WARN_THRESHOLD = 100


def ignored_exceptions_health() -> dict[str, Any]:
    """P2-1：把「被有意忽略的异常」计数暴露到 /health。

    注意本检查**永不**返回 unhealthy —— 这些异常按设计是可忽略的，
    它的价值在于「让原本黑洞化的故障浮出水面」，而非制造告警噪音。
    """
    from agent.core.logger import get_ignored_exception_stats

    try:
        stats = get_ignored_exception_stats()
    except Exception as e:
        return {"status": "healthy", "message": f"忽略异常统计不可用: {e}"}

    top = stats.get("top_sites") or []
    hot = [s for s in top if s.get("count", 0) >= IGNORED_EXC_SITE_WARN_THRESHOLD]
    return {
        "status": "degraded" if hot else "healthy",
        "message": (
            f"{len(hot)} 处站点忽略异常次数超过 {IGNORED_EXC_SITE_WARN_THRESHOLD}"
            if hot
            else f"累计忽略异常 {stats.get('total', 0)} 次 / {stats.get('distinct_sites', 0)} 个站点"
        ),
        "extra": stats,
    }


async def subsystems_health(engine: Any) -> dict[str, Any]:
    """D1（审计 §1.7）：汇总 engine 的子系统降级状态，供 /health 暴露。

    - 关键（critical）子系统降级 → unhealthy
    - 仅普通子系统降级 → degraded
    - 无降级 → healthy
    """
    get_report = getattr(engine, "get_degraded_report", None)
    if get_report is None:
        return {"status": "healthy", "message": "engine 未暴露降级报告接口"}
    try:
        report = get_report()
    except Exception as e:
        return {"status": "degraded", "message": f"读取降级报告异常: {e}"}
    critical = report.get("critical_degraded", []) or []
    degraded = report.get("degraded_subsystems", {}) or {}
    return {
        "status": "unhealthy" if critical else ("degraded" if degraded else "healthy"),
        "message": (
            f"关键子系统降级 {len(critical)} 个，普通降级 {len(degraded)} 个"
            if (critical or degraded)
            else "所有子系统正常"
        ),
        "extra": {
            "critical_degraded": critical,
            "critical_degraded_count": len(critical),
            "degraded": sorted(degraded.keys()) if isinstance(degraded, dict) else list(degraded),
            "degraded_count": len(degraded) if isinstance(degraded, dict) else len(degraded),
        },
    }
