"""
Vision工具 - 支持图片理解和Vision模型集成

集成 MemoryEngine.store_multimodal：Vision 调用成功后，异步将
"图像描述 + 图像路径"写入跨模态记忆，供后续 search_multimodal 检索。
遵循 AGENTS.md 0.2 节：本工具属 Python 主实现端，无 TS 侧重复实现。
"""
from __future__ import annotations

import base64
import os
from typing import Any

from agent.core.logger import StructuredLogger
from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)

log = StructuredLogger("vision_tools")

try:
    import aiohttp
    HAS_AIOHTTP = True
except ImportError:
    HAS_AIOHTTP = False


async def _try_store_multimodal_memory(
    content: str,
    image_path: str | None,
    question: str,
    model: str,
) -> None:
    """将 Vision 结果异步写入跨模态记忆（失败不影响主流程）。

    复用 MemoryEngine.store_multimodal，避免重复实现多模态编码逻辑。
    仅当全局 engine.memory 可用时调用，无 engine 时静默跳过。

    Args:
        content: Vision 模型返回的图像描述文本。
        image_path: 本地图像路径；为空则不写图像向量。
        question: 用户原始问题，作为 metadata 记录。
        model: 使用的 Vision 模型名。
    """
    try:
        # 延迟导入避免循环依赖
        from agent.main import engine
        if not engine or not getattr(engine, "memory", None):
            return
        memory = engine.memory
        # 仅在提供本地图像路径时才写入图像向量
        # URL/Base64 模式下不写图像路径，避免无效编码
        await memory.store_multimodal(
            content=content,
            image_path=image_path if image_path else None,
            memory_type="long_term",
            scene="vision_understand",
            emotion="neutral",
            metadata={
                "source": "vision_tools",
                "vision_model": model,
                "question": question,
            },
        )
        log.debug(
            "Vision 结果已写入跨模态记忆",
            model=model,
            has_image=bool(image_path),
        )
    except Exception as exc:
        # 写入失败不影响 Vision 工具主流程
        log.warning("Vision 结果写入跨模态记忆失败", error=str(exc))

VISION_UNDERSTAND_DEF = ToolDefinition(
    name="vision_understand",
    description="使用Vision模型理解图片内容。适用场景：分析截图、理解图表数据、识别图片中的文字或物体。支持GPT-4o Vision和Claude Vision。",
    short_desc="Vision模型理解图片",
    category=ToolCategory.COGNITION,
    tags=["vision", "image", "understand", "gpt-4o", "claude"],
    scenes=["research", "daily", "development"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="image_url", type="string", required=False, description="图片URL"),
        ToolParameterDef(name="image_path", type="string", required=False, description="本地图片路径"),
        ToolParameterDef(name="image_base64", type="string", required=False, description="Base64编码的图片数据"),
        ToolParameterDef(name="question", type="string", required=False, description="针对图片的问题"),
        ToolParameterDef(name="model", type="string", required=False, description="Vision模型，默认用环境变量VISION_MODEL设置的值", enum=["gpt-4o", "claude", "custom"]),
    ],
    risk_level="low",
)


async def vision_understand_executor(params: dict[str, Any]) -> ToolResult:
    image_url = str(params.get("image_url", ""))
    image_path = str(params.get("image_path", ""))
    image_base64 = str(params.get("image_base64", ""))
    question = str(params.get("question", ""))
    model = str(params.get("model", "gpt-4o"))

    # 准备图片数据
    image_data = None
    if image_url:
        if not HAS_AIOHTTP:
            return ToolResult(success=False, error="需要安装aiohttp: pip install aiohttp")
        image_data = await _download_image(image_url)
    elif image_path and os.path.exists(image_path):
        with open(image_path, "rb") as f:
            image_data = f.read()
    elif image_base64:
        try:
            image_data = base64.b64decode(image_base64)
        except Exception as e:
            return ToolResult(success=False, error=f"Base64解码失败: {e}")
    else:
        return ToolResult(success=False, error="需要提供图片URL、路径或Base64数据")

    if not image_data:
        return ToolResult(success=False, error="未能获取图片数据")

    # 调用Vision API
    try:
        if model == "gpt-4o":
            response = await _call_gpt4o_vision(image_data, question)
        elif model == "claude":
            response = await _call_claude_vision(image_data, question)
        else:
            response = await _call_custom_vision(image_data, question, model)

        # 集成跨模态记忆：将 Vision 结果异步写入多模态记忆
        # 仅本地图像路径模式写入 image_path，URL/Base64 模式仅写文本描述
        await _try_store_multimodal_memory(
            content=response,
            image_path=image_path if image_path else None,
            question=question,
            model=model,
        )

        return ToolResult(
            success=True,
            output=response,
            metadata={"model": model, "image_size": len(image_data)}
        )
    except Exception as e:
        return ToolResult(success=False, error=f"Vision模型调用失败: {e}")


async def _download_image(url: str) -> bytes:
    """下载图片数据"""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status != 200:
                    return None
                return await resp.read()
    except Exception:
        return None


async def _call_gpt4o_vision(image_data: bytes, question: str) -> str:
    """调用GPT-4o Vision API"""
    import json
    
    try:
        from litellm import acompletion
        
        # 准备请求
        base64_image = base64.b64encode(image_data).decode("utf-8")
        image_url = f"data:image/jpeg;base64,{base64_image}"
        
        messages = [
            {
                "role": "system",
                "content": "你是一个专业的图像分析助手。根据用户的问题，准确分析图片内容并给出有帮助的回答。"
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": question if question else "请详细描述这张图片的内容。"
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_url,
                            "detail": "high"
                        }
                    }
                ]
            }
        ]
        
        # 调用LiteLLM
        response = await acompletion(
            model=os.getenv("VISION_MODEL", "gpt-4o"),
            messages=messages,
            max_tokens=4000,
            temperature=0.3,
        )
        
        return response.choices[0].message.content
    
    except ImportError:
        return "LiteLLM未安装，请运行: pip install litellm"
    except Exception as e:
        return f"GPT-4o Vision调用失败: {e}"


async def _call_claude_vision(image_data: bytes, question: str) -> str:
    """调用Claude Vision API"""
    import os
    
    try:
        from litellm import acompletion
        
        base64_image = base64.b64encode(image_data).decode("utf-8")
        image_url = f"data:image/jpeg;base64,{base64_image}"
        
        messages = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": question if question else "请描述这张图片的内容。"
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_url,
                            "detail": "high"
                        }
                    }
                ]
            }
        ]
        
        response = await acompletion(
            model=os.getenv("VISION_MODEL", "claude-sonnet-4-20250514"),
            messages=messages,
            max_tokens=4000,
            temperature=0.3,
        )
        
        return response.choices[0].message.content
    
    except ImportError:
        return "LiteLLM未安装"
    except Exception as e:
        return f"Claude Vision调用失败: {e}"


async def _call_custom_vision(image_data: bytes, question: str, model: str) -> str:
    """调用自定义Vision模型"""
    # 这里可以根据实际需求集成其他Vision模型
    # 例如本地部署的CLIP、BLIP等
    return f"[自定义Vision模型{model}待集成]"
