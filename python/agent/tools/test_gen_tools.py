"""自动测试生成闭环工具集。

提供测试分析、生成、执行、迭代修复和覆盖率分析五大工具，
实现从源码分析到测试通过的全闭环自动化。

Tools:
    test_gen_analyze: 分析目标代码，识别需要测试的函数/类。
    test_gen_generate: 为指定函数生成测试代码。
    test_gen_execute: 执行测试并收集结果。
    test_gen_iterate: 闭环迭代——执行→分析失败→修复→重新执行。
    test_gen_coverage: 分析测试覆盖率。
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)

_log = StructuredLogger("tools.test_gen")


# ==================== LLM 辅助函数 ====================


def _get_llm():
    """获取全局LLM实例。

    Returns:
        LLM实例或None。
    """
    from agent.main import engine
    if engine and hasattr(engine, "llm") and engine.llm:
        return engine.llm
    return None


# ==================== AST 解析辅助 ====================


def _parse_python_ast(code: str) -> ast.Module | None:
    """安全解析Python代码为AST。

    Args:
        code: Python源代码字符串。

    Returns:
        ast.Module | None: 解析成功返回AST模块节点，失败返回None。
    """
    try:
        return ast.parse(code)
    except SyntaxError:
        return None


def _extract_public_symbols(tree: ast.Module) -> list[dict[str, Any]]:
    """从AST中提取所有公共函数和类方法。

    提取规则：非下划线开头的函数/方法视为公共符号。

    Args:
        tree: 已解析的AST模块节点。

    Returns:
        list[dict]: 公共符号列表，每项包含 kind/name/args/docstring/line。
    """
    symbols: list[dict[str, Any]] = []

    for node in ast.iter_child_nodes(tree):
        # 顶层公共函数
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not node.name.startswith("_"):
                args = [a.arg for a in node.args.args]
                docstring = ast.get_docstring(node) or ""
                symbols.append({
                    "kind": "function",
                    "name": node.name,
                    "class": None,
                    "args": args,
                    "docstring": docstring,
                    "line": node.lineno,
                    "is_async": isinstance(node, ast.AsyncFunctionDef),
                })
        # 类及其公共方法
        elif isinstance(node, ast.ClassDef):
            if not node.name.startswith("_"):
                class_doc = ast.get_docstring(node) or ""
                symbols.append({
                    "kind": "class",
                    "name": node.name,
                    "class": None,
                    "args": [],
                    "docstring": class_doc,
                    "line": node.lineno,
                    "is_async": False,
                })
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        if not item.name.startswith("_"):
                            args = [a.arg for a in item.args.args if a.arg != "self"]
                            docstring = ast.get_docstring(item) or ""
                            symbols.append({
                                "kind": "method",
                                "name": f"{node.name}.{item.name}",
                                "class": node.name,
                                "args": args,
                                "docstring": docstring,
                                "line": item.lineno,
                                "is_async": isinstance(item, ast.AsyncFunctionDef),
                            })

    return symbols


def _extract_imports(tree: ast.Module) -> list[str]:
    """从AST中提取导入语句文本。

    Args:
        tree: 已解析的AST模块节点。

    Returns:
        list[str]: 导入语句列表。
    """
    imports: list[str] = []
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.Import):
            imports.append(f"import {', '.join(a.name for a in node.names)}")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            names = ", ".join(a.name for a in node.names if a.name)
            imports.append(f"from {module} import {names}")
    return imports


def _check_existing_coverage(
    source_path: Path, symbols: list[dict[str, Any]], language: str
) -> dict[str, bool]:
    """检查已有测试是否覆盖了指定符号。

    Args:
        source_path: 源文件路径。
        symbols: 公共符号列表。
        language: 编程语言。

    Returns:
        dict[str, bool]: 符号名 → 是否已覆盖。
    """
    coverage: dict[str, bool] = {s["name"]: False for s in symbols}

    # 推断测试文件路径
    test_candidates = _infer_test_file_paths(source_path, language)

    for test_path in test_candidates:
        if not test_path.exists():
            continue
        try:
            test_code = test_path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            _log.warning("读取测试文件失败", path=str(test_path), error=str(e))
            continue
        # 在测试代码中搜索符号名
        for sym in symbols:
            if sym["name"] in test_code:
                coverage[sym["name"]] = True

    return coverage


def _infer_test_file_paths(source_path: Path, language: str) -> list[Path]:
    """根据源文件推断可能的测试文件路径。

    Args:
        source_path: 源文件路径。
        language: 编程语言。

    Returns:
        list[Path]: 候选测试文件路径列表。
    """
    candidates: list[Path] = []
    stem = source_path.stem
    parent = source_path.parent

    if language == "python":
        # tests/test_<module>.py
        project_root = _find_project_root(source_path)
        candidates.append(project_root / "tests" / f"test_{stem}.py")
        # 同目录 test_<module>.py
        candidates.append(parent / f"test_{stem}.py")
        # tests 目录下同名
        candidates.append(parent / "tests" / f"test_{stem}.py")
    elif language == "typescript":
        # <module>.test.ts
        candidates.append(parent / f"{stem}.test.ts")
        # __tests__ 目录
        candidates.append(parent / "__tests__" / f"{stem}.test.ts")

    return candidates


def _find_project_root(start: Path) -> Path:
    """向上查找项目根目录（含pyproject.toml/setup.py的目录）。

    Args:
        start: 起始路径。

    Returns:
        Path: 项目根目录。
    """
    current = start.parent
    for _ in range(10):
        if (current / "pyproject.toml").exists() or (current / "setup.py").exists():
            return current
        parent = current.parent
        if parent == current:
            break
        current = parent
    return start.parent


# ==================== 测试执行辅助 ====================


def _run_pytest(test_file: str, timeout: int) -> dict[str, Any]:
    """运行pytest并解析结果。

    Args:
        test_file: 测试文件路径。
        timeout: 超时秒数。

    Returns:
        dict: 包含 passed/failed/errors/total/output 的结果字典。
    """
    python_exe = os.environ.get("JBX_PYTHON", "python")
    try:
        result = subprocess.run(
            [python_exe, "-m", "pytest", test_file, "-v", "--tb=short", "--no-header"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"passed": 0, "failed": 0, "errors": 1, "total": 0,
                "output": f"pytest超时（{timeout}秒）"}
    except Exception as e:
        return {"passed": 0, "failed": 0, "errors": 1, "total": 0,
                "output": f"pytest执行失败: {e}"}

    output = result.stdout + result.stderr
    # 解析 pytest 摘要行: "X passed, Y failed, Z errors"
    passed = failed = errors = 0
    summary_match = re.search(r"(\d+) passed", output)
    if summary_match:
        passed = int(summary_match.group(1))
    fail_match = re.search(r"(\d+) failed", output)
    if fail_match:
        failed = int(fail_match.group(1))
    err_match = re.search(r"(\d+) error", output)
    if err_match:
        errors = int(err_match.group(1))

    return {
        "passed": passed,
        "failed": failed,
        "errors": errors,
        "total": passed + failed + errors,
        "output": output,
    }


def _run_jest(test_file: str, timeout: int) -> dict[str, Any]:
    """运行jest并解析结果。

    Args:
        test_file: 测试文件路径。
        timeout: 超时秒数。

    Returns:
        dict: 包含 passed/failed/errors/total/output 的结果字典。
    """
    try:
        result = subprocess.run(
            ["npx", "jest", test_file, "--verbose", "--no-coverage"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"passed": 0, "failed": 0, "errors": 1, "total": 0,
                "output": f"jest超时（{timeout}秒）"}
    except Exception as e:
        return {"passed": 0, "failed": 0, "errors": 1, "total": 0,
                "output": f"jest执行失败: {e}"}

    output = result.stdout + result.stderr
    # 解析 jest 摘要: "Tests: X failed, Y passed, Z total"
    passed = failed = errors = 0
    passed_match = re.search(r"(\d+) passed", output)
    if passed_match:
        passed = int(passed_match.group(1))
    failed_match = re.search(r"(\d+) failed", output)
    if failed_match:
        failed = int(failed_match.group(1))

    return {
        "passed": passed,
        "failed": failed,
        "errors": errors,
        "total": passed + failed,
        "output": output,
    }


# ==================== 工具定义 ====================


TEST_GEN_ANALYZE_DEF = ToolDefinition(
    name="test_gen_analyze",
    description="分析目标代码，识别需要测试的函数/类/方法，检查已有测试覆盖情况。适用场景：了解测试缺口、规划测试策略。不适用：生成测试代码（用test_gen_generate）、执行测试（用test_gen_execute）。",
    short_desc="分析测试覆盖缺口",
    category=ToolCategory.CODE,
    tags=["test", "analyze", "coverage", "gap"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="target_path", type="string", description="要分析的文件或目录路径"),
        ToolParameterDef(name="language", type="string", required=False, description="编程语言", enum=["python", "typescript"]),
        ToolParameterDef(name="framework", type="string", required=False, description="测试框架", enum=["pytest", "jest"]),
    ],
    risk_level="low",
)

TEST_GEN_GENERATE_DEF = ToolDefinition(
    name="test_gen_generate",
    description="为指定函数生成测试代码。使用AST解析源文件获取签名，结合LLM生成测试。适用场景：自动生成单元测试。不适用：分析覆盖缺口（用test_gen_analyze）、执行测试（用test_gen_execute）。",
    short_desc="生成测试代码",
    category=ToolCategory.CODE,
    tags=["test", "generate", "create", "unit"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="source_file", type="string", description="源文件路径"),
        ToolParameterDef(name="functions", type="string", required=False, description="要测试的函数列表，逗号分隔，空=全部"),
        ToolParameterDef(name="framework", type="string", required=False, description="测试框架", enum=["pytest", "jest"]),
        ToolParameterDef(name="output_file", type="string", required=False, description="输出测试文件路径，空=自动推断"),
    ],
    risk_level="medium",
)

TEST_GEN_EXECUTE_DEF = ToolDefinition(
    name="test_gen_execute",
    description="执行生成的测试，收集结果摘要。适用场景：验证测试是否通过。不适用：生成测试（用test_gen_generate）、迭代修复（用test_gen_iterate）。",
    short_desc="执行测试并收集结果",
    category=ToolCategory.CODE,
    tags=["test", "execute", "run", "verify"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="test_file", type="string", description="测试文件路径"),
        ToolParameterDef(name="timeout", type="number", required=False, description="超时秒数，默认60"),
        ToolParameterDef(name="framework", type="string", required=False, description="测试框架", enum=["pytest", "jest"]),
    ],
    risk_level="low",
)

TEST_GEN_ITERATE_DEF = ToolDefinition(
    name="test_gen_iterate",
    description="闭环迭代——执行测试→分析失败→修复测试→重新执行，直到全部通过或达到最大迭代次数。适用场景：自动修复测试失败。不适用：仅执行不修复（用test_gen_execute）。",
    short_desc="闭环迭代修复测试",
    category=ToolCategory.CODE,
    tags=["test", "iterate", "fix", "loop"],
    scenes=["coding", "development"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="test_file", type="string", description="测试文件路径"),
        ToolParameterDef(name="source_file", type="string", description="源文件路径"),
        ToolParameterDef(name="max_iterations", type="number", required=False, description="最大迭代次数，默认3"),
    ],
    risk_level="medium",
)

TEST_GEN_COVERAGE_DEF = ToolDefinition(
    name="test_gen_coverage",
    description="分析测试覆盖率。Python使用pytest --cov，TypeScript使用jest --coverage。适用场景：了解测试覆盖情况。不适用：分析缺口（用test_gen_analyze）。",
    short_desc="分析测试覆盖率",
    category=ToolCategory.CODE,
    tags=["test", "coverage", "metric"],
    scenes=["coding", "development"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="source_path", type="string", description="源文件或目录路径"),
        ToolParameterDef(name="test_path", type="string", required=False, description="测试文件路径"),
        ToolParameterDef(name="language", type="string", required=False, description="编程语言", enum=["python", "typescript"]),
    ],
    risk_level="low",
)


# ==================== 工具执行器 ====================


async def test_gen_analyze_executor(params: dict[str, Any]) -> ToolResult:
    """分析目标代码，识别需要测试的函数/类，检查已有覆盖。

    Args:
        params: 工具参数字典。

    Returns:
        ToolResult: 包含未覆盖符号列表和建议测试路径的结果。
    """
    start = time.time()
    target_path = str(params.get("target_path", ""))
    language = str(params.get("language", "python"))
    framework = str(params.get("framework", "pytest"))

    if not target_path:
        return ToolResult(success=False, error="目标路径不能为空")

    tp = Path(target_path).expanduser().resolve()
    if not tp.exists():
        return ToolResult(success=False, error=f"路径不存在: {target_path}")

    # 收集待分析的Python文件
    if tp.is_dir():
        if language == "python":
            files = sorted(tp.rglob("*.py"))
        else:
            files = sorted(tp.rglob("*.ts"))
    else:
        files = [tp]

    all_uncovered: list[dict[str, Any]] = []
    all_suggestions: list[str] = []

    for f in files:
        if language == "python":
            try:
                code = f.read_text(encoding="utf-8", errors="replace")
            except Exception as e:
                _log.warning("读取文件失败", path=str(f), error=str(e))
                continue
            tree = _parse_python_ast(code)
            if not tree:
                continue
            symbols = _extract_public_symbols(tree)
            if not symbols:
                continue
            coverage = _check_existing_coverage(f, symbols, language)
            for sym in symbols:
                if not coverage.get(sym["name"], False):
                    all_uncovered.append({
                        "file": str(f),
                        "kind": sym["kind"],
                        "name": sym["name"],
                        "args": sym["args"],
                        "line": sym["line"],
                    })
            # 建议测试路径
            test_candidates = _infer_test_file_paths(f, language)
            existing = [c for c in test_candidates if c.exists()]
            if existing:
                all_suggestions.append(f"{f.name} → 已有测试: {existing[0]}")
            else:
                all_suggestions.append(f"{f.name} → 建议创建: {test_candidates[0]}")
        else:
            # TypeScript: 基础文件级分析（不依赖AST深度解析）
            all_suggestions.append(f"{f.name} → (TypeScript需手动指定函数列表)")

    # 构建输出
    lines: list[str] = []
    lines.append(f"📋 测试覆盖分析: {tp}")
    lines.append(f"语言: {language} | 框架: {framework}")
    lines.append(f"分析文件: {len(files)} 个")
    lines.append(f"未覆盖符号: {len(all_uncovered)} 个")
    lines.append("")

    if all_uncovered:
        lines.append("未覆盖的函数/类/方法:")
        for item in all_uncovered[:50]:
            kind_label = {"function": "fn", "class": "cls", "method": "mt"}.get(
                item["kind"], "?"
            )
            lines.append(f"  [{kind_label}] {item['name']} (行{item['line']}) — {item['file']}")
        if len(all_uncovered) > 50:
            lines.append(f"  ... 还有 {len(all_uncovered) - 50} 个未显示")

    lines.append("")
    lines.append("建议测试文件:")
    for s in all_suggestions:
        lines.append(f"  {s}")

    return ToolResult(
        success=True,
        output="\n".join(lines),
        duration=time.time() - start,
        metadata={
            "uncovered_count": len(all_uncovered),
            "uncovered_symbols": all_uncovered[:100],
            "suggestions": all_suggestions,
        },
    )


async def test_gen_generate_executor(params: dict[str, Any]) -> ToolResult:
    """为指定函数生成测试代码。

    读取源文件AST提取签名，构建prompt发送LLM生成测试，
    写入输出文件或默认路径。

    Args:
        params: 工具参数字典。

    Returns:
        ToolResult: 包含生成测试代码和写入路径的结果。
    """
    start = time.time()
    source_file = str(params.get("source_file", ""))
    functions_str = str(params.get("functions", ""))
    framework = str(params.get("framework", "pytest"))
    output_file = str(params.get("output_file", ""))

    if not source_file:
        return ToolResult(success=False, error="源文件路径不能为空")

    sp = Path(source_file).expanduser().resolve()
    if not sp.exists():
        return ToolResult(success=False, error=f"源文件不存在: {source_file}")

    try:
        code = sp.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取源文件失败: {e}")

    # 解析AST
    tree = _parse_python_ast(code)
    if not tree:
        return ToolResult(success=False, error="源文件Python语法有误，无法解析AST")

    symbols = _extract_public_symbols(tree)
    imports = _extract_imports(tree)
    module_name = sp.stem

    # 筛选目标函数
    if functions_str:
        target_names = {n.strip() for n in functions_str.split(",") if n.strip()}
        target_symbols = [s for s in symbols if s["name"] in target_names]
    else:
        target_symbols = symbols

    if not target_symbols:
        return ToolResult(success=False, error="未找到目标函数/类，请检查functions参数或源文件")

    # 构建LLM prompt
    llm = _get_llm()
    if not llm:
        return ToolResult(success=True, output="LLM不可用，无法生成测试代码",
                          duration=time.time() - start)

    # 读取已有测试作为风格参考
    test_candidates = _infer_test_file_paths(sp, "python")
    existing_test_code = ""
    for tc in test_candidates:
        if tc.exists():
            try:
                existing_test_code = tc.read_text(encoding="utf-8", errors="replace")[:2000]
                break
            except Exception as e:
                # 读不到既有测试只是失去风格参考（可降级），但必须留痕，
                # 否则"生成的测试为何没沿用既有风格"无从排查。
                _log.warning("读取既有测试文件失败，将不参考其风格",
                             file=str(tc), error=f"{type(e).__name__}: {e}")

    # 构建签名信息
    sig_parts: list[str] = []
    for sym in target_symbols:
        if sym["kind"] == "class":
            sig_parts.append(f"class {sym['name']}")
        elif sym["kind"] == "method":
            args_str = ", ".join(sym["args"])
            sig_parts.append(f"def {sym['name']}(self, {args_str})")
        else:
            args_str = ", ".join(sym["args"])
            sig_parts.append(f"def {sym['name']}({args_str})")

    prompt_parts = [
        f"请为以下Python模块生成{framework}测试代码。",
        f"",
        f"模块: {module_name}",
        f"源文件: {sp}",
        f"",
        f"导入语句:\n" + "\n".join(f"  {imp}" for imp in imports),
        f"",
        f"需要测试的符号:\n" + "\n".join(f"  - {sig}" for sig in sig_parts),
    ]

    # 附加docstring信息
    docs = [s for s in target_symbols if s["docstring"]]
    if docs:
        prompt_parts.append("")
        prompt_parts.append("文档注释:")
        for d in docs:
            prompt_parts.append(f"  {d['name']}: {d['docstring'][:200]}")

    if existing_test_code:
        prompt_parts.append("")
        prompt_parts.append(f"已有测试代码（参考风格）:\n```python\n{existing_test_code}\n```")

    prompt_parts.append("")
    prompt_parts.append("要求:")
    prompt_parts.append("1. 使用pytest框架（def test_xxx风格）")
    prompt_parts.append(f"2. 导入源模块: from {module_name} import ...")
    prompt_parts.append("3. 每个函数/方法至少一个测试用例")
    prompt_parts.append("4. 包含正常情况和边界情况")
    prompt_parts.append("5. 如果有外部依赖，使用unittest.mock")
    prompt_parts.append("请只输出测试代码，用```python代码块包裹。")

    try:
        response = await llm.chat(
            messages=[{"role": "user", "content": "\n".join(prompt_parts)}],
            use_cache=False,
        )
        generated = response.get("content", "")
    except Exception as e:
        return ToolResult(success=False, error=f"LLM生成测试失败: {e}")

    # 提取代码块
    code_match = re.search(r"```(?:python)?\n([\s\S]*?)```", generated)
    test_code = code_match.group(1) if code_match else generated.strip()

    # 确定输出路径
    if output_file:
        op = Path(output_file).expanduser().resolve()
    else:
        project_root = _find_project_root(sp)
        op = project_root / "tests" / f"test_{module_name}.py"

    # 写入文件
    try:
        op.parent.mkdir(parents=True, exist_ok=True)
        op.write_text(test_code, encoding="utf-8")
    except Exception as e:
        return ToolResult(success=False, error=f"写入测试文件失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=True,
        output=f"测试代码已生成并写入: {op}\n\n测试符号: {', '.join(s['name'] for s in target_symbols)}",
        duration=time.time() - start,
        metadata={
            "output_file": str(op),
            "target_symbols": [s["name"] for s in target_symbols],
            "framework": framework,
        },
    )


async def test_gen_execute_executor(params: dict[str, Any]) -> ToolResult:
    """执行测试并收集结果摘要。

    Args:
        params: 工具参数字典。

    Returns:
        ToolResult: 包含通过/失败/错误统计的结果。
    """
    start = time.time()
    test_file = str(params.get("test_file", ""))
    timeout = int(params.get("timeout", 60))
    framework = str(params.get("framework", "pytest"))

    if not test_file:
        return ToolResult(success=False, error="测试文件路径不能为空")

    tp = Path(test_file).expanduser().resolve()
    if not tp.exists():
        return ToolResult(success=False, error=f"测试文件不存在: {test_file}")

    # 自动检测框架
    if framework == "pytest" and tp.suffix == ".ts":
        framework = "jest"
    elif framework == "jest" and tp.suffix == ".py":
        framework = "pytest"

    # 运行测试
    if framework == "pytest":
        result = _run_pytest(str(tp), timeout)
    else:
        result = _run_jest(str(tp), timeout)

    all_pass = result["failed"] == 0 and result["errors"] == 0
    # 截取关键输出（最后30行）
    output_lines = result["output"].splitlines()
    summary_output = "\n".join(output_lines[-30:])

    lines: list[str] = []
    lines.append(f"🧪 测试执行结果: {tp.name}")
    lines.append(f"框架: {framework} | 超时: {timeout}s")
    lines.append(f"通过: {result['passed']} | 失败: {result['failed']} | 错误: {result['errors']}")
    lines.append(f"总计: {result['total']}")
    if all_pass:
        lines.append("✅ 全部通过！")
    else:
        lines.append("❌ 存在失败或错误")
    lines.append("")
    lines.append("执行输出（末尾）:")
    lines.append(summary_output)

    return ToolResult(
        success=all_pass,
        output="\n".join(lines),
        duration=time.time() - start,
        metadata={
            "passed": result["passed"],
            "failed": result["failed"],
            "errors": result["errors"],
            "total": result["total"],
        },
    )


async def test_gen_iterate_executor(params: dict[str, Any]) -> ToolResult:
    """闭环迭代——执行测试→分析失败→修复测试→重新执行。

    Args:
        params: 工具参数字典。

    Returns:
        ToolResult: 包含迭代过程和最终结果的结果。
    """
    start = time.time()
    test_file = str(params.get("test_file", ""))
    source_file = str(params.get("source_file", ""))
    max_iterations = int(params.get("max_iterations", 3))

    if not test_file:
        return ToolResult(success=False, error="测试文件路径不能为空")
    if not source_file:
        return ToolResult(success=False, error="源文件路径不能为空")

    tp = Path(test_file).expanduser().resolve()
    sp = Path(source_file).expanduser().resolve()

    if not tp.exists():
        return ToolResult(success=False, error=f"测试文件不存在: {test_file}")
    if not sp.exists():
        return ToolResult(success=False, error=f"源文件不存在: {source_file}")

    # 读取源代码
    try:
        source_code = sp.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return ToolResult(success=False, error=f"读取源文件失败: {e}")

    framework = "pytest" if tp.suffix == ".py" else "jest"
    iteration_log: list[str] = []

    for i in range(1, max_iterations + 1):
        iteration_log.append(f"--- 迭代 {i}/{max_iterations} ---")

        # 执行测试
        if framework == "pytest":
            result = _run_pytest(str(tp), 60)
        else:
            result = _run_jest(str(tp), 60)

        passed = result["passed"]
        failed = result["failed"]
        errors = result["errors"]
        total = result["total"]
        iteration_log.append(f"结果: {passed}通过/{failed}失败/{errors}错误 (共{total})")

        # 全部通过则返回成功
        if failed == 0 and errors == 0:
            iteration_log.append("✅ 全部通过！")
            return ToolResult(
                success=True,
                output="\n".join(iteration_log),
                duration=time.time() - start,
                metadata={"iterations": i, "passed": passed, "total": total},
            )

        # 分析失败原因
        test_output = result["output"]
        fail_details = _extract_failure_details(test_output)
        iteration_log.append(f"失败详情:\n{fail_details[:500]}")

        # 使用LLM修复测试
        llm = _get_llm()
        if not llm:
            iteration_log.append("LLM不可用，无法自动修复，停止迭代")
            break

        # 读取当前测试代码
        try:
            current_test_code = tp.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            iteration_log.append(f"读取测试文件失败: {e}")
            break

        # 构建修复prompt
        prompt = (
            f"以下测试执行失败，请修复测试代码。\n\n"
            f"源代码:\n```python\n{source_code[:3000]}\n```\n\n"
            f"当前测试代码:\n```python\n{current_test_code[:3000]}\n```\n\n"
            f"失败输出:\n{test_output[:2000]}\n\n"
            f"常见修复方式:\n"
            f"1. 修正import路径\n"
            f"2. 修正函数调用参数\n"
            f"3. 添加mock或fixture\n"
            f"4. 修正断言预期值\n"
            f"5. 处理异步函数（async/await）\n\n"
            f"请输出修复后的完整测试代码，用```python代码块包裹。"
        )

        try:
            response = await llm.chat(
                messages=[{"role": "user", "content": prompt}],
                use_cache=False,
            )
            fix_content = response.get("content", "")
        except Exception as e:
            iteration_log.append(f"LLM修复请求失败: {e}")
            break

        # 提取修复后的代码
        code_match = re.search(r"```(?:python)?\n([\s\S]*?)```", fix_content)
        fixed_code = code_match.group(1) if code_match else fix_content.strip()

        # 语法验证
        if framework == "pytest":
            test_tree = _parse_python_ast(fixed_code)
            if not test_tree:
                iteration_log.append("修复后代码语法有误，跳过本轮")
                continue

        # 写入修复后的测试
        try:
            tp.write_text(fixed_code, encoding="utf-8")
            iteration_log.append("已写入修复后的测试代码")
        except Exception as e:
            iteration_log.append(f"写入修复代码失败: {e}")
            break

    # 达到最大迭代次数仍未通过
    iteration_log.append(f"⚠️ 达到最大迭代次数({max_iterations})，测试仍未全部通过")

    return ToolResult(
        success=False,
        output="\n".join(iteration_log),
        duration=time.time() - start,
        metadata={
            "iterations": max_iterations,
            "passed": result.get("passed", 0),
            "failed": result.get("failed", 0),
            "errors": result.get("errors", 0),
        },
    )


def _extract_failure_details(test_output: str) -> str:
    """从测试输出中提取失败详情。

    Args:
        test_output: 测试执行输出文本。

    Returns:
        str: 失败详情摘要。
    """
    details: list[str] = []
    # 查找FAILURES段落
    in_failures = False
    for line in test_output.splitlines():
        if "FAILURES" in line or "FAILED" in line:
            in_failures = True
        if in_failures:
            details.append(line)
            if len(details) > 30:
                break

    if not details:
        # 回退：提取含Error/AssertionError的行
        for line in test_output.splitlines():
            if "Error" in line or "AssertionError" in line or "assert" in line.lower():
                details.append(line)
                if len(details) > 20:
                    break

    return "\n".join(details) if details else "(未提取到失败详情)"


async def test_gen_coverage_executor(params: dict[str, Any]) -> ToolResult:
    """分析测试覆盖率。

    Args:
        params: 工具参数字典。

    Returns:
        ToolResult: 包含覆盖率百分比和未覆盖行号的结果。
    """
    start = time.time()
    source_path = str(params.get("source_path", ""))
    test_path = str(params.get("test_path", ""))
    language = str(params.get("language", "python"))

    if not source_path:
        return ToolResult(success=False, error="源路径不能为空")

    sp = Path(source_path).expanduser().resolve()
    if not sp.exists():
        return ToolResult(success=False, error=f"源路径不存在: {source_path}")

    if language == "python":
        result = _run_python_coverage(sp, test_path)
    else:
        result = _run_jest_coverage(sp, test_path)

    return ToolResult(
        success=result.get("success", False),
        output=result.get("output", ""),
        duration=time.time() - start,
        metadata=result.get("metadata", {}),
    )


def _run_python_coverage(source_path: Path, test_path: str) -> dict[str, Any]:
    """运行pytest --cov分析Python覆盖率。

    Args:
        source_path: 源文件或目录路径。
        test_path: 测试文件路径（可选）。

    Returns:
        dict: 包含覆盖率信息的结果字典。
    """
    python_exe = os.environ.get("JBX_PYTHON", "python")
    module_name = source_path.stem if source_path.is_file() else source_path.name

    cmd = [python_exe, "-m", "pytest", "--cov", module_name, "--cov-report=term-missing", "-v"]
    if test_path:
        cmd.append(test_path)
    else:
        # 查找对应测试文件
        candidates = _infer_test_file_paths(source_path, "python")
        for c in candidates:
            if c.exists():
                cmd.append(str(c))
                break

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return {"success": False, "output": "覆盖率分析超时（120秒）"}
    except Exception as e:
        return {"success": False, "output": f"覆盖率分析失败: {e}"}

    output = result.stdout + result.stderr

    # 解析覆盖率百分比
    coverage_pct = 0.0
    uncovered_lines: list[int] = []
    # pytest-cov输出格式: "module_name   XX%"
    cov_match = re.search(r"TOTAL\s+(\d+)%", output)
    if cov_match:
        coverage_pct = float(cov_match.group(1))
    else:
        # 尝试匹配单模块覆盖率
        cov_match2 = re.search(rf"{re.escape(module_name)}\s+(\d+)%", output)
        if cov_match2:
            coverage_pct = float(cov_match2.group(1))

    # 解析未覆盖行号: "module_name  XX%  12, 15-20"
    missing_match = re.search(rf"{re.escape(module_name)}\s+\d+%\s+([\d,\s\-]+)", output)
    if missing_match:
        uncovered_lines = _parse_missing_lines(missing_match.group(1))

    lines: list[str] = []
    lines.append(f"📊 覆盖率分析: {source_path}")
    lines.append(f"总覆盖率: {coverage_pct:.0f}%")
    if uncovered_lines:
        lines.append(f"未覆盖行: {uncovered_lines[:50]}")
    lines.append("")
    # 输出最后20行
    output_tail = "\n".join(output.splitlines()[-20:])
    lines.append("覆盖率报告（末尾）:")
    lines.append(output_tail)

    return {
        "success": True,
        "output": "\n".join(lines),
        "metadata": {
            "coverage_pct": coverage_pct,
            "uncovered_lines": uncovered_lines,
        },
    }


def _run_jest_coverage(source_path: Path, test_path: str) -> dict[str, Any]:
    """运行jest --coverage分析TypeScript覆盖率。

    Args:
        source_path: 源文件或目录路径。
        test_path: 测试文件路径（可选）。

    Returns:
        dict: 包含覆盖率信息的结果字典。
    """
    cmd = ["npx", "jest", "--coverage", "--verbose"]
    if test_path:
        cmd.append(test_path)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return {"success": False, "output": "覆盖率分析超时（120秒）"}
    except Exception as e:
        return {"success": False, "output": f"覆盖率分析失败: {e}"}

    output = result.stdout + result.stderr
    # 解析jest覆盖率
    cov_match = re.search(r"All files\s+\|\s+(\d+\.?\d*)", output)
    coverage_pct = float(cov_match.group(1)) if cov_match else 0.0

    lines: list[str] = []
    lines.append(f"📊 覆盖率分析: {source_path}")
    lines.append(f"总覆盖率: {coverage_pct:.1f}%")
    lines.append("")
    output_tail = "\n".join(output.splitlines()[-20:])
    lines.append("覆盖率报告（末尾）:")
    lines.append(output_tail)

    return {
        "success": True,
        "output": "\n".join(lines),
        "metadata": {"coverage_pct": coverage_pct},
    }


def _parse_missing_lines(missing_str: str) -> list[int]:
    """解析pytest-cov未覆盖行号字符串。

    格式示例: "12, 15-20, 30" → [12, 15, 16, 17, 18, 19, 20, 30]

    Args:
        missing_str: 未覆盖行号字符串。

    Returns:
        list[int]: 未覆盖行号列表。
    """
    lines: list[int] = []
    malformed: list[str] = []
    for part in missing_str.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                start, end = part.split("-", 1)
                for n in range(int(start), int(end) + 1):
                    lines.append(n)
            except ValueError:
                malformed.append(part)
        else:
            try:
                lines.append(int(part))
            except ValueError:
                malformed.append(part)
    if malformed:
        # 静默丢弃畸形片段会让覆盖率缺口被低估（少报未覆盖行），必须留痕。
        _log.warning("pytest-cov 未覆盖行号存在无法解析的片段，已跳过",
                     malformed=malformed, raw=missing_str[:200])
    return sorted(lines)
