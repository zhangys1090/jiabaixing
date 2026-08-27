from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("skill_usage_tracker")


_STALE_AFTER_DAYS = 30
_MAX_RECENT_QUALITY_SCORES = 10
_MAX_INTEGRATION_HISTORY = 20


@dataclass
class SkillUsageRecord:
    name: str
    skill_path: str = ""
    created_at: str = ""
    last_loaded_at: str | None = None
    last_used_at: str | None = None
    load_count: int = 0
    use_count: int = 0
    quality_score: float = 0.7
    recent_quality_scores: list[float] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": self.skill_path,
            "created_at": self.created_at,
            "last_loaded_at": self.last_loaded_at,
            "last_used_at": self.last_used_at,
            "load_count": self.load_count,
            "use_count": self.use_count,
            "quality_score": self.quality_score,
            "recent_quality_scores": self.recent_quality_scores,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SkillUsageRecord:
        return cls(
            name=data.get("name", ""),
            skill_path=data.get("path", ""),
            created_at=data.get("created_at", ""),
            last_loaded_at=data.get("last_loaded_at"),
            last_used_at=data.get("last_used_at"),
            load_count=data.get("load_count", 0),
            use_count=data.get("use_count", 0),
            quality_score=data.get("quality_score", 0.7),
            recent_quality_scores=data.get("recent_quality_scores", []),
        )


@dataclass
class SkillInsightReport:
    agent_id: str = ""
    top_skills: list[dict[str, Any]] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)
    generated_at: str = ""


@dataclass
class SkillInsightReportResult:
    agent_id: str = ""
    top_skills: list[dict[str, Any]] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)
    generated_at: str = ""


class SkillUsageTracker:
    _instance: SkillUsageTracker | None = None

    def __init__(self, data_dir: str | None = None) -> None:
        self._data_dir = Path(data_dir) if data_dir else (
            Path(__file__).resolve().parent.parent.parent / "data" / "evolution"
        )
        self._usage_path = self._data_dir / "skill-usage.json"
        self._skills: dict[str, SkillUsageRecord] = {}
        self._integration_history: list[dict[str, Any]] = []
        self._MAX_SKILLS = 5000
        self._load()

    @classmethod
    def get_instance(cls) -> SkillUsageTracker:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        cls._instance = None

    def _load(self) -> None:
        if not self._usage_path.exists():
            return
        try:
            raw = self._usage_path.read_text(encoding="utf-8")
            data = json.loads(raw)
            skills_data = data.get("skills", {})
            for name, record_data in skills_data.items():
                self._skills[name] = SkillUsageRecord.from_dict(record_data)
            log.debug("Loaded skill usage data", count=len(self._skills))
        except Exception as e:
            log.warning("Failed to load skill usage data", error=str(e))

    def _save(self) -> None:
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            serializable: dict[str, Any] = {}
            for name, record in self._skills.items():
                serializable[name] = record.to_dict()
            self._usage_path.write_text(
                json.dumps({"skills": serializable, "last_scan_at": time.time()}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            log.warning("Failed to save skill usage data", error=str(e))

    def register(self, name: str, skill_path: str, quality_score: float = 0.7) -> None:
        if name in self._skills:
            return
        self._skills[name] = SkillUsageRecord(
            name=name,
            skill_path=skill_path,
            created_at=time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            quality_score=quality_score,
        )
        if len(self._skills) > self._MAX_SKILLS:
            sorted_skills = sorted(self._skills.items(), key=lambda x: x[1].last_used_at if hasattr(x[1], 'last_used_at') and x[1].last_used_at else x[1].created_at)
            to_remove = sorted_skills[: len(self._skills) - (self._MAX_SKILLS * 3 // 4)]
            for sn, _ in to_remove:
                del self._skills[sn]
        self._save()
        log.info(f"Skill registered: {name}")

    def track_load(self, name: str) -> None:
        record = self._skills.get(name)
        if not record:
            return
        record.last_loaded_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
        record.load_count += 1
        self._save()

    def track_use(self, name: str, quality_score: float | None = None) -> None:
        record = self._skills.get(name)
        if not record:
            return
        record.last_used_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
        record.use_count += 1
        if quality_score is not None:
            record.quality_score = (
                record.quality_score * (record.use_count - 1) + quality_score
            ) / record.use_count
            record.recent_quality_scores.append(quality_score)
            if len(record.recent_quality_scores) > _MAX_RECENT_QUALITY_SCORES:
                record.recent_quality_scores = record.recent_quality_scores[-_MAX_RECENT_QUALITY_SCORES:]
        self._save()

    def get_stats(self) -> list[SkillUsageRecord]:
        return sorted(
            self._skills.values(),
            key=lambda r: r.created_at,
            reverse=True,
        )

    def get_least_used(self) -> list[SkillUsageRecord]:
        now = time.time()
        stale_threshold = _STALE_AFTER_DAYS * 24 * 60 * 60
        result: list[SkillUsageRecord] = []
        for record in self._skills.values():
            if record.use_count == 0:
                result.append(record)
            elif not record.last_used_at:
                result.append(record)
            else:
                try:
                    last_used = time.mktime(
                        time.strptime(record.last_used_at, "%Y-%m-%dT%H:%M:%S")
                    )
                    if now - last_used > stale_threshold:
                        result.append(record)
                except ValueError:
                    result.append(record)
        return result

    def get_active(self) -> list[SkillUsageRecord]:
        now = time.time()
        active_threshold = _STALE_AFTER_DAYS * 24 * 60 * 60
        result: list[SkillUsageRecord] = []
        for record in self._skills.values():
            if not record.last_used_at:
                continue
            try:
                last_used = time.mktime(
                    time.strptime(record.last_used_at, "%Y-%m-%dT%H:%M:%S")
                )
                if now - last_used <= active_threshold:
                    result.append(record)
            except ValueError:
                continue
        return result

    def scan_directory(self, skills_dir: str) -> int:
        skills_path = Path(skills_dir)
        if not skills_path.exists():
            return 0
        new_count = 0
        for file_path in skills_path.iterdir():
            if file_path.suffix == ".md":
                name = file_path.stem
                if name not in self._skills:
                    self.register(name, str(file_path))
                    new_count += 1
        return new_count

    def get_summary(self) -> dict[str, int]:
        now = time.time()
        stale_threshold = _STALE_AFTER_DAYS * 24 * 60 * 60
        total = len(self._skills)
        active = 0
        stale = 0
        for record in self._skills.values():
            if not record.last_used_at:
                stale += 1
                continue
            try:
                last_used = time.mktime(
                    time.strptime(record.last_used_at, "%Y-%m-%dT%H:%M:%S")
                )
                if now - last_used <= stale_threshold:
                    active += 1
                else:
                    stale += 1
            except ValueError:
                stale += 1
        return {"total": total, "active": active, "stale": stale}

    def get_record(self, name: str) -> SkillUsageRecord | None:
        return self._skills.get(name)

    def get_recent_quality_scores(self, name: str) -> list[float]:
        record = self._skills.get(name)
        if not record:
            return []
        return list(record.recent_quality_scores)

    def get_auto_generated_skill_names(self) -> list[str]:
        return [name for name in self._skills if name.startswith("auto-")]

    def share_skill_insights(self, agent_id: str) -> SkillInsightReportResult:
        all_skills = list(self._skills.values())
        top_skills = sorted(
            [s for s in all_skills if s.use_count > 0],
            key=lambda s: s.use_count,
            reverse=True,
        )[:10]

        top_skills_data = [
            {
                "name": s.name,
                "usage_count": s.use_count,
                "success_rate": s.quality_score,
                "avg_quality": s.quality_score,
            }
            for s in top_skills
        ]

        recommendations: list[str] = []
        for skill_data in top_skills_data[:3]:
            if skill_data["avg_quality"] < 0.7:
                recommendations.append(
                    f"建议优化 {skill_data['name']}（质量分 {skill_data['avg_quality']:.2f}）"
                )
            else:
                recommendations.append(f"{skill_data['name']} 表现良好，可考虑推广使用")

        low_usage = [s for s in all_skills if s.use_count == 0 and s.load_count > 0]
        if low_usage:
            recommendations.append(
                f"发现 {len(low_usage)} 个已加载但未使用的技能，建议评估是否需要"
            )

        return SkillInsightReportResult(
            agent_id=agent_id,
            top_skills=top_skills_data,
            recommendations=recommendations,
            generated_at=time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        )

    def integrate_external_insights(self, report: SkillInsightReport) -> int:
        if (
            not report.agent_id
            or not report.generated_at
            or not isinstance(report.top_skills, list)
        ):
            return 0

        integrated_count = 0
        for external_skill in report.top_skills:
            local_record = self._skills.get(external_skill.get("name", ""))
            if not local_record:
                continue
            local_weight = external_skill.get("usage_count", 0)
            external_weight = local_record.use_count
            total_weight = local_weight + external_weight
            if total_weight > 0:
                adjusted_score = (
                    local_record.quality_score * local_weight
                    + external_skill.get("success_rate", 0.7) * external_weight
                ) / total_weight
                local_record.quality_score = adjusted_score
                integrated_count += 1

        if integrated_count > 0:
            self._save()
            self._integration_history.append({
                "from_agent": report.agent_id,
                "integrated_count": integrated_count,
                "timestamp": time.time(),
            })
            if len(self._integration_history) > _MAX_INTEGRATION_HISTORY:
                self._integration_history = self._integration_history[-_MAX_INTEGRATION_HISTORY:]

        return integrated_count

    def get_integration_history(self) -> list[dict[str, Any]]:
        return list(self._integration_history)
