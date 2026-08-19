"""迁移运行器（审计 P0-4）：将 Alembic 应用到目标 SQLite 库。

用法:
    python scripts/migrate.py upgrade [--db PATH] [--url URL]
    python scripts/migrate.py downgrade [--revision REV]
    python scripts/migrate.py current [--db PATH]
    python scripts/migrate.py stamp [--revision head]

默认目标库为记忆库 python/data/memory.db；可用 --db / --url / AGENT_DB_URL 切换到
其它持久化库（如 trajectory.db、session_lineage.db）。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # python/
MIGRATIONS = ROOT / "migrations"


def main() -> int:
    ap = argparse.ArgumentParser(description="家百星 Alembic 迁移运行器")
    ap.add_argument("command", choices=["upgrade", "downgrade", "current", "stamp"])
    ap.add_argument("--db", default=None, help="目标 SQLite 库路径（覆盖 AGENT_DB_URL）")
    ap.add_argument("--url", default=None, help="完整 sqlalchemy url，如 sqlite:////abs/path.db")
    ap.add_argument("--revision", default="head")
    args = ap.parse_args()

    url = args.url or os.environ.get("AGENT_DB_URL")
    if args.db and not url:
        url = f"sqlite:///{os.path.abspath(args.db)}"
    if url:
        os.environ["AGENT_DB_URL"] = url

    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")

    cmd = [sys.executable, "-m", "alembic", "-c", str(MIGRATIONS / "alembic.ini")]
    if args.command == "stamp":
        cmd += ["stamp", args.revision]
    else:
        cmd += [args.command, args.revision]

    return subprocess.call(cmd, cwd=str(ROOT), env=env)


if __name__ == "__main__":
    raise SystemExit(main())
