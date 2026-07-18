"""i18n 国际化模块和 plugins 插件系统测试。

覆盖 I18n、Plugin、PluginState、PluginInfo、PluginManager 的全部公共方法。
"""

from __future__ import annotations

import json
import os
import tempfile

import pytest

from agent.i18n import BUILTIN_EN_US, BUILTIN_ZH_CN, I18n, get_i18n
from agent.plugins import Plugin, PluginInfo, PluginManager, PluginState


# ===========================================================================
# I18n 测试
# ===========================================================================


class TestI18n:
    """I18n 国际化管理器测试。"""

    def test_default_locale_is_zh_cn(self) -> None:
        """默认语言应为 zh-CN。"""
        i18n = I18n()
        assert i18n.get_locale() == "zh-CN"

    def test_custom_default_locale(self) -> None:
        """可指定自定义默认语言。"""
        i18n = I18n("en-US")
        assert i18n.get_locale() == "en-US"

    def test_set_locale(self) -> None:
        """set_locale 应正确切换语言。"""
        i18n = I18n()
        i18n.set_locale("en-US")
        assert i18n.get_locale() == "en-US"

    def test_translate_zh_cn(self) -> None:
        """zh-CN 翻译应正确返回。"""
        i18n = I18n("zh-CN")
        assert i18n.t("system.name") == "家百星"
        assert i18n.t("system.welcome") == "欢迎使用家百星 AI 助手"

    def test_translate_en_us(self) -> None:
        """en-US 翻译应正确返回。"""
        i18n = I18n("en-US")
        assert i18n.t("system.name") == "Jiabaixing"
        assert i18n.t("system.welcome") == "Welcome to Jiabaixing AI Assistant"

    def test_translate_with_params(self) -> None:
        """带参数的翻译应正确替换。"""
        i18n = I18n("zh-CN")
        result = i18n.t("tool.executing", tool="搜索")
        assert result == "正在执行 搜索..."

    def test_translate_multiple_params(self) -> None:
        """多个参数的翻译应全部替换。"""
        i18n = I18n("zh-CN")
        result = i18n.t("tool.failed", tool="搜索", error="超时")
        assert result == "搜索 执行失败: 超时"

    def test_translate_missing_key_returns_key(self) -> None:
        """不存在的 key 应返回 key 本身。"""
        i18n = I18n()
        assert i18n.t("nonexistent.key") == "nonexistent.key"

    def test_translate_fallback_to_default_locale(self) -> None:
        """当前语言缺少 key 时应回退到默认语言。"""
        i18n = I18n("zh-CN")
        i18n.add_translations("ja-JP", {"greeting": "こんにちは"})
        i18n.set_locale("ja-JP")
        # ja-JP 没有此 key，回退到 zh-CN
        assert i18n.t("system.name") == "家百星"

    def test_add_translations(self) -> None:
        """add_translations 应添加新翻译。"""
        i18n = I18n()
        i18n.add_translations("ja-JP", {"greeting": "こんにちは"})
        i18n.set_locale("ja-JP")
        assert i18n.t("greeting") == "こんにちは"

    def test_add_translations_merge(self) -> None:
        """add_translations 应合并而非覆盖已有语言。"""
        i18n = I18n()
        i18n.add_translations("zh-CN", {"custom.key": "自定义值"})
        assert i18n.t("custom.key") == "自定义值"
        # 原有翻译仍可用
        assert i18n.t("system.name") == "家百星"

    def test_load_translations_from_json(self) -> None:
        """load_translations 应从 JSON 文件加载翻译。"""
        i18n = I18n()
        data = {"fr-FR": {"greeting": "Bonjour"}}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            tmp_path = f.name
        try:
            i18n.load_translations(tmp_path)
            i18n.set_locale("fr-FR")
            assert i18n.t("greeting") == "Bonjour"
        finally:
            os.unlink(tmp_path)

    def test_load_translations_file_not_found(self) -> None:
        """加载不存在的文件不应抛出异常。"""
        i18n = I18n()
        i18n.load_translations("/nonexistent/path.json")  # 不应抛出

    def test_list_locales(self) -> None:
        """list_locales 应返回所有可用语言。"""
        i18n = I18n()
        locales = i18n.list_locales()
        assert "zh-CN" in locales
        assert "en-US" in locales

    def test_list_locales_includes_added(self) -> None:
        """list_locales 应包含动态添加的语言。"""
        i18n = I18n()
        i18n.add_translations("ja-JP", {"greeting": "こんにちは"})
        locales = i18n.list_locales()
        assert "ja-JP" in locales

    def test_has_key_true(self) -> None:
        """has_key 对存在的 key 应返回 True。"""
        i18n = I18n()
        assert i18n.has_key("system.name") is True

    def test_has_key_false(self) -> None:
        """has_key 对不存在的 key 应返回 False。"""
        i18n = I18n()
        assert i18n.has_key("nonexistent.key") is False

    def test_has_key_with_locale(self) -> None:
        """has_key 应支持指定语言。"""
        i18n = I18n()
        assert i18n.has_key("system.name", locale="en-US") is True
        assert i18n.has_key("system.name", locale="fr-FR") is False

    def test_translate_with_incomplete_params_returns_template(self) -> None:
        """参数不完整时返回原始模板。"""
        i18n = I18n("zh-CN")
        # tool.failed 需要 tool 和 error，只传 tool
        result = i18n.t("tool.failed", tool="搜索")
        assert result == "{tool} 执行失败: {error}"


class TestGetI18n:
    """get_i18n 全局单例测试。"""

    def test_returns_i18n_instance(self) -> None:
        """get_i18n 应返回 I18n 实例。"""
        instance = get_i18n()
        assert isinstance(instance, I18n)


class TestBuiltinTranslations:
    """内置翻译字典完整性测试。"""

    def test_zh_cn_has_all_keys(self) -> None:
        """zh-CN 应包含所有预期 key。"""
        expected_keys = [
            "system.name", "system.welcome", "system.goodbye",
            "error.generic", "error.network", "error.timeout", "error.permission",
            "error.not_found",
            "tool.executing", "tool.completed", "tool.failed", "tool.approval_needed",
            "memory.stored", "memory.recalled", "memory.not_found",
            "session.new", "session.saved", "session.search.results",
            "security.warning", "security.confirm",
            "budget.warning", "budget.exceeded",
        ]
        for key in expected_keys:
            assert key in BUILTIN_ZH_CN, f"Missing key in BUILTIN_ZH_CN: {key}"

    def test_en_us_has_all_keys(self) -> None:
        """en-US 应包含所有预期 key。"""
        expected_keys = list(BUILTIN_ZH_CN.keys())
        for key in expected_keys:
            assert key in BUILTIN_EN_US, f"Missing key in BUILTIN_EN_US: {key}"

    def test_both_locales_have_same_keys(self) -> None:
        """zh-CN 和 en-US 的 key 集合应完全一致。"""
        assert set(BUILTIN_ZH_CN.keys()) == set(BUILTIN_EN_US.keys())


# ===========================================================================
# PluginState 测试
# ===========================================================================


class TestPluginState:
    """PluginState 枚举测试。"""

    def test_all_states_exist(self) -> None:
        """所有预期状态应存在。"""
        assert PluginState.UNLOADED.value == "unloaded"
        assert PluginState.LOADED.value == "loaded"
        assert PluginState.ENABLED.value == "enabled"
        assert PluginState.DISABLED.value == "disabled"
        assert PluginState.ERROR.value == "error"

    def test_state_count(self) -> None:
        """应有 5 个状态。"""
        assert len(PluginState) == 5


# ===========================================================================
# PluginInfo 测试
# ===========================================================================


class TestPluginInfo:
    """PluginInfo 数据类测试。"""

    def test_default_values(self) -> None:
        """默认值应正确。"""
        info = PluginInfo(name="test")
        assert info.name == "test"
        assert info.version == "0.1.0"
        assert info.description == ""
        assert info.author == ""
        assert info.homepage == ""
        assert info.dependencies == []
        assert info.state == PluginState.UNLOADED

    def test_custom_values(self) -> None:
        """自定义值应正确。"""
        info = PluginInfo(
            name="my_plugin",
            version="1.0.0",
            description="A test plugin",
            author="Test Author",
            homepage="https://example.com",
            dependencies=["dep1", "dep2"],
            state=PluginState.ENABLED,
        )
        assert info.name == "my_plugin"
        assert info.version == "1.0.0"
        assert info.dependencies == ["dep1", "dep2"]
        assert info.state == PluginState.ENABLED


# ===========================================================================
# Plugin 抽象基类测试
# ===========================================================================


class ConcretePlugin(Plugin):
    """用于测试的具体插件实现。"""

    def __init__(
        self,
        name: str = "test_plugin",
        version: str = "1.0.0",
        description: str = "测试插件",
        dependencies: list[str] | None = None,
    ) -> None:
        self._name = name
        self._version = version
        self._description = description
        self._dependencies = dependencies or []
        self._load_called = False
        self._unload_called = False
        self._enable_called = False
        self._disable_called = False
        self._tools_registered = False

    @property
    def name(self) -> str:
        return self._name

    @property
    def version(self) -> str:
        return self._version

    @property
    def description(self) -> str:
        return self._description

    @property
    def info(self) -> PluginInfo:
        return PluginInfo(
            name=self._name,
            version=self._version,
            description=self._description,
            dependencies=self._dependencies,
        )

    async def on_load(self, context: dict) -> None:
        self._load_called = True

    async def on_unload(self) -> None:
        self._unload_called = True

    async def on_enable(self) -> None:
        self._enable_called = True

    async def on_disable(self) -> None:
        self._disable_called = True

    def register_tools(self, registry) -> None:
        self._tools_registered = True


class ErrorPlugin(Plugin):
    """在生命周期方法中抛出异常的插件，用于测试错误处理。"""

    @property
    def name(self) -> str:
        return "error_plugin"

    @property
    def version(self) -> str:
        return "0.0.1"

    @property
    def description(self) -> str:
        return "总是出错的插件"

    async def on_load(self, context: dict) -> None:
        raise RuntimeError("on_load failed")


class TestPlugin:
    """Plugin 抽象基类测试。"""

    def test_cannot_instantiate_abc(self) -> None:
        """不能直接实例化 Plugin 抽象基类。"""
        with pytest.raises(TypeError):
            Plugin()  # type: ignore[abstract]

    def test_concrete_plugin_properties(self) -> None:
        """具体插件属性应正确返回。"""
        plugin = ConcretePlugin()
        assert plugin.name == "test_plugin"
        assert plugin.version == "1.0.0"
        assert plugin.description == "测试插件"

    def test_plugin_info(self) -> None:
        """info 属性应返回正确的 PluginInfo。"""
        plugin = ConcretePlugin(dependencies=["dep_a"])
        info = plugin.info
        assert isinstance(info, PluginInfo)
        assert info.name == "test_plugin"
        assert info.dependencies == ["dep_a"]

    @pytest.mark.asyncio
    async def test_on_load(self) -> None:
        """on_load 应被正确调用。"""
        plugin = ConcretePlugin()
        await plugin.on_load({})
        assert plugin._load_called is True

    @pytest.mark.asyncio
    async def test_on_unload(self) -> None:
        """on_unload 应被正确调用。"""
        plugin = ConcretePlugin()
        await plugin.on_unload()
        assert plugin._unload_called is True

    @pytest.mark.asyncio
    async def test_on_enable(self) -> None:
        """on_enable 应被正确调用。"""
        plugin = ConcretePlugin()
        await plugin.on_enable()
        assert plugin._enable_called is True

    @pytest.mark.asyncio
    async def test_on_disable(self) -> None:
        """on_disable 应被正确调用。"""
        plugin = ConcretePlugin()
        await plugin.on_disable()
        assert plugin._disable_called is True

    def test_register_tools(self) -> None:
        """register_tools 应被正确调用。"""
        plugin = ConcretePlugin()
        plugin.register_tools(None)
        assert plugin._tools_registered is True


# ===========================================================================
# PluginManager 测试
# ===========================================================================


class TestPluginManager:
    """PluginManager 插件管理器测试。"""

    def test_register_plugin(self) -> None:
        """注册插件应成功。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        assert manager.get_plugin("test_plugin") is plugin

    def test_register_duplicate_plugin_ignored(self) -> None:
        """重复注册同名插件应被忽略。"""
        manager = PluginManager()
        manager.register_plugin(ConcretePlugin(name="dup"))
        manager.register_plugin(ConcretePlugin(name="dup"))
        assert len(manager.list_plugins()) == 1

    def test_unregister_plugin(self) -> None:
        """注销插件应成功。"""
        manager = PluginManager()
        manager.register_plugin(ConcretePlugin(name="removable"))
        assert manager.unregister_plugin("removable") is True
        assert manager.get_plugin("removable") is None

    def test_unregister_nonexistent_plugin(self) -> None:
        """注销不存在的插件应返回 False。"""
        manager = PluginManager()
        assert manager.unregister_plugin("nonexistent") is False

    @pytest.mark.asyncio
    async def test_load_plugin(self) -> None:
        """加载插件应成功并变更状态。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        result = await manager.load_plugin("test_plugin")
        assert result is True
        assert plugin._load_called is True
        info = manager.list_plugins()[0]
        assert info.state == PluginState.LOADED

    @pytest.mark.asyncio
    async def test_load_nonexistent_plugin(self) -> None:
        """加载不存在的插件应返回 False。"""
        manager = PluginManager()
        result = await manager.load_plugin("nonexistent")
        assert result is False

    @pytest.mark.asyncio
    async def test_load_plugin_twice_fails(self) -> None:
        """重复加载已加载的插件应返回 False。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        await manager.load_plugin("test_plugin")
        result = await manager.load_plugin("test_plugin")
        assert result is False

    @pytest.mark.asyncio
    async def test_load_plugin_error_sets_error_state(self) -> None:
        """加载出错时应设为 ERROR 状态。"""
        manager = PluginManager()
        manager.register_plugin(ErrorPlugin())
        result = await manager.load_plugin("error_plugin")
        assert result is False
        info = manager.list_plugins()[0]
        assert info.state == PluginState.ERROR

    @pytest.mark.asyncio
    async def test_unload_plugin(self) -> None:
        """卸载插件应成功并变为 UNLOADED。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        await manager.load_plugin("test_plugin")
        result = await manager.unload_plugin("test_plugin")
        assert result is True
        assert plugin._unload_called is True
        info = manager.list_plugins()[0]
        assert info.state == PluginState.UNLOADED

    @pytest.mark.asyncio
    async def test_enable_plugin(self) -> None:
        """启用插件应成功并变为 ENABLED。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        await manager.load_plugin("test_plugin")
        result = await manager.enable_plugin("test_plugin")
        assert result is True
        assert plugin._enable_called is True
        info = manager.list_plugins()[0]
        assert info.state == PluginState.ENABLED

    @pytest.mark.asyncio
    async def test_enable_from_disabled(self) -> None:
        """从 DISABLED 状态启用插件应成功。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        await manager.load_plugin("test_plugin")
        await manager.enable_plugin("test_plugin")
        await manager.disable_plugin("test_plugin")
        result = await manager.enable_plugin("test_plugin")
        assert result is True
        info = manager.list_plugins()[0]
        assert info.state == PluginState.ENABLED

    @pytest.mark.asyncio
    async def test_enable_from_unloaded_fails(self) -> None:
        """从 UNLOADED 状态启用插件应失败。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        result = await manager.enable_plugin("test_plugin")
        assert result is False

    @pytest.mark.asyncio
    async def test_disable_plugin(self) -> None:
        """禁用插件应成功并变为 DISABLED。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        await manager.load_plugin("test_plugin")
        await manager.enable_plugin("test_plugin")
        result = await manager.disable_plugin("test_plugin")
        assert result is True
        assert plugin._disable_called is True
        info = manager.list_plugins()[0]
        assert info.state == PluginState.DISABLED

    @pytest.mark.asyncio
    async def test_disable_not_enabled_fails(self) -> None:
        """禁用未启用的插件应失败。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)
        await manager.load_plugin("test_plugin")
        result = await manager.disable_plugin("test_plugin")
        assert result is False

    @pytest.mark.asyncio
    async def test_full_lifecycle(self) -> None:
        """完整生命周期: register → load → enable → disable → unload。"""
        manager = PluginManager()
        plugin = ConcretePlugin()
        manager.register_plugin(plugin)

        # Load
        assert await manager.load_plugin("test_plugin") is True
        assert manager.list_plugins()[0].state == PluginState.LOADED

        # Enable
        assert await manager.enable_plugin("test_plugin") is True
        assert manager.list_plugins()[0].state == PluginState.ENABLED

        # Disable
        assert await manager.disable_plugin("test_plugin") is True
        assert manager.list_plugins()[0].state == PluginState.DISABLED

        # Unload from disabled
        assert await manager.unload_plugin("test_plugin") is True
        assert manager.list_plugins()[0].state == PluginState.UNLOADED

    def test_get_plugin(self) -> None:
        """get_plugin 应返回正确的插件实例。"""
        manager = PluginManager()
        plugin = ConcretePlugin(name="alpha")
        manager.register_plugin(plugin)
        assert manager.get_plugin("alpha") is plugin
        assert manager.get_plugin("nonexistent") is None

    def test_list_plugins_all(self) -> None:
        """list_plugins 无过滤应返回所有插件。"""
        manager = PluginManager()
        manager.register_plugin(ConcretePlugin(name="a"))
        manager.register_plugin(ConcretePlugin(name="b"))
        assert len(manager.list_plugins()) == 2

    def test_list_plugins_filter_by_state(self) -> None:
        """list_plugins 按状态过滤应正确。"""
        manager = PluginManager()
        manager.register_plugin(ConcretePlugin(name="a"))
        unloaded = manager.list_plugins(state=PluginState.UNLOADED)
        assert len(unloaded) == 1
        loaded = manager.list_plugins(state=PluginState.LOADED)
        assert len(loaded) == 0

    @pytest.mark.asyncio
    async def test_load_all(self) -> None:
        """load_all 应加载所有未加载插件。"""
        manager = PluginManager()
        manager.register_plugin(ConcretePlugin(name="p1"))
        manager.register_plugin(ConcretePlugin(name="p2"))
        results = await manager.load_all()
        assert results["p1"] is True
        assert results["p2"] is True
        infos = manager.list_plugins()
        assert all(i.state == PluginState.LOADED for i in infos)

    @pytest.mark.asyncio
    async def test_load_all_skips_already_loaded(self) -> None:
        """load_all 不应重复加载已加载插件。"""
        manager = PluginManager()
        manager.register_plugin(ConcretePlugin(name="p1"))
        await manager.load_plugin("p1")
        results = await manager.load_all()
        assert len(results) == 0

    def test_register_all_tools(self) -> None:
        """register_all_tools 应仅注册已启用插件的工具。"""
        manager = PluginManager()
        enabled = ConcretePlugin(name="enabled")
        disabled = ConcretePlugin(name="disabled")
        manager.register_plugin(enabled)
        manager.register_plugin(disabled)
        # 手动设置状态
        manager._states["enabled"] = PluginState.ENABLED
        manager._states["disabled"] = PluginState.DISABLED
        manager.register_all_tools(None)
        assert enabled._tools_registered is True
        assert disabled._tools_registered is False

    def test_get_dependencies(self) -> None:
        """get_dependencies 应返回正确的依赖列表。"""
        manager = PluginManager()
        plugin = ConcretePlugin(name="dep_plugin", dependencies=["base", "core"])
        manager.register_plugin(plugin)
        deps = manager.get_dependencies("dep_plugin")
        assert deps == ["base", "core"]

    def test_get_dependencies_nonexistent(self) -> None:
        """不存在的插件的依赖列表应为空。"""
        manager = PluginManager()
        assert manager.get_dependencies("nonexistent") == []

    def test_check_dependencies_satisfied(self) -> None:
        """依赖全部满足时应返回 (True, [])。"""
        manager = PluginManager()
        manager.register_plugin(ConcretePlugin(name="base"))
        manager.register_plugin(
            ConcretePlugin(name="app", dependencies=["base"])
        )
        satisfied, missing = manager.check_dependencies("app")
        assert satisfied is True
        assert missing == []

    def test_check_dependencies_missing(self) -> None:
        """依赖缺失时应返回 (False, missing_list)。"""
        manager = PluginManager()
        manager.register_plugin(
            ConcretePlugin(name="app", dependencies=["base", "missing_dep"])
        )
        satisfied, missing = manager.check_dependencies("app")
        assert satisfied is False
        assert "missing_dep" in missing
