"""国际化(i18n)模块，提供多语言翻译支持。

支持动态切换语言、参数替换翻译、从 JSON 文件加载翻译字典。
内置 zh-CN / en-US 两种语言的常用翻译。

Usage:
    i18n = I18n("zh-CN")
    text = i18n.t("tool.executing", tool="搜索")
    # => "正在执行 搜索..."
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent.core.logger import get_logger

logger = get_logger("i18n")

# ---------------------------------------------------------------------------
# 内置翻译字典
# ---------------------------------------------------------------------------

BUILTIN_ZH_CN: dict[str, str] = {
    # 系统
    "system.name": "家百星",
    "system.welcome": "欢迎使用家百星 AI 助手",
    "system.goodbye": "再见！",
    # 错误
    "error.generic": "操作失败",
    "error.network": "网络连接失败",
    "error.timeout": "操作超时",
    "error.permission": "权限不足",
    "error.not_found": "未找到相关内容",
    # 工具
    "tool.executing": "正在执行 {tool}...",
    "tool.completed": "{tool} 执行完成",
    "tool.failed": "{tool} 执行失败: {error}",
    "tool.approval_needed": "{tool} 需要审批",
    # 记忆
    "memory.stored": "已记住: {content}",
    "memory.recalled": "回忆: {content}",
    "memory.not_found": "未找到相关记忆",
    # 会话
    "session.new": "新会话已创建",
    "session.saved": "会话已保存",
    "session.search.results": "找到 {count} 条相关会话",
    # 安全
    "security.warning": "安全警告: {message}",
    "security.confirm": "请确认: {message}",
    # 预算
    "budget.warning": "预算警告: 已使用 {percentage}%",
    "budget.exceeded": "预算已超限",
}

BUILTIN_EN_US: dict[str, str] = {
    "system.name": "Jiabaixing",
    "system.welcome": "Welcome to Jiabaixing AI Assistant",
    "system.goodbye": "Goodbye!",
    "error.generic": "Operation failed",
    "error.network": "Network connection failed",
    "error.timeout": "Operation timed out",
    "error.permission": "Permission denied",
    "error.not_found": "Not found",
    "tool.executing": "Executing {tool}...",
    "tool.completed": "{tool} completed",
    "tool.failed": "{tool} failed: {error}",
    "tool.approval_needed": "{tool} requires approval",
    "memory.stored": "Remembered: {content}",
    "memory.recalled": "Recalled: {content}",
    "memory.not_found": "No relevant memory found",
    "session.new": "New session created",
    "session.saved": "Session saved",
    "session.search.results": "Found {count} related sessions",
    "security.warning": "Security warning: {message}",
    "security.confirm": "Please confirm: {message}",
    "budget.warning": "Budget warning: {percentage}% used",
    "budget.exceeded": "Budget exceeded",
}


class I18n:
    """国际化管理器，提供多语言翻译支持。

    支持运行时切换语言、参数替换、动态添加翻译字典、从 JSON 文件加载翻译。
    内置 zh-CN / en-US 翻译，开箱即用。

    Attributes:
        _default_locale: 默认语言。
        _current_locale: 当前语言。
        _translations: 语言 -> 翻译字典 的映射。

    Usage:
        i18n = I18n("zh-CN")
        i18n.t("system.welcome")  # => "欢迎使用家百星 AI 助手"
        i18n.set_locale("en-US")
        i18n.t("system.welcome")  # => "Welcome to Jiabaixing AI Assistant"
    """

    def __init__(self, default_locale: str = "zh-CN") -> None:
        """初始化国际化管理器。

        Args:
            default_locale: 默认语言，默认为 "zh-CN"。
        """
        self._default_locale: str = default_locale
        self._current_locale: str = default_locale
        self._translations: dict[str, dict[str, str]] = {
            "zh-CN": dict(BUILTIN_ZH_CN),
            "en-US": dict(BUILTIN_EN_US),
        }

    def set_locale(self, locale: str) -> None:
        """设置当前语言。

        Args:
            locale: 语言标识，如 "zh-CN"、"en-US"。
        """
        self._current_locale = locale
        logger.info(f"Locale set to {locale}")

    def get_locale(self) -> str:
        """获取当前语言。

        Returns:
            str: 当前语言标识。
        """
        return self._current_locale

    def t(self, key: str, **kwargs: Any) -> str:
        """翻译文本，支持参数替换。

        若 key 在当前语言中不存在，则回退到默认语言；
        若默认语言也不存在，则返回 key 本身。

        Args:
            key: 翻译键，如 "system.welcome"。
            **kwargs: 模板参数，如 name="张三"。

        Returns:
            str: 翻译后的文本。
        """
        template = self._get_template(key)
        if template is None:
            logger.debug(f"Translation key not found: {key}")
            return key
        try:
            return template.format(**kwargs)
        except KeyError:
            # 模板参数不完整时返回原始模板
            logger.warning(f"Missing format args for key={key}, template={template}")
            return template

    def add_translations(self, locale: str, translations: dict[str, str]) -> None:
        """添加翻译字典到指定语言。

        若语言已存在，则合并覆盖同键条目。

        Args:
            locale: 语言标识。
            translations: 翻译字典，键为翻译键，值为翻译文本。
        """
        if locale not in self._translations:
            self._translations[locale] = {}
        self._translations[locale].update(translations)
        logger.info(f"Added {len(translations)} translations for {locale}")

    def load_translations(self, path: str) -> None:
        """从 JSON 文件加载翻译。

        JSON 文件格式应为 ``{"locale": {"key": "value", ...}, ...}``，
        例如::

            {
                "zh-CN": {"greeting": "你好"},
                "en-US": {"greeting": "Hello"}
            }

        Args:
            path: JSON 文件的路径。
        """
        file_path = Path(path)
        if not file_path.exists():
            logger.error(f"Translations file not found: {path}")
            return
        try:
            data: dict[str, dict[str, str]] = json.loads(file_path.read_text(encoding="utf-8"))
            for locale, translations in data.items():
                self.add_translations(locale, translations)
            logger.info(f"Loaded translations from {path}")
        except (json.JSONDecodeError, OSError) as exc:
            logger.error(f"Failed to load translations from {path}: {exc}")

    def list_locales(self) -> list[str]:
        """列出所有可用语言。

        Returns:
            list[str]: 语言标识列表。
        """
        return sorted(self._translations.keys())

    def has_key(self, key: str, locale: str | None = None) -> bool:
        """检查翻译键是否存在。

        Args:
            key: 翻译键。
            locale: 语言标识，为 None 时使用当前语言。

        Returns:
            bool: 翻译键是否存在。
        """
        target = locale or self._current_locale
        translations = self._translations.get(target, {})
        return key in translations

    # ------------------------------------------------------------------
    # 私有方法
    # ------------------------------------------------------------------

    def _get_template(self, key: str) -> str | None:
        """获取翻译模板，依次从当前语言和默认语言中查找。

        Args:
            key: 翻译键。

        Returns:
            str | None: 翻译模板，未找到时返回 None。
        """
        # 优先当前语言
        translations = self._translations.get(self._current_locale, {})
        if key in translations:
            return translations[key]
        # 回退默认语言
        if self._current_locale != self._default_locale:
            translations = self._translations.get(self._default_locale, {})
            if key in translations:
                return translations[key]
        return None


# ---------------------------------------------------------------------------
# 全局单例
# ---------------------------------------------------------------------------

_global_i18n: I18n | None = None


def get_i18n() -> I18n:
    """获取全局 I18n 单例。

    Returns:
        I18n: 全局国际化管理器实例。
    """
    global _global_i18n
    if _global_i18n is None:
        _global_i18n = I18n()
    return _global_i18n
