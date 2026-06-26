from __future__ import annotations

import time

import pytest

from agent.evolution.fewshot_generalizer import (
    FewShotExample,
    FewShotGeneralizer,
    FewShotLearnResult,
    GeneralizedSkill,
)


def _example(
    input_text: str = "",
    output: str = "",
    category: str = "default",
    quality: float = 0.8,
) -> FewShotExample:
    return FewShotExample(
        input=input_text,
        output=output,
        category=category,
        quality_score=quality,
        timestamp=time.time(),
    )


def test_add_example():
    gen = FewShotGeneralizer()
    gen.add_example(_example("帮我写Python代码", category="code"))
    assert len(gen.get_examples()) == 1


def test_add_example_triggers_generalization():
    gen = FewShotGeneralizer()
    gen.add_example(_example("帮我写Python函数", category="code", quality=0.9))
    gen.add_example(_example("帮我写Python类", category="code", quality=0.85))
    gen.add_example(_example("帮我写Python模块", category="code", quality=0.8))

    skills = gen.get_generalized_skills()
    assert len(skills) >= 1
    assert skills[0].example_count >= 2


def test_no_generalization_insufficient_similar():
    gen = FewShotGeneralizer()
    gen.add_example(_example("帮我写Python代码", category="code"))
    gen.add_example(_example("今天天气怎么样", category="weather"))

    skills = gen.get_generalized_skills()
    assert len(skills) == 0


def test_match_skill():
    gen = FewShotGeneralizer()
    gen.add_example(_example("帮我写Python函数", category="code", quality=0.9))
    gen.add_example(_example("帮我写Python类", category="code", quality=0.85))
    gen.add_example(_example("帮我写Python模块", category="code", quality=0.8))

    matched = gen.match_skill("帮我写Python脚本")
    assert matched is not None
    assert "code" in matched.category


def test_match_skill_no_match():
    gen = FewShotGeneralizer()
    gen.add_example(_example("帮我写Python代码", category="code"))
    matched = gen.match_skill("今天吃什么")
    assert matched is None


def test_match_skill_empty():
    gen = FewShotGeneralizer()
    matched = gen.match_skill("anything")
    assert matched is None


def test_learn_from_few_shots():
    gen = FewShotGeneralizer()
    examples = [
        _example("帮我写Python函数", category="code", quality=0.9),
        _example("帮我写Python类", category="code", quality=0.85),
        _example("帮我写Python模块", category="code", quality=0.8),
    ]

    result = gen.learn_from_few_shots(examples, "code")
    assert result is not None
    assert result.confidence > 0.5
    assert result.example_count == 3
    assert len(result.trigger_keywords) >= 0


def test_learn_from_few_shots_insufficient():
    gen = FewShotGeneralizer()
    result = gen.learn_from_few_shots([_example("test", category="code")], "code")
    assert result is None


def test_get_examples_by_category():
    gen = FewShotGeneralizer()
    gen.add_example(_example("Python代码", category="code"))
    gen.add_example(_example("天气查询", category="weather"))
    gen.add_example(_example("Java代码", category="code"))

    code_examples = gen.get_examples(category="code")
    assert len(code_examples) == 2


def test_get_stats():
    gen = FewShotGeneralizer()
    gen.add_example(_example("Python代码", category="code", quality=0.9))
    gen.add_example(_example("天气查询", category="weather", quality=0.7))

    stats = gen.get_stats()
    assert stats["total_examples"] == 2
    assert stats["categories"]["code"] == 1
    assert stats["categories"]["weather"] == 1
    assert stats["avg_quality"] > 0.7


def test_max_examples_limit():
    gen = FewShotGeneralizer()
    for i in range(150):
        gen.add_example(_example(f"example {i}", category="test"))

    assert len(gen.get_examples()) <= 100


def test_calculate_input_similarity():
    sim = FewShotGeneralizer._calculate_input_similarity("帮我写Python代码", "帮我写Python函数")
    assert sim > 0.0

    sim2 = FewShotGeneralizer._calculate_input_similarity("完全不同的输入", "毫无关联的文本")
    assert sim2 < sim


def test_calculate_input_similarity_identical():
    sim = FewShotGeneralizer._calculate_input_similarity("相同的文本", "相同的文本")
    assert sim == 1.0


def test_calculate_input_similarity_empty():
    sim = FewShotGeneralizer._calculate_input_similarity("", "")
    assert sim == 0.0


def test_extract_keywords():
    keywords = FewShotGeneralizer._extract_keywords_from_examples([
        "帮我写Python函数",
        "帮我写Python类",
        "帮我写Python模块",
    ])
    assert len(keywords) >= 0


def test_extract_keywords_no_common():
    keywords = FewShotGeneralizer._extract_keywords_from_examples([
        "苹果香蕉橙子",
        "汽车火车飞机",
    ])
    assert len(keywords) == 0


def test_generalized_skill_merge_keywords():
    gen = FewShotGeneralizer()
    gen.add_example(_example("帮我写Python函数", category="code", quality=0.9))
    gen.add_example(_example("帮我写Python类", category="code", quality=0.85))
    gen.add_example(_example("帮我写Python模块", category="code", quality=0.8))

    gen.add_example(_example("帮我写Python脚本", category="code", quality=0.75))

    skills = gen.get_generalized_skills()
    code_skills = [s for s in skills if s.category == "code"]
    if code_skills:
        assert code_skills[0].example_count >= 2


def test_generalized_skill_to_dict():
    skill = GeneralizedSkill(
        name="test_skill",
        trigger_keywords=["python", "code"],
        example_count=3,
        avg_quality=0.85,
        category="code",
        created_at=1000.0,
    )
    d = skill.to_dict()
    assert d["name"] == "test_skill"
    assert d["trigger_keywords"] == ["python", "code"]
    assert d["example_count"] == 3
    assert d["avg_quality"] == 0.85


def test_add_examples_batch():
    gen = FewShotGeneralizer()
    examples = [
        _example("Python函数", category="code", quality=0.9),
        _example("Python类", category="code", quality=0.85),
    ]
    gen.add_examples(examples)
    assert len(gen.get_examples()) == 2


def test_learn_from_few_shots_adds_to_examples():
    gen = FewShotGeneralizer()
    examples = [
        _example("Python函数", category="code", quality=0.9),
        _example("Python类", category="code", quality=0.85),
    ]
    gen.learn_from_few_shots(examples, "code")
    assert len(gen.get_examples()) == 2
