from __future__ import annotations

import json
import os
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
import logging
logger = logging.getLogger(__name__)


LSP_COMPLETION_DEF = ToolDefinition(
    name="lsp_completion",
    description='获取代码补全建议。适用场景：用户需要代码自动补全、查看可用方法/属性、获取代码片段。不适用：诊断问题（用 lsp_diagnostics）、悬停文档（用 lsp_hover）。',
    category=ToolCategory.CODE,
    parameters=[
        ToolParameterDef(name="uri", type="string", description="文件 URI，如 file:///path/to/file.ts"),
        ToolParameterDef(name="line", type="number", description="行号（从0开始）"),
        ToolParameterDef(name="character", type="number", description="列号（从0开始）"),
    ],
    risk_level="low",
)

LSP_DIAGNOSTICS_DEF = ToolDefinition(
    name="lsp_diagnostics",
    description='获取文件的 LSP 诊断信息（错误、警告等）。适用场景：检查代码问题、获取类型错误、查看代码质量。不适用：代码补全（用 lsp_completion）、悬停信息（用 lsp_hover）。',
    category=ToolCategory.CODE,
    parameters=[
        ToolParameterDef(name="uri", type="string", description="文件 URI，如 file:///path/to/file.ts"),
        ToolParameterDef(name="severity", type="string", required=False, description="过滤严重级别", enum=["error", "warning", "info", "hint"]),
    ],
    risk_level="low",
)

LSP_HOVER_DEF = ToolDefinition(
    name="lsp_hover",
    description='获取代码悬停文档信息。适用场景：查看函数/类的文档、了解类型定义、查看方法签名。不适用：代码补全（用 lsp_completion）、诊断（用 lsp_diagnostics）。',
    category=ToolCategory.CODE,
    parameters=[
        ToolParameterDef(name="uri", type="string", description="文件 URI，如 file:///path/to/file.ts"),
        ToolParameterDef(name="line", type="number", description="行号（从0开始）"),
        ToolParameterDef(name="character", type="number", description="列号（从0开始）"),
    ],
    risk_level="low",
)

LSP_DEFINITION_DEF = ToolDefinition(
    name="lsp_definition",
    description='查找符号的定义位置。适用场景：跳转到函数定义、查看类声明位置、追踪变量来源。不适用：查找引用（用 lsp_references）、代码补全（用 lsp_completion）。',
    category=ToolCategory.CODE,
    parameters=[
        ToolParameterDef(name="uri", type="string", description="文件 URI，如 file:///path/to/file.ts"),
        ToolParameterDef(name="line", type="number", description="行号（从0开始）"),
        ToolParameterDef(name="character", type="number", description="列号（从0开始）"),
    ],
    risk_level="low",
)

LSP_REFERENCES_DEF = ToolDefinition(
    name="lsp_references",
    description='查找符号的所有引用位置。适用场景：查找函数调用处、查看变量使用位置、追踪接口实现。不适用：查找定义（用 lsp_definition）、代码补全（用 lsp_completion）。',
    category=ToolCategory.CODE,
    parameters=[
        ToolParameterDef(name="uri", type="string", description="文件 URI，如 file:///path/to/file.ts"),
        ToolParameterDef(name="line", type="number", description="行号（从0开始）"),
        ToolParameterDef(name="character", type="number", description="列号（从0开始）"),
    ],
    risk_level="low",
)

LSP_SYMBOLS_DEF = ToolDefinition(
    name="lsp_symbols",
    description='获取文件中的文档符号（类、函数、变量等）。适用场景：查看文件结构、了解代码组织、快速定位符号。不适用：诊断问题（用 lsp_diagnostics）、定义跳转（用 lsp_definition）。',
    category=ToolCategory.CODE,
    parameters=[
        ToolParameterDef(name="uri", type="string", description="文件 URI，如 file:///path/to/file.ts"),
    ],
    risk_level="low",
)


def _uri_to_path(uri: str) -> str:
    if uri.startswith("file:///"):
        return uri[8:].lstrip("/")
    if uri.startswith("file://"):
        return uri[7:]
    return uri


def _detect_language(uri: str) -> str:
    ext = Path(uri).suffix.lower()
    mapping = {
        ".py": "python",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".js": "javascript",
        ".jsx": "javascript",
        ".go": "go",
        ".rs": "rust",
        ".java": "java",
        ".c": "c",
        ".cpp": "cpp",
        ".h": "c",
        ".hpp": "cpp",
        ".cs": "csharp",
        ".rb": "ruby",
        ".php": "php",
        ".swift": "swift",
        ".kt": "kotlin",
        ".scala": "scala",
        ".lua": "lua",
        ".r": "r",
    }
    return mapping.get(ext, "unknown")


async def lsp_completion_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    uri = str(params.get("uri", ""))
    line = int(params.get("line", 0))
    character = int(params.get("character", 0))

    if not uri:
        return ToolResult(success=False, error="文件 URI 不能为空", duration=time.time() - start)

    file_path = _uri_to_path(uri)
    if not os.path.isfile(file_path):
        return ToolResult(success=False, error=f"文件不存在: {file_path}", duration=time.time() - start)

    language = _detect_language(uri)

    if language == "python":
        try:
            result = await _python_completions(file_path, line, character)
            return ToolResult(success=True, output=result, duration=time.time() - start)
        except Exception as e:
            logger.warning("lsp_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"补全失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=False,
        output=f"LSP 补全不支持 {language}（仅 Python 由本后端实现）。",
        error=f"unsupported_language: LSP completion 仅支持 Python，{language} 需经 TS 后端调用",
        duration=time.time() - start,
    )


async def lsp_diagnostics_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    uri = str(params.get("uri", ""))
    severity_filter = str(params.get("severity", ""))

    if not uri:
        return ToolResult(success=False, error="文件 URI 不能为空", duration=time.time() - start)

    file_path = _uri_to_path(uri)
    if not os.path.isfile(file_path):
        return ToolResult(success=False, error=f"文件不存在: {file_path}", duration=time.time() - start)

    language = _detect_language(uri)

    if language == "python":
        try:
            result = await _python_diagnostics(file_path, severity_filter)
            return ToolResult(success=True, output=result, duration=time.time() - start)
        except Exception as e:
            logger.warning("lsp_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"诊断失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=False,
        output=f"LSP 诊断不支持 {language}（仅 Python 由本后端实现）。",
        error=f"unsupported_language: LSP diagnostics 仅支持 Python，{language} 需经 TS 后端调用",
        duration=time.time() - start,
    )


async def lsp_hover_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    uri = str(params.get("uri", ""))
    line = int(params.get("line", 0))
    character = int(params.get("character", 0))

    if not uri:
        return ToolResult(success=False, error="文件 URI 不能为空", duration=time.time() - start)

    file_path = _uri_to_path(uri)
    if not os.path.isfile(file_path):
        return ToolResult(success=False, error=f"文件不存在: {file_path}", duration=time.time() - start)

    language = _detect_language(uri)

    if language == "python":
        try:
            result = await _python_hover(file_path, line, character)
            return ToolResult(success=True, output=result, duration=time.time() - start)
        except Exception as e:
            logger.warning("lsp_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"悬停查询失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=False,
        output=f"LSP 悬停不支持 {language}（仅 Python 由本后端实现）。",
        error=f"unsupported_language: LSP hover 仅支持 Python，{language} 需经 TS 后端调用",
        duration=time.time() - start,
    )


async def lsp_definition_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    uri = str(params.get("uri", ""))
    line = int(params.get("line", 0))
    character = int(params.get("character", 0))

    if not uri:
        return ToolResult(success=False, error="文件 URI 不能为空", duration=time.time() - start)

    file_path = _uri_to_path(uri)
    if not os.path.isfile(file_path):
        return ToolResult(success=False, error=f"文件不存在: {file_path}", duration=time.time() - start)

    language = _detect_language(uri)

    if language == "python":
        try:
            result = await _python_definition(file_path, line, character)
            return ToolResult(success=True, output=result, duration=time.time() - start)
        except Exception as e:
            logger.warning("lsp_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"定义跳转失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=False,
        output=f"LSP 定义跳转不支持 {language}（仅 Python 由本后端实现）。",
        error=f"unsupported_language: LSP definition 仅支持 Python，{language} 需经 TS 后端调用",
        duration=time.time() - start,
    )


async def lsp_references_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    uri = str(params.get("uri", ""))
    line = int(params.get("line", 0))
    character = int(params.get("character", 0))

    if not uri:
        return ToolResult(success=False, error="文件 URI 不能为空", duration=time.time() - start)

    file_path = _uri_to_path(uri)
    if not os.path.isfile(file_path):
        return ToolResult(success=False, error=f"文件不存在: {file_path}", duration=time.time() - start)

    language = _detect_language(uri)

    if language == "python":
        try:
            result = await _python_references(file_path, line, character)
            return ToolResult(success=True, output=result, duration=time.time() - start)
        except Exception as e:
            logger.warning("lsp_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"引用查找失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=False,
        output=f"LSP 引用查找不支持 {language}（仅 Python 由本后端实现）。",
        error=f"unsupported_language: LSP references 仅支持 Python，{language} 需经 TS 后端调用",
        duration=time.time() - start,
    )


async def lsp_symbols_executor(params: dict[str, Any]) -> ToolResult:
    start = time.time()
    uri = str(params.get("uri", ""))

    if not uri:
        return ToolResult(success=False, error="文件 URI 不能为空", duration=time.time() - start)

    file_path = _uri_to_path(uri)
    if not os.path.isfile(file_path):
        return ToolResult(success=False, error=f"文件不存在: {file_path}", duration=time.time() - start)

    language = _detect_language(uri)

    if language == "python":
        try:
            result = await _python_symbols(file_path)
            return ToolResult(success=True, output=result, duration=time.time() - start)
        except Exception as e:
            logger.warning("lsp_tools 异常处理", error=str(e))
            return ToolResult(success=False, error=f"符号查找失败: {e}", duration=time.time() - start)

    return ToolResult(
        success=False,
        output=f"LSP 符号查找不支持 {language}（仅 Python 由本后端实现）。",
        error=f"unsupported_language: LSP symbols 仅支持 Python，{language} 需经 TS 后端调用",
        duration=time.time() - start,
    )


def _run_pyright(args: list[str], timeout: int = 15) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            ["pyright", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
        return {"stdout": proc.stdout, "stderr": proc.stderr, "returncode": proc.returncode}
    except FileNotFoundError:
        return {"stdout": "", "stderr": "pyright not installed", "returncode": -1}
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": "pyright timeout", "returncode": -1}


async def _python_diagnostics(file_path: str, severity_filter: str = "") -> str:
    result = _run_pyright(["--outputjson", file_path])
    if result["returncode"] == -1 and "not installed" in result["stderr"]:
        lines: list[str] = []
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            for i, line_text in enumerate(f, 1):
                stripped = line_text.rstrip()
                if stripped.endswith(":") and not stripped.startswith(("#", "'", '"')):
                    lines.append(f"  L{i}: 可能的定义行: {stripped}")
        if lines:
            return f"⚠️ pyright 未安装，仅提供基础分析:\n" + "\n".join(lines)
        return "⚠️ pyright 未安装，无法提供 Python 诊断。请安装: pip install pyright"

    try:
        data = json.loads(result["stdout"])
    except json.JSONDecodeError:
        return f"pyright 输出解析失败:\n{result['stdout'][:500]}"

    diagnostics = data.get("generalDiagnostics", [])
    if not diagnostics:
        return "✅ 无诊断问题"

    severity_map = {"error": "❌", "warning": "⚠️", "information": "ℹ️", "hint": "💡"}
    items: list[str] = []
    for d in diagnostics:
        sev = d.get("severity", "information")
        if severity_filter and sev != severity_filter and not (severity_filter == "info" and sev == "information"):
            continue
        icon = severity_map.get(sev, "•")
        loc = d.get("range", {}).get("start", {})
        line_num = loc.get("line", 0) + 1
        msg = d.get("message", "")
        items.append(f"{icon} L{line_num}: {msg}")

    if not items:
        return f"✅ 无 {severity_filter} 级别诊断问题"

    return f"📋 诊断结果 ({len(items)} 项):\n" + "\n".join(items[:30])


async def _python_completions(file_path: str, line: int, character: int) -> str:
    return f"💡 代码补全 ({Path(file_path).name}:{line}:{character})\nPython 补全建议需通过 LSP 服务器获取。建议使用 IDE 内置补全或 pyright 语言服务器。"


async def _python_hover(file_path: str, line: int, character: int) -> str:
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            lines_list = f.readlines()
        if 0 <= line < len(lines_list):
            code_line = lines_list[line].rstrip()
            return f"📄 悬停信息 ({Path(file_path).name}:{line}:{character})\n```\n{code_line}\n```\n详细类型信息需通过 pyright 语言服务器获取。"
        return f"📄 行 {line} 超出文件范围"
    except Exception as e:
        logger.warning("lsp_tools 异常处理", error=str(e))
        return f"悬停查询失败: {e}"


async def _python_definition(file_path: str, line: int, character: int) -> str:
    return f"🔍 定义跳转 ({Path(file_path).name}:{line}:{character})\nPython 定义跳转需通过 pyright 语言服务器获取。"


async def _python_references(file_path: str, line: int, character: int) -> str:
    return f"🔗 引用查找 ({Path(file_path).name}:{line}:{character})\nPython 引用查找需通过 pyright 语言服务器获取。"


async def _python_symbols(file_path: str) -> str:
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            lines_list = f.readlines()
    except Exception as e:
        logger.warning("lsp_tools 异常处理", error=str(e))
        return f"符号查找失败: {e}"

    import re as _re

    symbols: list[str] = []
    for i, code_line in enumerate(lines_list, 1):
        stripped = code_line.strip()
        cls_match = _re.match(r"^class\s+(\w+)", stripped)
        if cls_match:
            symbols.append(f"  📦 class {cls_match.group(1)} (L{i})")
            continue
        func_match = _re.match(r"^(async\s+)?def\s+(\w+)", stripped)
        if func_match:
            symbols.append(f"  ⚙️ def {func_match.group(2)} (L{i})")
            continue
        var_match = _re.match(r"^(\w+)\s*[:=]", stripped)
        if var_match and not stripped.startswith("_") and not stripped.startswith("#"):
            name = var_match.group(1)
            if name.isupper() or name[0].islower():
                kind = "📌" if name.isupper() else "📝"
                symbols.append(f"  {kind} {name} (L{i})")

    if not symbols:
        return f"📋 {Path(file_path).name}: 未找到符号"

    return f"📋 {Path(file_path).name} 符号列表 ({len(symbols)} 个):\n" + "\n".join(symbols[:50])
