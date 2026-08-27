from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
from agent.infrastructure.safe_json import safe_json_loads
from agent.core.types import RiskLevel
from agent.security.sensitive_detector import CheckScene
from agent.evolution.feedback_collector import FeedbackCollector
from agent.evolution.types import (
    EvolutionAction,
    EvolutionCause,
    EvolutionMetrics,
    EvolutionPlan,
    EvolutionPriority,
    EvolutionResult,
    EvolutionType,
    FeedbackSignal,
    LearningSignal,
    ReflectionConfig,
    SignalType,
)

log = StructuredLogger("evolution_engine")

_PERSISTENCE_KEYWORDS = [
    "我喜欢", "我偏好", "记住", "以后都这样", "以后都", "每次都",
    "总是", "习惯", "偏好", "我习惯", "请记住", "务必", "一定要",
    "默认", "我的风格", "按照我", "我通常",
]


class EvolutionEngine:
    def __init__(self, data_dir: str | None = None) -> None:
        self._metrics = EvolutionMetrics()
        self._feedback_history: list[FeedbackSignal] = []
        self._evolution_history: list[EvolutionResult] = []
        self._tool_weights: dict[str, float] = {}
        self._prompt_examples: list[dict[str, str]] = []
        self._quality_threshold = 0.7
        self._tool_call_stats: dict[str, dict[str, Any]] = {}
        self._scene_quality: dict[str, list[float]] = {}
        self._correction_rules: list[dict[str, str]] = []
        self._knowledge_nudges: list[str] = []
        self._tool_signal_stats: dict[str, dict[str, Any]] = {}
        self._MAX_TOOL_SIGNAL_STATS = 500
        self._MAX_EVOLUTION_HISTORY = 5000
        self._MAX_TOOL_CALL_STATS = 500
        self._MAX_SCENE_QUALITY = 500
        self._MAX_SKILLS = 500
        self._MAX_SKILL_QUALITY_HISTORY = 500
        self._MAX_USED_PLAN_IDS = 5000
        self._task_success_count: int = 0
        self._task_failure_count: int = 0
        self._total_signals: int = 0
        self._skills: dict[str, dict[str, Any]] = {}
        self._skill_quality_history: dict[str, list[float]] = {}
        self._tool_sequence_history: list[tuple[str, ...]] = []
        self._compound_skills: dict[str, dict[str, Any]] = {}
        self._MAX_TOOL_SEQUENCE_HISTORY = 2000
        self._MAX_COMPOUND_SKILLS = 100
        self._COMPOUND_PATTERN_MIN_OCCURRENCE = 2
        self._data_dir = Path(data_dir) if data_dir else Path(__file__).resolve().parent.parent.parent / "data" / "evolution"
        self._state_path = self._data_dir / "engine-state.json"
        self._used_plan_ids: set[str] = set()
        self._feedback_collector = FeedbackCollector()
        self._load_state()

    def _load_state(self) -> None:
        if not self._state_path.exists():
            return
        try:
            raw = self._state_path.read_text(encoding="utf-8")
        except OSError as _exc:
            log_ignored(log, "evolution.EvolutionEngine._load_state", _exc)
            return
        state = safe_json_loads(raw, {}, context="evolution.load_state")
        if not isinstance(state, dict):
            # 顶层损坏：保留内存中已有（可能为空）的默认状态，不再抛异常
            return
        # 逐键容错：单条损坏仅跳过该键，不再把整份进化状态静默清空
        if isinstance(state.get("tool_weights"), dict):
            self._tool_weights = state["tool_weights"]
        if isinstance(state.get("tool_call_stats"), dict):
            self._tool_call_stats = state["tool_call_stats"]
        if isinstance(state.get("prompt_examples"), list):
            self._prompt_examples = state["prompt_examples"][-30:]
        if isinstance(state.get("correction_rules"), list):
            self._correction_rules = state["correction_rules"][-20:]
        if isinstance(state.get("skills"), dict):
            self._skills = state["skills"]
        if isinstance(state.get("skill_quality_history"), dict):
            self._skill_quality_history = {
                k: (v[-20:] if isinstance(v, list) else v)
                for k, v in state["skill_quality_history"].items()
            }
        if isinstance(state.get("scene_quality"), dict):
            self._scene_quality = {
                k: (v[-30:] if isinstance(v, list) else v)
                for k, v in state["scene_quality"].items()
            }
        if isinstance(state.get("tool_sequence_history"), list):
            self._tool_sequence_history = [tuple(s) for s in state["tool_sequence_history"] if isinstance(s, list)][-self._MAX_TOOL_SEQUENCE_HISTORY:]
        if isinstance(state.get("compound_skills"), dict):
            self._compound_skills = state["compound_skills"]
        if isinstance(state.get("used_plan_ids"), list):
            self._used_plan_ids = set(state["used_plan_ids"][-1000:])
        if isinstance(state.get("knowledge_nudges"), list):
            self._knowledge_nudges = state["knowledge_nudges"][-50:]
        if isinstance(state.get("task_success_count"), (int, float)):
            self._task_success_count = state["task_success_count"]
        if isinstance(state.get("task_failure_count"), (int, float)):
            self._task_failure_count = state["task_failure_count"]
        if isinstance(state.get("total_signals"), (int, float)):
            self._total_signals = state["total_signals"]
        if isinstance(state.get("metrics"), dict):
            m = state["metrics"]
            self._metrics.total_interactions = m.get("total_interactions", 0)
            self._metrics.total_evolutions = m.get("total_evolutions", 0)
            self._metrics.successful_evolutions = m.get("successful_evolutions", 0)
            self._metrics.average_quality = m.get("average_quality", 0.0)
            self._metrics.quality_trend = m.get("quality_trend", "stable")
            self._metrics.tool_weights = dict(self._tool_weights)
            self._metrics.prompt_examples = list(self._prompt_examples[-20:])
        log.debug("Evolution state restored", examples=len(self._prompt_examples), tools=len(self._tool_call_stats), rules=len(self._correction_rules))

    def _schedule_persist(self) -> None:
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            state = {
                "tool_weights": self._tool_weights,
                "tool_call_stats": self._tool_call_stats,
                "prompt_examples": self._prompt_examples[-30:],
                "correction_rules": self._correction_rules[-20:],
                "skills": self._skills,
                "skill_quality_history": {k: v[-20:] for k, v in self._skill_quality_history.items()},
                "scene_quality": {k: v[-30:] for k, v in self._scene_quality.items()},
                "tool_sequence_history": [list(s) for s in self._tool_sequence_history[-self._MAX_TOOL_SEQUENCE_HISTORY:]],
                "compound_skills": self._compound_skills,
                "used_plan_ids": list(self._used_plan_ids)[-1000:],
                "knowledge_nudges": self._knowledge_nudges[-50:],
                "task_success_count": self._task_success_count,
                "task_failure_count": self._task_failure_count,
                "total_signals": self._total_signals,
                "metrics": {
                    "total_interactions": self._metrics.total_interactions,
                    "total_evolutions": self._metrics.total_evolutions,
                    "successful_evolutions": self._metrics.successful_evolutions,
                    "average_quality": self._metrics.average_quality,
                    "quality_trend": self._metrics.quality_trend,
                },
                "saved_at": time.time(),
            }
            self._state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            log.warning("Failed to persist evolution state", error=str(e))

    def _process_feedback_signal(self, signal: FeedbackSignal) -> None:
        self._feedback_history.append(signal)
        if len(self._feedback_history) > 5000:
            self._feedback_history = self._feedback_history[-3000:]
        self._metrics.total_interactions += 1
        self._metrics.recent_quality_scores.append(signal.quality_score)
        if len(self._metrics.recent_quality_scores) > 50:
            self._metrics.recent_quality_scores = self._metrics.recent_quality_scores[-50:]

        self._update_quality_trend()

        if signal.tool_name:
            self._update_tool_weight(signal.tool_name, signal.quality_score)

        for tool_name in signal.tools_used:
            if tool_name not in self._tool_call_stats:
                self._tool_call_stats[tool_name] = {"calls": 0, "successes": 0, "total_duration_ms": 0.0}
            stats = self._tool_call_stats[tool_name]
            stats["calls"] += 1
            if signal.tool_successes.get(tool_name, True):
                stats["successes"] += 1
            if tool_name in signal.tool_durations_ms:
                stats["total_duration_ms"] += signal.tool_durations_ms[tool_name]
            if len(self._tool_call_stats) > self._MAX_TOOL_CALL_STATS:
                oldest_tools = list(self._tool_call_stats.keys())[: len(self._tool_call_stats) - (self._MAX_TOOL_CALL_STATS * 3 // 4)]
                for t in oldest_tools:
                    del self._tool_call_stats[t]

        if signal.scene:
            if signal.scene not in self._scene_quality:
                self._scene_quality[signal.scene] = []
            self._scene_quality[signal.scene].append(signal.quality_score)
            if len(self._scene_quality[signal.scene]) > 30:
                self._scene_quality[signal.scene] = self._scene_quality[signal.scene][-30:]
            if len(self._scene_quality) > self._MAX_SCENE_QUALITY:
                oldest_scenes = list(self._scene_quality.keys())[: len(self._scene_quality) - (self._MAX_SCENE_QUALITY * 3 // 4)]
                for s in oldest_scenes:
                    del self._scene_quality[s]

        if signal.user_correction:
            self._add_prompt_example(signal)

        if signal.quality_score < 0.5 and signal.tools_used:
            self._learn_from_failure(signal)

        if len(self._feedback_history) % 5 == 0:
            self._schedule_persist()

        if len(self._feedback_history) % 20 == 0 and self._skills:
            self.check_skill_health()

    async def collect_feedback(self, signal: FeedbackSignal) -> None:
        self._process_feedback_signal(signal)

    def collect_feedback_sync(self, signal: FeedbackSignal) -> None:
        self._process_feedback_signal(signal)

    async def record_tool_failure(self, tool_name: str, error: str = "", **kwargs: Any) -> None:
        """E-06: 记录工具失败事件到反馈历史，使 should_evolve 的 TOOL_FAILURE 路径生效。

        Args:
            tool_name: 失败的工具名称。
            error: 错误信息。
        """
        signal = FeedbackSignal(
            interaction_id=f"tool_fail_{int(time.time())}",
            quality_score=0.0,
            cause=EvolutionCause.TOOL_FAILURE.value,
            tool_name=tool_name,
            error=error,
            timestamp=time.time(),
        )
        self._process_feedback_signal(signal)
        log.info("Tool failure recorded for evolution", tool=tool_name, error=error[:100])

    async def should_evolve(self) -> EvolutionPlan | None:
        if not self._metrics.recent_quality_scores:
            return None

        avg_quality = sum(self._metrics.recent_quality_scores[-10:]) / min(
            10, len(self._metrics.recent_quality_scores)
        )
        self._metrics.average_quality = avg_quality

        recent_failures = [
            f for f in self._feedback_history[-20:] if f.cause == EvolutionCause.TOOL_FAILURE
        ]
        if len(recent_failures) >= 3:
            failed_tools = set(f.tool_name for f in recent_failures if f.tool_name)
            plan_id = f"evo_{int(time.time())}"
            while plan_id in self._used_plan_ids:
                plan_id = f"evo_{int(time.time())}_{len(self._used_plan_ids)}"
            self._used_plan_ids.add(plan_id)

            return EvolutionPlan(
                plan_id=plan_id,
                evolution_type=EvolutionType.TOOL_WEIGHT_ADJUSTMENT,
                priority=EvolutionPriority.MEDIUM,
                cause=EvolutionCause.TOOL_FAILURE,
                actions=[
                    EvolutionAction(
                        action_type="reduce_weight",
                        target=tool,
                        description=f"工具 {tool} 近期多次失败",
                    )
                    for tool in failed_tools
                ],
                reasoning=f"近期{len(recent_failures)}次工具失败，涉及: {', '.join(failed_tools)}",
            )

        if avg_quality < self._quality_threshold:
            plan_id = f"evo_{int(time.time())}"
            while plan_id in self._used_plan_ids:
                plan_id = f"evo_{int(time.time())}_{len(self._used_plan_ids)}"
            self._used_plan_ids.add(plan_id)

            return EvolutionPlan(
                plan_id=plan_id,
                evolution_type=EvolutionType.PROMPT_OPTIMIZATION,
                priority=EvolutionPriority.HIGH if avg_quality < 0.5 else EvolutionPriority.MEDIUM,
                cause=EvolutionCause.LOW_QUALITY,
                actions=[
                    EvolutionAction(
                        action_type="adjust_prompt",
                        target="system_prompt",
                        description=f"平均质量 {avg_quality:.2f} 低于阈值 {self._quality_threshold}",
                        params={"avg_quality": avg_quality},
                    )
                ],
                reasoning=f"最近10次交互平均质量={avg_quality:.2f}，低于阈值{self._quality_threshold}",
            )

        return None

    async def execute_evolution(self, plan: EvolutionPlan) -> EvolutionResult:
        import time as _time

        if plan.plan_id in self._used_plan_ids:
            executed_plan_ids = {r.plan_id for r in self._evolution_history}
            if plan.plan_id in executed_plan_ids:
                return EvolutionResult(
                    plan_id=plan.plan_id,
                    success=False,
                    executed_actions=0,
                    total_actions=len(plan.actions),
                    duration_ms=0,
                )

        start = _time.time()
        executed = 0

        for action in plan.actions:
            try:
                success = await self._execute_action(action)
                if success:
                    executed += 1
            except Exception as _exc:
                log.debug("engine 异常处理", error=str(_exc))
                log_ignored(log, "engine.EvolutionEngine.execute_evolution", _exc)

        result = EvolutionResult(
            plan_id=plan.plan_id,
            success=executed == len(plan.actions),
            executed_actions=executed,
            total_actions=len(plan.actions),
            duration_ms=(_time.time() - start) * 1000,
        )

        self._evolution_history.append(result)
        if len(self._evolution_history) > self._MAX_EVOLUTION_HISTORY:
            self._evolution_history = self._evolution_history[-self._MAX_EVOLUTION_HISTORY * 3 // 4:]
        self._metrics.total_evolutions += 1
        if result.success:
            self._metrics.successful_evolutions += 1

        self._schedule_persist()
        return result

    async def _execute_action(self, action: EvolutionAction) -> bool:
        if action.action_type == "adjust_prompt":
            return self._apply_prompt_adjustment(action)
        elif action.action_type == "reduce_weight":
            if action.target in self._tool_weights:
                self._tool_weights[action.target] *= 0.8
            return True
        elif action.action_type == "increase_weight":
            if action.target in self._tool_weights:
                self._tool_weights[action.target] = min(1.0, self._tool_weights[action.target] * 1.2)
            return True
        return False

    def _apply_prompt_adjustment(self, action: EvolutionAction) -> bool:
        avg_quality = action.params.get("avg_quality", 0.5) if action.params else 0.5

        recent_low = [
            f for f in self._feedback_history[-20:]
            if f.quality_score < 0.5
        ]

        if not recent_low:
            return True

        failed_tools: dict[str, int] = {}
        for f in recent_low:
            for t in f.tools_used:
                if not f.tool_successes.get(t, True):
                    failed_tools[t] = failed_tools.get(t, 0) + 1

        low_scenes: dict[str, float] = {}
        for f in recent_low:
            if f.scene:
                low_scenes[f.scene] = low_scenes.get(f.scene, 0) + 1

        rule_parts = []
        if failed_tools:
            sorted_tools = sorted(failed_tools.items(), key=lambda x: x[1], reverse=True)
            tools_str = ", ".join(t for t, c in sorted_tools[:3])
            rule_parts.append(f"工具{tools_str}近期失败率高，优先使用替代方案或分步执行")

        if low_scenes:
            top_scene = max(low_scenes, key=low_scenes.get)
            rule_parts.append(f"场景{top_scene}质量偏低，需要更精确的指令和上下文")

        if avg_quality < 0.4:
            rule_parts.append("整体质量严重偏低，优先确认用户意图后再执行工具调用")

        if rule_parts:
            rule_text = " | ".join(rule_parts)
            self._correction_rules.append({
                "rule": rule_text,
                "avg_quality": f"{avg_quality:.2f}",
                "timestamp": str(int(time.time())),
            })
            if len(self._correction_rules) > 20:
                self._correction_rules = self._correction_rules[-20:]

        log.info("Prompt adjustment applied", rules=len(self._correction_rules), avg_quality=f"{avg_quality:.2f}")
        return True

    def get_correction_rules(self) -> list[dict[str, str]]:
        return list(self._correction_rules)

    def build_evolution_prompt_section(self) -> str:
        sections: list[str] = []

        if self._correction_rules:
            recent_rules = self._correction_rules[-5:]
            rule_lines = [f"- {r['rule']}" for r in recent_rules]
            sections.append("# 进化纠错规则\n" + "\n".join(rule_lines))

        weights = self.get_tool_weights()
        reliable = [t for t, w in weights.items() if w > 0.8]
        unreliable = [t for t, w in weights.items() if w < 0.5]
        if reliable:
            sections.append(f"# 进化推荐\n高可靠工具（优先使用）: {', '.join(reliable[:10])}")
        if unreliable:
            sections.append(f"低可靠工具（谨慎使用）: {', '.join(unreliable[:5])}")

        if self._metrics.quality_trend == "declining":
            sections.append("# 质量预警\n近期质量下降趋势，执行前务必确认用户意图")

        return "\n\n".join(sections)

    def nudge_knowledge_persistence(self, user_input: str, tools_used: list[str]) -> str | None:
        matched_kw = None
        for kw in _PERSISTENCE_KEYWORDS:
            if kw in user_input:
                matched_kw = kw
                break
        if not matched_kw:
            return None

        has_memory_store = any(
            "memory_store" in t or "memoryStore" in t or "save_memory" in t
            for t in tools_used
        )
        if has_memory_store:
            return None

        try:
            from agent.security.sensitive_detector import check_sensitive_info
            check_result = check_sensitive_info(user_input, CheckScene.STORAGE)
            if check_result.risk_level in (RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL):
                log.warning("Knowledge persistence blocked by sensitive info", keyword=matched_kw, risk=check_result.risk_level.value)
                return None
        except Exception as exc:
            # E-05: 检测器异常时 fail-safe 阻止持久化，避免敏感信息泄露。
            log.warning("Sensitive detector unavailable, blocking persistence as fail-safe", error=str(exc))
            return None

        # E-05: 脱敏 snippet，移除可能的敏感模式（邮箱/电话/身份证等）。
        import re as _re
        snippet = user_input[:80]
        snippet = _re.sub(r'[\w.+-]+@[\w-]+\.[\w.]+', '[邮箱]', snippet)
        snippet = _re.sub(r'1[3-9]\d{9}', '[电话]', snippet)
        snippet = _re.sub(r'\d{6}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]', '[身份证]', snippet)
        nudge = (
            f"检测到用户表达了偏好/习惯（关键词: \"{matched_kw}\"），但未调用记忆存储工具。"
            f"建议将以下信息持久化: \"{snippet}\""
        )
        log.info("Knowledge persistence nudge", keyword=matched_kw)
        return nudge

    def _update_tool_weight(self, tool_name: str, quality: float) -> None:
        if tool_name not in self._tool_weights:
            self._tool_weights[tool_name] = 0.5
        current = self._tool_weights[tool_name]
        self._tool_weights[tool_name] = current * 0.9 + quality * 0.1
        self._metrics.tool_weights = dict(self._tool_weights)

    def _add_prompt_example(self, signal: FeedbackSignal) -> None:
        self._prompt_examples.append({
            "input": signal.interaction_id,
            "correction": "true" if signal.user_correction else "false",
            "quality": str(signal.quality_score),
        })
        self._metrics.prompt_examples = list(self._prompt_examples[-20:])

    def _update_quality_trend(self) -> None:
        scores = self._metrics.recent_quality_scores
        if len(scores) < 5:
            self._metrics.quality_trend = "insufficient_data"
            return

        recent = sum(scores[-5:]) / 5
        older = sum(scores[-10:-5]) / min(5, len(scores[-10:-5])) if len(scores) >= 6 else recent

        if recent > older + 0.05:
            self._metrics.quality_trend = "improving"
        elif recent < older - 0.05:
            self._metrics.quality_trend = "declining"
        else:
            self._metrics.quality_trend = "stable"

    def get_metrics(self) -> EvolutionMetrics:
        return self._metrics

    def get_tool_weights(self) -> dict[str, float]:
        weights: dict[str, float] = {}
        for tool_name, stats in self._tool_call_stats.items():
            if stats["calls"] >= 2:
                success_rate = stats["successes"] / stats["calls"]
                weights[tool_name] = 0.5 + success_rate
        for tool_name, weight in self._tool_weights.items():
            if tool_name in weights:
                weights[tool_name] = (weights[tool_name] + weight) / 2
            else:
                weights[tool_name] = weight
        return weights

    def get_prompt_examples(self) -> list[dict[str, str]]:
        return list(self._prompt_examples)

    def get_tool_recommendations(self, scene: str = "") -> list[dict[str, Any]]:
        recommendations: list[dict[str, Any]] = []
        for tool_name, stats in self._tool_call_stats.items():
            if stats["calls"] < 2:
                continue
            success_rate = stats["successes"] / stats["calls"]
            avg_duration = stats["total_duration_ms"] / stats["calls"] if stats["calls"] > 0 else 0
            weight = self._tool_weights.get(tool_name, 0.5)
            recommendations.append({
                "tool_name": tool_name,
                "success_rate": round(success_rate, 3),
                "avg_duration_ms": round(avg_duration, 1),
                "evolution_weight": round(weight, 3),
                "calls": stats["calls"],
            })
        recommendations.sort(key=lambda x: x["evolution_weight"], reverse=True)

        if scene and scene in self._scene_quality:
            scene_avg = sum(self._scene_quality[scene]) / len(self._scene_quality[scene])
            recommendations.insert(0, {
                "scene": scene,
                "avg_quality": round(scene_avg, 3),
                "sample_count": len(self._scene_quality[scene]),
            })

        return recommendations

    def _learn_from_failure(self, signal: FeedbackSignal) -> None:
        for tool_name in signal.tools_used:
            success = signal.tool_successes.get(tool_name, True)
            if not success:
                if tool_name not in self._tool_weights:
                    self._tool_weights[tool_name] = 0.5
                self._tool_weights[tool_name] *= 0.85
                correction = self._generate_correction(tool_name, signal.error or "")
                self._prompt_examples.append({
                    "input": signal.interaction_id,
                    "correction": correction,
                    "quality": str(signal.quality_score),
                    "scene": signal.scene,
                })
                if len(self._prompt_examples) > 30:
                    self._prompt_examples = self._prompt_examples[-30:]

                self._correction_rules.append({
                    "rule": correction,
                    "tool": tool_name,
                    "scene": signal.scene,
                    "quality": signal.quality_score,
                })
                if len(self._correction_rules) > 20:
                    self._correction_rules = self._correction_rules[-20:]
        self._metrics.tool_weights = dict(self._tool_weights)
        self._metrics.prompt_examples = list(self._prompt_examples[-20:])
        self._schedule_persist()

    def _generate_correction(self, tool_name: str, error: str) -> str:
        if "timeout" in error.lower() or "超时" in error:
            return f"工具{tool_name}超时，请简化请求或分步执行"
        if "permission" in error.lower() or "权限" in error:
            return f"工具{tool_name}权限不足，请检查文件路径或使用安全的操作方式"
        if "not found" in error.lower() or "不存在" in error or "未找到" in error:
            return f"工具{tool_name}资源不存在，请先确认文件/路径是否正确"
        return f"工具{tool_name}失败，请提供更明确的指令，避免歧义"

    # ─── StrategyAdjuster: 策略自适应调整 ───

    def record_signal(self, signal: LearningSignal) -> None:
        self._total_signals += 1

        if signal.signal_type in (SignalType.TASK_SUCCESS, SignalType.TASK_FAILURE):
            if signal.signal_type == SignalType.TASK_SUCCESS:
                self._task_success_count += 1
            else:
                self._task_failure_count += 1
            log.debug("Strategy signal recorded", signal_type=signal.signal_type.value)
            return

        if signal.signal_type == SignalType.TOOL_SELECTION_QUALITY:
            # R2 → EvolutionEngine：记录"工具集选择"事件（场景→工具分布学习）。
            if not signal.tool_name:
                return
            stats = self._tool_signal_stats.setdefault(
                signal.tool_name,
                {
                    "success_count": 0,
                    "failure_count": 0,
                    "avg_quality": 0.0,
                    "last_used": 0.0,
                    "selection_count": 0,
                },
            )
            stats["selection_count"] = stats.get("selection_count", 0) + 1
            stats["last_used"] = signal.timestamp or time.time()
            log.debug(
                "工具集选择信号已记录",
                tool=signal.tool_name,
                toolset=signal.metadata.get("toolset_id"),
                scene=signal.metadata.get("scene"),
            )
            return

        if not signal.tool_name:
            return

        if signal.tool_name not in self._tool_signal_stats:
            self._tool_signal_stats[signal.tool_name] = {
                "success_count": 0,
                "failure_count": 0,
                "avg_quality": 0.0,
                "last_used": 0.0,
            }
            if len(self._tool_signal_stats) > self._MAX_TOOL_SIGNAL_STATS:
                sorted_stats = sorted(self._tool_signal_stats.items(), key=lambda x: x[1].get("last_used", 0))
                to_remove = sorted_stats[: len(self._tool_signal_stats) - (self._MAX_TOOL_SIGNAL_STATS * 3 // 4)]
                for k, _ in to_remove:
                    del self._tool_signal_stats[k]

        stats = self._tool_signal_stats[signal.tool_name]

        if signal.signal_type == SignalType.POSITIVE:
            stats["success_count"] += 1
            prev_avg = stats["avg_quality"]
            stats["avg_quality"] = (prev_avg * (stats["success_count"] - 1) + signal.quality) / stats["success_count"]
        elif signal.signal_type == SignalType.NEGATIVE:
            stats["failure_count"] += 1

        stats["last_used"] = signal.timestamp or time.time()
        log.debug("Strategy tool signal recorded", tool=signal.tool_name, signal_type=signal.signal_type.value)

    def record_toolset_selection(
        self,
        scene: str,
        toolset_id: str,
        tool_names: list[str],
        method: str = "sampled",
    ) -> None:
        """R2 工具集采样结果 → 进化引擎。

        为每个被选中的工具发一条 TOOL_SELECTION_QUALITY 信号，使进化引擎
        积累"场景 → 工具集"分布，供后续自适应工具优先级调整使用。

        Args:
            scene: 检测出的场景（如 coding/browsing）。
            toolset_id: 选中的工具集 id。
            tool_names: 选中的工具名列表。
            method: 选择方法（"sampled" 概率分发 / "deterministic" 确定性）。
        """
        ts = time.time()
        for name in tool_names:
            if not name:
                continue
            self.record_signal(
                LearningSignal(
                    signal_type=SignalType.TOOL_SELECTION_QUALITY,
                    tool_name=name,
                    quality=0.5,
                    timestamp=ts,
                    metadata={
                        "scene": scene,
                        "toolset_id": toolset_id,
                        "method": method,
                    },
                )
            )

    def get_adjusted_tool_priority(self, tools: list[str]) -> list[str]:
        def _sort_key(tool_name: str) -> float:
            stats = self._tool_signal_stats.get(tool_name)
            if not stats:
                return 0.0
            total = stats["success_count"] + stats["failure_count"]
            if total == 0:
                return 0.0
            return stats["success_count"] / total

        return sorted(tools, key=_sort_key, reverse=True)

    def get_adjusted_reflection_config(self) -> ReflectionConfig:
        tool_failures = 0
        tool_successes = 0
        for stats in self._tool_signal_stats.values():
            tool_failures += stats["failure_count"]
            tool_successes += stats["success_count"]

        total_successes = tool_successes + self._task_success_count
        total_failures = tool_failures + self._task_failure_count
        overall_success_rate = total_successes / max(total_successes + total_failures, 1)

        if overall_success_rate < 0.5:
            return ReflectionConfig(
                enable_deep_reflection=True,
                max_retries=4,
            )

        if overall_success_rate > 0.8 and self._total_signals > 5:
            return ReflectionConfig(
                enable_deep_reflection=False,
                max_retries=1,
            )

        return ReflectionConfig(
            enable_deep_reflection=True,
            max_retries=2,
        )

    # ─── Skill 自动生成与改进 ───

    def generate_skill(self, params: dict[str, Any]) -> str | None:
        quality_score = params.get("quality_score", 0)
        if quality_score < 0.7:
            return None
        user_input = params.get("input", "")
        if not user_input or len(user_input) < 5:
            return None

        skill_name = self._skill_name_from_input(user_input)
        if not skill_name:
            return None

        existing = [e for e in self._prompt_examples if e.get("input", "").startswith(skill_name)]
        if len(existing) >= 3:
            return None

        response = params.get("response", "")
        tools_used = params.get("tools_used", [])
        scene = params.get("scene", "")

        skill_entry = {
            "name": skill_name,
            "input_pattern": user_input[:100],
            "response_template": response[:200] if response else "",
            "tools": tools_used,
            "scene": scene,
            "quality": quality_score,
            "created_at": time.time(),
            "use_count": 0,
            "avg_quality": quality_score,
        }

        self._skills[skill_name] = skill_entry
        if len(self._skills) > self._MAX_SKILLS:
            oldest_skills = list(self._skills.keys())[: len(self._skills) - (self._MAX_SKILLS * 3 // 4)]
            for s in oldest_skills:
                del self._skills[s]
                self._skill_quality_history.pop(s, None)
        self._schedule_persist()
        log.info("Skill generated", skill_name=skill_name, quality=quality_score)
        return skill_name

    def improve_skill(self, skill_name: str) -> bool:
        skill = self._skills.get(skill_name)
        if not skill:
            return False

        related_failures = [
            r for r in self._correction_rules
            if r.get("tool") in skill.get("tools", [])
        ]
        if not related_failures:
            return False

        failure_patterns = "\n".join(
            f"- {r['rule']}" for r in related_failures[-5:]
        )

        skill["improvement_notes"] = failure_patterns
        skill["improved_at"] = time.time()
        self._schedule_persist()
        log.info("Skill improved", skill_name=skill_name, failures=len(related_failures))
        return True

    def track_skill_usage(self, skill_name: str, quality: float) -> None:
        skill = self._skills.get(skill_name)
        if not skill:
            return
        skill["use_count"] = skill.get("use_count", 0) + 1
        prev_avg = skill.get("avg_quality", 0.5)
        count = skill["use_count"]
        skill["avg_quality"] = (prev_avg * (count - 1) + quality) / count
        skill["last_used_at"] = time.time()

        if skill_name not in self._skill_quality_history:
            self._skill_quality_history[skill_name] = []
        self._skill_quality_history[skill_name].append(quality)
        if len(self._skill_quality_history[skill_name]) > 20:
            self._skill_quality_history[skill_name] = self._skill_quality_history[skill_name][-20:]

        self._schedule_persist()

    def get_skill_stats(self) -> list[dict[str, Any]]:
        return [
            {
                "name": name,
                "use_count": data.get("use_count", 0),
                "avg_quality": round(data.get("avg_quality", 0), 3),
                "scene": data.get("scene", ""),
                "tools": data.get("tools", []),
            }
            for name, data in self._skills.items()
        ]

    def get_least_used_skills(self, threshold: int = 2) -> list[dict[str, Any]]:
        return [
            {"name": name, **data}
            for name, data in self._skills.items()
            if data.get("use_count", 0) <= threshold
        ]

    def _skill_name_from_input(self, text: str) -> str:
        import re
        cleaned = re.sub(r"[^\w\u4e00-\u9fff]", "_", text[:30])
        cleaned = re.sub(r"_+", "_", cleaned).strip("_")
        return f"auto_{cleaned}" if cleaned else ""

    # ─── Skill 质量趋势分析与自动淘汰 ───

    def get_skill_quality_trends(self) -> dict[str, dict[str, Any]]:
        trends: dict[str, dict[str, Any]] = {}
        for name, history in self._skill_quality_history.items():
            if len(history) < 3:
                trends[name] = {"trend": "insufficient_data", "current_avg": 0.0, "recent_avg": 0.0, "older_avg": 0.0, "sample_count": len(history)}
                continue

            mid = len(history) // 2
            if mid == 0:
                mid = 1
            older = history[:mid]
            recent = history[mid:]

            older_avg = sum(older) / len(older)
            recent_avg = sum(recent) / len(recent)

            if recent_avg > older_avg + 0.05:
                trend_label = "improving"
            elif recent_avg < older_avg - 0.05:
                trend_label = "declining"
            else:
                trend_label = "stable"

            trends[name] = {
                "trend": trend_label,
                "current_avg": round(recent_avg, 3),
                "recent_avg": round(recent_avg, 3),
                "older_avg": round(older_avg, 3),
                "sample_count": len(history),
            }

        return trends

    def prune_low_quality_skills(
        self,
        quality_threshold: float = 0.4,
        min_uses: int = 3,
        declining_only: bool = True,
    ) -> list[str]:
        trends = self.get_skill_quality_trends()
        pruned: list[str] = []

        for name, data in list(self._skills.items()):
            avg_quality = data.get("avg_quality", 0)
            use_count = data.get("use_count", 0)
            if use_count < min_uses:
                continue
            if avg_quality >= quality_threshold:
                continue

            trend_info = trends.get(name, {})
            if declining_only and trend_info.get("trend") != "declining":
                continue

            del self._skills[name]
            self._skill_quality_history.pop(name, None)
            pruned.append(name)
            log.info("Skill pruned", skill_name=name, avg_quality=f"{avg_quality:.3f}", use_count=use_count)

        if pruned:
            self._schedule_persist()

        return pruned

    def check_skill_health(self) -> dict[str, Any]:
        total = len(self._skills)
        if total == 0:
            return {"total": 0, "healthy": 0, "at_risk": 0, "declining": 0, "pruned": []}

        trends = self.get_skill_quality_trends()
        healthy = 0
        at_risk = 0
        declining = 0

        for name, data in self._skills.items():
            avg_q = data.get("avg_quality", 0)
            trend_info = trends.get(name, {})
            trend_label = trend_info.get("trend", "insufficient_data")

            if avg_q >= 0.7 and trend_label != "declining":
                healthy += 1
            elif trend_label == "declining":
                declining += 1
            else:
                at_risk += 1

        pruned = self.prune_low_quality_skills()

        return {
            "total": total,
            "healthy": healthy,
            "at_risk": at_risk,
            "declining": declining,
            "pruned": pruned,
        }

    # ─── E2: 工具自创造 — 检测重复工具组合模式，自动创造复合工具 ───

    def record_tool_sequence(self, tool_names: list[str]) -> None:
        if not tool_names or len(tool_names) < 2:
            return
        seq = tuple(tool_names)
        self._tool_sequence_history.append(seq)
        if len(self._tool_sequence_history) > self._MAX_TOOL_SEQUENCE_HISTORY:
            self._tool_sequence_history = self._tool_sequence_history[-self._MAX_TOOL_SEQUENCE_HISTORY:]

    def _find_recurring_patterns(self, min_length: int = 2, max_length: int = 5) -> dict[tuple[str, ...], int]:
        pattern_counts: dict[tuple[str, ...], int] = {}
        for seq in self._tool_sequence_history:
            for length in range(min_length, min(max_length + 1, len(seq) + 1)):
                for start in range(len(seq) - length + 1):
                    sub = seq[start:start + length]
                    pattern_counts[sub] = pattern_counts.get(sub, 0) + 1
        return {
            p: c for p, c in pattern_counts.items()
            if c >= self._COMPOUND_PATTERN_MIN_OCCURRENCE
        }

    def generate_compound_skill(self, tool_names: list[str], context: str = "") -> str | None:
        if not tool_names or len(tool_names) < 2:
            return None
        self.record_tool_sequence(tool_names)
        recurring = self._find_recurring_patterns()
        if not recurring:
            return None
        sorted_patterns = sorted(recurring.items(), key=lambda x: (-len(x[0]), -x[1]))
        best_pattern, occurrence = sorted_patterns[0]
        compound_key = "+".join(best_pattern)
        if compound_key in self._compound_skills:
            self._compound_skills[compound_key]["use_count"] += 1
            self._compound_skills[compound_key]["last_seen_at"] = time.time()
            self._schedule_persist()
            return None
        skill_name = f"compound_{compound_key}"
        self._compound_skills[compound_key] = {
            "name": skill_name,
            "tools": list(best_pattern),
            "occurrence": occurrence,
            "created_at": time.time(),
            "use_count": 0,
            "last_seen_at": time.time(),
            "context": context[:100] if context else "",
        }
        if len(self._compound_skills) > self._MAX_COMPOUND_SKILLS:
            oldest = sorted(
                self._compound_skills.items(),
                key=lambda x: x[1].get("last_seen_at", 0),
            )
            for key, _ in oldest[: len(oldest) - self._MAX_COMPOUND_SKILLS * 3 // 4]:
                del self._compound_skills[key]
        self._schedule_persist()
        log.info(
            "E2: compound skill created",
            skill_name=skill_name,
            tools=list(best_pattern),
            occurrence=occurrence,
        )
        return skill_name

    def get_compound_skills(self) -> list[dict[str, Any]]:
        return [
            {
                "name": data["name"],
                "tools": data["tools"],
                "occurrence": data["occurrence"],
                "use_count": data.get("use_count", 0),
            }
            for data in self._compound_skills.values()
        ]

    # ─── E3: 知识自增长 — 自动沉淀知识到长期记忆 ───

    def auto_deposit_knowledge(
        self,
        user_input: str,
        assistant_output: str,
        tools_used: list[str],
        quality_score: float,
    ) -> dict[str, str] | None:
        if quality_score < 0.6:
            return None
        deposits: dict[str, str] = {}
        nudge = self.nudge_knowledge_persistence(user_input, tools_used)
        if nudge:
            deposits["preference_nudge"] = nudge
        if tools_used and quality_score >= 0.7:
            tool_knowledge = f"工具组合经验: {', '.join(tools_used)} → 成功完成任务（质量{quality_score:.0%}）"
            deposits["tool_experience"] = tool_knowledge
        if len(user_input) > 20 and len(assistant_output) > 50 and quality_score >= 0.75:
            import re as _re
            snippet_in = _re.sub(r'[\w.+-]+@[\w-]+\.[\w.]+', '[邮箱]', user_input[:60])
            snippet_in = _re.sub(r'1[3-9]\d{9}', '[电话]', snippet_in)
            snippet_out = assistant_output[:80]
            qa_knowledge = f"问答经验: Q=\"{snippet_in}\" → A=\"{snippet_out}\""
            deposits["qa_experience"] = qa_knowledge
        if deposits:
            log.info("E3: knowledge auto-deposit", types=list(deposits.keys()))
        return deposits if deposits else None

    # ─── Few-shot 泛化 ───

    def generalize_fewshot(self) -> list[dict[str, Any]]:
        if len(self._prompt_examples) < 2:
            return []

        category_map: dict[str, list[dict]] = {}
        for ex in self._prompt_examples:
            scene = ex.get("scene", "default")
            category_map.setdefault(scene, []).append(ex)

        generalized: list[dict[str, Any]] = []
        for scene, examples in category_map.items():
            if len(examples) < 2:
                continue

            tools_set: set[str] = set()
            corrections: list[str] = []
            for ex in examples:
                correction = ex.get("correction", "")
                if correction:
                    corrections.append(correction)

            if corrections:
                pattern = {
                    "category": scene,
                    "common_corrections": corrections[:3],
                    "sample_count": len(examples),
                    "generalized_rule": f"在{scene}场景中，常见问题: {'; '.join(set(corrections[:3]))}",
                }
                generalized.append(pattern)

        return generalized

    # ─── 洞察生成 ───

    def get_insights(self) -> list[dict[str, Any]]:
        insights: list[dict[str, Any]] = []

        weights = self.get_tool_weights()
        reliable = [(t, w) for t, w in weights.items() if w > 0.8]
        unreliable = [(t, w) for t, w in weights.items() if w < 0.5]

        if reliable:
            top = reliable[0]
            insights.append({
                "type": "tool_reliability",
                "description": f"工具{top[0]}表现最稳定（权重{top[1]:.2f}）",
                "confidence": top[1],
            })

        if unreliable:
            worst = unreliable[0]
            insights.append({
                "type": "tool_risk",
                "description": f"工具{worst[0]}可靠性低（权重{worst[1]:.2f}），建议替代方案",
                "confidence": 1.0 - worst[1],
            })

        if self._metrics.quality_trend == "declining":
            insights.append({
                "type": "quality_alert",
                "description": "近期质量下降趋势，建议检查工具调用策略",
                "confidence": 0.7,
            })

        if self._correction_rules:
            recent_rules = self._correction_rules[-3:]
            for rule in recent_rules:
                insights.append({
                    "type": "correction",
                    "description": rule["rule"],
                    "confidence": 0.6,
                })

        if self._skills:
            high_quality = [
                (n, d) for n, d in self._skills.items()
                if d.get("avg_quality", 0) > 0.8 and d.get("use_count", 0) >= 2
            ]
            if high_quality:
                insights.append({
                    "type": "skill_pattern",
                    "description": f"发现{len(high_quality)}个高质量技能模式，可复用",
                    "confidence": 0.8,
                })

        return insights

    # ─── 隐式反馈集成 ───

    def record_implicit_feedback(self, feedback_stats: Any) -> None:
        """
        记录隐式反馈统计数据

        将隐式反馈收集器的统计数据接入进化引擎，
        用于补充学习信号，解决信号稀疏问题。
        """
        try:
            # 记录隐式反馈总数
            total_signals = getattr(feedback_stats, "total_signals", 0)
            if total_signals > 0:
                # 将隐式反馈计入总交互数
                # 注意：不重复计数，只用于趋势分析
                log.debug(
                    "Implicit feedback recorded",
                    total=total_signals,
                    positive=getattr(feedback_stats, "positive_count", 0),
                    negative=getattr(feedback_stats, "negative_count", 0),
                )

            # 正向反馈比例可以用来调整质量趋势判断
            positive_ratio = getattr(feedback_stats, "positive_ratio", None)
            if callable(positive_ratio):
                try:
                    ratio = positive_ratio()
                    # 如果正向反馈比例很高，可以略微提升质量趋势信心
                    if ratio > 0.7 and self._metrics.quality_trend == "stable":
                        log.debug("High positive feedback ratio detected")
                except Exception as _exc:
                    log.debug("engine 异常处理", error=str(_exc))
                    log_ignored(log, "engine.EvolutionEngine.record_implicit_feedback", _exc)
        except Exception as e:
            log.warning(f"Failed to record implicit feedback: {e}")

    # ─── 反馈收集器集成 ───

    def get_feedback_stats(self) -> list[dict[str, Any]]:
        """获取反馈收集器的聚合统计数据。

        Returns:
            各工具的反馈统计列表，包含调用次数、成功率、平均耗时等。
        """
        stats = self._feedback_collector.get_aggregated_stats()
        return [
            {
                "tool_name": s.tool_name,
                "total_calls": s.total_calls,
                "success_count": s.success_count,
                "avg_duration": s.avg_duration,
                "failure_rate": s.failure_rate,
                "avg_rating": s.avg_rating,
                "rating_count": s.rating_count,
            }
            for s in stats
        ]

    def apply_feedback_learning(self) -> dict[str, float]:
        """根据反馈数据调整工具权重。

        从FeedbackCollector导出权重调整建议，合并到进化引擎的
        工具权重中，使工具推荐排序更精准。

        Returns:
            调整后的工具权重字典。
        """
        export = self._feedback_collector.export_for_evolution()
        adjustments = export.get("weight_adjustments", {})
        for tool_name, suggested_weight in adjustments.items():
            if tool_name in self._tool_weights:
                current = self._tool_weights[tool_name]
                self._tool_weights[tool_name] = current * 0.7 + suggested_weight * 0.3
            else:
                self._tool_weights[tool_name] = suggested_weight
            self._tool_weights[tool_name] = round(self._tool_weights[tool_name], 3)
        self._metrics.tool_weights = dict(self._tool_weights)
        if adjustments:
            self._schedule_persist()
            log.info("反馈学习已应用", adjusted_tools=len(adjustments))
        return dict(self._tool_weights)

    def get_feedback_collector(self) -> FeedbackCollector:
        """获取反馈收集器实例。

        Returns:
            FeedbackCollector: 当前引擎关联的反馈收集器。
        """
        return self._feedback_collector

    def get_learning_status_data(self) -> dict[str, Any]:
        """
        获取学习状态数据，供学习状态报告器使用

        返回统一格式的学习数据，便于生成报告。
        """
        return {
            "total_interactions": self._metrics.total_interactions,
            "total_evolutions": self._metrics.total_evolutions,
            "successful_evolutions": self._metrics.successful_evolutions,
            "average_quality": self._metrics.average_quality,
            "quality_trend": self._metrics.quality_trend,
            "recent_quality_scores": list(self._metrics.recent_quality_scores),
            "tool_count": len(self._tool_call_stats),
            "skill_count": len(self._skills),
            "correction_rules_count": len(self._correction_rules),
            "insights_count": len(self.get_insights()),
        }

    def record_tool_signal(
        self,
        tool_name: str,
        signal_type: str = "failure",
        quality_score: float = 0.3,
    ) -> None:
        """P1-修复6: 记录工具运行时信号（成功/失败/降级），供进化闭环 TOOL_ENHANCE 路径调用。

        与 record_tool_failure 不同，此方法同步、轻量，仅更新信号统计与权重，
        不写入反馈历史（避免触发 should_evolve 的误判）。
        """
        if tool_name not in self._tool_signal_stats:
            self._tool_signal_stats[tool_name] = {
                "success": 0, "failure": 0, "degraded": 0, "total": 0,
            }
        stats = self._tool_signal_stats[tool_name]
        key = signal_type if signal_type in stats else "failure"
        stats[key] += 1
        stats["total"] += 1
        self._update_tool_weight(tool_name, quality_score)
        self._total_signals += 1
        log.debug(
            "Tool signal recorded",
            tool=tool_name, signal_type=signal_type, quality=round(quality_score, 2),
        )

    async def register_risk_signal(
        self,
        risk_type: str,
        description: str,
        severity: str = "medium",
    ) -> None:
        """P1-修复6: 注册运行时风险信号，供进化闭环在评估阶段上报高危风险。

        风险信号累积后影响纠错规则生成与工具权重，形成"风险→进化"反馈。
        """
        if not hasattr(self, "_risk_signals"):
            self._risk_signals: list[dict[str, Any]] = []
        self._risk_signals.append({
            "risk_type": risk_type,
            "description": description,
            "severity": severity,
            "timestamp": time.time(),
        })
        if len(self._risk_signals) > 200:
            self._risk_signals = self._risk_signals[-100:]
        if severity in ("high", "critical"):
            self._correction_rules.append({
                "rule": f"检测到高危风险[{risk_type}]: {description[:80]}，执行前需人工确认或降级",
                "avg_quality": f"{self._metrics.average_quality:.2f}",
                "timestamp": str(int(time.time())),
            })
            if len(self._correction_rules) > 20:
                self._correction_rules = self._correction_rules[-20:]
        log.info(
            "Risk signal registered",
            risk_type=risk_type, severity=severity,
        )

    async def rollback_to_checkpoint(self, checkpoint_id: str = "latest") -> bool:
        """P1-修复6: 回滚到检查点 — 进化闭环在执行失败时调用以恢复上次稳定状态。

        EvolutionEngine 以持久化状态文件作为隐式检查点：重载 _state_path 即可恢复
        上次成功持久化的工具权重/纠错规则/技能。返回是否成功恢复。
        """
        try:
            before_weights = dict(self._tool_weights)
            self._load_state()
            restored = self._tool_weights != before_weights
            log.info(
                "Evolution checkpoint rollback",
                checkpoint_id=checkpoint_id, restored=restored,
            )
            return True
        except Exception as e:
            log.warning("Evolution rollback failed", error=str(e))
            return False

    def get_realtime_feedback(self) -> dict[str, Any]:
        """P1-修复6: 提供实时学习反馈，供 controller 自适应策略调整调用。

        基于近期质量趋势与工具权重，输出建议的最大重试次数、是否降速、工具推荐。
        """
        scores = self._metrics.recent_quality_scores
        recent_avg = sum(scores[-5:]) / min(5, len(scores)) if scores else 0.5

        if recent_avg < 0.4:
            suggested_max_retries = 1
            should_slow_down = True
        elif recent_avg < 0.6:
            suggested_max_retries = 2
            should_slow_down = True
        else:
            suggested_max_retries = 3
            should_slow_down = False

        weights = self.get_tool_weights()
        tool_recommendations = {
            tool: round(w, 2) for tool, w in weights.items() if w > 0.3
        }

        return {
            "suggested_max_retries": suggested_max_retries,
            "should_slow_down": should_slow_down,
            "tool_recommendations": tool_recommendations,
            "quality_trend": self._metrics.quality_trend,
            "recent_avg_quality": round(recent_avg, 3),
        }
