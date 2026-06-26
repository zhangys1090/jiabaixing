# 家百星 V5.0 功能使用指南

> 版本: 1.0 | 日期: 2026-06-16
> 本文档说明 20 项 Hermes 增强特性在 CLI / 网关 / 前端 三个入口的具体用法

---

## 一、三入口架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        用户层                               │
├──────────────┬──────────────────┬──────────────────────────┤
│   CLI 入口   │    网关入口      │      前端入口            │
│  (终端交互)   │  (多平台消息)    │    (Web UI)             │
├──────────────┼──────────────────┼──────────────────────────┤
│ src/cli.ts   │ gatewayWorker.ts │ React (src/frontend/)    │
│ REPL/管道    │ Telegram/Discord │ localhost:3111           │
│ /slash cmd   │ /Slack/微信      │ WebSocket 实时           │
├──────────────┴──────────────────┴──────────────────────────┤
│                    统一核心层                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            JiabaixingCore / InteractionEngine       │   │
│  │         HookManager ← LLM Function Calling           │   │
│  │         AgentHarness (E-T-C-S-L-V 六层)             │   │
│  └─────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                      LLM 层                                │
│  MultiModelLLMProvider → ProviderManager → OpenAI/DeepSeek  │
└─────────────────────────────────────────────────────────────┘
```

### 入口特性对比

| 特性     | CLI                  | 网关          | 前端            |
| -------- | -------------------- | ------------- | --------------- |
| 交互模式 | REPL / 管道 / 子命令 | 异步消息      | WebSocket       |
| 审批流程 | 阻塞等待             | 非阻塞 + 回调 | 弹窗 + 确认     |
| 工具执行 | 同步                 | 异步          | 异步            |
| 实时反馈 | 终端输出             | 平台消息      | SSE / WebSocket |
| 上下文   | 终端会话             | 跨平台        | Web 会话        |

---

## 二、CLI 入口 — 功能用法

### 入口文件

- `src/cli.ts` → `src/cli/index.ts` (REPL + 子命令)

### 2.1 交互模式

```bash
# 交互式 REPL
npm start

# 管道模式（cat file.txt | npm start）
cat query.txt | npm start

# 子命令模式
npm run cli -- slash /help
```

### 2.2 核心功能用法

#### @引用系统

```
$ @src/main.ts  # 自动展开文件内容注入上下文
$ @docs/        # 展开目录结构
$ @https://...  # 展开 URL 内容
$ @git_diff     # 展开 Git 差异
```

**原理**: `ContextReferenceResolver.resolve()` 在 `ContextManager.buildContext()` 中被调用，自动解析 `@` 引用并内联到 LLM 上下文。

#### 子 Agent 委派

```
/delegate 创建用户注册功能
```

**参数**:

```json
{
  "goal": "创建用户注册功能",
  "context": "当前项目是 React + TypeScript",
  "tools": ["file_write", "code_generate"],
  "max_concurrent": 3
}
```

**原理**: `delegate_task` 工具在 Harness T 层注册，委托给 `BatchProcessor` 并发执行多个子 Agent。

#### 代码沙箱执行

```
/execute python "print('hello world')"
```

```json
{
  "language": "python",
  "code": "import math; print(math.sqrt(16))",
  "callback_tools": ["file_write", "shell_exec"]
}
```

**原理**: `execute_code` 工具在沙箱中执行代码，支持 Python/JS，通过 `hermes.call()` 回调 Agent 工具。

#### Hook 系统（无直接用户命令，但自动生效）

- `beforeToolCall`: 文件修改工具调用前自动创建检查点
- `afterToolCall`: 工具执行后记录指标
- `onToolError`: 错误时触发告警

#### 批处理

```bash
# CLI 无直接命令，但 API 可用
curl -X POST http://localhost:3111/api/batch/run \
  -H "Content-Type: application/json" \
  -d '{"prompts": [{"text": "任务1"}, {"text": "任务2"}], "format": "sharegpt"}'
```

#### 技能渐进披露

```
/skill web 开发
```

**原理**: `SkillRegistry.getSkillSummaries()` 返回所有技能摘要，ContextManager 按需 `expandSkillSection()` 展开完整技能内容。

#### 检查点回滚

```
/rollback  # 列出检查点
/rollback auto-before-file_write  # 回滚到文件修改前
```

**原理**: `CheckpointService.createCheckpoint()` 在 Executor 中自动调用（针对 file_write/incremental_edit 等工具），`rollback_changes` 工具调用 `rollback()`。

#### 浏览器自动化

```json
{
  "instruction": "打开 Google 搜索 '家百星'",
  "connection_mode": "local" // local | cdp | browserbase
}
```

#### 图像生成

```json
{
  "prompt": "一只可爱的熊猫在竹林里",
  "model": "flux-pro" // flux-klein | flux-pro | gpt-image | ideogram-v3 | recraft-v4 | qwen
}
```

#### TTS 多提供商

```json
{
  "text": "你好，有什么可以帮助你的？",
  "provider": "edge" // edge | elevenlabs | openai | azure
}
```

**原理**: `SpeechSynthesizer` 优先使用 `TTSProviderRegistry`，无 Registry 时降级内置合成。

#### OpenAI 兼容 API

```bash
curl http://localhost:3111/v1/models
curl -X POST http://localhost:3111/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-chat", "messages": [{"role": "user", "content": "你好"}]}'
```

#### ACP IDE 集成

```bash
# IDE 通过 /api/ide/chat 发送请求
curl -X POST http://localhost:3111/api/ide/chat \
  -d '{"message": "帮我写一个函数", "sessionId": "vscode-001"}'
```

#### 皮肤主题

```bash
# CLI 主题通过 ThemeManager 设置
# 环境变量或配置文件
THEME=dark  # default | dark | minimal | colorful
```

#### 凭证池

**无直接命令，自动生效**: `MultiModelLLMProvider.generate()` 从 `CredentialPool.getNext()` 获取 API Key，失败时自动切换。

---

## 三、网关入口 — 功能用法

### 入口文件

- `src/integration/gatewayWorker.ts`

### 3.1 交互模式

```
用户在 Telegram/Discord/微信/Slack 发送消息
  → IntegrationManager 接收
  → gatewayWorker.ts 通过 WebSocket 转发到核心
  → 核心处理后通过 IntegrationManager 回复
```

### 3.2 核心功能用法

| 消息示例                                | 触发的功能                         |
| --------------------------------------- | ---------------------------------- |
| `@src/utils/logger.ts 帮我分析这段代码` | ContextReferenceResolver (@引用)   |
| `/delegate 帮我重构 auth 模块`          | delegate_task 批量模式             |
| `@git_diff`                             | Git 差异展开                       |
| `用 Python 写个快速排序`                | execute_code 沙箱                  |
| 任意工具调用                            | HookManager (before/after/onError) |
| 批量查询                                | BatchProcessor (API)               |

### 3.3 网关特有功能

#### 多平台统一上下文

- 网关消息自动携带平台标识 (`source: 'telegram' | 'discord' | 'slack'`)
- Hook 系统在网关层可注册 `gateway` 类型 Hook，实现跨平台日志/监控

```typescript
// 网关 Hook 示例
hookManager.register({
  id: 'gateway-logger',
  event: 'afterToolCall',
  handler: async (ctx) => {
    await sendToPlatformWebhook(ctx);
    return ctx;
  },
  type: 'gateway', // 网关层 Hook
});
```

#### 插件系统 (Gateway Hook)

- Gateway Hook 类型: 日志/告警/外部 webhook
- 在 `IntegrationManager` 初始化时注册

---

## 四、前端入口 — 功能用法

### 入口文件

- `src/frontend/` (React + Vite)
- API: `http://localhost:3111`

### 4.1 交互模式

```
用户浏览器 → React App → WebSocket (ws://localhost:3111)
                    ↓
              HTTP REST API
                    ↓
              核心层处理
```

### 4.2 核心功能用法

#### WebSocket 实时交互

- 连接: `ws://localhost:3111`
- 发送: `{ type: 'user_input', input: '...', source: 'frontend' }`
- 接收: 实时 token 流 + 工具调用事件

#### 审批流程 (前端特有)

```
工具调用 → 需要审批 → WebSocket 推送 'approval_request'
                        ↓
                  前端弹窗 → 用户确认/拒绝
                        ↓
                  POST /api/approval/respond
```

#### Hook 系统 (前端可见)

- 工具调用事件通过 WebSocket 实时推送
- 前端可订阅 `tool_start` / `tool_complete` / `tool_error` 事件

#### OpenAI 兼容 API (前端调用)

```typescript
// 前端通过 fetch 调用
const res = await fetch('http://localhost:3111/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-chat', messages: [...] })
});
```

#### ACP IDE 集成 (前端可用)

```typescript
// 订阅 IDE diff 事件
socket.on('ide_diff', (data: { sessionId: string; diff: string }) => {
  // 在前端渲染 diff
});
```

### 4.3 前端特有功能

#### 多模态输入

- 支持图片上传 → 自动注入 `images` 字段 → LLM 多模态处理

#### 实时指标展示

- WebSocket 推送 `token_usage` / `loop_count` / `tool_metrics`

---

## 五、LLM 反馈链路（核心链路）

### 5.1 完整链路

```
用户输入
  ↓
入口层 (CLI/Gateway/Frontend)
  ↓
WebSocket/HTTP → JiabaixingCore
  ↓
InteractionEngine.buildContext()
  ├─ ContextReferenceResolver (@引用解析)
  ├─ SkillRegistry.getSkillSummaries() (渐进披露)
  ├─ ContextFileRegistry (多格式上下文文件)
  └─ AgentHarness.buildContext() (E-T-C-S-L-V)
  ↓
LLM.generate() → Function Calling
  ↓
AgentHarness.runFCLoop()
  ├─ HookManager.beforeToolCall()
  ├─ Executor.executeTool()
  │   ├─ 文件修改工具 → CheckpointService.createCheckpoint() (自动)
  │   ├─ 工具执行 → HookManager.afterToolCall()
  │   └─ 错误 → HookManager.onToolError()
  ├─ ToolCallGuard (权限校验)
  └─ LoopController (循环控制)
  ↓
LLM 接收工具结果 → 继续生成
  ↓
响应 → 入口层
  ├─ CLI: stdout
  ├─ Gateway: IntegrationManager 回复平台
  └─ Frontend: WebSocket 推送
```

### 5.2 Hook 事件链路

| 事件             | 触发时机    | 典型用途             |
| ---------------- | ----------- | -------------------- |
| `beforeToolCall` | 工具执行前  | 自动检查点、参数校验 |
| `afterToolCall`  | 工具执行后  | 指标记录、结果修改   |
| `onToolError`    | 工具异常    | 告警、回滚           |
| `beforeLoop`     | FC 循环开始 | 上下文准备           |
| `afterLoop`      | FC 循环结束 | 结果汇总             |
| `onLoopError`    | 循环异常    | 错误恢复             |
| `beforePlan`     | 规划开始    | 约束注入             |
| `afterPlan`      | 规划结束    | 计划验证             |

### 5.3 工具 → LLM → 工具循环

```
LLM: "我需要读取文件 src/main.ts"
  ↓ 生成 function_call: file_read
AgentHarness.executeTool(file_read)
  ↓
HookManager.beforeToolCall(file_read)
  ↓
Executor.executeTool(file_read)
  ↓
HookManager.afterToolCall(result)
  ↓
LLM 接收结果: "文件内容如下..."
  ↓ 继续生成
```

### 5.4 三入口反馈差异

| 环节     | CLI         | 网关                    | 前端           |
| -------- | ----------- | ----------------------- | -------------- |
| LLM 输出 | stdout 流式 | IntegrationManager 回复 | WebSocket 推送 |
| 工具结果 | 终端打印    | 平台消息                | UI 日志区      |
| 审批     | 阻塞输入    | 后台 + webhook          | 弹窗           |
| 错误     | stderr      | 错误消息                | 告警 banner    |

---

## 六、快速索引

| 功能       | CLI 命令                | API 端点                         | WebSocket 事件              |
| ---------- | ----------------------- | -------------------------------- | --------------------------- |
| @引用      | `@file` / `@git_diff`   | —                                | —                           |
| 子Agent    | `/delegate`             | `POST /api/tools/delegate_task`  | —                           |
| 沙箱       | `/execute python "..."` | `POST /api/tools/execute_code`   | —                           |
| Hook       | 自动生效                | —                                | `tool_start/complete/error` |
| 批处理     | —                       | `POST /api/batch/run`            | —                           |
| 技能       | `/skill <name>`         | —                                | —                           |
| 上下文文件 | 自动加载                | —                                | —                           |
| 检查点     | `/rollback`             | —                                | —                           |
| 浏览器     | —                       | `POST /api/tools/browser_agent`  | —                           |
| 图像生成   | —                       | `POST /api/tools/image_generate` | —                           |
| TTS        | —                       | `POST /api/tools/tts_speak`      | —                           |
| OpenAI API | —                       | `POST /v1/chat/completions`      | —                           |
| ACP IDE    | —                       | `POST /api/ide/chat`             | —                           |
| 主题       | `THEME=dark`            | —                                | 前端设置                    |
| 凭证池     | 自动                    | —                                | —                           |
| 插件       | —                       | `POST /api/plugins/...`          | —                           |
