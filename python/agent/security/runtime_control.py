"""运行时安全管理控制器（R1 管理面核心）。

统一管理两类运行时安全状态，并作为"管理面（HTTP 端点）"与"运行时执行器
（ApprovalManager / PluginTrustPolicy）"之间的唯一协调者：

    R1-A 运行时姿态（RuntimePosture）
        - 支持对环境变量默认值的运行时覆盖
        - 支持紧急锁定（lockdown）：开启后所有工具调用被拒绝
    R1-B 插件信任（PluginTrustPolicy）
        - 查看/改写每个插件的信任等级

设计要点（符合 AGENTS.md §0.1 / §0.3）：
    - 写入时同时推送到真实执行器（set_posture → ApprovalManager.set_posture；
      set_lockdown → ApprovalManager.set_lockdown；set_trust → PluginTrustPolicy.set_trust），
      即"接线到具体运行时调用点"。
    - 读取时回显真实执行器状态，不做影子状态。
    - 线程安全（加锁），可被 FastAPI 多 worker 共享同一进程内的单例。
"""

from __future__ import annotations

import threading
from typing import Any

from agent.plugins.trust import (
    PluginTrustPolicy,
    TrustLevel,
    allowed_context_scope,
    can_call_llm,
    max_allowed_tool_risk,
)
from agent.security.runtime_posture import RuntimePosture, decide


class RuntimeSecurityController:
    """运行时安全管理单例控制器。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._posture_override: RuntimePosture | None = None
        self._lockdown: bool = False
        self._approval_manager: Any = None
        self._plugin_policy: PluginTrustPolicy | None = None

    # ── 接线（由 engine 在子系统就绪后调用） ──

    def attach_approval_manager(self, am: Any) -> None:
        with self._lock:
            self._approval_manager = am
            # 把当前管理态推到执行器，保证进程内一致。
            if self._lockdown:
                am.set_lockdown(True)
            elif self._posture_override is not None:
                am.set_posture(self._posture_override)

    def attach_plugin_policy(self, policy: PluginTrustPolicy) -> None:
        with self._lock:
            self._plugin_policy = policy

    # ── R1-A 运行时姿态 ──

    def default_posture(self) -> RuntimePosture:
        return RuntimePosture.from_env()

    def posture_source(self) -> str:
        with self._lock:
            if self._lockdown:
                return "lockdown"
            if self._posture_override is not None:
                return "override"
            return "env"

    def effective_posture(self) -> RuntimePosture:
        with self._lock:
            if self._lockdown:
                return RuntimePosture.SAFE
            if self._posture_override is not None:
                return self._posture_override
            return RuntimePosture.from_env()

    def set_posture(self, posture: RuntimePosture) -> None:
        with self._lock:
            self._posture_override = posture
            if self._approval_manager is not None and not self._lockdown:
                self._approval_manager.set_posture(posture)

    def decisions(self) -> dict[str, str]:
        """当前有效姿态下，各风险等级的裁决（供管理面预览）。"""
        posture = self.effective_posture()
        return {
            risk: decide(posture, risk).value
            for risk in ("low", "medium", "high", "critical")
        }

    # ── R1-A 紧急锁定 ──

    def is_lockdown(self) -> bool:
        with self._lock:
            return self._lockdown

    def set_lockdown(self, enabled: bool) -> None:
        with self._lock:
            self._lockdown = bool(enabled)
            if self._approval_manager is not None:
                self._approval_manager.set_lockdown(self._lockdown)

    def reset(self) -> None:
        """清除运行时覆盖与锁定，恢复到环境变量默认值。"""
        with self._lock:
            self._posture_override = None
            self._lockdown = False
            if self._approval_manager is not None:
                self._approval_manager.set_lockdown(False)
                self._approval_manager.set_posture(RuntimePosture.from_env())

    # ── R1-B 插件信任 ──

    def list_plugin_trust(self) -> list[dict[str, Any]]:
        with self._lock:
            policy = self._plugin_policy
        if policy is None:
            return []
        return [self._trust_entry(name, policy.get_trust(name)) for name in policy.list_plugins()]

    def _trust_entry(self, name: str, level: TrustLevel) -> dict[str, Any]:
        return {
            "plugin": name,
            "trust_level": level.value,
            "can_call_llm": can_call_llm(level),
            "context_scope": allowed_context_scope(level).value,
            "max_tool_risk": max_allowed_tool_risk(level),
        }

    def set_plugin_trust(self, plugin: str, level: TrustLevel) -> dict[str, Any]:
        with self._lock:
            policy = self._plugin_policy
        if policy is None:
            raise RuntimeError("插件信任策略尚未初始化")
        policy.set_trust(plugin, level)
        policy.register_default(plugin)
        return self._trust_entry(plugin, level)


_controller = RuntimeSecurityController()


def get_controller() -> RuntimeSecurityController:
    """返回进程内单例控制器。"""
    return _controller
