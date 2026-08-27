from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from agent.config import DATA_DIR
from agent.core.logger import log_ignored
import logging
logger = logging.getLogger(__name__)


@dataclass
class SkillParameter:
    """技能参数定义。

    Attributes:
        name: 参数名称。
        type: 参数类型。
        required: 是否必填。
        description: 参数描述。
    """

    name: str
    type: str = "string"
    required: bool = True
    description: str = ""


@dataclass
class SkillDefinition:
    """技能定义——注册到系统的技能元数据。

    Attributes:
        name: 技能名称。
        description: 技能描述。
        category: 技能分类。
        version: 版本号。
        author: 作者。
        tags: 标签列表。
        parameters: 参数定义列表。
        source: 来源（builtin/user/hub）。
    """

    name: str
    description: str = ""
    category: str = "general"
    version: str = "1.0.0"
    author: str = ""
    tags: list[str] = field(default_factory=list)
    parameters: list[SkillParameter] = field(default_factory=list)
    source: str = "builtin"


@dataclass
class SkillResult:
    """技能执行结果。

    Attributes:
        success: 是否成功。
        output: 输出内容。
        error: 错误信息。
        metadata: 附加元数据。
    """

    success: bool
    output: str = ""
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class HubSkillEntry:
    """Skill Hub 市场条目。

    Attributes:
        name: 技能名称。
        description: 技能描述。
        category: 分类。
        version: 版本。
        author: 作者。
        tags: 标签。
        downloads: 下载次数。
        rating: 评分(0-5)。
        hub_url: Hub 上的 URL。
        installed: 是否已安装。
    """

    name: str
    description: str = ""
    category: str = "general"
    version: str = "1.0.0"
    author: str = ""
    tags: list[str] = field(default_factory=list)
    downloads: int = 0
    rating: float = 0.0
    hub_url: str = ""
    installed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "version": self.version,
            "author": self.author,
            "tags": self.tags,
            "downloads": self.downloads,
            "rating": self.rating,
            "hub_url": self.hub_url,
            "installed": self.installed,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> HubSkillEntry:
        return cls(
            name=data.get("name", ""),
            description=data.get("description", ""),
            category=data.get("category", "general"),
            version=data.get("version", "1.0.0"),
            author=data.get("author", ""),
            tags=data.get("tags", []),
            downloads=data.get("downloads", 0),
            rating=data.get("rating", 0.0),
            hub_url=data.get("hub_url", ""),
            installed=data.get("installed", False),
        )


@dataclass
class SkillSyncResult:
    """技能同步结果。

    Attributes:
        added: 新增的技能名称列表。
        updated: 更新的技能名称列表。
        removed: 移除的技能名称列表。
        errors: 错误信息列表。
    """

    added: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class Skill:
    """技能封装——将技能定义和执行函数绑定。

    封装技能的定义和执行逻辑，支持异步执行和结果转换。

    Usage:
        skill = Skill(SkillDefinition(name="greet"), execute_fn=my_func)
        result = await skill.execute({"name": "World"})
    """
    def __init__(
        self,
        definition: SkillDefinition,
        execute_fn: Any | None = None,
    ) -> None:
        self.definition = definition
        self._execute_fn = execute_fn

    async def execute(
        self,
        params: dict[str, Any],
        context: dict[str, Any] | None = None,
    ) -> SkillResult:
        if self._execute_fn:
            try:
                result = await self._execute_fn(params, context)
                if isinstance(result, SkillResult):
                    return result
                return SkillResult(success=True, output=str(result))
            except Exception as e:
                logger.warning("registry 异常处理", error=str(e))
                return SkillResult(success=False, error=str(e))

        return SkillResult(
            success=True,
            output=f"技能 {self.definition.name} 执行完成",
            metadata={"params": params},
        )


#: 内置技能定义（模块级，供 register_builtin_skills 与 builtin_skill_names 共用）。
_BUILTIN_SKILL_DEFINITIONS: list[SkillDefinition] = [
    SkillDefinition(
        name="chat",
        description="基础聊天技能",
        category="communication",
        tags=["chat", "conversation"],
        source="builtin",
    ),
    SkillDefinition(
        name="code_analysis",
        description="代码分析技能",
        category="development",
        tags=["code", "analysis", "review"],
        parameters=[
            SkillParameter(name="code", description="要分析的代码"),
            SkillParameter(name="language", required=False, description="编程语言"),
        ],
        source="builtin",
    ),
    SkillDefinition(
        name="file_search",
        description="文件搜索技能",
        category="filesystem",
        tags=["file", "search", "find"],
        parameters=[
            SkillParameter(name="pattern", description="搜索模式"),
            SkillParameter(name="path", required=False, description="搜索路径"),
        ],
        source="builtin",
    ),
    SkillDefinition(
        name="memory_recall",
        description="记忆回忆技能",
        category="memory",
        tags=["memory", "recall", "search"],
        parameters=[
            SkillParameter(name="query", description="搜索查询"),
        ],
        source="builtin",
    ),
    SkillDefinition(
        name="task_plan",
        description="任务规划技能",
        category="planning",
        tags=["plan", "task", "organize"],
        parameters=[
            SkillParameter(name="task", description="要规划的任务"),
        ],
        source="builtin",
    ),
]


def builtin_skill_names() -> list[str]:
    """返回所有内置技能的 name 列表（供 ExtensionCatalog 等目录声明复用）。"""
    return [d.name for d in _BUILTIN_SKILL_DEFINITIONS]


class SkillRegistry:
    """技能注册中心——管理所有技能的统一注册和发现。

    单例模式，支持按名称、分类和标签搜索技能。

    Usage:
        registry = SkillRegistry.get_instance()
        registry.register(Skill(SkillDefinition(name="my_skill")))
        skill = registry.get("my_skill")
        skills = registry.find_by_category("code")
    """
    _instance: SkillRegistry | None = None

    def __init__(self) -> None:
        self._skills: dict[str, Skill] = {}
        self._categories: set[str] = set()
        self._data_dir = DATA_DIR / "skills"
        self._data_dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def get_instance(cls) -> SkillRegistry:
        if cls._instance is None:
            cls._instance = SkillRegistry()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def register(self, skill: Skill) -> None:
        name = skill.definition.name
        if name in self._skills:
            return
        self._skills[name] = skill
        self._categories.add(skill.definition.category)

    def unregister(self, name: str) -> bool:
        if name not in self._skills:
            return False
        skill = self._skills.pop(name)
        self._rebuild_categories()
        return True

    def get_skill(self, name: str) -> Skill | None:
        return self._skills.get(name)

    def get_all_skills(self) -> list[Skill]:
        return list(self._skills.values())

    def get_skills_by_category(self, category: str) -> list[Skill]:
        return [s for s in self._skills.values() if s.definition.category == category]

    def get_categories(self) -> list[str]:
        return sorted(self._categories)

    def get_skill_meta(self) -> list[dict[str, Any]]:
        return [
            {
                "name": s.definition.name,
                "description": s.definition.description,
                "category": s.definition.category,
                "version": s.definition.version,
                "tags": s.definition.tags,
                "source": s.definition.source,
            }
            for s in self._skills.values()
        ]

    def search_skills(self, query: str) -> list[Skill]:
        query_lower = query.lower()
        results: list[tuple[Skill, float]] = []
        for skill in self._skills.values():
            d = skill.definition
            score = 0.0
            if query_lower in d.name.lower():
                score += 1.0
            if query_lower in d.description.lower():
                score += 0.5
            if any(query_lower in t.lower() for t in d.tags):
                score += 0.3
            if query_lower in d.category.lower():
                score += 0.2
            if score > 0:
                results.append((skill, score))

        results.sort(key=lambda x: x[1], reverse=True)
        return [r[0] for r in results]

    def _rebuild_categories(self) -> None:
        self._categories = {s.definition.category for s in self._skills.values()}

    def register_builtin_skills(
        self, enabled_check: "Callable[[str], bool] | None" = None
    ) -> None:
        """注册所有内置技能。

        Args:
            enabled_check: 可选门控回调 ref("skill:<name>") -> bool；返回 False 的
                技能被跳过（T4：ExtensionCatalog 窄腰门控，向后兼容默认全启用）。
        """
        for defn in _BUILTIN_SKILL_DEFINITIONS:
            ref = f"skill:{defn.name}"
            if enabled_check is not None and not enabled_check(ref):
                continue
            self.register(Skill(definition=defn))


class SkillHub:
    """Skill Hub 市场——技能发现、安装和同步。

    管理技能市场目录，支持搜索、安装、卸载和同步。
    Hub 目录存储在 DATA_DIR/skills/hub/ 下。

    Usage:
        hub = SkillHub.get_instance()
        entries = hub.search("code")
        hub.install("code_review")
        hub.sync_with_registry(SkillRegistry.get_instance())
    """

    _instance: SkillHub | None = None

    def __init__(self) -> None:
        self._hub_dir = DATA_DIR / "skills" / "hub"
        self._hub_dir.mkdir(parents=True, exist_ok=True)
        self._index_file = self._hub_dir / "index.json"
        self._entries: dict[str, HubSkillEntry] = {}
        self._load_index()

    @classmethod
    def get_instance(cls) -> SkillHub:
        if cls._instance is None:
            cls._instance = SkillHub()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def _load_index(self) -> None:
        if self._index_file.exists():
            try:
                data = json.loads(self._index_file.read_text(encoding="utf-8"))
                for item in data:
                    entry = HubSkillEntry.from_dict(item)
                    self._entries[entry.name] = entry
            except (json.JSONDecodeError, OSError) as _exc:
                log_ignored(None, "registry.SkillHub._load_index", _exc)

    def _save_index(self) -> None:
        data = [e.to_dict() for e in self._entries.values()]
        self._index_file.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def search(self, query: str, category: str | None = None) -> list[HubSkillEntry]:
        query_lower = query.lower()
        results: list[tuple[HubSkillEntry, float]] = []
        for entry in self._entries.values():
            if category and entry.category != category:
                continue
            score = 0.0
            if query_lower in entry.name.lower():
                score += 2.0
            if query_lower in entry.description.lower():
                score += 1.0
            if any(query_lower in t.lower() for t in entry.tags):
                score += 0.5
            if query_lower in entry.category.lower():
                score += 0.3
            if score > 0:
                results.append((entry, score))
        results.sort(key=lambda x: (-x[1], -x[0].rating, -x[0].downloads))
        return [r[0] for r in results]

    def list_entries(self, category: str | None = None) -> list[HubSkillEntry]:
        entries = list(self._entries.values())
        if category:
            entries = [e for e in entries if e.category == category]
        entries.sort(key=lambda e: (-e.rating, -e.downloads))
        return entries

    def get_entry(self, name: str) -> HubSkillEntry | None:
        return self._entries.get(name)

    def publish(self, entry: HubSkillEntry) -> None:
        self._entries[entry.name] = entry
        self._save_index()

    def unpublish(self, name: str) -> bool:
        if name not in self._entries:
            return False
        del self._entries[name]
        self._save_index()
        return True

    def install(self, name: str, registry: SkillRegistry | None = None) -> bool:
        entry = self._entries.get(name)
        if not entry:
            return False
        if registry and not registry.get_skill(name):
            definition = SkillDefinition(
                name=entry.name,
                description=entry.description,
                category=entry.category,
                version=entry.version,
                author=entry.author,
                tags=entry.tags,
                source="hub",
            )
            registry.register(Skill(definition=definition))
        entry.installed = True
        entry.downloads += 1
        self._save_index()
        return True

    def uninstall(self, name: str, registry: SkillRegistry | None = None) -> bool:
        entry = self._entries.get(name)
        if not entry or not entry.installed:
            return False
        if registry:
            registry.unregister(name)
        entry.installed = False
        self._save_index()
        return True

    def sync_with_registry(self, registry: SkillRegistry) -> SkillSyncResult:
        result = SkillSyncResult()

        for entry in self._entries.values():
            if not entry.installed:
                continue
            existing = registry.get_skill(entry.name)
            if not existing:
                definition = SkillDefinition(
                    name=entry.name,
                    description=entry.description,
                    category=entry.category,
                    version=entry.version,
                    author=entry.author,
                    tags=entry.tags,
                    source="hub",
                )
                registry.register(Skill(definition=definition))
                result.added.append(entry.name)
            elif existing.definition.version != entry.version:
                existing.definition.description = entry.description
                existing.definition.version = entry.version
                existing.definition.tags = entry.tags
                result.updated.append(entry.name)

        hub_installed = {n for n, e in self._entries.items() if e.installed}
        for skill in registry.get_all_skills():
            if skill.definition.source == "hub" and skill.definition.name not in hub_installed:
                registry.unregister(skill.definition.name)
                result.removed.append(skill.definition.name)

        return result

    def get_stats(self) -> dict[str, Any]:
        total = len(self._entries)
        installed = sum(1 for e in self._entries.values() if e.installed)
        categories: dict[str, int] = {}
        for e in self._entries.values():
            categories[e.category] = categories.get(e.category, 0) + 1
        return {
            "total": total,
            "installed": installed,
            "categories": categories,
        }


class SkillSync:
    """技能同步器——处理远程 Hub 仓库的同步。

    支持从远程 JSON 索引拉取技能列表，与本地 Hub 合并。
    """

    def __init__(self, hub: SkillHub | None = None) -> None:
        self._hub = hub or SkillHub.get_instance()
        self._remote_urls: list[str] = []
        remote_env = os.getenv("SKILL_HUB_URLS", "")
        if remote_env:
            self._remote_urls = [u.strip() for u in remote_env.split(",") if u.strip()]

    def add_remote(self, url: str) -> None:
        if url not in self._remote_urls:
            self._remote_urls.append(url)

    def remove_remote(self, url: str) -> None:
        self._remote_urls = [u for u in self._remote_urls if u != url]

    def get_remotes(self) -> list[str]:
        return list(self._remote_urls)

    async def fetch_remote_index(self, url: str) -> list[HubSkillEntry]:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(url)
                data = r.json()
        except ImportError:
            try:
                from urllib.request import urlopen
                with urlopen(url, timeout=15) as resp:
                    data = json.loads(resp.read().decode())
            except Exception as e:
                logger.warning("registry.fetch_hub_skills urllib获取失败", url=url, error=str(e))
                return []
        except Exception as e:
            logger.warning("registry.fetch_hub_skills httpx获取失败", url=url, error=str(e))
            return []

        if not isinstance(data, list):
            return []

        entries: list[HubSkillEntry] = []
        for item in data:
            try:
                entry = HubSkillEntry.from_dict(item)
                entry.hub_url = url
                entries.append(entry)
            except Exception as e:
                logger.warning("registry 异常处理", error=str(e))
                log_ignored(None, "registry.SkillHub._parse_index", e)
                continue
        return entries

    async def sync(self) -> SkillSyncResult:
        result = SkillSyncResult()
        for url in self._remote_urls:
            remote_entries = await self.fetch_remote_index(url)
            for remote in remote_entries:
                local = self._hub.get_entry(remote.name)
                if not local:
                    self._hub.publish(remote)
                    result.added.append(remote.name)
                elif remote.version != local.version:
                    local.description = remote.description
                    local.version = remote.version
                    local.author = remote.author
                    local.tags = remote.tags
                    local.rating = remote.rating
                    local.downloads = remote.downloads
                    result.updated.append(remote.name)
        if result.added or result.updated:
            self._hub._save_index()
        return result
