"""Windows UIA 桌面自动化工具测试 — P0 审计产物验证"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from agent.tools.windows_uia import (
    UIAEngine,
    UIAQuery,
    UIAElement,
    register_uia_tools,
)


class TestUIAQuery:
    def test_query_creation_default(self):
        query = UIAQuery()
        assert query.name is None
        assert query.class_name is None
        assert query.control_type is None
        assert query.automation_id is None
        assert query.timeout == 10.0

    def test_query_creation_with_name(self):
        query = UIAQuery(name="Calculator")
        assert query.name == "Calculator"

    def test_query_creation_with_class_name(self):
        query = UIAQuery(class_name="Notepad")
        assert query.class_name == "Notepad"

    def test_query_creation_full(self):
        query = UIAQuery(
            name="Save",
            class_name="Button",
            control_type="Button",
            automation_id="saveBtn",
            timeout=10.0,
        )
        assert query.name == "Save"
        assert query.class_name == "Button"
        assert query.control_type == "Button"
        assert query.automation_id == "saveBtn"
        assert query.timeout == 10.0


class TestUIAElement:
    def test_element_creation(self):
        elem = UIAElement(
            name="Button1",
            control_type="Button",
            rect={"x": 100, "y": 200, "w": 80, "h": 30},
        )
        assert elem.name == "Button1"
        assert elem.control_type == "Button"
        assert elem.rect["x"] == 100
        assert elem.rect["y"] == 200

    def test_element_defaults(self):
        elem = UIAElement(
            name="Text",
            control_type="Text",
            rect={"x": 0, "y": 0, "w": 100, "h": 20},
        )
        assert elem.class_name == ""
        assert elem.automation_id == ""


class TestUIAEngine:
    @pytest.fixture(autouse=True)
    def _reset_engine(self):
        UIAEngine._instance = None

    def test_singleton(self):
        e1 = UIAEngine.get_instance()
        e2 = UIAEngine.get_instance()
        assert e1 is e2

    def test_fallback_mode(self):
        engine = UIAEngine.get_instance()
        assert isinstance(engine._fallback, bool)

    @pytest.mark.asyncio
    async def test_find_elements_fallback(self):
        engine = UIAEngine.get_instance()
        engine._fallback = True
        query = UIAQuery(name="Nonexistent")
        elements = await engine.find_elements(query)
        assert isinstance(elements, list)

    @pytest.mark.asyncio
    async def test_click_fallback(self):
        engine = UIAEngine.get_instance()
        engine._fallback = True
        elem = UIAElement(
            name="Button",
            control_type="Button",
            rect={"x": 100, "y": 100, "w": 50, "h": 25},
        )
        ok = await engine.click(elem)
        assert isinstance(ok, bool)

    @pytest.mark.asyncio
    async def test_set_text_fallback(self):
        engine = UIAEngine.get_instance()
        engine._fallback = True
        elem = UIAElement(
            name="TextBox",
            control_type="Edit",
            rect={"x": 100, "y": 100, "w": 200, "h": 30},
        )
        ok = await engine.set_text(elem, "hello")
        assert isinstance(ok, bool)

    @pytest.mark.asyncio
    async def test_fallback_mode_switches(self):
        engine = UIAEngine.get_instance()
        engine._fallback = True
        assert engine._fallback is True
        engine._fallback = False
        assert engine._fallback is False


class TestUIAToolRegistration:
    def test_register_uia_tools(self):
        registry = MagicMock()
        register_uia_tools(registry)
        assert registry.register.call_count == 3
