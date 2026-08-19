from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from agent.config import DATA_DIR
from agent.core.logger import log_ignored


def _as_set(exclude: str | set[str] | None) -> set[str]:
    """把 ``exclude`` 归一为名称集合：None→空集，str→单元素集合，set→原样。"""
    if exclude is None:
        return set()
    if isinstance(exclude, str):
        return {exclude}
    return set(exclude)


class ProviderConfig:
    def __init__(
        self,
        name: str,
        display_name: str = "",
        base_url: str = "",
        api_key: str = "",
        model: str = "",
        enabled: bool = True,
        priority: int = 0,
        extra: dict[str, Any] | None = None,
    ):
        self.name = name
        self.display_name = display_name or name
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.enabled = enabled
        self.priority = priority
        self.extra = extra or {}
        self.last_health_check: float | None = None
        self.healthy: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "base_url": self.base_url,
            "api_key": self.api_key,
            "model": self.model,
            "enabled": self.enabled,
            "priority": self.priority,
            "extra": self.extra,
            "last_health_check": self.last_health_check,
            "healthy": self.healthy,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProviderConfig:
        p = cls(
            name=data["name"],
            display_name=data.get("display_name", ""),
            base_url=data.get("base_url", ""),
            api_key=data.get("api_key", ""),
            model=data.get("model", ""),
            enabled=data.get("enabled", True),
            priority=data.get("priority", 0),
            extra=data.get("extra"),
        )
        p.last_health_check = data.get("last_health_check")
        p.healthy = data.get("healthy")
        return p


class ProviderManager:
    def __init__(self, data_dir: str | Path | None = None):
        self._dir = Path(data_dir) if data_dir else DATA_DIR
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / "providers.json"
        self._providers: dict[str, ProviderConfig] = {}
        self._primary: str | None = None
        # 可选挂载的能力驱动路由器（不破坏既有 get_primary 行为）
        self._cap_router = None
        self._load()

    def set_capability_router(self, router) -> None:
        """挂载 ``CapabilityAwareRouter`` 以支持任务级选型（增强 LLM 底座）。"""
        self._cap_router = router

    def select_for_task(self, requirement):
        """按任务能力诉求选型；未挂载路由器或选型失败则返回 None（回退 get_primary）。

        返回 ``ScoredProvider`` 或 ``None``。
        """
        if self._cap_router is None:
            return None
        candidates = [p.name for p in self._providers.values() if p.enabled]
        return self._cap_router.select(requirement, candidates=candidates)

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            for p in data.get("providers", []):
                cfg = ProviderConfig.from_dict(p)
                self._providers[cfg.name] = cfg
            self._primary = data.get("primary")
        except (json.JSONDecodeError, KeyError) as _exc:
            log_ignored(None, "router.ProviderManager._load", _exc)

    def _save(self) -> None:
        data = {
            "providers": [p.to_dict() for p in self._providers.values()],
            "primary": self._primary,
        }
        self._path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def register(self, config: ProviderConfig) -> None:
        self._providers[config.name] = config
        if self._primary is None:
            self._primary = config.name
        self._save()

    def unregister(self, name: str) -> bool:
        if name not in self._providers:
            return False
        del self._providers[name]
        if self._primary == name:
            self._primary = next(iter(self._providers), None)
        self._save()
        return True

    def get_primary(self) -> ProviderConfig | None:
        if self._primary and self._primary in self._providers:
            return self._providers[self._primary]
        for p in sorted(self._providers.values(), key=lambda x: x.priority):
            if p.enabled:
                return p
        return None

    def set_primary(self, name: str) -> bool:
        if name not in self._providers:
            return False
        self._primary = name
        self._save()
        return True

    def list_providers(self) -> list[ProviderConfig]:
        return list(self._providers.values())

    def get_fallback(self, exclude: str | set[str] | None = None) -> ProviderConfig | None:
        """返回优先级最高的「可用且未被排除」的 Provider。

        修复旧实现的致命缺陷：旧代码在调用点传 ``exclude=None`` 时会把
        刚刚失败的 primary（最高优先级）再次选中，导致跨厂商故障转移
        实际不发生。新实现接受单名或名称集合，稳定跳过已失败的 Provider。

        Args:
            exclude: 需排除的 Provider 名称；可为单个字符串或名称集合，
                ``None`` 表示不排除任何 Provider（返回最高优先级启用项）。
        """
        excluded = _as_set(exclude)
        for p in sorted(self._providers.values(), key=lambda x: x.priority):
            if p.enabled and p.name not in excluded:
                return p
        return None

    def fallback_chain(self, exclude: str | set[str] | None = None) -> list[ProviderConfig]:
        """返回按优先级排序的候选 Provider 链（已排除指定项）。

        供调用方做跨厂商重试 / 退避：第一个元素即最高优先级启用 Provider，
        此后依次为次优 Provider，直至穷尽。空 exclude 时包含全部启用项。
        """
        excluded = _as_set(exclude)
        return [
            p
            for p in sorted(self._providers.values(), key=lambda x: x.priority)
            if p.enabled and p.name not in excluded
        ]
