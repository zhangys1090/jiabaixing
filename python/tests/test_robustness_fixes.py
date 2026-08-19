"""核心代码健壮性修复回归测试。

覆盖本轮审计发现并修复的「持久化/外部数据损坏即崩溃 / 单条损坏清空全量状态」类缺陷：
- session_store / workspace：顶层 JSON 非 dict（被覆盖为数组/标量）时构造器崩溃
- account_usage / evolution：单条损坏记录把整份历史静默清空
- workflow/checkpoint_store：DB 列 JSON 半写损坏时 load 直接冒泡 JSONDecodeError
- safe_json_loads：统一的安全反序列化入口
"""

import json
import sqlite3

import pytest

from agent.infrastructure.safe_json import safe_json_loads
from agent.persistence.session_store import SessionStore
from agent.persistence.workspace import WorkspaceManager
from agent.persistence.account_usage import AccountUsageTracker
from agent.workflow.checkpoint_store import WorkflowStore
from agent.evolution.engine import EvolutionEngine


# ---------------- safe_json_loads ----------------
def test_safe_json_loads_corrupt_returns_default():
    assert safe_json_loads("{not json", {}) == {}
    assert safe_json_loads("not json", None) is None
    assert safe_json_loads(None, "x") == "x"
    assert safe_json_loads(123, "x") == "x"
    assert safe_json_loads('{"a": 1}', None) == {"a": 1}
    assert safe_json_loads([1, 2], None) == [1, 2]  # 已为 list 原样返回


# ---------------- SessionStore ----------------
def test_session_store_top_level_array_no_crash(tmp_path):
    jpath = tmp_path / "s.json"
    jpath.write_text("[1, 2, 3]", encoding="utf-8")  # 被外部工具覆盖为数组
    store = SessionStore(db_path=str(tmp_path / "s.db"))
    assert store.list_sessions() == []


def test_session_store_invalid_json_no_crash(tmp_path):
    jpath = tmp_path / "s.json"
    jpath.write_text("{broken", encoding="utf-8")
    store = SessionStore(db_path=str(tmp_path / "s.db"))
    assert store.list_sessions() == []


# ---------------- WorkspaceManager ----------------
def test_workspace_manager_non_dict_no_crash(tmp_path):
    (tmp_path / "workspaces.json").write_text('["a","b"]', encoding="utf-8")
    mgr = WorkspaceManager(data_dir=tmp_path)
    assert mgr._workspaces == {}


# ---------------- AccountUsageTracker（单条损坏不清空） ----------------
def test_account_usage_partial_corruption_keeps_good(tmp_path):
    path = tmp_path / "usage.json"
    data = {
        "records": {
            "u1": [
                {"user_id": "u1", "model": "m", "input_tokens": 1,
                 "output_tokens": 2, "cost_usd": 0.01, "timestamp": 1.0},
            ],
            # u2 的记录缺字段 → 旧代码 KeyError 逃逸 except，整份历史被清空
            "u2": [{"user_id": "u2"}],
        },
        "budgets": {},
    }
    path.write_text(json.dumps(data), encoding="utf-8")
    tracker = AccountUsageTracker(persist_path=str(path))
    assert "u1" in tracker._records and len(tracker._records["u1"]) == 1
    assert "u2" not in tracker._records  # 损坏条被跳过，而非清空全部


# ---------------- WorkflowCheckpointStore（损坏列不冒泡） ----------------
def test_checkpoint_store_corrupt_variables_row(tmp_path):
    store = WorkflowStore(db_path=str(tmp_path / "c.db"))
    with sqlite3.connect(str(tmp_path / "c.db")) as conn:
        conn.execute(
            "INSERT INTO workflow_instances "
            "(id, definition_id, status, variables_json, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("bad", "d1", "running", "{not-valid-json", 1.0, 1.0),
        )
    inst = store.load_instance("bad")  # 旧代码此处抛 JSONDecodeError
    assert inst is not None
    assert inst.variables == {}  # 安全降级而非崩溃


# ---------------- EvolutionEngine（单键损坏不清空） ----------------
def test_evolution_engine_partial_corruption_keeps_good(tmp_path):
    state_path = tmp_path / "engine-state.json"
    state = {
        "tool_weights": {"x": 1.0},          # 正确
        "used_plan_ids": "not-a-list",        # 错误类型 → 应被跳过
        "prompt_examples": [{"a": "b"}],      # 正确
    }
    state_path.write_text(json.dumps(state), encoding="utf-8")
    engine = EvolutionEngine(data_dir=str(tmp_path))
    assert engine._tool_weights == {"x": 1.0}
    assert engine._prompt_examples == [{"a": "b"}]
    assert engine._used_plan_ids == set()  # 错误键被跳过，保留默认空集合
