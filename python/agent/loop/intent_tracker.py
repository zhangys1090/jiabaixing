"""用户意图追踪器 — 实时追踪用户意图变化和漂移检测。

核心价值：
1. 意图识别：从用户输入中识别核心意图和子意图
2. 意图漂移检测：检测用户意图是否发生变化（话题切换/需求变更/补充需求）
3. 意图延续性评分：评估当前对话是否仍在服务原始意图
4. 意图回溯：当检测到意图漂移时，提供回溯到原始意图的路径

设计原则：
- 轻量级：纯规则 + 简单启发式，不依赖 LLM
- 非侵入式：意图追踪失败不阻断对话
- 可解释：每次意图漂移检测都有明确的证据

Usage:
    tracker = IntentTracker()
    tracker.set_initial_intent("帮我修复登录页面的bug")
    drift = tracker.check_drift("顺便看看注册页面")
    if drift.is_drifted:
        logger.info(drift.recommendation)
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("intent_tracker")



class IntentType(str, Enum):
    TASK = "task"
    QUESTION = "question"
    NAVIGATION = "navigation"
    MODIFICATION = "modification"
    FEEDBACK = "feedback"
    SOCIAL = "social"


class DriftSeverity(str, Enum):
    NONE = "none"
    MINOR = "minor"
    MODERATE = "moderate"
    MAJOR = "major"


@dataclass
class Intent:
    text: str
    intent_type: IntentType = IntentType.TASK
    keywords: list[str] = field(default_factory=list)
    entities: list[str] = field(default_factory=list)
    timestamp: float = field(default_factory=time.time)
    confidence: float = 0.5

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "intent_type": self.intent_type.value,
            "keywords": self.keywords,
            "entities": self.entities,
            "timestamp": self.timestamp,
            "confidence": self.confidence,
        }


@dataclass
class DriftResult:
    is_drifted: bool = False
    severity: DriftSeverity = DriftSeverity.NONE
    original_intent: str = ""
    current_intent: str = ""
    continuity_score: float = 1.0
    evidence: list[str] = field(default_factory=list)
    recommendation: str = ""
    should_acknowledge: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "is_drifted": self.is_drifted,
            "severity": self.severity.value,
            "original_intent": self.original_intent,
            "current_intent": self.current_intent,
            "continuity_score": self.continuity_score,
            "evidence": self.evidence,
            "recommendation": self.recommendation,
            "should_acknowledge": self.should_acknowledge,
        }


_TOPIC_SHIFT_PHRASES = {
    "顺便", "对了", "另外", "换个话题", "不说这个了", "算了",
    "还是", "不如", "换个", "等等", "先不", "先做",
    "instead", "by the way", "anyway", "never mind", "let's",
}

_INTERRUPTION_PHRASES = {
    "等一下", "停一下", "先停", "打断一下", "插一句",
    "hold on", "wait", "stop", "actually",
}

_MODIFICATION_PHRASES = {
    "不对", "不是这样", "改一下", "换一种", "我改主意了",
    "算了还是", "不对应该是", "更正",
    "no wait", "actually", "I meant", "let me rephrase",
}


class IntentTracker:
    def __init__(self, max_history: int = 50) -> None:
        self._max_history = max_history
        self._initial_intent: Intent | None = None
        self._intent_history: list[Intent] = []
        self._drift_count: int = 0
        self._last_drift_time: float = 0.0

    def set_initial_intent(self, text: str, intent_type: IntentType = IntentType.TASK) -> Intent:
        keywords = self._extract_keywords(text)
        entities = self._extract_entities(text)
        intent = Intent(
            text=text,
            intent_type=intent_type,
            keywords=keywords,
            entities=entities,
            confidence=1.0,
        )
        self._initial_intent = intent
        self._intent_history.append(intent)
        return intent

    def update_intent(self, text: str, intent_type: IntentType = IntentType.TASK) -> Intent:
        keywords = self._extract_keywords(text)
        entities = self._extract_entities(text)
        intent = Intent(
            text=text,
            intent_type=intent_type,
            keywords=keywords,
            entities=entities,
            confidence=0.7,
        )
        self._intent_history.append(intent)
        if len(self._intent_history) > self._max_history:
            self._intent_history = self._intent_history[-self._max_history:]
        return intent

    def check_drift(self, current_text: str) -> DriftResult:
        if self._initial_intent is None:
            return DriftResult()

        current_intent = self.update_intent(current_text)
        original = self._initial_intent

        continuity = self._compute_continuity(original, current_intent)
        evidence: list[str] = []
        severity = DriftSeverity.NONE

        topic_shift = self._detect_topic_shift(current_text)
        if topic_shift:
            evidence.append(f"检测到话题切换信号: {topic_shift}")

        interruption = self._detect_interruption(current_text)
        if interruption:
            evidence.append(f"检测到中断信号: {interruption}")

        modification = self._detect_modification(current_text)
        if modification:
            evidence.append(f"检测到意图修改信号: {modification}")

        keyword_overlap = self._compute_keyword_overlap(original, current_intent)
        if keyword_overlap < 0.2:
            evidence.append(f"关键词重叠度低: {keyword_overlap:.1%}")

        if continuity < 0.3 or (topic_shift and keyword_overlap < 0.3):
            severity = DriftSeverity.MAJOR
        elif continuity < 0.5 or topic_shift:
            severity = DriftSeverity.MODERATE
        elif continuity < 0.7 or modification:
            severity = DriftSeverity.MINOR

        is_drifted = severity != DriftSeverity.NONE
        recommendation = ""
        should_acknowledge = False

        if severity == DriftSeverity.MAJOR:
            recommendation = "用户意图已大幅偏移，建议确认是否切换到新任务"
            should_acknowledge = True
        elif severity == DriftSeverity.MODERATE:
            recommendation = "用户意图有中等偏移，建议在完成当前任务后处理新需求"
            should_acknowledge = True
        elif severity == DriftSeverity.MINOR:
            recommendation = "用户意图有轻微调整，建议微调当前执行计划"

        if is_drifted:
            self._drift_count += 1
            self._last_drift_time = time.time()

        return DriftResult(
            is_drifted=is_drifted,
            severity=severity,
            original_intent=original.text,
            current_intent=current_intent.text,
            continuity_score=continuity,
            evidence=evidence,
            recommendation=recommendation,
            should_acknowledge=should_acknowledge,
        )

    def get_continuity_score(self) -> float:
        if self._initial_intent is None or not self._intent_history:
            return 1.0
        return self._compute_continuity(self._initial_intent, self._intent_history[-1])

    def get_stats(self) -> dict[str, Any]:
        return {
            "initial_intent": self._initial_intent.text if self._initial_intent else None,
            "intent_count": len(self._intent_history),
            "drift_count": self._drift_count,
            "last_drift_time": self._last_drift_time,
            "continuity_score": self.get_continuity_score(),
        }

    def _compute_continuity(self, original: Intent, current: Intent) -> float:
        keyword_score = self._compute_keyword_overlap(original, current)
        entity_score = self._compute_entity_overlap(original, current)
        type_score = 1.0 if original.intent_type == current.intent_type else 0.5
        return keyword_score * 0.5 + entity_score * 0.3 + type_score * 0.2

    def _compute_keyword_overlap(self, a: Intent, b: Intent) -> float:
        if not a.keywords and not b.keywords:
            return 0.5
        if not a.keywords or not b.keywords:
            return 0.0
        set_a = set(a.keywords)
        set_b = set(b.keywords)
        intersection = set_a & set_b
        union = set_a | set_b
        return len(intersection) / len(union) if union else 0.0

    def _compute_entity_overlap(self, a: Intent, b: Intent) -> float:
        if not a.entities and not b.entities:
            return 0.5
        if not a.entities or not b.entities:
            return 0.0
        set_a = set(a.entities)
        set_b = set(b.entities)
        intersection = set_a & set_b
        union = set_a | set_b
        return len(intersection) / len(union) if union else 0.0

    def _detect_topic_shift(self, text: str) -> str | None:
        text_lower = text.lower()
        for phrase in _TOPIC_SHIFT_PHRASES:
            if phrase in text_lower:
                return phrase
        return None

    def _detect_interruption(self, text: str) -> str | None:
        text_lower = text.lower()
        for phrase in _INTERRUPTION_PHRASES:
            if phrase in text_lower:
                return phrase
        return None

    def _detect_modification(self, text: str) -> str | None:
        text_lower = text.lower()
        for phrase in _MODIFICATION_PHRASES:
            if phrase in text_lower:
                return phrase
        return None

    def _extract_keywords(self, text: str) -> list[str]:
        import re
        words = re.findall(r'[\u4e00-\u9fff]+|[a-zA-Z]{2,}', text)
        stopwords = {
            "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
            "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
            "你", "会", "着", "没有", "看", "好", "自己", "这", "他",
            "the", "a", "an", "is", "are", "was", "were", "be", "been",
            "being", "have", "has", "had", "do", "does", "did", "will",
            "would", "could", "should", "may", "might", "can", "shall",
            "to", "of", "in", "for", "on", "with", "at", "by", "from",
            "it", "this", "that", "i", "me", "my", "we", "our", "you",
        }
        return [w for w in words if w not in stopwords and len(w) >= 2]

    def _extract_entities(self, text: str) -> list[str]:
        import re
        entities: list[str] = []
        quoted = re.findall(r'[""「」『』](.*?)[""「」『』]', text)
        entities.extend(quoted)
        paths = re.findall(r'[a-zA-Z]:\\[\w\\]+|/[\w/]+', text)
        entities.extend(paths)
        code_refs = re.findall(r'\b[A-Z][a-zA-Z]+\.[a-zA-Z]+\b', text)
        entities.extend(code_refs)
        return [e for e in entities if len(e) >= 2]