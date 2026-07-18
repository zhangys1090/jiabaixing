"""发布包编译脚本 — 将 .py 编译为 .pyc 并移除源码，保护商业逻辑。

用法:
    python scripts/compile_pyc.py [--keep-source] [--exclude module1,module2]

功能:
    1. 递归编译 python-backend/agent 下所有 .py 为 .pyc
    2. 默认移除 .py 文件（仅保留 .pyc）
    3. --keep-source 保留 .py 文件（调试模式）
    4. --exclude 排除特定模块不编译（如需要动态修改的配置文件）
    5. 自动排除 __pycache__ 中非当前 Python 版本的 .pyc
"""
from __future__ import annotations

import argparse
import compileall
import os
import shutil
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "src" / "frontend" / "release" / "JiabaixingDesktop-win32-x64" / "resources" / "app" / "python-backend" / "agent"

EXCLUDE_DEFAULT = ["config.py", "__init__.py"]


def compile_agent(keep_source: bool = False, exclude: list[str] | None = None) -> dict[str, int]:
    exclude = exclude or EXCLUDE_DEFAULT
    stats = {"compiled": 0, "removed": 0, "skipped": 0, "errors": 0}

    if not AGENT_DIR.exists():
        print(f"ERROR: Agent directory not found: {AGENT_DIR}")
        sys.exit(1)

    print(f"Compiling Python source in: {AGENT_DIR}")
    print(f"  keep_source={keep_source}, exclude={exclude}")

    success = compileall.compile_dir(
        str(AGENT_DIR),
        force=True,
        optimize=2,
        quiet=1,
        legacy=True,
    )

    if not success:
        print("WARNING: Some files failed to compile")
        stats["errors"] += 1

    for py_file in AGENT_DIR.rglob("*.py"):
        rel = py_file.relative_to(AGENT_DIR)
        if py_file.name in exclude:
            stats["skipped"] += 1
            continue

        pyc_file = py_file.with_suffix(".pyc")
        if not pyc_file.exists():
            pyc_cand = py_file.parent / "__pycache__" / f"{py_file.stem}.cpython-{sys.version_info.major}{sys.version_info.minor}.opt-2.pyc"
            if pyc_cand.exists():
                shutil.copy2(str(pyc_cand), str(pyc_file))
            else:
                print(f"  WARNING: No .pyc for {rel}")
                stats["errors"] += 1
                continue

        stats["compiled"] += 1

        if not keep_source:
            py_file.unlink()
            stats["removed"] += 1

    for cache_dir in AGENT_DIR.rglob("__pycache__"):
        shutil.rmtree(str(cache_dir), ignore_errors=True)

    print(f"\nDone: compiled={stats['compiled']}, removed={stats['removed']}, "
          f"skipped={stats['skipped']}, errors={stats['errors']}")
    return stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compile agent source to .pyc")
    parser.add_argument("--keep-source", action="store_true", help="Keep .py files after compilation")
    parser.add_argument("--exclude", type=str, default="", help="Comma-separated list of files to exclude")
    args = parser.parse_args()

    exclude_list = [x.strip() for x in args.exclude.split(",") if x.strip()] if args.exclude else None
    compile_agent(keep_source=args.keep_source, exclude=exclude_list)
