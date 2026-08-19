"""静默吞异常红线（棘轮式）— 审计 §1.7 D2 配套治理。

背景
----
全仓存在大量 ``except SomeError: pass`` —— 异常被吞掉且不留任何日志。
其危害是「故障不可观测」：安全检查抛异常时输出照常放行、记忆写入失败时
数据静默丢失，而日志、指标、health 全都看不到。

一次性清零 300+ 处不现实且高风险，因此本脚本采用**棘轮（ratchet）策略**：
以 ``scripts/silent_except_baseline.json`` 记录各文件当前数量作为基线，
- 任何文件数量**增加** → exit 1（阻断 CI），逼停新增技术债；
- 数量**减少** → 提示更新基线（欢迎，但不阻断）；
- 出现基线中没有的新文件且数量 > 0 → exit 1。

同时对「安全关键路径」执行更严格的**零容忍白名单**：这些模块里的静默吞
异常等价于安全 fail-open（见 D4/D6），一处都不允许。

用法
----
    python scripts/check_silent_except.py              # 校验（CI）
    python scripts/check_silent_except.py --update     # 重新生成基线

退出码：0 = 通过；1 = 新增静默吞异常。
"""

from __future__ import annotations

import argparse
import ast
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
PY_ROOT = HERE.parent
AGENT_ROOT = PY_ROOT / "agent"
BASELINE = HERE / "silent_except_baseline.json"

# 安全关键路径：这些文件里的静默吞异常 = 安全 fail-open，零容忍。
# 对应审计 D4（审批）/ D6（守卫、Schema 校验）已修复项，防止回潮。
ZERO_TOLERANCE: tuple[str, ...] = (
    "agent/core/conversation_loop.py",
    "agent/tools/approval_manager.py",
    "agent/security/",
)


def _rel(p: pathlib.Path) -> str:
    return p.relative_to(PY_ROOT).as_posix()


def _is_silent(handler: ast.ExceptHandler) -> bool:
    """handler 体仅有 ``pass`` 或 ``...`` 即视为静默吞异常。"""
    return all(
        isinstance(s, ast.Pass)
        or (
            isinstance(s, ast.Expr)
            and isinstance(s.value, ast.Constant)
            and s.value.value is Ellipsis
        )
        for s in handler.body
    )


_IMPORT_ERRORS = {"ImportError", "ModuleNotFoundError"}


def _caught_names(handler: ast.ExceptHandler) -> set[str]:
    """取出 handler 捕获的异常类型名集合；裸 except 返回空集。"""
    node = handler.type
    if node is None:
        return set()
    items = node.elts if isinstance(node, ast.Tuple) else [node]
    names: set[str] = set()
    for it in items:
        if isinstance(it, ast.Name):
            names.add(it.id)
        elif isinstance(it, ast.Attribute):
            names.add(it.attr)
    return names


def _is_optional_dependency_guard(try_node: ast.Try, handler: ast.ExceptHandler) -> bool:
    """判断是否为「可选依赖导入守卫」这一合法模式，予以豁免。

    典型形态::

        try:
            import chromadb
            _chromadb_available = True
        except ImportError:
            pass

    豁免理由：这类 pass **不是**故障不可观测——依赖缺失的事实由随后的
    可用性标志位（或使用点的 AttributeError/None 分支）显式承载，属于
    有意的能力降级声明，而非把真实异常吞进黑洞。

    豁免条件（三者同时满足，故意收得很紧）：
      1) 只捕获 ImportError / ModuleNotFoundError（不含裸 except、不含 Exception）；
      2) try 体仅由 import 语句与简单赋值构成（不含任何函数调用等副作用）；
      3) try 体至少包含一条 import 语句。
    """
    if not _caught_names(handler) <= _IMPORT_ERRORS or not _caught_names(handler):
        return False

    has_import = False
    for stmt in try_node.body:
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            has_import = True
            continue
        # 仅允许「常量/名称」级别的简单赋值，如 _x_available = True
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            value = stmt.value
            if value is None or isinstance(value, (ast.Constant, ast.Name, ast.Attribute)):
                continue
        return False

    return has_import


def scan() -> tuple[dict[str, int], dict[str, list[int]], list[str]]:
    """扫描全包，返回 (每文件计数, 每文件行号, 解析失败文件)。"""
    counts: dict[str, int] = {}
    locations: dict[str, list[int]] = {}
    parse_errors: list[str] = []

    for f in sorted(AGENT_ROOT.rglob("*.py")):
        rel = _rel(f)
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except (SyntaxError, ValueError) as e:
            # BOM / 语法错误：由 check_import_scan.py 负责阻断，此处仅记录。
            parse_errors.append(f"{rel}: {type(e).__name__}: {str(e)[:80]}")
            continue

        # 遍历 Try 节点（而非裸 ExceptHandler），以便能检视 try 体——
        # 合法的可选依赖守卫（仅 import + 简单赋值 + 捕获 ImportError）予以豁免。
        silent_lines: list[int] = []
        for try_node in ast.walk(tree):
            if not isinstance(try_node, ast.Try):
                continue
            for handler in try_node.handlers:
                if _is_optional_dependency_guard(try_node, handler):
                    continue
                if _is_silent(handler):
                    silent_lines.append(handler.lineno)
        if silent_lines:
            counts[rel] = len(silent_lines)
            locations[rel] = sorted(silent_lines)

    return counts, locations, parse_errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true", help="重新生成基线文件")
    args = ap.parse_args()

    counts, locations, parse_errors = scan()
    total = sum(counts.values())

    if args.update:
        BASELINE.write_text(
            json.dumps(
                {"_total": total, "_note": "静默吞异常棘轮基线，只许降不许升", **dict(sorted(counts.items()))},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"[UPDATED] 基线已更新: {len(counts)} 个文件 / {total} 处")
        return 0

    if not BASELINE.exists():
        print(f"[FAIL] 缺少基线文件 {BASELINE.name}，请先运行 --update")
        return 1

    base_raw = json.loads(BASELINE.read_text(encoding="utf-8"))
    base = {k: v for k, v in base_raw.items() if not k.startswith("_")}

    print(f"[INFO] 静默吞异常总数: {total}（基线 {base_raw.get('_total', sum(base.values()))}）")
    if parse_errors:
        print(f"[WARN] AST 解析失败 {len(parse_errors)} 个文件（由导入扫描红线负责阻断）:")
        for e in parse_errors:
            print(f"    - {e}")

    regressions: list[str] = []
    for rel, n in sorted(counts.items()):
        allowed = base.get(rel, 0)
        if n > allowed:
            new_lines = locations[rel]
            regressions.append(
                f"{rel}: {allowed} → {n}（+{n - allowed}），行号 {new_lines}"
            )

    # 零容忍路径
    zero_viol: list[str] = []
    for rel, n in sorted(counts.items()):
        if any(rel.startswith(z) for z in ZERO_TOLERANCE) and n > 0:
            zero_viol.append(f"{rel}: {n} 处，行号 {locations[rel]}")

    improved = [
        f"{rel}: {base[rel]} → {counts.get(rel, 0)}"
        for rel in sorted(base)
        if counts.get(rel, 0) < base[rel]
    ]
    if improved:
        print(f"[GOOD] {len(improved)} 个文件已改善，建议运行 --update 收紧基线:")
        for i in improved[:10]:
            print(f"    - {i}")

    if zero_viol:
        print(f"[FAIL] 安全关键路径零容忍违规 {len(zero_viol)} 个文件:")
        for v in zero_viol:
            print(f"    - {v}")
    if regressions:
        print(f"[FAIL] 静默吞异常新增 {len(regressions)} 个文件:")
        for r in regressions:
            print(f"    - {r}")

    if zero_viol or regressions:
        print("[BLOCK] 请为新增的 except 补 log.error/降级标记，禁止裸 pass (exit 1)")
        return 1

    print("[PASS] 无新增静默吞异常")
    return 0


if __name__ == "__main__":
    sys.exit(main())
