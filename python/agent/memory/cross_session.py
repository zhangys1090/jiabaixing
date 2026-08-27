"""跨会话记忆 + 主动行为引擎。

设计目标：
1. 跨会话记忆：将短期记忆（单会话）升级为跨会话持久化记忆，
   支持用户偏好、习惯、历史上下文的跨会话复用
2. 主动行为引擎：基于跨会话记忆和感知状态，主动触发行为
   （提醒、建议、预操作），而非仅被动响应用户输入
3. 记忆衰减与强化：基于访问频率和重要性自动调整记忆权重

跨会话记忆类型：
  - user_preference: 用户偏好（语言/风格/工具偏好）
  - user_habit: 用户习惯（工作时间/常用操作/工作流模式）
  - task_pattern: 任务模式（常见任务类型/成功策略/失败模式）
  - context_snapshot: 上下文快照（会话关键状态/中断点恢复）

主动行为类型：
  - reminder: 提醒（定时/条件触发）
  - suggestion: 建议（基于上下文推荐操作）
  - pre_operation: 预操作（提前准备环境/资源）
  - follow_up: 跟进（任务完成后的后续检查）

Usage:
    memory = CrossSessionMemory(data_dir="/path/to/data")
    memory.store_preference("language", "zh-CN")
    prefs = memory.get_preferences()

    engine = ProactiveEngine(memory=memory, perception_bus=bus)
    actions = engine.evaluate(perception_state)
    await engine.execute(actions)
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

log = StructuredLogger("cross_session_memory")


class MemoryType(str, Enum):
    USER_PREFERENCE = "user_preference"
    USER_HABIT = "user_habit"
    TASK_PATTERN = "task_pattern"
    CONTEXT_SNAPSHOT = "context_snapshot"


class ProactiveActionType(str, Enum):
    REMINDER = "reminder"
    SUGGESTION = "suggestion"
    PRE_OPERATION = "pre_operation"
    FOLLOW_UP = "follow_up"
    ENVIRONMENT_ADAPTATION = "environment_adaptation"
    QUALITY_ALERT = "quality_alert"


class MemoryPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class CrossSessionEntry:
    id: str = ""
    memory_type: MemoryType = MemoryType.USER_PREFERENCE
    key: str = ""
    value: Any = None
    priority: MemoryPriority = MemoryPriority.MEDIUM
    access_count: int = 0
    last_accessed: float = 0.0
    created_at: float = 0.0
    updated_at: float = 0.0
    decay_score: float = 1.0
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def touch(self) -> None:
        self.access_count += 1
        self.last_accessed = time.time()
        self.decay_score = min(1.0, self.decay_score + 0.1)

    def decay(self, hours_elapsed: float) -> None:
        decay_rate = {
            MemoryPriority.CRITICAL: 0.01,
            MemoryPriority.HIGH: 0.02,
            MemoryPriority.MEDIUM: 0.05,
            MemoryPriority.LOW: 0.1,
        }
        rate = decay_rate.get(self.priority, 0.05)
        self.decay_score = max(0.1, self.decay_score * (1.0 - rate * hours_elapsed / 24.0))


@dataclass
class ProactiveAction:
    action_type: ProactiveActionType = ProactiveActionType.SUGGESTION
    title: str = ""
    description: str = ""
    trigger_condition: str = ""
    priority: MemoryPriority = MemoryPriority.MEDIUM
    confidence: float = 0.5
    related_memories: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SessionSummary:
    session_id: str = ""
    user_id: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    task_count: int = 0
    success_count: int = 0
    tools_used: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    preferences_observed: dict[str, Any] = field(default_factory=dict)
    key_insights: list[str] = field(default_factory=list)


class CrossSessionMemory:
    def __init__(self, data_dir: str | None = None, user_id: str = "default") -> None:
        self._user_id = user_id
        self._data_dir = Path(data_dir) if data_dir else Path(
            os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent.parent / "data"))
        ) / "cross_session" / user_id
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._memory_path = self._data_dir / "memories.json"
        self._session_path = self._data_dir / "sessions.jsonl"

        self._memories: dict[str, CrossSessionEntry] = {}
        self._max_memories = 500
        self._session_summaries: list[SessionSummary] = []
        self._max_sessions = 50

        self._load_memories()

    def _load_memories(self) -> None:
        if self._memory_path.exists():
            try:
                raw = json.loads(self._memory_path.read_text(encoding="utf-8"))
                for entry_data in raw.get("memories", []):
                    entry = CrossSessionEntry(
                        id=entry_data.get("id", ""),
                        memory_type=MemoryType(entry_data.get("memory_type", "user_preference")),
                        key=entry_data.get("key", ""),
                        value=entry_data.get("value"),
                        priority=MemoryPriority(entry_data.get("priority", "medium")),
                        access_count=entry_data.get("access_count", 0),
                        last_accessed=entry_data.get("last_accessed", 0.0),
                        created_at=entry_data.get("created_at", 0.0),
                        updated_at=entry_data.get("updated_at", 0.0),
                        decay_score=entry_data.get("decay_score", 1.0),
                        tags=entry_data.get("tags", []),
                        metadata=entry_data.get("metadata", {}),
                    )
                    self._memories[entry.id] = entry
                log.debug("Cross-session memories loaded", count=len(self._memories))
            except Exception as e:
                log.warning("Failed to load cross-session memories", error=str(e))

    def _save_memories(self) -> None:
        try:
            data = {
                "memories": [
                    {
                        "id": e.id,
                        "memory_type": e.memory_type.value,
                        "key": e.key,
                        "value": e.value,
                        "priority": e.priority.value,
                        "access_count": e.access_count,
                        "last_accessed": e.last_accessed,
                        "created_at": e.created_at,
                        "updated_at": e.updated_at,
                        "decay_score": e.decay_score,
                        "tags": e.tags,
                        "metadata": e.metadata,
                    }
                    for e in self._memories.values()
                ],
                "saved_at": time.time(),
            }
            self._memory_path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as e:
            log.warning("Failed to save cross-session memories", error=str(e))

    def store(
        self,
        memory_type: MemoryType,
        key: str,
        value: Any,
        priority: MemoryPriority = MemoryPriority.MEDIUM,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CrossSessionEntry:
        existing = self._find_by_key(memory_type, key)
        if existing:
            existing.value = value
            existing.updated_at = time.time()
            existing.touch()
            if tags:
                existing.tags = list(set(existing.tags + tags))
            if metadata:
                existing.metadata.update(metadata)
            self._save_memories()
            return existing

        now = time.time()
        entry_id = f"{memory_type.value}_{key}_{int(now)}"
        entry = CrossSessionEntry(
            id=entry_id,
            memory_type=memory_type,
            key=key,
            value=value,
            priority=priority,
            created_at=now,
            updated_at=now,
            last_accessed=now,
            tags=tags or [],
            metadata=metadata or {},
        )
        self._memories[entry_id] = entry

        if len(self._memories) > self._max_memories:
            self._evict_low_priority()

        self._save_memories()
        return entry

    def retrieve(
        self,
        memory_type: MemoryType | None = None,
        key: str | None = None,
        tags: list[str] | None = None,
        min_decay: float = 0.3,
        limit: int = 10,
    ) -> list[CrossSessionEntry]:
        results = []
        for entry in self._memories.values():
            if entry.decay_score < min_decay:
                continue
            if memory_type and entry.memory_type != memory_type:
                continue
            if key and entry.key != key:
                continue
            if tags and not any(t in entry.tags for t in tags):
                continue
            entry.touch()
            results.append(entry)

        results.sort(key=lambda e: (e.priority.value, e.decay_score, e.access_count), reverse=True)
        return results[:limit]

    def store_preference(self, key: str, value: Any, **kwargs: Any) -> CrossSessionEntry:
        return self.store(MemoryType.USER_PREFERENCE, key, value, priority=MemoryPriority.HIGH, **kwargs)

    def get_preferences(self) -> dict[str, Any]:
        entries = self.retrieve(memory_type=MemoryType.USER_PREFERENCE, limit=50)
        return {e.key: e.value for e in entries}

    def store_habit(self, key: str, value: Any, **kwargs: Any) -> CrossSessionEntry:
        return self.store(MemoryType.USER_HABIT, key, value, priority=MemoryPriority.MEDIUM, **kwargs)

    def get_habits(self) -> dict[str, Any]:
        entries = self.retrieve(memory_type=MemoryType.USER_HABIT, limit=50)
        return {e.key: e.value for e in entries}

    def store_task_pattern(self, key: str, value: Any, **kwargs: Any) -> CrossSessionEntry:
        return self.store(MemoryType.TASK_PATTERN, key, value, priority=MemoryPriority.MEDIUM, **kwargs)

    def store_session_summary(self, summary: SessionSummary) -> None:
        self._session_summaries.append(summary)
        if len(self._session_summaries) > self._max_sessions:
            self._session_summaries = self._session_summaries[-self._max_sessions:]

        try:
            with open(self._session_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "session_id": summary.session_id,
                    "user_id": summary.user_id,
                    "start_time": summary.start_time,
                    "end_time": summary.end_time,
                    "task_count": summary.task_count,
                    "success_count": summary.success_count,
                    "tools_used": summary.tools_used,
                    "topics": summary.topics,
                    "preferences_observed": summary.preferences_observed,
                    "key_insights": summary.key_insights,
                }, ensure_ascii=False) + "\n")
        except Exception as e:
            log.debug("Failed to append session summary", error=str(e))

        for pref_key, pref_value in summary.preferences_observed.items():
            self.store_preference(pref_key, pref_value, tags=["session_observed"])

    def apply_decay(self) -> int:
        now = time.time()
        decayed = 0
        for entry in self._memories.values():
            hours = (now - entry.last_accessed) / 3600.0
            old_score = entry.decay_score
            entry.decay(hours)
            if entry.decay_score < old_score:
                decayed += 1
        if decayed > 0:
            self._save_memories()
        return decayed

    def _find_by_key(self, memory_type: MemoryType, key: str) -> CrossSessionEntry | None:
        for entry in self._memories.values():
            if entry.memory_type == memory_type and entry.key == key:
                return entry
        return None

    def _evict_low_priority(self) -> None:
        entries = sorted(
            self._memories.values(),
            key=lambda e: (e.priority.value, e.decay_score, e.access_count),
        )
        to_remove = len(self._memories) - self._max_memories + 50
        for entry in entries[:to_remove]:
            if entry.priority != MemoryPriority.CRITICAL:
                del self._memories[entry.id]

    def get_stats(self) -> dict[str, Any]:
        type_counts: dict[str, int] = {}
        for entry in self._memories.values():
            type_counts[entry.memory_type.value] = type_counts.get(entry.memory_type.value, 0) + 1
        return {
            "total_memories": len(self._memories),
            "type_counts": type_counts,
            "session_count": len(self._session_summaries),
        }


class ProactiveEngine:
    def __init__(
        self,
        memory: CrossSessionMemory | None = None,
        perception_bus: Any | None = None,
    ) -> None:
        self._memory = memory or CrossSessionMemory()
        self._perception_bus = perception_bus
        self._action_history: list[ProactiveAction] = []
        self._max_history = 50
        self._cooldown_seconds = 300.0
        self._last_action_time: dict[ProactiveActionType, float] = {}

    def evaluate(
        self,
        perception_state: Any | None = None,
        current_input: str = "",
        prediction_stats: dict[str, Any] | None = None,
        environment_change: dict[str, Any] | None = None,
    ) -> list[ProactiveAction]:
        actions: list[ProactiveAction] = []

        actions.extend(self._evaluate_reminders(perception_state))
        actions.extend(self._evaluate_suggestions(perception_state, current_input))
        actions.extend(self._evaluate_pre_operations(perception_state))
        actions.extend(self._evaluate_follow_ups())

        # W3-4: 基于学习结果和环境变化的自主触发
        if prediction_stats is not None:
            actions.extend(self._evaluate_quality_alerts(prediction_stats))
        if environment_change is not None:
            actions.extend(self._evaluate_environment_adaptation(environment_change, perception_state))

        actions = [a for a in actions if self._check_cooldown(a.action_type)]

        actions.sort(key=lambda a: (a.priority.value, a.confidence), reverse=True)
        return actions[:5]

    def _evaluate_reminders(self, perception_state: Any | None = None) -> list[ProactiveAction]:
        actions: list[ProactiveAction] = []

        habits = self._memory.get_habits()
        now = time.time()
        import datetime
        current_hour = datetime.datetime.now().hour

        work_start = habits.get("work_start_hour")
        if work_start and isinstance(work_start, int):
            if current_hour == work_start:
                actions.append(ProactiveAction(
                    action_type=ProactiveActionType.REMINDER,
                    title="工作开始提醒",
                    description=f"根据您的习惯，通常在 {work_start}:00 开始工作",
                    trigger_condition=f"hour=={work_start}",
                    priority=MemoryPriority.MEDIUM,
                    confidence=0.7,
                    related_memories=["habit:work_start_hour"],
                ))

        daily_tasks = habits.get("daily_tasks", [])
        if daily_tasks and isinstance(daily_tasks, list):
            for task in daily_tasks[:3]:
                if isinstance(task, dict):
                    actions.append(ProactiveAction(
                        action_type=ProactiveActionType.REMINDER,
                        title=f"日常任务: {task.get('name', '未命名')}",
                        description=task.get("description", ""),
                        priority=MemoryPriority.MEDIUM,
                        confidence=0.6,
                    ))

        return actions

    def _evaluate_suggestions(
        self,
        perception_state: Any | None = None,
        current_input: str = "",
    ) -> list[ProactiveAction]:
        actions: list[ProactiveAction] = []

        prefs = self._memory.get_preferences()

        if perception_state:
            scene = getattr(perception_state, "scene", None)
            if scene and hasattr(scene, "scene_type"):
                scene_type = scene.scene_type
                if scene_type == "coding":
                    preferred_editor = prefs.get("preferred_editor")
                    if preferred_editor:
                        actions.append(ProactiveAction(
                            action_type=ProactiveActionType.SUGGESTION,
                            title="编码环境建议",
                            description=f"检测到编码场景，建议使用 {preferred_editor}",
                            priority=MemoryPriority.LOW,
                            confidence=0.5,
                            related_memories=["preference:preferred_editor"],
                        ))

            emotion = getattr(perception_state, "emotion", None)
            if emotion and hasattr(emotion, "emotion_type"):
                if emotion.emotion_type == "frustrated":
                    actions.append(ProactiveAction(
                        action_type=ProactiveActionType.SUGGESTION,
                        title="简化操作建议",
                        description="检测到您可能遇到困难，建议分解任务或寻求帮助",
                        priority=MemoryPriority.HIGH,
                        confidence=0.6,
                    ))

        task_patterns = self._memory.retrieve(
            memory_type=MemoryType.TASK_PATTERN, limit=5,
        )
        if task_patterns and current_input:
            for pattern in task_patterns[:2]:
                pattern_keywords = pattern.key.lower().split("_")
                if any(kw in current_input.lower() for kw in pattern_keywords if len(kw) > 2):
                    actions.append(ProactiveAction(
                        action_type=ProactiveActionType.SUGGESTION,
                        title=f"基于历史模式的建议",
                        description=f"类似任务的历史经验: {str(pattern.value)[:100]}",
                        priority=MemoryPriority.MEDIUM,
                        confidence=0.5,
                        related_memories=[pattern.id],
                    ))

        return actions

    def _evaluate_pre_operations(self, perception_state: Any | None = None) -> list[ProactiveAction]:
        actions: list[ProactiveAction] = []

        prefs = self._memory.get_preferences()
        habits = self._memory.get_habits()

        auto_launch = habits.get("auto_launch_apps", [])
        if auto_launch and isinstance(auto_launch, list):
            import datetime
            current_hour = datetime.datetime.now().hour
            work_start = habits.get("work_start_hour", 9)
            if isinstance(work_start, int) and current_hour == work_start:
                for app in auto_launch[:3]:
                    actions.append(ProactiveAction(
                        action_type=ProactiveActionType.PRE_OPERATION,
                        title=f"预启动: {app}",
                        description=f"根据习惯，工作开始时自动启动 {app}",
                        priority=MemoryPriority.LOW,
                        confidence=0.5,
                    ))

        return actions

    def _evaluate_follow_ups(self) -> list[ProactiveAction]:
        actions: list[ProactiveAction] = []

        sessions = self._memory._session_summaries
        if sessions:
            last_session = sessions[-1]
            if last_session.success_count < last_session.task_count:
                failed_ratio = 1.0 - (last_session.success_count / max(1, last_session.task_count))
                if failed_ratio > 0.3:
                    actions.append(ProactiveAction(
                        action_type=ProactiveActionType.FOLLOW_UP,
                        title="上次会话跟进",
                        description=f"上次会话有 {last_session.task_count - last_session.success_count} 个任务未完成",
                        priority=MemoryPriority.MEDIUM,
                        confidence=0.6,
                    ))

        return actions

    def _check_cooldown(self, action_type: ProactiveActionType) -> bool:
        last_time = self._last_action_time.get(action_type, 0.0)
        if time.time() - last_time < self._cooldown_seconds:
            return False
        return True

    def _evaluate_quality_alerts(
        self,
        prediction_stats: dict[str, Any],
    ) -> list[ProactiveAction]:
        actions: list[ProactiveAction] = []
        mismatch_rate = prediction_stats.get("mismatch_rate", 0.0)
        total_predictions = prediction_stats.get("total_predictions", 0)
        tool_stats = prediction_stats.get("tool_stats", {})

        if total_predictions >= 5 and mismatch_rate > 0.4:
            actions.append(ProactiveAction(
                action_type=ProactiveActionType.QUALITY_ALERT,
                title="执行质量下降预警",
                description=f"近期预测偏差率达 {mismatch_rate:.0%}，建议检查工具链或调整策略",
                trigger_condition=f"mismatch_rate>{0.4:.0%}",
                priority=MemoryPriority.HIGH,
                confidence=min(0.9, mismatch_rate),
            ))

        for tool_name, stats in tool_stats.items():
            if not isinstance(stats, dict):
                continue
            success_rate = stats.get("success_rate", 1.0)
            total_calls = stats.get("total_calls", 0)
            if total_calls >= 3 and success_rate < 0.5:
                actions.append(ProactiveAction(
                    action_type=ProactiveActionType.QUALITY_ALERT,
                    title=f"工具 {tool_name} 成功率过低",
                    description=f"工具 {tool_name} 近期成功率仅 {success_rate:.0%}（{total_calls} 次调用），建议切换替代工具",
                    trigger_condition=f"tool_success_rate<{0.5:.0%}",
                    priority=MemoryPriority.HIGH,
                    confidence=0.7,
                    related_memories=[f"tool_stats:{tool_name}"],
                ))

        return actions

    def _evaluate_environment_adaptation(
        self,
        environment_change: dict[str, Any],
        perception_state: Any | None = None,
    ) -> list[ProactiveAction]:
        actions: list[ProactiveAction] = []
        changed_fields = environment_change.get("changed_fields", [])
        old_state = environment_change.get("old_state", {})
        new_state = environment_change.get("new_state", {})

        if "network_status" in changed_fields:
            old_net = old_state.get("network_status", "unknown")
            new_net = new_state.get("network_status", "unknown")
            if old_net == "connected" and new_net in ("disconnected", "limited"):
                actions.append(ProactiveAction(
                    action_type=ProactiveActionType.ENVIRONMENT_ADAPTATION,
                    title="网络状态变化 - 切换离线模式",
                    description="检测到网络断开，建议切换到离线可用工具和本地缓存策略",
                    trigger_condition="network_status=disconnected",
                    priority=MemoryPriority.HIGH,
                    confidence=0.8,
                ))
            elif old_net in ("disconnected", "limited") and new_net == "connected":
                actions.append(ProactiveAction(
                    action_type=ProactiveActionType.ENVIRONMENT_ADAPTATION,
                    title="网络恢复 - 同步待处理数据",
                    description="网络已恢复，建议同步离线期间的待处理数据",
                    trigger_condition="network_status=connected",
                    priority=MemoryPriority.MEDIUM,
                    confidence=0.7,
                ))

        if "active_window" in changed_fields:
            new_window = new_state.get("active_window", "")
            prefs = self._memory.get_preferences()
            known_apps = prefs.get("known_applications", {})
            if new_window and isinstance(known_apps, dict):
                for app_key, app_config in known_apps.items():
                    if isinstance(app_config, dict) and app_config.get("window_pattern", "") in new_window:
                        actions.append(ProactiveAction(
                            action_type=ProactiveActionType.ENVIRONMENT_ADAPTATION,
                            title=f"检测到 {app_config.get('name', app_key)} 环境",
                            description=app_config.get("suggestion", f"已切换到 {app_key}，可提供针对性帮助"),
                            trigger_condition=f"active_window={app_key}",
                            priority=MemoryPriority.LOW,
                            confidence=0.5,
                        ))

        if "emotion_type" in changed_fields:
            old_emotion = old_state.get("emotion_type", "neutral")
            new_emotion = new_state.get("emotion_type", "neutral")
            if new_emotion == "frustrated" and old_emotion != "frustrated":
                actions.append(ProactiveAction(
                    action_type=ProactiveActionType.ENVIRONMENT_ADAPTATION,
                    title="情绪变化 - 简化交互",
                    description="检测到情绪变化，建议简化操作步骤并提供更直接的解决方案",
                    trigger_condition="emotion_type=frustrated",
                    priority=MemoryPriority.HIGH,
                    confidence=0.6,
                ))

        return actions

    def record_action_executed(self, action: ProactiveAction) -> None:
        self._last_action_time[action.action_type] = time.time()
        self._action_history.append(action)
        if len(self._action_history) > self._max_history:
            self._action_history = self._action_history[-self._max_history:]

    async def execute(self, actions: list[ProactiveAction]) -> list[dict[str, Any]]:
        results = []
        for action in actions:
            result = {
                "action_type": action.action_type.value,
                "title": action.title,
                "executed": False,
                "message": action.description,
            }

            if action.action_type == ProactiveActionType.PRE_OPERATION:
                result["executed"] = True
                result["message"] = f"预操作已触发: {action.description}"

            elif action.action_type == ProactiveActionType.SUGGESTION:
                result["executed"] = True
                result["message"] = f"建议: {action.description}"

            elif action.action_type == ProactiveActionType.REMINDER:
                result["executed"] = True
                result["message"] = f"提醒: {action.description}"

            elif action.action_type == ProactiveActionType.FOLLOW_UP:
                result["executed"] = True
                result["message"] = f"跟进: {action.description}"

            elif action.action_type == ProactiveActionType.ENVIRONMENT_ADAPTATION:
                result["executed"] = True
                result["message"] = f"环境适应: {action.description}"

            elif action.action_type == ProactiveActionType.QUALITY_ALERT:
                result["executed"] = True
                result["message"] = f"质量预警: {action.description}"

            self.record_action_executed(action)
            results.append(result)

        return results
