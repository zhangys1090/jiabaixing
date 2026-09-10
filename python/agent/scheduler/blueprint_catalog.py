"""Cron 蓝图目录与智能建议。

提供预定义的定时任务蓝图和基于用户行为的智能建议：
  - 蓝图目录：常用定时任务模板（备份、清理、同步、报告等）
  - 智能建议：根据用户行为模式推荐定时任务
  - 一键部署：从蓝图创建 CronJob 并注册到调度器

与 CronJobScheduler 的关系：
  - CronJobScheduler 管理任务调度执行
  - BlueprintCatalog 提供任务模板和推荐
  - SuggestionCatalog 分析用户行为生成建议

集成示例::

    from agent.scheduler.blueprint_catalog import BlueprintCatalog

    catalog = BlueprintCatalog()
    blueprints = catalog.list_blueprints()
    job = catalog.create_job("daily_backup", args={"/data/project"})
    await scheduler.add_job(job)
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from agent.core.logger import StructuredLogger

log = StructuredLogger("blueprint_catalog")




class BlueprintCategory(str, Enum):
    BACKUP = "backup"
    CLEANUP = "cleanup"
    SYNC = "sync"
    REPORT = "report"
    MONITOR = "monitor"
    MAINTENANCE = "maintenance"
    CUSTOM = "custom"


@dataclass
class CronBlueprint:
    id: str
    name: str
    category: BlueprintCategory
    description: str
    schedule: str
    command: str
    default_args: dict[str, Any] = field(default_factory=dict)
    required_args: list[str] = field(default_factory=list)
    optional_args: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    difficulty: int = 1
    popularity: int = 0


@dataclass
class TaskSuggestion:
    id: str
    name: str
    reason: str
    schedule: str
    command: str
    confidence: float
    category: BlueprintCategory = BlueprintCategory.CUSTOM
    based_on: str = ""


_BUILTIN_BLUEPRINTS: list[CronBlueprint] = [
    CronBlueprint(
        id="daily_backup",
        name="每日备份",
        category=BlueprintCategory.BACKUP,
        description="每日凌晨自动备份指定目录",
        schedule="daily",
        command="backup",
        default_args={"compress": True, "keep_days": 7},
        required_args=["source_path"],
        optional_args={"dest_path": "", "exclude": "*.tmp"},
        tags=["备份", "自动化"],
        popularity=95,
    ),
    CronBlueprint(
        id="hourly_sync",
        name="每小时同步",
        category=BlueprintCategory.SYNC,
        description="每小时同步远程数据源",
        schedule="every:1h",
        command="sync",
        default_args={"mode": "incremental"},
        required_args=["source_url"],
        optional_args={"timeout": 30},
        tags=["同步", "数据"],
        popularity=70,
    ),
    CronBlueprint(
        id="weekly_cleanup",
        name="每周清理",
        category=BlueprintCategory.CLEANUP,
        description="每周清理临时文件和过期缓存",
        schedule="weekly",
        command="cleanup",
        default_args={"dry_run": False, "max_age_days": 30},
        required_args=[],
        optional_args={"paths": "/tmp,/cache"},
        tags=["清理", "维护"],
        popularity=60,
    ),
    CronBlueprint(
        id="daily_report",
        name="每日报告",
        category=BlueprintCategory.REPORT,
        description="每日生成用量统计报告",
        schedule="daily",
        command="report",
        default_args={"format": "markdown", "send_to": ""},
        required_args=[],
        optional_args={"include_charts": True},
        tags=["报告", "统计"],
        popularity=80,
    ),
    CronBlueprint(
        id="health_check",
        name="健康检查",
        category=BlueprintCategory.MONITOR,
        description="每 5 分钟检查服务健康状态",
        schedule="every:5m",
        command="health_check",
        default_args={"timeout": 10, "alert_on_fail": True},
        required_args=[],
        optional_args={"endpoints": ""},
        tags=["监控", "健康"],
        popularity=85,
    ),
    CronBlueprint(
        id="memory_review",
        name="记忆审查",
        category=BlueprintCategory.MAINTENANCE,
        description="每日审查和整理长期记忆",
        schedule="daily",
        command="memory_review",
        default_args={"max_items": 100, "decay_days": 30},
        required_args=[],
        optional_args={},
        tags=["记忆", "维护"],
        popularity=50,
    ),
    CronBlueprint(
        id="skill_update",
        name="技能更新检查",
        category=BlueprintCategory.MAINTENANCE,
        description="每日检查技能包更新",
        schedule="daily",
        command="skill_update_check",
        default_args={"auto_update": False},
        required_args=[],
        optional_args={},
        tags=["技能", "更新"],
        popularity=45,
    ),
    CronBlueprint(
        id="context_compress",
        name="上下文压缩",
        category=BlueprintCategory.MAINTENANCE,
        description="每 6 小时压缩长期对话上下文",
        schedule="every:6h",
        command="context_compress",
        default_args={"max_turns": 50, "strategy": "summary"},
        required_args=[],
        optional_args={},
        tags=["上下文", "压缩"],
        popularity=55,
    ),
]


class BlueprintCatalog:
    """Cron 蓝图目录。

    管理预定义的定时任务蓝图，支持搜索、过滤和一键创建。
    """

    def __init__(self) -> None:
        self._blueprints: dict[str, CronBlueprint] = {b.id: b for b in _BUILTIN_BLUEPRINTS}
        self._custom_blueprints: dict[str, CronBlueprint] = {}

    def add_blueprint(self, blueprint: CronBlueprint) -> None:
        self._custom_blueprints[blueprint.id] = blueprint
        self._blueprints[blueprint.id] = blueprint
        log.info("蓝图已添加", id=blueprint.id, name=blueprint.name)

    def remove_blueprint(self, blueprint_id: str) -> bool:
        if blueprint_id in self._custom_blueprints:
            del self._custom_blueprints[blueprint_id]
        return self._blueprints.pop(blueprint_id, None) is not None

    def get_blueprint(self, blueprint_id: str) -> CronBlueprint | None:
        return self._blueprints.get(blueprint_id)

    def list_blueprints(
        self,
        category: BlueprintCategory | None = None,
        tag: str | None = None,
    ) -> list[CronBlueprint]:
        blueprints = list(self._blueprints.values())
        if category:
            blueprints = [b for b in blueprints if b.category == category]
        if tag:
            blueprints = [b for b in blueprints if tag in b.tags]
        return sorted(blueprints, key=lambda b: b.popularity, reverse=True)

    def search(self, query: str) -> list[CronBlueprint]:
        query_lower = query.lower()
        results = []
        for b in self._blueprints.values():
            searchable = f"{b.name} {b.description} {' '.join(b.tags)}".lower()
            if query_lower in searchable:
                results.append(b)
        return sorted(results, key=lambda b: b.popularity, reverse=True)

    def create_job_args(self, blueprint_id: str, user_args: dict[str, Any] | None = None) -> dict[str, Any] | None:
        blueprint = self._blueprints.get(blueprint_id)
        if blueprint is None:
            return None

        merged = dict(blueprint.default_args)
        if user_args:
            merged.update(user_args)

        for req_arg in blueprint.required_args:
            if req_arg not in merged or not merged[req_arg]:
                log.warning("蓝图缺少必需参数", blueprint=blueprint_id, arg=req_arg)
                return None

        return {
            "name": blueprint.name,
            "schedule": blueprint.schedule,
            "command": blueprint.command,
            "args": merged,
        }

    def get_categories(self) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for b in self._blueprints.values():
            counts[b.category.value] += 1
        return dict(counts)

    def get_tags(self) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for b in self._blueprints.values():
            for tag in b.tags:
                counts[tag] += 1
        return dict(counts)


class SuggestionCatalog:
    """智能建议目录。

    基于用户行为模式生成定时任务建议。
    """

    def __init__(self, blueprint_catalog: BlueprintCatalog) -> None:
        self._catalog = blueprint_catalog
        self._user_patterns: dict[str, dict[str, Any]] = {}
        self._suggestions: list[TaskSuggestion] = []

    def record_user_action(self, user_id: str, action: str, details: dict[str, Any] | None = None) -> None:
        if user_id not in self._user_patterns:
            self._user_patterns[user_id] = defaultdict(int)
        self._user_patterns[user_id][action] += 1
        if details:
            for k, v in details.items():
                key = f"{action}:{k}"
                self._user_patterns[user_id][key] = v

    def generate_suggestions(self, user_id: str) -> list[TaskSuggestion]:
        patterns = self._user_patterns.get(user_id, {})
        suggestions: list[TaskSuggestion] = []

        backup_count = patterns.get("backup", 0)
        if backup_count >= 3:
            suggestions.append(TaskSuggestion(
                id="auto_daily_backup",
                name="每日自动备份",
                reason=f"您近期手动备份 {backup_count} 次，建议设置自动备份",
                schedule="daily",
                command="backup",
                confidence=0.9,
                category=BlueprintCategory.BACKUP,
                based_on=f"backup_count={backup_count}",
            ))

        sync_count = patterns.get("sync", 0)
        if sync_count >= 5:
            suggestions.append(TaskSuggestion(
                id="auto_hourly_sync",
                name="每小时自动同步",
                reason=f"您近期手动同步 {sync_count} 次，建议设置自动同步",
                schedule="every:1h",
                command="sync",
                confidence=0.85,
                category=BlueprintCategory.SYNC,
                based_on=f"sync_count={sync_count}",
            ))

        cleanup_count = patterns.get("cleanup", 0)
        if cleanup_count >= 2:
            suggestions.append(TaskSuggestion(
                id="auto_weekly_cleanup",
                name="每周自动清理",
                reason=f"您近期手动清理 {cleanup_count} 次，建议设置定期清理",
                schedule="weekly",
                command="cleanup",
                confidence=0.8,
                category=BlueprintCategory.CLEANUP,
                based_on=f"cleanup_count={cleanup_count}",
            ))

        suggestions.append(TaskSuggestion(
            id="suggest_health_check",
            name="服务健康监控",
            reason="建议启用服务健康监控，及时发现异常",
            schedule="every:5m",
            command="health_check",
            confidence=0.7,
            category=BlueprintCategory.MONITOR,
        ))

        self._suggestions = suggestions
        return sorted(suggestions, key=lambda s: s.confidence, reverse=True)

    def get_suggestions(self) -> list[TaskSuggestion]:
        return self._suggestions

    def dismiss_suggestion(self, suggestion_id: str) -> None:
        self._suggestions = [s for s in self._suggestions if s.id != suggestion_id]
