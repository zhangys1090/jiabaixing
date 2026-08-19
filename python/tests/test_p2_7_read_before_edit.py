"""P2-7 read-before-edit 安全约束回归测试。

- 编辑未先读取的文件必须被拒绝（read-before-edit）
- file_edit 多匹配且非 replace_all 必须报错（禁止静默替换首处）
- incremental_edit 的 search 多匹配必须报错
"""
from __future__ import annotations

from pathlib import Path

import pytest

from agent.tools.file_tools import file_edit_executor, file_read_executor, incremental_edit_executor


async def test_p2_7_file_edit_requires_read(tmp_path: Path):
    f = tmp_path / "a.txt"
    f.write_text("hello world\n", encoding="utf-8")
    # 未先 file_read → 直接编辑应被拦截
    res = await file_edit_executor(
        {"file_path": str(f), "old_text": "hello", "new_text": "hi"}
    )
    assert res.success is False
    assert "read-before-edit" in res.error


async def test_p2_7_file_edit_after_read_ok(tmp_path: Path):
    f = tmp_path / "a.txt"
    f.write_text("hello world\n", encoding="utf-8")
    r = await file_read_executor({"file_path": str(f)})
    assert r.success is True
    res = await file_edit_executor(
        {"file_path": str(f), "old_text": "hello", "new_text": "hi"}
    )
    assert res.success is True
    assert "hi world" in f.read_text(encoding="utf-8")


async def test_p2_7_file_edit_multi_match_rejected(tmp_path: Path):
    f = tmp_path / "a.txt"
    f.write_text("x y x y x\n", encoding="utf-8")
    r = await file_read_executor({"file_path": str(f)})
    assert r.success is True
    # 非 replace_all 且匹配多处 → 必须报错，禁止静默替换
    res = await file_edit_executor(
        {"file_path": str(f), "old_text": "x", "new_text": "z"}
    )
    assert res.success is False
    assert "匹配到" in res.error
    # replace_all 应成功
    res2 = await file_edit_executor(
        {"file_path": str(f), "old_text": "x", "new_text": "z", "replace_all": True}
    )
    assert res2.success is True
    assert f.read_text(encoding="utf-8") == "z y z y z\n"


async def test_p2_7_incremental_edit_ambiguous_rejected(tmp_path: Path):
    f = tmp_path / "m.py"
    f.write_text("def foo():\n    pass\ndef foo():\n    pass\n", encoding="utf-8")
    r = await file_read_executor({"file_path": str(f)})
    assert r.success is True
    res = await incremental_edit_executor(
        {"file_path": str(f), "edits": [{"search": "def foo():", "replace": "def bar():"}]}
    )
    assert res.success is False
    assert "匹配到多处" in res.error
