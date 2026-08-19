"""jiabaixing E2E / 边界测试共享夹具与基础设施。

本文件为所有端到端（E2E）与边界（boundary）测试提供统一的离线引擎夹具，
避免每个测试文件重复构造轻量 AgentEngine。核心机制（与 test_baseline_e2e.py
一致，并经 CI 验证）：

- 通过 ``AgentEngine.__new__`` 跳过重型 ``__init__``，仅注入完整调用链所需的
  最小属性集（真实 ``SessionStore`` + 真实 ``ToolRegistry`` 默认工具）。
- 用 monkeypatch 替换 ``LLMProvider.chat`` / ``check_available``，使全链路
  不依赖外部 LLM API（离线可跑，CI 无需任何密钥）。
- 将引擎注入 ``agent.main.engine``，测试通过 ``httpx.ASGITransport`` 直接
  驱动真实 FastAPI ``app``，从而验证「用户输入 → 路由 → 引擎 → 输出」完整链路。

标记（e2e / boundary / unit / slow）在 ``pytest.ini`` 中注册；本文件仅提供夹具。
"""

from __future__ import annotations

import threading
import time
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from agent.core.engine import AgentEngine
from agent.llm.provider import LLMProvider


@pytest.fixture
def anyio_backend() -> str:
    """指定 anyio 使用 asyncio 后端（与 asyncio_mode=auto 配合）。"""
    return "asyncio"


async def _mock_chat(
    self: LLMProvider,
    messages: list[dict[str, str]],
    tools: list[dict[str, Any]] | None = None,
    stream: bool = False,
    use_cache: bool = True,
    system_prompt: str | None = None,
    user_id: str | None = None,
    strategy_name: str | None = None,
    task_type: str | None = None,
) -> dict[str, Any]:
    """Mock LLM chat：返回固定响应，避免任何外部网络调用。"""
    return {
        "content": "你好，我是家百星，很高兴为您服务！",
        "role": "assistant",
        "finish_reason": "stop",
    }


async def _mock_check_available(self: LLMProvider) -> bool:
    """Mock LLM 可用性检查，始终返回 True。"""
    return True


@pytest.fixture
def mock_llm_engine(monkeypatch, tmp_path):
    """构造轻量但可用的 AgentEngine 并注入 ``agent.main.engine``。

    跳过 ``AgentEngine.__init__`` 的重型初始化，仅设置调用链所需的最小属性集，
    真实挂载 ``SessionStore`` 与 ``ToolRegistry``（默认工具），并用 Mock LLM 替换
    网络方法。测试结束后清理全局 engine，避免污染其他用例。

    Yields:
        AgentEngine: 已就绪的轻量引擎实例。
    """
    # Mock LLMProvider 的网络方法（离线关键）
    monkeypatch.setattr(LLMProvider, "chat", _mock_chat)
    monkeypatch.setattr(LLMProvider, "check_available", _mock_check_available)

    engine = AgentEngine.__new__(AgentEngine)

    # 核心对话链所需的最小属性
    engine.llm = LLMProvider()
    engine._session_count = 0
    engine._active_sessions = 0
    engine._start_time = time.time()
    # process_input 使用 _counter_lock 做并发计数，__new__ 跳过 __init__ 必须手动补上
    engine._counter_lock = threading.Lock()
    engine._domain_proxy_enabled = True
    engine._loop_strategies = {}
    engine._registry = None
    engine._degraded_subsystems = set()
    engine._degraded_reasons = {}
    engine._critical_degraded = set()
    engine.domains = {}

    # process_input 中可选的子系统（设为 None 走降级路径）
    engine.hook_manager = None
    engine.security = None
    engine.memory = None
    engine.evolution = None
    engine.conversation = None
    engine.loop = None
    engine.context_manager = None
    engine.context_file_registry = None
    engine.context_reference_resolver = None
    engine.context_compressor = None
    engine.context_window_manager = None
    engine.unified_context_orchestrator = None
    engine.output_guardrail = None
    engine.verification = None
    engine.trajectory_db = None
    engine.flywheel = None
    engine.persistence = None
    engine.curator = None
    engine.feedback_loops = None
    engine.performance_monitor = None
    engine.learning_signals = None
    engine.strategy_adapter = None
    engine.evolution_trigger = None
    engine.think_scrubber = None
    engine._multi_agent_orchestrator = None
    engine.production_metrics = None
    engine.feedback_loop = None
    engine.fewshot_generalizer = None
    engine.incremental_planner = None
    engine.plan_quality_checker = None
    engine.reflection_applier = None
    engine.canary_manager = None
    engine.priority_scorer = None
    engine._redis_cache = None
    engine._evolution_orchestrator = None
    engine.persona = None
    engine.toolset_registry = None
    engine.mcp_tool_bridge = None
    engine.permission_guard = None
    engine.schema_validator = None
    engine.tool_call_guard = None
    engine.approval_manager = None
    engine.skill_registry = None
    engine.agent_registry = None
    engine.orchestrator = None
    engine.cron_scheduler = None
    engine.output_guardrail = None
    engine.sandbox = None
    engine.batch_processor = None
    engine.attention_focus = None
    engine.session_recap = None
    engine.title_generator = None

    # 会话存储（真实实例，支持会话管理链）
    # 使用 tmp_path 隔离 SQLite 文件，避免 xdist 多进程并行时锁竞争
    try:
        from agent.persistence.session_store import SessionStore

        engine.session_store = SessionStore(db_path=str(tmp_path / "sessions.db"))
    except Exception:
        engine.session_store = None

    # 工具注册表（真实实例 + 默认工具，支持工具调用链）
    try:
        from agent.tools.registry import ToolRegistry, register_default_tools

        engine.tool_registry = ToolRegistry()
        register_default_tools(engine.tool_registry)
    except Exception:
        engine.tool_registry = None

    # A2A 协议组件（支持 A2A 路由链）
    try:
        from agent.a2a import (
            A2AAgentCard,
            A2ACapability,
            A2ACapabilityType,
            A2ATransport,
        )

        engine.a2a_self_card = A2AAgentCard(
            id="agent:jiabaixing",
            name="Jiabaixing",
            description="家百星主 Agent — E2E 测试",
            url="http://localhost:3112/a2a",
            transport=A2ATransport.HTTP,
            capabilities=[
                A2ACapability(
                    type=A2ACapabilityType.TASK_EXECUTION,
                    name="task-execution",
                    description="执行通用任务",
                ),
            ],
            version="1.0.0",
        )
        engine.a2a_manager = None
        engine.a2a_remote_endpoints = []
    except Exception:
        engine.a2a_self_card = None
        engine.a2a_manager = None
        engine.a2a_remote_endpoints = []

    # 注入到全局 engine（API 路由通过 get_engine() 读取）
    import agent.main as main_module

    main_module.engine = engine

    # 挂载 A2A 路由（lifespan 未触发，需手动挂载）
    if engine.a2a_self_card is not None:
        try:
            from agent.a2a import mount_a2a_routes

            mount_a2a_routes(
                main_module.app,
                manager=engine.a2a_manager,
                self_card=engine.a2a_self_card,
            )
        except Exception:
            pass

    try:
        yield engine
    finally:
        # 清理全局 engine，避免影响其他测试
        main_module.engine = None


@pytest.fixture
async def asgi_client(mock_llm_engine):
    """基于 ASGITransport 的 FastAPI 测试客户端（无需启动真实服务器）。"""
    from agent.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
