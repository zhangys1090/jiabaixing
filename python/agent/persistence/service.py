from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.memory.engine import MemoryEngine
from agent.persistence.trajectory import TrajectoryDatabase


@dataclass
class MemoryStoreOptions:
    """记忆存储选项。

    Attributes:
        type: 记忆类型（short_term/long_term）。
        scene: 场景标签。
        emotion: 情绪标签。
        trace_id: 追踪ID。
        source: 来源。
        importance: 重要性（1-10）。
    """

    type: str = "short_term"
    scene: str | None = None
    emotion: str | None = None
    trace_id: str | None = None
    source: str | None = None
    importance: float = 5.0


@dataclass
class MemoryRecallOptions:
    """记忆召回选项。

    Attributes:
        limit: 返回数量上限。
        scene: 场景过滤。
        emotion: 情绪过滤。
        start_time: 开始时间。
        end_time: 结束时间。
    """

    limit: int = 5
    scene: str | None = None
    emotion: str | None = None
    start_time: float | None = None
    end_time: float | None = None


@dataclass
class TaskState:
    """任务状态——可恢复执行的任务快照。

    Attributes:
        task_id: 任务ID。
        user_id: 用户ID。
        description: 任务描述。
        status: 任务状态。
        plan_json: 执行计划JSON。
        current_step_index: 当前步骤序号。
        step_results_json: 步骤结果JSON。
        created_at: 创建时间戳。
        updated_at: 更新时间戳。
        resume_context: 恢复上下文。
    """

    task_id: str = ""
    user_id: str = "default"
    description: str = ""
    status: str = "pending"
    plan_json: str | None = None
    current_step_index: int = 0
    step_results_json: str | None = None
    created_at: float = 0.0
    updated_at: float = 0.0
    resume_context: str | None = None


@dataclass
class UserProfile:
    """用户画像。

    Attributes:
        name: 用户名称。
        preferences: 偏好设置。
        facts: 已知事实列表。
        communication_style: 沟通风格。
        active_hours: 活跃时段。
        last_updated: 最后更新时间戳。
    """

    name: str | None = None
    preferences: dict[str, list[str]] = field(default_factory=dict)
    facts: list[str] = field(default_factory=list)
    communication_style: str | None = None
    active_hours: str | None = None
    last_updated: float = 0.0


@dataclass
class EvolutionMetric:
    """进化指标——Agent自我进化度量。

    Attributes:
        metric_type: 指标类型。
        value: 指标值。
        timestamp: 记录时间戳。
        metadata: 附加元数据。
    """

    metric_type: str = ""
    value: float = 0.0
    timestamp: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


class PersistenceService:
    """持久化服务——统一管理记忆、轨迹和状态持久化。

    整合记忆引擎、轨迹数据库和任务状态管理，提供统一的持久化接口。
    支持用户画像、进化指标和任务恢复。

    Usage:
        service = PersistenceService(memory_engine=mem, trajectory_db=db)
        service.save_memory("用户偏好简洁回答", scene="chat")
        task = service.save_task_state(task_id, status="running")
        profile = service.get_user_profile()
    """
    def __init__(
        self,
        memory_engine: MemoryEngine | None = None,
        trajectory_db: TrajectoryDatabase | None = None,
        data_dir: Path | None = None,
    ) -> None:
        self.memory = memory_engine
        self.trajectory_db = trajectory_db or TrajectoryDatabase()
        self._data_dir = data_dir or DATA_DIR / "persistence"
        self._data_dir.mkdir(parents=True, exist_ok=True)

        self._task_states: dict[str, TaskState] = {}
        self._evolution_metrics: list[EvolutionMetric] = []
        self._promoted_ids: set[str] = set()
        self._initialized = False
        self._flush_count = 0
        # P1 修复：持久化写入锁，防止并发 flush 导致数据撕裂
        self._flush_lock = asyncio.Lock()

    async def initialize(self) -> None:
        if self._initialized:
            return
        await self._load_task_states()
        await self._load_evolution_metrics()
        self._initialized = True

    async def store_memory(
        self, content: str, options: MemoryStoreOptions | None = None
    ) -> str:
        opts = options or MemoryStoreOptions()
        if not self.memory:
            return ""

        try:
            if opts.type == "instant":
                await self.memory.store_instant(content, scene=opts.scene, emotion=opts.emotion)
            elif opts.type == "long_term":
                await self.memory.store_long_term(content, scene=opts.scene, emotion=opts.emotion)
            else:
                await self.memory.store_short_term(content, scene=opts.scene, emotion=opts.emotion)
            return "stored"
        except Exception:
            return ""

    async def recall_memory(
        self, query: str, options: MemoryRecallOptions | None = None
    ) -> list[dict[str, Any]]:
        opts = options or MemoryRecallOptions()
        if not self.memory:
            return []

        try:
            results = await self.memory.search(query=query, limit=opts.limit)
            return results
        except Exception:
            return []

    async def promote_memories(self) -> int:
        if not self.memory:
            return 0

        try:
            queries = ["重要", "记住", "关键", "用户偏好", "学习"]
            all_memories: list[dict[str, Any]] = []

            for q in queries:
                results = await self.memory.search(query=q, limit=20)
                all_memories.extend(results)

            seen: set[str] = set()
            unique: list[dict[str, Any]] = []
            for m in all_memories:
                mid = m.get("id", "") or m.get("content", "")
                if mid not in seen:
                    seen.add(mid)
                    unique.append(m)

            candidates = [
                m for m in unique
                if m.get("id", "") not in self._promoted_ids
                and f"promoted:{m.get('id', '')}" not in self._promoted_ids
                and m.get("type", "short_term") in ("short_term", None)
                and (m.get("importance", 0) >= 7 or m.get("accessCount", 0) >= 3)
            ]

            if not candidates:
                return 0

            promoted = 0
            for memory in candidates:
                mid = memory.get("id", "")
                content = memory.get("content", "")
                if not content:
                    continue
                try:
                    await self.memory.store_long_term(
                        content,
                        scene=memory.get("scene"),
                        emotion=memory.get("emotion"),
                    )
                    if mid:
                        self._promoted_ids.add(mid)
                        self._promoted_ids.add(f"promoted:{mid}")
                    promoted += 1
                except Exception:
                    pass

            return promoted
        except Exception:
            return 0

    async def save_task_state(self, task: TaskState) -> None:
        task.updated_at = time.time()
        self._task_states[task.task_id] = task
        await self._flush_task_states()

    async def load_task_state(self, task_id: str) -> TaskState | None:
        return self._task_states.get(task_id)

    async def list_active_tasks(self) -> list[TaskState]:
        return [
            t for t in self._task_states.values()
            if t.status in ("pending", "in_progress", "paused")
        ]

    async def update_task_status(
        self, task_id: str, status: str, resume_context: str | None = None
    ) -> bool:
        task = self._task_states.get(task_id)
        if not task:
            return False
        task.status = status
        task.updated_at = time.time()
        if resume_context:
            task.resume_context = resume_context
        await self._flush_task_states()
        return True

    async def delete_task(self, task_id: str) -> bool:
        if task_id not in self._task_states:
            return False
        del self._task_states[task_id]
        await self._flush_task_states()
        return True

    def record_evolution_metric(self, metric: EvolutionMetric) -> None:
        self._evolution_metrics.append(metric)
        if len(self._evolution_metrics) > 1000:
            self._evolution_metrics = self._evolution_metrics[-1000:]
        self._flush_count += 1
        if self._flush_count >= 10:
            self._flush_evolution_metrics()
            self._flush_count = 0

    def get_evolution_metrics(
        self, metric_type: str | None = None, limit: int | None = None
    ) -> list[EvolutionMetric]:
        metrics = self._evolution_metrics
        if metric_type:
            metrics = [m for m in metrics if m.metric_type == metric_type]
        if limit:
            metrics = metrics[-limit:]
        return metrics

    async def shutdown(self) -> None:
        await self._flush_task_states()
        self._flush_evolution_metrics()
        self._initialized = False

    async def _flush_task_states(self) -> None:
        # P1 修复：加锁防止并发写入数据撕裂
        async with self._flush_lock:
            path = self._data_dir / "task-states.json"
            try:
                data = [
                    {
                        "task_id": t.task_id,
                        "user_id": t.user_id,
                        "description": t.description,
                        "status": t.status,
                        "plan_json": t.plan_json,
                        "current_step_index": t.current_step_index,
                        "step_results_json": t.step_results_json,
                        "created_at": t.created_at,
                        "updated_at": t.updated_at,
                        "resume_context": t.resume_context,
                    }
                    for t in self._task_states.values()
                ]
                # 原子写入：先写临时文件再重命名
                tmp_path = path.with_suffix(".json.tmp")
                tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp_path.replace(path)
            except Exception:
                pass

    async def _load_task_states(self) -> None:
        path = self._data_dir / "task-states.json"
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for item in data:
                task = TaskState(
                    task_id=item.get("task_id", ""),
                    user_id=item.get("user_id", "default"),
                    description=item.get("description", ""),
                    status=item.get("status", "pending"),
                    plan_json=item.get("plan_json"),
                    current_step_index=item.get("current_step_index", 0),
                    step_results_json=item.get("step_results_json"),
                    created_at=item.get("created_at", 0.0),
                    updated_at=item.get("updated_at", 0.0),
                    resume_context=item.get("resume_context"),
                )
                self._task_states[task.task_id] = task
        except Exception:
            pass

    def _flush_evolution_metrics(self) -> None:
        path = self._data_dir / "evolution-metrics.json"
        try:
            data = [
                {
                    "metric_type": m.metric_type,
                    "value": m.value,
                    "timestamp": m.timestamp,
                    "metadata": m.metadata,
                }
                for m in self._evolution_metrics
            ]
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    async def _load_evolution_metrics(self) -> None:
        path = self._data_dir / "evolution-metrics.json"
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self._evolution_metrics = [
                EvolutionMetric(
                    metric_type=m.get("metric_type", ""),
                    value=m.get("value", 0.0),
                    timestamp=m.get("timestamp", 0.0),
                    metadata=m.get("metadata", {}),
                )
                for m in data[-1000:]
            ]
        except Exception:
            pass
