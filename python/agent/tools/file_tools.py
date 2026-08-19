from __future__ import annotations

import difflib
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)
from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
_log = StructuredLogger("tools.file")

# P2-7（审计 §3.3）：read-before-edit 安全约束。
# 记录本进程内已通过 file_read 读取过的文件绝对路径；编辑工具在写入前校验，
# 避免"盲改"未见过内容的文件。bypass_read_check 参数提供程序化写入的安全阀。
_READ_FILES: set[str] = set()


def _mark_read(file_path: Path) -> None:
    _READ_FILES.add(str(file_path.resolve()))


def _read_before_edit_check(file_path: Path, create_if_missing: bool, bypass: bool) -> str | None:
    """返回错误描述（若违反 read-before-edit），否则 None。"""
    if bypass:
        return None
    if create_if_missing and not file_path.exists():
        return None  # 新建文件无需先读
    if str(file_path.resolve()) not in _READ_FILES:
        return f"编辑前请先使用 file_read 读取该文件（read-before-edit 安全约束）：{file_path}"
    return None


FILE_READ_DEF = ToolDefinition(
    name="file_read",
    description="读取指定文件的内容。适用场景：查看源代码文件、读取配置文件、获取文档内容。不适用：列出目录内容（用 file_list）、搜索文件（用 file_search）。",
    short_desc="读取文件内容",
    category=ToolCategory.FILE,
    tags=["file", "read", "code", "config"],
    scenes=["coding", "development", "research", "daily"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="要读取的文件路径（绝对路径或相对路径）"),
        ToolParameterDef(name="encoding", type="string", required=False, description="文件编码格式", enum=["utf-8", "ascii", "gbk"]),
        ToolParameterDef(name="offset", type="number", required=False, description="起始行号（从1开始）"),
        ToolParameterDef(name="limit", type="number", required=False, description="最多读取的行数，0表示全部"),
    ],
    risk_level="low",
)

FILE_LIST_DEF = ToolDefinition(
    name="file_list",
    description="列出指定目录下的文件和子目录。适用场景：浏览项目结构、查找文件位置。不适用：读取文件内容（用 file_read）、搜索文件内容（用 file_grep）。",
    short_desc="列出目录内容",
    category=ToolCategory.FILE,
    tags=["file", "directory", "list"],
    scenes=["coding", "development", "research", "daily"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="dir_path", type="string", description="目录路径"),
        ToolParameterDef(name="pattern", type="string", required=False, description="文件名匹配模式（glob语法）"),
        ToolParameterDef(name="recursive", type="boolean", required=False, description="是否递归列出子目录"),
        ToolParameterDef(name="max_depth", type="number", required=False, description="递归最大深度"),
    ],
    risk_level="low",
)

FILE_GREP_DEF = ToolDefinition(
    name="file_grep",
    description="在文件中搜索匹配的文本行。适用场景：查找代码中的变量定义、搜索日志中的错误信息。不适用：读取完整文件（用 file_read）、查找文件名（用 file_search）。",
    short_desc="搜索文件内容",
    category=ToolCategory.FILE,
    tags=["file", "search", "grep", "code", "debug"],
    scenes=["coding", "development", "research"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="pattern", type="string", description="搜索的正则表达式或关键词；ast 模式下为符号名/正则"),
        ToolParameterDef(name="path", type="string", required=False, description="搜索的文件或目录路径"),
        ToolParameterDef(name="file_pattern", type="string", required=False, description="文件名过滤模式，如 *.py"),
        ToolParameterDef(name="case_insensitive", type="boolean", required=False, description="是否忽略大小写"),
        ToolParameterDef(name="context", type="number", required=False, description="上下文行数（-C，前后各 N 行）"),
        ToolParameterDef(name="before", type="number", required=False, description="匹配前上下文行数（-B）"),
        ToolParameterDef(name="after", type="number", required=False, description="匹配后上下文行数（-A）"),
        ToolParameterDef(name="multiline", type="boolean", required=False, description="多行匹配（ripgrep -U --multiline-dotall，跨行正则）"),
        ToolParameterDef(name="mode", type="string", required=False, description="搜索模式", enum=["text", "ast"]),
        ToolParameterDef(name="language", type="string", required=False, description="ast 模式语言（默认 python）", enum=["python", "ts"]),
        ToolParameterDef(name="max_results", type="number", required=False, description="最大结果数"),
    ],
    risk_level="low",
)

FILE_SEARCH_DEF = ToolDefinition(
    name="file_search",
    description=(
        "按文件名搜索文件。支持 glob 模式、多模式（空白/逗号分隔）与模糊匹配兜底。"
        "适用场景：查找项目中的配置文件、定位源代码文件。"
        "不适用：搜索文件内容（用 file_grep）、列出目录（用 file_list）。"
    ),
    short_desc="按文件名搜索",
    category=ToolCategory.FILE,
    tags=["file", "search", "find", "fuzzy"],
    scenes=["coding", "development", "research"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="pattern", type="string", description="文件名匹配模式，支持空白/逗号分隔的多模式"),
        ToolParameterDef(name="dir_path", type="string", required=False, description="搜索的根目录"),
        ToolParameterDef(name="max_results", type="number", required=False, description="最大结果数"),
        ToolParameterDef(name="fuzzy", type="boolean", required=False, description="无精确命中时启用模糊匹配兜底，默认true"),
        ToolParameterDef(name="fuzzy_threshold", type="number", required=False, description="模糊匹配相似度阈值(0-1)，默认0.6"),
    ],
    risk_level="low",
)

FILE_EDIT_DEF = ToolDefinition(
    name="file_edit",
    description="编辑文件内容，支持全文替换或指定行范围替换。适用场景：修改代码、更新配置。不适用：创建新文件（用 file_write）、查看文件（用 file_read）。",
    short_desc="编辑文件内容",
    category=ToolCategory.FILE,
    tags=["file", "edit", "code", "write"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="要编辑的文件路径"),
        ToolParameterDef(name="old_text", type="string", description="要替换的原始文本"),
        ToolParameterDef(name="new_text", type="string", description="替换后的新文本"),
        ToolParameterDef(name="replace_all", type="boolean", required=False, description="是否替换所有匹配项"),
        ToolParameterDef(name="bypass_read_check", type="boolean", required=False, description="跳过 read-before-edit 校验（仅程序化写入新建文件时使用）"),
    ],
    risk_level="medium",
)


_MAX_FILE_SIZE = 2 * 1024 * 1024
_MAX_OUTPUT_LENGTH = 50000
_MAX_INCREMENTAL_EDITS = 20
_MAX_MULTI_FILE_COUNT = 50


INCREMENTAL_EDIT_DEF = ToolDefinition(
    name="incremental_edit",
    description='增量修改代码文件，只修改需要改的部分，保持其他代码不变。支持语法验证和预览模式。适用场景：修改函数、添加功能、修复bug、重构局部代码。不适用：创建新文件、完全重写文件。',
    short_desc="增量修改代码文件",
    category=ToolCategory.FILE,
    tags=["file", "edit", "code", "incremental", "refactor"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="要修改的文件路径"),
        ToolParameterDef(name="edits", type="array", description='修改列表，每项包含 {search: "要替换的代码", replace: "新代码", description: "修改说明"}'),
        ToolParameterDef(name="create_if_missing", type="boolean", required=False, description="文件不存在时是否创建"),
        ToolParameterDef(name="preview_only", type="boolean", required=False, description="仅预览修改，不实际写入文件"),
        ToolParameterDef(name="validate_syntax", type="boolean", required=False, description="是否验证修改后的语法（仅支持TS/JS/Python）"),
        ToolParameterDef(name="bypass_read_check", type="boolean", required=False, description="跳过 read-before-edit 校验（仅程序化写入新建文件时使用）"),
    ],
    risk_level="medium",
)

MULTI_FILE_EDIT_DEF = ToolDefinition(
    name="multi_file_edit",
    description='同时修改多个文件，保持修改的原子性。适用场景：重构涉及多个文件、添加功能需要修改多处、API变更需要同步更新。不适用：单文件修改（用 incremental_edit）。',
    short_desc="多文件原子修改",
    category=ToolCategory.FILE,
    tags=["file", "edit", "multi-file", "refactor", "code"],
    scenes=["coding", "development"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="files", type="array", description='文件修改列表，每项包含 {path, edits: [{search, replace, description}]}'),
        ToolParameterDef(name="atomic", type="boolean", required=False, description="是否原子操作（任一失败则全部回滚）"),
        ToolParameterDef(name="bypass_read_check", type="boolean", required=False, description="跳过 read-before-edit 校验（仅程序化写入新建文件时使用）"),
    ],
    risk_level="high",
    permissions=["file_write"],
)


def _resolve_path(raw_path: str) -> Path:
    p = Path(raw_path).expanduser()
    if not p.is_absolute():
        # 尝试多种候选根目录，解决 TS 项目相对路径与 Python 进程 CWD 不一致的问题
        project_root = Path(os.environ.get("PROJECT_ROOT", Path(__file__).resolve().parent.parent.parent))
        python_root = project_root / "python"
        cwd = Path(os.getcwd()).parent.parent  # 从 python/ 往上两级到项目根
        cwd_project = cwd if cwd != python_root else project_root
        for base in [cwd_project, project_root, python_root, Path(os.getcwd())]:
            candidate = base / p
            if candidate.exists():
                return candidate.resolve()
        # 都没有找到就 fallback
        p = Path(os.getcwd()) / p
    return p.resolve()


async def file_read_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    raw_path = str(params.get("file_path", ""))
    encoding = str(params.get("encoding", "utf-8"))
    offset = max(1, int(params.get("offset", 1)))
    limit = int(params.get("limit", 0))

    if not raw_path:
        return ToolResult(success=False, error="文件路径不能为空")

    file_path = _resolve_path(raw_path)

    if not file_path.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    if not file_path.is_file():
        return ToolResult(success=False, error=f"路径不是文件: {file_path}")

    if file_path.stat().st_size > _MAX_FILE_SIZE:
        return ToolResult(success=False, error=f"文件过大（>{_MAX_FILE_SIZE // 1024 // 1024}MB）")

    try:
        content = file_path.read_text(encoding=encoding, errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}")

    lines = content.splitlines(keepends=True)
    total_lines = len(lines)

    start_idx = offset - 1
    end_idx = start_idx + limit if limit > 0 else total_lines
    selected = lines[start_idx:end_idx]

    numbered: list[str] = []
    for i, line in enumerate(selected, start=offset):
        numbered.append(f"{i:6d}\t{line.rstrip()}")

    output = "\n".join(numbered)
    if len(output) > _MAX_OUTPUT_LENGTH:
        output = output[:_MAX_OUTPUT_LENGTH] + f"\n... (截断，共 {total_lines} 行)"

    _mark_read(file_path)
    return ToolResult(
        success=True,
        output=output,
        duration=time.time() - start,
        metadata={"total_lines": total_lines, "file_path": str(file_path)},
    )


async def file_list_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    # 兼容 TS 前端的 "directory" 参数名和 Python 后端的 "dir_path"
    raw_dir = str(params.get("dir_path") or params.get("directory", "."))
    pattern = str(params.get("pattern", "*"))
    recursive = bool(params.get("recursive", False))
    max_depth = int(params.get("max_depth", 3))

    dir_path = _resolve_path(raw_dir)

    if not dir_path.exists():
        return ToolResult(success=False, error=f"目录不存在: {dir_path}")

    if not dir_path.is_dir():
        return ToolResult(success=False, error=f"路径不是目录: {dir_path}")

    _IGNORE_DIRS = {
        "node_modules", ".git", "dist", "build", "__pycache__",
        ".venv", "venv", ".mypy_cache", ".pytest_cache", ".next",
        "data", ".checkpoints", "coverage",
    }

    entries: list[str] = []
    try:
        if recursive:
            for root, dirs, files in os.walk(dir_path):
                rel_root = Path(root).relative_to(dir_path)
                depth = len(rel_root.parts)
                if depth >= max_depth:
                    dirs.clear()
                    continue
                dirs[:] = [d for d in dirs if d not in _IGNORE_DIRS and not d.startswith(".")]
                for d in sorted(dirs):
                    entries.append(f"📁 {rel_root / d}/")
                for f in sorted(files):
                    if Path(f).match(pattern) or pattern == "*":
                        entries.append(f"📄 {rel_root / f}")
        else:
            for item in sorted(dir_path.iterdir()):
                name = item.name
                if name.startswith(".") or name in _IGNORE_DIRS:
                    continue
                if item.is_dir():
                    entries.append(f"📁 {name}/")
                else:
                    entries.append(f"📄 {name}")
    except PermissionError:
        return ToolResult(success=False, error=f"无权限访问: {dir_path}")

    if not entries:
        return ToolResult(success=True, output="目录为空")

    output = f"{dir_path} ({len(entries)} 项)\n" + "\n".join(entries[:200])
    return ToolResult(
        success=True,
        output=output,
        duration=time.time() - start,
        metadata={"entry_count": len(entries)},
    )


async def file_grep_executor(params: dict[str, Any]) -> ToolResult:
    """在文件中搜索文本（优先 ripgrep，支持上下文/多行；回退纯 Python）/ AST 符号。"""
    start = time.time()
    pattern = str(params.get("pattern", ""))
    raw_path = str(params.get("path") or params.get("directory", "."))
    file_pattern = str(params.get("file_pattern", "*"))
    case_insensitive = bool(params.get("case_insensitive") or params.get("ignore_case", False))
    max_results = int(params.get("max_results", 50))
    ctx = params.get("context")
    before = int(params.get("before", 0) or 0)
    after = int(params.get("after", 0) or 0)
    multiline = bool(params.get("multiline", False))
    mode = str(params.get("mode", "text")).lower()
    language = str(params.get("language", "python")).lower()

    if not pattern:
        return ToolResult(success=False, error="搜索模式不能为空")
    if ctx is not None:
        before = after = int(ctx)

    search_path = _resolve_path(raw_path)

    if mode == "ast":
        return await _ast_grep(pattern, search_path, language, max_results, start)

    rg = shutil.which("rg")
    if rg:
        try:
            return _rg_grep(rg, pattern, search_path, file_pattern, case_insensitive,
                            before, after, multiline, max_results, start)
        except Exception as e:
            _log.warning("ripgrep 调用失败，回退纯 Python 搜索", error=str(e))

    return _py_grep(pattern, search_path, file_pattern, case_insensitive, before, after, max_results, start)


def _rg_grep(rg, pattern, search_path, file_pattern, case_insensitive, before, after, multiline, max_results, start):
    args = [rg, "--line-number", "--with-filename", "--color", "never", "-e", pattern]
    if case_insensitive:
        args.append("-i")
    if before:
        args += ["-B", str(before)]
    if after:
        args += ["-A", str(after)]
    if multiline:
        args += ["-U", "--multiline-dotall"]
    if file_pattern and file_pattern != "*":
        args += ["--glob", file_pattern]
    args += [str(search_path)]
    proc = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=60)
    lines = (proc.stdout or "").splitlines()
    shown = lines[:max_results] if max_results else lines
    if not shown:
        return ToolResult(success=True, output="未找到匹配项")
    output = f"找到 {len(lines)} 处匹配（ripgrep）:\n" + "\n".join(shown)
    return ToolResult(success=True, output=output, duration=time.time() - start,
                      metadata={"match_count": len(lines), "engine": "ripgrep"})


def _py_grep(pattern, search_path, file_pattern, case_insensitive, before, after, max_results, start):
    import re
    flags = re.IGNORECASE if case_insensitive else 0
    try:
        regex = re.compile(pattern, flags)
    except re.error as e:
        return ToolResult(success=False, error=f"正则表达式无效: {e}")
    _IGNORE_DIRS = {"node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"}
    files: list[Path] = []
    if search_path.is_file():
        files = [search_path]
    elif search_path.is_dir():
        for root, dirs, fnames in os.walk(search_path):
            dirs[:] = [d for d in dirs if d not in _IGNORE_DIRS and not d.startswith(".")]
            for f in fnames:
                if file_pattern == "*" or Path(f).match(file_pattern):
                    files.append(Path(root) / f)
            if len(files) > 2000:
                break
    else:
        return ToolResult(success=False, error=f"路径不存在: {search_path}")
    matches: list[str] = []
    for fp in files:
        if len(matches) >= max_results:
            break
        try:
            content = fp.read_text(encoding="utf-8", errors="ignore")
        except Exception as e:
            log_ignored(_log, "file_tools._grep_read", e)
            continue
        flines = content.splitlines()
        for i, line in enumerate(flines, 1):
            if regex.search(line):
                rel = fp.relative_to(search_path) if search_path.is_dir() else fp.name
                block = []
                for j in range(max(1, i - before), min(len(flines), i + after) + 1):
                    prefix = ">" if j == i else " "
                    block.append(f"{rel}:{j}: {prefix} {flines[j - 1].strip()[:200]}")
                matches.append("\n".join(block))
                if len(matches) >= max_results:
                    break
    if not matches:
        return ToolResult(success=True, output="未找到匹配项")
    output = f"找到 {len(matches)} 处匹配（纯 Python）:\n" + "\n".join(matches)
    return ToolResult(success=True, output=output, duration=time.time() - start,
                      metadata={"match_count": len(matches), "engine": "python"})


async def _ast_grep(pattern, search_path, language, max_results, start):
    if language != "python":
        return ToolResult(success=False, error=f"ast 模式暂仅支持 python（收到: {language}）")
    import ast as _ast, re as _re
    sym = pattern.strip()
    rx = None
    if not sym.isidentifier():
        try:
            rx = _re.compile(sym)
        except _re.error:
            return ToolResult(success=False, error="ast 模式 pattern 需为标识符或合法正则")
    _IGNORE = {"node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"}
    hits: list[str] = []
    files: list[Path] = [search_path] if search_path.is_file() else []
    if search_path.is_dir():
        for p in search_path.rglob("*.py"):
            if any(s in p.parts for s in _IGNORE):
                continue
            files.append(p)
    for fp in files:
        if len(hits) >= max_results:
            break
        try:
            tree = _ast.parse(fp.read_text(encoding="utf-8", errors="replace"))
        except Exception as e:
            log_ignored(_log, "file_tools._symbol_scan_parse", e)
            continue
        for node in _ast.walk(tree):
            name = None
            kind = None
            if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
                name, kind = node.name, "def"
            elif isinstance(node, _ast.Name) and isinstance(getattr(node, "ctx", None), _ast.Store):
                name, kind = node.id, "assign"
            elif isinstance(node, _ast.arg):
                name, kind = node.arg, "arg"
            if name is None:
                continue
            if rx is not None:
                if not rx.search(name):
                    continue
            elif name != sym:
                continue
            hits.append(f"{fp}:{getattr(node, 'lineno', '?')}: {kind} {name}")
            if len(hits) >= max_results:
                break
    if not hits:
        return ToolResult(success=True, output="未找到符号")
    return ToolResult(success=True, output="AST 符号命中:\n" + "\n".join(hits),
                      duration=time.time() - start, metadata={"match_count": len(hits), "engine": "ast"})


def _file_name_match(
    filename: str,
    pattern: str | list[str],
    fuzzy: bool = True,
    threshold: float = 0.72,
) -> bool:
    """文件名匹配——多策略融合，提升 file_search 召回率。

    依次尝试：大小写不敏感 glob → 子串 → token 全命中 → 模糊相似度。
    覆盖 LLM 常见误用：漏写通配符、大小写不符、拼写小偏差、多词拆分。
    支持多模式：pattern 为空白/逗号分隔的字符串或列表，任一命中即收录。
    """
    import fnmatch
    import re
    from difflib import SequenceMatcher

    if isinstance(pattern, str):
        sub_patterns = [p for p in pattern.replace(",", " ").split() if p] or [pattern]
    else:
        sub_patterns = [p for p in pattern if p]

    f_lower = filename.lower()
    stem = f_lower.rsplit(".", 1)[0]

    for p_raw in sub_patterns:
        p_lower = p_raw.lower()
        if fnmatch.fnmatch(f_lower, p_lower):
            return True
        if p_lower in f_lower:
            return True

        tokens = [t for t in re.split(r"[\s_\-\.]+", p_lower) if t]
        if tokens and all(t in f_lower for t in tokens):
            return True

        if fuzzy and len(p_lower) >= 3 and SequenceMatcher(None, p_lower, stem).ratio() >= threshold:
            return True

    return False


def _collect_all_files(dir_path: Path, max_scan: int = 4000) -> list[str]:
    """收集目录下全部文件名（用于无结果时的模糊建议）。"""
    _IGNORE_DIRS = {
        "node_modules", ".git", "dist", "build", "__pycache__",
        ".venv", "venv", ".mypy_cache", ".pytest_cache",
    }
    names: list[str] = []
    for root, dirs, files in os.walk(dir_path):
        dirs[:] = [d for d in dirs if d not in _IGNORE_DIRS and not d.startswith(".")]
        for f in files:
            names.append(f)
            if len(names) >= max_scan:
                return names
    return names


def _suggest_closest_files(
    dir_path: Path,
    pattern: str,
    top_n: int = 5,
    min_score: float = 0.3,
) -> str:
    """无精确命中时，给出最接近的文件名建议，避免"零结果"挫败。

    基于 difflib 相似度对全目录文件名排序，返回 top_n 个建议文本。
    无任何相近文件时返回 "未找到匹配文件。"。
    """
    from difflib import SequenceMatcher

    sub_patterns = [p for p in pattern.replace(",", " ").split() if p] or [pattern]
    names = _collect_all_files(dir_path)
    if not names:
        return "未找到匹配文件。"

    scored: list[tuple[float, str]] = []
    for name in names:
        stem = name.lower().rsplit(".", 1)[0]
        best = max(
            SequenceMatcher(None, p.lower(), stem).ratio() for p in sub_patterns
        )
        if best >= min_score:
            scored.append((best, name))

    if not scored:
        return "未找到匹配文件。"

    scored.sort(key=lambda x: x[0], reverse=True)
    lines = [f"未找到精确匹配，相近文件建议（模糊匹配）："]
    for score, name in scored[:top_n]:
        lines.append(f"  - {name} (相似度 {score:.2f})")
    return "\n".join(lines)


async def file_search_executor(params: dict[str, Any]) -> ToolResult:
    import json
    import logging
    from pathlib import Path
    start = time.time()
    # 兼容 TS 前端的 "query"/"filePattern" 参数名
    pattern = str(params.get("pattern") or params.get("query", ""))
    raw_dir = str(params.get("dir_path") or params.get("baseDir", "."))
    max_results = int(params.get("max_results") or params.get("maxResults", 30))
    fuzzy = bool(params.get("fuzzy", True))
    fuzzy_threshold = float(params.get("fuzzy_threshold", 0.72))

    # 创建logger用于记录file_search详细日志
    log = logging.getLogger("file_search")

    # 记录调用参数
    call_info = {
        "timestamp": time.time(),
        "pattern": pattern,
        "dir_path": raw_dir,
        "max_results": max_results,
    }
    log.debug(f"file_search called: {json.dumps(call_info)}")

    # 检查pattern是否为空
    if not pattern:
        log.warning(f"file_search failed: empty pattern, input={params}")
        return ToolResult(success=False, error="搜索模式不能为空")

    dir_path = _resolve_path(raw_dir)

    # 检查目录是否存在且是有效目录
    if not dir_path.exists():
        log.warning(f"file_search failed: directory not found, dir={dir_path}")
        return ToolResult(success=False, error=f"目录不存在: {dir_path}")

    if not dir_path.is_dir():
        log.warning(f"file_search failed: not a directory, path={dir_path}")
        return ToolResult(success=False, error=f"路径不是目录: {dir_path}")

    results: list[str] = []
    for root, dirs, files in os.walk(dir_path):
        dirs[:] = [d for d in dirs if d not in _IGNORE_DIRS and not d.startswith(".")]
        for f in files:
            if _file_name_match(f, pattern, fuzzy=fuzzy, threshold=fuzzy_threshold):
                rel = Path(root).relative_to(dir_path) / f
                results.append(str(rel))
                if len(results) >= max_results:
                    break
        if len(results) >= max_results:
            break

    if not results:
        log.warning(f"file_search completed with no results: pattern='{pattern}', dir='{raw_dir}'")
        suggestion = _suggest_closest_files(dir_path, pattern)
        return ToolResult(
            success=True,
            output=suggestion,
            duration=time.time() - start,
            metadata={"file_count": 0, "fuzzy_suggested": bool(suggestion)},
        )

    log.info(f"file_search success: found {len(results)} files for pattern='{pattern}'")
    output = f"找到 {len(results)} 个文件:\n" + "\n".join(results)
    return ToolResult(
        success=True,
        output=output,
        duration=time.time() - start,
        metadata={"file_count": len(results)},
    )


async def file_edit_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    raw_path = str(params.get("file_path", ""))
    old_text = str(params.get("old_text", ""))
    new_text = str(params.get("new_text", ""))
    replace_all = bool(params.get("replace_all", False))

    if not raw_path:
        return ToolResult(success=False, error="文件路径不能为空")
    if not old_text:
        return ToolResult(success=False, error="原始文本不能为空")

    file_path = _resolve_path(raw_path)

    if not file_path.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    bypass = bool(params.get("bypass_read_check", False))
    rb_err = _read_before_edit_check(file_path, create_if_missing=False, bypass=bypass)
    if rb_err:
        return ToolResult(success=False, error=rb_err)

    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}")

    count = content.count(old_text)
    if count == 0:
        return ToolResult(success=False, error="未找到要替换的文本")

    if not replace_all and count > 1:
        return ToolResult(
            success=False,
            error=f"old_text 匹配到 {count} 处，为避免静默替换请设置 replace_all=true 或提供更精确的 old_text",
        )

    if replace_all:
        new_content = content.replace(old_text, new_text)
    else:
        new_content = content.replace(old_text, new_text, 1)

    try:
        file_path.write_text(new_content, encoding="utf-8")
    except Exception as e:
        return ToolResult(success=False, error=f"写入失败: {e}")

    replaced = count if replace_all else 1
    return ToolResult(
        success=True,
        output=f"已替换 {replaced} 处匹配（共 {count} 处）",
        duration=time.time() - start,
        metadata={"replacements": replaced, "total_matches": count},
    )


def _validate_python_syntax(code: str) -> list[str]:
    errors: list[str] = []
    try:
        compile(code, "<incremental_edit>", "exec")
    except SyntaxError as e:
        errors.append(f"Python语法错误: 行{e.lineno}: {e.msg}")
    return errors


def _validate_js_ts_syntax(code: str, ext: str) -> list[str]:
    errors: list[str] = []
    open_braces = code.count("{")
    close_braces = code.count("}")
    if open_braces != close_braces:
        errors.append(f"花括号不匹配: {{ {open_braces} vs }} {close_braces}")
    open_parens = code.count("(")
    close_parens = code.count(")")
    if open_parens != close_parens:
        errors.append(f"圆括号不匹配: ( {open_parens} vs ) {close_parens}")
    open_brackets = code.count("[")
    close_brackets = code.count("]")
    if open_brackets != close_brackets:
        errors.append(f"方括号不匹配: [ {open_brackets} vs ] {close_brackets}")
    return errors


async def incremental_edit_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    raw_path = str(params.get("file_path", ""))
    edits_raw = params.get("edits", [])
    create_if_missing = bool(params.get("create_if_missing", False))
    preview_only = bool(params.get("preview_only", False))
    validate_syntax = bool(params.get("validate_syntax", False))

    if not raw_path:
        return ToolResult(success=False, error="文件路径不能为空")

    if not edits_raw or not isinstance(edits_raw, list):
        return ToolResult(success=False, error="请提供至少一个修改项")

    if len(edits_raw) > _MAX_INCREMENTAL_EDITS:
        return ToolResult(success=False, error=f"单次最多{_MAX_INCREMENTAL_EDITS}个修改项，请分批操作")

    edits: list[dict[str, str]] = []
    for e in edits_raw:
        if isinstance(e, dict) and e.get("search"):
            edits.append({
                "search": str(e["search"]),
                "replace": str(e.get("replace", "")),
                "description": str(e.get("description", "修改代码")),
            })

    if not edits:
        return ToolResult(success=False, error="没有有效的修改项（每个修改项必须包含search字段）")

    file_path = _resolve_path(raw_path)
    file_exists = file_path.exists()

    if not file_exists and not create_if_missing:
        return ToolResult(success=False, error=f"文件不存在: {file_path}。设置 create_if_missing=true 可创建新文件。")

    bypass = bool(params.get("bypass_read_check", False))
    rb_err = _read_before_edit_check(file_path, create_if_missing=create_if_missing, bypass=bypass)
    if rb_err:
        return ToolResult(success=False, error=rb_err)

    try:
        content = file_path.read_text(encoding="utf-8") if file_exists else ""
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}")

    original_content = content
    applied: list[dict[str, Any]] = []
    modified = False
    ambiguous: list[str] = []

    for edit in edits:
        search_text = edit["search"]
        replace_text = edit["replace"]
        desc = edit["description"]

        n = content.count(search_text)
        if n == 0:
            applied.append({"description": desc, "found": False})
        elif n > 1:
            # 多匹配：静默替换首处会破坏其它位置，直接报错要求更精确
            ambiguous.append(desc)
            applied.append({"description": desc, "found": True, "ambiguous": True})
        else:
            before = content[:content.index(search_text)]
            line_number = before.count("\n") + 1
            content = content.replace(search_text, replace_text, 1)
            preview_before = "\n".join(search_text.split("\n")[:3])
            preview_after = "\n".join(replace_text.split("\n")[:3])
            applied.append({
                "description": desc,
                "found": True,
                "line_number": line_number,
                "preview": f"行{line_number}:\n- {preview_before}\n+ {preview_after}",
            })
            modified = True

    if ambiguous:
        return ToolResult(
            success=False,
            error="以下修改项匹配到多处，为避免静默替换请提供更精确的 search 文本：\n"
            + "\n".join(f"- {d}" for d in ambiguous),
        )

    if not modified:
        not_found_list = "\n".join(f'- "{a["description"]}": 未找到' for a in applied)
        return ToolResult(success=False, error=f"未找到任何要修改的代码片段。\n{not_found_list}")

    if validate_syntax and not preview_only:
        ext = file_path.suffix.lower()
        syntax_errors: list[str] = []
        if ext == ".py":
            syntax_errors = _validate_python_syntax(content)
        elif ext in (".ts", ".tsx", ".js", ".jsx"):
            syntax_errors = _validate_js_ts_syntax(content, ext)
        if syntax_errors:
            errors_text = "\n".join(syntax_errors)
            return ToolResult(
                success=False,
                error=f"语法验证失败，修改未应用:\n{errors_text}\n\n建议：检查替换的代码是否完整，或设置 validate_syntax=false 跳过验证。",
                metadata={"syntax_errors": syntax_errors},
            )

    if preview_only:
        found_edits = [a for a in applied if a["found"]]
        preview_text = "\n\n".join(a["preview"] for a in found_edits)
        return ToolResult(
            success=True,
            output=f"预览模式 - 以下修改将被应用:\n{preview_text}\n\n共{len(found_edits)}处修改。设置 preview_only=false 以实际执行。",
            metadata={"preview": found_edits, "applied_count": len(found_edits)},
        )

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
    except Exception as e:
        return ToolResult(success=False, error=f"写入失败: {e}")

    found_edits = [a for a in applied if a["found"]]
    details = "\n".join(
        f"- {a['description']}: ✓ 行{a['line_number']}" if a["found"]
        else f"- {a['description']}: ✗ 未找到"
        for a in applied
    )
    return ToolResult(
        success=True,
        output=f"已修改 {file_path}\n应用的修改: {len(found_edits)}/{len(edits)}\n{details}",
        duration=time.time() - start,
        metadata={"applied_edits": found_edits, "applied_count": len(found_edits)},
    )


async def multi_file_edit_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    files_raw = params.get("files", [])
    atomic = bool(params.get("atomic", False))

    if not files_raw or not isinstance(files_raw, list):
        return ToolResult(success=False, error="请提供至少一个文件修改项")

    if len(files_raw) > _MAX_MULTI_FILE_COUNT:
        return ToolResult(success=False, error=f"单次最多修改{_MAX_MULTI_FILE_COUNT}个文件，请分批操作")

    results: list[dict[str, Any]] = []
    rollback_stack: list[tuple[Path, str]] = []

    for file_item in files_raw:
        if not isinstance(file_item, dict):
            results.append({"path": "未知路径", "success": False, "applied_count": 0, "error": "无效的文件修改项"})
            continue

        raw_path = str(file_item.get("path", ""))
        edits_raw = file_item.get("edits", [])

        if not raw_path:
            results.append({"path": raw_path or "未知路径", "success": False, "applied_count": 0, "error": "无效的文件路径"})
            continue

        file_path = _resolve_path(raw_path)

        bypass = bool(params.get("bypass_read_check", False))
        rb_err = _read_before_edit_check(file_path, create_if_missing=not file_path.exists(), bypass=bypass)
        if rb_err:
            results.append({"path": raw_path, "success": False, "applied_count": 0, "error": rb_err})
            continue

        try:
            file_exists = file_path.exists()
            content = file_path.read_text(encoding="utf-8") if file_exists else ""
            original_content = content

            applied_count = 0
            if isinstance(edits_raw, list):
                for edit in edits_raw:
                    if isinstance(edit, dict):
                        search_text = str(edit.get("search", ""))
                        replace_text = str(edit.get("replace", ""))
                        if search_text and search_text in content:
                            content = content.replace(search_text, replace_text, 1)
                            applied_count += 1

            if applied_count > 0:
                rollback_stack.append((file_path, original_content))
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(content, encoding="utf-8")
                results.append({"path": str(file_path), "success": True, "applied_count": applied_count})
            else:
                results.append({"path": str(file_path), "success": False, "applied_count": 0, "error": "未找到任何匹配的代码片段"})

        except Exception as e:
            results.append({"path": str(file_path), "success": False, "applied_count": 0, "error": str(e)})

    failures = [r for r in results if not r["success"]]

    if atomic and failures and rollback_stack:
        for file_path, original_content in rollback_stack:
            try:
                file_path.write_text(original_content, encoding="utf-8")
            except Exception as _exc:
                log_ignored(_log, "file_tools.multi_file_edit_executor", _exc)

        failure_details = "\n".join(f'{r["path"]}: {r["error"]}' for r in failures)
        return ToolResult(
            success=False,
            error=f"原子模式：部分修改失败，已回滚所有修改\n失败: {failure_details}",
            metadata={"results": results, "rolled_back": True},
        )

    success_count = sum(1 for r in results if r["success"])
    details = "\n".join(
        f'- {r["path"]}: ✓ {r["applied_count"]}处修改' if r["success"]
        else f'- {r["path"]}: ✗ {r["error"]}'
        for r in results
    )
    return ToolResult(
        success=len(failures) == 0,
        output=f"修改完成: {success_count}/{len(files_raw)} 个文件\n{details}",
        duration=time.time() - start,
        metadata={"results": results},
    )
