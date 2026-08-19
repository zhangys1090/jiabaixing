import logging
import os
import sys
import threading
from typing import Any


_LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

_initialized = False


def setup_logging(level: int = logging.INFO) -> None:
    global _initialized
    if _initialized:
        return
    root = logging.getLogger("agent")
    root.setLevel(level)
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(_LOG_FORMAT, _DATE_FORMAT))
        root.addHandler(handler)
    _initialized = True


def get_logger(name: str) -> logging.Logger:
    setup_logging()
    return logging.getLogger(f"agent.{name}")


class StructuredLogger:
    def __init__(self, name: str) -> None:
        self._logger = get_logger(name)
        self._name = name

    def _format_kwargs(self, kwargs: dict[str, Any]) -> str:
        if not kwargs:
            return ""
        parts = [f"{k}={v}" for k, v in kwargs.items()]
        return " | " + " ".join(parts)

    def debug(self, msg: str, **kwargs: Any) -> None:
        self._logger.debug(msg + self._format_kwargs(kwargs))

    def info(self, msg: str, **kwargs: Any) -> None:
        self._logger.info(msg + self._format_kwargs(kwargs))

    def warning(self, msg: str, **kwargs: Any) -> None:
        self._logger.warning(msg + self._format_kwargs(kwargs))

    def error(self, msg: str, **kwargs: Any) -> None:
        self._logger.error(msg + self._format_kwargs(kwargs))

    def critical(self, msg: str, **kwargs: Any) -> None:
        self._logger.critical(msg + self._format_kwargs(kwargs))


# ---------------------------------------------------------------------------
# 已忽略异常（原 ``except ...: pass``）的可观测记账 — 审计 P2-1
# ---------------------------------------------------------------------------
#
# 背景：全仓曾有 350+ 处 ``except X: pass``。它们大多确实「可以忽略」（指标
# 上报失败、可选上下文加载失败…），但 ``pass`` 让故障彻底不可观测，这是历史上
# 「文档说完成、实际不生效」的结构性成因。
#
# 直接全改 ``log.warning`` 会在热路径刷屏，因此统一走 ``log_ignored()``：
#   1) 默认按 DEBUG 记录（不污染生产日志）；
#   2) **无条件**计入进程内计数器，可经 ``get_ignored_exception_stats()``
#      与 ``/health`` 暴露 —— 「可观测」由计数器承载，而非日志级别；
#   3) 可用 ``IGNORED_EXC_LOG_LEVEL=warning`` 提级，用于排障时一键放大。

_ignored_counts: dict[str, int] = {}
_ignored_lock = threading.Lock()
_ignored_total = 0

_VALID_LEVELS = ("debug", "info", "warning", "error")


def _default_ignored_level() -> str:
    level = os.getenv("IGNORED_EXC_LOG_LEVEL", "debug").strip().lower()
    return level if level in _VALID_LEVELS else "debug"


_fallback_logger: "StructuredLogger | None" = None


def _get_fallback_logger() -> "StructuredLogger":
    """给没有模块级 logger 的调用方兜底，避免为记账被迫改动模块结构。"""
    global _fallback_logger
    if _fallback_logger is None:
        _fallback_logger = StructuredLogger("ignored")
    return _fallback_logger


def log_ignored(
    log: "StructuredLogger | logging.Logger | None",
    where: str,
    exc: BaseException,
    *,
    level: str | None = None,
    **ctx: Any,
) -> None:
    """记录一处「有意忽略」的异常，替代裸 ``pass``。

    Args:
        log: 调用方的 logger（StructuredLogger 或标准 Logger 均可）；
            传 ``None`` 时使用内置的 ``agent.ignored`` 兜底 logger。
        where: 发生位置，约定为 ``模块.类.方法`` 或 ``模块.函数``。
        exc: 被忽略的异常实例。
        level: 日志级别，默认取 ``IGNORED_EXC_LOG_LEVEL``（缺省 debug）。
        **ctx: 附加上下文键值。

    该函数**自身绝不抛异常** —— 它运行在 except 块内，抛出会掩盖原始控制流。
    """
    global _ignored_total
    try:
        with _ignored_lock:
            _ignored_counts[where] = _ignored_counts.get(where, 0) + 1
            _ignored_total += 1

        if log is None:
            log = _get_fallback_logger()
        lvl = (level or _default_ignored_level()).lower()
        if lvl not in _VALID_LEVELS:
            lvl = "debug"
        emit = getattr(log, lvl, None)
        if emit is None:
            return
        msg = f"忽略异常 @ {where}"
        if isinstance(log, StructuredLogger):
            emit(msg, error=f"{type(exc).__name__}: {exc}", **ctx)
        else:  # 标准 logging.Logger 不吃任意 kwargs
            extra = " ".join(f"{k}={v}" for k, v in ctx.items())
            emit(f"{msg} | error={type(exc).__name__}: {exc}"
                 + (f" | {extra}" if extra else ""))
    except Exception:  # noqa: BLE001 - 记账失败绝不影响业务路径
        return


def get_ignored_exception_stats() -> dict[str, Any]:
    """返回已忽略异常的聚合统计，供 /health、诊断端点消费。"""
    with _ignored_lock:
        by_site = dict(_ignored_counts)
        total = _ignored_total
    top = sorted(by_site.items(), key=lambda kv: -kv[1])[:20]
    return {
        "total": total,
        "distinct_sites": len(by_site),
        "top_sites": [{"where": w, "count": c} for w, c in top],
    }


def reset_ignored_exception_stats() -> None:
    """清空统计（测试用）。"""
    global _ignored_total
    with _ignored_lock:
        _ignored_counts.clear()
        _ignored_total = 0
