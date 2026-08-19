"""元决策引擎 — 基于决策经验的自适应策略选择。

设计目标：
1. 元决策：决定"如何决策"，而非直接决策
2. 决策经验持久化：记录每次决策的上下文/策略/结果，跨会话复用
3. 策略自适应：根据历史成功率动态调整决策策略权重
4. Q-Learning 启发：状态-动作价值表驱动策略选择

决策策略：
- rule_based: 规则驱动（快速，低消耗）
- llm_driven: LLM 驱动（精确，高消耗）
- debate_driven: 辩论驱动（最严谨，最高消耗）
- mcts_driven: MCTS 搜索驱动（探索性，中等消耗）

状态空间：
- 任务复杂度: simple/moderate/complex
- 感知场景: desktop/coding/research/daily/automation
- 情绪状态: neutral/frustrated/anxious/confident/curious
- 风险等级: low/medium/high/critical

Usage:
    engine = MetaDecisionEngine(data_dir="/path/to/data")
    strategy = engine.decide(context)
    engine.record_outcome(strategy, success=True)
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("meta_decision_engine")


class DecisionStrategy(str, Enum):
    RULE_BASED = "rule_based"
    LLM_DRIVEN = "llm_driven"
    DEBATE_DRIVEN = "debate_driven"
    MCTS_DRIVEN = "mcts_driven"


@dataclass
class DecisionContext:
    complexity: str = "moderate"
    scene: str = "daily"
    emotion: str = "neutral"
    risk_level: str = "low"
    has_perception: bool = False
    tool_count: int = 0
    step_count: int = 0
    user_input_preview: str = ""


@dataclass
class DecisionRecord:
    timestamp: float = 0.0
    context: DecisionContext = field(default_factory=DecisionContext)
    strategy: DecisionStrategy = DecisionStrategy.RULE_BASED
    outcome: str = "unknown"
    duration_ms: float = 0.0
    quality_score: float = 0.0
    session_id: str = ""


@dataclass
class StrategyStats:
    total: int = 0
    successes: int = 0
    total_quality: float = 0.0
    avg_duration_ms: float = 0.0

    @property
    def success_rate(self) -> float:
        return self.successes / self.total if self.total > 0 else 0.5

    @property
    def avg_quality(self) -> float:
        return self.total_quality / self.total if self.total > 0 else 0.5


class MetaDecisionEngine:
    def __init__(self, data_dir: str | None = None) -> None:
        self._data_dir = Path(data_dir) if data_dir else Path(
            os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent.parent / "data"))
        ) / "meta_decision"
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._state_path = self._data_dir / "q_table.json"
        self._history_path = self._data_dir / "history.jsonl"

        self._q_table: dict[str, dict[str, float]] = {}
        self._strategy_stats: dict[str, StrategyStats] = {
            s.value: StrategyStats() for s in DecisionStrategy
        }
        self._learning_rate = float(os.environ.get("META_DECISION_LR", "0.1"))
        self._discount_factor = float(os.environ.get("META_DECISION_GAMMA", "0.9"))
        self._exploration_rate = float(os.environ.get("META_DECISION_EPSILON", "0.15"))
        self._max_history = 500
        self._history: list[DecisionRecord] = []

        self._load_state()

    def _load_state(self) -> None:
        if self._state_path.exists():
            try:
                raw = json.loads(self._state_path.read_text(encoding="utf-8"))
                self._q_table = raw.get("q_table", {})
                for sname, sdata in raw.get("strategy_stats", {}).items():
                    if sname in self._strategy_stats:
                        self._strategy_stats[sname] = StrategyStats(
                            total=sdata.get("total", 0),
                            successes=sdata.get("successes", 0),
                            total_quality=sdata.get("total_quality", 0.0),
                            avg_duration_ms=sdata.get("avg_duration_ms", 0.0),
                        )
            except Exception as e:
                log.warning("Failed to load meta decision state", error=str(e))

    def _save_state(self) -> None:
        try:
            state = {
                "q_table": self._q_table,
                "strategy_stats": {
                    name: {
                        "total": stats.total,
                        "successes": stats.successes,
                        "total_quality": stats.total_quality,
                        "avg_duration_ms": stats.avg_duration_ms,
                    }
                    for name, stats in self._strategy_stats.items()
                },
            }
            self._state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            log.warning("Failed to save meta decision state", error=str(e))

    def _append_history(self, record: DecisionRecord) -> None:
        try:
            with open(self._history_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "ts": record.timestamp,
                    "strategy": record.strategy.value,
                    "outcome": record.outcome,
                    "quality": record.quality_score,
                    "complexity": record.context.complexity,
                    "scene": record.context.scene,
                    "emotion": record.context.emotion,
                    "risk": record.context.risk_level,
                    "duration_ms": record.duration_ms,
                }, ensure_ascii=False) + "\n")
        except Exception as e:
            log.debug("Failed to append history", error=str(e))

    def _state_key(self, context: DecisionContext) -> str:
        return f"{context.complexity}|{context.scene}|{context.emotion}|{context.risk_level}"

    def decide(self, context: DecisionContext) -> DecisionStrategy:
        state_key = self._state_key(context)

        import random
        if random.random() < self._exploration_rate:
            strategy = random.choice(list(DecisionStrategy))
            log.debug("Exploration decision", strategy=strategy.value, state=state_key)
            return strategy

        q_values = self._q_table.get(state_key, {})
        if not q_values:
            return self._heuristic_decision(context)

        best_strategy = max(q_values, key=lambda k: q_values[k])
        if q_values[best_strategy] < 0.3:
            return self._heuristic_decision(context)

        return DecisionStrategy(best_strategy)

    def _heuristic_decision(self, context: DecisionContext) -> DecisionStrategy:
        if context.risk_level in ("high", "critical"):
            return DecisionStrategy.DEBATE_DRIVEN

        if context.complexity == "complex":
            if context.scene in ("automation", "debugging"):
                return DecisionStrategy.MCTS_DRIVEN
            return DecisionStrategy.DEBATE_DRIVEN

        if context.complexity == "moderate":
            if context.emotion in ("frustrated", "anxious"):
                return DecisionStrategy.DEBATE_DRIVEN
            return DecisionStrategy.LLM_DRIVEN

        return DecisionStrategy.RULE_BASED

    def record_outcome(
        self,
        context: DecisionContext,
        strategy: DecisionStrategy,
        success: bool,
        quality_score: float = 0.5,
        duration_ms: float = 0.0,
        session_id: str = "",
    ) -> None:
        state_key = self._state_key(context)
        action_key = strategy.value

        reward = quality_score if success else -0.2
        current_q = self._q_table.get(state_key, {}).get(action_key, 0.5)
        max_future_q = max(self._q_table.get(state_key, {}).values(), default=0.5)
        new_q = current_q + self._learning_rate * (
            reward + self._discount_factor * max_future_q - current_q
        )

        if state_key not in self._q_table:
            self._q_table[state_key] = {}
        self._q_table[state_key][action_key] = new_q

        stats = self._strategy_stats.get(action_key)
        if stats:
            stats.total += 1
            if success:
                stats.successes += 1
            stats.total_quality += quality_score
            stats.avg_duration_ms = (
                (stats.avg_duration_ms * (stats.total - 1) + duration_ms) / stats.total
                if stats.total > 0 else duration_ms
            )

        record = DecisionRecord(
            timestamp=time.time(),
            context=context,
            strategy=strategy,
            outcome="success" if success else "failure",
            duration_ms=duration_ms,
            quality_score=quality_score,
            session_id=session_id,
        )
        self._history.append(record)
        self._append_history(record)

        if len(self._history) >= 10:
            self._save_state()
            self._history.clear()

    def get_stats(self) -> dict[str, Any]:
        return {
            "q_table_size": len(self._q_table),
            "strategy_stats": {
                name: {
                    "total": stats.total,
                    "success_rate": round(stats.success_rate, 3),
                    "avg_quality": round(stats.avg_quality, 3),
                    "avg_duration_ms": round(stats.avg_duration_ms, 1),
                }
                for name, stats in self._strategy_stats.items()
            },
        }

    def build_context_from_loop(
        self,
        context: Any,
        perception_state: Any = None,
    ) -> DecisionContext:
        complexity = "moderate"
        scene = "daily"
        emotion = "neutral"
        risk_level = "low"
        has_perception = False
        tool_count = 0
        step_count = 0

        if context:
            plan = getattr(context, "plan", None)
            if plan:
                step_count = len(plan.steps)
                if step_count <= 1:
                    complexity = "simple"
                elif step_count <= 3:
                    complexity = "moderate"
                else:
                    complexity = "complex"
                tool_count = sum(1 for s in plan.steps if s.tool_name)
                risks = [s.risk_level for s in plan.steps if s.risk_level]
                if risks:
                    risk_priority = {"low": 0, "medium": 1, "high": 2, "critical": 3}
                    risk_level = max(risks, key=lambda r: risk_priority.get(r, 0))

        if perception_state:
            has_perception = True
            scene_obj = getattr(perception_state, "scene", None)
            if scene_obj and hasattr(scene_obj, "scene_type"):
                scene = scene_obj.scene_type
            emotion_obj = getattr(perception_state, "emotion", None)
            if emotion_obj and hasattr(emotion_obj, "emotion_type"):
                emotion = emotion_obj.emotion_type

        user_input_preview = ""
        if context:
            user_input_preview = getattr(context, "user_input", "") or ""

        return DecisionContext(
            complexity=complexity,
            scene=scene,
            emotion=emotion,
            risk_level=risk_level,
            has_perception=has_perception,
            tool_count=tool_count,
            step_count=step_count,
            user_input_preview=user_input_preview,
        )
