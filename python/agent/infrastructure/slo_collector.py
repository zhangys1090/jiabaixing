"""SLO 收集器 —— 把请求延迟/错误样本聚合为可监控的服务等级目标。

背景（审计 P1）：项目活跃、生产模拟 88% 通过，但"真实用户 / SLO / 反馈闭环"
缺乏实证。本模块为 `/v1/health/slo` 端点提供数据源，使 SLO 从文档主张变为
可被监控与告警核查的事实。

- 线程安全（被 FastAPI 中间件并发写入）。
- 维护有界延迟样本（默认 1000），计算成功率与 P95 延迟。
- 与阈值（SLO_OBJECTIVES）比对，输出 ok / breach。
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any


@dataclass
class SLOObjectives:
    """SLO 阈值（可被监控/告警引用）。"""

    success_rate_min: float = 0.95  # 成功率下限
    p95_latency_ms_max: float = 2000.0  # P95 延迟上限（毫秒）


SLO_OBJECTIVES = SLOObjectives()


class SLOCollector:
    """有界样本的 SLO 聚合器。"""

    def __init__(self, max_samples: int = 1000) -> None:
        self._max = max_samples
        self._lock = threading.Lock()
        self._latencies: deque[float] = deque(maxlen=max_samples)
        self._errors: int = 0
        self._total: int = 0
        self._start = time.time()

    def record(self, latency_ms: float, is_error: bool = False) -> None:
        """记录一次请求结果。"""
        with self._lock:
            self._latencies.append(float(latency_ms))
            self._total += 1
            if is_error:
                self._errors += 1

    def _p95(self) -> float:
        if not self._latencies:
            return 0.0
        s = sorted(self._latencies)
        idx = min(len(s) - 1, int(0.95 * (len(s) - 1) + 0.5))
        return s[idx]

    def snapshot(self, objectives: SLOObjectives | None = None) -> dict[str, Any]:
        """输出当前 SLO 快照（供 /v1/health/slo）。"""
        obj = objectives or SLO_OBJECTIVES
        with self._lock:
            total = self._total
            errors = self._errors
            succ = (total - errors) / total if total else 1.0
            p95 = self._p95()
        success_ok = succ >= obj.success_rate_min
        latency_ok = p95 <= obj.p95_latency_ms_max
        status = "ok" if (success_ok and latency_ok) else "breach"
        return {
            "service": "jiabaixing-agent",
            "window": {
                "total_requests": total,
                "errors": errors,
                "uptime_sec": round(time.time() - self._start, 1),
            },
            "success_rate": round(succ, 4),
            "p95_latency_ms": round(p95, 1),
            "objectives": {
                "success_rate_min": obj.success_rate_min,
                "p95_latency_ms_max": obj.p95_latency_ms_max,
            },
            "status": status,
        }


_collector: SLOCollector | None = None


def get_slo_collector() -> SLOCollector:
    """SLO 收集器单例。"""
    global _collector
    if _collector is None:
        _collector = SLOCollector()
    return _collector
