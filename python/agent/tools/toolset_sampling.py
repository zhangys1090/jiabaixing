"""工具集概率分发（Toolset Sampling）。

对标 Hermes 的"工具集概率分布"能力：同一个场景不再只能确定性地绑定到
单一工具集，而是可以有一组候选工具集，按相对概率权重做**加权采样**，
让 Executor 在相似场景下拿到不同但合理的工具子集（探索/多样性）。

设计要点（对齐 AGENTS.md §0.1，Python 主实现；§0.3 "已完成"标准）：
  - 默认关闭（确定性行为完全不变），仅当显式开启才进入采样分支。
  - 纯函数 + 可注入 RNG（random.Random），测试可复现、不依赖全局随机态。
  - 权重恒为正，且被直接归一化为概率（weight 即相对概率，无 softmax/温度）。
  - 单候选场景与关闭状态都退化为确定性最高权重选择（零回归）。

Usage:
    sampler = ToolsetSampler()                     # 默认每场景 1 个主导工具集
    sampler.add_candidate("coding", "coding", 0.7)
    sampler.add_candidate("coding", "full", 0.3)   # 30% 概率拿到 full 工具集
    chosen = sampler.sample("coding")
"""

from __future__ import annotations

import os
import random
from dataclasses import dataclass

from agent.core.logger import StructuredLogger
log = StructuredLogger("toolset_sampling")


#: 通过该环境变量开启工具集概率分发（默认 off = 确定性行为）。
TOOLSET_SAMPLING_ENV = "AGENT_TOOLSET_SAMPLING"


@dataclass
class ToolsetCandidate:
    """场景下的一个候选工具集及其相对概率权重。

    Attributes:
        toolset_id: 候选工具集 ID（对应 ToolsetRegistry 中的定义）。
        weight: 相对概率权重（> 0）；同场景各候选按 weight 直接归一化为概率。
        disclosure_level: 该候选被选中时使用的披露等级（可选覆盖）。
    """

    toolset_id: str
    weight: float = 1.0
    disclosure_level: int | None = None

    def __post_init__(self) -> None:
        if self.weight <= 0:
            raise ValueError(f"候选工具集权重必须为正: {self.toolset_id}={self.weight}")


def parse_sampling_flag(value: str | None) -> bool:
    """解析开关环境变量；仅 on/true/1/yes 视为开启，其余（含缺省）关闭。"""
    if not value:
        return False
    return value.strip().lower() in ("on", "true", "1", "yes", "enabled")


def _normalize_weights(candidates: list[ToolsetCandidate]) -> list[float]:
    """按相对权重直接归一化为概率分布（weight 即相对概率）。"""
    total = sum(c.weight for c in candidates)
    if total <= 0:
        raise ValueError("候选权重之和必须为正数")
    return [c.weight / total for c in candidates]


class ToolsetSampler:
    """工具集加权概率采样器。

    每个场景持有一组候选工具集（带权重）。``sample`` 按 softmax 归一化权重
    做加权随机选择；关闭或单候选时退化为确定性最高权重选择。
    """

    def __init__(self, rng: random.Random | None = None) -> None:
        """初始化采样器。

        Args:
            rng: 可注入的随机源；默认新建一个（每次采样器独立）。
                测试可传固定种子的 ``random.Random(seed)`` 保证可复现。
        """
        self._candidates: dict[str, list[ToolsetCandidate]] = {}
        self._rng = rng or random.Random()

    # ─── 候选登记 ───

    def add_candidate(
        self,
        scene: str,
        toolset_id: str,
        weight: float = 1.0,
        disclosure_level: int | None = None,
    ) -> None:
        """为某场景添加一个候选工具集。重复 (scene, toolset_id) 会覆盖权重。"""
        cand = ToolsetCandidate(toolset_id=toolset_id, weight=weight, disclosure_level=disclosure_level)
        items = self._candidates.setdefault(scene, [])
        for i, existing in enumerate(items):
            if existing.toolset_id == toolset_id:
                items[i] = cand
                return
        items.append(cand)

    def set_candidates(self, scene: str, candidates: list[ToolsetCandidate]) -> None:
        """整体替换某场景的候选列表。"""
        if not candidates:
            self._candidates.pop(scene, None)
            return
        self._candidates[scene] = list(candidates)

    def get_candidates(self, scene: str) -> list[ToolsetCandidate]:
        return list(self._candidates.get(scene, []))

    def scenes(self) -> list[str]:
        return list(self._candidates.keys())

    # ─── 采样 ───

    def _pick(
        self,
        scene: str,
        rng: random.Random,
    ) -> ToolsetCandidate:
        """核心选择逻辑（纯函数式、可注入 RNG）。

        规则：
          - 无候选 → 抛 KeyError（调用方需保证场景有默认候选）。
          - 单候选 → 始终返回该候选（确定性）。
          - 多候选 → 按相对权重归一化后的概率加权随机。
        """
        cands = self._candidates.get(scene)
        if not cands:
            raise KeyError(f"场景无候选工具集: {scene}")
        if len(cands) == 1:
            return cands[0]
        probs = _normalize_weights(cands)
        chosen = rng.choices(cands, weights=probs, k=1)[0]
        return chosen

    def sample(
        self,
        scene: str,
        rng: random.Random | None = None,
    ) -> ToolsetCandidate:
        """按相对权重概率采样一个候选工具集。

        Args:
            scene: 场景名。
            rng: 可选临时随机源（不修改实例自带 rng）；用于单次可复现调用。

        Returns:
            ToolsetCandidate: 被选中的候选（含 toolset_id / 可选 disclosure_level）。
        """
        source = rng or self._rng
        chosen = self._pick(scene, source)
        log.debug(
            "工具集采样", scene=scene, toolset=chosen.toolset_id,
            weight=chosen.weight,
        )
        return chosen

    def deterministic_pick(self, scene: str) -> ToolsetCandidate:
        """确定性选择最高权重候选（采样关闭时的等价路径）。"""
        cands = self._candidates.get(scene)
        if not cands:
            raise KeyError(f"场景无候选工具集: {scene}")
        return max(cands, key=lambda c: c.weight)


def build_default_sampler() -> ToolsetSampler:
    """构建默认采样器：每个场景 1 个主导工具集（权重 1.0），行为与旧确定性映射一致。

    后续可由 SCENE_TOOLSET_CANDIDATES 扩展为真正的多候选分布。
    """
    sampler = ToolsetSampler()
    # 与 SCENE_TOOLSET_MAP 基本对齐，确保确定性路径结果与旧版一致。
    _DEFAULT_DOMINANT = {
        "coding": "coding",
        "desktop": "desktop",
        "development": "coding",
        "research": "network",
        "briefing": "full",
        "work": "full",
        "daily": "daily",
        "comfort": "minimal",
        "greeting": "minimal",
    }
    for scene, ts in _DEFAULT_DOMINANT.items():
        sampler.add_candidate(scene, ts, weight=1.0)
    return sampler
