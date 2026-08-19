"""Engine 扩展组件统一初始化模块。

提供所有新增组件的工厂方法，通过统一入口集成到 AgentEngine。
所有新组件在此集中管理，避免分散修改 engine.py。

组件：
- MemoryConsolidator:   记忆自动整理
- ConfigReloader:       动态配置热重载
- BackpressureController: 背压机制
- HealthChecker:        统一健康检查
- VerificationLoop:     验证闭环集成
- ClarificationEngine:  澄清交互集成
"""

from __future__ import annotations

from typing import Any

from agent.core.logger import StructuredLogger
from agent.core.backpressure import BackpressureController, BackpressureConfig
from agent.core.config_watcher import ConfigReloader
from agent.memory.consolidation import MemoryConsolidator, ConsolidationConfig
from agent.core.verification_loop import VerificationLoop
from agent.core.clarification import ClarificationEngine, ClarificationConfig
from agent.api.health import (
    get_health_checker,
    set_engine_for_health,
    register_default_checks,
    create_health_router,
)

log = StructuredLogger("engine_extensions")

__all__ = [
    "init_extensions",
    "shutdown_extensions",
    "get_health_router",
]


def init_extensions(engine: Any) -> None:
    log.info("Initializing engine extensions...")

    engine.backpressure = BackpressureController(
        BackpressureConfig(enabled=True, max_concurrent=50, max_queue_depth=200)
    )
    log.info("BackpressureController initialized")

    engine.config_reloader = ConfigReloader(engine)
    log.info("ConfigReloader initialized")

    llm = getattr(engine, "llm", None)
    engine.memory_consolidator = MemoryConsolidator(
        llm=llm,
        config=ConsolidationConfig(
            strategy=ConsolidationConfig.strategy,
            max_input_tokens=8000,
            recent_keep_count=10,
            enabled=True,
        ),
    )
    log.info("MemoryConsolidator initialized")

    verification = getattr(engine, "verification", None)
    engine.verification_loop = VerificationLoop(
        verification=verification,
        enable_tool_verification=True,
        enable_response_verification=True,
        enable_guardrails=True,
        max_correction_rounds=2,
    )
    log.info("VerificationLoop initialized")

    engine.clarification_engine = ClarificationEngine(
        ClarificationConfig(enabled=True, auto_detect=True, max_questions=3)
    )
    log.info("ClarificationEngine initialized")

    set_engine_for_health(engine)
    register_default_checks(engine)
    log.info("HealthChecker initialized")

    log.info("All engine extensions initialized successfully")


async def shutdown_extensions(engine: Any) -> None:
    log.info("Shutting down engine extensions...")
    reloader = getattr(engine, "config_reloader", None)
    if reloader:
        try:
            await reloader.stop()
        except Exception as e:
            log.warning("Failed to stop ConfigReloader", error=str(e))
    log.info("Engine extensions shutdown complete")


def get_health_router() -> Any:
    return create_health_router()
