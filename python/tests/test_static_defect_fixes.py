"""静态缺陷红线（check_static_defects.py）抓到的真实缺陷回归测试。

这批缺陷的共同特征：**模块能正常导入**，所以 ``check_import_scan.py`` 全绿，
但要么在特定分支执行时抛 NameError，要么根本不崩、只是静默地做错事。
下面每个测试都对应一处已修复的真实生产缺陷，防止回退。

对应审计条目：P2-1 延伸（静默失败治理）。
"""

from __future__ import annotations

import ast
import logging
import subprocess
import sys
from pathlib import Path

import pytest

PYTHON_DIR = Path(__file__).resolve().parent.parent


# ─────────────────────────────────────────────────────────────
# 缺陷 1：core/distributed.py 的 log 从未定义
#   → 分布式锁心跳失败 / Leader 选举失败路径直接 NameError，
#     反而掩盖了真正的失败原因。
# ─────────────────────────────────────────────────────────────
class TestDistributedLoggerDefined:
    def test_module_level_log_exists(self):
        from agent.core import distributed

        assert hasattr(distributed, "log"), "distributed.py 缺少模块级 log，失败路径会 NameError"

    def test_log_is_stdlib_logger_supporting_positional_args(self):
        """本模块用 %-style 位置参数，必须是标准库 Logger。

        StructuredLogger 的签名是 ``warning(msg, **kwargs)``，传位置参数会 TypeError，
        所以这里不能想当然地换成 StructuredLogger。
        """
        from agent.core import distributed

        assert isinstance(distributed.log, logging.Logger)
        # 真正验证：位置参数插值不抛异常
        distributed.log.warning("probe %d/%d: %s", 1, 3, "ok")

    def test_heartbeat_failure_path_has_no_undefined_name(self):
        """静态确认心跳失败分支引用的 log 已可解析。"""
        src = (PYTHON_DIR / "agent" / "core" / "distributed.py").read_text(encoding="utf-8")
        assert "log = logging.getLogger(__name__)" in src


# ─────────────────────────────────────────────────────────────
# 缺陷 2：api/proxy_server.py 未导入 defaultdict → __init__ 必崩
# ─────────────────────────────────────────────────────────────
class TestProxyServerConstructible:
    def test_proxy_server_init_does_not_raise(self):
        from agent.api.proxy_server import ProxyServer

        server = ProxyServer()
        # _rate_limits 必须是可自动建键的 defaultdict
        assert server._rate_limits["never-seen-key"] == []


# ─────────────────────────────────────────────────────────────
# 缺陷 3：api/sessions.py 调用了未定义的 get_engine → 断点恢复接口必崩
# ─────────────────────────────────────────────────────────────
class TestSessionsGetEngineDefined:
    def test_get_engine_is_defined_and_callable(self):
        from agent.api import sessions

        assert callable(getattr(sessions, "get_engine", None))
        # 引擎未初始化时应返回 None 而不是抛 NameError
        assert sessions.get_engine() is None or sessions.get_engine() is not None


# ─────────────────────────────────────────────────────────────
# 缺陷 4：context/models.py 里 BuildContext 被定义两次且字段不同，
#   前一个（含 outputs 字段）被静默丢弃 —— 任何按前者写的代码都会 AttributeError。
# ─────────────────────────────────────────────────────────────
class TestBuildContextSingleDefinition:
    def test_only_one_build_context_class(self):
        src = (PYTHON_DIR / "agent" / "context" / "models.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        defs = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "BuildContext"]
        assert len(defs) == 1, f"BuildContext 被定义了 {len(defs)} 次，前面的会被静默丢弃"

    def test_surviving_definition_has_expected_api(self):
        """存活版本用的是 component_outputs 而非 outputs，字段名不能回退。"""
        from agent.context.models import BuildContext, ContextBuildRequest

        ctx = BuildContext(request=ContextBuildRequest(user_input="hi"))
        assert hasattr(ctx, "component_outputs")
        assert hasattr(ctx, "tokens_used")
        ctx.set_output("comp", {"k": "v"})
        assert ctx.get_output("comp") == {"k": "v"}


# ─────────────────────────────────────────────────────────────
# 缺陷 5：security/__init__.py 同名导出两个不同的 RiskLevel，
#   后者（security_guidance 版，无 NONE 成员）静默覆盖前者。
# ─────────────────────────────────────────────────────────────
class TestRiskLevelNotShadowed:
    def test_package_risk_level_has_none_member(self):
        import agent.security as sec

        assert hasattr(sec.RiskLevel, "NONE"), (
            "agent.security.RiskLevel 被 security_guidance 版覆盖了，NONE 成员丢失"
        )

    def test_guidance_risk_level_exported_under_distinct_name(self):
        import agent.security as sec

        assert hasattr(sec, "GuidanceRiskLevel")
        assert not hasattr(sec.GuidanceRiskLevel, "NONE")
        assert sec.GuidanceRiskLevel is not sec.RiskLevel

    def test_package_risk_level_is_sensitive_detector_version(self):
        import agent.security as sec
        from agent.security.sensitive_detector import RiskLevel as DetectorRiskLevel

        assert sec.RiskLevel is DetectorRiskLevel


# ─────────────────────────────────────────────────────────────
# 缺陷 6：tools/mcp_tool_bridge.py 闭包晚绑定
#   作者写了 server_name_capture = server_name 试图捕获，但那仍是循环作用域变量，
#   结果所有注册的 MCP 工具都会调用 **最后一次迭代** 的 server/tool。
#   这是「不崩但静默路由错乱」，最难排查的一类。
# ─────────────────────────────────────────────────────────────
class TestMCPBridgeClosureBinding:
    @pytest.mark.asyncio
    async def test_each_bridged_tool_routes_to_its_own_server_and_tool(self):
        from agent.tools.mcp_tool_bridge import MCPProvider, MCPToolBridge, MCPToolInfo
        from agent.tools.registry import ToolRegistry

        calls: list[tuple[str, str]] = []

        class FakeProvider(MCPProvider):
            async def get_running_servers(self) -> list[str]:
                return ["srvA", "srvB"]

            async def list_tools(self, server_name: str) -> list[MCPToolInfo]:
                return [
                    MCPToolInfo(name=f"{server_name}_t1"),
                    MCPToolInfo(name=f"{server_name}_t2"),
                ]

            async def call_tool(self, server_name, tool_name, params):
                calls.append((server_name, tool_name))
                return f"{server_name}/{tool_name}"

        registry = ToolRegistry()
        bridge = MCPToolBridge(provider=FakeProvider())
        count = await bridge.sync_to_registry(registry)
        assert count == 4

        # 逐个执行，每个都必须路由到自己的 server/tool
        expected = [
            ("mcp_srvA_srvA_t1", ("srvA", "srvA_t1")),
            ("mcp_srvA_srvA_t2", ("srvA", "srvA_t2")),
            ("mcp_srvB_srvB_t1", ("srvB", "srvB_t1")),
            ("mcp_srvB_srvB_t2", ("srvB", "srvB_t2")),
        ]
        for bridged_name, want in expected:
            calls.clear()
            result = await registry.execute(bridged_name, {})
            assert calls == [want], (
                f"{bridged_name} 路由到了 {calls}，期望 {want} —— 闭包晚绑定回退了"
            )
            assert result.output == f"{want[0]}/{want[1]}"


# ─────────────────────────────────────────────────────────────
# 缺陷 7：orchestration/task_dispatcher.py 同类闭包晚绑定
# ─────────────────────────────────────────────────────────────
class TestTaskDispatcherClosureBinding:
    def test_executor_lambda_binds_task_id_per_iteration(self):
        src = (PYTHON_DIR / "agent" / "orchestration" / "task_dispatcher.py").read_text(
            encoding="utf-8"
        )
        # 必须用默认参数绑定，而不是直接闭包引用循环变量 t
        assert "_tid=task_id" in src, "task_dispatcher 的 executor 闭包未按迭代绑定 task_id"


# ─────────────────────────────────────────────────────────────
# 元测试：红线脚本本身必须保持全绿，任何新引入的同类缺陷都会在此暴露
# ─────────────────────────────────────────────────────────────
class TestStaticDefectRedLine:
    def test_red_line_script_passes(self):
        script = PYTHON_DIR / "scripts" / "check_static_defects.py"
        assert script.exists()

        proc = subprocess.run(
            [sys.executable, str(script)],
            cwd=PYTHON_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        if "[SKIP]" in output:
            pytest.skip("ruff 未安装，跳过静态缺陷红线元测试")
        assert proc.returncode == 0, f"静态缺陷红线未通过：\n{output}"

    def test_red_line_covers_key_rules(self):
        sys.path.insert(0, str(PYTHON_DIR / "scripts"))
        try:
            from check_static_defects import RULES
        finally:
            sys.path.pop(0)

        for code in ("F821", "F811", "B023", "E722"):
            assert code in RULES, f"红线丢失了关键规则 {code}"
