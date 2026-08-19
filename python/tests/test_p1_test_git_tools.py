"""P1-1 / P1-2 测试链路与 Git 链路工具回归测试（审计落地验证）。

全部通过 mock subprocess 完成，不触发真实命令执行。
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from agent.tools import test_tools, git_tools
from agent.tools.registry import ToolRegistry, register_default_tools


def _cp(stdout="", stderr="", returncode=0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def _init_reg() -> ToolRegistry:
    reg = ToolRegistry()
    register_default_tools(reg)
    return reg


# --------------------------------------------------------------------------- #
# 注册
# --------------------------------------------------------------------------- #
def test_p1_tools_registered():
    reg = _init_reg()
    for name in ("test_run", "test_generate", "coverage_read",
                 "git_status", "git_diff", "git_commit", "git_log"):
        assert reg.has(name), f"{name} 未注册"


# --------------------------------------------------------------------------- #
# test_run
# --------------------------------------------------------------------------- #
async def test_test_run_parses_pytest_output():
    fake = _cp(stdout="FAILED tests/demo.py::test_bad - assert 1 == 2\n1 failed, 4 passed in 0.12s",
               returncode=1)
    with patch.object(test_tools.subprocess, "run", return_value=fake):
        res = await test_tools.test_run_executor({"framework": "pytest", "cwd": "."})
    assert res.success is False  # pytest 失败 exit!=0
    assert res.metadata["failed"] == 1
    assert res.metadata["passed"] == 4
    assert "tests/demo.py::test_bad" in res.metadata["failed_tests"]


async def test_test_run_missing_runner():
    with patch.object(test_tools.subprocess, "run", side_effect=FileNotFoundError("no pytest")):
        res = await test_tools.test_run_executor({"framework": "pytest", "cwd": "."})
    assert res.success is False
    assert "未安装" in res.error


async def test_test_run_invalid_framework():
    res = await test_tools.test_run_executor({"framework": "make"})
    assert res.success is False
    assert "不支持" in res.error


# --------------------------------------------------------------------------- #
# test_generate
# --------------------------------------------------------------------------- #
async def test_test_generate_python_scaffold(tmp_path: Path):
    src = tmp_path / "calc.py"
    src.write_text("def add(a, b):\n    return a + b\n\nclass Calc:\n    def mul(self, a, b):\n        return a * b\n", encoding="utf-8")
    res = await test_tools.test_generate_executor({"file_path": str(src), "framework": "pytest"})
    assert res.success is True
    out_file = Path(res.metadata["output_path"])
    assert out_file.exists()
    text = out_file.read_text(encoding="utf-8")
    assert "def test_add():" in text
    assert "class TestCalc:" in text
    assert "def test_mul(self):" in text


async def test_test_generate_refuses_overwrite(tmp_path: Path):
    src = tmp_path / "calc.py"
    src.write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    out = tmp_path / "test_calc.py"
    out.write_text("# existing\n", encoding="utf-8")
    res = await test_tools.test_generate_executor({"file_path": str(src)})
    assert res.success is False
    assert "已存在" in res.error


# --------------------------------------------------------------------------- #
# coverage_read
# --------------------------------------------------------------------------- #
async def test_coverage_read_lcov(tmp_path: Path):
    cov = tmp_path / "lcov.info"
    cov.write_text(
        "SF:/proj/a.py\nLF:10\nLH:8\nend_of_record\nSF:/proj/b.py\nLF:4\nLH:1\nend_of_record\n",
        encoding="utf-8",
    )
    res = await test_tools.coverage_read_executor({"path": str(cov)})
    assert res.success is True
    assert res.metadata["total_pct"] == pytest.approx(9 / 14 * 100, abs=0.1)
    assert "/proj/a.py" in res.metadata["files"]


# --------------------------------------------------------------------------- #
# git_status / diff / log
# --------------------------------------------------------------------------- #
async def test_git_status_parses_porcelain():
    fake = _cp(stdout="## main...origin/main\n M file_a.py\nA  file_b.py\n?? file_c.py\n")
    with patch.object(git_tools.subprocess, "run", return_value=fake):
        res = await git_tools.git_status_executor({"repo_path": "."})
    assert res.success is True
    assert res.metadata["branch"] == "main"
    assert "file_a.py" in res.metadata["modified"]
    assert "file_b.py" in res.metadata["staged"]
    assert "file_c.py" in res.metadata["untracked"]


async def test_git_status_not_a_repo():
    res = await git_tools.git_status_executor({"repo_path": "/nonexistent/path/xyz"})
    assert res.success is False
    assert "不是 git 仓库" in res.error


async def test_git_diff_returns_text():
    fake = _cp(stdout="diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n")
    with patch.object(git_tools.subprocess, "run", return_value=fake):
        res = await git_tools.git_diff_executor({"repo_path": "."})
    assert res.success is True
    assert "diff --git" in res.output


async def test_git_log_parses():
    fake = _cp(stdout="abc123 fix bug\n def456 add feature\n")
    with patch.object(git_tools.subprocess, "run", return_value=fake):
        res = await git_tools.git_log_executor({"repo_path": "."})
    assert res.success is True
    assert res.metadata["count"] == 2


# --------------------------------------------------------------------------- #
# git_commit（参数化，禁止任意命令）
# --------------------------------------------------------------------------- #
async def test_git_commit_requires_message():
    res = await git_tools.git_commit_executor({"repo_path": "."})
    assert res.success is False
    assert "message" in res.error


async def test_git_commit_runs_add_and_commit(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)

    calls: list[list[str]] = []

    def fake_run(args, **kwargs):
        calls.append(list(args))
        # _run_git 内部以 ["git", *args] 调用，故子命令在 args[1]
        if args[1] == "commit":
            return _cp(stdout="")
        if args[1] == "rev-parse":
            return _cp(stdout="deadbeef")
        return _cp(stdout="")

    with patch.object(git_tools.subprocess, "run", side_effect=fake_run):
        res = await git_tools.git_commit_executor(
            {"message": "feat: x", "repo_path": str(repo), "files": ["a.py", "b.py"]}
        )
    assert res.success is True
    # 断言 add 仅作用于指定文件，且 commit -m 参数化传入 message（无 shell 拼接）
    add_call = next(c for c in calls if len(c) > 1 and c[1] == "add")
    assert "a.py" in add_call and "b.py" in add_call
    commit_call = next(c for c in calls if len(c) > 1 and c[1] == "commit")
    assert commit_call[2] == "-m" and commit_call[3] == "feat: x"
    assert res.metadata["commit"] == "deadbeef"


async def test_git_commit_nothing_to_commit():
    fake = _cp(stderr="nothing to commit, working tree clean", returncode=1)
    with patch.object(git_tools.subprocess, "run", return_value=fake):
        res = await git_tools.git_commit_executor({"message": "x", "repo_path": "."})
    assert res.success is True
    assert res.metadata["nothing_to_commit"] is True


# --------------------------------------------------------------------------- #
# code_review 接入 git diff（P1-2）
# --------------------------------------------------------------------------- #
async def test_code_review_git_repo_reviews_changed(tmp_path: Path, monkeypatch):
    (tmp_path / ".git").mkdir()
    changed_file = tmp_path / "changed.py"
    changed_file.write_text("def foo():\n    password = 'secret123'\n    return 1\n", encoding="utf-8")

    def fake_run(args, **kwargs):
        # 仅 git diff --name-only 返回改动文件名（注意实际参数为 --name-only）
        if "--name-only" in args:
            return _cp(stdout="changed.py")
        return _cp(stdout="")

    import agent.tools.code_tools as code_tools

    with patch.object(code_tools.subprocess, "run", side_effect=fake_run), \
         patch.object(code_tools, "_run_llm_review", return_value=[]):
        res = await code_tools.code_review_executor({"git_repo": str(tmp_path)})
    assert res.success is True
    assert any("changed.py" in f for f in res.metadata["changed_files"])
    # 安全规则应抓到硬编码密码
    assert res.metadata["total_findings"] >= 1
