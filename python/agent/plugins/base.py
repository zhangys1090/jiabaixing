"""插件系统基础定义，包含插件状态枚举、插件信息数据类和插件抽象基类。

所有自定义插件必须继承 Plugin 抽象基类并实现其生命周期方法。

Usage:
    class MyPlugin(Plugin):
        @property
        def name(self) -> str:
            return "my_plugin"

        @property
        def version(self) -> str:
            return "1.0.0"

        @property
        def description(self) -> str:
            return "我的自定义插件"

        async def on_load(self, context: dict) -> None:
            print(f"{self.name} loaded")
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class PluginState(Enum):
    """插件状态枚举，描述插件在生命周期中的当前阶段。

    Attributes:
        UNLOADED: 未加载，刚注册时的初始状态。
        LOADED: 已加载，on_load 已调用成功。
        ENABLED: 已启用，on_enable 已调用成功，插件可提供服务。
        DISABLED: 已禁用，on_disable 已调用，插件暂停服务但保留在内存。
        ERROR: 错误状态，生命周期方法执行出错。
    """

    UNLOADED = "unloaded"
    LOADED = "loaded"
    ENABLED = "enabled"
    DISABLED = "disabled"
    ERROR = "error"


@dataclass
class PluginInfo:
    """插件元信息数据类，描述插件的静态属性和当前状态。

    Attributes:
        name: 插件唯一名称标识。
        version: 插件版本号，遵循语义化版本。
        description: 插件功能描述。
        author: 插件作者。
        homepage: 插件主页 URL。
        dependencies: 依赖的其他插件名称列表。
        state: 插件当前状态。
    """

    name: str
    version: str = "0.1.0"
    description: str = ""
    author: str = ""
    homepage: str = ""
    dependencies: list[str] = field(default_factory=list)
    state: PluginState = PluginState.UNLOADED


class Plugin(ABC):
    """插件抽象基类，定义插件的生命周期接口。

    所有自定义插件必须继承此类并至少实现 name、version、description 属性。
    生命周期方法（on_load / on_unload / on_enable / on_disable）提供默认空实现，
    插件可按需覆盖。register_tools 用于向工具注册表注册插件提供的工具。

    Usage:
        class EchoPlugin(Plugin):
            @property
            def name(self) -> str:
                return "echo"

            @property
            def version(self) -> str:
                return "1.0.0"

            @property
            def description(self) -> str:
                return "回显插件"

            async def on_load(self, context: dict) -> None:
                self._context = context
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """插件唯一名称标识。

        Returns:
            str: 插件名称。
        """
        ...

    @property
    @abstractmethod
    def version(self) -> str:
        """插件版本号。

        Returns:
            str: 语义化版本字符串。
        """
        ...

    @property
    @abstractmethod
    def description(self) -> str:
        """插件功能描述。

        Returns:
            str: 功能描述文本。
        """
        ...

    @property
    def info(self) -> PluginInfo:
        """获取插件元信息。

        Returns:
            PluginInfo: 包含插件名称、版本、描述等元信息的数据对象。
        """
        return PluginInfo(
            name=self.name,
            version=self.version,
            description=self.description,
        )

    async def on_load(self, context: dict[str, Any]) -> None:
        """加载时调用，用于初始化插件资源。

        Args:
            context: 运行时上下文字典，可包含配置、服务实例等。
        """
        pass

    async def on_unload(self) -> None:
        """卸载时调用，用于释放插件持有的资源。"""
        pass

    async def on_enable(self) -> None:
        """启用时调用，插件开始对外提供服务。"""
        pass

    async def on_disable(self) -> None:
        """禁用时调用，插件暂停服务但保留在内存。"""
        pass

    def register_tools(self, registry: Any) -> None:
        """向工具注册表注册插件提供的工具。

        默认空实现，插件可按需覆盖。

        Args:
            registry: 工具注册表实例，类型由具体实现决定。
        """
        pass
