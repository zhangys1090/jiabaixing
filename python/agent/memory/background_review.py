"""后台记忆审查器。

自动审查和清理记忆存储：
  - 过时记忆检测与标记
  - 重复记忆合并
  - 低质量记忆清理
  - 记忆重要性重评估
  - 审查计划与调度
  - 审查报告生成

与 MemoryManager 的关系：
  - MemoryManager 管理记忆 CRUD
  - BackgroundReview 定期审查记忆质量
  - 审查结果反馈到 MemoryManager

集成示例::

    from agent.memory.background_review import BackgroundReview

    reviewer = BackgroundReview()
    report = await reviewer.review("user_1")
    print(report.summary)  # "审查 50 条记忆：合并 3 条重复，清理 5 条过时"
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine
from agent.core.logger import StructuredLogger

log = StructuredLogger("background_review")




class ReviewAction(str, Enum):
    """审查动作。"""

    KEEP = "keep"
    MERGE = "merge"
    ARCHIVE = "archive"
    DELETE = "delete"
    REASSESS = "reassess"


class ReviewReason(str, Enum):
    """审查原因。"""

    STALE = "stale"
    DUPLICATE = "duplicate"
    LOW_QUALITY = "low_quality"
    LOW_IMPORTANCE = "low_importance"
    CONFLICTING = "conflicting"
    EXPIRED = "expired"
    MANUAL = "manual"


@dataclass
class ReviewEntry:
    """审查条目。

    Attributes:
        item_id: 记忆条目 ID。
        action: 审查动作。
        reason: 审查原因。
        confidence: 审查置信度。
        details: 详细信息。
    """

    item_id: str = ""
    action: ReviewAction = ReviewAction.KEEP
    reason: ReviewReason = ReviewReason.STALE
    confidence: float = 0.0
    details: str = ""


@dataclass
class ReviewReport:
    """审查报告。

    Attributes:
        user_id: 用户 ID。
        total_reviewed: 审查总数。
        kept: 保留数。
        merged: 合并数。
        archived: 归档数。
        deleted: 删除数。
        reassessed: 重评数。
        entries: 审查条目列表。
        started_at: 开始时间。
        completed_at: 完成时间。
    """

    user_id: str = ""
    total_reviewed: int = 0
    kept: int = 0
    merged: int = 0
    archived: int = 0
    deleted: int = 0
    reassessed: int = 0
    entries: list[ReviewEntry] = field(default_factory=list)
    started_at: float = 0.0
    completed_at: float = 0.0

    @property
    def summary(self) -> str:
        parts = [f"审查 {self.total_reviewed} 条记忆"]
        actions: list[str] = []
        if self.merged:
            actions.append(f"合并 {self.merged} 条重复")
        if self.archived:
            actions.append(f"归档 {self.archived} 条过时")
        if self.deleted:
            actions.append(f"清理 {self.deleted} 条低质")
        if self.reassessed:
            actions.append(f"重评 {self.reassessed} 条重要性")
        if actions:
            parts.append("：" + "，".join(actions))
        return "".join(parts)

    @property
    def duration(self) -> float:
        if self.started_at > 0 and self.completed_at > 0:
            return self.completed_at - self.started_at
        return 0.0


@dataclass
class ReviewConfig:
    """审查配置。

    Attributes:
        stale_threshold_days: 过时阈值（天）。
        min_importance: 最小重要性。
        duplicate_similarity: 重复相似度阈值。
        max_age_days: 最大年龄（天）。
        auto_apply: 是否自动应用审查结果。
    """

    stale_threshold_days: float = 30.0
    min_importance: float = 0.1
    duplicate_similarity: float = 0.85
    max_age_days: float = 90.0
    auto_apply: bool = False


class BackgroundReview:
    """后台记忆审查器。

    自动审查和清理记忆存储。
    """

    def __init__(self, config: ReviewConfig | None = None) -> None:
        self._config = config or ReviewConfig()
        self._reports: list[ReviewReport] = []
        self._on_action: Callable[..., Coroutine[Any, Any, None]] | None = None
        self._MAX_REPORTS = 100

    @property
    def config(self) -> ReviewConfig:
        return self._config

    def on_action(self, callback: Callable[..., Coroutine[Any, Any, None]]) -> None:
        """设置审查动作回调。"""
        self._on_action = callback

    async def review(
        self,
        user_id: str,
        memories: list[dict[str, Any]] | None = None,
        memory_manager: Any = None,
    ) -> ReviewReport:
        """执行记忆审查。

        Args:
            user_id: 用户 ID。
            memories: 待审查的记忆列表（None 从 MemoryManager 获取）。
            memory_manager: MemoryManager 实例，用于在 memories=None 时获取记忆。

        Returns:
            ReviewReport 审查报告。
        """
        report = ReviewReport(user_id=user_id, started_at=time.time())

        items = memories
        if items is None and memory_manager is not None:
            try:
                result = await memory_manager.retrieve(user_id, limit=500)
                items = [
                    {
                        "id": m.id,
                        "content": m.content,
                        "created_at": m.created_at,
                        "accessed_at": m.accessed_at,
                        "importance": m.importance,
                        "decay_factor": m.decay_factor,
                    }
                    for m in result.items
                ]
            except Exception as e:
                log.warning("Failed to fetch memories from MemoryManager", error=str(e))
                items = []
        if items is None:
            items = []
        report.total_reviewed = len(items)

        now = time.time()
        stale_threshold = self._config.stale_threshold_days * 86400
        max_age = self._config.max_age_days * 86400

        for item in items:
            item_id = item.get("id", "")
            created_at = item.get("created_at", now)
            importance = item.get("importance", 0.5)
            decay = item.get("decay_factor", 1.0)
            content = item.get("content", "")
            accessed_at = item.get("accessed_at", created_at)

            age = now - created_at
            time_since_access = now - accessed_at

            if age > max_age and importance < self._config.min_importance:
                entry = ReviewEntry(
                    item_id=item_id,
                    action=ReviewAction.DELETE,
                    reason=ReviewReason.EXPIRED,
                    confidence=0.9,
                    details=f"超过最大年龄 {self._config.max_age_days} 天且重要性低",
                )
                report.deleted += 1

            elif time_since_access > stale_threshold and decay < 0.3:
                entry = ReviewEntry(
                    item_id=item_id,
                    action=ReviewAction.ARCHIVE,
                    reason=ReviewReason.STALE,
                    confidence=0.8,
                    details=f"超过 {self._config.stale_threshold_days} 天未访问且衰减严重",
                )
                report.archived += 1

            elif importance < self._config.min_importance and decay < 0.2:
                entry = ReviewEntry(
                    item_id=item_id,
                    action=ReviewAction.DELETE,
                    reason=ReviewReason.LOW_QUALITY,
                    confidence=0.7,
                    details="重要性低且衰减严重",
                )
                report.deleted += 1

            elif decay < 0.5 and importance > 0.3:
                entry = ReviewEntry(
                    item_id=item_id,
                    action=ReviewAction.REASSESS,
                    reason=ReviewReason.LOW_IMPORTANCE,
                    confidence=0.6,
                    details="重要性可能需要重评估",
                )
                report.reassessed += 1

            else:
                entry = ReviewEntry(
                    item_id=item_id,
                    action=ReviewAction.KEEP,
                    confidence=1.0,
                )
                report.kept += 1

            report.entries.append(entry)

            if self._on_action and entry.action != ReviewAction.KEEP:
                try:
                    await self._on_action(entry)
                except Exception as e:
                    log.warning("Review action callback failed", error=str(e))

        duplicates = self._find_duplicates(items)
        for dup_group in duplicates:
            if len(dup_group) > 1:
                keep_id = dup_group[0]
                for merge_id in dup_group[1:]:
                    entry = ReviewEntry(
                        item_id=merge_id,
                        action=ReviewAction.MERGE,
                        reason=ReviewReason.DUPLICATE,
                        confidence=0.85,
                        details=f"与 {keep_id} 重复",
                    )
                    report.entries.append(entry)
                    report.merged += 1

        report.completed_at = time.time()
        self._reports.append(report)
        if len(self._reports) > self._MAX_REPORTS:
            self._reports = self._reports[-(self._MAX_REPORTS * 3 // 4):]

        log.info(
            "Memory review completed",
            user=user_id,
            total=report.total_reviewed,
            kept=report.kept,
            merged=report.merged,
            archived=report.archived,
            deleted=report.deleted,
        )

        return report

    def get_reports(self, limit: int = 10) -> list[ReviewReport]:
        """获取审查报告。"""
        return self._reports[-limit:]

    def _find_duplicates(self, items: list[dict[str, Any]]) -> list[list[str]]:
        """查找重复记忆。"""
        content_map: dict[str, list[str]] = {}
        for item in items:
            content = item.get("content", "").strip().lower()
            item_id = item.get("id", "")
            if len(content) < 10:
                continue
            key = content[:50]
            content_map.setdefault(key, []).append(item_id)

        return [ids for ids in content_map.values() if len(ids) > 1]
