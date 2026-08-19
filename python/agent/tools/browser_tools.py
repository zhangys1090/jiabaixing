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

from agent.core.logger import StructuredLogger
from agent.core.logger import log_ignored
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

log = StructuredLogger("browser_tools")


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


BROWSER_FILL_FORM_DEF = ToolDefinition(
    name="browser_fill_form",
    description='语义化表单填写——根据字段描述自动匹配并填写表单。策略：1.label文本匹配 2.placeholder匹配 3.name属性匹配 4.输入框类型推断。支持iframe内表单、动态加载表单。适用场景：需要填写登录表单、搜索表单、注册表单等。不适用：单个输入框（用browser_type）。',
    short_desc="语义化表单填写",
    category=ToolCategory.DESKTOP,
    tags=["browser", "form", "fill", "semantic", "auto", "iframe"],
    scenes=["desktop", "daily", "research"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="url", type="string", required=False, description="页面URL，不填则在当前页面操作"),
        ToolParameterDef(name="fields", type="string", description="表单字段JSON，如 {\"用户名\": \"zhangsan\", \"密码\": \"xxx\", \"邮箱\": \"a@b.com\"}"),
        ToolParameterDef(name="submit", type="boolean", required=False, description="填写完成后是否自动提交表单，默认false"),
        ToolParameterDef(name="headless", type="boolean", required=False, description="是否无头模式，默认true"),
        ToolParameterDef(name="iframe", type="string", required=False, description="iframe的CSS选择器，表单在iframe内时填写"),
        ToolParameterDef(name="wait_for", type="string", required=False, description="等待表单出现的CSS选择器（动态加载表单），最多等5秒"),
    ],
    risk_level="medium",
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
        log.warning("browser_agent: 任务为空")
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


async def browser_fill_form_executor(params: dict[str, Any]) -> ToolResult:
    """语义化表单填写执行器 — 支持 iframe / 动态加载"""
    start = time.time()
    url = str(params.get("url", ""))
    fields_str = str(params.get("fields", ""))
    do_submit = bool(params.get("submit", False))
    headless = bool(params.get("headless", True))
    iframe_selector = str(params.get("iframe", ""))
    wait_for_selector = str(params.get("wait_for", ""))

    if not fields_str:
        return ToolResult(success=False, error="请提供表单字段JSON", duration=time.time() - start)

    import json
    try:
        fields = json.loads(fields_str)
    except json.JSONDecodeError:
        return ToolResult(success=False, error="fields参数必须是合法JSON，如 {\"用户名\": \"zhangsan\"}", duration=time.time() - start)

    if not isinstance(fields, dict) or not fields:
        return ToolResult(success=False, error="fields必须是非空JSON对象", duration=time.time() - start)

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

            page = await browser._get_or_create_page(session_id)

            # ─── 等待动态加载 ───
            if wait_for_selector:
                try:
                    await page.wait_for_selector(wait_for_selector, timeout=5000)
                except Exception as _exc:
                    log_ignored(log, "browser_tools.browser_fill_form_executor", _exc)

            # ─── iframe 处理 ───
            fill_context: Any = page
            if iframe_selector:
                try:
                    frame_locator = page.frame_locator(iframe_selector)
                    fill_context = frame_locator
                except Exception as _exc:
                    log_ignored(log, "browser_tools.browser_fill_form_executor", _exc)

            results: dict[str, bool] = {}

            # ─── CAPTCHA 检测 ───
            captcha_info = await _detect_captcha(fill_context if iframe_selector else page)
            if captcha_info["detected"]:
                return ToolResult(
                    success=False,
                    output=f"检测到验证码（{captcha_info['type']}），需要人工处理或使用专用工具。\n提示：可先手动完成验证码，再调用此工具填写表单。",
                    duration=time.time() - start,
                    metadata={"captcha_detected": True, "captcha_type": captcha_info["type"], "captcha_info": captcha_info},
                )

            for desc, value in fields.items():
                selector = await _find_input_selector(fill_context, desc, is_frame=bool(iframe_selector))
                if selector:
                    try:
                        if iframe_selector and fill_context is not page:
                            fill_context.locator(selector).fill(str(value))
                        else:
                            await page.fill(selector, str(value))
                        results[desc] = True
                    except Exception:
                        results[desc] = False
                else:
                    results[desc] = False

            if do_submit:
                try:
                    submit_sel = 'button[type="submit"], input[type="submit"]'
                    if iframe_selector and fill_context is not page:
                        btn = fill_context.locator(submit_sel).first
                        if await btn.count() > 0:
                            await btn.click()
                    else:
                        submit_btn = page.locator(submit_sel).first
                        if await submit_btn.count() > 0:
                            await submit_btn.click()
                except Exception as _exc:
                    log_ignored(log, "browser_tools.browser_fill_form_executor", _exc)

            filled = sum(1 for v in results.values() if v)
            total = len(results)
            lines = [f"表单填写完成: {filled}/{total} 个字段成功"]
            if iframe_selector:
                lines.append(f"  (iframe: {iframe_selector})")
            for desc, ok in results.items():
                icon = "✅" if ok else "❌"
                lines.append(f"  {icon} {desc}")

            return ToolResult(
                success=filled > 0,
                output="\n".join(lines),
                duration=time.time() - start,
                metadata=results,
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
        return ToolResult(success=False, error=f"表单填写失败: {e}", duration=time.time() - start)


async def _detect_captcha(page: Any) -> dict[str, Any]:
    """检测页面中的验证码（CAPTCHA）"""
    captcha_selectors = {
        "recaptcha": [
            'iframe[src*="google.com/recaptcha"]',
            'div.g-recaptcha',
            '.g-recaptcha',
        ],
        "hcaptcha": [
            'iframe[src*="hcaptcha.com"]',
            '#hcaptcha-widget',
            '[data-hcaptcha-widget]',
        ],
        "image_captcha": [
            'img[alt*="captcha" i]',
            'img[alt*="验证码" i]',
            'img.captcha',
            '.captcha-image img',
            'img[src*="captcha" i]',
        ],
        "slider_captcha": [
            '.slider-verify',
            '.drag-verify',
            '[class*="slider"] [class*="verify"]',
            '[class*="drag"] [class*="verify"]',
        ],
    }

    result: dict[str, Any] = {
        "detected": False,
        "type": None,
        "selector": None,
        "hint": "",
    }

    for captcha_type, selectors in captcha_selectors.items():
        for sel in selectors:
            try:
                elem = page.locator(sel).first
                if await elem.count() > 0:
                    is_visible = await elem.is_visible()
                    if is_visible:
                        result["detected"] = True
                        result["type"] = captcha_type
                        result["selector"] = sel
                        if captcha_type == "recaptcha":
                            result["hint"] = "Google reCAPTCHA，可能需要点击复选框或完成图片选择"
                        elif captcha_type == "hcaptcha":
                            result["hint"] = "hCaptcha 验证码"
                        elif captcha_type == "image_captcha":
                            result["hint"] = "图片验证码，需要输入文字"
                        elif captcha_type == "slider_captcha":
                            result["hint"] = "滑块验证码，需要拖动滑块到正确位置"
                        return result
            except Exception as e:
                log_ignored(log, "browser_tools._detect_captcha", e)
                continue

    return result


async def _find_input_selector(page: Any, description: str, is_frame: bool = False) -> str | None:
    """根据字段描述自动匹配输入框选择器

    策略优先级：
    1. label文本匹配 → for属性
    2. placeholder匹配
    3. name属性匹配
    4. 输入框类型推断（密码/邮箱/搜索等）
    5. aria-label 匹配
    """
    desc_lower = description.lower()

    type_hints: dict[str, str] = {
        "密码": "input[type='password']",
        "password": "input[type='password']",
        "邮箱": "input[type='email']",
        "email": "input[type='email']",
        "搜索": "input[type='search']",
        "search": "input[type='search']",
        "电话": "input[type='tel']",
        "phone": "input[type='tel']",
        "网址": "input[type='url']",
        "url": "input[type='url']",
        "手机": "input[type='tel']",
        "日期": "input[type='date']",
        "date": "input[type='date']",
    }

    # 策略1: label文本匹配
    try:
        label = page.locator(f'label:has-text("{description}")').first
        if await label.count() > 0:
            if not is_frame:
                for_attr = await label.get_attribute("for")
                if for_attr:
                    return f"#{for_attr}"
            input_inside = label.locator("input, textarea, select").first
            if await input_inside.count() > 0:
                return "input, textarea, select"
    except Exception as _exc:
        log_ignored(log, "browser_tools._find_input_selector", _exc)

    # 策略2: placeholder匹配
    try:
        by_placeholder = page.locator(f'[placeholder*="{description}" i]').first
        if await by_placeholder.count() > 0:
            return f'[placeholder*="{description}" i]'
    except Exception as _exc:
        log_ignored(log, "browser_tools._find_input_selector", _exc)

    # 策略3: name属性匹配
    try:
        by_name = page.locator(f'[name*="{desc_lower}" i]').first
        if await by_name.count() > 0:
            return f'[name*="{desc_lower}" i]'
    except Exception as _exc:
        log_ignored(log, "browser_tools._find_input_selector", _exc)

    # 策略4: aria-label 匹配
    try:
        by_aria = page.locator(f'[aria-label*="{description}" i]').first
        if await by_aria.count() > 0:
            return f'[aria-label*="{description}" i]'
    except Exception as _exc:
        log_ignored(log, "browser_tools._find_input_selector", _exc)

    # 策略5: 类型推断
    for hint, selector in type_hints.items():
        if hint in desc_lower:
            try:
                elem = page.locator(selector).first
                if await elem.count() > 0:
                    return selector
            except Exception as _exc:
                log_ignored(log, "browser_tools._find_input_selector", _exc)

    return None
