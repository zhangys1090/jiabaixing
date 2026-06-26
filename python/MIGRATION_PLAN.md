# 家百星 V5.0 混合架构迁移计划

> 版本: 2.4
> 日期: 2026-06-23
> Python 版本: 3.13
> 状态: Phase 0-9 全部完成 ✅ | P1-P4 全部完成 ✅ | 1123 测试通过 ✅

---

## 一、迁移目标

将核心 Agent 逻辑从 TypeScript 迁移到 Python，利用 Python AI 生态（litellm / langchain / chromadb / jieba / sentence-transformers / scikit-learn），同时保留 TypeScript 的 IDE 集成/桌面自动化/前端能力。

**架构原则**：

- `AGENT_BACKEND` 环境变量控制后端选择（`local` | `python`）
- 默认 `local`，确保迁移过程零停机
- 每个 Phase 独立可验证，可随时回退

---

## 二、模块归属

### 留 TypeScript（~220 文件）

| 模块                                  | 理由                  |
| ------------------------------------- | --------------------- |
| React Frontend + Electron             | 前端展示              |
| Express + WebSocket 服务              | HTTP/WS 入口          |
| CLI/REPL                              | 命令行交互            |
| ACPServer + ACPActivityTracker        | IDE 集成入口          |
| LSP Client                            | VS Code 生态          |
| DesktopAutomation (nut-js/playwright) | Node.js 原生          |
| Integration (飞书/微信)               | Node.js SDK           |
| 文件工具 / 系统工具 / 桌面工具        | Node.js 文件系统      |
| SandboxExecutor                       | Node.js child_process |
| Security审计 / MCP / Config / Plugins | Node.js 生态          |
| contracts.ts / I18nManager            | 前后端契约            |

### 迁 Python（~130 文件）

| 模块                      | 文件数 | Python 对应                    |
| ------------------------- | ------ | ------------------------------ |
| core/ (JiabaixingCore 等) | 8      | agent/core/                    |
| models/ (LLMProvider 等)  | 8      | agent/llm/ (litellm)           |
| memory/ (MemoryEngine 等) | 34     | agent/memory/ (chromadb+jieba) |
| evolution/ (V1+V2)        | 17     | agent/evolution/ (合并V1+V2)   |
| harness/loop/ (9 文件)    | 9      | agent/loop/                    |
| harness/evaluation/       | 11     | agent/evaluation/              |
| harness/orchestration/    | 5      | agent/orchestration/           |
| harness/persistence/      | 5      | agent/persistence/             |
| harness/context/ (部分)   | 2      | agent/core/                    |
| harness/constraints/      | 1      | agent/core/                    |
| harness/verification/     | 2      | agent/security/                |
| skills/SkillRegistry      | 1      | agent/skills/                  |
| cron/CronJobScheduler     | 1      | agent/scheduler/               |
| persona/                  | 2      | agent/persona/                 |
| 认知/代码/日常工具        | 20     | agent/skills/definitions/      |

---

## 三、Python Agent API 端点

```
POST   /v1/chat                    # 核心对话
WS     /v1/stream/{session_id}     # 流式对话
POST   /v1/plan                    # 规划
POST   /v1/execute                 # 执行
POST   /v1/evaluate                # 评估
POST   /v1/reflect                 # 反思
GET    /v1/memory/search           # 记忆检索
POST   /v1/memory/store            # 记忆存储
GET    /v1/memory/profile          # 用户画像
GET    /v1/memory/stats            # 记忆统计
GET    /v1/skills                  # 技能列表
POST   /v1/skills/execute          # 技能执行
POST   /v1/evolution/feedback      # 进化反馈
GET    /v1/evolution/status        # 进化状态
GET    /v1/cron/jobs               # 定时任务列表
POST   /v1/cron/jobs               # 注册定时任务
DELETE /v1/cron/jobs/{job_id}      # 删除定时任务
GET    /v1/sessions                # 会话列表
GET    /v1/sessions/{id}/messages  # 会话消息
WS     /v1/events                  # EventBus 双向同步
GET    /health                     # 健康检查
GET    /v1/status                  # Agent 状态
```

---

## 四、分阶段执行计划

### Phase 0：基础设施（1 周） ✅ 已完成

**目标**：搭建 Python 骨架 + Bridge 层，验证端到端通信

**Python 侧**：

- [x] 创建 python/ 目录结构
- [x] pyproject.toml 依赖
- [x] FastAPI 骨架 + /health
- [x] /v1/chat 最小端点（litellm）
- [x] WS /v1/stream 流式对话

**TS 侧**：

- [x] 创建 src/ide/PythonAgentBridge.ts
- [x] 修改 acpRoutes.ts 支持 AGENT_BACKEND 切换
- [x] 添加环境变量: AGENT_BACKEND, PYTHON_AGENT_URL

**验证结果**：

- Python Agent 启动成功 (http://localhost:8765)
- /health 返回 `{"status":"ok","python_version":"3.13.0"}`
- 9/9 API 测试全部通过
- TS 侧 PythonAgentBridge 编译无错误
- acpRoutes.ts 支持 `AGENT_BACKEND=python` 动态切换

---

### Phase 1：LLM 层迁移（2 周） ✅ 已完成

**目标**：LLMProvider → Python litellm

**Python 侧**：

- [x] agent/llm/provider.py (litellm 封装 + 缓存 + 队列 + 故障转移)
- [x] agent/llm/cache.py (LRU + TTL 缓存)
- [x] agent/llm/queue.py (并发控制信号量)
- [x] agent/llm/router.py (ProviderManager 多模型路由)
- [x] agent/api/llm.py (Provider 管理 API)

**验证结果**：

- 10/10 LLM 单元测试通过（缓存/队列/路由）
- 19/19 全量测试通过
- litellm 统一封装，支持 100+ 模型
- 自动故障转移到备用 Provider
- 缓存命中率可追踪

---

### Phase 2：Memory 层迁移（2 周） ✅ 已完成

**目标**：MemoryEngine → Python SQLite FTS5 + jieba

**Python 侧**：

- [x] agent/memory/engine.py (MemoryEngine 异步封装)
- [x] agent/memory/store.py (SQLite FTS5 全文检索 + jieba 分词)
- [x] agent/memory/tokenizer.py (jieba 中文分词/关键词提取)
- [x] agent/api/memory.py (搜索/存储/统计 API)

**验证结果**：

- 10/10 Memory 单元测试通过（分词/存储/搜索/统计/删除）
- 29/29 全量测试通过
- SQLite FTS5 零外部依赖，Python 内置
- jieba 中文分词准确率高
- 支持按类型过滤、相关性评分、批量删除

---

### Phase 3：Loop 层迁移（3 周） ✅ 已完成

**目标**：Planner/Executor/Evaluator/LoopController → Python

**Python 侧**：

- [x] agent/loop/types.py (数据类型定义)
- [x] agent/loop/controller.py (Plan-Execute-Evaluate 状态机)
- [x] agent/loop/planner.py (任务复杂度分析 + LLM 规划)
- [x] agent/loop/executor.py (步骤执行 + 重试逻辑)
- [x] agent/loop/evaluator.py (质量评估 + 进展追踪)
- [x] agent/loop/reporter.py (响应提取 + 质量评分)

**验证结果**：

- 13/13 Loop 单元测试通过（类型/规划/执行/评估/报告/控制器）
- 42/42 全量测试通过
- Plan-Execute-Evaluate 完整循环
- 简单任务跳过规划直接执行
- 复杂任务自动分解为步骤
- 失败步骤自动重试（最多2次）
- 评估建议重新规划（最多3次）
- AgentEngine 支持 use_loop 参数切换模式

---

### Phase 4：Evolution 层迁移（2 周） ✅ 已完成

**目标**：V1+V2 合并 → Python

**Python 侧**：

- [x] agent/evolution/types.py (进化类型定义)
- [x] agent/evolution/engine.py (V1+V2合并：反馈收集+工具权重+质量趋势+进化规划)
- [x] agent/api/evolution.py (反馈/状态/触发 API)

**验证结果**：

- 12/12 Evolution 单元测试通过
- 54/54 全量测试通过
- V1+V2 合并为单一引擎，消除重复
- 反馈信号收集 → 质量趋势追踪 → 自动进化触发
- 工具权重动态调整（成功+0.1，失败×0.8）
- 用户纠正自动生成 Prompt 示例
- 低质量自动触发 Prompt 优化
- 工具失败自动触发权重调整

---

### Phase 5：Skill + Cron + Session 迁移（2 周） ✅ 已完成

**目标**：SkillRegistry / CronJobScheduler / SessionStore → Python

**Python 侧**：

- [x] agent/skills/registry.py (技能注册/查找/搜索/执行)
- [x] agent/scheduler/cron.py (定时任务调度+注入扫描+持久化)
- [x] agent/persistence/session_store.py (会话存储+消息管理+持久化)
- [x] agent/api/skills.py (技能列表/执行 API)
- [x] agent/api/sessions.py (会话 CRUD + 消息 API)
- [x] agent/api/cron.py (任务注册/删除/切换 API)

**验证结果**：

- 22/22 Phase 5 单元测试通过（Skill 9 + Session 6 + Cron 7）
- 76/76 全量测试通过
- SkillRegistry 单例模式，支持注册/查找/搜索/分类
- 5 个内置技能自动注册
- SessionStore JSON 持久化，支持创建/消息/删除/统计
- CronJobScheduler 支持 every:Ns/m/h/d 调度格式
- 危险命令注入扫描（rm -rf /, shutdown 等）
- 任务持久化到 jobs.json

---

### Phase 6：Context + Persona + Security 迁移（2 周） ✅ 已完成

**目标**：ContextManager / PersonaCore / SecurityGuard → Python

**Python 侧**：

- [x] agent/core/context_pipeline.py (上下文管道 + Token 预算分配)
- [x] agent/core/persona.py (人格核心 + 场景语气参数)
- [x] agent/core/security.py (安全守卫 + 权限管理 + 审计日志)

**验证结果**：

- 23/23 Phase 6 单元测试通过（Context 8 + Persona 6 + Security 9）
- 99/99 全量测试通过
- TokenBudgetAllocator 6 桶分配（30/15/25/15/15/10%）
- ContextManager 可组合管道：系统提示 → 人格语气 → 动态上下文 → 记忆 → 历史
- PersonaCore 场景推断（development/work/comfort/greeting/briefing/daily）
- SecurityGuard 危险命令拦截 + 敏感信息检测 + 权限管理 + 审计日志

---

### Phase 7：工具层迁移 + 清理（2 周） ✅ 已完成

**目标**：ToolRegistry + 15 个默认工具 → Python

**Python 侧**：

- [x] agent/tools/registry.py (工具注册表 + OpenAI Function Calling 格式)
- [x] 15 个默认工具注册（Memory 3 + Cognition 3 + Code 2 + File 3 + Network 2 + System 2 + Daily 2）

**验证结果**：

- 13/13 Phase 7 单元测试通过
- 112/112 全量测试通过
- ToolRegistry 声明式注册 + Schema 验证
- to_openai_tools() 生成 Function Calling 格式
- 按分类查询工具（MEMORY/COGNITION/CODE/FILE/NETWORK/SYSTEM/DAILY）
- 工具执行统一错误处理

---

### Phase 8：集成测试 + 性能优化（2 周） ✅ 已完成

**目标**：端到端集成测试 + API 全链路验证

**Python 侧**：

- [x] tests/test_phase8_e2e.py (10 个端到端测试)

**验证结果**：

- 10/10 端到端测试通过
- 122/122 全量测试通过
- Health → LLM Providers → Memory → Skills → Sessions → Cron → Evolution 全链路验证
- Session 创建 + 消息添加 + 消息查询完整流程
- Cron 任务注册 + 列表查询
- Evolution 反馈提交 + 状态查询 + 触发进化
- 全管道集成测试（health → skills → memory → evolution → cron）

**测试矩阵**：
| 场景 | Python | 验证点 |
|------|:------:|--------|
| 基础聊天 | ✅ | 响应一致性 |
| 记忆检索 | ✅ | FTS5 结果 |
| 技能列表 | ✅ | 分类查询 |
| 会话管理 | ✅ | CRUD + 消息 |
| 定时任务 | ✅ | 注册 + 列表 |
| 进化引擎 | ✅ | 反馈 + 状态 + 触发 |
| 全链路 | ✅ | 端到端管道 |

---

## 五、时间线

```
Week 1-2:   Phase 0 — 基础设施 + Bridge
Week 3-4:   Phase 1 — LLM 层
Week 5-6:   Phase 2 — Memory 层
Week 7-9:   Phase 3 — Loop 层
Week 10-11: Phase 4 — Evolution 层
Week 12-13: Phase 5 — Skill + Cron + Session
Week 14-15: Phase 6 — Context + Persona + Security
Week 16-17: Phase 7 — 工具层 + 清理
Week 18-19: Phase 8 — 集成测试 + 优化
Week 20-22: Phase 9 — 核心闭环增强（FC Loop + 压缩 + 策展人）
```

---

### Phase 9：核心闭环增强（3 周） ✅ 已完成

**目标**：Hermes 功能清单 P0 优先级——对话循环 + 工具调用循环 + 上下文压缩 + 记忆策展

**Python 侧**：

- [x] agent/core/turn_types.py (Turn 上下文 + 迭代预算 + 工具调用/结果类型)
- [x] agent/core/conversation_loop.py (FC 循环：LLM → 工具调用 → 工具结果 → LLM → 最终响应)
- [x] agent/core/context_compressor.py (4 级压缩策略：截断 → 移除旧结果 → 摘要 → 保留最近)
- [x] agent/memory/curator.py (记忆策展：聚类整合 + 重要性提升 + 自提醒 + 洞察提取)
- [x] agent/core/engine.py (全模块集成：Conversation + Context + Persona + Security + Tools + Skills + Sessions + Curator)

**验证结果**：

- 19/19 核心闭环测试通过
- 141/141 全量测试通过
- ConversationLoop 支持 FC（Function Calling）循环
  - LLM 返回 tool_calls → 执行工具 → 结果回注 → LLM 继续生成
  - 迭代预算控制（默认 10 轮）
  - 失败自动重试（默认 3 次）
- ContextCompressor 4 级压缩策略
  - L1: 工具输出截断（>2000 字符）
  - L2: 移除旧工具结果（保留最近 3 个）
  - L3: 早期历史摘要压缩
  - L4: 仅保留最近消息
- Curator 记忆策展
  - 聚类整合（5+ 条相似记忆合并为长期记忆）
  - 重要性自动提升（含"重要/紧急/截止"等关键词）
  - 自提醒生成（扫描日程/待办/提醒）
  - 洞察提取（频繁话题统计）
- AgentEngine 全模块集成
  - 安全检查 → Context 构建 → Persona 语气 → ConversationLoop → 记忆存储 → 会话持久化 → 进化反馈

---

## 六、风险与对策

| 风险             | 对策                               |
| ---------------- | ---------------------------------- |
| Bridge HTTP 延迟 | localhost ~5ms；热路径保留 TS 本地 |
| 双进程运维       | Docker Compose / PM2 统一管理      |
| 类型不同步       | OpenAPI 自动生成 TS 类型           |
| Python 崩溃      | TS 侧 Fallback 到 local 模式       |
| 功能回归         | 每个 Phase 完成后运行完整测试      |

---

## 七、P1 功能集成（已完成 ✅）

### P1-1：凭据池 Credential Pool

- [x] agent/llm/credential_pool.py (222行)
- [x] 多 API Key 轮换策略：FILL_FIRST / ROUND_ROBIN / LEAST_USED / RANDOM
- [x] 故障自动切换 + 速率限制处理
- [x] 集成到 LLMProvider.\_resolve_api_key()

### P1-2：成本守卫 Cost Guard

- [x] 集成在 agent/llm/provider.py
- [x] 基于模型定价的 Token 用量统计
- [x] 日预算 + 单请求预算限制
- [x] 集成到 LLMProvider.\_do_chat() 的 usage 统计

### P1-3：Prompt 缓存 Prompt Caching

- [x] agent/llm/prompt_cache.py (293行)
- [x] 精确匹配 (Exact Match)
- [x] 前缀匹配 (Prefix Match)
- [x] 语义匹配 (Semantic Match)
- [x] SQLite 持久化存储
- [x] 集成到 LLMProvider.chat() 缓存逻辑

**验证结果**：

- test_p1_credential_cost.py 覆盖全部 P1 功能
- 179/179 全量测试通过

---

## 八、P2 功能集成（进行中 🟡）

### P2-1：Gateway 平台适配器 — ❌ 已取消

**决策**：Python Gateway 空壳已删除。网关功能保留在 TS 侧 `src/integration/`。

**原因**：

1. TS 侧 `MultiPlatformGateway.ts` (518行) + `IntegrationManager.ts` (618行) 功能完善
2. 微信/飞书/钉钉等平台依赖 Node.js SDK，Python 无对应 SDK
3. TS 侧已实现 Worker 模式、MCP 集成、Webhook 管理、消息队列、SSRF 防护
4. Python Gateway 空壳无真实 API 调用，send_message 只返回假 ID
5. 按迁移计划，集成层（飞书/微信/钉钉）应留在 TypeScript

**结论**：Gateway 不迁移到 Python，TS 侧 `src/integration/` 为唯一实现。

### P2-2：多传输层 Transport Layer — ✅ 已集成

- [x] agent/llm/transports.py (368行) — OpenAI/Anthropic/Gemini 适配器
- [x] TransportFactory 工厂模式 + URL 自动推断
- [x] 集成到 LLMProvider（\_resolve_transport + \_do_chat_via_transport）
- [x] Transport 缓存复用（避免重复创建）
- [x] API 端点 /v1/llm/providers/transport/info + /transport/switch
- [x] 测试覆盖（36 个测试，含单元+集成+API）
- [ ] Bedrock 适配器真实 API 验证（需 AWS 凭据）

**集成架构**：

```
LLMProvider._do_chat()
  ├─ _resolve_transport() → 检查 ProviderConfig.extra["transport"] 或 URL 自动推断
  │   ├─ Anthropic/Gemini → _do_chat_via_transport() (httpx 直发)
  │   └─ OpenAI Compatible → None → _do_chat_via_litellm() (litellm 兜底)
  └─ _do_chat_via_transport()
      ├─ transport.convert_messages() → 消息格式转换
      ├─ transport.convert_tools() → 工具格式转换
      ├─ transport.build_request() → 构建 HTTP 请求
      ├─ httpx.AsyncClient → 发送请求
      └─ transport.normalize_response() → 统一响应格式
```

---

## 九、TS 旧文件清理策略（待定 ⏳）

**当前状态**：✅ Phase A 已完成（2026-06-22）。🟡 Phase B 端到端测试已通过（208/208）。

**清理原则**：不急于删除，等 Python 后端稳定运行后再清理。

### 清理阶段

| 阶段    | 条件                            | 操作                             | 状态                    |
| ------- | ------------------------------- | -------------------------------- | ----------------------- |
| Phase A | `AGENT_BACKEND=python` 成为默认 | 标记 TS 对应模块为 `@deprecated` | ✅ 已完成               |
| Phase B | Python 后端稳定运行 2 周+       | 逐模块验证完整性                 | 🟡 测试通过，待生产验证 |
| Phase C | 确认无引用                      | 删除 TS 对应模块                 | ⏳ 待定                 |

### Phase B 端到端测试结果（2026-06-22）

**3 个入口全覆盖，29 个测试全部通过**：

| 入口       | 测试数 | 覆盖路径                                                   | 状态 |
| ---------- | ------ | ---------------------------------------------------------- | ---- |
| CLI        | 10     | REPL → HTTP /v1/chat → AgentEngine                         | ✅   |
| Gateway    | 8      | 微信/飞书/钉钉 → TS Gateway → PythonAgentBridge → /v1/chat | ✅   |
| 前端 UI    | 7      | React → TS /api/ide/chat → PythonAgentBridge → /v1/chat    | ✅   |
| 跨入口集成 | 4      | 共享记忆、会话隔离、进化反馈、全流程                       | ✅   |

**修复的 Bug**：

- `agent/api/skills.py`：`req.params` → `req.parameters`（与 SkillExecuteRequest 模型对齐）
- `agent/api/skills.py`：`SkillExecuteResponse.output` → `result`（与模型定义对齐）

### Phase A 已标记 @deprecated 的文件（2026-06-22）

**高优先级（8 个文件）**：

| TS 文件                          | Python 对应               | @deprecated |
| -------------------------------- | ------------------------- | :---------: |
| src/models/LLMProvider.ts        | agent/llm/provider.py     |     ✅      |
| src/models/LLMResponseCache.ts   | agent/llm/cache.py        |     ✅      |
| src/models/RequestQueue.ts       | agent/llm/queue.py        |     ✅      |
| src/models/ProviderManager.ts    | agent/llm/router.py       |     ✅      |
| src/models/PromptCacheManager.ts | agent/llm/prompt_cache.py |     ✅      |
| src/models/SqliteCacheStore.ts   | agent/llm/prompt_cache.py |     ✅      |
| src/memory/MemoryEngine.ts       | agent/memory/engine.py    |     ✅      |
| src/memory/ChineseTokenizer.ts   | agent/memory/tokenizer.py |     ✅      |

**中优先级（4 个文件）**：

| TS 文件                                     | Python 对应                    | @deprecated |
| ------------------------------------------- | ------------------------------ | :---------: |
| src/harness/loop/LoopController.ts          | agent/loop/controller.py       |     ✅      |
| src/evolution/EvolutionEngine.ts            | agent/evolution/engine.py      |     ✅      |
| src/harness/context/ContextManager.ts       | agent/core/context_pipeline.py |     ✅      |
| src/harness/context/TokenBudgetAllocator.ts | agent/core/context_pipeline.py |     ✅      |

### TS 侧可清理模块清单（Python 已替代，待 Phase B/C）

| TS 模块                   | 文件数 | Python 对应             | 清理优先级 |
| ------------------------- | ------ | ----------------------- | ---------- |
| src/harness/loop/\*       | 8      | agent/loop/\*           | 中         |
| src/evolution/\*          | 16     | agent/evolution/\*      | 中         |
| src/harness/evaluation/\* | 12     | agent/loop/evaluator.py | 中         |

### 不迁移到 Python 的 TS 模块（保留）

| 模块                             | 理由                            |
| -------------------------------- | ------------------------------- |
| src/integration/\* (Gateway)     | 依赖 Node.js SDK，Python 无对应 |
| src/ide/PythonAgentBridge.ts     | TS ↔ Python 通信桥              |
| src/server/routes/acpRoutes.ts   | ACP 路由 + 后端切换             |
| src/models/transports/\*         | TS 侧传输层（与 Python 侧并行） |
| src/models/MultimodalProvider.ts | 多模态功能                      |
| src/models/LlamaCppModel.ts      | 本地模型                        |
| src/models/RedisCache.ts         | Redis 缓存（Python 未实现）     |
| src/harness/tools/\*             | Node.js 文件系统工具            |
| src/harness/sandbox/\*           | 沙箱执行                        |
| src/security/\*                  | 安全审计（Node.js 生态）        |

---

## 十、优先级模块状态说明

### 🟠 P1 — 已完成 ✅

| 功能              | Python 实现                  | 状态    | 说明                                                            |
| ----------------- | ---------------------------- | ------- | --------------------------------------------------------------- |
| 凭据池 + 成本守卫 | agent/llm/credential_pool.py | ✅ 完成 | 多 API Key 轮换（FILL_FIRST/ROUND_ROBIN/RANDOM）+ 日/次预算控制 |
| Prompt 缓存       | agent/llm/prompt_cache.py    | ✅ 完成 | Anthropic 前缀缓存断点 + SQLite 持久化 + 前缀/语义匹配          |

**P1 测试覆盖**：test_p1_credential_cost.py 覆盖全部 P1 功能

### 🟡 P2 — 已完成 ✅

| 功能               | Python 实现             | 状态      | 说明                                                                            |
| ------------------ | ----------------------- | --------- | ------------------------------------------------------------------------------- |
| Gateway 平台适配器 | ❌ 已取消               | ❌ 取消   | TS 侧 src/integration/ 功能完善，依赖 Node.js SDK，Python 无需重复              |
| 多传输层 Transport | agent/llm/transports.py | ✅ 已集成 | OpenAI/Anthropic/Gemini 适配器 + TransportFactory + LLMProvider 集成 + API 端点 |

### 🟢 P3 — 已完成 ✅

| 功能         | Python 实现                       | 状态    | 说明                                     |
| ------------ | --------------------------------- | ------- | ---------------------------------------- |
| LSP 集成     | agent/lsp/ (5 文件)               | ✅ 完成 | 语言服务器协议，代码补全/诊断/跳转/符号  |
| MCP 客户端   | agent/mcp/server_manager.py       | ✅ 完成 | Model Context Protocol，工具调用标准     |
| 浏览器自动化 | agent/tools/browser_automation.py | ✅ 完成 | CDP + Browserbase + Playwright，网页操作 |

**P3 验证结果**：

- LSP: LspClientManager + LspTransport + LspCompletionProvider + LspDiagnosticsProvider + 完整类型定义
- MCP: MCPServerManager + MCPServerConfig + 进程管理 + 工具过滤
- 浏览器自动化: BrowserAutomation + 多后端支持（LOCAL/CDP/BROWSERBASE/BROWSER_USE）

### 🟢 P4 — 已完成 ✅

| 功能                     | TS 源文件                                              | Python 状态 | 说明                                 |
| ------------------------ | ------------------------------------------------------ | ----------- | ------------------------------------ |
| ContextFileRegistry      | src/harness/context/ContextFileRegistry.ts (342L)      | ✅ 完成     | agent/core/context_pipeline.py       |
| ContextReferenceResolver | src/harness/context/ContextReferenceResolver.ts (286L) | ✅ 完成     | agent/core/context_pipeline.py       |
| ContextWindowManager     | src/harness/context/ContextWindowManager.ts (423L)     | ✅ 完成     | agent/core/context_compressor.py     |
| HookManager              | src/harness/hooks/HookManager.ts (244L)                | ✅ 完成     | agent/core/hooks.py                  |
| FeedbackLoops            | src/harness/loops/FeedbackLoops.ts (246L)              | ✅ 完成     | agent/loop/feedback_loops.py         |
| AgentRegistry            | src/harness/orchestration/AgentRegistry.ts (841L)      | ✅ 完成     | agent/orchestration/agent_factory.py |
| OrchestratorAgent        | src/harness/orchestration/OrchestratorAgent.ts (749L)  | ✅ 完成     | agent/orchestration/agent_factory.py |
| SubAgentFanout           | src/harness/orchestration/SubAgentFanout.ts (343L)     | ✅ 完成     | agent/orchestration/fanout.py        |

### 优先级与归属对照表

| 优先级 | 功能                     | 归属层     | Python    | TS           |
| ------ | ------------------------ | ---------- | --------- | ------------ |
| 🟠 P1  | 凭据池 + 成本守卫        | Agent 核心 | ✅ 实现   | @deprecated  |
| 🟠 P1  | Prompt 缓存              | Agent 核心 | ✅ 实现   | @deprecated  |
| 🟡 P2  | 多传输层                 | Agent 核心 | ✅ 已集成 | 保留（并行） |
| 🟡 P2  | Gateway 平台适配器       | 集成层     | ❌ 取消   | ✅ 唯一实现  |
| 🟢 P3  | LSP 集成                 | IDE 集成   | ✅ 完成   | 保留         |
| 🟢 P3  | MCP 客户端               | 工具层     | ✅ 完成   | 保留         |
| 🟢 P3  | 浏览器自动化             | 工具层     | ✅ 完成   | 保留         |
| 🟢 P4  | ContextFileRegistry      | Agent 核心 | ✅ 完成   | @deprecated  |
| 🟢 P4  | ContextReferenceResolver | Agent 核心 | ✅ 完成   | @deprecated  |
| 🟢 P4  | ContextWindowManager     | Agent 核心 | ✅ 完成   | @deprecated  |
| 🟢 P4  | HookManager              | Agent 核心 | ✅ 完成   | @deprecated  |
| 🟢 P4  | FeedbackLoops            | Agent 核心 | ✅ 完成   | @deprecated  |
| 🟢 P4  | AgentRegistry            | Agent 核心 | ✅ 完成   | @deprecated  |
| 🟢 P4  | OrchestratorAgent        | Agent 核心 | ✅ 完成   | @deprecated  |
| 🟢 P4  | SubAgentFanout           | Agent 核心 | ✅ 完成   | @deprecated  |

---

## 十一、代码统计

| 指标                | 数量            |
| ------------------- | --------------- |
| Python agent 文件数 | 126             |
| Python agent 代码行 | ~13,000         |
| Python 测试文件数   | 14              |
| Python 测试代码行   | 2,100           |
| 全量测试            | 1,123 passed ✅ |
| TS 源文件数         | 487             |
| TS 代码行           | 131,866         |
| P4 待迁移模块       | 0 个 ✅         |
