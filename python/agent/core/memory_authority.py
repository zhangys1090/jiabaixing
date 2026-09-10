"""D6 MemoryAuthority — Authority 链持久化权威（SQLite）

D6 验收标准（冻结方案）：
  - 跨进程记忆一致性（重启可恢复，Risk 4: LearnedBeliefs 持久化）
  - TS→Python Decision 交叉验证数据源（Risk 1）
  - 无静默记忆分歧（写入失败 log_ignored 可观测，不静默）

职责：
  ✅ beliefs / belief_history / decisions / evidence 的唯一持久化写路径
  ✅ 重启恢复（load_beliefs / get_decision / get_evidence_for_goal）
  ❌ 不做检索语义（→ MemoryEngine.search，经 StateAuthority readMemory）
  ❌ 不裁决、不写 Goal 状态

写入方（唯一）：
  - LearningAuthority._apply_belief_update → persist_belief_update
  - DecisionAuthority.decide → persist_decision
  - GoalAuthority.updateFromEvidence → persist_evidence
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Any

from agent.core.authority_types import Decision, GoalEvidence
from agent.core.learning_authority import BeliefUpdate, LearnedBelief
from agent.core.logger import StructuredLogger, log_ignored

log = StructuredLogger("memory_authority")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS beliefs (
    context_signature TEXT PRIMARY KEY,
    proposer_id TEXT NOT NULL,
    action_name TEXT NOT NULL,
    confidence_bias REAL NOT NULL,
    progress_bias REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    last_updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS belief_history (
    belief_id TEXT PRIMARY KEY,
    source_evidence_id TEXT NOT NULL,
    source_goal_id TEXT NOT NULL,
    source_decision_id TEXT NOT NULL,
    proposer_id TEXT NOT NULL,
    action_name TEXT NOT NULL,
    context_signature TEXT NOT NULL,
    confidence_adjustment REAL NOT NULL,
    progress_adjustment REAL NOT NULL,
    reason TEXT NOT NULL,
    ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    chosen_candidate_id TEXT NOT NULL,
    chosen_proposer_id TEXT NOT NULL,
    chosen_action_name TEXT NOT NULL,
    selection_reason TEXT NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_goal ON decisions(goal_id);
CREATE TABLE IF NOT EXISTS evidence (
    evidence_id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    action_name TEXT NOT NULL,
    observation TEXT,
    expected_effect TEXT NOT NULL,
    actual_effect TEXT NOT NULL,
    progress_delta REAL NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_goal ON evidence(goal_id);
"""


class MemoryAuthority:
    """Authority 链产物（信念/决策/证据）的唯一持久化权威。"""

    _instance: MemoryAuthority | None = None
    _lock = threading.Lock()

    @classmethod
    def getInstance(cls) -> MemoryAuthority:
        with cls._lock:
            if cls._instance is None:
                cls._instance = MemoryAuthority()
            return cls._instance

    @classmethod
    def resetInstance(cls) -> None:
        with cls._lock:
            inst = cls._instance
            cls._instance = None
        if inst is not None:
            inst.close()

    def __init__(self, db_path: str | None = None) -> None:
        self._mu = threading.RLock()
        if db_path is None:
            db_path = os.environ.get("AUTHORITY_STORE_PATH", "data/authority_store.db")
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._failed = False
        try:
            parent = os.path.dirname(db_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            self._conn = sqlite3.connect(db_path, check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(_SCHEMA)
            self._conn.commit()
        except Exception as _db_exc:
            # 持久化不可用时 Authority 链继续工作（内存态），但必须可观测
            self._failed = True
            self._conn = None
            log_ignored(log, "MemoryAuthority.init", _db_exc)

    # ---------------------------------------------------------- 写入（唯一路径）

    def persist_belief_update(self, update: BeliefUpdate, belief: LearnedBelief) -> None:
        try:
            with self._mu:
                assert self._conn is not None
                self._conn.execute(
                    "INSERT OR REPLACE INTO beliefs VALUES (?,?,?,?,?,?,?)",
                    (
                        belief.contextSignature, belief.proposerId, belief.actionName,
                        belief.confidenceBias, belief.progressBias, belief.sampleCount,
                        belief.lastUpdated,
                    ),
                )
                self._conn.execute(
                    "INSERT OR REPLACE INTO belief_history VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        update.beliefId, update.sourceEvidenceId, update.sourceGoalId,
                        update.sourceDecisionId, update.proposerId, update.actionName,
                        update.contextSignature, update.confidenceAdjustment,
                        update.progressAdjustment, update.reason, update.timestamp,
                    ),
                )
                self._conn.commit()
        except Exception as _exc:
            log_ignored(log, "MemoryAuthority.persist_belief_update", _exc)

    def persist_decision(self, decision: Decision) -> None:
        try:
            chosen = decision.chosen
            payload = chosen.action.payload if isinstance(chosen.action.payload, dict) else {}
            action_name = str(payload.get("name", ""))
            with self._mu:
                assert self._conn is not None
                self._conn.execute(
                    "INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?,?,?)",
                    (
                        decision.decisionId, decision.goalId, decision.snapshotId,
                        decision.chosenCandidateId, chosen.proposerId, action_name,
                        decision.selectionReason, decision.timestamp,
                    ),
                )
                self._conn.commit()
        except Exception as _exc:
            log_ignored(log, "MemoryAuthority.persist_decision", _exc)

    def persist_evidence(self, evidence: GoalEvidence) -> None:
        try:
            observation = None
            if evidence.observation is not None:
                observation = evidence.observation if isinstance(evidence.observation, str) else json.dumps(evidence.observation, ensure_ascii=False, default=str)
            with self._mu:
                assert self._conn is not None
                self._conn.execute(
                    "INSERT OR REPLACE INTO evidence VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        evidence.evidenceId, evidence.goalId, evidence.decisionId,
                        evidence.actionName, observation, evidence.expectedEffect,
                        evidence.actualEffect, evidence.progressDelta, evidence.timestamp,
                    ),
                )
                self._conn.commit()
        except Exception as _exc:
            log_ignored(log, "MemoryAuthority.persist_evidence", _exc)

    # ---------------------------------------------------------- 读取（恢复/交叉验证）

    def load_beliefs(self) -> dict[str, LearnedBelief]:
        if self._conn is None:
            return {}
        try:
            with self._mu:
                rows = self._conn.execute("SELECT * FROM beliefs").fetchall()
            return {
                r[0]: LearnedBelief(
                    contextSignature=r[0], proposerId=r[1], actionName=r[2],
                    confidenceBias=r[3], progressBias=r[4], sampleCount=r[5],
                    lastUpdated=r[6],
                )
                for r in rows
            }
        except Exception as _exc:
            log_ignored(log, "MemoryAuthority.load_beliefs", _exc)
            return {}

    def get_decision(self, decision_id: str) -> dict[str, Any] | None:
        """Risk 1: TS→Python 交叉验证的 Decision 记录查询。"""
        if self._conn is None:
            return None
        try:
            with self._mu:
                row = self._conn.execute(
                    "SELECT * FROM decisions WHERE decision_id = ?", (decision_id,)
                ).fetchone()
            if row is None:
                return None
            keys = ["decisionId", "goalId", "snapshotId", "chosenCandidateId",
                    "proposerId", "actionName", "selectionReason", "ts"]
            return dict(zip(keys, row))
        except Exception as _exc:
            log_ignored(log, "MemoryAuthority.get_decision", _exc)
            return None

    def get_decisions_for_goal(self, goal_id: str) -> list[dict[str, Any]]:
        if self._conn is None:
            return []
        try:
            with self._mu:
                rows = self._conn.execute(
                    "SELECT * FROM decisions WHERE goal_id = ? ORDER BY ts", (goal_id,)
                ).fetchall()
            keys = ["decisionId", "goalId", "snapshotId", "chosenCandidateId",
                    "proposerId", "actionName", "selectionReason", "ts"]
            return [dict(zip(keys, r)) for r in rows]
        except Exception as _exc:
            log_ignored(log, "MemoryAuthority.get_decisions_for_goal", _exc)
            return []

    def get_evidence_for_goal(self, goal_id: str) -> list[dict[str, Any]]:
        if self._conn is None:
            return []
        try:
            with self._mu:
                rows = self._conn.execute(
                    "SELECT * FROM evidence WHERE goal_id = ? ORDER BY ts", (goal_id,)
                ).fetchall()
            keys = ["evidenceId", "goalId", "decisionId", "actionName", "observation",
                    "expectedEffect", "actualEffect", "progressDelta", "ts"]
            return [dict(zip(keys, r)) for r in rows]
        except Exception as _exc:
            log_ignored(log, "MemoryAuthority.get_evidence_for_goal", _exc)
            return []

    def get_belief_history_for_goal(self, goal_id: str) -> list[dict[str, Any]]:
        if self._conn is None:
            return []
        try:
            with self._mu:
                rows = self._conn.execute(
                    "SELECT * FROM belief_history WHERE source_goal_id = ? ORDER BY ts",
                    (goal_id,),
                ).fetchall()
            keys = ["beliefId", "sourceEvidenceId", "sourceGoalId", "sourceDecisionId",
                    "proposerId", "actionName", "contextSignature", "confidenceAdjustment",
                    "progressAdjustment", "reason", "ts"]
            return [dict(zip(keys, r)) for r in rows]
        except Exception as _exc:
            log_ignored(log, "MemoryAuthority.get_belief_history_for_goal", _exc)
            return []

    @property
    def is_persistent(self) -> bool:
        return self._conn is not None and not self._failed

    def close(self) -> None:
        try:
            with self._mu:
                if self._conn is not None:
                    self._conn.close()
                    self._conn = None
        except Exception as _close_exc:
            log_ignored(log, "MemoryAuthority.close", _close_exc)
