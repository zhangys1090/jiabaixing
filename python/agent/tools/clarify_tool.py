"""澄清工具——向用户提出结构化澄清请求。

当 Agent 遇到不确定、有歧义的用户需求时，通过此工具向用户
构造结构化的澄清请求（选择题或开放式问题），引导用户补充信息。

Usage:
    from agent.tools.clarify_tool import register_clarify_tool
    register_clarify_tool(registry)
"""
from __future__ import annotations

import time
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
    ToolRegistry,
)

# ==================== 工具定义 ====================

CLARIFY_DEF = ToolDefinition(
    name="clarify",
    description=(
        "向用户提出结构化澄清请求。适用场景：用户需求不明确、存在歧义、"
        "需要确认选项。不适用：需求已明确时。"
    ),
    short_desc="结构化澄清请求",
    category=ToolCategory.COGNITION,
    tags=["clarify", "question", "interaction"],
    scenes=["coding", "daily", "research", "work"],
    capability_level=1,
    parameters=[
        ToolParameterDef(
            name="question",
            type="string",
            required=True,
            description="需要向用户确认的问题",
        ),
        ToolParameterDef(
            name="options",
            type="array",
            required=False,
            description="选项列表",
        ),
        ToolParameterDef(
            name="context",
            type="string",
            required=False,
            description="上下文说明",
        ),
    ],
    risk_level="low",
)


# ==================== 执行器 ====================


async def clarify_executor(params: dict[str, Any]) -> ToolResult:
    """执行澄清请求，构造结构化的澄清文本返回给用户。

    Args:
        params: 工具参数字典，包含 question / options / context。

    Returns:
        ToolResult: 包含格式化澄清请求的结果，metadata 中携带
            wait_for_user_response=True 标记。
    """
    start = time.time()
    question = str(params.get("question", "")).strip()
    options = params.get("options")
    context = params.get("context")

    if not question:
        return ToolResult(success=False, error="问题不能为空", duration=time.time() - start)

    # 构造输出文本
    parts: list[str] = []

    # 上下文说明
    if context:
        parts.append(f"📋 上下文: {context}")

    parts.append(f"需要澄清: {question}")

    # 选项格式化
    if options and isinstance(options, list) and len(options) > 0:
        option_lines: list[str] = []
        option_labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        for idx, opt in enumerate(options):
            label = option_labels[idx] if idx < len(option_labels) else str(idx + 1)
            option_lines.append(f"  {label}. {opt}")
        parts.append("\n".join(option_lines))
    else:
        parts.append("（开放式问题，请自由回答）")

    parts.append("")
    parts.append("请回复您的选择。")

    output = "\n".join(parts)

    return ToolResult(
        success=True,
        output=output,
        duration=time.time() - start,
        metadata={"wait_for_user_response": True},
    )


# ==================== 注册函数 ====================


def register_clarify_tool(registry: ToolRegistry) -> None:
    """注册 clarify 工具到工具注册中心。

    Args:
        registry: 工具注册中心实例。
    """
    registry.register(CLARIFY_DEF, clarify_executor)
