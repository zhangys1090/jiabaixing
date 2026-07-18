"""插件管理器，负责插件的注册、加载、卸载、启用、禁用及依赖检查。

PluginManager 维护插件注册表和状态机，驱动插件在 UNLOADED → LOADED → ENABLED →
DISABLED → LOADED 之间流转，并提供依赖解析和批量操作能力。

Usage:
    manager = PluginManager()
    manager.register_plugin(MyPlugin())
    results = await manager.load_all()
"""

from __future__ import annotations

from typing import Any

from agent.a2a.protocol import TrustLevel
from agent.core.logger import get_logger
from agent.plugins.base import Plugin, PluginInfo, PluginState
from agent.plugins.trust import (
    ContextScope,
    PluginTrustError,
    PluginTrustPolicy,
    allowed_context_scope,
    can_call_llm,
    can_call_tool,
)

logger = get_logger("plugins.manager")


class _GatedToolRegistry:
    """工具注册表代理：插件工具注册时逐个过信任 gate（guard_plugin_tool）。

    - UNTRUSTED 插件：_MAX_TOOL_RISK[UNTRUSTED] = -1 → 任何工具被拒，全不注册。
    - 受信插件：按 (信任等级 × 工具风险) 矩阵放行；critical 永不放行（硬底线）。
    - 被拒工具跳过（记录警告），不影响其它工具与插件。

    这样插件工具只有在通过信任策略后才会进入核心工具注册表，
    避免不受信插件把工具暴露给 LLM。
    """

    def __init__(self, real: Any, plugin_name: str, manager: "PluginManager") -> None:
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_plugin", plugin_name)
        object.__setattr__(self, "_manager", manager)

    def register(self, definition: Any, executor: Any) -> None:
        real = object.__getattribute__(self, "_real")
        if real is None:
            return
        plugin = object.__getattribute__(self, "_plugin")
        manager = object.__getattribute__(self, "_manager")
        tool_name = getattr(definition, "name", None) or "?"
        risk = getattr(definition, "risk_level", None) or "high"
        try:
            manager.guard_plugin_tool(plugin, tool_name, risk)
        except Exception as exc:
            logger.warning(
                "插件工具被信任策略拒绝, 跳过注册",
                plugin=plugin, tool=tool_name, risk=risk, reason=str(exc),
            )
            return
        real.register(definition, executor)

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_real"), name)


class PluginManager:
    """插件管理器，统一管理插件的注册与生命周期。

    管理器维护一个以插件名称为键的注册表，每个插件的状态由 PluginState 枚举描述。
    生命周期方法（load / unload / enable / disable）遵循严格的状态转换规则，
    非法转换将被忽略并记录警告日志。

    Attributes:
        _plugins: 已注册的插件实例映射（名称 -> 插件）。
        _states: 插件状态映射（名称 -> PluginState）。
    """

    def __init__(self, trust_policy: PluginTrustPolicy | None = None) -> None:
        """初始化插件管理器。

        Args:
            trust_policy: 插件信任策略；默认新建一个（新插件默认 UNTRUSTED）。
        """
        self._plugins: dict[str, Plugin] = {}
        self._states: dict[str, PluginState] = {}
        self._trust = trust_policy if trust_policy is not None else PluginTrustPolicy()

    def register_plugin(self, plugin: Plugin) -> None:
        """注册插件到管理器。

        若同名插件已存在则记录警告并忽略。新插件默认置为最低信任等级
        （UNTRUSTED），必须显式提升才能获得 LLM/工具/上下文能力。

        Args:
            plugin: 插件实例。
        """
        if plugin.name in self._plugins:
            logger.warning(f"Plugin already registered: {plugin.name}, skipping")
            return
        self._plugins[plugin.name] = plugin
        self._states[plugin.name] = PluginState.UNLOADED
        self._trust.register_default(plugin.name)
        logger.info(f"Plugin registered: {plugin.name} v{plugin.version}")

    # ─── 信任策略入口 ───

    @property
    def trust(self) -> PluginTrustPolicy:
        """暴露信任策略，供 CLI/HTTP 入口查询或调整。"""
        return self._trust

    def set_plugin_trust(self, name: str, level: TrustLevel) -> None:
        """设置插件信任等级。"""
        self._trust.set_trust(name, level)

    def get_plugin_trust(self, name: str) -> TrustLevel:
        """查询插件信任等级。"""
        return self._trust.get_trust(name)

    def guard_plugin_llm(self, name: str) -> None:
        """插件发起 LLM 调用前的信任 gate；越权抛 PluginTrustError。"""
        self._trust.guard_llm(name)

    def guard_plugin_tool(self, name: str, tool_name: str, risk_level: str) -> None:
        """插件触发工具前的信任 gate；越权抛 PluginTrustError。"""
        self._trust.guard_tool(name, tool_name, risk_level)

    def guard_plugin_context(self, name: str) -> ContextScope:
        """插件获取上下文前的信任 gate；返回允许范围，UNTRUSTED 抛 PluginTrustError。"""
        return self._trust.guard_context(name)

    def unregister_plugin(self, name: str) -> bool:
        """注销插件，将其从管理器中移除。

        Args:
            name: 插件名称。

        Returns:
            bool: 是否成功注销。未注册的插件返回 False。
        """
        if name not in self._plugins:
            logger.warning(f"Plugin not found for unregistration: {name}")
            return False
        del self._plugins[name]
        del self._states[name]
        logger.info(f"Plugin unregistered: {name}")
        return True

    async def load_plugin(self, name: str) -> bool:
        """加载指定插件，调用其 on_load 方法。

        仅 UNLOADED 状态的插件可加载，加载成功后状态变为 LOADED。

        Args:
            name: 插件名称。

        Returns:
            bool: 是否加载成功。
        """
        plugin = self._plugins.get(name)
        if plugin is None:
            logger.warning(f"Plugin not found for loading: {name}")
            return False
        if self._states[name] != PluginState.UNLOADED:
            logger.warning(f"Plugin {name} is not in UNLOADED state (current: {self._states[name]})")
            return False
        try:
            await plugin.on_load({})
            self._states[name] = PluginState.LOADED
            logger.info(f"Plugin loaded: {name}")
            return True
        except Exception as exc:
            self._states[name] = PluginState.ERROR
            logger.error(f"Failed to load plugin {name}: {exc}")
            return False

    async def unload_plugin(self, name: str) -> bool:
        """卸载指定插件，调用其 on_unload 方法。

        仅 LOADED 或 DISABLED 状态的插件可卸载，卸载成功后状态变为 UNLOADED。

        Args:
            name: 插件名称。

        Returns:
            bool: 是否卸载成功。
        """
        plugin = self._plugins.get(name)
        if plugin is None:
            logger.warning(f"Plugin not found for unloading: {name}")
            return False
        current_state = self._states[name]
        if current_state not in (PluginState.LOADED, PluginState.DISABLED):
            logger.warning(f"Plugin {name} cannot be unloaded from state {current_state}")
            return False
        try:
            await plugin.on_unload()
            self._states[name] = PluginState.UNLOADED
            logger.info(f"Plugin unloaded: {name}")
            return True
        except Exception as exc:
            self._states[name] = PluginState.ERROR
            logger.error(f"Failed to unload plugin {name}: {exc}")
            return False

    async def enable_plugin(self, name: str) -> bool:
        """启用指定插件，调用其 on_enable 方法。

        仅 LOADED 或 DISABLED 状态的插件可启用，启用成功后状态变为 ENABLED。

        Args:
            name: 插件名称。

        Returns:
            bool: 是否启用成功。
        """
        plugin = self._plugins.get(name)
        if plugin is None:
            logger.warning(f"Plugin not found for enabling: {name}")
            return False
        current_state = self._states[name]
        if current_state not in (PluginState.LOADED, PluginState.DISABLED):
            logger.warning(f"Plugin {name} cannot be enabled from state {current_state}")
            return False
        try:
            await plugin.on_enable()
            self._states[name] = PluginState.ENABLED
            logger.info(f"Plugin enabled: {name}")
            return True
        except Exception as exc:
            self._states[name] = PluginState.ERROR
            logger.error(f"Failed to enable plugin {name}: {exc}")
            return False

    async def disable_plugin(self, name: str) -> bool:
        """禁用指定插件，调用其 on_disable 方法。

        仅 ENABLED 状态的插件可禁用，禁用成功后状态变为 DISABLED。

        Args:
            name: 插件名称。

        Returns:
            bool: 是否禁用成功。
        """
        plugin = self._plugins.get(name)
        if plugin is None:
            logger.warning(f"Plugin not found for disabling: {name}")
            return False
        if self._states[name] != PluginState.ENABLED:
            logger.warning(f"Plugin {name} cannot be disabled from state {self._states[name]}")
            return False
        try:
            await plugin.on_disable()
            self._states[name] = PluginState.DISABLED
            logger.info(f"Plugin disabled: {name}")
            return True
        except Exception as exc:
            self._states[name] = PluginState.ERROR
            logger.error(f"Failed to disable plugin {name}: {exc}")
            return False

    def get_plugin(self, name: str) -> Plugin | None:
        """获取指定名称的插件实例。

        Args:
            name: 插件名称。

        Returns:
            Plugin | None: 插件实例，不存在时返回 None。
        """
        return self._plugins.get(name)

    def list_plugins(self, state: PluginState | None = None) -> list[PluginInfo]:
        """列出已注册的插件信息。

        Args:
            state: 可选的状态过滤，为 None 时列出所有插件。

        Returns:
            list[PluginInfo]: 插件信息列表。
        """
        result: list[PluginInfo] = []
        for name, plugin in self._plugins.items():
            current_state = self._states[name]
            if state is not None and current_state != state:
                continue
            info = plugin.info
            info.state = current_state
            result.append(info)
        return result

    async def load_all(self) -> dict[str, bool]:
        """加载所有已注册但尚未加载的插件。

        Returns:
            dict[str, bool]: 插件名称 -> 是否加载成功的映射。
        """
        results: dict[str, bool] = {}
        for name, state in list(self._states.items()):
            if state == PluginState.UNLOADED:
                results[name] = await self.load_plugin(name)
        return results

    def register_all_tools(self, registry: Any) -> None:
        """向核心工具注册表注册所有已启用插件的工具（过信任 gate）。

        每个插件工具经 _GatedToolRegistry 逐个过 guard_plugin_tool：
        UNTRUSTED 插件的工具一律不注册；受信插件按 (信任等级 × 风险) 矩阵放行，
        critical 工具永不放行。保证不受信插件无法把工具暴露给 LLM。

        Args:
            registry: 核心工具注册表实例。为 None 时 _GatedToolRegistry 内的
                register 会安全跳过（不注册任何工具），但仍会调用 plugin.register_tools。
        """
        for name, plugin in self._plugins.items():
            if self._states[name] == PluginState.ENABLED:
                try:
                    gated = _GatedToolRegistry(registry, name, self)
                    plugin.register_tools(gated)
                    logger.info(f"Tools registered for plugin (trust-gated): {name}")
                except Exception as exc:
                    logger.error(f"Failed to register tools for plugin {name}: {exc}")

    # ─── T2：能力请求点（运行时 gate 的主动调用入口）────

    def request_llm(self, name: str) -> None:
        """插件发起 LLM 调用前的能力请求点（运行时 gate）。

        越权抛 PluginTrustError，由插件转成拒绝 + 审计。
        """
        self.guard_plugin_llm(name)

    def request_tool(self, name: str, tool_name: str, risk_level: str) -> None:
        """插件触发工具前的能力请求点（运行时 gate）。"""
        self.guard_plugin_tool(name, tool_name, risk_level)

    def request_context(self, name: str) -> ContextScope:
        """插件获取上下文前的能力请求点（运行时 gate）。"""
        return self.guard_plugin_context(name)

    def can_use_llm(self, name: str) -> bool:
        """非抛出版：该插件是否被允许发起 LLM 调用。"""
        return can_call_llm(self._trust.get_trust(name))

    def can_use_tool(self, name: str, risk_level: str | None) -> bool:
        """非抛出版：该插件是否可调用给定风险的工具（critical 永为 False）。"""
        return can_call_tool(self._trust.get_trust(name), risk_level)

    def context_scope(self, name: str) -> ContextScope:
        """非抛出版：该插件允许的上下文范围。"""
        return allowed_context_scope(self._trust.get_trust(name))

    def get_dependencies(self, name: str) -> list[str]:
        """获取插件的依赖列表。

        Args:
            name: 插件名称。

        Returns:
            list[str]: 依赖的插件名称列表，插件不存在时返回空列表。
        """
        plugin = self._plugins.get(name)
        if plugin is None:
            return []
        return list(plugin.info.dependencies)

    def check_dependencies(self, name: str) -> tuple[bool, list[str]]:
        """检查插件的依赖是否全部已注册。

        Args:
            name: 插件名称。

        Returns:
            tuple[bool, list[str]]: (是否全部满足, 未满足的依赖名称列表)。
        """
        deps = self.get_dependencies(name)
        missing = [dep for dep in deps if dep not in self._plugins]
        return (len(missing) == 0, missing)
