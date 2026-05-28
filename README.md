# Jiabaixing 家百星 V5.0 智能助手

> Harness Agent Framework 六维管控智能体系统

## 快速启动

### 前置要求

- **Node.js**: `>=20.x`
- **npm**: 已安装
- **Ollama**（可选，用于本地 LLM）: `ollama serve`

### 启动步骤

```bash
# 1. 安装依赖（会自动重建 native 模块 better-sqlite3）
npm install

# 2. 启动后端 + 前端（推荐）
npm start
# 系统启动后，网关会自动初始化

# 3. 使用 CLI 配置网关（可选）
# 打开新终端，运行：
npm run cli

# 或分别启动
npm run start:backend   # 仅后端
npm run start:frontend  # 仅前端（需单独终端）
```

### 环境变量配置

根目录 `.env` 文件：

```env
PORT=3111
JWT_SECRET=your-secret-key
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b
ENABLE_DIRECT_EXECUTOR=true
QQ_ENABLED=false
```

### 访问地址

| 服务 | 地址 |
|------|------|
| 前端 | http://localhost:3000 |
| 后端 API | http://localhost:3111 |
| WebSocket | ws://localhost:3111 |

---

## V5.0 架构说明

### 六层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 6: Constraints   — 行为约束、预算控制、权限守卫       │
│  Layer 5: Verification  — 输出安全检查、结果验证            │
│  Layer 4: Persistence   — 任务状态、记忆、对话历史持久化     │
│  Layer 3: Context       — 动态上下文、Token预算分配         │
│  Layer 2: Tools         — 工具注册、执行、Schema验证       │
│  Layer 1: Loop          — Planner→Executor→Evaluator→Reporter│
└─────────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 文件 | 说明 |
|------|------|------|
| **AgentHarness** | `src/harness/AgentHarness.ts` | V5.0 入口，六层组件初始化 |
| **LoopController** | `src/harness/loop/LoopController.ts` | Plan-Execute-Evaluate 状态机 |
| **Executor** | `src/harness/loop/Executor.ts` | FC 循环，LLM 自主选择工具 |
| **Planner** | `src/harness/loop/Planner.ts` | 意图分析 + 执行计划生成 |
| **Evaluator** | `src/harness/loop/Evaluator.ts` | 目标达成度评估 |
| **Reporter** | `src/harness/loop/Reporter.ts` | 响应格式化 + 质量评分 |
| **ToolRegistry** | `src/harness/tools/registry/ToolRegistry.ts` | 19 个 Harness 专用工具 |
| **SkillRegistry** | `src/skills/SkillRegistry.ts` | 47 个技能 + 基础设施工具 |
| **ContextManager** | `src/harness/context/ContextManager.ts` | 上下文构建 + Token 管理 |
| **PersistenceService** | `src/harness/persistence/PersistenceService.ts` | 任务持久化到 `data/persistence/` |
| **VerificationService** | `src/harness/verification/VerificationService.ts` | 输出安全 + 敏感信息检测 |
| **ConstraintsService** | `src/harness/constraints/ConstraintsService.ts` | 预算控制 + 行为约束 |
| **OrchestratorAgent** | `src/harness/orchestration/OrchestratorAgent.ts` | Phase 10: 多Agent编排协调 |
| **TaskDispatcher** | `src/harness/orchestration/TaskDispatcher.ts` | Phase 10: DAG任务分发 |
| **ResultAggregator** | `src/harness/orchestration/ResultAggregator.ts` | Phase 10: 并行结果聚合 |
| **EvaluationPipeline** | `src/harness/evaluation/EvaluationPipeline.ts` | Phase 11: 自动评估管道 |
| **QualityScorer** | `src/harness/evaluation/QualityScorer.ts` | Phase 11: 五维质量评分 |
| **OptimizationFeedbackLoop** | `src/harness/evaluation/OptimizationFeedbackLoop.ts` | Phase 11: 优化闭环反馈 |

### 工具链

- **Harness 工具**: 19 个（记忆/认知/桌面/系统/文件/代码）
- **技能**: 47 个（find-skills, playwright, docs, refactor, web-search, agent-browser, batch, simplify, skill-creator 等）
- **MCP 工具**: filesystem, sqlite

### 数据流

```
用户输入 → WebSocket → JiabaixingCore → AgentHarness
    → ContextManager (构建上下文)
    → LoopController (Plan→Execute→Evaluate)
        → Planner (生成执行计划)
        → Executor (LLM自主选择工具，66个工具可选)
            → ToolRegistry / SkillRegistry
            → VerificationService (安全检查)
        → Evaluator (评估目标达成)
        → Reporter (生成响应)
    → 返回结果 → WebSocket → 前端
```

---

## 网关（WebSocket）

### 网关启动说明

网关会在系统启动时自动初始化，无需单独启动。网关由 `IntegrationManager` 管理，负责：
- 微信个人号登录（Playwright 扫码）
- 微信企业号/公众号 API
- QQ 机器人（Mirai）
- 飞书应用
- 钉钉应用

启动系统后，可以通过以下方式配置网关：

**方式 1：通过 CLI 配置（推荐）**
```bash
npm run cli
# 输入 gateway 进入网关配置菜单
```

**方式 2：通过前端界面配置**
打开浏览器访问 http://localhost:3000，在集成管理页面配置网关。

### 协议说明

| 项目 | 说明 |
|------|------|
| 地址 | `ws://localhost:3111` |
| 编码 | UTF-8 JSON |
| 去重 | 同一 traceId 5分钟内不重复处理 |
| 超时 | 8秒无响应发送温柔提示 |

### 客户端 → 服务端 消息类型

| type | 字段 | 说明 |
|------|------|------|
| `user_input` | `text` / `input` / `message` | 用户输入文本，任意字段兼容 |
| `command` | `text` | 命令输入，同 user_input |
| `get_status` | — | 查询服务状态 |
| `clarification_response` | `response` | 用户澄清回答 |
| `execution_confirm` | `confirmed: bool` | 执行确认/取消 |
| `automation_task_toggle` | `taskId`, `enabled` | 任务启用/禁用 |
| `automation_task_create` | `task` | 创建自动化任务 |
| `automation_trigger_execute` | `trigger` | 触发自动化执行 |

### 服务端 → 客户端 消息类型

| type | 字段 | 说明 |
|------|------|------|
| `connected` | `message`, `model`, `status`, `timestamp` | 连接成功 |
| `status` | `status`, `model`, `uptime`, `clients` | 服务状态 |
| `response` | `response`, `traceId`, `intent` | 处理结果 |
| `error` | `message`, `traceId` | 错误信息 |

### 前端 → WebSocket 示例

```javascript
// 连接
const ws = new WebSocket('ws://localhost:3111');

ws.onopen = () => {
  console.log('已连接');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.type}]`, data);
};

// 发送消息（支持多种字段格式）
ws.send(JSON.stringify({
  type: 'user_input',
  text: '帮我创建一个测试文件',
  userId: 'test-user'
}));

// 查询状态
ws.send(JSON.stringify({ type: 'get_status' }));
```

### 后端处理流程

```
WebSocket 消息
    ↓
processInputWithCore()
    ↓
JiabaixingCore.processInput()
    ↓
AgentHarness.processInput()
    ↓
EventBus.emit('response_ready')
    ↓
eventBusSetup broadcast()
    ↓
WebSocket 广播到所有客户端
```

### 17 个 EventBus → WebSocket 广播事件

| 事件 | 触发时机 |
|------|----------|
| `response_ready` | 处理完成 |
| `tool_trace` | 工具调用 |
| `thinking_update` | LLM 思考更新 |
| `planning_update` | 规划更新 |
| `memory_recalled` | 记忆检索 |
| `tool_started` | 工具开始执行 |
| `tool_completed` | 工具执行完成 |
| `tool_failed` | 工具执行失败 |
| `loop_started` | 循环开始 |
| `loop_completed` | 循环完成 |
| `loop_iteration` | 循环迭代 |
| `intent_detected` | 意图识别 |
| `verification_result` | 验证结果 |
| `constraint_check` | 约束检查 |
| `constitution_violation` | 宪法违规 |
| `schedule_triggered` | 定时触发 |
| `automation_triggered` | 自动化触发 |

---

## CLI 命令行工具

### 说明

CLI 是独立的命令行工具，通过 HTTP API 与后端服务通信。**使用前需要先启动后端服务**（通过 `npm start` 或 `npm run start:backend`）。

CLI 已集成到主系统架构中，但运行在独立进程，负责：
- 网关配置（微信/QQ/飞书/钉钉）
- 定时任务管理
- 系统配置
- 终端聊天

### 启动

```bash
# 确保后端已启动后，运行
npm run cli
```

### 主菜单命令

| 命令 | 说明 |
|------|------|
| `gateway` / `gw` | 进入网关配置（微信/QQ/飞书/钉钉） |
| `qq` | QQ 快速连接（Mirai） |
| `schedule` / `sched` | 定时任务 & 自动化管理 |
| `config` / `cfg` | 系统配置管理 |
| `daemon` / `svc` | 后台常驻服务控制 |
| `chat` / `c` | 进入终端聊天模式 |
| `status` / `st` | 查看各平台连接状态 |
| `web` / `w` | 打开前端界面 |
| `help` | 显示主菜单 |
| `quit` / `exit` / `q` | 退出 CLI |

### 网关配置子菜单

```
gateway > 1     # 微信扫码登录（个人微信）
gateway > 2     # 微信企业号/公众号 API
gateway > 3     # QQ 机器人（Mirai）
gateway > 4     # 飞书（App 凭证）
gateway > 5     # 钉钉（Client 凭证）
gateway > list  # 查看各平台连接状态
gateway > back  # 返回主菜单
```

**微信扫码**：`Playwright` 打开 wx.qq.com 获取二维码，手机微信扫码

**QQ (Mirai)**：需先在 Mirai Console 登录，再填入 HTTP 地址 + verifyKey + QQ号

**飞书/钉钉**：填入 App ID + App Secret

### 定时任务子菜单

```
schedule > list     # 查看所有任务状态
schedule > add      # 添加新定时任务 (输入 cron 表达式)
schedule > toggle   # 启用/禁用任务
schedule > run      # 手动执行一个任务
schedule > triggers # 查看主动触发器队列
schedule > patterns # 查看用户行为模式
schedule > back    # 返回主菜单
```

**内置 4 个默认定时任务**：

| 任务 | Cron | 说明 |
|------|------|------|
| 早安简报 | `0 8 * * *` | 每天早上 8:00 |
| 情绪检查 | `*/30 * * * *` | 每 30 分钟 |
| 任务提醒 | `*/15 * * * *` | 每 15 分钟 |
| 行为分析 | `0 2 * * *` | 每天凌晨 2:00 |

### 配置管理子菜单

```
config > show   # 显示当前所有配置（敏感值隐藏）
config > env    # 编辑 .env 文件
config > model  # 查看 LLM 模型配置
config > back   # 返回主菜单
```

### 后台服务子菜单

```
daemon > start   # 启动后端服务（后台）
daemon > stop    # 停止后端服务
daemon > restart # 重启后端服务
daemon > status  # 查看详细状态
daemon > logs    # 查看最近日志
daemon > back    # 返回主菜单
```

### 聊天模式

```
chat > 你好，帮我搜索一下项目中的工具文件
chat > /quit     # 返回主菜单
chat > /gateway  # 进入网关配置
chat > /help     # 显示聊天命令帮助
```

### CLI 交互示例

```
jiabaixing > gateway
  ┌──────────────────────────────────────┐
  │         GATEWAY 网关配置              │
  ├──────────────────────────────────────┤
  │  1. 微信  (扫码登录个人微信) 🟢       │
  │  2. 微信  (企业号/公众号 API)         │
  │  3. QQ    (Mirai 扫码+密码登录) 🐧    │
  │  4. 飞书  (App凭证)     ✈️            │
  │  5. 钉钉  (Client凭证)  📌            │
  │                                      │
  │  list    查看各平台连接状态           │
  │  back    返回主菜单                   │
  └──────────────────────────────────────┘

  gateway > list

  ┌──────────────────────────────────────────┐
  │            平台连接状态                   │
  ├──────────────────────────────────────────┤
  │  ⚪ 微信个人  disconnected              │
  │  ⚪ 微信企业  disconnected              │
  │  ⚪ QQ      disconnected              │
  │  ⚪ 飞书    disconnected              │
  │  ⚪ 钉钉    disconnected              │
  └──────────────────────────────────────────┘

  gateway > back
jiabaixing > chat

  Jiabaixing CLI  v2.0
  AI Agent  ·  终端交互版

  💬 进入聊天模式 (输入 /quit 返回菜单)

  You > 你好
  AI  > 你好！有什么可以帮助你的吗？
```

---

## 测试指南

### 1. WebSocket 连接测试

打开浏览器控制台，连接 WebSocket：

```javascript
const ws = new WebSocket('ws://localhost:3111');

// 发送消息
ws.send(JSON.stringify({
  type: 'user_input',
  text: '你好，帮我搜索一下项目中的工具文件',
  userId: 'test-user'
}));

// 接收消息
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('收到:', data.type, data);
};
```

### 2. REST API 测试

```bash
# 健康检查
curl http://localhost:3111/api/core/health

# 工具使用统计
curl http://localhost:3111/api/debug/tool-usage

# 技能列表
curl http://localhost:3111/api/skill/list

# 进化指标
curl http://localhost:3111/api/evolution/metrics
```

### 3. 单元测试

```bash
npm test                           # 运行所有测试
npm run test:watch                # 监听模式
npm run test:coverage             # 覆盖率报告
npm run test:integration          # 集成测试
```

**Harness 专项测试**（共 10 个文件）：

```bash
npm test -- --grep "Harness"          # Harness 集成测试
npm test -- --grep "loop"             # 循环层测试
npm test -- --grep "tools"            # 工具层测试
npm test -- --grep "verification"     # 验证层测试
npm test -- --grep "persistence"      # 持久化层测试
```

### 4. V5.0 功能验证清单

- [ ] **LLM 自主选择**: 输入"帮我创建一个测试文件"，观察 Executor 是否自主调用 file/incremental_edit 工具
- [ ] **权限控制**: 未经授权用户只能使用只读工具（MEMORY_READ, FILE_READ）
- [ ] **任务持久化**: 重启后任务状态从 `data/persistence/task-states.json` 恢复
- [ ] **Token 预算**: 大量工具调用后消息自动压缩
- [ ] **安全验证**: 工具输出经过 VerificationService 检查
- [ ] **66 工具**: LLM 可看到全部 Harness 工具 + SkillRegistry 技能

---

## 目录结构

```
jiabaixing/
├── src/
│   ├── harness/              # V5.0 Harness Agent Framework
│   │   ├── AgentHarness.ts   # 入口
│   │   ├── loop/             # Layer 1: 循环层
│   │   ├── tools/            # Layer 2: 工具层
│   │   ├── context/          # Layer 3: 上下文层
│   │   ├── persistence/      # Layer 4: 持久化层
│   │   ├── verification/     # Layer 5: 验证层
│   │   ├── constraints/      # Layer 6: 约束层
│   │   ├── orchestration/    # Phase 10: 多Agent编排
│   │   └── evaluation/       # Phase 11: 自评估与优化
│   ├── skills/               # 技能系统
│   │   └── SkillRegistry.ts  # 技能注册中心
│   ├── core/                 # 核心模块
│   │   └── JiabaixingCore.ts # V5.0 统一架构核心
│   ├── server/               # 服务端
│   │   ├── websocket.ts      # WebSocket 处理
│   │   └── eventBusSetup.ts # EventBus → WebSocket 桥接
│   ├── llm/                  # LLM 集成
│   ├── mcp/                  # MCP 服务器
│   ├── frontend/             # React 前端
│   └── models/               # 数据模型
├── tests/                    # 测试文件
│   ├── harness/              # Harness 专项测试
│   ├── integration/          # 集成测试
│   └── e2e/                 # 端到端测试
├── data/                     # 运行时数据
│   ├── persistence/         # 任务持久化（V5.0 新增）
│   ├── evolution/            # 进化指标
│   └── memory/               # 记忆存储
├── .env                      # 环境变量
└── package.json
```

---

## 常见问题

### 1. 启动失败：better-sqlite3

```bash
npm run fix:native
npm start
```

### 2. LLM 不可用

系统会以降级模式运行，无 LLM 时仅支持直接命令执行。

### 3. 端口占用

修改 `.env` 中的 `PORT=3111` 为其他端口。

### 4. 前端构建失败

```bash
cd src/frontend
npm install
npm start
```

---

## 开发指南

### 代码规范

```bash
npm run lint        # 检查代码
npm run format      # 格式化代码
npm run check       # 完整检查（lint + format + test）
```

### 编译

```bash
npm run build       # 生产构建
npm run build:fast  # 快速构建（跳过类型检查）
```

---

**版本**: 5.0.0
**更新日期**: 2026-05-27
**架构**: Harness Agent Framework 六维管控 + 多Agent编排 + 自评估
