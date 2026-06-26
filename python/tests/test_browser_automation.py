from __future__ import annotations

import pytest

from agent.tools.browser_automation import (
    BrowserAutomation,
    BrowserConfig,
    BrowserConnectionMode,
    BrowserDialogPolicy,
    BrowserSession,
    ElementInfo,
    PageContent,
    ScreenshotResult,
)


# ═══════════════════════════════════════════════════════════════
# BrowserConfig tests
# ═══════════════════════════════════════════════════════════════


class TestBrowserConfig:
    def test_default_config(self):
        config = BrowserConfig()
        assert config.connection_mode == BrowserConnectionMode.LOCAL
        assert config.headless is True
        assert config.viewport_width == 1280
        assert config.viewport_height == 720
        assert config.default_timeout == 30.0
        assert config.dialog_policy == BrowserDialogPolicy.MUST_RESPOND

    def test_cdp_config(self):
        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.CDP,
            cdp_url="ws://localhost:9222",
            headless=False,
        )
        assert config.connection_mode == BrowserConnectionMode.CDP
        assert config.cdp_url == "ws://localhost:9222"
        assert config.headless is False

    def test_browserbase_config(self):
        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.BROWSERBASE,
            browserbase_api_key="test-key",
            browserbase_session_id="test-session",
        )
        assert config.connection_mode == BrowserConnectionMode.BROWSERBASE
        assert config.browserbase_api_key == "test-key"

    def test_custom_viewport(self):
        config = BrowserConfig(viewport_width=1920, viewport_height=1080)
        assert config.viewport_width == 1920
        assert config.viewport_height == 1080

    def test_dialog_policy_auto_dismiss(self):
        config = BrowserConfig(dialog_policy=BrowserDialogPolicy.AUTO_DISMISS)
        assert config.dialog_policy == BrowserDialogPolicy.AUTO_DISMISS

    def test_recording_enabled(self):
        config = BrowserConfig(record_sessions=True)
        assert config.record_sessions is True


# ═══════════════════════════════════════════════════════════════
# BrowserSession tests
# ═══════════════════════════════════════════════════════════════


class TestBrowserSession:
    def test_session_creation(self):
        config = BrowserConfig()
        session = BrowserSession(
            session_id="abc123",
            config=config,
        )
        assert session.session_id == "abc123"
        assert session.page_count == 0

    def test_session_page_count(self):
        session = BrowserSession(
            session_id="abc",
            config=BrowserConfig(),
            page_count=5,
        )
        assert session.page_count == 5


# ═══════════════════════════════════════════════════════════════
# ElementInfo tests
# ═══════════════════════════════════════════════════════════════


class TestElementInfo:
    def test_element_info(self):
        info = ElementInfo(
            selector="#btn",
            tag="button",
            text="Click me",
            visible=True,
        )
        assert info.selector == "#btn"
        assert info.tag == "button"
        assert info.text == "Click me"
        assert info.visible is True

    def test_element_info_with_attributes(self):
        info = ElementInfo(
            selector=".link",
            tag="a",
            text="Home",
            visible=True,
            attributes={"href": "/", "class": "link"},
        )
        assert info.attributes["href"] == "/"


# ═══════════════════════════════════════════════════════════════
# PageContent tests
# ═══════════════════════════════════════════════════════════════


class TestPageContent:
    def test_page_content(self):
        content = PageContent(
            url="https://example.com",
            title="Example",
            text="Hello World",
            html="<html><body>Hello World</body></html>",
        )
        assert content.url == "https://example.com"
        assert content.title == "Example"
        assert content.text == "Hello World"


# ═══════════════════════════════════════════════════════════════
# BrowserAutomation tests
# ═══════════════════════════════════════════════════════════════


class TestBrowserAutomation:
    def test_creation_with_default_config(self):
        browser = BrowserAutomation()
        assert browser._config is not None
        assert browser._config.headless is True
        assert browser._sessions == {}

    def test_creation_with_custom_config(self):
        config = BrowserConfig(headless=False, viewport_width=1920)
        browser = BrowserAutomation(config=config)
        assert browser._config.headless is False
        assert browser._config.viewport_width == 1920

    def test_is_connected_when_not_launched(self):
        browser = BrowserAutomation()
        assert browser.is_connected is False

    def test_get_session_not_found(self):
        browser = BrowserAutomation()
        assert browser.get_session("nonexistent") is None

    def test_get_all_sessions_empty(self):
        browser = BrowserAutomation()
        assert browser.get_all_sessions() == []

    def test_generate_session_id_unique(self):
        browser = BrowserAutomation()
        id1 = browser._generate_session_id()
        id2 = browser._generate_session_id()
        assert id1 != id2
        assert len(id1) == 8

    async def test_launch_without_playwright(self):
        browser = BrowserAutomation()
        session_id = await browser.launch()
        assert session_id is not None
        assert len(session_id) == 8

    async def test_launch_creates_session(self):
        browser = BrowserAutomation()
        session_id = await browser.launch()
        session = browser.get_session(session_id)
        assert session is not None
        assert session.session_id == session_id

    async def test_launch_multiple_sessions(self):
        browser = BrowserAutomation()
        id1 = await browser.launch()
        id2 = await browser.launch()
        assert id1 != id2
        assert len(browser.get_all_sessions()) == 2

    async def test_close_session(self):
        browser = BrowserAutomation()
        session_id = await browser.launch()
        await browser.close(session_id)
        assert browser.get_session(session_id) is None

    async def test_close_all_sessions(self):
        browser = BrowserAutomation()
        await browser.launch()
        await browser.launch()
        await browser.close()
        assert browser.get_all_sessions() == []

    async def test_get_page_content_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.get_page_content("nonexistent")

    async def test_screenshot_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.screenshot("nonexistent")

    async def test_click_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.click("nonexistent", "#btn")

    async def test_type_text_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.type_text("nonexistent", "#input", "hello")

    async def test_get_text_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.get_text("nonexistent", "#title")

    async def test_get_elements_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.get_elements("nonexistent", ".item")

    async def test_execute_js_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.execute_js("nonexistent", "console.log('test')")

    async def test_wait_for_selector_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.wait_for_selector("nonexistent", "#el")

    async def test_navigate_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.navigate("nonexistent", "https://example.com")

    async def test_scroll_to_bottom_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.scroll_to_bottom("nonexistent")

    async def test_get_console_logs_requires_launch(self):
        browser = BrowserAutomation()
        with pytest.raises(RuntimeError, match="未启动"):
            await browser.get_console_logs("nonexistent")


# ═══════════════════════════════════════════════════════════════
# ScreenshotResult tests
# ═══════════════════════════════════════════════════════════════


class TestScreenshotResult:
    def test_screenshot_result(self):
        result = ScreenshotResult(
            session_id="abc",
            data=b"fake-image-data",
        )
        assert result.session_id == "abc"
        assert result.data == b"fake-image-data"
        assert result.mime_type == "image/png"


# ═══════════════════════════════════════════════════════════════
# BrowserConnectionMode enum tests
# ═══════════════════════════════════════════════════════════════


class TestBrowserConnectionMode:
    def test_modes(self):
        assert BrowserConnectionMode.LOCAL == "local"
        assert BrowserConnectionMode.CDP == "cdp"
        assert BrowserConnectionMode.BROWSERBASE == "browserbase"
        assert BrowserConnectionMode.BROWSER_USE == "browser-use"


class TestBrowserDialogPolicy:
    def test_policies(self):
        assert BrowserDialogPolicy.MUST_RESPOND == "must_respond"
        assert BrowserDialogPolicy.AUTO_DISMISS == "auto_dismiss"
        assert BrowserDialogPolicy.AUTO_ACCEPT == "auto_accept"
