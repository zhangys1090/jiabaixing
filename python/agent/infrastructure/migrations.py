"""启动期迁移应用（审计 P0-4）。

在项目启动早期调用 run_migrations()，把 Alembic 升级到 head，使存量库 schema
与代码版本对齐。默认应用记忆库；其它库通过 AGENT_DB_URL 切换。失败不阻断启动
（仅告警），避免迁移问题导致整个进程无法拉起。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

_log = None


def run_migrations(db_path: str | None = None) -> bool:
    """对目标库执行 `alembic upgrade head`。返回是否成功。"""
    global _log
    if _log is None:
        from agent.core.logger import StructuredLogger

        _log = StructuredLogger("infra.migrations")

    root = Path(__file__).resolve().parent.parent.parent  # python/
    migrations_ini = root / "migrations" / "alembic.ini"
    if not migrations_ini.exists():
        _log.warning("未找到迁移配置，跳过", path=str(migrations_ini))
        return False

    env = dict(os.environ)
    env["PYTHONPATH"] = str(root) + os.pathsep + env.get("PYTHONPATH", "")
    if db_path:
        env["AGENT_DB_URL"] = f"sqlite:///{os.path.abspath(db_path)}"

    try:
        rc = subprocess.call(
            [sys.executable, "-m", "alembic", "-c", str(migrations_ini), "upgrade", "head"],
            cwd=str(root),
            env=env,
        )
    except Exception as e:  # noqa: BLE001
        _log.warning("迁移执行异常", error=str(e))
        return False

    if rc != 0:
        _log.warning("迁移返回非零退出码", rc=rc)
        return False
    _log.info("迁移已应用至 head")
    return True
