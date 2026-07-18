"""插件信任策略（Plugin Trust Policy）。

堵住"插件侧提示注入"这一高危面：不受信插件不能拿全量上下文、不能触发敏感工具、
不能发起 LLM 调用。对标 Hermes 的 _TrustPolicy / PluginLlmTrustError。

信任模型直接复用 A2A 的 TrustLevel（UNTRUSTED/LOW/MEDIUM/HIGH），不另造一套
（符合 AGENTS.md §0.1，统一信任语义）。

三条受控路径：
    1. LLM 调用      —— 需 >= LOW
    2. 工具调用      —— 按 (信任等级 × 工具风险) 矩阵放行；critical 永不放行（硬底线）
    3. 上下文获取    —— UNTRUSTED=none / LOW,MEDIUM=scoped / HIGH=full

违规一律抛 PluginTrustError，由调用方转成拒绝 + 审计。
"""

from __future__ import annotations

import os
from enum import Enum

from agent.a2a.protocol import TrustLevel
from agent.core.logger import StructuredLogger

log = StructuredLogger("plugin_trust")

#: 操作员可通过该环境变量预声明受信插件（无需改代码即可端到端激活）。
#: 格式："pluginA:high,pluginB:medium"；未列出的插件仍默认 UNTRUSTED。
PLUGIN_TRUST_ENV = "AGENT_PLUGIN_TRUST"


class PluginTrustError(PermissionError):
    """插件越权时抛出：越过其信任等级允许的能力边界。"""


class ContextScope(str, Enum):
    """插件可获取的上下文范围。"""

    NONE = "none"      # 不给任何对话上下文
    SCOPED = "scoped"  # 仅给脱敏/裁剪后的受限上下文
    FULL = "full"      # 全量上下文


#: 信任等级从低到高的序（用于比较）。
_TRUST_ORDER: dict[TrustLevel, int] = {
    TrustLevel.UNTRUSTED: 0,
    TrustLevel.LOW: 1,
    TrustLevel.MEDIUM: 2,
    TrustLevel.HIGH: 3,
}

#: 工具风险从低到高的序。
_RISK_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2, "critical": 3}

#: 各信任等级允许的最高工具风险（critical 不在任何等级内 —— 硬底线）。
_MAX_TOOL_RISK: dict[TrustLevel, int] = {
    TrustLevel.UNTRUSTED: -1,  # 不允许任何工具
    TrustLevel.LOW: _RISK_ORDER["low"],
    TrustLevel.MEDIUM: _RISK_ORDER["medium"],
    TrustLevel.HIGH: _RISK_ORDER["high"],
}

#: LLM 调用所需最低信任等级。
_MIN_TRUST_FOR_LLM = TrustLevel.LOW

#: 各信任等级允许的最大上下文范围。
_CONTEXT_SCOPE: dict[TrustLevel, ContextScope] = {
    TrustLevel.UNTRUSTED: ContextScope.NONE,
    TrustLevel.LOW: ContextScope.SCOPED,
    TrustLevel.MEDIUM: ContextScope.SCOPED,
    TrustLevel.HIGH: ContextScope.FULL,
}


def _normalize_risk(risk_level: str | None) -> str:
    if not risk_level:
        return "high"
    v = str(risk_level).strip().lower()
    return v if v in _RISK_ORDER else "high"


def parse_trust_level(value: str | None, default: TrustLevel = TrustLevel.UNTRUSTED) -> TrustLevel:
    """把字符串解析成 TrustLevel；无法识别时返回 default（安全默认最低）。"""
    if not value:
        return default
    v = str(value).strip().lower()
    for level in TrustLevel:
        if level.value == v:
            return level
    return default


def can_call_llm(level: TrustLevel) -> bool:
    """该信任等级是否可发起 LLM 调用。"""
    return _TRUST_ORDER[level] >= _TRUST_ORDER[_MIN_TRUST_FOR_LLM]


def can_call_tool(level: TrustLevel, risk_level: str | None) -> bool:
    """该信任等级是否可调用给定风险的工具。critical 永远返回 False。"""
    risk = _normalize_risk(risk_level)
    if risk == "critical":
        return False
    return _RISK_ORDER[risk] <= _MAX_TOOL_RISK[level]


def allowed_context_scope(level: TrustLevel) -> ContextScope:
    """该信任等级允许的最大上下文范围。"""
    return _CONTEXT_SCOPE[level]


class PluginTrustPolicy:
    """插件信任策略：维护每个插件的信任等级并对三条路径做 gate。

    新插件默认 UNTRUSTED（最低 tier），必须显式提升才能获得能力。

    Usage:
        policy = PluginTrustPolicy()
        policy.set_trust("my_plugin", TrustLevel.MEDIUM)
        policy.guard_llm("my_plugin")                      # 不满足则抛 PluginTrustError
        policy.guard_tool("my_plugin", "shell_exec", "high")
        scope = policy.guard_context("my_plugin")          # 返回允许的 ContextScope
    """

    def __init__(self, default_level: TrustLevel = TrustLevel.UNTRUSTED) -> None:
        self._default = default_level
        self._levels: dict[str, TrustLevel] = {}

    @classmethod
    def from_env(
        cls, env_var: str = PLUGIN_TRUST_ENV, default_level: TrustLevel = TrustLevel.UNTRUSTED
    ) -> "PluginTrustPolicy":
        """从环境变量构建策略，预声明受信插件（无需改代码即可激活）。

        环境变量格式："pluginA:high,pluginB:medium"。每项 name:level，非法项跳过；
        未列出的插件仍走 default_level（默认 UNTRUSTED）。

        Args:
            env_var: 环境变量名，默认 ``AGENT_PLUGIN_TRUST``。
            default_level: 未列出插件的默认信任等级。

        Returns:
            PluginTrustPolicy: 预置了受信插件的策略实例。
        """
        policy = cls(default_level=default_level)
        raw = os.environ.get(env_var, "")
        for item in raw.split(","):
            item = item.strip()
            if not item or ":" not in item:
                continue
            name, _, level_str = item.partition(":")
            name = name.strip()
            if not name:
                continue
            level = parse_trust_level(level_str, default=default_level)
            policy._levels[name] = level
            log.info("插件信任等级（来自环境变量）", plugin=name, level=level.value)
        return policy

    def register_default(self, name: str) -> None:
        """为新插件登记默认（最低）信任等级；已存在则不覆盖。"""
        self._levels.setdefault(name, self._default)

    def set_trust(self, name: str, level: TrustLevel) -> None:
        self._levels[name] = level
        log.info("插件信任等级已设置", plugin=name, level=level.value)

    def get_trust(self, name: str) -> TrustLevel:
        return self._levels.get(name, self._default)

    def guard_llm(self, name: str) -> None:
        level = self.get_trust(name)
        if not can_call_llm(level):
            log.warning("插件 LLM 调用被拒", plugin=name, level=level.value)
            raise PluginTrustError(
                f"插件 {name}（信任等级 {level.value}）无权发起 LLM 调用，需 >= {_MIN_TRUST_FOR_LLM.value}"
            )

    def guard_tool(self, name: str, tool_name: str, risk_level: str) -> None:
        level = self.get_trust(name)
        if not can_call_tool(level, risk_level):
            log.warning(
                "插件工具调用被拒", plugin=name, tool=tool_name,
                risk=risk_level, level=level.value,
            )
            raise PluginTrustError(
                f"插件 {name}（信任等级 {level.value}）无权调用 {risk_level} 风险工具 {tool_name}"
            )

    def guard_context(self, name: str) -> ContextScope:
        """返回该插件允许的上下文范围；UNTRUSTED 抛错（完全无上下文）。"""
        level = self.get_trust(name)
        scope = allowed_context_scope(level)
        if scope is ContextScope.NONE:
            log.warning("插件上下文获取被拒", plugin=name, level=level.value)
            raise PluginTrustError(
                f"插件 {name}（信任等级 {level.value}）无权获取任何对话上下文"
            )
        return scope

    def list_plugins(self) -> list[str]:
        """返回当前已知插件名（按字母序）。已知 = 已登记信任等级的插件。"""
        return sorted(self._levels.keys())


def max_allowed_tool_risk(level: TrustLevel) -> str:
    """该信任等级允许的最高工具风险（critical 永不在内）。

    Returns:
        "none" / "low" / "medium" / "high"。
    """
    order = _MAX_TOOL_RISK.get(level, -1)
    if order < 0:
        return "none"
    for risk, o in _RISK_ORDER.items():
        if o == order:
            return risk
    return "none"
