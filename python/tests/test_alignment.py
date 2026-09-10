"""P0-2: 宪法检查器 + 红队测试。"""

from __future__ import annotations

from agent.alignment.constitution_checker import (
    ConstitutionChecker,
    ConstitutionCheckResult,
    ConstitutionRule,
)
from agent.alignment.red_team import (
    RedTeamSuite,
    AttackCategory,
    AttackPrompt,
    AttackSeverity,
)


def test_constitution_check_clean_output():
    checker = ConstitutionChecker()
    result = checker.check("这是一个正常的回答，没有虚构任何内容。")
    assert result.is_compliant
    assert result.compliance_rate >= 0.8


def test_constitution_check_fabricated_url():
    checker = ConstitutionChecker()
    result = checker.check(
        "请访问 https://jiabaixing-secret-internal.corp/api/v3/users 获取数据。"
    )
    assert len(result.violations) > 0
    has_url_violation = any(
        v.rule == ConstitutionRule.NO_FABRICATED_URLS for v in result.violations
    )
    assert has_url_violation


def test_constitution_check_fabricated_api():
    checker = ConstitutionChecker(
        known_apis={"os.path.join", "json.loads"},
    )
    result = checker.check(
        "使用 quantum.compute.optimize() 函数来加速计算。"
    )
    has_api_violation = any(
        v.rule == ConstitutionRule.NO_FABRICATED_APIS for v in result.violations
    )
    assert has_api_violation


def test_constitution_check_with_known_tools():
    checker = ConstitutionChecker()
    result = checker.check(
        "使用 web_search 工具搜索信息。",
        available_tools={"web_search", "file_read", "code_execute"},
    )
    assert result.is_compliant


def test_red_team_suite_prompt_count():
    suite = RedTeamSuite()
    assert suite.prompt_count >= 15


def test_red_team_suite_categories():
    suite = RedTeamSuite()
    categories = suite.prompts_by_category
    assert "jailbreak" in categories
    assert "hallucination_induction" in categories
    assert "permission_bypass" in categories


def test_red_team_without_llm():
    import asyncio
    suite = RedTeamSuite()
    report = asyncio.get_event_loop().run_until_complete(suite.run(max_prompts=3))
    assert report.total_attacks == 3
    assert report.passed_attacks == 3
    assert report.safety_score == 1.0
