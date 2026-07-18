# 家百星 V5.0 架构全景 & 重复分析

> 生成日期: 2026-06-16（本节后续由 2026-07-15 架构演进补充）
> 源码: TypeScript 薄网关 (~350 .ts) + Python FastAPI 后端 (~300 .py)
> 架构范式: **混合架构** — TS 网关 (:3111) 负责 HTTP/WS/前端编排，`AGENT_BACKEND=python` 时真实 Agent 逻辑在 Python 后端 (:3112)

> ⚠️ **架构现状速览 (2026-07-15)**
> 本文原始版本以"TS 中心"视角撰写。经 2026-07 多次枢纽迁移，**MCP / 记忆 / LLM 三大核心枢纽的 TS 实现已收口为 bridge 壳**（re-export + `@deprecated` + 经 `bridgeRegistry` 代理 `python/agent/api/*`），真实逻辑全部位于 Python 端。循环层（LoopController/Planner/Executor/Evaluator/Reporter）亦已迁 Python。此外，AGENTS.md §0.1 模块归属表中的 **会话持久化 (SessionStore)、轨迹持久化 (TrajectoryDatabase)、OpenTelemetry SDK** 三项 TS 独立实现亦已收口为桥接回退壳 / traceId 透传壳。文档派生审计探针 `scripts/doc-derived-audit.mjs` 当前 **37 PASS / 0 FAIL**（见 §1.6）。

---

## 一、项目节点与功能全景

### 1.1 入口点

| 入口        | 路径                               | 职责                                       |
| ----------- | ---------------------------------- | ------------------------------------------ |
| 服务端      | `src/main.ts`                      | Express + WebSocket，端口 3111             |
| Python 后端 | `python/`（FastAPI）               | 端口 3112，`AGENT_BACKEND=python` 启用     |
| CLI         | `src/cli.ts`                       | REPL / pipe / subcommand / daemon 四种模式 |
| 工作线程    | `src/integration/gatewayWorker.ts` | 消息网关的独立线程                         |

### 1.2 六层 Harness 架构

```
用户输入 → JiabaixingCore.processInput()
  → ContextManager.buildContext()              [C层 - Context]
      → ContextReferenceResolver.resolve()     [@引用解析]
  → HookManager.execute('before_execute')      [L层 - Hooks 统一入口]
      → ConstraintsService.executeHooks()      [L层 - 委托 HookManager]
  → LoopController.run()                        [循环层已迁 Python: python/agent/loop/controller.py]
      → Planner.plan()                          [E层 - Plan]
      → Executor.execute() → ToolRegistry       [E+T层 - Execute]
          → delegate_task → BatchProcessor       [批量并发委托]
      → Evaluator.evaluate()                    [E+V层 - Evaluate]
      → Reporter.report()                       [E层 - Report]
  → PersistenceService.record()                [S层 - Persistence]
      → CheckpointService.snapshot()            [工作目录快照]
  → EventBus.emit('response_ready')
```

### 1.3 完整模块地图

```
src/
├── main.ts / cli.ts                     ← 入口
│
├── core/ (13 文件)                      ← 中央编排
│   ├── JiabaixingCore.ts               ← 核心引擎
│   ├── ConstitutionPromptBuilder.ts     ← 宪法提示词
│   ├── ConversationHistoryManager.ts    ← 对话历史
│   ├── UnifiedContextPipeline.ts        ← 上下文管道
│   ├── ScenarioAwareScheduler.ts        ← 场景调度
│   ├── DAGTask.ts                       ← 有向无环图任务
│   └── ...
│
├── harness/ (110+ 文件)                 ← 六层管控 (E-T-C-S-L-V)
│   ├── AgentHarness.ts                  ← 总控 (TS 侧仅编排/调度; 循环逻辑在 Python)
│   ├── loop/ (仅 AutonomousTrigger.ts) ← Loop 层已迁 Python (python/agent/loop/controller.py)
│   ├── tools/ (50+ 文件)               ← 工具层
│   │   ├── registry/ (6 文件)           ← 注册/权限/校验/MCP桥
│   │   └── {code,cognition,daily,desktop,file,
│   │         memory,network,system}/     ← 8 类工具
│   ├── context/ (4 文件)               ← 上下文层
│   │   ├── ContextManager.ts            ← 上下文构建主入口
│   │   ├── ContextReferenceResolver.ts  ← @引用解析器 ✨新增
│   │   ├── ContextFileRegistry.ts       ← 项目文件发现
│   │   └── TokenBudgetAllocator.ts      ← Token预算分配
│   ├── persistence/ (4 文件)           ← 持久化层
│   │   ├── PersistenceService.ts        ← 主持久化服务
│   │   ├── TrajectoryDatabase.ts        ← 轨迹数据库
│   │   └── TrajectoryQueryService.ts    ← 轨迹查询
│   ├── verification/                    ← 验证层
│   ├── constraints/                     ← 约束层 (委托 HookManager)
│   ├── evaluation/ (11 文件)           ← 评估子系统
│   ├── orchestration/ (5 文件)         ← 多Agent编排
│   ├── hooks/ HookManager.ts           ← 统一生命周期钩子 ✨新增
│   ├── batch/ BatchProcessor.ts        ← 并行批处理 ✨新增
│   └── sandbox/ SandboxExecutor.ts     ← 沙箱
│
├── memory/ (34 文件)                    ← 记忆系统 (TS 侧为桥接壳, 真实逻辑在 Python)
│   ├── MemoryEngine.ts                 ← 三层记忆引擎 (bridge 壳 → Python python/agent/memory/engine.py)
│   ├── MemoryEngineBridge.ts           ← MemoryEngine 的 Python 桥接实现
│   ├── KnowledgeGraphBuilder.ts         ← 知识图谱 (类型/契约, 逻辑在 Python)
│   ├── {ShortTerm,LongTerm}Memory.ts   ← @deprecated 类型契约 (仅 type 使用)
│   ├── VectorDatabase*.ts               ← @deprecated 向量桥接壳 (存储已迁 Python)
│   ├── external/ (3 文件)              ← 外部记忆适配器 ✨扩展
│   │   ├── ExternalMemoryProvider.ts    ← 外部记忆抽象基类
│   │   ├── LocalMemoryStore.ts          ← 本地存储
│   │   └── MemoryFileProvider.ts        ← 记忆文件
│   └── ...
│
├── models/ (14 文件)                    ← LLM 模型层 (TS 侧为桥接壳, 真实调用在 Python)
│   ├── LLMProvider.ts                   ← 主 LLM 接口 (bridge 壳 → Python python/agent/api/llm.py)
│   ├── LLMProviderBridge.ts             ← LLMProvider 的 Python 桥接实现
│   ├── MultiModelLLMProvider.ts         ← 多模型路由 (bridge 壳 + 本地回退)
│   ├── MultiModelLLMProviderBridge.ts   ← 本地多模型路由实现 (离线回退)
│   ├── ProviderManager.ts               ← 提供商管理
│   ├── OpenAICompatibleModel.ts          ← OpenAI 适配器
│   ├── LLMResponseCache.ts              ← 仅存的 TS 缓存（其余已迁 python/agent/llm）
│   └── ...
│
├── server/ (55+ 文件)                  ← HTTP/WS 服务
│   ├── bootstrap.ts                    ← 启动编排
│   ├── routes/ (24 路由)
│   │   ├── openaiCompatibleRoutes.ts   ← /v1/chat/completions ✨新增
│   │   ├── ideRoutes.ts                ← IDE 集成路由 ✨新增
│   │   ├── batchRoutes.ts              ← 批处理路由 ✨新增
│   │   └── ... (20+ 其他路由)
│   └── websocket/ (5+ 文件)
│
├── plugins/ (2 文件)                   ← 插件系统 ✨新增
│   ├── PluginInterface.ts              ← 插件接口定义
│   └── PluginContext.ts                ← 插件上下文
│
├── ide/ (1 文件)                       ← IDE 集成 ✨新增
│   └── ACPServer.ts                    ← Agent Communication Protocol
│
├── security/ (12 文件)                 ← 安全
├── evolution/ (17 文件)               ← 进化引擎 (V1+V2)
├── desktop/ (17 文件)                 ← 桌面自动化
├── integration/ (15 文件)             ← 即时通讯适配器
├── interaction/ (5 文件)              ← 交互引擎
├── multimodal/ (5 文件)               ← 多模态
│   └── ...
├── cli/ (29 文件)                     ← CLI 子系统
│   └── ...
├── training/ (1 文件)                 ← RL 训练 ✨新增
│   └── TrajectoryExporter.ts           ← RL 训练轨迹导出
├── config/ llm/ skills/
├── curator/ persona/ user/
├── mcp/ monitoring/ daemon/
└── shared/ utils/ types/
```

### 1.4 与 Hermes Agent 架构对比

| 维度     | Hermes Agent                                                              | 家百星                                        |
| -------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| 语言     | Python 3.10+                                                              | TypeScript 6.0                                |
| 核心循环 | `AIAgent._run()` ~6000行                                                  | `AgentHarness` 6层分离                        |
| 工具注册 | 自注册 (import时调 `registry.register()`) + AST 发现                      | 集中注册 `registerHarnessTools.ts`            |
| 工具集   | `toolsets.py` 递归组合                                                    | 8 类目录硬编码                                |
| 记忆     | 4层 (L1-L4) + 冻结快照                                                    | 3层 (instant/STM/LTM) + 向量 + 外部记忆 ✅    |
| 技能     | agentskills.io 渐进式披露 3级                                             | SkillRegistry + Curator + 渐进披露 ✅         |
| 插件     | 3 种类型 + PluginManager/load_plugin ✅ (python/agent/plugins/manager.py) | 已迁移至 Python                               |
| 子Agent  | 单进程多线程 max_workers=3                                                | SubAgentFanout (parallel/sequential/adaptive) |
| 钩子     | 插件钩子 + 网关钩子 + shell钩子                                           | HookManager (统一) ✅                         |
| 提供商   | 统一 Provider 抽象                                                        | 分散 (LLM/TTS/记忆各自)                       |

### 1.5 功能对齐状态 (家百星 vs Hermes)

| 功能              | 状态 | 实现组件                                                               |
| ----------------- | ---- | ---------------------------------------------------------------------- |
| 上下文引用(@引用) | ✅   | `ContextReferenceResolver`                                             |
| 子Agent委派       | ✅   | `delegate_task` + `BatchProcessor`                                     |
| 代码沙箱          | ✅   | `SandboxExecutor`                                                      |
| Hook系统          | ✅   | `HookManager` (统一，ConstraintsService 委托)                          |
| 批处理            | ✅   | `BatchProcessor`                                                       |
| 技能渐进披露      | ✅   | `SkillRegistry` + `Curator`                                            |
| 检查点增强        | ✅   | Python `python/agent/persistence/checkpoint.py` (CheckpointService)    |
| 浏览器自动化      | ✅   | `desktop/` 模块                                                        |
| 图像生成          | ✅   | 工具层 image_gen                                                       |
| TTS多提供商       | ✅   | Python `python/agent/tools/voice_mode_tool.py`（TS 已不承载 TTS 注册） |
| Prompt缓存        | ✅   | Python `python/agent/llm/prompt_cache.py`                              |
| 外部记忆          | ✅   | `ExternalMemoryProvider` (TS) + Mem0(Python `providers.py`)/本地/文件  |
| OpenAI兼容API     | ✅   | `openaiCompatibleRoutes` (/v1/chat/completions)                        |
| IDE集成ACP        | ✅   | `ACPServer`                                                            |
| 皮肤主题          | ❌   | 已移除: TS 死代码, 无 Python 等价实现 (无需求)                         |
| RL训练轨迹        | ✅   | `TrajectoryExporter`                                                   |
| 凭证池            | ✅   | `ProviderManager` 凭证轮换                                             |
| 全双工语音        | ✅   | Python `python/agent/tools/voice_mode_tool.py` (VoiceModeManager)      |
| 插件系统          | ✅   | Python `python/agent/plugins/manager.py` (PluginManager + load_plugin) |

### 1.6 枢纽迁移状态 (2026-07)

> 方法论: 把本文档与 AGENTS.md 的断言当规格，派生出只读探针 `scripts/doc-derived-audit.mjs`；
> 失败点 = 文档与代码不一致的真问题。下文"迁移范式"即探针驱动出的统一收口方案。

**统一迁移范式**: `git mv` 原 `class X` → `XBridge`（保留实现作为 bridge 优先 + `AGENT_BACKEND=local` 本地回退）；
原路径 `X.ts` 改为 `export { XBridge as X }` 重导出壳；类标 `@deprecated`。
探针 `findDef('X')` 因正则 `\bclass\s+X\b` 不匹配 `XBridge`（无词边界）→ 计为 `findDef===0` → **自动 PASS**，且不再检查活跃引用。
下游 `import { X }` / `new X()` 经壳零改动解析到 Bridge。

| 枢纽       | TS 原类                                                                  | 现状 (2026-07-15)                                                                                                                   | 探针断言                              | 结果 |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---- |
| **MCP**    | `MCPServerManager`                                                       | 已迁 Python (`python/agent/mcp/`)；TS 仅薄 HTTP 入口 (<300 行)                                                                      | `A-MCP`                               | ✅   |
| **记忆**   | `MemoryEngine` / `ShortTermMemory` / `LongTermMemory` / `VectorDatabase` | 桥接壳 → `python/agent/memory/engine.py` (+18 桥接方法)；子记忆类 `@deprecated`                                                     | `A-Memory-*` (4 条)                   | ✅   |
| **LLM**    | `LLMProvider` / `MultiModelLLMProvider`                                  | 桥接壳 → `python/agent/api/llm.py` (+11 桥接方法)；多模型路由保留本地回退                                                           | `A-LLM-Provider` / `A-LLM-MultiModel` | ✅   |
| 循环层     | `LoopController` / `Planner` / `Executor` / `Evaluator` / `Reporter`     | 整层迁 Python (`python/agent/loop/controller.py`)；TS 仅余 `AutonomousTrigger.ts`                                                   | `A-Loop-Controller`                   | ✅   |
| 进化       | `EvolutionEngine`                                                        | 桥接壳 → `python/agent/evolution/`                                                                                                  | `A-Evolution-Engine`                  | ✅   |
| A2A        | `A2AProtocolManager`                                                     | 无 TS 实现 (Python 网络层)                                                                                                          | `A-A2A-Manager`                       | ✅   |
| 会话持久化 | `SessionStore`                                                           | 桥接回退壳 `SessionStore.ts` → `SessionStoreBridge` (`@deprecated`)，Python 端 `python/agent/api/sessions.py`                       | `A-Persistence-Session`               | ✅   |
| 轨迹持久化 | `TrajectoryDatabase`                                                     | 桥接回退壳 `TrajectoryDatabase.ts` → `TrajectoryDatabaseBridge` (`@deprecated`)，Python 端 `python/agent/persistence/trajectory.py` | `A-Persistence-Trajectory`            | ✅   |
| 可观测性   | `initOTel` (NodeSDK)                                                     | TS 移除 `@opentelemetry/sdk-node` + `initOTel()`，改为 traceId 透传壳；SDK 由 Python `otel_setup.py` 负责                           | `A-OTel-SDK`                          | ✅   |

**验证闸门**: `node scripts/doc-derived-audit.mjs` → **37 PASS / 0 FAIL**；`npx tsc --noEmit` 仅余预存 10 个无关错误；
默认 `npm test` 受 `jest.config.js` 的 `testPathIgnorePatterns` 约束，相关套件零回归。

---

## 二、Hermes Agent 框架实现解析

### 2.1 核心设计哲学

**"工具自治，框架只做分发"** — 每个工具文件独立自注册，框架通过 AST 扫描自动发现，无需任何配置文件。

### 2.2 关键实现模式

#### 自注册工具 (Self-Registering Tools)

```python
# tools/session_search_tool.py — 在文件顶部执行
registry.register(
    name="session_search",
    toolset="session_search",
    schema=SESSION_SEARCH_SCHEMA,
    handler=lambda args, **kw: session_search(
        query=args.get("query") or "",
        db=kw.get("db"),
        current_session_id=kw.get("current_session_id"),
    ),
    check_fn=check_session_search_requirements,
)
```

注册发生在 **import 时**，框架通过 AST 解析文件确认存在 `registry.register()` 调用后才执行 import。

#### 工具集 (Toolset) 递归组合

```python
TOOLSETS = {
    "web":  {"tools": ["web_search", "web_extract"], "includes": []},
    "safe": {"tools": [], "includes": ["web", "vision", "image_gen"]},
}
```

双重过滤：工具集白/黑名单 (粗粒度) + `check_fn` (细粒度运行时可用性)。

#### 记忆的冻结快照模式

```
首次构建:
  _system_prompt_snapshot = MEMORY.md + USER.md  ← 冻结，永不改变
  注入到 system prompt

运行时写入:
  memory tool call → 写入磁盘 MEMORY.md (live)
  _system_prompt_snapshot 不变
  新记忆在下一次会话才进入 system prompt
```

**目的**：保持 system prompt 前缀稳定 → 最大化 KV 缓存命中率。

### 2.3 家百星 vs Hermes 实现差异

| Hermes 怎么做                   | 家百星做法                            | 差异影响                 |
| ------------------------------- | ------------------------------------- | ------------------------ |
| 工具自注册 + AST 发现           | 集中在 `registerHarnessTools.ts` 注册 | 家百星加工具需改注册文件 |
| 工具集按平台启用                | 8 类目录硬编码                        | 缺少 "平台" 维度控制     |
| 3 级渐进式技能披露              | SkillRegistry + Curator + 渐进披露 ✅ | 已对齐                   |
| 冻结快照保持 system prompt 稳定 | Python `prompt_cache.py` ✅           | 已对齐                   |
| 统一 Provider ABC               | 分散在 LLM/TTS/记忆                   | 重复代码多               |
| 插件 3 种类型 + 独占槽          | Python PluginManager 统一加载 ✅      | 缺少独占/依赖语义        |

---

## 三、重复实现分析与合并建议

### 3.1 🚨 严重重复 (文件重复)

| #   | 重复文件                                                                | 问题                                                                    | 建议                                                                                                   |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `src/memory/VectorDatabase.ts` vs `src/memory/VectorDatabaseFactory.ts` | `VectorDatabase.ts` 已转为 `@deprecated` 向量桥接壳 (真实存储迁 Python) | **保留** `VectorDatabase.ts` 作桥接壳，统一引用 `VectorDatabaseFactory.ts`；待 Python 侧完全接管后可删 |
| 2   | `src/memory/Database.ts` vs `src/shared/DatabaseShim.ts`                | 两个 `MemoryDatabase` 类，一个用 better-sqlite3，一个是内存实现         | **删除** `src/memory/Database.ts` (未使用)，统一用 `DatabaseShim`                                      |
| 3   | `src/models/ModelInterface.ts` vs `src/core/ModelInterface.ts`          | models 版只是从 core 的 re-export                                       | **保留** core 版，models 版保留为 re-export 别名                                                       |

### 3.2 ✅ 已合并：ConstraintsService.hooks → HookManager (双轨→单轨)

**原问题**：`ConstraintsService` 内部维护独立的 `hooks: Map<LifecycleEvent, LifecycleHook[]>`，与 `HookManager` 形成双轨执行路径，同一钩子可能被执行两次。

**当前状态**：✅ 已合并。`ConstraintsService.registerHook()` 和 `executeHooks()` 现在优先委托给 `HookManager`，仅在无 `HookManager` 实例时降级到本地 hooks Map。

```typescript
// ConstraintsService.registerHook() — 优先委托 HookManager
registerHook(event: LifecycleEvent, hook: LifecycleHook): void {
  if (this.deps.hookManager) {
    // 委托给 HookManager，不再维护本地 hooks
    this.deps.hookManager.register({ ... });
    return;
  }
  // 降级：无 HookManager 时使用本地 hooks
  const existing = this.hooks.get(event) || [];
  existing.push(hook);
  this.hooks.set(event, existing);
}
```

**后续**：当所有调用方都确保注入 `HookManager` 后，可移除 `ConstraintsService` 中的本地 `hooks` Map 和降级逻辑。

### 3.3 ✅ 已合并：delegate_task 批量并发控制 → BatchProcessor

**原问题**：`delegate_task` 工具内部实现了独立的批量并发控制逻辑（Promise 并发池），与 `BatchProcessor` 功能重复。

**当前状态**：✅ 已合并。`delegate_task` 现在委托 `BatchProcessor` 处理并发控制。

```typescript
// delegate_task.ts — 委托 BatchProcessor
const processor = new BatchProcessor({
  items: tasks,
  concurrency: maxConcurrent,
  handler: (task) => this.executeSingleTask(task),
});
const results = await processor.run();
```

### 3.4 🔴 缓存系统重复 (4 种缓存)

| 实现                 | 路径                               | 存储        | 用途                      |
| -------------------- | ---------------------------------- | ----------- | ------------------------- |
| `LLMResponseCache`   | `src/models/LLMResponseCache.ts`   | 内存 Map    | 旧版 LLM 响应缓存         |
| `SqliteCacheStore`   | `python/agent/llm/`（已迁）        | SQLite      | 持久化值存储（Python）    |
| `PromptCacheManager` | `python/agent/llm/prompt_cache.py` | 包装 SQLite | prompt 智能缓存（Python） |
| `RedisCache`         | `python/agent/`（已迁）            | Redis       | 通用缓存（Python）        |

**说明**：上述缓存均已迁 Python（`python/agent/llm`）；TS 侧仅保留 `LLMResponseCache`（内存 Map）作为轻量 fallback，其余 `SqliteCacheStore`/`PromptCacheManager`/`RedisCache` 的 TS 文件已删除。

### 3.5 🟠 上下文构建器重复 (4 套)

| 实现                            | 输入           | 输出       | 用途           |
| ------------------------------- | -------------- | ---------- | -------------- |
| `ConstitutionPromptBuilder`     | 身份/规则/记忆 | 系统提示词 | Harness 内建   |
| `ContextManager.buildContext()` | 8 个组件       | 完整上下文 | Harness 主流程 |
| `ContextFileRegistry`           | 项目文件       | 上下文条目 | 自动发现       |
| `LLMContextBuilder`             | 记忆           | 上下文片段 | 记忆系统       |

**建议**：

- `ContextManager` 作为唯一入口，其他三个作为其内部策略
- `LLMContextBuilder` → 记忆组装逻辑已在 Python (`python/agent/memory/engine.py`) 统一；`MemoryEngine` 仅为 TS 桥接壳，不再承载组装
- `ConstitutionPromptBuilder` → 作为 `ContextManager` 的 systemPrompt 策略
- `ContextFileRegistry` → 作为 `ContextManager` 的文件扫描策略

### 3.6 🟡 进化引擎重复 (V1 + V2)

| 实现                   | 路径                                    | 核心                  | 活跃度 |
| ---------------------- | --------------------------------------- | --------------------- | ------ |
| `EvolutionEngine` (V1) | `src/evolution/EvolutionEngine.ts`      | 反馈学习              | 维护中 |
| `EvolutionEngineV2`    | `src/evolution/v2/EvolutionEngineV2.ts` | 自我进化 + 自修改代码 | 活跃   |

**建议**：

- **合并** 到 `evolution/` 下单一引擎
- V2 的 `SelfModificationEngine` 和 `EvolutionPlanner` 直接继承 V1 的 `FeedbackCollector` 和 `StrategyOptimizer`
- V1 的 `EvolutionOrchestrator` 作为总调度

### 3.7 🟢 提供商模式分散 (LLM/TTS/记忆)

| 模式          | 路径                                            | 有抽象吗                    | 注册方式    |
| ------------- | ----------------------------------------------- | --------------------------- | ----------- |
| LLM Provider  | `src/models/ProviderManager.ts`                 | 有 (Model 接口)             | 配置驱动    |
| TTS Provider  | Python `python/agent/tools/voice_mode_tool.py`  | 有（TTS 已迁 Python）       | Python 装配 |
| 记忆 Provider | `src/memory/external/ExternalMemoryProvider.ts` | 有 (ExternalMemoryProvider) | 代码注册    |

**建议**：

- 统一使用 `ExternalMemoryProviderRegistry` 的注册模式
- 提取 `IProvider<T>` 基础接口，TTS 和 LLM Provider 继承
- `ProviderManager` 改名为 `LLMProviderManager`，专门管 LLM

### 3.8 🔵 工具注册重复

| 注册表          | 文件                                         | 用途       | 关系 |
| --------------- | -------------------------------------------- | ---------- | ---- |
| `ToolRegistry`  | `src/harness/tools/registry/ToolRegistry.ts` | 运行时工具 | 主   |
| `SkillRegistry` | `src/skills/SkillRegistry.ts`                | 技能管理   | 次   |

代码注释: "SkillRegistry dual-write has been removed — tools are only registered in ToolRegistry."

**建议**：

- 确认 `SkillRegistry` 是否真的不再用于工具注册
- 如果仅用于技能管理，改名 `SkillLibrary` 避免混淆
- 统一用 `ToolRegistry` 做所有工具入口

### 3.9 合并优先级总结

| 优先级   | 范围    | 事项                                                                     | 工作量     | 风险   | 状态                          |
| -------- | ------- | ------------------------------------------------------------------------ | ---------- | ------ | ----------------------------- |
| **P0**   | 🚨 严重 | `VectorDatabase.ts` 已 @deprecated (桥接壳); `memory/Database.ts` 待确认 | ~0.5天     | 低     | 调整中 (枢纽迁移后优先级下降) |
| **P1**   | 🔴 高   | 缓存系统统一 (ICache + 迁移)                                             | ~2天       | 中     | 待处理                        |
| ~~P1.5~~ | ~~🟠~~  | ~~ConstraintsService.hooks → HookManager~~                               | ~~~1天~~   | ~~中~~ | ✅ 已完成                     |
| ~~P1.6~~ | ~~🟠~~  | ~~delegate_task 并发控制 → BatchProcessor~~                              | ~~~0.5天~~ | ~~低~~ | ✅ 已完成                     |
| **P2**   | 🟠 中   | 上下文构建器合并到 ContextManager                                        | ~1天       | 中     | 待处理                        |
| **P3**   | 🟡 中   | 进化引擎 V1+V2 合并                                                      | ~1天       | 低     | 待处理                        |
| **P4**   | 🟢 低   | 提供商模式统一 + SkillRegistry 改名                                      | ~0.5天     | 低     | 待处理                        |

---

## 四、架构建议 (与 Hermes 对齐)

### 4.1 已对齐的 Hermes 模式

1. **✅ 统一 Hook 系统** — `HookManager` 统一管理所有生命周期钩子，`ConstraintsService` 委托执行
2. **✅ 批处理并发控制** — `BatchProcessor` 统一并行批处理，`delegate_task` 委托使用
3. **✅ 上下文引用解析** — `ContextReferenceResolver` 支持 @引用语法
4. **✅ 检查点增强** — Python `python/agent/persistence/checkpoint.py` 的 `CheckpointService` 提供工作目录快照
5. **✅ 外部记忆集成** — `ExternalMemoryProvider` (TS 抽象基类) + 适配器: Mem0(由 Python `python/agent/memory/providers.py` 承载)/本地/文件
6. **✅ Prompt 缓存** — Python `prompt_cache.py` 智能缓存
7. **✅ 技能渐进披露** — SkillRegistry + Curator 多级加载
8. **✅ 插件系统** — Python `python/agent/plugins/manager.py` (PluginManager + load_plugin)
9. **✅ OpenAI 兼容 API** — `/v1/chat/completions` 端点
10. **✅ IDE 集成** — `ACPServer` Agent Communication Protocol
11. **✅ 全双工语音** — Python `python/agent/tools/voice_mode_tool.py` (VoiceModeManager)
12. **✅ RL 训练轨迹** — `TrajectoryExporter` 导出
13. **CLI 主题** — 已移除 (TS 死代码, 无 Python 等价, 无需求)
14. **✅ 凭证池** — `ProviderManager` 凭证轮换

### 4.2 仍需对齐的 Hermes 模式

1. **工具集按平台开关** — 当前 8 类目录硬编码，应改为 `Toolset` 配置驱动
2. **统一 Provider 抽象** — LLM/TTS/记忆 共享基础接口
3. **自注册工具** — AST 扫描自动发现，加工具不需改注册文件

### 4.3 家百星已有而 Hermes 没有的能力

1. **六层 Harness 独立开关** — E-T-C-S-L-V 每层可独立启用/禁用
2. **进化引擎 (Self-Modification)** — Hermes 只能创建技能，家百星能修改自身代码
3. **桌面自动化** — 屏幕截图、UI 检测、输入模拟
4. **中文优先** — 中文分词、中文 TTS 优化
5. **多平台 IM 集成** — 微信、钉钉、飞书、QQ
6. **SQLite + FTS5 全文检索 + 向量存储**（Python 中心；`ChromaVectorDatabase` 仅 TS 遗留向量层）

### 4.4 建议保留的特色架构

- **六层 Harness** — 比 Hermes 的单层 `AIAgent._run()` 更清晰
- **声明式工具 Schema** — 比 Hermes 的 Python dict 更适合 TypeScript
- **SubAgentFanout 三种策略** — parallel/sequential/adaptive 比 Hermes 的固定并发更强
- **独立的 Security 模块** — 12 个文件的纵深防御
- **统一 HookManager** — 比 Hermes 的分散钩子更一致
