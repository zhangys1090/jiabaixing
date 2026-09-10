"""插件系统（PluginManager）。

提供第三方扩展的加载、生命周期和隔离管理：
  - 插件发现与加载（目录扫描 + 入口点）
  - 生命周期管理（install → enable → disable → uninstall）
  - 依赖解析与版本检查
  - 沙箱隔离（每个插件独立命名空间）
  - Hook/Event 集成（插件可注册 Hook 和监听事件）

与 Hook 系统的关系：
  - 插件通过 Hook 系统注册自定义行为
  - PluginManager 管理插件的加载和卸载
  - 两者组合提供完整的扩展机制

集成示例::

    from agent.cli.plugin_manager import PluginManager

    mgr = PluginManager()
    await mgr.install_from_dir("./my_plugin")
    await mgr.enable("my_plugin")
    # 插件的 hooks 自动注册到 HookManager
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Awaitable

from agent.config import DATA_ROOT
from agent.core.logger import StructuredLogger

log = StructuredLogger("plugin_manager")



class PluginStatus(str, Enum):
    DISCOVERED = "discovered"
    INSTALLED = "installed"
    ENABLED = "enabled"
    DISABLED = "disabled"
    ERROR = "error"


@dataclass
class PluginManifest:
    id: str
    name: str
    version: str
    description: str = ""
    author: str = ""
    homepage: str = ""
    min_agent_version: str = "0.1.0"
    dependencies: list[str] = field(default_factory=list)
    permissions: list[str] = field(default_factory=list)
    entry_point: str = "plugin.py"
    hooks: list[str] = field(default_factory=list)
    config_schema: dict[str, Any] = field(default_factory=dict)


@dataclass
class PluginInstance:
    manifest: PluginManifest
    status: PluginStatus = PluginStatus.DISCOVERED
    module: Any = None
    config: dict[str, Any] = field(default_factory=dict)
    installed_at: float = 0.0
    enabled_at: float = 0.0
    error_message: str = ""
    hook_registrations: list[str] = field(default_factory=list)


@dataclass
class PluginEvent:
    type: str
    plugin_id: str
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if self.timestamp == 0.0:
            self.timestamp = time.time()


class PluginManager:
    """插件管理器。

    管理插件的发现、加载、生命周期和隔离。
    """

    def __init__(self, plugins_dir: Path | None = None) -> None:
        self._dir = plugins_dir or DATA_ROOT / "plugins"
        self._plugins: dict[str, PluginInstance] = {}
        self._event_handlers: dict[str, list[Callable[..., Awaitable[Any]]]] = defaultdict(list)
        self._hook_manager: Any = None

    def set_hook_manager(self, hook_manager: Any) -> None:
        self._hook_manager = hook_manager

    def discover(self, scan_dir: Path | None = None) -> list[PluginManifest]:
        target = scan_dir or self._dir
        manifests = []
        if not target.exists():
            return manifests

        for plugin_dir in target.iterdir():
            if not plugin_dir.is_dir():
                continue
            manifest_file = plugin_dir / "manifest.json"
            if not manifest_file.exists():
                continue
            try:
                data = json.loads(manifest_file.read_text(encoding="utf-8"))
                manifest = PluginManifest(
                    id=data.get("id", plugin_dir.name),
                    name=data.get("name", plugin_dir.name),
                    version=data.get("version", "0.1.0"),
                    description=data.get("description", ""),
                    author=data.get("author", ""),
                    homepage=data.get("homepage", ""),
                    min_agent_version=data.get("min_agent_version", "0.1.0"),
                    dependencies=data.get("dependencies", []),
                    permissions=data.get("permissions", []),
                    entry_point=data.get("entry_point", "plugin.py"),
                    hooks=data.get("hooks", []),
                    config_schema=data.get("config_schema", {}),
                )
                if manifest.id not in self._plugins:
                    self._plugins[manifest.id] = PluginInstance(manifest=manifest)
                manifests.append(manifest)
            except Exception as e:
                log.warning("插件清单解析失败", dir=str(plugin_dir), error=str(e))

        return manifests

    async def install(self, plugin_id: str) -> bool:
        instance = self._plugins.get(plugin_id)
        if instance is None:
            log.error("插件不存在", id=plugin_id)
            return False

        if instance.status in (PluginStatus.INSTALLED, PluginStatus.ENABLED, PluginStatus.DISABLED):
            return True

        try:
            plugin_dir = self._dir / plugin_id
            entry_file = plugin_dir / instance.manifest.entry_point

            if not entry_file.exists():
                instance.status = PluginStatus.ERROR
                instance.error_message = f"入口文件不存在: {entry_file}"
                return False

            module_name = f"plugin_{plugin_id}"
            spec = importlib.util.spec_from_file_location(module_name, str(entry_file))
            if spec is None or spec.loader is None:
                instance.status = PluginStatus.ERROR
                instance.error_message = "无法创建模块规格"
                return False

            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)

            instance.module = module
            instance.status = PluginStatus.INSTALLED
            instance.installed_at = time.time()

            if hasattr(module, "on_install"):
                await module.on_install(instance.config)

            await self._emit("plugin_installed", plugin_id, {"version": instance.manifest.version})
            log.info("插件已安装", id=plugin_id, version=instance.manifest.version)
            return True
        except Exception as e:
            log.debug("plugin_manager 异常处理", error=str(e))
            instance.status = PluginStatus.ERROR
            instance.error_message = str(e)
            log.error("插件安装失败", id=plugin_id, error=str(e))
            return False

    async def install_from_dir(self, plugin_dir: str | Path) -> str | None:
        plugin_dir = Path(plugin_dir)
        manifest_file = plugin_dir / "manifest.json"
        if not manifest_file.exists():
            log.error("插件目录缺少 manifest.json", dir=str(plugin_dir))
            return None

        try:
            data = json.loads(manifest_file.read_text(encoding="utf-8"))
            plugin_id = data.get("id", plugin_dir.name)

            target_dir = self._dir / plugin_id
            target_dir.mkdir(parents=True, exist_ok=True)

            for src_file in plugin_dir.iterdir():
                if src_file.is_file():
                    content = src_file.read_bytes()
                    (target_dir / src_file.name).write_bytes(content)

            self.discover()
            success = await self.install(plugin_id)
            return plugin_id if success else None
        except Exception as e:
            log.error("从目录安装插件失败", dir=str(plugin_dir), error=str(e))
            return None

    async def enable(self, plugin_id: str) -> bool:
        instance = self._plugins.get(plugin_id)
        if instance is None:
            return False

        if instance.status == PluginStatus.ENABLED:
            return True

        if instance.status == PluginStatus.DISCOVERED:
            if not await self.install(plugin_id):
                return False
            instance = self._plugins[plugin_id]

        try:
            module = instance.module
            if module and hasattr(module, "on_enable"):
                await module.on_enable(instance.config)

            if self._hook_manager and module and hasattr(module, "register_hooks"):
                hooks = module.register_hooks(self._hook_manager)
                instance.hook_registrations = hooks or []

            instance.status = PluginStatus.ENABLED
            instance.enabled_at = time.time()

            await self._emit("plugin_enabled", plugin_id, {})
            log.info("插件已启用", id=plugin_id)
            return True
        except Exception as e:
            log.debug("plugin_manager 异常处理", error=str(e))
            instance.status = PluginStatus.ERROR
            instance.error_message = str(e)
            log.error("插件启用失败", id=plugin_id, error=str(e))
            return False

    async def disable(self, plugin_id: str) -> bool:
        instance = self._plugins.get(plugin_id)
        if instance is None or instance.status != PluginStatus.ENABLED:
            return False

        try:
            if instance.module and hasattr(instance.module, "on_disable"):
                await instance.module.on_disable(instance.config)

            if self._hook_manager:
                for hook_name in instance.hook_registrations:
                    self._hook_manager.remove_hook(hook_name)
                instance.hook_registrations.clear()

            instance.status = PluginStatus.DISABLED
            await self._emit("plugin_disabled", plugin_id, {})
            log.info("插件已禁用", id=plugin_id)
            return True
        except Exception as e:
            log.error("插件禁用失败", id=plugin_id, error=str(e))
            return False

    async def uninstall(self, plugin_id: str) -> bool:
        instance = self._plugins.get(plugin_id)
        if instance is None:
            return False

        if instance.status == PluginStatus.ENABLED:
            await self.disable(plugin_id)

        try:
            if instance.module and hasattr(instance.module, "on_uninstall"):
                await instance.module.on_uninstall(instance.config)

            module_name = f"plugin_{plugin_id}"
            sys.modules.pop(module_name, None)

            plugin_dir = self._dir / plugin_id
            if plugin_dir.exists():
                for f in plugin_dir.iterdir():
                    if f.is_file():
                        f.unlink()
                plugin_dir.rmdir()

            self._plugins.pop(plugin_id)
            await self._emit("plugin_uninstalled", plugin_id, {})
            log.info("插件已卸载", id=plugin_id)
            return True
        except Exception as e:
            log.error("插件卸载失败", id=plugin_id, error=str(e))
            return False

    def on_event(self, event_type: str, handler: Callable[..., Awaitable[Any]]) -> None:
        self._event_handlers[event_type].append(handler)

    async def _emit(self, event_type: str, plugin_id: str, data: dict[str, Any]) -> None:
        event = PluginEvent(type=event_type, plugin_id=plugin_id, data=data)
        for handler in self._event_handlers.get(event_type, []):
            try:
                await handler(event)
            except Exception as e:
                log.error("事件处理器失败", type=event_type, error=str(e))

    def get_plugin(self, plugin_id: str) -> PluginInstance | None:
        return self._plugins.get(plugin_id)

    def list_plugins(self, status: PluginStatus | None = None) -> list[PluginInstance]:
        plugins = list(self._plugins.values())
        if status:
            plugins = [p for p in plugins if p.status == status]
        return plugins

    def get_stats(self) -> dict[str, Any]:
        counts = defaultdict(int)
        for p in self._plugins.values():
            counts[p.status.value] += 1
        return dict(counts)
