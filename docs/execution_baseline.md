# Jiabaixing Agent 执行基线文档

**版本**: v1.1
**建立日期**: 2026-07-05
**状态**: 基线已建立 — 7 条核心调用链端到端验证通过 + 模块测试全覆盖

---

## 一、基线定义

执行基线是家百星 Agent 系统的最小可验证执行流程集合。每条基线调用链
代表从用户输入到系统输出的完整路径，确保核心功能贯通。

基线测试文件: `python/tests/test_baseline_e2e.py`

---

## 二、7 条核心调用链

### 调用链 1: 健康检查链

```
GET /health → root_router.health() → get_engine() → eng.llm.check_available() → HealthResponse
```

**验证点**:

- 返回 HTTP 200
- `status == "ok"`
- 包含 `uptime_seconds`、`llm_available`、`llm_model` 字段

---

### 调用链 2: 会话管理链

```
POST /v1/sessions → sessions.create_session() → SessionStore.create_session() → session_id
GET /v1/sessions/{id} → sessions.get_session() → SessionStore.get_session()
POST /v1/sessions/{id}/messages → sessions.add_message()
GET /v1/sessions/{id}/messages → sessions.get_messages()
```

**验证点**:

- 创建会话返回 `session_id`
- 查询会话返回完整会话数据
- 添加消息成功
- 查询消息返回正确内容

---

### 调用链 3: 核心对话链

```
POST /v1/chat → chat.chat() → get_engine() → eng.process_input(message, session_id)
  → _should_use_loop("你好")=False → _process_simple() → self.llm.chat(messages)
  → ChatResponse
```

**验证点**:

- 返回 HTTP 200
- `content` 非空字符串
- `session_id` 正确回传
- 包含 `trace_id`

---

### 调用链 4: 工具调用链

```
engine.tool_registry.execute("file_list", {"dir_path": "."})
  → ToolRegistry._tools["file_list"] → file_list_executor(params) → ToolResult
```

**验证点**:

- `tool_registry.size() > 0`
- `file_list` 工具已注册
- 执行 `file_list` 返回 `success=True`
- API 端点 `GET /v1/metrics` 返回 `tool_metrics.total_tools > 0`

---

### 调用链 5: MCP 路由链

```
GET /v1/mcp/servers → mcp.list_servers() → MCPServerManager.get_instance().get_all_servers()
  → 返回 {"servers": [...], "total": N}
```

**验证点**:

- 返回 HTTP 200
- 包含 `servers` 列表和 `total` 计数
- `total == len(servers)`

---

### 调用链 6: A2A 路由链

```
GET /a2a/.well-known/agent.json → a2a_router.get_self_agent_card() → self_card.to_dict()
GET /a2a/agents → a2a_router.list_agents()
```

**验证点**:

- 返回 HTTP 200
- Agent Card 包含 `id`、`name`、`capabilities`
- `capabilities` 包含 `task-execution` 类型

---

### 调用链 7: 多模态路由链

```
POST /v1/memory/multimodal/store → multimodal.store_multimodal() → get_memory()
  → engine.memory.store_multimodal(content, ...) → mem_id
```

**验证点**:

- 返回 HTTP 200
- 包含 `mem_id`
- 多模态内容成功存储

---

## 三、基线架构组件

### 3.1 核心组件清单

| 组件                  | 文件路径                                     | 职责                   |
| --------------------- | -------------------------------------------- | ---------------------- |
| AgentEngine           | `python/agent/core/engine.py`                | 主引擎，协调所有子系统 |
| LLMProvider           | `python/agent/llm/provider.py`               | LLM 调用统一接口       |
| ToolRegistry          | `python/agent/tools/registry.py`             | 工具注册与执行         |
| SessionStore          | `python/agent/persistence/session_store.py`  | 会话持久化             |
| ConversationLoop      | `python/agent/core/conversation_loop.py`     | ReAct 对话循环         |
| ContextManager        | `python/agent/core/context_pipeline.py`      | 上下文管道构建         |
| ContextCompressor     | `python/agent/core/context_compressor.py`    | 上下文压缩             |
| ThinkScrubber         | `python/agent/core/think_scrubber.py`        | 思考标签清洗           |
| SecurityGuard         | `python/agent/core/security.py`              | 安全守卫               |
| PersonaCore           | `python/agent/core/persona.py`               | 人格核心               |
| Resilience            | `python/agent/core/resilience.py`            | 重试 + 熔断器          |
| ApiGatewayMiddleware  | `python/agent/infrastructure/api_gateway.py` | API 网关               |
| CanaryReleaseManager  | `python/agent/core/canary_release.py`        | 金丝雀发布             |
| DynamicPriorityScorer | `python/agent/core/dynamic_priority.py`      | 动态优先级             |
| OTel Setup            | `python/agent/infrastructure/otel_setup.py`  | 可观测性               |
| Redis Cache           | `python/agent/memory/redis_cache.py`         | 分布式缓存             |

### 3.2 GAP 模块闭环集成

| GAP    | 模块                         | 闭环方式                                            |
| ------ | ---------------------------- | --------------------------------------------------- |
| GAP-02 | EvolutionTrigger             | engine loop 路径告警触发自动进化                    |
| GAP-03 | FewShotGeneralizer           | engine chat 路径跨任务泛化                          |
| GAP-04 | AttentionFocusAdapter        | 注册为 ContextComponent                             |
| GAP-05 | IncrementalPlanner           | engine loop 路径 needs_replan 触发重规划            |
| GAP-06 | StrategyAdapter              | engine chat/loop 路径记录 outcome，最优策略推荐闭环 |
| GAP-07 | Curator                      | engine loop 路径完成后自动策展记忆                  |
| GAP-08 | PlanQualityChecker           | engine loop 结果后自动质量检查                      |
| GAP-09 | LearningSignalCollector      | engine chat/loop 路径采集信号，弱项检测闭环         |
| GAP-10 | ReflectionApplicationManager | 与反思引擎闭环                                      |

---

## 四、测试基线

### 4.1 测试结果

| 套件                | 通过 | 失败      | 跳过 |
| ------------------- | ---- | --------- | ---- |
| Python 全套测试     | 2059 | 0         | 7    |
| TypeScript 全套测试 | 2133 | 61 (预存) | 2    |

### 4.2 基线 E2E 测试覆盖

| 调用链            | 测试函数                               | 状态 |
| ----------------- | -------------------------------------- | ---- |
| 健康检查链        | `test_chain_1_health_check`            | ✅   |
| 会话管理链        | `test_chain_2_session_management`      | ✅   |
| 核心对话链        | `test_chain_3_core_chat`               | ✅   |
| 工具调用链        | `test_chain_4_tool_invocation`         | ✅   |
| 工具调用链 (API)  | `test_chain_4_tool_invocation_via_api` | ✅   |
| MCP 路由链        | `test_chain_5_mcp_servers`             | ✅   |
| A2A 路由链        | `test_chain_6_a2a_agent_card`          | ✅   |
| A2A 路由链 (列表) | `test_chain_6_a2a_agents_list`         | ✅   |
| 多模态路由链      | `test_chain_7_multimodal_store`        | ✅   |

### 4.3 模块测试覆盖

| 模块                            | 测试文件                                            | 用例数 | 状态 |
| ------------------------------- | --------------------------------------------------- | ------ | ---- |
| Resilience（重试+熔断）         | `tests/test_resilience.py`                          | 25     | ✅   |
| ContextCompressor（注意力聚焦） | `tests/test_core_loop.py`                           | 5      | ✅   |
| ConversationLoop                | `tests/test_core_loop.py`                           | 4      | ✅   |
| ThinkScrubber                   | `tests/test_phase1_hermes.py`                       | 7      | ✅   |
| SecurityGuard                   | `tests/test_phase6.py` + `test_permission_guard.py` | 12     | ✅   |
| PersonaCore                     | `tests/test_phase6.py`                              | 6      | ✅   |
| ContextPipeline                 | `tests/test_phase6.py`                              | 7      | ✅   |
| CanaryRelease                   | `tests/test_canary_release.py`                      | 20+    | ✅   |
| DynamicPriority                 | `tests/test_api_gateway_priority.py`                | 15+    | ✅   |
| ApiGateway                      | `tests/test_api_gateway_priority.py`                | 10+    | ✅   |

---

## 五、部署基线

### 5.1 环境变量

| 变量                          | 默认值           | 说明                 |
| ----------------------------- | ---------------- | -------------------- |
| `AGENT_BACKEND`               | `python`         | Agent 后端选择       |
| `REDIS_ENABLED`               | `false`          | Redis 缓存开关       |
| `REDIS_HOST`                  | `localhost`      | Redis 主机           |
| `REDIS_PORT`                  | `6379`           | Redis 端口           |
| `OTEL_ENABLED`                | `false`          | OpenTelemetry 开关   |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `localhost:4317` | OTel 导出端点        |
| `RATE_LIMIT_CAPACITY`         | `0`              | 限流桶容量（0=禁用） |
| `RATE_LIMIT_REFILL`           | `10`             | 限流桶补充速率       |

### 5.2 K8s 部署配置

| 文件                                         | 用途                                   |
| -------------------------------------------- | -------------------------------------- |
| `deploy/kubernetes/namespace-and-redis.yaml` | Namespace + ConfigMap + Secret + Redis |
| `deploy/kubernetes/deployment.yaml`          | 应用 Deployment                        |
| `deploy/kubernetes/service.yaml`             | Service 定义                           |
| `deploy/kubernetes/ingress.yaml`             | Ingress 规则                           |
| `deploy/kubernetes/hpa.yaml`                 | HPA 自动扩缩容                         |

---

## 六、基线维护规则

1. **任何核心调用链变更必须更新基线测试**
2. **基线测试 100% 通过才允许合并**
3. **新增核心调用链必须补充到本文档**
4. **每次发布前验证基线完整性**

---

**文档版本**: v1.1
**建立日期**: 2026-07-05
**维护者**: 开发团队
