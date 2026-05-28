# 前端API调用清单

> 生成日期: 2026-05-28
> 项目: jiabaixing

## 目录
1. [API服务概览](#1-api服务概览)
2. [前端API调用方法清单](#2-前端api调用方法清单)
3. [API调用分类统计](#3-api调用分类统计)

---

## 1. API服务概览

### 主服务文件: [apiService.ts](file:///c:/zy/jiabaixing/src/frontend/src/api/apiService.ts)

前端API服务层采用`JiabaixingApiService`类统一管理所有API请求,所有端点引用共享契约层`contracts.ts`,禁止硬编码。

### 核心特性:
- ✅ 统一缓存管理 (5分钟默认过期)
- ✅ 自动重试机制 (最多3次,指数退避)
- ✅ 类型安全 (使用TypeScript类型注解)
- ✅ 契约驱动 (所有端点来自`API_ENDPOINTS`常量)

---

## 2. 前端API调用方法清单

### 2.1 系统健康与模型管理

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getHealth()` | GET | `/api/health` | 获取系统健康状态 |
| `getModels()` | GET | `/api/models` | 获取模型列表 |
| `getModelStatus()` | GET | `/api/models/status` | 获取模型状态 |
| `getModelHealth()` | GET | `/api/models/health` | 获取模型健康状态 |
| `switchModel()` | POST | `/api/models/switch` | 切换模型 |

### 2.2 消息处理

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `processMessage()` | POST | `/api/process` | 处理输入消息 |
| `processMultimodalMessage()` | POST | `/api/process` | 处理多模态消息 |
| `submitCorrection()` | POST | `/api/correct` | 提交用户纠正 |

### 2.3 实时流

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getLogs()` | SSE | `/api/logs` | 获取SSE日志流 |

### 2.4 进化系统

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getEvolutionStatus()` | GET | `/api/evolution/status` | 获取进化状态 |
| `getEvolutionMetrics()` | GET | `/api/evolution/metrics` | 获取进化指标 |
| `getEvolutionInsights()` | GET | `/api/evolution/insights` | 获取进化洞察 |
| `triggerEvolution()` | POST | `/api/evolution/trigger` | 触发手动进化 |
| `triggerEvolutionCycle()` | POST | `/api/evolution/cycle` | 触发完整进化周期 |
| `triggerHealing()` | POST | `/api/evolution/healing` | 触发修复 |
| `triggerRefactor()` | POST | `/api/evolution/refactor` | 触发重构 |
| `triggerEnhance()` | POST | `/api/evolution/enhance` | 触发增强 |

### 2.5 编排系统

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getOrchestratorMetrics()` | GET | `/api/orchestrator/metrics` | 获取编排器指标 |
| `triggerOrchestratorOptimize()` | POST | `/api/orchestrator/optimize` | 触发编排器优化 |

### 2.6 记忆系统

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `storeMemory()` | POST | `/api/memory/store` | 存储记忆 |
| `searchMemory()` | GET | `/api/memory/search` | 搜索记忆 |
| `getMemoryProfile()` | GET | `/api/memory/profile` | 获取记忆画像 |
| `updateMemoryPreferences()` | POST | `/api/memory/preferences` | 更新记忆偏好 |
| `getMemoryStats()` | GET | `/api/memory/stats` | 获取记忆统计 |

### 2.7 安全系统

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getSecurityLogs()` | GET | `/api/security/logs` | 获取安全日志 |
| `getSecurityEvents()` | GET | `/api/security/events` | 获取安全事件 |
| `getSecurityReport()` | GET | `/api/security/report` | 获取安全报告 |
| `validateSecurityInput()` | POST | `/api/security/validate` | 安全输入验证 |
| `getSecurityAudit()` | GET | `/api/security/audit` | 安全审计 |

### 2.8 技能系统

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `executeSkill()` | POST | `/api/skills/execute` | 执行技能 |
| `listSkills()` | GET | `/api/skills/list` | 列出技能 |

### 2.9 性能监控

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getPerformanceSnapshot()` | GET | `/api/performance/snapshot` | 获取性能快照 |
| `getPerformanceMetrics()` | GET | `/api/performance/metrics` | 获取性能指标 |
| `getPerformanceErrors()` | GET | `/api/performance/errors` | 获取性能错误 |
| `getLLMPerformance()` | GET | `/api/llm/performance` | 获取LLM性能 |
| `sendPerformanceMetrics()` | POST | `/api/performance/metrics` | 发送性能指标 |

### 2.10 系统管理

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getSystemResources()` | GET | `/api/system/resources` | 获取系统资源 |
| `getSystemIntegrity()` | GET | `/api/system/integrity` | 系统完整性检查 |
| `getSystemMetrics()` | GET | `/api/metrics` | 获取性能指标 |
| `getSystemConfig()` | GET | `/api/config` | 获取配置信息 |

### 2.11 日志系统

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getErrorLogs()` | GET | `/api/logs/errors` | 获取错误日志 |
| `getLogsQuery()` | GET | `/api/logs` | 获取通用日志 |
| `sendErrorMonitoring()` | POST | `/api/error/monitoring` | 发送错误监控 |

### 2.12 自动化任务

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getAutomationTasks()` | GET | `/api/automation/tasks` | 获取自动化任务列表 |
| `createAutomationTask()` | POST | `/api/automation/tasks` | 创建自动化任务 |
| `getAutomationTriggers()` | GET | `/api/automation/triggers` | 获取触发队列 |
| `getAutomationPatterns()` | GET | `/api/automation/patterns` | 获取行为模式 |

### 2.13 任务管理

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `createTask()` | POST | `/api/tasks/create` | 创建跨会话任务 |
| `listTasks()` | GET | `/api/tasks/list` | 查询活跃任务 |
| `cancelTask()` | POST | `/api/tasks/:id/cancel` | 取消任务 |
| `pauseTask()` | POST | `/api/tasks/:id/pause` | 暂停任务 |
| `resumeTask()` | POST | `/api/tasks/:id/resume` | 恢复任务 |
| `getHarnessTaskStatus()` | GET | `/api/tasks/harness/status` | Harness状态 |
| `simulateTask()` | POST | `/api/simulate_task` | 模拟任务 |

### 2.14 集成系统

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getIntegrationPlatforms()` | GET | `/api/integration/platforms` | 获取平台列表 |
| `getIntegrationPlatformStatus()` | GET | `/api/integration/:platform/status` | 获取平台状态 |
| `connectIntegrationPlatform()` | POST | `/api/integration/:platform/connect` | 连接平台 |
| `disconnectIntegrationPlatform()` | POST | `/api/integration/:platform/disconnect` | 断开平台 |
| `sendIntegrationMessage()` | POST | `/api/integration/:platform/send` | 发送消息 |
| `getIntegrationWebhook()` | GET | `/api/integration/:platform/webhook` | 处理webhook |
| `getIntegrationStatus()` | GET | `/api/integration/system-status` | 获取系统状态 |

### 2.15 其他功能

| 方法名 | HTTP方法 | 对应端点 | 功能描述 |
|--------|----------|----------|----------|
| `getConversations()` | GET | `/api/conversations` | 获取对话列表 |
| `sendUserBehaviorEvents()` | POST | `/api/user-behavior/events` | 发送用户行为事件 |
| `getRecommendations()` | GET | `/api/recommendations` | 获取推荐 |
| `processOptimizationPlan()` | POST | `/api/optimization/process` | 处理优化计划 |
| `getOptimizationHistory()` | GET | `/api/optimization/history` | 获取优化历史 |

---

## 3. API调用分类统计

### 3.1 按HTTP方法统计

| HTTP方法 | 数量 | 占比 |
|----------|------|------|
| GET | 40 | 62.5% |
| POST | 23 | 35.9% |
| SSE | 1 | 1.6% |
| **总计** | **64** | **100%** |

### 3.2 按功能模块统计

| 模块 | API数量 |
|------|---------|
| 系统健康与模型管理 | 5 |
| 消息处理 | 3 |
| 实时流 | 1 |
| 进化系统 | 8 |
| 编排系统 | 2 |
| 记忆系统 | 5 |
| 安全系统 | 5 |
| 技能系统 | 2 |
| 性能监控 | 5 |
| 系统管理 | 4 |
| 日志系统 | 3 |
| 自动化任务 | 4 |
| 任务管理 | 7 |
| 集成系统 | 7 |
| 其他功能 | 5 |
| **总计** | **64** |

### 3.3 缓存策略

- 默认缓存过期: 5分钟
- 特殊缓存: `getHealth()` 缓存30秒
- 非GET请求不缓存
- 提供手动清除缓存方法: `clearCache()`, `clearCacheForEndpoint()`

---

## 4. 契约引用

### 所有端点引用自: [contracts.ts](file:///c:/zy/jiabaixing/src/shared/contracts.ts#L21-L96)

前端严格遵循契约驱动设计,所有API端点常量来自共享契约层,确保前后端一致性。

---

## 5. 类型导入

前端从契约层导入以下类型,确保类型安全:
- `API_ENDPOINTS` - 端点常量
- `ApiResponse` - API响应包装器
- `HealthResponse` - 健康响应
- `ModelInfo` - 模型信息
- `ModelStatus` - 模型状态
- `ModelHealth` - 模型健康
- `MemorySearchResponse` - 记忆搜索响应
- `MemoryProfileResponse` - 记忆画像响应
- `MemoryStatsResponse` - 记忆统计响应
- `SkillExecuteResponse` - 技能执行响应
- `SkillListResponse` - 技能列表响应
- `SecurityValidateResponse` - 安全验证响应
- `PerformanceSnapshotResponse` - 性能快照响应
- `SystemResourcesResponse` - 系统资源响应
- `IntegrationPlatform` - 集成平台
- `PlatformConfig` - 平台配置
- `IntegrationStatusResponse` - 集成状态响应
- `PlatformConnectResponse` - 平台连接响应
- `PlatformDisconnectResponse` - 平台断开响应
- `SendMessageRequest` - 发送消息请求
- `SendMessageResponse` - 发送消息响应
- `EvolutionCycleStatus` - 进化周期状态
