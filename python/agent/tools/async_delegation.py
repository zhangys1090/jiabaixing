"""委派工具（子 Agent 委派 + 并行委派）。

增强 delegate_tool.py 的委派能力：
  - 并行委派：同时向多个子 Agent 发送任务
  - 条件委派：根据任务特征自动选择子 Agent
  - 结果聚合：合并多个子 Agent 的结果
  - 超时与重试：单个子 Agent 超时不影响整体
  - 委派链：子 Agent 可继续委派（有深度限制）

与 delegate_tool.py 的关系：
  - delegate_tool.py 提供基础 SubAgentDelegator
  - AsyncDelegator 扩展并行和条件委派能力
  - 两者可组合使用

集成示例::

    from agent.tools.async_delegation import AsyncDelegator, DelegationSpec

    delegator = AsyncDelegator()
    delegator.register_handler("researcher", researcher_handler)
    delegator.register_handler("writer", writer_handler)

    specs = [
        DelegationSpec(agent="researcher", task="搜索相关资料"),
        DelegationSpec(agent="writer", task="撰写摘要"),
    ]
    results = await delegator.delegate_parallel(specs)
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger

log = StructuredLogger("async_delegation")


class DelegationStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


class AggregationMode(str, Enum):
    CONCAT = "concat"
    MERGE = "merge"
    BEST = "best"
    VOTE = "vote"
    FIRST_SUCCESS = "first_success"


@dataclass
class DelegationSpec:
    agent: str
    task: str
    timeout: float = 60.0
    priority: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class DelegationResult:
    id: str
    spec: DelegationSpec
    status: DelegationStatus = DelegationStatus.PENDING
    result: str = ""
    error: str = ""
    duration_ms: float = 0.0
    started_at: float = 0.0
    completed_at: float = 0.0

    def __post_init__(self) -> None:
        if not self.id:
            self.id = str(uuid.uuid4())


@dataclass
class ParallelResult:
    delegation_id: str
    results: list[DelegationResult]
    aggregation_mode: AggregationMode
    aggregated_result: str = ""
    total_duration_ms: float = 0.0
    success_count: int = 0
    failure_count: int = 0
    all_completed: bool = True


@dataclass
class AgentCapability:
    agent_id: str
    capabilities: list[str] = field(default_factory=list)
    max_concurrent: int = 3
    current_load: int = 0
    avg_duration_ms: float = 0.0
    success_rate: float = 1.0
    cost_per_call: float = 0.0

    @property
    def is_available(self) -> bool:
        return self.current_load < self.max_concurrent


class AsyncDelegator:
    """异步委派管理器。

    管理子 Agent 的并行委派、条件路由和结果聚合。
    支持委派暂停开关（审计 P0-1：防失控 Agent 树）。
    """

    # ─── 审计 P0-1：委派暂停开关 ───
    _spawn_paused: asyncio.Event = asyncio.Event()
    _spawn_paused.set()

    @classmethod
    def is_spawn_paused(cls) -> bool:
        """检查委派是否暂停。非阻塞，调用方在发起新委派前检查。"""
        return not cls._spawn_paused.is_set()

    @classmethod
    async def pause_spawn(cls, reason: str = "") -> None:
        """暂停所有新委派。已运行的委派不受影响。"""
        cls._spawn_paused.clear()
        log.warning("委派已暂停", reason=reason)

    @classmethod
    async def resume_spawn(cls) -> None:
        """恢复委派。"""
        cls._spawn_paused.set()
        log.info("委派已恢复")

    @classmethod
    def get_pause_state(cls) -> dict[str, Any]:
        """获取委派暂停状态。"""
        return {
            "paused": cls.is_spawn_paused(),
            "reason": "委派已暂停" if cls.is_spawn_paused() else "正常运行",
        }

    def __init__(self, max_depth: int = 3, default_timeout: float = 60.0) -> None:
        self._handlers: dict[str, Callable[..., Awaitable[str]]] = {}
        self._capabilities: dict[str, AgentCapability] = {}
        self._active_tasks: dict[str, DelegationResult] = {}
        self._max_depth = max_depth
        self._default_timeout = default_timeout
        self._depth_counter: dict[str, int] = defaultdict(int)
        self._stats = {"total_delegations": 0, "total_success": 0, "total_failure": 0}

    def register_handler(
        self,
        agent_id: str,
        handler: Callable[..., Awaitable[str]],
        capabilities: list[str] | None = None,
        max_concurrent: int = 3,
    ) -> None:
        self._handlers[agent_id] = handler
        self._capabilities[agent_id] = AgentCapability(
            agent_id=agent_id,
            capabilities=capabilities or [],
            max_concurrent=max_concurrent,
        )
        log.info("委派处理器已注册", agent=agent_id)

    def unregister_handler(self, agent_id: str) -> None:
        self._handlers.pop(agent_id, None)
        self._capabilities.pop(agent_id, None)

    async def delegate_single(self, spec: DelegationSpec) -> DelegationResult:
        if self.is_spawn_paused():
            return DelegationResult(
                spec=spec,
                status=DelegationStatus.FAILED,
                error="委派已暂停，新任务被拒绝",
            )
        handler = self._handlers.get(spec.agent)
        if handler is None:
            return DelegationResult(
                spec=spec,
                status=DelegationStatus.FAILED,
                error=f"Agent '{spec.agent}' 未注册",
            )

        cap = self._capabilities.get(spec.agent)
        if cap:
            cap.current_load += 1

        result = DelegationResult(spec=spec, status=DelegationStatus.RUNNING, started_at=time.time())
        self._active_tasks[result.id] = result
        self._stats["total_delegations"] += 1

        try:
            output = await asyncio.wait_for(
                handler(spec.task, **spec.metadata),
                timeout=spec.timeout,
            )
            result.status = DelegationStatus.COMPLETED
            result.result = output
            result.completed_at = time.time()
            result.duration_ms = (result.completed_at - result.started_at) * 1000
            self._stats["total_success"] += 1

            if cap:
                cap.success_rate = (
                    (cap.success_rate * (self._stats["total_success"] - 1) + 1.0)
                    / self._stats["total_success"]
                )
                cap.avg_duration_ms = (
                    (cap.avg_duration_ms * (self._stats["total_success"] - 1) + result.duration_ms)
                    / self._stats["total_success"]
                )
        except asyncio.TimeoutError:
            result.status = DelegationStatus.TIMEOUT
            result.error = f"超时 ({spec.timeout}s)"
            result.completed_at = time.time()
            result.duration_ms = (result.completed_at - result.started_at) * 1000
            self._stats["total_failure"] += 1
        except asyncio.CancelledError:
            result.status = DelegationStatus.CANCELLED
            result.completed_at = time.time()
            result.duration_ms = (result.completed_at - result.started_at) * 1000
        except Exception as e:
            result.status = DelegationStatus.FAILED
            result.error = str(e)
            result.completed_at = time.time()
            result.duration_ms = (result.completed_at - result.started_at) * 1000
            self._stats["total_failure"] += 1
        finally:
            if cap:
                cap.current_load = max(0, cap.current_load - 1)
            self._active_tasks.pop(result.id, None)

        return result

    async def delegate_parallel(
        self,
        specs: list[DelegationSpec],
        aggregation: AggregationMode = AggregationMode.CONCAT,
        fail_fast: bool = False,
    ) -> ParallelResult:
        start = time.monotonic()
        delegation_id = str(uuid.uuid4())

        sorted_specs = sorted(specs, key=lambda s: s.priority, reverse=True)
        tasks = [self.delegate_single(spec) for spec in sorted_specs]

        if fail_fast:
            results = await asyncio.gather(*tasks, return_exceptions=True)
        else:
            results = await asyncio.gather(*tasks, return_exceptions=True)

        processed: list[DelegationResult] = []
        for r in results:
            if isinstance(r, Exception):
                processed.append(DelegationResult(
                    spec=DelegationSpec(agent="unknown", task=""),
                    status=DelegationStatus.FAILED,
                    error=str(r),
                ))
            else:
                processed.append(r)

        success_count = sum(1 for r in processed if r.status == DelegationStatus.COMPLETED)
        failure_count = sum(1 for r in processed if r.status != DelegationStatus.COMPLETED)
        aggregated = self._aggregate(processed, aggregation)

        total_duration = (time.monotonic() - start) * 1000
        return ParallelResult(
            delegation_id=delegation_id,
            results=processed,
            aggregation_mode=aggregation,
            aggregated_result=aggregated,
            total_duration_ms=total_duration,
            success_count=success_count,
            failure_count=failure_count,
            all_completed=failure_count == 0,
        )

    async def delegate_conditional(
        self,
        task: str,
        condition: Callable[[str, AgentCapability], bool] | None = None,
        timeout: float = 60.0,
    ) -> DelegationResult:
        best_agent = self._find_best_agent(task, condition)
        if best_agent is None:
            return DelegationResult(
                spec=DelegationSpec(agent="", task=task),
                status=DelegationStatus.FAILED,
                error="无可用 Agent",
            )

        spec = DelegationSpec(agent=best_agent, task=task, timeout=timeout)
        return await self.delegate_single(spec)

    async def delegate_chain(
        self,
        tasks: list[tuple[str, str]],
        timeout_per_step: float = 60.0,
    ) -> list[DelegationResult]:
        if len(tasks) > self._max_depth:
            log.warning("委派链超过最大深度", depth=len(tasks), max=self._max_depth)
            tasks = tasks[:self._max_depth]

        results = []
        current_context = ""
        for agent_id, task_desc in tasks:
            full_task = f"{task_desc}\n\n上下文: {current_context}" if current_context else task_desc
            spec = DelegationSpec(agent=agent_id, task=full_task, timeout=timeout_per_step)
            result = await self.delegate_single(spec)
            results.append(result)
            if result.status == DelegationStatus.COMPLETED:
                current_context = result.result
            else:
                break
        return results

    def _find_best_agent(
        self,
        task: str,
        condition: Callable[[str, AgentCapability], bool] | None = None,
    ) -> str | None:
        candidates = []
        for agent_id, cap in self._capabilities.items():
            if not cap.is_available:
                continue
            if condition and not condition(task, cap):
                continue
            score = cap.success_rate * 100 - cap.current_load * 10 - cap.avg_duration_ms / 1000
            candidates.append((agent_id, score))

        if not candidates:
            return None
        return max(candidates, key=lambda x: x[1])[0]

    def _aggregate(self, results: list[DelegationResult], mode: AggregationMode) -> str:
        successful = [r for r in results if r.status == DelegationStatus.COMPLETED]

        if not successful:
            errors = [r.error for r in results if r.error]
            return f"所有委派失败: {'; '.join(errors[:3])}"

        if mode == AggregationMode.CONCAT:
            parts = [f"[{r.spec.agent}] {r.result}" for r in successful]
            return "\n---\n".join(parts)

        elif mode == AggregationMode.MERGE:
            combined = " ".join(r.result for r in successful)
            return combined

        elif mode == AggregationMode.BEST:
            return max(successful, key=lambda r: len(r.result)).result

        elif mode == AggregationMode.VOTE:
            vote_counts: dict[str, int] = defaultdict(int)
            for r in successful:
                vote_counts[r.result] += 1
            return max(vote_counts, key=vote_counts.get)

        elif mode == AggregationMode.FIRST_SUCCESS:
            return successful[0].result

        return successful[0].result

    def get_active_tasks(self) -> list[dict[str, Any]]:
        return [
            {
                "id": r.id,
                "agent": r.spec.agent,
                "status": r.status.value,
                "duration_ms": r.duration_ms,
            }
            for r in self._active_tasks.values()
        ]

    def get_stats(self) -> dict[str, Any]:
        agents = {}
        for aid, cap in self._capabilities.items():
            agents[aid] = {
                "load": cap.current_load,
                "max_concurrent": cap.max_concurrent,
                "success_rate": round(cap.success_rate, 3),
                "avg_duration_ms": round(cap.avg_duration_ms, 1),
            }
        return {
            "agents": agents,
            "active_tasks": len(self._active_tasks),
            **self._stats,
        }
