from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger
log = StructuredLogger("skill_engine")


_STALE_AFTER_DAYS = 30
_QUALITY_DECLINE_WINDOW = 5
_MAX_RECENT_QUALITY = 10
_MIN_QUALITY_FOR_GENERATION = 0.7
_MIN_INPUT_LENGTH = 5


@dataclass
class SkillUsageRecord:
    name: str
    path: str = ""
    created_at: float = 0.0
    last_loaded_at: float | None = None
    last_used_at: float | None = None
    load_count: int = 0
    use_count: int = 0
    quality_score: float = 0.7
    recent_quality_scores: list[float] = field(default_factory=list)
    source: str = "auto"
    category: str = ""
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": self.path,
            "created_at": self.created_at,
            "last_loaded_at": self.last_loaded_at,
            "last_used_at": self.last_used_at,
            "load_count": self.load_count,
            "use_count": self.use_count,
            "quality_score": self.quality_score,
            "recent_quality_scores": self.recent_quality_scores[-_MAX_RECENT_QUALITY:],
            "source": self.source,
            "category": self.category,
            "tags": self.tags,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SkillUsageRecord:
        return cls(
            name=data.get("name", ""),
            path=data.get("path", ""),
            created_at=data.get("created_at", 0.0),
            last_loaded_at=data.get("last_loaded_at"),
            last_used_at=data.get("last_used_at"),
            load_count=data.get("load_count", 0),
            use_count=data.get("use_count", 0),
            quality_score=data.get("quality_score", 0.7),
            recent_quality_scores=data.get("recent_quality_scores", []),
            source=data.get("source", "auto"),
            category=data.get("category", ""),
            tags=data.get("tags", []),
        )


@dataclass
class SkillInsightReport:
    agent_id: str
    top_skills: list[dict[str, Any]] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)
    generated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "top_skills": self.top_skills,
            "recommendations": self.recommendations,
            "generated_at": self.generated_at,
        }


@dataclass
class SkillGenerationParams:
    input: str = ""
    response: str = ""
    tools_used: list[str] = field(default_factory=list)
    total_duration: float = 0.0
    quality_score: float = 0.0
    trace_id: str = ""
    scene: str = ""


@dataclass
class SkillImprovementResult:
    skill_name: str
    success: bool
    old_version: str = ""
    new_version: str = ""
    improvement_notes: str = ""
    failure_patterns_count: int = 0
    correction_count: int = 0


class SkillUsageTracker:
    def __init__(self, data_dir: str | Path | None = None) -> None:
        if data_dir is None:
            data_dir = Path(__file__).resolve().parent.parent.parent / "data" / "evolution"
        self._data_dir = Path(data_dir)
        self._usage_file = self._data_dir / "skill-usage.json"
        self._skills: dict[str, SkillUsageRecord] = {}
        self._load()

    def _load(self) -> None:
        if not self._usage_file.exists():
            return
        try:
            raw = self._usage_file.read_text(encoding="utf-8")
            data = json.loads(raw)
            for name, record_data in data.get("skills", {}).items():
                self._skills[name] = SkillUsageRecord.from_dict(record_data)
            log.debug("SkillUsageTracker state loaded", count=len(self._skills))
        except Exception as e:
            log.warning("Failed to load skill usage state", error=str(e))

    def _save(self) -> None:
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            data = {
                "skills": {name: rec.to_dict() for name, rec in self._skills.items()},
                "last_scan_at": time.time(),
            }
            self._usage_file.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as e:
            log.warning("Failed to persist skill usage state", error=str(e))

    def register(
        self,
        name: str,
        skill_path: str = "",
        quality_score: float = 0.7,
        source: str = "auto",
        category: str = "",
        tags: list[str] | None = None,
    ) -> None:
        if name in self._skills:
            return
        self._skills[name] = SkillUsageRecord(
            name=name,
            path=skill_path,
            created_at=time.time(),
            quality_score=quality_score,
            source=source,
            category=category,
            tags=tags or [],
        )
        self._save()
        log.debug("Skill registered to tracker", name=name)

    def track_load(self, name: str) -> None:
        rec = self._skills.get(name)
        if not rec:
            return
        rec.last_loaded_at = time.time()
        rec.load_count += 1
        self._save()

    def track_use(self, name: str, quality_score: float | None = None) -> None:
        rec = self._skills.get(name)
        if not rec:
            return
        rec.last_used_at = time.time()
        rec.use_count += 1
        if quality_score is not None:
            rec.quality_score = (
                (rec.quality_score * (rec.use_count - 1) + quality_score) / rec.use_count
            )
            rec.recent_quality_scores.append(quality_score)
            if len(rec.recent_quality_scores) > _MAX_RECENT_QUALITY:
                rec.recent_quality_scores = rec.recent_quality_scores[-_MAX_RECENT_QUALITY:]
        self._save()

    def get_record(self, name: str) -> SkillUsageRecord | None:
        return self._skills.get(name)

    def get_stats(self) -> list[SkillUsageRecord]:
        return sorted(self._skills.values(), key=lambda r: r.created_at, reverse=True)

    def get_auto_generated_skill_names(self) -> list[str]:
        return [name for name in self._skills if name.startswith("auto_")]

    def get_recent_quality_scores(self, name: str) -> list[float]:
        rec = self._skills.get(name)
        if not rec:
            return []
        return list(rec.recent_quality_scores)

    def get_least_used(self) -> list[SkillUsageRecord]:
        now = time.time()
        stale_threshold = _STALE_AFTER_DAYS * 24 * 60 * 60
        return [
            rec for rec in self._skills.values()
            if rec.use_count == 0
            or not rec.last_used_at
            or (now - rec.last_used_at) > stale_threshold
        ]

    def get_active(self) -> list[SkillUsageRecord]:
        now = time.time()
        active_threshold = _STALE_AFTER_DAYS * 24 * 60 * 60
        return [
            rec for rec in self._skills.values()
            if rec.last_used_at and (now - rec.last_used_at) <= active_threshold
        ]

    def get_summary(self) -> dict[str, int]:
        now = time.time()
        stale_threshold = _STALE_AFTER_DAYS * 24 * 60 * 60
        all_records = list(self._skills.values())
        return {
            "total": len(all_records),
            "active": sum(
                1 for s in all_records
                if s.last_used_at and (now - s.last_used_at) <= stale_threshold
            ),
            "stale": sum(
                1 for s in all_records
                if not s.last_used_at or (now - s.last_used_at) > stale_threshold
            ),
        }

    def scan_directory(self, skills_dir: str | Path) -> int:
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

    def share_skill_insights(self, agent_id: str) -> SkillInsightReport:
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
        for skill in top_skills[:3]:
            if skill.quality_score < 0.7:
                recommendations.append(
                    f"建议优化 {skill.name}（质量分 {skill.quality_score:.2f}）"
                )
            else:
                recommendations.append(f"{skill.name} 表现良好，可考虑推广使用")

        low_usage = [s for s in all_skills if s.use_count == 0 and s.load_count > 0]
        if low_usage:
            recommendations.append(
                f"发现 {len(low_usage)} 个已加载但未使用的技能，建议评估是否需要"
            )

        return SkillInsightReport(
            agent_id=agent_id,
            top_skills=top_skills_data,
            recommendations=recommendations,
            generated_at=time.time(),
        )

    def integrate_external_insights(self, report: SkillInsightReport) -> int:
        if not report.agent_id or not report.top_skills:
            return 0

        integrated_count = 0
        for external_skill in report.top_skills:
            local_rec = self._skills.get(external_skill.get("name", ""))
            if not local_rec:
                continue

            local_weight = external_skill.get("usage_count", 1)
            external_weight = local_rec.use_count
            external_success_rate = external_skill.get("success_rate", 0.5)

            total_weight = local_weight + external_weight
            if total_weight > 0:
                local_rec.quality_score = (
                    (local_rec.quality_score * local_weight + external_success_rate * external_weight)
                    / total_weight
                )
                integrated_count += 1

        if integrated_count > 0:
            self._save()

        return integrated_count


class SkillAutoGenerator:
    def __init__(self, tracker: SkillUsageTracker, skills_dir: str | Path | None = None) -> None:
        self._tracker = tracker
        if skills_dir is None:
            skills_dir = Path(__file__).resolve().parent.parent.parent / "data" / "evolution" / "skills"
        self._skills_dir = Path(skills_dir)
        self._skills_dir.mkdir(parents=True, exist_ok=True)
        # 语义去重缓存 - 存储已生成skill的输入文本hash
        self._generated_inputs: list[tuple[str, float]] = []  # (text_hash, timestamp)
        self._MAX_GENERATED_INPUTS = 10000

    def _text_hash(self, text: str) -> str:
        """生成文本的词袋hash用于快速比较,使用jieba分词"""
        try:
            import jieba
            words = jieba.cut(text.lower())
            return "|".join(sorted(set(w for w in words if len(w) >= 2)))
        except ImportError:
            # jieba不可用时退化为字符级hash
            chars = set(text.lower())
            return "|".join(sorted(c for c in chars if len(c) >= 1))

    def _jaccard_similarity(self, text_a: str, text_b: str) -> float:
        """计算两个文本的Jaccard相似度,使用jieba分词"""
        try:
            import jieba
            words_a = set(w for w in jieba.cut(text_a.lower()) if len(w) >= 2)
            words_b = set(w for w in jieba.cut(text_b.lower()) if len(w) >= 2)
        except ImportError:
            words_a = set(c for c in text_a.lower())
            words_b = set(c for c in text_b.lower())

        if not words_a or not words_b:
            return 0.0

        intersection = words_a & words_b
        union = words_a | words_b

        return len(intersection) / len(union)

    def _is_duplicate_input(self, new_input: str, threshold: float = 0.7) -> bool:
        """检查新输入是否与已生成的skill输入高度相似"""
        if len(self._generated_inputs) == 0:
            return False

        now = time.time()

        # 清理超过30天的旧记录
        self._generated_inputs = [
            (h, t) for h, t in self._generated_inputs
            if (now - t) < _STALE_AFTER_DAYS * 24 * 60 * 60
        ]

        # 使用Jaccard相似度计算
        for existing_hash, _ in self._generated_inputs:
            sim = self._jaccard_similarity(new_input, existing_hash)
            if sim >= threshold:
                return True

        return False

    def _track_generated_input(self, text: str) -> None:
        """记录已生成的skill输入用于去重"""
        text_hash = self._text_hash(text)
        self._generated_inputs.append((text_hash, time.time()))
        if len(self._generated_inputs) > self._MAX_GENERATED_INPUTS:
            self._generated_inputs = self._generated_inputs[-self._MAX_GENERATED_INPUTS * 3 // 4:]

    def generate(self, params: SkillGenerationParams) -> str | None:
        if params.quality_score < _MIN_QUALITY_FOR_GENERATION:
            return None
        if not params.input or len(params.input) < _MIN_INPUT_LENGTH:
            return None

        # 新增: 语义去重检查
        if self._is_duplicate_input(params.input, threshold=0.7):
            log.debug(
                "Skill generation skipped: semantically duplicate input",
                input_hash=self._text_hash(params.input)[:16],
            )
            return None

        skill_name = self._skill_name_from_input(params.input)
        if not skill_name:
            return None

        skill_path = self._skills_dir / f"{skill_name}.md"
        if skill_path.exists():
            log.debug("Skill already exists", name=skill_name)
            self._tracker.register(skill_name, str(skill_path), params.quality_score)
            return str(skill_path)

        keywords = self._extract_keywords(params.input)
        tools_formatted = "\n".join(f"  - `{t}`" for t in params.tools_used) if params.tools_used else "  无工具调用"

        content = f"""---
name: {skill_name}
description: 从交互中自动生成 — {params.input[:60]}
version: 1.0.0
source: evolution
generatedAt: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
metadata:
  tags: [auto-generated, evolution]
---

# {skill_name}

自动生成的技能，源自一次成功的高质量交互。

## 触发条件

当用户输入涉及类似以下关键词时：

```
{', '.join(keywords)}
```

## 执行步骤

原始输入: "{params.input[:120]}"

### 使用的工具链

{tools_formatted}

### 质量评分

- 质量分数: {params.quality_score:.0%}
- 耗时: {params.total_duration / 1000:.1f}s
- 轨迹ID: {params.trace_id}

## 参考

原始响应摘要:

{params.response[:300]}

---

_由 jiabaixing SkillAutoGenerator 于 {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())} 自动生成_
"""
        try:
            skill_path.write_text(content, encoding="utf-8")
            # 记录输入用于语义去重
            self._track_generated_input(params.input)
            self._tracker.register(skill_name, str(skill_path), params.quality_score, source="auto")
            log.info("Skill generated", name=skill_name, quality=f"{params.quality_score:.2f}")
            return str(skill_path)
        except Exception as e:
            log.warning("Failed to write skill file", name=skill_name, error=str(e))
            return None

    def _skill_name_from_input(self, text: str) -> str:
        cleaned = re.sub(r"[^\w\u4e00-\u9fff]", "_", text[:30])
        cleaned = re.sub(r"_+", "_", cleaned).strip("_")
        return f"auto_{cleaned}" if cleaned else ""

    def _extract_keywords(self, text: str) -> list[str]:
        stop_words = {
            "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
            "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
            "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
            "the", "a", "an", "is", "are", "was", "were", "be", "been",
            "have", "has", "had", "do", "does", "did", "will", "would",
            "could", "should", "may", "might", "can", "shall", "to",
            "of", "in", "for", "on", "with", "at", "by", "from", "as",
        }
        words = re.findall(r"[\w\u4e00-\u9fff]+", text.lower())
        return [w for w in words if w not in stop_words and len(w) >= 2][:10]


class SkillAutoImprover:
    def __init__(
        self,
        tracker: SkillUsageTracker,
        correction_rules: list[dict[str, Any]] | None = None,
        prompt_examples: list[dict[str, str]] | None = None,
    ) -> None:
        self._tracker = tracker
        self._correction_rules = correction_rules or []
        self._prompt_examples = prompt_examples or []

    def set_correction_rules(self, rules: list[dict[str, Any]]) -> None:
        self._correction_rules = rules

    def set_prompt_examples(self, examples: list[dict[str, str]]) -> None:
        self._prompt_examples = examples

    def check_quality_decline(self, skill_name: str) -> bool:
        recent_scores = self._tracker.get_recent_quality_scores(skill_name)
        if len(recent_scores) < _QUALITY_DECLINE_WINDOW:
            return False

        last_n = recent_scores[-_QUALITY_DECLINE_WINDOW:]
        for i in range(1, len(last_n)):
            if last_n[i] >= last_n[i - 1]:
                return False

        log.info(
            "Skill quality decline detected",
            skill_name=skill_name,
            scores=[f"{s:.2f}" for s in last_n],
        )
        return True

    def improve(self, skill_name: str) -> SkillImprovementResult:
        record = self._tracker.get_record(skill_name)
        if not record:
            return SkillImprovementResult(skill_name=skill_name, success=False)

        if not record.path:
            return self._improve_in_memory(record)

        skill_path = Path(record.path)
        if not skill_path.exists():
            return self._improve_in_memory(record)

        return self._improve_skill_file(record, skill_path)

    def _improve_skill_file(self, record: SkillUsageRecord, skill_path: Path) -> SkillImprovementResult:
        try:
            original = skill_path.read_text(encoding="utf-8")
        except Exception as e:
            log.warning("Failed to read skill file", path=str(skill_path), error=str(e))
            return SkillImprovementResult(skill_name=record.name, success=False)

        related_failures = self._collect_related_failures(record.name)
        related_corrections = self._collect_related_corrections(record.name)

        version_match = re.search(r"version:\s*(\d+)\.(\d+)\.(\d+)", original)
        if version_match:
            major = int(version_match.group(1))
            minor = int(version_match.group(2)) + 1
            patch = int(version_match.group(3))
            new_version = f"{major}.{minor}.{patch}"
            old_version = f"{major}.{version_match.group(2)}.{patch}"
        else:
            old_version = "1.0.0"
            new_version = "1.1.0"

        failure_text = "\n".join(
            f'- 输入: "{f.get("input", "")[:80]}" → 错误: {f.get("error", "")}'
            for f in related_failures
        ) if related_failures else "暂无具体失败记录"

        correction_text = "\n".join(
            f'- 触发: "{c.get("trigger", "")}" → 纠正: {c.get("correction", "")}'
            for c in related_corrections
        ) if related_corrections else "暂无纠错示例"

        improvement_section = f"""

## 自动改进记录 ({new_version})

_改进时间: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())}_

### 改进原因

最近 {_QUALITY_DECLINE_WINDOW} 次使用的质量评分持续下降，当前平均质量: {record.quality_score:.0%}

### 已识别的失败模式

{failure_text}

### 纠正建议

{correction_text}

### 改进指引

- 优先参考上述纠正建议调整执行步骤
- 对失败模式中提到的场景增加额外检查
- 如果工具调用失败率高，考虑使用替代工具或分步执行

---

_由 jiabaixing SkillAutoImprover 于 {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())} 自动改进_
"""

        updated = re.sub(r"version:\s*\d+\.\d+\.\d+", f"version: {new_version}", original)
        updated = updated.replace(
            "---\n",
            f"---\n\n<!-- 自动改进记录 -->\n<!-- 改进时间: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} -->\n<!-- 改进原因: 质量评分持续下降 -->\n",
            1,
        )
        final = updated + improvement_section

        try:
            skill_path.write_text(final, encoding="utf-8")
            log.info(
                "Skill auto-improved",
                skill_name=record.name,
                version=new_version,
                quality=f"{record.quality_score:.0%}",
            )
            return SkillImprovementResult(
                skill_name=record.name,
                success=True,
                old_version=old_version,
                new_version=new_version,
                improvement_notes=f"质量从{old_version}改进到{new_version}",
                failure_patterns_count=len(related_failures),
                correction_count=len(related_corrections),
            )
        except Exception as e:
            log.warning("Failed to write improved skill file", error=str(e))
            return SkillImprovementResult(skill_name=record.name, success=False)

    def _improve_in_memory(self, record: SkillUsageRecord) -> SkillImprovementResult:
        related_failures = self._collect_related_failures(record.name)
        related_corrections = self._collect_related_corrections(record.name)

        if not related_failures and not related_corrections:
            return SkillImprovementResult(skill_name=record.name, success=False)

        failure_text = "; ".join(f.get("rule", "") for f in related_failures[:3])
        record.tags = record.tags + [f"improved_{int(time.time())}"]

        log.info(
            "Skill improved in-memory",
            skill_name=record.name,
            failures=len(related_failures),
            corrections=len(related_corrections),
        )
        return SkillImprovementResult(
            skill_name=record.name,
            success=True,
            old_version="1.0.0",
            new_version="1.1.0",
            improvement_notes=failure_text,
            failure_patterns_count=len(related_failures),
            correction_count=len(related_corrections),
        )

    def _collect_related_failures(self, skill_name: str) -> list[dict[str, Any]]:
        skill_keywords = skill_name.replace("auto_", "").split("_")
        skill_keywords = [kw for kw in skill_keywords if len(kw) >= 2]

        related: list[dict[str, Any]] = []
        for rule in self._correction_rules:
            if any(kw in rule.get("rule", "") or kw in rule.get("tool", "") for kw in skill_keywords):
                related.append(rule)
        return related[-10:]

    def _collect_related_corrections(self, skill_name: str) -> list[dict[str, Any]]:
        skill_keywords = skill_name.replace("auto_", "").split("_")
        skill_keywords = [kw for kw in skill_keywords if len(kw) >= 2]

        related: list[dict[str, Any]] = []
        for example in self._prompt_examples:
            trigger = example.get("input", "") + example.get("scene", "")
            if any(kw in trigger for kw in skill_keywords):
                related.append({
                    "trigger": example.get("input", ""),
                    "correction": example.get("correction", ""),
                })
        return related[-10:]

    def scan_and_improve_declining(self) -> list[SkillImprovementResult]:
        auto_skills = self._tracker.get_auto_generated_skill_names()
        results: list[SkillImprovementResult] = []
        for skill_name in auto_skills:
            if self.check_quality_decline(skill_name):
                result = self.improve(skill_name)
                results.append(result)
        return results
