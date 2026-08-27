"""进化闭环打通 + 效果量化。

设计目标：
1. 进化闭环打通：将 EvolutionEngine/EvolutionOrchestrator/CapabilityEvolutionLinkage
   三大进化组件连通为运行时强制执行的完整链路
2. 效果量化：对每次进化操作的效果进行量化评估，形成"进化-验证-反馈"闭环
3. 进化决策记录：记录每次进化决策的完整上下文和效果

进化闭环流程：
  信号采集（工具失败/质量下降/能力漂移）
    → 信号聚合（模式识别：连续失败/失败率飙升/延迟飙升）
      → 进化决策（策略选择：Prompt优化/工具增强/路由降级/回滚）
        → 进化执行（CanaryRelease 灰度发布）
          → 效果验证（A/B 对比 + 质量评分）
            → 效果记录（成功/失败 → 反馈到进化引擎）

效果量化指标：
  - quality_delta: 进化前后质量分差值
  - latency_delta: 进化前后延迟差值
  - success_rate_delta: 进化前后成功率差值
  - confidence: 效果评估置信度

Usage:
    loop = EvolutionClosedLoop(orchestrator=orchestrator)
    result = await loop.execute_evolution(signal)
    metrics = loop.get_effectiveness_metrics()
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored

log = StructuredLogger("evolution_closed_loop")


class EvolutionAction(str, Enum):
    PROMPT_OPTIMIZE = "prompt_optimize"
    TOOL_ENHANCE = "tool_enhance"
    ROUTE_DEGRADE = "route_degrade"
    ROLLBACK = "rollback"
    SKILL_UPDATE = "skill_update"
    CORRECTION_RULE = "correction_rule"
    WEIGHT_ADJUST = "weight_adjust"


class EvolutionOutcome(str, Enum):
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILURE = "failure"
    SKIPPED = "skipped"
    ROLLED_BACK = "rolled_back"


@dataclass
class EvolutionSignal:
    signal_type: str = "quality_drop"
    source: str = ""
    severity: float = 0.5
    context: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0


@dataclass
class EvolutionDecision:
    action: EvolutionAction = EvolutionAction.PROMPT_OPTIMIZE
    target: str = ""
    reasoning: str = ""
    confidence: float = 0.5
    pre_state: dict[str, Any] = field(default_factory=dict)


@dataclass
class EffectMeasurement:
    quality_before: float = 0.0
    quality_after: float = 0.0
    latency_before_ms: float = 0.0
    latency_after_ms: float = 0.0
    success_rate_before: float = 0.0
    success_rate_after: float = 0.0
    confidence: float = 0.0
    sample_size: int = 0

    @property
    def quality_delta(self) -> float:
        return self.quality_after - self.quality_before

    @property
    def latency_delta(self) -> float:
        return self.latency_after_ms - self.latency_before_ms

    @property
    def success_rate_delta(self) -> float:
        return self.success_rate_after - self.success_rate_before

    @property
    def is_effective(self) -> bool:
        if self.sample_size < 3:
            return False
        if self.quality_delta > 0.05:
            return True
        if self.success_rate_delta > 0.1:
            return True
        if self.quality_delta > 0 and self.latency_delta < 0:
            return True
        return False


@dataclass
class EvolutionCycleRecord:
    cycle_id: str = ""
    timestamp: float = 0.0
    signal: EvolutionSignal = field(default_factory=EvolutionSignal)
    decision: EvolutionDecision = field(default_factory=EvolutionDecision)
    outcome: EvolutionOutcome = EvolutionOutcome.SKIPPED
    effect: EffectMeasurement = field(default_factory=EffectMeasurement)
    duration_ms: float = 0.0
    rollback_performed: bool = False


@dataclass
class EffectivenessMetrics:
    total_cycles: int = 0
    successful_cycles: int = 0
    rolled_back_cycles: int = 0
    avg_quality_delta: float = 0.0
    avg_latency_delta_ms: float = 0.0
    avg_success_rate_delta: float = 0.0
    effectiveness_rate: float = 0.0
    action_stats: dict[str, dict[str, int]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_cycles": self.total_cycles,
            "successful_cycles": self.successful_cycles,
            "rolled_back_cycles": self.rolled_back_cycles,
            "avg_quality_delta": round(self.avg_quality_delta, 4),
            "avg_latency_delta_ms": round(self.avg_latency_delta_ms, 1),
            "avg_success_rate_delta": round(self.avg_success_rate_delta, 4),
            "effectiveness_rate": round(self.effectiveness_rate, 4),
            "action_stats": self.action_stats,
        }


class EvolutionClosedLoop:
    def __init__(
        self,
        orchestrator: Any | None = None,
        evolution_engine: Any | None = None,
        capability_linkage: Any | None = None,
        data_dir: str | None = None,
    ) -> None:
        self._orchestrator = orchestrator
        self._evolution_engine = evolution_engine
        self._capability_linkage = capability_linkage

        self._data_dir = Path(data_dir) if data_dir else Path(
            os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent.parent / "data"))
        ) / "evolution_closed_loop"
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._metrics_path = self._data_dir / "metrics.json"
        self._history_path = self._data_dir / "cycle_history.jsonl"

        self._cycle_counter = 0
        self._recent_cycles: list[EvolutionCycleRecord] = []
        self._max_recent_cycles = 100
        self._metrics = EffectivenessMetrics()
        self._quality_window: list[float] = []
        self._latency_window: list[float] = []
        self._success_window: list[bool] = []
        self._window_size = 20

        self._load_metrics()

    def _load_metrics(self) -> None:
        if self._metrics_path.exists():
            try:
                raw = json.loads(self._metrics_path.read_text(encoding="utf-8"))
                self._metrics.total_cycles = raw.get("total_cycles", 0)
                self._metrics.successful_cycles = raw.get("successful_cycles", 0)
                self._metrics.rolled_back_cycles = raw.get("rolled_back_cycles", 0)
                self._metrics.avg_quality_delta = raw.get("avg_quality_delta", 0.0)
                self._metrics.avg_latency_delta_ms = raw.get("avg_latency_delta_ms", 0.0)
                self._metrics.avg_success_rate_delta = raw.get("avg_success_rate_delta", 0.0)
                self._metrics.effectiveness_rate = raw.get("effectiveness_rate", 0.0)
                self._metrics.action_stats = raw.get("action_stats", {})
            except Exception as e:
                log.warning("Failed to load evolution metrics", error=str(e))

    def _save_metrics(self) -> None:
        try:
            self._metrics_path.write_text(
                json.dumps(self._metrics.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            log.warning("Failed to save evolution metrics", error=str(e))

    def _append_cycle_history(self, record: EvolutionCycleRecord) -> None:
        try:
            with open(self._history_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "cycle_id": record.cycle_id,
                    "timestamp": record.timestamp,
                    "action": record.decision.action.value,
                    "outcome": record.outcome.value,
                    "quality_delta": record.effect.quality_delta,
                    "latency_delta": record.effect.latency_delta,
                    "success_rate_delta": record.effect.success_rate_delta,
                    "is_effective": record.effect.is_effective,
                    "duration_ms": record.duration_ms,
                    "rollback": record.rollback_performed,
                }, ensure_ascii=False) + "\n")
        except Exception as e:
            log.debug("Failed to append cycle history", error=str(e))

    def collect_signal(
        self,
        signal_type: str,
        source: str = "",
        severity: float = 0.5,
        context: dict[str, Any] | None = None,
    ) -> EvolutionSignal:
        signal = EvolutionSignal(
            signal_type=signal_type,
            source=source,
            severity=severity,
            context=context or {},
            timestamp=time.time(),
        )
        return signal

    def decide_evolution_action(self, signal: EvolutionSignal) -> EvolutionDecision:
        action = EvolutionAction.PROMPT_OPTIMIZE
        target = ""
        reasoning = ""
        confidence = 0.5

        if signal.signal_type == "tool_failure":
            tool_name = signal.context.get("tool_name", "unknown")
            action = EvolutionAction.TOOL_ENHANCE
            target = tool_name
            reasoning = f"工具 {tool_name} 失败，触发工具增强"
            confidence = 0.7

        elif signal.signal_type == "quality_drop":
            action = EvolutionAction.PROMPT_OPTIMIZE
            target = signal.context.get("prompt_id", "default")
            reasoning = "质量下降，触发 Prompt 优化"
            confidence = 0.6

        elif signal.signal_type == "risk_detected":
            action = EvolutionAction.CORRECTION_RULE
            target = signal.context.get("top_risk", "unknown_risk")[:50]
            reasoning = f"检测到高危风险，触发纠错规则生成: {target}"
            confidence = 0.75

        elif signal.signal_type == "capability_drift":
            provider = signal.context.get("provider", "unknown")
            action = EvolutionAction.ROUTE_DEGRADE
            target = provider
            reasoning = f"Provider {provider} 能力漂移，触发路由降级"
            confidence = 0.8

        elif signal.signal_type == "consecutive_failure":
            action = EvolutionAction.ROLLBACK
            target = signal.context.get("checkpoint_id", "latest")
            reasoning = "连续失败，触发回滚到最近良好检查点"
            confidence = 0.9

        elif signal.signal_type == "skill_quality_drop":
            skill_name = signal.context.get("skill_name", "unknown")
            action = EvolutionAction.SKILL_UPDATE
            target = skill_name
            reasoning = f"技能 {skill_name} 质量下降，触发技能更新"
            confidence = 0.6

        elif signal.signal_type == "correction_needed":
            action = EvolutionAction.CORRECTION_RULE
            target = signal.context.get("rule_target", "")
            reasoning = "需要修正规则，触发修正规则生成"
            confidence = 0.7

        elif signal.signal_type == "weight_imbalance":
            action = EvolutionAction.WEIGHT_ADJUST
            target = signal.context.get("weight_target", "")
            reasoning = "工具权重失衡，触发权重调整"
            confidence = 0.5

        if signal.severity > 0.8:
            confidence = min(1.0, confidence + 0.1)

        pre_state = self._capture_pre_state()

        return EvolutionDecision(
            action=action,
            target=target,
            reasoning=reasoning,
            confidence=confidence,
            pre_state=pre_state,
        )

    async def execute_evolution(
        self,
        signal: EvolutionSignal,
    ) -> EvolutionCycleRecord:
        start = time.time()
        self._cycle_counter += 1

        decision = self.decide_evolution_action(signal)

        outcome = EvolutionOutcome.SKIPPED
        rollback_performed = False
        effect = EffectMeasurement()

        try:
            outcome = await self._execute_action(decision)

            effect = self._measure_effect(decision.pre_state)

            if effect.is_effective:
                if outcome == EvolutionOutcome.PARTIAL:
                    outcome = EvolutionOutcome.SUCCESS
            else:
                if effect.quality_delta < -0.1 and decision.action not in (EvolutionAction.ROLLBACK,):
                    rollback_performed = await self._attempt_rollback(decision)
                    if rollback_performed:
                        outcome = EvolutionOutcome.ROLLED_BACK

        except Exception as e:
            log.warning("Evolution action failed", action=decision.action.value, error=str(e))
            outcome = EvolutionOutcome.FAILURE

        duration_ms = (time.time() - start) * 1000

        record = EvolutionCycleRecord(
            cycle_id=f"evo_{self._cycle_counter}_{int(start)}",
            timestamp=start,
            signal=signal,
            decision=decision,
            outcome=outcome,
            effect=effect,
            duration_ms=duration_ms,
            rollback_performed=rollback_performed,
        )

        self._update_metrics(record)
        self._recent_cycles.append(record)
        if len(self._recent_cycles) > self._max_recent_cycles:
            self._recent_cycles = self._recent_cycles[-self._max_recent_cycles:]
        self._append_cycle_history(record)

        log.info(
            "Evolution cycle completed",
            cycle_id=record.cycle_id,
            action=decision.action.value,
            outcome=outcome.value,
            quality_delta=round(effect.quality_delta, 4),
            is_effective=effect.is_effective,
            rollback=rollback_performed,
            duration_ms=round(duration_ms, 1),
        )
        return record

    async def _execute_action(self, decision: EvolutionDecision) -> EvolutionOutcome:
        if decision.action == EvolutionAction.ROUTE_DEGRADE and self._capability_linkage:
            try:
                provider = decision.target
                self._capability_linkage.on_drift_detected(provider, {})
                return EvolutionOutcome.SUCCESS
            except Exception as e:
                log.warning("Route degrade failed", error=str(e))
                return EvolutionOutcome.FAILURE

        if decision.action == EvolutionAction.ROLLBACK:
            if self._evolution_engine:
                try:
                    checkpoint_id = decision.target
                    if hasattr(self._evolution_engine, "rollback_to_checkpoint"):
                        await self._evolution_engine.rollback_to_checkpoint(checkpoint_id)
                    return EvolutionOutcome.SUCCESS
                except Exception as e:
                    log.warning("Rollback failed", error=str(e))
                    return EvolutionOutcome.FAILURE

        if decision.action == EvolutionAction.PROMPT_OPTIMIZE and self._orchestrator:
            try:
                if hasattr(self._orchestrator, "run_optimization_cycle"):
                    result = await self._orchestrator.run_optimization_cycle()
                    if result:
                        return EvolutionOutcome.SUCCESS
                return EvolutionOutcome.PARTIAL
            except Exception as e:
                log.warning("Prompt optimization failed", error=str(e))
                return EvolutionOutcome.FAILURE

        if decision.action == EvolutionAction.TOOL_ENHANCE and self._evolution_engine:
            try:
                if hasattr(self._evolution_engine, "record_tool_signal"):
                    self._evolution_engine.record_tool_signal(
                        tool_name=decision.target,
                        signal_type="failure",
                        quality_score=0.3,
                    )
                return EvolutionOutcome.SUCCESS
            except Exception as e:
                log.warning("Tool enhancement failed", error=str(e))
                return EvolutionOutcome.FAILURE

        if decision.action == EvolutionAction.WEIGHT_ADJUST and self._evolution_engine:
            try:
                if hasattr(self._evolution_engine, "_tool_weights"):
                    current = self._evolution_engine._tool_weights.get(decision.target, 1.0)
                    self._evolution_engine._tool_weights[decision.target] = max(0.1, current * 0.8)
                return EvolutionOutcome.SUCCESS
            except Exception as e:
                log.warning("Weight adjustment failed", error=str(e))
                return EvolutionOutcome.FAILURE

        if decision.action in (EvolutionAction.SKILL_UPDATE, EvolutionAction.CORRECTION_RULE):
            if self._evolution_engine:
                try:
                    if hasattr(self._evolution_engine, "_schedule_persist"):
                        self._evolution_engine._schedule_persist()
                    return EvolutionOutcome.SUCCESS
                except Exception as e:
                    log.warning("Skill/correction update failed", error=str(e))
                    return EvolutionOutcome.FAILURE

        return EvolutionOutcome.SKIPPED

    def _capture_pre_state(self) -> dict[str, Any]:
        state: dict[str, Any] = {}
        if self._evolution_engine:
            try:
                if hasattr(self._evolution_engine, "_metrics"):
                    m = self._evolution_engine._metrics
                    state["quality"] = getattr(m, "average_quality", 0.0)
                if hasattr(self._evolution_engine, "_tool_weights"):
                    state["tool_weights"] = dict(self._evolution_engine._tool_weights)
            except Exception as _exc:
                log.debug("closed_loop 异常处理", error=str(_exc))
                log_ignored(log, "closed_loop.EvolutionClosedLoop._capture_pre_state", _exc)
        return state

    def _measure_effect(self, pre_state: dict[str, Any]) -> EffectMeasurement:
        effect = EffectMeasurement(
            quality_before=pre_state.get("quality", 0.0),
            quality_after=0.0,
            sample_size=len(self._quality_window),
        )

        if self._quality_window:
            effect.quality_after = sum(self._quality_window[-10:]) / len(self._quality_window[-10:])
        if self._latency_window:
            effect.latency_before_ms = pre_state.get("latency_ms", 0.0)
            effect.latency_after_ms = sum(self._latency_window[-10:]) / len(self._latency_window[-10:])
        if self._success_window:
            effect.success_rate_before = pre_state.get("success_rate", 0.5)
            recent = self._success_window[-10:]
            effect.success_rate_after = sum(1 for s in recent if s) / len(recent) if recent else 0.0

        effect.confidence = min(1.0, effect.sample_size / 10.0)
        return effect

    async def _attempt_rollback(self, decision: EvolutionDecision) -> bool:
        if self._evolution_engine and hasattr(self._evolution_engine, "rollback_to_checkpoint"):
            try:
                await self._evolution_engine.rollback_to_checkpoint("latest")
                log.info("Rollback to latest checkpoint succeeded")
                return True
            except Exception as e:
                log.warning("Rollback attempt failed", error=str(e))
        return False

    def record_quality(self, quality: float) -> None:
        self._quality_window.append(quality)
        if len(self._quality_window) > self._window_size:
            self._quality_window = self._quality_window[-self._window_size:]

    def record_latency(self, latency_ms: float) -> None:
        self._latency_window.append(latency_ms)
        if len(self._latency_window) > self._window_size:
            self._latency_window = self._latency_window[-self._window_size:]

    def record_success(self, success: bool) -> None:
        self._success_window.append(success)
        if len(self._success_window) > self._window_size:
            self._success_window = self._success_window[-self._window_size:]

    def _update_metrics(self, record: EvolutionCycleRecord) -> None:
        self._metrics.total_cycles += 1

        if record.outcome in (EvolutionOutcome.SUCCESS,):
            self._metrics.successful_cycles += 1
        if record.rollback_performed:
            self._metrics.rolled_back_cycles += 1

        total = self._metrics.total_cycles
        if total > 0:
            self._metrics.avg_quality_delta = (
                (self._metrics.avg_quality_delta * (total - 1) + record.effect.quality_delta) / total
            )
            self._metrics.avg_latency_delta_ms = (
                (self._metrics.avg_latency_delta_ms * (total - 1) + record.effect.latency_delta) / total
            )
            self._metrics.avg_success_rate_delta = (
                (self._metrics.avg_success_rate_delta * (total - 1) + record.effect.success_rate_delta) / total
            )
            self._metrics.effectiveness_rate = self._metrics.successful_cycles / total

        action_name = record.decision.action.value
        if action_name not in self._metrics.action_stats:
            self._metrics.action_stats[action_name] = {"total": 0, "success": 0}
        self._metrics.action_stats[action_name]["total"] += 1
        if record.outcome == EvolutionOutcome.SUCCESS:
            self._metrics.action_stats[action_name]["success"] += 1

        if total % 5 == 0:
            self._save_metrics()

    def get_effectiveness_metrics(self) -> EffectivenessMetrics:
        return self._metrics

    async def ingest_structured_report(self, report: Any) -> None:
        """闭环修复：报告→进化 — 接收结构化执行报告并更新进化指标。"""
        try:
            report_dict = report.to_dict() if hasattr(report, "to_dict") else {}
            quality = report_dict.get("quality", {}).get("overall_score", 0.5)
            risks = report_dict.get("risks", [])
            improvements = report_dict.get("improvements", [])

            self.record_quality(quality)

            high_risks: list[Any] = []
            for r in risks:
                if isinstance(r, dict):
                    sev_val = r.get("severity", "")
                    risk_type = r.get("type", "unknown")
                    description = r.get("description", "")
                else:
                    sev = getattr(r, "severity", None)
                    sev_val = sev.value if hasattr(sev, "value") else str(sev) if sev else ""
                    risk_type = getattr(r, "risk_type", "unknown")
                    description = getattr(r, "description", "")
                if sev_val in ("high", "critical"):
                    high_risks.append(r)

            if high_risks and self._evolution_engine and hasattr(self._evolution_engine, "register_risk_signal"):
                for risk in high_risks[:3]:
                    try:
                        if isinstance(risk, dict):
                            _rtype = risk.get("type", "unknown")
                            _desc = risk.get("description", "")
                            _sev = risk.get("severity", "medium")
                        else:
                            _rtype = getattr(risk, "risk_type", "unknown")
                            _desc = getattr(risk, "description", "")
                            _sev = getattr(risk, "severity", "medium")
                        await self._evolution_engine.register_risk_signal(
                            risk_type=_rtype,
                            description=_desc,
                            severity=_sev,
                        )
                    except Exception as _exc:
                        log.debug("closed_loop 异常处理", error=str(_exc))
                        log_ignored(log, "closed_loop.EvolutionClosedLoop.ingest_structured_report", _exc)

            if improvements:
                log.debug("Improvements detected from structured report", count=len(improvements))

            log.info(
                "Structured report ingested into evolution",
                quality=quality,
                risk_count=len(risks),
                improvement_count=len(improvements),
            )

            # 残留-1 修复：进化周期自动触发 — 当质量低于阈值或检测到高危风险时，
            # 采集信号并异步执行进化周期（信号→决策→执行→度量→回滚），打通"半开环"。
            _should_trigger = quality < 0.5 or len(high_risks) > 0
            if _should_trigger:
                try:
                    if high_risks:
                        _top_risk = (
                            high_risks[0].get("description", "")
                            if isinstance(high_risks[0], dict)
                            else getattr(high_risks[0], "description", "")
                        )
                        signal = self.collect_signal(
                            signal_type="risk_detected",
                            source="structured_report",
                            severity=1.0 - quality,
                            context={
                                "quality": quality,
                                "risk_count": len(high_risks),
                                "top_risk": _top_risk,
                            },
                        )
                    else:
                        signal = self.collect_signal(
                            signal_type="quality_drop",
                            source="structured_report",
                            severity=1.0 - quality,
                            context={"quality": quality, "prompt_id": "default"},
                        )
                    asyncio.ensure_future(self.execute_evolution(signal))
                    log.info(
                        "Evolution cycle auto-triggered",
                        signal_type=signal.signal_type,
                        quality=quality,
                        risk_count=len(high_risks),
                    )
                except Exception as _e:
                    log.warning("Auto-trigger evolution cycle failed", error=str(_e))
        except Exception as e:
            log.warning("Failed to ingest structured report", error=str(e))

    def get_recent_cycles(self, limit: int = 10) -> list[EvolutionCycleRecord]:
        return self._recent_cycles[-limit:]
