"""数据库连接工厂 — 统一 SQLite / PostgreSQL 切换.

根据 DATABASE_URL 环境变量自动选择后端：
- sqlite:   同步 sqlite3 连接（默认，零依赖）
- postgres: 同步 psycopg2 / 异步 asyncpg 连接（生产级）

设计原则：
1. 现有 sqlite3 同步代码无需修改，通过 get_sync_connection() 获取连接（自动适配 PG）
2. 新代码推荐使用 database_session() 异步上下文管理器
3. PostgreSQL 连接池自动管理，SQLite 保持单连接模式
4. 优雅降级：PostgreSQL 不可用时回退到 SQLite

Usage:
    # 同步模式（兼容现有代码，自动适配 PG）
    from agent.persistence.database import get_sync_connection
    conn = get_sync_connection()
    conn.execute("SELECT 1")

    # 异步模式（新代码推荐）
    from agent.persistence.database import database_session
    async with database_session() as conn:
        await conn.execute(text("SELECT 1"))
"""

from __future__ import annotations

import logging
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from agent.config import DATA_DIR
from agent.core.logger import log_ignored, StructuredLogger
log = StructuredLogger("database")

log = logging.getLogger(__name__)

SQLITE_DEFAULT_PATH: Path = DATA_DIR / "agent.db"

# 全局 PostgreSQL 同步连接池（psycopg2 ThreadedConnectionPool）
_pg_sync_pool: Any = None


def _get_database_url() -> str:
    return os.getenv("DATABASE_URL", "")


def _is_postgres_url(url: str) -> bool:
    return url.startswith(("postgresql://", "postgres://", "postgresql+"))


def _get_pg_sync_pool() -> Any:
    """获取 PostgreSQL 同步连接池（psycopg2 ThreadedConnectionPool）。

    懒加载，首次调用时创建。连接池参数可通过环境变量覆盖。
    """
    global _pg_sync_pool
    if _pg_sync_pool is not None:
        return _pg_sync_pool

    url = _get_database_url()
    if not _is_postgres_url(url):
        return None

    try:
        from urllib.parse import urlparse

        from psycopg2 import pool as pg_pool
    except ImportError:
        log.warning(
            "DATABASE_URL 指向 PostgreSQL，但 psycopg2 未安装。"
            "请运行: pip install psycopg2-binary。回退到 SQLite。"
        )
        return None

    parsed = urlparse(url)
    min_conn = int(os.getenv("PG_POOL_MIN", "2"))
    max_conn = int(os.getenv("PG_POOL_MAX", "10"))

    try:
        _pg_sync_pool = pg_pool.ThreadedConnectionPool(
            min_conn,
            max_conn,
            host=parsed.hostname or "localhost",
            port=parsed.port or 5432,
            database=parsed.path.lstrip("/") if parsed.path else "jiabaixing",
            user=parsed.username or "agent",
            password=parsed.password or "",
            connect_timeout=int(os.getenv("PG_CONNECT_TIMEOUT", "10")),
        )
    except Exception as _pg_err:
        # 连接失败（主机不可达/认证错误/超时等）：按设计回退 SQLite，而非向上抛异常。
        # 否则 get_sync_connection 在 PostgreSQL 不可用时无法降级，违背文档约定。
        log.warning(
            "PostgreSQL 同步连接池创建失败，回退到 SQLite: %s", _pg_err
        )
        return None
    log.info(
        f"PostgreSQL 同步连接池已创建: host={parsed.hostname}, "
        f"db={parsed.path.lstrip('/') if parsed.path else 'jiabaixing'}, "
        f"pool={min_conn}-{max_conn}"
    )
    return _pg_sync_pool


def _get_pg_sync_conn() -> Any:
    """从连接池获取一个 PostgreSQL 同步连接。"""
    pool = _get_pg_sync_pool()
    if pool is None:
        return None
    return pool.getconn()


def _put_pg_sync_conn(conn: Any) -> None:
    """归还 PostgreSQL 同步连接到连接池。"""
    pool = _get_pg_sync_pool()
    if pool is not None and conn is not None:
        try:
            pool.putconn(conn)
        except Exception as _exc:
            log.debug("database 异常处理", error=str(_exc))
            log_ignored(log, "database._put_pg_sync_conn", _exc)


def get_sync_connection(
    db_path: str | Path | None = None,
    **kwargs: Any,
) -> Any:
    """获取同步数据库连接 — 自动适配 SQLite / PostgreSQL。

    PostgreSQL 模式使用 psycopg2 ThreadedConnectionPool，返回 psycopg2 connection。
    调用方需自行归还连接（调用 _put_pg_sync_conn）或使用上下文管理器。

    Args:
        db_path: 自定义数据库路径（仅 SQLite 模式有效），默认使用 DATA_DIR/agent.db。
        **kwargs: 传递给 sqlite3.connect 的额外参数（仅 SQLite 模式有效）。

    Returns:
        sqlite3.Connection 或 psycopg2 connection: 同步数据库连接。
    """
    url = _get_database_url()

    if _is_postgres_url(url):
        pg_conn = _get_pg_sync_conn()
        if pg_conn is not None:
            return pg_conn
        log.warning("PostgreSQL 连接池不可用，回退到 SQLite。")

    path = Path(db_path) if db_path else SQLITE_DEFAULT_PATH
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(path), **kwargs)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@asynccontextmanager
async def database_session() -> AsyncIterator[Any]:
    """统一异步数据库会话上下文管理器 — 自动选择 SQLite/PostgreSQL 后端。

    PostgreSQL 模式使用 SQLAlchemy async engine（asyncpg）。
    SQLite 模式使用 aiosqlite。

    Yields:
        SQLAlchemy AsyncConnection 或 aiosqlite Connection。

    Usage:
        async with database_session() as conn:
            result = await conn.execute(text("SELECT 1"))
    """
    backend = get_database_backend()
    if backend == "postgres":
        engine = get_async_engine()
        async with engine.begin() as conn:
            yield conn
    else:
        import aiosqlite

        async with aiosqlite.connect(str(SQLITE_DEFAULT_PATH)) as conn:
            conn.row_factory = aiosqlite.Row
            yield conn


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

    def _validate_table_identifier(self, table_name: str) -> str:
        """校验表名为合法 SQL 标识符（防标识符注入）。

        SQLite 表名无法通过参数化占位符绑定，故采用严格白名单校验：
        仅允许字母/数字/下划线且以字母或下划线开头。非法则抛 ValueError，
        避免 `table_name` 来自不可信输入时篡改 SQL 结构。
        """
        if not isinstance(table_name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table_name):
            raise ValueError(f"非法的表名标识符: {table_name!r}")
        return table_name

    def get_table_schema(self, table_name: str) -> list[dict[str, Any]]:
        """获取表的列信息."""
        conn = self._get_sqlite_conn()
        try:
            cursor = conn.execute(f"PRAGMA table_info({self._validate_table_identifier(table_name)})")
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
            cursor = conn.execute(f"SELECT COUNT(*) FROM {self._validate_table_identifier(table_name)}")
            return cursor.fetchone()[0]
        finally:
            conn.close()
