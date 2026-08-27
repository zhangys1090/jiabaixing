"""插件注册表 — 学习 DeepSeek Harness 的 Everything is a Plugin 设计.

DeepSeek Harness 核心主张:
  - 一切皆插件: 模型适配器/工具注册表/会话日志/Agent Loop 都是插件
  - 基于 Cordis 元框架: Context/Service/Fiber/Effect/inject/waterfall/isolate
  - 热插拔: 运行时可替换任意插件
  - 可回溯: 插件变更历史可回放

jiabaixing 适配:
  - 评分器/断言器/验证器 可作为插件注册
  - 运行时热替换（无需重启）
  - 插件生命周期: register → activate → deactivate → unregister
  - 插件依赖声明与自动解析
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("plugin_registry")


class PluginState(str, Enum):
    REGISTERED = "registered"
    ACTIVE = "active"
    INACTIVE = "inactive"
    ERROR = "error"


class PluginCategory(str, Enum):
    SCORER = "scorer"
    ASSERTION = "assertion"
    VERIFIER = "verifier"
    TOOL = "tool"
    MODEL = "model"
    MIDDLEWARE = "middleware"
    EVAL = "eval"


@dataclass
class PluginSpec:
    name: str
    category: PluginCategory
    version: str = "1.0.0"
    description: str = ""
    dependencies: list[str] = field(default_factory=list)
    config_schema: dict[str, Any] = field(default_factory=dict)
    factory: Callable | None = None


@dataclass
class PluginInstance:
    spec: PluginSpec
    state: PluginState = PluginState.REGISTERED
    instance: Any = None
    registered_at: float = field(default_factory=time.time)
    activated_at: float = 0.0
    error: str = ""


@dataclass
class PluginChangeEvent:
    plugin_name: str
    old_state: PluginState
    new_state: PluginState
    timestamp: float = field(default_factory=time.time)
    reason: str = ""


class PluginRegistry:
    """插件注册表 — DeepSeek Harness 风格的 Everything is a Plugin.

    功能:
      - 插件注册/注销
      - 插件激活/停用（热插拔）
      - 依赖解析
      - 变更历史（可回溯）
      - 按类别查询
    """

    def __init__(self):
        self._plugins: dict[str, PluginInstance] = {}
        self._change_history: list[PluginChangeEvent] = []

    def register(self, spec: PluginSpec) -> None:
        if spec.name in self._plugins:
            log.warning("插件已存在，将替换", plugin=spec.name)
            self._unregister_internal(spec.name)

        instance = PluginInstance(spec=spec)
        if spec.factory:
            try:
                instance.instance = spec.factory()
            except Exception as e:
                instance.state = PluginState.ERROR
                instance.error = str(e)
                log.error("插件工厂创建失败", plugin=spec.name, error=str(e))

        self._plugins[spec.name] = instance
        self._record_change(spec.name, PluginState.REGISTERED, PluginState.REGISTERED, "注册")
        log.info("插件已注册", plugin=spec.name, category=spec.category.value, version=spec.version)

    def unregister(self, name: str) -> bool:
        if name not in self._plugins:
            return False
        plugin = self._plugins[name]
        if plugin.state == PluginState.ACTIVE:
            self.deactivate(name)
        return self._unregister_internal(name)

    def activate(self, name: str) -> bool:
        plugin = self._plugins.get(name)
        if not plugin:
            log.warning("插件不存在", plugin=name)
            return False
        if plugin.state == PluginState.ACTIVE:
            return True
        if plugin.state == PluginState.ERROR:
            log.warning("插件处于错误状态", plugin=name)
            return False

        for dep in plugin.spec.dependencies:
            dep_plugin = self._plugins.get(dep)
            if not dep_plugin or dep_plugin.state != PluginState.ACTIVE:
                log.warning("插件依赖未满足", plugin=name, dependency=dep)
                return False

        old_state = plugin.state
        plugin.state = PluginState.ACTIVE
        plugin.activated_at = time.time()
        self._record_change(name, old_state, PluginState.ACTIVE, "激活")
        log.info("插件已激活", plugin=name)
        return True

    def deactivate(self, name: str) -> bool:
        plugin = self._plugins.get(name)
        if not plugin or plugin.state != PluginState.ACTIVE:
            return False

        dependents = [
            p.spec.name for p in self._plugins.values()
            if p.state == PluginState.ACTIVE and name in p.spec.dependencies
        ]
        if dependents:
            log.warning("插件有活跃依赖，无法停用", plugin=name, dependents=dependents)
            return False

        old_state = plugin.state
        plugin.state = PluginState.INACTIVE
        self._record_change(name, old_state, PluginState.INACTIVE, "停用")
        log.info("插件已停用", plugin=name)
        return True

    def hot_swap(self, name: str, new_spec: PluginSpec) -> bool:
        old_plugin = self._plugins.get(name)
        was_active = old_plugin and old_plugin.state == PluginState.ACTIVE

        if was_active:
            self.deactivate(name)

        self.register(new_spec)

        if was_active:
            return self.activate(name)
        return True

    def get(self, name: str) -> Any | None:
        plugin = self._plugins.get(name)
        if plugin and plugin.state == PluginState.ACTIVE and plugin.instance:
            return plugin.instance
        return None

    def get_spec(self, name: str) -> PluginSpec | None:
        plugin = self._plugins.get(name)
        return plugin.spec if plugin else None

    def list_plugins(
        self,
        category: PluginCategory | None = None,
        state: PluginState | None = None,
    ) -> list[dict[str, Any]]:
        result = []
        for name, plugin in self._plugins.items():
            if category and plugin.spec.category != category:
                continue
            if state and plugin.state != state:
                continue
            result.append({
                "name": name,
                "category": plugin.spec.category.value,
                "version": plugin.spec.version,
                "state": plugin.state.value,
                "description": plugin.spec.description,
                "dependencies": plugin.spec.dependencies,
            })
        return result

    def get_change_history(self, limit: int = 50) -> list[dict[str, Any]]:
        history = self._change_history[-limit:] if limit > 0 else self._change_history
        return [
            {
                "plugin": e.plugin_name,
                "old_state": e.old_state.value,
                "new_state": e.new_state.value,
                "timestamp": e.timestamp,
                "reason": e.reason,
            }
            for e in history
        ]

    def _unregister_internal(self, name: str) -> bool:
        plugin = self._plugins.pop(name, None)
        if plugin:
            self._record_change(name, plugin.state, PluginState.REGISTERED, "注销")
            log.info("插件已注销", plugin=name)
            return True
        return False

    def _record_change(
        self, name: str, old: PluginState, new: PluginState, reason: str
    ) -> None:
        self._change_history.append(PluginChangeEvent(
            plugin_name=name, old_state=old, new_state=new, reason=reason
        ))
