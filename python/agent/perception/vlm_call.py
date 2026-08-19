"""VLM 原生调用层 — 不依赖 vision_tools 的视觉语言模型接口。

将 VLM 调用逻辑从 vision_tools 工具层解耦为独立模块，
供 perception/visual_grounding、action_verifier 等子系统直接使用，
无需经过 ToolRegistry → ToolDefinition → ToolExecutor 的间接调用链。

支持的模型：
- GPT-4o Vision (litellm)
- Claude Vision (litellm)
- 自定义模型（通过 VLM_PROVIDER 扩展点）

Usage:
    from agent.perception.vlm_call import vlmc
    result = await vlmc.analyze(image_base64="...", question="描述图片内容")
    if result.success:
        print(result.text)
"""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("vlm_call")


@dataclass
class VLMResult:
    """VLM 调用结果。

    Attributes:
        success: 是否成功。
        text: 模型输出文本。
        model: 使用的模型名。
        error: 错误信息。
        usage: token 用量。
    """

    success: bool = False
    text: str = ""
    model: str = ""
    error: str = ""
    usage: dict[str, int] = field(default_factory=dict)


class VLMCaller:
    """VLM 原生调用器。

    直接通过 litellm.acompletion 调用视觉语言模型，
    不依赖 ToolRegistry / vision_tools 的工具注册机制。

    优势：
    - 无需构造 ToolParameterDef / ToolResult 中间结构
    - 支持自定义 system_prompt
    - 支持原始 bytes / base64 / 文件路径输入
    - 可被 perception 子系统直接调用
    """

    def __init__(self, default_model: str = "") -> None:
        self._default_model = default_model or os.getenv("VISION_MODEL", "gpt-4o")
        self._providers: dict[str, Any] = {}

    @property
    def default_model(self) -> str:
        return self._default_model

    async def analyze(
        self,
        image_bytes: bytes | None = None,
        image_base64: str = "",
        image_path: str = "",
        question: str = "",
        system_prompt: str = "",
        model: str = "",
        temperature: float = 0.3,
        max_tokens: int = 4000,
    ) -> VLMResult:
        """分析图片内容。

        三种图片输入方式（优先级从高到低）：
        1. image_bytes: 原始图片字节
        2. image_base64: Base64 编码的图片
        3. image_path: 本地图片文件路径

        Args:
            image_bytes: 原始图片字节数据。
            image_base64: Base64 编码的图片数据。
            image_path: 本地图片文件路径。
            question: 问题/指令。
            system_prompt: 系统提示词。
            model: 模型名（空则使用默认）。
            temperature: 采样温度。
            max_tokens: 最大输出 token 数。

        Returns:
            VLMResult: 调用结果。
        """
        raw_bytes = self._resolve_image(image_bytes, image_base64, image_path)
        if raw_bytes is None:
            return VLMResult(success=False, error="未提供有效图片数据")

        model = model or self._default_model
        b64 = base64.b64encode(raw_bytes).decode("utf-8")
        image_url = f"data:image/jpeg;base64,{b64}"

        content_parts: list[dict[str, Any]] = []
        if question:
            content_parts.append({"type": "text", "text": question})
        content_parts.append({
            "type": "image_url",
            "image_url": {"url": image_url, "detail": "high"},
        })

        messages: list[dict[str, Any]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": content_parts})

        try:
            from litellm import acompletion

            response = await acompletion(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )

            text = response.choices[0].message.content
            usage = {}
            if hasattr(response, "usage") and response.usage:
                usage = {
                    "prompt_tokens": getattr(response.usage, "prompt_tokens", 0),
                    "completion_tokens": getattr(response.usage, "completion_tokens", 0),
                    "total_tokens": getattr(response.usage, "total_tokens", 0),
                }

            return VLMResult(
                success=True,
                text=text,
                model=model,
                usage=usage,
            )

        except ImportError:
            return VLMResult(
                success=False,
                error="litellm 未安装，请运行: pip install litellm",
                model=model,
            )
        except Exception as e:
            return VLMResult(
                success=False,
                error=f"VLM 调用失败: {e}",
                model=model,
            )

    async def locate_element(
        self,
        image_bytes: bytes | None = None,
        image_base64: str = "",
        image_path: str = "",
        description: str = "",
        image_size: tuple[int, int] | None = None,
        model: str = "",
    ) -> VLMResult:
        """定位屏幕元素（专用接口）。

        生成结构化定位 prompt，要求模型返回 JSON 格式坐标。

        Args:
            image_bytes: 截图像素数据。
            image_base64: Base64 截图。
            image_path: 截图文件路径。
            description: 目标元素描述。
            image_size: 截图尺寸 (w, h)。
            model: 模型名。

        Returns:
            VLMResult: text 字段包含 JSON 坐标信息。
        """
        size_info = ""
        if image_size:
            size_info = f"\n截图尺寸: {image_size[0]}x{image_size[1]}"

        question = (
            f"在截图中找到目标元素的位置。\n"
            f"目标描述: {description}\n"
            f"请返回目标中心坐标，格式为 JSON: "
            f'{{"x": 像素x坐标, "y": 像素y坐标, "found": true/false, '
            f'"description": "描述你看到的内容"}}'
            f"{size_info}"
        )

        return await self.analyze(
            image_bytes=image_bytes,
            image_base64=image_base64,
            image_path=image_path,
            question=question,
            system_prompt="你是一个精确的屏幕元素定位助手。只返回 JSON 格式的坐标数据。",
            model=model,
            temperature=0.1,
        )

    def _resolve_image(
        self,
        image_bytes: bytes | None,
        image_base64: str,
        image_path: str,
    ) -> bytes | None:
        """解析图片输入为原始字节。"""
        if image_bytes:
            return image_bytes

        if image_base64:
            try:
                return base64.b64decode(image_base64)
            except Exception as e:
                log.warning("Base64 解码失败", error=str(e))
                return None

        if image_path and os.path.exists(image_path):
            try:
                with open(image_path, "rb") as f:
                    return f.read()
            except Exception as e:
                log.warning("图片文件读取失败", path=image_path, error=str(e))
                return None

        return None


vlmc = VLMCaller()
