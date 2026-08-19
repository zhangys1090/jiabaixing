from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.knowledge.knowledge_extractor import KnowledgeExtractor
from agent.knowledge.knowledge_lifecycle import KnowledgeLifecycle
from agent.knowledge.knowledge_store import KnowledgeStore

log = StructuredLogger("failure_learner")


@dataclass
class FailureLearningRecord:
    """一次失败学习的产出。"""

    action: str
    error: str
    knowledge_ids: list[str] = field(default_factory=list)
    lesson: str = ""
    timestamp: float = 0.0
    signature: str = ""


class FailureLearner:
    """主动从失败学习闭环。

    闭环路径：
      失败事件（工具异常 / 验证未通过 / 计划回滚）
        → 捕获失败上下文（动作、错误、评价分析）
        → KnowledgeExtractor 抽取为「纠正知识」并写入知识库
        → 后续规划可通过 ``build_injection_prompt`` 主动注入历史失败经验，
          避免重蹈覆辙。

    依赖既有组件（KnowledgeLifecycle / KnowledgeExtractor / KnowledgeStore），
    不重复实现记忆/知识写入逻辑。核心缺失在于：既有 ``ingest_operation``
    写入能力存在，但主循环失败时从未调用它——本类补全这一闭环接线。
    """

    def __init__(
        self,
        knowledge_lifecycle: KnowledgeLifecycle | None = None,
        extractor: KnowledgeExtractor | None = None,
        store: KnowledgeStore | None = None,
        session_id: str = "default",
    ) -> None:
        self._lifecycle = knowledge_lifecycle
        self._store = store or (knowledge_lifecycle.store if knowledge_lifecycle else None)
        self._extractor = extractor or (knowledge_lifecycle.extractor if knowledge_lifecycle else None)
        self._session_id = session_id
        if self._lifecycle is None and self._extractor is None:
            raise ValueError("FailureLearner 需要 knowledge_lifecycle 或 extractor 之一")

        # 「同错重复率」指标状态：按错误签名聚合出现次数。
        self._error_counts: dict[str, int] = {}
        self._total_failures: int = 0
        self._unique_signatures: set[str] = set()

    async def learn_from_failure(
        self,
        action: str,
        error: str,
        *,
        task: str = "",
        evaluation: Any | None = None,
        session_id: str | None = None,
    ) -> FailureLearningRecord:
        """从一次失败中沉淀纠正知识，返回学习记录。

        Args:
            action: 失败动作（工具名或动作描述）。
            error: 失败原因/错误信息。
            task: 关联的原始任务（用于上下文）。
            evaluation: 可选的评价产出，携带 failure_analysis / suggested_correction。
            session_id: 会话 ID。
        """
        sid = session_id or self._session_id
        signature = self._signature(action, error)
        self._error_counts[signature] = self._error_counts.get(signature, 0) + 1
        self._total_failures += 1
        self._unique_signatures.add(signature)
        result: dict[str, Any] = {"success": False, "error": error}
        if evaluation is not None:
            analysis = getattr(evaluation, "failure_analysis", None)
            suggested = getattr(evaluation, "suggested_correction", None)
            if analysis:
                result["failure_analysis"] = analysis
            if suggested:
                result["suggested_correction"] = suggested

        knowledge_ids: list[str] = []
        if self._lifecycle is not None:
            ids = await self._lifecycle.ingest_operation(action, result, session_id=sid)
            knowledge_ids = list(ids) if ids else []
        elif self._extractor is not None:
            knowledge_ids = await self._extractor.extract_from_operation(action, result, session_id=sid)

        lesson = self._build_lesson(action, error, knowledge_ids)
        log.info("失败经验已沉淀", action=action, knowledge_ids=knowledge_ids)
        return FailureLearningRecord(
            action=action,
            error=error,
            knowledge_ids=knowledge_ids,
            lesson=lesson,
            timestamp=time.time(),
            signature=signature,
        )

    async def build_injection_prompt(self, task: str, top_k: int = 3) -> str:
        """为后续规划主动注入历史失败经验。

        返回空串表示无相关经验（不打扰规划）。
        """
        if self._store is None or not task:
            return ""
        try:
            results = await self._store.search(task, top_k=top_k)
        except Exception as exc:
            log.warning("失败经验检索失败", error=str(exc))
            return ""
        lines: list[str] = []
        for item in results:
            entry = getattr(item, "entry", None)
            content = getattr(entry, "content", None) or getattr(item, "content", None) or ""
            if content:
                lines.append(f"- {content}")
        if not lines:
            return ""
        return "【历史失败经验，请主动规避】\n" + "\n".join(lines[:top_k])

    @staticmethod
    def _build_lesson(action: str, error: str, ids: list[str]) -> str:
        if ids:
            return (
                f"已沉淀纠正知识[{', '.join(ids)}]：执行「{action}」曾失败（{error}），"
                "后续规划应规避同类错误。"
            )
        return f"执行「{action}」失败（{error}），但未能写入知识库，建议人工复盘。"

    @staticmethod
    def _signature(action: str, error: str) -> str:
        """从动作 + 错误首行提炼稳定签名，用于聚合「同错」。

        仅取错误文本首行前 80 字符，避免堆栈噪声导致同一根因被识别为不同错误。
        """
        first_line = error.strip().splitlines()[0][:80] if error.strip() else "unknown"
        return f"{action}::{first_line}"

    def recurrence_rate(self) -> float:
        """同错重复率 = (总失败数 - 唯一签名数) / 总失败数。

        返回 0.0 表示无重复（每次失败都是新错误）；越接近 1.0 表示反复
        踩同一个坑——主动学习闭环应显著降低该指标。
        """
        if self._total_failures == 0:
            return 0.0
        repeated = self._total_failures - len(self._unique_signatures)
        return repeated / self._total_failures

    def error_signature_counts(self) -> dict[str, int]:
        """返回各错误签名的出现次数（用于定位最高频失败根因）。"""
        return dict(self._error_counts)

    def get_metrics(self) -> dict[str, Any]:
        """主动学习效率指标快照。"""
        repeated = self._total_failures - len(self._unique_signatures)
        top: list[tuple[str, int]] = sorted(
            self._error_counts.items(), key=lambda x: -x[1]
        )[:5]
        return {
            "total_failures": self._total_failures,
            "unique_signatures": len(self._unique_signatures),
            "repeated_failures": repeated,
            "recurrence_rate": self.recurrence_rate(),
            "top_repeated_errors": [
                {"signature": sig, "count": cnt} for sig, cnt in top
            ],
        }
