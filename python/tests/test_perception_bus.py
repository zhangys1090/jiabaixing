"""W7/W8 测试：SharedPerceptionBus + 感知型子 Agent 模板 + traceId 贯通。"""

from __future__ import annotations

from agent.orchestration.perception_bus import (
    PERCEPTION_AGENT_TEMPLATES,
    PerceptionAgentTemplate,
    SharedPerceptionBus,
    get_perception_template,
)
from agent.perception.sensory_fusion import SenseSample


def test_preset_templates_exist():
    for kind in ("visual_operator", "desktop_automation", "device_control"):
        tpl = get_perception_template(kind)
        assert isinstance(tpl, PerceptionAgentTemplate)
        assert tpl.modalities and tpl.tools


def test_bus_aggregates_by_trace_id():
    bus = SharedPerceptionBus()
    bus.ingest("agentA", SenseSample("visual", "看到按钮", 0.9), trace_id="t1")
    bus.ingest("agentB", SenseSample("audio", "听到提示音", 0.8), trace_id="t1")
    bus.ingest("agentC", SenseSample("text", "其它链路", 0.9), trace_id="t2")

    fused = bus.aggregate("t1")
    assert set(fused.modalities) == {"visual", "audio"}
    assert bus.agent_ids("t1") == {"agentA", "agentB"}
    # 不同 trace 不串扰
    assert set(bus.aggregate("t2").modalities) == {"text"}


def test_bus_auto_generates_trace_id():
    bus = SharedPerceptionBus()
    tid = bus.ingest("agentA", SenseSample("visual", "x", 0.9))
    assert isinstance(tid, str) and len(tid) > 0
    assert set(bus.aggregate(tid).modalities) == {"visual"}


def test_bus_clear():
    bus = SharedPerceptionBus()
    bus.ingest("a", SenseSample("visual", "x", 0.9), trace_id="t1")
    n = bus.clear("t1")
    assert n == 1
    assert bus.size == 0


def test_template_from_dict():
    tpl = PerceptionAgentTemplate.from_dict(
        {"kind": "k", "description": "d", "modalities": ["visual"], "tools": ["ocr"]}
    )
    assert tpl.kind == "k"
    assert tpl.modalities == ("visual",)
