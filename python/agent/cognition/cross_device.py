"""P2-3: 跨设备协同 — 具身智能多设备调度。

设计目标：
1. 设备注册与发现：动态注册设备，维护设备能力图谱
2. 任务分解与分发：根据设备能力将任务分解并分发到最优设备
3. 状态同步：跨设备状态实时同步，保持一致性
4. 故障转移：主设备失败时自动切换到备用设备
5. 协作编排：多设备并行执行子任务，结果聚合

跨设备协同架构：
  DeviceRegistry（设备注册/发现/能力图谱）
    → TaskDecomposer（任务分解：按设备能力拆分子任务）
      → DeviceScheduler（调度：最优设备分配 + 负载均衡）
        → ExecutionCoordinator（执行协调：并行/串行 + 状态同步）
          → ResultAggregator（结果聚合：合并 + 冲突解决）
            → FaultTolerance（容障：超时/失败 → 重试/切换）

Usage:
    registry = DeviceRegistry()
    registry.register(device)
    coordinator = CrossDeviceCoordinator(registry=registry)
    result = await coordinator.execute_task(task)
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("cross_device")


class DeviceKind(str, Enum):
    DESKTOP = "desktop"
    MOBILE = "mobile"
    TABLET = "tablet"
    IOT = "iot"
    BROWSER = "browser"
    SERVER = "server"
    EMBEDDED = "embedded"


class DeviceStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"
    BUSY = "busy"
    ERROR = "error"
    STANDBY = "standby"


class TaskPriority(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


class SubTaskState(str, Enum):
    PENDING = "pending"
    ASSIGNED = "assigned"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class DeviceCapability:
    name: str = ""
    version: str = "1.0"
    parameters: dict[str, Any] = field(default_factory=dict)
    reliability: float = 0.9
    avg_latency_ms: float = 100.0


@dataclass
class DeviceProfile:
    device_id: str = ""
    name: str = ""
    kind: DeviceKind = DeviceKind.DESKTOP
    status: DeviceStatus = DeviceStatus.OFFLINE
    capabilities: list[DeviceCapability] = field(default_factory=list)
    max_concurrent_tasks: int = 1
    current_load: float = 0.0
    last_heartbeat: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)
    endpoint: str = ""

    @property
    def is_available(self) -> bool:
        return self.status == DeviceStatus.ONLINE and self.current_load < 1.0

    @property
    def capability_names(self) -> set[str]:
        return {c.name for c in self.capabilities}

    def has_capability(self, capability: str) -> bool:
        return capability in self.capability_names

    def get_capability(self, name: str) -> DeviceCapability | None:
        for c in self.capabilities:
            if c.name == name:
                return c
        return None


@dataclass
class SubTask:
    subtask_id: str = ""
    task_id: str = ""
    description: str = ""
    required_capabilities: list[str] = field(default_factory=list)
    assigned_device: str = ""
    state: SubTaskState = SubTaskState.PENDING
    priority: TaskPriority = TaskPriority.NORMAL
    input_data: dict[str, Any] = field(default_factory=dict)
    output_data: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    created_at: float = 0.0
    started_at: float = 0.0
    completed_at: float = 0.0
    timeout_ms: float = 30000.0
    retry_count: int = 0
    max_retries: int = 2
    dependencies: list[str] = field(default_factory=list)


@dataclass
class DeviceTask:
    task_id: str = ""
    description: str = ""
    priority: TaskPriority = TaskPriority.NORMAL
    subtasks: list[SubTask] = field(default_factory=list)
    required_capabilities: list[str] = field(default_factory=list)
    preferred_device: str = ""
    status: str = "pending"
    created_at: float = 0.0
    completed_at: float = 0.0
    result: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


@dataclass
class SchedulingDecision:
    subtask_id: str = ""
    device_id: str = ""
    score: float = 0.0
    reason: str = ""


@dataclass
class CoordinationResult:
    task_id: str = ""
    success: bool = False
    completed_subtasks: int = 0
    failed_subtasks: int = 0
    total_duration_ms: float = 0.0
    devices_used: list[str] = field(default_factory=list)
    results: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    failover_count: int = 0


class DeviceRegistry:
    """设备注册中心 — 设备发现 + 能力图谱维护。"""

    def __init__(self, heartbeat_timeout_s: float = 30.0) -> None:
        self._devices: dict[str, DeviceProfile] = {}
        self._heartbeat_timeout = heartbeat_timeout_s

    def register(self, device: DeviceProfile) -> None:
        device.last_heartbeat = time.time()
        self._devices[device.device_id] = device
        log.info("设备注册", device_id=device.device_id, name=device.name,
                 kind=device.kind.value, caps=len(device.capabilities))

    def unregister(self, device_id: str) -> bool:
        if device_id in self._devices:
            del self._devices[device_id]
            log.info("设备注销", device_id=device_id)
            return True
        return False

    def update_heartbeat(self, device_id: str) -> bool:
        device = self._devices.get(device_id)
        if device:
            device.last_heartbeat = time.time()
            if device.status == DeviceStatus.OFFLINE:
                device.status = DeviceStatus.ONLINE
            return True
        return False

    def get_device(self, device_id: str) -> DeviceProfile | None:
        return self._devices.get(device_id)

    def find_by_capability(self, capability: str) -> list[DeviceProfile]:
        self._check_heartbeats()
        return [d for d in self._devices.values() if d.is_available and d.has_capability(capability)]

    def find_available(self, kind: DeviceKind | None = None) -> list[DeviceProfile]:
        self._check_heartbeats()
        devices = [d for d in self._devices.values() if d.is_available]
        if kind:
            devices = [d for d in devices if d.kind == kind]
        return devices

    def _check_heartbeats(self) -> None:
        now = time.time()
        for device in self._devices.values():
            if device.status == DeviceStatus.ONLINE and (now - device.last_heartbeat) > self._heartbeat_timeout:
                device.status = DeviceStatus.OFFLINE
                log.warning("设备心跳超时", device_id=device.device_id)

    @property
    def device_count(self) -> int:
        return len(self._devices)

    @property
    def online_count(self) -> int:
        return sum(1 for d in self._devices.values() if d.status == DeviceStatus.ONLINE)

    @property
    def all_devices(self) -> dict[str, DeviceProfile]:
        return dict(self._devices)


class DeviceScheduler:
    """设备调度器 — 最优设备分配 + 负载均衡。"""

    def __init__(self, registry: DeviceRegistry) -> None:
        self._registry = registry

    def schedule(self, subtask: SubTask) -> SchedulingDecision | None:
        candidates: list[tuple[float, DeviceProfile]] = []
        for cap_name in subtask.required_capabilities:
            devices = self._registry.find_by_capability(cap_name)
            for device in devices:
                score = self._score_device(device, subtask)
                candidates.append((score, device))
        if not candidates:
            available = self._registry.find_available()
            if available:
                best = max(available, key=lambda d: 1.0 - d.current_load)
                return SchedulingDecision(
                    subtask_id=subtask.subtask_id,
                    device_id=best.device_id,
                    score=0.3,
                    reason="无精确能力匹配，选择负载最低的可用设备",
                )
            return None
        candidates.sort(key=lambda x: x[0], reverse=True)
        best_score, best_device = candidates[0]
        return SchedulingDecision(
            subtask_id=subtask.subtask_id,
            device_id=best_device.device_id,
            score=best_score,
            reason=f"能力匹配+负载最优(负载={best_device.current_load:.0%})",
        )

    def _score_device(self, device: DeviceProfile, subtask: SubTask) -> float:
        score = 0.0
        matched_caps = 0
        for req_cap in subtask.required_capabilities:
            cap = device.get_capability(req_cap)
            if cap:
                matched_caps += 1
                score += cap.reliability * 0.3
                latency_factor = max(0.0, 1.0 - cap.avg_latency_ms / 5000.0)
                score += latency_factor * 0.2
        if subtask.required_capabilities:
            cap_coverage = matched_caps / len(subtask.required_capabilities)
            score += cap_coverage * 0.3
        load_factor = 1.0 - device.current_load
        score += load_factor * 0.2
        return score


class CrossDeviceCoordinator:
    """跨设备协同协调器 — 任务分解 + 调度 + 执行 + 聚合。"""

    def __init__(
        self,
        registry: DeviceRegistry | None = None,
        max_parallel: int = 3,
        default_timeout_ms: float = 30000.0,
        execution_handler: Any | None = None,
    ) -> None:
        self._registry = registry or DeviceRegistry()
        self._scheduler = DeviceScheduler(self._registry)
        self._max_parallel = max_parallel
        self._default_timeout = default_timeout_ms
        self._active_tasks: dict[str, DeviceTask] = {}
        self._execution_log: list[dict[str, Any]] = []
        self._execution_handler = execution_handler

    def register_device(self, device: DeviceProfile) -> None:
        self._registry.register(device)

    def unregister_device(self, device_id: str) -> bool:
        return self._registry.unregister(device_id)

    async def execute_task(
        self,
        description: str,
        required_capabilities: list[str] | None = None,
        preferred_device: str = "",
        priority: TaskPriority = TaskPriority.NORMAL,
        subtask_defs: list[dict[str, Any]] | None = None,
        rollback_on_failure: bool = True,
    ) -> CoordinationResult:
        start = time.time()
        task = DeviceTask(
            task_id=f"task_{uuid.uuid4().hex[:12]}",
            description=description,
            priority=priority,
            required_capabilities=required_capabilities or [],
            preferred_device=preferred_device,
            created_at=start,
        )

        if subtask_defs:
            for std in subtask_defs:
                sub = SubTask(
                    subtask_id=f"st_{uuid.uuid4().hex[:8]}",
                    task_id=task.task_id,
                    description=std.get("description", ""),
                    required_capabilities=std.get("capabilities", []),
                    priority=priority,
                    input_data=std.get("input", {}),
                    timeout_ms=std.get("timeout_ms", self._default_timeout),
                    max_retries=std.get("max_retries", 2),
                    dependencies=std.get("dependencies", []),
                    created_at=time.time(),
                )
                task.subtasks.append(sub)
        else:
            sub = SubTask(
                subtask_id=f"st_{uuid.uuid4().hex[:8]}",
                task_id=task.task_id,
                description=description,
                required_capabilities=required_capabilities or [],
                priority=priority,
                created_at=time.time(),
            )
            task.subtasks.append(sub)

        self._active_tasks[task.task_id] = task
        devices_used: set[str] = set()
        failover_count = 0
        completed_subtasks: list[SubTask] = []

        for subtask in task.subtasks:
            decision = self._scheduler.schedule(subtask)
            if not decision:
                subtask.state = SubTaskState.FAILED
                subtask.error = "无可用设备"
                task.errors.append(f"子任务{subtask.subtask_id}：无可用设备")
                continue
            subtask.assigned_device = decision.device_id
            subtask.state = SubTaskState.ASSIGNED
            devices_used.add(decision.device_id)

        assigned = [s for s in task.subtasks if s.state == SubTaskState.ASSIGNED]
        assigned = self._topological_sort(assigned)
        for i in range(0, len(assigned), self._max_parallel):
            batch = assigned[i:i + self._max_parallel]
            results = await asyncio.gather(
                *[self._execute_subtask(s) for s in batch], return_exceptions=True
            )
            for subtask, result in zip(batch, results):
                if isinstance(result, Exception):
                    subtask.state = SubTaskState.FAILED
                    subtask.error = str(result)
                    fo = await self._try_failover(subtask)
                    if fo:
                        failover_count += 1
                        devices_used.add(subtask.assigned_device)
                elif result:
                    subtask.state = SubTaskState.COMPLETED
                    subtask.output_data = result
                    completed_subtasks.append(subtask)
                else:
                    subtask.state = SubTaskState.FAILED
                    subtask.error = "执行返回空结果"
                    fo = await self._try_failover(subtask)
                    if fo:
                        failover_count += 1
                        devices_used.add(subtask.assigned_device)

        completed = sum(1 for s in task.subtasks if s.state == SubTaskState.COMPLETED)
        failed = sum(1 for s in task.subtasks if s.state == SubTaskState.FAILED)
        success = failed == 0 and completed > 0
        duration_ms = (time.time() - start) * 1000

        if not success and rollback_on_failure and completed_subtasks:
            log.warning("跨设备任务失败，回滚已完成子任务",
                        task_id=task.task_id, completed=len(completed_subtasks))
            for cst in completed_subtasks:
                cst.state = SubTaskState.CANCELLED
                cst.output_data = {}
            completed = 0

        task.status = "completed" if success else "failed"
        task.completed_at = time.time()
        task.result = {s.subtask_id: s.output_data for s in task.subtasks if s.state == SubTaskState.COMPLETED}

        coord_result = CoordinationResult(
            task_id=task.task_id,
            success=success,
            completed_subtasks=completed,
            failed_subtasks=failed,
            total_duration_ms=duration_ms,
            devices_used=list(devices_used),
            results=task.result,
            errors=task.errors,
            failover_count=failover_count,
        )
        log.info("跨设备任务完成", task_id=task.task_id,
                 success=success, completed=completed, failed=failed,
                 devices=len(devices_used), failover=failover_count,
                 duration_ms=f"{duration_ms:.0f}")
        return coord_result

    async def _execute_subtask(self, subtask: SubTask) -> dict[str, Any] | None:
        subtask.state = SubTaskState.RUNNING
        subtask.started_at = time.time()
        device = self._registry.get_device(subtask.assigned_device)
        if not device or not device.is_available:
            return None
        device.current_load = min(1.0, device.current_load + 0.3)
        try:
            if self._execution_handler is not None:
                result = await self._execution_handler(
                    device=device,
                    subtask=subtask,
                )
            else:
                await asyncio.sleep(0.01)
                result = {"status": "simulated", "device": subtask.assigned_device}
            subtask.state = SubTaskState.COMPLETED
            subtask.completed_at = time.time()
            subtask.output_data = result or {}
            return result
        except Exception as e:
            subtask.state = SubTaskState.FAILED
            subtask.error = str(e)
            return None
        finally:
            device.current_load = max(0.0, device.current_load - 0.3)

    async def _try_failover(self, subtask: SubTask) -> bool:
        if subtask.retry_count >= subtask.max_retries:
            return False
        original_device = subtask.assigned_device
        subtask.retry_count += 1
        subtask.state = SubTaskState.PENDING
        decision = self._scheduler.schedule(subtask)
        if not decision or decision.device_id == original_device:
            return False
        subtask.assigned_device = decision.device_id
        subtask.state = SubTaskState.ASSIGNED
        result = await self._execute_subtask(subtask)
        if result:
            subtask.state = SubTaskState.COMPLETED
            subtask.output_data = result
            log.info("故障转移成功", subtask_id=subtask.subtask_id,
                     from_device=original_device, to_device=decision.device_id)
            return True
        subtask.state = SubTaskState.FAILED
        return False

    def get_task_status(self, task_id: str) -> DeviceTask | None:
        return self._active_tasks.get(task_id)

    @staticmethod
    def _topological_sort(subtasks: list[SubTask]) -> list[SubTask]:
        """按依赖关系拓扑排序子任务，无依赖的保持原序。"""
        if not subtasks:
            return subtasks
        id_map = {s.subtask_id: s for s in subtasks}
        in_degree: dict[str, int] = {s.subtask_id: 0 for s in subtasks}
        graph: dict[str, list[str]] = {s.subtask_id: [] for s in subtasks}
        for s in subtasks:
            for dep in s.dependencies:
                if dep in id_map:
                    graph[dep].append(s.subtask_id)
                    in_degree[s.subtask_id] += 1
        queue = [sid for sid, deg in in_degree.items() if deg == 0]
        result: list[SubTask] = []
        while queue:
            sid = queue.pop(0)
            result.append(id_map[sid])
            for neighbor in graph[sid]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)
        remaining = [id_map[sid] for sid in id_map if sid not in {s.subtask_id for s in result}]
        return result + remaining

    async def sync_device_state(self, device_id: str, state_update: dict[str, Any]) -> bool:
        """同步设备状态更新。"""
        device = self._registry.get_device(device_id)
        if not device:
            return False
        if "status" in state_update:
            try:
                device.status = DeviceStatus(state_update["status"])
            except ValueError:
                pass
        if "load" in state_update:
            device.current_load = float(state_update["load"])
        if "capabilities" in state_update:
            caps_data = state_update["capabilities"]
            if isinstance(caps_data, list):
                device.capabilities = [
                    DeviceCapability(
                        name=c.get("name", ""),
                        reliability=c.get("reliability", 0.9),
                        avg_latency_ms=c.get("avg_latency_ms", 100.0),
                    ) if isinstance(c, dict) else c
                    for c in caps_data
                ]
        device.metadata.update(state_update.get("metadata", {}))
        self._registry.update_heartbeat(device_id)
        log.info("设备状态同步", device_id=device_id, updates=list(state_update.keys()))
        return True

    def save_state(self) -> dict[str, Any]:
        """序列化设备注册表为可持久化字典。"""
        devices_data = {}
        for did, device in self._registry.all_devices.items():
            devices_data[did] = {
                "device_id": device.device_id,
                "name": device.name,
                "kind": device.kind.value,
                "status": device.status.value,
                "capabilities": [
                    {"name": c.name, "reliability": c.reliability, "avg_latency_ms": c.avg_latency_ms}
                    for c in device.capabilities
                ],
                "max_concurrent_tasks": device.max_concurrent_tasks,
                "current_load": device.current_load,
                "endpoint": device.endpoint,
            }
        return {"devices": devices_data, "active_tasks": len(self._active_tasks)}

    def load_state(self, data: dict[str, Any]) -> None:
        """从持久化字典恢复设备注册表。"""
        devices_data = data.get("devices", {})
        for did, ddata in devices_data.items():
            if did not in self._registry.all_devices:
                device = DeviceProfile(
                    device_id=ddata["device_id"],
                    name=ddata.get("name", ""),
                    kind=DeviceKind(ddata.get("kind", "desktop")),
                    status=DeviceStatus(ddata.get("status", "offline")),
                    capabilities=[
                        DeviceCapability(name=c["name"], reliability=c.get("reliability", 0.9),
                                         avg_latency_ms=c.get("avg_latency_ms", 100.0))
                        for c in ddata.get("capabilities", [])
                    ],
                    max_concurrent_tasks=ddata.get("max_concurrent_tasks", 1),
                    current_load=ddata.get("current_load", 0.0),
                    endpoint=ddata.get("endpoint", ""),
                )
                self._registry.register(device)
        log.info("跨设备状态恢复", devices_loaded=len(devices_data))

    @property
    def registry(self) -> DeviceRegistry:
        return self._registry
