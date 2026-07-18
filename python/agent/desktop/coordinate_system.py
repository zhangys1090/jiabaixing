"""
归一化坐标系统 — 与 TS 端 NormalizedCoordinates.ts 对齐

Anthropic Computer Use / UI-TARS 行业标准：
  归一化坐标范围 [0, 1000] × [0, 1000]
  LLM 输出归一化坐标，由本模块转换为绝对像素坐标后执行

TS 端实现: src/desktop/NormalizedCoordinates.ts (已完成)
Python 端实现: 本文件 (补齐)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

NORMALIZED_MAX = 1000


@dataclass(frozen=True)
class NormalizedPoint:
    """归一化坐标点 [0, 1000]"""
    x: int
    y: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "x", max(0, min(NORMALIZED_MAX, self.x)))
        object.__setattr__(self, "y", max(0, min(NORMALIZED_MAX, self.y)))

    def to_pixel(self, screen_width: int, screen_height: int) -> Tuple[int, int]:
        return (
            int(self.x / NORMALIZED_MAX * screen_width),
            int(self.y / NORMALIZED_MAX * screen_height),
        )

    def is_within_screen(self) -> bool:
        return 0 <= self.x <= NORMALIZED_MAX and 0 <= self.y <= NORMALIZED_MAX


@dataclass(frozen=True)
class NormalizedRect:
    """归一化矩形 [0, 1000]"""
    x1: int
    y1: int
    x2: int
    y2: int

    def __post_init__(self) -> None:
        for attr in ("x1", "y1", "x2", "y2"):
            val = max(0, min(NORMALIZED_MAX, getattr(self, attr)))
            object.__setattr__(self, attr, val)

    def to_pixel(self, screen_width: int, screen_height: int) -> Tuple[int, int, int, int]:
        return (
            int(self.x1 / NORMALIZED_MAX * screen_width),
            int(self.y1 / NORMALIZED_MAX * screen_height),
            int(self.x2 / NORMALIZED_MAX * screen_width),
            int(self.y2 / NORMALIZED_MAX * screen_height),
        )

    @property
    def center(self) -> NormalizedPoint:
        return NormalizedPoint(x=(self.x1 + self.x2) // 2, y=(self.y1 + self.y2) // 2)


def to_normalized(x: int, y: int, screen_width: int, screen_height: int) -> NormalizedPoint:
    """绝对像素坐标 → 归一化坐标"""
    return NormalizedPoint(
        x=int(x / screen_width * NORMALIZED_MAX) if screen_width else 0,
        y=int(y / screen_height * NORMALIZED_MAX) if screen_height else 0,
    )


def from_normalized(nx: int, ny: int, screen_width: int, screen_height: int) -> Tuple[int, int]:
    """归一化坐标 → 绝对像素坐标"""
    return (
        int(nx / NORMALIZED_MAX * screen_width),
        int(ny / NORMALIZED_MAX * screen_height),
    )


def rect_to_normalized(
    x1: int, y1: int, x2: int, y2: int,
    screen_width: int, screen_height: int,
) -> NormalizedRect:
    """绝对像素矩形 → 归一化矩形"""
    return NormalizedRect(
        x1=int(x1 / screen_width * NORMALIZED_MAX) if screen_width else 0,
        y1=int(y1 / screen_height * NORMALIZED_MAX) if screen_height else 0,
        x2=int(x2 / screen_width * NORMALIZED_MAX) if screen_width else 0,
        y2=int(y2 / screen_height * NORMALIZED_MAX) if screen_height else 0,
    )


def rect_from_normalized(
    rect: NormalizedRect, screen_width: int, screen_height: int,
) -> Tuple[int, int, int, int]:
    """归一化矩形 → 绝对像素矩形"""
    return rect.to_pixel(screen_width, screen_height)
