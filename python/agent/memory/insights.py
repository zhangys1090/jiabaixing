"""记忆洞察提取器。

自动从用户交互中提炼偏好、模式、关键事实：
  - 偏好提取（语言/风格/格式偏好）
  - 模式识别（常见问题/工作流模式）
  - 关键事实提取（姓名/角色/项目/技术栈）
  - 洞察合并与去重
  - 置信度评分
  - 洞察老化与更新

与 MemoryManager 的关系：
  - MemoryManager 管理记忆存储
  - Insights 从记忆中提炼洞察
  - 洞察写回 MemoryManager 作为 LTM

集成示例::

    from agent.memory.insights import InsightExtractor

    extractor = InsightExtractor()
    insights = await extractor.extract("user_1", messages)
    for insight in insights:
        print(f"{insight.category}: {insight.content} (conf={insight.confidence})")
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("insights")


class InsightCategory(str, Enum):
    """洞察分类。"""

    PREFERENCE = "preference"
    PATTERN = "pattern"
    FACT = "fact"
    SKILL = "skill"
    CONTEXT = "context"
    BEHAVIOR = "behavior"


@dataclass
class Insight:
    """洞察条目。

    Attributes:
        id: 洞察 ID。
        category: 分类。
        content: 内容。
        confidence: 置信度（0-1）。
        source: 来源描述。
        tags: 标签。
        created_at: 创建时间。
        updated_at: 更新时间。
        evidence_count: 证据数量。
        metadata: 附加元数据。
    """

    id: str = ""
    category: InsightCategory = InsightCategory.FACT
    content: str = ""
    confidence: float = 0.5
    source: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0
    evidence_count: int = 1
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        now = time.time()
        if self.created_at == 0.0:
            self.created_at = now
        if self.updated_at == 0.0:
            self.updated_at = now


PREFERENCE_PATTERNS: list[tuple[str, str, float]] = [
    (r"我(?:喜欢|偏好|更倾向|习惯用|prefer|like to use)\s+(.+?)(?:[。，,.]|$)", "preference_lang_tool", 0.7),
    (r"请(?:用|使用|以)\s*(.+?)(?:格式|风格|方式|format|style)", "preference_format", 0.8),
    (r"不要(?:用|使用|以)\s*(.+?)(?:[。，,.]|$)", "preference_avoid", 0.7),
    (r"回答(?:用|使用)\s*(中文|英文|日文|简体|繁体)", "preference_language", 0.9),
]

FACT_PATTERNS: list[tuple[str, str, float]] = [
    (r"我(?:叫|是|名叫|name is)\s+(\S+)", "fact_name", 0.8),
    (r"我(?:在|就职于|work at)\s+(.+?)(?:[。，,.]|$)", "fact_organization", 0.7),
    (r"我(?:的|my)\s*(角色|职位|role|position|title)\s*(?:是|is)\s*(.+?)(?:[。，,.]|$)", "fact_role", 0.7),
    (r"项目(?:名|名称|叫)\s*(?:是|is)?\s*(.+?)(?:[。，,.]|$)", "fact_project", 0.6),
    (r"(?:技术栈|tech stack|技术选型)\s*(?:是|:|：)\s*(.+?)(?:[。，,.]|$)", "fact_tech_stack", 0.6),
]

PATTERN_PATTERNS: list[tuple[str, str, float]] = [
    (r"经常|总是|always|usually|typically", "pattern_frequency", 0.5),
    (r"每次|every time|whenever", "pattern_condition", 0.6),
]


class InsightExtractor:
    """记忆洞察提取器。

    从用户交互中自动提炼偏好、模式、关键事实。
    """

    def __init__(self, min_confidence: float = 0.5) -> None:
        self._min_confidence = min_confidence
        self._insights: dict[str, Insight] = {}
        self._next_id = 1

    async def extract(
        self,
        user_id: str,
        messages: list[dict[str, Any]],
    ) -> list[Insight]:
        """从消息中提取洞察。

        Args:
            user_id: 用户 ID。
            messages: 消息列表。

        Returns:
            新提取的洞察列表。
        """
        new_insights: list[Insight] = []

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role != "user" or not content:
                continue

            for pattern_str, insight_name, base_conf in PREFERENCE_PATTERNS:
                matches = self._safe_findall(pattern_str, content)
                for match_text in matches:
                    insight = self._create_or_update(
                        user_id=user_id,
                        category=InsightCategory.PREFERENCE,
                        content=f"偏好: {match_text.strip()}",
                        confidence=base_conf,
                        source=insight_name,
                    )
                    if insight:
                        new_insights.append(insight)

            for pattern_str, insight_name, base_conf in FACT_PATTERNS:
                matches = self._safe_findall(pattern_str, content)
                for match_text in matches:
                    insight = self._create_or_update(
                        user_id=user_id,
                        category=InsightCategory.FACT,
                        content=f"事实: {match_text.strip()}",
                        confidence=base_conf,
                        source=insight_name,
                    )
                    if insight:
                        new_insights.append(insight)

            for pattern_str, insight_name, base_conf in PATTERN_PATTERNS:
                if self._safe_search(pattern_str, content):
                    insight = self._create_or_update(
                        user_id=user_id,
                        category=InsightCategory.PATTERN,
                        content=f"模式: {content[:80].strip()}",
                        confidence=base_conf,
                        source=insight_name,
                    )
                    if insight:
                        new_insights.append(insight)

        log.info("Insights extracted", user=user_id, count=len(new_insights))
        return new_insights

    async def get_insights(
        self,
        user_id: str,
        category: InsightCategory | None = None,
        min_confidence: float | None = None,
    ) -> list[Insight]:
        """获取用户的洞察。"""
        threshold = min_confidence or self._min_confidence
        results = [
            i for i in self._insights.values()
            if i.metadata.get("user_id") == user_id
            and i.confidence >= threshold
        ]
        if category:
            results = [i for i in results if i.category == category]
        results.sort(key=lambda i: i.confidence, reverse=True)
        return results

    async def merge_insights(self, user_id: str, new_insights: list[Insight]) -> list[Insight]:
        """合并洞察（去重+置信度提升）。"""
        merged: list[Insight] = []
        for ni in new_insights:
            existing = self._find_similar(ni)
            if existing:
                existing.confidence = min(1.0, existing.confidence + 0.1)
                existing.evidence_count += 1
                existing.updated_at = time.time()
                merged.append(existing)
            else:
                key = f"{user_id}_{ni.id}"
                self._insights[key] = ni
                merged.append(ni)
        return merged

    def _create_or_update(
        self,
        user_id: str,
        category: InsightCategory,
        content: str,
        confidence: float,
        source: str,
    ) -> Insight | None:
        """创建或更新洞察。"""
        content_key = f"{category.value}:{content}"
        full_key = f"{user_id}_{content_key}"

        if full_key in self._insights:
            existing = self._insights[full_key]
            existing.confidence = min(1.0, existing.confidence + 0.1)
            existing.evidence_count += 1
            existing.updated_at = time.time()
            return existing

        insight_id = f"ins_{self._next_id}"
        self._next_id += 1

        insight = Insight(
            id=insight_id,
            category=category,
            content=content,
            confidence=confidence,
            source=source,
            metadata={"user_id": user_id},
        )
        self._insights[full_key] = insight
        return insight

    def _find_similar(self, insight: Insight) -> Insight | None:
        """查找相似洞察。"""
        for existing in self._insights.values():
            if existing.category == insight.category and existing.content == insight.content:
                return existing
        return None

    def _safe_findall(self, pattern: str, text: str) -> list[str]:
        """安全正则查找。"""
        try:
            return re.findall(pattern, text)
        except re.error:
            return []

    def _safe_search(self, pattern: str, text: str) -> bool:
        """安全正则搜索。"""
        try:
            return bool(re.search(pattern, text))
        except re.error:
            return False
