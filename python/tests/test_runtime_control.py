"""R1 管理面：RuntimeSecurityController 单元测试（无 fastapi 依赖）。

验证管理面控制器确实把写入推送到真实运行时执行器：
    - 姿态覆盖 → ApprovalManager.set_posture
    - 锁定 → ApprovalManager.set_lockdown（且 request_approval 立即拒绝）
    - 插件信任改写 → PluginTrustPolicy.set_trust
"""

import asyncio

from agent.plugins.trust import PluginTrustPolicy, TrustLevel
from agent.security.runtime_control import RuntimeSecurityController
from agent.security.runtime_posture import RuntimePosture
from agent.tools.approval_manager import ApprovalManager


class FakeApprovalManager:
    def __init__(self) -> None:
        self.posture = RuntimePosture.CONFIRM
        self.lockdown = False

    def set_posture(self, p: RuntimePosture) -> None:
        self.posture = p

    def set_lockdown(self, b: bool) -> None:
        self.lockdown = b


def test_posture_override_pushes_to_enforcer() -> None:
    am = FakeApprovalManager()
    c = RuntimeSecurityController()
    c.attach_approval_manager(am)

    # 无覆盖时回退环境变量默认（未设置 → CONFIRM）
    assert c.effective_posture() == RuntimePosture.CONFIRM
    assert c.posture_source() == "env"

    # 覆盖为 SAFE，且真实执行器被同步
    c.set_posture(RuntimePosture.SAFE)
    assert c.effective_posture() == RuntimePosture.SAFE
    assert c.posture_source() == "override"
    assert am.posture == RuntimePosture.SAFE

    # 决策预览矩阵正确
    d = c.decisions()
    assert d["low"] == "allow"
    assert d["medium"] == "deny"
    assert d["critical"] == "deny"


def test_lockdown_enforces_deny_at_runtime() -> None:
    am = ApprovalManager(auto_approve_all=True, posture=RuntimePosture.YOLO)
    c = RuntimeSecurityController()
    c.attach_approval_manager(am)

    c.set_lockdown(True)
    assert c.is_lockdown()
    assert am.lockdown is True
    # 锁定时有效姿态强制 SAFE，来源标记为 lockdown
    assert c.effective_posture() == RuntimePosture.SAFE
    assert c.posture_source() == "lockdown"

    # request_approval 在锁定下立即拒绝（不会等待 120s 超时）
    resp = asyncio.run(am.request_approval("shell_exec", {}, "critical"))
    assert resp.approved is False
    assert "锁定" in resp.reason

    # 解除后恢复正常
    c.set_lockdown(False)
    assert am.lockdown is False


def test_plugin_trust_list_and_set() -> None:
    policy = PluginTrustPolicy()
    policy.set_trust("alpha", TrustLevel.HIGH)
    c = RuntimeSecurityController()
    c.attach_plugin_policy(policy)

    items = c.list_plugin_trust()
    assert any(i["plugin"] == "alpha" and i["trust_level"] == "high" for i in items)
    # 通过控制器改写，真实策略被同步
    entry = c.set_plugin_trust("beta", TrustLevel.MEDIUM)
    assert entry["trust_level"] == "medium"
    assert entry["max_tool_risk"] == "medium"
    assert policy.get_trust("beta") == TrustLevel.MEDIUM


def test_reset_clears_overrides() -> None:
    am = FakeApprovalManager()
    c = RuntimeSecurityController()
    c.attach_approval_manager(am)
    c.set_posture(RuntimePosture.YOLO)
    assert c.posture_source() == "override"
    c.set_lockdown(True)
    assert c.posture_source() == "lockdown"

    c.reset()
    assert c.posture_source() == "env"
    assert c.is_lockdown() is False
    assert am.lockdown is False
