"""Git 链路工具集（审计 P1-2）。

提供结构化 Git 操作，替代「靠 shell_exec 拼 git 命令」的脆弱做法：
- git_status：解析 git status --porcelain 为 staged/modified/untracked 结构。
- git_diff：返回统一 diff 文本（支持 --staged 与工作区 diff）。
- git_commit：安全提交（参数化 message / 选择性 add，绝不拼接任意命令）。
- git_log：返回提交列表（oneline）。

所有命令以参数列表 + shell=False 执行，仅允许白名单子命令，规避注入。
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import ToolCategory, ToolDefinition, ToolParameterDef, ToolResult

_log = StructuredLogger("tools.git")


def _run_git(args: list[str], cwd: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        timeout=timeout,
        capture_output=True,
        text=True,
        check=False,
    )


def _resolve_repo(repo_path: str) -> tuple[Path | None, str | None]:
    if repo_path:
        base = Path(repo_path).expanduser().resolve()
    else:
        base = Path.cwd().resolve()
    for cand in [base, *base.parents]:
        if (cand / ".git").exists():
            return cand, None
    return None, f"不是 git 仓库（未在 {base} 或其父目录找到 .git）"


# --------------------------------------------------------------------------- #
# git_status
# --------------------------------------------------------------------------- #
GIT_STATUS_DEF = ToolDefinition(
    name="git_status",
    description="解析 git 工作区状态，返回暂存/修改/未跟踪文件清单。比 shell_exec 拼 `git status` 更结构化、可解析。",
    short_desc="查看 Git 状态",
    category=ToolCategory.CODE,
    tags=["git", "vcs", "code"],
    scenes=["coding", "development"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="repo_path", type="string", required=False, description="仓库路径（可选，默认当前目录）"),
    ],
    risk_level="low",
    permissions=["git:read"],
)


async def git_status_executor(params: dict[str, Any]) -> ToolResult:
    import time

    start = time.time()
    repo, err = _resolve_repo(str(params.get("repo_path", "") or ""))
    if err:
        return ToolResult(success=False, error=err, duration=time.time() - start)

    proc = _run_git(["status", "--porcelain", "-b"], str(repo))
    if proc.returncode != 0:
        return ToolResult(success=False, error=proc.stderr.strip() or "git status 失败", duration=time.time() - start)

    branch = "unknown"
    staged: list[str] = []
    modified: list[str] = []
    untracked: list[str] = []
    for line in proc.stdout.splitlines():
        if line.startswith("##"):
            branch = line[2:].strip().split("...")[0].strip()
            continue
        if len(line) < 4:
            continue
        x, y = line[0], line[1]
        f = line[3:].strip()
        if x == "?" and y == "?":
            untracked.append(f)
        elif x in ("M", "A", "D", "R", "C", "U") or y in ("M", "A", "D", "R", "C", "U"):
            staged.append(f)
            if y in ("M", "D"):
                modified.append(f)
        elif x == " " and y == "M":
            modified.append(f)

    summary = (
        f"分支: {branch}\n"
        f"暂存: {len(staged)}  修改(未暂存): {len(modified)}  未跟踪: {len(untracked)}\n"
        + ("\n".join(f"  [S] {f}" for f in staged) if staged else "")
        + ("\n".join(f"  [M] {f}" for f in modified) if modified else "")
        + ("\n".join(f"  [?] {f}" for f in untracked) if untracked else "")
    ).strip()
    return ToolResult(
        success=True,
        output=summary,
        duration=time.time() - start,
        metadata={
            "branch": branch,
            "staged": staged,
            "modified": modified,
            "untracked": untracked,
            "counts": {"staged": len(staged), "modified": len(modified), "untracked": len(untracked)},
        },
    )


# --------------------------------------------------------------------------- #
# git_diff
# --------------------------------------------------------------------------- #
GIT_DIFF_DEF = ToolDefinition(
    name="git_diff",
    description="返回统一格式 diff 文本。可查看工作区改动或已暂存改动（staged=true）。结构化封装，避免 shell 注入。",
    short_desc="查看 Git 差异",
    category=ToolCategory.CODE,
    tags=["git", "vcs", "diff", "code"],
    scenes=["coding", "development"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="repo_path", type="string", required=False, description="仓库路径（可选）"),
        ToolParameterDef(name="staged", type="boolean", required=False, description="查看已暂存改动，默认 false（工作区）"),
        ToolParameterDef(name="path", type="string", required=False, description="限定文件路径（可选）"),
    ],
    risk_level="low",
    permissions=["git:read"],
)


async def git_diff_executor(params: dict[str, Any]) -> ToolResult:
    import time

    start = time.time()
    repo, err = _resolve_repo(str(params.get("repo_path", "") or ""))
    if err:
        return ToolResult(success=False, error=err, duration=time.time() - start)

    args = ["diff"]
    if params.get("staged"):
        args.append("--staged")
    path = str(params.get("path", "") or "")
    if path:
        args.append("--")
        args.append(path)

    proc = _run_git(args, str(repo))
    if proc.returncode != 0:
        return ToolResult(success=False, error=proc.stderr.strip() or "git diff 失败", duration=time.time() - start)

    diff_text = proc.stdout
    added = diff_text.count("\n+") - diff_text.count("\n+++")
    removed = diff_text.count("\n-") - diff_text.count("\n---")
    return ToolResult(
        success=True,
        output=diff_text if diff_text.strip() else "(无差异)",
        duration=time.time() - start,
        metadata={"lines": len(diff_text.splitlines()), "added": max(added, 0), "removed": max(removed, 0)},
    )


# --------------------------------------------------------------------------- #
# git_commit
# --------------------------------------------------------------------------- #
GIT_COMMIT_DEF = ToolDefinition(
    name="git_commit",
    description="安全地创建 Git 提交。可 `all=true` 添加全部改动，或指定 `files` 列表；message 必填。命令参数化，绝不拼接任意 shell。",
    short_desc="创建 Git 提交",
    category=ToolCategory.CODE,
    tags=["git", "vcs", "commit", "code"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="message", type="string", description="提交说明（必填）"),
        ToolParameterDef(name="repo_path", type="string", required=False, description="仓库路径（可选）"),
        ToolParameterDef(name="all", type="boolean", required=False, description="git add -A 添加全部改动，默认 false"),
        ToolParameterDef(name="files", type="array", required=False, description="仅添加指定文件列表（与 all 互斥，优先 files）"),
    ],
    risk_level="high",
    permissions=["git:write"],
)


async def git_commit_executor(params: dict[str, Any]) -> ToolResult:
    import time

    start = time.time()
    message = str(params.get("message", "") or "").strip()
    if not message:
        return ToolResult(success=False, error="message 不能为空")

    repo, err = _resolve_repo(str(params.get("repo_path", "") or ""))
    if err:
        return ToolResult(success=False, error=err, duration=time.time() - start)

    # 1) 选择性 add（参数化，禁止任意路径注入）
    files = params.get("files") or []
    if isinstance(files, str):
        files = [files]
    if params.get("all"):
        add_proc = _run_git(["add", "-A"], str(repo))
        if add_proc.returncode != 0:
            return ToolResult(success=False, error=f"git add 失败: {add_proc.stderr.strip()}", duration=time.time() - start)
    elif files:
        safe_files = [str(f) for f in files if str(f).strip()][:200]
        if not safe_files:
            return ToolResult(success=False, error="files 为空")
        add_proc = _run_git(["add", "--", *safe_files], str(repo))
        if add_proc.returncode != 0:
            return ToolResult(success=False, error=f"git add 失败: {add_proc.stderr.strip()}", duration=time.time() - start)
    else:
        # 未指定 add 范围时，仅提交已暂存内容（不静默 add -A）
        pass

    # 2) 提交（message 作为参数传入，不进入 shell）
    commit_proc = _run_git(["commit", "-m", message], str(repo))
    if commit_proc.returncode != 0:
        stderr = (commit_proc.stderr or "").strip()
        if "nothing to commit" in stderr:
            return ToolResult(success=True, output="没有可提交的改动。", duration=time.time() - start,
                              metadata={"nothing_to_commit": True})
        return ToolResult(success=False, error=f"git commit 失败: {stderr}", duration=time.time() - start)

    # 3) 取本次提交 hash
    hash_proc = _run_git(["rev-parse", "HEAD"], str(repo))
    head = hash_proc.stdout.strip() if hash_proc.returncode == 0 else "unknown"
    return ToolResult(
        success=True,
        output=f"已提交: {head}\n{message}",
        duration=time.time() - start,
        metadata={"commit": head, "message": message},
    )


# --------------------------------------------------------------------------- #
# git_log
# --------------------------------------------------------------------------- #
GIT_LOG_DEF = ToolDefinition(
    name="git_log",
    description="返回提交历史（oneline），可限制条数与限定文件。结构化、可解析。",
    short_desc="查看 Git 提交历史",
    category=ToolCategory.CODE,
    tags=["git", "vcs", "log", "code"],
    scenes=["coding", "development"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="repo_path", type="string", required=False, description="仓库路径（可选）"),
        ToolParameterDef(name="max_count", type="integer", required=False, description="最大条数，默认 20，上限 200"),
        ToolParameterDef(name="path", type="string", required=False, description="仅查看某文件的提交（可选）"),
    ],
    risk_level="low",
    permissions=["git:read"],
)


async def git_log_executor(params: dict[str, Any]) -> ToolResult:
    import time

    start = time.time()
    repo, err = _resolve_repo(str(params.get("repo_path", "") or ""))
    if err:
        return ToolResult(success=False, error=err, duration=time.time() - start)

    try:
        max_count = max(1, min(int(params.get("max_count", 20)), 200))
    except (TypeError, ValueError):
        max_count = 20

    args = ["log", f"--max-count={max_count}", "--oneline"]
    path = str(params.get("path", "") or "")
    if path:
        args.append("--")
        args.append(path)

    proc = _run_git(args, str(repo))
    if proc.returncode != 0:
        return ToolResult(success=False, error=proc.stderr.strip() or "git log 失败", duration=time.time() - start)

    commits = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    return ToolResult(
        success=True,
        output="\n".join(commits) if commits else "(无提交历史)",
        duration=time.time() - start,
        metadata={"commits": commits, "count": len(commits)},
    )
