# 家百星（jiabaixing）后端功能与 3 入口集成关系分析报告

---

## 输出1：后端功能 vs 3入口覆盖度矩阵

### 发现：后端 API 端点总览

| #   | 文件                                       | 路由注册方式                     | 端点                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/server/routes/chatRoutes.ts`          | Router                           | `POST /api/chat`                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | `src/server/routes/coreRoutes.ts`          | `registerCoreRoutes()`           | `GET /api/health`, `GET /api/models`, `GET /api/models/status`, `GET /api/models/health`, `POST /api/models/switch`, `POST /api/process`, `GET /api/evolution`, `POST /api/correct`, `GET /api/logs/stream`(SSE), `POST /api/desktop/screenshot`, `POST /api/desktop/automate`                                                                                                                          |
| 3   | `src/server/routes/automationRoutes.ts`    | Router                           | `GET /api/automation/tasks`, `POST /api/automation/tasks`, `PATCH /api/automation/tasks/:taskId/toggle`, `POST /api/automation/tasks/:taskId/execute`, `GET /api/automation/triggers`, `GET /api/automation/patterns`                                                                                                                                                                                   |
| 4   | `src/server/routes/contextManageRoutes.ts` | `registerContextManageRoutes()`  | `GET /api/context/list`, `POST /api/context/refresh`, `POST /api/context/load`, `POST /api/context/create`, `GET /api/context/read/:fileName`                                                                                                                                                                                                                                                           |
| 5   | `src/server/routes/debugRoutes.ts`         | `registerDebugRoutes()`          | `GET /api/debug/weights`, `GET /api/debug/recentHistory`, `GET /api/debug/tool-usage`, `POST /api/simulate_task`                                                                                                                                                                                                                                                                                        |
| 6   | `src/server/routes/docsRoutes.ts`          | `registerDocsRoutes()`           | `GET /llms.txt`, `GET /llms-full.txt`, `GET /api/docs/index`, `POST /api/docs/generate`, `GET /docs/*`(静态)                                                                                                                                                                                                                                                                                            |
| 7   | `src/server/routes/evolutionRoutes.ts`     | `registerEvolutionRoutes()`      | `GET /api/evolution/metrics`, `GET /api/evolution/insights`, `POST /api/evolution/trigger`, `GET /api/orchestrator/metrics`, `POST /api/orchestrator/optimize`, `POST /api/evolution/cycle`, `POST /api/evolution/healing`, `POST /api/evolution/refactor`, `POST /api/evolution/enhance`                                                                                                               |
| 8   | `src/server/routes/integrationRoutes.ts`   | Router                           | `GET /api/integration/wechat/qrcode`, `GET /api/integration/platforms`, `GET /:platform/status`, `POST /:platform/connect`, `POST /:platform/disconnect`, `POST /:platform/webhook`, `POST /:platform/send`, `GET /api/integration/system-status`, `POST /api/integration/webhooks`, `DELETE /api/integration/webhooks/:id`, `GET /api/integration/webhooks`, `POST /api/integration/webhooks/:id/test` |
| 9   | `src/server/routes/mcpRoutes.ts`           | `registerMCPRoutes()`            | `GET /api/mcp/servers`, `GET /api/mcp/servers/:name`, `POST /api/mcp/servers/:name/start`, `POST /api/mcp/servers/:name/stop`, `POST /api/mcp/servers/start-all`, `GET /api/mcp/servers/:name/tools`, `POST /api/mcp/servers/:name/call`, `POST /api/mcp/servers/:name/message`, `POST /api/mcp/register`                                                                                               |
| 10  | `src/server/routes/memoryRoutes.ts`        | `registerMemoryRoutes()`         | `POST /api/memory/store`, `GET /api/memory/search`, `GET /api/memory/profile`, `POST /api/memory/preferences`                                                                                                                                                                                                                                                                                           |
| 11  | `src/server/routes/orchestrateRoutes.ts`   | Router                           | `POST /api/orchestrate`, `POST /api/evaluate`                                                                                                                                                                                                                                                                                                                                                           |
| 12  | `src/server/routes/performanceRoutes.ts`   | `registerPerformanceRoutes()`    | `GET /api/performance/snapshot`, `GET /api/performance/metrics`, `GET /api/performance/errors`, `GET /api/llm/performance`, `POST /api/performance/metrics`                                                                                                                                                                                                                                             |
| 13  | `src/server/routes/securityRoutes.ts`      | `registerSecurityRoutes()`       | `GET /api/security/logs`, `GET /api/security/events`, `GET /api/security/report`, `POST /api/security/validate`, `GET /api/security/audit`                                                                                                                                                                                                                                                              |
| 14  | `src/server/routes/skillRoutes.ts`         | Router + `registerSkillRoutes()` | `POST /api/skills/execute`, `GET /api/skills/list`                                                                                                                                                                                                                                                                                                                                                      |
| 15  | `src/server/routes/systemRoutes.ts`        | Router                           | 服务管理: `GET/POST /api/system/service/*`; 审批门控: `GET/PUT/POST /api/system/approval/*`; 工作流: `GET/POST/DELETE /api/system/workflows/*`; 热键: `GET/PUT/POST /api/system/hotkeys/*`; 托盘: `GET/PUT/POST /api/system/tray/*`                                                                                                                                                                     |
| 16  | `src/server/routes/systemStateRoutes.ts`   | Router                           | `GET /api/system/resources`, `GET /api/memory/stats`, `GET /api/metrics`, `GET /api/logs/errors`, `GET /api/logs`, `GET /api/config`, `GET /api/evolution/status`, `GET /api/system/integrity`, `POST /api/error/monitoring`, `GET /api/conversations`, `POST /api/user-behavior/events`, `GET /api/recommendations`, `POST /api/optimization/process`, `GET /api/optimization/history`                 |
| 17  | `src/server/routes/taskRoutes.ts`          | Router                           | `POST /api/tasks/create`, `GET /api/tasks/list`, `POST /api/tasks/:id/cancel`, `POST /api/tasks/:id/pause`, `POST /api/tasks/:id/resume`, `GET /api/harness/status`                                                                                                                                                                                                                                     |
| 18  | `src/server/routes/traeRoutes.ts`          | `registerTraeRoutes()`           | `GET /api/trae/health`, `GET /api/trae/performance`, `GET /api/trae/mcp/status`, `GET /api/trae/skills/status`, `POST /api/trae/skills/execute`, `POST /api/trae/security/audit`, `POST /api/trae/testing/generate`                                                                                                                                                                                     |

### WebSocket 事件

**服务端 WebSocket 入口**: `src/server/websocket/index.ts`

- 接收的客户端事件（`client → server`）：`user_input` / `command`, `cancel_task`, `get_status`, `clarification_response`, `execution_confirm`, `automation_task_toggle`, `automation_task_create`, `automation_trigger_execute`
- 发送的服务端事件（`server → client`）：由 `src/server/eventBusSetup.ts` 通过 `EventBus → Ws` 桥接所有事件

**完整 WS 事件类型**（定义于 `src/shared/contracts.ts`）：

- 客户端→服务端：`user_input`, `command`, `get_status`, `clarification_response`, `execution_confirm`, `cancel_task`
- 服务端→客户端：`connected`, `response_ready`, `response`, `error`, `status`, `proactive_message`, `weight_update`, `agent_execution_update`, `perception_update`, `brain_stage_update`, `skill_execution_update`, `evolution_event`, `clarification_request`, `execution_preview`, `file_modified`, `file_rollback`, `multi_file_modified`, `tool_trace`, `server_log`, `user_correction`, `thinking`, `processing_status`, `task_cancelled`, `asr_result`, `tts_chunk`, `dialog_state`, `cancel`, `environment_update`, `project_change`, `git_status`, `stream_start`, `stream_chunk`, `stream_done`

### 覆盖度矩阵

| 后端功能分类         | REST API 端点                                                                                            | WS 事件                                       | CLI 能用              | 网关能用                        | 前端能用       |
| -------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------- | ------------------------------- | -------------- |
| **对话处理**         | POST /api/chat, POST /api/process                                                                        | user_input/command → response_ready           | ✅ (直接 fetch + IPC) | ✅ (core.processInput 直接调用) | ✅ (WS + REST) |
| **健康检查**         | GET /api/health                                                                                          | —                                             | ✅                    | ❌                              | ✅             |
| **模型管理**         | GET /api/models, GET /api/models/status, GET /api/models/health, POST /api/models/switch                 | —                                             | ❌                    | ❌                              | ✅             |
| **用户纠正**         | POST /api/correct                                                                                        | user_correction                               | ❌                    | ❌                              | ✅ (WS + REST) |
| **日志流(SSE)**      | GET /api/logs (SSE)                                                                                      | server_log                                    | ❌                    | ❌                              | ✅ (SSE+WS)    |
| **日志查询**         | GET /api/logs, GET /api/logs/errors                                                                      | —                                             | ❌                    | ❌                              | ✅             |
| **日志(文件读取)**   | GET /api/logs/errors, GET /api/logs?file=                                                                | —                                             | ❌                    | ❌                              | ✅             |
| **桌面截图**         | POST /api/desktop/screenshot                                                                             | —                                             | ❌                    | ❌                              | ✅             |
| **桌面自动化**       | POST /api/desktop/automate                                                                               | —                                             | ❌                    | ❌                              | ✅             |
| **记忆存储**         | POST /api/memory/store                                                                                   | —                                             | ❌                    | ❌                              | ✅             |
| **记忆搜索**         | GET /api/memory/search                                                                                   | —                                             | ❌                    | ❌                              | ✅             |
| **用户画像**         | GET /api/memory/profile, POST /api/memory/preferences                                                    | —                                             | ❌                    | ❌                              | ✅             |
| **记忆统计**         | GET /api/memory/stats                                                                                    | —                                             | ✅ (仅 stats)         | ❌                              | ✅             |
| **进化指标**         | GET /api/evolution/metrics, GET /api/evolution/insights                                                  | evolution_event                               | ✅ (metrics+status)   | ❌                              | ✅             |
| **进化触发**         | POST /api/evolution/trigger, POST /api/evolution/cycle, POST /api/evolution/healing/refactor/enhance     | —                                             | ❌                    | ❌                              | ✅             |
| **进化状态**         | GET /api/evolution/status                                                                                | —                                             | ✅                    | ❌                              | ✅             |
| **编排器指标**       | GET /api/orchestrator/metrics, POST /api/orchestrator/optimize                                           | —                                             | ❌                    | ❌                              | ✅             |
| **多Agent编排**      | POST /api/orchestrate                                                                                    | —                                             | ❌                    | ❌                              | ✅             |
| **自评估**           | POST /api/evaluate                                                                                       | —                                             | ❌                    | ❌                              | ✅             |
| **技能执行**         | POST /api/skills/execute                                                                                 | skill_execution_update                        | ✅                    | ❌                              | ✅             |
| **技能列表**         | GET /api/skills/list                                                                                     | —                                             | ✅                    | ❌                              | ✅             |
| **自动化任务(CRUD)** | GET/POST /api/automation/tasks                                                                           | automation_task_toggle/create/trigger_execute | ✅                    | ❌                              | ✅             |
| **自动化触发器**     | GET /api/automation/triggers                                                                             | —                                             | ✅                    | ❌                              | ✅             |
| **自动化行为模式**   | GET /api/automation/patterns                                                                             | —                                             | ✅                    | ❌                              | ✅             |
| **任务(跨会话)**     | POST/GET /api/tasks/\*                                                                                   | task_cancelled                                | ❌                    | ❌                              | ✅             |
| **性能快照**         | GET /api/performance/snapshot                                                                            | —                                             | ❌                    | ❌                              | ✅             |
| **性能指标**         | GET/POST /api/performance/metrics                                                                        | —                                             | ❌                    | ❌                              | ✅             |
| **性能错误**         | GET /api/performance/errors                                                                              | —                                             | ❌                    | ❌                              | ✅             |
| **LLM性能**          | GET /api/llm/performance                                                                                 | —                                             | ❌                    | ❌                              | ✅             |
| **安全日志**         | GET /api/security/logs                                                                                   | —                                             | ❌                    | ❌                              | ✅             |
| **安全事件**         | GET /api/security/events                                                                                 | —                                             | ❌                    | ❌                              | ✅             |
| **安全报告**         | GET /api/security/report                                                                                 | —                                             | ❌                    | ❌                              | ✅             |
| **安全验证**         | POST /api/security/validate                                                                              | —                                             | ❌                    | ❌                              | ✅             |
| **安全审计**         | GET /api/security/audit                                                                                  | —                                             | ❌                    | ❌                              | ✅             |
| **上下文管理**       | GET /api/context/list, POST /api/context/refresh/load/create, GET /api/context/read/:fileName            | —                                             | ✅                    | ❌                              | ❌             |
| **系统资源**         | GET /api/system/resources                                                                                | —                                             | ❌                    | ❌                              | ✅             |
| **系统完整性**       | GET /api/system/integrity                                                                                | —                                             | ❌                    | ❌                              | ✅             |
| **系统指标**         | GET /api/metrics                                                                                         | —                                             | ❌                    | ❌                              | ✅             |
| **系统配置**         | GET /api/config                                                                                          | —                                             | ❌                    | ❌                              | ✅             |
| **系统服务管理**     | GET/POST /api/system/service/\*                                                                          | —                                             | ❌                    | ❌                              | ❌             |
| **审批门控**         | GET/PUT/POST /api/system/approval/\*                                                                     | —                                             | ❌                    | ❌                              | ❌             |
| **工作流管理**       | GET/POST/DELETE /api/system/workflows/\*                                                                 | —                                             | ❌                    | ❌                              | ❌             |
| **热键管理**         | GET/PUT/POST /api/system/hotkeys/\*                                                                      | —                                             | ❌                    | ❌                              | ❌             |
| **托盘管理**         | GET/PUT/POST /api/system/tray/\*                                                                         | —                                             | ❌                    | ❌                              | ❌             |
| **集成平台管理**     | GET /api/integration/platforms, POST /:platform/connect/disconnect/send/webhook                          | —                                             | ❌                    | ✅ (直接调用)                   | ✅             |
| **微信二维码**       | GET /api/integration/wechat/qrcode                                                                       | —                                             | ❌                    | ✅                              | ✅             |
| **Webhook管理**      | POST/DELETE/GET /api/integration/webhooks                                                                | —                                             | ❌                    | ✅                              | ✅             |
| **MCP服务器管理**    | GET/POST /api/mcp/servers/\*                                                                             | —                                             | ❌                    | ❌                              | ✅             |
| **TRAE优化**         | GET/POST /api/trae/\*                                                                                    | —                                             | ❌                    | ❌                              | ✅             |
| **文档生成**         | GET /llms.txt, GET /api/docs/index, POST /api/docs/generate                                              | —                                             | ❌                    | ❌                              | ✅             |
| **调试**             | GET /api/debug/weights, GET /api/debug/recentHistory, GET /api/debug/tool-usage, POST /api/simulate_task | —                                             | ❌                    | ❌                              | ✅             |
| **对话历史**         | GET /api/conversations                                                                                   | —                                             | ❌                    | ❌                              | ✅             |
| **用户行为事件**     | POST /api/user-behavior/events                                                                           | —                                             | ❌                    | ❌                              | ✅             |
| **推荐**             | GET /api/recommendations                                                                                 | —                                             | ❌                    | ❌                              | ✅             |
| **错误监控**         | POST /api/error/monitoring                                                                               | —                                             | ❌                    | ❌                              | ✅             |
| **优化处理**         | POST /api/optimization/process, GET /api/optimization/history                                            | —                                             | ❌                    | ❌                              | ✅             |

---

## 输出2：交互架构图（ASCII）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          家百星 V5.0 系统架构                                │
└─────────────────────────────────────────────────────────────────────────────┘

        ┌─────── IPC (Named Pipe) ──────────┐
        │   fallback: HTTP REST (localhost)  │
        ▼                                    │
┌──────────────┐                    ┌────────┴───────────┐
│              │                    │                    │
│   CLI 入口   │──── HTTP ────────►│                    │
│  src/cli.ts  │  POST /api/process │                    │
│              │  GET /api/health   │                    │
│              │  GET/POST /api/    │                    │
│              │  automation/tasks  │                    │
│              │  GET /api/skills/* │                    │
│              │  GET /api/memory/  │                    │
│              │    stats           │                    │
│              │  GET /api/         │                    │
│              │    evolution/*     │                    │
│              │  GET/POST /api/    │                    │
│              │    context/*       │                    │
│              │  POST /api/chat    │                    │
│              │                    │                    │
│  IPC: ping,  │                    │    ┌───────────────┴──────────────┐
│  get_status  │                    │    │   Express HTTP Server        │
│  ...         │                    │    │   (src/server/bootstrap.ts)  │
└──────────────┘                    │    │                              │
                                    │    │  Routes (18 route files)     │
                                    │    │  ┌──────────────────────┐    │
        ┌─────── HTTP REST ─────────┤    │  │ chatRoutes           │    │
        │                           │    │  │ coreRoutes           │    │
        ▼                           │    │  │ automationRoutes     │    │
┌──────────────┐                    │    │  │ contextManageRoutes  │    │
│              │                    │    │  │ debugRoutes          │    │
│  前端 Web    │──── WS (ws://)─────►    │  │ docsRoutes           │    │
│  React App   │  user_input        │    │  │ evolutionRoutes      │    │
│  (src/       │  cancel_task       │    │  │ integrationRoutes    │    │
│   frontend/) │  get_status        │    │  │ mcpRoutes            │    │
│              │  clarification_    │    │  │ memoryRoutes         │    │
│              │    response        │    │  │ orchestrateRoutes    │    │
│              │  execution_confirm │    │  │ performanceRoutes    │    │
│              │                    │    │  │ securityRoutes       │    │
│  REST: all   │  ◄── server events ────┤  │ skillRoutes          │    │
│  60+ API     │  response_ready    │    │  │ systemRoutes         │    │
│  端点       │  agent_execution_  │    │  │ systemStateRoutes    │    │
│             │    update           │    │  │ taskRoutes           │    │
│             │  ... (30+ events)   │    │  │ traeRoutes           │    │
│             │                    │    │  └──────────────────────┘    │
│  SSE also   │                    │    │                              │
│  /api/logs  │                    │    └──────────────────────────────┘
└──────────────┘                    │                   │
                                    │                   │ core.processInput()
                                    │                   ▼
        ┌─────── IPC (child_process.fork) ──────┐  ┌──────────────────────┐
        │   OR in-process direct call (fallback) │  │  JiabaixingCore     │
        ▼                                        │  │  (src/core/)        │
┌─────────────────┐                              │  │                      │
│                 │                              │  │  LLM → Models       │
│  网关 Worker    │── IPC (process.send/message)─►  │  Memory Engine      │
│  (独立进程)     │  connect/disconnect          │  │  Harness            │
│  src/integration│  sendMessage                 │  │  Evolution Engine   │
│  /gatewayWorker │  getPlatforms                │  │  Skill Registry     │
│                 │  getStatus                   │  │  EventBus           │
│  平台适配器:    │  handleWebhook              │  └──────────────────────┘
│  WeChat         │  getWeChatQRState            │
│  Feishu         │                              │
│  DingTalk       │                              │
│  QQ             │                              │
│  Telegram       │                              │
│  Discord        │                              │
│  Slack          │                              │
│                 │                              │
│  webhook:       │  ◄── EventBus events ────────┤
│  integration_   │  (integration_message)       │
│     message     │                              │
└─────────────────┘                              │
                                                 │
        ┌────────── 直接函数调用 ──────────────────┤
        │  (in-process, same memory space)        │
        ▼                                         │
┌────────────────┐                                │
│ Integration    │── core.processInput() ─────────►│
│ Manager        │                                  │
│ (inline mode)  │                                  │
└────────────────┘                                  │
                                                    │
        ┌────────── EventBus ───────────────────────┤
        ▼                                           │
┌──────────────────────────┐                        │
│  eventBusSetup.ts        │◄── EventBus events ────┤
│                          │                        │
│  EventBus → WebSocket     │                        │
│  broadcast (wss.clients) │                        │
│                          │                        │
│  EventBus → Webhooks     │                        │
│  (integration webhooks)  │                        │
└──────────────────────────┘                        │
                                                    │
            WebSocket Server (ws://)
            (src/server/websocket/)
            - WsProcessor (输入处理+重试+超时)
            - WsAuth (认证)
            - WsRateLimit (限流+熔断)
            - WsDedup (去重)
            - WsTaskManager (任务管理)
            - WsRetry (重试)
```

---

## 输出3：关键发现

### 1. 通信方式不统一（同一功能多个入口走不同通道）

| 功能              | CLI                              | 网关                                    | 前端                                              | 问题                                 |
| ----------------- | -------------------------------- | --------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| **对话/消息处理** | IPC + HTTP (`POST /api/process`) | 直接 `core.processInput()` (in-process) | WebSocket `user_input` + REST `POST /api/process` | **三入口三种方式**，无统一消息路由层 |
| **平台连接/管理** | ❌ 无法调用                      | IPC (fork进程间通信) + 直接调用         | REST `POST /:platform/connect`                    | 网关走IPC，前端走REST，两套API       |
| **自动化任务**    | HTTP REST (直接fetch)            | ❌ 无法调用                             | REST + WS (`automation_task_*`)                   | CLI和前端都走REST但WS只有前端能用    |
| **调用后端方式**  | IPC优先→HTTP降级                 | IPC (fork) + 直接调用                   | WebSocket + fetch                                 | 三种入口三种通信模式                 |

### 2. 集成缺口（功能只有部分入口能访问）

**只有前端能访问的功能（约40+端点）**：

- 模型管理（切换模型、状态查询）
- MCP服务器管理
- TRAE优化系统
- 安全审计/验证/报告
- 性能监控（快照/指标/错误）
- 桌面截图/自动化
- 审批门控、工作流管理、热键、托盘
- 系统服务安装/管理
- 文档生成
- 对话历史、推荐、用户行为事件
- 错误监控、优化处理记录
- 记忆存储/搜索/画像/偏好

**只有CLI能访问的功能**：

- 上下文管理 (`/api/context/*`) — CLI专用

**只有网关能访问的功能**：

- 平台消息接收处理（WeChat/DingTalk/QQ/Telegram等平台的消息接收）

**三个入口都能访问的核心功能**：

- 对话处理 (`processInput` 核心方法)

**三个入口都不能直接通过REST访问的功能**：

- 系统服务管理（`/api/system/service/*`）— **注**: 前端apiService中未找到对应调用，但API已在systemRoutes中定义
- 审批门控、工作流、热键、托盘 — API已定义但前端没有直接UI调用

### 3. CLI的IPC与HTTP双通道设计

CLI 采用 **IPC优先 + HTTP降级** 策略：

- **IPC**: 通过 Named Pipe (`\\.\pipe\jiabaixing`) 或 Unix Domain Socket (`/tmp/jiabaixing.sock`) 发送 JSON Lines 请求
- **HTTP**: 降级到 `http://localhost:3111` 的 REST API
- IPC 方法包括: `ping`, `get_status`, `chat`, `process`, `skills_list`, `skills_execute`, `memory_stats`, `evolution_status`, `evolution_metrics`, `automation_tasks`, `automation_task_toggle`, `automation_task_execute`, `automation_triggers`, `automation_patterns`, `context_list`, `context_refresh`, `context_create`, `context_read`
- 但服务端IPC处理端未在代码中找到实现（没有 `net.createServer` 处理 IPC 请求的代码）— **IPC 可能尚未在服务端实现**，因此CLI始终降级到HTTP

### 4. 网关的双重模式（Worker vs Inline）

`GatewayBridge` 支持两种运行模式：

- **隔离Worker模式**: `child_process.fork()` 启动独立进程运行 `gatewayWorker.ts`，通过 `process.send/on('message')` 进行IPC通信
- **内联降级模式**: 当Worker不可用时，直接调用 `IntegrationManager.getInstance()` 的方法

GatewayBridge的IPC消息类型：`connect`, `disconnect`, `sendMessage`, `getPlatforms`, `getStatus`, `getWeChatQRState`, `handleWebhook`, `ping`

### 5. WebSocket事件类型远多于WS处理器

- 前端定义的事件监听器类型：27种（包括 `agent_execution_update`, `perception_update`, `brain_stage_update`, `skill_execution_update`, `evolution_event`, `clarification_request`, `execution_preview`, `file_modified`, `file_rollback`, `multi_file_modified`, `tool_trace`, `server_log`, `user_correction`, `processing_status`, `task_cancelled`, `environment_update`, `project_change`, `git_status`, `stream_start/chunk/done` 等）
- 但服务端 `eventBusSetup.ts` 中实际注册的事件广播器只有约20种，与EventBus事件的桥接可能不完全

### 6. 建议的优化点

1. **统一消息路由层**：当前 CLI/网关/前端 三套通信方式调用同一核心功能(`processInput`)，应抽象一个统一的消息路由层（如 `MessageRouter`），消除重复的调用代码。

2. **完成服务端IPC实现**：CLI 的 IPC 通道在服务端没有对应实现 (`net.createServer` 处理请求的代码缺失)，建议在 `src/server/bootstrap.ts` 或 `main.ts` 中添加 IPC Server 支持，让 CLI 真正利用 IPC 的低延迟优势。

3. **前端开发现代化管理功能**：`/api/system/service/*`, `/api/system/approval/*`, `/api/system/workflows/*`, `/api/system/hotkeys/*`, `/api/system/tray/*` 这些 API 已定义但前端没有对应UI，是未完成的集成缺口。

4. **网关与前端共享集成管理 API**：当前网关通过 IPC 调用集成功能，前端通过 REST API，应当统一为通过 REST API 访问，减少重复的实现路径。

5. **WebSocket 事件治理**：前端定义了 27+ 种 WS 事件类型，但实际服务端事件总线注册的事件类型不完整，建议做一次全面的 EventBus ↔ WS 事件映射审计，确保所有事件双向桥接。

6. **CLI 能力扩展**：当前 CLI 只能访问约 16 个核心端点（health, process, skills, memory/stats, evolution/status, evolution/metrics, automation/_, context/_, chat），还有约 40+ 个端点未能通过 CLI 访问，建议补充 CLI 的 RPC 映射表。
