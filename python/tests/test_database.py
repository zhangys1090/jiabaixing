"""数据库连接工厂单元测试.

覆盖：
- SQLite 同步连接
- 数据库后端识别
- SQLAlchemy 异步/同步引擎创建
- PostgreSQL URL 解析
- 迁移工具
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

from agent.persistence.database import (
    DatabaseMigration,
    get_async_engine,
    get_database_backend,
    get_sync_connection,
    get_sync_engine,
)


class TestGetDatabaseBackend:
    def test_sqlite_default(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            assert get_database_backend() == "sqlite"

    def test_postgres_url(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://user:pass@localhost/db"}):
            assert get_database_backend() == "postgres"

    def test_postgres_async_url(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql+asyncpg://user:pass@localhost/db"}):
            assert get_database_backend() == "postgres"


class TestGetSyncConnection:
    def test_sqlite_connection(self, tmp_path):
        db_path = tmp_path / "test.db"
        conn = get_sync_connection(db_path=str(db_path))
        assert isinstance(conn, sqlite3.Connection)

        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO test (name) VALUES (?)", ("hello",))
        conn.commit()

        cursor = conn.execute("SELECT name FROM test")
        assert cursor.fetchone()[0] == "hello"
        conn.close()

    def test_wal_mode(self, tmp_path):
        db_path = tmp_path / "wal_test.db"
        conn = get_sync_connection(db_path=str(db_path))
        cursor = conn.execute("PRAGMA journal_mode")
        mode = cursor.fetchone()[0]
        assert mode == "wal"
        conn.close()

    def test_foreign_keys_enabled(self, tmp_path):
        db_path = tmp_path / "fk_test.db"
        conn = get_sync_connection(db_path=str(db_path))
        cursor = conn.execute("PRAGMA foreign_keys")
        assert cursor.fetchone()[0] == 1
        conn.close()

    def test_postgres_url_fallback_to_sqlite(self, tmp_path):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://user:pass@localhost/db"}):
            db_path = tmp_path / "fallback.db"
            conn = get_sync_connection(db_path=str(db_path))
            assert isinstance(conn, sqlite3.Connection)
            conn.close()


class TestGetAsyncEngine:
    def test_sqlite_async_engine(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            engine = get_async_engine()
            assert engine is not None
            assert "sqlite" in str(engine.url)

    def test_postgres_async_engine_url_conversion(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://user:pass@localhost/mydb"}):
            engine = get_async_engine()
            assert engine is not None
            url_str = str(engine.url)
            assert "asyncpg" in url_str
            assert "mydb" in url_str


class TestGetSyncEngine:
    def test_sqlite_sync_engine(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            engine = get_sync_engine()
            assert engine is not None
            assert "sqlite" in str(engine.url)


class TestDatabaseMigration:
    def test_list_tables(self, tmp_path):
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)")
        conn.commit()
        conn.close()

        with patch.object(DatabaseMigration, "_get_sqlite_conn", return_value=sqlite3.connect(str(db_path))):
            migration = DatabaseMigration()
            tables = migration.list_tables()
            assert "users" in tables
            assert "posts" in tables

    def test_get_table_schema(self, tmp_path):
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER DEFAULT 0)")
        conn.commit()
        conn.close()

        with patch.object(DatabaseMigration, "_get_sqlite_conn", return_value=sqlite3.connect(str(db_path))):
            migration = DatabaseMigration()
            schema = migration.get_table_schema("users")
            assert len(schema) == 3
            names = [col["name"] for col in schema]
            assert "id" in names
            assert "name" in names
            assert "age" in names

    def test_get_row_count(self, tmp_path):
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY)")
        conn.execute("INSERT INTO items VALUES (1)")
        conn.execute("INSERT INTO items VALUES (2)")
        conn.execute("INSERT INTO items VALUES (3)")
        conn.commit()
        conn.close()

        with patch.object(DatabaseMigration, "_get_sqlite_conn", return_value=sqlite3.connect(str(db_path))):
            migration = DatabaseMigration()
            count = migration.get_row_count("items")
            assert count == 3
