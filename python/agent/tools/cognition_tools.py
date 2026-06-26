from __future__ import annotations

from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)


EMOTION_DETECT_DEF = ToolDefinition(
    name="emotion_detect",
    description="检测用户文本中的情绪和意图。适用场景：理解用户情感、调整回复语气。不适用：纯信息查询。",
    category=ToolCategory.COGNITION,
    parameters=[
        ToolParameterDef(name="text", type="string", description="要分析的文本"),
    ],
    risk_level="low",
)

SCENE_ANALYZE_DEF = ToolDefinition(
    name="scene_analyze",
    description="分析当前对话场景和上下文。适用场景：判断对话类型、识别任务阶段。不适用：简单问答。",
    category=ToolCategory.COGNITION,
    parameters=[
        ToolParameterDef(name="context", type="string", description="当前对话上下文"),
    ],
    risk_level="low",
)

SELF_REFLECT_DEF = ToolDefinition(
    name="self_reflect",
    description="触发自我反思，评估当前执行状态和策略。适用场景：任务执行遇到困难、需要调整策略。不适用：简单直接的任务。",
    category=ToolCategory.COGNITION,
    parameters=[
        ToolParameterDef(name="topic", type="string", required=False, description="反思主题"),
        ToolParameterDef(name="depth", type="string", required=False, description="反思深度: surface/deep", enum=["surface", "deep"]),
    ],
    risk_level="low",
)


def _get_llm():
    from agent.main import engine
    if engine and hasattr(engine, "llm") and engine.llm:
        return engine.llm
    return None


async def emotion_detect_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    text = str(params.get("text", ""))

    if not text:
        return ToolResult(success=False, error="文本不能为空")

    llm = _get_llm()
    if not llm:
        return ToolResult(success=True, output="LLM不可用，无法进行情绪分析", duration=time.time() - start)

    prompt = (
        f"请分析以下文本中的情绪和意图，用JSON格式返回：\n"
        f"文本: {text[:500]}\n\n"
        f'返回格式: {{"emotion": "情绪类型", "intensity": "强度1-10", "intent": "意图", "suggested_tone": "建议回复语气"}}'
    )

    try:
        response = await llm.chat(messages=[{"role": "user", "content": prompt}], use_cache=False)
        content = response.get("content", "")
        return ToolResult(success=True, output=content, duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"情绪分析失败: {e}")


async def scene_analyze_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    context = str(params.get("context", ""))

    if not context:
        return ToolResult(success=False, error="上下文不能为空")

    llm = _get_llm()
    if not llm:
        return ToolResult(success=True, output="LLM不可用，无法进行场景分析", duration=time.time() - start)

    prompt = (
        f"请分析以下对话场景，用JSON格式返回：\n"
        f"上下文: {context[:1000]}\n\n"
        f'返回格式: {{"scene_type": "场景类型", "task_phase": "任务阶段", "key_entities": ["关键实体"], "suggested_action": "建议行动"}}'
    )

    try:
        response = await llm.chat(messages=[{"role": "user", "content": prompt}], use_cache=False)
        content = response.get("content", "")
        return ToolResult(success=True, output=content, duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"场景分析失败: {e}")


async def self_reflect_executor(params: dict[str, Any]) -> ToolResult:
    import time
    start = time.time()
    topic = params.get("topic", "当前任务执行状态")
    depth = str(params.get("depth", "surface"))

    llm = _get_llm()
    if not llm:
        return ToolResult(success=True, output="LLM不可用，无法进行自我反思", duration=time.time() - start)

    depth_instruction = (
        "请进行深度反思，包括：根因分析、策略评估、替代方案、改进计划"
        if depth == "deep"
        else "请进行简要反思，包括：当前状态、问题识别、下一步建议"
    )

    prompt = (
        f"自我反思主题: {topic}\n"
        f"{depth_instruction}\n\n"
        f"请以结构化方式输出反思结果。"
    )

    try:
        response = await llm.chat(messages=[{"role": "user", "content": prompt}], use_cache=False)
        content = response.get("content", "")
        return ToolResult(success=True, output=content, duration=time.time() - start)
    except Exception as e:
        return ToolResult(success=False, error=f"自我反思失败: {e}")
