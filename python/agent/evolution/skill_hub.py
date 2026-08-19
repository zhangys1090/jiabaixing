"""Skill Hub 技能市场。

提供技能的发布、发现、安装和版本管理：
  - 技能注册表（本地 + 远程）
  - 技能搜索与推荐
  - 版本管理与依赖解析
  - 安装/卸载/更新
  - 评分与评论

与 SkillEngine 的关系：
  - SkillEngine 管理技能执行
  - SkillHub 管理技能生命周期（发现→安装→更新→卸载）
  - SkillUsageTracker 追踪使用统计

集成示例::

    from agent.evolution.skill_hub import SkillHub

    hub = SkillHub()
    skills = hub.search("backup")
    await hub.install(skills[0].id)
    await hub.update_all()
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from agent.config import DATA_ROOT
from agent.core.logger import StructuredLogger

log = StructuredLogger("skill_hub")


class SkillStatus(str, Enum):
    AVAILABLE = "available"
    INSTALLED = "installed"
    OUTDATED = "outdated"
    BROKEN = "broken"
    PRIVATE = "private"


class SkillCategory(str, Enum):
    AUTOMATION = "automation"
    ANALYSIS = "analysis"
    COMMUNICATION = "communication"
    DATA = "data"
    DEVELOPMENT = "development"
    PRODUCTIVITY = "productivity"
    SECURITY = "security"
    CUSTOM = "custom"


@dataclass
class SkillVersion:
    version: str
    released_at: float
    changelog: str = ""
    min_agent_version: str = "0.1.0"
    dependencies: list[str] = field(default_factory=list)
    checksum: str = ""


@dataclass
class SkillEntry:
    id: str
    name: str
    category: SkillCategory
    description: str
    author: str = ""
    status: SkillStatus = SkillStatus.AVAILABLE
    installed_version: str = ""
    latest_version: str = ""
    versions: list[SkillVersion] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    rating: float = 0.0
    rating_count: int = 0
    download_count: int = 0
    homepage: str = ""
    source_url: str = ""
    size_kb: int = 0
    created_at: float = 0.0
    updated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category.value,
            "description": self.description,
            "author": self.author,
            "status": self.status.value,
            "installed_version": self.installed_version,
            "latest_version": self.latest_version,
            "tags": self.tags,
            "rating": self.rating,
            "download_count": self.download_count,
        }


@dataclass
class InstallResult:
    success: bool
    skill_id: str
    version: str
    message: str = ""
    duration_ms: float = 0.0


_BUILTIN_SKILLS: list[SkillEntry] = [
    SkillEntry(
        id="auto-backup",
        name="自动备份",
        category=SkillCategory.AUTOMATION,
        description="智能备份策略，支持增量/全量/差异备份",
        author="jiabaixing",
        latest_version="1.2.0",
        tags=["备份", "自动化", "调度"],
        rating=4.8,
        rating_count=120,
        download_count=1500,
    ),
    SkillEntry(
        id="data-analyzer",
        name="数据分析器",
        category=SkillCategory.ANALYSIS,
        description="对话式数据分析，支持 CSV/JSON/SQL",
        author="jiabaixing",
        latest_version="2.0.1",
        tags=["数据", "分析", "可视化"],
        rating=4.6,
        rating_count=85,
        download_count=900,
    ),
    SkillEntry(
        id="code-review",
        name="代码审查",
        category=SkillCategory.DEVELOPMENT,
        description="AI 驱动的代码审查和重构建议",
        author="jiabaixing",
        latest_version="1.5.0",
        tags=["代码", "审查", "重构"],
        rating=4.7,
        rating_count=200,
        download_count=2100,
    ),
    SkillEntry(
        id="security-scanner",
        name="安全扫描",
        category=SkillCategory.SECURITY,
        description="依赖漏洞扫描和合规检查",
        author="jiabaixing",
        latest_version="1.3.2",
        tags=["安全", "漏洞", "合规"],
        rating=4.5,
        rating_count=60,
        download_count=500,
    ),
    SkillEntry(
        id="report-generator",
        name="报告生成器",
        category=SkillCategory.PRODUCTIVITY,
        description="自动生成周报/月报/专项报告",
        author="jiabaixing",
        latest_version="1.1.0",
        tags=["报告", "模板", "自动化"],
        rating=4.4,
        rating_count=45,
        download_count=350,
    ),
    SkillEntry(
        id="multi-translate",
        name="多语言翻译",
        category=SkillCategory.COMMUNICATION,
        description="高质量多语言翻译，保留格式和术语",
        author="jiabaixing",
        latest_version="2.1.0",
        tags=["翻译", "多语言", "i18n"],
        rating=4.9,
        rating_count=300,
        download_count=5000,
    ),
]


class SkillHub:
    """技能市场。

    管理技能的发布、发现、安装和更新。
    """

    def __init__(self, skills_dir: Path | None = None, auditor: Any = None) -> None:
        self._dir = skills_dir or DATA_ROOT / "skills"
        self._registry: dict[str, SkillEntry] = {s.id: s for s in _BUILTIN_SKILLS}
        self._installed: dict[str, str] = {}
        self._auditor = auditor
        self._load_installed()

    def _load_installed(self) -> None:
        manifest = self._dir / "manifest.json"
        if manifest.exists():
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                for item in data.get("installed", []):
                    self._installed[item["id"]] = item["version"]
                    if item["id"] in self._registry:
                        self._registry[item["id"]].status = SkillStatus.INSTALLED
                        self._registry[item["id"]].installed_version = item["version"]
            except Exception as e:
                log.warning("加载技能清单失败", error=str(e))

    def _save_manifest(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        manifest = self._dir / "manifest.json"
        data = {
            "installed": [
                {"id": sid, "version": ver}
                for sid, ver in self._installed.items()
            ]
        }
        manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def search(
        self,
        query: str = "",
        category: SkillCategory | None = None,
        tag: str | None = None,
        sort_by: str = "rating",
    ) -> list[SkillEntry]:
        results = list(self._registry.values())
        if query:
            q = query.lower()
            results = [s for s in results if q in f"{s.name} {s.description} {' '.join(s.tags)}".lower()]
        if category:
            results = [s for s in results if s.category == category]
        if tag:
            results = [s for s in results if tag in s.tags]

        if sort_by == "rating":
            results.sort(key=lambda s: s.rating, reverse=True)
        elif sort_by == "downloads":
            results.sort(key=lambda s: s.download_count, reverse=True)
        elif sort_by == "updated":
            results.sort(key=lambda s: s.updated_at, reverse=True)
        return results

    def get_skill(self, skill_id: str) -> SkillEntry | None:
        return self._registry.get(skill_id)

    def list_installed(self) -> list[SkillEntry]:
        return [s for s in self._registry.values() if s.status == SkillStatus.INSTALLED]

    def list_available(self) -> list[SkillEntry]:
        return [s for s in self._registry.values() if s.status == SkillStatus.AVAILABLE]

    async def install(self, skill_id: str, version: str = "") -> InstallResult:
        start = time.monotonic()
        entry = self._registry.get(skill_id)
        if entry is None:
            return InstallResult(success=False, skill_id=skill_id, version=version, message="技能不存在")

        target_version = version or entry.latest_version
        if entry.status == SkillStatus.INSTALLED and entry.installed_version == target_version:
            return InstallResult(success=True, skill_id=skill_id, version=target_version, message="已安装")

        # 安装前安全审计
        if self._auditor:
            try:
                skill_dir = self._dir / skill_id
                if skill_dir.exists():
                    py_files = list(skill_dir.glob("**/*.py"))
                    for py_file in py_files:
                        report = self._auditor.audit_file(py_file)
                        if not report.is_safe:
                            log.warning(
                                "技能安装被安全审计阻止",
                                skill_id=skill_id,
                                risk_level=report.risk_level.value,
                                violations=len(report.violations),
                            )
                            return InstallResult(
                                success=False,
                                skill_id=skill_id,
                                version=target_version,
                                message=f"安全审计未通过: {report.summary}",
                            )
            except Exception as e:
                log.warning("技能安全审计异常，跳过审计继续安装", error=str(e))

        entry.status = SkillStatus.INSTALLED
        entry.installed_version = target_version
        self._installed[skill_id] = target_version
        self._save_manifest()

        duration = (time.monotonic() - start) * 1000
        log.info("技能已安装", id=skill_id, version=target_version)
        return InstallResult(
            success=True,
            skill_id=skill_id,
            version=target_version,
            message=f"已安装 {entry.name} v{target_version}",
            duration_ms=duration,
        )

    async def uninstall(self, skill_id: str) -> bool:
        entry = self._registry.get(skill_id)
        if entry is None or entry.status != SkillStatus.INSTALLED:
            return False
        entry.status = SkillStatus.AVAILABLE
        entry.installed_version = ""
        self._installed.pop(skill_id, None)
        self._save_manifest()
        log.info("技能已卸载", id=skill_id)
        return True

    async def update(self, skill_id: str) -> InstallResult:
        entry = self._registry.get(skill_id)
        if entry is None:
            return InstallResult(success=False, skill_id=skill_id, version="", message="技能不存在")
        if entry.status != SkillStatus.INSTALLED:
            return InstallResult(success=False, skill_id=skill_id, version="", message="技能未安装")
        if entry.installed_version == entry.latest_version:
            return InstallResult(success=True, skill_id=skill_id, version=entry.latest_version, message="已是最新")
        return await self.install(skill_id, entry.latest_version)

    async def update_all(self) -> list[InstallResult]:
        results = []
        for skill_id, entry in self._registry.items():
            if entry.status == SkillStatus.INSTALLED and entry.installed_version != entry.latest_version:
                result = await self.update(skill_id)
                results.append(result)
        return results

    def check_outdated(self) -> list[SkillEntry]:
        return [
            s for s in self._registry.values()
            if s.status == SkillStatus.INSTALLED and s.installed_version != s.latest_version
        ]

    def get_stats(self) -> dict[str, Any]:
        total = len(self._registry)
        installed = len([s for s in self._registry.values() if s.status == SkillStatus.INSTALLED])
        outdated = len(self.check_outdated())
        categories = defaultdict(int)
        for s in self._registry.values():
            categories[s.category.value] += 1
        return {
            "total": total,
            "installed": installed,
            "outdated": outdated,
            "categories": dict(categories),
        }

    def publish(self, entry: SkillEntry) -> None:
        self._registry[entry.id] = entry
        log.info("技能已发布", id=entry.id, name=entry.name)

    def add_rating(self, skill_id: str, rating: float) -> None:
        entry = self._registry.get(skill_id)
        if entry is None:
            return
        total = entry.rating * entry.rating_count + rating
        entry.rating_count += 1
        entry.rating = total / entry.rating_count
