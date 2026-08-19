"""W7/W8 多 Agent 感知模板 + 共享感知总线（traceId 贯通）。

- ``PerceptionAgentTemplate``：预置的感知型子 Agent 角色（视觉操作 / 桌面自动化 / 设备控制），
  声明其消费的模态与工具集，供子 Agent 派发时注入感知上下文（AGENTS.md §0.1：模板定义属 Agent 核心）。
- ``SharedPerceptionBus``：汇聚多个子 Agent 上报的 ``SenseSample``（带 ``trace_id`` + ``agent_id``），
  可按 ``trace_id`` 聚合为 ``FusedPerception``，实现跨子 Agent 的感知融合与链路贯通。

详见 docs/jiabaixing-unique-capability-enhancement.md §六 (U5) / §八。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from agent.core.tracing import new_trace_id
from agent.perception.sensory_fusion import (
    FusedPerception,
    SenseSample,
    SensoryFusion,
)


@dataclass(frozen=True)
class PerceptionAgentTemplate:
    """感知型子 Agent 预设：声明其消费的模态与工具集。"""

    kind: str
    description: str
    modalities: tuple[str, ...]
    tools: tuple[str, ...]
    use_shared_fusion: bool = True

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "PerceptionAgentTemplate":
        return cls(
            kind=str(d.get("kind", "generic")),
            description=str(d.get("description", "")),
            modalities=tuple(d.get("modalities", ())),
            tools=tuple(d.get("tools", ())),
            use_shared_fusion=bool(d.get("use_shared_fusion", True)),
        )


# 预置感知型子 Agent 模板（文档 3 §六）：把五感能力下沉到专职子 Agent。
PERCEPTION_AGENT_TEMPLATES: dict[str, PerceptionAgentTemplate] = {
    "visual_operator": PerceptionAgentTemplate(
        kind="visual_operator",
        description="视觉操作型子 Agent：结合视觉定位与 UI 自动化执行界面操作。",
        modalities=("visual", "uia", "ocr"),
        tools=("visual_grounding", "uia", "ocr", "screen_capture"),
    ),
    "desktop_automation": PerceptionAgentTemplate(
        kind="desktop_automation",
        description="桌面自动化型子 Agent：调度桌面自动化完成点击/输入/拖拽等动作。",
        modalities=("uia", "visual", "proprioception"),
        tools=("nut", "playwright", "uia", "action_verifier"),
    ),
    "device_control": PerceptionAgentTemplate(
        kind="device_control",
        description="设备控制型子 Agent：读取真实设备网关状态并下发控制指令。",
        modalities=("environment", "proprioception"),
        tools=("device_manager", "device_gateway", "action_verifier"),
    ),
}


def get_perception_template(kind: str) -> PerceptionAgentTemplate | None:
    return PERCEPTION_AGENT_TEMPLATES.get(kind)


@dataclass
class PerceptionBusEntry:
    """一次感知样本上报（带 trace_id / agent_id 贯通标记）。"""

    agent_id: str
    sample: SenseSample
    trace_id: str
    task_id: str | None = None


class SharedPerceptionBus:
    """共享感知总线：跨子 Agent 汇聚 SenseSample，按 trace_id 聚合融合。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: list[PerceptionBusEntry] = []

    def ingest(
        self,
        agent_id: str,
        sample: SenseSample,
        trace_id: str | None = None,
        task_id: str | None = None,
    ) -> str:
        """汇聚一条感知样本，返回贯通用的 trace_id（缺省自动生成）。"""
        trace_id = trace_id or new_trace_id()
        with self._lock:
            self._entries.append(
                PerceptionBusEntry(
                    agent_id=agent_id, sample=sample, trace_id=trace_id, task_id=task_id
                )
            )
        return trace_id

    def for_trace(self, trace_id: str) -> list[SenseSample]:
        with self._lock:
            return [e.sample for e in self._entries if e.trace_id == trace_id]

    def agent_ids(self, trace_id: str) -> set[str]:
        with self._lock:
            return {e.agent_id for e in self._entries if e.trace_id == trace_id}

    def aggregate(
        self,
        trace_id: str,
        strategy: str = "weighted",
        weights: dict[str, float] | None = None,
    ) -> FusedPerception:
        """按 trace_id 聚合该链路下所有子 Agent 的感知样本。"""
        with self._lock:
            samples = [e.sample for e in self._entries if e.trace_id == trace_id]
        fusion = SensoryFusion(weights=weights)
        fusion.add_many(samples)
        return fusion.fuse(strategy)

    def aggregate_all(
        self,
        strategy: str = "weighted",
        weights: dict[str, float] | None = None,
    ) -> FusedPerception:
        """聚合总线中全部样本（忽略 trace_id 边界）。"""
        with self._lock:
            samples = [e.sample for e in self._entries]
        fusion = SensoryFusion(weights=weights)
        fusion.add_many(samples)
        return fusion.fuse(strategy)

    def clear(self, trace_id: str | None = None) -> int:
        with self._lock:
            if trace_id is None:
                n = len(self._entries)
                self._entries.clear()
                return n
            before = len(self._entries)
            self._entries = [e for e in self._entries if e.trace_id != trace_id]
            return before - len(self._entries)

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._entries)
