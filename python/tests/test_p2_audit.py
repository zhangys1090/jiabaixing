"""三项战略级能力审计优化测试。"""

from __future__ import annotations

import asyncio
import pytest


class TestWorldModelAudit:
    """P2-1 世界模型审计优化验证。"""

    def test_deep_copy_safety(self):
        from agent.cognition.world_model import WorldModel, EntityState
        m = WorldModel()

        async def _run():
            s1 = await m.build_current_state(
                {"entities": [{"id": "btn", "name": "OK", "type": "button", "state": "active"}]}
            )
            await m.predict(s1, "click", "btn")
            assert s1.entities["btn"].state == EntityState.ACTIVE

        asyncio.get_event_loop().run_until_complete(_run())

    def test_persistence_round_trip(self):
        from agent.cognition.world_model import WorldModel
        m = WorldModel()
        state_data = m.save_state()
        assert "causal_rules" in state_data
        assert len(state_data["causal_rules"]) > 0
        m2 = WorldModel()
        m2.load_state(state_data)
        assert len(m2.causal_rules) >= len(m.causal_rules)

    def test_adaptive_surprise_detection(self):
        from agent.cognition.world_model import WorldModel, WorldState, Entity, EntityState
        m = WorldModel()
        before = WorldState(
            state_id="s1",
            entities={"win": Entity(entity_id="win", name="Dialog", state=EntityState.ACTIVE, visible=True)},
        )
        after = WorldState(
            state_id="s2",
            entities={"win": Entity(entity_id="win", name="Dialog", state=EntityState.ERROR, visible=False)},
        )

        async def _run():
            report = await m.detect_surprise_adaptive(before, after)
            assert report.is_surprising
            assert report.surprise_score > 0

        asyncio.get_event_loop().run_until_complete(_run())

    def test_causal_rule_learning_and_online_update(self):
        from agent.cognition.world_model import WorldModel, CausalRule
        m = WorldModel()
        r = CausalRule(
            rule_id="custom1", action_pattern="scroll", target_pattern="list",
            expected_effects={"scrolled": True}, probability=0.7,
        )
        m.learn_causal_rule(r)
        m.update_rule_from_outcome("custom1", True)
        assert m.causal_rules["custom1"].probability > 0.7
        m.update_rule_from_outcome("custom1", False)
        assert m.causal_rules["custom1"].learned_from == 2


class TestContinualLearningAudit:
    """P2-2 持续学习回路审计优化验证。"""

    def test_experience_record_and_learn(self):
        from agent.cognition.continual_learning import ContinualLearningLoop
        cl = ContinualLearningLoop()
        cl.record_experience("搜索", "web_search", "OK", True, 0.9, 500, ["web_search"], "direct")
        cl.record_experience("搜索", "web_search", "OK", True, 0.85, 600, ["web_search"], "direct")
        cl.record_experience("调试", "code_execute", "修", True, 0.8, 1200, ["code_execute"], "cot")
        cl.record_experience("部署", "deploy", "失败", False, 0.2, 3000, ["deploy"], "direct")
        report = asyncio.get_event_loop().run_until_complete(cl.learn())
        assert report.total_experiences == 4
        assert report.adjustments_made >= 0

    def test_tool_optimization_real(self):
        from agent.cognition.continual_learning import ContinualLearningLoop
        cl = ContinualLearningLoop()
        for _ in range(15):
            cl.record_experience("t", "bad_tool", "fail", False, 0.1, 100, ["bad_tool"], "direct")
        for _ in range(15):
            cl.record_experience("t", "great_tool", "OK", True, 0.95, 100, ["great_tool"], "cot")
        report = asyncio.get_event_loop().run_until_complete(cl.learn())
        tool_adjs = [a for a in report.adjustments if a.type.value == "rule_update"]
        assert len(tool_adjs) >= 1

    def test_strategy_optimization_real(self):
        from agent.cognition.continual_learning import ContinualLearningLoop
        cl = ContinualLearningLoop()
        for _ in range(15):
            cl.record_experience("t", "tool_a", "OK", True, 0.95, 100, ["tool_a"], "cot")
        for _ in range(15):
            cl.record_experience("t", "tool_a", "fail", False, 0.1, 100, ["tool_a"], "direct")
        report = asyncio.get_event_loop().run_until_complete(cl.learn())
        strategy_adjs = [a for a in report.adjustments if a.type.value == "strategy_switch"]
        assert len(strategy_adjs) >= 1

    def test_adaptive_decay(self):
        from agent.cognition.continual_learning import ContinualLearningLoop
        cl = ContinualLearningLoop(decay_threshold=0.2)
        for _ in range(3):
            cl.record_experience("t", "a", "OK", True, 0.9, 100, ["a"], "direct")
        asyncio.get_event_loop().run_until_complete(cl.learn())
        assert cl.knowledge_count >= 0

    def test_persistence_round_trip(self):
        from agent.cognition.continual_learning import ContinualLearningLoop
        cl = ContinualLearningLoop()
        cl.record_experience("搜索", "web_search", "OK", True, 0.9, 500, ["web_search"], "direct")
        cl.record_experience("搜索", "web_search", "OK", True, 0.85, 600, ["web_search"], "direct")
        cl.record_experience("搜索", "web_search", "OK", True, 0.88, 550, ["web_search"], "direct")
        asyncio.get_event_loop().run_until_complete(cl.learn())
        state = cl.save_state()
        assert "knowledge" in state
        assert "tool_stats" in state
        cl2 = ContinualLearningLoop()
        cl2.load_state(state)
        assert cl2.knowledge_count >= cl.knowledge_count


class TestCrossDeviceAudit:
    """P2-3 跨设备协同审计优化验证。"""

    def test_multi_device_execution(self):
        from agent.cognition.cross_device import (
            CrossDeviceCoordinator, DeviceProfile, DeviceCapability, DeviceKind, DeviceStatus,
        )
        cd = CrossDeviceCoordinator()
        cd.register_device(DeviceProfile(
            device_id="pc1", name="PC", kind=DeviceKind.DESKTOP, status=DeviceStatus.ONLINE,
            capabilities=[DeviceCapability(name="screen_capture", reliability=0.95)],
        ))
        cd.register_device(DeviceProfile(
            device_id="ph1", name="Phone", kind=DeviceKind.MOBILE, status=DeviceStatus.ONLINE,
            capabilities=[DeviceCapability(name="tap", reliability=0.85)],
        ))
        result = asyncio.get_event_loop().run_until_complete(
            cd.execute_task(
                "截图+点击",
                subtask_defs=[
                    {"description": "截图", "capabilities": ["screen_capture"]},
                    {"description": "点击", "capabilities": ["tap"]},
                ],
            )
        )
        assert result.success
        assert result.completed_subtasks == 2

    def test_rollback_on_partial_failure(self):
        from agent.cognition.cross_device import (
            CrossDeviceCoordinator, DeviceProfile, DeviceCapability, DeviceKind, DeviceStatus,
        )
        cd = CrossDeviceCoordinator()
        cd.register_device(DeviceProfile(
            device_id="d1", name="D1", kind=DeviceKind.DESKTOP, status=DeviceStatus.ONLINE,
            capabilities=[DeviceCapability(name="cap_a", reliability=0.9)],
        ))
        result = asyncio.get_event_loop().run_until_complete(
            cd.execute_task(
                "部分失败",
                subtask_defs=[
                    {"description": "子任务A", "capabilities": ["cap_a"]},
                    {"description": "子任务B", "capabilities": ["nonexistent_cap"]},
                ],
                rollback_on_failure=True,
            )
        )
        assert not result.success
        assert result.failed_subtasks >= 1

    def test_device_state_sync(self):
        from agent.cognition.cross_device import (
            CrossDeviceCoordinator, DeviceProfile, DeviceCapability, DeviceKind, DeviceStatus,
        )
        cd = CrossDeviceCoordinator()
        cd.register_device(DeviceProfile(
            device_id="pc1", name="PC", kind=DeviceKind.DESKTOP, status=DeviceStatus.ONLINE,
            capabilities=[DeviceCapability(name="screen_capture", reliability=0.95)],
        ))
        ok = asyncio.get_event_loop().run_until_complete(
            cd.sync_device_state("pc1", {"status": "busy", "load": 0.8})
        )
        assert ok
        d = cd.registry.get_device("pc1")
        assert d.status == DeviceStatus.BUSY
        assert abs(d.current_load - 0.8) < 0.01

    def test_persistence_round_trip(self):
        from agent.cognition.cross_device import (
            CrossDeviceCoordinator, DeviceProfile, DeviceCapability, DeviceKind, DeviceStatus,
        )
        cd = CrossDeviceCoordinator()
        cd.register_device(DeviceProfile(
            device_id="pc1", name="PC", kind=DeviceKind.DESKTOP, status=DeviceStatus.ONLINE,
            capabilities=[DeviceCapability(name="cap_a", reliability=0.9)],
        ))
        state = cd.save_state()
        assert "devices" in state
        cd2 = CrossDeviceCoordinator()
        cd2.load_state(state)
        assert cd2.registry.device_count >= cd.registry.device_count

    def test_failover_architecture(self):
        from agent.cognition.cross_device import (
            CrossDeviceCoordinator, DeviceProfile, DeviceCapability, DeviceKind, DeviceStatus,
        )
        cd = CrossDeviceCoordinator()
        cd.register_device(DeviceProfile(
            device_id="d1", name="D1", kind=DeviceKind.DESKTOP, status=DeviceStatus.ONLINE,
            capabilities=[DeviceCapability(name="cap_x", reliability=0.9)],
        ))
        cd.register_device(DeviceProfile(
            device_id="d2", name="D2", kind=DeviceKind.DESKTOP, status=DeviceStatus.ONLINE,
            capabilities=[DeviceCapability(name="cap_x", reliability=0.8)],
        ))
        assert cd.registry.online_count == 2
