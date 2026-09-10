# Phase 1-5 补全计划

## 目标

完成 Phase 5 IDE 接口、提升 Phase 4 进化引擎自动化、前端 SkillConsole 即插即用测试，并更新 README.md。

## 现状分析

### 已确认的基础设施
- **SkillRegistry**: 21个技能已注册，支持 `getAllSkillMeta()` 获取技能元数据
- **skillRoutes**: `/api/skills` 外部技能API已存在，但缺少 `/api/skills/execute` 直接执行端点
- **SkillConsole**: 前端组件已存在，使用 fallback 技能列表，未连接真实API
- **EvolutionEngine**: 每日凌晨3点定时优化 + 用户触发词检测，但缺少实时反馈闭环
- **AgentSelfReflection**: 执行记录结构完整，但未与 EvolutionEngine 深度集成
- **WebSocket**: `connectionManager` 支持 `skill_execute` 消息类型

---

## 任务一：补齐 Phase 5 IDE 接口（65% → 90%）

### 1.1 创建 IDE 集成技能 `src/skills/IDESkill.ts`

实现 VS Code / Cursor 等编辑器的通信接口：
- `openFile(path)` — 在IDE中打开文件
- `readFile(path)` — 读取文件内容（复用 FileSkill）
- `writeFile(path, content)` — 写入文件（复用 FileSkill）
- `runCommand(command)` — 在IDE终端执行命令
- `getDiagnostics()` — 获取代码诊断信息
- `applyEdit(uri, edits)` — 应用代码编辑

### 1.2 创建 LSP 风格通信协议 `src/ide/IDEProtocol.ts`

定义标准消息格式：
```typescript
interface IDEMessage {
  jsonrpc: '2.0';
  id?: string;
  method: string;
  params?: unknown;
}
```

### 1.3 创建 IDE 连接管理器 `src/ide/IDEConnectionManager.ts`

- WebSocket 连接到 IDE 插件（端口 9333）
- 心跳检测
- 请求-响应匹配（按 id）
- 连接状态管理

### 1.4 创建 VS Code 插件存根 `src/ide/vscode-extension-stub/`

- `extension.ts` — 插件入口
- `commands.ts` — 注册命令
- `websocket-server.ts` — 内嵌 WebSocket 服务器

### 1.5 注册 IDE 技能到 SkillRegistry

在 `src/skills/index.ts` 中注册 IDESkill。

---

## 任务二：提升 Phase 4 进化引擎自动化（70% → 90%）

### 2.1 实时反馈闭环 `src/evolution/RealTimeFeedbackLoop.ts`

当前 EvolutionEngine 只在每日凌晨3点或用户说"你最近回复有点冷"时触发。

新增实时闭环：
- 每次交互后自动评估质量（无需等待50条反馈）
- 质量评分 < 0.6 时立即触发微优化
- 连续3次低质量时触发深度优化
- 将 AgentSelfReflection 的执行记录自动导入 FeedbackCollector

### 2.2 自适应阈值调整

当前 `autoTriggerThreshold = 50` 固定值。

改为动态阈值：
- 根据交互频率调整（高频用户阈值降低）
- 根据反馈质量调整（高质量反馈减少阈值）
- 最小阈值 10，最大阈值 100

### 2.3 进化结果可视化API

新增后端API：
- `GET /api/evolution/metrics` — 进化指标
- `GET /api/evolution/insights` — 学习洞察
- `GET /api/evolution/performance` — 性能趋势

### 2.4 集成 AgentSelfReflection → EvolutionEngine

在 `JiabaixingCore.processInput()` 执行完成后：
1. 调用 `AgentSelfReflection.recordExecution()`
2. 将记录自动转发到 `EvolutionEngine.collectFeedback()`
3. 触发 `EvolutionEngine` 的实时检查

---

## 任务三：前端 SkillConsole 即插即用测试（验证闭环）

### 3.1 连接真实API

修改 `SkillConsole.tsx`：
- `fetchSkills()` 调用 `GET /api/skills` 获取真实技能列表
- `handleExecute()` 调用 `POST /api/skills/execute` 执行技能
- WebSocket `skill_execute` 响应处理

### 3.2 技能执行结果展示优化

- JSON 格式化输出
- 执行时间显示
- 错误堆栈折叠
- 成功/失败状态动画

### 3.3 技能注册测试

- 测试 `POST /api/skills/register` 注册新技能
- 测试 `GET /api/skills` 列表更新
- 测试 `POST /api/skills/:id/execute` 执行新技能

### 3.4 端到端测试

验证完整闭环：
1. 前端选择技能 → 2. 后端 SkillRegistry 查找 → 3. 执行 Skill → 4. 返回结果 → 5. 前端展示 → 6. 记录到 MemoryEngine → 7. EvolutionEngine 学习

---

## 任务四：更新 README.md

### 4.1 更新项目状态

- Phase 1-5 完成度更新
- 新增 IDE 接口说明
- 新增进化引擎自动化说明
- 新增 SkillConsole 使用指南

### 4.2 更新架构图

添加 IDE 接口层到架构图。

### 4.3 更新 API 文档

补充：
- `/api/skills/execute`
- `/api/evolution/metrics`
- `/api/evolution/insights`

---

## 执行顺序

1. **任务二（Phase 4 进化引擎）** — 先完成，因为任务三依赖它的API
2. **任务一（Phase 5 IDE 接口）** — 独立任务，可并行
3. **任务三（SkillConsole 测试）** — 依赖任务二的API
4. **任务四（README 更新）** — 最后，汇总所有变更

## 风险评估

| 风险 | 缓解措施 |
|------|----------|
| IDE 插件需要外部安装 | 提供详细安装文档 + 自动检测脚本 |
| 实时反馈可能过于频繁 | 添加冷却期（5分钟）+ 质量阈值过滤 |
| SkillConsole API 连接失败 | 保持 fallback 技能列表 + 错误提示 |
| 编译错误 | 每完成一个任务立即运行 `npm run build:fast` |
