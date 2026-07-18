"""数据库连接工厂 — 统一 SQLite / PostgreSQL 切换.

根据 DATABASE_URL 环境变量自动选择后端：
- sqlite:   同步 sqlite3 连接（默认，零依赖）
- postgres: 异步 asyncpg / psycopg 连接（生产级，需 pip install asyncpg）

设计原则：
1. 现有 sqlite3 同步代码无需修改，通过 get_sync_connection() 获取连接
2. 新代码推荐使用 get_async_engine() 获取 SQLAlchemy 异步引擎
3. PostgreSQL 连接池自动管理，SQLite 保持单连接模式
4. 优雅降级：PostgreSQL 不可用时回退到 SQLite

Usage:
    # 同步模式（兼容现有代码）
    from agent.persistence.database import get_sync_connection
    conn = get_sync_connection()
    conn.execute("SELECT 1")

    # 异步模式（新代码推荐）
    from agent.persistence.database import get_async_engine
    engine = get_async_engine()
    async with engine.begin() as conn:
        result = await conn.execute(text("SELECT 1"))
"""

from __future__ import annotations

import logging
import os
import sqlite3
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR

log = logging.getLogger(__name__)

SQLITE_DEFAULT_PATH: Path = DATA_DIR / "agent.db"


def _get_database_url() -> str:
    return os.getenv("DATABASE_URL", "")


def _is_postgres_url(url: str) -> bool:
    return url.startswith(("postgresql://", "postgres://", "postgresql+"))


def get_sync_connection(
    db_path: str | Path | None = None,
    **kwargs: Any,
) -> sqlite3.Connection:
    """获取同步数据库连接（SQLite 模式）.

    PostgreSQL 模式下不应使用同步连接。若 DATABASE_URL 指向 PostgreSQL，
    本函数将发出警告并回退到 SQLite。

    Args:
        db_path: 自定义数据库路径，默认使用 DATA_DIR/agent.db.
        **kwargs: 传递给 sqlite3.connect 的额外参数.

    Returns:
        sqlite3.Connection: SQLite 同步连接.
    """
    url = _get_database_url()
    if _is_postgres_url(url):
        log.warning(
            "DATABASE_URL 指向 PostgreSQL，但请求了同步连接。"
            "请使用 get_async_engine() 获取异步引擎。回退到 SQLite。"
        )

    path = Path(db_path) if db_path else SQLITE_DEFAULT_PATH
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(path), **kwargs)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def get_database_backend() -> str:
    """获取当前数据库后端类型.

    Returns:
        str: "sqlite" 或 "postgres".
    """
    url = _get_database_url()
    if _is_postgres_url(url):
        return "postgres"
    return "sqlite"


def get_async_engine() -> Any:
    """获取 SQLAlchemy 异步引擎.

    SQLite 模式使用 aiosqlite，PostgreSQL 模式使用 asyncpg。
    需要安装 sqlalchemy 和对应驱动。

    Returns:
        AsyncEngine: SQLAlchemy 异步引擎.

    Raises:
        ImportError: 缺少必要依赖.
    """
    try:
        from sqlalchemy.ext.asyncio import create_async_engine
    except ImportError:
        raise ImportError(
            "SQLAlchemy 未安装。请运行: pip install sqlalchemy[asyncio]"
        )

    url = _get_database_url()

    if _is_postgres_url(url):
        async_url = url
        if url.startswith("postgresql://"):
            async_url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        elif url.startswith("postgres://"):
            async_url = url.replace("postgres://", "postgresql+asyncpg://", 1)

        log.info(f"创建 PostgreSQL 异步引擎: {async_url.split('@')[-1]}")
        return create_async_engine(
            async_url,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,
            pool_recycle=3600,
            echo=False,
        )
    else:
        sqlite_path = SQLITE_DEFAULT_PATH
        sqlite_url = f"sqlite+aiosqlite:///{sqlite_path}"
        log.info(f"创建 SQLite 异步引擎: {sqlite_path}")
        return create_async_engine(
            sqlite_url,
            echo=False,
            connect_args={"check_same_thread": False},
        )


def get_sync_engine() -> Any:
    """获取 SQLAlchemy 同步引擎.

    Returns:
        Engine: SQLAlchemy 同步引擎.
    """
    try:
        from sqlalchemy import create_engine
    except ImportError:
        raise ImportError(
            "SQLAlchemy 未安装。请运行: pip install sqlalchemy"
        )

    url = _get_database_url()

    if _is_postgres_url(url):
        sync_url = url
        if "+" in url.split("://")[1].split("/")[0]:
            pass
        log.info(f"创建 PostgreSQL 同步引擎: {url.split('@')[-1]}")
        return create_engine(
            url,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,
            pool_recycle=3600,
            echo=False,
        )
    else:
        sqlite_path = SQLITE_DEFAULT_PATH
        sqlite_url = f"sqlite:///{sqlite_path}"
        return create_engine(
            sqlite_url,
            echo=False,
            connect_args={"check_same_thread": False},
        )


class DatabaseMigration:
    """数据库迁移工具 — SQLite → PostgreSQL 数据迁移.

    Usage:
        migration = DatabaseMigration()
        migration.migrate_table("sessions")
        migration.migrate_table("trajectory")
    """

    def __init__(self) -> None:
        self._sqlite_path = SQLITE_DEFAULT_PATH
        self._pg_url = _get_database_url()

    def _get_sqlite_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._sqlite_path))
        conn.row_factory = sqlite3.Row
        return conn

    def list_tables(self) -> list[str]:
        """列出 SQLite 中所有用户表."""
        conn = self._get_sqlite_conn()
        try:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
            return [row[0] for row in cursor.fetchall()]
        finally:
            conn.close()

    def get_table_schema(self, table_name: str) -> list[dict[str, Any]]:
        """获取表的列信息."""
        conn = self._get_sqlite_conn()
        try:
            cursor = conn.execute(f"PRAGMA table_info({table_name})")
            return [
                {
                    "cid": row[0],
                    "name": row[1],
                    "type": row[2],
                    "notnull": row[3],
                    "default": row[4],
                    "pk": row[5],
                }
                for row in cursor.fetchall()
            ]
        finally:
            conn.close()

    def get_row_count(self, table_name: str) -> int:
        """获取表行数."""
        conn = self._get_sqlite_conn()
        try:
            cursor = conn.execute(f"SELECT COUNT(*) FROM {table_name}")
            return cursor.fetchone()[0]
        finally:
            conn.close()
