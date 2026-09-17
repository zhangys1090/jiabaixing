"""LLM 调用失败报文捕获 —— 把失败请求的完整上下文落盘，供根因定位。

为什么需要（R-6，2026-09-17）:
    真实语料里 4/14 回合以 `请求参数有误` 结束，但**根因无法定位** ——
    因为失败只留下了**分类后的用户文案**，原始请求报文（model / temperature /
    max_tokens / tools schema / messages 结构）全部丢失。

    本模块在 LLM 调用最终失败时，把**可复现所需的全部请求上下文**落成 JSON。

安全约束:
    - **api_key 一律不落盘**（只记是否设置 + 长度）。
    - messages 内容做长度截断 + 条数上限，避免语料爆炸。
    - 落盘失败绝不抛出（诊断设施不得影响主链路）。

用法::

    from agent.llm.failure_capture import capture_llm_failure

    capture_llm_failure(
        model=..., kwargs=attempt_kwargs, exc=last_exc,
        provider_name=..., attempt_idx=..., attempts=...,
    )
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from agent.core.logger import StructuredLogger

log = StructuredLogger("llm_failure_capture")

#: 单条 message 内容保留多少字符
_MAX_MSG_CHARS = 1200
#: 最多保留多少条 message
_MAX_MSGS = 40
#: 目录内最多保留多少份失败报文
_MAX_FILES = 200

def failures_dir() -> Path:
    """失败报文落盘目录。可用 JBX_LLM_FAILURE_DIR 覆盖（测试用）。"""
    override = os.getenv("JBX_LLM_FAILURE_DIR", "")
    if override:
        d = Path(override)
    else:
        try:
            from agent.config import DATA_ROOT

            d = Path(DATA_ROOT) / "llm_failures"
        except Exception:
            d = Path("data") / "llm_failures"
    d.mkdir(parents=True, exist_ok=True)
    return d


_EXACT_SENSITIVE = frozenset({
    "api_key", "apikey", "authorization", "token", "secret", "password",
    "access_token", "auth", "bearer",
})
_SENSITIVE_SUFFIXES = ("_key", "_secret", "_password", "-key", "-token", "-secret")


def _is_sensitive_key(key: str) -> bool:
    """判断字段名是否为敏感字段。

    注意（本轮自我修正）：不能用"子串包含 token"这类宽松规则 ——
    `max_tokens` 含 "token" 会被误判为敏感并脱敏，而它正是定位
    "请求参数有误"最需要的字段之一。必须精确匹配或按后缀匹配。
    """
    lk = str(key).strip().lower()
    if lk in _EXACT_SENSITIVE:
        return True
    return lk.endswith(_SENSITIVE_SUFFIXES)


def _sanitize(obj: Any) -> Any:
    """递归脱敏 + 截断。"""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if _is_sensitive_key(k):
                out[k] = f"<redacted len={len(str(v))}>" if v else "<empty>"
            elif k == "messages" and isinstance(v, list):
                out[k] = [
                    {
                        "role": m.get("role"),
                        "content": (str(m.get("content"))[:_MAX_MSG_CHARS]
                                    if m.get("content") is not None else None),
                        "tool_calls": len(m.get("tool_calls") or []),
                    }
                    for m in v[:_MAX_MSGS]
                    if isinstance(m, dict)
                ]
                if len(v) > _MAX_MSGS:
                    out[k].append({"_truncated": f"{len(v) - _MAX_MSGS} more messages"})
            else:
                out[k] = _sanitize(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [_sanitize(x) for x in obj[:50]]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)[:300]


def capture_llm_failure(
    *,
    model: str,
    request: dict[str, Any],
    exc: BaseException,
    provider_name: str = "",
    attempt_idx: int = -1,
    attempt_total: int = 1,
    extra: dict[str, Any] | None = None,
) -> Path | None:
    """落盘一次 LLM 调用失败的完整上下文。

    Args:
        model: 实际传给 litellm 的模型名（归一化后）。
        request: 传给 acompletion 的完整 kwargs。
        exc: 最终异常。
        provider_name: 失败时所在的 provider。
        attempt_idx / attempt_total: failover 链中的位置。
        extra: 附加信息。

    Returns:
        落盘路径；失败时 None（**绝不抛**）。
    """
    try:
        d = failures_dir()
        ts = time.time()
        payload = {
            "capturedAt": ts,
            "exception": {
                "type": type(exc).__name__,
                "module": type(exc).__module__,
                "message": str(exc)[:1500],
            },
            "model": model,
            "provider": provider_name,
            "failover": {"attemptIndex": attempt_idx, "attemptTotal": attempt_total},
            "request": _sanitize(request),
            "extra": _sanitize(extra or {}),
            "env": {
                "ENV": os.environ.get("ENV", ""),
                "LLM_TIMEOUT": os.environ.get("LLM_TIMEOUT", ""),
                "AGENT_RUNTIME_POSTURE": os.environ.get("AGENT_RUNTIME_POSTURE", ""),
            },
        }
        # 关键：把异常类型编进文件名，便于按类型聚合
        safe_exc = "".join(c for c in type(exc).__name__ if c.isalnum())[:24] or "Exc"
        path = d / f"{int(ts)}_{safe_exc}.json"
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # 目录容量控制（超限删最旧的）
        try:
            files = sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime)
            for old in files[: max(0, len(files) - _MAX_FILES)]:
                old.unlink(missing_ok=True)
        except Exception:
            pass

        log.warning(
            "LLM 调用失败报文已落盘",
            path=str(path),
            exc=type(exc).__name__,
            model=model,
            provider=provider_name,
        )
        return path
    except Exception as e:
        # 诊断设施绝不阻断主链路
        log.debug("failure capture failed", error=str(e))
        return None
