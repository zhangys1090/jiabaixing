"""Profile 配置管理。

管理用户配置档案（Profile），支持多配置切换：
  - 多 Profile 管理（工作/个人/测试等）
  - 模型偏好配置
  - 平台连接配置
  - 技能白名单/黑名单
  - 导入/导出配置

与 AgentEngine 的关系：
  - AgentEngine 启动时加载 active profile
  - 运行时可通过 /profile 命令切换
  - 各 Profile 独立维护凭据和偏好

集成示例::

    from agent.cli.profile_manager import ProfileManager

    mgr = ProfileManager()
    mgr.create_profile("work", model="gpt-4o", platforms=["slack", "email"])
    mgr.switch_profile("work")
    config = mgr.get_active_config()
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.config import DATA_ROOT
from agent.core.logger import StructuredLogger

log = StructuredLogger("profile_manager")


_PROFILES_DIR = DATA_ROOT / "profiles"


@dataclass
class ModelPreference:
    default: str = "openai/gpt-4o-mini"
    fallback: str = "openai/gpt-3.5-turbo"
    vision: str = "openai/gpt-4o"
    embedding: str = "text-embedding-3-small"
    temperature: float = 0.7
    max_tokens: int = 4096
    top_p: float = 1.0


@dataclass
class PlatformConfig:
    enabled: list[str] = field(default_factory=lambda: ["webhook"])
    configs: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass
class SkillPolicy:
    whitelist: list[str] = field(default_factory=list)
    blacklist: list[str] = field(default_factory=list)
    auto_load: bool = True
    max_skills: int = 50


@dataclass
class MemoryConfig:
    max_short_term: int = 10
    max_long_term: int = 1000
    decay_days: int = 30
    auto_compress: bool = True


@dataclass
class ProfileConfig:
    name: str = "default"
    display_name: str = "默认配置"
    model: ModelPreference = field(default_factory=ModelPreference)
    platforms: PlatformConfig = field(default_factory=PlatformConfig)
    skills: SkillPolicy = field(default_factory=SkillPolicy)
    memory: MemoryConfig = field(default_factory=MemoryConfig)
    language: str = "zh-CN"
    theme: str = "dark"
    created_at: float = 0.0
    updated_at: float = 0.0

    def __post_init__(self) -> None:
        now = time.time()
        if self.created_at == 0.0:
            self.created_at = now
        if self.updated_at == 0.0:
            self.updated_at = now

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "model": {
                "default": self.model.default,
                "fallback": self.model.fallback,
                "vision": self.model.vision,
                "embedding": self.model.embedding,
                "temperature": self.model.temperature,
                "max_tokens": self.model.max_tokens,
                "top_p": self.model.top_p,
            },
            "platforms": {
                "enabled": self.platforms.enabled,
                "configs": self.platforms.configs,
            },
            "skills": {
                "whitelist": self.skills.whitelist,
                "blacklist": self.skills.blacklist,
                "auto_load": self.skills.auto_load,
                "max_skills": self.skills.max_skills,
            },
            "memory": {
                "max_short_term": self.memory.max_short_term,
                "max_long_term": self.memory.max_long_term,
                "decay_days": self.memory.decay_days,
                "auto_compress": self.memory.auto_compress,
            },
            "language": self.language,
            "theme": self.theme,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProfileConfig:
        model_data = data.get("model", {})
        platforms_data = data.get("platforms", {})
        skills_data = data.get("skills", {})
        memory_data = data.get("memory", {})

        return cls(
            name=data.get("name", "default"),
            display_name=data.get("display_name", ""),
            model=ModelPreference(
                default=model_data.get("default", "openai/gpt-4o-mini"),
                fallback=model_data.get("fallback", "openai/gpt-3.5-turbo"),
                vision=model_data.get("vision", "openai/gpt-4o"),
                embedding=model_data.get("embedding", "text-embedding-3-small"),
                temperature=model_data.get("temperature", 0.7),
                max_tokens=model_data.get("max_tokens", 4096),
                top_p=model_data.get("top_p", 1.0),
            ),
            platforms=PlatformConfig(
                enabled=platforms_data.get("enabled", ["webhook"]),
                configs=platforms_data.get("configs", {}),
            ),
            skills=SkillPolicy(
                whitelist=skills_data.get("whitelist", []),
                blacklist=skills_data.get("blacklist", []),
                auto_load=skills_data.get("auto_load", True),
                max_skills=skills_data.get("max_skills", 50),
            ),
            memory=MemoryConfig(
                max_short_term=memory_data.get("max_short_term", 10),
                max_long_term=memory_data.get("max_long_term", 1000),
                decay_days=memory_data.get("decay_days", 30),
                auto_compress=memory_data.get("auto_compress", True),
            ),
            language=data.get("language", "zh-CN"),
            theme=data.get("theme", "dark"),
            created_at=data.get("created_at", 0.0),
            updated_at=data.get("updated_at", 0.0),
        )


class ProfileManager:
    """配置档案管理器。

    管理多个用户配置档案，支持创建、切换、导入导出。
    """

    def __init__(self, profiles_dir: Path | None = None) -> None:
        self._dir = profiles_dir or _PROFILES_DIR
        self._profiles: dict[str, ProfileConfig] = {}
        self._active: str = "default"
        self._load_profiles()

    def _load_profiles(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        for fp in self._dir.glob("*.json"):
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
                config = ProfileConfig.from_dict(data)
                self._profiles[config.name] = config
            except Exception as e:
                log.warning("加载 Profile 失败", file=str(fp), error=str(e))

        if "default" not in self._profiles:
            self._profiles["default"] = ProfileConfig()

    def _save_profile(self, config: ProfileConfig) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        fp = self._dir / f"{config.name}.json"
        fp.write_text(json.dumps(config.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")

    def create_profile(
        self,
        name: str,
        display_name: str = "",
        model: str = "",
        platforms: list[str] | None = None,
        **kwargs: Any,
    ) -> ProfileConfig:
        if name in self._profiles:
            raise ValueError(f"Profile '{name}' 已存在")

        config = ProfileConfig(
            name=name,
            display_name=display_name or name,
        )
        if model:
            config.model.default = model
        if platforms:
            config.platforms.enabled = platforms

        for k, v in kwargs.items():
            if hasattr(config, k):
                setattr(config, k, v)

        self._profiles[name] = config
        self._save_profile(config)
        log.info("Profile 已创建", name=name)
        return config

    def delete_profile(self, name: str) -> bool:
        if name == "default":
            raise ValueError("不能删除默认 Profile")
        config = self._profiles.pop(name, None)
        if config is None:
            return False
        fp = self._dir / f"{name}.json"
        if fp.exists():
            fp.unlink()
        if self._active == name:
            self._active = "default"
        return True

    def switch_profile(self, name: str) -> ProfileConfig:
        if name not in self._profiles:
            raise ValueError(f"Profile '{name}' 不存在")
        self._active = name
        log.info("已切换 Profile", name=name)
        return self._profiles[name]

    def get_active_config(self) -> ProfileConfig:
        return self._profiles.get(self._active, self._profiles["default"])

    def get_active_name(self) -> str:
        return self._active

    def get_profile(self, name: str) -> ProfileConfig | None:
        return self._profiles.get(name)

    def list_profiles(self) -> list[dict[str, Any]]:
        result = []
        for name, config in self._profiles.items():
            result.append({
                "name": name,
                "display_name": config.display_name,
                "model": config.model.default,
                "platforms": config.platforms.enabled,
                "active": name == self._active,
                "language": config.language,
            })
        return result

    def update_profile(self, name: str, **kwargs: Any) -> ProfileConfig:
        config = self._profiles.get(name)
        if config is None:
            raise ValueError(f"Profile '{name}' 不存在")

        for k, v in kwargs.items():
            if k == "model_default":
                config.model.default = v
            elif k == "model_fallback":
                config.model.fallback = v
            elif k == "temperature":
                config.model.temperature = v
            elif k == "language":
                config.language = v
            elif k == "theme":
                config.theme = v
            elif hasattr(config, k):
                setattr(config, k, v)

        config.updated_at = time.time()
        self._save_profile(config)
        return config

    def export_profile(self, name: str) -> str:
        config = self._profiles.get(name)
        if config is None:
            raise ValueError(f"Profile '{name}' 不存在")
        return json.dumps(config.to_dict(), ensure_ascii=False, indent=2)

    def import_profile(self, json_str: str, name: str = "") -> ProfileConfig:
        data = json.loads(json_str)
        if name:
            data["name"] = name
        config = ProfileConfig.from_dict(data)
        self._profiles[config.name] = config
        self._save_profile(config)
        log.info("Profile 已导入", name=config.name)
        return config
