from __future__ import annotations

import json
import sqlite3
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from agent.core.logger import StructuredLogger

log = StructuredLogger("reflection_knowledge_base")


class ExperienceType(str, Enum):
    TOOL_USAGE = "tool_usage"
    ERROR_RECOVERY = "error_recovery"
    PLANNING = "planning"
    STRATEGY = "strategy"
    META = "meta"
    PROMPT = "prompt"


@dataclass
class ReflectionExperience:
    type: str = ""
    context: dict[str, Any] = field(default_factory=dict)
    action: str = ""
    result: str = ""
    reflection: str = ""
    insight: str = ""
    success_rate: float = 0.0
    usage_count: int = 0
    tags: list[str] = field(default_factory=list)
    id: str = ""
    created_at: float = 0.0
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if not self.type:
            self.type = ExperienceType.TOOL_USAGE.value
        if self.timestamp and not self.created_at:
            self.created_at = self.timestamp
        elif self.created_at and not self.timestamp:
            self.timestamp = self.created_at


class ReflectionKnowledgeBase:
    MAX_CACHE_SIZE = 100

    def __init__(self, db_path: str | Path | None = None) -> None:
        if db_path is None:
            from agent.config import DATA_DIR
            db_path = DATA_DIR / "reflection_kb.db"
        self._path = Path(db_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        from agent.persistence.database import get_sync_connection
        self._conn = get_sync_connection(db_path=str(self._path))
        self._conn.row_factory = sqlite3.Row
        self._init_tables()
        self._cache: OrderedDict[str, ReflectionExperience] = OrderedDict()

    def _init_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS experiences (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                context TEXT NOT NULL DEFAULT '{}',
                action TEXT NOT NULL DEFAULT '',
                result TEXT NOT NULL DEFAULT '',
                reflection TEXT NOT NULL DEFAULT '',
                insight TEXT NOT NULL DEFAULT '',
                success_rate REAL NOT NULL DEFAULT 0.0,
                usage_count INTEGER NOT NULL DEFAULT 0,
                tags TEXT NOT NULL DEFAULT '[]',
                created_at REAL NOT NULL DEFAULT 0,
                timestamp REAL NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_exp_type ON experiences(type);
            CREATE INDEX IF NOT EXISTS idx_exp_action ON experiences(action);
        """)
        self._conn.commit()

    def _find_similar(self, experience: ReflectionExperience) -> ReflectionExperience | None:
        if not experience.type or not experience.action:
            return None
        cur = self._conn.execute(
            "SELECT * FROM experiences WHERE type = ? AND action = ? LIMIT 1",
            (experience.type, experience.action),
        )
        row = cur.fetchone()
        if row:
            return self._row_to_experience(row)
        return None

    def add_experience(self, experience: ReflectionExperience) -> str:
        valid_types = {e.value for e in ExperienceType}
        if experience.type and experience.type not in valid_types:
            raise ValueError(f"Invalid experience type: {experience.type}")

        if not experience.id:
            similar = self._find_similar(experience)
            if similar:
                merged = ReflectionExperience(
                    id=similar.id,
                    type=experience.type or similar.type,
                    context={**similar.context, **experience.context},
                    action=experience.action or similar.action,
                    result=experience.result or similar.result,
                    reflection=experience.reflection or similar.reflection,
                    insight=experience.insight or similar.insight,
                    success_rate=experience.success_rate if experience.success_rate > 0 else similar.success_rate,
                    usage_count=similar.usage_count + 1,
                    tags=list(set(similar.tags + experience.tags)),
                    created_at=similar.created_at,
                    timestamp=similar.timestamp,
                )
                experience = merged
            else:
                experience.id = uuid.uuid4().hex

        now = time.time()
        if not experience.created_at:
            experience.created_at = now
        if not experience.timestamp:
            experience.timestamp = experience.created_at

        self._conn.execute(
            """INSERT OR REPLACE INTO experiences
               (id, type, context, action, result, reflection, insight,
                success_rate, usage_count, tags, created_at, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                experience.id,
                experience.type,
                json.dumps(experience.context, ensure_ascii=False),
                experience.action,
                experience.result,
                experience.reflection,
                experience.insight,
                experience.success_rate,
                experience.usage_count,
                json.dumps(experience.tags, ensure_ascii=False),
                experience.created_at,
                experience.timestamp,
            ),
        )
        self._conn.commit()
        self._cache[experience.id] = experience
        self._cache.move_to_end(experience.id)
        while len(self._cache) > self.MAX_CACHE_SIZE:
            self._cache.popitem(last=False)
        return experience.id

    def search_experiences(
        self,
        query: str = "",
        type: str | None = None,
        tags: list[str] | None = None,
        limit: int = 10,
        min_success_rate: float = 0.0,
    ) -> list[ReflectionExperience]:
        if limit <= 0:
            return []

        conditions = []
        params: list[Any] = []

        if type:
            conditions.append("type = ?")
            params.append(type)

        if query:
            conditions.append("(action LIKE ? OR insight LIKE ? OR reflection LIKE ? OR tags LIKE ?)")
            q = f"%{query}%"
            params.extend([q, q, q, q])

        if tags:
            tag_conditions = []
            for tag in tags:
                tag_conditions.append("tags LIKE ?")
                params.append(f'%"{tag}"%')
            conditions.append(f"({' OR '.join(tag_conditions)})")

        if min_success_rate > 0:
            conditions.append("success_rate >= ?")
            params.append(min_success_rate)

        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        params.append(limit)

        sql = f"""
            SELECT * FROM experiences{where}
            ORDER BY success_rate DESC, usage_count DESC
            LIMIT ?
        """
        cur = self._conn.execute(sql, params)
        results = []
        for row in cur:
            results.append(self._row_to_experience(row))
        return results

    def clear(self) -> None:
        if self._conn:
            self._conn.execute("DELETE FROM experiences")
            self._conn.commit()
        self._cache.clear()

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None  # type: ignore[assignment]

    def get_experience(self, exp_id: str) -> ReflectionExperience | None:
        if exp_id in self._cache:
            self._cache.move_to_end(exp_id)
            return self._cache[exp_id]
        if not self._conn:
            return None
        cur = self._conn.execute("SELECT * FROM experiences WHERE id = ?", (exp_id,))
        row = cur.fetchone()
        if not row:
            return None
        exp = self._row_to_experience(row)
        self._cache[exp_id] = exp
        self._cache.move_to_end(exp_id)
        while len(self._cache) > self.MAX_CACHE_SIZE:
            self._cache.popitem(last=False)
        return exp

    def update_usage(self, exp_id: str, success: bool) -> None:
        exp = self.get_experience(exp_id)
        if not exp:
            return
        new_count = exp.usage_count + 1
        new_rate = (exp.success_rate * exp.usage_count + (1.0 if success else 0.0)) / new_count
        if self._conn:
            self._conn.execute(
                "UPDATE experiences SET usage_count = ?, success_rate = ? WHERE id = ?",
                (new_count, new_rate, exp_id),
            )
            self._conn.commit()
        exp.usage_count = new_count
        exp.success_rate = new_rate
        if exp_id in self._cache:
            self._cache[exp_id] = exp

    def update_success_rate(self, exp_id: str, success: bool, smoothing: float = 0.3) -> None:
        exp = self.get_experience(exp_id)
        if not exp:
            return
        target = 1.0 if success else 0.0
        new_rate = exp.success_rate * (1 - smoothing) + target * smoothing
        new_count = exp.usage_count + 1
        if self._conn:
            self._conn.execute(
                "UPDATE experiences SET usage_count = ?, success_rate = ? WHERE id = ?",
                (new_count, new_rate, exp_id),
            )
            self._conn.commit()
        exp.usage_count = new_count
        exp.success_rate = new_rate
        if exp_id in self._cache:
            self._cache[exp_id] = exp

    def increment_usage(self, exp_id: str) -> None:
        exp = self.get_experience(exp_id)
        if not exp:
            return
        new_count = exp.usage_count + 1
        if self._conn:
            self._conn.execute(
                "UPDATE experiences SET usage_count = ? WHERE id = ?",
                (new_count, exp_id),
            )
            self._conn.commit()
        exp.usage_count = new_count
        if exp_id in self._cache:
            self._cache[exp_id] = exp

    def get_stats(self) -> dict[str, Any]:
        if not self._conn:
            return {"total_experiences": 0, "by_type": {}, "avg_success_rate": 0.0, "total_usage_count": 0}
        cur = self._conn.execute("SELECT COUNT(*) as cnt FROM experiences")
        total = cur.fetchone()["cnt"]
        cur = self._conn.execute("SELECT type, COUNT(*) as cnt FROM experiences GROUP BY type")
        by_type = {row["type"]: row["cnt"] for row in cur}
        cur = self._conn.execute("SELECT AVG(success_rate) as avg_sr FROM experiences")
        avg_sr = cur.fetchone()["avg_sr"] or 0.0
        cur = self._conn.execute("SELECT SUM(usage_count) as total_uc FROM experiences")
        total_uc = cur.fetchone()["total_uc"] or 0
        return {
            "total_experiences": total,
            "by_type": by_type,
            "avg_success_rate": avg_sr,
            "total_usage_count": total_uc,
        }

    def get_top_experiences(
        self,
        type: str | None = None,
        limit: int = 10,
        sort_by: str = "usage_count",
    ) -> list[ReflectionExperience]:
        valid_sort = ("usage_count", "success_rate", "created_at")
        if sort_by not in valid_sort:
            raise ValueError(f"Invalid sort_by: {sort_by}. Must be one of {valid_sort}")
        if limit <= 0:
            return []
        conditions = []
        params: list[Any] = []
        if type:
            conditions.append("type = ?")
            params.append(type)
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        params.append(limit)
        sql = f"SELECT * FROM experiences{where} ORDER BY {sort_by} DESC LIMIT ?"
        cur = self._conn.execute(sql, params)
        results = []
        for row in cur:
            results.append(self._row_to_experience(row))
        return results

    def _row_to_experience(self, row: sqlite3.Row) -> ReflectionExperience:
        return ReflectionExperience(
            id=row["id"],
            type=row["type"],
            context=json.loads(row["context"]),
            action=row["action"],
            result=row["result"],
            reflection=row["reflection"],
            insight=row["insight"],
            success_rate=row["success_rate"],
            usage_count=row["usage_count"],
            tags=json.loads(row["tags"]),
            created_at=row["created_at"],
            timestamp=row["timestamp"] if "timestamp" in row.keys() else row["created_at"],
        )

    def extract_transferable_patterns(
        self,
        task_description: str = "",
        limit: int = 5,
        min_success_rate: float = 0.6,
        min_usage_count: int = 2,
    ) -> list[dict[str, Any]]:
        """P1-4: 从历史任务提取可迁移模式，供规划阶段注入执行agent。

        提取高成功率、多次使用的经验模式，按相关度排序，
        返回结构化的可迁移模式列表。

        Args:
            task_description: 当前任务描述，用于相关性匹配。
            limit: 返回的最大模式数。
            min_success_rate: 最低成功率阈值。
            min_usage_count: 最低使用次数阈值。

        Returns:
            可迁移模式列表，每个模式包含 action/insight/params 等字段。
        """
        if not self._conn:
            return []

        conditions = ["success_rate >= ?", "usage_count >= ?"]
        params: list[Any] = [min_success_rate, min_usage_count]

        if task_description:
            keywords = [w for w in task_description.split() if len(w) > 1][:5]
            if keywords:
                like_clauses = []
                for kw in keywords:
                    like_clauses.append("(action LIKE ? OR insight LIKE ? OR tags LIKE ?)")
                    params.extend([f"%{kw}%", f"%{kw}%", f"%{kw}%"])
                conditions.append(f"({' OR '.join(like_clauses)})")

        where = " WHERE " + " AND ".join(conditions)
        params.append(limit)

        sql = f"""
            SELECT * FROM experiences{where}
            ORDER BY success_rate DESC, usage_count DESC
            LIMIT ?
        """

        cur = self._conn.execute(sql, params)
        patterns: list[dict[str, Any]] = []
        for row in cur:
            exp = self._row_to_experience(row)
            pattern: dict[str, Any] = {
                "action": exp.action,
                "insight": exp.insight,
                "success_rate": round(exp.success_rate, 3),
                "usage_count": exp.usage_count,
                "type": exp.type,
                "tags": exp.tags,
                "recommended_params": exp.context.get("recommended_params", {}),
                "common_pitfalls": exp.context.get("common_pitfalls", []),
            }
            if exp.reflection:
                pattern["reflection_summary"] = exp.reflection[:200]
            patterns.append(pattern)

        return patterns

    def build_planning_injection(
        self,
        task_description: str,
        max_patterns: int = 3,
    ) -> str:
        """P1-4: 构建可注入规划阶段的经验迁移文本。

        从历史任务提取可迁移模式，格式化为规划提示文本，
        在 Planner 规划时注入，指导执行agent选择更优策略。

        Args:
            task_description: 当前任务描述。
            max_patterns: 最大注入模式数。

        Returns:
            格式化的经验迁移提示文本，无可用模式时返回空字符串。
        """
        patterns = self.extract_transferable_patterns(
            task_description=task_description,
            limit=max_patterns,
            min_success_rate=0.5,
            min_usage_count=1,
        )

        if not patterns:
            return ""

        lines = ["【经验迁移】以下模式来自历史成功任务，可供参考："]
        for i, p in enumerate(patterns, 1):
            lines.append(f"{i}. {p['action']}")
            if p.get("insight"):
                lines.append(f"   关键洞察: {p['insight'][:150]}")
            if p.get("recommended_params"):
                lines.append(f"   推荐参数: {p['recommended_params']}")
            if p.get("common_pitfalls"):
                pitfalls = p["common_pitfalls"][:3]
                lines.append(f"   常见陷阱: {', '.join(pitfalls)}")
            lines.append(f"   成功率: {p['success_rate']*100:.0f}% (使用{p['usage_count']}次)")

        return "\n".join(lines)
