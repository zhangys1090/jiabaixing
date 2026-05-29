# Jiabaixing V5.0 架构优化计划

> 生成日期: 2026-05-29
> 基于对当前代码库的全面审查

---

## 一、现状分析

### 1.1 架构概览

当前系统为 **Jiabaixing V5.0 — Harness Agent Framework 六维管控智能体系统**，采用前后端分离架构：

- **后端**: Express + TypeScript，核心模块包括 `core/`、`harness/`、`memory/`、`models/`、`security/`、`evolution/`、`integration/`、`desktop/` 等
- **前端**: React + TypeScript (CRA)，WebSocket 实时通信
- **数据层**: better-sqlite3 (EventBus/轨迹/记忆)、向量数据库 (ChromaDB/内存向量)
- **LLM**: OpenAI 兼容接口，支持 DeepSeek + 智谱降级

### 1.2 已识别的核心问题

| 编号 | 问题 | 严重度 | 影响范围 |
|------|------|--------|----------|
| P1 | JiabaixingCore 上帝类，职责过重 | 高 | core/ |
| P2 | 双重 PerformanceMonitor 实现 | 高 | monitoring/ + utils/ |
| P3 | EventBus 单例模块级实例化，测试隔离困难 | 中 | shared/ |
| P4 | LLMProvider 硬编码人设 prompt，重复散落 | 中 | models/ |
| P5 | SecurityManager 使用 require() 动态引入 jsonwebtoken | 中 | security/ |
| P6 | 前端 App.tsx 直接管理 WebSocket，未复用 useWebSocket hook | 中 | frontend/ |
| P7 | MemoryEngine 写入队列无背压控制 | 中 | memory/ |
| P8 | 前端 stores 导出不完整，大量 store 未在 index.ts 导出 | 低 | frontend/stores/ |
| P9 | 循环依赖风险：core ↔ models ↔ memory | 高 | 跨模块 |
| P10 | 日志系统 traceId 使用全局可变状态 | 中 | utils/ |

---

## 二、优化方案

### ~~Phase 1: 架构解耦与职责分离（P1/P9）~~ — 已跳过

> P1 (JiabaixingCore 拆分) 按用户要求跳过，保留现状。

---

### Phase 1: 重复实现统一（P2 — 高优先级）

**目标**: 合并两套 PerformanceMonitor，消除功能重复

#### 2.2.1 PerformanceMonitor 统一

当前存在：
- `src/monitoring/PerformanceMonitor.ts` — EventEmitter 模式，单例，指标收集+告警
- `src/utils/PerformanceMonitor.ts` — `perf` 工具对象，`measure()`/`measureSync()` 计时

**统一方案**:
1. 保留 `src/monitoring/PerformanceMonitor.ts` 作为唯一实现
2. 将 `src/utils/PerformanceMonitor.ts` 中的 `perf.measure()`/`perf.measureSync()` 迁移到 monitoring 版本
3. `src/utils/PerformanceMonitor.ts` 改为从 `src/monitoring/` 重新导出
4. 全局搜索替换 `from '../utils/PerformanceMonitor'` → `from '../monitoring/PerformanceMonitor'`

**文件变更**:
- 修改: `src/monitoring/PerformanceMonitor.ts` (合并功能)
- 修改: `src/utils/PerformanceMonitor.ts` (改为 re-export)
- 修改: 所有引用 `utils/PerformanceMonitor` 的文件

---

### Phase 2: LLM 层优化（P4/P5 — 中优先级）

**目标**: 消除硬编码 prompt，修复动态 require，增强可维护性

#### 2.3.1 Prompt 模板外部化

当前 `LLMProvider` 中硬编码了多套人设 prompt（chat、multimodalChat、analyzeCode、devGenerateCode 等），且存在大量重复。

**方案**:
1. 扩展现有 `src/llm/PromptTemplateEngine.ts`，增加场景化模板注册
2. 将所有人设 prompt 迁移到 `src/config/default.config.ts` 或独立的 `src/llm/prompt-templates.ts`
3. LLMProvider 各方法改为从模板引擎获取 prompt
4. 支持运行时动态更新 prompt（配合进化引擎）

**文件变更**:
- 修改: `src/llm/PromptTemplateEngine.ts` (扩展模板注册能力)
- 新增: `src/llm/prompt-templates.ts` (模板定义)
- 修改: `src/models/LLMProvider.ts` (使用模板引擎)

#### 2.3.2 修复 SecurityManager 动态 require

```typescript
// 当前问题代码 (SecurityManager.ts L213)
const jwt = require('jsonwebtoken');
```

**方案**: 改为顶部静态 import，与项目其他模块保持一致

**文件变更**:
- 修改: `src/security/SecurityManager.ts`

---

### Phase 3: EventBus 与日志优化（P3/P10 — 中优先级）

**目标**: 改善 EventBus 可测试性，消除全局可变状态

#### 2.4.1 EventBus 延迟实例化

当前 `EventBus` 在模块加载时立即创建单例，导致测试无法隔离。

**方案**:
1. 导出 `JiabaixingEventBus` 类和 `getEventBus()` 工厂函数
2. `getEventBus()` 首次调用时才创建实例
3. 提供 `resetEventBus()` 用于测试清理
4. 现有 `EventBus` 导出保持兼容（指向懒实例）

**文件变更**:
- 修改: `src/shared/EventBus.ts`

#### 2.4.2 Logger traceId 改为 AsyncLocalStorage

当前使用全局可变对象 `{ id: string | null }` 存储 traceId，并发请求会互相覆盖。

**方案**:
1. 使用 Node.js `AsyncLocalStorage` 替代全局变量
2. `setTraceId`/`getTraceId`/`clearTraceId` 基于 ALS 实现
3. 在 HTTP 请求中间件和 WebSocket 处理中自动传播 traceId

**文件变更**:
- 修改: `src/utils/Logger.ts`

---

### Phase 4: 前端优化（P6/P8 — 中优先级）

**目标**: 前端架构规范化，消除重复逻辑

#### 2.5.1 App.tsx WebSocket 重构

当前 `App.tsx` 直接创建 WebSocket，但项目已有完善的 `useWebSocket` hook。

**方案**:
1. App.tsx 改用 `useWebSocket` hook
2. 将 `connectionStatus` 和 `ws` 通过 Context 或 store 共享
3. 移除 App.tsx 中的直接 WebSocket 管理

**文件变更**:
- 修改: `src/frontend/src/App.tsx`
- 可能修改: `src/frontend/src/contexts/ChatContext.tsx`

#### 2.5.2 Stores 导出规范化

当前 `stores/index.ts` 仅导出 2 个 store，但实际存在 12+ 个 store 文件。

**方案**:
1. 在 `stores/index.ts` 中补全所有 store 的导出
2. 统一 store 命名规范

**文件变更**:
- 修改: `src/frontend/src/stores/index.ts`

---

### Phase 5: MemoryEngine 背压控制（P7 — 中优先级）

**目标**: 防止写入队列在高压场景下无限增长

#### 2.6.1 写入队列背压

当前 `MemoryEngine.writeQueue` 有 `MAX_WRITE_QUEUE_SIZE=1000` 限制，但仅丢弃最旧项，无流控反馈。

**方案**:
1. 当队列超过阈值时，返回背压信号给调用方
2. `storeShortTermMemory`/`storeLongTermMemory` 在队列满时改为同步等待
3. 增加队列水位监控指标

**文件变更**:
- 修改: `src/memory/MemoryEngine.ts`

---

## 三、实施路线图

```
Week 1: Phase 1 (重复统一) + Phase 2 (LLM 优化)
  ├── Day 1-2: PerformanceMonitor 合并
  ├── Day 3-4: Prompt 模板外部化
  ├── Day 5:   SecurityManager 修复 + 测试

Week 2: Phase 3 (EventBus/日志) + Phase 4 (前端)
  ├── Day 1-2: EventBus 延迟实例化 + Logger ALS
  ├── Day 3-4: App.tsx WebSocket 重构 + Stores 规范化
  ├── Day 5:   集成测试

Week 3: Phase 5 (Memory 背压) + 全量回归
  ├── Day 1-2: MemoryEngine 背压控制
  ├── Day 3-5: 全量回归测试 + 修复
```

---

## 四、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| PerformanceMonitor 合并破坏现有监控 | 低 | 中 | 保留 re-export 兼容层，渐进迁移 |
| Logger ALS 在某些场景不兼容 | 低 | 中 | 保留全局变量作为 fallback |
| 前端重构影响用户体验 | 低 | 低 | 仅修改内部实现，不改变 UI |

---

## 五、验收标准

1. ✅ 无重复的 PerformanceMonitor 实现
2. ✅ LLMProvider 中无硬编码 prompt 字符串
3. ✅ SecurityManager 无动态 require
4. ✅ EventBus 支持测试隔离
5. ✅ Logger traceId 并发安全
6. ✅ 前端 App.tsx 使用 useWebSocket hook
7. ✅ 所有现有测试 100% 通过
8. ✅ `npm run lint` 无新增错误
