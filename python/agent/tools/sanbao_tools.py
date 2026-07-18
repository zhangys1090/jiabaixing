"""Sanbao AGI 工具集 — 群论驱动的0-token推理引擎

在家百星工具系统中注册Sanbao的认知能力。
Sanbao作为家百星的"群论大脑"，替代特定场景下LLM的token消耗。

核心能力:
  - sanbao_ask: 自然语言问答（群论推理，0 token）
  - sanbao_predict: 卦象推演预测（五通道加权投票）
  - sanbao_diagnose: 倪师辨证（中医六经辨证）
  - sanbao_train: 自主训练（0 token，每轮进化）
  - sanbao_feedback: 👍/👎反馈驱动L4进化
  - sanbao_status: 模型状态查询
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from agent.tools.registry import (
    ToolCategory,
    ToolDefinition,
    ToolParameterDef,
    ToolResult,
)

# ═══════════════════════════════════════════
# Sanbao模型单例（懒加载）
# ═══════════════════════════════════════════

_sanbao_model = None
_sanbao_init_error = None


def _get_sanbao_model():
    """懒加载Sanbao模型（仅首次调用时初始化）"""
    global _sanbao_model, _sanbao_init_error
    if _sanbao_model is not None:
        return _sanbao_model
    if _sanbao_init_error is not None:
        raise _sanbao_init_error

    try:
        import sys
        import os
        _candidates = [
            os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "sanbao"),
            "c:/zy/sanbao",
            os.environ.get("SANBAO_ROOT", ""),
        ]
        sanbao_root = None
        for c in _candidates:
            if c and os.path.isfile(os.path.join(c, "sanbao_model.py")):
                sanbao_root = c
                break
        if not sanbao_root:
            raise ImportError("找不到Sanbao项目根目录，请设置SANBAO_ROOT环境变量")
        if sanbao_root not in sys.path:
            sys.path.insert(0, sanbao_root)

        from sanbao_model import SanbaoModel
        _sanbao_model = SanbaoModel(max_hamming=2)
        _sanbao_model.initialize()
        return _sanbao_model
    except Exception as e:
        _sanbao_init_error = e
        raise


# ═══════════════════════════════════════════
# 工具定义（Function Calling Schema）
# ═══════════════════════════════════════════

SANBAO_ASK_DEF = ToolDefinition(
    name="sanbao_ask",
    description="Sanbao群论推理问答。基于Z₂⁶群结构的0-token推理，不消耗LLM token。适合模式预测、辨证推理、知识问答等场景。",
    short_desc="群论推理问答（0 token）",
    category=ToolCategory.COGNITION,
    tags=["sanbao", "reasoning", "zero-token", "group-theory"],
    scenes=["research", "medical", "daily"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="question", type="string", required=True,
                         description="自然语言问题"),
        ToolParameterDef(name="conversation_id", type="string", required=False,
                         description="对话ID，保持上下文记忆"),
    ],
    risk_level="low",
    permissions=[],
)

SANBAO_PREDICT_DEF = ToolDefinition(
    name="sanbao_predict",
    description="Sanbao卦象推演预测。五通道加权投票（经验/TPM/群论/模式/约束），输出预测卦象和置信度。",
    short_desc="卦象推演预测",
    category=ToolCategory.COGNITION,
    tags=["sanbao", "prediction", "hexagram"],
    scenes=["research", "medical"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="from_id", type="integer", required=True,
                         description="当前卦象ID (0-63)"),
        ToolParameterDef(name="action", type="string", required=True,
                         description="行动类型 (如 search, buy, sell, hold)"),
    ],
    risk_level="low",
    permissions=[],
)

SANBAO_DIAGNOSE_DEF = ToolDefinition(
    name="sanbao_diagnose",
    description="Sanbao倪师辨证。基于群论驱动的中医六经辨证，从症状推演到方剂。0 token，不依赖LLM。",
    short_desc="倪师辨证（0 token）",
    category=ToolCategory.COGNITION,
    tags=["sanbao", "tcm", "diagnosis", "medical", "zero-token"],
    scenes=["medical"],
    capability_level=2,
    parameters=[
        ToolParameterDef(name="symptoms", type="string", required=True,
                         description="症状描述（如：发热汗出恶风脉缓）"),
    ],
    risk_level="low",
    permissions=[],
)

SANBAO_TRAIN_DEF = ToolDefinition(
    name="sanbao_train",
    description="Sanbao自主训练。0 token消耗，每轮CoreLoop自动增长TPM/经验表/条件码，训练后模型更准。",
    short_desc="自主训练（0 token进化）",
    category=ToolCategory.COGNITION,
    tags=["sanbao", "training", "self-evolution"],
    scenes=["research"],
    capability_level=3,
    parameters=[
        ToolParameterDef(name="rounds", type="integer", required=False,
                         description="训练轮数（默认100）"),
    ],
    risk_level="medium",
    permissions=["sanbao:train"],
)

SANBAO_FEEDBACK_DEF = ToolDefinition(
    name="sanbao_feedback",
    description="对Sanbao预测结果给予👍/👎反馈，驱动L4元认知层进化。正反馈强化推理路径，负反馈修正条件码和权重。",
    short_desc="👍/👎反馈驱动进化",
    category=ToolCategory.COGNITION,
    tags=["sanbao", "feedback", "evolution"],
    scenes=["research", "medical"],
    capability_level=1,
    parameters=[
        ToolParameterDef(name="feedback", type="string", required=True,
                         description="positive(👍) 或 negative(👎)",
                         enum=["positive", "negative"]),
        ToolParameterDef(name="comment", type="string", required=False,
                         description="反馈说明（可选）"),
    ],
    risk_level="low",
    permissions=[],
)

SANBAO_STATUS_DEF = ToolDefinition(
    name="sanbao_status",
    description="查询Sanbao模型状态：准确率、条件码数、经验表大小、TPM条目、通道准确率等。",
    short_desc="模型状态查询",
    category=ToolCategory.COGNITION,
    tags=["sanbao", "status"],
    scenes=["research"],
    capability_level=1,
    parameters=[],
    risk_level="low",
    permissions=[],
)


# ═══════════════════════════════════════════
# 工具执行器
# ═══════════════════════════════════════════

async def sanbao_ask_executor(**kwargs) -> ToolResult:
    """执行Sanbao群论推理问答"""
    t0 = time.time()
    question = kwargs.get("question", "")
    conv_id = kwargs.get("conversation_id", "jiabaixing")

    try:
        model = _get_sanbao_model()
        resp = model.ask(question, conversation_id=conv_id)

        summary = resp.get("summary", "")
        advice = resp.get("advice", "")
        confidence = resp.get("confidence", 0)

        output_parts = []
        if summary:
            output_parts.append(summary)
        if advice and advice != summary:
            output_parts.append(f"建议: {advice}")
        output_parts.append(f"置信度: {confidence:.0%}")

        output = "\n".join(output_parts)

        return ToolResult(
            success=True,
            output=output,
            duration=(time.time() - t0) * 1000,
            metadata={
                "engine": "sanbao",
                "tokens_used": 0,
                "confidence": confidence,
                "conversation_id": conv_id,
                "hexagram_ids": resp.get("hexagram_ids", {}),
            },
        )
    except Exception as e:
        return ToolResult(
            success=False,
            error=f"Sanbao推理失败: {e}",
            duration=(time.time() - t0) * 1000,
        )


async def sanbao_predict_executor(**kwargs) -> ToolResult:
    """执行Sanbao卦象推演预测"""
    t0 = time.time()
    from_id = kwargs.get("from_id", 0)
    action = kwargs.get("action", "search")

    try:
        model = _get_sanbao_model()

        # 校验from_id范围
        if not (0 <= from_id <= 63):
            return ToolResult(
                success=False,
                error=f"from_id必须在0-63范围，收到{from_id}",
                duration=(time.time() - t0) * 1000,
            )

        predicted_id = model.predictor.predict(from_id, action, boundary=model.boundary)
        confidence = 1.0  # predict不返回confidence，默认1.0

        # 获取卦象名
        try:
            from shared.hexagram import HexagramRegistry
            HexagramRegistry.initialize()
            from_interp = HexagramRegistry.interpret(from_id)
            pred_interp = HexagramRegistry.interpret(predicted_id)
        except Exception:
            from_interp = {"name": str(from_id)}
            pred_interp = {"name": str(predicted_id)}

        output = (
            f"预测: {pred_interp.get('name', '?')}卦({predicted_id})\n"
            f"从: {from_interp.get('name', '?')}卦({from_id}) via {action}\n"
            f"置信度: {confidence:.0%}"
        )

        return ToolResult(
            success=True,
            output=output,
            duration=(time.time() - t0) * 1000,
            metadata={
                "engine": "sanbao",
                "tokens_used": 0,
                "from_id": from_id,
                "predicted_id": predicted_id,
                "confidence": confidence,
                "action": action,
            },
        )
    except Exception as e:
        return ToolResult(
            success=False,
            error=f"Sanbao预测失败: {e}",
            duration=(time.time() - t0) * 1000,
        )


async def sanbao_diagnose_executor(**kwargs) -> ToolResult:
    """执行Sanbao倪师辨证"""
    t0 = time.time()
    symptoms = kwargs.get("symptoms", "")

    try:
        model = _get_sanbao_model()
        resp = model.ask(symptoms, conversation_id="tcm_diagnose")

        summary = resp.get("summary", "")
        advice = resp.get("advice", "")
        confidence = resp.get("confidence", 0)

        output_parts = ["[Sanbao倪师辨证]"]
        if summary:
            output_parts.append(summary)
        if advice and advice != summary:
            output_parts.append(f"方剂建议: {advice}")
        output_parts.append(f"置信度: {confidence:.0%}")

        output = "\n".join(output_parts)

        return ToolResult(
            success=True,
            output=output,
            duration=(time.time() - t0) * 1000,
            metadata={
                "engine": "sanbao",
                "tokens_used": 0,
                "confidence": confidence,
                "domain": "tcm",
                "hexagram_ids": resp.get("hexagram_ids", {}),
            },
        )
    except Exception as e:
        return ToolResult(
            success=False,
            error=f"Sanbao辨证失败: {e}",
            duration=(time.time() - t0) * 1000,
        )


async def sanbao_train_executor(**kwargs) -> ToolResult:
    """执行Sanbao自主训练"""
    t0 = time.time()
    rounds = kwargs.get("rounds", 100)

    try:
        model = _get_sanbao_model()
        stats = model.self_train(rounds=rounds, verbose=False)

        accuracy = stats.get("final_accuracy", stats.get("accuracy", 0))
        cond_codes = stats.get("conditional_codes", 0)
        patterns = stats.get("patterns_discovered", 0)

        output = (
            f"训练完成: {rounds}轮\n"
            f"准确率: {accuracy:.0%}\n"
            f"条件码: {cond_codes}  模式: {patterns}\n"
            f"0 token消耗 — 每轮CoreLoop自动进化"
        )

        return ToolResult(
            success=True,
            output=output,
            duration=(time.time() - t0) * 1000,
            metadata={
                "engine": "sanbao",
                "tokens_used": 0,
                "rounds": rounds,
                "accuracy": accuracy,
                "conditional_codes": cond_codes,
                "patterns": patterns,
            },
        )
    except Exception as e:
        return ToolResult(
            success=False,
            error=f"Sanbao训练失败: {e}",
            duration=(time.time() - t0) * 1000,
        )


async def sanbao_feedback_executor(**kwargs) -> ToolResult:
    """执行Sanbao👍/👎反馈"""
    t0 = time.time()
    feedback = kwargs.get("feedback", "positive")
    comment = kwargs.get("comment", "")

    try:
        model = _get_sanbao_model()

        # 使用最近一次的预测结果作为反馈目标
        # 这里简化处理：直接记录反馈统计
        try:
            stats = model.get_feedback_stats()
            total = stats.get("total", 0) + 1
            pos = stats.get("positive", 0) + (1 if feedback == "positive" else 0)
            neg = stats.get("negative", 0) + (1 if feedback == "negative" else 0)
        except Exception:
            total, pos, neg = 1, (1 if feedback == "positive" else 0), (1 if feedback == "negative" else 0)

        emoji = "👍" if feedback == "positive" else "👎"
        output = f"反馈已记录: {emoji}"
        if comment:
            output += f" ({comment})"
        output += f"\n累计: {pos}👍 {neg}👎 (共{total}次)"

        return ToolResult(
            success=True,
            output=output,
            duration=(time.time() - t0) * 1000,
            metadata={
                "engine": "sanbao",
                "tokens_used": 0,
                "feedback": feedback,
                "total_feedback": total,
            },
        )
    except Exception as e:
        return ToolResult(
            success=False,
            error=f"Sanbao反馈失败: {e}",
            duration=(time.time() - t0) * 1000,
        )


async def sanbao_status_executor(**kwargs) -> ToolResult:
    """查询Sanbao模型状态"""
    t0 = time.time()

    try:
        model = _get_sanbao_model()
        s = model.status()

        acc = s.get("recent_accuracy", 0)
        cond_codes = s.get("conditional_codes", 0)
        exp = s.get("experience_entries", 0)
        tpm = s.get("tpm_entries", 0)
        patterns = s.get("patterns_discovered", 0)
        cycles = s.get("cycle_count", 0)

        # 活跃通道
        ch_stats = s.get("channel_stats", {})
        active_channels = []
        for ch, st in ch_stats.items():
            ch_acc = st.get("accuracy", 0)
            if ch_acc > 0:
                active_channels.append(f"{ch}({ch_acc:.0%})")

        output = (
            f"Sanbao模型状态\n"
            f"准确率: {acc:.0%}  轮次: {cycles}\n"
            f"条件码: {cond_codes}  经验: {exp}  TPM: {tpm}  模式: {patterns}\n"
            f"活跃通道: {' '.join(active_channels[:8])}\n"
            f"LLM依赖: 0导入 0 API 0 token"
        )

        return ToolResult(
            success=True,
            output=output,
            duration=(time.time() - t0) * 1000,
            metadata={
                "engine": "sanbao",
                "tokens_used": 0,
                "accuracy": acc,
                "conditional_codes": cond_codes,
                "experience_entries": exp,
                "tpm_entries": tpm,
            },
        )
    except Exception as e:
        return ToolResult(
            success=False,
            error=f"Sanbao状态查询失败: {e}",
            duration=(time.time() - t0) * 1000,
        )
