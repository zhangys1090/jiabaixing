# API接口连接审查计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全面审查jiabaixing项目的后端API接口与前端接口连接，识别接口清单、连接关系、缺失接口和不匹配问题。

**Architecture:** 
1. 梳理所有后端API路由定义
2. 梳理前端所有API调用
3. 建立API接口映射关系
4. 识别缺失/不匹配/不一致问题
5. 生成审查报告和修复建议

**Tech Stack:** Express.js (后端), React (前端), TypeScript, REST API

---

## 文件结构概览

### 后端API路由文件
| 文件 | 路径 | 说明 |
|------|------|------|
| main.ts | (file:///c:/zy/jiabaixing/src/main.ts) | 主入口，路由注册 |
| chat.ts | (file:///c:/zy/jiabaixing/src/routes/chat.ts) | 对话API |
| orchestrate.ts | (file:///c:/zy/jiabaixing/src/routes/orchestrate.ts) | 编排API |
| tasks.ts | (file:///c:/zy/jiabaixing/src/routes/tasks.ts) | 任务API |
| automation.ts | (file:///c:/zy/jiabaixing/src/routes/automation.ts) | 自动化API |
| coreRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/coreRoutes.ts) | 核心路由 |
| performanceRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/performanceRoutes.ts) | 性能路由 |
| securityRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/securityRoutes.ts) | 安全路由 |
| evolutionRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/evolutionRoutes.ts) | 进化路由 |
| memoryRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/memoryRoutes.ts) | 记忆路由 |
| skillRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/skillRoutes.ts) | 技能路由 |
| debugRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/debugRoutes.ts) | 调试路由 |
| integrationRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/integrationRoutes.ts) | 集成路由 |
| systemStateRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/systemStateRoutes.ts) | 系统状态路由 |
| traeRoutes.ts | (file:///c:/zy/jiabaixing/src/server/routes/traeRoutes.ts) | TRAE路由 |

### 前端API文件
| 文件 | 路径 | 说明 |
|------|------|------|
| apiService.ts | (file:///c:/zy/jiabaixing/src/frontend/src/api/apiService.ts) | API服务层 |
| contracts.ts | (file:///c:/zy/jiabaixing/src/shared/contracts.ts) | API契约定义 |

---

## 任务分解

### Task 1: 梳理后端API路由清单

**Files:**
- Read: (file:///c:/zy/jiabaixing/src/main.ts)
- Read: (file:///c:/zy/jiabaixing/src/routes/chat.ts)
- Read: (file:///c:/zy/jiabaixing/src/routes/orchestrate.ts)
- Read: (file:///c:/zy/jiabaixing/src/routes/tasks.ts)
- Read: (file:///c:/zy/jiabaixing/src/routes/automation.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/coreRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/performanceRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/securityRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/evolutionRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/memoryRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/skillRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/debugRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/integrationRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/systemStateRoutes.ts)
- Read: (file:///c:/zy/jiabaixing/src/server/routes/traeRoutes.ts)
- Create: `docs/api-review/backend-api-list.md`

- [ ] **Step 1: 从main.ts提取所有路由注册信息**

```typescript
// 从main.ts提取路由注册表
const registeredRoutes = {
  '/api/integration': 'integrationRoutes',
  '/api/automation': 'automationRoutes', 
  '/api/tasks': 'taskRoutes',
  '/api/chat': 'chatRoutes',
  '/api/orchestrate': 'orchestrateRoutes',
  // 以及registerXxxRoutes注册的所有路由
};
```

- [ ] **Step 2: 逐个分析路由文件，提取所有API端点**

创建后端API清单表格：
```markdown
| 方法 | 端点 | 文件 | 功能描述 | 状态 |
|------|------|------|----------|------|
| POST | /api/chat | chat.ts | 发送对话消息 | ✅ |
| POST | /api/orchestrate | orchestrate.ts | 多Agent编排 | ✅ |
| ... | ... | ... | ... | ... |
```

- [ ] **Step 3: 提取契约定义**

从contracts.ts提取所有API端点常量：
```typescript
export const API_ENDPOINTS = {
  HEALTH: '/api/health',
  PROCESS: '/api/process',
  CORRECT: '/api/correct',
  // ...
};
```

---

### Task 2: 梳理前端API调用清单

**Files:**
- Read: (file:///c:/zy/jiabaixing/src/frontend/src/api/apiService.ts)
- Read: (file:///c:/zy/jiabaixing/src/shared/contracts.ts)
- Search: 所有前端组件中对API的调用
- Create: `docs/api-review/frontend-api-list.md`

- [ ] **Step 1: 提取apiService.ts的所有方法**

```typescript
// JiabaixingApiService 方法列表
- getHealth()
- processMessage(input, images, userId)
- processMultimodalMessage(input, images)
- submitCorrection(toolId, correctionType, reason, severity, traceId)
- getModels()
- getModelStatus()
- getModelHealth()
- switchModel(targetModel, reason)
- getEvolutionStatus()
- getEvolutionMetrics()
- triggerEvolution(reason)
- triggerEvolutionCycle()
- triggerHealing()
- triggerRefactor()
- triggerEnhance()
- storeMemory(content, userId, importance, tags, emotion, scene)
- searchMemory(query, userId, limit)
- getMemoryProfile(userId)
- updateMemoryPreferences(preferences)
- getMemoryStats()
- getSecurityLogs(limit, level, category)
- validateSecurityInput(input)
- getSecurityAudit(limit, type)
- executeSkill(skillName, params, userId)
- listSkills()
- getPerformanceSnapshot()
- getPerformanceMetrics(limit)
- getPerformanceErrors(limit)
- getSystemResources()
- getSystemIntegrity()
- getSystemMetrics()
- getSystemConfig()
- getAutomationTasks()
- createAutomationTask(task)
- getAutomationTriggers()
- getAutomationPatterns()
- getErrorLogs(hours, level, limit)
- getLogsQuery(limit, level, module)
- getEvolutionInsights()
- getOrchestratorMetrics()
- triggerOrchestratorOptimize()
- getSecurityEvents(limit)
- getSecurityReport()
- getLLMPerformance()
- createTask(taskData)
- listTasks(limit)
- cancelTask(taskId)
- pauseTask(taskId)
- resumeTask(taskId)
- getHarnessTaskStatus()
- getIntegrationStatus()
- getConversations(limit)
- simulateTask(taskId, prompt)
- processOptimizationPlan(planId, action)
- getOptimizationHistory()
- sendUserBehaviorEvents(events)
- getRecommendations(userId, limit)
- sendPerformanceMetrics(metrics)
- sendErrorMonitoring(error)
- getIntegrationPlatforms()
- getIntegrationPlatformStatus(platform)
- connectIntegrationPlatform(platform, config)
- disconnectIntegrationPlatform(platform)
- sendIntegrationMessage(request)
- getIntegrationWebhook(platform)
```

- [ ] **Step 2: 搜索前端组件中的直接API调用**

使用grep搜索`fetch`, `axios`, `apiService`调用：
```
# 搜索示例
grep -r "apiService\." src/frontend/src/
grep -r "fetch(" src/frontend/src/
```

- [ ] **Step 3: 创建前端API调用清单表格**

```markdown
| 前端方法 | 调用端点 | 使用组件 | 状态 |
|----------|----------|----------|------|
| getHealth() | GET /api/health | 多个组件 | ✅ |
| processMessage() | POST /api/process | ChatInterface | ✅ |
| ... | ... | ... | ... |
```

---

### Task 3: 建立API接口映射关系图

**Files:**
- Create: `docs/api-review/api-connection-map.md`
- Create: `docs/api-review/api-connection-map.html` (可视化)

- [ ] **Step 1: 对比前后端API，创建映射表**

```markdown
# API接口映射表

## 完全匹配的接口
| 后端端点 | 前端调用 | 状态 |
|----------|----------|------|
| GET /api/health | getHealth() | ✅ 匹配 |
| POST /api/process | processMessage() | ✅ 匹配 |
| ... | ... | ... |

## 后端有但前端没有的接口
| 后端端点 | 文件 | 说明 | 优先级 |
|----------|------|------|--------|
| GET /api/debug/xxx | debugRoutes.ts | 调试用 | 低 |
| ... | ... | ... | ... |

## 前端有但后端没有的接口
| 前端调用 | 说明 | 状态 |
|----------|------|------|
| xxxApi() | 不存在的端点 | ❌ 缺失 |
| ... | ... | ... |

## 端点不匹配的接口
| 前端期望 | 后端实际 | 问题 |
|----------|----------|------|
| POST /api/chat | POST /api/process | 端点不匹配 |
| ... | ... | ... |
```

- [ ] **Step 2: 创建API连接图**

```mermaid
graph TD
    A[前端] -->|getHealth()| B[GET /api/health]
    A -->|processMessage()| C[POST /api/process]
    A -->|submitCorrection()| D[POST /api/correct]
    B --> E[coreRoutes.ts]
    C --> E
    D --> E
    A -->|getEvolutionStatus()| F[GET /api/evolution/status]
    F --> G[systemStateRoutes.ts]
    A -->|storeMemory()| H[POST /api/memory/store]
    H --> I[memoryRoutes.ts]
```

---

### Task 4: 深入分析各API模块

**Files:**
- Create: `docs/api-review/module-analysis/` directory
- Create: `docs/api-review/module-analysis/chat-api.md`
- Create: `docs/api-review/module-analysis/orchestrate-api.md`
- Create: `docs/api-review/module-analysis/tasks-api.md`
- Create: `docs/api-review/module-analysis/automation-api.md`
- Create: `docs/api-review/module-analysis/core-api.md`
- Create: `docs/api-review/module-analysis/performance-api.md`
- Create: `docs/api-review/module-analysis/security-api.md`
- Create: `docs/api-review/module-analysis/evolution-api.md`
- Create: `docs/api-review/module-analysis/memory-api.md`
- Create: `docs/api-review/module-analysis/skill-api.md`
- Create: `docs/api-review/module-analysis/debug-api.md`
- Create: `docs/api-review/module-analysis/integration-api.md`
- Create: `docs/api-review/module-analysis/system-api.md`
- Create: `docs/api-review/module-analysis/trae-api.md`

- [ ] **Step 1: 分析Chat API模块**

```markdown
# Chat API 模块分析

## 后端端点
| 方法 | 端点 | 功能 |
|------|------|------|
| POST | /api/chat | 发送对话消息 |

## 前端调用
| 方法 | 端点 | 组件 |
|------|------|------|
| processMessage() | POST /api/process | ChatInterface |

## 问题
- 🔴 **端点不匹配**: 前端调用 /api/process，后端只有 /api/chat
```

- [ ] **Step 2: 分析Orchestrate API模块**

```markdown
# Orchestrate API 模块分析

## 后端端点
| 方法 | 端点 | 功能 |
|------|------|------|
| POST | /api/orchestrate | 多Agent编排 |
| POST | /api/evaluate | 自评估 |

## 前端调用
| 方法 | 端点 | 组件 |
|------|------|------|
| getOrchestratorMetrics() | GET /api/orchestrator/metrics | OrchestrationPanel |
| triggerOrchestratorOptimize() | POST /api/orchestrator/optimize | OrchestrationPanel |

## 问题
- 🟡 **部分匹配**: 后端有 /api/orchestrate，前端调用 /api/orchestrator/*
```

- [ ] **Step 3-12: 逐个分析其余API模块**

对每个模块重复上述分析格式。

---

### Task 5: 识别和分类API问题

**Files:**
- Create: `docs/api-review/api-issues.md`

- [ ] **Step 1: 整理问题分类清单**

```markdown
# API问题清单

## 🔴 高优先级问题

### 1. 端点不匹配
| 前端期望 | 后端提供 | 影响范围 |
|----------|----------|----------|
| POST /api/process | POST /api/chat | ChatInterface |

### 2. 缺失端点
| 功能需求 | 建议端点 | 优先级 |
|----------|----------|--------|
| WebSocket连接管理 | /api/ws/... | 高 |

## 🟡 中优先级问题

### 3. 请求/响应类型不一致
- 对比contracts.ts中的类型定义与实际实现

### 4. 文档缺失
- 部分API缺少Swagger/OpenAPI文档

## 🟢 低优先级问题

### 5. 命名不规范
- 部分端点命名不一致
```

---

### Task 6: 生成最终审查报告

**Files:**
- Create: `docs/api-review/final-report.md`

- [ ] **Step 1: 编写审查报告概述**

```markdown
# API接口连接审查报告

## 执行摘要
- 审查日期: 2026-05-28
- 后端API总数: XX
- 前端API调用总数: XX
- 完全匹配: XX
- 不匹配: XX
- 缺失: XX
- 问题总计: XX

## 关键发现
- 🔴 高优先级问题: X个
- 🟡 中优先级问题: X个
- 🟢 低优先级问题: X个
```

- [ ] **Step 2: 添加详细问题列表和修复建议**

- [ ] **Step 3: 添加修复路线图**

```markdown
## 修复路线图

### Phase 1: 紧急修复 (立即)
- [ ] 修复端点不匹配问题
- [ ] 实现缺失的关键端点

### Phase 2: 优化 (本周)
- [ ] 统一类型定义
- [ ] 完善API文档

### Phase 3: 改进 (下週)
- [ ] 添加API版本管理
- [ ] 实现API监控
```

---

## 执行检查清单

- [ ] 所有后端API路由已梳理
- [ ] 所有前端API调用已梳理
- [ ] API映射关系已建立
- [ ] 问题已识别和分类
- [ ] 审查报告已生成
- [ ] 修复计划已制定

---

## 预期交付物

1. `docs/api-review/backend-api-list.md` - 后端API清单
2. `docs/api-review/frontend-api-list.md` - 前端API调用清单
3. `docs/api-review/api-connection-map.md` - API连接映射表
4. `docs/api-review/api-connection-map.html` - 可视化连接图
5. `docs/api-review/module-analysis/*.md` - 各模块详细分析
6. `docs/api-review/api-issues.md` - API问题清单
7. `docs/api-review/final-report.md` - 最终审查报告
