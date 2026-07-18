#!/usr/bin/env python3
"""生产就绪核查脚本（审计 P1：真实商用闭环证据）。

把「底层生产硬核 + 落地要求」从文档主张变为可核查事实：
逐项检查 分布式锁 / 消息队列主干 / 副本数 / OTel+SLO 端点，
输出 绿(OK)/黄(WARN)/红(RED) 清单，任一 RED 时退出码为 1。

运行：
    python python/scripts/verify_production_readiness.py
    python python/scripts/verify_production_readiness.py --slo-url http://localhost:8765

退出码：0 = 全部绿；1 = 存在红项（不应上线）。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any


# ------------------------- 单项检查 -------------------------

def _check_redis_lock() -> dict[str, Any]:
    """分布式锁（审计 P0-1）：需 REDIS_ENABLED 且 Redis 可达。"""
    if os.environ.get("REDIS_ENABLED", "false").lower() not in ("true", "1", "yes"):
        return {
            "name": "分布式锁 (DistributedLock)",
            "status": "RED",
            "detail": "REDIS_ENABLED != true：锁将降级为进程内 Lock，"
            "2+ 副本下共享 SQLite/Redis 存在竞态隐患（P0）。",
        }
    reachable, err = _redis_ping()
    if not reachable:
        return {
            "name": "分布式锁 (DistributedLock)",
            "status": "RED",
            "detail": f"Redis 不可达（{err}）：锁无法跨副本互斥，P0 风险未解除。",
        }
    return {
        "name": "分布式锁 (DistributedLock)",
        "status": "OK",
        "detail": "REDIS_ENABLED=true 且 Redis 可达：跨副本互斥已具备。",
    }


def _check_mq_backbone() -> dict[str, Any]:
    """消息队列主干（审计 P0-2）：需 MQ_ENABLED 且 Redis 可达（消费者组才生效）。"""
    if os.environ.get("MQ_ENABLED", "false").lower() not in ("true", "1", "yes"):
        return {
            "name": "消息队列主干 (RedisStreamsQueue)",
            "status": "RED",
            "detail": "MQ_ENABLED != true：队列回退为进程内 asyncio.Queue，"
            "多副本无法跨实例解耦（P0）。",
        }
    reachable, err = _redis_ping()
    if not reachable:
        return {
            "name": "消息队列主干 (RedisStreamsQueue)",
            "status": "RED",
            "detail": f"Redis 不可达（{err}）：Redis 消费者组循环无法连接，MQ 主干未通。",
        }
    return {
        "name": "消息队列主干 (RedisStreamsQueue)",
        "status": "OK",
        "detail": "MQ_ENABLED=true 且 Redis 可达：XREADGROUP 消费者循环跨实例解耦已具备。",
    }


def _check_replicas() -> dict[str, Any]:
    """副本数（落地要求）：需 >= 2 才谈得上水平扩展与锁/MQ 价值。"""
    try:
        n = int(os.environ.get("AGENT_REPLICAS", "1"))
    except ValueError:
        n = 1
    if n >= 2:
        return {
            "name": f"副本数 (AGENT_REPLICAS={n})",
            "status": "OK",
            "detail": ">=2 副本：水平扩展与跨实例解耦可被真实流量验证。",
        }
    return {
        "name": f"副本数 (AGENT_REPLICAS={n})",
        "status": "WARN",
        "detail": "单副本：分布式锁/MQ 的跨实例价值无法体现；"
        "建议 K8s 副本设 >=2（见 deploy/kubernetes/python-deployment.yaml）。",
    }


def _check_slo() -> dict[str, Any]:
    """OTel + SLO 端点（审计 P1）：需 OTEL_ENABLED 且 /v1/health/slo 可达。"""
    if os.environ.get("OTEL_ENABLED", "false").lower() not in ("true", "1", "yes"):
        return {
            "name": "可观测性 (OTel + SLO)",
            "status": "WARN",
            "detail": "OTEL_ENABLED != true：trace/指标未导出，SLO 缺乏数据来源。",
        }
    snap = _fetch_slo_snapshot()
    if snap is None:
        return {
            "name": "可观测性 (OTel + SLO)",
            "status": "RED",
            "detail": "SLO 端点不可达：商用闭环缺乏监控证据，无法告警。",
        }
    status = snap.get("status", "unknown")
    if status == "ok":
        return {
            "name": "可观测性 (OTel + SLO)",
            "status": "OK",
            "detail": f"SLO 端点可达且达标（success_rate={snap.get('success_rate')}，"
            f"p95={snap.get('p95_latency_ms')}ms，样本={snap.get('window', {}).get('total_requests')}）。",
        }
    return {
        "name": "可观测性 (OTel + SLO)",
        "status": "WARN",
        "detail": f"SLO 端点可达但状态={status}（阈值未达标），需排查延迟/错误率。",
    }


def _fetch_slo_snapshot() -> dict[str, Any] | None:
    """读取 /v1/health/slo 快照，失败返回 None。

    对 429 (Rate Limit) 做最多 3 次重试，间隔递增（0.5/1/2 秒），
    因为批量流量验证可能触发 ApiGateway 令牌桶限流。
    """
    url = f"{_slo_base()}/v1/health/slo"
    import json
    import urllib.request
    import urllib.error

    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:  # noqa: S310
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 3:
                time.sleep(0.5 * (2 ** attempt))
                continue
            return None
        except Exception:  # noqa: BLE001
            return None
    return None


def _check_real_traffic(n: int) -> dict[str, Any]:
    """最后一公里（真实流量）：向线上服务发起 N 次真实 HTTP 请求，
    再确认 /v1/health/slo 的 SLO 收集器确实记录了这些流量。
    这是「研发态硬核 → 生产态」的关键证据——SLO 必须反映真实用户体感。
    """
    if n <= 0:
        return {
            "name": "真实流量验证 (Real Traffic)",
            "status": "WARN",
            "detail": "未指定 --traffic，跳过真实流量验证（建议上线前用 --traffic 100 验证）。",
        }
    base = _slo_base()
    paths = ["/v1/health/slo", "/v1/metrics", "/docs", "/openapi.json"]
    total = 0
    ok = 0
    for i in range(n):
        p = paths[i % len(paths)]
        try:
            import urllib.request

            with urllib.request.urlopen(base + p, timeout=5) as r:  # noqa: S310
                code = r.status
            total += 1
            if 200 <= code < 400:
                ok += 1
        except Exception:  # noqa: BLE001
            total += 1
        # 每 10 个请求间短暂暂停，避免触发令牌桶限流（默认 60 容量/秒 1 补充）
        if (i + 1) % 10 == 0:
            time.sleep(0.2)
    snap = _fetch_slo_snapshot()
    samples = snap.get("window", {}).get("total_requests", 0) if snap else 0
    if total == 0:
        return {
            "name": "真实流量验证 (Real Traffic)",
            "status": "RED",
            "detail": "未能向服务发起任何真实请求（服务不可达？）。",
        }
    # SLO 收集器应至少记录到大部分真实流量（允许少量统计窗口边界差异）
    if samples < total * 0.5:
        return {
            "name": "真实流量验证 (Real Traffic)",
            "status": "RED",
            "detail": f"发起 {total} 次真实请求，但 SLO 样本仅 {samples}："
            "中间件未把真实流量写入 SLO 收集器，商用闭环证据缺失。",
        }
    succ = snap.get("success_rate") if snap else None
    p95 = snap.get("p95_latency_ms") if snap else None
    status = snap.get("status") if snap else "unknown"
    return {
        "name": "真实流量验证 (Real Traffic)",
        "status": "OK" if status == "ok" else "WARN",
        "detail": f"真实流量 {total} 次（成功 {ok}），SLO 已记录样本={samples}，"
        f"成功率={succ}，P95={p95}ms，状态={status}。",
    }


# ------------------------- 工具函数 -------------------------

def _slo_base() -> str:
    base = os.environ.get("SLO_BASE_URL", "http://127.0.0.1:8765").rstrip("/")
    # 归一化 localhost -> 127.0.0.1：uvicorn 仅监听 IPv4，
    # 而 localhost 在部分平台优先解析为 IPv6(::1)，会导致每次请求卡 ~2s 且流量打不到 SLO 中间件。
    if "://localhost" in base:
        base = base.replace("://localhost", "://127.0.0.1")
    return base


def _redis_ping() -> tuple[bool, str]:
    try:
        import redis.asyncio as aioredis  # type: ignore



        async def _ping() -> bool:
            # socket_connect_timeout 必须显式设置：否则当 Redis 未部署时，
            # TCP 连接会卡在 OS 重传超时（Windows 上可达分钟级），导致核查脚本假死。
            redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
            # 归一化 localhost -> 127.0.0.1：Windows 上 localhost 优先解析 IPv6(::1)，
            # 而 redis-server 默认仅监听 IPv4，导致连接卡到超时。
            if "://localhost" in redis_url:
                redis_url = redis_url.replace("://localhost", "://127.0.0.1")
            r = aioredis.from_url(
                redis_url,
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=2,
                protocol=2,  # RESP2 兼容 Redis 5.x
            )
            try:
                return bool(await asyncio.wait_for(r.ping(), timeout=2))
            finally:
                await r.aclose()



        return _run(_ping()), ""
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def _run(coro: Any) -> Any:
    try:
        import asyncio



        return asyncio.get_event_loop().run_until_complete(coro)
    except RuntimeError:
        import asyncio



        return asyncio.run(coro)


# ------------------------- 汇总 -------------------------

CHECKS = [_check_redis_lock, _check_mq_backbone, _check_replicas, _check_slo]


def run_checks() -> list[dict[str, Any]]:
    return [fn() for fn in CHECKS]


_GLYPH = {"OK": "[绿]", "WARN": "[黄]", "RED": "[红]"}


def main() -> int:
    parser = argparse.ArgumentParser(description="生产就绪核查")
    parser.add_argument(
        "--slo-url", default=None, help="SLO 端点基址，默认 http://localhost:8765"
    )
    parser.add_argument(
        "--traffic", type=int, default=0,
        help="最后一公里：向线上服务发起 N 次真实 HTTP 请求并校验 SLO 反映真实流量（默认 0=跳过）",
    )
    args = parser.parse_args()
    if args.slo_url:
        os.environ["SLO_BASE_URL"] = args.slo_url

    print("=" * 64)
    print("家百星 生产就绪核查  (P0/P1 差距验证)")
    print("=" * 64)
    results = run_checks()
    if args.traffic:
        results.append(_check_real_traffic(args.traffic))
    any_red = False
    for r in results:
        print(f"{_GLYPH[r['status']]} {r['name']}")
        print(f"      {r['detail']}")
        if r["status"] == "RED":
            any_red = True
    print("-" * 64)
    if any_red:
        print("结论：存在红项 —— 不建议上线，先解除 P0 风险。")
        return 1
    print("结论：全部绿/黄 —— 生产硬核已具备，可进入灰度（见 docs/PRODUCTION_READINESS_RUNBOOK.md）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
