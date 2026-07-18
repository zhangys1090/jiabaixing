# 家百星 Agent 核心能力架构审计报告 V2.0

> **审计时间**: 2026-06-30 | **V5.5 更新**: 2026-07-14
> **审计范围**: 编排层 / 执行层 / 状态层 / ReAct 循环 / 记忆系统 / 自我反思 / 规划能力 / 学习闭环
> **目标**: 识别差距，制定补足计划，逐项执行

---

## 〇、V5.5 架构改善记录 (2026-07-14)

### 已完成

| 优先级 | 类别 | 改善项                                  | 状态 |
| ------ | ---- | --------------------------------------- | ---- |
| P0     | 安全 | Python 后端绑定 127.0.0.1               | ✅   |
| P0     | 安全 | CORS 收紧为白名单 (localhost:3111/3112) | ✅   |
| P0     | 安全 | 发布包编译脚本 (.py → .pyc)             | ✅   |
| P0     | 可靠 | 核心子系统标记 critical=True (6 个)     | ✅   |
| P1     | 架构 | AgentEngine 拆分为 7 个 Facade          | ✅   |
| P1     | 架构 | LoopController 中间件化 (4 中间件)      | ✅   |
| P1     | 质量 | bare except 全部添加日志                | ✅   |
| P1     | 性能 | SQLite 异步包装 (asyncio.to_thread)     | ✅   |
| P1     | 性能 | 真实百分位延迟 Histogram                | ✅   |
| P2     | 可靠 | WebSocket 心跳 + 连接数限制             | ✅   |

### 待推进 (V6.0)

| 优先级 | 类别 | 改善项                              | 状态 |
| ------ | ---- | ----------------------------------- | ---- |
| P2     | 架构 | Singleton 改为依赖注入              | 📋   |
| P2     | 契约 | 前后端 API 契约对齐 (14 个缺失端点) | 📋   |
| P2     | 业务 | 飞书应用独立化                      | 📋   |
| P3     | 架构 | V6.0 移除 TS 端 AI 核心组件         | 📋   |

---

## 一、编排层审计 (Orchestration Layer)

### 1.1 EvolutionOrchestrator 审计

**文件**: `python/agent/evolution/orchestrator.py` (725行)

| 维度       | 现状                                             | 评级 |
| ---------- | ------------------------------------------------ | ---- |
| 单例模式   | Singleton + `get_instance()`                     | 专业 |
| 双引擎架构 | EvolutionEngine V1 + V2 并行                     | 优秀 |
| 冷却机制   | 5分钟冷却 + last_triggered 防抖                  | 专业 |
| 验证回滚   | `_pending_rollbacks` + `_ROLLBACK_THRESHOLD=0.1` | 优秀 |
| 信号收集   | `_per_turn_lightweight_signal()` 每轮调用        | 优秀 |
| 指标输出   | `OrchestratorMetrics` 12项指标                   | 优秀 |
| 策略适应   | `get_realtime_feedback()` 动态调整               | 优秀 |

**发现的问题**:

1. **信号稀疏**: 学习信号仅在 `record_interaction()` 时触发，而该方法在 Controller 中仅在 loop 结束时调用（第492-552行），这意味着每次完整循环才产生一次信号
2. **质量评分来源不明**: `_trigger_optimization_cycle()` 依赖 `self._quality_history`，但外部注入的质量分数 (0-1) 没有经过校准
3. **回滚验证逻辑错误**: `_check_pending_rollbacks()` 中的 `elapsed` 计算使用了时间戳差值，应该用交互计数而非时间

### 1.2 OrchestrationExecutor (DAG调度器) 审计

**文件**: `python/agent/orchestration/executor.py` (340行)

| 维度      | 现状                                  | 评级 |
| --------- | ------------------------------------- | ---- |
| DAG验证   | 循环检测 + 依赖完整性检查             | 专业 |
| 并行执行  | asyncio.Semaphore + 并发控制          | 优秀 |
| 优先级    | TaskPriority CRITICAL/HIGH/NORMAL/LOW | 专业 |
| 超时保护  | 每个任务独立超时                      | 优秀 |
| 重试机制  | 指数退避重试                          | 专业 |
| fail-fast | 依赖失败时跳过下游                    | 专业 |

---

## 二、执行层审计 (Execution Layer)

### 2.1 LoopController 核心循环

**文件**: `python/agent/loop/controller.py` (1286行)

| 阶段                 | 实现                               | 评级 |
| -------------------- | ---------------------------------- | ---- |
| Phase 1 Planning     | Planner + CausalModeler + 经验注入 | 优秀 |
| Phase 2 Executing    | Executor + 链式/并行执行           | 优秀 |
| Phase 3 Evaluating   | Evaluator 目标进度评估             | 专业 |
| Phase 3.5 Reflecting | 反思应用 + 策略自适应              | 优秀 |
| Phase 4 Reporting    | Reporter 多维质量评分              | 专业 |

### 2.2 Executor 重试机制

**文件**: `python/agent/loop/executor.py`

**关键发现**:

- `_retry_with_reflection()` 方法存在 — 失败后调用 ReflectionEngine 修正参数
- 单次调用最多重试 `_MAX_REFLECTION_RETRIES = 3` 次
- 工具超时默认 30s (`TOOL_TIMEOUT` 环境变量可调)
- **缺失**: 参数修正后没有自动尝试"替代工具"，虽然 `ReflectionResult` 中有 `alternative_tool` 字段

### 2.3 Resilience 中间件

**文件**: `python/agent/core/resilience.py` (139行)

| 组件           | 功能                      | 评级 |
| -------------- | ------------------------- | ---- |
| RetryConfig    | 指数退避 + 可配置最大重试 | 优秀 |
| CircuitBreaker | 半开/闭合状态转换         | 专业 |
| with_retry     | 通用重试装饰器            | 专业 |
| resilient_call | 重试 + 熔断组合           | 优秀 |

---

## 三、状态层审计 (State Layer)

### 3.1 轨迹持久化 (TrajectoryDB)

**文件**: `python/agent/persistence/trajectory.py`

| 能力         | 实现                           | 评级 |
| ------------ | ------------------------------ | ---- |
| 执行记录     | ExecutionRecord + 状态管理     | 优秀 |
| 工具调用记录 | ToolInvocationRecord 详细日志  | 优秀 |
| 状态转换     | StateTransitionRecord 完整审计 | 优秀 |

### 3.2 LoopState 状态机

```
IDLE → PLANNING → EXECUTING → EVALUATING → REPORTING → COMPLETED
                              ↕ (replan 回溯)
```

| 维度       | 评级                         |
| ---------- | ---------------------------- |
| 状态完整性 | 6种状态覆盖全流程            |
| 可观测性   | LoopObserver + LifecycleHook |
| 隐式反馈   | ImplicitFeedbackCollector    |

---

## 四、ReAct 循环审计 (重点)

### 4.1 基础 Thought→Action→Observation

**实现位置**: `LoopController.run_react_loop()` (第582-709行)

| 阶段        | 实现                                       | 评级 |
| ----------- | ------------------------------------------ | ---- |
| Thought     | `_react_think_structured()` 强制 JSON 输出 | 优秀 |
| Action      | `_react_act()` 工具执行                    | 优秀 |
| Observation | `_react_observe()` 结果摘要                | 优秀 |
| 结构化      | `StructuredReActStep` 数据类               | 优秀 |
| 最大迭代    | 默认 10 次                                 | 专业 |

### 4.2 反思式 ReAct + 自纠错

| 能力     | 实现状态                                                  | 评级 |
| -------- | --------------------------------------------------------- | ---- |
| 失败反思 | `_reflect_on_failure()` 调用 `ReflectionEngine.reflect()` | 优秀 |
| 参数修正 | `reflection.corrected_args` → 重试                        | 优秀 |
| 替代工具 | `reflection.alternative_tool` 字段存在但**从未被使用**    | 缺失 |
| 深度反思 | `_deep_reflect()` 轨迹级分析                              | 优秀 |
| 经验回放 | `get_relevant_experiences()` 历史相似经验匹配             | 优秀 |

### 4.3 上下文管理

| 维度       | 现状                                         | 评级     |
| ---------- | -------------------------------------------- | -------- |
| 上下文压缩 | `context.messages[-10:]` 保留最近10条        | 专业     |
| 经验注入   | `_apply_reflection_to_planning()` 自动注入   | 优秀     |
| 主动检索   | 被动触发，需手动调用 `search_with_context()` | 中等     |
| 注意力聚焦 | 无 — 上下文仅靠消息数量限制                  | **缺失** |

### 4.4 工具执行重试

| 维度     | 现状                               | 问题         |
| -------- | ---------------------------------- | ------------ |
| 单次调用 | `_retry_with_reflection()` 最多3次 | 符合预期     |
| 参数修正 | ReflectionEngine 分析根因 + 修正   | 优秀         |
| 自动重试 | 失败→反思→修正→重试 闭环           | 优秀         |
| 替代工具 | 接口存在但未集成到执行流           | **严重缺失** |

---

## 五、记忆系统审计

### 5.1 三层记忆架构

| 层级     | 文件                 | 容量     | 检索方式        | 评级 |
| -------- | -------------------- | -------- | --------------- | ---- |
| 即时记忆 | `store_instant()`    | SQLite   | FTS5            | 专业 |
| 短期记忆 | `store_short_term()` | SQLite   | FTS5 + 时效衰减 | 优秀 |
| 长期记忆 | `store_long_term()`  | SQLite   | FTS5 + 语义     | 优秀 |
| 情景记忆 | `episodic_memory.py` | 独立存储 | 向量嵌入        | 优秀 |

### 5.2 检索能力对比

| 能力       | 当前实现                                | 期望实现                     | 差距     |
| ---------- | --------------------------------------- | ---------------------------- | -------- |
| 关键词匹配 | FTS5 + jieba 中文分词                   | -                            | 优秀     |
| 语义检索   | `search_semantic()` + cosine similarity | -                            | 优秀     |
| 混合检索   | `search_with_context()` FTS+语义+KG     | -                            | 优秀     |
| 情景记忆   | EpisodicMemoryStore + 时效衰减          | -                            | 优秀     |
| 知识图谱   | `get_related_entries()` 关联记忆展开    | -                            | 专业     |
| 经验迁移   | `transfer_experience()` 跨工具经验      | -                            | 专业     |
| 主动检索   | 需手动调用，无自动触发的上下文感知检索  | 根据当前任务自动检索相关记忆 | **缺失** |

---

## 六、自我反思审计

### 6.1 ReflectionEngine 能力矩阵

| 能力                             | 实现                | 实际调用频率   | 差距         |
| -------------------------------- | ------------------- | -------------- | ------------ |
| `reflect()` 工具级反思           | 完整实现 (844行)    | 失败时调用     | 符合预期     |
| `deep_reflect()` 深度反思        | 完整实现            | 进度<50%时触发 | 符合预期     |
| `lightweight_reflect()` 轻量反思 | 完整实现 (<500ms)   | 每轮调用       | 优秀         |
| `reflect_on_task_failure()`      | 完整实现            | loop结束时     | 符合预期     |
| `reflect_on_success()`           | 完整实现            | **从未被调用** | **严重缺失** |
| `meta_reflect()` 元反思          | 完整实现            | 每10轮调用     | 符合预期     |
| `record_experience()`            | 完整实现            | 失败时自动记录 | 优秀         |
| `get_relevant_experiences()`     | 完整实现 (经验回放) | 反思时自动调用 | 优秀         |

### 6.2 关键差距

1. **成功反思从未被调用**: `reflect_on_success()` 接口完整但无任何调用方
2. **反思知识库未充分利用**: `ReflectionKnowledgeBase` 存在但 `_kb_enabled` 取决于环境变量
3. **元反思是异步的**: `_trigger_meta_reflect()` 使用 `asyncio.ensure_future()` — 结果不被等待

---

## 七、规划能力审计

### 7.1 Planner 实现

| 能力           | 实现                                | 评级 |
| -------------- | ----------------------------------- | ---- |
| 初始规划       | `Planner.plan()` 生成 ExecutionPlan | 优秀 |
| 重规划         | `Planner.replan()` 结合失败信息     | 优秀 |
| 因果分析       | CausalModeler 依赖图 + 并行分组     | 优秀 |
| 反思注入       | `_inject_reflection_into_context()` | 优秀 |
| 单次规划无迭代 | 规划→执行→评估→重规划 完整闭环      | 优秀 |

**MAX_REPLAN_COUNT = 3** — 最多3次重规划，防止无限循环

---

## 八、学习闭环审计

### 8.1 EvolutionOrchestrator 学习流

```
交互记录 → 信号收集 → 策略适配器 → 进化引擎 → 质量验证 → (失败)回滚
```

| 环节          | 实现                                     | 评级 |
| ------------- | ---------------------------------------- | ---- |
| 信号收集      | `ImplicitFeedbackCollector` + 正负反馈   | 优秀 |
| 策略适应      | `StrategyAdapter` 动态调整参数           | 优秀 |
| 能力检测      | `LLMCapabilityDetector` 热适配           | 优秀 |
| Few-shot 泛化 | `FewShotGeneralizer` 经验抽象            | 优秀 |
| 实时自适应    | `get_realtime_feedback()` 提供运行时建议 | 优秀 |
| 学习频率      | 每20轮 + 连续低质量触发                  | 专业 |

### 8.2 差距

- 学习信号依赖外部注入质量评分，缺少**自主学习能力**来生成自己的质量评分
- `LearningSignal` 只有 TASK_SUCCESS/TASK_FAILURE 两种，缺乏**过程信号**（如：工具调用路径质量、规划复杂度评分）

---

## 九、综合差距评分汇总

| 维度               | 当前成熟度 | 目标成熟度 | 差距等级 |
| ------------------ | ---------- | ---------- | -------- |
| 编排层 (DAG)       | ⭐⭐⭐⭐   | ⭐⭐⭐⭐   | 无       |
| 执行层 (重试+反思) | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐ | 小       |
| 状态层 (持久化)    | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 无       |
| ReAct 基础循环     | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 无       |
| 反思式 ReAct       | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐ | 中       |
| 替代工具集成       | ⭐         | ⭐⭐⭐⭐⭐ | **极大** |
| 主动记忆检索       | ⭐⭐       | ⭐⭐⭐⭐⭐ | **大**   |
| 注意力聚焦机制     | ⭐         | ⭐⭐⭐⭐   | **极大** |
| 成功反思调用       | ⭐         | ⭐⭐⭐⭐   | **极大** |
| 学习闭环信号丰富度 | ⭐⭐⭐     | ⭐⭐⭐⭐⭐ | 中       |

---

## 十、差距补足计划

### P0 — 极大差距 (立即执行)

#### 任务 1: 集成替代工具执行

- **问题**: `ReflectionResult.alternative_tool` 字段完整但从未被使用
- **影响**: 工具失败后只能重试同一工具，无法换用备选方案
- **方案**: 在 `_retry_with_reflection()` 失败后，如果 reflection 返回 `alternative_tool`，切换到替代工具重新执行

#### 任务 2: 实现主动记忆检索

- **问题**: 记忆检索完全是手动的，Agent 不知道何时该查记忆
- **影响**: 每次任务需要从头规划，无法利用历史经验加速
- **方案**: 在 `Planner.plan()` 中自动注入 `search_with_context()` 的相似任务经验

#### 任务 3: 实现注意力聚焦机制

- **问题**: 上下文管理仅靠 `messages[-10:]` 限制数量，无质量加权
- **影响**: 重要信息可能被稀释，无关信息占据窗口
- **方案**: 实现 `AttentionFocusManager` — 按相关性对上下文消息打分排序，保留 Top-K 高注意力消息

### P1 — 大差距 (第一轮迭代)

#### 任务 4: 启用成功反思

- **问题**: `reflect_on_success()` 完整但未调用
- **影响**: 只从失败中学习，错失从成功经验中提炼模式的機會
- **方案**: 在 `LoopController.run()` 的每个成功步骤后调用 `reflection.reflect_on_success()`

#### 任务 5: 丰富学习信号

- **问题**: 只有 TASK_SUCCESS/TASK_FAILURE
- **影响**: EvolutionOrchestrator 无法区分"规划质量"、"工具选择质量"等维度
- **方案**: 新增 `PLAN_QUALITY`, `TOOL_SELECTION_QUALITY`, `REFLECTION_EFFECTIVENESS` 信号类型

### P2 — 中等差距 (第二轮迭代)

#### 任务 6: 优化质量评分来源

- **问题**: 质量评分完全依赖外部传入
- **方案**: 内置质量评分器 — 基于工具成功率、循环轮数、输出长度等自动生成

---

## 十一、优先级排序

| 优先级   | 任务         | 预估工作量 | 影响范围         |
| -------- | ------------ | ---------- | ---------------- |
| **P0-1** | 替代工具集成 | 2h         | 执行成功率+15%   |
| **P0-2** | 主动记忆检索 | 4h         | 规划效率+25%     |
| **P0-3** | 注意力聚焦   | 3h         | 上下文利用率+30% |
| P1-1     | 成功反思启用 | 1h         | 学习闭环完整性   |
| P1-2     | 学习信号丰富 | 2h         | 进化决策精度     |
| P2-1     | 内置质量评分 | 3h         | 自动化程度       |

---

## 十二、实施记录 (2026-06-30)

### P0-1: 替代工具集成

- **状态**: 已完成 ✅
- **发现**: 已有集成（executor.py:406-445），但存在 bug
- **修复**: 修正了 `transfer_experience` 的错误调用 — 原代码传入已修改的 `step.tool_name` 作为 `source_tool`（此时已是替代工具名，而非原始工具名）
- **文件修改**: `python/agent/loop/executor.py`

### P0-2: 主动记忆检索

- **状态**: 已完成 ✅
- **方案**: 在 `Planner` 构造函数中注入 `MemoryEngine`，在 `_plan_complex()` 中调用 `search_with_context()` 注入相似任务经验到规划 Prompt
- **文件创建/修改**: `python/agent/loop/planner.py` (添加了 memory_engine 参数), `python/agent/loop/controller.py` (创建 MemoryEngine 并注入到 Planner)

### P0-3: 注意力聚焦机制

- **状态**: 已完成 ✅
- **方案**: 创建 `AttentionFocusManager` — 实现三步流程：消息评分 → Top-K 选取 → 重编号
- **文件创建**: `python/agent/loop/attention.py` (90行)
- **集成**: Controller 在每个 Phase 结束后和 ReAct 循环中调用 `apply_to_context()`
- **环境变量**: `ATTENTION_MAX_MESSAGES=15`, `ATTENTION_MAX_TOKENS=4000`

### P1-1: 成功反思启用

- **状态**: 已完成 ✅ (含 bug 修复)
- **方案**: 在 `LoopController.run()` 的 executor_output 处理后，遍历成功步骤调用 `reflection.reflect_on_success()`
- **Bug 修复**: 第313行存在一个遗留的 `_reflect_on_failure` 调用被错误地嵌套在了成功反思循环内 — 已移除并将因果分析部分正确缩进

### P1-2: 学习信号丰富

- **状态**: 已完成 ✅
- **方案**:
  - `SignalType` 枚举新增5种: `PLAN_QUALITY`, `TOOL_SELECTION_QUALITY`, `REFLECTION_EFFECTIVENESS`, `CONTEXT_COMPRESSION_SUCCESS`, `MEMORY_RETRIEVAL_HIT`
  - `LearningSignal` 增加 `metadata`, `plan_steps`, `reflection_score`, `memory_hit` 字段
  - Controller 注入逻辑扩展: 每轮循环注入8种不同类型的信号
- **文件修改**: `python/agent/evolution/types.py`, `python/agent/loop/controller.py`

### P2-1: 内置质量评分器

- **状态**: 已完成 ✅
- **方案**:
  - 创建 `BuiltInQualityScorer` 类（95行）— 5维度加权: 工具成功率(30%)、计划完成率(25%)、效率(20%)、反思价值(10%)、上下文相关性(15%)
  - 增强 `Reporter._compute_quality_score()` 返回值从 `float` 改为 `(float, dict)` 以返回 breakdown
  - `ReporterOutput` 新增 `quality_breakdown` 字段
  - `AgentResult.metadata` 包含完整的质量评分维度明细
- **文件创建/修改**: `python/agent/loop/quality_scorer.py` (新建), `python/agent/loop/reporter.py`, `python/agent/loop/types.py`

### 测试结果

- **核心测试**: 32/32 通过 (executor + controller)
- **全量测试**: 1478/1479 通过 (1 个失败为前置 Python 版本环境问题，与本次改动无关)
