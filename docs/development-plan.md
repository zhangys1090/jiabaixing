# Jiabaixing V5.0 开发计划

> 生成时间: 2026-05-27
> 项目路径: `C:\zy\jiabaixing`

---

## 一、当前项目状态

### 代码规模
| 指标 | 数值 |
|------|------|
| TS/TSX 源文件 | 268 个 |
| 代码行数 | ~70,000 行 |
| 版本 | 5.0.0 |
| 架构 | 六层 E-T-C-S-L-V Harness |

### 当前状态

| 项目 | 状态 | 说明 |
|------|------|------|
| npm 安装 | ✅ 已完成 | 621 个 node_modules |
| TypeScript 编译 | ⚠️ 23 个错误 | 21 在 AuditLogger + 2 在 IndependentEvaluationService |
| 单元测试 | ⚠️ 14 失败 / 11 通过 | 全部 202 个测试运行时通过，但 14 个套件因编译错误无法启动 |
| ESLint | ❌ 189 个非格式错误 | 未使用变量、any 类型、未处理 Promise |
| Prettier | ❌ 1777 个格式问题 | 自动可修复 |
| 服务启动 | ✅ 已验证 | `http://localhost:3111` 正常响应 |
| 数据库 | ❌ 测试需要 mock | better-sqlite3 需 mock 环境 |

### 14 个失败测试套件

| 测试文件 | 失败原因 |
|----------|----------|
| `tests/harness/loop.test.ts` | 编译错误 |
| `tests/harness/tools.test.ts` | 编译错误 |
| `tests/harness/verification.test.ts` | 编译错误 |
| `tests/harness/phase2-loop-context.test.ts` | 编译错误 |
| `tests/harness/phase3-4-deep.test.ts` | 编译错误 |
| `tests/harness/phase5-routing.test.ts` | 编译错误 |
| `tests/harness/step-evaluator.test.ts` | 编译错误 |
| `tests/harness/integration.test.ts` | 编译错误 |
| `tests/harness/full-pipeline.test.ts` | 编译错误 |
| `tests/harness/comprehensive-coverage.test.ts` | 编译错误 |
| `tests/harness/independent-evaluator.test.ts` | 编译错误 |
| `tests/harness/persistence-injection.test.ts` | 编译错误 |
| `tests/unit/security/AuditLogger.test.ts` | 编译错误 |
| `tests/unit/security/SecurityManager.test.ts` | 编译错误 |

---

## 二、5 阶段开发计划

### Phase 1: 修复阻塞问题（1-2 天）

**目标：** 让 TypeScript 编译通过 + 测试全部运行

#### 1.1 修复 AuditLogger.ts 类型错误（20 个）
- `AuditLogEntry` 接口缺少 `actor`、`target`、`category`、`userId`、`resource` 字段
- `result` 类型 \"success\"|\"failure\" 缺少 \"warning\"
- 修复：在类型定义中补充缺失字段

#### 1.2 修复 IndependentEvaluationService.ts 类型错误（3 个）
- `completed` 属性类型不匹配（布尔 | undefined）
- `tool_calls` 可能为 undefined
- `content` 类型不匹配 undefined

#### 1.3 修复 AgentHarness.ts 接口缺失
- `historyProvider` 缺少 `getAllHistory()` 方法
- 在创建 historyProvider 时补充该方法

#### 1.4 ESLint 修复
- 运行 `eslint --fix` 修复自动可修复问题（约 1777 个）
- 处理 189 个手动错误：未使用变量清理、any 类型替换

---

### Phase 2: 核心架构加固（2-3 天）

**目标：** 解决已识别的架构缺陷

#### 2.1 实现 Context Compaction（上下文压缩）
- 位置：`src/harness/context/ContextManager.ts`
- 实现 `compressHistory()` 方法：合并早期对话为摘要
- 触发条件：Token 预算超过阈值

#### 2.2 实现 Context Summarization（上下文摘要）
- 位置：`src/harness/context/ContextManager.ts`
- 实现 `summarizeHistory()` 方法：LLM 生成对话摘要
- 存储到 LongTermMemory

#### 2.3 实现 Context Offloading（上下文卸荷）
- 位置：`src/harness/context/ContextManager.ts`
- 实现 `offloadHistory()` 方法：将早期对话写入文件系统
- 设计 LRU 策略 + 卸荷索引

#### 2.4 Evaluator 解耦
- 将 Evaluator 从 LoopController 中独立出来
- 实现独立评估 Agent 模式

---

### Phase 3: 评估体系升级（2-3 天）

**目标：** 建立可信的评估和审计系统

#### 3.1 建立 Golden Eval Set
- 收集真实世界的成功/失败案例
- 手工标注预期输出
- 自动化回归验证

#### 3.2 审计系统修复
- 修复 `AuditLogger.ts` 全部类型错误（保证编译通过）
- 完善全轨迹审计（trajectory-level audit）
- 确保审计日志器初始化正确

#### 3.3 多裁判共识评分
- 实现多 LLM 交叉验证机制
- 分数聚合算法

---

### Phase 4: 代码质量提升（1-2 天）

**目标：** 消除技术债务

#### 4.1 类型系统加固
- 逐个替换 `any` 类型为具体接口
- 添加 strictNullChecks 兼容代码

#### 4.2 错误处理统一
- 统一项目中所有 catch 块的错误处理模式
- 添加结构化错误类型

#### 4.3 Promise 链规范化
- 处理所有未 await 的 Promise
- 添加 .catch 或 void 操作符

#### 4.4 仪表盘开发展示
- 前端测试面板显示进度和通过率
- 整理CLI命令执行

---

### Phase 5: 功能增强（3-5 天）

**目标：** 新功能开发

#### 5.1 速率限制 + 熔断器
- 实现令牌桶算法
- 添加并发上限控制
- 实现熔断机制（断路器模式）

#### 5.2 增强回溯策略
- 支持多次重试（当前仅 1 次）
- 实现回溯路径探索

#### 5.3 混沌测试框架
- 注入随机故障
- 验证系统容错能力

#### 5.4 插件签名验证
- PKI 签名验证机制
- 插件来源信任链

#### 5.5 工具初始化
- 多 Agent 协作模式基础框架

---

## 三、优先级策略

```
Phase 1: 🔴 P0 — 编译+测试修复   可立即产出 → UI 开发看板展示 
Phase 2: 🟠 P1 — 架构加固
Phase 3: 🟡 P2 — 评估体系
Phase 4: 🔵 P3 — 代码质量
Phase 5: 🟢 P4 — 功能增强
```

---

## 四、已知缺陷清单

### 编译错误（27 个）
1. `src/security/AuditLogger.ts` — 21 个: `AuditLogEntry` 类型缺字段
   - 缺 `actor`、`target`、`category`、`userId`、`resource`
   - `result` 类型需加 \"warning\"
2. `src/harness/AgentHarness.ts` — 1 个: 缺 `getAllHistory()`
3. `src/harness/evaluation/IndependentEvaluationService.ts` — 3 个: 类型不完整

### ESLint 问题（189 个非格式问题）
- `no-unused-vars` — 未使用变量/参数（最多）
- `no-explicit-any` — 大量 any 类型
- `no-floating-promises` — 未处理的 Promise
- `await-thenable` — 对非 Promise 值使用 await
- `ban-ts-comment` — 大量 @ts-ignore

### 架构缺陷
1. 无上下文缩减（Compaction / Summarization / Offloading 均未实现）
2. Evaluator 非独立（与执行循环耦合）
3. 无 Golden Eval Set
4. 回溯最多 1 次
5. 混沌测试 / 对抗测试 — 未实施
6. 插件签名验证 — 未实施
7. 速率限制 + 并发上限 + 熔断 — 仅部分实现
8. 全轨迹审计 — trajectory-level 审计未实现
