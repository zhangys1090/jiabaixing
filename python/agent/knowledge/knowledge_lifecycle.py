"""KnowledgeLifecycle — 知识生命周期管理。

整合 KnowledgeStore、KnowledgeExtractor、KnowledgeDecay，
提供完整的知识沉淀、检索、衰减、淘汰闭环。

生命周期：
1. Ingest: 从对话/操作/文档中提取知识
2. Store: 存储并建立向量索引
3. Retrieve: 语义检索相关知识
4. Validate: 通过后续操作验证知识
5. Decay: 时间衰减与访问增强
6. Prune: 淘汰无效知识

Usage:
    from agent.knowledge import KnowledgeLifecycle
    lifecycle = KnowledgeLifecycle()
    await lifecycle.initialize()
    await lifecycle.ingest_dialog(messages, session_id="s1")
    results = await lifecycle.retrieve("agent能力")
    report = await lifecycle.run_maintenance()
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger, log_ignored
from agent.knowledge.knowledge_store import KnowledgeStore, KnowledgeEntry, SearchResult
from agent.knowledge.knowledge_extractor import KnowledgeExtractor, ExtractedKnowledge
from agent.knowledge.knowledge_decay import KnowledgeDecay, DecayConfig, DecayResult
from agent.knowledge.knowledge_graph import KnowledgeGraph

log = StructuredLogger("knowledge_lifecycle")


@dataclass
class MaintenanceReport:
    """知识库维护报告。

    Attributes:
        total_entries: 总条目数。
        ingested: 新增条目数。
        decayed: 衰减条目数。
        pruned: 淘汰条目数。
        boosted: 增强条目数。
        duration_ms: 耗时（毫秒）。
    """

    total_entries: int = 0
    ingested: int = 0
    decayed: int = 0
    pruned: int = 0
    boosted: int = 0
    duration_ms: float = 0.0


class KnowledgeLifecycle:
    """知识生命周期管理器。

    整合知识存储、提取、衰减三大组件，提供一站式知识管理。

    Usage:
        lifecycle = KnowledgeLifecycle()
        await lifecycle.initialize()
        await lifecycle.ingest_dialog(messages)
        results = await lifecycle.retrieve("查询")
    """

    def __init__(
        self,
        db_path: str = "",
        decay_config: DecayConfig | None = None,
        decay_interval_hours: float = 24.0,
    ) -> None:
        self._store = KnowledgeStore(db_path)
        self._extractor = KnowledgeExtractor(self._store)
        self._decay = KnowledgeDecay(self._store, decay_config)
        self._graph = KnowledgeGraph(self._store)
        self._initialized = False
        self._decay_interval_hours = decay_interval_hours
        self._decay_task: asyncio.Task | None = None
        self._decay_running = False

    @property
    def store(self) -> KnowledgeStore:
        return self._store

    @property
    def extractor(self) -> KnowledgeExtractor:
        return self._extractor

    @property
    def decay(self) -> KnowledgeDecay:
        return self._decay

    @property
    def graph(self) -> KnowledgeGraph:
        return self._graph

    async def initialize(self) -> None:
        """初始化知识库。"""
        if self._initialized:
            return
        await self._store.initialize()
        await self._graph.initialize()
        self._initialized = True
        log.info("KnowledgeLifecycle 初始化完成")

    async def close(self) -> None:
        """关闭知识库，停止衰减定时任务。"""
        await self.stop_decay_scheduler()
        await self._graph.close()
        await self._store.close()
        self._initialized = False

    async def start_decay_scheduler(self) -> None:
        """启动知识衰减定时任务。

        后台周期性运行 run_maintenance()，自动衰减过时知识、淘汰无效条目。
        默认每 24 小时运行一次，可通过 decay_interval_hours 配置。
        """
        if self._decay_running:
            return
        self._decay_running = True
        self._decay_task = asyncio.ensure_future(self._decay_loop())
        log.info(
            "知识衰减定时任务已启动",
            interval_hours=self._decay_interval_hours,
        )

    async def stop_decay_scheduler(self) -> None:
        """停止知识衰减定时任务。"""
        self._decay_running = False
        if self._decay_task is not None:
            self._decay_task.cancel()
            try:
                await self._decay_task
            except asyncio.CancelledError as _exc:
                log_ignored(log, "knowledge_lifecycle.stop_decay_scheduler", _exc)
            self._decay_task = None
        log.info("知识衰减定时任务已停止")

    async def _decay_loop(self) -> None:
        """衰减定时循环。"""
        interval_s = self._decay_interval_hours * 3600
        while self._decay_running:
            try:
                await asyncio.sleep(interval_s)
                if not self._decay_running:
                    break
                report = await self.run_maintenance()
                log.info(
                    "定时衰减完成",
                    total=report.total_entries,
                    decayed=report.decayed,
                    pruned=report.pruned,
                    boosted=report.boosted,
                )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.warning("定时衰减异常", error=str(exc))
                await asyncio.sleep(60)

    async def ingest_dialog(
        self,
        messages: list[dict[str, Any]],
        session_id: str = "",
    ) -> list[str]:
        """从对话中提取并存储知识。

        Args:
            messages: 对话消息列表。
            session_id: 会话 ID。

        Returns:
            新增知识 ID 列表。
        """
        self._ensure_initialized()
        return await self._extractor.extract_from_dialog(messages, session_id)

    async def ingest_operation(
        self,
        action: str,
        result: dict[str, Any],
        session_id: str = "",
    ) -> list[str]:
        """从操作结果中提取并存储知识。

        Args:
            action: 操作描述。
            result: 操作结果。
            session_id: 会话 ID。

        Returns:
            新增知识 ID 列表。
        """
        self._ensure_initialized()
        return await self._extractor.extract_from_operation(action, result, session_id)

    async def ingest_document(
        self,
        content: str,
        doc_id: str = "",
        tags: list[str] | None = None,
    ) -> list[str]:
        """从文档中提取并存储知识。

        Args:
            content: 文档内容。
            doc_id: 文档 ID。
            tags: 附加标签。

        Returns:
            新增知识 ID 列表。
        """
        self._ensure_initialized()
        return await self._extractor.extract_from_document(content, doc_id, tags)

    async def add_knowledge(
        self,
        content: str,
        tags: list[str] | None = None,
        source: str = "manual",
        confidence: float = 1.0,
    ) -> str:
        """手动添加知识。

        Args:
            content: 知识内容。
            tags: 标签列表。
            source: 来源。
            confidence: 置信度。

        Returns:
            知识 ID。
        """
        self._ensure_initialized()
        entry_id = await self._store.add(
            content=content,
            tags=tags,
            source=source,
            confidence=confidence,
        )
        try:
            await self._graph.add_entry(entry_id, content)
        except Exception as _exc:
            log.warning("知识图谱实体提取失败", error=str(_exc))
        return entry_id

    async def retrieve(
        self,
        query: str,
        top_k: int = 5,
        tags: list[str] | None = None,
        min_confidence: float = 0.3,
    ) -> list[SearchResult]:
        """检索相关知识。

        Args:
            query: 查询文本。
            top_k: 返回最大数量。
            tags: 过滤标签。
            min_confidence: 最低置信度。

        Returns:
            检索结果列表。
        """
        self._ensure_initialized()
        vector_results = await self._store.search(
            query=query,
            top_k=top_k * 2,
            tags=tags,
            min_confidence=min_confidence,
        )
        try:
            hybrid = await self._graph.hybrid_search(
                query=query,
                vector_results=vector_results,
                top_k=top_k,
            )
            return hybrid if hybrid else vector_results[:top_k]
        except Exception as _exc:
            log.warning("混合检索降级为纯向量检索", error=str(_exc))
            return vector_results[:top_k]

    async def validate_knowledge(self, entry_id: str, verified: bool = True) -> bool:
        """验证知识（增强或降低置信度）。

        Args:
            entry_id: 知识 ID。
            verified: 是否验证通过。

        Returns:
            是否成功。
        """
        self._ensure_initialized()
        if verified:
            return await self._decay.boost_knowledge(entry_id, amount=0.15)
        else:
            return await self._decay.decay_knowledge(entry_id, amount=0.2)

    async def run_maintenance(self) -> MaintenanceReport:
        """运行知识库维护（衰减 + 淘汰）。

        Returns:
            MaintenanceReport: 维护报告。
        """
        self._ensure_initialized()
        start = time.monotonic()

        decay_result = await self._decay.run_decay_cycle()
        total = await self._store.count()

        elapsed = (time.monotonic() - start) * 1000

        report = MaintenanceReport(
            total_entries=total,
            decayed=decay_result.decayed,
            pruned=decay_result.pruned,
            boosted=decay_result.boosted,
            duration_ms=elapsed,
        )

        log.info(
            "知识库维护完成",
            total=total, decayed=report.decayed,
            pruned=report.pruned, duration_ms=elapsed,
        )

        return report

    async def get_stats(self) -> dict[str, Any]:
        """获取知识库统计信息。

        Returns:
            统计信息字典。
        """
        self._ensure_initialized()
        total = await self._store.count()

        dialog_count = await self._store.count(source="dialog")
        operation_count = await self._store.count(source="operation")
        document_count = await self._store.count(source="document")

        graph_stats = await self._graph.get_stats()

        return {
            "total": total,
            "by_source": {
                "dialog": dialog_count,
                "operation": operation_count,
                "document": document_count,
                "manual": total - dialog_count - operation_count - document_count,
            },
            "graph": graph_stats,
            "initialized": self._initialized,
        }

    def _ensure_initialized(self) -> None:
        """确保知识库已初始化。"""
        if not self._initialized:
            raise RuntimeError("KnowledgeLifecycle 未初始化，请先调用 initialize()")

    async def export_session_knowledge(
        self,
        session_id: str,
        tags: list[str] | None = None,
        min_confidence: float = 0.5,
        source: str = "",
    ) -> list[dict[str, Any]]:
        """W4-3: 导出指定会话的知识，用于跨会话迁移。

        从知识库中检索属于指定会话的所有知识条目，
        序列化为可传输的字典列表，供新会话导入使用。

        Args:
            session_id: 源会话 ID。
            tags: 过滤标签，None 则不过滤。
            min_confidence: 最低置信度阈值。
            source: 过滤来源类型，空字符串则不过滤来源。

        Returns:
            可序列化的知识条目列表。
        """
        self._ensure_initialized()
        all_entries = await self._store.list_entries(
            source=source,
            tags=tags,
            limit=500,
        )
        session_entries = [
            e for e in all_entries
            if e.source_id == session_id
            and e.confidence >= min_confidence
        ]
        exported: list[dict[str, Any]] = []
        for entry in session_entries:
            exported.append({
                "id": entry.id,
                "content": entry.content,
                "tags": list(entry.tags),
                "source": entry.source,
                "source_id": entry.source_id,
                "confidence": entry.confidence,
                "created_at": entry.created_at,
                "access_count": entry.access_count,
            })
        log.info(
            "W4-3: 导出会话知识",
            session_id=session_id,
            exported_count=len(exported),
        )
        return exported

    async def import_session_knowledge(
        self,
        knowledge_items: list[dict[str, Any]],
        target_session_id: str = "",
        confidence_adjustment: float = -0.1,
    ) -> list[str]:
        """W4-3: 导入知识到当前会话，实现跨会话迁移。

        将从其他会话导出的知识条目导入到当前知识库，
        自动调整置信度（迁移知识默认降低 0.1），
        并建立图谱关联。

        Args:
            knowledge_items: 导出的知识条目列表。
            target_session_id: 目标会话 ID。
            confidence_adjustment: 置信度调整值（负值降低，正值提高）。

        Returns:
            新增知识 ID 列表。
        """
        self._ensure_initialized()
        imported_ids: list[str] = []
        for item in knowledge_items:
            content = item.get("content", "")
            if not content:
                continue
            tags = item.get("tags", [])
            if target_session_id and "migrated" not in tags:
                tags = list(tags) + ["migrated", f"from_session:{item.get('id', 'unknown')[:8]}"]
            confidence = max(0.1, min(1.0, item.get("confidence", 0.5) + confidence_adjustment))
            entry_id = await self._store.add(
                content=content,
                tags=tags,
                source="migration",
                source_id=target_session_id,
                confidence=confidence,
            )
            try:
                await self._graph.add_entry(entry_id, content)
            except Exception as _exc:
                log_ignored(log, "knowledge_lifecycle.import_session_knowledge.graph", _exc)
            imported_ids.append(entry_id)
        log.info(
            "W4-3: 导入会话知识",
            target_session_id=target_session_id,
            imported_count=len(imported_ids),
            total_items=len(knowledge_items),
        )
        return imported_ids

    async def transfer_knowledge(
        self,
        source_session_id: str,
        target_session_id: str,
        tags: list[str] | None = None,
        min_confidence: float = 0.5,
        source: str = "",
    ) -> list[str]:
        """W4-3: 一站式跨会话知识迁移。

        从源会话导出知识并导入到目标会话，
        自动调整置信度并标记迁移来源。

        Args:
            source_session_id: 源会话 ID。
            target_session_id: 目标会话 ID。
            tags: 过滤标签。
            min_confidence: 最低置信度。
            source: 过滤来源类型，空字符串则不过滤。

        Returns:
            迁移的知识 ID 列表。
        """
        exported = await self.export_session_knowledge(
            session_id=source_session_id,
            tags=tags,
            min_confidence=min_confidence,
            source=source,
        )
        if not exported:
            return []
        return await self.import_session_knowledge(
            knowledge_items=exported,
            target_session_id=target_session_id,
        )

    async def get_relevant_knowledge_for_session(
        self,
        query: str,
        session_id: str = "",
        top_k: int = 5,
        include_migrated: bool = True,
    ) -> list[SearchResult]:
        """W4-3: 获取与会话相关的跨会话知识。

        在新会话开始时，根据用户输入检索所有相关历史知识，
        包括从其他会话迁移过来的知识。

        Args:
            query: 查询文本。
            session_id: 当前会话 ID。
            top_k: 返回最大数量。
            include_migrated: 是否包含迁移的知识。

        Returns:
            检索结果列表。
        """
        self._ensure_initialized()
        results = await self.retrieve(query=query, top_k=top_k)
        if not include_migrated:
            results = [
                r for r in results
                if "migrated" not in r.entry.tags
            ]
        return results
