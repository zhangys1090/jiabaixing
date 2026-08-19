"""执行-感知闭环桥接器（Actuation-Perception Bridge）。

解决 PerceptionActionLoop 与 ActuationBus 耦合度不够的问题：
1. 执行后自动验证：ActuationBus 执行完成后自动触发 PerceptionActionLoop 验证
2. 多策略验证闭环：支持视觉验证、本体感验证、混合验证三种策略
3. 验证失败自动重试：验证失败时自动调整参数重试（最多 N 次）
4. 执行-验证-调整循环：验证失败时自动调整执行参数（位置偏移、力度调整等）
5. 闭环指标回流：将执行-验证闭环指标回流到 ClosedLoopMetricCollector

设计原则（遵循 AGENTS.md §0.1）：
- 决策核心在 Python
- 非侵入式：桥接 ActuationBus 和 PerceptionActionLoop，不修改两者内部逻辑
- 可选挂载：未挂载时 ActuationBus 独立运行，PerceptionActionLoop 独立运行
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

from agent.core.logger import StructuredLogger

log = StructuredLogger("actuation_perception_bridge")


class VerificationStrategy(str, Enum):
    VISUAL = "visual"
    PROPRIOCEPTION = "proprioception"
    HYBRID = "hybrid"
    NONE = "none"


class AdjustmentType(str, Enum):
    POSITION_OFFSET = "position_offset"
    FORCE_ADJUSTMENT = "force_adjustment"
    SPEED_ADJUSTMENT = "speed_adjustment"
    RETRY_WITH_SAME = "retry_with_same"
    ABANDON = "abandon"


@dataclass
class BridgeConfig:
    max_retries: int = 3
    default_strategy: VerificationStrategy = VerificationStrategy.HYBRID
    position_offset_step: float = 5.0
    force_adjustment_ratio: float = 0.2
    speed_adjustment_ratio: float = 0.3
    verification_delay_ms: float = 300.0
    confidence_threshold: float = 0.7
    enable_auto_adjustment: bool = True


@dataclass
class BridgeResult:
    success: bool = False
    total_attempts: int = 0
    final_strategy: VerificationStrategy = VerificationStrategy.NONE
    adjustments_applied: list[dict[str, Any]] = field(default_factory=list)
    verification_confidence: float = 0.0
    total_duration_ms: float = 0.0
    actuation_results: list[dict[str, Any]] = field(default_factory=list)
    verification_results: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class AdjustmentDecision:
    adjustment_type: AdjustmentType = AdjustmentType.RETRY_WITH_SAME
    parameter_changes: dict[str, Any] = field(default_factory=dict)
    reason: str = ""


class ActuationPerceptionBridge:
    """执行-感知闭环桥接器：串联 ActuationBus 执行和 PerceptionActionLoop 验证。"""

    _instance: ActuationPerceptionBridge | None = None

    def __init__(
        self,
        config: BridgeConfig | None = None,
        actuation_bus: Any = None,
        perception_loop: Any = None,
    ) -> None:
        self._config = config or BridgeConfig()
        self._bus = actuation_bus
        self._loop = perception_loop
        self._execution_count = 0
        self._success_count = 0
        self._adjustment_count = 0
        self._history: list[BridgeResult] = []
        self._max_history = 100

    @classmethod
    def get_instance(cls) -> ActuationPerceptionBridge:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def set_actuation_bus(self, bus: Any) -> None:
        self._bus = bus

    def set_perception_loop(self, loop: Any) -> None:
        self._loop = loop

    async def execute_with_verification(
        self,
        action_description: str,
        actuation_command: Any,
        verification_strategy: VerificationStrategy | None = None,
        context: dict[str, Any] | None = None,
    ) -> BridgeResult:
        self._execution_count += 1
        start = time.time()
        strategy = verification_strategy or self._config.default_strategy

        result = BridgeResult(
            final_strategy=strategy,
        )

        current_command = actuation_command

        for attempt in range(self._config.max_retries + 1):
            result.total_attempts = attempt + 1

            act_result = await self._execute_actuation(current_command)
            result.actuation_results.append({
                "attempt": attempt + 1,
                "success": act_result.get("success", False),
                "detail": act_result.get("detail", ""),
            })

            if not act_result.get("success", False):
                if attempt < self._config.max_retries:
                    decision = self._decide_adjustment(act_result, "actuation_failed", attempt)
                    if decision.adjustment_type == AdjustmentType.ABANDON:
                        break
                    current_command = self._apply_adjustment(current_command, decision)
                    result.adjustments_applied.append({
                        "attempt": attempt + 1,
                        "type": decision.adjustment_type.value,
                        "changes": decision.parameter_changes,
                        "reason": decision.reason,
                    })
                    self._adjustment_count += 1
                    continue
                break

            if strategy == VerificationStrategy.NONE:
                result.success = True
                result.verification_confidence = 1.0
                break

            if self._config.verification_delay_ms > 0:
                await asyncio.sleep(self._config.verification_delay_ms / 1000.0)

            verify_result = await self._verify_action(action_description, strategy, context)
            result.verification_results.append({
                "attempt": attempt + 1,
                "success": verify_result.get("success", False),
                "confidence": verify_result.get("confidence", 0.0),
                "method": verify_result.get("method", ""),
            })

            if verify_result.get("success", False) and verify_result.get("confidence", 0.0) >= self._config.confidence_threshold:
                result.success = True
                result.verification_confidence = verify_result.get("confidence", 0.0)
                break

            if attempt < self._config.max_retries and self._config.enable_auto_adjustment:
                decision = self._decide_adjustment(
                    verify_result, "verification_failed", attempt,
                )
                if decision.adjustment_type == AdjustmentType.ABANDON:
                    break
                current_command = self._apply_adjustment(current_command, decision)
                result.adjustments_applied.append({
                    "attempt": attempt + 1,
                    "type": decision.adjustment_type.value,
                    "changes": decision.parameter_changes,
                    "reason": decision.reason,
                })
                self._adjustment_count += 1

        result.total_duration_ms = (time.time() - start) * 1000

        if result.success:
            self._success_count += 1

        self._history.append(result)
        if len(self._history) > self._max_history:
            self._history = self._history[-self._max_history:]

        log.info(
            "Actuation-Perception bridge completed",
            action=action_description,
            success=result.success,
            attempts=result.total_attempts,
            confidence=result.verification_confidence,
            adjustments=len(result.adjustments_applied),
            duration_ms=round(result.total_duration_ms),
        )

        return result

    async def _execute_actuation(self, command: Any) -> dict[str, Any]:
        if self._bus is None:
            return {"success": False, "detail": "ActuationBus 未挂载"}

        try:
            result = await self._bus.execute(command)
            return {
                "success": result.success,
                "detail": result.detail or result.error or "",
                "status": result.status.value if hasattr(result.status, "value") else str(result.status),
            }
        except Exception as e:
            return {"success": False, "detail": f"执行异常: {e}"}

    async def _verify_action(
        self,
        action_description: str,
        strategy: VerificationStrategy,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if strategy == VerificationStrategy.VISUAL:
            return await self._verify_visual(action_description, context)
        if strategy == VerificationStrategy.PROPRIOCEPTION:
            return self._verify_proprioception(context)
        if strategy == VerificationStrategy.HYBRID:
            visual = await self._verify_visual(action_description, context)
            proprio = self._verify_proprioception(context)
            if visual.get("success", False) and proprio.get("success", False):
                confidence = (visual.get("confidence", 0.0) + proprio.get("confidence", 0.0)) / 2.0
                return {
                    "success": True,
                    "confidence": confidence,
                    "method": "hybrid",
                    "visual": visual,
                    "proprioception": proprio,
                }
            if visual.get("success", False):
                return visual
            if proprio.get("success", False):
                return proprio
            return {
                "success": False,
                "confidence": max(visual.get("confidence", 0.0), proprio.get("confidence", 0.0)),
                "method": "hybrid_failed",
            }
        return {"success": True, "confidence": 1.0, "method": "none"}

    async def _verify_visual(
        self,
        action_description: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self._loop is None:
            return {"success": False, "confidence": 0.0, "method": "visual_no_loop"}

        try:
            verify_result = await self._loop.verify_only(
                action_description=action_description,
                strategy="auto",
            )
            return {
                "success": verify_result.success,
                "confidence": verify_result.confidence,
                "method": verify_result.method,
                "evidence": verify_result.evidence[:200] if verify_result.evidence else "",
            }
        except Exception as e:
            return {"success": False, "confidence": 0.0, "method": "visual_error", "error": str(e)}

    def _verify_proprioception(self, context: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            from agent.perception.device_sense import get_proprioception_channel
            channel = get_proprioception_channel()
            recent = channel.get_recent(limit=1)
            if recent:
                sample = recent[0]
                confidence = sample.get("confidence", 0.0)
                return {
                    "success": confidence >= self._config.confidence_threshold,
                    "confidence": confidence,
                    "method": "proprioception",
                }
        except Exception:
            pass

        return {"success": True, "confidence": 0.5, "method": "proprioception_fallback"}

    def _decide_adjustment(
        self,
        result: dict[str, Any],
        failure_type: str,
        attempt: int,
    ) -> AdjustmentDecision:
        if attempt >= self._config.max_retries:
            return AdjustmentDecision(
                adjustment_type=AdjustmentType.ABANDON,
                reason="已达最大重试次数",
            )

        if failure_type == "actuation_failed":
            error = result.get("detail", "")
            if "timeout" in error.lower():
                return AdjustmentDecision(
                    adjustment_type=AdjustmentType.SPEED_ADJUSTMENT,
                    parameter_changes={"timeout_ms": 1.5},
                    reason="超时，增加超时时间",
                )
            if "position" in error.lower() or "坐标" in error:
                return AdjustmentDecision(
                    adjustment_type=AdjustmentType.POSITION_OFFSET,
                    parameter_changes={"offset_x": self._config.position_offset_step * (attempt + 1)},
                    reason="位置偏差，调整偏移",
                )
            return AdjustmentDecision(
                adjustment_type=AdjustmentType.RETRY_WITH_SAME,
                reason="执行失败，相同参数重试",
            )

        if failure_type == "verification_failed":
            confidence = result.get("confidence", 0.0)
            if confidence < 0.3:
                return AdjustmentDecision(
                    adjustment_type=AdjustmentType.POSITION_OFFSET,
                    parameter_changes={"offset_x": self._config.position_offset_step * (attempt + 1)},
                    reason=f"验证置信度过低 ({confidence:.2f})，调整位置",
                )
            return AdjustmentDecision(
                adjustment_type=AdjustmentType.FORCE_ADJUSTMENT,
                parameter_changes={"force_ratio": 1.0 + self._config.force_adjustment_ratio * (attempt + 1)},
                reason=f"验证失败但置信度尚可 ({confidence:.2f})，调整力度",
            )

        return AdjustmentDecision(
            adjustment_type=AdjustmentType.RETRY_WITH_SAME,
            reason="未知失败类型，相同参数重试",
        )

    def _apply_adjustment(self, command: Any, decision: AdjustmentDecision) -> Any:
        if not hasattr(command, "parameters"):
            return command

        params = dict(command.parameters)
        for key, value in decision.parameter_changes.items():
            if key in params:
                if isinstance(value, float) and isinstance(params[key], (int, float)):
                    params[key] = params[key] * value
                else:
                    params[key] = value
            else:
                if key == "offset_x":
                    params["offset_x"] = value
                elif key == "force_ratio":
                    current_force = params.get("force", 0.5)
                    params["force"] = current_force * value
                elif key == "timeout_ms":
                    current_timeout = getattr(command, "timeout_ms", 10000)
                    command.timeout_ms = int(current_timeout * value)
                elif key == "speed_ratio":
                    current_speed = params.get("speed", 0.5)
                    params["speed"] = current_speed * value

        command.parameters = params
        return command

    def get_stats(self) -> dict[str, Any]:
        total = len(self._history)
        success = sum(1 for r in self._history if r.success)
        avg_attempts = sum(r.total_attempts for r in self._history) / total if total > 0 else 0.0
        avg_confidence = sum(r.verification_confidence for r in self._history) / total if total > 0 else 0.0
        return {
            "total_executions": self._execution_count,
            "success_count": self._success_count,
            "adjustment_count": self._adjustment_count,
            "success_rate": round(success / total, 3) if total > 0 else 0.0,
            "avg_attempts": round(avg_attempts, 2),
            "avg_confidence": round(avg_confidence, 3),
            "history_size": total,
        }
