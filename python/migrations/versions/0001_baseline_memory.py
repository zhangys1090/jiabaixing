"""baseline: memory store schema (审计 P0-4)

建立记忆库的权威 schema 版本基线。此前 schema 由 MemoryStore._init_tables 以
CREATE TABLE IF NOT EXISTS 自愈，无任何版本/升级/回滚机制；本 revision 将
memories 表结构纳入 Alembic 管理，后续任何字段变更都通过新 revision 演进，
避免存量库因 schema 变更而不可用。

Revision ID: 0001_baseline_memory
Revises:
Create Date: 2026-08-02
"""
from __future__ import annotations

from alembic import op

revision = "0001_baseline_memory"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            tokens TEXT NOT NULL DEFAULT '',
            memory_type TEXT NOT NULL DEFAULT 'short_term',
            scene TEXT NOT NULL DEFAULT '',
            emotion TEXT NOT NULL DEFAULT 'neutral',
            timestamp REAL NOT NULL DEFAULT 0,
            metadata TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    op.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            content,
            tokens,
            memory_type,
            scene,
            content='memories',
            content_rowid='rowid'
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS memories_fts")
    op.execute("DROP TABLE IF EXISTS memories")
