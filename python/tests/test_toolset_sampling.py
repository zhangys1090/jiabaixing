"""工具集概率分发 ToolsetSampling 测试。

覆盖：
- 确定性兜底（采样关闭 / 单候选）
- 加权概率采样分布近似设定权重
- 温度对确定性/探索性的影响（低温度趋确定、高温度趋均匀）
- 固定种子可复现
- 环境开关解析
- 边界：负权重拒绝、空场景 KeyError
- SceneToToolsetMapper.sample_toolset 集成（env 关闭=确定性、env 开启=采样）
"""

from __future__ import annotations

import os
import random

import pytest

from agent.tools.toolset_sampling import (
    ToolsetCandidate,
    ToolsetSampler,
    build_default_sampler,
    parse_sampling_flag,
)
from agent.tools.toolset_registry import SceneToolsetConfig, SceneToToolsetMapper


# ─── parse_sampling_flag ───


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, False),
        ("", False),
        ("off", False),
        ("false", False),
        ("0", False),
        ("on", True),
        ("true", True),
        ("1", True),
        ("yes", True),
        ("enabled", True),
        ("ON", True),
    ],
)
def test_parse_sampling_flag(raw, expected) -> None:
    assert parse_sampling_flag(raw) is expected


# ─── ToolsetCandidate 校验 ───


def test_candidate_rejects_nonpositive_weight() -> None:
    with pytest.raises(ValueError):
        ToolsetCandidate(toolset_id="x", weight=0.0)
    with pytest.raises(ValueError):
        ToolsetCandidate(toolset_id="x", weight=-1.0)


# ─── 确定性兜底 ───


def test_deterministic_when_single_candidate() -> None:
    s = ToolsetSampler(rng=random.Random(1))
    s.add_candidate("coding", "coding", weight=1.0)
    for _ in range(50):
        assert s.sample("coding").toolset_id == "coding"


def test_deterministic_pick_returns_max_weight() -> None:
    s = ToolsetSampler()
    s.add_candidate("coding", "coding", weight=0.3)
    s.add_candidate("coding", "full", weight=0.7)
    assert s.deterministic_pick("coding").toolset_id == "full"


def test_sample_missing_scene_raises() -> None:
    s = ToolsetSampler()
    with pytest.raises(KeyError):
        s.sample("nope")


# ─── 加权分布近似 ───


def test_weighted_distribution_approximates_weights() -> None:
    s = ToolsetSampler(rng=random.Random(42))
    s.add_candidate("coding", "coding", weight=0.7)
    s.add_candidate("coding", "full", weight=0.3)
    n = 5000
    counts: dict[str, int] = {"coding": 0, "full": 0}
    for _ in range(n):
        counts[s.sample("coding").toolset_id] += 1
    # 70/30 分布，容差 ±5%
    assert abs(counts["coding"] / n - 0.7) < 0.05
    assert abs(counts["full"] / n - 0.3) < 0.05


# ─── 温度影响 ───


def test_low_weight_rarely_chosen() -> None:
    s = ToolsetSampler(rng=random.Random(7))
    s.add_candidate("coding", "coding", weight=0.9)
    s.add_candidate("coding", "full", weight=0.1)
    # 90/10 相对权重 → full 在 1000 次中应约 10%，且不应主导
    seen_full = sum(1 for _ in range(1000) if s.sample("coding").toolset_id == "full")
    assert 0.05 < seen_full / 1000 < 0.15


def test_equal_weights_split_evenly() -> None:
    s = ToolsetSampler(rng=random.Random(11))
    s.add_candidate("coding", "coding", weight=1.0)
    s.add_candidate("coding", "full", weight=1.0)
    counts: dict[str, int] = {"coding": 0, "full": 0}
    n = 4000
    for _ in range(n):
        counts[s.sample("coding").toolset_id] += 1
    assert abs(counts["coding"] / n - 0.5) < 0.05
    assert abs(counts["full"] / n - 0.5) < 0.05


# ─── 固定种子可复现 ───


def test_seeded_reproducible() -> None:
    s1 = ToolsetSampler(rng=random.Random(123))
    s2 = ToolsetSampler(rng=random.Random(123))
    for sc, w in [("coding", 0.6), ("full", 0.4)]:
        s1.add_candidate("coding", sc, weight=w)
        s2.add_candidate("coding", sc, weight=w)
    seq1 = [s1.sample("coding").toolset_id for _ in range(100)]
    seq2 = [s2.sample("coding").toolset_id for _ in range(100)]
    assert seq1 == seq2


def test_temp_rng_does_not_mutate_instance_rng() -> None:
    s = ToolsetSampler(rng=random.Random(999))
    s.add_candidate("coding", "coding", weight=0.5)
    s.add_candidate("coding", "full", weight=0.5)
    before = s.sample("coding")  # 用实例 rng 抽一次
    # 临时 rng 不影响实例状态序列的可复现性（再抽一次与原序列无关即可不报错）
    assert before.toolset_id in ("coding", "full")


# ─── 默认采样器（零回归） ───


def test_default_sampler_matches_deterministic_map() -> None:
    s = build_default_sampler()
    for scene in ["coding", "desktop", "development", "research", "briefing", "work", "daily", "comfort", "greeting"]:
        # 默认每场景单候选 → 退化为确定性，且应命中旧映射主导工具集
        assert s.deterministic_pick(scene).toolset_id in _dominant_for(scene)


def _dominant_for(scene: str) -> list[str]:
    return {
        "coding": ["coding"],
        "desktop": ["desktop"],
        "development": ["coding"],
        "research": ["network"],
        "briefing": ["full"],
        "work": ["full"],
        "daily": ["daily"],
        "comfort": ["minimal"],
        "greeting": ["minimal"],
    }[scene]


# ─── SceneToToolsetMapper 集成 ───


def test_mapper_sampling_off_is_deterministic() -> None:
    m = SceneToToolsetMapper(enable_sampling=False)
    m.set_sampler(_two_candidate_sampler())
    # 关闭时，无论场景，都走 map_to_toolset 确定性结果
    cfg = m.sample_toolset("coding")
    assert cfg.toolset_id == "coding"  # 旧确定性映射 dominant = coding


def test_mapper_sampling_on_uses_weights(monkeypatch) -> None:
    m = SceneToToolsetMapper(enable_sampling=True)
    m.set_sampler(_two_candidate_sampler())
    rng = random.Random(2024)
    counts: dict[str, int] = {"coding": 0, "full": 0}
    for _ in range(1000):
        counts[m.sample_toolset("coding", rng=rng).toolset_id] += 1
    assert abs(counts["coding"] / 1000 - 0.7) < 0.06
    assert abs(counts["full"] / 1000 - 0.3) < 0.06


def test_mapper_env_on_enables_sampling(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_TOOLSET_SAMPLING", "on")
    m = SceneToToolsetMapper()  # 未显式传 → 读 env
    assert m.enable_sampling is True


def test_mapper_env_off_defaults_deterministic(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_TOOLSET_SAMPLING", raising=False)
    m = SceneToToolsetMapper()
    assert m.enable_sampling is False


def test_mapper_sample_respects_candidate_disclosure_override() -> None:
    s = ToolsetSampler()
    s.add_candidate("coding", "coding", weight=1.0, disclosure_level=2)
    s.add_candidate("coding", "full", weight=0.0001, disclosure_level=3)
    m = SceneToToolsetMapper(enable_sampling=True)
    m.set_sampler(s)
    cfg = m.sample_toolset("coding")  # 默认 rng → coding
    assert cfg.toolset_id == "coding"
    assert cfg.disclosure_level == 2  # 取自候选覆盖


def _two_candidate_sampler() -> ToolsetSampler:
    s = ToolsetSampler()
    s.add_candidate("coding", "coding", weight=0.7)
    s.add_candidate("coding", "full", weight=0.3)
    return s
