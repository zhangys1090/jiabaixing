# 进化引擎与上下文构建器架构分析报告

**报告日期**: 2026-06-24  
**分析范围**: 进化引擎 V1/V2 并存问题、上下文构建器多套实现问题  
**技术栈**: TypeScript + Python 混合架构

---

## 一、进化引擎 V1/V2 分析

### 1.1 目录结构与文件清单

#### TypeScript 端

**进化引擎根目录**: `src/evolution/`

| 文件                            | 大小   | 说明                             |
| ------------------------------- | ------ | -------------------------------- |
| EvolutionEngine.ts              | 35KB   | V1 进化引擎（已标记 deprecated） |
| EvolutionOrchestrator.ts        | 34KB   | 进化编排器 v2，统一调度所有引擎  |
| EvolutionKnowledgeBase.ts       | 9.6KB  | 进化知识库                       |
| FeedbackCollector.ts            | 9.7KB  | 反馈收集器                       |
| LearningSignalCollector.ts      | 2KB    | 学习信号收集器                   |
| LLMCapabilityDetector.ts        | 17KB   | LLM 能力探测器                   |
| OptimizationResultDispatcher.ts | 5.3KB  | 优化结果分发器                   |
| SkillUsageTracker.ts            | 10KB   | 技能使用追踪器                   |
| StrategyAdapter.ts              | 11.6KB | 策略适配器                       |
| StrategyAdjuster.ts             | 4.4KB  | 策略调整器                       |
| StrategyOptimizer.ts            | 7.5KB  | 策略优化器                       |
| index.ts                        | 368B   | 统一导出（V2 only）              |

**V2 子目录**: `src/evolution/v2/`

| 文件                      | 大小   | 说明                |
| ------------------------- | ------ | ------------------- |
| EvolutionEngineV2.ts      | 15KB   | V2 真正自我进化引擎 |
| EvolutionPlanner.ts       | 5.6KB  | 进化规划器          |
| EvolutionRollback.ts      | 4.8KB  | 进化回滚机制        |
| SelfModificationEngine.ts | 13.4KB | 自我修改引擎        |
| types.ts                  | 3.6KB  | 类型定义            |

#### Python 端

**进化引擎目录**: `python/agent/evolution/`

| 文件                       | 大小   | 说明            |
| -------------------------- | ------ | --------------- |
| engine.py                  | 33.7KB | V1 进化引擎     |
| v2_engine.py               | 30.6KB | V2 进化引擎     |
| orchestrator.py            | 20.5KB | 进化编排器      |
| skill_engine.py            | 22.4KB | 技能进化引擎    |
| skill_usage_tracker.py     | 12KB   | 技能使用追踪器  |
| strategy_adapter.py        | 13KB   | 策略适配器      |
| llm_capability_detector.py | 12.6KB | LLM 能力探测器  |
| fewshot_generalizer.py     | 8.7KB  | Few-shot 泛化器 |
| types.py                   | 2.8KB  | 类型定义        |

---

### 1.2 功能对比

#### V1 vs V2 功能对比表

| 功能维度     | V1 (EvolutionEngine)     | V2 (EvolutionEngineV2)                             |
| ------------ | ------------------------ | -------------------------------------------------- |
| **核心定位** | 反馈学习，参数优化       | 真正自我进化，代码自修改                           |
| **学习方式** | 从交互反馈中提取模式     | 主动分析问题，生成进化计划                         |
| **修改范围** | 仅修改参数、提示词、权重 | 可直接修改代码文件                                 |
| **进化类型** | Prompt优化、工具权重调整 | 代码修复、代码优化、Prompt改进、工具增强、架构变更 |
| **回滚机制** | 无                       | 有完整的回滚机制（EvolutionRollback）              |
| **规划能力** | 简单的规则触发           | 有专门的进化规划器（EvolutionPlanner）             |
| **风险控制** | 相对保守，风险低         | 风险较高，有风险等级评估                           |
| **执行方式** | 即时生效                 | 生成计划→验证→执行→回滚                            |

#### V1 核心功能

1. **反馈收集**：记录交互结果（成功/失败、质量评分、工具使用等）
2. **Prompt 示例学习**：从低质量交互中提取 PromptExample（触发→纠正模式）
3. **工具权重计算**：从工具调用统计中计算进化权重
4. **策略优化**：生成策略优化建议
5. **知识持久化提示**：识别需要持久化的知识
6. **技能泛化**：从示例中泛化通用技能

#### V2 核心功能

1. **进化规划**：根据问题原因生成详细的进化计划
2. **自我修改**：直接修改代码文件（SelfModificationEngine）
3. **回滚机制**：进化失败时自动回滚（EvolutionRollback）
4. **多类型进化**：
   - CODE_FIX - 代码修复
   - CODE_OPTIMIZATION - 代码优化
   - PROMPT_IMPROVEMENT - Prompt 改进
   - TOOL_ENHANCEMENT - 工具增强
   - ARCHITECTURE_CHANGE - 架构变更
5. **风险评估**：对进化操作进行风险等级评估
6. **策略学习**：记录策略效果，调整策略权重

---

### 1.3 调用关系

#### 调用链路图

```
用户交互
    ↓
EvolutionOrchestrator（进化编排器）←── 统一入口
    ├─ 收集交互数据
    ├─ 协调各引擎优化周期
    ├─ 提供统一指标
    │
    ├─→ EvolutionEngine (V1) ←── 反馈学习，参数优化
    │     ├─ 收集反馈
    │     ├─ 计算工具权重
    │     └─ 生成 Prompt 示例
    │
    └─→ EvolutionEngineV2 (V2) ←── 真正自我进化
          ├─ EvolutionPlanner（进化规划）
          ├─ SelfModificationEngine（自我修改）
          └─ EvolutionRollback（进化回滚）
```

#### 入口点

1. **主入口**：`EvolutionOrchestrator.recordInteraction()`
   - 统一记录交互，同时驱动所有子引擎

2. **V1 入口**：
   - `EvolutionEngine.collectFeedback()` - 收集反馈
   - `EvolutionEngine.assessQuality()` - 评估质量
   - `EvolutionEngine.generateSkill()` - 生成技能
   - `EvolutionEngine.nudgeKnowledgePersistence()` - 知识持久化提示

3. **V2 入口**：
   - `EvolutionEngineV2.triggerEvolution()` - 触发进化

#### 调用方

- **AgentHarness**：通过 HarnessDeps 注入进化引擎
- **LoopController**：在主循环中调用进化相关功能
- **initHarness.ts**：初始化时注册进化引擎到编排器

---

### 1.4 职责边界

#### V1 职责（反馈学习层）

- ✅ 从交互中学习模式和规律
- ✅ 优化运行时参数（工具权重、Prompt 示例等）
- ✅ 低风险，不修改代码
- ✅ 实时生效，快速迭代
- ✅ 适合高频、小幅度的优化

#### V2 职责（自我进化层）

- ✅ 真正的代码级自我修改
- ✅ 处理复杂问题和系统性改进
- ✅ 有完整的规划→执行→验证→回滚流程
- ✅ 高风险，需要谨慎执行
- ✅ 适合低频、大幅度的架构级优化

#### 关系定位

**结论：V1 和 V2 是互补关系，不是替代关系**

- V1 负责"日常学习"：从每次交互中快速学习，优化参数
- V2 负责"深度进化"：定期或在特定触发条件下进行深度代码级改进
- 两者配合形成"快速迭代 + 深度进化"的双层进化体系

#### 迁移状态

- TypeScript 端 V1 已标记 deprecated，但仍在被 EvolutionOrchestrator 使用
- Python 端 V1 和 V2 并存，由 orchestrator 统一调度
- 整体处于"双轨并行"状态，尚未完全统一

---

### 1.5 统一方案

#### 推荐方案：方案 C - 部分重叠，合并重复功能，保留各自特色

**理由**：

1. V1 和 V2 定位不同，一个是参数优化，一个是代码自修改
2. 两者是互补关系，不是替代关系
3. 但确实存在一些重复功能（如反馈收集、策略学习等）

**统一方案**：

1. **明确分层定位**：
   - V1 层：反馈学习 + 参数优化（轻量、快速、低风险）
   - V2 层：代码级自我进化（重量、深度、高风险）

2. **合并重复功能**：
   - 统一反馈收集机制
   - 统一策略学习框架
   - 统一指标收集和展示

3. **保留各自特色**：
   - V1 保留：快速反馈学习、工具权重调整、Prompt 示例生成
   - V2 保留：代码自修改、进化规划、回滚机制、风险评估

4. **统一入口**：
   - 继续使用 EvolutionOrchestrator 作为统一入口
   - 明确各引擎的职责边界和触发条件

---

### 1.6 实施计划

#### Phase 1: 文档与注释（已完成）

- ✅ 明确 V1 和 V2 的职责边界
- ✅ 在代码中补充注释说明两者关系
- ✅ 补充架构文档

#### Phase 2: 接口统一（1-2 周）

- [ ] 统一反馈数据结构
- [ ] 统一指标收集接口
- [ ] 统一进化触发机制

#### Phase 3: 重复功能合并（2-4 周）

- [ ] 合并反馈收集逻辑
- [ ] 合并策略学习框架
- [ ] 统一指标展示

#### Phase 4: 深度优化（1-2 月）

- [ ] 优化双层进化协作机制
- [ ] 完善风险控制体系
- [ ] 增加进化效果评估

---

## 二、上下文构建器分析

### 2.1 实现清单

#### TypeScript 端

**Harness 层上下文**: `src/harness/context/`

| 文件                        | 大小   | 说明                   | 状态             |
| --------------------------- | ------ | ---------------------- | ---------------- |
| ContextManager.ts           | 47.9KB | 上下文管理器（主入口） | ⚠️ 已 deprecated |
| ContextFileRegistry.ts      | 10.3KB | 上下文文件注册         | 正常             |
| ContextReferenceResolver.ts | 7.7KB  | @引用解析器            | 正常             |
| ContextWindowManager.ts     | 12.2KB | 上下文窗口管理器       | 正常             |
| TokenBudgetAllocator.ts     | 3KB    | Token 预算分配器       | 正常             |

**Core 层上下文**: `src/core/`

| 文件                         | 大小   | 说明               | 状态 |
| ---------------------------- | ------ | ------------------ | ---- |
| ConstitutionPromptBuilder.ts | 20KB   | 宪法 Prompt 构建器 | 正常 |
| UnifiedContextPipeline.ts    | 11.6KB | 统一上下文管道 v2  | 正常 |

**Memory 层上下文**: `src/memory/`

| 文件                 | 大小   | 说明             | 状态 |
| -------------------- | ------ | ---------------- | ---- |
| LLMContextBuilder.ts | 11.7KB | LLM 上下文构建器 | 正常 |

#### Python 端

**Core 层**: `python/agent/core/`

| 文件                  | 大小   | 说明         |
| --------------------- | ------ | ------------ |
| context_pipeline.py   | 19.1KB | 上下文管道   |
| context_compressor.py | 13.7KB | 上下文压缩器 |

**Context 层**: `python/agent/context/`

| 文件               | 大小  | 说明       |
| ------------------ | ----- | ---------- |
| attention_focus.py | 6.9KB | 注意力聚焦 |

---

### 2.2 职责对比

#### 各实现职责对比表

| 组件                            | 核心职责                                       | 输入                       | 输出                       | 使用场景                 |
| ------------------------------- | ---------------------------------------------- | -------------------------- | -------------------------- | ------------------------ |
| **ConstitutionPromptBuilder**   | 构建系统提示词（身份、人格、规则、工具清单）   | 用户ID、项目上下文         | 完整的系统 Prompt 字符串   | 每次对话的系统提示词构建 |
| **ContextManager** (deprecated) | Harness 层上下文管理，整合各种来源             | 用户输入、对话历史、记忆等 | 结构化上下文对象           | Harness 主循环（已废弃） |
| **UnifiedContextPipeline**      | 统一上下文管道，集成记忆、场景、情感、用户画像 | 用户输入、用户ID           | 结构化 UnifiedContext 对象 | 核心交互流程             |
| **LLMContextBuilder**           | 智能记忆筛选，构建记忆上下文片段               | 记忆列表、查询文本         | 筛选后的记忆上下文         | 记忆检索后的智能筛选     |
| **ContextFileRegistry**         | 项目文件上下文管理                             | 项目文件列表               | 上下文文件条目             | 项目级上下文加载         |
| **ContextReferenceResolver**    | @文件名等引用解析                              | 用户输入文本               | 解析后的文本 + 引用内容    | 用户输入中的文件引用解析 |
| **ContextWindowManager**        | 上下文窗口大小管理                             | 对话历史、Token 预算       | 裁剪后的对话历史           | Token 预算控制           |
| **TokenBudgetAllocator**        | Token 预算分配                                 | 总预算、各组件需求         | 各组件 Token 分配方案      | 上下文构建前的预算规划   |

---

### 2.3 依赖关系

#### 依赖关系图

```
用户输入
    ↓
┌─────────────────────────────────────────────────┐
│  UnifiedContextPipeline（统一上下文管道 v2）     │
│  ├─ 场景检测                                     │
│  ├─ 情感检测                                     │
│  ├─ 时间上下文构建                               │
│  ├─ 用户画像构建                                 │
│  ├─ 数据主权评分                                 │
│  └─→ LLMContextBuilder（智能记忆筛选）          │
│        └─→ MemoryEngine（记忆检索）              │
└─────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────┐
│  ConstitutionPromptBuilder（宪法 Prompt 构建器） │
│  ├─ 身份人格                                     │
│  ├─ 行为准则                                     │
│  ├─ 工具清单                                     │
│  ├─ 用户画像注入                                 │
│  └─ 项目上下文注入                               │
└─────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────┐
│  ContextManager（Harness 层，已 deprecated）     │
│  ├─ ContextWindowManager（窗口管理）             │
│  ├─ TokenBudgetAllocator（预算分配）             │
│  ├─ ContextFileRegistry（文件注册）              │
│  └─ ContextReferenceResolver（引用解析）         │
└─────────────────────────────────────────────────┘
    ↓
最终 Prompt
```

#### 数据流向

1. **用户输入** → `ContextReferenceResolver` → 解析 @引用
2. **解析后输入** → `UnifiedContextPipeline` → 构建结构化上下文
   - 场景检测
   - 情感检测
   - 记忆检索 + LLMContextBuilder 筛选
   - 用户画像构建
   - 数据主权评分
3. **结构化上下文** → `ConstitutionPromptBuilder` → 构建系统 Prompt
4. **系统 Prompt + 对话历史** → `ContextManager` (deprecated) → 最终上下文
   - Token 预算分配
   - 上下文窗口管理
   - 上下文压缩/摘要

#### 循环依赖检查

✅ **无循环依赖**

- ConstitutionPromptBuilder 不依赖其他上下文组件
- UnifiedContextPipeline 依赖 LLMContextBuilder
- LLMContextBuilder 依赖 MemoryEngine
- ContextManager 依赖 ConstitutionPromptBuilder
- 各辅助组件（FileRegistry、ReferenceResolver 等）相互独立

---

### 2.4 重复功能识别

#### 重复功能分析

| 功能                 | 实现在哪里                              | 重复程度 | 说明                                                              |
| -------------------- | --------------------------------------- | -------- | ----------------------------------------------------------------- |
| **系统 Prompt 构建** | ConstitutionPromptBuilder               | 无重复   | 唯一实现，负责身份、人格、规则等                                  |
| **记忆上下文构建**   | LLMContextBuilder + ContextManager      | 部分重复 | LLMContextBuilder 是专门的记忆筛选器，ContextManager 也有记忆注入 |
| **上下文窗口管理**   | ContextWindowManager                    | 无重复   | 唯一实现                                                          |
| **Token 预算管理**   | TokenBudgetAllocator                    | 无重复   | 唯一实现                                                          |
| **文件引用解析**     | ContextReferenceResolver                | 无重复   | 唯一实现                                                          |
| **项目文件上下文**   | ContextFileRegistry                     | 无重复   | 唯一实现                                                          |
| **统一上下文管道**   | UnifiedContextPipeline + ContextManager | 高度重复 | 两者都是上下文构建的主入口，功能高度重叠                          |

#### 主要重复点

**1. UnifiedContextPipeline vs ContextManager**

- **重叠度**: 高
- **重叠功能**:
  - 都负责整合各种上下文来源
  - 都有记忆注入功能
  - 都作为上下文构建的主入口
- **差异**:
  - ContextManager 是 Harness 层的，更全面，包含窗口管理、Token 预算等
  - UnifiedContextPipeline 是 Core 层的，更聚焦于记忆、场景、情感等 AI 相关上下文
- **状态**: ContextManager 已标记 deprecated，UnifiedContextPipeline 是 v2 版本

**2. LLMContextBuilder vs ContextManager 中的记忆注入**

- **重叠度**: 中
- **重叠功能**: 都负责从记忆中筛选相关内容注入上下文
- **差异**:
  - LLMContextBuilder 是专门的智能筛选器，有去重、压缩、相关性排序等
  - ContextManager 中的记忆注入比较简单
- **状态**: UnifiedContextPipeline 使用 LLMContextBuilder，ContextManager 已 deprecated

---

### 2.5 统一方案

#### 主实现确认

**主实现：UnifiedContextPipeline + ConstitutionPromptBuilder**

**理由**：

1. ContextManager 已标记 deprecated，迁移到 Python 端
2. UnifiedContextPipeline 是 v2 版本，设计更先进
3. ConstitutionPromptBuilder 负责系统 Prompt，职责清晰
4. 各辅助组件（FileRegistry、ReferenceResolver、WindowManager 等）职责单一，保留

#### 统一架构

```
┌─────────────────────────────────────────────────────┐
│  上下文构建统一架构                                   │
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │  ConstitutionPromptBuilder（系统 Prompt 层）   │   │
│  │  - 身份、人格、行为准则                        │   │
│  │  - 工具清单                                    │   │
│  │  - 用户画像注入                                │   │
│  │  - 项目上下文注入                              │   │
│  └───────────────────────────────────────────────┘   │
│                        ↑                              │
│  ┌───────────────────────────────────────────────┐   │
│  │  UnifiedContextPipeline（统一上下文管道 v2）    │   │
│  │  - 场景感知                                    │   │
│  │  - 情感感知                                    │   │
│  │  - 时间上下文                                  │   │
│  │  - 记忆检索 + 智能筛选                         │   │
│  │  - 用户画像构建                                │   │
│  │  - 数据主权审计                                │   │
│  └───────────────────────────────────────────────┘   │
│                        ↑                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ LLMContext  │  │ ContextFile │  │ ContextRef  │  │
│  │ Builder     │  │ Registry    │  │ Resolver    │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
│                        ↑                              │
│  ┌─────────────┐  ┌─────────────┐                    │
│  │ ContextWin- │  │ TokenBudget │                    │
│  │ dowManager  │  │ Allocator   │                    │
│  └─────────────┘  └─────────────┘                    │
└─────────────────────────────────────────────────────┘
```

#### 废弃组件

| 组件                        | 状态             | 替代方案                                            | 预计移除时间       |
| --------------------------- | ---------------- | --------------------------------------------------- | ------------------ |
| ContextManager.ts           | ⚠️ 已 deprecated | UnifiedContextPipeline + Python 端 context_pipeline | V6.0（约 2026-09） |
| ContextManager 中的记忆注入 | ⚠️ 已 deprecated | LLMContextBuilder                                   | V6.0（约 2026-09） |

#### 接口统一建议

1. **统一上下文数据结构**：
   - 定义标准的 Context 接口
   - 各组件输出统一格式
   - 便于组合和扩展

2. **统一构建流程**：
   - 明确各组件的调用顺序
   - 标准化输入输出
   - 便于测试和维护

3. **统一配置方式**：
   - 集中管理上下文相关配置
   - 支持动态调整

---

### 2.6 实施计划

#### Phase 1: 现状确认与文档（已完成）

- ✅ 盘点所有上下文构建器实现
- ✅ 分析各组件职责
- ✅ 梳理依赖关系
- ✅ 识别重复功能

#### Phase 2: 废弃标记与注释（1 周）

- [ ] 确认 ContextManager 的废弃状态
- [ ] 在相关文件中补充注释说明
- [ ] 明确迁移路径和替代方案

#### Phase 3: 接口统一（2-3 周）

- [ ] 定义标准的 Context 接口
- [ ] 统一各组件的输入输出格式
- [ ] 完善类型定义

#### Phase 4: 功能迁移（1-2 月）

- [ ] 将 ContextManager 中的独有功能迁移到 UnifiedContextPipeline
- [ ] 确保所有调用方迁移到新的实现
- [ ] 完善测试覆盖

#### Phase 5: 清理废弃代码（V6.0）

- [ ] 移除 ContextManager
- [ ] 清理相关依赖
- [ ] 更新文档

---

## 三、整体架构优化建议

### 3.1 双后端架构优化

**现状**：TypeScript + Python 双后端，TS 端很多组件已标记 deprecated

**建议**：

1. **明确分层**：
   - TypeScript 端：薄网关 + 前端 + 本地工具 + 集成
   - Python 端：核心 AI 引擎（循环、记忆、进化、编排等）

2. **加速迁移**：
   - 优先迁移核心 AI 能力到 Python 端
   - 逐步减少对 TS 端废弃组件的依赖
   - 按计划在 V6.0 移除废弃组件

3. **统一接口**：
   - 定义标准的跨端接口
   - 确保双端功能对齐
   - 降低通信成本

### 3.2 进化引擎优化

**现状**：V1 + V2 双层进化体系，但职责边界不够清晰

**建议**：

1. **明确分层定位**：
   - V1：快速反馈学习（轻量、实时、低风险）
   - V2：深度代码进化（重量、定期、高风险）

2. **统一入口**：
   - 继续使用 EvolutionOrchestrator 作为统一入口
   - 明确各引擎的触发条件和协作方式

3. **效果评估**：
   - 建立进化效果评估体系
   - 量化进化带来的改进
   - 持续优化进化策略

### 3.3 上下文系统优化

**现状**：多套上下文构建器并存，部分功能重复

**建议**：

1. **统一主实现**：
   - 以 UnifiedContextPipeline + ConstitutionPromptBuilder 为主
   - 逐步淘汰 ContextManager

2. **模块化设计**：
   - 保持各辅助组件的独立性
   - 便于组合和复用
   - 清晰的职责边界

3. **性能优化**：
   - 优化记忆检索和筛选性能
   - 智能上下文压缩
   - Token 预算精细化管理

---

## 四、已完成的修改清单

### 代码修改

| 文件                                  | 修改类型 | 说明                                    |
| ------------------------------------- | -------- | --------------------------------------- |
| `src/harness/loop/LoopController.ts`  | 注释更新 | 更新 @deprecated 注释，添加详细废弃信息 |
| `src/memory/MemoryEngine.ts`          | 注释更新 | 更新 @deprecated 注释，添加详细废弃信息 |
| `src/harness/AgentHarness.ts`         | 注释更新 | 添加双后端架构说明和废弃组件说明        |
| `src/memory/VectorDatabase.ts`        | 注释更新 | 标记为主实现，补充功能说明              |
| `src/memory/VectorDatabaseFactory.ts` | 注释更新 | 标记为 deprecated，添加废弃信息         |

### 新增文档

| 文件                                        | 说明                 |
| ------------------------------------------- | -------------------- |
| `docs/ARCHITECTURE_AUDIT_REPORT.md`         | 架构深度审计报告     |
| `docs/SHORT_TERM_OPTIMIZATION_REPORT.md`    | 短期优化修复报告     |
| `docs/DEPRECATION_SCHEDULE.md`              | 废弃组件清单及时间表 |
| `docs/EVOLUTION_CONTEXT_REFACTOR_REPORT.md` | 本报告               |

---

## 五、后续工作建议

### 高优先级（1-2 周）

1. 完成进化引擎的接口统一
2. 明确上下文构建器的迁移计划
3. 补充更多组件的废弃信息
4. 完善功能对齐测试

### 中优先级（1-2 月）

1. 合并进化引擎的重复功能
2. 统一上下文构建器接口
3. 完善双端功能对齐
4. 优化性能和稳定性

### 低优先级（3-6 月）

1. 按计划移除废弃组件
2. 深度优化进化引擎效果
3. 完善上下文智能程度
4. 持续架构优化

---

**报告生成时间**: 2026-06-24  
**报告版本**: 1.0
