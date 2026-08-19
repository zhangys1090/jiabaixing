"""U2×U3：能力路由 × 进化引擎 联动（漂移自愈）。

把 ``LLMCapabilityDetector`` 检测到的**能力漂移**，自动转化为两层自愈动作：
1. **路由降级**：对能力下降的 Provider 调用 ``CapabilityAwareRouter.set_provider_degraded``
   临时降权，避免继续派发高风险任务（W4 漂移 → 路由）。
2. **进化回滚**：当检测到能力 "退化"（``changed`` 中 new<old 或 ``removed``），触发进化引擎
   回滚到最近一个已知良好检查点（Prompt/工具组合），恢复退化前的提示词/工具（漂移自愈）。

设计为解耦回调式，便于单元测试与线上接入（AGENTS.md §0.1：属 Agent 核心）。

详见 docs/jiabaixing-unique-capability-enhancement.md §三 3.2 / §四 / U2×U3。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

from agent.core.tracing import new_trace_id
from agent.evolution.llm_capability_detector import CapabilityDiff, LLMCapabilityDetector

# 仅类型注解需要 CapabilityAwareRouter；运行时导入会触发
# agent.llm.__init__ → capability_aware_router → agent.evolution.__init__ → 本模块
# 的循环导入（__future__ annotations 使注解惰性求值，故可安全置于 TYPE_CHECKING 下）。
if TYPE_CHECKING:
    from agent.llm.capability_aware_router import CapabilityAwareRouter

# 可比较"退化"的核心数值维度（new < old 视为退化）
_CAPABILITY_DIMS = (
    "reasoning_depth",
    "code_generation",
    "tool_calling_accuracy",
    "structured_output",
    "context_window",
)


@dataclass
class LinkageResult:
    """一次漂移联动的处理结果（含 trace_id 便于审计贯通）。"""

    trace_id: str
    provider: str
    degraded: bool
    changed_metrics: list[str]
    routing_action: str
    rollback_required: bool
    rollback_checkpoint_id: str | None
    timestamp: float = field(default_factory=time.time)


class CapabilityEvolutionLinkage:
    """能力路由 × 进化引擎 联动控制器。

    Args:
        detector: ``LLMCapabilityDetector`` 实例（漂移源）。
        router: 可选 ``CapabilityAwareRouter``，用于路由降级。
        on_rollback: 可选异步回调 ``async (checkpoint_id, result) -> None``，执行进化回滚。
        get_latest_checkpoint_id: 可选回调 ``() -> str | None``，返回最近良好检查点。
        on_adjust: 可选同步回调 ``(result) -> None``，每次联动后通知（如记日志/埋点）。
    """

    def __init__(
        self,
        detector: LLMCapabilityDetector,
        router: CapabilityAwareRouter | None = None,
        *,
        on_rollback: Callable[[str, LinkageResult], Any] | None = None,
        get_latest_checkpoint_id: Callable[[], str | None] | None = None,
        on_adjust: Callable[[LinkageResult], None] | None = None,
    ) -> None:
        self._detector = detector
        self._router = router
        self._on_rollback = on_rollback
        self._get_latest_checkpoint_id = get_latest_checkpoint_id
        self._on_adjust = on_adjust
        self._history: list[LinkageResult] = []
        self._pending: list[LinkageResult] = []

    # ------------------------------------------------------------------ 注册
    def register(self) -> None:
        """把检测器漂移回调接到本联动；随后调用 ``detector.start_drift_monitor``。"""
        self._detector.on_capability_drift = self._on_drift

    def _on_drift(self, provider: str, diff: CapabilityDiff) -> LinkageResult:
        return self.notify_capability_change(provider, diff)

    # ------------------------------------------------------------------ 核心
    def notify_capability_change(
        self, provider: str, diff: CapabilityDiff
    ) -> LinkageResult:
        """处理一次能力变化：判定退化 → 路由降级 + 排队回滚。返回处理结果。"""
        changed_metrics = self._degraded_metrics(diff)
        degraded = len(changed_metrics) > 0 or bool(diff.removed)

        routing_action = ""
        if self._router is not None and degraded:
            self._router.set_provider_degraded(provider, True)
            routing_action = "degraded"

        rollback_required = False
        rollback_cp: str | None = None
        if degraded and self._get_latest_checkpoint_id is not None:
            cp = self._get_latest_checkpoint_id()
            if cp:
                rollback_required = True
                rollback_cp = cp
                self._pending.append(rollback_cp)

        result = LinkageResult(
            trace_id=new_trace_id(),
            provider=provider,
            degraded=degraded,
            changed_metrics=changed_metrics,
            routing_action=routing_action,
            rollback_required=rollback_required,
            rollback_checkpoint_id=rollback_cp,
        )
        self._history.append(result)
        if self._on_adjust is not None:
            self._on_adjust(result)
        return result

    @staticmethod
    def _degraded_metrics(diff: CapabilityDiff) -> list[str]:
        out: list[str] = []
        changed = diff.changed or []
        for entry in changed:
            if not isinstance(entry, dict):
                continue
            field_name = entry.get("field")
            if field_name not in _CAPABILITY_DIMS:
                continue
            try:
                frm = float(entry.get("from"))
                to = float(entry.get("to"))
            except (TypeError, ValueError):
                continue
            if to < frm:
                out.append(field_name)
        return out

    # ------------------------------------------------------------------ 回滚
    async def flush_pending_rollbacks(self) -> int:
        """执行所有排队的进化回滚（异步）。返回实际触发的回滚数。"""
        if self._on_rollback is None:
            self._pending.clear()
            return 0
        done = 0
        while self._pending:
            checkpoint_id = self._pending.pop(0)
            await self._on_rollback(checkpoint_id, None)
            done += 1
        return done

    @property
    def history(self) -> list[LinkageResult]:
        return list(self._history)

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def reset(self) -> None:
        self._history.clear()
        self._pending.clear()


def evolution_rollback_handlers(
    engine: Any,
) -> tuple[Callable[[str, LinkageResult], Any], Callable[[], str | None]]:
    """从 ``EvolutionEngineV2`` 提取 (on_rollback, get_latest_checkpoint_id) 回调。

    兼容式实现：优先调用引擎上的公开方法，缺省时兜底读取私有检查点字典。
    """

    async def on_rollback(checkpoint_id: str, _result: LinkageResult) -> None:
        await engine.rollback_to_checkpoint(checkpoint_id)

    def get_latest() -> str | None:
        fn = getattr(engine, "latest_checkpoint_id", None)
        if callable(fn):
            return fn()  # type: ignore[no-any-return]
        rb = getattr(engine, "_rollback", None)
        cps = getattr(rb, "_checkpoints", None)
        if isinstance(cps, dict) and cps:
            return max(cps.items(), key=lambda kv: kv[1].get("timestamp", 0))[0]
        return None

    return on_rollback, get_latest
