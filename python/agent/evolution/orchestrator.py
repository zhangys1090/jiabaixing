from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.evolution.engine import EvolutionEngine
from agent.evolution.llm_capability_detector import LLMCapabilityDetector, LLMCapabilities, LLMProtocol
from agent.evolution.strategy_adapter import StrategyAdapter
from agent.evolution.types import RollbackSnapshot
from agent.evolution.v2_engine import EvolutionEngineV2, V2EvolutionCause

log = StructuredLogger("evolution_orchestrator")

_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000
_AUTO_DETECTION_INTERVAL_SEC = 5 * 60
_MAX_QUALITY_HISTORY = 500
_MAX_RESPONSE_TIME_HISTORY = 500
_MAX_OPTIMIZATION_CYCLES = 100


@dataclass
class OptimizationCycleResult:
    engine_name: str
    triggered: bool
    detail: str = ""


@dataclass
class OptimizationCycle:
    cycle_id: str
    timestamp: float
    engines_participated: list[str] = field(default_factory=list)
    results: list[OptimizationCycleResult] = field(default_factory=list)
    overall_score: float = 0.0


@dataclass
class VerificationResult:
    vtype: str
    target: str
    before_score: float
    after_score: float
    success: bool
    confidence: float


@dataclass
class OrchestratorMetrics:
    total_interactions: int = 0
    total_optimizations: int = 0
    average_quality: float = 0.0
    quality_trend: str = "stable"
    response_time_avg: float = 0.0
    response_time_p95: float = 0.0
    cycle_success_rate: float = 0.0
    cycles_today: int = 0
    engines_active: list[str] = field(default_factory=list)
    verification_success_rate: float = 0.0
    tool_weights: dict[str, float] = field(default_factory=dict)
    recent_cycles: list[dict[str, Any]] = field(default_factory=list)


class EvolutionOrchestrator:
    _instance: EvolutionOrchestrator | None = None

    def __init__(self) -> None:
        self._evolution_engine: EvolutionEngine | None = None
        self._evolution_engine_v2: EvolutionEngineV2 | None = None
        self._capability_detector: LLMCapabilityDetector | None = None
        self._strategy_adapter: StrategyAdapter | None = None

        self._interaction_count = 0
        self._quality_history: list[float] = []
        self._response_time_history: list[float] = []
        self._optimization_cycles: list[OptimizationCycle] = []
        self._cycles_today = 0
        self._last_cycle_day = time.time()
        self._optimization_in_progress = False

        self._engine_cooldowns: dict[str, float] = {}
        self._engine_last_triggered: dict[str, float] = {}
        self._verification_results: list[VerificationResult] = []

        self._is_running = False
        self._auto_detection_task: asyncio.Task[None] | None = None
        self._start_time = time.time()

        self._consecutive_low_quality_count = 0
        self._consecutive_failure_count = 0
        self._last_auto_detection_time = 0.0

        # 验证回滚（P0）
        self._pending_rollbacks: dict[str, RollbackSnapshot] = {}
        self._VERIFICATION_INTERACTIONS = 5  # 优化后等待 N 次交互再验证
        self._ROLLBACK_THRESHOLD = 0.1       # 质量下降超过此阈值触发回滚

    @classmethod
    def get_instance(cls) -> EvolutionOrchestrator:
        if cls._instance is None:
            cls._instance = EvolutionOrchestrator()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        if cls._instance and cls._instance._is_running:
            cls._instance.stop()
        cls._instance = None

    def register_engines(
        self,
        evolution_engine: EvolutionEngine | None = None,
        evolution_engine_v2: EvolutionEngineV2 | None = None,
        capability_detector: LLMCapabilityDetector | None = None,
        strategy_adapter: StrategyAdapter | None = None,
    ) -> None:
        self._evolution_engine = evolution_engine
        self._evolution_engine_v2 = evolution_engine_v2
        self._capability_detector = capability_detector
        self._strategy_adapter = strategy_adapter

        active: list[str] = []
        if evolution_engine:
            active.append("EvolutionEngine")
        if evolution_engine_v2:
            active.append("EvolutionEngineV2")
        if capability_detector:
            active.append("LLMCapabilityDetector")
        if strategy_adapter:
            active.append("StrategyAdapter")

        log.info(f"Evolution orchestrator registered {len(active)} engines: {', '.join(active)}")

    def start(self) -> None:
        if self._is_running:
            log.warning("Evolution orchestrator already running")
            return
        self._is_running = True
        self._start_auto_detection()
        log.info("Evolution orchestrator started")

    def stop(self) -> None:
        self._is_running = False
        if self._auto_detection_task:
            self._auto_detection_task.cancel()
            self._auto_detection_task = None
        log.info("Evolution orchestrator stopped")

    def _start_auto_detection(self) -> None:
        async def _loop() -> None:
            while self._is_running:
                try:
                    await asyncio.sleep(_AUTO_DETECTION_INTERVAL_SEC)
                    if self._is_running:
                        await self._run_auto_detection()
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    log.error("Auto detection error", error=str(e))

        self._auto_detection_task = asyncio.create_task(_loop())

    async def record_interaction(self, quality: float, response_time_ms: float, tool_successes: bool = True) -> None:
        self._interaction_count += 1
        self._quality_history.append(quality)
        self._response_time_history.append(response_time_ms)

        if len(self._quality_history) > _MAX_QUALITY_HISTORY:
            self._quality_history = self._quality_history[-_MAX_QUALITY_HISTORY:]
        if len(self._response_time_history) > _MAX_RESPONSE_TIME_HISTORY:
            self._response_time_history = self._response_time_history[-_MAX_RESPONSE_TIME_HISTORY:]

        if not tool_successes:
            self._consecutive_failure_count += 1
            self._consecutive_low_quality_count += 1
        else:
            if quality < 0.4:
                self._consecutive_low_quality_count += 1
            else:
                self._consecutive_low_quality_count = max(0, self._consecutive_low_quality_count - 1)

        if quality >= 0.6:
            self._consecutive_failure_count = 0

        # P1-3: 每轮触发轻量学习信号收集（替代纯周期性检测）
        await self._per_turn_lightweight_signal(quality, response_time_ms, tool_successes)

        if self._interaction_count % 20 == 0:
            await self._trigger_optimization_cycle("periodic_check")

        if self._consecutive_low_quality_count >= 3:
            await self._trigger_optimization_cycle("consecutive_low_quality")
            self._consecutive_low_quality_count = 0

        if self._consecutive_failure_count >= 2:
            await self._trigger_optimization_cycle("consecutive_tool_failure")
            self._consecutive_failure_count = 0

        if len(self._quality_history) >= 5:
            recent_avg = sum(self._quality_history[-5:]) / 5
            if len(self._quality_history) >= 10:
                prev_avg = sum(self._quality_history[-10:-5]) / 5
                if prev_avg - recent_avg > 0.2:
                    await self._trigger_optimization_cycle("quality_degradation_detected")

        # 验证回滚：检查待验证的优化，看质量是否下降
        if self._pending_rollbacks:
            await self._check_pending_rollbacks(quality)

    async def _per_turn_lightweight_signal(
        self,
        quality: float,
        response_time_ms: float,
        tool_successes: bool,
    ) -> None:
        """P1-3: 每轮触发轻量学习信号收集。

        替代纯周期性(5分钟)检测，每轮交互后立即收集信号并
        进行轻量级策略微调，无需等待完整优化周期。

        设计目标：<50ms，不阻塞主流程，失败时静默降级。
        """
        try:
            self._per_turn_signals = getattr(self, "_per_turn_signals", [])
            self._per_turn_signals.append({
                "quality": quality,
                "response_time_ms": response_time_ms,
                "tool_successes": tool_successes,
                "timestamp": time.time(),
            })

            if len(self._per_turn_signals) > 50:
                self._per_turn_signals = self._per_turn_signals[-50:]

            if len(self._per_turn_signals) < 3:
                return

            recent = self._per_turn_signals[-3:]
            avg_q = sum(s["quality"] for s in recent) / len(recent)
            avg_rt = sum(s["response_time_ms"] for s in recent) / len(recent)
            failure_rate = sum(1 for s in recent if not s["tool_successes"]) / len(recent)

            if self._strategy_adapter:
                if failure_rate > 0.5:
                    self._strategy_adapter.record_signal("high_failure_rate", value=-1.0)
                elif avg_q > 0.8 and failure_rate == 0:
                    self._strategy_adapter.record_signal("high_quality_streak", value=1.0)

                if avg_rt > 5000:
                    self._strategy_adapter.record_signal("slow_response", value=-0.5)

            if self._evolution_engine and hasattr(self._evolution_engine, "_tool_weights"):
                for s in recent:
                    if not s["tool_successes"]:
                        for tool_name, weight in list(self._evolution_engine._tool_weights.items()):
                            self._evolution_engine._tool_weights[tool_name] = max(
                                0.1, weight * 0.95
                            )

            log.debug(
                "Per-turn lightweight signal processed",
                avg_quality=round(avg_q, 3),
                avg_response_time_ms=round(avg_rt, 1),
                failure_rate=round(failure_rate, 3),
            )
        except Exception as e:
            log.debug("Per-turn lightweight signal failed", error=str(e))

    async def _trigger_optimization_cycle(self, reason: str) -> None:
        if self._optimization_in_progress:
            return

        now = time.time()
        self._optimization_in_progress = True

        try:
            cycle_id = f"cycle_{uuid.uuid4().hex[:8]}"
            results: list[OptimizationCycleResult] = []

            # 验证回滚：优化前拍快照
            pre_snapshot = self._take_baseline_snapshot(cycle_id, reason)

            if self._evolution_engine:
                cooldown = self._engine_cooldowns.get("EvolutionEngine", _DEFAULT_COOLDOWN_MS)
                last = self._engine_last_triggered.get("EvolutionEngine", 0)
                if now - last >= cooldown / 1000:
                    try:
                        plan = await self._evolution_engine.should_evolve()
                        if plan:
                            result = await self._evolution_engine.execute_evolution(plan)
                            results.append(OptimizationCycleResult(
                                engine_name="EvolutionEngine",
                                triggered=True,
                                detail=f"Type: {plan.evolution_type}, Actions: {result.executed_actions}/{result.total_actions}",
                            ))
                            self._engine_last_triggered["EvolutionEngine"] = now
                        else:
                            results.append(OptimizationCycleResult(
                                engine_name="EvolutionEngine",
                                triggered=False,
                                detail="No evolution needed",
                            ))
                    except Exception as e:
                        results.append(OptimizationCycleResult(
                            engine_name="EvolutionEngine",
                            triggered=False,
                            detail=str(e),
                        ))
                else:
                    results.append(OptimizationCycleResult(
                        engine_name="EvolutionEngine",
                        triggered=False,
                        detail="Cooldown period",
                    ))

            if self._evolution_engine_v2:
                cooldown = self._engine_cooldowns.get("EvolutionEngineV2", _DEFAULT_COOLDOWN_MS)
                last = self._engine_last_triggered.get("EvolutionEngineV2", 0)
                if now - last >= cooldown / 1000:
                    try:
                        cause_dict = self._detect_v2_evolution_cause()
                        if cause_dict:
                            # _detect_v2_evolution_cause 返回 dict，需转换为 V2EvolutionCause；
                            # 且 EvolutionEngineV2 的公开 API 为 trigger_evolution（内部完成
                            # generate_evolution_plan + 执行 + 校验 + 回滚），历史上误调用
                            # 不存在的 plan_evolution/execute 导致 AttributeError 被吞、V2 从不执行。
                            cause = V2EvolutionCause(
                                type=str(cause_dict.get("type", "")),
                                description=str(cause_dict.get("description", "")),
                                context=cause_dict.get("context", {}) or {},
                                timestamp=float(cause_dict.get("timestamp", now)),
                            )
                            v2_result = await self._evolution_engine_v2.trigger_evolution(cause)
                            if v2_result is not None:
                                results.append(OptimizationCycleResult(
                                    engine_name="EvolutionEngineV2",
                                    triggered=True,
                                    detail=(
                                        f"Cause: {cause.type}, Success: {v2_result.success}, "
                                        f"actions: {v2_result.executed_actions}, "
                                        f"validation: {v2_result.validation_passed}"
                                    ),
                                ))
                                self._engine_last_triggered["EvolutionEngineV2"] = now
                            else:
                                results.append(OptimizationCycleResult(
                                    engine_name="EvolutionEngineV2",
                                    triggered=False,
                                    detail="No plan generated / evolution skipped",
                                ))
                        else:
                            results.append(OptimizationCycleResult(
                                engine_name="EvolutionEngineV2",
                                triggered=False,
                                detail="No evolution cause detected",
                            ))
                    except Exception as e:
                        results.append(OptimizationCycleResult(
                            engine_name="EvolutionEngineV2",
                            triggered=False,
                            detail=str(e),
                        ))
                else:
                    results.append(OptimizationCycleResult(
                        engine_name="EvolutionEngineV2",
                        triggered=False,
                        detail="Cooldown period",
                    ))

            cycle = OptimizationCycle(
                cycle_id=cycle_id,
                timestamp=now,
                engines_participated=[r.engine_name for r in results if r.triggered],
                results=results,
                overall_score=self._calculate_overall_score(),
            )
            self._optimization_cycles.append(cycle)
            if len(self._optimization_cycles) > _MAX_OPTIMIZATION_CYCLES:
                self._optimization_cycles = self._optimization_cycles[-_MAX_OPTIMIZATION_CYCLES:]

            self._cycles_today += 1
            triggered = sum(1 for r in results if r.triggered)
            log.info(
                f"Optimization cycle completed: {cycle_id} "
                f"(engines: {triggered}/{len(results)}, reason: {reason})"
            )

            # 验证回滚：有引擎被触发优化时，将基线加入待验证队列
            if triggered > 0:
                pre_snapshot.tool_weights = dict(self._evolution_engine._tool_weights) if self._evolution_engine else {}
                self._pending_rollbacks[cycle_id] = pre_snapshot
                log.info(
                    "Rollback baseline saved, pending verification",
                    cycle_id=cycle_id,
                    baseline_quality=round(pre_snapshot.avg_quality, 3),
                    verification_after=self._VERIFICATION_INTERACTIONS,
                )

        finally:
            self._optimization_in_progress = False

    async def _run_auto_detection(self) -> None:
        now = time.time()
        if now - self._last_auto_detection_time < _AUTO_DETECTION_INTERVAL_SEC:
            return
        self._last_auto_detection_time = now

        cause = self._detect_auto_improvement()
        if cause:
            log.info(f"Auto-detected improvement: {cause.get('type')} - {cause.get('description', '')}")
            await self._trigger_optimization_cycle("auto_detection")

    def _detect_auto_improvement(self) -> dict[str, Any] | None:
        if self._interaction_count < 10:
            return None

        avg_quality = self._calculate_avg_quality()
        trend = self._calculate_quality_trend()

        if self._consecutive_low_quality_count >= 3 and avg_quality < 0.5:
            return {
                "type": "LOW_QUALITY",
                "description": f"连续低质量 ({self._consecutive_low_quality_count}次, avg={avg_quality:.2f})",
                "context": {"avg_quality": avg_quality},
                "timestamp": time.time(),
            }

        if self._consecutive_failure_count >= 3:
            return {
                "type": "FAILURE",
                "description": f"连续失败 ({self._consecutive_failure_count}次)",
                "context": {"consecutive_failures": self._consecutive_failure_count},
                "timestamp": time.time(),
            }

        if self._interaction_count > 50 and avg_quality > 0.7 and trend == "stable":
            last_cycle = self._optimization_cycles[-1].timestamp if self._optimization_cycles else 0
            if time.time() - last_cycle > 60 * 60:
                return {
                    "type": "PROACTIVE_IMPROVEMENT",
                    "description": f"系统稳定 (avg={avg_quality:.2f})，主动优化",
                    "context": {"avg_quality": avg_quality},
                    "timestamp": time.time(),
                }

        return None

    def _detect_v2_evolution_cause(self) -> dict[str, Any] | None:
        if self._interaction_count < 5:
            return None

        avg_quality = self._calculate_avg_quality()

        if self._consecutive_low_quality_count >= 3:
            return {
                "type": "LOW_QUALITY",
                "description": f"连续低质量交互 ({self._consecutive_low_quality_count}次)",
                "context": {"avg_quality": avg_quality},
                "timestamp": time.time(),
            }

        if self._consecutive_failure_count >= 3:
            return {
                "type": "FAILURE",
                "description": f"连续失败 ({self._consecutive_failure_count}次)",
                "context": {"consecutive_failures": self._consecutive_failure_count},
                "timestamp": time.time(),
            }

        return None

    async def detect_and_adapt_llm_capabilities(self, provider: str, llm: LLMProtocol) -> dict[str, Any] | None:
        if not self._capability_detector:
            log.warning("No capability detector registered")
            return None

        self._capability_detector.set_llm(llm)
        caps = await self._capability_detector.detect(provider, force=True)

        if not caps or not self._strategy_adapter:
            return None

        config = await self._strategy_adapter.adapt(caps)
        return {"capabilities": caps.to_dict(), "strategy": config.to_dict()}

    def get_current_llm_capabilities(self, provider: str) -> dict[str, Any] | None:
        if not self._capability_detector:
            return None
        caps = self._capability_detector.get_cached(provider)
        return caps.to_dict() if caps else None

    def get_current_strategy(self) -> dict[str, Any] | None:
        if not self._strategy_adapter:
            return None
        config = self._strategy_adapter.get_current_config()
        return config.to_dict() if config else None

    def get_metrics(self) -> OrchestratorMetrics:
        avg_quality = self._calculate_avg_quality()
        avg_time = self._calculate_avg_response_time()
        p95_time = self._calculate_p95_response_time()

        cycle_success = 0.0
        if self._optimization_cycles:
            successful = sum(1 for c in self._optimization_cycles if any(r.triggered for r in c.results))
            cycle_success = successful / len(self._optimization_cycles)

        verif_success = 0.0
        if self._verification_results:
            verif_success = sum(1 for v in self._verification_results if v.success) / len(self._verification_results)

        engines = []
        if self._evolution_engine:
            engines.append("EvolutionEngine")
        if self._evolution_engine_v2:
            engines.append("EvolutionEngineV2")
        if self._capability_detector:
            engines.append("LLMCapabilityDetector")
        if self._strategy_adapter:
            engines.append("StrategyAdapter")

        tool_weights: dict[str, float] = {}
        if self._evolution_engine:
            tool_weights = dict(self._evolution_engine._tool_weights)

        recent_cycles = []
        for c in self._optimization_cycles[-10:]:
            recent_cycles.append({
                "cycle_id": c.cycle_id,
                "timestamp": c.timestamp,
                "engines": c.engines_participated,
                "triggered": sum(1 for r in c.results if r.triggered),
                "score": c.overall_score,
            })

        return OrchestratorMetrics(
            total_interactions=self._interaction_count,
            total_optimizations=len(self._optimization_cycles),
            average_quality=avg_quality,
            quality_trend=self._calculate_quality_trend(),
            response_time_avg=avg_time,
            response_time_p95=p95_time,
            cycle_success_rate=cycle_success,
            cycles_today=self._cycles_today,
            engines_active=engines,
            verification_success_rate=verif_success,
            tool_weights=tool_weights,
            recent_cycles=recent_cycles,
        )

    def set_engine_cooldown(self, engine_name: str, cooldown_ms: int) -> None:
        self._engine_cooldowns[engine_name] = cooldown_ms

    def reset_daily_count(self) -> None:
        self._cycles_today = 0
        self._last_cycle_day = time.time()

    def add_verification(self, vtype: str, target: str, before_score: float, after_score: float, success: bool, confidence: float) -> None:
        self._verification_results.append(VerificationResult(
            vtype=vtype,
            target=target,
            before_score=before_score,
            after_score=after_score,
            success=success,
            confidence=confidence,
        ))

    def _calculate_avg_quality(self) -> float:
        if not self._quality_history:
            return 0.0
        recent = self._quality_history[-20:]
        return sum(recent) / len(recent)

    def _calculate_avg_response_time(self) -> float:
        if not self._response_time_history:
            return 0.0
        recent = self._response_time_history[-20:]
        return sum(recent) / len(recent)

    def _calculate_p95_response_time(self) -> float:
        if not self._response_time_history:
            return 0.0
        sorted_times = sorted(self._response_time_history[-50:])
        idx = int(len(sorted_times) * 0.95) - 1
        return sorted_times[max(0, idx)]

    def _calculate_quality_trend(self) -> str:
        if len(self._quality_history) < 10:
            return "stable"
        first_half = self._quality_history[-10:-5]
        second_half = self._quality_history[-5:]
        if len(first_half) < 3 or len(second_half) < 3:
            return "stable"
        avg_first = sum(first_half) / len(first_half)
        avg_second = sum(second_half) / len(second_half)
        if avg_second > avg_first + 0.05:
            return "improving"
        elif avg_second < avg_first - 0.05:
            return "declining"
        return "stable"

    def _calculate_overall_score(self) -> float:
        avg_quality = self._calculate_avg_quality()
        cycle_success = 0.0
        if self._optimization_cycles:
            successful = sum(1 for c in self._optimization_cycles if any(r.triggered for r in c.results))
            cycle_success = successful / len(self._optimization_cycles)
        return avg_quality * 0.6 + cycle_success * 0.4

    @property
    def is_running(self) -> bool:
        return self._is_running

    def get_realtime_feedback(self) -> dict[str, Any]:
        """获取实时学习反馈，供执行层即时调整策略。

        P1-3: 增强为包含每轮轻量信号分析结果。
        """
        avg_quality = self._calculate_avg_quality()
        trend = self._calculate_quality_trend()

        suggested_max_retries = 2
        suggested_reflection_depth = "medium"
        should_slow_down = False

        if avg_quality < 0.4:
            suggested_max_retries = 4
            suggested_reflection_depth = "deep"
            should_slow_down = True
        elif avg_quality < 0.6:
            suggested_max_retries = 3
            suggested_reflection_depth = "deep"
        elif avg_quality > 0.8 and trend == "improving":
            suggested_max_retries = 1
            suggested_reflection_depth = "shallow"

        tool_recommendations: dict[str, float] = {}
        if self._evolution_engine:
            tool_recommendations = dict(self._evolution_engine._tool_weights)

        per_turn_summary: dict[str, Any] = {}
        per_turn_signals = getattr(self, "_per_turn_signals", [])
        if per_turn_signals:
            recent = per_turn_signals[-5:]
            per_turn_summary = {
                "recent_avg_quality": round(sum(s["quality"] for s in recent) / len(recent), 3),
                "recent_avg_response_ms": round(sum(s["response_time_ms"] for s in recent) / len(recent), 1),
                "recent_failure_rate": round(sum(1 for s in recent if not s["tool_successes"]) / len(recent), 3),
                "signal_count": len(per_turn_signals),
            }

        return {
            "suggested_max_retries": suggested_max_retries,
            "suggested_reflection_depth": suggested_reflection_depth,
            "tool_recommendations": tool_recommendations,
            "quality_trend": trend,
            "average_quality": avg_quality,
            "should_slow_down": should_slow_down,
            "consecutive_failures": self._consecutive_failure_count,
            "consecutive_low_quality": self._consecutive_low_quality_count,
            "per_turn_summary": per_turn_summary,
        }

    def _take_baseline_snapshot(self, cycle_id: str, reason: str) -> RollbackSnapshot:
        """拍优化前的状态基线快照。"""
        avg_q = self._calculate_avg_quality()
        avg_rt = (
            sum(self._response_time_history) / len(self._response_time_history)
            if self._response_time_history else 0.0
        )
        return RollbackSnapshot(
            cycle_id=cycle_id,
            timestamp=time.time(),
            avg_quality=avg_q,
            avg_response_time_ms=avg_rt,
            interaction_count=self._interaction_count,
            tool_weights={},
            reason=reason,
        )

    async def _check_pending_rollbacks(self, current_quality: float) -> None:
        """检查待验证的优化，若质量下降则触发回滚。"""
        expired: list[str] = []
        for cycle_id, snapshot in self._pending_rollbacks.items():
            # 等待足够多的交互后再验证（审计 E-01：原用"交互计数 − 时间戳"恒为负，
            # 导致回滚判断永不触发；改为基于快照时的交互计数差值）
            if self._interaction_count - snapshot.interaction_count < self._VERIFICATION_INTERACTIONS:
                continue

            if current_quality < snapshot.avg_quality - self._ROLLBACK_THRESHOLD:
                log.warning(
                    "Quality degraded after evolution, triggering rollback",
                    cycle_id=cycle_id,
                    baseline=round(snapshot.avg_quality, 3),
                    current=round(current_quality, 3),
                    threshold=self._ROLLBACK_THRESHOLD,
                )
                await self._rollback_evolution(cycle_id, snapshot)
                expired.append(cycle_id)
            else:
                # 质量未下降，移除验证
                expired.append(cycle_id)

        for cid in expired:
            self._pending_rollbacks.pop(cid, None)

    async def _rollback_evolution(self, cycle_id: str, snapshot: RollbackSnapshot) -> None:
        """回滚到优化前的状态。"""
        if self._evolution_engine:
            try:
                # 恢复工具权重
                if snapshot.tool_weights:
                    self._evolution_engine._tool_weights = dict(snapshot.tool_weights)
                    self._evolution_engine._save_state()
                    log.info(
                        "Rollback executed: tool weights restored",
                        cycle_id=cycle_id,
                        tools=len(snapshot.tool_weights),
                    )
                snapshot.rolled_back = True
                self.add_verification(
                    vtype="rollback",
                    target=f"evolution_{cycle_id}",
                    before_score=snapshot.avg_quality,
                    after_score=self._calculate_avg_quality(),
                    success=True,
                    confidence=0.8,
                )
                log.info(
                    "Rollback completed",
                    cycle_id=cycle_id,
                    reason=snapshot.reason,
                )
            except Exception as e:
                log.error("Rollback failed", cycle_id=cycle_id, error=str(e))
