"""P2-6 专项测试：子 Agent 工具下放 + 独立 ReAct 循环。

覆盖：
1. 子 Agent 能执行白名单内工具并经多轮 ReAct 给出最终答案；
2. 非白名单（高危）工具被拒绝执行，绝不越权；
3. max_iterations 上限生效，防止无限循环；
4. 无注册表时回退裸 LLM（零回归）；
5. 默认安全白名单确实排除高危工具。
"""

import asyncio

import pytest

from agent.tools.delegate_tool import (
    DEFAULT_SUBAGENT_MAX_ITERATIONS,
    DelegateRole,
    DelegateStatus,
    SubAgentDelegator,
    SUBAGENT_SAFE_TOOLS,
)
from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolRegistry,
    ToolResult,
)


class FakeLLM:
    """脚本化 LLM：按预置响应序列返回，并记录每次 chat 调用的入参。"""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    async def chat(self, messages, tools=None, use_cache=True):
        self.calls.append({"messages": messages, "tools": tools})
        if self._responses:
            return self._responses.pop(0)
        return {"content": "(fallback)", "tool_calls": None, "finish_reason": "stop"}


def _fake_def(name, category=ToolCategory.FILE, risk="low"):
    return ToolDefinition(
        name=name,
        description=f"fake {name}",
        short_desc=name,
        category=category,
        parameters=[ToolParameterDef(name="x", type="string", required=False, description="arg")],
        risk_level=risk,
    )


def _executor_factory(log, marker):
    async def _exec(params=None):
        log.append(marker)
        return ToolResult(success=True, output=f"result-of-{marker}")
    return _exec


def _build_parent_registry():
    """构造一个含白名单工具 + 高危工具的父注册表。"""
    reg = ToolRegistry()
    log = []

    # 白名单内（file_read）
    reg.register(_fake_def("file_read", ToolCategory.FILE), _executor_factory(log, "file_read"))
    # 白名单内（web_search）
    reg.register(_fake_def("web_search", ToolCategory.NETWORK), _executor_factory(log, "web_search"))
    # 高危：绝不应被下放执行（使用真实风险级，验证元数据派生白名单能正确排除）
    reg.register(_fake_def("shell_exec", ToolCategory.SYSTEM, "high"), _executor_factory(log, "shell_exec"))
    reg.register(_fake_def("file_edit", ToolCategory.FILE, "high"), _executor_factory(log, "file_edit"))
    reg.register(
        _fake_def("delegate_task", ToolCategory.COGNITION, "medium"),
        _executor_factory(log, "delegate_task"),
    )
    return reg, log


def _tool_call(name, args=None, call_id="call_1"):
    return {
        "id": call_id,
        "function": {"name": name, "arguments": __import__("json").dumps(args or {})},
    }


# ───────────────────────── 1. 正常 ReAct 流程 ─────────────────────────

async def test_subagent_executes_whitelisted_tool_and_returns_final():
    parent, exec_log = _build_parent_registry()
    llm = FakeLLM([
        {
            "content": "",
            "tool_calls": [_tool_call("file_read", {"x": "/tmp/a.txt"})],
            "finish_reason": "tool_calls",
        },
        {
            "content": "文件内容是 result-of-file_read，任务完成。",
            "tool_calls": None,
            "finish_reason": "stop",
        },
    ])

    d = SubAgentDelegator(role=DelegateRole.ORCHESTRATOR, spawn_depth=0)
    d.set_llm(llm)
    d.set_registry(parent)

    result = await d.delegate(task_description="读取 /tmp/a.txt 并总结", context="", timeout=30)

    assert result.status == DelegateStatus.COMPLETED
    assert result.tool_calls_made == 1
    assert result.rounds_used == 2
    assert "result-of-file_read" in result.result_text
    # 仅白名单工具被执行；高危工具未触碰
    assert exec_log == ["file_read"]
    # LLM 两轮都被传入工具 schema（首轮有工具，第二轮已无 tool_calls 也应能看到 schema 参数）
    assert len(llm.calls) == 2


# ───────────────────────── 2. 拒绝高危工具 ─────────────────────────

async def test_subagent_rejects_non_whitelisted_tool():
    parent, exec_log = _build_parent_registry()
    # LLM 试图调用高危 shell_exec，但子注册表不含它
    llm = FakeLLM([
        {
            "content": "",
            "tool_calls": [_tool_call("shell_exec", {"x": "rm -rf /"})],
            "finish_reason": "tool_calls",
        },
        {
            "content": "我无法执行该工具，已完成。",
            "tool_calls": None,
            "finish_reason": "stop",
        },
    ])

    d = SubAgentDelegator(role=DelegateRole.ORCHESTRATOR, spawn_depth=0)
    d.set_llm(llm)
    d.set_registry(parent)

    result = await d.delegate(task_description="危险任务", timeout=30)

    assert result.status == DelegateStatus.COMPLETED
    # 关键：高危 executor 绝未被执行
    assert "shell_exec" not in exec_log
    assert "file_edit" not in exec_log
    assert "delegate_task" not in exec_log
    # 子注册表对未授权工具返回 not found，但循环仍可继续产出最终答案
    assert "无法执行" in result.result_text or "完成" in result.result_text


# ───────────────────────── 3. max_iterations 上限 ─────────────────────────

async def test_subagent_max_iterations_cap():
    parent, _ = _build_parent_registry()
    # LLM 永远只产 file_read 工具调用 → 必须被 max_iterations 截断
    llm = FakeLLM([
        {"content": "", "tool_calls": [_tool_call("file_read", {})], "finish_reason": "tool_calls"}
        for _ in range(10)
    ])

    d = SubAgentDelegator(role=DelegateRole.ORCHESTRATOR, spawn_depth=0)
    d.set_llm(llm)
    d.set_registry(parent)

    cap = 3
    result = await d.delegate(task_description="循环任务", timeout=30, max_iterations=cap)

    assert result.rounds_used == cap
    assert result.tool_calls_made == cap
    # 达到上限后给出兜底文本而非崩溃
    assert result.result_text


# ───────────────────────── 4. 裸 LLM 回退（无注册表） ─────────────────────────

async def test_subagent_bare_llm_fallback_without_registry():
    llm = FakeLLM([
        {"content": "裸 LLM 直接回答", "tool_calls": None, "finish_reason": "stop"},
    ])

    d = SubAgentDelegator(role=DelegateRole.ORCHESTRATOR, spawn_depth=0)
    d.set_llm(llm)
    # 不设置 registry → 走裸 LLM 分支

    result = await d.delegate(task_description="简单问题", timeout=30)

    assert result.status == DelegateStatus.COMPLETED
    assert result.tool_calls_made == 0
    assert result.rounds_used == 0
    assert "裸 LLM" in result.result_text


# ───────────────────────── 5. 白名单默认排除高危 ─────────────────────────

def test_default_whitelist_excludes_dangerous_tools():
    dangerous = {
        "shell_exec", "code_execution", "file_edit", "incremental_edit",
        "multi_file_edit", "code_edit_ast", "git_commit", "delegate_task",
        "desktop_automate", "browser_agent", "image_generate", "message_push",
        "ha_control", "cronjob_create", "kanban_spawn", "memory_store",
    }
    assert dangerous.isdisjoint(SUBAGENT_SAFE_TOOLS)


def test_build_sub_registry_only_whitelisted():
    parent, _ = _build_parent_registry()
    d = SubAgentDelegator()
    d.set_registry(parent)
    sub = d._build_sub_registry(set(SUBAGENT_SAFE_TOOLS))

    assert sub.get("file_read") is not None
    assert sub.get("web_search") is not None
    # 高危工具不存在于子注册表
    assert sub.get("shell_exec") is None
    assert sub.get("file_edit") is None
    assert sub.get("delegate_task") is None
    assert sub.size() == 2  # 仅 file_read + web_search 命中白名单


def test_explicit_whitelist_override():
    parent, _ = _build_parent_registry()
    d = SubAgentDelegator()
    d.set_registry(parent)
    # 显式只下放 web_search
    sub = d._build_sub_registry({"web_search"})
    assert sub.size() == 1
    assert sub.get("web_search") is not None
    assert sub.get("file_read") is None


if __name__ == "__main__":
    asyncio.run(test_subagent_executes_whitelisted_tool_and_returns_final())
    print("smoke ok")
