# Jiabaixing V5.0 — 开发者指南

## 目录

1. [快速开始](#1-快速开始)
2. [架构概览](#2-架构概览)
3. [模块参考](#3-模块参考)
4. [API 参考](#4-api-参考)
5. [工具系统](#5-工具系统)
6. [事件系统](#6-事件系统)
7. [配置参考](#7-配置参考)
8. [开发指南](#8-开发指南)
9. [故障排查](#9-故障排查)

---

## 1. 快速开始

### 环境要求

- Node.js >= 20.x
- Windows 10+（主平台；Linux/macOS 部分支持）
- 至少一个 LLM 提供商 API Key

### 安装

```bash
npm install
npm run fix:native      # 重编译 better-sqlite3
```

### 配置 LLM

编辑 `.env` 或 `data/providers.json`：

```bash
# .env
DEEPSEEK_API_KEY=sk-你的key
LLM_MODEL=deepseek-chat
OPENAI_API_BASE=https://api.deepseek.com
```

或使用 providers.json（优先级更高）：

```json
{
  "providers": [
    { "name": "deepseek", "baseUrl": "https://api.deepseek.com", "apiKey": "sk-...", "model": "deepseek-chat", "enabled": true, "priority": 0 }
  ],
  "primary": "deepseek"
}
```

### 启动

```bash
npm run start           # 后端 + 前端
npm run cli             # CLI 交互模式
npm run daemon          # 后台守护模式
```

### 验证

```bash
curl http://localhost:3111/api/health   # 健康检查
npm test                                 # 运行测试
```

---

## 2. 架构概览

### 核心理念

```
Agent = (LLM 推理 + 能力组件) × Harness 六层控制
```

LLM 负责认知（推理、工具选择、表达）。Harness 负责工程（预算、权限、验证、状态）。

### 架构图

```
用户输入
    │
    ▼
┌──────────────────────────────────────────┐
│  网关层 (Express HTTP / WebSocket / CLI)  │
└──────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────┐
│  JiabaixingCore (src/core/)              │
│  · PersonaCore (人格/语气)               │
│  · ConversationHistoryManager            │
│  · MemoryAssistant                       │
│  · FeedbackCollector                     │
│  · EvolutionOrchestrator                 │
└──────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────┐
│  AgentHarness (src/harness/)             │
│  ┌────────────────────────────────────┐  │
│  │  E - 执行循环 (LoopController)     │  │
│  │  Planner → Executor → Evaluator    │  │
│  │  → Reporter (状态机 + 重规划)      │  │
│  ├────────────────────────────────────┤  │
│  │  T - 工具注册表 (36工具, 8类别)    │  │
│  │  SchemaValidator + PermissionGuard │  │
│  ├────────────────────────────────────┤  │
│  │  C - 上下文管理器                  │  │
│  │  宪法Prompt → 记忆 → 动态 → 历史  │  │
│  ├────────────────────────────────────┤  │
│  │  S - 状态存储 (SQLite / ChromaDB)  │  │
│  ├────────────────────────────────────┤  │
│  │  L - 生命周期钩子 (9个钩子)        │  │
│  ├────────────────────────────────────┤  │
│  │  V - 验证层                        │  │
│  │  输出安全 + 结果验证 + 质量评分    │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
    │                    │
    ▼                    ▼
┌────────────┐  ┌────────────────┐
│ MemoryEngine│  │EvolutionEngineV2│
│ 三层记忆    │  │ LLM自我进化    │
│ SQLite+Chroma│  │ 计划→修改→验证 │
└────────────┘  └────────────────┘
```

### 六层 Harness (E-T-C-S-L-V)

| 层 | 名称 | 职责 | 关键文件 |
|----|------|------|---------|
| **E** | 执行循环 | Plan-Execute-Evaluate-Report 状态机 | `src/harness/loop/LoopController.ts` |
| **T** | 工具注册表 | 36 个声明式工具，8 类别，JSON Schema + 4 级权限 | `src/harness/tools/registry/ToolRegistry.ts` |
| **C** | 上下文管理器 | 宪法 prompt → 记忆 → 动态上下文 → 历史 | `src/harness/context/ContextManager.ts` |
| **S** | 状态存储 | 瞬时(LoopContext) / 短期(SQLite) / 长期(ChromaDB) | `src/harness/persistence/PersistenceService.ts` |
| **L** | 生命周期钩子 | 9 个钩子: before_loop 到 after_response | `src/harness/constraints/ConstraintsService.ts` |
| **V** | 验证层 | 输出安全 + 结果验证 + 5 维质量评分 | `src/harness/verification/VerificationService.ts` |

### 请求流

```
网关 → JiabaixingCore.processInput()
  → AgentHarness.processInput()
    → ContextManager.buildContext()           [层 C]
    → ConstraintsService.executeHooks(BEFORE_LOOP)  [层 L]
    → LoopController.run()
      → Planner.plan()                       [层 E]
      → Executor.execute()                   [层 E + T]
        → ToolCallGuard.check()              [去重+缓存+限速]
        → ToolRegistry.execute()
        → SchemaValidator.validate()
        → PermissionGuard.check()
      → Evaluator.evaluate()                 [层 E + V]
      → Reporter.report()                    [层 E]
    → ConstraintsService.executeHooks(AFTER_RESPONSE) [层 L]
    → PersistenceService.record()            [层 S]
    → EventBus.emit('response_ready')
```

---

## 3. 模块参考

### 3.1 核心模块 (`src/core/`)

| 文件 | 职责 |
|------|------|
| `JiabaixingCore.ts` | 主引擎，所有用户输入的入口 |
| `ConstitutionPromptBuilder.ts` | 构建系统 prompt（人格+记忆+进化） |
| `ConversationHistoryManager.ts` | 对话历史管理，防抖持久化 |
| `MemoryAssistant.ts` | 自动从对话中提取知识 |
| `OptimizationScheduler.ts` | 24 小时自动优化调度 |
| `ScenarioAwareScheduler.ts` | 场景感知任务调度（环境感知+Git 感知） |
| `TaskComplexityAnalyzer.ts` | 任务复杂度分析 |
| `DAGTask.ts` | 有向无环图任务模型 |
| `DynamicTaskAdjuster.ts` | 动态任务优先级调整 |

### 3.2 Harness 模块 (`src/harness/`)

| 文件 | 职责 |
|------|------|
| `AgentHarness.ts` | 六层组装点 |
| `types.ts` | 所有类型定义 (650 行) |
| `deps.ts` | 依赖注入接口 |
| `loop/LoopController.ts` | E 层：状态机 |
| `loop/Planner.ts` | 任务规划（正则快跳 + LLM 分解 + 研究模式） |
| `loop/Executor.ts` | 工具执行 FC 循环（含去重守卫+意图过滤） |
| `loop/Evaluator.ts` | 步骤评估（规则 + 可选 LLM） |
| `loop/Reporter.ts` | 响应提取 + 5 维质量评分 |
| `tools/registry/ToolRegistry.ts` | 工具注册和执行 |
| `tools/registry/ToolCallGuard.ts` | 工具调用守卫（去重+缓存+限速） |
| `tools/registry/SchemaValidator.ts` | JSON Schema 验证 |
| `tools/registry/PermissionGuard.ts` | 4 级权限检查 |
| `context/ContextManager.ts` | 上下文构建管道 |
| `persistence/PersistenceService.ts` | 状态持久化 |
| `persistence/TrajectoryDatabase.ts` | 执行轨迹存储 |
| `verification/VerificationService.ts` | 输出安全和质量 |
| `constraints/ConstraintsService.ts` | 生命周期钩子和预算 |
| `sandbox/SandboxExecutor.ts` | 沙箱执行 |
| `orchestration/OrchestratorAgent.ts` | 多 Agent 编排 |

### 3.3 记忆模块 (`src/memory/`)

| 层 | 存储 | 生命周期 | 用途 |
|----|------|---------|------|
| 瞬时 | 内存数组 | 1 小时 | 请求级上下文 |
| 短期 | SQLite | 会话 | 对话、工具结果 |
| 长期 | ChromaDB(向量) | 永久 | 知识提取、语义搜索 |

关键文件：
- `MemoryEngine.ts` — 主记忆引擎
- `MemoryRetriever.ts` — 混合检索（RRF 融合）
- `KnowledgeGraphBuilder.ts` — 知识图谱
- `ConversationCompressor.ts` — 对话压缩

### 3.4 进化模块 (`src/evolution/`)

| 文件 | 职责 |
|------|------|
| `EvolutionEngine.ts` | V1 进化引擎（学习+PromptExample 生成+工具权重） |
| `EvolutionOrchestrator.ts` | 统一编排器 |
| `FeedbackCollector.ts` | 反馈信号收集（纠正检测+重复提问+工具失败） |
| `v2/EvolutionEngineV2.ts` | V2 LLM 驱动自我进化 |
| `v2/SelfModificationEngine.ts` | 执行文件修改 |
| `v2/EvolutionRollback.ts` | 快照 + 回滚 |

**进化闭环**：
```
交互完成 → EvolutionEngine.collectFeedback()
  → 提取学习模式 → 生成 PromptExample
  → 计算工具权重 → 持久化到磁盘

Planner.plan() 时:
  → getPromptExamples() → 注入规划 prompt

每 5 分钟:
  → getToolWeights() → applyEvolutionWeights() → 影响工具排序
```

### 3.5 集成模块 (`src/integration/`)

支持平台：微信（QR+API）、QQ（Mirai）、飞书、钉钉

架构：双模式 — fork 子进程（隔离）+ 主进程内联（降级）

### 3.6 安全模块 (`src/security/`)

4 核心模块 + 8 原子模块：
- SecurityFacade: SecurityManager + AuthenticationManager + EncryptionManager
- SecurityCore: SecurityPolicyEngine + SecurityGuard + NetworkGuard
- AuditService: AuditLogger + DataSovereigntyPipeline

### 3.7 模型模块 (`src/models/`)

- `LLMProvider.ts` — 单提供商包装
- `ProviderManager.ts` — 多提供商管理+路由
- 路由逻辑：简单任务(< 200 字) → 本地，复杂任务 → 主提供商
- 自动故障转移：主 → 次 → 本地
- 熔断器：3+ 次失败标记不健康

---

## 4. API 参考

### 核心端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| POST | `/api/process` | 文本/图片处理 |
| POST | `/api/chat` | 聊天接口 |

### 模型端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/models` | 列出可用模型 |
| GET | `/api/models/status` | 当前模型状态 |
| POST | `/api/models/switch` | 切换模型 |

### 记忆端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/memory/store` | 存储记忆 |
| GET | `/api/memory/search` | 搜索记忆 |
| GET | `/api/memory/profile` | 用户画像 |

### 进化端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/evolution/metrics` | 进化指标 |
| GET | `/api/evolution/insights` | 学习洞察 |
| POST | `/api/evolution/trigger` | 手动触发优化 |

### WebSocket 事件

连接 `ws://localhost:3111`：

| 事件 | 说明 |
|------|------|
| `agent_execution_update` | 执行进度更新 |
| `response_ready` | 响应就绪 |
| `tool_trace` | 工具调用追踪 |
| `stream_start/chunk/done` | 流式响应 |
| `proactive_message` | 主动消息 |

---

## 5. 工具系统

### 工具类别（36 个工具，8 类别）

| 类别 | 工具数 | 工具 |
|------|--------|------|
| 记忆 | 3 | memory_recall, memory_store, memory_search |
| 认知 | 3 | emotion_detect, analyze_scene, self_reflect |
| 桌面 | 2 | desktop_automate, desktop_screenshot |
| 文件 | 7 | file_read, file_list, file_search, file_grep, get_active_file, incremental_edit, multi_file_edit |
| 代码 | 3 | code_analyze, code_fix, code_generate |
| 日常 | 9 | task_manage, task_priority, task_dependency, batch_task, task_analytics, calendar, reminder_set, note_take, system_status |
| 网络 | 5 | web_search, web_fetch, skill_create, image_generate, tts_speak |
| 系统 | 4 | ask_clarification, preview_execution, rollback_changes, shell_exec |

### 添加新工具

1. 创建 `src/harness/tools/<类别>/my_tool.ts`
2. 定义 `ToolDefinition` + `createExecutor` 工厂函数
3. 在 `registerHarnessTools.ts` 中注册
4. 运行测试 `npm test`

### 工具调用守卫 (ToolCallGuard)

- **去重**：30 秒内相同工具+参数 → 返回缓存结果
- **缓存**：5 分钟 TTL，避免重复网络请求
- **限速**：同一工具每轮最多 2 次
- **意图过滤**：根据用户输入自动过滤相关工具子集

---

## 6. 事件系统

EventBus 是单例 EventEmitter，支持：
- SQLite 持久化（选定事件）
- 批量持久化（100ms 间隔，每批最多 50 条）
- 追踪跟踪（start/complete/fail）
- 重启后事件恢复

### 事件类别

- **核心**: user_input, task_completed, response_ready, stream_*
- **调度**: scheduler_started, environment_update, project_change, git_status
- **主动**: proactive_schedule, proactive_briefing, proactive_reminder
- **记忆**: memory_stored, memory_context_ready, memory_update
- **进化**: evolution_started, evolution_update, weight_update
- **执行**: agent_execution_update, tool_trace
- **集成**: integration_connected, integration_message

---

## 7. 配置参考

### 环境变量 (.env)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3111 | 服务端口 |
| `LLM_MODEL` | deepseek-chat | 主 LLM 模型 |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key |
| `OPENAI_API_BASE` | https://api.deepseek.com | OpenAI 兼容基础 URL |
| `TAVILY_API_KEY` | — | Tavily 搜索 API Key |
| `ENABLE_AUTO_OPTIMIZE` | true | 启用自动优化 |
| `HARNESS_LOOP` | true | 启用执行循环层 |
| `HARNESS_TOOLS` | true | 启用工具层 |
| `HARNESS_CONTEXT` | true | 启用上下文层 |
| `LOG_LEVEL` | info | 日志级别 |

### 提供商配置 (data/providers.json)

```json
{
  "providers": [
    { "name": "deepseek", "baseUrl": "https://api.deepseek.com", "apiKey": "sk-...", "model": "deepseek-chat", "enabled": true, "priority": 0 }
  ],
  "primary": "deepseek",
  "routingEnabled": true,
  "routing": {
    "simpleTaskProviders": ["local"],
    "complexTaskProviders": ["deepseek"],
    "simpleTaskMaxLength": 200
  }
}
```

---

## 8. 开发指南

### 项目结构

```
jiabaixing/
  src/
    core/           — 核心引擎
    harness/        — V5.0 六层 Harness
    evolution/      — 进化引擎
    memory/         — 三层记忆系统
    security/       — 安全模块
    models/         — LLM 提供商
    persona/        — 人格系统
    server/         — Express + WebSocket
    integration/    — 多平台网关
    frontend/       — React 前端
    shared/         — EventBus, 事件类型
    main.ts         — 入口
    cli.ts          — CLI 入口
  data/
    providers.json  — LLM 配置
    trajectory/     — 执行轨迹
    evolution/      — 进化状态
  tests/
    harness/        — Harness 测试
    unit/           — 单元测试
    integration/    — 集成测试
```

### 初始化序列 (main.ts)

1. 日志初始化
2. 安全和加密
3. 数据库（SQLite, ChromaDB）
4. 情感、语音、环境感知
5. 工具注册
6. 模型初始化
7. 核心引擎 (JiabaixingCore)
8. 交互引擎 (AgentHarness 注入)
9. 学习循环（热监视、自动优化）
10. 场景感知调度器

### 测试

```bash
npm test                    # 全量测试
npm run test:coverage       # 带覆盖率
npm run eval                # 评估套件（30 个 golden case）
```

### 代码风格

- TypeScript ES2022, CommonJS 模块
- ESLint + Prettier 强制
- 中文注释（项目语言约定）
- 依赖注入 via 接口
- EventBus 跨模块通信
- Logger 带 traceId 关联

---

## 9. 故障排查

### 常见问题

**better-sqlite3 编译失败**：
```bash
npm run fix:native
npm rebuild better-sqlite3
```

**端口 3111 被占用**：
系统自动尝试释放。不行则 `.env` 中设置 `PORT=3112`。

**LLM 不可用**：
```bash
# 检查 providers.json 中的 API Key
# 系统会自动降级：主 → 次 → 本地
```

**TypeScript 编译错误**：
```bash
npx tsc --noEmit    # 检查类型错误
```

**前端连不上后端**：
- 确认后端在 3111 端口运行
- 检查 WebSocket: `ws://localhost:3111`
- 检查 `.env` 中 `CORS_ORIGIN`

### 日志文件

| 文件 | 内容 |
|------|------|
| `logs/app.log` | 应用日志 |
| `logs/error.log` | 错误日志 |
| `data/trajectory/trajectory.db` | 执行轨迹 |
| `data/event_bus.db` | 事件持久化 |
| `data/evolution/engine-state.json` | 进化状态 |
