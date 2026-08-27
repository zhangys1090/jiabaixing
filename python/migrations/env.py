"""Alembic 环境 — 家百星 V5.0（审计 P0-4）。

支持 SQLite / PostgreSQL（sqlalchemy.url 由 AGENT_DB_URL 覆盖，默认记忆库）。
未启用 autogenerate：schema 以显式 DDL revision 管理（见 versions/）。
"""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context

config = context.config

if config.config_file_name:
    try:
        fileConfig(config.config_file_name)
    except Exception:
        pass

# 默认指向记忆库：DATA_ROOT/memory.db == python/data/memory.db（MemoryStore 默认）
from agent.config import DATA_ROOT

_default_url = f"sqlite:///{DATA_ROOT / 'memory.db'}"
url = os.environ.get("AGENT_DB_URL") or config.get_main_option("sqlalchemy.url") or _default_url
config.set_main_option("sqlalchemy.url", url)


def run_migrations_offline() -> None:
    context.configure(
        url=url,
        dialect_opts={"paramstyle": "qmark"},
        render_as_batch=True,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    from sqlalchemy import create_engine, pool

    connectable = create_engine(url, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            dialect_opts={"paramstyle": "qmark"},
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
