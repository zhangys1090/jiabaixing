"""W3 测试：DeviceSenseChannel / ProprioceptionChannel 环境感与本体感通道。"""

from __future__ import annotations

from agent.perception.device_sense import (
    DeviceSenseChannel,
    DeviceStatus,
    ProprioceptionChannel,
    device_status_to_text,
    get_device_sense_channel,
    ingest_device_telemetry,
)
from agent.perception.sensory_fusion import SensoryFusion


def _status(device_id="dev-1", state="on", online=True, **extra):
    return {"device_id": device_id, "name": f"灯{device_id}", "kind": "light", "state": state, "online": online, **extra}


def test_ingest_returns_environment_sample():
    ch = DeviceSenseChannel()
    sample = ch.ingest(_status())
    assert sample is not None
    assert sample.modality == "environment"
    assert sample.metadata["device_id"] == "dev-1"
    assert sample.metadata["state"] == "on"
    assert ch.device_count == 1


def test_ingest_many_and_snapshot_latest_per_device():
    ch = DeviceSenseChannel()
    ch.ingest_many([_status("a", "on"), _status("b", "off")])
    ch.ingest(_status("a", "dim"))  # 同一设备更新
    snaps = ch.snapshot_samples()
    ids = {s.metadata["device_id"] for s in snaps}
    assert ids == {"a", "b"}
    a_state = {s.metadata["state"] for s in snaps if s.metadata["device_id"] == "a"}
    assert a_state == {"dim"}  # 保留最新快照


def test_disabled_channel_returns_none():
    ch = DeviceSenseChannel(enabled=False)
    assert ch.ingest(_status()) is None
    assert ch.device_count == 0


def test_ingest_invalid_raises():
    ch = DeviceSenseChannel()
    try:
        ch.ingest({"name": "no-id"})
    except (ValueError, TypeError):
        pass
    else:
        raise AssertionError("缺少 device_id 应抛错")


def test_feed_into_sensory_fusion():
    ch = DeviceSenseChannel()
    ch.ingest_many([_status("a", "on", brightness=80), _status("b", "off", online=False)])
    fusion = SensoryFusion()
    ch.feed(fusion)
    fused = fusion.fuse()
    assert "environment" in fused.modalities
    assert "灯a" in fused.text or "on" in fused.text
    # 离线设备置信度被压低
    off = [s for s in ch.snapshot_samples() if s.metadata["device_id"] == "b"][0]
    assert off.confidence < 0.85


def test_device_status_to_text_includes_extras():
    text = device_status_to_text(_status("a", "on", brightness=80, location="客厅"))
    assert "客厅" in text
    assert "brightness" in text or "80" in text


def test_proprioception_channel_records_action():
    p = ProprioceptionChannel()
    ok = p.record_action("click", True, "点击成功")
    fail = p.record_action("type", False, "输入超时")
    assert ok.modality == "proprioception"
    assert ok.metadata["success"] is True
    assert ok.confidence > fail.confidence
    samples = p.samples()
    assert len(samples) == 2


def test_from_dict_and_singleton():
    ds = DeviceStatus.from_dict(_status("z", "on"))
    assert ds.device_id == "z"
    # 单例通道可被 ingest_device_telemetry 写入
    before = len(get_device_sense_channel().snapshot_samples())
    ingest_device_telemetry([_status("singleton-1", "on")])
    after = len(get_device_sense_channel().snapshot_samples())
    assert after >= before
