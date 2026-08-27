from fastapi import APIRouter
from fastapi.responses import JSONResponse

from agent.models.plan import (
    EvaluateRequest,
    EvaluateResponse,
    ExecuteRequest,
    ExecuteResponse,
    PlanRequest,
    PlanResponse,
    PlanStep,
    ReflectRequest,
    ReflectResponse,
)

router = APIRouter()

_MAX_TASK_LENGTH = 2000
_MAX_STEPS = 50
_MAX_STEP_DESC_LENGTH = 5000


def get_engine():
    from agent.main import engine
    return engine


def _engine_unavailable():
    return JSONResponse(
        status_code=503,
        content={"detail": "Agent engine not initialized"},
    )


@router.post("/plan", response_model=PlanResponse)
async def plan(req: PlanRequest) -> PlanResponse:
    eng = get_engine()
    if not eng:
        return _engine_unavailable()
    if not req.task or not req.task.strip():
        return JSONResponse(status_code=400, content={"detail": "task is required"})
    if len(req.task) > _MAX_TASK_LENGTH:
        return JSONResponse(status_code=400, content={"detail": f"task too long (max {_MAX_TASK_LENGTH} chars)"})
    messages = [
        {"role": "system", "content": "你是一个任务规划专家。请将用户任务分解为具体步骤，以JSON格式输出。"},
        {"role": "user", "content": f"请规划以下任务：{req.task[:_MAX_TASK_LENGTH]}"},
    ]
    result = await eng.llm.chat(messages=messages)
    return PlanResponse(
        session_id=req.session_id,
        trace_id=f"plan_{req.session_id}",
        steps=[PlanStep(step_id=1, description=result.get("content", ""))],
        reasoning=result.get("content", ""),
    )


@router.post("/execute", response_model=ExecuteResponse)
async def execute(req: ExecuteRequest) -> ExecuteResponse:
    eng = get_engine()
    if not eng:
        return _engine_unavailable()
    if not req.steps:
        return JSONResponse(status_code=400, content={"detail": "steps are required"})
    if len(req.steps) > _MAX_STEPS:
        return JSONResponse(status_code=400, content={"detail": f"too many steps (max {_MAX_STEPS})"})
    from agent.models.plan import ExecuteStepResult
    results = []
    for step in req.steps:
        messages = [
            {"role": "system", "content": "你是任务执行专家。请执行给定的步骤。"},
            {"role": "user", "content": f"执行步骤: {step.description[:_MAX_STEP_DESC_LENGTH]}"},
        ]
        result = await eng.llm.chat(messages=messages)
        results.append(ExecuteStepResult(
            step_id=step.step_id,
            success=True,
            output=result.get("content", ""),
        ))
    return ExecuteResponse(
        session_id=req.session_id,
        trace_id=f"exec_{req.session_id}",
        results=results,
    )


@router.post("/evaluate", response_model=EvaluateResponse)
async def evaluate(req: EvaluateRequest) -> EvaluateResponse:
    eng = get_engine()
    if not eng:
        return _engine_unavailable()
    if not req.task or not req.task.strip():
        return JSONResponse(status_code=400, content={"detail": "task is required"})
    if len(req.task) > _MAX_TASK_LENGTH:
        return JSONResponse(status_code=400, content={"detail": f"task too long (max {_MAX_TASK_LENGTH} chars)"})
    messages = [
        {"role": "system", "content": "你是任务评估专家。请评估执行结果的质量。"},
        {"role": "user", "content": f"评估任务: {req.task[:_MAX_TASK_LENGTH]}\n结果: {[r.model_dump() for r in req.results]}"},
    ]
    result = await eng.llm.chat(messages=messages)
    return EvaluateResponse(
        session_id=req.session_id,
        trace_id=f"eval_{req.session_id}",
        score=0.7,
        passed=True,
        feedback=result.get("content", ""),
    )


@router.post("/reflect", response_model=ReflectResponse)
async def reflect(req: ReflectRequest) -> ReflectResponse:
    eng = get_engine()
    if not eng:
        return _engine_unavailable()
    if not req.task or not req.task.strip():
        return JSONResponse(status_code=400, content={"detail": "task is required"})
    if len(req.task) > _MAX_TASK_LENGTH:
        return JSONResponse(status_code=400, content={"detail": f"task too long (max {_MAX_TASK_LENGTH} chars)"})
    messages = [
        {"role": "system", "content": "你是反思专家。请分析任务执行过程，找出改进点。"},
        {"role": "user", "content": f"反思任务: {req.task[:_MAX_TASK_LENGTH]}"},
    ]
    result = await eng.llm.chat(messages=messages)
    return ReflectResponse(
        session_id=req.session_id,
        trace_id=f"reflect_{req.session_id}",
        reflection=result.get("content", ""),
    )
