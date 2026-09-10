"""操作验证端点 —— 暴露 `/v1/perception/verify-action`。

将 Python 侧 ActionVerifier（操作前后对比验证：pixel/ocr/vlm/uia_diff）
以 HTTP 形式暴露，供 TS 桌面通道在操作执行后接回验证结果（P1-2 闭环）。
校验核心归属 Python（agent.perception.action_verifier），TS 仅做桥接，
符合 AGENTS.md §0.1。

Usage:
    app.include_router(action_verify_router, prefix="/v1/perception")
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from agent.core.logger import StructuredLogger, log_ignored
from agent.perception.action_verifier import ActionVerifier
log = StructuredLogger("action_verify")

router = APIRouter()


class VerifyActionRequest(BaseModel):
    """操作验证请求体（字段对应 Python ActionVerifier.verify）。"""

    action_description: str
    pre_path: str = ""
    post_path: str = ""
    strategy: str = "auto"
    target_region: str = ""
    threshold: float = 0.01
    question: str = ""


def _serialize(result: Any) -> dict[str, Any]:
    """将 VerificationResult 归一化为 JSON 安全的字典。"""
    return {
        "success": result.success,
        "confidence": result.confidence,
        "evidence": result.evidence,
        "retry_suggested": result.retry_suggested,
        "method": result.method,
        "diff_ratio": result.diff_ratio,
    }


@router.post("/verify-action")
async def verify_action(req: VerifyActionRequest) -> dict[str, Any]:
    """验证一个桌面操作是否成功，返回归一化 VerificationOutcome。"""
    verifier = ActionVerifier()
    try:
        result = await verifier.verify(
            action_description=req.action_description,
            pre_path=req.pre_path,
            post_path=req.post_path,
            strategy=req.strategy,
            target_region=req.target_region,
            threshold=req.threshold,
            question=req.question,
        )
    except Exception as e:  # 验证器内部异常不应拖垮调用方
        log_ignored(log, "action_verify.verify", e)
        return {
            "success": False,
            "confidence": 0.0,
            "evidence": f"验证失败: {e}",
            "retry_suggested": False,
            "method": "error",
            "diff_ratio": 0.0,
        }
    return _serialize(result)
