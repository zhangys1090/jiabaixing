from __future__ import annotations

import json as _json
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from agent.core.logger import StructuredLogger

log = StructuredLogger("result_aggregator")


class LLMChatProtocol(Protocol):
    """LLM对话接口协议，用于生成自然语言摘要和仲裁冲突。"""

    async def chat(self, prompt: str, system_prompt: str = "") -> str: ...


@dataclass
class TaskDetail:
    """单个任务的执行详情。

    Attributes:
        task_id: 任务唯一标识。
        status: 执行状态，'completed' 或 'failed'。
        result: 任务执行成功时的结果数据。
        error: 任务执行失败时的错误信息。
    """

    task_id: str
    status: str = "failed"
    result: Any = None
    error: str | None = None


@dataclass
class ResultConflict:
    """多Agent执行结果之间的冲突记录。

    Attributes:
        type: 冲突类型，如 file_write / goal_overlap / data_inconsistency / resource_contention。
        description: 冲突的可读描述。
        involved_tasks: 涉及冲突的任务ID列表。
        severity: 严重程度，low / medium / high。
    """

    type: str = ""
    description: str = ""
    involved_tasks: list[str] = field(default_factory=list)
    severity: str = "low"


@dataclass
class AggregatedResult:
    """多Agent编排的聚合结果。

    Attributes:
        success: 整体是否成功（全部任务成功则为True）。
        summary: 可读的摘要文本。
        details: 每个任务ID到TaskDetail的映射。
        total_tasks: 总任务数。
        completed_tasks: 成功完成的任务数。
        failed_tasks: 失败的任务数。
        duration: 聚合计算耗时（毫秒）。
        conflicts: 检测到的结果冲突列表。
        llm_summary: LLM生成的自然语言摘要（可选）。
    """

    success: bool = False
    summary: str = ""
    details: dict[str, TaskDetail] = field(default_factory=dict)
    total_tasks: int = 0
    completed_tasks: int = 0
    failed_tasks: int = 0
    duration: float = 0.0
    conflicts: list[ResultConflict] = field(default_factory=list)
    llm_summary: str | None = None


@dataclass
class ConsensusResult:
    """置信度加权合并后的共识结果。

    Attributes:
        selected_task_id: 被选中的任务ID。
        result: 被选中的任务结果数据。
        average_confidence: 所有候选结果的平均置信度。
        selected_agent_id: 被选中结果所属的Agent ID。
    """

    selected_task_id: str = ""
    result: Any = None
    average_confidence: float = 0.0
    selected_agent_id: str = ""


@dataclass
class TaskNode:
    """任务节点定义，描述一个待执行的任务单元。

    Attributes:
        id: 任务唯一标识。
        goal: 任务目标描述。
        context: 任务上下文信息。
        dependencies: 依赖的任务ID列表。
        priority: 优先级（1-10，10最高）。
        tools: 任务可用的工具列表。
        agent_id: 分配给此任务的Agent ID。
        status: 当前状态（pending / running / completed / failed）。
        assigned_to: 实际执行此任务的Agent标识。
        result: 任务执行结果。
        error: 任务执行失败时的错误信息。
    """

    id: str = ""
    goal: str = ""
    context: str = ""
    dependencies: list[str] = field(default_factory=list)
    priority: int = 5
    tools: list[str] = field(default_factory=list)
    agent_id: str | None = None
    status: str = "pending"
    assigned_to: str | None = None
    result: Any = None
    error: str | None = None


class ResultAggregator:
    """多Agent编排结果聚合器。

    合并多个Agent的执行结果，生成结构化摘要报告，提供成功/失败统计、
    执行时长、冲突检测、LLM摘要生成、LLM冲突仲裁和置信度加权合并等功能。

    Usage:
        aggregator = ResultAggregator(llm=my_llm)
        result = aggregator.aggregate(agent_results, task_nodes)
        if not result.success:
            failed = ResultAggregator.get_failed_details(result)
    """

    def __init__(self, llm: LLMChatProtocol | None = None) -> None:
        self._llm = llm

    def aggregate(
        self,
        agent_results: dict[str, Any],
        task_nodes: list[TaskNode],
    ) -> AggregatedResult:
        """聚合所有Agent的执行结果，生成统计摘要和冲突报告。

        Args:
            agent_results: 任务ID到执行结果的映射。
            task_nodes: 任务节点列表，每个节点包含状态信息。

        Returns:
            AggregatedResult: 包含成功/失败统计、摘要、冲突检测的聚合结果。
        """
        start_time = time.time()
        details: dict[str, TaskDetail] = {}

        completed_count = 0
        failed_count = 0
        failed_tasks: list[str] = []

        for task in task_nodes:
            if task.status == "completed" and task.id in agent_results:
                detail = TaskDetail(
                    task_id=task.id,
                    status="completed",
                    result=agent_results[task.id],
                )
                completed_count += 1
            else:
                # 未成功完成的任务（失败 / 待处理 / 跳过 / 标记完成但无结果）
                # 均计入失败，整体 success 才正确反映"是否有任务没跑成"。
                if task.status == "failed":
                    detail = TaskDetail(
                        task_id=task.id,
                        status="failed",
                        error=task.error or "未知错误",
                    )
                elif task.status in ("skipped", "pending"):
                    detail = TaskDetail(
                        task_id=task.id,
                        status=task.status,
                        error=f"任务{task.status}",
                    )
                else:
                    detail = TaskDetail(
                        task_id=task.id,
                        status="skipped",
                        error=f"任务未完成 (状态: {task.status})",
                    )
                failed_count += 1
                failed_tasks.append(task.id)

            details[task.id] = detail

        success = failed_count == 0
        duration = (time.time() - start_time) * 1000

        conflicts = self._detect_conflicts(agent_results, task_nodes)

        summary = self._build_summary(
            success,
            len(task_nodes),
            completed_count,
            failed_count,
            failed_tasks,
            duration,
        )

        log.info(
            "Results aggregated",
            completed=completed_count,
            total=len(task_nodes),
            duration_ms=int(duration),
            conflicts=len(conflicts),
        )

        return AggregatedResult(
            success=success,
            summary=summary,
            details=details,
            total_tasks=len(task_nodes),
            completed_tasks=completed_count,
            failed_tasks=failed_count,
            duration=duration,
            conflicts=conflicts,
        )

    async def aggregate_with_summary(
        self,
        agent_results: dict[str, Any],
        task_nodes: list[TaskNode],
    ) -> AggregatedResult:
        """聚合并使用LLM生成自然语言执行摘要。

        先调用 aggregate() 完成统计聚合，再通过LLM生成100字以内的中文摘要。
        如果LLM不可用或生成失败，llm_summary字段保持为None。

        Args:
            agent_results: 任务ID到执行结果的映射。
            task_nodes: 任务节点列表。

        Returns:
            AggregatedResult: 包含LLM摘要的聚合结果。
        """
        result = self.aggregate(agent_results, task_nodes)

        if self._llm and result.total_tasks > 0:
            try:
                task_summaries = "\n".join(
                    f"- {t.id}: {t.status} | 目标: {t.goal[:80]}"
                    for t in task_nodes
                )

                prompt = f"""请用简洁的中文总结以下多Agent编排执行结果：

总任务数: {result.total_tasks}
成功: {result.completed_tasks}
失败: {result.failed_tasks}
冲突: {len(result.conflicts)}

任务详情:
{task_summaries}

请生成一段100字以内的执行摘要。"""

                result.llm_summary = await self._llm.chat(prompt)
            except Exception as e:
                log.debug("LLM summary generation failed", error=str(e))

        return result

    def _detect_conflicts(
        self,
        agent_results: dict[str, Any],
        task_nodes: list[TaskNode],
    ) -> list[ResultConflict]:
        """检测不同Agent执行结果之间的冲突。

        检测两类冲突：
        1. 文件写入冲突：多个Agent写入同一文件路径。
        2. 目标重叠冲突：多个Agent执行相同目标描述。

        支持通过 filePath / path / file_path 三种字段名识别文件路径。

        Args:
            agent_results: 任务ID到执行结果的映射。
            task_nodes: 任务节点列表。

        Returns:
            list[ResultConflict]: 检测到的冲突列表。
        """
        conflicts: list[ResultConflict] = []

        file_write_map: dict[str, list[str]] = {}
        goal_map: dict[str, list[str]] = {}

        for task in task_nodes:
            if task.status != "completed":
                continue
            result = agent_results.get(task.id)
            if not result or not isinstance(result, dict):
                continue

            file_path = (
                result.get("filePath")
                or result.get("path")
                or result.get("file_path")
            )
            if isinstance(file_path, str):
                file_write_map.setdefault(file_path, []).append(task.id)

            if task.goal:
                goal_map.setdefault(task.goal, []).append(task.id)

        for file_path, task_ids in file_write_map.items():
            if len(task_ids) > 1:
                conflicts.append(
                    ResultConflict(
                        type="file_write",
                        description=f"多个Agent写入同一文件: {file_path}",
                        involved_tasks=task_ids,
                        severity="high",
                    )
                )

        for goal, task_ids in goal_map.items():
            if len(task_ids) > 1:
                conflicts.append(
                    ResultConflict(
                        type="goal_overlap",
                        description=f"多个Agent执行相同目标: {goal}",
                        involved_tasks=task_ids,
                        severity="medium",
                    )
                )

        return conflicts

    async def resolve_conflicts_with_llm(
        self,
        conflicts: list[ResultConflict],
        llm: LLMChatProtocol,
    ) -> list[dict[str, Any]]:
        """使用LLM仲裁解决结果冲突。

        对每个冲突构造仲裁prompt，让LLM选择最佳结果。如果LLM调用失败，
        默认选择第一个涉及的任务作为获胜方。

        Args:
            conflicts: 待解决的冲突列表。
            llm: 用于仲裁的LLM接口。

        Returns:
            list[dict]: 仲裁结果列表，每项包含 winner_task_id 和 resolution。
        """
        resolutions: list[dict[str, Any]] = []

        for conflict in conflicts:
            prompt = f"""请仲裁以下任务结果冲突，选择最佳结果：

冲突类型: {conflict.type}
冲突描述: {conflict.description}
涉及任务: {', '.join(conflict.involved_tasks)}

请以 JSON 格式返回仲裁结果，包含 winnerTaskId（获胜任务ID）和 reasoning（仲裁理由）。"""

            try:
                response = await llm.chat(prompt)
                parsed = _json.loads(response)
                resolutions.append({
                    "conflict": conflict,
                    "winner_task_id": parsed.get("winnerTaskId", ""),
                    "resolution": f"{parsed.get('winnerTaskId', '')}: {parsed.get('reasoning', '')}",
                })
            except Exception as e:
                log.warning("LLM conflict resolution failed", error=str(e))
                resolutions.append({
                    "conflict": conflict,
                    "winner_task_id": conflict.involved_tasks[0],
                    "resolution": f"默认选择第一个任务: {conflict.involved_tasks[0]}",
                })

        return resolutions

    def merge_with_consensus(
        self,
        results: list[dict[str, Any]],
    ) -> ConsensusResult:
        """置信度加权合并——选择最高置信度的结果。

        当多个Agent对同一任务产生不同结果且各带置信度时，选择置信度最高的
        作为最终结果，同时计算平均置信度作为整体可信度参考。

        Args:
            results: 带置信度的结果列表，每项需包含 taskId / result / confidence / agentId。

        Returns:
            ConsensusResult: 合并后的共识结果。
        """
        if not results:
            return ConsensusResult()

        sorted_results = sorted(results, key=lambda r: r.get("confidence", 0), reverse=True)
        winner = sorted_results[0]
        avg_confidence = sum(r.get("confidence", 0) for r in results) / len(results)

        return ConsensusResult(
            selected_task_id=winner.get("taskId", ""),
            result=winner.get("result"),
            average_confidence=avg_confidence,
            selected_agent_id=winner.get("agentId", ""),
        )

    @staticmethod
    def _build_summary(
        success: bool,
        total: int,
        completed: int,
        failed: int,
        failed_task_ids: list[str],
        duration: float,
    ) -> str:
        """构建可读的摘要文本。

        Args:
            success: 整体是否成功。
            total: 总任务数。
            completed: 成功任务数。
            failed: 失败任务数。
            failed_task_ids: 失败任务的ID列表。
            duration: 执行耗时（毫秒）。

        Returns:
            str: 格式化的摘要文本。
        """
        lines: list[str] = []
        status_emoji = "✅" if success else "⚠️"
        status_text = "全部任务执行成功" if success else "部分任务执行失败"

        lines.append(f"{status_emoji} 多Agent编排: {status_text}")
        lines.append(f"   总任务数: {total}")
        lines.append(f"   成功: {completed}")
        lines.append(f"   失败: {failed}")
        lines.append(f"   总耗时: {int(duration)}ms")

        if not success and failed_task_ids:
            lines.append(f"   失败任务: {', '.join(failed_task_ids)}")

        return "\n".join(lines)

    @staticmethod
    def is_all_successful(result: AggregatedResult) -> bool:
        """快速检查聚合结果是否全部成功。

        Args:
            result: 聚合结果。

        Returns:
            bool: 全部任务成功返回True。
        """
        return result.success

    @staticmethod
    def get_failed_details(result: AggregatedResult) -> list[TaskDetail]:
        """提取所有失败任务的详细信息。

        Args:
            result: 聚合结果。

        Returns:
            list[TaskDetail]: 失败任务的详情列表。
        """
        return [d for d in result.details.values() if d.status == "failed"]
