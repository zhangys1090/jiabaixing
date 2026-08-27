"""执行轨迹日志 — 学习 DeepSeek Harness 的"日志即唯一真相源"设计.

DeepSeek Harness 核心主张:
  - 日志即唯一真相源 (Log as Single Source of Truth)
  - 所有评测/诊断/强化 均基于 TraceLog
  - TraceLog 记录完整的 Agent 执行轨迹
  - 可回溯: 任意历史时刻的状态可重建

Codex Harness 补充:
  - Trace-level 诊断: 记录完整 tool_call 轨迹和中间状态
  - Subagent 轨迹: 子Agent 的执行也纳入主轨迹

jiabaixing 适配:
  - 与现有 ExecutionTrace/ToolCallTrace 集成
  - 提供 TraceLog 查询/回溯/导出 能力
  - 支持评测系统作为唯一数据源
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

log = StructuredLogger("trace_log")


class TraceEventType(str, Enum):
    SESSION_START = "session_start"
    SESSION_END = "session_end"
    USER_INPUT = "user_input"
    LLM_REQUEST = "llm_request"
    LLM_CALL = "llm_call"
    LLM_RESPONSE = "llm_response"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    APPROVAL_REQUEST = "approval_request"
    APPROVAL_DECISION = "approval_decision"
    CONTEXT_TRUNCATION = "context_truncation"
    CHECKPOINT_SAVE = "checkpoint_save"
    CHECKPOINT_RESTORE = "checkpoint_restore"
    CANCEL_REQUEST = "cancel_request"
    STRATEGY_SELECT = "strategy_select"
    ERROR = "error"
    EVAL_START = "eval_start"
    EVAL_END = "eval_end"
    SCORE = "score"
    SUBAGENT_SPAWN = "subagent_spawn"
    SUBAGENT_RESULT = "subagent_result"


@dataclass
class TraceEntry:
    trace_id: str
    session_id: str
    event_type: TraceEventType
    timestamp: float = field(default_factory=time.time)
    data: dict[str, Any] = field(default_factory=dict)
    parent_trace_id: str = ""
    duration_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "session_id": self.session_id,
            "event_type": self.event_type.value,
            "timestamp": self.timestamp,
            "data": self.data,
            "parent_trace_id": self.parent_trace_id,
            "duration_ms": self.duration_ms,
        }


class TraceLog:
    """执行轨迹日志 — DeepSeek Harness 风格的"唯一真相源".

    功能:
      - 记录 Agent 执行的每个关键事件
      - 按 session/trace/event 查询
      - 导出为 JSON 供评测系统消费
      - 可回溯任意时刻的状态
    """

    def __init__(self, persist_dir: str = ""):
        self._entries: list[TraceEntry] = []
        self._by_session: dict[str, list[int]] = {}
        self._by_trace: dict[str, list[int]] = {}
        self._persist_dir = persist_dir
        if persist_dir:
            os.makedirs(persist_dir, exist_ok=True)

    def record(
        self,
        trace_id: str,
        session_id: str,
        event_type: TraceEventType,
        data: dict[str, Any] | None = None,
        parent_trace_id: str = "",
        duration_ms: float = 0.0,
    ) -> TraceEntry:
        entry = TraceEntry(
            trace_id=trace_id,
            session_id=session_id,
            event_type=event_type,
            data=data or {},
            parent_trace_id=parent_trace_id,
            duration_ms=duration_ms,
        )
        idx = len(self._entries)
        self._entries.append(entry)

        self._by_session.setdefault(session_id, []).append(idx)
        self._by_trace.setdefault(trace_id, []).append(idx)

        if self._persist_dir:
            self._persist_entry(entry)

        return entry

    def query_by_session(
        self,
        session_id: str,
        event_type: TraceEventType | None = None,
        limit: int = 100,
    ) -> list[TraceEntry]:
        indices = self._by_session.get(session_id, [])
        entries = [self._entries[i] for i in indices if i < len(self._entries)]
        if event_type:
            entries = [e for e in entries if e.event_type == event_type]
        return entries[-limit:] if limit > 0 else entries

    def query_by_trace(self, trace_id: str) -> list[TraceEntry]:
        indices = self._by_trace.get(trace_id, [])
        return [self._entries[i] for i in indices if i < len(self._entries)]

    def query_by_time_range(
        self,
        start_time: float,
        end_time: float | None = None,
        event_type: TraceEventType | None = None,
    ) -> list[TraceEntry]:
        result = []
        for entry in self._entries:
            if entry.timestamp < start_time:
                continue
            if end_time and entry.timestamp > end_time:
                continue
            if event_type and entry.event_type != event_type:
                continue
            result.append(entry)
        return result

    def get_tool_call_trace(self, session_id: str) -> list[dict[str, Any]]:
        entries = self.query_by_session(
            session_id, event_type=TraceEventType.TOOL_CALL
        )
        trace = []
        for entry in entries:
            trace.append({
                "trace_id": entry.trace_id,
                "timestamp": entry.timestamp,
                "tool_name": entry.data.get("tool_name", ""),
                "arguments": entry.data.get("arguments", {}),
                "duration_ms": entry.duration_ms,
            })
        return trace

    def get_score_trace(self, session_id: str) -> list[dict[str, Any]]:
        entries = self.query_by_session(
            session_id, event_type=TraceEventType.SCORE
        )
        return [
            {
                "trace_id": e.trace_id,
                "timestamp": e.timestamp,
                "scores": e.data.get("scores", {}),
                "weighted": e.data.get("weighted", 0),
            }
            for e in entries
        ]

    def reconstruct_state(self, session_id: str, at_time: float) -> dict[str, Any]:
        entries = self.query_by_session(session_id)
        relevant = [e for e in entries if e.timestamp <= at_time]

        state: dict[str, Any] = {
            "session_id": session_id,
            "at_time": at_time,
            "tool_calls": [],
            "messages": [],
            "scores": [],
            "errors": [],
        }
        for entry in relevant:
            if entry.event_type == TraceEventType.TOOL_CALL:
                state["tool_calls"].append(entry.data)
            elif entry.event_type == TraceEventType.USER_INPUT:
                state["messages"].append({"role": "user", **entry.data})
            elif entry.event_type == TraceEventType.LLM_RESPONSE:
                state["messages"].append({"role": "assistant", **entry.data})
            elif entry.event_type == TraceEventType.SCORE:
                state["scores"].append(entry.data)
            elif entry.event_type == TraceEventType.ERROR:
                state["errors"].append(entry.data)

        return state

    def export_session(self, session_id: str) -> dict[str, Any]:
        entries = self.query_by_session(session_id, limit=0)
        return {
            "session_id": session_id,
            "entries": [e.to_dict() for e in entries],
            "total_events": len(entries),
            "export_time": time.time(),
        }

    def export_to_jsonl(self, session_id: str, path: str) -> int:
        entries = self.query_by_session(session_id, limit=0)
        with open(path, "w", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry.to_dict(), ensure_ascii=False) + "\n")
        return len(entries)

    def stats(self) -> dict[str, Any]:
        event_counts: dict[str, int] = {}
        for entry in self._entries:
            key = entry.event_type.value
            event_counts[key] = event_counts.get(key, 0) + 1
        return {
            "total_entries": len(self._entries),
            "total_sessions": len(self._by_session),
            "total_traces": len(self._by_trace),
            "event_counts": event_counts,
        }

    def _persist_entry(self, entry: TraceEntry) -> None:
        if not self._persist_dir:
            return
        try:
            path = os.path.join(
                self._persist_dir,
                f"trace_{entry.session_id}_{int(entry.timestamp)}.jsonl",
            )
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry.to_dict(), ensure_ascii=False) + "\n")
        except Exception as e:
            log.warning("轨迹持久化失败", error=str(e))

    def clear(self, session_id: str = "") -> int:
        if session_id:
            indices = self._by_session.pop(session_id, [])
            for idx in sorted(indices, reverse=True):
                if idx < len(self._entries):
                    self._entries[idx] = None
            self._entries = [e for e in self._entries if e is not None]
            self._rebuild_index()
            return len(indices)
        count = len(self._entries)
        self._entries.clear()
        self._by_session.clear()
        self._by_trace.clear()
        return count

    def _rebuild_index(self) -> None:
        self._by_session.clear()
        self._by_trace.clear()
        for i, entry in enumerate(self._entries):
            if entry is None:
                continue
            self._by_session.setdefault(entry.session_id, []).append(i)
            self._by_trace.setdefault(entry.trace_id, []).append(i)
