"""测试链路工具集（审计 P1-1）。

提供三个结构化工具，补齐 Agent「能写代码 → 能验证代码」的闭环：
- test_run：执行 pytest / jest / npm test 并解析结构化失败（不再依赖 shell_exec 拼命令）。
- test_generate：基于 AST 为目标源文件生成可编译的测试脚手架（函数 / 类级占位用例）。
- coverage_read：读取 lcov.info / coverage.xml / .coverage 并给出总行覆盖率与分文件明细。

所有外部命令均通过参数列表 + shell=False 执行，禁用任意命令拼装，规避命令注入。
"""

from __future__ import annotations

import asyncio
import ast
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import ToolCategory, ToolDefinition, ToolParameterDef, ToolResult

_log = StructuredLogger("tools.test")


# --------------------------------------------------------------------------- #
# 公共：子进程封装（便于测试 mock）
# --------------------------------------------------------------------------- #
def _run_subprocess(args: list[str], cwd: str, timeout: int) -> subprocess.CompletedProcess:
    """以 shell=False 运行命令，统一捕获 stdout/stderr。"""
    return subprocess.run(
        args,
        cwd=cwd,
        timeout=timeout,
        capture_output=True,
        text=True,
        check=False,
    )


def _resolve_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for parent in [cur, *cur.parents]:
        if (parent / ".git").exists():
            return parent
    return cur


# --------------------------------------------------------------------------- #
# test_run
# --------------------------------------------------------------------------- #
TEST_RUN_DEF = ToolDefinition(
    name="test_run",
    description=(
        "执行项目测试并返回结构化结果。支持 pytest（Python）/ jest（Node）/ npm test。"
        "自动探测框架或显式指定；解析通过/失败/错误数与失败用例名，不依赖 shell_exec 拼命令。"
        "适用于『改代码 → 跑测试 → 看失败』闭环。"
    ),
    short_desc="运行测试并解析结果",
    category=ToolCategory.CODE,
    tags=["test", "code", "verify", "pytest", "jest"],
    scenes=["coding", "development", "verification"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="framework", type="string", required=False,
                         description="测试框架：auto/pytest/jest/npm，默认 auto（依次探测）",
                         enum=["auto", "pytest", "jest", "npm"]),
        ToolParameterDef(name="path", type="string", required=False,
                         description="目标文件或目录（可选，留空则跑整个项目）"),
        ToolParameterDef(name="cwd", type="string", required=False,
                         description="运行工作目录（可选，默认当前目录）"),
        ToolParameterDef(name="timeout", type="integer", required=False,
                         description="超时秒数，默认 120，上限 600"),
    ],
    risk_level="medium",
    permissions=["test:run"],
)


def _build_test_command(framework: str, path: str) -> list[str]:
    if framework == "pytest":
        cmd = ["python", "-m", "pytest", "-q"]
        if path:
            cmd.append(path)
        return cmd
    if framework == "jest":
        cmd = ["npx", "jest"]
        if path:
            cmd.append(path)
        return cmd
    if framework == "npm":
        return ["npm", "test"]
    # auto：优先 pytest，回退 jest
    if path and (path.endswith(".ts") or path.endswith(".tsx") or path.endswith(".js")):
        return ["npx", "jest", path]
    return ["python", "-m", "pytest", "-q"] + ([path] if path else [])


def _parse_test_summary(text: str, framework: str) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "passed": 0, "failed": 0, "error": 0, "skipped": 0,
        "failed_tests": [],
    }
    if framework in ("pytest", "auto"):
        # 例如 "1 failed, 4 passed, 2 warnings in 0.12s"
        for key in ("passed", "failed", "error", "skipped"):
            m = re.search(rf"(\d+)\s+{key}", text)
            if m:
                summary[key] = int(m.group(1))
        # 失败用例名
        for line in text.splitlines():
            if line.strip().startswith("FAILED"):
                summary["failed_tests"].append(line.strip().split(" - ", 1)[0].replace("FAILED", "").strip())
    else:  # jest
        m = re.search(r"Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed", text)
        if m:
            summary["failed"] = int(m.group(1))
            summary["passed"] = int(m.group(2))
        for line in text.splitlines():
            if "✕" in line or "fail" in line.lower() and "●" in line:
                summary["failed_tests"].append(line.strip())
    return summary


async def test_run_executor(params: dict[str, Any]) -> ToolResult:
    import time

    start = time.time()
    framework = str(params.get("framework", "auto")).lower() or "auto"
    path = str(params.get("path", "") or "")
    cwd = str(params.get("cwd", "") or ".")
    try:
        timeout = max(5, min(int(params.get("timeout", 120)), 600))
    except (TypeError, ValueError):
        timeout = 120

    if framework not in ("auto", "pytest", "jest", "npm"):
        return ToolResult(success=False, error=f"不支持的 framework: {framework}")

    work_dir = Path(cwd).expanduser().resolve()
    if not work_dir.exists():
        return ToolResult(success=False, error=f"工作目录不存在: {cwd}")

    args = _build_test_command(framework, path)
    _log.info("执行测试", framework=framework, cwd=str(work_dir), command=" ".join(args))

    try:
        proc = await asyncio.to_thread(_run_subprocess, args, str(work_dir), timeout)
    except subprocess.TimeoutExpired:
        return ToolResult(
            success=False,
            error=f"测试执行超时（>{timeout}s）",
            duration=time.time() - start,
            metadata={"command": " ".join(args), "timeout": timeout},
        )
    except FileNotFoundError as e:
        return ToolResult(
            success=False,
            error=f"测试运行器不可用（{args[0]} 未安装？）: {e}",
            duration=time.time() - start,
            metadata={"command": " ".join(args)},
        )

    out = (proc.stdout or "") + (proc.stderr or "")
    summary = _parse_test_summary(out, framework)
    total = summary["passed"] + summary["failed"] + summary["error"]
    tail = "\n".join(out.splitlines()[-25:])

    ok = proc.returncode == 0
    return ToolResult(
        success=ok,
        output=(
            f"框架={framework} 命令={' '.join(args)}\n"
            f"通过={summary['passed']} 失败={summary['failed']} 错误={summary['error']} 跳过={summary['skipped']} 合计={total}\n"
            f"--- 输出尾段 ---\n{tail}"
        ),
        duration=time.time() - start,
        metadata={
            "framework": framework,
            "command": " ".join(args),
            "returncode": proc.returncode,
            "passed": summary["passed"],
            "failed": summary["failed"],
            "error": summary["error"],
            "skipped": summary["skipped"],
            "total": total,
            "failed_tests": summary["failed_tests"],
            "output_tail": tail,
        },
    )


# --------------------------------------------------------------------------- #
# test_generate（AST 脚手架）
# --------------------------------------------------------------------------- #
TEST_GENERATE_DEF = ToolDefinition(
    name="test_generate",
    description=(
        "为目标源文件（Python/JS/TS）生成可编译的测试脚手架：解析 AST，为每个顶层函数 / 类"
        "生成占位测试用例。产出为可直接运行的骨架，具体断言需由 Agent 补充。避免使用 LLM 调用，"
        "保证离线、可重现。"
    ),
    short_desc="生成测试脚手架",
    category=ToolCategory.CODE,
    tags=["test", "code", "generate", "scaffold"],
    scenes=["coding", "development", "verification"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="目标源文件路径"),
        ToolParameterDef(name="framework", type="string", required=False,
                         description="测试框架：pytest/unittest/jest，默认按扩展名推断",
                         enum=["pytest", "unittest", "jest"]),
        ToolParameterDef(name="output_path", type="string", required=False,
                         description="输出测试文件路径（可选，默认在源文件旁生成）"),
    ],
    risk_level="low",
    permissions=["test:generate"],
)


def _infer_test_framework(file_path: Path, framework: str) -> str:
    if framework and framework != "auto":
        return framework
    suffix = file_path.suffix.lower()
    if suffix == ".py":
        return "pytest"
    if suffix in (".ts", ".tsx", ".js", ".jsx"):
        return "jest"
    return "pytest"


def _python_scaffold(src: str, module_name: str, framework: str) -> str:
    tree = ast.parse(src)
    lines: list[str] = []
    if framework == "unittest":
        lines.append("import unittest")
        lines.append(f"import {module_name}")
        lines.append("")
        lines.append("")
        lines.append(f"class Test{module_name.title().replace('_', '')}(unittest.TestCase):")
        wrote = False
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and not node.name.startswith("_"):
                lines.append(f"    def test_{node.name}(self):")
                lines.append("        # TODO: 补充断言")
                lines.append("        self.assertTrue(True)")
                wrote = True
            elif isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
                lines.append(f"    def test_{node.name}_instantiates(self):")
                lines.append(f"        # TODO: 补充断言")
                lines.append(f"        self.assertIsNotNone({module_name}.{node.name})")
                wrote = True
        if not wrote:
            lines.append("    pass")
        return "\n".join(lines) + "\n"

    # pytest 风格
    lines.append(f"import {module_name}")
    lines.append("")
    lines.append("")
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and not node.name.startswith("_"):
            lines.append(f"def test_{node.name}():")
            lines.append("    # TODO: 补充断言")
            lines.append("    assert True")
            lines.append("")
        elif isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
            lines.append(f"class Test{node.name}:")
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and not sub.name.startswith("_"):
                    lines.append(f"    def test_{sub.name}(self):")
                    lines.append("        # TODO: 补充断言")
                    lines.append("        assert True")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _js_scaffold(src: str, module_name: str) -> str:
    return _js_scaffold_regex(src, module_name)


def _js_scaffold_regex(src: str, module_name: str) -> str:
    names: list[str] = []
    for m in re.finditer(r"(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)", src):
        names.append(m.group(1))
    for m in re.finditer(r"export\s+(?:default\s+)?class\s+([A-Za-z_]\w*)", src):
        names.append(m.group(1))
    if not names:
        for m in re.finditer(r"(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:\(|async)", src):
            names.append(m.group(1))
    lines = ["// 自动生成的测试脚手架（占位用例，需补充断言）", ""]
    if names:
        joined = ", ".join(sorted(set(names)))
        lines.append(f'import {{ {joined} }} from "./{module_name}";')
    else:
        lines.append(f"import * as {module_name} from './{module_name}';")
    lines.append("")
    lines.append(f"describe('{module_name}', () => {{")
    if names:
        for n in sorted(set(names)):
            lines.append(f"  it('{n}', () => {{")
            lines.append("    // TODO: 补充断言")
            lines.append("    expect(true).toBe(true);")
            lines.append("  });")
    else:
        lines.append("  it('placeholder', () => { expect(true).toBe(true); });")
    lines.append("});")
    lines.append("")
    return "\n".join(lines)


async def test_generate_executor(params: dict[str, Any]) -> ToolResult:
    import time

    start = time.time()
    raw_path = str(params.get("file_path", ""))
    if not raw_path:
        return ToolResult(success=False, error="file_path 不能为空")
    file_path = Path(raw_path).expanduser().resolve()
    if not file_path.exists():
        return ToolResult(success=False, error=f"文件不存在: {file_path}")

    try:
        src = file_path.read_text(encoding="utf-8")
    except Exception as e:
        return ToolResult(success=False, error=f"读取失败: {e}", duration=time.time() - start)

    framework = _infer_test_framework(file_path, str(params.get("framework", "auto") or "auto"))
    module_name = file_path.stem
    if module_name.startswith("test_") or module_name.endswith("_test"):
        module_name = re.sub(r"^(test_)|(_test)$", "", module_name)

    try:
        if framework == "jest":
            scaffold = _js_scaffold(src, module_name)
        else:
            scaffold = _python_scaffold(src, module_name, framework)
    except SyntaxError as e:
        return ToolResult(success=False, error=f"源文件语法有误，无法生成脚手架: {e}",
                          duration=time.time() - start)

    out_path = params.get("output_path")
    out_file = Path(str(out_path)).expanduser().resolve() if out_path else file_path.parent / f"test_{file_path.stem}.py"
    if out_file.exists():
        return ToolResult(
            success=False,
            error=f"输出文件已存在，避免覆盖: {out_file}",
            duration=time.time() - start,
            metadata={"output_path": str(out_file)},
        )
    try:
        out_file.write_text(scaffold, encoding="utf-8")
    except Exception as e:
        return ToolResult(success=False, error=f"写入测试文件失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=True,
        output=f"已生成测试脚手架: {out_file}\n框架={framework}\n\n{scaffold}",
        duration=time.time() - start,
        metadata={"output_path": str(out_file), "framework": framework, "lines": scaffold.count(chr(10)) + 1},
    )


# --------------------------------------------------------------------------- #
# coverage_read
# --------------------------------------------------------------------------- #
COVERAGE_READ_DEF = ToolDefinition(
    name="coverage_read",
    description=(
        "读取测试覆盖率数据并给出总覆盖率与分文件明细。支持三种格式："
        "lcov.info、coverage.xml（Cobertura）、.coverage（SQLite，需 coverage 包）。"
        "返回 total_pct 与各文件 line_pct / missing_lines，便于定位未覆盖代码。"
    ),
    short_desc="读取测试覆盖率",
    category=ToolCategory.CODE,
    tags=["test", "coverage", "verify"],
    scenes=["coding", "development", "verification"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="path", type="string", description="覆盖率文件路径（lcov.info / coverage.xml / .coverage）"),
        ToolParameterDef(name="source_filter", type="string", required=False,
                         description="仅返回路径包含该子串的文件（可选）"),
    ],
    risk_level="low",
    permissions=["test:coverage"],
)


def _parse_lcov(text: str) -> dict[str, Any]:
    files: dict[str, dict[str, int]] = {}
    cur: dict[str, int] = {}
    cur_file = ""
    for line in text.splitlines():
        if line.startswith("SF:"):
            cur_file = line[3:].strip()
            cur = {"lf": 0, "lh": 0}
            files[cur_file] = cur
        elif line.startswith("LF:"):
            cur["lf"] = int(line[3:].strip())
        elif line.startswith("LH:"):
            cur["lh"] = int(line[3:].strip())
    total_lf = sum(f["lf"] for f in files.values())
    total_lh = sum(f["lh"] for f in files.values())
    per_file = {}
    for f, v in files.items():
        pct = round(100.0 * v["lh"] / v["lf"], 2) if v["lf"] else 0.0
        per_file[f] = {"line_pct": pct, "lines": v["lf"], "hit": v["lh"]}
    total_pct = round(100.0 * total_lh / total_lf, 2) if total_lf else 0.0
    return {"total_pct": total_pct, "files": per_file}


def _parse_cobertura(xml_text: str) -> dict[str, Any]:
    root = ET.fromstring(xml_text)
    per_file: dict[str, Any] = {}
    total_lp = 0.0
    total_lh = 0.0
    for cls in root.iter("class"):
        fn = cls.get("filename")
        if not fn:
            continue
        lm = cls.find("lines")
        if lm is None:
            continue
        lines = lm.findall("line")
        total = len(lines)
        hit = sum(1 for ln in lines if int(ln.get("hits", "0")) > 0)
        pct = round(100.0 * hit / total, 2) if total else 0.0
        per_file[fn] = {"line_pct": pct, "lines": total, "hit": hit}
        total_lp += total
        total_lh += hit
    total_pct = round(100.0 * total_lh / total_lp, 2) if total_lp else 0.0
    return {"total_pct": total_pct, "files": per_file}


def _parse_sqlite_coverage(db_path: str) -> dict[str, Any]:
    try:
        import coverage
        from coverage.data import CoverageData
    except ImportError:
        raise RuntimeError("读取 .coverage 需要安装 coverage 包（pip install coverage）")
    data = CoverageData(db_path)
    data.read()
    per_file: dict[str, Any] = {}
    total_lines = 0
    total_missing = 0
    for f in data.measured_files():
        n = len(data.arcs(f) if data.has_arcs() else [])
        # .coverage 存的是行号集合；用 line_counts 更准确
        line_counts = data.line_counts(f)
        statements = len(line_counts)
        missing = len(data.missing_lines(f))
        hit = statements - missing
        pct = round(100.0 * hit / statements, 2) if statements else 0.0
        per_file[f] = {"line_pct": pct, "lines": statements, "hit": hit, "missing": missing}
        total_lines += statements
        total_missing += missing
    total_pct = round(100.0 * (total_lines - total_missing) / total_lines, 2) if total_lines else 0.0
    return {"total_pct": total_pct, "files": per_file}


async def coverage_read_executor(params: dict[str, Any]) -> ToolResult:
    import time

    start = time.time()
    raw_path = str(params.get("path", ""))
    if not raw_path:
        return ToolResult(success=False, error="path 不能为空")
    cov_file = Path(raw_path).expanduser().resolve()
    if not cov_file.exists():
        return ToolResult(success=False, error=f"覆盖率文件不存在: {cov_file}")

    source_filter = str(params.get("source_filter", "") or "")

    try:
        if cov_file.suffix == ".info" or cov_file.name == "lcov":
            result = _parse_lcov(cov_file.read_text(encoding="utf-8", errors="replace"))
        elif cov_file.suffix == ".xml" or cov_file.name == "coverage.xml":
            result = _parse_cobertura(cov_file.read_text(encoding="utf-8", errors="replace"))
        elif cov_file.name == ".coverage":
            result = _parse_sqlite_coverage(str(cov_file))
        else:
            return ToolResult(success=False, error=f"不支持的覆盖率格式: {cov_file.name}（支持 lcov.info / coverage.xml / .coverage）")
    except Exception as e:
        return ToolResult(success=False, error=f"解析覆盖率失败: {e}", duration=time.time() - start)

    if source_filter:
        result["files"] = {k: v for k, v in result["files"].items() if source_filter in k}

    ranked = sorted(result["files"].items(), key=lambda kv: kv[1]["line_pct"])
    report = [f"总覆盖率: {result['total_pct']}%  （筛选后 {len(result['files'])} 个文件）", ""]
    for f, v in ranked[:30]:
        report.append(f"  {v['line_pct']:6.2f}%  {f}  ({v['hit']}/{v.get('lines', 0)})")
    if len(ranked) > 30:
        report.append(f"  ... 其余 {len(ranked) - 30} 个文件省略")

    return ToolResult(
        success=True,
        output="\n".join(report),
        duration=time.time() - start,
        metadata=result,
    )
