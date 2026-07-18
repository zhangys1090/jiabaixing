"""
感知工具集 — 五感感知 + 操作验证 + 智能等待

将五感与手脚能力注册为 Tool，复用 ToolRegistry 统一调度。
LLM 在推理循环中自主决定何时感知、何时执行。

工具清单：
- screen_parse:     可交互元素检测 + Set-of-Mark 标注
- action_verify:    操作后自动验证（截图对比）
- smart_wait:       智能等待（等UI响应/屏幕变化/屏幕稳定）
- speech_transcribe: 语音转文字（faster-whisper STT）
"""

from __future__ import annotations

import asyncio
import io
import os
import time
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)

log: Any = None


def _get_logger() -> Any:
    global log
    if log is None:
        from agent.core.logger import StructuredLogger
        log = StructuredLogger("perception_tools")
    return log


# ═══════════════════════════════════════════════════════════════
# 工具定义
# ═══════════════════════════════════════════════════════════════

SCREEN_PARSE_DEF = ToolDefinition(
    name="screen_parse",
    description=(
        "解析屏幕截图，检测可交互元素并生成Set-of-Mark标注图。"
        "桌面端优先使用Accessibility Tree（精确、零GPU），不可用时降级到OCR+视觉检测。"
        "浏览器端提取DOM可交互元素。"
        "适用场景：Agent需要知道屏幕上有哪些可点击/可输入的元素时。"
        "不适用：只需要截图（用desktop_screenshot）。"
    ),
    short_desc="检测屏幕可交互元素+标注",
    category=ToolCategory.PERCEPTION,
    tags=["screen", "parse", "element", "accessibility", "som", "perception"],
    scenes=["desktop", "browser"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="context", type="string", required=False,
                         description="解析上下文：desktop（桌面应用）或 browser（浏览器），默认desktop",
                         enum=["desktop", "browser"]),
        ToolParameterDef(name="annotate", type="boolean", required=False,
                         description="是否生成Set-of-Mark标注图（在截图上标编号），默认true"),
    ],
    risk_level="low",
)


ACTION_VERIFY_DEF = ToolDefinition(
    name="action_verify",
    description=(
        "操作后自动验证——截图对比确认操作是否生效。"
        "策略自动选择：1.像素差异检测（快速，默认）2.区域OCR对比（检测文字变化）3.VLM判断（精确，需Vision模型）。"
        "适用场景：Agent执行点击/输入等操作后，需要确认操作是否生效。"
        "不适用：操作前预判（用preview_execution）。"
    ),
    short_desc="操作后截图验证",
    category=ToolCategory.PERCEPTION,
    tags=["verify", "screenshot", "diff", "perception", "feedback"],
    scenes=["desktop", "browser"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="pre_screenshot", type="string", required=False,
                         description="操作前截图路径（留空则自动取最近截图）"),
        ToolParameterDef(name="target_region", type="string", required=False,
                         description="关注区域，格式 x1,y1,x2,y2（归一化0-1000），留空则全屏对比"),
        ToolParameterDef(name="threshold", type="number", required=False,
                         description="像素差异阈值(0-1)，低于此值认为无变化，默认0.01"),
        ToolParameterDef(name="strategy", type="string", required=False,
                         description="验证策略：auto（自动选择）、pixel（像素差异）、ocr（OCR文字对比）、vlm（Vision模型判断），默认auto",
                         enum=["auto", "pixel", "ocr", "vlm"]),
        ToolParameterDef(name="question", type="string", required=False,
                         description="VLM策略时的验证问题，如'是否出现了成功提示'，留空则自动判断"),
    ],
    risk_level="low",
)


SMART_WAIT_DEF = ToolDefinition(
    name="smart_wait",
    description=(
        "智能等待——等待UI响应后再继续。"
        "支持三种模式：change（等屏幕变化）、stable（等屏幕稳定）、selector（等DOM元素出现，仅浏览器）。"
        "适用场景：执行操作后等待UI加载/动画完成。"
        "不适用：固定时间等待（直接用asyncio.sleep）。"
    ),
    short_desc="智能等待UI响应",
    category=ToolCategory.PERCEPTION,
    tags=["wait", "ui", "stable", "change", "perception"],
    scenes=["desktop", "browser"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="mode", type="string",
                         description="等待模式：change（等屏幕变化）、stable（等屏幕稳定连续N帧无变化）、selector（等DOM元素出现）",
                         enum=["change", "stable", "selector"]),
        ToolParameterDef(name="timeout", type="number", required=False,
                         description="最大等待时间(秒)，默认5.0"),
        ToolParameterDef(name="poll_interval", type="number", required=False,
                         description="轮询间隔(秒)，默认0.3"),
        ToolParameterDef(name="selector", type="string", required=False,
                         description="CSS选择器（selector模式必填）"),
    ],
    risk_level="low",
)


SPEECH_TRANSCRIBE_DEF = ToolDefinition(
    name="speech_transcribe",
    description=(
        "语音转文字（STT）。基于faster-whisper本地模型，支持中英文混合。"
        "自动检测GPU/CPU，GPU可用时自动启用CUDA加速。支持流式输出。"
        "适用场景：用户语音输入、音频文件转文字。"
        "不适用：文字转语音（用voice_interact的speak操作）。"
    ),
    short_desc="语音转文字(STT)",
    category=ToolCategory.PERCEPTION,
    tags=["speech", "stt", "whisper", "audio", "transcribe", "perception"],
    scenes=["daily", "desktop"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="audio_path", type="string",
                         description="音频文件路径（支持wav/mp3/flac/m4a）"),
        ToolParameterDef(name="language", type="string", required=False,
                         description="语言代码，默认zh（中文），可选en/ja/ko/auto"),
        ToolParameterDef(name="model", type="string", required=False,
                         description="Whisper模型大小：tiny/base/small/medium/large，默认base",
                         enum=["tiny", "base", "small", "medium", "large"]),
        ToolParameterDef(name="stream", type="boolean", required=False,
                         description="是否流式输出（逐段返回），默认false"),
    ],
    risk_level="low",
)


# ═══════════════════════════════════════════════════════════════
# 工具执行器
# ═══════════════════════════════════════════════════════════════

async def screen_parse_executor(params: dict[str, Any]) -> ToolResult:
    """屏幕解析执行器"""
    start = time.time()
    context = str(params.get("context", "desktop")).lower()
    annotate = bool(params.get("annotate", True))

    try:
        if context == "browser":
            return await _parse_browser(annotate, start)

        return await _parse_desktop(annotate, start)

    except Exception as e:
        return ToolResult(success=False, error=f"屏幕解析失败: {e}", duration=time.time() - start)


async def _parse_desktop(annotate: bool, start: float) -> ToolResult:
    """桌面端解析：优先Accessibility Tree，降级OCR"""
    elements: list[dict[str, Any]] = []

    # 通道1: Windows UI Automation
    a11y_elements = _try_accessibility_tree()
    if a11y_elements:
        elements = a11y_elements
    else:
        # 通道2: 截图 + OCR 提取文字区域作为可交互元素候选
        ocr_elements = await _try_ocr_elements()
        elements = ocr_elements

    if not elements:
        return ToolResult(
            success=True,
            output="未检测到可交互元素（可能无桌面环境或Accessibility API不可用）",
            duration=time.time() - start,
        )

    # 生成元素摘要
    lines = [f"检测到 {len(elements)} 个可交互元素："]
    for i, elem in enumerate(elements[:30]):
        name = elem.get("name", "")
        elem_type = elem.get("type", "")
        bbox = elem.get("bbox", "")
        lines.append(f"  [{i}] {elem_type}: {name} @ {bbox}")

    if len(elements) > 30:
        lines.append(f"  ... 共 {len(elements)} 个")

    # Set-of-Mark 标注
    annotated_path = ""
    if annotate and elements:
        annotated_path = await _render_set_of_mark(elements)

    output = "\n".join(lines)
    if annotated_path:
        output += f"\n\nSet-of-Mark标注图: {annotated_path}"

    return ToolResult(
        success=True,
        output=output,
        duration=time.time() - start,
        metadata={"element_count": len(elements), "annotated_image": annotated_path},
    )


async def _parse_browser(annotate: bool, start: float) -> ToolResult:
    """浏览器端解析：提取DOM可交互元素"""
    try:
        from agent.tools.browser_automation import BrowserAutomation, BrowserConfig, BrowserConnectionMode
        config = BrowserConfig(connection_mode=BrowserConnectionMode.LOCAL, headless=True)
        browser = BrowserAutomation(config)
        session_id = await browser.launch()

        try:
            elements = await _extract_browser_dom_elements(browser, session_id)

            if not elements:
                return ToolResult(
                    success=True,
                    output="浏览器页面无可交互元素",
                    duration=time.time() - start,
                )

            lines = [f"检测到 {len(elements)} 个可交互DOM元素："]
            for i, elem in enumerate(elements[:30]):
                tag = elem.get("tag", "")
                text = elem.get("text", "")[:40]
                selector = elem.get("selector", "")
                lines.append(f"  [{i}] <{tag}> {text} → {selector}")

            if len(elements) > 30:
                lines.append(f"  ... 共 {len(elements)} 个")

            return ToolResult(
                success=True,
                output="\n".join(lines),
                duration=time.time() - start,
                metadata={"element_count": len(elements)},
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
        return ToolResult(success=False, error=f"浏览器DOM解析失败: {e}", duration=time.time() - start)


def _try_accessibility_tree() -> list[dict[str, Any]]:
    """尝试通过 Windows UI Automation / macOS Accessibility 获取控件树"""
    import platform
    system = platform.system().lower()

    if system == "windows":
        return _try_win32_uia()
    if system == "darwin":
        return _try_macos_a11y()

    return []


def _try_macos_a11y() -> list[dict[str, Any]]:
    """macOS Accessibility 实现 — 通过 ApplicationServices / pyobjc"""
    try:
        import ApplicationServices
        from ApplicationServices import (
            AXUIElementCreateApplication,
            AXUIElementCopyAttributeValue,
            AXUIElementCopyAttributeNames,
            kAXErrorSuccess,
            kAXChildrenAttribute,
            kAXRoleAttribute,
            kAXTitleAttribute,
            kAXValueAttribute,
            kAXPositionAttribute,
            kAXSizeAttribute,
        )
    except ImportError:
        return []

    try:
        from AppKit import NSWorkspace
        active_app = NSWorkspace.sharedWorkspace().frontmostApplication()
        pid = active_app.processIdentifier()
        system_wide = AXUIElementCreateApplication(pid)

        elements: list[dict[str, Any]] = []
        _walk_macos_a11y(system_wide, elements, depth=0, max_depth=4)
        return elements
    except Exception:
        return []


def _walk_macos_a11y(element: Any, result: list[dict[str, Any]], depth: int, max_depth: int) -> None:
    """递归遍历 macOS Accessibility 控件树"""
    if depth > max_depth:
        return

    from ApplicationServices import (
        AXUIElementCopyAttributeValue,
        AXUIElementCopyAttributeNames,
        kAXErrorSuccess,
        kAXChildrenAttribute,
        kAXRoleAttribute,
        kAXTitleAttribute,
        kAXValueAttribute,
        kAXPositionAttribute,
        kAXSizeAttribute,
    )

    interactive_roles = {
        "AXButton", "AXCheckBox", "AXPopUpButton", "AXComboBox",
        "AXTextField", "AXTextArea", "AXLink", "AXMenuItem",
        "AXTabButton", "AXRadioButton", "AXSlider",
    }

    try:
        role = _ax_get_attr(element, kAXRoleAttribute) or ""
        name = _ax_get_attr(element, kAXTitleAttribute) or _ax_get_attr(element, kAXValueAttribute) or ""

        if role in interactive_roles:
            pos = _ax_get_attr(element, kAXPositionAttribute)
            size = _ax_get_attr(element, kAXSizeAttribute)
            bbox = ""
            if pos and size:
                try:
                    x, y = pos[0], pos[1]
                    w, h = size[0], size[1]
                    bbox = f"({int(x)},{int(y)},{int(x + w)},{int(y + h)})"
                except (TypeError, IndexError):
                    pass

            result.append({
                "name": str(name),
                "type": role,
                "bbox": bbox,
            })

        children_val = _ax_get_attr(element, kAXChildrenAttribute)
        if children_val:
            for child in children_val:
                _walk_macos_a11y(child, result, depth + 1, max_depth)

    except Exception:
        pass


def _ax_get_attr(element: Any, attr: str) -> Any:
    """安全获取 macOS AX 属性"""
    from ApplicationServices import AXUIElementCopyAttributeValue, kAXErrorSuccess
    code, value = AXUIElementCopyAttributeValue(element, attr, None)
    if code == kAXErrorSuccess:
        return value
    return None


def _try_win32_uia() -> list[dict[str, Any]]:
    """Windows UI Automation 实现"""
    try:
        import comtypes.client
        uia = comtypes.client.CreateObject(
            "{ff48dba4-60ef-4201-aa87-3f5f29773a3d}"
        )
        root = uia.GetRootElement()

        elements: list[dict[str, Any]] = []
        _walk_uia_tree(root, elements, depth=0, max_depth=4)
        return elements
    except Exception:
        return []


def _walk_uia_tree(element: Any, result: list[dict[str, Any]], depth: int, max_depth: int) -> None:
    """递归遍历 UI Automation 控件树"""
    if depth > max_depth:
        return

    try:
        control_type = str(getattr(element, "CurrentControlType", ""))
        name = str(getattr(element, "CurrentName", ""))

        interactive_types = {
            "50000",  # Button
            "50004",  # CheckBox
            "50005",  # ComboBox
            "50006",  # Edit
            "50009",  # Hyperlink
            "50013",  # ListItem
            "50014",  # Menu
            "50015",  # MenuItem
            "50026",  # TabItem
            "50033",  # TreeItem
        }

        if control_type in interactive_types:
            rect = getattr(element, "CurrentBoundingRectangle", None)
            bbox = ""
            if rect:
                bbox = f"({rect.left},{rect.top},{rect.right},{rect.bottom})"

            result.append({
                "name": name,
                "type": control_type,
                "bbox": bbox,
            })

        children = element.GetChildren()
        if children:
            for child in children:
                _walk_uia_tree(child, result, depth + 1, max_depth)

    except Exception:
        pass


async def _try_ocr_elements() -> list[dict[str, Any]]:
    """降级方案：截图 + OCR 提取文字区域"""
    try:
        from agent.desktop.desktop_controller import get_desktop_controller
        controller = get_desktop_controller()
        screenshot_result = controller.screenshot_full()
        if not screenshot_result.success:
            return []

        try:
            import pytesseract
            from PIL import Image

            img = Image.open(screenshot_result.image_path)
            data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, lang="chi_sim+eng")

            elements: list[dict[str, Any]] = []
            for i in range(len(data["text"])):
                text = data["text"][i].strip()
                if not text:
                    continue
                x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
                elements.append({
                    "name": text,
                    "type": "text",
                    "bbox": f"({x},{y},{x + w},{y + h})",
                })
            return elements
        except ImportError:
            return []

    except Exception:
        return []


async def _extract_browser_dom_elements(
    browser: Any, session_id: str,
) -> list[dict[str, Any]]:
    """提取浏览器DOM可交互元素"""
    try:
        page = await browser._get_or_create_page(session_id)
        js = """
        () => {
            const interactive = document.querySelectorAll(
                'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick]'
            );
            return Array.from(interactive).slice(0, 50).map((el, i) => {
                const rect = el.getBoundingClientRect();
                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || el.value || el.placeholder || '').trim().slice(0, 40);
                const id = el.id ? '#' + el.id : '';
                const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '';
                const name = el.name ? `[name="${el.name}"]` : '';
                return {
                    index: i,
                    tag,
                    text,
                    selector: id || name || tag + cls || tag,
                    bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.x + rect.width)},${Math.round(rect.y + rect.height)}`
                };
            });
        }
        """
        elements = await page.evaluate(js)
        return elements or []
    except Exception:
        return []


async def _render_set_of_mark(elements: list[dict[str, Any]]) -> str:
    """在截图上标注元素编号（Set-of-Mark）"""
    try:
        from agent.desktop.desktop_controller import get_desktop_controller
        from PIL import Image, ImageDraw

        controller = get_desktop_controller()
        screenshot_result = controller.screenshot_full()
        if not screenshot_result.success:
            return ""

        img = Image.open(screenshot_result.image_path)
        draw = ImageDraw.Draw(img)

        for i, elem in enumerate(elements[:30]):
            bbox_str = elem.get("bbox", "")
            if not bbox_str:
                continue
            try:
                bbox_str = bbox_str.strip("()")
                parts = [int(p.strip()) for p in bbox_str.split(",")]
                if len(parts) == 4:
                    draw.rectangle(parts, outline="red", width=2)
                    draw.text((parts[0], max(0, parts[1] - 14)), f"[{i}]", fill="red")
            except (ValueError, IndexError):
                continue

        from pathlib import Path
        som_dir = Path(os.environ.get("DATA_DIR", "data")) / "screenshots"
        som_dir.mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        save_path = som_dir / f"som_{timestamp}.png"
        img.save(str(save_path))
        return str(save_path)

    except Exception:
        return ""


# ─────────────────────────────────────────────────────────────
# action_verify 执行器
# ─────────────────────────────────────────────────────────────

async def action_verify_executor(params: dict[str, Any]) -> ToolResult:
    """操作后验证执行器 — 支持像素/OCR/VLM三种策略"""
    start = time.time()
    pre_screenshot = params.get("pre_screenshot", "")
    target_region = params.get("target_region", "")
    threshold = float(params.get("threshold", 0.01))
    strategy = str(params.get("strategy", "auto")).lower()
    question = str(params.get("question", ""))

    try:
        from agent.desktop.desktop_controller import get_desktop_controller
        controller = get_desktop_controller()

        post_result = controller.screenshot_full()
        if not post_result.success:
            return ToolResult(success=False, error="操作后截图失败", duration=time.time() - start)

        pre_path = str(pre_screenshot) if pre_screenshot else _get_latest_screenshot()
        if not pre_path or not os.path.exists(pre_path):
            return ToolResult(
                success=True,
                output=f"无法获取操作前截图，仅保存操作后截图: {post_result.image_path}",
                duration=time.time() - start,
                metadata={"changed": None, "method": "no_baseline"},
            )

        # ─── 策略选择 ───
        if strategy == "auto":
            if question:
                strategy = "vlm"
            elif target_region:
                strategy = "ocr"
            else:
                strategy = "pixel"

        # ─── 像素差异策略 ───
        if strategy == "pixel":
            diff_ratio = _compute_pixel_diff(pre_path, post_result.image_path, target_region)
            if diff_ratio < threshold:
                return ToolResult(
                    success=True,
                    output=f"操作验证[像素差异]：屏幕无显著变化（差异率={diff_ratio:.4f}，阈值={threshold}）。操作可能未生效。",
                    duration=time.time() - start,
                    metadata={"changed": False, "diff_ratio": diff_ratio, "method": "pixel_diff"},
                )
            return ToolResult(
                success=True,
                output=f"操作验证[像素差异]：屏幕已变化（差异率={diff_ratio:.4f}）。操作可能已生效。",
                duration=time.time() - start,
                metadata={"changed": True, "diff_ratio": diff_ratio, "method": "pixel_diff"},
            )

        # ─── OCR 文字对比策略 ───
        if strategy == "ocr":
            ocr_result = await _verify_by_ocr(pre_path, post_result.image_path, target_region)
            return ToolResult(
                success=True,
                output=ocr_result["summary"],
                duration=time.time() - start,
                metadata=ocr_result,
            )

        # ─── VLM 判断策略 ───
        if strategy == "vlm":
            vlm_result = await _verify_by_vlm(pre_path, post_result.image_path, question)
            return ToolResult(
                success=True,
                output=vlm_result["summary"],
                duration=time.time() - start,
                metadata=vlm_result,
            )

        return ToolResult(success=False, error=f"未知验证策略: {strategy}", duration=time.time() - start)

    except Exception as e:
        return ToolResult(success=False, error=f"操作验证失败: {e}", duration=time.time() - start)


async def _verify_by_ocr(pre_path: str, post_path: str, target_region: str = "") -> dict[str, Any]:
    """OCR 文字对比验证 — 提取前后截图的文字，比较差异"""
    try:
        import pytesseract
        from PIL import Image

        def _extract_text(path: str) -> str:
            img = Image.open(path)
            if target_region:
                try:
                    from agent.desktop.coordinate_system import from_normalized
                    parts = [int(p.strip()) for p in target_region.split(",")]
                    if len(parts) == 4:
                        sw, sh = img.size
                        x1, y1 = from_normalized(parts[0], parts[1], sw, sh)
                        x2, y2 = from_normalized(parts[2], parts[3], sw, sh)
                        img = img.crop((x1, y1, x2, y2))
                except (ValueError, IndexError):
                    pass
            return pytesseract.image_to_string(img, lang="chi_sim+eng").strip()

        pre_text = _extract_text(pre_path)
        post_text = _extract_text(post_path)

        if pre_text == post_text:
            return {
                "changed": False,
                "method": "ocr",
                "summary": f"操作验证[OCR]：文字无变化。前后文本一致。",
                "pre_text": pre_text[:200],
                "post_text": post_text[:200],
            }

        pre_words = set(pre_text.split())
        post_words = set(post_text.split())
        added = post_words - pre_words
        removed = pre_words - post_words

        lines = [f"操作验证[OCR]：文字已变化。"]
        if added:
            lines.append(f"  新增文字: {' '.join(list(added)[:10])}")
        if removed:
            lines.append(f"  消失文字: {' '.join(list(removed)[:10])}")

        return {
            "changed": True,
            "method": "ocr",
            "summary": "\n".join(lines),
            "pre_text": pre_text[:200],
            "post_text": post_text[:200],
            "added_words": list(added)[:20],
            "removed_words": list(removed)[:20],
        }

    except ImportError:
        return {
            "changed": None,
            "method": "ocr",
            "summary": "操作验证[OCR]：pytesseract 未安装，无法执行OCR对比。请运行: pip install pytesseract",
        }
    except Exception as e:
        return {
            "changed": None,
            "method": "ocr",
            "summary": f"操作验证[OCR]：执行失败: {e}",
        }


async def _verify_by_vlm(pre_path: str, post_path: str, question: str = "") -> dict[str, Any]:
    """VLM 判断策略 — 使用 Vision 模型对比前后截图（双图对比）"""
    try:
        from agent.tools.vision_tools import vision_understand_executor

        import base64
        from PIL import Image

        def _encode_image(path: str) -> str:
            img = Image.open(path)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return base64.b64encode(buf.getvalue()).decode()

        pre_b64 = _encode_image(pre_path)
        post_b64 = _encode_image(post_path)

        if question:
            verify_question = f"【操作前截图】和【操作后截图】对比。\n{question}"
        else:
            verify_question = (
                "我给你两张截图：【操作前截图】和【操作后截图】。\n"
                "请对比这两张截图，判断操作是否生效。\n"
                "1. 描述你看到的变化（如果有）\n"
                "2. 判断操作是否成功\n"
                "3. 如果有异常或错误，指出具体位置"
            )

        # 双图对比：同时发送前后截图
        combined_b64 = pre_b64 + "," + post_b64
        result = await vision_understand_executor({
            "image_base64": combined_b64,
            "question": verify_question,
        })

        if result.success:
            changed = True
            response_lower = result.output.lower()
            if any(kw in response_lower for kw in ["无变化", "没有变化", "no change", "相同", "一样", "未生效"]):
                changed = False

            return {
                "changed": changed,
                "method": "vlm",
                "summary": f"操作验证[VLM双图对比]：{result.output}",
                "vlm_response": result.output,
                "dual_image": True,
            }

        return {
            "changed": None,
            "method": "vlm",
            "summary": f"操作验证[VLM]：Vision模型调用失败 — {result.error}",
            "dual_image": False,
        }

    except ImportError:
        return {
            "changed": None,
            "method": "vlm",
            "summary": "操作验证[VLM]：vision_tools 不可用，无法执行VLM验证。",
            "dual_image": False,
        }
    except Exception as e:
        return {
            "changed": None,
            "method": "vlm",
            "summary": f"操作验证[VLM]：执行失败: {e}",
            "dual_image": False,
        }


def _get_latest_screenshot() -> str:
    """获取最近的截图文件路径"""
    from pathlib import Path
    screenshot_dir = Path(os.environ.get("DATA_DIR", "data")) / "screenshots"
    if not screenshot_dir.is_dir():
        return ""
    pngs = sorted(screenshot_dir.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    return str(pngs[0]) if pngs else ""


def _compute_pixel_diff(pre_path: str, post_path: str, target_region: str = "") -> float:
    """计算两张截图的像素差异率"""
    try:
        from PIL import Image
        import numpy as np

        img_pre = Image.open(pre_path).convert("L")
        img_post = Image.open(post_path).convert("L")

        if img_pre.size != img_post.size:
            img_post = img_post.resize(img_pre.size)

        if target_region:
            try:
                from agent.desktop.coordinate_system import from_normalized, NORMALIZED_MAX
                parts = [int(p.strip()) for p in target_region.split(",")]
                if len(parts) == 4:
                    sw, sh = img_pre.size
                    x1, y1 = from_normalized(parts[0], parts[1], sw, sh)
                    x2, y2 = from_normalized(parts[2], parts[3], sw, sh)
                    img_pre = img_pre.crop((x1, y1, x2, y2))
                    img_post = img_post.crop((x1, y1, x2, y2))
            except (ValueError, IndexError):
                pass

        arr_pre = np.array(img_pre, dtype=np.float32)
        arr_post = np.array(img_post, dtype=np.float32)

        diff = np.abs(arr_pre - arr_post)
        total_pixels = diff.size
        if total_pixels == 0:
            return 0.0
        changed_pixels = np.count_nonzero(diff > 30)
        return changed_pixels / total_pixels

    except ImportError:
        return _compute_pixel_diff_pure(pre_path, post_path)
    except Exception:
        return 0.5


def _compute_pixel_diff_pure(pre_path: str, post_path: str) -> float:
    """纯Pillow像素差异（无numpy依赖时的降级方案）"""
    try:
        from PIL import Image

        img_pre = Image.open(pre_path).convert("L")
        img_post = Image.open(post_path).convert("L")

        if img_pre.size != img_post.size:
            img_post = img_post.resize(img_pre.size)

        pixels_pre = list(img_pre.getdata())
        pixels_post = list(img_post.getdata())

        total = len(pixels_pre)
        if total == 0:
            return 0.0
        changed = sum(1 for a, b in zip(pixels_pre, pixels_post) if abs(a - b) > 30)
        return changed / total

    except Exception:
        return 0.5


# ─────────────────────────────────────────────────────────────
# smart_wait 执行器
# ─────────────────────────────────────────────────────────────

async def smart_wait_executor(params: dict[str, Any]) -> ToolResult:
    """智能等待执行器"""
    start = time.time()
    mode = str(params.get("mode", "change")).lower()
    timeout = float(params.get("timeout", 5.0))
    poll_interval = float(params.get("poll_interval", 0.3))
    selector = params.get("selector", "")

    try:
        if mode == "selector":
            return await _wait_for_selector(selector, timeout, start)

        from agent.desktop.desktop_controller import get_desktop_controller
        controller = get_desktop_controller()

        baseline_result = controller.screenshot_full()
        if not baseline_result.success:
            return ToolResult(success=False, error="截图失败", duration=time.time() - start)

        baseline_hash = _image_hash(baseline_result.image_path)
        deadline = time.time() + timeout

        if mode == "change":
            while time.time() < deadline:
                await asyncio.sleep(poll_interval)
                current_result = controller.screenshot_full()
                if current_result.success:
                    current_hash = _image_hash(current_result.image_path)
                    if current_hash != baseline_hash:
                        return ToolResult(
                            success=True,
                            output=f"屏幕已变化（等待了{time.time() - start:.1f}秒）",
                            duration=time.time() - start,
                        )
            return ToolResult(
                success=True,
                output=f"等待超时（{timeout}秒），屏幕无变化",
                duration=time.time() - start,
            )

        if mode == "stable":
            stable_count = 0
            stable_required = 2
            last_hash = None

            while time.time() < deadline:
                await asyncio.sleep(poll_interval)
                current_result = controller.screenshot_full()
                if current_result.success:
                    current_hash = _image_hash(current_result.image_path)
                    if current_hash == last_hash:
                        stable_count += 1
                        if stable_count >= stable_required:
                            return ToolResult(
                                success=True,
                                output=f"屏幕已稳定（等待了{time.time() - start:.1f}秒）",
                                duration=time.time() - start,
                            )
                    else:
                        stable_count = 0
                    last_hash = current_hash

            return ToolResult(
                success=True,
                output=f"等待超时（{timeout}秒），屏幕未稳定",
                duration=time.time() - start,
            )

        return ToolResult(success=False, error=f"未知等待模式: {mode}", duration=time.time() - start)

    except Exception as e:
        return ToolResult(success=False, error=f"智能等待失败: {e}", duration=time.time() - start)


async def _wait_for_selector(selector: str, timeout: float, start: float) -> ToolResult:
    """等待浏览器DOM元素出现 — 优先复用已有浏览器会话"""
    if not selector:
        return ToolResult(success=False, error="selector模式需要提供CSS选择器")

    page = await _get_active_browser_page()

    if page is not None:
        try:
            await page.wait_for_selector(selector, timeout=timeout * 1000)
            return ToolResult(
                success=True,
                output=f"元素 {selector} 已出现（等待了{time.time() - start:.1f}秒，复用已有会话）",
                duration=time.time() - start,
            )
        except Exception:
            return ToolResult(
                success=True,
                output=f"等待超时（{timeout}秒），元素 {selector} 未出现",
                duration=time.time() - start,
            )

    try:
        from agent.tools.browser_automation import BrowserAutomation, BrowserConfig, BrowserConnectionMode
        config = BrowserConfig(connection_mode=BrowserConnectionMode.LOCAL, headless=True)
        browser = BrowserAutomation(config)
        session_id = await browser.launch()

        try:
            page = await browser._get_or_create_page(session_id)
            try:
                await page.wait_for_selector(selector, timeout=timeout * 1000)
                return ToolResult(
                    success=True,
                    output=f"元素 {selector} 已出现（等待了{time.time() - start:.1f}秒）",
                    duration=time.time() - start,
                )
            except Exception:
                return ToolResult(
                    success=True,
                    output=f"等待超时（{timeout}秒），元素 {selector} 未出现",
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


async def _get_active_browser_page() -> Any | None:
    """尝试获取当前活跃的浏览器页面（复用已有会话）"""
    try:
        from agent.tools.browser_automation import BrowserAutomation
        browser = BrowserAutomation._instance if hasattr(BrowserAutomation, '_instance') else None
        if browser and hasattr(browser, '_sessions') and browser._sessions:
            first_session_id = next(iter(browser._sessions))
            page = await browser._get_or_create_page(first_session_id)
            return page
    except Exception:
        pass

    try:
        from agent.core.session_manager import get_active_browser
        active = get_active_browser()
        if active and hasattr(active, 'page'):
            return active.page
    except Exception:
        pass

    return None


def _image_hash(image_path: str) -> str:
    """计算图片感知哈希（用于变化检测）"""
    try:
        import imagehash
        from PIL import Image
        img = Image.open(image_path)
        return str(imagehash.average_hash(img, hash_size=8))
    except ImportError:
        from PIL import Image
        img = Image.open(image_path).convert("L").resize((16, 16))
        return str(list(img.getdata()))


# ─────────────────────────────────────────────────────────────
# speech_transcribe 执行器
# ─────────────────────────────────────────────────────────────

_whisper_instances: dict[str, Any] = {}


async def speech_transcribe_executor(params: dict[str, Any]) -> ToolResult:
    """语音转文字执行器 — 自动GPU加速 + 流式输出"""
    start = time.time()
    audio_path = str(params.get("audio_path", ""))
    language = str(params.get("language", "zh"))
    model_name = str(params.get("model", "base"))
    stream_mode = bool(params.get("stream", False))

    if not audio_path:
        return ToolResult(success=False, error="请提供音频文件路径", duration=time.time() - start)

    if not os.path.exists(audio_path):
        return ToolResult(success=False, error=f"音频文件不存在: {audio_path}", duration=time.time() - start)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return ToolResult(
            success=False,
            error="faster-whisper 未安装。请运行: pip install faster-whisper",
            duration=time.time() - start,
        )

    try:
        device, compute_type = _detect_whisper_device()
        cache_key = f"{model_name}_{device}_{compute_type}"
        whisper = _whisper_instances.get(cache_key)
        if whisper is None:
            whisper = WhisperModel(model_name, device=device, compute_type=compute_type)
            _whisper_instances[cache_key] = whisper

        segments, info = whisper.transcribe(
            audio_path,
            language=None if language == "auto" else language,
            vad_filter=True,
        )

        detected_lang = info.language if hasattr(info, "language") else language
        lang_prob = getattr(info, "language_probability", 0)

        if stream_mode:
            text_parts: list[str] = []
            segment_details: list[dict[str, Any]] = []
            for seg in segments:
                text = seg.text.strip()
                text_parts.append(text)
                segment_details.append({
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": text,
                })

            full_text = " ".join(text_parts)
            output = f"语音识别完成（{device}加速，语言: {detected_lang}，置信度: {lang_prob:.2f}）：\n\n"
            for seg in segment_details:
                output += f"[{seg['start']:.1f}-{seg['end']:.1f}] {seg['text']}\n"

            return ToolResult(
                success=True,
                output=output,
                duration=time.time() - start,
                metadata={
                    "language": detected_lang,
                    "model": model_name,
                    "device": device,
                    "char_count": len(full_text),
                    "segment_count": len(segment_details),
                    "segments": segment_details[:20],
                },
            )

        text_parts_simple: list[str] = []
        for seg in segments:
            text_parts_simple.append(seg.text.strip())

        full_text = " ".join(text_parts_simple)
        output = f"语音识别完成（{device}加速，语言: {detected_lang}，置信度: {lang_prob:.2f}）：\n\n{full_text}"

        return ToolResult(
            success=True,
            output=output,
            duration=time.time() - start,
            metadata={
                "language": detected_lang,
                "model": model_name,
                "device": device,
                "char_count": len(full_text),
            },
        )

    except Exception as e:
        return ToolResult(success=False, error=f"语音识别失败: {e}", duration=time.time() - start)


def _detect_whisper_device() -> tuple[str, str]:
    """自动检测 GPU 可用性，返回 (device, compute_type)"""
    try:
        import torch
        if torch.cuda.is_available():
            return ("cuda", "float16")
    except ImportError:
        pass

    try:
        import ctranslate2
        num_devices = ctranslate2.get_supported_compute_types("cuda") if hasattr(ctranslate2, "get_supported_compute_types") else []
        if num_devices:
            return ("cuda", "float16")
    except (ImportError, Exception):
        pass

    return ("cpu", "int8")
