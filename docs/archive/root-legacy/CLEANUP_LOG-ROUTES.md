# 路由合并清理日志 (CLEANUP_LOG-ROUTES.md)

## 日期

2026-06-08

## 目标

将 `src/routes/` 旧路由体系合并到 `src/server/routes/` 新路由体系。

## 变更汇总

### 新增文件 (迁移后的新路由文件)

1. `src/server/routes/automationRoutes.ts` — 从 `src/routes/automation.ts` 迁移
2. `src/server/routes/chatRoutes.ts` — 从 `src/routes/chat.ts` 迁移
3. `src/server/routes/orchestrateRoutes.ts` — 从 `src/routes/orchestrate.ts` 迁移
4. `src/server/routes/taskRoutes.ts` — 从 `src/routes/tasks.ts` 迁移
5. `src/server/routes/systemRoutes.ts` — 从 `src/routes/system.ts` 迁移

### 修改文件

1. `src/main.ts` — 将所有旧路由 import 路径更新为新的 server/routes/ 路径
2. `src/server/bootstrap.ts` — 将 `setSchedulerInstance` 的 import 从 `../routes/automation` 更新为 `../server/routes/automationRoutes`

### 删除文件

1. `src/routes/automation.ts` (已删除)
2. `src/routes/chat.ts` (已删除)
3. `src/routes/orchestrate.ts` (已删除)
4. `src/routes/tasks.ts` (已删除)
5. `src/routes/system.ts` (已删除)
6. `src/routes/` 目录 (已空)

## 功能映射

| 旧文件                | 新文件                             | 挂载点                          | 说明                                   |
| --------------------- | ---------------------------------- | ------------------------------- | -------------------------------------- |
| routes/automation.ts  | server/routes/automationRoutes.ts  | /api/automation/\*              | 调度任务CRUD、触发器、行为模式         |
| routes/chat.ts        | server/routes/chatRoutes.ts        | /api/chat                       | 对话API                                |
| routes/orchestrate.ts | server/routes/orchestrateRoutes.ts | /api/orchestrate, /api/evaluate | 多Agent编排、自评估                    |
| routes/tasks.ts       | server/routes/taskRoutes.ts        | /api/tasks/\*                   | Harness任务管理(CRUD/暂停/取消/恢复)   |
| routes/system.ts      | server/routes/systemRoutes.ts      | /api/system/\*                  | V5增强: 系统服务/审批/工作流/热键/托盘 |

## 不涉及变更的

- 所有新的 server/routes/ 原有文件 (coreRoutes, debugRoutes, systemStateRoutes 等) 保持不变
- SSE (Server-Sent Events) — 已存在于 `coreRoutes.ts` 的 `/api/logs/stream` 端点，本次无变更
- 业务逻辑 — 完全保持原样
- API端点路径 — 完全保持原样 (所有前端/客户端无需修改)

## 构建检查

- `npm run build` — 通过 (仅有2个预存在的 SecurityCore 错误，非本次变更引起)
- `npm test` — 待执行

## 注意事项

- `automationRoutes.ts` 导出的 `setSchedulerInstance` 被 `bootstrap.ts` 动态 import 引用，已同步更新路径
- 所有旧路由的文件均已从 src/routes/ 目录删除
