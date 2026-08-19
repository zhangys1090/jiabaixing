# 家百星 (Jiabaixing) V5.0 改进方案文档

## 文档版本

- 版本: 1.3
- 日期: 2026-08-06
- 状态: Phase 1-4 已完成

---

## 一、总体目标

将 jiabaixing 从"架构先进但实现不均"的状态，升级为"感知驱动、闭环执行、进化型"的完整 Agent 系统。核心改造路径：

```
当前: Plan → Execute → Evaluate → Report（四阶段，无感知）
目标: Perceive → Plan → Execute → Verify → Report（五阶段，感知驱动）
```

---

## 二、Phase 1 — 感知与闭环基础

### 2.1 PerceptionBus + 五感工具真实化（1.1-1.3, 1.5）

#### 2.1.1 改进点 1.1 — 情绪感知真实化

**现状**: `EmotionAnalyzer.ts` 的 `analyze()` 永远返回 `{ type: 'neutral', intensity: 0.5 }`，无真实情绪推理。

**实现目标**:

- Python 端新建 `EmotionPerceptionTool`，基于 LLM 对用户文本进行情绪推理
- 输出格式: `{ type, intensity, potentialNeeds, confidence }`
- 情绪类型: happy/sad/angry/anxious/frustrated/neutral/curious/confident
- 注册到 ToolRegistry，Agent 可自主调用

**验收标准**:

- 输入"我好烦啊代码跑不通" → `{ type: 'frustrated', intensity: 0.8, potentialNeeds: ['debugging_help', 'emotional_support'] }`
- 输入"太棒了终于跑通了" → `{ type: 'happy', intensity: 0.9, potentialNeeds: [] }`

#### 2.1.2 改进点 1.2 — 场景识别语义化

**现状**: `SceneRecognizer.ts` 基于关键词匹配 + 时间段硬编码规则，仅覆盖 5 种场景。

**实现目标**:

- Python 端新建 `ScenePerceptionTool`，用 LLM 做场景分类
- 支持 20+ 细粒度场景: coding/debugging/code_review/writing/meeting/presentation/research/data_analysis/deployment/monitoring 等
- 输出: `{ type, interactionMode, recommendedTools, confidence }`

**验收标准**:

- 输入"帮我 review 这个 PR" → `{ type: 'code_review', recommendedTools: ['file_read', 'code_analyze'] }`
- 场景识别准确率 > 85%

#### 2.1.3 改进点 1.3 — 环境感知真实化

**现状**: `EnvironmentPerceptionEngine.ts` 的 `identifyDevice()` 为模拟实现。

**实现目标**:

- Python 端新建 `EnvironmentPerceptionTool`，集成真实系统信息
- 信息源: OS 信息、活跃进程、网络状态、屏幕状态、时间上下文
- 输出: `{ os, activeProcesses, networkStatus, screenState, timeContext }`

**验收标准**:

- 返回真实系统信息，非模拟数据
- 在 Windows/macOS/Linux 上均可运行

#### 2.1.4 改进点 1.5 — 五感统一总线

**现状**: 感知工具散落在各处，无统一调度。

**实现目标**:

- 新建 `PerceptionBus` 类，统一调度五感工具
- 输出标准化 `PerceptionState`，注入 `LoopContext`
- 支持按需感知（轻量/标准/深度三级）
- 与 LoopController 集成，在每轮循环开始时调用

**验收标准**:

- 所有感知工具输出统一格式
- LoopController 可在每轮循环开始时调用 `perception_bus.perceive()` 获取当前感知状态
- 感知延迟 < 2s（标准模式）

---

### 2.2 重构 LoopController.run() 为五阶段循环（9.1）

**现状**: `LoopController.run()` 为四阶段循环: Plan → Execute → Evaluate → Report，缺少 Perceive 阶段。

**实现目标**:

- 重构为五阶段循环: **Perceive → Plan → Execute → Verify → Report**
- Perceive 阶段: 调用 PerceptionBus 获取当前环境状态，注入 LoopContext
- Verify 阶段: 增强评估，即使轻量模式也执行最小语义验证
- 新增 `LoopState.PERCEIVING` 和 `LoopState.VERIFYING` 状态
- 新增 `LoopPhase.PERCEIVER` 和 `LoopPhase.VERIFIER` 观察者阶段

**验收标准**:

- 每轮循环开始前 100% 执行感知阶段
- 感知结果注入 Plan 上下文
- LoopObserver 记录完整的五阶段追踪

---

### 2.3 并行工具执行默认启用（5.1）

**现状**: `ConversationLoop` 已内置 `ParallelToolExecutor`，但 `LoopController` 的 `Executor` 仍逐个串行调用工具。

**实现目标**:

- `Executor.execute()` 支持并行执行无依赖步骤
- 利用现有 `ParallelToolExecutor` 基础设施
- 依赖分析: 基于 `PlanStep.input_from_step` 字段
- 失败策略: `CONTINUE`（单工具失败不中断其他工具）

**验收标准**:

- 无依赖工具 100% 并行执行
- 有依赖工具严格按序执行
- 并行执行结果顺序与计划步骤顺序一致

---

## 三、Phase 1 实现记录

### 3.0 新增文件清单

| 文件                                  | 说明                               |
| ------------------------------------- | ---------------------------------- |
| `python/agent/perception/__init__.py` | 感知模块包初始化                   |
| `python/agent/perception/bus.py`      | PerceptionBus 五感统一感知总线     |
| `python/agent/perception/tools.py`    | 情绪/场景/环境感知工具定义与执行器 |

### 3.1 PerceptionBus + 五感工具真实化 — 实现详情

#### 3.1.1 PerceptionBus (`python/agent/perception/bus.py`)

- `PerceptionLevel` 枚举: LIGHT / STANDARD / DEEP 三级感知
- 数据类: `EmotionState`, `SceneState`, `EnvironmentState`, `VisualState`, `AudioState`
- `PerceptionState`: 五感统一输出，含 `to_prompt_text()` 方法生成上下文注入文本
- `PerceptionBus` 类:
  - `perceive(user_input, context)` → `PerceptionState`: 按级别调度五感通道
  - `_resolve_channels()`: LIGHT 仅情绪; STANDARD 情绪+场景+环境; DEEP 全五感
  - 每通道先尝试 ToolRegistry 工具 → 回退 LLM → 最终回退规则引擎
  - 非侵入式: 感知失败不阻断主循环，静默降级
  - 环境感知: 真实获取 OS 信息、活跃窗口、网络状态、屏幕分辨率、时间上下文

#### 3.1.2 感知工具 (`python/agent/perception/tools.py`)

- `emotion_perceive`: 基于 LLM 语义分析用户文本情绪，回退规则引擎
- `scene_perceive`: 基于 LLM 语义分析场景类型，回退规则引擎
- `environment_sense`: 真实系统信息采集（OS/活跃窗口/网络/屏幕/时间）
- `register_perception_tools()`: 统一注册到 ToolRegistry
- 已在 `engine.py` 两处 ToolRegistry 初始化时调用注册

#### 3.1.3 验收状态

- ✅ 情绪感知: LLM 语义分析 + 规则回退，支持 8 种情绪类型
- ✅ 场景感知: LLM 语义分析 + 规则回退，支持 10+ 场景类型
- ✅ 环境感知: 真实系统信息，Windows/macOS 兼容
- ✅ 统一输出: PerceptionState + to_prompt_text()
- ✅ 三级感知: LIGHT(<500ms) / STANDARD(<2s) / DEEP(<5s)
- ✅ 工具注册: engine.py 自动注册

### 3.2 五阶段循环重构 — 实现详情

#### 3.2.1 LoopState 扩展 (`python/agent/loop/types.py`)

- 新增 `LoopState.PERCEIVING = "perceiving"` — 感知阶段状态
- 新增 `LoopState.VERIFYING = "verifying"` — 验证阶段状态
- 新增 `LoopContext.perception_state: Any | None = None` — 存储感知结果

#### 3.2.2 LoopPhase 扩展 (`python/agent/loop/observer.py`)

- 新增 `LoopPhase.PERCEIVER = "perceiver"` — 感知阶段观察者
- 新增 `LoopPhase.VERIFIER = "verifier"` — 验证阶段观察者
- 更新 `phase_durations` / `phase_counts` / `reset_statistics` 包含新阶段

#### 3.2.3 LoopController.run() 重构 (`python/agent/loop/controller.py`)

- 新增 `perception_bus` 构造参数，自动初始化 PerceptionBus
- **Phase 0: PERCEIVING** — 每轮循环开始时调用 `perception_bus.perceive()`
  - 感知结果注入 `context.perception_state`
  - 生成 `to_prompt_text()` 作为系统消息注入上下文
  - 感知失败静默降级，不阻断主循环
- **Phase 2.5: VERIFYING** — Execute 之后、Evaluate 之前
  - `_verify_execution()`: 规则验证 + LLM 语义验证
  - `_verify_by_rules()`: 快速检查失败率、空输出、错误关键词
  - `_verify_by_llm()`: LLM 判断输出是否回答了用户问题
  - 验证反馈注入上下文供后续规划参考
  - 轻量模式仅规则验证(<100ms)，完整模式规则+LLM(<2s)

#### 3.2.4 验收状态

- ✅ 每轮循环 100% 执行感知阶段
- ✅ 感知结果注入 Plan 上下文（系统消息）
- ✅ LoopObserver 记录完整五阶段追踪
- ✅ 验证阶段在 Execute 后自动执行
- ✅ 验证反馈可驱动重规划

### 3.3 并行工具执行默认启用 — 实现详情

#### 3.3.1 Executor 重构 (`python/agent/loop/executor.py`)

- `execute()` 方法重构:
  - 检测 `EXECUTOR_PARALLEL_ENABLED` 环境变量（默认 `true`）
  - 分析 `PlanStep.input_from_step` 依赖关系
  - 无依赖步骤 → `_execute_parallel()` 并行执行
  - 有依赖步骤 → `_execute_sequential()` 串行执行
- `_execute_sequential()`: 原有串行逻辑提取为独立方法
- `_execute_parallel()`:
  - 基于 `ParallelToolExecutor` 基础设施
  - 依赖分析: `input_from_step` 为空 → 可并行
  - 分组策略: 每轮收集所有无依赖步骤，并行执行后更新已完成集合
  - 失败策略: `FailurePolicy.CONTINUE`（单步骤失败不中断其他）
  - 最大并行度: `EXECUTOR_MAX_PARALLEL` 环境变量（默认 4）
  - 并行执行后仍对失败步骤执行反思重试

#### 3.3.2 验收状态

- ✅ 无依赖工具默认并行执行
- ✅ 有依赖工具严格按序执行
- ✅ 失败策略 CONTINUE: 单步骤失败不中断其他
- ✅ 可通过环境变量控制开关和并行度

### 3.4 engine.py 集成

- 两处 LoopController 创建（主初始化 + `_init_loop`）均注入 `perception_bus`
- 两处 ToolRegistry 初始化（主初始化 + `_init_tool_registry`）均注册感知工具
- PerceptionBus 初始化失败时静默降级，不影响主流程

---

## 四、Phase 2 实现记录

### 4.0 新增文件清单

| 文件                                        | 说明                                                        |
| ------------------------------------------- | ----------------------------------------------------------- |
| `python/agent/loop/plan_scheduler.py`       | 统一规划调度器，调度 Planner/ToT/Incremental 三大规划器     |
| `python/agent/desktop/operation_loop.py`    | 桌面操作闭环，UIA+ActionVerifier+DesktopController 三层集成 |
| `python/agent/tools/scene_tool_selector.py` | 场景感知工具选择器，基于感知状态推荐最佳工具                |

### 4.1 统一规划调度器 + 规划器互连（3.1-3.3）

#### 4.1.1 PlanScheduler (`python/agent/loop/plan_scheduler.py`)

- `PlanStrategy` 枚举: DIRECT / SINGLE_PASS / TOT_REFINE / INCREMENTAL
- `ScheduleDecision` 数据类: 记录调度决策（策略/复杂度/感知影响/耗时）
- `PlanSchedulerConfig`: 可配置 ToT/精炼/感知注入开关
- `PlanScheduler` 类:
  - `schedule(input_text, context)` → `ExecutionPlan`: 统一规划入口
    - simple → DIRECT（无规划）
    - moderate → SINGLE_PASS（主 Planner 单步规划）
    - complex → TOT_REFINE（ToT 多候选 → 评分 → 精炼）
  - `replan(...)` → `ExecutionPlan`: 增量重规划入口
  - `_assess_complexity()`: 感知驱动复杂度评估
    - 场景类型影响: multi_step/automation/debugging → complex
    - 工具风险影响: high/critical 风险工具 → complex
    - 工具能力影响: 多个 L2+ 工具 → complex
  - `_plan_tot_refine()`: ToT 多候选 → 主 Planner 精炼互连
  - `_refine_plan()`: LLM 精炼 ToT 初始规划

#### 4.1.2 规划器互连协议

```
ToT (多候选) → PlanScheduler._plan_tot_refine()
  ↓ 选择最优候选
主 Planner (精炼) → PlanScheduler._refine_plan()
  ↓ 注入感知上下文 + 场景推荐
ExecutionPlan → LoopController
  ↓ 执行失败
IncrementalPlanner → PlanScheduler.replan()
  ↓ 增量修正
新 ExecutionPlan → LoopController
```

#### 4.1.3 LoopController 集成

- `LoopController.__init__` 新增 `self._plan_scheduler`
- Planning 阶段: `self._plan_scheduler.schedule()` 替代 `self.planner.plan()`
- Replan: `self._plan_scheduler.replan()` 替代 `self.planner.replan()`
- 保留 `self.planner` 供 PlanScheduler 内部调用和向后兼容

#### 4.1.4 验收状态

- ✅ 统一调度入口: schedule() / replan()
- ✅ 规划器互连: ToT → 主 Planner → Incremental 链路打通
- ✅ 感知驱动复杂度评估
- ✅ ScheduleDecision 记录完整决策链
- ✅ 向后兼容: self.planner 仍可用

### 4.2 UIA 集成 + 桌面操作闭环（2.1-2.2）

#### 4.2.1 DesktopOperationLoop (`python/agent/desktop/operation_loop.py`)

- `OperationSpec` 数据类: 操作规格（动作类型/目标/值/控制类型/重试策略）
- `OperationResult` 数据类: 操作结果（成功/证据/重试次数/验证信息）
- `DesktopOperationLoop` 类:
  - 三层集成: UIAEngine + DesktopController + ActionVerifier
  - `execute(spec)` → `OperationResult`: 完整闭环
    1. 操作前感知: 截图 + UIA 元素树快照
    2. 操作执行: UIA 精确操作优先，pyautogui 降级
    3. 操作后验证: ActionVerifier 多策略验证（pixel/ocr/uia_diff）
    4. 失败自动重试: 带指数退避的自动重试 + UIA 重定位
  - 支持 8 种操作: click/type/get_text/set_text/screenshot/activate_window/hotkey/scroll
  - UIA 优先策略: 有 UIA 时精确操作，无 UIA 时降级 pyautogui

#### 4.2.2 新增桌面工具

- `desktop_uia_action`: UIA 增强桌面操作
  - 精确元素定位 + 操作验证闭环
  - 参数: action/target/value/control_type/verify/max_retries
  - 风险等级: high
- `desktop_explore`: 桌面元素探索
  - UIA 元素树浏览，操作前探查界面结构
  - 参数: filter/control_type/depth
  - 风险等级: low

#### 4.2.3 验收状态

- ✅ 操作闭环: 感知 → 执行 → 验证 → 重试
- ✅ UIA 精确操作优先，pyautogui 降级
- ✅ ActionVerifier 多策略验证（pixel/ocr/vlm/uia_diff）
- ✅ 失败自动重试（指数退避 + UIA 重定位）
- ✅ 新工具注册到 ToolRegistry

### 4.3 场景感知工具选择（5.2）

#### 4.3.1 SceneToolSelector (`python/agent/tools/scene_tool_selector.py`)

- `ToolRecommendation` 数据类: 工具推荐（名称/评分/原因/风险/能力等级）
- `SceneToolMapping` 数据类: 场景-工具映射规则
- 8 大场景映射:
  - desktop → desktop_uia_action / desktop_automate / desktop_screenshot
  - coding → code_generate / code_analyze / shell_exec
  - research → web_search / web_fetch / file_grep
  - daily → task_manage / calendar / note_take
  - automation → desktop_uia_action / browser_agent / shell_exec
  - file_management → file_read / file_list / file_edit
  - communication → ask_clarification / message_push
  - debugging → code_analyze / code_fix / shell_exec
- 情绪-工具优先级: frustrated → ask_clarification, anxious → preview_execution
- `SceneToolSelector` 类:
  - `select(task_description, perception_state)` → `list[ToolRecommendation]`
  - `select_for_step(step_description, step_tool_hint)` → `ToolRecommendation`
  - `_detect_scene()`: 从 PerceptionState 检测场景类型
  - `_detect_emotion()`: 从 PerceptionState 检测情绪类型
  - `_score_candidates()`: 综合评分（场景匹配 + 情绪适配 + 关键词 + 风险惩罚）

#### 4.3.2 集成点

- **Planner**: `_plan_complex()` 中注入场景感知工具推荐到 LLM 规划上下文
- **PlanScheduler**: `_assess_complexity()` 中使用工具风险/能力等级影响复杂度评估
- **Planner.set_tool_registry()**: 自动初始化 SceneToolSelector

#### 4.3.3 验收状态

- ✅ 8 大场景映射规则
- ✅ 情绪-工具优先级调整
- ✅ 关键词-工具匹配加分
- ✅ 风险等级惩罚
- ✅ 感知状态驱动场景检测
- ✅ 集成到 Planner 和 PlanScheduler

---

## 五、Phase 3 实现记录

### 5.0 新增文件清单

| 文件                                          | 说明                                                          |
| --------------------------------------------- | ------------------------------------------------------------- |
| `python/agent/loop/meta_decision_engine.py`   | 元决策引擎，Q-Learning 启发的策略自适应选择 + 决策经验持久化  |
| `python/agent/loop/reasoning_chain.py`        | 推理链引擎，动态推理深度 + 推理链验证 + 推理链压缩            |
| `python/agent/llm/task_aware_model_router.py` | 任务感知模型路由，基于任务特征和感知状态自动选择最优 Provider |

### 5.1 元决策引擎 + 决策经验持久化（4.1-4.2）

#### 5.1.1 MetaDecisionEngine (`python/agent/loop/meta_decision_engine.py`)

- `DecisionStrategy` 枚举: RULE_BASED / LLM_DRIVEN / DEBATE_DRIVEN / MCTS_DRIVEN
- `DecisionContext` 数据类: 复杂度/场景/情绪/风险/感知状态
- `DecisionRecord` 数据类: 决策记录（上下文/策略/结果/质量/耗时）
- `StrategyStats` 数据类: 策略统计（总数/成功率/平均质量/平均耗时）
- `MetaDecisionEngine` 类:
  - Q-Learning 启发: 状态-动作价值表驱动策略选择
  - `decide(context)` → `DecisionStrategy`: 基于上下文选择决策策略
  - `record_outcome(...)`: 记录决策结果，更新 Q 表
  - `_heuristic_decision()`: 启发式降级（Q 表冷启动时）
  - `_state_key()`: 状态空间编码（complexity|scene|emotion|risk）
  - `build_context_from_loop()`: 从 LoopContext 构建 DecisionContext
- 决策经验持久化: JSON 文件存储 Q 表 + 策略统计 + JSONL 历史记录

#### 5.1.2 集成点

- **LoopController**: 循环结束时调用 `meta_decision.record_outcome()` 记录决策结果
- **DebateHarness**: L6 元决策层检查策略成功率，推荐调整

#### 5.1.3 验收状态

- ✅ Q-Learning 启发的策略选择
- ✅ 4 种决策策略（rule_based/llm_driven/debate_driven/mcts_driven）
- ✅ 启发式降级（Q 表冷启动）
- ✅ 决策经验持久化（Q 表 + 策略统计 + 历史记录）
- ✅ 感知状态驱动决策上下文构建

### 5.2 动态推理深度 + 推理链验证（6.1-6.2）

#### 5.2.1 ReasoningChainEngine (`python/agent/loop/reasoning_chain.py`)

- `ReasoningDepth` 枚举: SHALLOW(1层) / MEDIUM(2-3层) / DEEP(4-5层) / EXHAUSTIVE(6+层)
- `ChainNodeType` 枚举: CLAIM / EVIDENCE / INFERENCE / CONCLUSION / ASSUMPTION / COUNTER_ARGUMENT
- `ChainNode` 数据类: 推理节点（内容/类型/置信度/来源/父节点）
- `ReasoningChain` 数据类: 推理链（节点列表/深度/总置信度/验证结果）
- `VerificationStrategy` 枚举: CONSISTENCY / FACTUALITY / COMPLETENESS / REDUNDANCY
- `VerificationResult` 数据类: 验证结果（通过/策略/问题/评分）
- `ReasoningChainEngine` 类:
  - `determine_depth(query, complexity, perception_state)`: 动态推理深度选择
    - 感知影响: debugging/refactoring → DEEP, frustrated/anxious → DEEP
    - 高风险关键词: 删除/格式化/重置 → DEEP
  - `reason(query, ...)`: 构建推理链
    - LLM 驱动: 多层推理节点生成
    - 规则驱动: 关键词匹配生成推理节点
  - `verify(chain, strategies)`: 推理链验证
    - 一致性验证: 矛盾检测（前后矛盾词对）
    - 事实性验证: LLM 事实核查
    - 完整性验证: 根/叶/证据/推理/结论节点检查
    - 冗余验证: 重复内容 + 高相似度检测
  - `compress(chain, target_ratio)`: 推理链压缩
    - 保留关键类型: CLAIM / CONCLUSION / EVIDENCE
    - 按置信度排序可选节点

#### 5.2.2 验收状态

- ✅ 4 级动态推理深度（shallow/medium/deep/exhaustive）
- ✅ 感知驱动深度选择
- ✅ 推理链构建（LLM + 规则双模式）
- ✅ 4 种验证策略（一致性/事实性/完整性/冗余）
- ✅ 推理链压缩（保留关键节点）

### 5.3 任务感知模型路由（7.1）

#### 5.3.1 TaskAwareModelRouter (`python/agent/llm/task_aware_model_router.py`)

- `TaskType` 枚举: CODING / REASONING / AGENTIC / VISION / CONVERSATION / ANALYSIS / CREATIVE / AUTOMATION / RESEARCH / DEBUGGING
- `CostPreference` 枚举: QUALITY_FIRST / BALANCED / COST_FIRST
- `TaskProfile` 数据类: 任务画像（类型/复杂度/能力需求/成本偏好/风险）
- `RouteDecision` 数据类: 路由决策（Provider/评分/备选/推理/感知影响）
- `TaskAwareModelRouter` 类:
  - `route(input_text, perception_state)` → `RouteDecision`: 任务感知路由
  - `analyze_task(input_text, perception_state)` → `TaskProfile`: 任务特征分析
  - `_detect_task_type()`: 10 种任务类型关键词匹配
  - `_detect_complexity()`: 复杂度关键词检测
  - `_detect_multi_modal()`: 多模态需求检测
  - `_route_via_capability_router()`: 通过 CapabilityAwareRouter 精确路由
  - 感知增强: 场景→任务类型映射, 情绪→成本偏好映射
  - 降级链: CapabilityAwareRouter → preferred_provider → fallback_chain → default

#### 5.3.2 与 CapabilityAwareRouter 的关系

- CapabilityAwareRouter: 底层能力评分引擎（静态能力 → 评分）
- TaskAwareModelRouter: 上层路由决策引擎（任务需求 → Provider 选择）
- TaskAwareModelRouter 内部调用 CapabilityAwareRouter.route() 进行能力匹配

#### 5.3.3 验收状态

- ✅ 10 种任务类型识别
- ✅ 感知增强路由（场景→任务类型, 情绪→成本偏好）
- ✅ 成本-质量平衡（3 种成本偏好）
- ✅ CapabilityAwareRouter 集成
- ✅ 降级链（能力路由 → 指定 Provider → 备选链 → 默认）

---

## 六、Phase 4 实现记录

### 6.0 新增文件清单

| 文件                                    | 说明                                                              |
| --------------------------------------- | ----------------------------------------------------------------- |
| `python/agent/evolution/closed_loop.py` | 进化闭环打通 + 效果量化，信号采集→决策→执行→验证→反馈完整闭环     |
| `python/agent/loop/debate_harness.py`   | 辩论驱动六层 Harness，L1安全→L2辩论→L3因果→L4反思→L5进化→L6元决策 |
| `python/agent/memory/cross_session.py`  | 跨会话记忆 + 主动行为引擎，持久化记忆 + 主动提醒/建议/预操作/跟进 |

### 6.1 进化闭环打通 + 效果量化（8.1-8.3）

#### 6.1.1 EvolutionClosedLoop (`python/agent/evolution/closed_loop.py`)

- `EvolutionAction` 枚举: PROMPT_OPTIMIZE / TOOL_ENHANCE / ROUTE_DEGRADE / ROLLBACK / SKILL_UPDATE / CORRECTION_RULE / WEIGHT_ADJUST
- `EvolutionOutcome` 枚举: SUCCESS / PARTIAL / FAILURE / SKIPPED / ROLLED_BACK
- `EvolutionSignal` 数据类: 进化信号（类型/来源/严重度/上下文）
- `EvolutionDecision` 数据类: 进化决策（动作/目标/推理/置信度/前状态）
- `EffectMeasurement` 数据类: 效果量化（质量/延迟/成功率前后差值 + is_effective判定）
- `EvolutionCycleRecord` 数据类: 进化周期记录
- `EffectivenessMetrics` 数据类: 效果指标（总周期/成功/回滚/平均差值/有效率/动作统计）
- `EvolutionClosedLoop` 类:
  - 完整闭环: 信号采集 → 决策 → 执行 → 效果验证 → 反馈
  - `collect_signal()`: 信号采集
  - `decide_evolution_action()`: 信号→动作映射（7 种进化动作）
  - `execute_evolution()`: 执行进化动作 + 效果验证 + 自动回滚
  - `_measure_effect()`: 效果量化（quality_delta / latency_delta / success_rate_delta）
  - `_attempt_rollback()`: 效果为负时自动回滚
  - `record_quality/latency/success()`: 滑动窗口记录运行指标
  - `get_effectiveness_metrics()`: 获取效果指标

#### 6.1.2 集成点

- **AgentEngine**: 初始化时创建 EvolutionClosedLoop 并注入 DebateHarness
- **DebateHarness**: L5 进化层检查进化有效率

#### 6.1.3 验收状态

- ✅ 7 种进化动作（Prompt优化/工具增强/路由降级/回滚/技能更新/修正规则/权重调整）
- ✅ 效果量化（quality_delta / latency_delta / success_rate_delta）
- ✅ 自动回滚（效果为负时回滚到最近良好检查点）
- ✅ 效果指标持久化
- ✅ 与 EvolutionEngine / CapabilityEvolutionLinkage 集成

### 6.2 辩论驱动规划 + 六层 Harness 激活（10.1-10.2）

#### 6.2.1 DebateHarness (`python/agent/loop/debate_harness.py`)

- `HarnessLevel` 枚举: L1_SAFETY / L2_DEBATE / L3_CAUSAL / L4_REFLECTION / L5_EVOLUTION / L6_META_DECISION
- `DebateVerdict` 枚举: APPROVED / NEEDS_REFINEMENT / REJECTED / ESCALATE
- `HarnessCheckResult` 数据类: 单层检查结果
- `DebateReviewResult` 数据类: 完整审查结果（裁决/质量/漏洞/改进/精炼计划/升级标记）
- 六层 Harness 架构:
  - **L1 安全沙箱**: 高风险动作拦截 + 人工审批（RiskPrecheck 集成）
  - **L2 辩论审查**: DefaultDebater 多轮辩论 + 质量门控
  - **L3 因果建模**: CausalModeler 依赖分析 + 循环检测
  - **L4 反思应用**: ReflectionEngine 经验复用 + 历史建议
  - **L5 进化闭环**: EvolutionClosedLoop 效果率检查
  - **L6 元决策**: MetaDecisionEngine 策略成功率检查
- `DebateHarness` 类:
  - `review(plan, input_text, context)` → `DebateReviewResult`: 六层审查
  - 逐层检查: L1→L2→L3→L4→L5→L6
  - L1 不通过 → 直接 REJECTED
  - L2 不通过 → 精炼辩论（最多 N 轮）
  - 精炼未通过 → ESCALATE（升级到 MCTS 搜索）
  - `_aggregate_scores()`: 加权聚合六层评分（L1权重2.0, L2权重1.5, ...）

#### 6.2.2 集成点

- **LoopController**: 辩论审查阶段优先使用 DebateHarness，降级到单一 Debater
- **AgentEngine**: 初始化时注入进化闭环/辩论器/因果建模器到 DebateHarness

#### 6.2.3 验收状态

- ✅ 六层 Harness 完整实现
- ✅ 逐层检查 + 加权评分
- ✅ 辩论精炼闭环（未通过→精炼→再辩论→升级）
- ✅ 与安全沙箱/辩论器/因果建模/反思/进化/元决策六大组件集成
- ✅ 降级机制（DebateHarness → 单一 Debater）

### 6.3 跨会话记忆 + 主动行为引擎（10.4-10.5）

#### 6.3.1 CrossSessionMemory (`python/agent/memory/cross_session.py`)

- `MemoryType` 枚举: USER_PREFERENCE / USER_HABIT / TASK_PATTERN / CONTEXT_SNAPSHOT
- `MemoryPriority` 枚举: LOW / MEDIUM / HIGH / CRITICAL
- `CrossSessionEntry` 数据类: 跨会话记忆条目（类型/键/值/优先级/访问计数/衰减分数）
- `SessionSummary` 数据类: 会话摘要（任务数/成功数/工具/主题/偏好/洞察）
- `CrossSessionMemory` 类:
  - `store(memory_type, key, value)`: 存储跨会话记忆
  - `retrieve(memory_type, key, tags, min_decay, limit)`: 检索记忆
  - `store_preference/get_preferences()`: 用户偏好快捷方法
  - `store_habit/get_habits()`: 用户习惯快捷方法
  - `store_task_pattern()`: 任务模式存储
  - `store_session_summary()`: 会话摘要存储 + 偏好自动提取
  - `apply_decay()`: 记忆衰减（按优先级不同衰减率）
  - 持久化: JSON 文件存储 + JSONL 会话历史
  - 驱逐策略: 优先级+衰减分数+访问计数排序，保护 CRITICAL 条目

#### 6.3.2 ProactiveEngine (`python/agent/memory/cross_session.py`)

- `ProactiveActionType` 枚举: REMINDER / SUGGESTION / PRE_OPERATION / FOLLOW_UP
- `ProactiveAction` 数据类: 主动行为（类型/标题/描述/触发条件/优先级/置信度）
- `ProactiveEngine` 类:
  - `evaluate(perception_state, current_input)` → `list[ProactiveAction]`: 评估主动行为
  - `_evaluate_reminders()`: 基于习惯的定时提醒
  - `_evaluate_suggestions()`: 基于感知状态和任务模式的建议
  - `_evaluate_pre_operations()`: 基于习惯的预操作
  - `_evaluate_follow_ups()`: 基于上次会话的跟进
  - `execute(actions)`: 执行主动行为
  - 冷却机制: 同类型行为 5 分钟内不重复触发

#### 6.3.3 集成点

- **AgentEngine**: 初始化时创建 CrossSessionMemory + ProactiveEngine

#### 6.3.4 验收状态

- ✅ 4 种记忆类型（偏好/习惯/任务模式/上下文快照）
- ✅ 记忆衰减与强化（按优先级不同衰减率，访问强化）
- ✅ 会话摘要 + 偏好自动提取
- ✅ 4 种主动行为（提醒/建议/预操作/跟进）
- ✅ 感知驱动主动行为评估
- ✅ 冷却机制防止重复触发
- ✅ 持久化存储

### 7.3 跨会话记忆 + 主动行为引擎（10.4-10.5）

（已在 6.3 节实现）

---

## 八、总结

jiabaixing V5.0 改进方案 Phase 1-4 全部实现完成。核心改造路径：

```
当前: Plan → Execute → Evaluate → Report（四阶段，无感知）
目标: Perceive → Plan → Execute → Verify → Report（五阶段，感知驱动）✅
```

### 已完成的关键改造

1. **感知驱动闭环**（Phase 1）: PerceptionBus + 五感工具 + 感知注入
2. **规划与行动增强**（Phase 2）: PlanScheduler + UIA操作闭环 + 场景工具选择
3. **决策与推理深化**（Phase 3）: 元决策引擎 + 推理链验证 + 任务感知路由
4. **进化与差异化**（Phase 4）: 进化闭环 + 六层Harness + 跨会话记忆 + 主动行为

### 差异化优势

- **辩论驱动规划**: 六层 Harness（安全→辩论→因果→反思→进化→元决策）强制执行
- **进化型决策**: Q-Learning 元决策 + 进化闭环效果量化 + 自动回滚
- **感知行动闭环**: Perceive → Plan → Execute → Verify 完整闭环
- **跨会话记忆**: 用户偏好/习惯/任务模式持久化 + 主动行为引擎
