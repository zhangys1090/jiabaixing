"""U4 第2项 宪法/人格约束守卫测试。"""
from __future__ import annotations

from agent.perception.sensory_fusion import FusedPerception
from agent.tools.constitution_guard import (
    ConstitutionGuard,
    ConstitutionRule,
    ConstitutionSeverity,
    detect_danger,
)
from agent.tools.tool_call_guard import ToolCallGuard


def _danger_fused() -> FusedPerception:
    return FusedPerception(
        text="[environment] 检测到火灾报警信号",
        modalities=["environment"],
        confidence=0.95,
        structured={
            "environment": [
                {"content": "火灾报警触发,区域B2", "confidence": 0.99},
            ],
        },
    )


def _safe_fused() -> FusedPerception:
    return FusedPerception(
        text="[environment] 正常",
        modalities=["environment"],
        confidence=0.9,
        structured={"environment": [{"content": "设备运行正常", "confidence": 0.9}]},
    )


def test_detect_danger_true_when_keyword_present():
    assert detect_danger(fused=_danger_fused()) is True


def test_detect_danger_false_when_safe():
    assert detect_danger(fused=_safe_fused()) is False


def test_danger_blocks_destructive_action():
    guard = ConstitutionGuard.default()
    verdict = guard.evaluate({"tool": "shutdown_device"}, fused=_danger_fused())
    assert verdict.allowed is False
    assert verdict.danger_detected is True
    assert "danger_blocks_destructive" in verdict.blocked_by


def test_no_danger_allows_destructive_action():
    guard = ConstitutionGuard.default()
    verdict = guard.evaluate({"tool": "shutdown_device"}, fused=_safe_fused())
    assert verdict.allowed is True  # 危险规则仅在感知到危险时触发


def test_danger_does_not_block_non_destructive_action():
    guard = ConstitutionGuard.default()
    verdict = guard.evaluate({"tool": "web_search", "args": {}}, fused=_danger_fused())
    assert verdict.allowed is True


def test_unconditional_block_rule():
    guard = ConstitutionGuard.default()
    guard.add_rule(
        ConstitutionRule(
            rule_id="forbid_raw_shell",
            description="禁止直接执行原生 shell",
            severity=ConstitutionSeverity.BLOCK,
            action_keywords=("shell_exec", "execute_command"),
            requires_perception_danger=False,
        )
    )
    verdict = guard.evaluate({"tool": "shell_exec"}, fused=_safe_fused())
    assert verdict.allowed is False
    assert "forbid_raw_shell" in verdict.blocked_by


def test_warn_rule_is_allowed_but_recorded():
    guard = ConstitutionGuard.default()
    guard.add_rule(
        ConstitutionRule(
            rule_id="warn_delete",
            description="删除操作需谨慎",
            severity=ConstitutionSeverity.WARN,
            action_keywords=("delete",),
            requires_perception_danger=False,
        )
    )
    verdict = guard.evaluate({"tool": "delete_file"}, fused=_safe_fused())
    assert verdict.allowed is True
    assert any(v.rule_id == "warn_delete" for v in verdict.violations)


def test_tool_call_guard_integrates_constitution():
    tcg = ToolCallGuard()
    tcg.set_constitution_guard(ConstitutionGuard.default())
    tcg.set_current_perception(_danger_fused())

    blocked = tcg.check("shutdown_device", {"target": "main"})
    assert blocked.blocked is True
    assert blocked.result["metadata"]["constitutionBlocked"] is True

    allowed = tcg.check("web_search", {"query": "x"})
    assert allowed.blocked is False


def test_tool_call_guard_without_constitution_passthrough():
    tcg = ToolCallGuard()
    # 未注入宪法守卫：即使危险感知存在也不拦截（向后兼容）
    tcg.set_current_perception(_danger_fused())
    res = tcg.check("shutdown_device", {})
    assert res.blocked is False


def test_tool_call_guard_accepts_perception_arg():
    tcg = ToolCallGuard()
    tcg.set_constitution_guard(ConstitutionGuard.default())
    # 未 set_current_perception，但 check 直接传入 perception
    blocked = tcg.check("shutdown_device", {}, perception=_danger_fused())
    assert blocked.blocked is True
