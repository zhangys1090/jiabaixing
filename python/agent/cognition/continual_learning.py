"""P2-2: 持续学习回路 — 长期进化能力。

设计目标：
1. 经验提取：从任务执行历史中提取可复用的经验模式
2. 策略优化：基于经验反馈自动调整策略参数（工具选择/推理策略/提示词）
3. 知识沉淀：将高频成功模式固化为可检索的知识条目
4. 遗忘机制：低价值知识自动衰减，保持知识库精简高效
5. 迁移学习：跨领域/跨任务的经验迁移

持续学习闭环：
  任务执行 → 经验采集(成功/失败/耗时/质量)
    → 模式识别(成功模式/失败模式/性能瓶颈)
      → 策略调整(参数优化/规则更新/知识沉淀)
        → 效果验证(A/B对比)
          → 知识巩固(高频→高权重) / 遗忘(低频→衰减)

Usage:
    loop = ContinualLearningLoop(cross_session_memory=mem)
    experience = loop.record_experience(task, action, outcome)
    adjustments = await loop.learn()
    knowledge = loop.retrieve_relevant_knowledge("similar task")
"""

from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("continual_learning")


class ExperienceType(str, Enum):
    TASK_SUCCESS = "task_success"
    TASK_FAILURE = "task_failure"
    TOOL_USAGE = "tool_usage"
    STRATEGY_OUTCOME = "strategy_outcome"
    USER_FEEDBACK = "user_feedback"
    SELF_CORRECTION = "self_correction"


class KnowledgeCategory(str, Enum):
    PROCEDURE = "procedure"
    PATTERN = "pattern"
    ANTI_PATTERN = "anti_pattern"
    HEURISTIC = "heuristic"
    DOMAIN_FACT = "domain_fact"
    TOOL_WISDOM = "tool_wisdom"


class AdjustmentType(str, Enum):
    PARAMETER_TUNING = "parameter_tuning"
    RULE_UPDATE = "rule_update"
    KNOWLEDGE_SOLIDIFY = "knowledge_solidify"
    KNOWLEDGE_DECAY = "knowledge_decay"
    STRATEGY_SWITCH = "strategy_switch"
    PROMPT_REFINE = "prompt_refine"


@dataclass
class Experience:
    experience_id: str = ""
    type: ExperienceType = ExperienceType.TASK_SUCCESS
    task: str = ""
    action: str = ""
    outcome: str = ""
    success: bool = True
    quality_score: float = 0.5
    duration_ms: float = 0.0
    context: dict[str, Any] = field(default_factory=dict)
    tools_used: list[str] = field(default_factory=list)
    strategy_used: str = ""
    timestamp: float = 0.0

    @property
    def efficiency(self) -> float:
        if self.duration_ms <= 0:
            return 0.0
        return self.quality_score / (self.duration_ms / 1000.0)


@dataclass
class SuccessPattern:
    pattern_id: str = ""
    task_pattern: str = ""
    strategy: str = ""
    tools: list[str] = field(default_factory=list)
    success_rate: float = 0.0
    avg_quality: float = 0.0
    avg_duration_ms: float = 0.0
    occurrence_count: int = 0
    last_seen: float = 0.0
    confidence: float = 0.5


@dataclass
class FailurePattern:
    pattern_id: str = ""
    task_pattern: str = ""
    failure_mode: str = ""
    common_causes: list[str] = field(default_factory=list)
    occurrence_count: int = 0
    avoidance_strategies: list[str] = field(default_factory=list)
    last_seen: float = 0.0


@dataclass
class KnowledgeEntry:
    entry_id: str = ""
    category: KnowledgeCategory = KnowledgeCategory.HEURISTIC
    title: str = ""
    content: str = ""
    domain: str = "general"
    weight: float = 1.0
    access_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    created_at: float = 0.0
    last_accessed: float = 0.0
    last_reinforced: float = 0.0
    source_experience_ids: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / total if total > 0 else 0.0

    @property
    def decay_score(self) -> float:
        hours_since_reinforce = (time.time() - self.last_reinforced) / 3600.0
        decay_rate = 0.02 if self.weight > 0.7 else 0.05
        return max(0.1, self.weight * math.exp(-decay_rate * hours_since_reinforce))

    def reinforce(self, delta: float = 0.1) -> None:
        self.weight = min(2.0, self.weight + delta)
        self.access_count += 1
        self.success_count += 1
        self.last_accessed = time.time()
        self.last_reinforced = time.time()

    def penalize(self, delta: float = 0.05) -> None:
        self.weight = max(0.1, self.weight - delta)
        self.access_count += 1
        self.failure_count += 1
        self.last_accessed = time.time()


@dataclass
class LearningAdjustment:
    adjustment_id: str = ""
    type: AdjustmentType = AdjustmentType.PARAMETER_TUNING
    target: str = ""
    parameter: str = ""
    old_value: Any = None
    new_value: Any = None
    reason: str = ""
    confidence: float = 0.5
    timestamp: float = 0.0


@dataclass
class LearningReport:
    report_id: str = ""
    total_experiences: int = 0
    new_patterns_found: int = 0
    adjustments_made: int = 0
    knowledge_solidified: int = 0
    knowledge_decayed: int = 0
    adjustments: list[LearningAdjustment] = field(default_factory=list)
    duration_ms: float = 0.0


_TOOL_SUCCESS_RATES: dict[str, float] = {
    "web_search": 0.85, "file_read": 0.95, "file_write": 0.90,
    "code_execute": 0.80, "calculator": 0.98, "screen_capture": 0.95,
    "uia_inspect": 0.90, "clipboard": 0.95,
}

_STRATEGY_SUCCESS_RATES: dict[str, float] = {
    "direct": 0.7, "cot": 0.85, "tot": 0.80, "counterfactual": 0.75,
}


class ContinualLearningLoop:
    """持续学习回路 — 长期进化能力。

    Args:
        cross_session_memory: 跨会话记忆（可选，用于持久化知识）。
        knowledge_capacity: 知识库最大条目数。
        experience_window: 经验窗口大小（最近N条用于模式识别）。
        decay_threshold: 知识衰减阈值，低于此值的条目将被遗忘。
    """

    def __init__(
        self,
        cross_session_memory: Any | None = None,
        knowledge_capacity: int = 500,
        experience_window: int = 200,
        decay_threshold: float = 0.2,
    ) -> None:
        self._cross_session_memory = cross_session_memory
        self._knowledge_capacity = knowledge_capacity
        self._experience_window = experience_window
        self._decay_threshold = decay_threshold

        self._experiences: list[Experience] = []
        self._success_patterns: dict[str, SuccessPattern] = {}
        self._failure_patterns: dict[str, FailurePattern] = {}
        self._knowledge: dict[str, KnowledgeEntry] = {}
        self._tool_stats: dict[str, dict[str, float]] = {}
        self._strategy_stats: dict[str, dict[str, float]] = {}

        for tool, rate in _TOOL_SUCCESS_RATES.items():
            self._tool_stats[tool] = {"success_rate": rate, "count": 10.0}
        for strategy, rate in _STRATEGY_SUCCESS_RATES.items():
            self._strategy_stats[strategy] = {"success_rate": rate, "count": 10.0}

    def record_experience(
        self,
        task: str,
        action: str,
        outcome: str,
        success: bool = True,
        quality_score: float = 0.5,
        duration_ms: float = 0.0,
        tools_used: list[str] | None = None,
        strategy_used: str = "",
        context: dict[str, Any] | None = None,
    ) -> Experience:
        exp = Experience(
            experience_id=f"exp_{uuid.uuid4().hex[:12]}",
            type=ExperienceType.TASK_SUCCESS if success else ExperienceType.TASK_FAILURE,
            task=task,
            action=action,
            outcome=outcome,
            success=success,
            quality_score=quality_score,
            duration_ms=duration_ms,
            tools_used=tools_used or [],
            strategy_used=strategy_used,
            context=context or {},
            timestamp=time.time(),
        )
        self._experiences.append(exp)
        if len(self._experiences) > self._experience_window:
            self._experiences.pop(0)

        for tool in (tools_used or []):
            self._update_tool_stat(tool, success)
        if strategy_used:
            self._update_strategy_stat(strategy_used, success)

        log.info("经验记录", experience_id=exp.experience_id,
                 type=exp.type.value, success=success,
                 quality=f"{quality_score:.2f}")
        return exp

    async def learn(self) -> LearningReport:
        start = time.time()
        adjustments: list[LearningAdjustment] = []
        new_patterns = 0
        solidified = 0
        decayed = 0

        success_exps = [e for e in self._experiences if e.success]
        failure_exps = [e for e in self._experiences if not e.success]

        new_patterns += self._extract_success_patterns(success_exps)
        new_patterns += self._extract_failure_patterns(failure_exps)

        for pattern in self._success_patterns.values():
            if pattern.occurrence_count >= 3 and pattern.success_rate >= 0.7:
                adj = self._solidify_pattern_to_knowledge(pattern)
                if adj:
                    adjustments.append(adj)
                    solidified += 1

        for pattern in self._failure_patterns.values():
            if pattern.occurrence_count >= 2:
                adj = self._create_avoidance_knowledge(pattern)
                if adj:
                    adjustments.append(adj)
                    solidified += 1

        tool_adjs = self._optimize_tool_selection()
        adjustments.extend(tool_adjs)

        strategy_adjs = self._optimize_strategy_selection()
        adjustments.extend(strategy_adjs)

        decayed = self._apply_knowledge_decay()

        duration_ms = (time.time() - start) * 1000
        report = LearningReport(
            report_id=f"lr_{uuid.uuid4().hex[:12]}",
            total_experiences=len(self._experiences),
            new_patterns_found=new_patterns,
            adjustments_made=len(adjustments),
            knowledge_solidified=solidified,
            knowledge_decayed=decayed,
            adjustments=adjustments,
            duration_ms=duration_ms,
        )
        log.info("持续学习完成", report_id=report.report_id,
                 experiences=report.total_experiences,
                 patterns=new_patterns, adjustments=len(adjustments),
                 solidified=solidified, decayed=decayed)
        return report

    def retrieve_relevant_knowledge(
        self,
        query: str,
        category: KnowledgeCategory | None = None,
        domain: str | None = None,
        top_k: int = 5,
    ) -> list[KnowledgeEntry]:
        candidates: list[tuple[float, KnowledgeEntry]] = []
        query_lower = query.lower()
        query_words = set(query_lower.split())
        query_bigrams = self._extract_ngrams(query_lower, 2)

        for entry in self._knowledge.values():
            if category and entry.category != category:
                continue
            if domain and entry.domain != domain:
                continue
            relevance = 0.0
            title_lower = entry.title.lower()
            content_lower = entry.content.lower()
            if query_lower in title_lower:
                relevance += 0.5
            if query_lower in content_lower:
                relevance += 0.3
            title_words = set(title_lower.split())
            content_words = set(content_lower.split())
            word_overlap = len(query_words & (title_words | content_words))
            relevance += 0.1 * word_overlap
            entry_text = title_lower + " " + content_lower
            entry_bigrams = self._extract_ngrams(entry_text, 2)
            if query_bigrams and entry_bigrams:
                bigram_overlap = len(query_bigrams & entry_bigrams)
                bigram_total = len(query_bigrams | entry_bigrams)
                jaccard = bigram_overlap / bigram_total if bigram_total > 0 else 0.0
                relevance += 0.3 * jaccard
            for tag in entry.tags:
                if tag.lower() in query_lower:
                    relevance += 0.15
            relevance *= entry.decay_score
            if relevance > 0:
                candidates.append((relevance, entry))

        candidates.sort(key=lambda x: x[0], reverse=True)
        result = [entry for _, entry in candidates[:top_k]]
        for entry in result:
            entry.access_count += 1
            entry.last_accessed = time.time()
        return result

    def get_tool_recommendation(self, task: str) -> list[tuple[str, float]]:
        scores: list[tuple[str, float]] = []
        for tool, stats in self._tool_stats.items():
            scores.append((tool, stats["success_rate"]))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores

    def get_strategy_recommendation(self, task: str) -> list[tuple[str, float]]:
        scores: list[tuple[str, float]] = []
        for strategy, stats in self._strategy_stats.items():
            scores.append((strategy, stats["success_rate"]))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores

    @staticmethod
    def _extract_ngrams(text: str, n: int) -> set[str]:
        words = text.split()
        if len(words) < n:
            return set()
        return {" ".join(words[i:i + n]) for i in range(len(words) - n + 1)}

    def transfer_knowledge(self, source_domain: str, target_domain: str, min_weight: float = 0.5) -> int:
        """迁移学习 — 将源领域的高价值知识迁移到目标领域。"""
        transferred = 0
        candidates = [
            entry for entry in self._knowledge.values()
            if entry.domain == source_domain and entry.weight >= min_weight
        ]
        for entry in candidates:
            new_id = f"ke_xfer_{entry.entry_id}"
            if new_id not in self._knowledge:
                self._knowledge[new_id] = KnowledgeEntry(
                    entry_id=new_id,
                    category=entry.category,
                    title=entry.title,
                    content=entry.content,
                    domain=target_domain,
                    weight=entry.weight * 0.8,
                    tags=entry.tags + [f"transferred_from_{source_domain}"],
                    created_at=time.time(),
                    last_accessed=time.time(),
                    last_reinforced=time.time(),
                )
                transferred += 1
        if transferred > 0:
            log.info("迁移学习完成", source=source_domain, target=target_domain, count=transferred)
        return transferred

    def _update_tool_stat(self, tool: str, success: bool) -> None:
        if tool not in self._tool_stats:
            self._tool_stats[tool] = {"success_rate": 0.5, "count": 1.0}
        stats = self._tool_stats[tool]
        n = stats["count"]
        old_rate = stats["success_rate"]
        stats["success_rate"] = (old_rate * n + (1.0 if success else 0.0)) / (n + 1)
        stats["count"] = n + 1

    def _update_strategy_stat(self, strategy: str, success: bool) -> None:
        if strategy not in self._strategy_stats:
            self._strategy_stats[strategy] = {"success_rate": 0.5, "count": 1.0}
        stats = self._strategy_stats[strategy]
        n = stats["count"]
        old_rate = stats["success_rate"]
        stats["success_rate"] = (old_rate * n + (1.0 if success else 0.0)) / (n + 1)
        stats["count"] = n + 1

    def _extract_success_patterns(self, experiences: list[Experience]) -> int:
        if len(experiences) < 2:
            return 0
        found = 0
        strategy_groups: dict[str, list[Experience]] = {}
        for exp in experiences:
            key = exp.strategy_used or "none"
            strategy_groups.setdefault(key, []).append(exp)
        for strategy, group in strategy_groups.items():
            if len(group) < 2:
                continue
            avg_quality = sum(e.quality_score for e in group) / len(group)
            avg_duration = sum(e.duration_ms for e in group) / len(group)
            pattern_id = f"sp_{strategy}"
            if pattern_id in self._success_patterns:
                p = self._success_patterns[pattern_id]
                p.occurrence_count += len(group)
                p.success_rate = (p.success_rate * p.occurrence_count + len(group)) / (p.occurrence_count + len(group))
                p.avg_quality = avg_quality
                p.avg_duration_ms = avg_duration
                p.last_seen = time.time()
            else:
                self._success_patterns[pattern_id] = SuccessPattern(
                    pattern_id=pattern_id,
                    task_pattern=group[0].task[:50],
                    strategy=strategy,
                    tools=list({t for e in group for t in e.tools_used}),
                    success_rate=1.0,
                    avg_quality=avg_quality,
                    avg_duration_ms=avg_duration,
                    occurrence_count=len(group),
                    last_seen=time.time(),
                    confidence=min(1.0, len(group) / 10.0),
                )
                found += 1
        return found

    def _extract_failure_patterns(self, experiences: list[Experience]) -> int:
        if not experiences:
            return 0
        found = 0
        cause_groups: dict[str, list[Experience]] = {}
        for exp in experiences:
            cause = exp.outcome[:30] if exp.outcome else "unknown"
            cause_groups.setdefault(cause, []).append(exp)
        for cause, group in cause_groups.items():
            if len(group) < 1:
                continue
            pattern_id = f"fp_{cause}"
            if pattern_id in self._failure_patterns:
                p = self._failure_patterns[pattern_id]
                p.occurrence_count += len(group)
                p.last_seen = time.time()
            else:
                self._failure_patterns[pattern_id] = FailurePattern(
                    pattern_id=pattern_id,
                    task_pattern=group[0].task[:50],
                    failure_mode=cause,
                    common_causes=[cause],
                    occurrence_count=len(group),
                    last_seen=time.time(),
                )
                found += 1
        return found

    def _solidify_pattern_to_knowledge(self, pattern: SuccessPattern) -> LearningAdjustment | None:
        entry_id = f"ke_{pattern.pattern_id}"
        if entry_id in self._knowledge:
            self._knowledge[entry_id].reinforce(0.05)
            return None
        entry = KnowledgeEntry(
            entry_id=entry_id,
            category=KnowledgeCategory.PATTERN,
            title=f"成功模式：{pattern.strategy}策略",
            content=f"任务模式'{pattern.task_pattern}'使用{pattern.strategy}策略，"
                    f"成功率{pattern.success_rate:.0%}，平均质量{pattern.avg_quality:.2f}，"
                    f"工具集{pattern.tools}",
            domain="general",
            weight=pattern.confidence,
            source_experience_ids=[],
            tags=[pattern.strategy] + pattern.tools,
            created_at=time.time(),
            last_accessed=time.time(),
            last_reinforced=time.time(),
        )
        self._knowledge[entry_id] = entry
        return LearningAdjustment(
            adjustment_id=f"adj_{uuid.uuid4().hex[:8]}",
            type=AdjustmentType.KNOWLEDGE_SOLIDIFY,
            target=entry_id,
            parameter="weight",
            old_value=0.0,
            new_value=entry.weight,
            reason=f"成功模式出现{pattern.occurrence_count}次，成功率{pattern.success_rate:.0%}",
            confidence=pattern.confidence,
            timestamp=time.time(),
        )

    def _create_avoidance_knowledge(self, pattern: FailurePattern) -> LearningAdjustment | None:
        entry_id = f"ke_{pattern.pattern_id}"
        if entry_id in self._knowledge:
            return None
        entry = KnowledgeEntry(
            entry_id=entry_id,
            category=KnowledgeCategory.ANTI_PATTERN,
            title=f"失败模式：{pattern.failure_mode}",
            content=f"任务模式'{pattern.task_pattern}'常因'{pattern.failure_mode}'失败，"
                    f"出现{pattern.occurrence_count}次。"
                    f"避免策略：{pattern.avoidance_strategies or ['换用不同策略']}",
            domain="general",
            weight=0.6,
            tags=["avoidance", pattern.failure_mode],
            created_at=time.time(),
            last_accessed=time.time(),
            last_reinforced=time.time(),
        )
        self._knowledge[entry_id] = entry
        return LearningAdjustment(
            adjustment_id=f"adj_{uuid.uuid4().hex[:8]}",
            type=AdjustmentType.KNOWLEDGE_SOLIDIFY,
            target=entry_id,
            parameter="weight",
            old_value=0.0,
            new_value=0.6,
            reason=f"失败模式出现{pattern.occurrence_count}次",
            confidence=0.6,
            timestamp=time.time(),
        )

    def _optimize_tool_selection(self) -> list[LearningAdjustment]:
        adjustments: list[LearningAdjustment] = []
        for tool, stats in self._tool_stats.items():
            rate = stats["success_rate"]
            count = stats["count"]
            if count < 5:
                continue
            if rate < 0.3 and count >= 10:
                adjustments.append(LearningAdjustment(
                    adjustment_id=f"adj_{uuid.uuid4().hex[:8]}",
                    type=AdjustmentType.RULE_UPDATE,
                    target=tool,
                    parameter="priority",
                    old_value="normal",
                    new_value="deprecated",
                    reason=f"工具{tool}成功率仅{rate:.0%}（{int(count)}次采样），建议降级",
                    confidence=1.0 - rate,
                    timestamp=time.time(),
                ))
            elif rate > 0.9 and count >= 10:
                adjustments.append(LearningAdjustment(
                    adjustment_id=f"adj_{uuid.uuid4().hex[:8]}",
                    type=AdjustmentType.RULE_UPDATE,
                    target=tool,
                    parameter="priority",
                    old_value="normal",
                    new_value="preferred",
                    reason=f"工具{tool}成功率{rate:.0%}（{int(count)}次采样），建议优先",
                    confidence=rate,
                    timestamp=time.time(),
                ))
        return adjustments

    def _optimize_strategy_selection(self) -> list[LearningAdjustment]:
        adjustments: list[LearningAdjustment] = []
        strategy_rates = {s: st["success_rate"] for s, st in self._strategy_stats.items() if st["count"] >= 5}
        if not strategy_rates:
            return adjustments
        best_strategy = max(strategy_rates, key=strategy_rates.get)
        worst_strategy = min(strategy_rates, key=strategy_rates.get)
        if strategy_rates[best_strategy] - strategy_rates[worst_strategy] > 0.2:
            adjustments.append(LearningAdjustment(
                adjustment_id=f"adj_{uuid.uuid4().hex[:8]}",
                type=AdjustmentType.STRATEGY_SWITCH,
                target=worst_strategy,
                parameter="preferred_strategy",
                old_value=worst_strategy,
                new_value=best_strategy,
                reason=f"策略{best_strategy}成功率{strategy_rates[best_strategy]:.0%}远高于{worst_strategy}的{strategy_rates[worst_strategy]:.0%}",
                confidence=strategy_rates[best_strategy] - strategy_rates[worst_strategy],
                timestamp=time.time(),
            ))
        return adjustments

    def _apply_knowledge_decay(self) -> int:
        decayed = 0
        to_remove: list[str] = []
        avg_access = 0.0
        if self._knowledge:
            avg_access = sum(e.access_count for e in self._knowledge.values()) / len(self._knowledge)
        for entry_id, entry in self._knowledge.items():
            adaptive_threshold = self._decay_threshold
            if entry.access_count > avg_access * 2 and entry.success_rate > 0.7:
                adaptive_threshold *= 0.5
            elif entry.access_count < avg_access * 0.5:
                adaptive_threshold *= 2.0
            if entry.decay_score < adaptive_threshold:
                to_remove.append(entry_id)
                decayed += 1
        for entry_id in to_remove:
            del self._knowledge[entry_id]
        if len(self._knowledge) > self._knowledge_capacity:
            sorted_entries = sorted(self._knowledge.items(), key=lambda x: x[1].weight)
            excess = len(self._knowledge) - self._knowledge_capacity
            for entry_id, _ in sorted_entries[:excess]:
                del self._knowledge[entry_id]
                decayed += 1
        return decayed

    @property
    def knowledge_count(self) -> int:
        return len(self._knowledge)

    @property
    def experience_count(self) -> int:
        return len(self._experiences)

    def save_state(self) -> dict[str, Any]:
        """序列化知识库和统计信息为可持久化字典。"""
        knowledge_data = {}
        for eid, entry in self._knowledge.items():
            knowledge_data[eid] = {
                "entry_id": entry.entry_id,
                "category": entry.category.value,
                "title": entry.title,
                "content": entry.content,
                "domain": entry.domain,
                "weight": entry.weight,
                "access_count": entry.access_count,
                "success_count": entry.success_count,
                "failure_count": entry.failure_count,
                "tags": entry.tags,
                "last_reinforced": entry.last_reinforced,
            }
        return {
            "knowledge": knowledge_data,
            "tool_stats": self._tool_stats,
            "strategy_stats": self._strategy_stats,
            "experience_count": len(self._experiences),
        }

    def load_state(self, data: dict[str, Any]) -> None:
        """从持久化字典恢复知识库和统计信息。"""
        knowledge_data = data.get("knowledge", {})
        for eid, edata in knowledge_data.items():
            if eid not in self._knowledge:
                self._knowledge[eid] = KnowledgeEntry(
                    entry_id=edata["entry_id"],
                    category=KnowledgeCategory(edata["category"]),
                    title=edata["title"],
                    content=edata["content"],
                    domain=edata.get("domain", "general"),
                    weight=edata.get("weight", 1.0),
                    access_count=edata.get("access_count", 0),
                    success_count=edata.get("success_count", 0),
                    failure_count=edata.get("failure_count", 0),
                    tags=edata.get("tags", []),
                    created_at=time.time(),
                    last_accessed=time.time(),
                    last_reinforced=edata.get("last_reinforced", time.time()),
                )
        for tool, stats in data.get("tool_stats", {}).items():
            self._tool_stats[tool] = stats
        for strategy, stats in data.get("strategy_stats", {}).items():
            self._strategy_stats[strategy] = stats
        log.info("持续学习状态恢复", knowledge_loaded=len(knowledge_data))

    @property
    def pattern_count(self) -> int:
        return len(self._success_patterns) + len(self._failure_patterns)
