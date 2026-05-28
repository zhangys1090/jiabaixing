# API接口连接关系图

> 生成日期: 2026-05-28
> 项目: jiabaixing

## 目录
1. [连接关系总览](#1-连接关系总览)
2. [完整接口映射表](#2-完整接口映射表)
3. [按模块分类的连接关系](#3-按模块分类的连接关系)

---

## 1. 连接关系总览

### 统计摘要

| 项目 | 数量 |
|------|------|
| 后端已实现API | 70+ |
| 前端已调用API | 64 |
| 完全匹配的API | 58 |
| 后端有但前端未调用 | 12+ |
| 前端调用但后端未实现 | 6 |
| 重复的API端点 | 5 |

### 匹配状态图例

- ✅ 完全匹配 (前后端都有)
- 🚧 后端缺失 (前端调用了但后端没有)
- 📭 前端未用 (后端有但前端没调用)
- ⚠️ 部分匹配 (有差异需要注意)

---

## 2. 完整接口映射表

### 2.1 系统健康与模型管理

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/health` | ✅ coreRoutes | ✅ getHealth() | ✅ | 完全匹配 |
| `/api/models` | ✅ coreRoutes | ✅ getModels() | ✅ | 完全匹配 |
| `/api/models/status` | ❌ 未实现 | ✅ getModelStatus() | 🚧 | 前端调用但后端缺失 |
| `/api/models/health` | ❌ 未实现 | ✅ getModelHealth() | 🚧 | 前端调用但后端缺失 |
| `/api/models/switch` | ❌ 未实现 | ✅ switchModel() | 🚧 | 前端调用但后端缺失 |
| `/api/process` | ✅ coreRoutes | ✅ processMessage() | ✅ | 完全匹配 |
| `/api/process` | ✅ coreRoutes | ✅ processMultimodalMessage() | ✅ | 完全匹配 |
| `/api/correct` | ✅ coreRoutes | ✅ submitCorrection() | ✅ | 完全匹配 |
| `/api/logs` (SSE) | ✅ coreRoutes | ✅ getLogs() | ✅ | 完全匹配 |
| `/api/evolution` | ✅ coreRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |

### 2.2 进化系统

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/evolution/status` | ✅ systemStateRoutes | ✅ getEvolutionStatus() | ✅ | 完全匹配 |
| `/api/evolution/metrics` | ✅ evolutionRoutes | ✅ getEvolutionMetrics() | ✅ | 完全匹配 |
| `/api/evolution/insights` | ✅ evolutionRoutes | ✅ getEvolutionInsights() | ✅ | 完全匹配 |
| `/api/evolution/trigger` | ✅ evolutionRoutes | ✅ triggerEvolution() | ✅ | 完全匹配 |
| `/api/evolution/cycle` | ❌ 未实现 | ✅ triggerEvolutionCycle() | 🚧 | 前端调用但后端缺失 |
| `/api/evolution/healing` | ❌ 未实现 | ✅ triggerHealing() | 🚧 | 前端调用但后端缺失 |
| `/api/evolution/refactor` | ❌ 未实现 | ✅ triggerRefactor() | 🚧 | 前端调用但后端缺失 |
| `/api/evolution/enhance` | ❌ 未实现 | ✅ triggerEnhance() | 🚧 | 前端调用但后端缺失 |

### 2.3 编排系统

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/chat` | ✅ chatRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/orchestrate` | ✅ orchestrateRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/evaluate` | ✅ orchestrateRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/orchestrator/metrics` | ✅ evolutionRoutes | ✅ getOrchestratorMetrics() | ✅ | 完全匹配 |
| `/api/orchestrator/optimize` | ✅ evolutionRoutes | ✅ triggerOrchestratorOptimize() | ✅ | 完全匹配 |

### 2.4 记忆系统

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/memory/store` | ✅ memoryRoutes | ✅ storeMemory() | ✅ | 完全匹配 |
| `/api/memory/search` | ✅ memoryRoutes | ✅ searchMemory() | ✅ | 完全匹配 |
| `/api/memory/profile` | ✅ memoryRoutes | ✅ getMemoryProfile() | ✅ | 完全匹配 |
| `/api/memory/preferences` | ✅ memoryRoutes | ✅ updateMemoryPreferences() | ✅ | 完全匹配 |
| `/api/memory/stats` | ✅ systemStateRoutes | ✅ getMemoryStats() | ✅ | 完全匹配 |

### 2.5 安全系统

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/security/logs` | ✅ securityRoutes | ✅ getSecurityLogs() | ✅ | 完全匹配 |
| `/api/security/events` | ✅ securityRoutes | ✅ getSecurityEvents() | ✅ | 完全匹配 |
| `/api/security/report` | ✅ securityRoutes | ✅ getSecurityReport() | ✅ | 完全匹配 |
| `/api/security/validate` | ✅ securityRoutes | ✅ validateSecurityInput() | ✅ | 完全匹配 |
| `/api/security/audit` | ✅ securityRoutes | ✅ getSecurityAudit() | ✅ | 完全匹配 |

### 2.6 技能系统

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/skills/execute` | ✅ skillRoutes | ✅ executeSkill() | ✅ | 完全匹配 |
| `/api/skills/list` | ✅ skillRoutes | ✅ listSkills() | ✅ | 完全匹配 |

### 2.7 性能监控

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/performance/snapshot` | ✅ performanceRoutes | ✅ getPerformanceSnapshot() | ✅ | 完全匹配 |
| `/api/performance/metrics` | ✅ performanceRoutes | ✅ getPerformanceMetrics() | ✅ | 完全匹配 |
| `/api/performance/metrics` (POST) | ❌ 未实现 | ✅ sendPerformanceMetrics() | 🚧 | 前端调用但后端缺失 |
| `/api/performance/errors` | ✅ performanceRoutes | ✅ getPerformanceErrors() | ✅ | 完全匹配 |
| `/api/llm/performance` | ✅ performanceRoutes | ✅ getLLMPerformance() | ✅ | 完全匹配 |

### 2.8 系统管理

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/system/resources` | ✅ systemStateRoutes | ✅ getSystemResources() | ✅ | 完全匹配 |
| `/api/system/integrity` | ✅ systemStateRoutes | ✅ getSystemIntegrity() | ✅ | 完全匹配 |
| `/api/metrics` | ✅ systemStateRoutes | ✅ getSystemMetrics() | ✅ | 完全匹配 |
| `/api/config` | ✅ systemStateRoutes | ✅ getSystemConfig() | ✅ | 完全匹配 |

### 2.9 日志系统

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/logs` (GET) | ✅ systemStateRoutes | ✅ getLogsQuery() | ✅ | 完全匹配 |
| `/api/logs/errors` | ✅ systemStateRoutes | ✅ getErrorLogs() | ✅ | 完全匹配 |
| `/api/error/monitoring` | ❌ 未实现 | ✅ sendErrorMonitoring() | 🚧 | 前端调用但后端缺失 |

### 2.10 自动化任务

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/automation/tasks` (GET) | ✅ automationRoutes | ✅ getAutomationTasks() | ✅ | 完全匹配 |
| `/api/automation/tasks` (POST) | ✅ automationRoutes | ✅ createAutomationTask() | ✅ | 完全匹配 |
| `/api/automation/tasks/:taskId/toggle` (PATCH) | ✅ automationRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/automation/tasks/:taskId/execute` (POST) | ✅ automationRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/automation/triggers` | ✅ automationRoutes | ✅ getAutomationTriggers() | ✅ | 完全匹配 |
| `/api/automation/patterns` | ✅ automationRoutes | ✅ getAutomationPatterns() | ✅ | 完全匹配 |

### 2.11 任务管理

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/tasks/create` | ✅ tasksRoutes | ✅ createTask() | ✅ | 完全匹配 |
| `/api/tasks/create` | ✅ skillRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在tasksRoutes中 |
| `/api/tasks/list` | ✅ tasksRoutes | ✅ listTasks() | ✅ | 完全匹配 |
| `/api/tasks/list` | ✅ skillRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在tasksRoutes中 |
| `/api/tasks/:id/cancel` | ✅ tasksRoutes | ✅ cancelTask() | ✅ | 完全匹配 |
| `/api/tasks/:id/cancel` | ✅ skillRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在tasksRoutes中 |
| `/api/tasks/:id/pause` | ✅ tasksRoutes | ✅ pauseTask() | ✅ | 完全匹配 |
| `/api/tasks/:id/pause` | ✅ skillRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在tasksRoutes中 |
| `/api/tasks/:id/resume` | ✅ tasksRoutes | ✅ resumeTask() | ✅ | 完全匹配 |
| `/api/tasks/:id/resume` | ✅ skillRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在tasksRoutes中 |
| `/api/tasks/harness/status` | ✅ tasksRoutes | ✅ getHarnessTaskStatus() | ✅ | 完全匹配 |
| `/api/simulate_task` | ✅ debugRoutes | ✅ simulateTask() | ✅ | 完全匹配 |

### 2.12 集成系统

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/integration/wechat/qrcode` | ✅ integrationRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/integration/platforms` | ✅ integrationRoutes | ✅ getIntegrationPlatforms() | ✅ | 完全匹配 |
| `/api/integration/:platform/status` | ✅ integrationRoutes | ✅ getIntegrationPlatformStatus() | ✅ | 完全匹配 |
| `/api/integration/:platform/connect` | ✅ integrationRoutes | ✅ connectIntegrationPlatform() | ✅ | 完全匹配 |
| `/api/integration/:platform/disconnect` | ✅ integrationRoutes | ✅ disconnectIntegrationPlatform() | ✅ | 完全匹配 |
| `/api/integration/:platform/webhook` | ✅ integrationRoutes | ✅ getIntegrationWebhook() | ✅ | 完全匹配 |
| `/api/integration/:platform/send` | ✅ integrationRoutes | ✅ sendIntegrationMessage() | ✅ | 完全匹配 |
| `/api/integration/system-status` | ✅ integrationRoutes | ✅ getIntegrationStatus() | ✅ | 完全匹配 |

### 2.13 调试与TRAE系统

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/debug/weights` | ✅ debugRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/debug/recentHistory` | ✅ debugRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/debug/tool-usage` | ✅ debugRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/trae/health` | ✅ traeRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/trae/performance` | ✅ traeRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/trae/mcp/status` | ✅ traeRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/trae/skills/status` | ✅ traeRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/trae/skills/execute` | ✅ traeRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/trae/security/audit` | ✅ traeRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |
| `/api/trae/testing/generate` | ✅ traeRoutes | ❌ 未调用 | 📭 | 后端有但前端未用 |

### 2.14 其他功能

| 端点 | 后端实现 | 前端调用 | 状态 | 备注 |
|------|----------|----------|------|------|
| `/api/conversations` | ❌ 未实现 | ✅ getConversations() | 🚧 | 前端调用但后端缺失 |
| `/api/user-behavior/events` | ❌ 未实现 | ✅ sendUserBehaviorEvents() | 🚧 | 前端调用但后端缺失 |
| `/api/recommendations` | ❌ 未实现 | ✅ getRecommendations() | 🚧 | 前端调用但后端缺失 |
| `/api/optimization/process` | ❌ 未实现 | ✅ processOptimizationPlan() | 🚧 | 前端调用但后端缺失 |
| `/api/optimization/history` | ❌ 未实现 | ✅ getOptimizationHistory() | 🚧 | 前端调用但后端缺失 |
| `/api/correct` | ✅ systemStateRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在coreRoutes中 |
| `/api/evolution/trigger` | ✅ systemStateRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在evolutionRoutes中 |
| `/api/evolution/metrics` | ✅ systemStateRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在evolutionRoutes中 |
| `/api/security/logs` | ✅ systemStateRoutes | ❌ 未调用 | ⚠️ | 重复定义,已在securityRoutes中 |

---

## 3. 按模块分类的连接关系

### 3.1 完全匹配的模块 (✅)

这些模块的前后端API完全对应:
- 记忆系统 (5/5)
- 安全系统 (5/5)
- 技能系统 (2/2)
- 集成系统 (6/8)

### 3.2 部分匹配的模块 (⚠️)

这些模块存在部分匹配或重复:
- 任务管理 (存在5个重复端点)
- 系统状态 (存在4个重复端点)

### 3.3 缺失较多的模块 (🚧)

这些模块前端调用但后端未实现较多:
- 模型管理 (3/5缺失)
- 进化系统 (4/8缺失)
- 其他功能 (5/5缺失)

### 3.4 未使用的模块 (📭)

这些模块后端有实现但前端未调用:
- TRAE系统 (6/6未用)
- 调试系统 (3/4未用)
- Chat/Orchestrate/Evaluate (3/3未用)

---

## 4. 关键发现

### 4.1 主要问题
1. **重复端点**: 任务管理和系统状态模块存在5个重复定义的端点
2. **后端缺失**: 前端调用了12个后端未实现的端点
3. **前端未用**: 后端实现了12+个前端未调用的端点

### 4.2 优点
1. ✅ 大部分核心功能模块完全匹配
2. ✅ 采用契约驱动设计,确保类型安全
3. ✅ 前端有统一的API服务层,管理规范
