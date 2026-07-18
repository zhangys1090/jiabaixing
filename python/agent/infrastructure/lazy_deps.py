from __future__ import annotations

import importlib
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class _DepEntry:
    """懒加载依赖条目。

    Attributes:
        import_path: 模块完整导入路径，如 "agent.tools.web_search_provider"。
        attribute: 模块中需要提取的属性名，如 "WebSearchRegistry"；为 None 时返回整个模块。
        critical: 是否为关键模块（preload_critical 时会预加载）。
        loaded: 是否已经加载。
        value: 加载后的模块或属性值。
        load_time_ms: 加载耗时（毫秒）。
    """

    import_path: str
    attribute: str | None = None
    critical: bool = False
    loaded: bool = False
    value: Any = None
    load_time_ms: float = 0.0


class LazyDependency:
    """延迟导入管理器。

    将大型模块的导入推迟到首次访问时执行，从而加速启动时间。
    支持注册、预加载和加载统计。

    Usage:
        lazy = LazyDependency()
        lazy.register("web_search", "agent.tools.web_search_provider", "WebSearchRegistry")
        registry = lazy.get("web_search")  # 此时才真正导入
    """

    def __init__(self) -> None:
        self._registry: dict[str, _DepEntry] = {}

    def register(
        self,
        name: str,
        import_path: str,
        attribute: str | None = None,
        critical: bool = False,
    ) -> None:
        """注册懒加载模块。

        Args:
            name: 模块注册名称，后续通过此名称获取。
            import_path: 模块完整导入路径，如 "agent.tools.web_search_provider"。
            attribute: 模块中需要提取的属性名；为 None 时返回整个模块。
            critical: 是否标记为关键模块，preload_critical 时会预加载。
        """
        self._registry[name] = _DepEntry(
            import_path=import_path,
            attribute=attribute,
            critical=critical,
        )

    def get(self, name: str) -> Any:
        """获取模块或属性，首次访问时才真正导入。

        Args:
            name: 注册时使用的名称。

        Returns:
            Any: 导入的模块或属性对象。

        Raises:
            KeyError: 名称未注册时抛出。
            ImportError: 模块导入失败时抛出。
            AttributeError: 指定的属性不存在时抛出。
        """
        entry = self._registry.get(name)
        if entry is None:
            raise KeyError(f"懒加载依赖 '{name}' 未注册")

        if entry.loaded:
            return entry.value

        start = time.perf_counter()
        module = importlib.import_module(entry.import_path)
        value = getattr(module, entry.attribute) if entry.attribute else module
        elapsed = (time.perf_counter() - start) * 1000

        entry.value = value
        entry.loaded = True
        entry.load_time_ms = elapsed
        return value

    def is_loaded(self, name: str) -> bool:
        """检查指定模块是否已加载。

        Args:
            name: 注册时使用的名称。

        Returns:
            bool: 已加载返回 True，否则返回 False。
        """
        entry = self._registry.get(name)
        return entry.loaded if entry is not None else False

    def preload(self, names: list[str]) -> None:
        """预加载指定模块列表。

        Args:
            names: 需要预加载的模块名称列表。
        """
        for name in names:
            if name in self._registry and not self.is_loaded(name):
                self.get(name)

    def preload_critical(self) -> None:
        """预加载所有标记为 critical 的模块。"""
        critical_names = [
            name for name, entry in self._registry.items()
            if entry.critical and not entry.loaded
        ]
        self.preload(critical_names)

    def list_registered(self) -> list[str]:
        """列出所有已注册模块名。

        Returns:
            list[str]: 已注册模块名列表。
        """
        return list(self._registry.keys())

    def list_loaded(self) -> list[str]:
        """列出所有已加载模块名。

        Returns:
            list[str]: 已加载模块名列表。
        """
        return [name for name, entry in self._registry.items() if entry.loaded]

    def get_load_stats(self) -> dict[str, Any]:
        """获取加载统计信息。

        Returns:
            dict: 包含已注册数、已加载数和各模块加载时间的统计。
        """
        loaded_entries = {
            name: entry for name, entry in self._registry.items() if entry.loaded
        }
        return {
            "registered_count": len(self._registry),
            "loaded_count": len(loaded_entries),
            "load_details": {
                name: {
                    "import_path": entry.import_path,
                    "attribute": entry.attribute,
                    "load_time_ms": round(entry.load_time_ms, 2),
                    "critical": entry.critical,
                }
                for name, entry in loaded_entries.items()
            },
        }


# 预注册的懒加载列表（大型模块全部延迟导入）
DEFAULT_LAZY_DEPS: list[tuple[str, str, str | None]] = [
    ("web_search_provider", "agent.tools.web_search_provider", "WebSearchRegistry"),
    ("code_execution", "agent.tools.code_execution_tool", "CodeExecutor"),
    ("delegate_tool", "agent.tools.delegate_tool", "SubAgentDelegator"),
    ("vision_tools", "agent.tools.vision_tools", None),
    ("browser_tool", "agent.tools.browser_tool", None),
    ("tts_tool", "agent.tools.tts_tool", None),
    ("evolution_engine", "agent.evolution.engine", "EvolutionEngine"),
    ("a2a_protocol", "agent.a2a.protocol", "A2ATaskManager"),
    ("gateway_dispatcher", "agent.gateway.dispatcher", "MessageDispatcher"),
    ("ssl_guard", "agent.security.ssl_guard", "SSLGuard"),
]


def create_default_lazy_deps() -> LazyDependency:
    """创建并注册默认懒加载依赖。

    Returns:
        LazyDependency: 已注册默认依赖的懒加载管理器实例。
    """
    lazy = LazyDependency()
    for name, import_path, attribute in DEFAULT_LAZY_DEPS:
        lazy.register(name, import_path, attribute)
    return lazy
