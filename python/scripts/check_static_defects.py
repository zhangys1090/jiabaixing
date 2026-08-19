#!/usr/bin/env python
"""静态缺陷红线 —— 拦截「导入扫描抓不到、但运行时必炸」的一类代码缺陷。

背景（2026-08-02 审计发现）：
    ``check_import_scan.py`` 只能抓到 *导入期* 就暴露的问题。真正难缠的一类是
    **函数体内引用了未定义名称**、**同名类被定义两次导致前者被静默丢弃**、
    **闭包晚绑定捕获循环变量**——这些模块能正常导入，只在特定分支被执行时才崩，
    或者更糟：不崩，但行为静默错误。

    实际抓到的真实缺陷（均已修复）：
      * ``core/distributed.py``   ── ``log`` 从未定义，锁心跳失败路径直接 NameError
      * ``api/proxy_server.py``   ── ``defaultdict`` 未导入，``__init__`` 必崩
      * ``api/sessions.py``       ── ``get_engine`` 未定义，断点恢复接口必崩
      * ``context/models.py``     ── ``BuildContext`` 定义两次且字段不同，前者是死代码
      * ``security/__init__.py``  ── 两个不同的 ``RiskLevel`` 同名导出，静默覆盖
      * ``tools/mcp_tool_bridge`` ── 闭包晚绑定，所有 MCP 工具都路由到最后一个工具

用法::

    python scripts/check_static_defects.py           # 检查，有问题 exit 1
    python scripts/check_static_defects.py --list    # 仅列出规则说明

设计原则：**只收录零告警且高信噪比的规则**。风格类（F401 未使用导入、
B904 raise from）刻意排除，避免红线沦为噪音而被整体关闭。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# 规则 → 为什么它是真实缺陷（而非风格问题）
RULES: dict[str, str] = {
    "F821": "引用未定义名称 —— 该分支一旦执行必抛 NameError",
    "F811": "同名对象重复定义 —— 前一个定义被静默丢弃，是「文档说完成、实际不生效」的典型成因",
    "F823": "局部变量在赋值前被使用 —— 必抛 UnboundLocalError",
    "F402": "导入名被循环变量遮蔽 —— 后续使用该导入必错",
    "F502": "% 格式化把 dict 传给了需要 tuple 的位置",
    "F506": "% 格式化混用位置与命名占位符",
    "F601": "用 `str in (x,)` 之类的单元素成员判断，几乎总是笔误",
    "F602": "`in` 右侧是 str 而非容器，语义与预期不符",
    "F631": "对 tuple 做断言 —— 恒为真，断言完全失效",
    "F632": "用 `is` 比较字面量 —— CPython 实现细节相关，行为不可靠",
    "F633": "对 print 使用了 >> 重定向语法（Py2 遗留）",
    "F701": "语法层面的 break 位置错误",
    "F702": "语法层面的 continue 位置错误",
    "E722": "裸 except —— 会吞掉 KeyboardInterrupt/SystemExit",
    "B006": "可变对象作为默认参数 —— 跨调用共享状态，经典隐蔽 bug",
    "B008": "在默认参数中执行函数调用 —— 只在定义时求值一次",
    "B023": "闭包未绑定循环变量 —— 所有闭包都会捕获最后一次迭代的值",
}

TARGET = "agent"


def _repo_python_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def main() -> int:
    if "--list" in sys.argv:
        print("静态缺陷红线规则：")
        for code, why in RULES.items():
            print(f"  {code:6s} {why}")
        return 0

    cwd = _repo_python_dir()
    select = ",".join(RULES)

    try:
        proc = subprocess.run(
            [
                sys.executable, "-m", "ruff", "check",
                "--select", select,
                "--no-cache",
                "--output-format", "concise",
                TARGET,
            ],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        print("[SKIP] 未找到 ruff，跳过静态缺陷红线（CI 中应确保 ruff 已安装）")
        return 0

    output = (proc.stdout or "") + (proc.stderr or "")
    if "No module named ruff" in output:
        print("[SKIP] ruff 未安装，跳过静态缺陷红线（CI 中应确保 ruff 已安装）")
        return 0

    findings = [ln for ln in output.splitlines() if ln.strip().startswith(TARGET)]

    if not findings:
        print(f"[PASS] 静态缺陷红线通过（{len(RULES)} 条规则，0 告警）")
        return 0

    print(f"[FAIL] 发现 {len(findings)} 处静态缺陷：\n")
    for line in findings:
        print(f"  {line}")

    hit_codes = {c for c in RULES if f" {c} " in output}
    print("\n涉及规则说明：")
    for code in sorted(hit_codes):
        print(f"  {code}: {RULES[code]}")
    print("\n这些不是风格问题，是会导致运行时崩溃或静默错误行为的真实缺陷，必须修复。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
