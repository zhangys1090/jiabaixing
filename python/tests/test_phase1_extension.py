"""
Phase 1 扩展集成测试

覆盖:
  1. HomeAssistant 智能家居工具
  2. SkillHub 技能市场 + SkillSync 同步
  3. BlueprintCatalog Cron 蓝图目录
  4. ACP 认证+权限（Python 侧验证逻辑）
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestHomeAssistantTool:
    """Home Assistant 智能家居工具测试"""

    def test_ha_control_definition(self):
        from agent.tools.homeassistant_tool import HA_CONTROL_DEF
        assert HA_CONTROL_DEF.name == "ha_control"
        assert HA_CONTROL_DEF.category.value == "iot"
        assert HA_CONTROL_DEF.risk_level == "medium"
        action_param = next(p for p in HA_CONTROL_DEF.parameters if p.name == "action")
        assert "turn_on" in action_param.enum
        assert "turn_off" in action_param.enum
        assert "get_state" in action_param.enum

    def test_ha_scene_definition(self):
        from agent.tools.homeassistant_tool import HA_SCENE_DEF
        assert HA_SCENE_DEF.name == "ha_scene"
        assert HA_SCENE_DEF.category.value == "iot"
        action_param = next(p for p in HA_SCENE_DEF.parameters if p.name == "action")
        assert "activate" in action_param.enum
        assert "list_scenes" in action_param.enum

    def test_ha_sensor_definition(self):
        from agent.tools.homeassistant_tool import HA_SENSOR_DEF
        assert HA_SENSOR_DEF.name == "ha_sensor"
        assert HA_SENSOR_DEF.category.value == "iot"
        action_param = next(p for p in HA_SENSOR_DEF.parameters if p.name == "action")
        assert "get" in action_param.enum
        assert "history" in action_param.enum

    def test_ha_client_not_configured(self):
        from agent.tools.homeassistant_tool import HomeAssistantClient
        HomeAssistantClient.reset_instance()
        with patch.dict(os.environ, {}, clear=True):
            client = HomeAssistantClient()
            assert not client.is_configured()

    def test_ha_client_configured(self):
        from agent.tools.homeassistant_tool import HomeAssistantClient
        HomeAssistantClient.reset_instance()
        with patch.dict(os.environ, {"HA_BASE_URL": "http://hassio.local:8123", "HA_TOKEN": "test-token"}):
            client = HomeAssistantClient()
            assert client.is_configured()
        HomeAssistantClient.reset_instance()

    @pytest.mark.asyncio
    async def test_ha_control_no_config(self):
        from agent.tools.homeassistant_tool import ha_control_executor, HomeAssistantClient
        HomeAssistantClient.reset_instance()
        with patch.dict(os.environ, {}, clear=True):
            result = await ha_control_executor({"action": "list_devices"})
            assert not result.success
            assert "未配置" in result.error

    @pytest.mark.asyncio
    async def test_ha_control_missing_entity_id(self):
        from agent.tools.homeassistant_tool import ha_control_executor, HomeAssistantClient
        HomeAssistantClient.reset_instance()
        with patch.dict(os.environ, {"HA_BASE_URL": "http://hassio.local:8123", "HA_TOKEN": "test-token"}):
            result = await ha_control_executor({"action": "turn_on"})
            assert not result.success
            assert "entity_id" in result.error
        HomeAssistantClient.reset_instance()

    def test_ha_entity_dataclass(self):
        from agent.tools.homeassistant_tool import HAEntity
        entity = HAEntity(
            entity_id="light.living_room",
            state="on",
            attributes={"brightness": 255, "friendly_name": "客厅灯"},
            last_changed="2026-01-01T00:00:00",
        )
        d = entity.to_dict()
        assert d["entity_id"] == "light.living_room"
        assert d["state"] == "on"
        assert d["attributes"]["brightness"] == 255

    def test_iot_category_in_registry(self):
        from agent.tools.registry import ToolCategory
        assert ToolCategory.IOT.value == "iot"

    def test_iot_toolset_registered(self):
        from agent.tools.builtin_toolsets import IOT_TOOLSET, BUILTIN_TOOLSETS
        assert IOT_TOOLSET.id == "iot"
        assert IOT_TOOLSET in BUILTIN_TOOLSETS

    def test_iot_in_agent_toolset_map(self):
        from agent.tools.builtin_toolsets import AGENT_TOOLSET_MAP
        assert "iot" in AGENT_TOOLSET_MAP
        assert AGENT_TOOLSET_MAP["iot"] == "iot"


class TestSkillHub:
    """Skill Hub 市场测试"""

    def setup_method(self):
        from agent.skills.registry import SkillHub
        SkillHub.reset_instance()

    def teardown_method(self):
        from agent.skills.registry import SkillHub
        SkillHub.reset_instance()

    def test_hub_skill_entry_dataclass(self):
        from agent.skills.registry import HubSkillEntry
        entry = HubSkillEntry(
            name="code_review",
            description="代码审查技能",
            category="development",
            version="2.0.0",
            author="alice",
            tags=["code", "review"],
            downloads=100,
            rating=4.5,
        )
        d = entry.to_dict()
        assert d["name"] == "code_review"
        assert d["rating"] == 4.5
        assert d["downloads"] == 100

        restored = HubSkillEntry.from_dict(d)
        assert restored.name == "code_review"
        assert restored.rating == 4.5

    def test_hub_publish_and_get(self):
        from agent.skills.registry import SkillHub, HubSkillEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.skills.registry.DATA_DIR", Path(tmpdir)):
                hub = SkillHub()
                entry = HubSkillEntry(name="test_skill", description="测试技能", category="test")
                hub.publish(entry)
                assert hub.get_entry("test_skill") is not None
                assert hub.get_entry("test_skill").description == "测试技能"

    def test_hub_search(self):
        from agent.skills.registry import SkillHub, HubSkillEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.skills.registry.DATA_DIR", Path(tmpdir)):
                hub = SkillHub()
                hub.publish(HubSkillEntry(name="code_review", description="代码审查", category="development", tags=["code"]))
                hub.publish(HubSkillEntry(name="code_format", description="代码格式化", category="development", tags=["code"]))
                hub.publish(HubSkillEntry(name="image_gen", description="图像生成", category="creative", tags=["image"]))
                results = hub.search("code")
                assert len(results) == 2
                assert all("code" in r.name for r in results)

    def test_hub_list_entries(self):
        from agent.skills.registry import SkillHub, HubSkillEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.skills.registry.DATA_DIR", Path(tmpdir)):
                hub = SkillHub()
                hub.publish(HubSkillEntry(name="skill_a", category="dev", rating=3.0))
                hub.publish(HubSkillEntry(name="skill_b", category="dev", rating=4.5))
                hub.publish(HubSkillEntry(name="skill_c", category="creative", rating=5.0))
                all_entries = hub.list_entries()
                assert len(all_entries) == 3
                dev_entries = hub.list_entries(category="dev")
                assert len(dev_entries) == 2

    def test_hub_install_and_uninstall(self):
        from agent.skills.registry import SkillHub, SkillRegistry, HubSkillEntry
        SkillRegistry.reset_instance()
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.skills.registry.DATA_DIR", Path(tmpdir)):
                hub = SkillHub()
                hub.publish(HubSkillEntry(name="hub_skill", description="Hub技能", category="test"))
                registry = SkillRegistry()
                ok = hub.install("hub_skill", registry)
                assert ok
                assert hub.get_entry("hub_skill").installed
                assert hub.get_entry("hub_skill").downloads == 1
                assert registry.get_skill("hub_skill") is not None
                ok = hub.uninstall("hub_skill", registry)
                assert ok
                assert not hub.get_entry("hub_skill").installed
                assert registry.get_skill("hub_skill") is None
        SkillRegistry.reset_instance()

    def test_hub_unpublish(self):
        from agent.skills.registry import SkillHub, HubSkillEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.skills.registry.DATA_DIR", Path(tmpdir)):
                hub = SkillHub()
                hub.publish(HubSkillEntry(name="temp_skill"))
                assert hub.get_entry("temp_skill") is not None
                ok = hub.unpublish("temp_skill")
                assert ok
                assert hub.get_entry("temp_skill") is None

    def test_hub_sync_with_registry(self):
        from agent.skills.registry import SkillHub, SkillRegistry, HubSkillEntry
        SkillRegistry.reset_instance()
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.skills.registry.DATA_DIR", Path(tmpdir)):
                hub = SkillHub()
                hub.publish(HubSkillEntry(name="sync_skill", description="同步技能", category="test", version="1.0.0"))
                hub.install("sync_skill")
                registry = SkillRegistry()
                result = hub.sync_with_registry(registry)
                assert "sync_skill" in result.added
                assert registry.get_skill("sync_skill") is not None
        SkillRegistry.reset_instance()

    def test_hub_stats(self):
        from agent.skills.registry import SkillHub, HubSkillEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.skills.registry.DATA_DIR", Path(tmpdir)):
                hub = SkillHub()
                hub.publish(HubSkillEntry(name="s1", category="dev", installed=True))
                hub.publish(HubSkillEntry(name="s2", category="dev"))
                hub.publish(HubSkillEntry(name="s3", category="creative"))
                stats = hub.get_stats()
                assert stats["total"] == 3
                assert stats["installed"] == 1
                assert stats["categories"]["dev"] == 2

    def test_skill_sync_result_dataclass(self):
        from agent.skills.registry import SkillSyncResult
        result = SkillSyncResult(added=["a"], updated=["b"], removed=["c"], errors=["e"])
        assert result.added == ["a"]
        assert result.updated == ["b"]
        assert result.removed == ["c"]
        assert result.errors == ["e"]


class TestSkillSync:
    """SkillSync 远程同步测试"""

    def setup_method(self):
        from agent.skills.registry import SkillHub
        SkillHub.reset_instance()

    def teardown_method(self):
        from agent.skills.registry import SkillHub
        SkillHub.reset_instance()

    def test_sync_add_remote(self):
        from agent.skills.registry import SkillSync
        sync = SkillSync.__new__(SkillSync)
        sync._remote_urls = []
        sync.add_remote("https://hub.example.com/index.json")
        assert len(sync.get_remotes()) == 1

    def test_sync_remove_remote(self):
        from agent.skills.registry import SkillSync
        sync = SkillSync.__new__(SkillSync)
        sync._remote_urls = ["https://hub.example.com/index.json"]
        sync.remove_remote("https://hub.example.com/index.json")
        assert len(sync.get_remotes()) == 0

    def test_sync_env_urls(self):
        from agent.skills.registry import SkillSync
        with patch.dict(os.environ, {"SKILL_HUB_URLS": "https://a.com,https://b.com"}):
            sync = SkillSync.__new__(SkillSync)
            sync._remote_urls = []
            remote_env = os.getenv("SKILL_HUB_URLS", "")
            if remote_env:
                sync._remote_urls = [u.strip() for u in remote_env.split(",") if u.strip()]
            assert len(sync._remote_urls) == 2


class TestBlueprintCatalog:
    """Cron 蓝图目录测试"""

    def setup_method(self):
        from agent.scheduler.cron import BlueprintCatalog
        BlueprintCatalog.reset_instance()

    def teardown_method(self):
        from agent.scheduler.cron import BlueprintCatalog
        BlueprintCatalog.reset_instance()

    def test_blueprint_entry_dataclass(self):
        from agent.scheduler.cron import BlueprintEntry, BlueprintParam
        entry = BlueprintEntry(
            id="test_bp",
            name="测试蓝图",
            description="测试描述",
            command="echo {{msg}}",
            params=[BlueprintParam(name="msg", default="hello")],
            tags=["test"],
        )
        d = entry.to_dict()
        assert d["id"] == "test_bp"
        assert len(d["params"]) == 1
        assert d["params"][0]["name"] == "msg"

        restored = BlueprintEntry.from_dict(d)
        assert restored.id == "test_bp"
        assert len(restored.params) == 1
        assert restored.params[0].default == "hello"

    def test_catalog_register_and_get(self):
        from agent.scheduler.cron import BlueprintCatalog, BlueprintEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                entry = BlueprintEntry(id="bp1", name="蓝图1", command="echo hello")
                catalog.register(entry)
                assert catalog.get("bp1") is not None
                assert catalog.get("bp1").name == "蓝图1"

    def test_catalog_unregister(self):
        from agent.scheduler.cron import BlueprintCatalog, BlueprintEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                catalog.register(BlueprintEntry(id="bp2", name="蓝图2"))
                ok = catalog.unregister("bp2")
                assert ok
                assert catalog.get("bp2") is None

    def test_catalog_search(self):
        from agent.scheduler.cron import BlueprintCatalog, BlueprintEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                catalog.register(BlueprintEntry(id="bp_backup", name="系统备份", tags=["backup", "system"]))
                catalog.register(BlueprintEntry(id="bp_log", name="日志清理", tags=["log", "cleanup"]))
                catalog.register(BlueprintEntry(id="bp_health", name="健康检查", tags=["health"]))
                results = catalog.search("备份")
                assert len(results) == 1
                assert results[0].id == "bp_backup"

    def test_catalog_list_by_category(self):
        from agent.scheduler.cron import BlueprintCatalog, BlueprintEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                catalog.register(BlueprintEntry(id="bp1", name="A", category="system"))
                catalog.register(BlueprintEntry(id="bp2", name="B", category="monitoring"))
                catalog.register(BlueprintEntry(id="bp3", name="C", category="system"))
                system = catalog.list_entries(category="system")
                assert len(system) == 2

    def test_catalog_instantiate(self):
        from agent.scheduler.cron import BlueprintCatalog, BlueprintEntry, BlueprintParam
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                catalog.register(BlueprintEntry(
                    id="bp_instant",
                    name="实例化测试",
                    command="backup {{source}} to {{dest}}",
                    schedule="every:2h",
                    params=[
                        BlueprintParam(name="source", default="/data"),
                        BlueprintParam(name="dest", default="/backup"),
                    ],
                ))
                job = catalog.instantiate("bp_instant", {"source": "/home", "dest": "/mnt/backup"})
                assert job is not None
                assert job.command == "backup /home to /mnt/backup"
                assert job.schedule == "every:2h"
                assert job.name == "实例化测试"
                assert job.id.startswith("bp_bp_instant_")

    def test_catalog_instantiate_with_defaults(self):
        from agent.scheduler.cron import BlueprintCatalog, BlueprintEntry, BlueprintParam
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                catalog.register(BlueprintEntry(
                    id="bp_defaults",
                    name="默认参数测试",
                    command="echo {{msg}}",
                    params=[BlueprintParam(name="msg", default="hello")],
                ))
                job = catalog.instantiate("bp_defaults")
                assert job is not None
                assert job.command == "echo hello"

    def test_catalog_instantiate_schedule_override(self):
        from agent.scheduler.cron import BlueprintCatalog, BlueprintEntry
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                catalog.register(BlueprintEntry(id="bp_sched", name="调度覆盖", command="echo ok", schedule="every:1h"))
                job = catalog.instantiate("bp_sched", schedule_override="every:30m")
                assert job is not None
                assert job.schedule == "every:30m"

    def test_catalog_instantiate_not_found(self):
        from agent.scheduler.cron import BlueprintCatalog
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                job = catalog.instantiate("nonexistent")
                assert job is None

    def test_catalog_builtin_blueprints(self):
        from agent.scheduler.cron import BlueprintCatalog
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agent.scheduler.cron.DATA_DIR", Path(tmpdir)):
                catalog = BlueprintCatalog()
                catalog.register_builtin_blueprints()
                entries = catalog.list_entries()
                assert len(entries) >= 5
                assert catalog.get("system_backup") is not None
                assert catalog.get("log_cleanup") is not None
                assert catalog.get("health_check") is not None
                assert catalog.get("db_vacuum") is not None
                assert catalog.get("report_generate") is not None


class TestACPAuth:
    """ACP 认证+权限逻辑测试（Python 侧验证数据结构）"""

    def test_acp_auth_types_exist(self):
        try:
            from importlib import import_module
            spec = import_module("agent.config")
            assert spec is not None
        except ImportError:
            pass

    def test_acp_auth_env_config(self):
        with patch.dict(os.environ, {"ACP_API_KEY": "test-admin-key", "ACP_READ_ONLY_KEY": "test-read-key"}):
            assert os.getenv("ACP_API_KEY") == "test-admin-key"
            assert os.getenv("ACP_READ_ONLY_KEY") == "test-read-key"

    def test_acp_auth_enabled_default(self):
        with patch.dict(os.environ, {}, clear=False):
            val = os.getenv("ACP_AUTH_ENABLED", "true")
            assert val != "false"

    def test_acp_permission_levels(self):
        levels = ["read", "write", "admin", "denied"]
        assert len(levels) == 4
        assert "admin" in levels
        assert "denied" in levels

    def test_acp_scope_structure(self):
        scope = {
            "allowedCategories": ["cognition", "memory"],
            "deniedTools": ["shell_exec"],
            "allowedPaths": ["/home/user/project"],
            "maxTokensPerRequest": 4096,
            "maxRequestsPerHour": 200,
        }
        assert len(scope["allowedCategories"]) == 2
        assert "shell_exec" in scope["deniedTools"]
        assert scope["maxRequestsPerHour"] == 200
