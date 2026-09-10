import pytest

from agent.core.context_pipeline import ContextManager, TokenBudgetAllocator, TokenAllocation
from agent.core.persona import PersonaCore, ToneParams
from agent.core.command_guard import SecurityGuard, SecurityCheckResult


def test_token_allocation():
    allocator = TokenBudgetAllocator(8000)
    alloc = allocator.allocate()
    total = alloc.system_prompt + alloc.memory + alloc.history + alloc.dynamic_context + alloc.tool_results + alloc.reserve
    assert total <= 8000 * 1.1


def test_token_estimate():
    assert TokenBudgetAllocator.estimate_tokens("") >= 1
    assert TokenBudgetAllocator.estimate_tokens("hello world") >= 2


def test_truncate_to_budget():
    allocator = TokenBudgetAllocator(8000)
    long_text = "a" * 10000
    truncated = allocator.truncate_to_budget(long_text, 100)
    assert len(truncated) <= 500


def test_context_build_basic():
    cm = ContextManager()
    messages = cm.build_context("你好")
    assert len(messages) >= 1
    assert messages[-1]["role"] == "user"
    assert messages[-1]["content"] == "你好"


def test_context_build_with_system():
    cm = ContextManager()
    messages = cm.build_context("你好", system_prompt="你是助手")
    assert any(m["role"] == "system" for m in messages)


def test_context_build_with_memories():
    cm = ContextManager()
    messages = cm.build_context("你好", memories=["记忆1", "记忆2"])
    memory_msg = [m for m in messages if "记忆" in m.get("content", "")]
    assert len(memory_msg) >= 1


def test_context_build_with_history():
    cm = ContextManager()
    history = [
        {"role": "user", "content": "之前的问题"},
        {"role": "assistant", "content": "之前的回答"},
    ]
    messages = cm.build_context("新问题", history=history)
    assert len(messages) >= 3


def test_context_infer_scene():
    assert ContextManager.infer_scene("帮我写代码") == "development"
    assert ContextManager.infer_scene("项目排期") == "work"
    assert ContextManager.infer_scene("好难过") == "comfort"
    assert ContextManager.infer_scene("你好") == "greeting"
    assert ContextManager.infer_scene("周报") == "briefing"
    assert ContextManager.infer_scene("随便聊聊") == "daily"


def test_context_entries():
    cm = ContextManager()
    cm.build_context("你好", system_prompt="系统提示", memories=["记忆"])
    entries = cm.get_entries()
    assert len(entries) >= 2


def test_persona_summary():
    persona = PersonaCore()
    summary = persona.build_persona_summary()
    assert "贾百姓" in summary


def test_persona_tone_development():
    persona = PersonaCore()
    tone = persona.get_tone_for_scene("development")
    assert tone.temperature < 0.5
    assert tone.formality > 0.5


def test_persona_tone_comfort():
    persona = PersonaCore()
    tone = persona.get_tone_for_scene("comfort")
    assert tone.temperature > 0.7
    assert tone.formality < 0.5


def test_persona_scene_instruction():
    persona = PersonaCore()
    instruction = persona.build_scene_tone_instruction("development")
    assert len(instruction) > 0


def test_persona_override():
    persona = PersonaCore()
    custom = ToneParams(temperature=0.1, formality=1.0)
    persona.set_scene_override("custom_scene", custom)
    tone = persona.get_tone_for_scene("custom_scene")
    assert tone.temperature == 0.1


def test_persona_traits():
    persona = PersonaCore()
    persona.add_trait("幽默")
    assert "幽默" in persona._traits
    persona.remove_trait("幽默")
    assert "幽默" not in persona._traits


def test_security_check_safe_command():
    guard = SecurityGuard()
    result = guard.check_command("echo hello")
    assert result.allowed is True
    assert result.risk_level == "low"


def test_security_check_dangerous_command():
    guard = SecurityGuard()
    result = guard.check_command("rm -rf /")
    assert result.allowed is False
    assert result.risk_level == "critical"


def test_security_check_shutdown():
    guard = SecurityGuard()
    result = guard.check_command("shutdown now")
    assert result.allowed is False


def test_security_check_sensitive():
    guard = SecurityGuard()
    result = guard.check_command("password=secret123")
    assert result.allowed is True
    assert len(result.warnings) > 0


def test_security_check_output():
    guard = SecurityGuard()
    result = guard.check_output("正常输出")
    assert result.allowed is True

    result = guard.check_output("password=secret123")
    assert result.allowed is False


def test_security_permission_default():
    guard = SecurityGuard()
    assert guard.check_permission("user1", "memory_read") is True
    assert guard.check_permission("user1", "system_admin") is False


def test_security_permission_grant_revoke():
    guard = SecurityGuard()
    guard.grant_permission("user1", "system_admin")
    assert guard.check_permission("user1", "system_admin") is True
    guard.revoke_permission("user1", "system_admin")
    assert guard.check_permission("user1", "system_admin") is False


def test_security_audit_log():
    guard = SecurityGuard()
    guard.check_command("echo test")
    guard.check_command("rm -rf /")
    log = guard.get_audit_log()
    assert len(log) >= 2
