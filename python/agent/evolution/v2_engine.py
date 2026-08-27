from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.core.types import RiskLevel as CoreRiskLevel, BaseCheckpoint

log = StructuredLogger("evolution_v2")


class V2EvolutionType(str, Enum):
    CODE_FIX = "CODE_FIX"
    CODE_OPTIMIZATION = "CODE_OPTIMIZATION"
    PROMPT_IMPROVEMENT = "PROMPT_IMPROVEMENT"
    TOOL_ENHANCEMENT = "TOOL_ENHANCEMENT"
    ARCHITECTURE_CHANGE = "ARCHITECTURE_CHANGE"


class V2EvolutionPriority(str, Enum):
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class V2CauseType(str, Enum):
    FAILURE = "FAILURE"
    LOW_SATISFACTION = "LOW_SATISFACTION"
    BUG_REPORT = "BUG_REPORT"
    PROACTIVE_IMPROVEMENT = "PROACTIVE_IMPROVEMENT"
    PERFORMANCE_ISSUE = "PERFORMANCE_ISSUE"


class V2ActionType(str, Enum):
    MODIFY_FILE = "MODIFY_FILE"
    CREATE_FILE = "CREATE_FILE"
    DELETE_FILE = "DELETE_FILE"
    UPDATE_PROMPT = "UPDATE_PROMPT"
    UPDATE_CONFIG = "UPDATE_CONFIG"


class EvolutionRiskLevel(str, Enum):
    """进化引擎领域风险等级 — 与 core.types.RiskLevel 语义不同。

    SAFE/CAUTIOUS/RESTRICTED/FORBIDDEN 描述自修改安全边界，
    通过 to_core_risk_level() 映射到统一 RiskLevel。
    """

    SAFE = "safe"
    CAUTIOUS = "cautious"
    RESTRICTED = "restricted"
    FORBIDDEN = "forbidden"


_EVOLUTION_TO_CORE_RISK: dict[EvolutionRiskLevel, CoreRiskLevel] = {
    EvolutionRiskLevel.SAFE: CoreRiskLevel.LOW,
    EvolutionRiskLevel.CAUTIOUS: CoreRiskLevel.MEDIUM,
    EvolutionRiskLevel.RESTRICTED: CoreRiskLevel.HIGH,
    EvolutionRiskLevel.FORBIDDEN: CoreRiskLevel.CRITICAL,
}


def to_core_risk_level(level: EvolutionRiskLevel) -> CoreRiskLevel:
    """将进化引擎风险等级映射到统一 RiskLevel。"""
    return _EVOLUTION_TO_CORE_RISK.get(level, CoreRiskLevel.MEDIUM)


RiskLevel = EvolutionRiskLevel


@dataclass
class V2EvolutionCause:
    type: str = ""
    description: str = ""
    context: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0


@dataclass
class V2CodeLocation:
    file_path: str = ""
    line_start: int | None = None
    line_end: int | None = None
    snippet: str = ""


@dataclass
class V2EvolutionAction:
    type: str = ""
    target: str = ""
    content: str = ""
    original_content: str = ""
    description: str = ""


@dataclass
class V2EvolutionPlan:
    id: str = ""
    type: str = ""
    priority: str = "MEDIUM"
    cause: V2EvolutionCause = field(default_factory=V2EvolutionCause)
    title: str = ""
    description: str = ""
    actions: list[V2EvolutionAction] = field(default_factory=list)
    estimated_risk: str = "LOW"
    validation_steps: list[str] = field(default_factory=list)
    created_at: float = 0.0


@dataclass
class V2EvolutionResult:
    plan_id: str = ""
    success: bool = False
    executed_actions: int = 0
    failed_at: int | None = None
    error: str | None = None
    duration: float = 0.0
    validation_passed: bool | None = None
    validation_details: str = ""
    rollback_needed: bool = False
    rollback_success: bool | None = None


@dataclass
class V2RollbackCheckpoint(BaseCheckpoint):
    """进化引擎还原点 — 继承 core.types.BaseCheckpoint。"""

    plan_id: str = ""
    snapshot: dict[str, str] = field(default_factory=dict)


@dataclass
class V2EvolutionHistory:
    plan_id: str = ""
    type: str = ""
    title: str = ""
    success: bool = False
    cause: V2EvolutionCause = field(default_factory=V2EvolutionCause)
    result: V2EvolutionResult = field(default_factory=V2EvolutionResult)
    timestamp: float = 0.0


@dataclass
class V2EvolutionMetrics:
    total_evolutions: int = 0
    success_rate: float = 0.0
    average_duration: float = 0.0
    evolutions_by_type: dict[str, int] = field(default_factory=dict)
    rollback_rate: float = 0.0
    quality_improvement: float = 0.0


@dataclass
class StrategyRecord:
    strategy_type: str = ""
    applied_at: float = 0.0
    outcome: str = "success"
    impact_score: float = 0.0
    context: str = ""


@dataclass
class StrategyRecommendation:
    recommended_type: str = ""
    confidence: float = 0.0
    reasoning: str = ""


@dataclass
class StrategyTrend:
    strategy_type: str = ""
    direction: str = "stable"
    data_points: int = 0
    success_rate: float = 0.0


@dataclass
class ResourcePreloadHint:
    resource_type: str = ""
    probability: float = 0.0
    preload_action: str = ""


@dataclass
class SafetyAssessment:
    risk_level: str = "safe"
    allowed: bool = True
    requires_confirmation: bool = False
    reason: str = ""


@dataclass
class SafetyBoundary:
    path: str = ""
    risk_level: str = "safe"
    violation_count: int = 0
    success_count: int = 0


@dataclass
class CapabilityAssessment:
    can_handle: bool = True
    confidence_level: float = 0.5
    suggested_alternative: str | None = None
    reasoning: str = ""


_ESCALATION_VIOLATION_THRESHOLD = 2
_DE_ESCALATION_SUCCESS_THRESHOLD = 5
_MAX_STRATEGY_RECORDS = 100
_MAX_HISTORY = 200


class LLMClientProtocol(Protocol):
    async def chat(self, system_prompt: str, user_prompt: str) -> str: ...


class EvolutionRollback:
    def __init__(self, checkpoint_dir: str | Path | None = None) -> None:
        if checkpoint_dir is None:
            checkpoint_dir = Path(__file__).resolve().parent.parent.parent / "data" / "evolution" / "checkpoints"
        self._checkpoint_dir = Path(checkpoint_dir)
        self._checkpoint_dir.mkdir(parents=True, exist_ok=True)
        self._checkpoints: dict[str, V2RollbackCheckpoint] = {}
        self._MAX_CHECKPOINTS = 200
        self._load_checkpoints()

    def _load_checkpoints(self) -> None:
        for f in self._checkpoint_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                cp = V2RollbackCheckpoint(
                    id=data.get("id", ""),
                    plan_id=data.get("plan_id", ""),
                    timestamp=data.get("timestamp", 0.0),
                    snapshot=data.get("snapshot", {}),
                )
                self._checkpoints[cp.id] = cp
            except Exception as _exc:
                log.debug("v2_engine 异常处理", error=str(_exc))
                log_ignored(log, "v2_engine.EvolutionRollback._load_checkpoints", _exc)

    def create_checkpoint(self, plan_id: str, actions: list[V2EvolutionAction]) -> V2RollbackCheckpoint:
        snapshot: dict[str, str] = {}
        for action in actions:
            if action.type in ("MODIFY_FILE", "DELETE_FILE"):
                target_path = action.target
                p = Path(target_path)
                if p.exists():
                    try:
                        snapshot[target_path] = p.read_text(encoding="utf-8")
                    except Exception as _exc:
                        log.debug("v2_engine 异常处理", error=str(_exc))
                        log_ignored(log, "v2_engine.EvolutionRollback.create_checkpoint", _exc)

        cp = V2RollbackCheckpoint(
            id=f"checkpoint-{plan_id}-{int(time.time())}",
            plan_id=plan_id,
            timestamp=time.time(),
            snapshot=snapshot,
        )
        self._save_checkpoint(cp)
        self._checkpoints[cp.id] = cp
        if len(self._checkpoints) > self._MAX_CHECKPOINTS:
            sorted_cps = sorted(self._checkpoints.items(), key=lambda x: x[1].timestamp)
            to_remove = sorted_cps[: len(self._checkpoints) - (self._MAX_CHECKPOINTS * 3 // 4)]
            for cid, _ in to_remove:
                del self._checkpoints[cid]
        log.info("Checkpoint created", id=cp.id, files=len(snapshot))
        return cp

    async def rollback(self, checkpoint_id: str) -> dict[str, Any]:
        cp = self._checkpoints.get(checkpoint_id)
        if not cp:
            return {"success": False, "error": f"Checkpoint not found: {checkpoint_id}"}

        try:
            for file_path, original_content in cp.snapshot.items():
                if original_content:
                    Path(file_path).write_text(original_content, encoding="utf-8")
                else:
                    p = Path(file_path)
                    if p.exists():
                        p.unlink()
            log.info("Rollback completed", id=checkpoint_id)
            return {"success": True}
        except Exception as e:
            log.warning("Rollback failed", id=checkpoint_id, error=str(e))
            return {"success": False, "error": str(e)}

    def _save_checkpoint(self, cp: V2RollbackCheckpoint) -> None:
        path = self._checkpoint_dir / f"{cp.id}.json"
        data = {
            "id": cp.id,
            "plan_id": cp.plan_id,
            "timestamp": cp.timestamp,
            "snapshot": cp.snapshot,
        }
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def clean_old_checkpoints(self, days_to_keep: int = 7) -> int:
        cutoff = time.time() - days_to_keep * 24 * 60 * 60
        deleted = 0
        for f in list(self._checkpoint_dir.glob("*.json")):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    deleted += 1
            except Exception as _exc:
                log.debug("v2_engine 异常处理", error=str(_exc))
                log_ignored(log, "v2_engine.EvolutionRollback.clean_old_checkpoints", _exc)
        return deleted


class SelfModificationEngine:
    def __init__(self) -> None:
        self._safety_boundaries: dict[str, SafetyBoundary] = {}
        self._forbidden_paths: set[str] = {"node_modules", ".git", "dist", "build", "__pycache__", ".venv"}
        self._forbidden_delete_paths: set[str] = {"src/main.ts", "src/index.ts", "package.json", "agent/main.py"}
        self._cautious_modify_paths: set[str] = {"src/core/", "src/harness/", "agent/core/"}
        self._strategy_outcomes: list[StrategyRecord] = []
        self._MAX_SAFETY_BOUNDARIES = 1000

    async def execute_plan(self, plan: V2EvolutionPlan, checkpoint_id: str = "") -> V2EvolutionResult:
        start = time.time()
        result = V2EvolutionResult(plan_id=plan.id, success=True)

        for i, action in enumerate(plan.actions):
            log.info("Executing action", index=i + 1, total=len(plan.actions), desc=action.description)
            success = await self._execute_action(action)
            if not success:
                result.success = False
                result.failed_at = i
                result.error = f"Action failed at {i}: {action.description}"
                break
            result.executed_actions += 1

        result.duration = (time.time() - start) * 1000
        return result

    async def _execute_action(self, action: V2EvolutionAction) -> bool:
        try:
            # 安全边界强制：执行任何文件操作前先评估，禁止路径/禁止删除入口文件直接拒绝，
            # 避免 LLM 生成的计划修改/删除 agent/main.py、src/core/ 等受保护路径。
            assessment = self.assess_action_safety(action)
            if not assessment.allowed:
                log.warning(
                    "Action blocked by safety boundary",
                    target=action.target,
                    risk=assessment.risk_level,
                    reason=assessment.reason,
                )
                self.learn_safety_outcome(action, success=False)
                return False
            if action.type == "MODIFY_FILE":
                return self._modify_file(action)
            elif action.type == "CREATE_FILE":
                return self._create_file(action)
            elif action.type == "DELETE_FILE":
                return self._delete_file(action)
            elif action.type == "UPDATE_PROMPT":
                return self._update_prompt(action)
            elif action.type == "UPDATE_CONFIG":
                return self._modify_file(action)
            return False
        except Exception as e:
            log.warning("Action execution failed", error=str(e))
            return False

    def _modify_file(self, action: V2EvolutionAction) -> bool:
        p = Path(action.target)
        if not p.exists():
            return False
        if not action.original_content:
            try:
                action.original_content = p.read_text(encoding="utf-8")
            except Exception as _exc:
                log.debug("v2_engine 异常处理", error=str(_exc))
                log_ignored(log, "v2_engine.SelfModificationEngine._modify_file", _exc)
        try:
            p.write_text(action.content, encoding="utf-8")
            return True
        except Exception as _exc:
            log.warning("异常降级处理", error=str(_exc))
            return False

    def _create_file(self, action: V2EvolutionAction) -> bool:
        p = Path(action.target)
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            p.write_text(action.content, encoding="utf-8")
            return True
        except Exception as _exc:
            log.warning("异常降级处理", error=str(_exc))
            return False

    def _delete_file(self, action: V2EvolutionAction) -> bool:
        p = Path(action.target)
        if p.exists():
            if not action.original_content:
                try:
                    action.original_content = p.read_text(encoding="utf-8")
                except Exception as _exc:
                    log.debug("v2_engine 异常处理", error=str(_exc))
                    log_ignored(log, "v2_engine.SelfModificationEngine._delete_file", _exc)
            p.unlink()
        return True

    def _update_prompt(self, action: V2EvolutionAction) -> bool:
        if not action.target:
            return False
        p = Path(action.target)
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            p.write_text(action.content, encoding="utf-8")
            return True
        except Exception as _exc:
            log.warning("异常降级处理", error=str(_exc))
            return False

    def assess_action_safety(self, action: V2EvolutionAction) -> SafetyAssessment:
        target_path = action.target

        for forbidden in self._forbidden_paths:
            if forbidden in target_path:
                return SafetyAssessment(
                    risk_level="forbidden",
                    allowed=False,
                    requires_confirmation=False,
                    reason=f'路径 "{target_path}" 在禁止列表中',
                )

        if action.type == "DELETE_FILE":
            for forbidden in self._forbidden_delete_paths:
                if target_path.endswith(forbidden) or target_path == forbidden:
                    return SafetyAssessment(
                        risk_level="forbidden",
                        allowed=False,
                        requires_confirmation=False,
                        reason=f"禁止删除入口文件: {target_path}",
                    )

        if action.type == "MODIFY_FILE":
            for cautious in self._cautious_modify_paths:
                if cautious in target_path:
                    return SafetyAssessment(
                        risk_level="cautious",
                        allowed=True,
                        requires_confirmation=True,
                        reason=f"修改核心路径需要确认: {target_path}",
                    )

        boundary = self._safety_boundaries.get(target_path)
        if boundary:
            return SafetyAssessment(
                risk_level=boundary.risk_level,
                allowed=boundary.risk_level != "forbidden",
                requires_confirmation=boundary.risk_level in ("cautious", "restricted"),
                reason=f"历史记录: 成功 {boundary.success_count} 次, 违规 {boundary.violation_count} 次",
            )

        return SafetyAssessment(risk_level="safe", allowed=True, requires_confirmation=False, reason="无历史记录，默认安全")

    def learn_safety_outcome(self, action: V2EvolutionAction, success: bool) -> None:
        if not action.target:
            return
        boundary = self._safety_boundaries.get(action.target)
        if not boundary:
            boundary = SafetyBoundary(path=action.target)
            self._safety_boundaries[action.target] = boundary
            if len(self._safety_boundaries) > self._MAX_SAFETY_BOUNDARIES:
                sorted_boundaries = sorted(self._safety_boundaries.items(), key=lambda x: x[1].success_count + x[1].violation_count)
                to_remove = sorted_boundaries[: len(self._safety_boundaries) - (self._MAX_SAFETY_BOUNDARIES * 3 // 4)]
                for k, _ in to_remove:
                    del self._safety_boundaries[k]

        if success:
            boundary.success_count += 1
            if boundary.success_count >= _DE_ESCALATION_SUCCESS_THRESHOLD:
                boundary.risk_level = "safe"
                boundary.violation_count = 0
        else:
            boundary.violation_count += 1
            if boundary.violation_count >= _ESCALATION_VIOLATION_THRESHOLD:
                boundary.risk_level = "cautious"

    def record_strategy_outcome(self, record: StrategyRecord) -> None:
        self._strategy_outcomes.append(record)
        if len(self._strategy_outcomes) > _MAX_STRATEGY_RECORDS:
            self._strategy_outcomes = self._strategy_outcomes[-_MAX_STRATEGY_RECORDS:]

    def get_resource_preload_hints(self) -> list[ResourcePreloadHint]:
        if len(self._strategy_outcomes) < 3:
            return []

        frequency: dict[str, int] = {}
        for record in self._strategy_outcomes:
            frequency[record.strategy_type] = frequency.get(record.strategy_type, 0) + 1

        total = len(self._strategy_outcomes)
        hints: list[ResourcePreloadHint] = []
        for strategy_type, count in frequency.items():
            prob = count / total
            if prob > 0.1:
                hints.append(ResourcePreloadHint(
                    resource_type=strategy_type,
                    probability=prob,
                    preload_action=f"preload_{strategy_type.lower()}_resources",
                ))
        hints.sort(key=lambda h: h.probability, reverse=True)
        return hints

    def get_safety_report(self) -> dict[str, Any]:
        forbidden: list[str] = list(self._forbidden_paths) + list(self._forbidden_delete_paths)
        restricted: list[str] = []
        cautious: list[str] = []
        safe: list[str] = []

        for boundary in self._safety_boundaries.values():
            if boundary.risk_level == "forbidden":
                forbidden.append(boundary.path)
            elif boundary.risk_level == "restricted":
                restricted.append(boundary.path)
            elif boundary.risk_level == "cautious":
                cautious.append(boundary.path)
            else:
                safe.append(boundary.path)

        return {
            "total_boundaries": len(self._safety_boundaries) + len(self._forbidden_paths),
            "forbidden_paths": forbidden,
            "restricted_paths": restricted,
            "cautious_paths": cautious,
            "safe_paths": safe,
        }


class EvolutionPlanner:
    def __init__(self, llm_client: LLMClientProtocol | None = None) -> None:
        self._llm = llm_client

    async def generate_evolution_plan(self, cause: V2EvolutionCause) -> V2EvolutionPlan:
        plan_id = f"plan-{int(time.time())}-{id(cause) % 10000:04d}"

        if not self._llm:
            return self._fallback_plan(plan_id, cause)

        try:
            system_prompt = self._system_prompt()
            user_prompt = self._user_prompt(cause)
            response = await self._llm.chat(system_prompt, user_prompt)
            return self._parse_response(plan_id, cause, response)
        except Exception as e:
            log.warning("LLM plan generation failed, using fallback", error=str(e))
            return self._fallback_plan(plan_id, cause)

    def _system_prompt(self) -> str:
        return (
            "You are an advanced evolutionary programming assistant. "
            "Generate REAL CODE MODIFICATION plans to fix problems or improve the system.\n"
            "RESPONSE FORMAT (JSON ONLY):\n"
            '{"type": "CODE_FIX|CODE_OPTIMIZATION|PROMPT_IMPROVEMENT|TOOL_ENHANCEMENT|ARCHITECTURE_CHANGE", '
            '"priority": "CRITICAL|HIGH|MEDIUM|LOW", "title": "...", "description": "...", '
            '"actions": [{"type": "MODIFY_FILE|CREATE_FILE|DELETE_FILE|UPDATE_PROMPT|UPDATE_CONFIG", '
            '"target": "file_path", "content": "new content", "description": "..."}], '
            '"estimatedRisk": "LOW|MEDIUM|HIGH", "validationSteps": ["..."]}'
        )

    def _user_prompt(self, cause: V2EvolutionCause) -> str:
        context_details = ""
        if cause.context.get("failureInfo"):
            context_details += f"\nFAILURE INFO:\n{cause.context['failureInfo']}"
        if cause.context.get("satisfactionScore") is not None:
            context_details += f"\nSATISFACTION SCORE: {cause.context['satisfactionScore']}"
        if cause.context.get("performanceMetric"):
            pm = cause.context["performanceMetric"]
            context_details += f"\nPERFORMANCE ISSUE: {pm}"

        return (
            f"EVOLUTION TRIGGER: {cause.type}\n"
            f"DESCRIPTION: {cause.description}\n"
            f"{context_details}\n\n"
            "Analyze this issue and create a REAL evolution plan!"
        )

    def _parse_response(self, plan_id: str, cause: V2EvolutionCause, response: str) -> V2EvolutionPlan:
        json_str = response
        start = response.find("{")
        end = response.rfind("}")
        if start != -1 and end != -1:
            json_str = response[start:end + 1]

        try:
            parsed = json.loads(json_str)
            actions = []
            for a in parsed.get("actions", []):
                actions.append(V2EvolutionAction(
                    type=a.get("type", "MODIFY_FILE"),
                    target=a.get("target", ""),
                    content=a.get("content", ""),
                    description=a.get("description", ""),
                ))
            return V2EvolutionPlan(
                id=plan_id,
                type=parsed.get("type", V2EvolutionType.CODE_FIX),
                priority=parsed.get("priority", "MEDIUM"),
                cause=cause,
                title=parsed.get("title", "Evolution Plan"),
                description=parsed.get("description", cause.description),
                actions=actions,
                estimated_risk=parsed.get("estimatedRisk", "MEDIUM"),
                validation_steps=parsed.get("validationSteps", []),
                created_at=time.time(),
            )
        except json.JSONDecodeError:
            return self._fallback_plan(plan_id, cause)

    def _fallback_plan(self, plan_id: str, cause: V2EvolutionCause) -> V2EvolutionPlan:
        return V2EvolutionPlan(
            id=plan_id,
            type=V2EvolutionType.CODE_FIX,
            priority="MEDIUM",
            cause=cause,
            title="Default repair plan",
            description="Simple plan due to LLM unavailability",
            actions=[],
            estimated_risk="LOW",
            validation_steps=["Check if error resolved"],
            created_at=time.time(),
        )


class EvolutionEngineV2:
    _instance: EvolutionEngineV2 | None = None

    def __init__(
        self,
        llm_client: LLMClientProtocol | None = None,
        checkpoint_dir: str | Path | None = None,
    ) -> None:
        self._rollback = EvolutionRollback(checkpoint_dir)
        self._modifier = SelfModificationEngine()
        self._planner = EvolutionPlanner(llm_client)
        self._history: list[V2EvolutionHistory] = []
        self._is_running = False
        self._strategy_records: list[StrategyRecord] = []
        self._strategy_weights: dict[str, float] = {}
        self._capability_outcomes: dict[str, dict[str, Any]] = {}
        self._MAX_CAPABILITY_DOMAINS = 200
        self._MAX_STRATEGY_WEIGHTS = 100

    @classmethod
    def get_instance(cls, llm_client: LLMClientProtocol | None = None, checkpoint_dir: str | Path | None = None) -> EvolutionEngineV2:
        if cls._instance is None:
            cls._instance = cls(llm_client=llm_client, checkpoint_dir=checkpoint_dir)
        return cls._instance

    async def trigger_evolution(self, cause: V2EvolutionCause) -> V2EvolutionResult | None:
        if self._is_running:
            log.warning("Evolution already in progress, skipping")
            return None

        self._is_running = True
        try:
            log.info("Evolution started", cause_type=cause.type, description=cause.description[:80])
            plan = await self._planner.generate_evolution_plan(cause)
            return await self._execute_plan(plan)
        except Exception as e:
            log.warning("Evolution failed", error=str(e))
            return None
        finally:
            self._is_running = False

    async def _execute_plan(self, plan: V2EvolutionPlan) -> V2EvolutionResult:
        if not plan.actions:
            result = V2EvolutionResult(plan_id=plan.id, success=True)
            self._record_history(plan, result)
            return result

        checkpoint = self._rollback.create_checkpoint(plan.id, plan.actions)

        try:
            result = await self._modifier.execute_plan(plan, checkpoint.id)

            if result.success:
                validation = await self._validate_evolution(plan)
                result.validation_passed = validation.get("passed")
                result.validation_details = validation.get("details", "")
                if not validation.get("passed", True):
                    result.rollback_needed = True

        except Exception as e:
            log.debug("v2_engine 异常处理", error=str(e))
            result = V2EvolutionResult(
                plan_id=plan.id,
                success=False,
                error=str(e),
                rollback_needed=True,
            )

        if result.rollback_needed:
            rollback_result = await self._rollback.rollback(checkpoint.id)
            result.rollback_success = rollback_result.get("success", False)

        self._record_history(plan, result)
        return result

    async def _validate_evolution(self, plan: V2EvolutionPlan) -> dict[str, Any]:
        # 真实验证：对本次计划改动/新建的 .py 文件做 AST 语法检查、.json 做结构检查。
        # 历史实现恒返回 passed=True，导致坏改动不会被发现/回滚（进化质量门失效）。
        import ast

        errors: list[str] = []
        for action in plan.actions:
            if action.type not in ("MODIFY_FILE", "CREATE_FILE", "UPDATE_CONFIG", "UPDATE_PROMPT"):
                continue
            target = action.target or ""
            p = Path(target)
            if target.endswith(".py"):
                if not p.exists():
                    errors.append(f"文件不存在: {target}")
                    continue
                try:
                    ast.parse(p.read_text(encoding="utf-8"), filename=target)
                except SyntaxError as e:
                    errors.append(f"语法错误 {target}: {e.msg} (line {e.lineno})")
                except Exception as e:
                    log.debug("v2_engine 异常处理", error=str(e))
                    errors.append(f"校验失败 {target}: {e}")
            elif target.endswith(".json"):
                if p.exists():
                    try:
                        json.loads(p.read_text(encoding="utf-8"))
                    except Exception as e:
                        log.debug("v2_engine 异常处理", error=str(e))
                        errors.append(f"JSON 无效 {target}: {e}")

        if errors:
            return {"passed": False, "details": "; ".join(errors)}
        return {"passed": True, "details": "校验通过：Python 语法 / JSON 结构检查无误"}

    def _record_history(self, plan: V2EvolutionPlan, result: V2EvolutionResult) -> None:
        self._history.append(V2EvolutionHistory(
            plan_id=plan.id,
            type=plan.type,
            title=plan.title,
            success=result.success and not result.rollback_needed,
            cause=plan.cause,
            result=result,
            timestamp=time.time(),
        ))
        if len(self._history) > _MAX_HISTORY:
            self._history = self._history[-_MAX_HISTORY:]

    def get_history(self, limit: int = 100) -> list[V2EvolutionHistory]:
        return self._history[-limit:]

    def get_metrics(self) -> V2EvolutionMetrics:
        total = len(self._history)
        successful = sum(1 for h in self._history if h.success)
        rolled_back = sum(1 for h in self._history if h.result.rollback_success is True)
        avg_duration = (
            sum(h.result.duration for h in self._history) / total if total > 0 else 0.0
        )

        by_type: dict[str, int] = {}
        for h in self._history:
            by_type[h.type] = by_type.get(h.type, 0) + 1

        return V2EvolutionMetrics(
            total_evolutions=total,
            success_rate=successful / total if total > 0 else 0.0,
            average_duration=avg_duration,
            evolutions_by_type=by_type,
            rollback_rate=rolled_back / total if total > 0 else 0.0,
        )

    async def rollback_to_checkpoint(self, checkpoint_id: str) -> dict[str, Any]:
        return await self._rollback.rollback(checkpoint_id)

    def latest_checkpoint_id(self) -> str | None:
        """返回最近创建的回滚检查点 ID（无则 None）。供能力漂移联动触发回滚。"""
        cps = getattr(self._rollback, "_checkpoints", None)
        if not isinstance(cps, dict) or not cps:
            return None
        return max(cps.items(), key=lambda kv: kv[1].get("timestamp", 0))[0]

    def record_strategy_outcome(self, record: StrategyRecord) -> None:
        self._strategy_records.append(record)
        if len(self._strategy_records) > _MAX_STRATEGY_RECORDS:
            self._strategy_records = self._strategy_records[-_MAX_STRATEGY_RECORDS:]

        current = self._strategy_weights.get(record.strategy_type, 0.5)
        delta = 0.1 if record.outcome == "success" else -0.15
        self._strategy_weights[record.strategy_type] = max(0.0, min(1.0, current + delta))
        if len(self._strategy_weights) > self._MAX_STRATEGY_WEIGHTS:
            sorted_weights = sorted(self._strategy_weights.items(), key=lambda x: x[1])
            to_remove = sorted_weights[: len(self._strategy_weights) - (self._MAX_STRATEGY_WEIGHTS * 3 // 4)]
            for st, _ in to_remove:
                del self._strategy_weights[st]

    def predict_optimal_strategy(self, context: str = "") -> StrategyRecommendation | None:
        if not self._strategy_weights:
            return None

        top_strategy = max(self._strategy_weights, key=self._strategy_weights.get)
        top_weight = self._strategy_weights[top_strategy]

        sample_count = sum(1 for r in self._strategy_records if r.strategy_type == top_strategy)
        confidence = min(0.95, top_weight * (1 - 1 / (sample_count + 1)))

        return StrategyRecommendation(
            recommended_type=top_strategy,
            confidence=confidence,
            reasoning=f"基于 {sample_count} 次历史记录，权重 {top_weight:.2f}",
        )

    def get_strategy_trends(self) -> list[StrategyTrend]:
        trends: list[StrategyTrend] = []
        strategy_types = set(r.strategy_type for r in self._strategy_records)

        for strategy_type in strategy_types:
            records = sorted(
                [r for r in self._strategy_records if r.strategy_type == strategy_type],
                key=lambda r: r.applied_at,
            )
            if not records:
                continue

            success_count = sum(1 for r in records if r.outcome == "success")
            success_rate = success_count / len(records)

            direction = "stable"
            if len(records) >= 4:
                mid = len(records) // 2
                first_rate = sum(1 for r in records[:mid] if r.outcome == "success") / mid
                second_rate = sum(1 for r in records[mid:] if r.outcome == "success") / (len(records) - mid)
                if second_rate - first_rate > 0.2:
                    direction = "improving"
                elif first_rate - second_rate > 0.2:
                    direction = "declining"

            trends.append(StrategyTrend(
                strategy_type=strategy_type,
                direction=direction,
                data_points=len(records),
                success_rate=success_rate,
            ))

        return trends

    def get_resource_preload_hints(self) -> list[ResourcePreloadHint]:
        return self._modifier.get_resource_preload_hints()

    def record_capability_outcome(self, domain: str, success: bool) -> None:
        if domain not in self._capability_outcomes:
            self._capability_outcomes[domain] = {"successes": 0, "failures": 0, "last_seen": 0.0}
        if len(self._capability_outcomes) > self._MAX_CAPABILITY_DOMAINS:
            sorted_domains = sorted(self._capability_outcomes.items(), key=lambda x: x[1].get("last_seen", 0))
            to_remove = sorted_domains[: len(self._capability_outcomes) - (self._MAX_CAPABILITY_DOMAINS * 3 // 4)]
            for d, _ in to_remove:
                del self._capability_outcomes[d]
        record = self._capability_outcomes[domain]
        if success:
            record["successes"] += 1
        else:
            record["failures"] += 1
        record["last_seen"] = time.time()

    def assess_capability(self, domain: str, task: str = "") -> CapabilityAssessment:
        record = self._capability_outcomes.get(domain)
        if not record or (record["successes"] == 0 and record["failures"] == 0):
            return CapabilityAssessment(
                can_handle=True,
                confidence_level=0.5,
                reasoning="无历史记录，默认中等置信度",
            )

        total = record["successes"] + record["failures"]
        success_rate = record["successes"] / total
        confidence = max(0.0, min(1.0, success_rate))

        if success_rate < 0.3 and total >= 3:
            return CapabilityAssessment(
                can_handle=False,
                confidence_level=confidence,
                suggested_alternative="建议委派给更擅长此领域的 agent 或使用辅助工具",
                reasoning=f"成功率仅 {success_rate:.0%}（{total} 次记录）",
            )

        return CapabilityAssessment(
            can_handle=True,
            confidence_level=confidence,
            reasoning=f"成功率 {success_rate:.0%}（{total} 次记录）",
        )

    def get_capability_report(self) -> dict[str, Any]:
        boundaries: list[dict[str, Any]] = []
        weak_areas: list[str] = []
        total_confidence = 0.0

        for domain, record in self._capability_outcomes.items():
            total = record["successes"] + record["failures"]
            success_rate = record["successes"] / total if total > 0 else 0.0
            confidence = max(0.0, min(1.0, success_rate))

            boundaries.append({
                "domain": domain,
                "success_rate": success_rate,
                "total_attempts": total,
                "confidence_level": confidence,
            })
            total_confidence += confidence

            if success_rate < 0.5 and total >= 2:
                weak_areas.append(domain)

        return {
            "total_domains": len(self._capability_outcomes),
            "boundaries": boundaries,
            "weak_areas": weak_areas,
            "average_confidence": total_confidence / len(boundaries) if boundaries else 0.0,
        }
