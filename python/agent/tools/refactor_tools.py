"""重构工具链——基于AST的符号重命名、提取、移动与预览。"""
from __future__ import annotations
import ast, difflib, json, re, time
from pathlib import Path
from typing import Any
from agent.core.logger import StructuredLogger
from agent.tools.registry import (ToolCategory, ToolDefinition, ToolParameterDef, ToolResult)
log = StructuredLogger("refactor_tools")

_log = StructuredLogger("tools.refactor")

REFA = ToolCategory.CODE
RISK_MED, RISK_LOW = "medium", "low"
_SCENES = ["coding", "development"]

def _parse(code: str) -> ast.Module | None:
    """安全解析Python代码为AST，失败返回None。"""
    try: return ast.parse(code)
    except SyntaxError: return None
    except Exception as _exc:
        _log.warning("AST 解析异常", error=str(_exc))
        return None

def _read_lines(path: Path) -> list[str] | None:
    """读取文件所有行（保留换行符），失败返回None。"""
    try: return path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
    except Exception as _exc:
        _log.warning("文件读取失败", path=str(path), error=str(_exc))
        return None

def _diff(old: list[str], new: list[str], name: str = "a") -> str:
    """生成unified diff文本。"""
    return "".join(difflib.unified_diff(old, new, fromfile=f"a/{name}", tofile=f"b/{name}"))

def _validate_write(path: Path, old: list[str], new: list[str], preview: bool) -> ToolResult | None:
    """验证语法并写入。返回ToolResult表示错误/预览，None表示写入成功。"""
    code = "".join(new)
    if not _parse(code):
        return ToolResult(success=False, error="重构后代码语法有误，已放弃写入。", metadata={"diff": _diff(old, new, path.name)})
    d = _diff(old, new, path.name)
    if preview:
        return ToolResult(success=True, output=f"预览变更（未写入）:\n\n{d}", metadata={"preview": True, "file_path": str(path)})
    try: path.write_text(code, encoding="utf-8")
    except Exception as e: return ToolResult(success=False, error=f"写入文件失败: {e}")
    return None

def _last_import_line(tree: ast.Module) -> int:
    """获取AST中最后一个导入语句的行号。"""
    pos = 0
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            end = getattr(node, "end_lineno", node.lineno)
            if end > pos: pos = end
    return pos

def _find_project_root(fp: Path) -> Path:
    """向上查找项目根目录（含pyproject.toml/setup.py）。"""
    for parent in fp.parents:
        if (parent / "pyproject.toml").exists() or (parent / "setup.py").exists(): return parent
    return fp

def _module_path(fp: Path, root: Path) -> str:
    """计算文件相对项目根的Python模块路径。"""
    try: rel = fp.relative_to(root)
    except ValueError: return fp.stem
    parts = list(rel.parts)
    if parts and parts[-1].endswith(".py"): parts[-1] = parts[-1][:-3]
    return ".".join(parts)

def _find_py_files(root: Path, max_files: int = 200) -> list[Path]:
    """搜索项目中Python文件，跳过虚拟环境和缓存。"""
    skip = {".venv", "venv", "__pycache__", ".git", "node_modules"}
    result: list[Path] = []
    for p in root.rglob("*.py"):
        if any(s in p.parts for s in skip): continue
        result.append(p)
        if len(result) >= max_files: break
    return result

class _RenameTransformer(ast.NodeTransformer):
    """AST节点重命名转换器，将old_name替换为new_name。"""
    def __init__(self, old_name: str, new_name: str) -> None:
        self.old_name = old_name; self.new_name = new_name; self.changed = False
    def _rename(self, node: ast.AST, attr: str) -> ast.AST:
        if getattr(node, attr, None) == self.old_name:
            setattr(node, attr, self.new_name); self.changed = True
        return node
    def visit_Name(self, node: ast.Name) -> ast.Name: return self._rename(node, "id")
    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.FunctionDef:
        self._rename(node, "name"); self.generic_visit(node); return node
    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> ast.AsyncFunctionDef:
        self._rename(node, "name"); self.generic_visit(node); return node
    def visit_ClassDef(self, node: ast.ClassDef) -> ast.ClassDef:
        self._rename(node, "name"); self.generic_visit(node); return node
    def visit_Attribute(self, node: ast.Attribute) -> ast.Attribute:
        self._rename(node, "attr"); self.generic_visit(node); return node
    def visit_arg(self, node: ast.arg) -> ast.arg: return self._rename(node, "arg")
    def visit_Global(self, node: ast.Global) -> ast.Global:
        if self.old_name in node.names:
            node.names = [self.new_name if n == self.old_name else n for n in node.names]; self.changed = True
        return node
    def visit_Nonlocal(self, node: ast.Nonlocal) -> ast.Nonlocal:
        if self.old_name in node.names:
            node.names = [self.new_name if n == self.old_name else n for n in node.names]; self.changed = True
        return node

# ==================== refactor_rename ====================
REFACTOR_RENAME_DEF = ToolDefinition(
    name="refactor_rename",
    description="符号重命名工具。使用AST精确定位并重命名Python代码中的符号（变量/函数/类/参数/属性）。local仅单文件，project跨文件搜索并重命名。不适用：批量文本替换（用file_edit）。",
    short_desc="AST符号重命名", category=REFA, tags=["refactor", "rename", "ast"],
    scenes=_SCENES, capability_level=3,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="主文件路径"),
        ToolParameterDef(name="old_name", type="string", description="当前符号名"),
        ToolParameterDef(name="new_name", type="string", description="新符号名"),
        ToolParameterDef(name="scope", type="string", required=False, description="范围: local/project", enum=["local", "project"]),
        ToolParameterDef(name="preview_only", type="boolean", required=False, description="仅预览不写入"),
    ], risk_level=RISK_MED)

def _rename_in_file(fp: Path, old: str, new: str, preview: bool) -> dict[str, Any]:
    """在单个文件中执行AST重命名，返回结果字典。"""
    lines = _read_lines(fp)
    if lines is None: return {"success": False, "error": f"无法读取: {fp}"}
    code = "".join(lines)
    tree = _parse(code)
    if not tree: return {"success": False, "error": f"语法错误: {fp}"}
    t = _RenameTransformer(old, new)
    new_tree = t.visit(tree); ast.fix_missing_locations(new_tree)
    if not t.changed: return {"success": True, "changed": False, "diff": "", "file_path": str(fp)}
    new_code = ast.unparse(new_tree); new_lines = new_code.splitlines(keepends=True)
    d = _diff(lines, new_lines, fp.name)
    if not preview:
        if _parse(new_code):
            try: fp.write_text(new_code, encoding="utf-8")
            except Exception as e: return {"success": False, "error": f"写入失败: {e}"}
        else: return {"success": False, "error": "重命名后语法有误"}
    return {"success": True, "changed": True, "diff": d, "file_path": str(fp)}

async def refactor_rename_executor(params: dict[str, Any]) -> ToolResult:
    """符号重命名执行器，支持单文件和跨项目模式。"""
    t0 = time.time()
    file_path, old_name, new_name = str(params.get("file_path", "")), str(params.get("old_name", "")), str(params.get("new_name", ""))
    scope, preview = str(params.get("scope", "local")), bool(params.get("preview_only", False))
    if not file_path or not old_name or not new_name:
        return ToolResult(success=False, error="file_path/old_name/new_name 不能为空")
    main_path = Path(file_path).expanduser().resolve()
    if not main_path.exists(): return ToolResult(success=False, error=f"文件不存在: {file_path}")
    results = [_rename_in_file(main_path, old_name, new_name, preview)]
    if scope == "project":
        root = _find_project_root(main_path)
        for pf in _find_py_files(root):
            if pf == main_path: continue
            r = _rename_in_file(pf, old_name, new_name, preview)
            if r.get("changed"): results.append(r)
    changed = [r for r in results if r.get("changed")]
    errors = [r["error"] for r in results if not r.get("success")]
    if errors: return ToolResult(success=False, error="; ".join(errors), duration=time.time() - t0)
    if not changed: return ToolResult(success=True, output=f"未找到符号 '{old_name}'，无需重命名。", duration=time.time() - t0)
    output = f"重命名 '{old_name}' → '{new_name}'\n变更文件: {len(changed)} 个\n\n"
    output += "\n".join(r["diff"] for r in changed if r.get("diff"))
    return ToolResult(success=True, output=output, duration=time.time() - t0,
                      metadata={"old_name": old_name, "new_name": new_name, "changed_files": [r["file_path"] for r in changed]})

# ==================== refactor_extract ====================
REFACTOR_EXTRACT_DEF = ToolDefinition(
    name="refactor_extract",
    description="提取代码为函数/变量/常量。选中行范围提取为新定义，原位置替换为调用。自动推断参数和返回值。不适用：移动符号（用refactor_move）。",
    short_desc="提取代码为函数/变量/常量", category=REFA, tags=["refactor", "extract", "ast"],
    scenes=_SCENES, capability_level=3,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="源文件路径"),
        ToolParameterDef(name="extract_type", type="string", description="提取类型", enum=["function", "variable", "constant"]),
        ToolParameterDef(name="start_line", type="number", description="起始行号（从1开始）"),
        ToolParameterDef(name="end_line", type="number", description="结束行号"),
        ToolParameterDef(name="new_name", type="string", description="新定义名称"),
        ToolParameterDef(name="preview_only", type="boolean", required=False, description="仅预览不写入"),
    ], risk_level=RISK_MED)

def _infer_deps(code_lines: list[str]) -> tuple[list[str], list[str]]:
    """推断代码行的外部依赖（参数）和赋值名（返回值候选）。"""
    tree = _parse("\n".join(code_lines))
    if not tree: return [], []
    used, assigned = set(), set()
    builtins = {"print", "len", "range", "int", "str", "float", "list", "dict", "set", "tuple", "bool", "type", "isinstance", "True", "False", "None"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load): used.add(node.id)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store): assigned.add(node.id)
        elif isinstance(node, ast.arg): used.add(node.arg)
    return sorted(used - assigned - builtins), sorted(assigned)

async def refactor_extract_executor(params: dict[str, Any]) -> ToolResult:
    """提取代码执行器，将选中行提取为函数/变量/常量。"""
    t0 = time.time()
    file_path, ext_type = str(params.get("file_path", "")), str(params.get("extract_type", "function"))
    sl, el, new_name = int(params.get("start_line", 0)), int(params.get("end_line", 0)), str(params.get("new_name", ""))
    preview = bool(params.get("preview_only", False))
    if not file_path or not new_name: return ToolResult(success=False, error="file_path/new_name 不能为空")
    if sl < 1 or el < sl: return ToolResult(success=False, error="start_line/end_line 无效")
    p = Path(file_path).expanduser().resolve()
    lines = _read_lines(p)
    if lines is None: return ToolResult(success=False, error=f"无法读取: {file_path}")
    sel = lines[sl - 1:el]
    if not sel: return ToolResult(success=False, error="选中行范围为空")
    sel_code, old_lines = "".join(sel), lines[:]
    if ext_type == "function":
        pnames, rnames = _infer_deps([l.rstrip("\n") for l in sel])
        fp_str, body = ", ".join(pnames), "".join("    " + l for l in sel)
        fdef = f"def {new_name}({fp_str}):\n{body}"
        if rnames: fdef += f"    return {', '.join(rnames)}\n"
        call = (f"{', '.join(rnames)} = {new_name}({fp_str})\n" if rnames else f"{new_name}({fp_str})\n")
        indent = sel[0][:len(sel[0]) - len(sel[0].lstrip())]; call = indent + call
        tree = _parse("".join(lines)); ipos = _last_import_line(tree) if tree else 0
        new_lines = lines[:ipos] + [fdef + "\n"] + lines[ipos:sl - 1] + [call] + lines[el:]
    elif ext_type == "variable":
        fi = len(sel[0]) - len(sel[0].lstrip()); ind = sel[0][:fi]
        new_lines = lines[:sl - 1] + [f"{ind}{new_name} = {sel_code.strip()}\n"] + lines[el:]
    elif ext_type == "constant":
        cn = new_name.upper(); cdef = f"{cn} = {sel_code.strip()}\n"
        tree = _parse("".join(lines)); ipos = _last_import_line(tree) if tree else 0
        fi = len(sel[0]) - len(sel[0].lstrip()); ind = sel[0][:fi]
        new_lines = lines[:ipos] + [cdef + "\n"] + lines[ipos:sl - 1] + [f"{ind}{cn}\n"] + lines[el:]
    else: return ToolResult(success=False, error=f"不支持的提取类型: {ext_type}")
    vr = _validate_write(p, old_lines, new_lines, preview)
    if vr: vr.duration = time.time() - t0; return vr
    d = _diff(old_lines, new_lines, p.name)
    return ToolResult(success=True, output=f"提取完成: {ext_type} '{new_name}'\n\n{d}", duration=time.time() - t0,
                      metadata={"file_path": str(p), "extract_type": ext_type, "new_name": new_name})

# ==================== refactor_move ====================
REFACTOR_MOVE_DEF = ToolDefinition(
    name="refactor_move",
    description="移动符号到另一个文件。将函数/类从源文件移到目标文件，自动更新源文件/目标文件导入及项目引用。不适用：重命名（用refactor_rename）。",
    short_desc="移动符号到另一个文件", category=REFA, tags=["refactor", "move", "ast"],
    scenes=_SCENES, capability_level=3,
    parameters=[
        ToolParameterDef(name="source_file", type="string", description="源文件路径"),
        ToolParameterDef(name="symbol_name", type="string", description="要移动的符号名"),
        ToolParameterDef(name="target_file", type="string", description="目标文件路径"),
        ToolParameterDef(name="preview_only", type="boolean", required=False, description="仅预览不写入"),
    ], risk_level=RISK_MED)

def _extract_symbol(tree: ast.Module, code: str, name: str) -> tuple[str, int, int] | None:
    """从AST提取符号源码和行范围。"""
    lines = code.splitlines(keepends=True)
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
            s, e = node.lineno, getattr(node, "end_lineno", node.lineno)
            return ("".join(lines[s - 1:e]), s, e)
    return None

def _symbol_imports(tree: ast.Module, name: str) -> list[str]:
    """收集符号依赖的导入语句。"""
    used: set[str] = set()
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
            for child in ast.walk(node):
                if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load): used.add(child.id)
    imports: list[str] = []
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.ImportFrom):
            names = {a.name for a in node.names if a.name}
            if names & used: imports.append(f"from {node.module or ''} import {', '.join(a.name for a in node.names if a.name)}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in used: imports.append(f"import {alias.name}")
    return imports

async def refactor_move_executor(params: dict[str, Any]) -> ToolResult:
    """移动符号执行器，将函数/类移到目标文件并更新导入。"""
    t0 = time.time()
    src_file, sym_name, tgt_file = str(params.get("source_file", "")), str(params.get("symbol_name", "")), str(params.get("target_file", ""))
    preview = bool(params.get("preview_only", False))
    if not src_file or not sym_name or not tgt_file: return ToolResult(success=False, error="source_file/symbol_name/target_file 不能为空")
    src_p, tgt_p = Path(src_file).expanduser().resolve(), Path(tgt_file).expanduser().resolve()
    if not src_p.exists(): return ToolResult(success=False, error=f"源文件不存在: {src_file}")
    src_lines = _read_lines(src_p)
    if src_lines is None: return ToolResult(success=False, error=f"无法读取源文件: {src_file}")
    src_code = "".join(src_lines); src_tree = _parse(src_code)
    if not src_tree: return ToolResult(success=False, error="源文件语法有误")
    sym_info = _extract_symbol(src_tree, src_code, sym_name)
    if not sym_info: return ToolResult(success=False, error=f"未找到符号: {sym_name}")
    sym_src, sym_sl, sym_el = sym_info
    needed_imps = _symbol_imports(src_tree, sym_name)
    root = _find_project_root(src_p); src_mod = _module_path(src_p, root)
    all_diffs, changed, write_failures = [], [], []
    # 源文件：移除符号
    new_src = src_lines[:sym_sl - 1] + src_lines[sym_el:]
    all_diffs.append(_diff(src_lines, new_src, src_p.name)); changed.append(str(src_p))
    if not preview:
        nc = "".join(new_src)
        if _parse(nc):
            try: src_p.write_text(nc, encoding="utf-8")
            except Exception as e: return ToolResult(success=False, error=f"写入源文件失败: {e}")
    # 目标文件：添加符号和导入
    tgt_lines = _read_lines(tgt_p) if tgt_p.exists() else []
    if tgt_lines is None: return ToolResult(success=False, error=f"无法读取目标文件: {tgt_file}")
    old_tgt = tgt_lines[:]; new_tgt = tgt_lines[:]
    if new_tgt and not new_tgt[-1].endswith("\n"): new_tgt[-1] += "\n"
    new_tgt += ["\n", sym_src, "\n"]
    if needed_imps:
        ib = "\n".join(needed_imps) + "\n\n"
        if tgt_lines:
            tt = _parse("".join(tgt_lines)); ipos = _last_import_line(tt) if tt else 0
            new_tgt = new_tgt[:ipos] + [ib] + new_tgt[ipos:]
        else: new_tgt = [ib] + new_tgt
    all_diffs.append(_diff(old_tgt, new_tgt, tgt_p.name)); changed.append(str(tgt_p))
    if not preview:
        nc = "".join(new_tgt)
        if _parse(nc):
            try: tgt_p.parent.mkdir(parents=True, exist_ok=True); tgt_p.write_text(nc, encoding="utf-8")
            except Exception as e: return ToolResult(success=False, error=f"写入目标文件失败: {e}")
    # 更新项目引用
    for pf in _find_py_files(root):
        if pf in (src_p, tgt_p): continue
        pf_lines = _read_lines(pf)
        if pf_lines is None: continue
        pf_code = "".join(pf_lines)
        if sym_name not in pf_code: continue
        imp_line = f"from {src_mod} import {sym_name}\n"
        if imp_line.strip() in pf_code: continue
        pf_tree = _parse(pf_code)
        if not pf_tree: continue
        ipos = _last_import_line(pf_tree)
        new_pf = pf_lines[:ipos] + [imp_line] + pf_lines[ipos:]
        all_diffs.append(_diff(pf_lines, new_pf, pf.name)); changed.append(str(pf))
        if not preview:
            nc = "".join(new_pf)
            if _parse(nc):
                # 审计（D2）：写入失败此前被静默吞掉，文件仍被计入 changed 且工具
                # 返回 success=True —— 调用方会以为引用已全部更新，实际留下半成品重构。
                try:
                    pf.write_text(nc, encoding="utf-8")
                except Exception as e:
                    _log.error("更新引用文件写入失败，重构未完全应用", file=str(pf), error=f"{type(e).__name__}: {e}")
                    changed.remove(str(pf))
                    write_failures.append(f"{pf}: {type(e).__name__}: {e}")
    output = f"移动符号 '{sym_name}' 从 {src_file} → {tgt_file}\n变更文件: {len(changed)} 个\n\n" + "\n".join(all_diffs)
    if preview: output = f"预览（未写入）:\n\n{output}"
    if write_failures:
        output += "\n\n⚠️ 以下文件写入失败，引用未更新（重构不完整）:\n" + "\n".join(f"  - {x}" for x in write_failures)
    return ToolResult(success=not write_failures, output=output, duration=time.time() - t0,
                      error=("部分引用文件写入失败，重构不完整" if write_failures else None),
                      metadata={"symbol_name": sym_name, "source_file": str(src_p), "target_file": str(tgt_p),
                                "changed_files": changed, "write_failures": write_failures})

# ==================== refactor_preview ====================
REFACTOR_PREVIEW_DEF = ToolDefinition(
    name="refactor_preview",
    description="预览重构操作变更。对rename/extract/move生成变更预览，不实际执行。返回unified diff格式。不适用：实际执行重构（用对应工具）。",
    short_desc="预览重构变更", category=REFA, tags=["refactor", "preview", "diff"],
    scenes=_SCENES, capability_level=2,
    parameters=[
        ToolParameterDef(name="file_path", type="string", description="主文件路径"),
        ToolParameterDef(name="operation", type="string", description="重构操作类型", enum=["rename", "extract", "move"]),
        ToolParameterDef(name="operation_params", type="string", description='操作参数JSON，如 {"old_name":"x","new_name":"y"}'),
    ], risk_level=RISK_LOW)

async def refactor_preview_executor(params: dict[str, Any]) -> ToolResult:
    """重构预览执行器，调用对应工具的preview_only模式。"""
    t0 = time.time()
    file_path, operation = str(params.get("file_path", "")), str(params.get("operation", ""))
    op_str = str(params.get("operation_params", "{}"))
    if not operation: return ToolResult(success=False, error="operation 不能为空")
    try: op = json.loads(op_str)
    except json.JSONDecodeError as e: return ToolResult(success=False, error=f"operation_params JSON解析失败: {e}")
    op["preview_only"] = True
    if operation == "rename":
        op.setdefault("file_path", file_path); op.setdefault("scope", "local")
        result = await refactor_rename_executor(op)
    elif operation == "extract":
        op.setdefault("file_path", file_path)
        result = await refactor_extract_executor(op)
    elif operation == "move":
        op.setdefault("source_file", file_path)
        result = await refactor_move_executor(op)
    else: return ToolResult(success=False, error=f"不支持的操作类型: {operation}")
    if result.success: result.output = f"[预览模式] {result.output}"
    result.duration = time.time() - t0
    return result

# ==================== refactor_depgraph ====================
REFACTOR_DEPGRAPH_DEF = ToolDefinition(
    name="refactor_depgraph",
    description="生成项目模块依赖图（import 级）。Python 用 AST 精确解析 import/from（含相对导入归包）；"
                "TypeScript 用正则提取 import/require。输出 mermaid / json / text。不适用：运行时调用图（需动态/插桩分析）。",
    short_desc="生成模块依赖图", category=REFA, tags=["refactor", "dependency", "graph", "ast"],
    scenes=_SCENES, capability_level=3,
    parameters=[
        ToolParameterDef(name="root_path", type="string", description="项目根目录或单个源码文件"),
        ToolParameterDef(name="language", type="string", required=False, description="语言", enum=["python", "ts"]),
        ToolParameterDef(name="format", type="string", required=False, description="输出格式", enum=["mermaid", "json", "text"]),
        ToolParameterDef(name="max_nodes", type="number", required=False, description="最大节点数（防止超大图，默认 200）"),
    ], risk_level=RISK_LOW)

_SKIP_DIRS = {".venv", "venv", "__pycache__", ".git", "node_modules", "dist", "build", ".pytest_cache", ".mypy_cache"}

def _collect_source_files(root: Path, lang: str) -> list[Path]:
    """收集项目内源码文件，跳过虚拟环境与构建产物。"""
    pat = "*.py" if lang == "python" else "*.ts"
    if root.is_file():
        return [root]
    out: list[Path] = []
    for p in root.rglob(pat):
        if any(s in p.parts for s in _SKIP_DIRS):
            continue
        out.append(p)
    return out

def _py_imports(code: str, module_name: str) -> set[str]:
    """解析 Python 源码中的导入目标（顶层包名）。相对导入按当前包归并。"""
    tree = _parse(code)
    if not tree:
        return set()
    deps: set[str] = set()
    parts = module_name.split(".")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                deps.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                base = parts[: len(parts) - node.level] if node.level < len(parts) else []
                target = ".".join(base + ([node.module] if node.module else []))
                deps.add(target or "(local)")
            elif node.module:
                deps.add(node.module)
    return deps

_TS_IMPORT_RE = re.compile(r"import\s+(?:[^'\"\n]+?\s+from\s+)?['\"]([^'\"]+)['\"]")
_TS_REQUIRE_RE = re.compile(r"require\(['\"]([^'\"]+)['\"]\)")

def _ts_imports(text: str) -> set[str]:
    """正则提取 TS/JS 导入目标（顶层包名，跳过相对路径）。"""
    deps: set[str] = set()
    for m in _TS_IMPORT_RE.findall(text):
        if not m.startswith("."):
            deps.add(m.split("/")[0])
    for m in _TS_REQUIRE_RE.findall(text):
        if not m.startswith("."):
            deps.add(m.split("/")[0])
    return deps

async def refactor_depgraph_executor(params: dict[str, Any]) -> ToolResult:
    """生成模块依赖图执行器。"""
    t0 = time.time()
    root = str(params.get("root_path", ""))
    lang = str(params.get("language", "python")).lower()
    fmt = str(params.get("format", "mermaid")).lower()
    max_nodes = int(params.get("max_nodes", 200))
    if not root:
        return ToolResult(success=False, error="root_path 不能为空")
    rp = Path(root).expanduser().resolve()
    if not rp.exists():
        return ToolResult(success=False, error=f"路径不存在: {root}")
    if lang not in ("python", "ts"):
        return ToolResult(success=False, error=f"不支持的语言: {lang}")

    files = _collect_source_files(rp, lang)
    if not files:
        return ToolResult(success=False, error=f"未找到 {lang} 源文件: {root}")
    if len(files) > max_nodes * 4:
        files = files[: max_nodes * 4]

    graph: dict[str, set[str]] = {}
    parse_failures = 0
    for fp in files:
        if lang == "python":
            node = _module_path(fp, _find_project_root(fp))
            try:
                code = fp.read_text(encoding="utf-8", errors="replace")
            except Exception as _exc:
                log.warning("refactor_tools 异常被捕获", error=str(_exc))
                parse_failures += 1
                continue
            deps = _py_imports(code, node)
        else:
            node = fp.stem
            try:
                text = fp.read_text(encoding="utf-8", errors="replace")
            except Exception as _exc:
                log.warning("refactor_tools 异常被捕获", error=str(_exc))
                parse_failures += 1
                continue
            deps = _ts_imports(text)
        graph.setdefault(node, set()).update(deps)

    if len(graph) > max_nodes:
        top = sorted(graph.keys(), key=lambda k: len(graph[k]), reverse=True)[:max_nodes]
        graph = {k: graph[k] for k in top}

    nodes = sorted(graph.keys())
    edges = [(k, v) for k in nodes for v in sorted(graph[k])]
    # 边可能指向外部依赖（如 os / numpy），这些不是项目的内部模块节点；
    # 渲染前把它们一并纳入索引，避免 mermaid/json 生成时 idx[b] KeyError。
    all_names = sorted(set(nodes) | {b for _, b in edges})

    if fmt == "json":
        out = json.dumps(
            {"nodes": all_names, "edges": [{"from": a, "to": b} for a, b in edges]},
            ensure_ascii=False, indent=2,
        )
    elif fmt == "mermaid":
        idx = {k: i for i, k in enumerate(all_names)}
        lines = ["graph TD"]
        for k in all_names:
            lines.append(f'    n{idx[k]}["{k}"]')
        for a, b in edges:
            lines.append(f"    n{idx[a]} --> n{idx[b]}")
        out = "\n".join(lines)
    else:
        lines = [f"# 依赖图（{lang}，{len(nodes)} 节点 / {len(edges)} 边）"]
        for k in nodes:
            lines.append(f"- {k}: {', '.join(sorted(graph[k])) or '(无外部依赖)'}")
        out = "\n".join(lines)

    return ToolResult(success=True, output=out, duration=time.time() - t0,
                      metadata={"language": lang, "format": fmt, "nodes": len(nodes),
                                "edges": len(edges), "parse_failures": parse_failures,
                                "scanned_files": len(files)})
