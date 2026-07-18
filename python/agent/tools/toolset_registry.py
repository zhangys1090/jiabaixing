from __future__ import annotations

import os
import random
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import ToolCategory, ToolRegistry
from agent.tools.toolset_sampling import (
    ToolsetSampler,
    build_default_sampler,
    parse_sampling_flag,
)

log = StructuredLogger("toolset_registry")


@dataclass
class ToolsetEntry:
    """工具集条目——单个包含规则。

    Attributes:
        name: 工具名称，为None时匹配所有工具。
        category: 工具分类，为None时匹配所有分类。
    """

    name: str | None = None
    category: ToolCategory | None = None


@dataclass
class ToolsetDefinition:
    """工具集定义——按场景预组装的工具包。

    Attributes:
        id: 唯一标识。
        display_name: 显示名称。
        description: 描述。
        includes: 包含的工具列表（名称或分类）。
        excludes: 排除的工具名称列表。
        extends: 继承的父工具集ID。
        max_tools: 最大工具数限制，0表示不限制。
    """

    id: str
    display_name: str
    description: str
    includes: list[ToolsetEntry] = field(default_factory=list)
    excludes: list[str] = field(default_factory=list)
    extends: str | None = None
    max_tools: int = 0


@dataclass
class ResolvedToolset:
    """解析后的工具集——已展开所有继承和分类。

    Attributes:
        id: 工具集ID。
        display_name: 显示名称。
        tool_names: 最终解析出的工具名称列表。
        resolved_from: 解析链（包含继承的父工具集）。
    """

    id: str
    display_name: str
    tool_names: list[str]
    resolved_from: list[str]


class ToolsetRegistry:
    """工具集注册中心。

    管理工具集的注册、继承和解析。支持按名称/分类包含工具、
    按名称排除工具、继承父工具集和工具数量上限。

    Usage:
        registry = ToolsetRegistry()
        registry.register(ToolsetDefinition(
            id="code", display_name="编码工具", description="...",
            includes=[ToolsetEntry(category=ToolCategory.CODE)],
        ))
        resolved = registry.resolve("code", tool_registry)
    """
    def __init__(self) -> None:
        self._definitions: dict[str, ToolsetDefinition] = {}
        self._resolved_cache: dict[str, ResolvedToolset] = {}

    def register(self, definition: ToolsetDefinition) -> None:
        if definition.id in self._definitions:
            log.debug(f"工具集已存在，覆盖: {definition.id}")
        self._definitions[definition.id] = definition
        self._resolved_cache.pop(definition.id, None)
        log.info(f"注册工具集: {definition.id} ({definition.display_name})")

    def get(self, id: str) -> ToolsetDefinition | None:
        return self._definitions.get(id)

    def list(self) -> list[str]:
        return list(self._definitions.keys())

    def resolve(self, id: str, tool_registry: ToolRegistry) -> ResolvedToolset | None:
        if id in self._resolved_cache:
            return self._resolved_cache[id]

        definition = self._definitions.get(id)
        if not definition:
            log.warning(f"工具集不存在: {id}")
            return None

        resolved_from: list[str] = []
        tool_name_set: set[str] = set()

        if definition.extends:
            parent = self.resolve(definition.extends, tool_registry)
            if parent:
                resolved_from.extend(parent.resolved_from)
                for name in parent.tool_names:
                    tool_name_set.add(name)

        resolved_from.append(definition.id)

        for entry in definition.includes:
            if entry.name:
                if tool_registry.has(entry.name):
                    tool_name_set.add(entry.name)
                else:
                    log.warning(f"工具集 {id} 引用了不存在的工具: {entry.name}")
            elif entry.category:
                tools = tool_registry.get_by_category(entry.category)
                for t in tools:
                    tool_name_set.add(t.name)

        for name in definition.excludes:
            tool_name_set.discard(name)

        tool_names = list(tool_name_set)

        if definition.max_tools and definition.max_tools > 0 and len(tool_names) > definition.max_tools:
            tool_names = tool_names[:definition.max_tools]

        resolved = ResolvedToolset(
            id=definition.id,
            display_name=definition.display_name,
            tool_names=tool_names,
            resolved_from=resolved_from,
        )

        self._resolved_cache[id] = resolved
        return resolved

    def resolve_to_openai(self, id: str, tool_registry: ToolRegistry) -> list[dict[str, Any]]:
        resolved = self.resolve(id, tool_registry)
        if not resolved:
            return []

        all_openai_tools = tool_registry.to_openai_tools()
        name_set = set(resolved.tool_names)

        return [
            t for t in all_openai_tools
            if t.get("function", {}).get("name") in name_set
        ]

    def invalidate_cache(self, id: str | None = None) -> None:
        if id:
            self._resolved_cache.pop(id, None)
        else:
            self._resolved_cache.clear()


_global_toolset_registry: ToolsetRegistry | None = None


def get_toolset_registry() -> ToolsetRegistry:
    global _global_toolset_registry
    if _global_toolset_registry is None:
        _global_toolset_registry = ToolsetRegistry()
    return _global_toolset_registry


def reset_toolset_registry() -> None:
    global _global_toolset_registry
    _global_toolset_registry = None


# ==================== 场景→工具集映射 ====================


@dataclass
class SceneToolsetConfig:
    """场景到工具集的映射配置。

    Attributes:
        toolset_id: 对应的工具集ID。
        disclosure_level: 渐进式披露等级 1-3。
        tags: 该场景下优先暴露的工具标签。
        exclude_categories: 排除的工具分类。
    """

    toolset_id: str
    disclosure_level: int = 2
    tags: list[str] = field(default_factory=list)
    exclude_categories: list[str] = field(default_factory=list)


SCENE_TOOLSET_MAP: dict[str, SceneToolsetConfig] = {
    "coding": SceneToolsetConfig(
        toolset_id="coding",
        disclosure_level=3,
        tags=["code", "git", "file", "shell", "debug", "test", "review"],
        exclude_categories=["desktop", "daily"],
    ),
    "desktop": SceneToolsetConfig(
        toolset_id="desktop",
        disclosure_level=2,
        tags=["desktop", "automation", "screenshot", "window", "input"],
        exclude_categories=["code"],
    ),
    "development": SceneToolsetConfig(
        toolset_id="coding",
        disclosure_level=3,
        tags=["code", "git", "file", "shell", "debug", "test", "review", "deploy"],
        exclude_categories=["desktop", "daily"],
    ),
    "research": SceneToolsetConfig(
        toolset_id="network",
        disclosure_level=2,
        tags=["search", "web", "fetch", "knowledge", "analysis"],
    ),
    "briefing": SceneToolsetConfig(
        toolset_id="full",
        disclosure_level=2,
        tags=["summary", "report", "analysis", "file", "search"],
    ),
    "work": SceneToolsetConfig(
        toolset_id="full",
        disclosure_level=2,
        tags=["project", "file", "search", "schedule", "report"],
    ),
    "daily": SceneToolsetConfig(
        toolset_id="daily",
        disclosure_level=1,
        tags=["memory", "note", "schedule", "search"],
    ),
    "comfort": SceneToolsetConfig(
        toolset_id="minimal",
        disclosure_level=1,
        tags=["memory", "chat"],
    ),
    "greeting": SceneToolsetConfig(
        toolset_id="minimal",
        disclosure_level=1,
        tags=["chat"],
    ),
}

SCENE_KEYWORDS: dict[str, list[str]] = {
    "coding": [
        "代码", "编程", "开发", "调试", "bug", "函数", "接口", "api",
        "重构", "部署", "git", "commit", "test", "测试", "编译", "build",
        "npm", "yarn", "pnpm", "import", "export", "class", "类型",
        "typescript", "python", "react", "node", "修复", "优化",
    ],
    "desktop": [
        "桌面", "窗口", "截图", "自动化", "鼠标", "键盘", "点击",
        "打开应用", "关闭", "最小化", "最大化", "切换",
    ],
    "research": [
        "搜索", "查找", "研究", "了解", "调查", "比较", "分析",
        "有什么", "推荐", "最新", "新闻", "资料",
    ],
    "briefing": [
        "简报", "总结", "日报", "周报", "进度", "汇报", "报告",
        "生成报告", "写总结",
    ],
    "work": [
        "工作", "项目", "排期", "会议", "汇报", "方案", "需求", "上线",
        "任务",
    ],
    "comfort": [
        "难过", "烦", "累", "焦虑", "压力", "不开心", "心情", "崩溃", "安慰",
    ],
    "greeting": [
        "你好", "早上好", "晚安", "嗨", "hello", "hi", "hey",
    ],
}


class SceneToToolsetMapper:
    """场景感知 → 工具集选择。

    将场景检测和环境感知统一映射为工具集ID，
    支持渐进式工具披露。

    数据流:
        用户输入 + 环境状态
            → detect_scene() 场景检测
            → map_to_toolset() 场景→工具集（确定性兜底）
            → sample_toolset() 工具集概率分发（默认关闭，见 enable_sampling）
            → apply_disclosure_level() 渐进式披露
            → Executor 使用过滤后的工具集

    工具集概率分发（R2，对标 Hermes 工具集分布）：
      - 默认 enable_sampling=False,行为与旧版完全一致（确定性）。
      - 设 AGENT_TOOLSET_SAMPLING=on 后,同一场景按权重 + 温度做加权采样,
        可在相似场景下拿到不同但合理的工具子集（探索/多样性）。
      - 采样器可注入多候选 + 固定种子,测试可复现。
    """

    def __init__(self, enable_sampling: bool | None = None) -> None:
        self._active_env: str = "unknown"
        if enable_sampling is None:
            enable_sampling = parse_sampling_flag(os.environ.get("AGENT_TOOLSET_SAMPLING"))
        self.enable_sampling: bool = enable_sampling
        self._sampler: ToolsetSampler = build_default_sampler()

    # ─── 采样器配置 ───

    @property
    def sampler(self) -> ToolsetSampler:
        return self._sampler

    def set_sampler(self, sampler: ToolsetSampler) -> None:
        self._sampler = sampler

    def set_sampling_enabled(self, enabled: bool) -> None:
        self.enable_sampling = enabled

    def detect_scene(self, input_text: str, env: str | None = None) -> str:
        """从用户输入和环境状态检测场景。"""
        input_lower = input_text.lower()

        best_scene = "daily"
        best_score = 0

        for scene, keywords in SCENE_KEYWORDS.items():
            score = sum(1 for kw in keywords if kw in input_lower)
            if score > best_score:
                best_score = score
                best_scene = scene

        if env and env in ("coding", "browsing"):
            if best_score == 0:
                best_scene = "coding" if env == "coding" else "research"

        return best_scene

    def map_to_toolset(self, scene: str) -> SceneToolsetConfig:
        """将场景映射到工具集配置（确定性兜底）。"""
        return SCENE_TOOLSET_MAP.get(scene, SceneToolsetConfig(
            toolset_id="base",
            disclosure_level=1,
            tags=["memory", "search"],
        ))

    def apply_disclosure_level(
        self,
        input_text: str,
        config: SceneToolsetConfig,
    ) -> SceneToolsetConfig:
        """根据输入复杂度调整披露等级。"""
        complexity_indicators = [
            "同时", "多个", "批量", "重构", "架构", "系统",
            "all", "multiple", "refactor", "architecture",
        ]
        input_lower = input_text.lower()
        is_complex = any(ind in input_lower for ind in complexity_indicators)

        adjusted_level = config.disclosure_level
        if is_complex and config.disclosure_level < 3:
            adjusted_level = config.disclosure_level + 1

        return SceneToolsetConfig(
            toolset_id=config.toolset_id,
            disclosure_level=adjusted_level,
            tags=config.tags,
            exclude_categories=config.exclude_categories,
        )

    def sample_toolset(
        self,
        scene: str,
        rng: "random.Random | None" = None,
    ) -> SceneToolsetConfig:
        """概率分发入口：返回该场景应选用的工具集配置。

        行为：
          - enable_sampling=False 或场景无多候选 → 退化为确定性 map_to_toolset(scene)。
          - enable_sampling=True 且场景有多候选 → 按相对权重归一化后加权采样。

        Args:
            scene: 已检测出的场景名。
            rng: 可选临时随机源（不改动映射器自带 rng），单次调用可复现。

        Returns:
            SceneToolsetConfig: 选中工具集的配置（含 toolset_id / disclosure_level 等）。
        """
        if not self.enable_sampling:
            return self.map_to_toolset(scene)

        candidates = self._sampler.get_candidates(scene)
        if len(candidates) <= 1:
            # 单候选或无候选：与确定性路径一致，避免引入随机性。
            return self.map_to_toolset(scene)

        chosen = self._sampler.sample(scene, rng=rng)
        base = SCENE_TOOLSET_MAP.get(
            scene,
            SceneToolsetConfig(toolset_id="base", disclosure_level=1, tags=["memory", "search"]),
        )
        return SceneToolsetConfig(
            toolset_id=chosen.toolset_id,
            # 候选可覆盖披露等级；否则沿用场景基准。
            disclosure_level=chosen.disclosure_level
            if chosen.disclosure_level is not None
            else base.disclosure_level,
            tags=base.tags,
            exclude_categories=base.exclude_categories,
        )

    def resolve(
        self,
        input_text: str,
        env: str | None = None,
    ) -> dict[str, Any]:
        """完整映射流程: 输入 → 场景检测 → 工具集配置 → 渐进式披露。

        确定性路径（采样关闭或单候选）。开启采样时建议改用 sample_toolset
        获取到的 toolset_id 再走 apply_disclosure_level。

        Returns:
            包含 toolset_id, disclosure_level, tags, exclude_categories, scene 的字典。
        """
        scene = self.detect_scene(input_text, env)
        base_config = self.map_to_toolset(scene)
        config = self.apply_disclosure_level(input_text, base_config)

        return {
            "toolset_id": config.toolset_id,
            "disclosure_level": config.disclosure_level,
            "tags": config.tags,
            "exclude_categories": config.exclude_categories,
            "scene": scene,
        }

    def update_env(self, env: str) -> None:
        """更新当前环境状态。"""
        self._active_env = env

    def get_env(self) -> str:
        """获取当前环境状态。"""
        return self._active_env
