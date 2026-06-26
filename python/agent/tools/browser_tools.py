"""
浏览器自动化工具 - 基于Playwright的多后端浏览器自动化

支持的工具：
- browser_agent: 浏览器智能体，一句话完成浏览器任务
- browser_navigate: 导航到指定URL
- browser_click: 点击页面元素
- browser_type: 在输入框中输入文字
- browser_screenshot: 浏览器截图
- browser_get_text: 获取页面文本内容
- browser_execute_js: 执行JavaScript
"""

from __future__ import annotations

import time
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)
from agent.tools.browser_automation import (
    BrowserAutomation,
    BrowserConfig,
    BrowserConnectionMode,
)


# ─────────────────────────────────────────────────────────────
# 工具定义
# ─────────────────────────────────────────────────────────────

BROWSER_AGENT_DEF = ToolDefinition(
    name="browser_agent",
    description='浏览器智能体，自动完成浏览器操作任务。支持打开网页、点击按钮、填写表单、截图、提取内容等操作。适用场景：用户要求浏览网页、操作网站、抓取信息、填写表单等。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="task", type="string", description="浏览器任务描述，如：打开百度搜索Python、访问github并登录、截取当前页面"),
        ToolParameterDef(name="headless", type="boolean", required=False, description="是否无头模式（不显示浏览器窗口），默认true"),
    ],
    risk_level="medium",
)


BROWSER_NAVIGATE_DEF = ToolDefinition(
    name="browser_navigate",
    description='导航到指定URL并返回页面内容。适用场景：需要访问某个网页、获取页面内容时。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="url", type="string", description="要访问的URL，如 https://www.baidu.com"),
        ToolParameterDef(name="headless", type="boolean", required=False, description="是否无头模式，默认true"),
    ],
    risk_level="low",
)


BROWSER_SCREENSHOT_DEF = ToolDefinition(
    name="browser_screenshot",
    description='浏览器截图，截取当前页面或整个页面。适用场景：需要网页截图、保存页面状态时。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="url", type="string", required=False, description="要截图的URL，不填则截取当前页面"),
        ToolParameterDef(name="full_page", type="boolean", required=False, description="是否截取整页（滚动截图），默认false"),
        ToolParameterDef(name="headless", type="boolean", required=False, description="是否无头模式，默认true"),
    ],
    risk_level="low",
)


BROWSER_CLICK_DEF = ToolDefinition(
    name="browser_click",
    description='点击页面上的元素。适用场景：需要点击按钮、链接、菜单等元素时。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="url", type="string", required=False, description="页面URL，不填则在当前页面操作"),
        ToolParameterDef(name="selector", type="string", description="CSS选择器，如 #submit-btn, .login-button"),
        ToolParameterDef(name="headless", type="boolean", required=False, description="是否无头模式，默认true"),
    ],
    risk_level="medium",
)


BROWSER_TYPE_DEF = ToolDefinition(
    name="browser_type",
    description='在页面输入框中输入文字。适用场景：需要填写表单、搜索框输入等。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="url", type="string", required=False, description="页面URL，不填则在当前页面操作"),
        ToolParameterDef(name="selector", type="string", description="输入框的CSS选择器，如 #search-input"),
        ToolParameterDef(name="text", type="string", description="要输入的文字"),
        ToolParameterDef(name="headless", type="boolean", required=False, description="是否无头模式，默认true"),
    ],
    risk_level="medium",
)


BROWSER_GET_TEXT_DEF = ToolDefinition(
    name="browser_get_text",
    description='获取页面或元素的文本内容。适用场景：需要提取网页文字内容时。',
    category=ToolCategory.DESKTOP,
    parameters=[
        ToolParameterDef(name="url", type="string", required=False, description="页面URL，不填则获取当前页面"),
        ToolParameterDef(name="selector", type="string", required=False, description="元素CSS选择器，不填则获取整个页面文本"),
        ToolParameterDef(name="headless", type="boolean", required=False, description="是否无头模式，默认true"),
    ],
    risk_level="low",
)


# ─────────────────────────────────────────────────────────────
# 浏览器会话管理（单例）
# ─────────────────────────────────────────────────────────────

_browser_instance: BrowserAutomation | None = None
_current_session_id: str | None = None


def _get_browser(headless: bool = True) -> tuple[BrowserAutomation, str]:
    """获取或创建浏览器实例"""
    global _browser_instance, _current_session_id

    if _browser_instance is None or not _browser_instance.is_connected:
        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.LOCAL,
            headless=headless,
        )
        _browser_instance = BrowserAutomation(config)
        _current_session_id = None

    if _current_session_id is None:
        import asyncio
        # 注意：这里需要在async环境中调用
        _current_session_id = "pending"

    return _browser_instance, _current_session_id


# ─────────────────────────────────────────────────────────────
# 工具执行器
# ─────────────────────────────────────────────────────────────

async def browser_agent_executor(params: dict[str, Any]) -> ToolResult:
    """浏览器智能体执行器 - 高级接口"""
    start = time.time()
    task = str(params.get("task", ""))
    headless = bool(params.get("headless", True))

    if not task:
        return ToolResult(success=False, error="请提供浏览器任务描述", duration=time.time() - start)

    try:
        # 简单任务解析
        task_lower = task.lower()

        # 创建浏览器实例
        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.LOCAL,
            headless=headless,
        )
        browser = BrowserAutomation(config)
        session_id = await browser.launch()

        try:
            output = f"🌐 浏览器任务: {task}\n\n"

            # 导航类任务
            if "打开" in task_lower or "访问" in task_lower or "open" in task_lower:
                # 简单提取URL
                import re
                url_match = re.search(r'https?://[^\s，。、]+', task)
                if url_match:
                    url = url_match.group()
                    content = await browser.navigate(session_id, url)
                    output += f"✅ 已打开: {url}\n"
                    output += f"📄 页面标题: {content.title}\n"
                    output += f"📝 内容预览: {content.text[:200]}..."
                else:
                    output += "⚠️ 未检测到URL，请提供完整的网址"

            # 截图类任务
            elif "截图" in task_lower or "screenshot" in task_lower:
                screenshot = await browser.screenshot(session_id, full_page=False)
                # 保存截图
                import os
                from pathlib import Path
                screenshot_dir = Path(os.environ.get("DATA_DIR", "data")) / "screenshots"
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                save_path = screenshot_dir / f"browser_{timestamp}.png"
                with open(save_path, "wb") as f:
                    f.write(screenshot.data)
                output += f"📸 截图已保存: {save_path}"

            else:
                output += "ℹ️ 浏览器自动化已就绪\n"
                output += "支持的操作：导航、截图、点击、输入、提取文本等\n"
                output += "提示：可以使用 browser_navigate, browser_click, browser_type 等工具进行精确操作"

            return ToolResult(success=True, output=output, duration=time.time() - start)

        finally:
            await browser.close(session_id)

    except ImportError:
        return ToolResult(
            success=False,
            error="Playwright 未安装。请运行: pip install playwright && playwright install chromium",
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"浏览器操作失败: {e}", duration=time.time() - start)


async def browser_navigate_executor(params: dict[str, Any]) -> ToolResult:
    """导航执行器"""
    start = time.time()
    url = str(params.get("url", ""))
    headless = bool(params.get("headless", True))

    if not url:
        return ToolResult(success=False, error="请提供URL", duration=time.time() - start)

    try:
        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.LOCAL,
            headless=headless,
        )
        browser = BrowserAutomation(config)
        session_id = await browser.launch()

        try:
            content = await browser.navigate(session_id, url)
            output = f"✅ 已导航到: {url}\n"
            output += f"📄 页面标题: {content.title}\n"
            output += f"📝 内容预览:\n{content.text[:500]}..."
            return ToolResult(success=True, output=output, duration=time.time() - start)
        finally:
            await browser.close(session_id)

    except ImportError:
        return ToolResult(
            success=False,
            error="Playwright 未安装。请运行: pip install playwright && playwright install chromium",
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"导航失败: {e}", duration=time.time() - start)


async def browser_screenshot_executor(params: dict[str, Any]) -> ToolResult:
    """浏览器截图执行器"""
    start = time.time()
    url = str(params.get("url", ""))
    full_page = bool(params.get("full_page", False))
    headless = bool(params.get("headless", True))

    try:
        import os
        from pathlib import Path

        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.LOCAL,
            headless=headless,
        )
        browser = BrowserAutomation(config)
        session_id = await browser.launch()

        try:
            if url:
                await browser.navigate(session_id, url)

            screenshot = await browser.screenshot(session_id, full_page=full_page)

            screenshot_dir = Path(os.environ.get("DATA_DIR", "data")) / "screenshots"
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            save_path = screenshot_dir / f"browser_{timestamp}.png"
            with open(save_path, "wb") as f:
                f.write(screenshot.data)

            output = f"📸 浏览器截图已保存: {save_path}"
            if url:
                output += f"\n🌐 页面: {url}"
            if full_page:
                output += "\n📜 整页截图"

            return ToolResult(success=True, output=output, duration=time.time() - start)
        finally:
            await browser.close(session_id)

    except ImportError:
        return ToolResult(
            success=False,
            error="Playwright 未安装。请运行: pip install playwright && playwright install chromium",
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"截图失败: {e}", duration=time.time() - start)


async def browser_click_executor(params: dict[str, Any]) -> ToolResult:
    """点击执行器"""
    start = time.time()
    url = str(params.get("url", ""))
    selector = str(params.get("selector", ""))
    headless = bool(params.get("headless", True))

    if not selector:
        return ToolResult(success=False, error="请提供CSS选择器", duration=time.time() - start)

    try:
        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.LOCAL,
            headless=headless,
        )
        browser = BrowserAutomation(config)
        session_id = await browser.launch()

        try:
            if url:
                await browser.navigate(session_id, url)

            success = await browser.click(session_id, selector)
            if success:
                return ToolResult(
                    success=True,
                    output=f"✅ 已点击元素: {selector}",
                    duration=time.time() - start,
                )
            else:
                return ToolResult(
                    success=False,
                    error=f"点击失败，未找到元素: {selector}",
                    duration=time.time() - start,
                )
        finally:
            await browser.close(session_id)

    except ImportError:
        return ToolResult(
            success=False,
            error="Playwright 未安装。请运行: pip install playwright && playwright install chromium",
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"点击失败: {e}", duration=time.time() - start)


async def browser_type_executor(params: dict[str, Any]) -> ToolResult:
    """输入文字执行器"""
    start = time.time()
    url = str(params.get("url", ""))
    selector = str(params.get("selector", ""))
    text = str(params.get("text", ""))
    headless = bool(params.get("headless", True))

    if not selector:
        return ToolResult(success=False, error="请提供CSS选择器", duration=time.time() - start)
    if not text:
        return ToolResult(success=False, error="请提供要输入的文字", duration=time.time() - start)

    try:
        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.LOCAL,
            headless=headless,
        )
        browser = BrowserAutomation(config)
        session_id = await browser.launch()

        try:
            if url:
                await browser.navigate(session_id, url)

            success = await browser.type_text(session_id, selector, text)
            if success:
                return ToolResult(
                    success=True,
                    output=f'✅ 已在 {selector} 中输入: "{text}"',
                    duration=time.time() - start,
                )
            else:
                return ToolResult(
                    success=False,
                    error=f"输入失败，未找到元素: {selector}",
                    duration=time.time() - start,
                )
        finally:
            await browser.close(session_id)

    except ImportError:
        return ToolResult(
            success=False,
            error="Playwright 未安装。请运行: pip install playwright && playwright install chromium",
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"输入失败: {e}", duration=time.time() - start)


async def browser_get_text_executor(params: dict[str, Any]) -> ToolResult:
    """获取文本执行器"""
    start = time.time()
    url = str(params.get("url", ""))
    selector = str(params.get("selector", ""))
    headless = bool(params.get("headless", True))

    try:
        config = BrowserConfig(
            connection_mode=BrowserConnectionMode.LOCAL,
            headless=headless,
        )
        browser = BrowserAutomation(config)
        session_id = await browser.launch()

        try:
            if url:
                await browser.navigate(session_id, url)

            if selector:
                text = await browser.get_text(session_id, selector)
                return ToolResult(
                    success=True,
                    output=f"📝 元素 {selector} 的文本:\n{text}",
                    duration=time.time() - start,
                )
            else:
                content = await browser.get_page_content(session_id)
                return ToolResult(
                    success=True,
                    output=f"📄 页面标题: {content.title}\n📝 页面文本:\n{content.text[:1000]}...",
                    duration=time.time() - start,
                )
        finally:
            await browser.close(session_id)

    except ImportError:
        return ToolResult(
            success=False,
            error="Playwright 未安装。请运行: pip install playwright && playwright install chromium",
            duration=time.time() - start,
        )
    except Exception as e:
        return ToolResult(success=False, error=f"获取文本失败: {e}", duration=time.time() - start)
