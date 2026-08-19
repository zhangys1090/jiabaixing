"""安全的 JSON 反序列化工具。

集中处理「持久化/外部数据损坏即崩溃」这一类健壮性问题：
仓库内大量 ``json.loads(row[col])`` / ``json.loads(file.read_text())`` 调用在
数据被半写、被其它工具覆盖、或版本错配时，会直接把 ``JSONDecodeError``
冒泡成未捕获异常（API 500 / 构造器崩溃 / 整表加载失败）。

本模块提供一个统一、绝不抛异常的入口 ``safe_json_loads``，损坏数据一律降级为
调用方给定的 ``default``，并通过 ``log_ignored`` 记账（符合 P0-3 静默异常处理红线）。
"""

from __future__ import annotations

import json
from typing import Any

from agent.core.logger import log_ignored


def safe_json_loads(
    value: Any,
    default: Any = None,
    *,
    context: str = "json",
) -> Any:
    """解析 JSON，损坏或非字符串输入一律降级为 ``default``，绝不抛异常。

    Args:
        value: 待解析值。已为 ``dict``/``list`` 时原样返回（避免重复解析且兼容
            调用方已拿到对象的场景）；``None`` 或非字符串标量直接返回 ``default``。
        default: 解析失败时的降级值。
        context: 记账位置标识，便于在忽略统计里定位来源。

    Returns:
        解析后的对象，或 ``default``。
    """
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, (str, bytes, bytearray)):
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError, ValueError) as _exc:
        log_ignored(None, "infrastructure.safe_json.loads", _exc, context=context)
        return default
