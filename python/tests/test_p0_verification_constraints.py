from __future__ import annotations

import pytest

from agent.security.sensitive_detector import (
    CheckScene,
    RiskLevel,
    check_dangerous_command,
    check_sensitive_info,
    sanitize_text,
)
from agent.verification.service import (
    GoalProgress,
    QualityScore,
    SafetyCheckResult,
    ToolResult,
    ValidationResult,
    VerificationService,
    VerificationServiceDeps,
)
from agent.constraints.service import (
    BudgetAllocation,
    BudgetCheckResult,
    BudgetState,
    ConstraintsService,
    ConstraintsServiceDeps,
    ConstraintLevel,
    CreativeExplorationConfig,
    HookContext,
    HookResult,
    LifecycleEvent,
    Permission,
    ToolContext,
)


class TestSensitiveDetector:
    def test_safe_text(self):
        result = check_sensitive_info("这是一段普通文本，没有敏感信息")
        assert result.safe is True
        assert result.risk_level == RiskLevel.NONE

    def test_detect_phone_number(self):
        result = check_sensitive_info("我的手机号是13812345678")
        assert result.safe is False
        assert any(v.name == "手机号码" for v in result.violations)

    def test_detect_api_key(self):
        result = check_sensitive_info("api_key=sk-abc123def456ghi789jkl012mno345")
        assert result.safe is False
        assert any("API密钥" in v.name for v in result.violations)

    def test_detect_password_leak(self):
        result = check_sensitive_info("密码是 mypassword123")
        assert result.safe is False
        assert any(v.name == "密码泄露" for v in result.violations)

    def test_detect_id_card(self):
        result = check_sensitive_info("身份证号 110101199001011234")
        assert result.safe is False

    def test_storage_scene_stricter(self):
        result = check_sensitive_info("密钥", CheckScene.STORAGE)
        assert result.safe is False
        assert any(v.name == "敏感凭证关键词" for v in result.violations)

    def test_dangerous_command_rm_rf(self):
        result = check_dangerous_command("rm -rf /")
        assert result.dangerous is True

    def test_dangerous_command_drop_table(self):
        result = check_dangerous_command("drop table users")
        assert result.dangerous is True

    def test_safe_command(self):
        result = check_dangerous_command("ls -la")
        assert result.dangerous is False

    def test_sanitize_phone(self):
        result = sanitize_text("手机号13812345678")
        assert "13812345678" not in result
        assert "[手机号-已脱敏]" in result

    def test_sanitize_api_key(self):
        result = sanitize_text("key=sk-abc123def456ghi789jkl012mno345")
        assert "sk-abc123" not in result


class TestVerificationService:
    def setup_method(self):
        self.service = VerificationService()

    def test_validate_success_result(self):
        result = ToolResult(success=True, output="执行成功")
        vr = self.service.validate_tool_result("test_tool", result)
        assert vr.valid is True
        assert vr.sanitized_output == "执行成功"
        assert len(vr.errors) == 0

    def test_validate_failed_result(self):
        result = ToolResult(success=False, error="超时")
        vr = self.service.validate_tool_result("test_tool", result)
        assert vr.valid is False
        assert "超时" in vr.sanitized_output

    def test_validate_empty_output(self):
        result = ToolResult(success=True, output="")
        vr = self.service.validate_tool_result("test_tool", result)
        assert vr.valid is False
        assert "空结果" in vr.sanitized_output

    def test_validate_truncated_output(self):
        long_output = "x" * 5000
        result = ToolResult(success=True, output=long_output)
        vr = self.service.validate_tool_result("test_tool", result)
        assert vr.valid is True
        assert vr.auto_fixed is True
        assert "截断" in vr.warnings[0]

    def test_validate_error_pattern_warning(self):
        result = ToolResult(success=True, output="error: timeout")
        vr = self.service.validate_tool_result("test_tool", result)
        assert vr.valid is True
        assert len(vr.warnings) > 0

    def test_check_output_safety_safe(self):
        result = self.service.check_output_safety("这是一段安全的输出")
        assert result.safe is True
        assert result.risk_level == RiskLevel.NONE

    def test_check_output_safety_unsafe(self):
        result = self.service.check_output_safety("密码是 abc123456")
        assert result.safe is False
        assert len(result.violations) > 0

    def test_score_quality_success(self):
        ctx = {
            "loop_count": 2,
            "total_tool_calls": 3,
            "total_tool_duration": 1500.0,
            "total_duration": 5000.0,
            "completed_successfully": True,
        }
        score = self.service.score_quality(ctx)
        assert isinstance(score, QualityScore)
        assert score.overall > 0.5
        assert score.efficiency > 0.5

    def test_score_quality_failure(self):
        ctx = {
            "loop_count": 5,
            "total_tool_calls": 10,
            "total_tool_duration": 60000.0,
            "total_duration": 45000.0,
            "completed_successfully": False,
        }
        score = self.service.score_quality(ctx)
        assert score.overall < 0.8
        assert score.efficiency < 0.5

    @pytest.mark.asyncio
    async def test_evaluate_goal_progress_empty(self):
        result = await self.service.evaluate_goal_progress("帮我写代码", "")
        assert result.achieved is False
        assert result.progress < 0.5

    @pytest.mark.asyncio
    async def test_evaluate_goal_progress_error(self):
        result = await self.service.evaluate_goal_progress("帮我写代码", "抱歉，无法完成此操作")
        assert result.achieved is False
        assert result.suggested_action == "replan"

    @pytest.mark.asyncio
    async def test_evaluate_goal_progress_ok(self):
        result = await self.service.evaluate_goal_progress("帮我写代码", "这是为你编写的代码示例：\n```python\nprint('hello')\n```")
        assert result.achieved is True
        assert result.progress > 0.5


class TestConstraintsService:
    def setup_method(self):
        self.service = ConstraintsService()

    def test_check_budget_within(self):
        state = BudgetState(rounds_used=2, soft_round_limit=5, hard_round_limit=8)
        result = self.service.check_budget(state)
        assert result.within_budget is True
        assert len(result.warnings) == 0

    def test_check_budget_soft_limit(self):
        state = BudgetState(rounds_used=5, soft_round_limit=5, hard_round_limit=8)
        result = self.service.check_budget(state)
        assert result.within_budget is False
        assert any("软限制" in w for w in result.warnings)

    def test_check_budget_hard_limit(self):
        state = BudgetState(rounds_used=8, soft_round_limit=5, hard_round_limit=8)
        result = self.service.check_budget(state)
        assert result.within_budget is False
        assert any("硬限制" in w for w in result.warnings)

    def test_check_budget_remaining(self):
        state = BudgetState(rounds_used=3, soft_round_limit=5, hard_round_limit=8)
        result = self.service.check_budget(state)
        assert result.remaining["rounds"] == 5

    def test_check_safety_boundary_safe(self):
        result = self.service.check_safety_boundary("hello", "ls -la")
        assert result["allowed"] is True

    def test_check_safety_boundary_dangerous(self):
        result = self.service.check_safety_boundary("hello", "rm -rf /")
        assert result["allowed"] is False

    def test_check_safety_boundary_long_input(self):
        result = self.service.check_safety_boundary("x" * 10001, "ls")
        assert result["allowed"] is False

    def test_enforce_no_sensitive_data_leak_safe(self):
        ctx = {"result": {"output": "普通输出"}}
        result = self.service.enforce_behavior_constraint("no-sensitive-data-leak", ctx)
        assert result["compliant"] is True

    def test_enforce_no_sensitive_data_leak_unsafe(self):
        ctx = {"result": {"output": "密码是 abc123456"}}
        result = self.service.enforce_behavior_constraint("no-sensitive-data-leak", ctx)
        assert result["compliant"] is False

    def test_enforce_no_dangerous_commands(self):
        ctx = {"params": {"command": "rm -rf /"}}
        result = self.service.enforce_behavior_constraint("no-dangerous-commands", ctx)
        assert result["compliant"] is False

    def test_enforce_no_unauthorized_file_access(self):
        ctx = {"params": {"filePath": "C:\\Windows\\System32\\config"}}
        result = self.service.enforce_behavior_constraint("no-unauthorized-file-access", ctx)
        assert result["compliant"] is False

    def test_enforce_no_unbounded_recursion(self):
        ctx = {"params": {"recursionDepth": 12}}
        result = self.service.enforce_behavior_constraint("no-unbounded-recursion", ctx)
        assert result["compliant"] is False

    def test_enforce_with_level_hard(self):
        ctx = {"params": {"command": "rm -rf /"}}
        result = self.service.enforce_with_level("no-dangerous-commands", ctx)
        assert result["compliant"] is False
        assert result["level"] == "hard"

    def test_enforce_with_level_soft_pass(self):
        ctx = {"params": {"memoryMB": 600}}
        result = self.service.enforce_with_level("resource-limit-check", ctx)
        assert result["compliant"] is True
        assert result["level"] == "soft"

    def test_get_constraint_definitions(self):
        defs = self.service.get_constraint_definitions()
        assert len(defs) >= 6
        hard_count = sum(1 for d in defs if d.level == ConstraintLevel.HARD)
        assert hard_count >= 5

    def test_resolve_adaptive_budget_simple(self):
        alloc = self.service.resolve_adaptive_budget("simple")
        assert alloc.max_rounds == 4
        assert alloc.max_tool_calls == 5

    def test_resolve_adaptive_budget_complex(self):
        alloc = self.service.resolve_adaptive_budget("complex")
        assert alloc.max_rounds == 12
        assert alloc.max_tool_calls == 15

    def test_resolve_adaptive_budget_creative(self):
        alloc = self.service.resolve_adaptive_budget("moderate", enable_creative=True)
        base = self.service.get_adaptive_budget().moderate
        bonus = self.service.get_adaptive_budget().creative_bonus
        assert alloc.max_rounds == base.max_rounds + bonus.max_rounds

    def test_can_explore_creatively(self):
        budget = BudgetState(rounds_used=3, soft_round_limit=5, hard_round_limit=8)
        result = self.service.can_explore_creatively(0.8, budget)
        assert result["allowed"] is True

    def test_can_explore_creatively_low_quality(self):
        budget = BudgetState(rounds_used=3, soft_round_limit=5, hard_round_limit=8)
        result = self.service.can_explore_creatively(0.3, budget)
        assert result["allowed"] is False

    def test_get_budget_pressure_none(self):
        budget = BudgetState(rounds_used=1, soft_round_limit=5, hard_round_limit=8)
        result = self.service.get_budget_pressure(budget)
        assert result["level"] == "none"

    def test_get_budget_pressure_caution(self):
        budget = BudgetState(rounds_used=6, soft_round_limit=5, hard_round_limit=8)
        result = self.service.get_budget_pressure(budget)
        assert result["level"] in ("caution", "critical")

    def test_get_budget_pressure_critical(self):
        budget = BudgetState(rounds_used=8, soft_round_limit=5, hard_round_limit=8)
        result = self.service.get_budget_pressure(budget)
        assert result["level"] == "critical"

    @pytest.mark.asyncio
    async def test_execute_hooks_proceed(self):
        async def allow_hook(ctx):
            return HookResult(proceed=True)

        self.service.register_hook(LifecycleEvent.BEFORE_TOOL_CALL, allow_hook)
        ctx = HookContext(event=LifecycleEvent.BEFORE_TOOL_CALL)
        result = await self.service.execute_hooks(LifecycleEvent.BEFORE_TOOL_CALL, ctx)
        assert result.proceed is True

    @pytest.mark.asyncio
    async def test_execute_hooks_block(self):
        async def block_hook(ctx):
            return HookResult(proceed=False, reason="安全拦截")

        self.service.register_hook(LifecycleEvent.BEFORE_TOOL_CALL, block_hook)
        ctx = HookContext(event=LifecycleEvent.BEFORE_TOOL_CALL)
        result = await self.service.execute_hooks(LifecycleEvent.BEFORE_TOOL_CALL, ctx)
        assert result.proceed is False
        assert result.reason == "安全拦截"

    def test_no_sensitive_storage(self):
        ctx = {
            "toolName": "memory_store",
            "params": {"content": "api_key=sk-abc123def456ghi789jkl012mno345"},
        }
        result = self.service.enforce_behavior_constraint("no-sensitive-storage", ctx)
        assert result["compliant"] is False

    def test_no_sensitive_storage_safe(self):
        ctx = {
            "toolName": "memory_store",
            "params": {"content": "今天天气不错"},
        }
        result = self.service.enforce_behavior_constraint("no-sensitive-storage", ctx)
        assert result["compliant"] is True
