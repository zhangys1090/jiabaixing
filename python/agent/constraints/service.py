from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from agent.core.logger import StructuredLogger
from agent.security.sensitive_detector import (
    CheckScene,
    RiskLevel,
    check_dangerous_command,
    check_sensitive_info,
)

log = StructuredLogger("constraints")


class ConstraintLevel(str, Enum):
    HARD = "hard"
    SOFT = "soft"
    ADVISORY = "advisory"


class LifecycleEvent(str, Enum):
    BEFORE_LOOP = "before_loop"
    BEFORE_TOOL_CALL = "before_tool_call"
    AFTER_TOOL_CALL = "after_tool_call"
    BEFORE_RESPONSE = "before_response"
    AFTER_RESPONSE = "after_response"
    ON_ERROR = "on_error"
    ON_BUDGET_EXCEEDED = "on_budget_exceeded"
    ON_PLAN_CREATED = "on_plan_created"
    ON_STEP_COMPLETED = "on_step_completed"


@dataclass
class Permission:
    name: str


PERMISSION_MEMORY_READ = Permission("memory:read")
PERMISSION_MEMORY_WRITE = Permission("memory:write")
PERMISSION_FILE_READ = Permission("file:read")
PERMISSION_FILE_WRITE = Permission("file:write")
PERMISSION_DESKTOP_CONTROL = Permission("desktop:control")
PERMISSION_NETWORK_ACCESS = Permission("network:access")
PERMISSION_CODE_EXECUTE = Permission("code:execute")
PERMISSION_SYSTEM_ADMIN = Permission("system:admin")


@dataclass
class ToolContext:
    user_id: str | None = None
    trace_id: str | None = None
    permissions: set[Permission] = field(default_factory=set)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class HookContext:
    event: LifecycleEvent
    tool_name: str | None = None
    params: dict[str, Any] | None = None
    result: Any | None = None
    loop_state: str | None = None
    budget_state: Any | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class HookResult:
    proceed: bool = True
    modified_params: dict[str, Any] | None = None
    replacement_result: Any | None = None
    reason: str | None = None


@dataclass
class BudgetState:
    rounds_used: int = 0
    soft_round_limit: int = 5
    hard_round_limit: int = 8
    tokens_used: int = 0
    token_warning_limit: int = 5000
    token_hard_limit: int = 8000
    start_time: float = 0.0
    max_duration_ms: int = 120000
    tool_calls_used: int = 0
    max_tool_calls: int = 20
    agent_native: bool = False
    verification_level: str = "full"


@dataclass
class BudgetCheckResult:
    within_budget: bool = True
    hard_limit_exceeded: bool = False
    warnings: list[str] = field(default_factory=list)
    remaining: dict[str, int | float] = field(default_factory=dict)


@dataclass
class PermissionResult:
    allowed: bool = True
    missing: list[str] = field(default_factory=list)
    reason: str | None = None


@dataclass
class ConstraintDefinition:
    name: str
    level: ConstraintLevel
    description: str


@dataclass
class BudgetAllocation:
    """预算分配方案——单次任务执行的资源上限。

    P2 #15: 增加 estimated_ms 和 confidence 字段，支持基于历史数据的时间预算预估。

    Attributes:
        max_rounds: 最大循环轮次。
        max_tool_calls: 最大工具调用次数。
        max_tokens: 最大 Token 数。
        max_duration_ms: 最大执行时长（毫秒）。
        estimated_ms: 基于历史数据的预估耗时（毫秒），无历史数据时为 None。
        confidence: 预估置信度（low/medium/high），无历史数据时为 None。
    """

    max_rounds: int = 5
    max_tool_calls: int = 10
    max_tokens: int = 5000
    max_duration_ms: int = 60000
    estimated_ms: int | None = None
    confidence: str | None = None


@dataclass
class AdaptiveBudgetConfig:
    simple: BudgetAllocation = field(default_factory=lambda: BudgetAllocation(max_rounds=4, max_tool_calls=5, max_tokens=3000, max_duration_ms=30000))
    moderate: BudgetAllocation = field(default_factory=lambda: BudgetAllocation(max_rounds=8, max_tool_calls=10, max_tokens=5000, max_duration_ms=60000))
    complex: BudgetAllocation = field(default_factory=lambda: BudgetAllocation(max_rounds=12, max_tool_calls=15, max_tokens=8000, max_duration_ms=120000))
    creative_bonus: BudgetAllocation = field(default_factory=lambda: BudgetAllocation(max_rounds=3, max_tool_calls=4, max_tokens=2000, max_duration_ms=30000))
    agent_native_simple: BudgetAllocation = field(default_factory=lambda: BudgetAllocation(max_rounds=6, max_tool_calls=8, max_tokens=4000, max_duration_ms=45000))
    agent_native_moderate: BudgetAllocation = field(default_factory=lambda: BudgetAllocation(max_rounds=12, max_tool_calls=15, max_tokens=8000, max_duration_ms=90000))
    agent_native_complex: BudgetAllocation = field(default_factory=lambda: BudgetAllocation(max_rounds=18, max_tool_calls=25, max_tokens=12000, max_duration_ms=180000))


@dataclass
class CreativeExplorationConfig:
    enabled: bool = True
    max_extra_tool_calls: int = 4
    max_extra_rounds: int = 3
    quality_threshold: float = 0.7
    exploration_prompt: str = "当前任务进展良好。你可以尝试更有创造性的方法来提升结果质量，例如探索额外信息、优化输出格式、或提供更深入的见解。"


class PermissionGuardProtocol(Protocol):
    def check(
        self,
        tool_name: str,
        required_permissions: list[Permission],
        risk_level: str,
        context: ToolContext,
    ) -> dict[str, Any]: ...


LifecycleHook = object


@dataclass
class ConstraintsServiceDeps:
    permission_guard: PermissionGuardProtocol | None = None


_CONSTRAINT_DEFINITIONS: list[ConstraintDefinition] = [
    ConstraintDefinition("no-sensitive-data-leak", ConstraintLevel.HARD, "禁止泄露敏感信息（密钥、密码、身份证等）"),
    ConstraintDefinition("no-sensitive-storage", ConstraintLevel.HARD, "禁止存储敏感信息到记忆"),
    ConstraintDefinition("no-dangerous-commands", ConstraintLevel.HARD, "禁止执行危险命令（rm -rf、drop table等）"),
    ConstraintDefinition("no-unauthorized-file-access", ConstraintLevel.HARD, "禁止访问系统目录"),
    ConstraintDefinition("no-unbounded-recursion", ConstraintLevel.HARD, "禁止无限递归"),
    ConstraintDefinition("resource-limit-check", ConstraintLevel.SOFT, "资源使用建议限制"),
]

_PRESSURE_THRESHOLDS = {"caution": 0.7, "critical": 0.9}

_LIFECYCLE_TO_HOOK_EVENT: dict[str, str | None] = {
    "before_tool_call": "beforeToolCall",
    "after_tool_call": "afterToolCall",
    "on_error": "onToolError",
    "before_loop": "beforeLoop",
    "after_loop": "afterLoop",
    "on_budget_exceeded": "onBudgetExceeded",
}


class ConstraintsService:
    def __init__(self, deps: ConstraintsServiceDeps | None = None) -> None:
        self.deps = deps or ConstraintsServiceDeps()
        self._hooks: dict[LifecycleEvent, list] = {}
        self._adaptive_budget: AdaptiveBudgetConfig | None = None
        self._creative_config: CreativeExplorationConfig | None = None

    def check_budget(self, state: BudgetState) -> BudgetCheckResult:
        warnings: list[str] = []
        hard_exceeded = False
        soft_exceeded = False

        if state.rounds_used >= state.hard_round_limit:
            warnings.append(f"轮次已达硬限制 {state.hard_round_limit}")
            hard_exceeded = True
        elif state.rounds_used >= state.soft_round_limit:
            warnings.append(f"轮次已达软限制 {state.soft_round_limit}/{state.hard_round_limit}")
            soft_exceeded = True

        if state.tokens_used >= state.token_hard_limit:
            warnings.append(f"Token 已达硬限制 {state.token_hard_limit}")
            hard_exceeded = True
        elif state.tokens_used >= state.token_warning_limit:
            warnings.append(f"Token 接近限制 {state.token_warning_limit}/{state.token_hard_limit}")
            soft_exceeded = True

        if state.tool_calls_used >= state.max_tool_calls:
            warnings.append(f"工具调用已达上限 {state.max_tool_calls}")
            hard_exceeded = True

        elapsed = (time.time() - state.start_time) * 1000 if state.start_time else 0
        if elapsed >= state.max_duration_ms:
            warnings.append(f"时间已达上限 {state.max_duration_ms}ms")
            hard_exceeded = True

        return BudgetCheckResult(
            within_budget=not (hard_exceeded or soft_exceeded),
            hard_limit_exceeded=hard_exceeded,
            warnings=warnings,
            remaining={
                "rounds": max(0, state.hard_round_limit - state.rounds_used),
                "tokens": max(0, state.token_hard_limit - state.tokens_used),
                "tool_calls": max(0, state.max_tool_calls - state.tool_calls_used),
                "duration_ms": max(0, state.max_duration_ms - int(elapsed)),
            },
        )

    def check_permission(
        self,
        tool_name: str,
        required_permissions: list[Permission],
        risk_level: str,
        context: ToolContext,
    ) -> PermissionResult:
        if not self.deps.permission_guard:
            return PermissionResult(allowed=True)
        result = self.deps.permission_guard.check(tool_name, required_permissions, risk_level, context)
        return PermissionResult(
            allowed=result.get("allowed", True),
            missing=result.get("missing", []),
            reason=result.get("reason"),
        )

    def check_safety_boundary(self, input_text: str, action: str) -> dict[str, Any]:
        if len(input_text) > 10000:
            return {"allowed": False, "reason": "输入过长，可能存在注入攻击"}

        cmd_check = check_dangerous_command(action)
        if cmd_check.dangerous:
            return {"allowed": False, "reason": cmd_check.reason or "禁止执行危险操作"}

        return {"allowed": True}

    def register_hook(self, event: LifecycleEvent, hook: Any) -> None:
        existing = self._hooks.get(event, [])
        existing.append(hook)
        self._hooks[event] = existing

    async def execute_hooks(self, event: LifecycleEvent, context: HookContext) -> HookResult:
        hooks = self._hooks.get(event, [])
        for hook in hooks:
            try:
                result = await hook(context)
                if not result.proceed:
                    return result
                if result.modified_params and context.params is not None:
                    context.params.update(result.modified_params)
            except Exception as exc:
                from agent.core.logger import StructuredLogger
                log = StructuredLogger("constraints")
                log.error(
                    "钩子执行异常，拒绝继续",
                    event=event.value if hasattr(event, "value") else str(event),
                    hook=hook.__name__ if hasattr(hook, "__name__") else str(hook),
                    exception_type=type(exc).__name__,
                    exception_module=type(exc).__module__,
                    error=str(exc),
                )
                return HookResult(proceed=False, reason=f"{type(exc).__name__}: {exc}")
        return HookResult(proceed=True)

    def enforce_behavior_constraint(self, constraint: str, context: Any | None = None) -> dict[str, Any]:
        ctx = context or {}

        if constraint == "no-unbounded-recursion":
            recursion_depth = (ctx.get("params", {}) or {}).get("recursionDepth", 0)
            max_depth = 10
            if recursion_depth >= max_depth:
                return {"compliant": False, "violation": f"递归深度 {recursion_depth} 超过限制 {max_depth}，可能存在无限递归风险"}
            return {"compliant": True}

        if constraint == "no-unauthorized-file-access":
            file_path = (ctx.get("params", {}) or {}).get("filePath", "")
            if file_path:
                forbidden_paths = [
                    os.environ.get("HOME", ""),
                    os.environ.get("USERPROFILE", ""),
                    "/etc",
                    "/root",
                    "C:\\Windows",
                    "C:\\Program Files",
                    "C:\\Program Files (x86)",
                ]
                forbidden_paths = [p for p in forbidden_paths if p]
                for forbidden in forbidden_paths:
                    if file_path.startswith(forbidden):
                        return {"compliant": False, "violation": f"禁止访问系统目录: {forbidden}"}
            return {"compliant": True}

        if constraint == "no-sensitive-data-leak":
            output = (ctx.get("result") or {}).get("output") if isinstance(ctx, dict) else None
            if output:
                output_str = output if isinstance(output, str) else str(output)
                result = check_sensitive_info(output_str, CheckScene.OUTPUT)
                if not result.safe:
                    top_violation = result.violations[0] if result.violations else None
                    display_name = top_violation.name if top_violation else "未知"
                    return {"compliant": False, "violation": f"检测到可能泄露的敏感信息: {display_name}"}
            return {"compliant": True}

        if constraint == "no-sensitive-storage":
            tool_name = ctx.get("toolName", "") if isinstance(ctx, dict) else ""
            if tool_name in ("memory_store", "note_take"):
                params = ctx.get("params", {}) or {}
                all_values = " ".join(str(v) for v in params.values())
                content = str(params.get("content", params.get("text", ""))) + " " + all_values
                if content.strip():
                    result = check_sensitive_info(content, CheckScene.STORAGE)
                    if not result.safe:
                        specific_names = [
                            "API密钥", "AWS密钥", "GitHub令牌", "GitHub OAuth令牌",
                            "Slack令牌", "密钥凭证", "银行卡号", "身份证号",
                            "身份证号(18位)", "CVV码", "密码泄露", "敏感凭证关键词",
                        ]
                        top_violation = None
                        for v in result.violations:
                            if v.name in specific_names:
                                top_violation = v
                                break
                        top_violation = top_violation or (result.violations[0] if result.violations else None)
                        return {
                            "compliant": False,
                            "violation": f"禁止存储敏感信息 ({top_violation.name if top_violation else '未知'})，请勿将密钥、凭证等敏感数据保存到记忆中",
                        }
            return {"compliant": True}

        if constraint == "no-dangerous-commands":
            params = ctx.get("params", {}) if isinstance(ctx, dict) else {}
            cmd = params.get("command", params.get("script", ""))
            if cmd:
                result = check_dangerous_command(str(cmd))
                if result.dangerous:
                    return {"compliant": False, "violation": result.reason or f"检测到危险命令: {str(cmd)[:50]}"}
            return {"compliant": True}

        if constraint == "resource-limit-check":
            params = ctx.get("params", {}) if isinstance(ctx, dict) else {}
            memory_usage = params.get("memoryMB", 0)
            max_memory_mb = 512
            cpu_time = params.get("cpuTimeMs", 0)
            max_cpu_time_ms = 30000
            if memory_usage > max_memory_mb:
                return {"compliant": False, "violation": f"内存使用 {memory_usage}MB 超过限制 {max_memory_mb}MB"}
            if cpu_time > max_cpu_time_ms:
                return {"compliant": False, "violation": f"CPU 时间 {cpu_time}ms 超过限制 {max_cpu_time_ms}ms"}
            return {"compliant": True}

        return {"compliant": True}

    def get_constraint_level(self, constraint_name: str) -> ConstraintLevel:
        for d in _CONSTRAINT_DEFINITIONS:
            if d.name == constraint_name:
                return d.level
        return ConstraintLevel.ADVISORY

    def get_constraint_definitions(self) -> list[ConstraintDefinition]:
        return list(_CONSTRAINT_DEFINITIONS)

    def enforce_with_level(self, constraint: str, context: Any | None = None) -> dict[str, Any]:
        result = self.enforce_behavior_constraint(constraint, context)
        level = self.get_constraint_level(constraint)

        if not result.get("compliant", True) and level == ConstraintLevel.HARD:
            return {**result, "level": level.value, "blocked": True}

        if not result.get("compliant", True) and level == ConstraintLevel.SOFT:
            log.warning("SOFT constraint violated", constraint=constraint, violation=result.get("violation", ""))
            return {"compliant": True, "level": level.value, "soft_violation": result.get("violation", "")}

        if not result.get("compliant", True) and level == ConstraintLevel.ADVISORY:
            return {"compliant": True, "level": level.value, "advisory_violation": result.get("violation", "")}

        return {**result, "level": level.value}

    def get_adaptive_budget(self) -> AdaptiveBudgetConfig:
        return self._adaptive_budget or AdaptiveBudgetConfig()

    def get_creative_config(self) -> CreativeExplorationConfig:
        return self._creative_config or CreativeExplorationConfig()

    def set_adaptive_budget(self, config: dict[str, Any] | None = None) -> None:
        base = AdaptiveBudgetConfig()
        if config:
            self._adaptive_budget = AdaptiveBudgetConfig(**config)
        else:
            self._adaptive_budget = base

    def set_creative_config(self, config: dict[str, Any] | None = None) -> None:
        base = CreativeExplorationConfig()
        if config:
            self._creative_config = CreativeExplorationConfig(**config)
        else:
            self._creative_config = base

    def resolve_adaptive_budget(
        self,
        complexity: str = "moderate",
        enable_creative: bool = False,
        historical_estimate: Any | None = None,
        agent_native: bool = False,
    ) -> BudgetAllocation:
        """解析自适应预算分配方案。

        P2 #15: 新增 historical_estimate 参数。当提供历史预预估时，
        使用 estimated_ms * 1.2 替代静态 max_duration_ms，并填充
        estimated_ms 和 confidence 字段，供调用方（如 LoopController）
        做更精准的时间预算决策。样本不足时降级到静态 AdaptiveBudgetConfig。

        agent_native 模型（如 DeepSeek V4 Flash）具备原生 Agent 能力，
        工具调用准确率更高，可放宽轮数和工具调用限制，同时降低验证强度。

        Args:
            complexity: 任务复杂度（simple/moderate/complex）。
            enable_creative: 是否启用创造性探索附加预算。
            historical_estimate: 历史执行时间预估（ExecutionEstimate），
                传入 None 表示无历史数据，降级到静态配置。
            agent_native: 模型是否具备原生 Agent 能力。

        Returns:
            BudgetAllocation: 预算分配方案，含 max_duration_ms 和（如有）预估信息。
        """
        budget = self.get_adaptive_budget()
        if agent_native:
            base_map = {
                "simple": budget.agent_native_simple,
                "moderate": budget.agent_native_moderate,
                "complex": budget.agent_native_complex,
            }
        else:
            base_map = {
                "simple": budget.simple,
                "moderate": budget.moderate,
                "complex": budget.complex,
            }
        base = base_map.get(complexity, budget.moderate if not agent_native else budget.agent_native_moderate)

        # 计算创造性探索附加预算
        bonus = budget.creative_bonus if (enable_creative and self.get_creative_config().enabled) else None

        # P2 #15: 历史预估优先 — 用 estimated_ms * 1.2 替代静态 max_duration_ms
        if historical_estimate is not None:
            estimated_ms = historical_estimate.estimated_ms
            max_duration_ms = int(estimated_ms * 1.2)
            confidence = historical_estimate.confidence
        else:
            estimated_ms = None
            confidence = None
            max_duration_ms = base.max_duration_ms

        if bonus is not None:
            max_duration_ms += bonus.max_duration_ms

        return BudgetAllocation(
            max_rounds=base.max_rounds + (bonus.max_rounds if bonus else 0),
            max_tool_calls=base.max_tool_calls + (bonus.max_tool_calls if bonus else 0),
            max_tokens=base.max_tokens + (bonus.max_tokens if bonus else 0),
            max_duration_ms=max_duration_ms,
            estimated_ms=estimated_ms,
            confidence=confidence,
        )

    def can_explore_creatively(self, current_quality: float, budget_state: BudgetState) -> dict[str, Any]:
        config = self.get_creative_config()

        if not config.enabled:
            return {"allowed": False, "reason": "创造性探索未启用"}

        if current_quality < config.quality_threshold:
            return {"allowed": False, "reason": f"质量评分 {current_quality:.2f} 低于阈值 {config.quality_threshold}"}

        remaining_rounds = budget_state.hard_round_limit - budget_state.rounds_used
        if remaining_rounds < config.max_extra_rounds:
            return {"allowed": False, "reason": "剩余轮次不足以支持探索"}

        return {"allowed": True}

    def get_budget_pressure(self, budget: BudgetState) -> dict[str, Any]:
        rounds = budget.rounds_used / budget.hard_round_limit if budget.hard_round_limit > 0 else 0
        tokens = budget.tokens_used / budget.token_hard_limit if budget.token_hard_limit > 0 else 0
        tool_calls = budget.tool_calls_used / budget.max_tool_calls if budget.max_tool_calls > 0 else 0
        elapsed = (time.time() - budget.start_time) * 1000 if budget.start_time else 0
        duration = elapsed / budget.max_duration_ms if budget.max_duration_ms > 0 else 0

        details = {"rounds": rounds, "tokens": tokens, "tool_calls": tool_calls, "duration": duration}
        max_usage = max(rounds, tokens, tool_calls, duration)

        if max_usage >= _PRESSURE_THRESHOLDS["critical"]:
            dimension = self._get_highest_dimension(details)
            warning = self._build_critical_warning(dimension, budget)
            return {"level": "critical", "warning": warning, "details": details}

        if max_usage >= _PRESSURE_THRESHOLDS["caution"]:
            dimension = self._get_highest_dimension(details)
            warning = self._build_caution_warning(dimension, budget)
            return {"level": "caution", "warning": warning, "details": details}

        return {"level": "none", "details": details}

    @staticmethod
    def _get_highest_dimension(details: dict[str, float]) -> str:
        max_val = 0.0
        dim = "rounds"
        for k, v in details.items():
            if v > max_val:
                max_val = v
                dim = k
        return dim

    @staticmethod
    def _build_caution_warning(dimension: str, budget: BudgetState) -> str:
        labels = {
            "rounds": f"轮次 {budget.rounds_used}/{budget.hard_round_limit}",
            "tokens": f"Token {budget.tokens_used}/{budget.token_hard_limit}",
            "tool_calls": f"工具调用 {budget.tool_calls_used}/{budget.max_tool_calls}",
            "duration": f"时间已用",
        }
        return f"⚠️ 预算注意: {labels.get(dimension, dimension)} 使用率较高，建议注意效率"

    @staticmethod
    def _build_critical_warning(dimension: str, budget: BudgetState) -> str:
        labels = {
            "rounds": f"轮次 {budget.rounds_used}/{budget.hard_round_limit}",
            "tokens": f"Token {budget.tokens_used}/{budget.token_hard_limit}",
            "tool_calls": f"工具调用 {budget.tool_calls_used}/{budget.max_tool_calls}",
            "duration": f"时间已用",
        }
        return f"🚨 预算警告: {labels.get(dimension, dimension)} 即将耗尽，请尽快收敛"
