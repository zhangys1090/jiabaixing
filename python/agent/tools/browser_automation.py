from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from agent.core.logger import StructuredLogger

log = StructuredLogger("browser")


class BrowserConnectionMode(str, Enum):
    """浏览器连接模式枚举。

    Attributes:
        LOCAL: 本地启动浏览器。
        CDP: 通过Chrome DevTools Protocol连接已有浏览器。
        BROWSERBASE: 通过Browserbase云服务连接。
        BROWSER_USE: 通过browser-use库管理。
    """

    LOCAL = "local"
    CDP = "cdp"
    BROWSERBASE = "browserbase"
    BROWSER_USE = "browser-use"


class BrowserDialogPolicy(str, Enum):
    """浏览器弹窗处理策略。

    Attributes:
        MUST_RESPOND: 必须暂停等待用户响应。
        AUTO_DISMISS: 自动关闭弹窗。
        AUTO_ACCEPT: 自动接受弹窗。
    """

    MUST_RESPOND = "must_respond"
    AUTO_DISMISS = "auto_dismiss"
    AUTO_ACCEPT = "auto_accept"


@dataclass
class BrowserConfig:
    """浏览器自动化配置。

    Attributes:
        connection_mode: 连接模式。
        cdp_url: CDP连接地址（CDP模式时使用）。
        headless: 是否无头模式。
        viewport_width: 视口宽度。
        viewport_height: 视口高度。
        default_timeout: 默认超时（秒）。
        dialog_policy: 弹窗处理策略。
        dialog_timeout: 弹窗等待超时（秒）。
        record_sessions: 是否录制会话。
        user_data_dir: 用户数据目录。
        browserbase_api_key: Browserbase API密钥。
        browserbase_session_id: Browserbase会话ID。
    """

    connection_mode: BrowserConnectionMode = BrowserConnectionMode.LOCAL
    cdp_url: str = ""
    headless: bool = True
    viewport_width: int = 1280
    viewport_height: int = 720
    default_timeout: float = 30.0
    dialog_policy: BrowserDialogPolicy = BrowserDialogPolicy.MUST_RESPOND
    dialog_timeout: float = 300.0
    record_sessions: bool = False
    user_data_dir: str | None = None
    browserbase_api_key: str | None = None
    browserbase_session_id: str | None = None


@dataclass
class BrowserSession:
    """浏览器会话信息。

    Attributes:
        session_id: 会话ID。
        config: 会话配置。
        page_count: 打开的页面数。
        created_at: 创建时间戳。
        last_used: 最后使用时间戳。
    """

    session_id: str
    config: BrowserConfig
    page_count: int = 0
    created_at: float = 0.0
    last_used: float = 0.0


@dataclass
class ScreenshotResult:
    """截图结果。

    Attributes:
        session_id: 会话ID。
        data: 图片二进制数据。
        mime_type: MIME类型。
    """

    session_id: str
    data: bytes
    mime_type: str = "image/png"


@dataclass
class PageContent:
    """页面内容提取结果。

    Attributes:
        url: 页面URL。
        title: 页面标题。
        text: 纯文本内容。
        html: HTML内容。
    """

    url: str
    title: str
    text: str
    html: str


@dataclass
class ElementInfo:
    """页面元素信息。

    Attributes:
        selector: CSS选择器。
        tag: HTML标签名。
        text: 元素文本内容。
        visible: 是否可见。
        attributes: 元素属性字典。
    """

    selector: str
    tag: str
    text: str
    visible: bool
    attributes: dict = field(default_factory=dict)


class BrowserAutomation:
    """浏览器自动化引擎——基于Playwright的多后端支持。

    提供统一的浏览器操作接口，支持CDP、Browserbase和本地三种后端。
    核心功能包括页面导航、截图、元素交互、内容提取和执行JavaScript。

    Usage:
        config = BrowserConfig(connection_mode=BrowserConnectionMode.LOCAL)
        browser = BrowserAutomation(config)
        session = await browser.start_session()
        content = await browser.get_content(session.session_id)
        screenshot = await browser.screenshot(session.session_id)
    """
    def __init__(self, config: BrowserConfig | None = None) -> None:
        self._config = config or BrowserConfig()
        self._sessions: dict[str, BrowserSession] = {}
        self._session_counter: int = 0
        self._browser = None
        self._context = None
        self._playwright = None

    async def launch(self) -> str:
        session_id = self._generate_session_id()
        session = BrowserSession(
            session_id=session_id,
            config=self._config,
            created_at=asyncio.get_event_loop().time(),
        )

        try:
            import importlib
            spec = importlib.util.find_spec("playwright")
            if spec is None:
                raise ImportError("playwright 未安装")

            from playwright.async_api import async_playwright

            self._playwright = await async_playwright().start()

            launch_args: dict[str, Any] = {"headless": self._config.headless}

            if self._config.connection_mode == BrowserConnectionMode.CDP and self._config.cdp_url:
                self._browser = await self._playwright.chromium.connect_over_cdp(
                    self._config.cdp_url
                )
            elif self._config.connection_mode == BrowserConnectionMode.BROWSERBASE:
                self._browser = await self._playwright.chromium.connect_over_cdp(
                    f"wss://connect.browserbase.com?apiKey={self._config.browserbase_api_key}"
                )
            else:
                if self._config.user_data_dir:
                    launch_args["user_data_dir"] = self._config.user_data_dir
                self._browser = await self._playwright.chromium.launch(**launch_args)

            self._context = await self._browser.new_context(
                viewport={
                    "width": self._config.viewport_width,
                    "height": self._config.viewport_height,
                }
            )

            self._context.set_default_timeout(self._config.default_timeout * 1000)

            self._sessions[session_id] = session
            log.info(f"浏览器启动成功: {session_id}")
            return session_id

        except ImportError:
            log.warning("Playwright 未安装，浏览器自动化功能不可用")
            self._sessions[session_id] = session
            return session_id
        except Exception as e:
            log.error(f"浏览器启动失败: {e}")
            raise

    async def close(self, session_id: str | None = None) -> None:
        if session_id:
            session = self._sessions.pop(session_id, None)
            if session:
                log.info(f"关闭浏览器会话: {session_id}")
        else:
            self._sessions.clear()

        try:
            if self._context:
                await self._context.close()
                self._context = None
            if self._browser:
                await self._browser.close()
                self._browser = None
            if self._playwright:
                await self._playwright.stop()
                self._playwright = None
        except Exception as e:
            log.warning(f"关闭浏览器时出错: {e}")

    async def new_page(self, session_id: str) -> Any:
        if not self._context:
            raise RuntimeError("浏览器未启动")

        page = await self._context.new_page()
        session = self._sessions.get(session_id)
        if session:
            session.page_count += 1
        return page

    async def navigate(self, session_id: str, url: str) -> PageContent:
        page = await self._get_or_create_page(session_id)
        await page.goto(url, wait_until="domcontentloaded")
        return await self._get_page_content(page)

    async def screenshot(
        self, session_id: str, full_page: bool = False
    ) -> ScreenshotResult:
        page = await self._get_or_create_page(session_id)
        data = await page.screenshot(full_page=full_page)
        return ScreenshotResult(session_id=session_id, data=data)

    async def click(self, session_id: str, selector: str) -> bool:
        page = await self._get_or_create_page(session_id)
        try:
            await page.click(selector)
            return True
        except Exception as e:
            log.warning(f"点击失败 [{selector}]: {e}")
            return False

    async def type_text(
        self, session_id: str, selector: str, text: str, delay: float = 0
    ) -> bool:
        page = await self._get_or_create_page(session_id)
        try:
            await page.fill(selector, "")
            await page.type(selector, text, delay=delay)
            return True
        except Exception as e:
            log.warning(f"输入失败 [{selector}]: {e}")
            return False

    async def get_text(self, session_id: str, selector: str) -> str:
        page = await self._get_or_create_page(session_id)
        try:
            return await page.text_content(selector) or ""
        except Exception:
            return ""

    async def get_elements(self, session_id: str, selector: str) -> list[ElementInfo]:
        page = await self._get_or_create_page(session_id)
        try:
            elements = await page.query_selector_all(selector)
            result: list[ElementInfo] = []
            for el in elements:
                result.append(ElementInfo(
                    selector=selector,
                    tag=await el.evaluate("el => el.tagName.toLowerCase()"),
                    text=await el.text_content() or "",
                    visible=await el.is_visible(),
                    attributes=await el.evaluate(
                        "el => { const attrs = {}; for (const a of el.attributes) { attrs[a.name] = a.value; } return attrs; }"
                    ),
                ))
            return result
        except Exception:
            return []

    async def execute_js(self, session_id: str, script: str) -> Any:
        page = await self._get_or_create_page(session_id)
        return await page.evaluate(script)

    async def wait_for_selector(
        self, session_id: str, selector: str, timeout: float | None = None
    ) -> bool:
        page = await self._get_or_create_page(session_id)
        try:
            await page.wait_for_selector(selector, timeout=(timeout or self._config.default_timeout) * 1000)
            return True
        except Exception:
            return False

    async def get_page_content(self, session_id: str) -> PageContent:
        page = await self._get_or_create_page(session_id)
        return await self._get_page_content(page)

    async def scroll_to_bottom(self, session_id: str) -> None:
        page = await self._get_or_create_page(session_id)
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")

    async def get_console_logs(self, session_id: str) -> list[str]:
        page = await self._get_or_create_page(session_id)
        logs: list[str] = []
        page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
        return logs

    def get_session(self, session_id: str) -> BrowserSession | None:
        return self._sessions.get(session_id)

    def get_all_sessions(self) -> list[BrowserSession]:
        return list(self._sessions.values())

    @property
    def is_connected(self) -> bool:
        return self._browser is not None and self._browser.is_connected()

    async def _get_or_create_page(self, session_id: str) -> Any:
        if not self._context:
            raise RuntimeError("浏览器未启动，请先调用 launch()")

        pages = self._context.pages
        if not pages:
            page = await self._context.new_page()
            session = self._sessions.get(session_id)
            if session:
                session.page_count += 1
                session.last_used = asyncio.get_event_loop().time()
            return page

        session = self._sessions.get(session_id)
        if session:
            session.last_used = asyncio.get_event_loop().time()
        return pages[-1]

    async def _get_page_content(self, page) -> PageContent:
        url = page.url
        title = await page.title()
        text = await page.text_content("body") or ""
        html = await page.content()
        return PageContent(url=url, title=title, text=text, html=html)

    def _generate_session_id(self) -> str:
        import uuid
        return str(uuid.uuid4())[:8]
