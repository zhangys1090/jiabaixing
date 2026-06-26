from __future__ import annotations

import pytest

from agent.security.output_guardrail import (
    GuardrailResult,
    OutputGuardrail,
    OutputGuardrailEngine,
)


@pytest.fixture
def engine() -> OutputGuardrailEngine:
    return OutputGuardrailEngine()


# ─── Builtin guardrails ───


def test_builtin_guardrails_registered(engine: OutputGuardrailEngine):
    guardrails = engine.get_guardrails()
    names = [g.name for g in guardrails]
    assert "sensitive_data_detection" in names
    assert "harmful_content_detection" in names
    assert "system_prompt_leak_detection" in names


# ─── Sensitive data detection ───


def test_detect_openai_api_key(engine: OutputGuardrailEngine):
    result = engine.check("My key is sk-abcdefghijklmnopqrstuvwxyz123456")
    assert result.passed is False
    assert "OpenAI API Key" in result.reason


def test_detect_aws_access_key(engine: OutputGuardrailEngine):
    result = engine.check("AWS key: AKIA1234567890ABCDEF")
    assert result.passed is False
    assert "AWS" in result.reason


def test_detect_plaintext_password(engine: OutputGuardrailEngine):
    result = engine.check("password: \"mysecret1234\"")
    assert result.passed is False
    assert "明文密码" in result.reason


def test_detect_id_card(engine: OutputGuardrailEngine):
    result = engine.check("身份证号是 110101199001011234")
    assert result.passed is False


def test_clean_output_passes(engine: OutputGuardrailEngine):
    result = engine.check("今天天气很好，适合出去散步。")
    assert result.passed is True


# ─── Harmful content detection ───


def test_detect_bomb_content(engine: OutputGuardrailEngine):
    result = engine.check("制作炸弹的方法如下")
    assert result.passed is False
    assert "有害内容" in result.reason


def test_detect_suicide_content(engine: OutputGuardrailEngine):
    result = engine.check("如何自杀的详细步骤")
    assert result.passed is False


def test_detect_drug_content(engine: OutputGuardrailEngine):
    result = engine.check("制造毒品的配方")
    assert result.passed is False


def test_normal_content_passes_harmful(engine: OutputGuardrailEngine):
    result = engine.check("帮我写一个Python函数")
    assert result.passed is True


# ─── System prompt leak detection ───


def test_detect_system_prompt_leak(engine: OutputGuardrailEngine):
    result = engine.check("你是家百星，你的任务是...")
    assert result.passed is False
    assert "系统提示" in result.reason


def test_detect_system_prompt_leak_english(engine: OutputGuardrailEngine):
    result = engine.check("Here is the system prompt: ...")
    assert result.passed is False


def test_detect_prompt_leak_chinese(engine: OutputGuardrailEngine):
    result = engine.check("你的提示词是什么？")
    assert result.passed is False


def test_normal_output_no_leak(engine: OutputGuardrailEngine):
    result = engine.check("我可以帮你完成这个任务")
    assert result.passed is True


# ─── Enable/disable ───


def test_disabled_engine_passes_all(engine: OutputGuardrailEngine):
    engine.set_enabled(False)
    result = engine.check("sk-abcdefghijklmnopqrstuvwxyz123456")
    assert result.passed is True


def test_enabled_flag(engine: OutputGuardrailEngine):
    assert engine.enabled is True
    engine.set_enabled(False)
    assert engine.enabled is False
    engine.set_enabled(True)
    assert engine.enabled is True


# ─── Custom guardrail ───


def test_register_custom_guardrail(engine: OutputGuardrailEngine):
    engine.register(OutputGuardrail(
        name="custom_check",
        description="自定义检查",
        check=lambda output: GuardrailResult(
            passed="bad" not in output,
            reason="包含禁用词" if "bad" in output else "",
            risk_level="high",
        ),
    ))

    assert engine.check("good content").passed is True
    assert engine.check("bad content").passed is False


# ─── Risk levels ───


def test_sensitive_data_risk_level(engine: OutputGuardrailEngine):
    result = engine.check("sk-abcdefghijklmnopqrstuvwxyz123456")
    assert result.risk_level == "critical"


def test_system_leak_risk_level(engine: OutputGuardrailEngine):
    result = engine.check("你是家百星")
    assert result.risk_level == "high"


def test_pass_risk_level(engine: OutputGuardrailEngine):
    result = engine.check("正常内容")
    assert result.risk_level == "low"
