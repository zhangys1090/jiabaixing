"""真实设备 / 环境感通道 + 本体感通道（W3，详见文档 3 §2.2 / §八）。

架构归属（AGENTS.md §0.1）：TS 侧 ``DeviceManager`` 仅作为入口/透传，把真实设备网关
（``HttpDeviceAdapter``）拉取到的设备状态通过 ``PythonAgentBridge`` 推送到 Python 的
``POST /v1/devices/telemetry`` 端点；**本模块是 Agent 核心**，负责把设备状态字典转换为
``environment`` 模态的 ``SenseSample``，并可直接灌入 ``SensoryFusion``，闭合
"真实世界 → 感知 → 决策 → 行动 → 验证" 回路。

§2.2 #1 本体感（proprioception）：记录代理自身动作执行结果，作为自我感知信号回流，
与 §2.2 #2 环境感（environment）共同构成 "手脚五感" 的闭环新增通道。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from agent.perception.sensory_fusion import SenseSample, SensoryFusion


def device_status_to_text(status: dict[str, Any]) -> str:
    """把设备状态字典序列化为人类可读文本（用于 SenseSample.content）。"""
    name = status.get("name") or status.get("device_id") or "unknown"
    kind = status.get("kind", "device")
    state = status.get("state", "unknown")
    online = status.get("online", True)
    location = status.get("location")
    parts = [f"{name}（{kind}）状态={state}，在线={online}"]
    if location:
        parts.append(f"位置={location}")
    # 透出其余业务字段（如亮度/温度/电量等），便于决策复用
    extras = {
        k: v
        for k, v in status.items()
        if k not in ("device_id", "name", "kind", "state", "online", "location", "raw")
        and v is not None
    }
    if extras:
        extra_str = "，".join(f"{k}={v}" for k, v in extras.items())
        parts.append(f"附加={extra_str}")
    return "；".join(parts)


@dataclass
class DeviceStatus:
    """归一化后的设备状态（来自 TS 设备网关的字典载荷）。"""

    device_id: str
    name: str = ""
    kind: str = "device"
    state: str = "unknown"
    online: bool = True
    location: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DeviceStatus":
        if not isinstance(d, dict):
            raise TypeError("设备状态必须是 dict")
        device_id = str(d.get("device_id") or d.get("id") or "")
        if not device_id:
            raise ValueError("设备状态缺少 device_id/id")
        return cls(
            device_id=device_id,
            name=str(d.get("name", device_id)),
            kind=str(d.get("kind", "device")),
            state=str(d.get("state", "unknown")),
            online=bool(d.get("online", True)),
            location=d.get("location"),
            raw=d,
        )

    def to_sample(self, confidence: float = 0.85) -> SenseSample:
        return SenseSample(
            modality="environment",
            content=device_status_to_text(self.raw),
            confidence=confidence if self.online else max(0.1, confidence - 0.4),
            metadata={
                "device_id": self.device_id,
                "kind": self.kind,
                "state": self.state,
                "online": self.online,
                "location": self.location,
            },
        )


class DeviceSenseChannel:
    """环境感通道：汇聚真实设备状态，产出 ``environment`` 模态 SenseSample。"""

    def __init__(self, enabled: bool = True) -> None:
        self._enabled = enabled
        self._lock = threading.Lock()
        self._latest: dict[str, DeviceStatus] = {}
        self._history: list[SenseSample] = []

    def ingest(self, status: dict[str, Any]) -> SenseSample | None:
        """吸收一条设备状态，返回生成的 SenseSample（通道禁用时返回 None）。"""
        if not self._enabled:
            return None
        ds = DeviceStatus.from_dict(status)
        sample = ds.to_sample()
        with self._lock:
            self._latest[ds.device_id] = ds
            self._history.append(sample)
        return sample

    def ingest_many(self, statuses: list[dict[str, Any]]) -> list[SenseSample]:
        out: list[SenseSample] = []
        for s in statuses or []:
            sm = self.ingest(s)
            if sm is not None:
                out.append(sm)
        return out

    def snapshot_samples(self) -> list[SenseSample]:
        """返回每个设备最新状态的 SenseSample（用于灌入融合层）。"""
        with self._lock:
            return [ds.to_sample() for ds in self._latest.values()]

    def feed(self, fusion: SensoryFusion, strategy: str = "weighted") -> None:
        """把最新设备快照灌入指定的 ``SensoryFusion``。"""
        fusion.add_many(self.snapshot_samples())

    def clear(self) -> None:
        with self._lock:
            self._latest.clear()
            self._history.clear()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    @property
    def device_count(self) -> int:
        with self._lock:
            return len(self._latest)

    @property
    def history(self) -> list[SenseSample]:
        with self._lock:
            return list(self._history)


class ProprioceptionChannel:
    """本体感通道：记录代理自身动作执行结果，作为自我感知信号回流。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._samples: list[SenseSample] = []

    def record_action(
        self,
        action: str,
        success: bool,
        detail: str = "",
        confidence: float | None = None,
    ) -> SenseSample:
        conf = confidence if confidence is not None else (0.9 if success else 0.5)
        content = {
            "action": action,
            "success": success,
            "detail": detail,
        }
        sample = SenseSample(
            modality="proprioception",
            content=content,
            confidence=conf,
            metadata={"action": action, "success": success},
        )
        with self._lock:
            self._samples.append(sample)
        return sample

    def feed(self, fusion: SensoryFusion, strategy: str = "weighted") -> None:
        with self._lock:
            fusion.add_many(list(self._samples))

    def samples(self) -> list[SenseSample]:
        with self._lock:
            return list(self._samples)

    def clear(self) -> None:
        with self._lock:
            self._samples.clear()


# ---- 进程级单例：Python 端设备遥测端点直接写入同一通道 -----------------------
_default_channel: DeviceSenseChannel | None = None
_default_proprioception: ProprioceptionChannel | None = None


def get_device_sense_channel() -> DeviceSenseChannel:
    global _default_channel
    if _default_channel is None:
        _default_channel = DeviceSenseChannel()
    return _default_channel


def get_proprioception_channel() -> ProprioceptionChannel:
    global _default_proprioception
    if _default_proprioception is None:
        _default_proprioception = ProprioceptionChannel()
    return _default_proprioception


def ingest_device_telemetry(statuses: list[dict[str, Any]]) -> list[SenseSample]:
    """供 ``POST /v1/devices/telemetry`` 调用：写入全局 DeviceSenseChannel。"""
    return get_device_sense_channel().ingest_many(statuses or [])
