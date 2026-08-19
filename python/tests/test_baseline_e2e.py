"""jiabaixing 执行 agent 基线 — 端到端可验证的最小执行流程。

本模块是家百星项目的"执行 agent 基线"，用于证明从用户输入到系统输出的
完整调用链贯通。覆盖以下 7 条核心调用链：

1. 健康检查链: GET /health → 返回 200 + 服务状态
2. 会话管理链: POST /v1/sessions → 创建会话 → GET /v1/sessions/{id} → 查询会话
3. 核心对话链: POST /v1/chat → engine.process_input → 返回响应
4. 工具调用链: 用户输入触发工具调用 → tool_registry.execute → 返回工具结果
5. MCP 路由链: GET /v1/mcp/servers → 返回已注册的 MCP 服务器列表
6. A2A 路由链: GET /a2a/.well-known/agent.json → 返回 AgentCard
7. 多模态路由链: POST /v1/memory/multimodal/store → 写入多模态记忆

设计原则:
- 使用 httpx.AsyncClient + ASGITransport 直接测试 FastAPI app（无需启动真实服务器）
- 所有测试独立可运行，不依赖外部 LLM API
- 用 Mock 替代真实 LLM 调用，避免网络依赖
- 每个测试有清晰的 docstring 说明验证的调用链

遵循开发规则:
- 不重复造轮子（复用现有 phase8_e2e 测试模式）
- 直接集成到现有系统（使用真实的 FastAPI app 和路由）
- 测试 100% 通过
- 中文注释
"""

from __future__ import annotations

import time
from typing import Any

import pytest
import threading
from httpx import ASGITransport, AsyncClient

from agent.core.engine import AgentEngine
from agent.llm.provider import LLMProvider

# ─────────────────────────────────────────────────────────────
# 测试夹具：构造轻量但可用的 AgentEngine + Mock LLM
# ─────────────────────────────────────────────────────────────


@pytest.fixture
def anyio_backend() -> str:
    """指定 anyio 使用 asyncio 后端。"""
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
) -> dict[str, Any]:
    """Mock LLM chat 方法，返回固定响应以避免外部 API 调用。

    Args:
        self: LLMProvider 实例（被 monkeypatch 绑定）。
        messages: 消息列表。
        tools: 工具列表（忽略）。
        stream: 是否流式（忽略）。
        use_cache: 是否使用缓存（忽略）。
        system_prompt: 系统提示（忽略）。
        user_id: 用户 ID（忽略）。
        strategy_name: 灰度策略名（忽略）。

    Returns:
        dict: 固定的 LLM 响应字典。
    """
    return {
        "content": "你好，我是家百星，很高兴为您服务！",
        "role": "assistant",
        "finish_reason": "stop",
    }


async def _mock_check_available(self: LLMProvider) -> bool:
    """Mock LLM 可用性检查，始终返回 True。"""
    return True


@pytest.fixture
async def baseline_engine(monkeypatch):
    """构造轻量但可用的 AgentEngine 实例并注入到 agent.main.engine。

    通过 AgentEngine.__new__ 跳过 __init__ 的重型初始化，仅设置 7 条
    调用链所需的最小属性集。同时 mock LLMProvider.chat 避免外部 API 调用。

    Yields:
        AgentEngine: 已就绪的轻量引擎实例。
    """
    # Mock LLMProvider 的网络方法
    monkeypatch.setattr(LLMProvider, "chat", _mock_chat)
    monkeypatch.setattr(LLMProvider, "check_available", _mock_check_available)

    # 通过 __new__ 跳过重型 __init__，构造轻量 engine
    engine = AgentEngine.__new__(AgentEngine)

    # 核心对话链所需的最小属性
    engine.llm = LLMProvider()
    engine._session_count = 0
    engine._active_sessions = 0
    engine._start_time = time.time()
    # process_input 使用 _counter_lock 做并发计数，__new__ 跳过了 __init__ 必须手动补上
    engine._counter_lock = threading.Lock()
    # __init__ 中设置的下划线簿记属性（__getattr__ 对缺失下划线属性一律抛错，必须补齐）
    engine._domain_proxy_enabled = True
    engine._loop_strategies: dict = {}
    engine._registry = None
    engine._degraded_subsystems: set = set()
    engine._degraded_reasons: dict = {}
    engine._critical_degraded: set = set()
    engine.domains: dict = {}

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
    # P3-#3: 生产埋点 + 持续反馈闭环（process_input 引用，设为 None 走降级）
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
    try:
        from agent.persistence.session_store import SessionStore
        engine.session_store = SessionStore()
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
            get_a2a_manager,
        )
        import asyncio

        loop = asyncio.get_event_loop()
        if loop.is_running():
            # 在已有事件循环中创建 A2A manager（同步包装）
            engine.a2a_manager = None
            engine.a2a_self_card = A2AAgentCard(
                id="agent:jiabaixing",
                name="Jiabaixing",
                description="家百星主 Agent — 基线测试",
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
        else:
            engine.a2a_self_card = None
            engine.a2a_manager = None
    except Exception:
        engine.a2a_self_card = None
        engine.a2a_manager = None

    engine.a2a_remote_endpoints = []

    # 注入到全局 engine（API 路由通过 get_engine() 读取）
    import agent.main as main_module
    main_module.engine = engine

    # 挂载 A2A 路由（lifespan 未触发，需手动挂载）
    a2a_router_mounted = False
    if engine.a2a_self_card is not None:
        try:
            from agent.a2a import mount_a2a_routes
            mount_a2a_routes(main_module.app, manager=engine.a2a_manager, self_card=engine.a2a_self_card)
            a2a_router_mounted = True
        except Exception:
            a2a_router_mounted = False

    try:
        yield engine
    finally:
        # 清理全局 engine，避免影响其他测试
        main_module.engine = None


# ─────────────────────────────────────────────────────────────
# 调用链 1: 健康检查链
# ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_chain_1_health_check(baseline_engine):
    """调用链 1: 健康检查链。

    验证: GET /health → 返回 200 + status="ok" + 服务状态字段。

    调用路径: HTTP GET /health → root_router.health() →
              get_engine() → eng.llm.check_available() → HealthResponse
    """
    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    # 健康响应应包含基本字段
    assert "uptime_seconds" in data
    assert "llm_available" in data
    assert "llm_model" in data
    # mock 后 LLM 应可用
    assert data["llm_available"] is True


# ─────────────────────────────────────────────────────────────
# 调用链 2: 会话管理链
# ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_chain_2_session_management(baseline_engine):
    """调用链 2: 会话管理链。

    验证: POST /v1/sessions 创建会话 → GET /v1/sessions/{id} 查询会话 →
          POST /v1/sessions/{id}/messages 添加消息 → GET /v1/sessions/{id}/messages 查询消息。

    调用路径: HTTP POST /v1/sessions → sessions.create_session() →
              SessionStore.create_session() → 返回 session_id
              HTTP GET /v1/sessions/{id} → sessions.get_session() → SessionStore.get_session()
    """
    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 步骤 1: 创建会话
        resp = await client.post("/v1/sessions", json={"title": "基线测试会话"})
        assert resp.status_code == 200
        create_data = resp.json()
        assert "session_id" in create_data
        session_id = create_data["session_id"]
        assert create_data["title"] == "基线测试会话"

        # 步骤 2: 查询会话
        resp = await client.get(f"/v1/sessions/{session_id}")
        assert resp.status_code == 200
        session_data = resp.json()
        assert session_data["session_id"] == session_id
        assert "created_at" in session_data

        # 步骤 3: 添加消息
        resp = await client.post(
            f"/v1/sessions/{session_id}/messages",
            json={"role": "user", "content": "你好，家百星"},
        )
        assert resp.status_code == 200
        assert resp.json()["success"] is True

        # 步骤 4: 查询消息
        resp = await client.get(f"/v1/sessions/{session_id}/messages")
        assert resp.status_code == 200
        messages = resp.json()
        assert len(messages) >= 1
        assert messages[0]["content"] == "你好，家百星"
        assert messages[0]["role"] == "user"


# ─────────────────────────────────────────────────────────────
# 调用链 3: 核心对话链
# ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_chain_3_core_chat(baseline_engine):
    """调用链 3: 核心对话链。

    验证: POST /v1/chat → engine.process_input → _process_simple →
          llm.chat (mock) → 返回 ChatResponse。

    调用路径: HTTP POST /v1/chat → chat.chat() →
              get_engine() → eng.process_input(message, session_id) →
              _should_use_loop("你好")=False → _process_simple() →
              self.llm.chat(messages) → 返回响应
    """
    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/v1/chat",
            json={
                "message": "你好",
                "session_id": "baseline-chat-test",
            },
        )

    assert resp.status_code == 200
    data = resp.json()
    # 验证核心对话响应字段
    assert "content" in data
    assert isinstance(data["content"], str)
    assert len(data["content"]) > 0
    assert data["session_id"] == "baseline-chat-test"
    assert "trace_id" in data
    # mock LLM 返回的固定响应
    assert "家百星" in data["content"]


# ─────────────────────────────────────────────────────────────
# 调用链 4: 工具调用链
# ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_chain_4_tool_invocation(baseline_engine):
    """调用链 4: 工具调用链。

    验证: tool_registry.execute("file_list", params) → 返回 ToolResult。

    调用路径: engine.tool_registry.execute("file_list", {"dir_path": "."}) →
              ToolRegistry._tools["file_list"] → file_list_executor(params) →
              ToolResult(success=True, output=...)
    """
    eng = baseline_engine
    assert eng.tool_registry is not None, "tool_registry 未初始化"

    # 验证工具注册表非空
    assert eng.tool_registry.size() > 0, "工具注册表为空，未注册任何工具"

    # 验证 file_list 工具存在
    file_list_def = eng.tool_registry.get_definition("file_list")
    assert file_list_def is not None, "file_list 工具未注册"

    # 执行 file_list 工具
    result = await eng.tool_registry.execute(
        "file_list",
        {"dir_path": "."},
    )

    # 验证工具执行结果
    assert result is not None
    # file_list 应该成功（当前目录存在）
    assert result.success is True, f"file_list 执行失败: {result.error}"
    assert result.output is not None


@pytest.mark.anyio
async def test_chain_4_tool_invocation_via_api(baseline_engine):
    """调用链 4 (扩展): 通过 API 端点验证工具注册表可见性。

    验证: GET /v1/metrics → 返回 tool_metrics.total_tools > 0，
          证明工具注册表已挂载到 engine 并可被 API 访问。
    """
    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/metrics")

    assert resp.status_code == 200
    data = resp.json()
    # metrics 应包含工具指标
    assert "tool_metrics" in data
    tool_metrics = data["tool_metrics"]
    assert "total_tools" in tool_metrics
    assert tool_metrics["total_tools"] > 0, "engine.tool_registry 未挂载或为空"


# ─────────────────────────────────────────────────────────────
# 调用链 5: MCP 路由链
# ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_chain_5_mcp_servers(baseline_engine):
    """调用链 5: MCP 路由链。

    验证: GET /v1/mcp/servers → 返回 200 + {"servers": [...], "total": N}。

    调用路径: HTTP GET /v1/mcp/servers → mcp.list_servers() →
              MCPServerManager.get_instance().get_all_servers() →
              对每个 server 调用 get_server_status() → 返回列表
    """
    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/mcp/servers")

    assert resp.status_code == 200
    data = resp.json()
    # MCP 服务器列表响应结构
    assert "servers" in data
    assert "total" in data
    assert isinstance(data["servers"], list)
    assert data["total"] == len(data["servers"])
    # 即使没有注册的服务器，total 也应为 0（而非报错）
    assert data["total"] >= 0


# ─────────────────────────────────────────────────────────────
# 调用链 6: A2A 路由链
# ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_chain_6_a2a_agent_card(baseline_engine):
    """调用链 6: A2A 路由链。

    验证: GET /a2a/.well-known/agent.json → 返回 200 + AgentCard。

    调用路径: HTTP GET /a2a/.well-known/agent.json →
              a2a_router.get_self_agent_card() →
              self_card.to_dict() → 返回 Agent Card
    """
    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/a2a/.well-known/agent.json")

    assert resp.status_code == 200
    data = resp.json()
    # Agent Card 标准字段
    assert data["id"] == "agent:jiabaixing"
    assert data["name"] == "Jiabaixing"
    assert "capabilities" in data
    assert isinstance(data["capabilities"], list)
    assert len(data["capabilities"]) > 0
    # 验证 TASK_EXECUTION 能力已发布
    cap_types = [c["type"] for c in data["capabilities"]]
    assert "task-execution" in cap_types


@pytest.mark.anyio
async def test_chain_6_a2a_agents_list(baseline_engine):
    """调用链 6 (扩展): A2A Agent 列表端点。

    验证: GET /a2a/agents → 返回 200 + Agent Card 列表。
    """
    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/a2a/agents")

    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)


# ─────────────────────────────────────────────────────────────
# 调用链 7: 多模态路由链
# ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_chain_7_multimodal_store(baseline_engine, monkeypatch):
    """调用链 7: 多模态路由链。

    验证: POST /v1/memory/multimodal/store → engine.memory.store_multimodal →
          返回 MultimodalStoreResponse。

    调用路径: HTTP POST /v1/memory/multimodal/store →
              multimodal.store_multimodal() → get_memory() →
              engine.memory.store_multimodal(content, ...) → 返回 mem_id

    由于完整 MemoryEngine 初始化较重，本测试 mock memory.store_multimodal
    和 memory.get_stats，验证路由层调用链贯通。
    """
    # 为 engine 注入 mock memory（支持多模态接口）
    eng = baseline_engine

    class _MockMemory:
        """轻量 mock MemoryEngine，仅实现多模态接口。"""

        async def store_multimodal(
            self,
            content: str,
            image_path: str | None = None,
            memory_type: str = "long_term",
            scene: str = "multimodal",
            emotion: str = "neutral",
            metadata: dict[str, Any] | None = None,
        ) -> str:
            """Mock 多模态存储，返回固定 mem_id。"""
            return "mem_baseline_test_001"

        async def get_stats(self) -> dict[str, Any]:
            """Mock 统计信息，返回多模态模型名。"""
            return {"multimodal_model": "fallback"}

    eng.memory = _MockMemory()

    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/v1/memory/multimodal/store",
            json={
                "content": "这是一条多模态记忆测试内容",
                "memory_type": "long_term",
                "scene": "baseline_test",
            },
        )

    assert resp.status_code == 200
    data = resp.json()
    # 多模态存储响应字段
    assert data["success"] is True
    assert data["id"] == "mem_baseline_test_001"
    assert "model" in data


@pytest.mark.anyio
async def test_chain_7_multimodal_store_empty_content(baseline_engine):
    """调用链 7 (边界): 多模态存储空内容应返回 400。

    验证输入校验逻辑：content 为空时应拒绝。
    """
    # 注入 mock memory（即使不被调用，也需要存在以通过 503 检查）
    eng = baseline_engine

    class _MockMemory:
        async def store_multimodal(self, **kwargs):
            return "should_not_reach"

        async def get_stats(self):
            return {}

    eng.memory = _MockMemory()

    transport = ASGITransport(app=__import__("agent.main", fromlist=["app"]).app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/v1/memory/multimodal/store",
            json={"content": ""},
        )

    assert resp.status_code == 400
    assert "content" in resp.json()["detail"].lower()
