# 废弃组件清单及时间表

**生成日期**: 2026-06-24  
**版本**: V5.0  
**预计清理版本**: V6.0（约 2026-09）

---

## 概述

家百星 V5.0 正在进行双后端架构迁移，核心 AI 能力从 TypeScript 迁移到 Python。
部分 TypeScript 端组件已标记为废弃，将在 V6.0 版本中移除。

**迁移策略**：

- 默认使用 Python 后端（AGENT_BACKEND=python）
- TypeScript 端组件仅用于回退（AGENT_BACKEND=local）
- 废弃组件仅接收安全修复，不再新增功能
- 预计 V6.0 版本移除所有废弃组件

---

## 废弃组件清单

### 1. LoopController（TypeScript 端）

| 项目             | 详情                                        |
| ---------------- | ------------------------------------------- |
| **组件名称**     | LoopController                              |
| **文件路径**     | `src/harness/loop/LoopController.ts`        |
| **废弃版本**     | V5.0                                        |
| **迁移日期**     | 2026-06-22                                  |
| **预计移除版本** | V6.0（约 2026-09）                          |
| **替代方案**     | Python 端 `python/agent/loop/controller.py` |
| **回退方式**     | 设置 `AGENT_BACKEND=local`                  |
| **维护状态**     | 仅安全修复，不再新增功能                    |
| **影响范围**     | 执行层主循环                                |

**功能说明**：

- Plan-Execute-Evaluate 状态机
- 预算控制（轮次、token、工具调用、时长）
- 反思纠错机制
- 因果建模
- 辩论验证（可选）

---

### 2. MemoryEngine（TypeScript 端）

| 项目             | 详情                             |
| ---------------- | -------------------------------- |
| **组件名称**     | MemoryEngine                     |
| **文件路径**     | `src/memory/MemoryEngine.ts`     |
| **废弃版本**     | V5.0                             |
| **迁移日期**     | 2026-06-22                       |
| **预计移除版本** | V6.0（约 2026-09）               |
| **替代方案**     | Python 端 `python/agent/memory/` |
| **回退方式**     | 设置 `AGENT_BACKEND=local`       |
| **维护状态**     | 仅安全修复，不再新增功能         |
| **影响范围**     | 状态层记忆系统                   |

**功能说明**：

- 三层记忆架构（瞬时/短期/长期）
- 混合检索（关键词 + 语义 + 向量）
- 记忆晋升机制
- 知识图谱构建
- 对话压缩
- 记忆加密

---

### 3. VectorDatabaseFactory（简化版）

| 项目             | 详情                                        |
| ---------------- | ------------------------------------------- |
| **组件名称**     | VectorDatabaseFactory（简化版存根）         |
| **文件路径**     | `src/memory/VectorDatabaseFactory.ts`       |
| **废弃版本**     | V5.0                                        |
| **废弃日期**     | 2026-06-24                                  |
| **预计移除版本** | V6.0（约 2026-09）                          |
| **替代方案**     | `src/memory/VectorDatabase.ts` 中的完整实现 |
| **维护状态**     | 仅安全修复，不再新增功能                    |
| **影响范围**     | 向量数据库                                  |

**功能说明**：

- 简化版向量数据库实现
- 仅支持内存模式
- 为 MemoryEngine 提供向量数据库创建能力

**注意**：

- 此文件为简化版存根，功能有限
- 完整实现请参考 `VectorDatabase.ts`
- 由于 MemoryEngine 整体已废弃，此文件暂不做重构
- 将随 MemoryEngine 一起在 V6.0 移除

---

### 4. TypeScript 端其他相关组件

以下组件随主组件一起废弃，将在 V6.0 移除：

| 组件名称               | 文件路径                               | 说明                                     |
| ---------------------- | -------------------------------------- | ---------------------------------------- |
| Planner                | `src/harness/loop/Planner.ts`          | 规划器，随 LoopController 一起废弃       |
| Executor               | `src/harness/loop/Executor.ts`         | 执行器，随 LoopController 一起废弃       |
| Evaluator              | `src/harness/loop/Evaluator.ts`        | 评估器，随 LoopController 一起废弃       |
| Reporter               | `src/harness/loop/Reporter.ts`         | 报告器，随 LoopController 一起废弃       |
| ReflectionEngine       | `src/harness/loop/ReflectionEngine.ts` | 反思引擎，随 LoopController 一起废弃     |
| CausalModeler          | `src/harness/loop/CausalModeler.ts`    | 因果建模器，随 LoopController 一起废弃   |
| ShortTermMemory        | `src/memory/ShortTermMemory.ts`        | 短期记忆，随 MemoryEngine 一起废弃       |
| LongTermMemory         | `src/memory/LongTermMemory.ts`         | 长期记忆，随 MemoryEngine 一起废弃       |
| MemoryRetriever        | `src/memory/MemoryRetriever.ts`        | 记忆检索器，随 MemoryEngine 一起废弃     |
| KnowledgeGraphBuilder  | `src/memory/KnowledgeGraphBuilder.ts`  | 知识图谱构建器，随 MemoryEngine 一起废弃 |
| ConversationCompressor | `src/memory/ConversationCompressor.ts` | 对话压缩器，随 MemoryEngine 一起废弃     |
| MemoryEncryption       | `src/memory/MemoryEncryption.ts`       | 记忆加密，随 MemoryEngine 一起废弃       |
| MemoryTracker          | `src/memory/MemoryTracker.ts`          | 记忆追踪器，随 MemoryEngine 一起废弃     |

---

## 迁移路线图

### Phase 1: V5.0（当前版本）

- ✅ Python 端核心功能实现完成
- ✅ 双后端切换机制建立
- ✅ TypeScript 端组件标记为废弃
- ⏳ 功能对齐验证（进行中）
- ⏳ 性能对比测试

### Phase 2: V5.x（过渡期）

- Python 端功能持续优化
- TypeScript 端仅接收安全修复
- 收集用户反馈，验证 Python 端稳定性
- 逐步减少对 TypeScript 端的依赖

### Phase 3: V6.0（预计 2026-09）

- 移除 TypeScript 端废弃组件
- TypeScript 端仅保留薄网关功能
- Python 端成为唯一的 AI 引擎
- 简化架构，降低维护成本

---

## 回退方案

如果 Python 后端出现问题，可以通过以下方式回退到 TypeScript 本地实现：

1. 设置环境变量：

   ```bash
   AGENT_BACKEND=local
   ```

2. 重启服务

3. 验证回退成功：
   - 检查日志中是否有 "使用 TS 本地实现" 相关信息
   - 验证核心功能是否正常

**注意**：回退方案仅用于紧急情况，不建议长期使用。
TypeScript 端组件已停止功能更新，可能缺少最新特性。

---

## 验证清单

### 功能对齐验证

- [ ] 主循环功能对齐
- [ ] 工具调用功能对齐
- [ ] 记忆系统功能对齐
- [ ] 反思纠错功能对齐
- [ ] 规划功能对齐
- [ ] 编排层功能对齐

### 性能验证

- [ ] 响应时间对比
- [ ] 内存占用对比
- [ ] 稳定性对比

### 兼容性验证

- [ ] API 接口兼容性
- [ ] 数据格式兼容性
- [ ] 配置项兼容性

---

## 风险评估

| 风险项              | 影响 | 概率 | 缓解措施             |
| ------------------- | ---- | ---- | -------------------- |
| Python 端功能不完整 | 高   | 中   | 保持双后端，逐步验证 |
| 性能下降            | 中   | 低   | 性能测试，优化瓶颈   |
| 数据迁移问题        | 中   | 低   | 提供数据迁移工具     |
| 回退方案失效        | 高   | 低   | 定期测试回退路径     |

---

## 联系方式

如有迁移相关问题，请联系架构团队。

---

**文档版本**: 1.0  
**最后更新**: 2026-06-24
