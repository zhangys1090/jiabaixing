"""P2-6 子 Agent 工具下放 — 白名单 / 沙箱边界 / unsafe 门控 回归测试。

覆盖：
- 白名单正确性：基准集无幽灵条目、不含高危/越界/拒绝集成员；双轨派生正确。
- 沙箱子注册表隔离：高危工具对子 Agent 不可见、不可执行。
- unsafe 能力门控：关闭时子集强制、delegate_task 永禁；开启时(算子开关)才突破。
- 边界 enforcement：输出截断、单工具超时降级、max_iterations 墙、max_steps 第五道墙。
- ReAct 收敛：mock LLM 多轮 tool_calls → 终答。
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolRegistry,
    ToolResult,
)
from agent.tools.delegate_tool import (
    DelegateStatus,
    SUBAGENT_DENY_TOOLS,
    SUBAGENT_SAFE_TOOLS,
    SubAgentDelegator,
    derive_default_safe_tools,
    resolve_allowed_tools,
)

TOOLS_DIR = Path(__file__).resolve().parents[1] / "agent" / "tools"


def _build_registry(spec):
    """spec: iterable of (name, category, risk, executor)。"""
    reg = ToolRegistry()
    for name, cat, risk, executor in spec:
        reg.register(
            ToolDefinition(name=name, description="x", category=cat, risk_level=risk),
            executor,
        )
    return reg


async def _ok(_params=None):
    return ToolResult(success=True, output="OK")


class _ScriptedLLM:
    """按预设脚本返回 LLM 响应；记录最后一次收到的 messages。"""

    def __init__(self, responses):
        self._responses = list(responses)
        self.last_messages = None
        self.calls = 0

    async def chat(self, messages, tools=None, use_cache=None):
        self.last_messages = messages
        self.calls += 1
        if not self._responses:
            return {"content": "(no more scripted responses)", "tool_calls": None}
        return self._responses.pop(0)


def _tc(tid, name, args="{}"):
    return {"id": tid, "function": {"name": name, "arguments": args}}


class TestWhitelistBaselineIntegrity:
    """基准白名单的静态正确性（不依赖运行期注册表）。"""

    def _scan_tool_names(self):
        names = set()
        pat = re.compile(r'ToolDefinition\(\s*name\s*=\s*"([^"]+)"')
        for f in TOOLS_DIR.glob("*.py"):
            txt = f.read_text(encoding="utf-8", errors="ignore")
            for m in pat.finditer(txt):
                names.add(m.group(1))
        return names

    def _scan_non_low(self):
        pat = re.compile(r'ToolDefinition\(\s*(.*?)\n\)', re.S)
        name_re = re.compile(r'name\s*=\s*"([^"]+)"')
        risk_re = re.compile(r'risk_level\s*=\s*"([^"]+)"')
        non_low = set()
        for f in TOOLS_DIR.glob("*.py"):
            txt = f.read_text(encoding="utf-8", errors="ignore")
            for m in pat.finditer(txt):
                nm = name_re.search(m.group(1))
                rk = risk_re.search(m.group(1))
                if nm and rk and rk.group(1) != "low":
                    non_low.add(nm.group(1))
        return non_low

    def test_baseline_no_phantom(self):
        names = self._scan_tool_names()
        assert names, "未能扫描到任何工具定义"
        for n in SUBAGENT_SAFE_TOOLS:
            assert n in names, f"基准白名单含幽灵工具(未注册): {n}"

    def test_baseline_excludes_deny_and_dangerous(self):
        for n in SUBAGENT_DENY_TOOLS:
            assert n not in SUBAGENT_SAFE_TOOLS, f"基准集误含拒绝项: {n}"
        dangerous = {
            "shell_exec", "execute_code", "git_commit", "multi_file_edit",
            "desktop_automate", "desktop_screenshot", "file_edit",
            "incremental_edit", "code_edit_ast", "code_fix", "code_generate",
            "delegate_task", "code_generate_ast", "test_run",
            "memory_store", "message_push", "image_generate", "skill_create",
            "ha_control", "browser_click", "uia_click", "rollback_changes",
            "cronjob_create", "cronjob_execute", "kanban_add_task",
            "note_take", "reminder_set", "task_manage", "voice_mode",
            "test_gen_execute", "browser_screenshot",
        }
        for n in dangerous:
            assert n not in SUBAGENT_SAFE_TOOLS, f"基准集误含高危工具: {n}"

    def test_baseline_excludes_non_low_risk(self):
        for n in self._scan_non_low():
            assert n not in SUBAGENT_SAFE_TOOLS, f"基准集含非 low 风险工具: {n}"


class TestDerivation:
    """双轨派生：元数据(risk==low) - 拒绝集 - delegate_task。"""

    def _spec(self):
        return [
            ("file_read", ToolCategory.FILE, "low", _ok),
            ("code_analyze", ToolCategory.CODE, "low", _ok),
            ("shell_exec", ToolCategory.CODE, "high", _ok),
            ("execute_code", ToolCategory.CODE, "high", _ok),
            ("git_commit", ToolCategory.CODE, "high", _ok),
            ("multi_file_edit", ToolCategory.FILE, "high", _ok),
            ("delegate_task", ToolCategory.COGNITION, "medium", _ok),
            ("code_generate_ast", ToolCategory.CODE, "medium", _ok),
            ("test_run", ToolCategory.CODE, "medium", _ok),
            ("memory_store", ToolCategory.MEMORY, "low", _ok),
            ("message_push", ToolCategory.NETWORK, "low", _ok),
            ("kanban_add_task", ToolCategory.SYSTEM, "low", _ok),
            ("ha_scene", ToolCategory.IOT, "low", _ok),
            ("image_generate", ToolCategory.NETWORK, "low", _ok),
            ("skill_create", ToolCategory.NETWORK, "low", _ok),
            ("note_take", ToolCategory.DAILY, "low", _ok),
            ("browser_screenshot", ToolCategory.DESKTOP, "low", _ok),
            ("voice_mode", ToolCategory.PERCEPTION, "low", _ok),
        ]

    def test_derivation_includes_only_low_readonly(self):
        reg = _build_registry(self._spec())
        assert derive_default_safe_tools(reg) == {"file_read", "code_analyze"}

    def test_derivation_excludes_high_medium_deny(self):
        reg = _build_registry(self._spec())
        safe = derive_default_safe_tools(reg)
        banned = [
            "shell_exec", "execute_code", "git_commit", "multi_file_edit",
            "delegate_task", "code_generate_ast", "test_run", "memory_store",
            "message_push", "kanban_add_task", "ha_scene", "image_generate",
            "skill_create", "note_take", "browser_screenshot", "voice_mode",
        ]
        for bad in banned:
            assert bad not in safe, f"派生误含: {bad}"

    def test_derivation_no_registry_falls_back(self):
        assert derive_default_safe_tools(None) == SUBAGENT_SAFE_TOOLS


class TestSandboxIsolation:
    """沙箱子注册表：非白名单工具对子 Agent 不可见、不可执行。"""

    @pytest.mark.asyncio
    async def test_sub_registry_excludes_non_whitelisted(self):
        calls = []

        async def shell_exec(_p=None):
            calls.append(1)
            return ToolResult(success=True, output="PWNED")

        reg = _build_registry([
            ("file_read", ToolCategory.FILE, "low", _ok),
            ("shell_exec", ToolCategory.CODE, "high", shell_exec),
        ])
        d = SubAgentDelegator()
        d.set_registry(reg)
        allowed = derive_default_safe_tools(reg)
        sub = d._build_sub_registry(allowed)
        assert sub.has("file_read")
        assert not sub.has("shell_exec")
        res = await sub.execute("shell_exec", {})
        assert res.success is False
        assert "not found" in (res.error or "")
        assert calls == [], "高危工具执行器不应被调用"


class TestResolveAllowedTools:
    """resolve_allowed_tools：子集校验 + unsafe 能力门控。"""

    def _default(self):
        reg = _build_registry([
            ("file_read", ToolCategory.FILE, "low", _ok),
            ("shell_exec", ToolCategory.CODE, "high", _ok),
        ])
        return derive_default_safe_tools(reg)

    def test_none_uses_default(self):
        default = self._default()
        assert resolve_allowed_tools(None, False, default) == set(default)

    def test_unauthorized_stripped_when_unsafe_off(self):
        default = self._default()
        got = resolve_allowed_tools({"file_read", "shell_exec"}, False, default)
        assert got == {"file_read"}

    def test_delegate_task_always_stripped(self):
        default = self._default()
        got = resolve_allowed_tools({"file_read", "delegate_task"}, False, default)
        assert "delegate_task" not in got

    def test_unsafe_off_ignores_unsafe_flag(self, monkeypatch):
        monkeypatch.delenv("AGENT_SUBAGENT_UNSAFE", raising=False)
        default = self._default()
        got = resolve_allowed_tools({"file_read", "shell_exec"}, True, default)
        assert got == {"file_read"}

    def test_unsafe_on_honors_breakout(self, monkeypatch):
        monkeypatch.setenv("AGENT_SUBAGENT_UNSAFE", "1")
        default = self._default()
        got = resolve_allowed_tools({"file_read", "shell_exec"}, True, default)
        assert got == {"file_read", "shell_exec"}
        got2 = resolve_allowed_tools(
            {"file_read", "shell_exec", "delegate_task"}, True, default
        )
        assert "delegate_task" not in got2


class _CapturingLLM(_ScriptedLLM):
    """记录最后一次 tool 消息内容，供截断/超时断言。"""

    def __init__(self, responses):
        super().__init__(responses)
        self.last_tool_content = None

    async def chat(self, messages, tools=None, use_cache=None):
        r = await super().chat(messages, tools=tools, use_cache=use_cache)
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        if tool_msgs:
            self.last_tool_content = tool_msgs[-1]["content"]
        return r


class TestReactLoop:
    """ReAct 循环行为：收敛、轮数墙、步数墙、截断、超时。"""

    @pytest.mark.asyncio
    async def test_converges_after_tool_call(self):
        file_calls = []

        async def file_read(_p=None):
            file_calls.append(1)
            return ToolResult(success=True, output="CONTENT-XYZ")

        reg = _build_registry([("file_read", ToolCategory.FILE, "low", file_read)])
        llm = _ScriptedLLM([
            {"content": "", "tool_calls": [_tc("t1", "file_read")]},
            {"content": "FINAL-ANSWER", "tool_calls": None},
        ])
        d = SubAgentDelegator()
        d.set_registry(reg)
        d.set_llm(llm)
        res = await d.delegate("do it")
        assert res.status == DelegateStatus.COMPLETED
        assert res.result_text == "FINAL-ANSWER"
        assert res.tool_calls_made == 1
        assert file_calls == [1]

    @pytest.mark.asyncio
    async def test_max_iterations_wall(self):
        async def file_read(_p=None):
            return ToolResult(success=True, output="x")

        reg = _build_registry([("file_read", ToolCategory.FILE, "low", file_read)])
        llm = _ScriptedLLM([{"content": "", "tool_calls": [_tc("t1", "file_read")]}] * 3)
        d = SubAgentDelegator()
        d.set_registry(reg)
        d.set_llm(llm)
        res = await d.delegate("loop", max_iterations=3)
        assert res.rounds_used == 3
        assert res.tool_calls_made == 3
        assert "最大迭代" in res.result_text

    @pytest.mark.asyncio
    async def test_max_steps_wall(self):
        async def file_read(_p=None):
            return ToolResult(success=True, output="x")

        reg = _build_registry([("file_read", ToolCategory.FILE, "low", file_read)])
        two = {"content": "", "tool_calls": [_tc("a", "file_read"), _tc("b", "file_read")]}
        llm = _ScriptedLLM([two, two, two, two])
        d = SubAgentDelegator()
        d.set_registry(reg)
        d.set_llm(llm)
        res = await d.delegate("steps", max_iterations=10, max_steps=3)
        assert res.tool_calls_made == 3, res.tool_calls_made
        assert res.rounds_used < 10
        assert "最大工具调用" in res.result_text

    @pytest.mark.asyncio
    async def test_output_truncation(self):
        async def file_read(_p=None):
            return ToolResult(success=True, output="X" * 5000)

        reg = _build_registry([("file_read", ToolCategory.FILE, "low", file_read)])
        llm = _CapturingLLM([
            {"content": "", "tool_calls": [_tc("t1", "file_read")]},
            {"content": "FINAL", "tool_calls": None},
        ])
        d = SubAgentDelegator()
        d.set_registry(reg)
        d.set_llm(llm)
        res = await d.delegate("trunc", max_tool_output_chars=20)
        assert res.status == DelegateStatus.COMPLETED
        assert llm.last_tool_content is not None
        assert "truncated" in llm.last_tool_content
        assert len(llm.last_tool_content) <= 20 + 50

    @pytest.mark.asyncio
    async def test_per_tool_timeout_degrades(self):
        async def slow(_p=None):
            await asyncio.sleep(5)
            return ToolResult(success=True, output="should-not-reach")

        reg = _build_registry([("file_read", ToolCategory.FILE, "low", slow)])
        llm = _CapturingLLM([
            {"content": "", "tool_calls": [_tc("t1", "file_read")]},
            {"content": "FINAL", "tool_calls": None},
        ])
        d = SubAgentDelegator()
        d.set_registry(reg)
        d.set_llm(llm)
        res = await d.delegate("timeout", per_tool_timeout=0.2)
        assert res.status == DelegateStatus.COMPLETED
        assert res.tool_calls_made == 1
        assert "超时" in (llm.last_tool_content or "")


class TestUnsafeE2E:
    """unsafe 能力门控端到端：关闭拦截、开启放行、delegate_task 永禁。"""

    @pytest.mark.asyncio
    async def test_unsafe_off_blocks_high_tool_execution(self, monkeypatch):
        monkeypatch.delenv("AGENT_SUBAGENT_UNSAFE", raising=False)
        shell_calls = []

        async def shell_exec(_p=None):
            shell_calls.append(1)
            return ToolResult(success=True, output="PWNED")

        async def file_read(_p=None):
            return ToolResult(success=True, output="data")

        reg = _build_registry([
            ("file_read", ToolCategory.FILE, "low", file_read),
            ("shell_exec", ToolCategory.CODE, "high", shell_exec),
        ])
        llm = _ScriptedLLM([
            {"content": "", "tool_calls": [_tc("t1", "shell_exec")]},
            {"content": "FINAL", "tool_calls": None},
        ])
        d = SubAgentDelegator()
        d.set_registry(reg)
        d.set_llm(llm)
        res = await d.delegate(
            "x", allowed_tools={"file_read", "shell_exec"}, unsafe=False
        )
        assert res.tool_calls_made == 1
        assert shell_calls == [], "unsafe 关闭时高危工具不应执行"

    @pytest.mark.asyncio
    async def test_unsafe_on_allows_high_tool_execution(self, monkeypatch):
        monkeypatch.setenv("AGENT_SUBAGENT_UNSAFE", "1")
        shell_calls = []

        async def shell_exec(_p=None):
            shell_calls.append(1)
            return ToolResult(success=True, output="PWNED")

        async def file_read(_p=None):
            return ToolResult(success=True, output="data")

        reg = _build_registry([
            ("file_read", ToolCategory.FILE, "low", file_read),
            ("shell_exec", ToolCategory.CODE, "high", shell_exec),
        ])
        llm = _ScriptedLLM([
            {"content": "", "tool_calls": [_tc("t1", "shell_exec")]},
            {"content": "FINAL", "tool_calls": None},
        ])
        d = SubAgentDelegator()
        d.set_registry(reg)
        d.set_llm(llm)
        res = await d.delegate(
            "x", allowed_tools={"file_read", "shell_exec"}, unsafe=True
        )
        assert res.tool_calls_made == 1
        assert shell_calls == [1], "unsafe 开启时应执行高危工具"
