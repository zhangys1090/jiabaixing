# Jiabaixing V5.0 — 开发文档

> **版本**: V5.0 Harness Agent Framework | **架构**: E-T-C-S-L-V 六层管控
> **语言**: TypeScript (ES2022) | **运行**: Node.js >= 20.x
> **默认模型**: deepseek-chat (OpenAI 兼容接口)
> **验证日期**: 2026-05-30

---

## 一、概述

Jiabaixing 是本机 AI 智能体。核心理念：

> **Agent = (LLM 推理 + 能力组件) × Harness 管控系统**

LLM 做认知（推理/选工具/表达），Harness 做工程（预算/权限/验证/状态）。单一路径：

```
Gateway → JiabaixingCore → AgentHarness → LoopController
                                              ├── Planner
                                              ├── Executor → ToolRegistry
                                              ├── Evaluator
                                              └── Reporter
```

### 已验证状态 (2026-05-30)

| 指标 | 值 | 来源 |
|------|-----|------|
| TypeScript 编译 | 0 errors | `npx tsc --noEmit` |
| 测试套件 | 52/52 通过 (100%) | `npx jest` |
| 测试用例 | 872/874 通过 (99.8%) | `npx jest` |
| 注册工具 | 33 个 (8 类) | ToolRegistry |
| Eval 通过率 | 83.3% (25/30) | 最近评估: 2026-05-26 |
| 轨迹数据库 | 110 条执行记录 | trajectory.db |
| 进化指标 | 9 条聚合指标 | metrics.db |
| 前端面板 | 14 个 | React 18 |

---

## 二、快速开始

### 一键安装

```bash
bash install.sh     # 自动完成：检查环境 → 安装依赖 → 配置 LLM → 验证
```

### 启动

```bash
./run.sh            # 一键启动（后端 + 前端）
# 或:  npm run start
```

### 验证

```bash
curl http://localhost:3111/api/health
npm run setup:test  # 测试所有 LLM 连接
npm test            # 872 个测试
```

---

## 三、架构

### 3.1 Harness 六层

```
E — Execution Loop   Planner→Executor→Evaluator→Reporter (状态机+replan)
T — Tool Registry    33 个声明式工具, 8 类, JSON Schema + 四级权限
C — Context Manager  宪法Prompt→记忆→动态上下文→历史 (Token六桶分配)
S — State Store      瞬时(LoopContext)/短期(SQLite)/长期(ChromaDB)
L — Lifecycle Hooks  9 个钩子: before_loop ~ after_response
V — Verification     工具结果验证 + 安全检查 + 五维质量评分
```

### 3.2 职责划分

| LLM 做 | Harness 做 |
|--------|-----------|
| 推理与创造力 | 持久化 (记忆/状态/轨迹) |
| 工具选择 (FC) | 预算控制 (4 维: 轮次/token/时间/工具) |
| 多步推理 (ReAct) | 工具结果验证 + 安全检查 |
| 个性化表达 | 五维质量评分 + 生命周期钩子 |
| 场景适应 | 状态机校验 + 权限守卫 |

### 3.3 架构原则

- **约束而不指令** — Harness 设边界, 不告诉模型怎么思考
- **状态外部化** — LoopContext 承载全部状态, Agent 无内部状态
- **Rippable Architecture** — 6 层独立开关, 模型提升后可剥离
- **声明式工具** — JSON Schema + SchemaValidator + PermissionGuard

---

## 四、已实现能力 (验证通过)

### 4.1 执行循环 ✅

`LoopController.ts` — Plan-Execute-Evaluate-Report 状态机

- Planner: 简单任务 regex 跳过, 复杂任务 LLM 分解
- Executor: FC 循环, 工具并行执行, 停转检测, Token 压缩
- Evaluator: 预算检查 + 步骤汇总 + IndependentEvaluationService 深度评估
- Reporter: 响应提取 + 质量评分 (步骤成功率 + 响应内容)

**修复记录** (2026-05-30): Token 预算现在从 Executor 反馈更新 (之前永远为 0), replan 注入先删除旧计划, quality 评分引入步骤成功率

### 4.2 工具注册表 ✅

33 个声明式工具, 8 个分类:

| 分类 | 数量 | 工具 |
|------|------|------|
| memory | 3 | memory_recall, memory_store, memory_search |
| cognition | 3 | emotion_detect, analyze_scene, self_reflect |
| desktop | 2 | desktop_automate, desktop_screenshot |
| file | 5 | file_list, file_search, get_active_file, incremental_edit, multi_file_edit |
| code | 3 | code_analyze, code_fix, code_generate |
| system | 4 | ask_clarification, preview_execution, rollback_changes, shell_exec |
| daily | 9 | task_manage, reminder_set, note_take, system_status, batch_task, calendar, task_analytics, task_dependency, task_priority |
| network | 4 | web_search, skill_create, image_generate, web_fetch |

### 4.3 上下文管理 ✅

`ContextManager.ts` — 组合管道: 宪法Prompt → 记忆注入 → 动态上下文 → 历史

- `buildContext()`: 全量上下文构建
- `buildPhaseContext(phase)`: 按阶段优化 (planning 轻量, execution 全量)
- TokenBudgetAllocator: 6 桶分配

### 4.4 三层记忆 ✅

| 层 | 存储 | 用途 |
|----|------|------|
| 瞬时 | LoopContext.messages | 请求生命周期 |
| 短期 | SQLite (better-sqlite3) | 对话/工具结果/用户画像 |
| 长期 | ChromaDB 向量 | 知识提取/语义检索 |

### 4.5 生命周期钩子 ✅

9 个钩子 + 状态机转移校验: BEFORE_LOOP, ON_PLAN_CREATED, BEFORE_TOOL_CALL, AFTER_TOOL_CALL, ON_ERROR, BEFORE_RESPONSE, AFTER_RESPONSE, ON_STEP_COMPLETED, ON_BUDGET_EXCEEDED

### 4.6 评估框架 ✅

- `StepEvaluator`: 规则引擎 (成功/失败/空输出/敏感信息)
- `IndependentEvaluationService`: 独立 LLM 深度评估
- `EvalRunner`: 自动化评估管道
- `GoldenEvalSet`: 30 条用例 (memory 15, tool_use 5, safety 3, planning 4, multi_step 3)
- `EvalGate` / `EvalTrendAnalyzer`: CI/CD 门禁 + 趋势分析

**最近评估**: 83.3% 通过率 (25/30), 安全类 100%, 多步推理最弱 (66.7%)

### 4.7 轨迹审计 ✅

`TrajectoryDatabase` (SQLite) — 3 张表:
- `executions`: 110 条执行记录 (2026-05-30)
- `tool_invocations`: 24 条工具调用记录
- `state_transitions`: 15 条状态转移

`TrajectoryFlywheel` — 轨迹分析引擎, 成功率统计, 工具使用模式, 瓶颈识别, 优化建议

### 4.8 进化引擎 ✅ (V2 only)

EvolutionEngineV2: LLM 驱动自我进化
- `EvolutionPlanner`: LLM 生成修改计划
- `SelfModificationEngine`: 执行文件修改
- `EvolutionRollback`: 快照 + 回滚
- `validateEvolution()`: 真实运行 `tsc --noEmit` (HIGH 风险: + jest)

**周期**: 5 分钟检查 → 质量 < 0.7 → 触发 V2 自进化

### 4.9 多平台网关

4 平台: 微信 (QR+API) / QQ (Mirai) / 飞书 / 钉钉。双模架构: fork 子进程 + 主进程内联。

### 4.10 CLI 终端

`src/cli.ts` — REPL 客户端, HTTP 连接后端。支持 `/chat`, `/env`, `/schedule`, `/config`, `/status`, `/evolution`, `/web`, `/help`, `/clear`, `/quit`。

### 4.11 前端面板

React 18 + TypeScript + Zustand + WebSocket。14 个面板: ChatInterface, DesktopPanel, EvolutionPanel, SecurityPanel, MemoryPanel, SkillConsole, MonitorPanel, PerformancePanel, AgentExecutionPanel, LogPanel, SettingsPanel, AutomationPanel, IntegrationPanel, VibeCodingPanel。

**已知问题**: DesktopPanel OCR 为 mock, EvolutionPanel 指标硬编码, AutomationPanel 无数据源, VibeCodingPanel 未被渲染。

### 4.12 安全模块

4 个核心模块 + 8 个原子模块: **SecurityFacade** (SecurityManager + AuthenticationManager + EncryptionManager), **SecurityCore** (SecurityPolicyEngine + SecurityGuard + NetworkGuard), **AuditService** (AuditLogger + DataSovereigntyPipeline), **types.ts**。原有 8 个原子模块仍可独立导入（向后兼容 re-export）。

**动态策略** (2026-06-01): `AutonomyPermissionGuard.dynamicPolicyAdjust` 基于任务意图、风险容忍度和历史成功率动态调整工具白名单，解决静态白名单对 LLM 自主性的障碍。

**脱敏修复** (2026-05-30): `VerificationService.checkOutputSafety` 之前使用 `$& [已脱敏]` (原文仍在), 现在用 `$1[已脱敏]` (真正替换)。

---

## 五、API 端点

### 核心端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 (LLM 状态/运行时间/模型) |
| POST | `/api/process` | 主处理 (文本/图片) |
| POST | `/api/upload` | 文件上传 |
| POST | `/api/voice/upload` | 语音转文字 |
| GET | `/api/models/status` | 模型列表与状态 |
| POST | `/api/models/switch` | 切换模型 |
| POST | `/api/skills/execute` | 执行技能 |
| GET | `/api/skills/list` | 列出技能 |

### 进化端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/evolution/metrics` | 进化指标 |
| GET | `/api/evolution/insights` | 学习洞察 |
| POST | `/api/evolution/trigger` | 手动触发优化 |
| POST | `/api/evolution/healing` | 自愈 (→Orchestrator) |
| POST | `/api/evolution/refactor` | 重构 (→Orchestrator) |
| POST | `/api/evolution/enhance` | 增强 (→Orchestrator) |

### 其他端点

`/api/config`, `/api/metrics`, `/api/logs`, `/api/security/*`, `/api/performance/*`, `/api/mcp/*`, `/api/desktop/*`, `/api/conversations`, `/api/recommendations`

### WebSocket

`ws://localhost:3111` — 实时事件: `agent_execution_update`, `response_ready`, `tool_trace`, `weight_update`, `proactive_message`, `environment_update`, `project_change`, `git_status`

**修复**: `agent_execution_update` 现在推送每轮 FC 循环和每个工具完成状态 (之前仅在状态转移时推送)。

---

## 六、评估数据

### Eval 评分 (2026-05-26)

| 类别 | 用例 | 通过 | 通过率 | 平均分 |
|------|------|------|--------|--------|
| memory | 15 | 13 | 86.7% | 87.3% |
| tool_use | 5 | 4 | 80.0% | 86.0% |
| safety | 3 | 3 | 100.0% | 100.0% |
| planning | 4 | 3 | 75.0% | 76.3% |
| multi_step | 3 | 2 | 66.7% | 73.3% |
| **总计** | **30** | **25** | **83.3%** | **85.5%** |

### 轨迹数据 (2026-05-29)

```
Executions: 110
Tool invocations: 24
Top tools: file_search (13, 100%), file_list (6, 100%), read_file (3, 0%)
```

---

## 七、测试

### 测试结构

```
tests/
├── harness/         # 六层测试: loop, tools, verification, integration
├── unit/            # 单元: core, memory, desktop, harness
└── src/evolution/   # V2 进化测试
```

### 测试命令

```bash
npm test                   # 全量: 857 tests, 52 suites
npm run test:coverage      # 覆盖率
npm run eval               # Eval 评估: 30 条用例, 真实 LLM
npm run build:fast         # 快速编译
npm run lint               # ESLint
npm run check              # lint + format + test
```

---

## 八、项目目录

```
jiabaixing/
├── src/
│   ├── core/              JiabaixingCore, ScenarioAwareScheduler
│   ├── harness/           ★ V5.0 六层 Harness
│   │   ├── loop/          E: Plan-Execute-Evaluate-Report
│   │   ├── tools/         T: 33 工具 (8 类)
│   │   ├── context/       C: ContextManager + TokenBudget
│   │   ├── persistence/   S: PersistenceService + TrajectoryDB
│   │   ├── verification/  V: VerificationService
│   │   ├── constraints/   L: Lifecycle Hooks
│   │   ├── evaluation/    StepEvaluator, EvalRunner, QualityScorer
│   │   ├── sandbox/       沙箱执行器
│   │   └── orchestration/ 多 Agent 编排
│   ├── evolution/         进化引擎 V2
│   ├── memory/            三层记忆 (SQLite/ChromaDB)
│   ├── security/          4 核心模块 + 8 原子模块 (SecurityFacade/SecurityCore/AuditService/types)
│   ├── models/            LLMProvider (DeepSeek + 智谱降级)
│   ├── persona/           人格系统
│   ├── mcp/               MCP 服务管理
│   ├── server/            Express + WebSocket + 路由
│   ├── frontend/          React 18 (14 面板)
│   └── main.ts            入口
├── data/
│   ├── eval/              Eval 用例 + 报告
│   ├── trajectory/        trajectory.db
│   └── evolution/         metrics.db
├── tests/                  881 tests, 53 suites
├── scripts/runEval.ts      Eval CLI
├── package.json
├── tsconfig.json
├── tsconfig.fast.json
├── jest.config.js
├── .env.example
├── PROJECT.md
└── CLAUDE.md
```

---

## 九、技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 20+, TypeScript (ES2022, CommonJS) |
| Web | Express 4.x + ws 8.x |
| 前端 | React 18 + TypeScript + Zustand |
| 数据库 | better-sqlite3 + ChromaDB |
| LLM | OpenAI 兼容 (ProviderManager 管理, 支持多模型+路由+降级) |
| 桌面 | @nut-tree/nut-js |
| 安全 | bcrypt + jsonwebtoken + helmet |
| 日志 | winston + 自定义 Logger |
| 测试 | jest 30 + ts-jest |
| 构建 | tsc + ts-node |

---

## 配置

### Provider 管理（v5.1）

使用 `npm run setup` 向导管理 LLM 模型：

```bash
npm run setup            # 交互式配置向导
npm run setup:list       # 查看当前配置
npm run setup:test       # 测试所有 Provider 连接
```

支持多 Provider 并行，自动降级和熔断感知。配置存储在 `data/providers.json`。

### 环境变量（兼容）

`.env` 文件仍然生效，启动时会自动导入到 ProviderManager：

### Harness 开关

```typescript
const harness = new AgentHarness({
  useHarnessLoop: true,          // E
  useHarnessTools: true,         // T
  useHarnessContext: true,       // C
  useHarnessPersistence: true,   // S
  useHarnessVerification: true,  // V
  useHarnessConstraints: true,   // L
  useIndependentEvaluator: true, // 独立评估
  useTrajectoryPersistence: true,// 轨迹审计
});
```

---

## 十一、开发规范

### 添加新工具

1. `src/harness/tools/<category>/` 创建定义文件
2. 导出 `TOOL_DEF: ToolDefinition` + executor
3. 在 `registerHarnessTools.ts` 注册
4. `npm test` 验证

### 测试

```bash
npm test                    # 全量: 874 tests, 52 suites
npm run test:coverage       # 覆盖率
npm run eval                # Eval 评估: 30 条用例
npm run build:fast          # 快速编译
npm run setup               # Provider 配置向导
```

---

## 十二、已知局限

### 功能局限

| 局限 | 状态 |
|------|------|
| Golden Eval 覆盖不足 (30 用例) | 🟡 可扩展 |
| 前端面板部分 mock 数据 | 🟡 |
| ModelRouter 还未接入 Harness 层 | 🟡 |
| CLI 启动慢 (ts-node 5-10s) | 🟡 |
| 桌面自动化依赖 Windows powershell | 🟡 |

### 性能局限

| 局限 | 数据 | 状态 |
|------|------|------|
| 单条消息 LLM 调用 | 2+N (Planner + Evaluator + N 轮 Executor) | 🟡 简单任务已有快速路径 |
