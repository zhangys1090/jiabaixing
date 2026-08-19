"""P1-3 / P1-4 / P1-5 工具回归测试。

- P1-3：refactor_depgraph（模块依赖图，AST）
- P1-4：file_grep（ripgrep 后端 + 纯 Python 回退 + AST 模式）
- P1-5：memory store search_semantic 不再全表扫描（LIMIT + 预筛）
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent.tools.refactor_tools import refactor_depgraph_executor
from agent.tools.file_tools import file_grep_executor
from agent.memory.store import MemoryStore


# --------------------------------------------------------------------------- #
# P1-3 依赖图
# --------------------------------------------------------------------------- #
async def test_p1_3_depgraph_python(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text("[tool.black]\n", encoding="utf-8")
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "mod1.py").write_text("X = 1\n", encoding="utf-8")
    (pkg / "mod2.py").write_text(
        "from pkg.mod1 import X\n\ndef f():\n    return X\n", encoding="utf-8"
    )
    res = await refactor_depgraph_executor(
        {"root_path": str(tmp_path), "language": "python", "format": "json"}
    )
    assert res.success is True
    import json as _json

    data = _json.loads(res.output)
    assert len(data["nodes"]) >= 2
    assert len(data["edges"]) >= 1
    # mod2 依赖 pkg.mod1
    assert ("pkg.mod2", "pkg.mod1") in [(e["from"], e["to"]) for e in data["edges"]]


async def test_p1_3_depgraph_mermaid(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text("[build-system]\n", encoding="utf-8")
    (tmp_path / "a.py").write_text("import os\n", encoding="utf-8")
    res = await refactor_depgraph_executor(
        {"root_path": str(tmp_path), "language": "python", "format": "mermaid"}
    )
    assert res.success is True
    assert res.output.startswith("graph TD")


# --------------------------------------------------------------------------- #
# P1-4 代码搜索
# --------------------------------------------------------------------------- #
async def test_p1_4_file_grep_text(tmp_path: Path):
    f = tmp_path / "code.txt"
    f.write_text("alpha\nbeta needle gamma\ndelta\n", encoding="utf-8")
    res = await file_grep_executor({"pattern": "needle", "path": str(f)})
    assert res.success is True
    assert res.metadata["match_count"] >= 1
    assert "needle" in res.output


async def test_p1_4_file_grep_context(tmp_path: Path):
    f = tmp_path / "code.txt"
    f.write_text("line1\nline2 needle line2\nline3\n", encoding="utf-8")
    res = await file_grep_executor(
        {"pattern": "needle", "path": str(f), "context": 1}
    )
    assert res.success is True
    # 上下文应包含匹配行上下各 1 行
    assert "line1" in res.output and "line3" in res.output


async def test_p1_4_file_grep_ast(tmp_path: Path):
    f = tmp_path / "m.py"
    f.write_text(
        "def target_func():\n    pass\ntarget_func = 1\n", encoding="utf-8"
    )
    res = await file_grep_executor(
        {"pattern": "target_func", "path": str(f), "mode": "ast", "language": "python"}
    )
    assert res.success is True
    assert "def target_func" in res.output
    assert "assign target_func" in res.output


async def test_p1_4_file_grep_ast_requires_python(tmp_path: Path):
    f = tmp_path / "m.py"
    f.write_text("def x(): pass\n", encoding="utf-8")
    res = await file_grep_executor(
        {"pattern": "x", "path": str(f), "mode": "ast", "language": "ts"}
    )
    assert res.success is False


# --------------------------------------------------------------------------- #
# P1-5 记忆检索 LIMIT + 预筛
# --------------------------------------------------------------------------- #
def test_p1_5_search_semantic_sql_has_limit_and_prefilter(tmp_path: Path):
    store = MemoryStore(db_path=str(tmp_path / "m.db"))

    captured: list[tuple[str, tuple]] = []

    class _Cur:
        def __iter__(self):
            return iter([])

        def fetchone(self):
            return None

        def fetchall(self):
            return []

    class _FakeConn:
        def execute(self, sql, params=()):
            captured.append((sql, tuple(params)))
            return _Cur()

        def commit(self):
            pass

        def close(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    store._conn = _FakeConn()  # sqlite3.Connection.execute 只读，无法 monkeypatch
    # search_semantic 为同步方法
    store.search_semantic("查询测试内容", limit=5, scene_filter="work", recent_hours=24)

    assert captured, "search_semantic 未执行任何 SQL"
    sql = captured[0][0]
    assert "LIMIT" in sql, "search_semantic 未加 LIMIT（仍全表扫描）"
    assert "scene = ?" in sql, "scene_filter 预筛未生效"
    assert "timestamp >= ?" in sql, "recent_hours 预筛未生效"
