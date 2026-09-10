"""P2 认知层 API 路由 — 世界模型 + 持续学习 + 跨设备协同。

端点:
  POST /v1/cognition/predict       — 世界模型预判
  POST /v1/cognition/simulate      — 模拟推演
  POST /v1/cognition/surprise      — 意外检测
  POST /v1/learning/record         — 记录经验
  POST /v1/learning/learn          — 触发学习
  POST /v1/learning/knowledge      — 检索知识
  POST /v1/devices/register        — 注册设备
  POST /v1/devices/execute         — 跨设备执行任务
  GET  /v1/devices/list            — 列出设备
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("api_cognition")

router = APIRouter(tags=["cognition", "learning", "devices"])

_world_model: Any = None
_learning_loop: Any = None
_coordinator: Any = None


def _get_world_model() -> Any:
    global _world_model
    if _world_model is None:
        from agent.cognition.world_model import WorldModel
        _world_model = WorldModel()
    return _world_model


def _get_learning_loop() -> Any:
    global _learning_loop
    if _learning_loop is None:
        from agent.cognition.continual_learning import ContinualLearningLoop
        _learning_loop = ContinualLearningLoop()
    return _learning_loop


def _get_coordinator() -> Any:
    global _coordinator
    if _coordinator is None:
        from agent.cognition.cross_device import CrossDeviceCoordinator
        _coordinator = CrossDeviceCoordinator()
    return _coordinator


class PredictRequest(BaseModel):
    action: str = Field(..., description="动作名称")
    target: str = Field("", description="目标实体")
    current_state: dict[str, Any] | None = Field(None, description="当前状态")


class PredictResponse(BaseModel):
    prediction_id: str
    confidence: float
    confidence_level: str
    reasoning: str
    risks: list[str]
    estimated_duration_ms: float


class SimulateRequest(BaseModel):
    action_sequence: list[dict[str, str]] = Field(..., description="动作序列")
    horizon: int | None = Field(None, description="模拟步数上限")


class SimulateResponse(BaseModel):
    simulation_id: str
    total_confidence: float
    total_duration_ms: float
    is_feasible: bool
    failure_reason: str
    steps: int


class SurpriseRequest(BaseModel):
    expected_state: dict[str, Any] = Field(..., description="预期状态")
    actual_state: dict[str, Any] = Field(..., description="实际状态")
    threshold: float = Field(0.3, description="意外阈值")


class SurpriseResponse(BaseModel):
    report_id: str
    surprise_score: float
    is_surprising: bool
    surprises: list[str]


class RecordExperienceRequest(BaseModel):
    task: str = Field(..., description="任务描述")
    action: str = Field(..., description="执行动作")
    outcome: str = Field(..., description="结果描述")
    success: bool = Field(True, description="是否成功")
    quality_score: float = Field(0.5, description="质量评分")
    duration_ms: float = Field(0.0, description="耗时(ms)")
    tools_used: list[str] = Field(default_factory=list, description="使用的工具")
    strategy_used: str = Field("", description="使用的策略")


class RecordExperienceResponse(BaseModel):
    experience_id: str
    type: str


class LearnResponse(BaseModel):
    report_id: str
    total_experiences: int
    new_patterns_found: int
    adjustments_made: int
    knowledge_solidified: int
    knowledge_decayed: int


class KnowledgeQueryRequest(BaseModel):
    query: str = Field(..., description="查询文本")
    category: str | None = Field(None, description="知识类别")
    domain: str | None = Field(None, description="领域")
    top_k: int = Field(5, description="返回数量")


class KnowledgeQueryResponse(BaseModel):
    results: list[dict[str, Any]]


class DeviceRegisterRequest(BaseModel):
    device_id: str = Field(..., description="设备ID")
    name: str = Field("", description="设备名称")
    kind: str = Field("desktop", description="设备类型")
    capabilities: list[dict[str, Any]] = Field(default_factory=list, description="设备能力")
    endpoint: str = Field("", description="设备端点")


class DeviceRegisterResponse(BaseModel):
    device_id: str
    registered: bool


class DeviceExecuteRequest(BaseModel):
    description: str = Field(..., description="任务描述")
    required_capabilities: list[str] = Field(default_factory=list, description="所需能力")
    preferred_device: str = Field("", description="首选设备")
    priority: str = Field("normal", description="优先级")
    subtasks: list[dict[str, Any]] | None = Field(None, description="子任务定义")


class DeviceExecuteResponse(BaseModel):
    task_id: str
    success: bool
    completed_subtasks: int
    failed_subtasks: int
    total_duration_ms: float
    devices_used: list[str]
    failover_count: int


@router.post("/cognition/predict", response_model=PredictResponse)
async def predict(req: PredictRequest) -> Any:
    model = _get_world_model()
    state = await model.build_current_state(req.current_state)
    pred = await model.predict(state, req.action, req.target)
    return PredictResponse(
        prediction_id=pred.prediction_id,
        confidence=pred.confidence,
        confidence_level=pred.confidence_level.value,
        reasoning=pred.reasoning,
        risks=pred.risks,
        estimated_duration_ms=pred.estimated_duration_ms,
    )


@router.post("/cognition/simulate", response_model=SimulateResponse)
async def simulate(req: SimulateRequest) -> Any:
    model = _get_world_model()
    state = await model.build_current_state()
    result = await model.simulate(state, req.action_sequence, req.horizon)
    return SimulateResponse(
        simulation_id=result.simulation_id,
        total_confidence=result.total_confidence,
        total_duration_ms=result.total_duration_ms,
        is_feasible=result.is_feasible,
        failure_reason=result.failure_reason,
        steps=len(result.actions),
    )


@router.post("/cognition/surprise", response_model=SurpriseResponse)
async def detect_surprise(req: SurpriseRequest) -> Any:
    from agent.cognition.world_model import WorldState, Entity, EntityState
    model = _get_world_model()

    def _parse_state(data: dict[str, Any], state_id: str) -> WorldState:
        state = WorldState(state_id=state_id, entities={})
        for ed in data.get("entities", []):
            if isinstance(ed, dict):
                eid = ed.get("id", ed.get("entity_id", ""))
                if not eid:
                    continue
                state.entities[eid] = Entity(
                    entity_id=eid,
                    name=ed.get("name", ""),
                    state=EntityState(ed.get("state", "unknown")),
                    visible=ed.get("visible", True),
                    enabled=ed.get("enabled", True),
                )
        state.environment = data.get("environment", {})
        return state

    expected = _parse_state(req.expected_state, "expected")
    actual = _parse_state(req.actual_state, "actual")
    report = await model.detect_surprise(expected, actual, req.threshold)
    return SurpriseResponse(
        report_id=report.report_id,
        surprise_score=report.surprise_score,
        is_surprising=report.is_surprising,
        surprises=report.surprises,
    )


@router.post("/learning/record", response_model=RecordExperienceResponse)
async def record_experience(req: RecordExperienceRequest) -> Any:
    loop = _get_learning_loop()
    exp = loop.record_experience(
        task=req.task, action=req.action, outcome=req.outcome,
        success=req.success, quality_score=req.quality_score,
        duration_ms=req.duration_ms, tools_used=req.tools_used,
        strategy_used=req.strategy_used,
    )
    return RecordExperienceResponse(experience_id=exp.experience_id, type=exp.type.value)


@router.post("/learning/learn", response_model=LearnResponse)
async def trigger_learning() -> Any:
    loop = _get_learning_loop()
    report = await loop.learn()
    return LearnResponse(
        report_id=report.report_id,
        total_experiences=report.total_experiences,
        new_patterns_found=report.new_patterns_found,
        adjustments_made=report.adjustments_made,
        knowledge_solidified=report.knowledge_solidified,
        knowledge_decayed=report.knowledge_decayed,
    )


@router.post("/learning/knowledge", response_model=KnowledgeQueryResponse)
async def query_knowledge(req: KnowledgeQueryRequest) -> Any:
    from agent.cognition.continual_learning import KnowledgeCategory
    loop = _get_learning_loop()
    cat = KnowledgeCategory(req.category) if req.category else None
    entries = loop.retrieve_relevant_knowledge(req.query, cat, req.domain, req.top_k)
    results = [
        {"entry_id": e.entry_id, "title": e.title, "content": e.content,
         "category": e.category.value, "weight": e.weight, "decay_score": e.decay_score}
        for e in entries
    ]
    return KnowledgeQueryResponse(results=results)


@router.post("/devices/register", response_model=DeviceRegisterResponse)
async def register_device(req: DeviceRegisterRequest) -> Any:
    from agent.cognition.cross_device import DeviceProfile, DeviceKind, DeviceCapability
    coord = _get_coordinator()
    try:
        kind = DeviceKind(req.kind)
    except ValueError:
        kind = DeviceKind.DESKTOP
    caps = [DeviceCapability(name=c.get("name", ""), reliability=c.get("reliability", 0.9),
                             avg_latency_ms=c.get("avg_latency_ms", 100.0)) for c in req.capabilities]
    device = DeviceProfile(device_id=req.device_id, name=req.name, kind=kind,
                           capabilities=caps, endpoint=req.endpoint)
    coord.register_device(device)
    return DeviceRegisterResponse(device_id=req.device_id, registered=True)


@router.post("/devices/execute", response_model=DeviceExecuteResponse)
async def execute_task(req: DeviceExecuteRequest) -> Any:
    from agent.cognition.cross_device import TaskPriority
    coord = _get_coordinator()
    try:
        priority = TaskPriority(req.priority)
    except ValueError:
        priority = TaskPriority.NORMAL
    result = await coord.execute_task(
        description=req.description,
        required_capabilities=req.required_capabilities,
        preferred_device=req.preferred_device,
        priority=priority,
        subtask_defs=req.subtasks,
    )
    return DeviceExecuteResponse(
        task_id=result.task_id, success=result.success,
        completed_subtasks=result.completed_subtasks,
        failed_subtasks=result.failed_subtasks,
        total_duration_ms=result.total_duration_ms,
        devices_used=result.devices_used,
        failover_count=result.failover_count,
    )


@router.get("/devices/list")
async def list_devices() -> dict[str, Any]:
    coord = _get_coordinator()
    devices = coord.registry.all_devices
    return {
        "total": len(devices),
        "online": coord.registry.online_count,
        "devices": [
            {"device_id": d.device_id, "name": d.name, "kind": d.kind.value,
             "status": d.status.value, "capabilities": list(d.capability_names),
             "load": d.current_load}
            for d in devices.values()
        ],
    }


class DeviceSyncRequest(BaseModel):
    device_id: str = Field(..., description="设备ID")
    status: str | None = Field(None, description="设备状态")
    load: float | None = Field(None, description="当前负载")
    capabilities: list[dict[str, Any]] | None = Field(None, description="能力列表")
    metadata: dict[str, Any] | None = Field(None, description="元数据")


@router.post("/devices/sync")
async def sync_device(req: DeviceSyncRequest) -> dict[str, Any]:
    update: dict[str, Any] = {}
    if req.status is not None:
        update["status"] = req.status
    if req.load is not None:
        update["load"] = req.load
    if req.capabilities is not None:
        update["capabilities"] = req.capabilities
    if req.metadata is not None:
        update["metadata"] = req.metadata
    coord = _get_coordinator()
    ok = await coord.sync_device_state(req.device_id, update)
    return {"device_id": req.device_id, "synced": ok}


@router.get("/cognition/state")
async def get_cognition_state() -> dict[str, Any]:
    model = _get_world_model()
    loop = _get_learning_loop()
    coord = _get_coordinator()
    return {
        "world_model": model.save_state(),
        "learning": loop.save_state(),
        "devices": coord.save_state(),
    }


class TransferLearningRequest(BaseModel):
    source_domain: str = Field(..., description="源领域")
    target_domain: str = Field(..., description="目标领域")
    min_weight: float = Field(0.5, description="最低权重阈值")


@router.post("/learning/transfer")
async def transfer_learning(req: TransferLearningRequest) -> dict[str, Any]:
    """迁移学习 — 将源领域知识迁移到目标领域。"""
    loop = _get_learning_loop()
    count = loop.transfer_knowledge(
        source_domain=req.source_domain,
        target_domain=req.target_domain,
        min_weight=req.min_weight,
    )
    return {"source": req.source_domain, "target": req.target_domain, "transferred": count}


class BranchSimulateRequest(BaseModel):
    initial_state: dict[str, Any] = Field(..., description="初始世界状态")
    action_sequence: list[dict[str, str]] = Field(..., description="动作序列")
    num_branches: int = Field(3, description="分支数量")
    horizon: int | None = Field(None, description="模拟步数上限")


@router.post("/cognition/simulate_branches")
async def simulate_branches(req: BranchSimulateRequest) -> dict[str, Any]:
    """蒙特卡洛分支模拟 — 多分支探索最优执行路径。"""
    from agent.cognition.world_model import WorldState, Entity, EntityState
    model = _get_world_model()

    def _parse_state(data: dict[str, Any], state_id: str) -> WorldState:
        state = WorldState(state_id=state_id, entities={})
        for ed in data.get("entities", []):
            if isinstance(ed, dict):
                eid = ed.get("id", ed.get("entity_id", ""))
                if not eid:
                    continue
                state.entities[eid] = Entity(
                    entity_id=eid,
                    name=ed.get("name", ""),
                    state=EntityState(ed.get("state", "unknown")),
                    visible=ed.get("visible", True),
                    enabled=ed.get("enabled", True),
                )
        state.environment = data.get("environment", {})
        return state

    initial = _parse_state(req.initial_state, "initial")
    result = await model.simulate(
        initial, req.action_sequence,
        horizon=req.horizon, num_branches=req.num_branches,
    )
    return {
        "feasible": result.is_feasible,
        "total_confidence": result.total_confidence,
        "steps": len(result.actions),
        "failure_reason": result.failure_reason,
    }
