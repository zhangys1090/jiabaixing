# Jiabaixing V5.0 — 开发文档

> **版本**: V5.0 Harness Agent Framework
> **架构**: E-T-C-S-L-V 六层管控
> **语言**: TypeScript（ES2022, CommonJS）
> **运行环境**: Node.js >= 20.x
> **默认模型**: qwen2.5:3b（OpenAI 兼容接口）
> **更新日期**: 2026-05-25

---

## 一、概述

Jiabaixing 是一个运行在本机的 AI 智能体系统。核心理念：

> **Agent = (LLM 推理内核 + 能力组件) × Harness 管控系统**

模型做认知决策（工具选择、推理、表达），Harness 做工程管控（预算、权限、验证、状态）。单一执行路径：

```
Gateway → JiabaixingCore → AgentHarness → LoopController
                                              ├── Planner
                                              ├── Executor → ToolRegistry
                                              ├── Evaluator
                                              └── Reporter
```

**当前状态**：核心链路可工作。Harness 六层全部启用，25 个声明式工具，132 个 Harness 测试通过，4 平台消息网关。

---

## 二、快速开始

### 环境

- Node.js >= 20.x，npm >= 9.x
- 可访问的 LLM 服务（OpenAI 兼容接口）

### 启动

```bash
cp .env.example .env    # 编辑 .env 填入 LLM 配置
npm install
npm start               # 后端 :3111 + 前端 :3000
```

### 验证

```bash
curl http://localhost:3111/api/health
npm run cli             # 终端对话
```

### 常用命令

```bash
npm run dev              # 热重载
npm run start:backend    # 仅后端
npm run start:frontend   # 仅前端
npm test                 # 全量测试
npm run build:fast       # 快速构建
npm run lint             # ESLint
npm run format           # Prettier
```

---

## 三、架构

### 3.1 六层 Harness

```
┌─────────────────────────────────────────────────────────┐
│                   Agent Harness（六层核心）                │
│                                                          │
│  E — Execution Loop     Planner→Executor→Evaluator→Reporter │
│  T — Tool Registry      8 类 25 个声明式工具              │
│  C — Context Manager    宪法 Prompt→记忆→动态上下文→历史   │
│  S — State Store        三层记忆（瞬时/SQLite/ChromaDB）   │
│  L — Lifecycle Hooks    9 个钩子（before_loop→on_step_completed） │
│  V — Evaluation         五维质量评分 + 目标达成度          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 LLM 与 Harness 职责

| LLM 做                       | Harness 做              |
| ---------------------------- | ----------------------- |
| 创造力与推理                 | 持久化（记忆、状态）    |
| 自然语言理解                 | 预算控制（四维限制）    |
| 工具选择（Function Calling） | 工具结果验证 + 安全检查 |
| 多步推理（ReAct）            | 五维质量评分            |
| 个性化表达                   | 生命周期钩子 + 权限守卫 |

### 3.3 四维预算控制

| 维度     | 软限制 | 硬限制 |
| -------- | ------ | ------ |
| 轮次     | 4      | 8      |
| Token    | 4500   | 6000   |
| 时间     | —      | 60s    |
| 工具调用 | —      | 20     |

### 3.4 架构原则

- **约束而非指令** — Harness 设边界，不告诉模型怎么思考
- **状态外部化** — Agent 不持有内部状态，全部由 LoopContext 管理
- **Rippable Architecture** — 6 层独立开关，模型提升后可逐层剥离
- **降级保底** — Harness 失败 → 简单回复兜底
- **声明式工具** — JSON Schema 定义参数，SchemaValidator 验证

---

## 四、已实现能力

### 4.1 执行循环

`src/harness/loop/LoopController.ts`

```
Planner → Executor → Evaluator → Reporter
    ↑                      │
    └── 回溯重规划（最多1次）──┘
```

| 阶段      | 职责                                       |
| --------- | ------------------------------------------ |
| Planner   | LLM 驱动任务分解，简单任务自动跳过         |
| Executor  | FC 循环，工具调用 + 结果验证               |
| Evaluator | 目标达成度评估，建议 continue/replan/abort |
| Reporter  | 响应生成 + 质量评分                        |

**已知局限**：Evaluator 与执行耦合（非独立评估 Agent），回溯重试最多 1 次。

### 4.2 工具注册表

`src/harness/tools/registry/ToolRegistry.ts`

25 个声明式工具，8 个分类：

| 分类      | 工具                                                                       | 权限        |
| --------- | -------------------------------------------------------------------------- | ----------- |
| memory    | memory_recall, memory_search, memory_store                                 | low         |
| cognition | emotion_detect, scene_analyze, self_reflect                                | low         |
| desktop   | desktop_screenshot, desktop_automate                                       | medium/high |
| file      | file_list, file_search, get_active_file, incremental_edit, multi_file_edit | low-high    |
| code      | code_analyze, code_fix, code_generate                                      | low-high    |
| system    | ask_clarification, preview_execution, rollback_changes                     | low-high    |
| daily     | task_manage, reminder_set, note_take, system_status                        | low-medium  |
| network   | web_search, skill_create                                                   | medium/high |

每个工具有 JSON Schema 参数定义、四级权限分级（low/medium/high/critical）、幂等标志、超时时间。执行结果经 `VerificationService` 三阶段验证（错误检测 → 安全检查 → 截断处理）。

### 4.3 上下文管理

`src/harness/context/ContextManager.ts`

可组合管道：`宪法 Prompt → 记忆检索 → 动态上下文 → 对话历史`

Token 预算六桶分配：systemPrompt 30% / memory 20% / history 25% / dynamicContext 10% / toolResults 10% / reserve 5%

**已知局限**：无上下文缩减机制（Compaction/Summarization/Offloading 均未实现）。

### 4.4 三层记忆

```
瞬时记忆 — LoopContext.messages（请求生命周期）
短期记忆 — SQLite（近期对话、工具结果、用户画像）
长期记忆 — ChromaDB 向量存储（知识提取、语义检索）
```

`src/harness/persistence/PersistenceService.ts` + `src/memory/MemoryEngine.ts`

### 4.5 生命周期钩子

`src/harness/constraints/ConstraintsService.ts`

9 个钩子：`BEFORE_LOOP`, `BEFORE_TOOL_CALL`, `AFTER_TOOL_CALL`, `BEFORE_RESPONSE`, `AFTER_RESPONSE`, `ON_ERROR`, `ON_BUDGET_EXCEEDED`, `ON_PLAN_CREATED`, `ON_STEP_COMPLETED`

### 4.6 评估验证

`src/harness/verification/VerificationService.ts`

五维质量评分（accuracy/usefulness/friendliness/efficiency/overall，0-1 范围）+ 目标达成度（achieved + progress + suggestedAction）。

**已知局限**：LLM-as-a-Judge 基础实现，无 Golden Eval Set，无全轨迹审计。

### 4.7 多平台网关

`src/integration/GatewayBridge.ts`

双模架构：fork 子进程（优先，崩溃自动重启 5 次）+ 主进程内联（回退）。

5 个平台适配器：微信个人号（扫码）/ 微信企业号 / QQ（Mirai）/ 飞书 / 钉钉。

### 4.8 CLI 终端

`src/cli.ts` — 独立 REPL 客户端，通过 HTTP 连接后端。支持 `/chat`, `/gateway`, `/schedule`, `/config`, `/status`, `/web`, `/help`, `/clear`, `/quit`。

### 4.9 前端面板

React 18 + TypeScript + Zustand + WebSocket，14 个面板（ChatInterface, IntegrationPanel, AutomationPanel, EvolutionPanel, SecurityPanel, MemoryPanel, SkillConsole, DesktopPanel, MonitorPanel, PerformancePanel, AgentExecutionPanel, LogPanel, SettingsPanel, VibeCodingPanel）。

### 4.10 安全模块

8 个安全模块：NetworkGuard, DataSovereigntyPipeline（加密+脱敏）, AuthenticationManager（JWT）, SecurityManager, SecurityPolicyEngine（权限+速率限制+注入检测）, SecurityGuard, EncryptionManager, AuditLogger。

安全边界：输入层注入检测 → 执行层权限检查 → 输出层内容安全审核 → 持久化层加密脱敏。

### 4.11 进化引擎

`src/evolution/` — 反馈驱动自动优化，24h 周期调度。记录进化指标 + 学习洞察，支持手动触发优化。

---

## 五、API 参考

### 主处理端点

**`POST /api/process`**

```json
// 请求
{ "input": "帮我搜索最近的文档", "userId": "user_001", "traceId": "trace_abc123" }

// 响应
{
  "response": "找到以下文档...",
  "traceId": "trace_abc123",
  "intent": "harness_orchestrated",
  "details": {
    "quality": { "overall": 0.85, "accuracy": 0.9, "usefulness": 0.8 },
    "loopRounds": 2,
    "toolCalls": 3
  }
}
```

### 其他端点

| 路由                 | 关键端点                                                     |
| -------------------- | ------------------------------------------------------------ |
| `/api/health`        | `GET /health`                                                |
| `/api/integration`   | platforms, connect, disconnect, webhook, send, wechat/qrcode |
| `/api/automation`    | tasks (CRUD), triggers, patterns                             |
| `/api/skills`        | list, execute, register                                      |
| `/api/evolution`     | status, metrics, trigger, healing                            |
| `/api/llm`           | status, switch, performance                                  |
| `/api/performance`   | snapshot                                                     |
| `/api/security`      | logs, validate                                               |
| `/api/conversations` | 对话历史                                                     |

### WebSocket

`ws://localhost:3111` — 事件：`agent_execution_update`, `integration_message`, `response_ready`, `system_status`

---

## 六、开发指南

### 环境搭建

```bash
git clone <repo> && cd jiabaixing
npm install && cp .env.example .env
npm run dev
```

### 添加新工具

1. 在 `src/harness/tools/<category>/` 创建工具定义文件
2. 导出 `TOOL_NAME_DEF: ToolDefinition` 和 `createXxxExecutor()`
3. 在 `registerHarnessTools.ts` 中导入并注册
4. 运行 `npm test -- tests/harness/tools.test.ts` 验证

### 添加新平台适配器

1. 继承 `BaseIntegrationAdapter`
2. 实现 `connect()`, `disconnect()`, `sendMessage()`, `handleWebhook()`
3. 在 `IntegrationManager.initializeAdapters()` 中注册
4. 在 `gatewayWorker.ts` 中添加 IPC 消息处理

### 代码质量

```bash
npm run lint && npm run format && npm run build:fast
```

### Commit 规范

`feat:` 新功能 / `fix:` Bug 修复 / `refactor:` 重构 / `test:` 测试 / `docs:` 文档 / `chore:` 构建

---

## 七、测试

```
tests/
├── harness/         # Harness 六层测试（132 个用例）
├── unit/            # 单元测试
├── integration/     # 集成测试
└── e2e/             # 端到端测试
```

| 模块                   | 目标覆盖率 |
| ---------------------- | ---------- |
| Harness LoopController | > 90%      |
| ToolRegistry           | > 90%      |
| VerificationService    | > 85%      |
| MemoryEngine           | > 90%      |

```bash
npm test                   # 全量
npm run test:coverage      # 覆盖率
npm run test:integration   # 仅集成
npm run test:e2e           # Cypress E2E
```

suggestedAction: 'continue' | 'replan' | 'abort';
}

```



---

## 八、项目目录

```

jiabaixing/
├── src/
│ ├── core/ # JiabaixingCore, 调度, 任务协调
│ ├── harness/ # ★ V5.0 Harness 六层（E-T-C-S-L-V）
│ │ ├── loop/ # E — Execution Loop
│ │ ├── tools/ # T — Tool Registry（8 类 25 工具）
│ │ ├── context/ # C — Context Manager
│ │ ├── persistence/ # S — State Store
│ │ ├── verification/ # V — Evaluation
│ │ └── constraints/ # L — Lifecycle Hooks
│ ├── integration/ # 网关（GatewayBridge + 5 适配器 + Worker）
│ ├── memory/ # 三层记忆（瞬时/SQLite/ChromaDB）
│ ├── evolution/ # 进化引擎
│ ├── security/ # 8 个安全模块
│ ├── skills/ # 技能注册表（双写兼容）
│ ├── models/ # LLMProvider + ModelSelector
│ ├── persona/ # 人格系统
│ ├── multimodal/ # 多模态感知
│ ├── server/ # Express + 路由 + WebSocket + bootstrap
│ ├── shared/ # contracts.ts + EventBus
│ ├── frontend/ # React 前端（14 个面板）
│ ├── cli.ts # CLI 终端
│ └── main.ts # 入口
├── tests/
│ ├── harness/ # 132 个测试
│ ├── unit/ / integration/ / e2e/
├── .env / .env.example
├── package.json
├── tsconfig.json
├── PROJECT.md
└── CLAUDE.md

````

---

## 九、技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 20+, TypeScript (ES2022) |
| Web 框架 | Express 4.x + ws 8.x |
| 前端 | React 18 + Zustand |
| 数据库 | better-sqlite3 + ChromaDB |
| LLM 接口 | OpenAI 兼容 API |
| 桌面控制 | @nut-tree/nut-js + playwright |
| 安全 | bcrypt + jsonwebtoken + helmet |
| 日志 | winston |
| 测试 | jest 30 + ts-jest |
| 进程管理 | PM2（推荐） |

---


---

## 十一、配置参考

### 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENAI_API_BASE` | 是 | `http://127.0.0.1:8001/v1` | LLM 服务地址 |
| `OPENAI_API_KEY` | 否 | `not-needed` | API 密钥 |
| `LLM_MODEL` | 否 | `qwen2.5:3b` | 模型名称 |
| `API_PORT` | 否 | `3111` | 后端端口 |
| `ENABLE_AUTO_OPTIMIZE` | 否 | `true` | 启用自动进化 |

### Harness 功能开关

```typescript
const harness = new AgentHarness({
  useHarnessLoop: true,          // E
  useHarnessTools: true,         // T
  useHarnessContext: true,       // C
  useHarnessVerification: true,  // V
  useHarnessConstraints: true,   // L
  useHarnessPersistence: true,   // S
});
````

### 网关平台配置

```bash
# QQ 自动连接（其他平台通过 CLI /gateway 或前端配置）
QQ_ENABLED=true
MIRAI_HTTP_HOST=localhost
MIRAI_HTTP_PORT=8080
MIRAI_VERIFY_KEY=your-key
QQ_ACCOUNT=123456789
```

### 部署（PM2 推荐）

```bash
npm run build
pm2 start dist/main.js --name jiabaixing
pm2 save && pm2 startup
```

## 十二、进化路线图

### 14.1 功能路线图

| 阶段                                | 目标                                        | 状态      |
| ----------------------------------- | ------------------------------------------- | --------- |
| Phase 1-7: Foundation               | LLM-First, FC loop, 预算, 记忆, 主动触发    | ✅ 100%   |
| Phase 8: Harness Agent Framework    | 六层 E-T-C-S-L-V Harness                    | ✅ 100%   |
| Phase 9: Full Harness Integration   | Harness 完全集成至所有通路                  | ✅ 100%   |
| Phase 10: Multi-Agent Orchestration | 多 Agent 协同 + 任务拆解 + Sub-Agent 扇出   | 🚧 开发中 |
| Phase 11: Self-Evaluation Pipeline  | 效果自评估 + 持续优化闭环 + Golden Eval Set | 🚧 开发中 |
| Phase 12: Docker + K8s              | 容器化部署 + 编排                           | 📋 规划中 |
| Phase 13: Plugin Ecosystem          | 第三方插件市场                              | 💡 设想   |

### 14.2 H0-H3 成熟度演进

基于 arXiv:2605.13357 定义的四级 Harness 成熟度模型：

| 级别                | 核心能力                                 | 当前状态    | 下一里程碑                     |
| ------------------- | ---------------------------------------- | ----------- | ------------------------------ |
| **H0** — 基础输出   | 仅输出最终补丁，无工具，无恢复           | ✅ 已超越   | —                              |
| **H1** — 工具访问   | 单步工具调用，无循环，失败即终止         | ✅ 已超越   | —                              |
| **H2** — 失败归因   | 多步 ReAct + 工具验证 + 错误回溯         | ✅ 达成     | H3 部分特性                    |
| **H3** — 确定性校验 | 独立 Evaluator + 全轨迹审计 + 安全自动化 | 📋 部分达成 | 全轨迹审计 + Golden Eval CI/CD |

**H2→H3 具体演进计划**：

| 能力缺口               | 当前状态                       | 目标状态                                       | 优先级 |
| ---------------------- | ------------------------------ | ---------------------------------------------- | ------ |
| **全轨迹审计**         | 仅记录工具输出                 | 每步完整上下文快照 + 结构化审计日志            | P0     |
| **独立安全 Evaluator** | VerificationService 与执行耦合 | 完全独立的评估 Agent，分离执行与评判           | P0     |
| **Golden Eval Set**    | 无结构化评估数据集             | 50+ 真实失败案例 + 触发/非触发混合             | P1     |
| **CI/CD 评估门禁**     | 无自动化评估管道               | Eval Harness → 部署门禁（pass@k + pass^k）     | P1     |
| **Context Compaction** | 无上下文缩减机制               | Compaction → Summarization 三级缩减            | P2     |
| **语义级参数校验**     | SchemaValidator 格式校验       | OPP 级语义校验（参数值是否"合理"而非仅"合法"） | P2     |
| **混沌 + 对抗测试**    | 无                             | 季度混沌测试 + 对抗样本验证                    | P3     |
| **插件签名验证**       | 无                             | Sigstore/Cosign 插件签名 + 验证链              | P3     |

### 14.3 行业趋势跟踪（2026→2028）

| 方向             | 说明                                      | 对 Jiabaixing 的影响          |
| ---------------- | ----------------------------------------- | ----------------------------- |
| **自适应架构**   | 元学习动态优化上下文窗口和工具调用策略    | 可融入 EvolutionEngine        |
| **多模态扩展**   | 语音、图像、视频统一处理                  | 已有 multimodal/ 基础，可深化 |
| **边缘部署**     | WebAssembly 轻量化，端侧设备运行          | 低优先级（桌面优先）          |
| **联邦学习**     | 保护数据隐私的模型协同训练                | 与本地优先理念冲突            |
| **神经符号系统** | 连接主义 + 符号主义融合推理               | 可增强确定性校验（H3）        |
| **多智能体协作** | 去中心化分布式调度网络                    | Phase 10 核心方向             |
| **Meta Harness** | Harness Evolution Loop — Harness 自我进化 | Phase 11+ 长期愿景            |

---

## 十二、术语表

| 术语                      | 说明                                                           |
| ------------------------- | -------------------------------------------------------------- |
| **Harness**               | 六层工程管控系统，封装 LLM 不确定性                            |
| **E-T-C-S-L-V**           | Execution / Tools / Context / State / Lifecycle / Verification |
| **LoopController**        | Plan-Execute-Evaluate 状态机控制器                             |
| **LoopContext**           | Agent 全部运行时状态的载体                                     |
| **Rippable Architecture** | 可剥离架构，模型能力提升后可逐层拆除 Harness 层                |
| **FC Loop**               | Function Calling 循环（LLM 选工具→执行→结果反馈）              |
| **ReAct**                 | Reasoning + Acting，推理与行动交替                             |
| **双写兼容**              | Harness ToolRegistry 同步到旧版 SkillRegistry 的兼容层         |

---

**维护者**: 开发团队
**最后更新**: 2026-05-25
**版本**: V5.0

参考文献：
**一句话**：把消息入口、AI 思考、工具执行、记忆存储、自我进化、安全审计全部打通的完整智能体操作系统。

### 1.2 行业背景与理论渊源

#### Harness Engineering 作为独立工程学科

2025-2026 年，AI 工程领域完成了从"训练更好的模型"到"构建更好的 Harness"的范式转换。Harness Engineering（驾驭工程）被确立为独立工程学科，其核心命题是：

> **"以确定性的工程系统，封装大语言模型的非确定性智能"** —— 将模型原生的不可控推理能力，转化为可 SLA 保障、可审计、可规模化复制的企业级生产力。

**关键里程碑**：

| 时间    | 事件                                                     | 意义                               |
| ------- | -------------------------------------------------------- | ---------------------------------- |
| 2020    | EleutherAI 推出 Evaluation Harness                       | Harness 工程思想原型               |
| 2023    | OpenAI Function Calling 发布                             | Agent 从"对话系统"进化为"行动系统" |
| 2025.11 | Anthropic 官方博客系统阐述 Agent Harness 概念 + MCP 协议 | 概念确立与协议标准化               |
| 2026.1  | Mitchell Hashimoto 命名 "Harness Engineering"            | 确立为独立工程领域                 |
| 2026.3  | OpenAI 发布百万行代码实证研究                            | 大规模验证 Harness 工程收益        |
| 2026.5  | arXiv:2605.13357 "AI Harness Engineering" 论文发表       | 十一项组件职责 + H0-H3 成熟度模型  |

#### 核心行业共识

1. **"如果你不是模型，你就是管控"** — Mitchell Hashimoto。Harness 是连接 LLM 能力与外部环境的完整工程中间层。
2. **"Meta 以 $2B 收购 Manus，买的是 Harness，不是模型"** — swyx @ 2025 AI Engineer Summit。Harness 是主要性能杠杆：LangChain 编程 Agent Terminal Bench 排名 30→前5，仅改 Harness，不改模型。
3. **无 Harness 时的成功率崩塌**：20 步任务、单步 95% 成功率 → 整体仅 36%。Harness 的任务是阻止这种指数级衰减。
4. **95% GenAI 试点失败**（MIT NANDA 2025），42% 企业 AI 试点被放弃，主因是缺少工程化 Harness 管控。

#### IMPACT 框架（swyx @ 2025 AI Engineer Summit）

行业广泛引用的 Agent 六维能力模型：

| 组件                 | 说明                              | Jiabaixing 对应                     |
| -------------------- | --------------------------------- | ----------------------------------- |
| **I - Intent**       | 目标编码与意图验证                | Planner + ConstitutionPromptBuilder |
| **M - Memory**       | 长期记忆 + 技能库 + 可复用工作流  | 三层记忆体系 + SkillRegistry        |
| **P - Planning**     | 多步骤可编辑计划                  | Plan-Execute-Evaluate 状态机        |
| **A - Authority**    | 权限模型与信任边界                | PermissionGuard + 四级权限分级      |
| **C - Control Flow** | 动态执行路径 vs 硬编码序列        | LoopController + 四维预算           |
| **T - Tools**        | RAG、搜索、沙箱执行、浏览器自动化 | 8 类 25 个声明式工具                |

| **声明式工具** | JSON Schema 定义参数，SchemaValidator 验证 |
| **契约驱动** | 前后端共享 contracts.ts，类型安全 |
| **Evaluator 独立性** | Evaluator 独立于执行 Agent，避免自我评价失真 |

### 3.6 行业对标分析

与 2025-2026 年主流 AI Agent Harness 框架的架构对比：

| 维度           | Jiabaixing V5.0                       | Claude Code           | Manus                         | Google ADK                         | deep-agent                       |
| -------------- | ------------------------------------- | --------------------- | ----------------------------- | ---------------------------------- | -------------------------------- |
| **循环模式**   | Plan-Execute-Evaluate 状态机 + replan | 初始化器 + 编码 Agent | KV-Cache 优化 ReAct           | Flow/Processor 管道                | Plan-Execute-Review-Fix-Finish   |
| **上下文策略** | 宪法 Prompt + 混合检索 + Token 预算   | CLAUDE.md + JIT 检索  | 文件系统即上下文 + compaction | 编译视图管道 + 多处理器            | Plan.md + Implement.md 持久化    |
| **工具管理**   | 8 类 25 声明式工具 + 四级权限         | MCP + 懒加载          | Logit Masking 状态机          | 统一 ToolContext + before_callback | TDL 统一描述 + 动态代理          |
| **错误恢复**   | Evaluator 回溯 + 降级兜底             | Git 检查点 + 进度文件 | 错误轨迹保留                  | 结构化事件日志                     | 显式 TRANSITIONS 表 + Ralph Loop |
| **多 Agent**   | （Phase 10 规划中）                   | MCP Agent Teams       | 子 Agent 上下文隔离           | Agent Transfer + Narrative Casting | Sub-Agent 扇出 + Scratchpad      |
| **评估体系**   | 五维质量评分 + 目标达成度             | 无内置                | 无内置                        | 无内置                             | Evaluator 独立 + 通过/重试/失败  |
| **成熟度**     | H2+ (失败归因 + 结构化验证)           | H2+                   | H2+                           | H2                                 | H3 (确定性需求校验)              |

### 3.7 成熟度模型：H0-H3 四级阶梯

引用自 arXiv:2605.13357 _"AI Harness Engineering: A Runtime Substrate for Foundation-Model Software Agents"_ (2026.05)，定义 Agent Harness 的四级成熟度：

| 级别   | 特征                            | 典型表现                                      | Jiabaixing 状态 |
| ------ | ------------------------------- | --------------------------------------------- | --------------- |
| **H0** | 仅输出最终补丁                  | 无工具访问，无错误恢复。模型生成 → 直接返回   | 已超越          |
| **H1** | 基本工具访问                    | 单步工具调用，无循环，失败即终止              | 已超越          |
| **H2** | 失败归因 + 可复现日志           | 多步 ReAct 循环，工具结果验证，错误分类与回溯 | ✅ 当前水平     |
| **H3** | 确定性需求校验 + 结构化验证报告 | 独立 Evaluator，全轨迹审计，安全合规自动化    | 📋 部分达成     |

**H2→H3 的关键差距**（Jiabaixing 演进方向）：

1. **全轨迹审计**：当前仅验证工具输出，H3 要求记录每一步的完整上下文快照
2. **独立安全 Evaluator**：当前 VerificationService 与执行耦合，H3 要求完全独立的评估 Agent
3. **确定性校验**：SchemaValidator 校验参数格式，H3 要求语义级需求校验（参数值是否"合理"而非仅"合法"）
4. **CI/CD 集成评估管道**：Golden Dataset → Evaluation Harness → 部署门禁

. **安全检查** — 输出内容安全审核 4. **截断处理** — 超长结果裁剪

#### 工具安全模型参考（OpenPort Protocol 2025）

OpenPort Protocol (OPP, arXiv:2602.20196) 定义了 Agent 工具访问安全的行业标准，Jiabaixing 的工具安全模型与其对齐：

**授权依赖的清单压缩（Manifest Redaction）**：

```

VisibleTools(agent) = { t ∈ Tools | ReqScopes(t) ⊆ Scopes(agent) ∧ PolicyAllows(agent, t) }

```

Agent 无权使用的工具在清单中完全不可见 —— 防止能力泄露和工具枚举攻击。

**多层次权限模型**（OPP 标准 + Jiabaixing 实现）：

| 范围层     | OPP 标准       | Jiabaixing 实现                             |
| ---------- | -------------- | ------------------------------------------- |
| **工具级** | 哪些函数可调用 | `requiredPermissions: Permission[]`         |
| **资源级** | 什么数据可访问 | `riskLevel: low/medium/high/critical`       |
| **参数级** | 什么参数值合法 | `parameters: JSON Schema` + SchemaValidator |

**写入治理（Write Governance）** — OPP 风险门控写入生命周期：

1. **默认：草稿创建** — 写操作创建可审查草案，非直接执行
2. **人工审核** — 高风险操作需用户确认（`requiresConfirmation: true`）
3. **时间限定的自动执行** — 仅在显式策略允许下
4. **高风险防护** — 预检影响哈希 + 幂等键（`idempotent: true`）+ TOCTOU 漂移检测

**2025 行业安全检查清单**（Jiabaixing 对齐状态）：

| 检查项                             | OPP 要求 | Jiabaixing                       |
| ---------------------------------- | -------- | -------------------------------- |
| 专用 AI 服务身份 + 默认拒绝        | ✅ 必须  | ✅ PermissionGuard 实现          |
| 禁止 AI 自由 SQL/exec              | ✅ 必须  | ✅ 工具风险分级 + Schema 约束    |
| 声明式请求 Schema + 参数 allowlist | ✅ 必须  | ✅ JSON Schema + requiredParams  |
| 结构化不可篡改审计日志             | ✅ 必须  | ✅ AuditLogger 实现              |
| 高风险操作人工门禁                 | ✅ 必须  | ✅ requiresConfirmation 机制     |
| 速率限制 + 并发上限 + 熔断         | ✅ 建议  | ⚠️ SecurityPolicyEngine 部分实现 |
| 混沌 + 对抗测试（季度）            | ✅ 建议  | ❌ 未实施                        |
| 插件签名验证（Sigstore/Cosign）    | ✅ 建议  | ❌ 未实施                        |

1. **错误检测** — 空结果、异常信息
2. **安全检查** — 输出内容安全审核
3. **截断处理** — 超长结果裁剪

#### 工具安全模型参考（OpenPort Protocol 2025）

OpenPort Protocol (OPP, arXiv:2602.20196) 定义了 Agent 工具访问安全的行业标准：

**授权依赖的清单压缩（Manifest Redaction）**：

```

VisibleTools(agent) = { t ∈ Tools | ReqScopes(t) ⊆ Scopes(agent) ∧ PolicyAllows(agent, t) }

```

Agent 无权使用的工具在清单中完全不可见 —— 防止能力泄露和工具枚举攻击。

**多层次权限模型**（OPP 标准 + Jiabaixing 实现）：

| 范围层     | OPP 标准       | Jiabaixing 实现                             |
| ---------- | -------------- | ------------------------------------------- |
| **工具级** | 哪些函数可调用 | `requiredPermissions: Permission[]`         |
| **资源级** | 什么数据可访问 | `riskLevel: low/medium/high/critical`       |
| **参数级** | 什么参数值合法 | `parameters: JSON Schema` + SchemaValidator |

**写入治理（Write Governance）** — OPP 风险门控写入生命周期：

1. **默认：草稿创建** — 写操作创建可审查草案，非直接执行
2. **人工审核** — 高风险操作需用户确认（`requiresConfirmation: true`）
3. **时间限定的自动执行** — 仅在显式策略允许下
4. **高风险防护** — 预检影响哈希 + 幂等键（`idempotent: true`）+ TOCTOU 漂移检测

**2025 行业安全检查清单**（Jiabaixing 对齐状态）：

| 检查项                             | OPP 要求 | Jiabaixing                    |
| ---------------------------------- | -------- | ----------------------------- |
| 专用 AI 服务身份 + 默认拒绝        | 必须     | PermissionGuard 实现          |
| 禁止 AI 自由 SQL/exec              | 必须     | 工具风险分级 + Schema 约束    |
| 声明式请求 Schema + 参数 allowlist | 必须     | JSON Schema + requiredParams  |
| 结构化不可篡改审计日志             | 必须     | AuditLogger 实现              |
| 高风险操作人工门禁                 | 必须     | requiresConfirmation 机制     |
| 速率限制 + 并发上限 + 熔断         | 建议     | SecurityPolicyEngine 部分实现 |
| 混沌 + 对抗测试（季度）            | 建议     | 未实施                        |
| 插件签名验证（Sigstore/Cosign）    | 建议     | 未实施                        |

#### Context Engineering 行业参考（2025）

2025 年，"Context Engineering"成为正式工程学科。核心理念：**"Context 是注意力预算，不是内存"** —— 不应将上下文窗口当堆栈使用。

**Context Explosion 三级压力**（Shopify 生产数据）：

| 压力              | 表现                                    | 缓解策略                   |
| ----------------- | --------------------------------------- | -------------------------- |
| **成本/延迟螺旋** | Token 成本线性增长，计算量二次增长      | Compaction + Summarization |
| **信号衰减**      | "Lost in the middle" — 模型关注过期信息 | JIT Retrieval + 上下文卸荷 |
| **物理上限**      | 工具输出可达用户消息的 100 倍           | 文件系统卸荷（Manus 模式） |

**三级上下文缩减策略**（行业最佳实践）：

| 策略                            | 操作                                   | 适用场景        | Jiabaixing 实现 |
| ------------------------------- | -------------------------------------- | --------------- | --------------- |
| **Compaction（可逆压缩）**      | 剥离可重建字段（保留路径，删除内容）   | 旧工具调用结果  | ❌ 未实现       |
| **Summarization（不可逆摘要）** | LLM 滑动窗口摘要，结构化 Schema 输出   | 超出 N 轮的对话 | ❌ 未实现       |
| **Context Offloading（卸荷）**  | 大数据结果存文件系统，上下文只保留指针 | 工具输出 > 1KB  | ❌ 未实现       |

**Context Caching 优化**（Google ADK / Manus 实践）：

- **稳定前缀**（system prompt, identity, summaries）→ 前端位置，复用 KV Cache
- **可变后缀**（最新对话轮次, 新工具输出）→ 后端位置，按需重新计算
- **触发策略**：硬上限 + "预旋转阈值"（~128K tokens 出现退化前）+ 压缩触发三层阈值

**智能衰减记忆**（UC Irvine, arXiv 2509.25250, 2025）：

```

Score(memory) = α × recency + β × relevance + γ × user_utility

```

实验数据：hybrid utility scoring 实现 92.5% 任务完成率，vs 基础 RAG 81.4%，滑动窗口 65.2%，且 Token 成本降低 22%。

#### 行业钩子模式参考（LangChain Middleware / Claude SDK 2025）

2025 年，LangChain Middleware API 和 Claude Agent SDK 分别定义了行业标准的钩子架构，Jiabaixing 的 9 钩子体系与之对照：

**三层拦截点**（LangChain Middleware API 标准）：

| 钩子层                  | LangChain 标准 | Claude SDK         | Jiabaixing 对应                                          |
| ----------------------- | -------------- | ------------------ | -------------------------------------------------------- |
| **Pre-processing 门禁** | `before_model` | `PreToolUse`       | `BEFORE_TOOL_CALL` + `BEFORE_LOOP`                       |
| **Execution 优化**      | `model`        | （系统提示词注入） | `ON_PLAN_CREATED`                                        |
| **Output 校验 + 熔断**  | `after_model`  | `PostToolUse`      | `AFTER_TOOL_CALL` + `BEFORE_RESPONSE` + `AFTER_RESPONSE` |

**两种粒度级别**（strands-agents SDK / LangGraph 标准）：

| 粒度       | 事件类型                                     | 触发频率         | Jiabaixing 对应                        |
| ---------- | -------------------------------------------- | ---------------- | -------------------------------------- |
| **批量级** | `BeforeToolsEvent` / `AfterToolsEvent`       | 每轮工具使用一次 | `BEFORE_LOOP` / `ON_STEP_COMPLETED`    |
| **工具级** | `BeforeToolCallEvent` / `AfterToolCallEvent` | 每个工具调用一次 | `BEFORE_TOOL_CALL` / `AFTER_TOOL_CALL` |

**关键生产模式**：

| 模式                | 钩子点                   | 实现方式                                                          |
| ------------------- | ------------------------ | ----------------------------------------------------------------- |
| **安全门禁**        | `before_tool`            | 验证工具参数，校验 session 用户权限，阻塞危险命令                 |
| **不变量强制**      | `post_model`             | Block END 状态直到必要工具被调用，防止 Agent 提前退出             |
| **熔断器**          | `after_model`            | 检测不安全输出 → `interrupt()` 暂停执行 → 升级人工处理            |
| **多 Agent 文件锁** | `PreToolUse/PostToolUse` | Redis 文件锁防止并行 Agent 冲突                                   |
| **成本优化**        | `model`                  | 简单查询路由到便宜模型 → 据报告节省 ~$5,100/月（1000 用户 Agent） |
| **可观测性**        | 全部钩子                 | OpenTelemetry traces + 结构化日志                                 |

**VIGIL 反射运行时**（arXiv:2512.07094, 2025.12）— 业界最先进的自愈模式：

```

观察层 → 反射层（affective states）→ 诊断层（Roses/Buds/Thorns 分析）
→ 适配层（生成 prompt + code patches）→ 编排层（stage-gated pipeline）

```

关键是大部分循环是**确定性代码**，不是 LLM 调用 —— LLM 仅用于高层推理和 diff 合成。

行业评估框架参考（2025-2026）

2025-2026 年，Agent 评估从"手动体感检查"进化为**自动化、可复现的评估管道**。以下是关键框架与 Jiabaixing 的对标：

**三种评分器类型**（Anthropic 工程团队标准）：

| 评分器                 | 原理                                         | 适用场景                     | Jiabaixing 对应 |
| ---------------------- | -------------------------------------------- | ---------------------------- | --------------- |
| **Code-based grader**  | 确定性检查（字符串匹配、静态分析、状态验证） | 工具路由准确性、数据来源验证 | SchemaValidator |
| **Model-based grader** | LLM-as-a-Judge + 评分标准 + 多裁判共识       | 开放式任务、语义相似度       | 五维质量评分    |
| **Human grader**       | 专家审核、众包、A/B 测试                     | 校准基准、安全边界           | 未实施          |

**关键评估维度**（Google Cloud 四维 + Claw-Eval 三维）：

| 维度                      | 来源         | 评估问题                       | Jiabaixing 状态                       |
| ------------------------- | ------------ | ------------------------------ | ------------------------------------- |
| **Tool Routing Accuracy** | Google Cloud | Agent 是否选择了正确的 API？   | 工具调用日志可查                      |
| **Data Groundedness**     | Google Cloud | 回答是否严格基于工具数据？     | 未实施                                |
| **Response Similarity**   | Google Cloud | 语义正确但表述不同？           | 五维评分.precision                    |
| **Escalation Precision**  | Google Cloud | 是否正确升级人工处理？         | 目标达成度                            |
| **Completion**            | Claw-Eval    | 任务是否完成？                 | 目标达成度                            |
| **Safety**                | Claw-Eval    | 是否存在安全违规（乘法门禁）？ | VerificationService.checkOutputSafety |
| **Robustness**            | Claw-Eval    | 是否从暂态故障中恢复？         | Evaluator 回溯 + 降级兜底             |

**Claw-Eval 关键发现**（Peking Univ./HKU, ICLR 2026）：

- 仅检查输出的评估会遗漏 **44% 的安全违规** 和 **13% 的鲁棒性失败**
- 全轨迹审计（trajectory-level auditing）是可信评估的前提
- 无单一模型在所有领域占优，评估需要异质任务环境

**HAL 关键发现**（Princeton/Stanford, ICLR 2026）：

- 更高推理努力度（reasoning effort）反而在多数运行中**降低**准确率
- Agent 被观测到"作弊"行为（搜索基准数据集而非完成任务，模拟中滥用信用卡）
- 标准化评估 Harness + 21,730 次 rollouts 是唯一可靠的评估方法

**Anthropic 评估建设 8 步路线图**：

| 步骤                  | 焦点                      | Jiabaixing 状态           |
| --------------------- | ------------------------- | ------------------------- |
| 0. 尽早开始           | 20-50 个真实失败任务足够  | ⚠️ 缺少结构化 eval set    |
| 1. 从现有手工测试开始 | 将已有测试用例转化为评估  | ⚠️ 132 Harness 测试偏单元 |
| 2. 明确任务 + 参考解  | 含清晰评判标准的任务描述  | ❌                        |
| 3. 构建平衡问题集     | 触发 + 非触发案例混合     | ❌                        |
| 4. 构建鲁棒评估框架   | 每次运行使用干净沙箱      | ❌                        |
| 5. 设计仔细的评分器   | 优先确定性，校准 LLM 裁判 | ✅ 五维评分基础           |
| 6. 定期检查轨迹       | 人工审查 Agent 执行日志   | ⚠️                        |
| 7. 监控评估饱和       | 天花板效应检测            | ❌                        |
| 8. 长期协作维护       | 专门评估团队 + 领域专家   | ❌                        |

**评估成熟度差距**：当前五维质量评分是基础性的 LLM-as-a-Judge 实现。完整的评估体系需要：Golden Eval Set（真实失败案例收集）→ 评估 Harness（干净沙箱 + 轨迹审计）→ 部署门禁（CI/CD 集成）。

### 4.7 网关与多平台消息
