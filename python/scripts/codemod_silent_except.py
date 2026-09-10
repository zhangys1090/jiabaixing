"""把 ``except X: pass`` 批量改写为可观测的 ``log_ignored(...)`` — 审计 P2-1 配套。

设计要点
--------
* 只改写 **handler 体仅有 pass/...** 的处理器（与 ``check_silent_except.py``
  的判定完全一致），其余一律不动。
* 复用同一套「可选依赖导入守卫」豁免规则，避免把合法的
  ``try: import x  except ImportError: pass`` 改坏。
* 为 handler 补上异常绑定名（``as _exc``），若已有绑定名则沿用。
  裸 ``except:`` 会被改成 ``except BaseException as _exc:``（语义等价）。
* 生成的调用形如::

      log_ignored(log, "engine.AgentEngine._init_metrics", _exc)

  其中位置串由 AST 的外层 class/function 链推导，便于定位。
* 幂等：已改写过的 handler 体不再是 pass，第二次运行即为 no-op。

用法::

    python scripts/codemod_silent_except.py --dry-run agent/core/engine.py
    python scripts/codemod_silent_except.py --apply agent/core/engine.py ...
"""

from __future__ import annotations

import argparse
import ast
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
PY_ROOT = HERE.parent

sys.path.insert(0, str(HERE))
from check_silent_except import (
    _is_optional_dependency_guard,
    _is_silent,
)

BIND_NAME = "_exc"
HELPER_IMPORT = "from agent.core.logger import log_ignored"
# 模块级 logger 变量的候选名（按优先级）
LOGGER_CANDIDATES = ("log", "logger", "_log", "LOG", "_logger")


def _module_logger_name(tree: ast.Module) -> str | None:
    """探测模块级 logger 变量名；找不到返回 None（该文件需人工处理）。"""
    assigned: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    assigned.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            assigned.add(node.target.id)
    for name in LOGGER_CANDIDATES:
        if name in assigned:
            return name
    return None


def _import_anchor_line(tree: ast.Module) -> int:
    """返回插入 helper import 的 0-based 行号（顶层最后一条 import 之后）。"""
    last = 0
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            last = max(last, node.end_lineno or node.lineno)
        elif last:
            break  # import 区已结束
    return last


def _qualname(stack: list[ast.AST], module: str) -> str:
    parts = [module]
    for node in stack:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            parts.append(node.name)
    return ".".join(parts)


def _collect(tree: ast.Module, module: str) -> list[tuple[ast.ExceptHandler, str]]:
    """深度优先收集待改写 handler，附带其 qualname。"""
    found: list[tuple[ast.ExceptHandler, str]] = []

    def walk(node: ast.AST, stack: list[ast.AST]) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.Try):
                for handler in child.handlers:
                    if _is_silent(handler) and not _is_optional_dependency_guard(child, handler):
                        found.append((handler, _qualname(stack, module)))
            walk(child, stack + [child])

    walk(tree, [])
    return found


def _header_end_line(handler: ast.ExceptHandler, lines: list[str]) -> int:
    """返回 handler 头部（以 ``:`` 结尾那一行）的 0-based 行号。"""
    body_start = handler.body[0].lineno - 1
    for i in range(body_start - 1, handler.lineno - 2, -1):
        stripped = lines[i].split("#")[0].rstrip()
        if stripped.endswith(":"):
            return i
    raise ValueError(f"无法定位 except 头部结尾，line={handler.lineno}")


def _rewrite_header(line: str, handler: ast.ExceptHandler) -> str:
    """在 ``except ...:`` 的冒号前插入 ``as _exc``。"""
    code, sep, comment = line.partition("#")
    stripped = code.rstrip()
    if not stripped.endswith(":"):
        raise ValueError(f"意外的 except 头部: {line!r}")
    trailing_ws = code[len(stripped):]
    body = stripped[:-1].rstrip()

    if body.rstrip() == "except":
        body = "except BaseException"
    new = f"{body} as {BIND_NAME}:{trailing_ws}"
    return new + sep + comment if sep else new


def process(path: pathlib.Path, apply: bool) -> int:
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    module = path.stem
    targets = _collect(tree, module)
    if not targets:
        return 0

    # 无模块级 logger 时传 None —— log_ignored 内部会用兜底 logger，
    # 这样不必为「记账」去改动模块结构（新增全局变量）。
    logger_var = _module_logger_name(tree) or "None"

    lines = src.splitlines(keepends=True)
    # 自底向上改写，避免行号漂移
    targets.sort(key=lambda t: t[0].lineno, reverse=True)

    for handler, qual in targets:
        bind = handler.name or BIND_NAME
        body_start = handler.body[0].lineno - 1
        body_end = (handler.body[-1].end_lineno or handler.body[-1].lineno) - 1
        indent = lines[body_start][: len(lines[body_start]) - len(lines[body_start].lstrip())]

        call = f'{indent}log_ignored({logger_var}, "{qual}", {bind})\n'
        lines[body_start : body_end + 1] = [call]

        if handler.name is None:
            hdr = _header_end_line(handler, lines)
            lines[hdr] = _rewrite_header(lines[hdr], handler)

    new_src = "".join(lines)

    # 补 helper 导入：优先跟在已有 logger 导入后，否则接在顶层 import 区末尾
    if "log_ignored" in new_src and HELPER_IMPORT not in new_src:
        out: list[str] = []
        inserted = False
        for line in new_src.splitlines(keepends=True):
            out.append(line)
            if not inserted and line.startswith("from agent.core.logger import"):
                out.append(HELPER_IMPORT + "\n")
                inserted = True
        if inserted:
            new_src = "".join(out)
        else:
            anchor = _import_anchor_line(ast.parse(new_src))
            if anchor == 0:
                print(f"[SKIP] {path.name}: 无顶层 import 区，需人工补 helper 导入")
                return 0
            out = new_src.splitlines(keepends=True)
            out.insert(anchor, HELPER_IMPORT + "\n")
            new_src = "".join(out)

    ast.parse(new_src)  # 语法自检，失败即中止，绝不写坏文件

    if apply:
        path.write_text(new_src, encoding="utf-8")
    return len(targets)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    total = 0
    for f in args.files:
        p = (PY_ROOT / f) if not pathlib.Path(f).is_absolute() else pathlib.Path(f)
        n = process(p, args.apply)
        total += n
        print(f"{'改写' if args.apply else '待改写'} {n:3d} 处  {f}")
    print(f"合计 {total} 处")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
