"""四大功能补齐建议的端到端验证。

覆盖：
  ② 知识沉淀 — 主动从失败学习闭环（FailureLearner）
  ③ 安全沙箱 — 高风险动作预检 + 人工审批（RiskPrecheck）+ 规划器联动
  ④ MCP 生态 — 动态工具发现 → LLM 选择 → 执行（MCPToolOrchestrator）

约定：现有测试套件以同步用例为主，故异步逻辑统一通过 ``asyncio.run`` 调用，
避免对 pytest-asyncio 配置的依赖。
"""
from __future__ import annotations

import asyncio
import os
import tempfile
import uuid

from agent.loop.types import ExecutionPlan, PlanStep
from agent.loop.planner import Planner
from agent.tools.registry import ToolRegistry, ToolDefinition, ToolParameterDef, ToolResult
from agent.tools.approval_manager import ApprovalManager
from agent.security.runtime_posture import RuntimePosture
from agent.safety.risk_precheck import RiskPrecheck, plan_to_approval_requests
from agent.knowledge.knowledge_lifecycle import KnowledgeLifecycle
from agent.knowledge.failure_learner import FailureLearner
from agent.mcp.orchestrator import (
    MCPToolOrchestrator,
    RuleBasedSelector,
    LlmToolSelector,
    ToolExecutionResult,
)
from agent.tools.mcp_tool_bridge import MCPToolBridge
from types import SimpleNamespace


# --------------------------------------------------------------------------- #
# ③ 安全沙箱：高风险动作预检 + 人工审批 + 规划器联动
# --------------------------------------------------------------------------- #
def _make_security_registry():
    reg = ToolRegistry()
    calls: list[str] = []

    def mk(name: str, risk: str) -> None:
        d = ToolDefinition(
            name=name, description=name, risk_level=risk, parameters=[], tags=["smoke"],
        )

        async def executor(params):
            calls.append(name)
            return ToolResult(success=True, output=f"ok:{name}")

        reg.register(d, executor)

    mk("read_file", "low")
    mk("shell_exec", "high")
    mk("fs_delete", "critical")
    return reg, calls


def test_risk_precheck_low_passes_without_approval():
    async def impl():
        reg, calls = _make_security_registry()
        rp = RiskPrecheck(reg)  # 未接审批管理器
        assert rp.requires_approval("read_file") is False
        assert rp.requires_approval("fs_delete") is True
        # 无审批管理器时，低风险与高风险均直通执行
        res = await rp.execute("read_file", {})
        assert res.success
        assert "read_file" in calls

    asyncio.run(impl())


def test_risk_precheck_high_auto_approved():
    async def impl():
        reg, calls = _make_security_registry()
        am = ApprovalManager(auto_approve_all=True)
        rp = RiskPrecheck(reg, am)
        res = await rp.execute("shell_exec", {"cmd": "ls"})
        assert res.success, res.error
        assert "shell_exec" in calls  # 高风险的自动批准应真正执行

    asyncio.run(impl())


def test_risk_precheck_critical_blocked_under_safe():
    async def impl():
        reg, calls = _make_security_registry()
        am = ApprovalManager(posture=RuntimePosture.SAFE)
        rp = RiskPrecheck(reg, am)
        res = await rp.execute("fs_delete", {"path": "/etc/passwd"})
        assert res.success is False
        assert res.metadata.get("blocked_by") == "approval"
        assert "fs_delete" not in calls  # 被拦截，未真正执行

    asyncio.run(impl())


def test_risk_precheck_annotate_plan_links_planner():
    async def impl():
        reg, _ = _make_security_registry()
        rp = RiskPrecheck(reg)
        plan = ExecutionPlan(steps=[PlanStep(step_id="s1", description="d", tool_name="fs_delete")])
        rp.annotate_plan(plan)
        assert plan.steps[0].risk_level == "critical"  # 规划器联动标注

    asyncio.run(impl())


# --------------------------------------------------------------------------- #
# ② 知识沉淀：主动从失败学习闭环
# --------------------------------------------------------------------------- #
def test_failure_learner_closed_loop():
    async def impl():
        db_path = os.path.join(tempfile.gettempdir(), f"kb_failure_{uuid.uuid4().hex}.db")
        lc = KnowledgeLifecycle(db_path=db_path)
        await lc.initialize()
        try:
            learner = FailureLearner(knowledge_lifecycle=lc)
            rec = await learner.learn_from_failure(
                action="fs_delete",
                error="权限不足：无法删除受保护文件 /etc/passwd",
                task="删除 /etc/passwd",
            )
            # 失败经验已写入纠正知识
            assert rec.knowledge_ids, "失败经验应写入知识库"

            # 闭环：后续规划注入历史失败经验，主动规避
            prompt = await learner.build_injection_prompt("删除 /etc/passwd")
            assert "失败经验" in prompt
            assert "权限不足" in prompt or "fs_delete" in prompt
        finally:
            try:
                await lc.close()
            except Exception:
                pass

    asyncio.run(impl())


# --------------------------------------------------------------------------- #
# ④ MCP 生态：动态工具发现 → LLM 选择 → 执行
# --------------------------------------------------------------------------- #
class _FakeMCPServerManager:
    """离线 MCP 提供方：无需真实子进程即可验证发现→选择→执行链路。"""

    def __init__(self):
        self._tools = [
            {"name": "fs_search", "description": "在文件系统中搜索文件", "inputSchema": {}},
            {"name": "web_fetch", "description": "抓取指定网页内容", "inputSchema": {}},
        ]

    def register_server(self, config):
        return None

    def get_running_servers(self):
        return ["fake_server"]

    def list_tools(self, server_name):
        return self._tools

    async def call_tool(self, server_name, tool_name, arguments):
        return ToolResult(success=True, output=f"result_of_{tool_name}")


def test_mcp_discover_select_execute_e2e():
    async def impl():
        reg = ToolRegistry()
        fake = _FakeMCPServerManager()
        orch = MCPToolOrchestrator(fake, reg)

        # 1) 动态工具发现：注册并桥接到注册中心
        from types import SimpleNamespace

        count = await orch.discover(SimpleNamespace(name="fake_server"))
        assert count == 2
        mcp_tools = [t for t in reg.get_all_definitions() if t.name.startswith("mcp_")]
        assert len(mcp_tools) == 2

        # 2) LLM 选择（离线 RuleBasedSelector 替代 V4 Flash function calling）
        results: list[ToolExecutionResult] = await orch.select_and_execute(
            "搜索文件系统中体积最大的文件", RuleBasedSelector(), only_mcp=True,
        )
        assert results, "应至少选中一个工具"
        assert any(r.tool_name.endswith("fs_search") for r in results)
        assert all(r.success for r in results)

    asyncio.run(impl())


# --------------------------------------------------------------------------- #
# ③ 规划器按风险拆分「需审批/可自动」步骤 + 前端确认 UI 适配
# --------------------------------------------------------------------------- #
def test_planner_annotates_risk_and_splits_approval():
    """Planner 在生成阶段即为每一步标注 risk_level 与 requires_approval。"""
    reg, _ = _make_security_registry()
    planner = Planner(llm=SimpleNamespace(), tool_registry=reg)
    steps = [
        PlanStep(step_id="s1", description="读取", tool_name="read_file"),
        PlanStep(step_id="s2", description="执行命令", tool_name="shell_exec"),
        PlanStep(step_id="s3", description="删除", tool_name="fs_delete"),
        PlanStep(step_id="s4", description="直接回答", tool_name=None),
    ]
    annotated = planner._annotate_risk(steps)
    assert annotated[0].risk_level == "low" and annotated[0].requires_approval is False
    assert annotated[1].risk_level == "high" and annotated[1].requires_approval is True
    assert annotated[2].risk_level == "critical" and annotated[2].requires_approval is True
    assert annotated[3].requires_approval is False  # 无工具名不触发审批

    plan = ExecutionPlan(steps=annotated)
    pending = plan.pending_approval_steps()
    assert {s.tool_name for s in pending} == {"shell_exec", "fs_delete"}


def test_plan_to_approval_requests_shape():
    """计划待审批步骤转换为前端 ApprovalDialog 所需请求结构。"""
    plan = ExecutionPlan(
        steps=[
            PlanStep(step_id="s1", description="d", tool_name="read_file", risk_level="low", requires_approval=False),
            PlanStep(step_id="s2", description="d", tool_name="shell_exec", risk_level="high", requires_approval=True, tool_params={"cmd": "ls"}),
            PlanStep(step_id="s3", description="d", tool_name="fs_delete", risk_level="critical", requires_approval=True, tool_params={"path": "/x"}),
        ]
    )
    reqs = plan_to_approval_requests(plan)
    assert len(reqs) == 2
    assert {r["toolName"] for r in reqs} == {"shell_exec", "fs_delete"}
    assert all(r["status"] == "pending" for r in reqs)
    assert all(set(r.keys()) == {"id", "toolName", "params", "riskLevel", "timestamp", "status"} for r in reqs)


# --------------------------------------------------------------------------- #
# ④ 真实 LLM 工具选择器（V4 Flash Function Calling）
# --------------------------------------------------------------------------- #
def test_llm_tool_selector_parses_function_calls():
    async def impl():
        class FakeLLM:
            async def chat_with_tools(self, messages, tools, tool_choice="auto"):
                # 模拟 V4 Flash 返回的结构化 tool_calls
                return {
                    "content": "",
                    "role": "assistant",
                    "finish_reason": "tool_calls",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": "web_fetch", "arguments": '{"url": "https://example.com"}'},
                        }
                    ],
                }

        reg = ToolRegistry()
        d = ToolDefinition(
            name="web_fetch",
            description="抓取网页内容",
            parameters=[ToolParameterDef(name="url", type="string", description="网页地址", required=True)],
            tags=["web"],
        )
        reg.register(d, lambda params: ToolResult(success=True, output="html"))
        selector = LlmToolSelector(FakeLLM())
        calls = await selector.select("帮我抓取 https://example.com 的内容", reg.get_all_definitions())
        assert len(calls) == 1
        assert calls[0].tool_name == "web_fetch"
        assert calls[0].params == {"url": "https://example.com"}

    asyncio.run(impl())


# --------------------------------------------------------------------------- #
# ② 同错重复率指标：量化主动学习效率
# --------------------------------------------------------------------------- #
def test_failure_learner_recurrence_metric():
    async def impl():
        db_path = os.path.join(tempfile.gettempdir(), f"kb_recur_{uuid.uuid4().hex}.db")
        lc = KnowledgeLifecycle(db_path=db_path)
        await lc.initialize()
        try:
            learner = FailureLearner(knowledge_lifecycle=lc)
            # 同一根因重复 3 次
            for _ in range(3):
                await learner.learn_from_failure(action="fs_delete", error="权限不足：无法删除受保护文件")
            # 另一个不同根因
            await learner.learn_from_failure(action="shell_exec", error="命令未找到：lsxx")
            metrics = learner.get_metrics()
            assert metrics["total_failures"] == 4
            assert metrics["unique_signatures"] == 2
            assert metrics["repeated_failures"] == 2
            assert metrics["recurrence_rate"] == 0.5
            assert metrics["top_repeated_errors"][0]["count"] == 3
        finally:
            try:
                await lc.close()
            except Exception:
                pass

    asyncio.run(impl())


def test_approval_preview_reuse_at_execution():
    """规划阶段推送的待审批预览，执行阶段被 request_approval 复用（预览一次即放行）。"""
    async def impl():
        am = ApprovalManager()  # CONFIRM 姿态：人工介入
        plan = ExecutionPlan(
            steps=[
                PlanStep(step_id="s1", description="执行命令", tool_name="shell_exec", risk_level="high", requires_approval=True, tool_params={"cmd": "ls"}),
            ]
        )
        ids = await am.preview_plan_approvals(plan)
        assert len(ids) == 1
        preview_id = ids[0]
        assert am.pending_count() == 1  # 前端确认 UI 现在能看到待审批项

        async def do_request():
            return await am.request_approval("shell_exec", {"cmd": "ls"}, risk_level="high")

        task = asyncio.create_task(do_request())
        await asyncio.sleep(0.05)  # 让 request_approval 进入等待
        assert am.respond(preview_id, True) is True  # 用户在预览请求上点批准
        resp = await task
        assert resp.approved is True
        assert am.pending_count() == 0

    asyncio.run(impl())
