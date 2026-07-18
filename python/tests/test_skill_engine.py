from __future__ import annotations

import tempfile
import time
from pathlib import Path

import pytest

from agent.evolution.skill_engine import (
    SkillAutoGenerator,
    SkillAutoImprover,
    SkillGenerationParams,
    SkillImprovementResult,
    SkillInsightReport,
    SkillUsageRecord,
    SkillUsageTracker,
)


def _fresh_tracker(tmp_dir: str | None = None) -> SkillUsageTracker:
    if tmp_dir is None:
        tmp_dir = tempfile.mkdtemp()
    return SkillUsageTracker(data_dir=tmp_dir)


# ─── SkillUsageRecord ───


def test_usage_record_round_trip():
    rec = SkillUsageRecord(
        name="auto_test_skill",
        path="/tmp/skills/auto_test_skill.md",
        created_at=1000.0,
        last_loaded_at=2000.0,
        last_used_at=3000.0,
        load_count=5,
        use_count=3,
        quality_score=0.85,
        recent_quality_scores=[0.8, 0.85, 0.9],
        source="auto",
        category="development",
        tags=["test"],
    )
    d = rec.to_dict()
    restored = SkillUsageRecord.from_dict(d)
    assert restored.name == rec.name
    assert restored.path == rec.path
    assert restored.use_count == rec.use_count
    assert restored.quality_score == rec.quality_score
    assert restored.recent_quality_scores == rec.recent_quality_scores
    assert restored.tags == rec.tags


# ─── SkillUsageTracker ───


def test_register_skill():
    tracker = _fresh_tracker()
    tracker.register("auto_python_code", "/tmp/skills/auto_python_code.md", 0.8)
    rec = tracker.get_record("auto_python_code")
    assert rec is not None
    assert rec.name == "auto_python_code"
    assert rec.quality_score == 0.8


def test_register_duplicate_ignored():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md", 0.9)
    tracker.register("auto_test", "/tmp/b.md", 0.5)
    rec = tracker.get_record("auto_test")
    assert rec is not None
    assert rec.quality_score == 0.9


def test_track_load():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md")
    tracker.track_load("auto_test")
    tracker.track_load("auto_test")
    rec = tracker.get_record("auto_test")
    assert rec is not None
    assert rec.load_count == 2
    assert rec.last_loaded_at is not None


def test_track_use():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md", 0.7)
    tracker.track_use("auto_test", 0.9)
    rec = tracker.get_record("auto_test")
    assert rec is not None
    assert rec.use_count == 1
    assert abs(rec.quality_score - 0.9) < 0.01


def test_track_use_moving_average():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md", 0.5)
    tracker.track_use("auto_test", 0.7)
    tracker.track_use("auto_test", 0.9)
    rec = tracker.get_record("auto_test")
    assert rec is not None
    assert rec.use_count == 2
    assert rec.quality_score > 0.7


def test_track_use_quality_history():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md")
    for q in [0.5, 0.6, 0.7, 0.8, 0.9]:
        tracker.track_use("auto_test", q)
    scores = tracker.get_recent_quality_scores("auto_test")
    assert scores == [0.5, 0.6, 0.7, 0.8, 0.9]


def test_track_use_max_history():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md")
    for i in range(15):
        tracker.track_use("auto_test", 0.5 + i * 0.01)
    scores = tracker.get_recent_quality_scores("auto_test")
    assert len(scores) <= 10


def test_get_stats():
    tracker = _fresh_tracker()
    tracker.register("auto_b", "/tmp/b.md", 0.8)
    tracker.register("auto_a", "/tmp/a.md", 0.9)
    stats = tracker.get_stats()
    assert len(stats) == 2


def test_get_auto_generated_skill_names():
    tracker = _fresh_tracker()
    tracker.register("auto_skill1", "/tmp/1.md")
    tracker.register("manual_skill", "/tmp/2.md", source="manual")
    tracker.register("auto_skill2", "/tmp/3.md")
    names = tracker.get_auto_generated_skill_names()
    assert "auto_skill1" in names
    assert "auto_skill2" in names
    assert "manual_skill" not in names


def test_get_least_used():
    tracker = _fresh_tracker()
    tracker.register("auto_used", "/tmp/a.md")
    tracker.register("auto_unused", "/tmp/b.md")
    tracker.track_use("auto_used", 0.8)
    least = tracker.get_least_used()
    names = [r.name for r in least]
    assert "auto_unused" in names


def test_get_active():
    tracker = _fresh_tracker()
    tracker.register("auto_active", "/tmp/a.md")
    tracker.track_use("auto_active", 0.8)
    active = tracker.get_active()
    names = [r.name for r in active]
    assert "auto_active" in names


def test_get_summary():
    tracker = _fresh_tracker()
    tracker.register("auto_active", "/tmp/a.md")
    tracker.register("auto_stale", "/tmp/b.md")
    tracker.track_use("auto_active", 0.8)
    summary = tracker.get_summary()
    assert summary["total"] == 2
    assert summary["active"] >= 1


def test_scan_directory(tmp_path):
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    (skills_dir / "auto_code.md").write_text("# code skill", encoding="utf-8")
    (skills_dir / "auto_search.md").write_text("# search skill", encoding="utf-8")

    tracker = _fresh_tracker(str(tmp_path / "data"))
    new_count = tracker.scan_directory(skills_dir)
    assert new_count == 2
    assert tracker.get_record("auto_code") is not None
    assert tracker.get_record("auto_search") is not None


def test_scan_directory_no_duplicates(tmp_path):
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    (skills_dir / "auto_test.md").write_text("# test", encoding="utf-8")

    tracker = _fresh_tracker(str(tmp_path / "data"))
    tracker.scan_directory(skills_dir)
    new_count = tracker.scan_directory(skills_dir)
    assert new_count == 0


def test_persistence(tmp_path):
    data_dir = tmp_path / "data"
    tracker = SkillUsageTracker(data_dir=data_dir)
    tracker.register("auto_persist", "/tmp/a.md", 0.85)
    tracker.track_use("auto_persist", 0.9)

    tracker2 = SkillUsageTracker(data_dir=data_dir)
    rec = tracker2.get_record("auto_persist")
    assert rec is not None
    assert rec.quality_score > 0.85
    assert rec.use_count == 1


def test_track_nonexistent_skill():
    tracker = _fresh_tracker()
    tracker.track_use("nonexistent", 0.5)
    assert tracker.get_record("nonexistent") is None


# ─── SkillInsightReport ───


def test_share_skill_insights():
    tracker = _fresh_tracker()
    tracker.register("auto_good", "/tmp/a.md", 0.9)
    tracker.register("auto_bad", "/tmp/b.md", 0.4)
    tracker.track_use("auto_good", 0.9)
    tracker.track_use("auto_good", 0.85)
    tracker.track_use("auto_bad", 0.4)

    report = tracker.share_skill_insights("agent_1")
    assert report.agent_id == "agent_1"
    assert len(report.top_skills) > 0
    assert report.top_skills[0]["name"] == "auto_good"
    assert len(report.recommendations) > 0


def test_integrate_external_insights():
    tracker = _fresh_tracker()
    tracker.register("auto_shared", "/tmp/a.md", 0.7)
    tracker.track_use("auto_shared", 0.7)

    external_report = SkillInsightReport(
        agent_id="agent_2",
        top_skills=[
            {"name": "auto_shared", "usage_count": 5, "success_rate": 0.9, "avg_quality": 0.9},
        ],
        recommendations=[],
        generated_at=time.time(),
    )

    count = tracker.integrate_external_insights(external_report)
    assert count == 1
    rec = tracker.get_record("auto_shared")
    assert rec is not None
    assert rec.quality_score > 0.7


def test_integrate_external_insights_empty():
    tracker = _fresh_tracker()
    report = SkillInsightReport(agent_id="", top_skills=[], recommendations=[], generated_at=0.0)
    count = tracker.integrate_external_insights(report)
    assert count == 0


def test_integrate_external_insights_unknown_skill():
    tracker = _fresh_tracker()
    report = SkillInsightReport(
        agent_id="agent_2",
        top_skills=[{"name": "nonexistent", "usage_count": 3, "success_rate": 0.8, "avg_quality": 0.8}],
        recommendations=[],
        generated_at=time.time(),
    )
    count = tracker.integrate_external_insights(report)
    assert count == 0


# ─── SkillAutoGenerator ───


def test_generate_skill():
    tmp = tempfile.mkdtemp()
    tracker = _fresh_tracker(tmp)
    generator = SkillAutoGenerator(tracker, skills_dir=Path(tmp) / "skills")

    params = SkillGenerationParams(
        input="帮我写一个Python函数",
        response="这是一个Python函数示例...",
        tools_used=["code_analysis", "file_write"],
        total_duration=1500.0,
        quality_score=0.85,
        trace_id="trace_001",
        scene="development",
    )

    result = generator.generate(params)
    assert result is not None
    assert Path(result).exists()
    assert "auto_" in Path(result).stem

    content = Path(result).read_text(encoding="utf-8")
    assert "Python" in content
    assert "code_analysis" in content

    rec = tracker.get_record(Path(result).stem)
    assert rec is not None


def test_generate_skill_low_quality_rejected():
    tmp = tempfile.mkdtemp()
    tracker = _fresh_tracker(tmp)
    generator = SkillAutoGenerator(tracker, skills_dir=Path(tmp) / "skills")

    params = SkillGenerationParams(
        input="帮我写代码",
        quality_score=0.3,
    )
    result = generator.generate(params)
    assert result is None


def test_generate_skill_short_input_rejected():
    tmp = tempfile.mkdtemp()
    tracker = _fresh_tracker(tmp)
    generator = SkillAutoGenerator(tracker, skills_dir=Path(tmp) / "skills")

    params = SkillGenerationParams(
        input="写",
        quality_score=0.9,
    )
    result = generator.generate(params)
    assert result is None


def test_generate_skill_duplicate_returns_existing():
    """测试同名skill已存在时直接返回,不重复生成"""
    tmp = tempfile.mkdtemp()
    tracker = _fresh_tracker(tmp)
    skills_dir = Path(tmp) / "skills"
    generator = SkillAutoGenerator(tracker, skills_dir=skills_dir)

    # 第一次生成
    params = SkillGenerationParams(
        input="帮我写一个Python函数",
        quality_score=0.85,
        response="示例代码",
    )
    result1 = generator.generate(params)
    assert result1 is not None

    # 第二次相同输入,语义去重触发,应该返回None(不再生成)
    # 这是预期的新行为 - 防止重复生成相同输入
    params2 = SkillGenerationParams(
        input="帮我写一个Python函数",
        quality_score=0.9,
        response="更好的代码",
    )
    result2 = generator.generate(params2)
    # 语义去重后,不会重复生成
    assert result2 is None


def test_generate_skill_semantic_duplication():
    """测试语义去重:相似输入不应该重复生成skill"""
    tmp = tempfile.mkdtemp()
    tracker = _fresh_tracker(tmp)
    generator = SkillAutoGenerator(tracker, skills_dir=Path(tmp) / "skills")

    # 第一次生成
    params1 = SkillGenerationParams(
        input="用一句话介绍你自己",
        quality_score=0.85,
        response="我是家百星AI助手...",
    )
    result1 = generator.generate(params1)
    assert result1 is not None

    # 第二次高度相似输入,语义去重触发
    params2 = SkillGenerationParams(
        input="你好请用一句话介绍你自己",
        quality_score=0.9,
        response="我是家百星AI助手,很高兴为您服务...",
    )
    result2 = generator.generate(params2)
    assert result2 is None


def test_generate_skill_no_tools():
    tmp = tempfile.mkdtemp()
    tracker = _fresh_tracker(tmp)
    generator = SkillAutoGenerator(tracker, skills_dir=Path(tmp) / "skills")

    params = SkillGenerationParams(
        input="解释一下什么是递归",
        quality_score=0.8,
        response="递归是一种编程技巧...",
        tools_used=[],
    )
    result = generator.generate(params)
    assert result is not None
    content = Path(result).read_text(encoding="utf-8")
    assert "无工具调用" in content


# ─── SkillAutoImprover ───


def test_check_quality_decline_true():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md")
    declining_scores = [0.9, 0.8, 0.7, 0.6, 0.5]
    for q in declining_scores:
        tracker.track_use("auto_test", q)

    improver = SkillAutoImprover(tracker)
    assert improver.check_quality_decline("auto_test") is True


def test_check_quality_decline_false_improving():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md")
    improving_scores = [0.5, 0.6, 0.7, 0.8, 0.9]
    for q in improving_scores:
        tracker.track_use("auto_test", q)

    improver = SkillAutoImprover(tracker)
    assert improver.check_quality_decline("auto_test") is False


def test_check_quality_decline_insufficient_data():
    tracker = _fresh_tracker()
    tracker.register("auto_test", "/tmp/a.md")
    tracker.track_use("auto_test", 0.5)
    tracker.track_use("auto_test", 0.4)

    improver = SkillAutoImprover(tracker)
    assert improver.check_quality_decline("auto_test") is False


def test_improve_skill_file(tmp_path):
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    skill_file = skills_dir / "auto_python.md"
    skill_file.write_text(
        "---\nname: auto_python\nversion: 1.0.0\n---\n\n# auto_python\n\n测试技能\n",
        encoding="utf-8",
    )

    tracker = _fresh_tracker(str(tmp_path / "data"))
    tracker.register("auto_python", str(skill_file), 0.7)

    declining_scores = [0.9, 0.8, 0.7, 0.6, 0.5]
    for q in declining_scores:
        tracker.track_use("auto_python", q)

    improver = SkillAutoImprover(
        tracker,
        correction_rules=[{"rule": "工具file_read超时", "tool": "file_read", "scene": "dev"}],
        prompt_examples=[{"input": "auto_python", "correction": "使用缓存减少超时", "scene": "dev"}],
    )

    result = improver.improve("auto_python")
    assert result.success is True
    assert result.new_version == "1.1.0"
    assert result.old_version == "1.0.0"

    updated = skill_file.read_text(encoding="utf-8")
    assert "自动改进记录" in updated
    assert "1.1.0" in updated


def test_improve_skill_in_memory():
    tracker = _fresh_tracker()
    tracker.register("auto_memory", "", 0.7)

    declining_scores = [0.9, 0.8, 0.7, 0.6, 0.5]
    for q in declining_scores:
        tracker.track_use("auto_memory", q)

    improver = SkillAutoImprover(
        tracker,
        correction_rules=[{"rule": "内存不足", "tool": "memory", "scene": "default"}],
        prompt_examples=[],
    )

    result = improver.improve("auto_memory")
    assert result.success is True


def test_improve_nonexistent_skill():
    tracker = _fresh_tracker()
    improver = SkillAutoImprover(tracker)
    result = improver.improve("nonexistent")
    assert result.success is False


def test_improve_skill_no_failures_no_corrections():
    tracker = _fresh_tracker()
    tracker.register("auto_clean", "", 0.9)
    for q in [0.9, 0.8, 0.7, 0.6, 0.5]:
        tracker.track_use("auto_clean", q)

    improver = SkillAutoImprover(tracker, correction_rules=[], prompt_examples=[])
    result = improver.improve("auto_clean")
    assert result.success is False


def test_scan_and_improve_declining():
    tracker = _fresh_tracker()
    tracker.register("auto_good", "/tmp/a.md", 0.9)
    tracker.register("auto_bad", "/tmp/b.md", 0.7)

    for q in [0.5, 0.6, 0.7, 0.8, 0.9]:
        tracker.track_use("auto_good", q)

    for q in [0.9, 0.8, 0.7, 0.6, 0.5]:
        tracker.track_use("auto_bad", q)

    improver = SkillAutoImprover(
        tracker,
        correction_rules=[{"rule": "工具bad超时", "tool": "bad", "scene": "test"}],
    )

    results = improver.scan_and_improve_declining()
    improved_names = [r.skill_name for r in results if r.success]
    assert "auto_bad" in improved_names
    assert "auto_good" not in improved_names


def test_improve_skill_version_increment(tmp_path):
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    skill_file = skills_dir / "auto_versioned.md"
    skill_file.write_text(
        "---\nname: auto_versioned\nversion: 2.3.1\n---\n\n# auto_versioned\n\n测试\n",
        encoding="utf-8",
    )

    tracker = _fresh_tracker(str(tmp_path / "data"))
    tracker.register("auto_versioned", str(skill_file), 0.7)
    for q in [0.9, 0.8, 0.7, 0.6, 0.5]:
        tracker.track_use("auto_versioned", q)

    improver = SkillAutoImprover(tracker)
    result = improver.improve("auto_versioned")
    assert result.success is True
    assert result.old_version == "2.3.1"
    assert result.new_version == "2.4.1"


def test_set_correction_rules_and_prompt_examples():
    tracker = _fresh_tracker()
    improver = SkillAutoImprover(tracker)

    improver.set_correction_rules([{"rule": "test rule"}])
    improver.set_prompt_examples([{"input": "test", "correction": "fix"}])

    assert len(improver._correction_rules) == 1
    assert len(improver._prompt_examples) == 1
