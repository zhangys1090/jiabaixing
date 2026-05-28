# 后端API路由清单

> 生成日期: 2026-05-28
> 项目: jiabaixing

## 目录
1. [路由注册概览](#1-路由注册概览)
2. [API端点详细清单](#2-api端点详细清单)
3. [路由文件结构](#3-路由文件结构)

---

## 1. 路由注册概览

### 主入口文件: (file:///c:/zy/jiabaixing/src/main.ts#L66-L97)

在main.ts中，路由按以下方式注册:

```typescript
// 直接挂载的路由
app.use('/api/integration', integrationRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api', chatRoutes);
app.use('/api', orchestrateRoutes);
app.use(systemStateRoutes);

// 通过函数注册的路由
registerCoreRoutes(app, core);
registerPerformanceRoutes(app, core);
registerSecurityRoutes(app, core);
registerEvolutionRoutes(app, core);
registerMemoryRoutes(app, core);
registerSkillRoutes(app, core);
registerTraeRoutes(app, core);
registerDebugRoutes(app, core, broadcast);
```

---

## 2. API端点详细清单

### 2.1 核心路由 - (file:///c:/zy/jiabaixing/src/server/routes/coreRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/health` | 获取系统健康状态 | ✅ |
| GET | `/api/models` | 获取模型列表 | ✅ |
| POST | `/api/process` | 处理输入消息 | ✅ |
| GET | `/api/evolution` | 获取进化版本列表 | ✅ |
| POST | `/api/correct` | 提交用户纠正 | ✅ |
| GET | `/api/logs` | SSE日志流 | ✅ |

### 2.2 Chat路由 - (file:///c:/zy/jiabaixing/src/routes/chat.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| POST | `/api/chat` | 发送对话消息 | ✅ |

### 2.3 Orchestrate路由 - (file:///c:/zy/jiabaixing/src/routes/orchestrate.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| POST | `/api/orchestrate` | 多Agent编排执行 | ✅ |
| POST | `/api/evaluate` | 自评估管道 | ✅ |

### 2.4 Tasks路由 - (file:///c:/zy/jiabaixing/src/routes/tasks.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| POST | `/api/tasks/create` | 创建跨会话任务 | ✅ |
| GET | `/api/tasks/list` | 查询活跃任务 | ✅ |
| POST | `/api/tasks/:id/cancel` | 取消任务 | ✅ |
| POST | `/api/tasks/:id/pause` | 暂停任务 | ✅ |
| POST | `/api/tasks/:id/resume` | 恢复任务 | ✅ |
| GET | `/api/tasks/../harness/status` | Harness状态 | ✅ |

### 2.5 Automation路由 - (file:///c:/zy/jiabaixing/src/routes/automation.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/automation/tasks` | 获取自动化任务列表 | ✅ |
| POST | `/api/automation/tasks` | 创建自动化任务 | ✅ |
| PATCH | `/api/automation/tasks/:taskId/toggle` | 切换任务启用状态 | ✅ |
| POST | `/api/automation/tasks/:taskId/execute` | 执行任务 | ✅ |
| GET | `/api/automation/triggers` | 获取触发队列 | ✅ |
| GET | `/api/automation/patterns` | 获取行为模式 | ✅ |

### 2.6 性能路由 - (file:///c:/zy/jiabaixing/src/server/routes/performanceRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/performance/snapshot` | 获取性能快照 | ✅ |
| GET | `/api/performance/metrics` | 获取性能指标 | ✅ |
| GET | `/api/performance/errors` | 获取性能错误 | ✅ |
| GET | `/api/llm/performance` | 获取LLM性能 | ✅ |

### 2.7 安全路由 - (file:///c:/zy/jiabaixing/src/server/routes/securityRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/security/logs` | 获取安全日志 | ✅ |
| GET | `/api/security/events` | 获取安全事件 | ✅ |
| GET | `/api/security/report` | 获取安全报告 | ✅ |
| POST | `/api/security/validate` | 安全输入验证 | ✅ |
| GET | `/api/security/audit` | 安全审计 | ✅ |

### 2.8 进化路由 - (file:///c:/zy/jiabaixing/src/server/routes/evolutionRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/evolution/metrics` | 获取进化指标 | ✅ |
| GET | `/api/evolution/insights` | 获取进化洞察 | ✅ |
| POST | `/api/evolution/trigger` | 触发手动优化 | ✅ |
| GET | `/api/orchestrator/metrics` | 获取编排器指标 | ✅ |
| POST | `/api/orchestrator/optimize` | 触发编排器优化 | ✅ |

### 2.9 记忆路由 - (file:///c:/zy/jiabaixing/src/server/routes/memoryRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| POST | `/api/memory/store` | 存储记忆 | ✅ |
| GET | `/api/memory/search` | 搜索记忆 | ✅ |
| GET | `/api/memory/profile` | 获取记忆画像 | ✅ |
| POST | `/api/memory/preferences` | 更新记忆偏好 | ✅ |

### 2.10 技能路由 - (file:///c:/zy/jiabaixing/src/server/routes/skillRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| POST | `/api/skills/execute` | 执行技能 | ✅ |
| GET | `/api/skills/list` | 列出技能 | ✅ |
| POST | `/api/tasks/create` (重复) | 创建任务 | ✅ |
| GET | `/api/tasks/list` (重复) | 列出任务 | ✅ |
| POST | `/api/tasks/:id/cancel` (重复) | 取消任务 | ✅ |
| POST | `/api/tasks/:id/pause` (重复) | 暂停任务 | ✅ |
| POST | `/api/tasks/:id/resume` (重复) | 恢复任务 | ✅ |

### 2.11 调试路由 - (file:///c:/zy/jiabaixing/src/server/routes/debugRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/debug/weights` | 获取权重信息 | ✅ |
| GET | `/api/debug/recentHistory` | 获取最近历史 | ✅ |
| GET | `/api/debug/tool-usage` | 获取工具使用统计 | ✅ |
| POST | `/api/simulate_task` | 模拟任务 | ✅ |

### 2.12 集成路由 - (file:///c:/zy/jiabaixing/src/server/routes/integrationRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/integration/wechat/qrcode` | 获取微信二维码 | ✅ |
| GET | `/api/integration/platforms` | 获取平台列表 | ✅ |
| GET | `/api/integration/:platform/status` | 获取平台状态 | ✅ |
| POST | `/api/integration/:platform/connect` | 连接平台 | ✅ |
| POST | `/api/integration/:platform/disconnect` | 断开平台 | ✅ |
| POST | `/api/integration/:platform/webhook` | 处理webhook | ✅ |
| POST | `/api/integration/:platform/send` | 发送消息 | ✅ |
| GET | `/api/integration/system-status` | 获取系统状态 | ✅ |

### 2.13 系统状态路由 - (file:///c:/zy/jiabaixing/src/server/routes/systemStateRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/system/resources` | 获取系统资源 | ✅ |
| GET | `/api/memory/stats` | 获取记忆统计 | ✅ |
| GET | `/api/metrics` | 获取性能指标 | ✅ |
| GET | `/api/logs/errors` | 获取错误日志 | ✅ |
| GET | `/api/logs` | 获取通用日志 | ✅ |
| GET | `/api/config` | 获取配置信息 | ✅ |
| GET | `/api/evolution/status` | 获取进化状态 | ✅ |
| POST | `/api/evolution/trigger` | 触发进化 | ✅ |
| GET | `/api/evolution/metrics` | 获取进化指标 | ✅ |
| POST | `/api/correct` | 用户纠正 | ✅ |
| GET | `/api/security/logs` | 获取安全日志 | ✅ |
| GET | `/api/system/integrity` | 系统完整性检查 | ✅ |

### 2.14 TRAE路由 - (file:///c:/zy/jiabaixing/src/server/routes/traeRoutes.ts)

| 方法 | 端点 | 功能描述 | 状态 |
|------|------|----------|------|
| GET | `/api/trae/health` | TRAE健康检查 | ✅ |
| GET | `/api/trae/performance` | TRAE性能 | ✅ |
| GET | `/api/trae/mcp/status` | MCP状态 | ✅ |
| GET | `/api/trae/skills/status` | 技能状态 | ✅ |
| POST | `/api/trae/skills/execute` | 执行优化技能 | ✅ |
| POST | `/api/trae/security/audit` | 安全审计 | ✅ |
| POST | `/api/trae/testing/generate` | 生成测试 | ✅ |

---

## 3. 路由文件结构

### 3.1 直接路由文件 (src/routes/)
| 文件 | 说明 |
|------|------|
| (file:///c:/zy/jiabaixing/src/routes/chat.ts) | Chat API |
| (file:///c:/zy/jiabaixing/src/routes/orchestrate.ts) | Orchestrate API |
| (file:///c:/zy/jiabaixing/src/routes/tasks.ts) | Tasks API |
| (file:///c:/zy/jiabaixing/src/routes/automation.ts) | Automation API |

### 3.2 注册函数路由文件 (src/server/routes/)
| 文件 | 说明 |
|------|------|
| (file:///c:/zy/jiabaixing/src/server/routes/coreRoutes.ts) | Core Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/performanceRoutes.ts) | Performance Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/securityRoutes.ts) | Security Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/evolutionRoutes.ts) | Evolution Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/memoryRoutes.ts) | Memory Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/skillRoutes.ts) | Skill Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/debugRoutes.ts) | Debug Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/integrationRoutes.ts) | Integration Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/systemStateRoutes.ts) | System State Routes |
| (file:///c:/zy/jiabaixing/src/server/routes/traeRoutes.ts) | TRAE Routes |

---

## 4. API统计摘要

| 类别 | 数量 |
|------|------|
| 路由文件总数 | 14 |
| API端点总数 | 70+ |
| GET端点 | ~40 |
| POST端点 | ~30 |
| PATCH端点 | 1 |
| 重复端点 | 5 (tasks路由重复) |
| SSE端点 | 1 |

---

## 5. 契约定义 - (file:///c:/zy/jiabaixing/src/shared/contracts.ts#L21-L96)

API端点常量定义:

```typescript
export const API_ENDPOINTS = {
  HEALTH: '/api/health',
  MODELS: '/api/models',
  MODELS_STATUS: '/api/models/status',
  MODELS_HEALTH: '/api/models/health',
  MODELS_SWITCH: '/api/models/switch',
  PROCESS: '/api/process',
  CORRECT: '/api/correct',
  LOGS_SSE: '/api/logs',
  LOGS_QUERY: '/api/logs',
  LOGS_ERRORS: '/api/logs/errors',
  EVOLUTION: '/api/evolution',
  EVOLUTION_STATUS: '/api/evolution/status',
  EVOLUTION_METRICS: '/api/evolution/metrics',
  EVOLUTION_INSIGHTS: '/api/evolution/insights',
  EVOLUTION_TRIGGER: '/api/evolution/trigger',
  EVOLUTION_CYCLE: '/api/evolution/cycle',
  EVOLUTION_HEALING: '/api/evolution/healing',
  EVOLUTION_REFACTOR: '/api/evolution/refactor',
  EVOLUTION_ENHANCE: '/api/evolution/enhance',
  ORCHESTRATOR_METRICS: '/api/orchestrator/metrics',
  ORCHESTRATOR_OPTIMIZE: '/api/orchestrator/optimize',
  MEMORY_STORE: '/api/memory/store',
  MEMORY_SEARCH: '/api/memory/search',
  MEMORY_PROFILE: '/api/memory/profile',
  MEMORY_PREFERENCES: '/api/memory/preferences',
  MEMORY_STATS: '/api/memory/stats',
  SECURITY_LOGS: '/api/security/logs',
  SECURITY_EVENTS: '/api/security/events',
  SECURITY_REPORT: '/api/security/report',
  SECURITY_VALIDATE: '/api/security/validate',
  SECURITY_AUDIT: '/api/security/audit',
  SKILLS_EXECUTE: '/api/skills/execute',
  SKILLS_LIST: '/api/skills/list',
  PERFORMANCE_SNAPSHOT: '/api/performance/snapshot',
  PERFORMANCE_METRICS: '/api/performance/metrics',
  PERFORMANCE_ERRORS: '/api/performance/errors',
  LLM_PERFORMANCE: '/api/llm/performance',
  SYSTEM_RESOURCES: '/api/system/resources',
  SYSTEM_INTEGRITY: '/api/system/integrity',
  SYSTEM_METRICS: '/api/metrics',
  SYSTEM_CONFIG: '/api/config',
  AUTOMATION_TASKS: '/api/automation/tasks',
  AUTOMATION_TRIGGERS: '/api/automation/triggers',
  AUTOMATION_PATTERNS: '/api/automation/patterns',
  TASKS_CREATE: '/api/tasks/create',
  TASKS_LIST: '/api/tasks/list',
  TASKS_CANCEL: '/api/tasks/:id/cancel',
  TASKS_PAUSE: '/api/tasks/:id/pause',
  TASKS_RESUME: '/api/tasks/:id/resume',
  TASKS_HARNESS_STATUS: '/api/tasks/harness/status',
  INTEGRATION: '/api/integration',
  INTEGRATION_PLATFORMS: '/api/integration/platforms',
  INTEGRATION_CONNECT: '/api/integration/:platform/connect',
  INTEGRATION_DISCONNECT: '/api/integration/:platform/disconnect',
  INTEGRATION_STATUS: '/api/integration/:platform/status',
  INTEGRATION_WEBHOOK: '/api/integration/:platform/webhook',
  INTEGRATION_SEND: '/api/integration/:platform/send',
  SIMULATE_TASK: '/api/simulate_task',
  CONVERSATIONS: '/api/conversations',
  USER_BEHAVIOR_EVENTS: '/api/user-behavior/events',
  RECOMMENDATIONS: '/api/recommendations',
  PERFORMANCE_METRICS_POST: '/api/performance/metrics',
  ERROR_MONITORING: '/api/error/monitoring',
  OPTIMIZATION_PROCESS: '/api/optimization/process',
  OPTIMIZATION_HISTORY: '/api/optimization/history',
} as const;
```
