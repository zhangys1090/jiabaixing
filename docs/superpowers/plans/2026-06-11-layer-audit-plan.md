# 入口层 + 核心引擎层 + Harness六层框架 审计计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对家百星项目的入口层、核心引擎层、Harness六层框架进行全面代码与功能审计，识别架构缺陷、安全隐患、性能瓶颈和测试盲区

**Architecture:** 三层递进审计 — 入口层(2文件)→核心引擎层(12文件)→Harness六层(18+文件)，每层按"代码规范→功能完整性→安全审计→性能评估→测试覆盖"五维度审计

**Tech Stack:** TypeScript 6 / Express / WebSocket / Jest / ts-jest

---

## 审计范围与文件清单

### 入口层 (2文件)

| 文件          | 行数 | 职责                                             |
| ------------- | ---- | ------------------------------------------------ |
| `src/main.ts` | ~268 | HTTP+WebSocket服务入口，路由注册，10步初始化流程 |
| `src/cli.ts`  | ~38  | CLI薄代理，委托到`src/cli/index.ts`              |

### 核心引擎层 (12文件)

| 文件                                     | 职责                                 |
| ---------------------------------------- | ------------------------------------ |
| `src/core/JiabaixingCore.ts`             | 主引擎，V5.0统一委托给AgentHarness   |
| `src/core/ConstitutionPromptBuilder.ts`  | 宪法Prompt构建(身份+行为规则)        |
| `src/core/MemoryAssistant.ts`            | 记忆辅助(自动检索/去重/知识图谱)     |
| `src/core/ConversationHistoryManager.ts` | 对话历史存储/持久化                  |
| `src/core/OptimizationScheduler.ts`      | 自动优化调度(反馈报告→启发式建议)    |
| `src/core/ScenarioAwareScheduler.ts`     | 场景感知调度(时间/桌面/Git/事件触发) |
| `src/core/TaskComplexityAnalyzer.ts`     | 任务复杂度分析+拆解建议              |
| `src/core/DAGTask.ts`                    | DAG任务图(依赖管理/执行调度)         |
| `src/core/DynamicTaskAdjuster.ts`        | 动态任务调整(运行时重规划)           |
| `src/core/ModelInterface.ts`             | 统一模型接口定义(OpenAI兼容)         |
| `src/core/UnifiedContextPipeline.ts`     | 统一上下文管道(记忆+主权+场景)       |
| `src/core/index.ts`                      | 模块统一导出                         |

### Harness六层框架 (18+文件)

| 层         | 文件                                          | 职责                                             |
| ---------- | --------------------------------------------- | ------------------------------------------------ |
| E-执行循环 | `harness/loop/LoopController.ts`              | Plan-Execute-Evaluate状态机                      |
| E-规划     | `harness/loop/Planner.ts`                     | 意图分析+执行计划生成                            |
| E-执行     | `harness/loop/Executor.ts`                    | FC循环+工具调用+钩子                             |
| E-评估     | `harness/loop/Evaluator.ts`                   | 目标达成度评估(委托IndependentEvaluationService) |
| E-报告     | `harness/loop/Reporter.ts`                    | 最终响应+质量评分                                |
| T-工具注册 | `harness/tools/registry/ToolRegistry.ts`      | 声明式工具注册+Schema验证                        |
| T-工具守卫 | `harness/tools/registry/ToolCallGuard.ts`     | 去重+缓存+速率限制                               |
| C-上下文   | `harness/context/ContextManager.ts`           | 可组合上下文管道+压缩                            |
| S-持久化   | `harness/persistence/PersistenceService.ts`   | 统一持久化(记忆/对话/任务/画像)                  |
| L-约束     | `harness/constraints/ConstraintsService.ts`   | 5重防御+生命周期钩子                             |
| V-验证     | `harness/verification/VerificationService.ts` | 工具结果验证+输出安全+质量评分                   |
| 入口       | `harness/AgentHarness.ts`                     | 六层组装点+配置管理                              |
| 类型       | `harness/types.ts`                            | 全局类型定义                                     |
| 依赖       | `harness/deps.ts`                             | 依赖注入定义                                     |

---

## 审计维度定义

| 维度              | 检查项                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| **D1 代码规范**   | TypeScript类型安全(no any)、命名规范、JSDoc注释、文件长度≤500行、导入顺序 |
| **D2 功能完整性** | 接口契约一致性、错误处理覆盖、边界条件、降级策略、功能闭环                |
| **D3 安全审计**   | 输入验证、输出编码、敏感信息保护、权限控制、注入防护                      |
| **D4 性能评估**   | 内存泄漏、异步阻塞、缓存策略、资源限制、大文件处理                        |
| **D5 测试覆盖**   | 单元测试覆盖、集成测试覆盖、边界测试、mock合理性                          |

---

## Task 1: 入口层审计 — src/main.ts

**Files:**

- Audit: `src/main.ts`

- [ ] **Step 1: D1 代码规范审计**

检查项：

- [ ] 导入顺序：第三方库→内部模块→类型导入（当前：cors/express/fs/http/path/ws 混排）
- [ ] 类型安全：`core` 变量声明为 `null` 后多处 `core!` 非空断言，缺少运行时守卫
- [ ] 文件长度：268行，✅ 在500行限制内
- [ ] JSDoc注释：`setupRoutes`/`startServer`/`listenServer`/`startServerWithRetry` 缺少JSDoc
- [ ] 命名规范：函数名符合camelCase ✅

**发现：**

1. `core` 变量在 `setupRoutes()` 中直接使用 `core?.getHarness()`，但在 `registerCoreRoutes(app, core)` 中未做null检查
2. `server!`/`wss!` 非空断言在 `listenServer()` 中使用，但 `server` 可能为null（如果 `startServer` 未先调用）
3. `require('dotenv/config')` 在文件顶部使用require而非import，与ES模块风格不一致

- [ ] **Step 2: D2 功能完整性审计**

检查项：

- [ ] 10步初始化流程是否完整实现（当前委托给`bootstrap()`）
- [ ] 路由注册是否覆盖所有API端点
- [ ] 端口冲突重试逻辑是否健壮
- [ ] 优雅关闭是否清理所有资源
- [ ] V5增强初始化(SystemTray/DesktopHotkey)是否非阻塞

**发现：**

1. `initializeV5Enhancements()` 用空catch吞掉错误，无日志记录具体错误信息
2. `startServerWithRetry()` 端口递增后只重建了http/ws，未重新调用 `setupRoutes(broadcast)` — 新端口的路由可能丢失
3. `gracefulShutdown` 只处理SIGTERM/SIGINT，未处理Windows下的进程关闭事件
4. 生产环境HTTPS强制中间件只记录warn不拒绝请求，形同虚设

- [ ] **Step 3: D3 安全审计**

检查项：

- [ ] CORS配置：生产环境 `origin: false` 是否合理
- [ ] JSON body限制：50mb是否过大
- [ ] HTTPS强制中间件：当前只warn不block
- [ ] 静态文件服务：是否暴露敏感文件

**发现：**

1. `express.json({ limit: '50mb' })` — 50mb body限制过大，可能导致DoS攻击，建议降至10mb
2. HTTPS中间件 `next()` 放行所有非安全请求，生产环境应返回403
3. `express.static(frontendBuildPath)` 未设置缓存头，可能暴露构建产物中的source map

- [ ] **Step 4: D4 性能评估**

检查项：

- [ ] 路由注册是否有性能瓶颈
- [ ] WebSocket连接管理
- [ ] 静态文件服务缓存策略

**发现：**

1. `setupStaticFiles()` 每次启动都 `fs.promises.access()` 检查前端构建目录，可缓存结果
2. 路由注册使用 `app.use()` 挂载15+路由模块，无路由优先级优化

- [ ] **Step 5: D5 测试覆盖**

检查项：

- [ ] main.ts是否有对应测试文件
- [ ] 启动流程是否可测试

**发现：**

1. `src/main.ts` 无直接测试文件（入口文件通常通过集成测试覆盖）
2. `bootstrap()` 函数在单独模块中，可独立测试 ✅

---

## Task 2: 入口层审计 — src/cli.ts

**Files:**

- Audit: `src/cli.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 文件仅38行，薄代理模式，代码规范良好
2. ✅ 四种模式分发清晰：daemon/子命令/管道/交互REPL
3. ⚠️ `require.main === module` 判断在ESM模式下可能不工作
4. ⚠️ `pipeMode(args)` 传入空args，管道模式可能需要stdin数据而非args
5. ✅ 错误处理：mainLoop catch + process.exit(1)

---

## Task 3: 核心引擎层审计 — JiabaixingCore.ts

**Files:**

- Audit: `src/core/JiabaixingCore.ts`

- [ ] **Step 1: D1 代码规范审计**

**发现：**

1. ⚠️ `public evolutionEngine` 和 `public feedbackCollector` 直接暴露可变属性，违反封装原则
2. ⚠️ `IMemoryEngine` 接口定义在JiabaixingCore.ts中（84行），应提取到独立类型文件
3. ⚠️ `ProcessInputResult`/`TrackedProcessResult` 接口也应提取
4. ⚠️ 构造函数中 `new LLMProvider(process.env.LLM_MODEL || 'deepseek-chat')` 硬编码默认模型名
5. ⚠️ `CONTEXT_FILE_LIST` 包含 `CLAUDE.md` — 第三方产品名称硬编码
6. ✅ 文件行数约500行，在限制边界

- [ ] **Step 2: D2 功能完整性审计**

**发现：**

1. ✅ V5.0架构：完全委托给AgentHarness处理
2. ⚠️ `processInput()` 无Harness时返回 `fallback_simple` 意图 — 降级路径是否足够？
3. ⚠️ `initialize()` 中LLM初始化失败只标记降级，不抛出异常 — 可能导致静默失败
4. ⚠️ `generateProactiveMessage()` 的 `reason` 参数使用字符串字面量，应使用枚举
5. ⚠️ `inferSceneFromInput()` 是私有方法但通过 `(core as any).inferSceneFromInput()` 测试 — 类型不安全

- [ ] **Step 3: D3 安全审计**

**发现：**

1. ⚠️ `processInput()` 的 `userInput` 参数未做长度限制/验证
2. ⚠️ `refreshProjectContext()` 读取文件系统，路径可能被注入
3. ✅ `SecurityAuditor` 已集成

- [ ] **Step 4: D4 性能评估**

**发现：**

1. ⚠️ `_contextFileCache` 缓存5分钟TTL，但无LRU淘汰 — 长时间运行可能积累
2. ✅ `initialized` 标志防止重复初始化

- [ ] **Step 5: D5 测试覆盖**

**发现：**

1. ✅ 48个分层测试已通过（构造/初始化/processInput/访问器/generateProactiveMessage/inferScene）
2. ⚠️ `processInputWithTracking` 测试只验证成功路径，未测试异常路径

---

## Task 4: 核心引擎层审计 — ConstitutionPromptBuilder.ts

**Files:**

- Audit: `src/core/ConstitutionPromptBuilder.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 精简设计：宪法Prompt只负责身份+行为规则，工具信息由FC Schema提供
2. ✅ `buildConstitutionPrompt()` 生成约30行精简Prompt
3. ⚠️ `MemoryEngineUserProfile` 接口定义在此文件中（35行），应提取到独立类型文件
4. ⚠️ `PromptBuilderDependencies.memoryEngine` 类型为 `null | object`，过于宽泛
5. ⚠️ `buildUserProfileSection()` 中 `getUserProfile()` 返回null时静默跳过，无日志
6. ⚠️ 人格描述硬编码为"28岁的私人秘书"和"御姐秘书" — 应从PersonaCore读取
7. ✅ 测试覆盖：通过JiabaixingCore测试间接覆盖

---

## Task 5: 核心引擎层审计 — MemoryAssistant.ts

**Files:**

- Audit: `src/core/MemoryAssistant.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 依赖注入模式：通过构造函数接收IMemoryEngine
2. ✅ Jaccard相似度去重算法
3. ⚠️ `autoRetrieveMemories()` catch块完全静默 — 记忆检索失败应记录warn
4. ⚠️ `autoExtractKnowledge()` 中LLM调用失败也静默
5. ⚠️ `migrateCrossSessionKnowledge()`/`identifyKnowledgeGaps()`/`proactiveKnowledgeEnrichment()` 三个方法依赖KnowledgeGraphBuilder，但builder可能为null
6. ✅ 测试覆盖：通过JiabaixingCore测试间接覆盖

---

## Task 6: 核心引擎层审计 — 其余9个文件

**Files:**

- Audit: `src/core/ConversationHistoryManager.ts`
- Audit: `src/core/OptimizationScheduler.ts`
- Audit: `src/core/ScenarioAwareScheduler.ts`
- Audit: `src/core/TaskComplexityAnalyzer.ts`
- Audit: `src/core/DAGTask.ts`
- Audit: `src/core/DynamicTaskAdjuster.ts`
- Audit: `src/core/ModelInterface.ts`
- Audit: `src/core/UnifiedContextPipeline.ts`
- Audit: `src/core/index.ts`

- [ ] **Step 1: ConversationHistoryManager 审计**

**发现：**

1. ⚠️ `MAX_HISTORY = 20` 硬编码，无法配置
2. ⚠️ `saveDebounceTimer` 使用 `NodeJS.Timeout` 但未在dispose时清理 — 可能内存泄漏
3. ⚠️ 文件路径 `data/conversation-state-${userId}.json` — userId未做路径遍历检查
4. ✅ 异步init()模式正确（构造函数不能async）

- [ ] **Step 2: OptimizationScheduler 审计**

**发现：**

1. ⚠️ `IMemoryEngine` 接口在此文件中重复定义（与JiabaixingCore.ts中的不同版本）
2. ⚠️ `applyOptimizationsFromReport()` 使用同步 `fs.existsSync` + 异步 `fs.promises.readFile` 混用
3. ⚠️ `optimizationScheduler` 定时器未在dispose时清理

- [ ] **Step 3: ScenarioAwareScheduler 审计**

**发现：**

1. ⚠️ `TaskStatus` 枚举在此文件中定义，与 `DAGTask.ts` 中的 `TaskStatus` 重复且不一致（DAG有SUCCESS/RETRYING，Scenario有COMPLETED/CANCELLED）
2. ⚠️ `execSync` 同步执行Git命令 — 可能阻塞事件循环
3. ⚠️ 文件可能超过500行（调度器逻辑复杂）
4. ⚠️ 测试耗时389秒（全量测试中最慢），需优化

- [ ] **Step 4: TaskComplexityAnalyzer 审计**

**发现：**

1. ✅ 纯分析模块，无副作用
2. ⚠️ 复杂度关键词硬编码，无法动态扩展
3. ✅ 接口定义清晰（TaskComplexityResult/TaskDecomposition/SubTask）

- [ ] **Step 5: DAGTask.ts 审计**

**发现：**

1. ✅ 纯数据结构定义，无逻辑
2. ⚠️ `TaskStatus` 枚举与ScenarioAwareScheduler中的重复定义
3. ⚠️ `TaskNode` 类所有属性都是public，缺少封装

- [ ] **Step 6: DynamicTaskAdjuster 审计**

**发现：**

1. ⚠️ `import Logger from '../utils/Logger'` — 使用default import，但Logger是named export
2. ⚠️ `TaskExecutionState.resourceUsage` 的cpu/memory/io字段无实际采集逻辑
3. ⚠️ 与Planner的replan功能可能重叠

- [ ] **Step 7: ModelInterface.ts 审计**

**发现：**

1. ✅ 统一模型接口定义，整合了core和models两套接口
2. ⚠️ `LLMToolDef` 接口与 `ToolRegistry.OpenAIToolDef` 可能重复
3. ✅ 支持多模态输入(images/audio)

- [ ] **Step 8: UnifiedContextPipeline.ts 审计**

**发现：**

1. ✅ 三重组合架构：数据主权×记忆深度×主动关怀
2. ⚠️ `MemoryEngine` 直接依赖具体类而非接口 — 违反依赖倒置原则
3. ⚠️ `DataSovereigntyPipeline` 可能为null但未做null检查

- [ ] **Step 9: index.ts 审计**

**发现：**

1. ⚠️ 只导出4个模块，但core目录有12个文件 — 大量模块未导出
2. ⚠️ 注释"多个未使用的模块已被移除" — 但DAGTask/DynamicTaskAdjuster/ModelInterface等仍在

---

## Task 7: Harness六层审计 — AgentHarness.ts (组装入口)

**Files:**

- Audit: `src/harness/AgentHarness.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 六层组件清晰组装：LoopController/ToolRegistry/ContextManager/PersistenceService/ConstraintsService/VerificationService
2. ✅ 环境变量配置覆盖所有层开关
3. ✅ 默认配置全开（DEFAULT_CONFIG）
4. ⚠️ `getEnvConfig()` 8个if语句重复模式，可用循环+映射表简化
5. ⚠️ `initialized` 标志无并发保护 — 多次调用initialize可能竞态
6. ⚠️ `processInput()` 是核心方法，需确认错误传播链完整
7. ✅ OrchestratorAgent集成（多Agent编排）

---

## Task 8: Harness六层审计 — E层(执行循环)

**Files:**

- Audit: `src/harness/loop/LoopController.ts`
- Audit: `src/harness/loop/Planner.ts`
- Audit: `src/harness/loop/Executor.ts`
- Audit: `src/harness/loop/Evaluator.ts`
- Audit: `src/harness/loop/Reporter.ts`

- [ ] **Step 1: LoopController 审计**

**发现：**

1. ✅ Plan-Execute-Evaluate状态机实现完整
2. ✅ 预算控制：轮次/Token/工具调用/时长四维限制
3. ✅ 辩论器(Debater)集成 — 计划验证
4. ⚠️ `HARNESS_TOOLS` 硬编码工具名列表 — 与ToolRegistry注册脱节，新增工具需手动同步
5. ⚠️ `STATE_DISPLAY` 状态展示信息硬编码
6. ⚠️ `LoopControllerDeps` 接口过于庞大（11个依赖），应拆分

- [ ] **Step 2: Planner 审计**

**发现：**

1. ✅ 简单任务跳过规划（ACTION_SIMPLE_PATTERNS正则匹配）
2. ✅ 知识图谱注入器(knowledgeInjector)集成
3. ⚠️ `ACTION_SIMPLE_PATTERNS` 正则列表硬编码，无法动态扩展
4. ⚠️ `detectLanguageFilePatternFromInput()` 导出供ContextManager使用 — 跨层依赖
5. ⚠️ LLM规划失败时降级策略不明确

- [ ] **Step 3: Executor 审计**

**发现：**

1. ✅ FC循环 + ToolCallHooks非侵入式钩子
2. ✅ Human-in-the-Loop审批管理器集成
3. ✅ 工具输出截断(MAX_TOOL_OUTPUT=12000)
4. ⚠️ `DEFAULT_SAFE_PERMISSIONS` 包含所有权限 — "安全"权限列表过于宽松
5. ⚠️ `HARD_TOOL_LIMIT = 20` / `SOFT_TOOL_LIMIT = 10` 硬编码
6. ⚠️ `executeWithRetry` 重试策略未考虑幂等性

- [ ] **Step 4: Evaluator 审计**

**发现：**

1. ✅ 纯适配器模式：委托给IndependentEvaluationService
2. ✅ replanCount重置防止状态泄漏（C6 fix）
3. ⚠️ `MAX_REPLAN = 2` 硬编码
4. ⚠️ LLM评估可选(`enableLLMEvaluation`)，关闭时评估质量可能不足

- [ ] **Step 5: Reporter 审计**

**发现：**

1. ✅ 质量评分四维：accuracy/usefulness/efficiency/overall
2. ⚠️ `computeQuality()` 中 `overall` 初始1.0，只在非自然完成时-0.3 — 评分过于宽松
3. ⚠️ `extractResponse()` 从后往前找assistant消息 — 如果最后一条是工具调用结果而非assistant回复，可能提取错误
4. ⚠️ 无LLM辅助的质量评估 — 纯启发式评分可能不准确

---

## Task 9: Harness六层审计 — T层(工具注册)

**Files:**

- Audit: `src/harness/tools/registry/ToolRegistry.ts`
- Audit: `src/harness/tools/registry/ToolCallGuard.ts`

- [ ] **Step 1: ToolRegistry 审计**

**发现：**

1. ✅ 声明式注册 + Schema验证 + 权限检查
2. ✅ `cachedOpenAITools` 缓存避免重复转换
3. ⚠️ 重复注册静默跳过(`if (this.tools.has(definition.name)) return`) — 应该warn
4. ⚠️ `DiscoveredTool` 接口定义但未在注册流程中使用 — 死代码
5. ⚠️ 无工具注销(unregister)机制

- [ ] **Step 2: ToolCallGuard 审计**

**发现：**

1. ✅ 三重防护：结果缓存+去重+速率限制
2. ✅ 从SecurityPolicyEngine统一读取配置
3. ⚠️ `hashArgs()` 使用JSON.stringify — 对象属性顺序不同会产生不同hash
4. ⚠️ `callHistory` 无清理机制 — 长时间运行可能积累
5. ⚠️ `resultCache` 无大小限制 — 可能内存泄漏

---

## Task 10: Harness六层审计 — C层(上下文)

**Files:**

- Audit: `src/harness/context/ContextManager.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 可组合上下文管道：宪法Prompt+记忆+动态上下文+历史+人格+场景
2. ✅ Token预算分配器(TokenBudgetAllocator)集成
3. ✅ 压缩/摘要/卸荷三级策略
4. ⚠️ `ContextManagerDeps` 接口9个依赖，过于庞大
5. ⚠️ `STOP_WORDS` 硬编码中英文停用词 — 应提取到配置
6. ⚠️ `detectLanguageFilePatternFromInput` 从Planner导入 — C层依赖E层，违反分层原则
7. ⚠️ 压缩阈值配置硬编码(DEFAULT_COMPRESSION_THRESHOLD)

---

## Task 11: Harness六层审计 — S层(持久化)

**Files:**

- Audit: `src/harness/persistence/PersistenceService.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 统一持久化：记忆/对话/任务/画像/进化指标
2. ✅ 跨会话任务状态管理(TaskState)
3. ⚠️ 依赖注入接口过于庞大 — 需要memoryEngine/conversationManager/chatService/eventBus/userProfile等多个依赖
4. ⚠️ 文件持久化路径未做路径遍历检查
5. ⚠️ 无数据迁移/版本管理机制

---

## Task 12: Harness六层审计 — L层(约束)

**Files:**

- Audit: `src/harness/constraints/ConstraintsService.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 5重防御：预算检查+权限检查+敏感信息检测+危险命令检测+生命周期钩子
2. ✅ 敏感信息检测委托给统一模块SensitiveDetector
3. ✅ 生命周期钩子系统(LifecycleHook)
4. ⚠️ `checkBudget()` 返回warnings但不阻止执行 — 预算超限时应强制终止
5. ⚠️ `hooks` Map无清理机制 — 长时间运行可能积累已注册的钩子
6. ⚠️ `AdaptiveBudgetConfig`/`CreativeExplorationConfig` 在types.ts中定义但可能未使用

---

## Task 13: Harness六层审计 — V层(验证)

**Files:**

- Audit: `src/harness/verification/VerificationService.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 多层验证：工具结果验证+输出安全检查+质量评分+目标达成评估
2. ✅ 输出安全检查委托给SensitiveDetector
3. ✅ `truncationWarnedTools` 使用RedisCache做去重(TTL=10分钟)
4. ⚠️ `RedisCache` 依赖可能过重 — 简单的Map+TTL即可满足需求
5. ⚠️ `validateToolResult()` 中空结果返回valid=false — 某些工具(如删除)空结果是正常的
6. ⚠️ LLM辅助评估可选，关闭时验证质量可能不足

---

## 审计发现汇总

### 严重问题 (P0 — 必须修复) ✅ 全部已修复

| #    | 文件                       | 问题                        | 影响                 | 状态      |
| ---- | -------------------------- | --------------------------- | -------------------- | --------- |
| P0-1 | main.ts                    | HTTPS中间件只warn不block    | 生产环境安全形同虚设 | ✅ 已修复 |
| P0-2 | main.ts                    | JSON body限制50mb           | DoS攻击风险          | ✅ 已修复 |
| P0-3 | main.ts                    | 端口重试后未重新setupRoutes | 新端口路由丢失       | ✅ 已修复 |
| P0-4 | ConversationHistoryManager | userId未做路径遍历检查      | 可读取任意文件       | ✅ 已修复 |
| P0-5 | ToolCallGuard              | resultCache无大小限制       | 内存泄漏             | ✅ 已修复 |
| P0-6 | ConstraintsService         | 预算超限不强制终止          | 资源耗尽             | ✅ 已修复 |

### 重要问题 (P1 — 应该修复) ✅ 全部已修复

| #     | 文件                   | 问题                                         | 影响         | 状态      |
| ----- | ---------------------- | -------------------------------------------- | ------------ | --------- |
| P1-1  | JiabaixingCore         | IMemoryEngine接口应提取到独立文件            | 类型定义耦合 | ✅ 已修复 |
| P1-2  | JiabaixingCore         | evolutionEngine/feedbackCollector public暴露 | 封装破坏     | ✅ 已修复 |
| P1-3  | ScenarioAwareScheduler | execSync阻塞事件循环                         | 性能瓶颈     | ✅ 已修复 |
| P1-4  | ScenarioAwareScheduler | TaskStatus枚举与DAGTask重复且不一致          | 类型混乱     | ✅ 已修复 |
| P1-5  | DynamicTaskAdjuster    | Logger import方式错误(default vs named)      | 运行时错误   | ✅ 已修复 |
| P1-6  | LoopController         | HARNESS_TOOLS硬编码与ToolRegistry脱节        | 新增工具遗漏 | ✅ 已修复 |
| P1-7  | Executor               | DEFAULT_SAFE_PERMISSIONS包含所有权限         | 权限控制失效 | ✅ 已修复 |
| P1-8  | ContextManager         | C层依赖E层(Planner导入)                      | 分层违反     | ✅ 已修复 |
| P1-9  | Reporter               | 质量评分过于宽松                             | 评分失真     | ✅ 已修复 |
| P1-10 | ToolRegistry           | 重复注册静默跳过                             | 调试困难     | ✅ 已修复 |

### 一般问题 (P2 — 建议改进) ✅ 全部已修复/评估

| #     | 文件                      | 问题                                       | 状态                        |
| ----- | ------------------------- | ------------------------------------------ | --------------------------- |
| P2-1  | main.ts                   | require('dotenv/config')与ES模块风格不一致 | ✅ 已修复                   |
| P2-2  | main.ts                   | initializeV5Enhancements()吞掉错误详情     | ✅ 已修复                   |
| P2-3  | ConstitutionPromptBuilder | 人格描述硬编码                             | ⏭️ 跳过(需PersonaCore配合)  |
| P2-4  | MemoryAssistant           | 记忆检索失败静默                           | ✅ 已修复                   |
| P2-5  | Planner                   | ACTION_SIMPLE_PATTERNS硬编码               | ⏭️ 跳过(需配置系统配合)     |
| P2-6  | ToolCallGuard             | hashArgs使用JSON.stringify                 | ✅ 评估后保留(已有排序处理) |
| P2-7  | ToolCallGuard             | callHistory无清理                          | ✅ 评估后保留(已有TTL过期)  |
| P2-8  | ContextManager            | STOP_WORDS硬编码                           | ⏭️ 跳过(需配置系统配合)     |
| P2-9  | OptimizationScheduler     | IMemoryEngine接口重复定义                  | ✅ 已修复                   |
| P2-10 | core/index.ts             | 大量模块未导出                             | ✅ 已修复                   |

### 测试覆盖评估

| 层          | 测试文件数 | 测试用例数 | 覆盖评估                                              |
| ----------- | ---------- | ---------- | ----------------------------------------------------- |
| 入口层      | 0          | 0          | ❌ 无直接测试                                         |
| 核心引擎层  | 2          | 48+        | ✅ JiabaixingCore覆盖良好，其他模块间接覆盖           |
| Harness E层 | 5          | 60+        | ✅ LoopController/Planner/Executor/Evaluator/Reporter |
| Harness T层 | 3          | 30+        | ✅ ToolRegistry/ToolCallGuard/SchemaValidator         |
| Harness C层 | 1          | 10+        | ✅ ContextManager                                     |
| Harness S层 | 2          | 15+        | ✅ PersistenceService/TrajectoryDatabase              |
| Harness L层 | 1          | 10+        | ✅ ConstraintsService                                 |
| Harness V层 | 1          | 10+        | ✅ VerificationService                                |

---

## 修复优先级建议

### 第一批：P0安全修复 (1-2天)

1. **P0-1**: main.ts HTTPS中间件改为返回403
2. **P0-2**: main.ts JSON body限制降至10mb
3. **P0-3**: main.ts 端口重试后重新setupRoutes
4. **P0-4**: ConversationHistoryManager userId路径遍历检查
5. **P0-5**: ToolCallGuard resultCache添加大小限制
6. **P0-6**: ConstraintsService 预算超限强制终止

### 第二批：P1架构修复 (2-3天)

1. **P1-1+P1-2**: JiabaixingCore 提取IMemoryEngine到独立文件 + 封装public属性
2. **P1-3+P1-4**: ScenarioAwareScheduler 异步Git + 统一TaskStatus枚举
3. **P1-5**: DynamicTaskAdjuster 修复Logger import
4. **P1-6**: LoopController HARNESS_TOOLS从ToolRegistry动态获取
5. **P1-7**: Executor 收紧DEFAULT_SAFE_PERMISSIONS
6. **P1-8**: ContextManager 移除对Planner的跨层依赖
7. **P1-9**: Reporter 改进质量评分算法
8. **P1-10**: ToolRegistry 重复注册时warn

### 第三批：P2改进 (1-2天)

1. 统一配置管理（消除硬编码常量）
2. 完善入口层测试
3. 清理死代码和未导出模块
