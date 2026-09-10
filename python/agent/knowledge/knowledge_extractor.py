"""KnowledgeExtractor — 从对话与操作中提取知识。

分析 LLM 对话和工具操作结果，自动提取有价值的事实、
偏好、模式等知识，存入知识库。

提取类型：
- fact: 事实性知识（用户偏好、系统配置等）
- pattern: 操作模式（常用工作流、快捷操作等）
- correction: 纠正性知识（操作失败后的修正）
- insight: 洞察性知识（从多次操作中总结的规律）

Usage:
    from agent.knowledge.knowledge_extractor import KnowledgeExtractor
    extractor = KnowledgeExtractor(store)
    await extractor.extract_from_dialog(messages)
    await extractor.extract_from_operation(action, result)
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from agent.knowledge.knowledge_store import KnowledgeStore
from agent.core.logger import StructuredLogger

log = StructuredLogger("knowledge_extractor")



@dataclass
class ExtractedKnowledge:
    """提取的知识。

    Attributes:
        content: 知识内容。
        knowledge_type: 知识类型（fact/pattern/correction/insight）。
        confidence: 置信度。
        tags: 标签列表。
        source_id: 来源标识。
    """

    content: str = ""
    knowledge_type: str = "fact"
    confidence: float = 0.5
    tags: list[str] = field(default_factory=list)
    source_id: str = ""


class KnowledgeExtractor:
    """知识提取器。

    从对话和操作中自动提取知识，支持：
    1. 对话提取：分析用户指令和 LLM 回复
    2. 操作提取：分析工具调用结果
    3. 纠正提取：从失败操作中学习
    4. 模式提取：从重复操作中发现模式

    Usage:
        extractor = KnowledgeExtractor(store)
        await extractor.extract_from_dialog(messages)
    """

    FACT_PATTERNS = [
        (r"我(?:喜欢|偏好|习惯)(.+?)(?:[，。,.]|$)", "preference"),
        (r"(?:总是|每次|一般)(?:都)?(.+?)(?:[，。,.]|$)", "habit"),
        (r"(?:不要|别|禁止)(.+?)(?:[，。,.]|$)", "avoidance"),
        (r"(?:默认|缺省)(?:配置|设置)(?:是)?(.+?)(?:[，。,.]|$)", "default"),
        (r"项目(?:使用|采用|基于)(.+?)(?:[，。,.]|$)", "tech_stack"),
    ]

    CORRECTION_PATTERNS = [
        r"(?:不对|错了|不是)(.+?)(?:[，。,.]|$)",
        r"(?:应该|需要|必须)(?:改成|改为|修改为)(.+?)(?:[，。,.]|$)",
        r"(?:正确的是|实际上是)(.+?)(?:[，。,.]|$)",
    ]

    def __init__(self, store: KnowledgeStore) -> None:
        self._store = store
        self._operation_history: list[dict[str, Any]] = []
        self._pattern_window_size: int = 10

    async def extract_from_dialog(
        self,
        messages: list[dict[str, Any]],
        session_id: str = "",
    ) -> list[str]:
        """从对话中提取知识。

        Args:
            messages: 对话消息列表。
            session_id: 会话 ID。

        Returns:
            提取的知识 ID 列表。
        """
        extracted: list[ExtractedKnowledge] = []

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            if role == "user":
                extracted.extend(self._extract_facts(content, session_id))
                extracted.extend(self._extract_corrections(content, session_id))

            elif role == "assistant":
                extracted.extend(self._extract_insights(content, session_id))

        ids: list[str] = []
        for k in extracted:
            try:
                kid = await self._store.add(
                    content=k.content,
                    tags=k.tags + [k.knowledge_type],
                    source="dialog",
                    source_id=k.source_id,
                    confidence=k.confidence,
                )
                ids.append(kid)
            except Exception as e:
                log.warning("知识存储失败", error=str(e))

        if ids:
            log.info("对话知识提取", count=len(ids), session=session_id[:8])

        return ids

    async def extract_from_operation(
        self,
        action: str,
        result: dict[str, Any],
        session_id: str = "",
    ) -> list[str]:
        """从操作结果中提取知识。

        Args:
            action: 操作描述。
            result: 操作结果。
            session_id: 会话 ID。

        Returns:
            提取的知识 ID 列表。
        """
        self._operation_history.append({
            "action": action,
            "result": result,
            "timestamp": time.time(),
        })

        extracted: list[ExtractedKnowledge] = []
        success = result.get("success", False)

        if not success:
            error = result.get("error", "")
            extracted.append(ExtractedKnowledge(
                content=f"操作失败: {action} -> {error}",
                knowledge_type="correction",
                confidence=0.8,
                tags=["failure", "correction"],
                source_id=session_id,
            ))

        extracted.extend(self._extract_patterns(session_id))

        ids: list[str] = []
        for k in extracted:
            try:
                kid = await self._store.add(
                    content=k.content,
                    tags=k.tags + [k.knowledge_type],
                    source="operation",
                    source_id=k.source_id,
                    confidence=k.confidence,
                )
                ids.append(kid)
            except Exception as e:
                log.warning("知识存储失败", error=str(e))

        return ids

    async def extract_from_document(
        self,
        content: str,
        doc_id: str = "",
        tags: list[str] | None = None,
    ) -> list[str]:
        """从文档中提取知识。

        Args:
            content: 文档内容。
            doc_id: 文档 ID。
            tags: 附加标签。

        Returns:
            提取的知识 ID 列表。
        """
        chunks = self._chunk_document(content)
        ids: list[str] = []

        for chunk in chunks:
            try:
                kid = await self._store.add(
                    content=chunk,
                    tags=(tags or []) + ["document"],
                    source="document",
                    source_id=doc_id,
                    confidence=0.9,
                )
                ids.append(kid)
            except Exception as e:
                log.warning("文档知识存储失败", error=str(e))

        if ids:
            log.info("文档知识提取", chunks=len(ids), doc=doc_id[:8])

        return ids

    def _extract_facts(self, content: str, source_id: str) -> list[ExtractedKnowledge]:
        """从用户输入中提取事实性知识。"""
        results: list[ExtractedKnowledge] = []

        for pattern, tag in self.FACT_PATTERNS:
            matches = re.findall(pattern, content)
            for match in matches:
                match = match.strip()
                if len(match) > 2:
                    results.append(ExtractedKnowledge(
                        content=match,
                        knowledge_type="fact",
                        confidence=0.7,
                        tags=["fact", tag],
                        source_id=source_id,
                    ))

        return results

    def _extract_corrections(self, content: str, source_id: str) -> list[ExtractedKnowledge]:
        """从用户输入中提取纠正性知识。"""
        results: list[ExtractedKnowledge] = []

        for pattern in self.CORRECTION_PATTERNS:
            matches = re.findall(pattern, content)
            for match in matches:
                match = match.strip()
                if len(match) > 2:
                    results.append(ExtractedKnowledge(
                        content=match,
                        knowledge_type="correction",
                        confidence=0.9,
                        tags=["correction"],
                        source_id=source_id,
                    ))

        return results

    def _extract_insights(self, content: str, source_id: str) -> list[ExtractedKnowledge]:
        """从 LLM 回复中提取洞察性知识。"""
        results: list[ExtractedKnowledge] = []

        insight_patterns = [
            r"(?:总结|结论|要点)[:：]\s*(.+?)(?:\n|$)",
            r"(?:建议|推荐)[:：]\s*(.+?)(?:\n|$)",
            r"(?:注意|重要)[:：]\s*(.+?)(?:\n|$)",
        ]

        for pattern in insight_patterns:
            matches = re.findall(pattern, content)
            for match in matches:
                match = match.strip()
                if len(match) > 5:
                    results.append(ExtractedKnowledge(
                        content=match,
                        knowledge_type="insight",
                        confidence=0.6,
                        tags=["insight"],
                        source_id=source_id,
                    ))

        return results

    def _extract_patterns(self, source_id: str) -> list[ExtractedKnowledge]:
        """从操作历史中提取模式知识。"""
        results: list[ExtractedKnowledge] = []

        if len(self._operation_history) < 3:
            return results

        recent = self._operation_history[-self._pattern_window_size:]
        action_counts: dict[str, int] = {}

        for op in recent:
            action = op["action"]
            action_type = action.split()[0] if action else ""
            if action_type:
                action_counts[action_type] = action_counts.get(action_type, 0) + 1

        for action_type, count in action_counts.items():
            if count >= 3:
                results.append(ExtractedKnowledge(
                    content=f"频繁操作模式: {action_type} (近期执行{count}次)",
                    knowledge_type="pattern",
                    confidence=0.5 + min(count / 10, 0.4),
                    tags=["pattern", action_type],
                    source_id=source_id,
                ))

        return results

    def _chunk_document(self, content: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
        """将文档分块。

        Args:
            content: 文档内容。
            chunk_size: 块大小（字符数）。
            overlap: 重叠大小。

        Returns:
            文本块列表。
        """
        if len(content) <= chunk_size:
            return [content]

        chunks: list[str] = []
        start = 0
        while start < len(content):
            end = start + chunk_size
            chunk = content[start:end]
            if end < len(content):
                last_period = chunk.rfind("。")
                last_newline = chunk.rfind("\n")
                split_at = max(last_period, last_newline)
                if split_at > start + chunk_size // 2:
                    chunk = content[start:split_at + 1]
                    end = split_at + 1
            chunks.append(chunk.strip())
            start = end - overlap

        return [c for c in chunks if c]
