#!/usr/bin/env python3
"""真实流量探针 —— 在生产 HTTP 栈上发起真实请求，验证 SLO/中间件闭环。

用途（审计收口 · 最后一公里）：把研发态的 SLO/MetricsMiddleware 推到「生产态」，
即真正有流量经过的 HTTP 服务。本脚本启动**真实的** `agent.main:app`
（同一套 MetricsMiddleware + /v1/health/slo 路由），仅把 lifespan 替换为空操作，
以绕过 LLM engine 初始化（litellm 等在纯 HTTP 层验证中并非必需）。

启动后可直接对其发起真实 HTTP 流量，再由
`verify_production_readiness.py --traffic N` 读取 /v1/health/slo 确认样本已被写入。

运行：
    python python/scripts/live_smoke.py                # 监听 :8765
    SMOKE_PORT=9000 python python/scripts/live_smoke.py

随后在另一终端：
    python python/scripts/verify_production_readiness.py \
        --slo-url http://localhost:8765 --traffic 100
"""

from __future__ import annotations

import os

from contextlib import asynccontextmanager

from agent.main import app


@asynccontextmanager
async def _noop_lifespan(app):  # noqa: ANN001
    # 跳过 engine/litellm 初始化：本探针只验证 HTTP 层（SLO + 中间件）
    yield


# 用空 lifespan 替换原 lifespan，避免 engine.initialize() 因缺依赖失败
app.router.lifespan_context = _noop_lifespan  # type: ignore[attr-defined]


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("SMOKE_PORT", "8765"))
    print(f"[live_smoke] 启动真实 Agent HTTP 栈于 :{port}（lifespan=noop，仅验证 HTTP 层）")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
