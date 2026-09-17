"""回合链路摘要（trace digest）— 把主循环的完整执行链落成可分析的结构化记录。

设计目的:
    Authority 接线完成后，"主循环到底为什么失败"需要的是**逐环节的证据**，
    而不是测试通过数。本模块把一轮对话的完整链路压成一条结构化记录：

        USER → GOAL → SNAPSHOT → PROPOSERS → CANDIDATES → FINAL DECISION
             → TOOL → ACTUAL RESULT → PREDICTION ERROR → EVIDENCE
             → REPLAN? → NEXT DECISION → FINAL VERIFICATION

    落盘后由 ``scripts/analyze_failure_corpus.py`` 按 M0–M15 分类，
    产出**失败地图**而不是又一张 PASS 表。

设计约束:
    - 纯记录，不参与决策；任何记录失败都不得影响主循环（§9.6 同类原则）。
    - 落盘 JSON 可增量追加，不覆盖历史（语料是累积资产）。
    - 不记录密钥/环境变量；用户输入截断存储。

用法::

    from agent.core.trace_digest import TraceDigest

    d = TraceDigest(turn_id, session_id, user_input)
    d.set_identity(goal_id, snapshot_id)
    d.record_decision(decision)
    d.record_action(tool_call, tool_result, prediction_error)
    d.record_replan(before, after, reason)
    d.finalize(finish_reason, quality_score, goal_progress)
    d.persist()          # 落盘到 data/traces/
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("trace_digest")

#: 单条用户输入最多存多少字符（避免语料膨胀）
_MAX_INPUT_CHARS = 500
#: 单个动作输出最多存多少字符
_MAX_OUTPUT_CHARS = 300


def traces_dir() -> Path:
    """语料落盘根目录（data/traces）。可用 JBX_TRACE_DIR 覆盖（测试用）。"""
    override = os.getenv("JBX_TRACE_DIR", "")
    if override:
        d = Path(override)
    else:
        try:
            from agent.config import DATA_ROOT

            d = Path(DATA_ROOT) / "traces"
        except Exception:
            d = Path("data") / "traces"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class TraceDigest:
    """一轮对话的链路摘要。

    Attributes:
        turn_id: 回合标识（与 ConversationLoop 的 trace_id 一致）。
        session_id: 会话标识。
        user_input: 用户输入（截断）。
        goal_id / snapshot_id: Authority 身份。
        rounds: 每轮决策与动作记录。
        replan: replan 记录。
        finish_reason / quality_score / goal_progress: 收口信息。
    """

    turn_id: str
    session_id: str
    user_input: str
    started_at: float = field(default_factory=time.time)
    goal_id: str | None = None
    snapshot_id: str | None = None
    goal_progress_start: float | None = None
    goal_progress_end: float | None = None
    rounds: list[dict[str, Any]] = field(default_factory=list)
    replan: dict[str, Any] = field(default_factory=dict)
    finish_reason: str = ""
    quality_score: float | None = None
    error: str | None = None
    authority_enabled: bool = True

    def __post_init__(self) -> None:
        self.user_input = (self.user_input or "")[:_MAX_INPUT_CHARS]

    # ── 记录 API（全部尽力而为，不抛）──

    def set_identity(self, goal_id: str | None, snapshot_id: str | None) -> None:
        """记录本轮的 Authority 身份。记录进度起点。"""
        self.goal_id = goal_id
        self.snapshot_id = snapshot_id

    def note_goal_progress_start(self, progress: float | None) -> None:
        """记录 Goal 初始进度（用于判断"是否真的推进了"）。"""
        self.goal_progress_start = progress

    def record_decision(self, decision: Any, round_idx: int) -> str | None:
        """记录一次 DecisionAuthority 裁决，返回 decisionId。

        Args:
            decision: Decision 实例。
            round_idx: 轮次（1 起）。

        Returns:
            decisionId，失败时 None。
        """
        try:
            candidates: list[dict[str, Any]] = []
            accepted_ids = {c.candidateId for c in decision.acceptedCandidates}
            rejected_ids = {c.candidateId for c in decision.rejectedCandidates}
            for cand in (
                list(decision.acceptedCandidates) + list(decision.rejectedCandidates)
            ):
                payload = cand.action.payload if isinstance(cand.action.payload, dict) else {}
                candidates.append({
                    "proposerId": cand.proposerId,
                    "actionName": payload.get("name", ""),
                    "confidence": round(float(cand.confidence), 4),
                    "estimatedGoalProgress": round(
                        float(cand.estimatedGoalProgress), 4
                    ),
                    "verdict": (
                        "accepted" if cand.candidateId in accepted_ids
                        else "rejected" if cand.candidateId in rejected_ids
                        else "unknown"
                    ),
                    "chosen": cand.candidateId == decision.chosenCandidateId,
                    "reasoning": (cand.reasoning or "")[:200],
                })
            chosen_payload = (
                decision.chosen.action.payload
                if decision.chosen and isinstance(decision.chosen.action.payload, dict)
                else {}
            )
            self.rounds.append({
                "round": round_idx,
                "decisionId": decision.decisionId,
                "proposerSet": list(decision.proposerSet),
                "proposerCount": getattr(decision, "proposerCount", len(decision.proposerSet)),
                "candidateCount": getattr(decision, "candidateCount", len(candidates)),
                "competitionDegraded": bool(
                    getattr(decision, "competitionDegraded", False)
                ),
                "chosenAction": chosen_payload.get("name", ""),
                "selectionReason": (decision.selectionReason or "")[:300],
                "candidates": candidates,
                "actions": [],
            })
            return decision.decisionId
        except Exception as exc:
            log.debug("trace_digest record_decision failed", error=str(exc))
            return None

    def record_action(
        self,
        tool_name: str,
        success: bool,
        error: str | None,
        output: str | None,
        is_chosen: bool = False,
        expected_effect: str = "",
        actual_effect: str = "",
        error_type: str = "",
        error_magnitude: float | None = None,
        duration_ms: float | None = None,
    ) -> None:
        """记录一次工具执行及其预测误差。

        找不到对应轮次时挂到最后一轮（保持链路不断）。
        """
        try:
            entry = {
                "tool": tool_name,
                "success": bool(success),
                "error": (error or "")[:200] or None,
                "outputHead": (output or "")[:_MAX_OUTPUT_CHARS] or None,
                "isChosen": bool(is_chosen),
                "expectedEffect": expected_effect,
                "actualEffect": actual_effect,
                "errorType": error_type,
                "errorMagnitude": (
                    round(float(error_magnitude), 4)
                    if error_magnitude is not None else None
                ),
                "durationMs": round(duration_ms, 1) if duration_ms is not None else None,
            }
            if not self.rounds:
                self.rounds.append({"round": 1, "actions": []})
            self.rounds[-1].setdefault("actions", []).append(entry)
        except Exception as exc:
            log.debug("trace_digest record_action failed", error=str(exc))

    def record_replan(self, before: int, after: int, reason: str) -> None:
        """记录一次 replan（判断 M11/M12 的关键证据）。"""
        self.replan = {
            "triggered": True,
            "planVersionBefore": before,
            "planVersionAfter": after,
            "reason": (reason or "")[:300],
        }

    def finalize(
        self,
        finish_reason: str,
        quality_score: float | None = None,
        goal_progress_end: float | None = None,
        error: str | None = None,
    ) -> None:
        """收口本轮记录。"""
        self.finish_reason = finish_reason or ""
        self.quality_score = (
            round(float(quality_score), 4) if quality_score is not None else None
        )
        self.goal_progress_end = goal_progress_end
        self.error = (error or "")[:300] or None

    # ── 派生视图 ──

    def to_dict(self) -> dict[str, Any]:
        """转成可序列化字典。"""
        return {
            "turnId": self.turn_id,
            "sessionId": self.session_id,
            "userInput": self.user_input,
            "startedAt": self.started_at,
            "goalId": self.goal_id,
            "snapshotId": self.snapshot_id,
            "goalProgressStart": self.goal_progress_start,
            "goalProgressEnd": self.goal_progress_end,
            "authorityEnabled": self.authority_enabled,
            "rounds": self.rounds,
            "replan": self.replan,
            "finishReason": self.finish_reason,
            "qualityScore": self.quality_score,
            "error": self.error,
        }

    @property
    def action_count(self) -> int:
        """本轮执行的动作总数。"""
        return sum(len(r.get("actions", [])) for r in self.rounds)

    @property
    def failure_count(self) -> int:
        """本轮执行失败的动作数。"""
        return sum(
            1 for r in self.rounds for a in r.get("actions", []) if not a.get("success")
        )

    def persist(self, target_dir: Path | None = None) -> Path | None:
        """落盘为 JSON。失败不抛（语料丢失不应影响主循环）。

        Returns:
            落盘路径；失败时 None。
        """
        try:
            d = target_dir or traces_dir()
            d.mkdir(parents=True, exist_ok=True)
            safe_turn = "".join(
                c for c in self.turn_id if c.isalnum() or c in "-_"
            )[:40] or "turn"
            path = d / f"{int(self.started_at)}_{safe_turn}.json"
            path.write_text(
                json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return path
        except Exception as exc:
            log.debug("trace_digest persist failed", error=str(exc))
            return None


def load_corpus(dir_path: Path | None = None) -> list[dict[str, Any]]:
    """加载语料目录下全部 trace digest。

    **递归扫描**（R-8，2026-09-17）：语料按批次/run-tag 分子目录存放，
    例如 `data/traces/<run_tag>/*.json`。此前用 `glob("*.json")` 只扫顶层，
    导致跨批次语料要么混在一起、要么后续批次根本不被读到。

    Args:
        dir_path: 目录根；None 时用默认 traces 目录。

    Returns:
        digest 字典列表，按 startedAt 升序。损坏文件跳过。
    """
    d = dir_path or traces_dir()
    out: list[dict[str, Any]] = []
    if not d.exists():
        return out
    # rglob：递归覆盖 data/traces/<tag>/xxx.json 与顶层的旧格式
    for f in sorted(d.rglob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "turnId" in data:
                data["_sourceFile"] = str(f.relative_to(d))
                # run-tag 目录名作为语料元数据（分析器可按批次过滤）
                rel_parts = f.relative_to(d).parts
                data["_runTag"] = rel_parts[-2] if len(rel_parts) >= 2 else ""
                out.append(data)
        except Exception:
            continue
    out.sort(key=lambda x: x.get("startedAt", 0))
    return out
