# jiabaixing AGENT 状态可视化与闭环打通计划

## 目标

将 jiabaixing 从"功能开发完成"推进到"系统闭环验证完成"——让前端 UI 能实时观测到 AGENT 的完整生命周期：眼睛感知 → 大脑决策 → 手脚执行 → 进化学习。用户通过前端 Dashboard 看到状态流动，验证系统真正运转。

## 现状分析（基于代码审查）

### 已连接的部分

| 组件         | 状态  | 说明                                                          |
| ---------- | --- | ----------------------------------------------------------- |
| 聊天消息流      | 已连接 | WebSocket `user_input` → `response_ready`                   |
| 主动消息推送     | 已连接 | EventBus `proactive_message` → WebSocket → 前端               |
| 技能列表/执行    | 已连接 | REST API `/api/skills` + `/api/skills/execute`              |
| 日志实时流      | 已连接 | Logger → EventBus `log` → WebSocket `server_log` → LogPanel |
| 进化指标查询     | 半连接 | REST API 有，但 EvolutionPanel 图表用假数据                          |
| Agent 执行更新 | 半连接 | WebSocket 支持接收，但 `AgentLoop.ts` 未被 `JiabaixingCore` 使用      |

### 核心缺口

1. **AgentLoop 孤立**：`src/core/AgentLoop.ts` 完整实现了 PERCEIVE→PLAN→EXECUTE→VERIFY→OUTPUT→LEARN 状态机，但 `JiabaixingCore.processInput()` 使用内联逻辑，未接入 AgentLoop
2. **无阶段事件**：`JiabaixingCore` 处理链中（意图识别→任务分解→场景识别→记忆检索→LLM生成）没有发射细粒度阶段事件
3. **感知层无事件**：VisionEngine / SpeechRecognizer / MultimodalFusionEngine 处理各阶段没有发射事件到 EventBus
4. **技能执行无实时进度**：EnhancedSkillExecutor 只在完成后记录 trace，没有执行前/中/后的事件
5. **进化无实时推送**：RealTimeFeedbackLoop 触发优化时只写日志，没有 WebSocket 推送
6. **前端类型不匹配**：WebSocketMessage 类型定义缺少 `brain_stage_update` / `perception_update` / `skill_execution_update` / `evolution_event`

## 架构设计

### 统一状态流

```
┌─────────────────────────────────────────────────────────────┐
│                    统一状态可视化仪表盘                        │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│   感知层     │   决策层     │   执行层     │    进化层         │
├─────────────┼─────────────┼─────────────┼───────────────────┤
│ 语音输入状态 │ 意图识别阶段 │ 技能调用链   │ 实时质量分数       │
│ 图像分析进度 │ 任务分解树   │ 执行进度条   │ 优化触发动画       │
│ 文本预处理   │ 记忆检索状态 │ 重试/回退    │ 策略池评分         │
│ 融合置信度   │ LLM生成进度 │ 执行追踪     │ 自适应阈值曲线     │
└─────────────┴─────────────┴─────────────┴───────────────────┘
         ↑              ↑              ↑              ↑
    WebSocket      WebSocket      WebSocket      WebSocket
   `perception_`  `brain_stage`  `skill_exec_`  `evolution_`
      update        update         update         event
```

### 后端事件发射规范

所有新增事件通过 `EventBus.emit()` 发射，由 WebSocket 服务器统一订阅并广播到前端。

## 实施步骤

### Phase 1: 后端事件发射体系（基础设施）

#### 1.1 扩展 EventBus 事件类型

**文件**: `src/shared/EventBus.ts`

在 `EventMap` 接口中新增以下事件类型：

```typescript
// 感知层事件
perception_update: [payload: {
  traceId: string;
  modality: 'voice' | 'image' | 'text' | 'sensor' | 'fusion';
  status: 'started' | 'processing' | 'completed' | 'failed';
  progress?: number; // 0-1
  result?: unknown;
  confidence?: number;
  timestamp: string;
}];

// 大脑决策阶段事件
brain_stage_update: [payload: {
  traceId: string;
  stage: 'intent_recognition' | 'task_decomposition' | 'scene_recognition' | 'memory_retrieval' | 'llm_generation' | 'persona_adjustment';
  status: 'started' | 'completed' | 'failed';
  duration?: number;
  result?: unknown;
  timestamp: string;
}];

// 技能执行实时事件
skill_execution_update: [payload: {
  traceId: string;
  skillName: string;
  step: 'started' | 'retry' | 'fallback' | 'completed' | 'failed';
  attempt?: number;
  maxRetries?: number;
  duration?: number;
  error?: string;
  timestamp: string;
}];

// 进化引擎事件
evolution_event: [payload: {
  type: 'quality_assessed' | 'micro_optimization' | 'deep_optimization' | 'strategy_updated' | 'threshold_adjusted';
  traceId?: string;
  score?: number;
  description: string;
  metrics?: Record<string, number>;
  timestamp: string;
}];
```

#### 1.2 WebSocket 服务器广播新事件

**文件**: `src/server/index.ts`

在 `initializeWebSocket` 函数中，为每个新事件类型添加订阅和广播逻辑：

* 订阅 `perception_update` → 广播 `perception_update`

* 订阅 `brain_stage_update` → 广播 `brain_stage_update`

* 订阅 `skill_execution_update` → 广播 `skill_execution_update`

* 订阅 `evolution_event` → 广播 `evolution_event`

### Phase 2: JiabaixingCore 处理链事件化

**文件**: `src/core/JiabaixingCore.ts`

在 `processInput()` 方法的每个关键阶段前后插入事件发射：

```typescript
// 1. 意图识别阶段
EventBus.emit('brain_stage_update', {
  traceId: finalTraceId,
  stage: 'intent_recognition',
  status: 'started',
  timestamp: new Date().toISOString(),
});
const intentResult = await this.intentRecognizer.recognize(input);
EventBus.emit('brain_stage_update', {
  traceId: finalTraceId,
  stage: 'intent_recognition',
  status: 'completed',
  duration: Date.now() - intentStart,
  result: { level1: intentResult.level1, level2: intentResult.level2, confidence: intentResult.confidence },
  timestamp: new Date().toISOString(),
});

// 2. 场景识别阶段（同理）
// 3. 任务分解阶段（同理）
// 4. 记忆检索阶段（同理）
// 5. LLM生成阶段（同理）
// 6. 人格微调阶段（同理）
```

**注意**: 保持现有逻辑不变，仅增加事件发射，不影响原有执行流程。

### Phase 3: AgentLoop 接入核心流程

**文件**: `src/core/JiabaixingCore.ts`（修改）+ `src/core/AgentLoop.ts`（增强）

#### 3.1 增强 AgentLoop 的事件发射

在 `AgentLoop.runInternal()` 的每个阶段转换时，除了现有的 `context_update` 事件，增加 `brain_stage_update` 和 `perception_update` 事件发射：

* `perceivePhase` 开始/完成 → `perception_update` + `brain_stage_update`

* `planPhase` 开始/完成 → `brain_stage_update`

* `executePhase` 开始/完成 → `skill_execution_update`

* `verifyPhase` 开始/完成 → `brain_stage_update`

* `outputPhase` 开始/完成 → `brain_stage_update`

* `learnPhase` 开始/完成 → `evolution_event`

#### 3.2 JiabaixingCore 使用 AgentLoop

修改 `processInput()` 中复杂任务的执行路径：

当前逻辑（L819-868）：

```typescript
if (this.agentLoop && isComplex) {
  const agentResult = await this.agentLoop.executeTask(input, {...});
  // ...
}
```

此逻辑**已经存在**，但需要确保：

1. `agentLoop` 在初始化时被正确创建和注入
2. `agentLoop` 的 `skillBridge` 和 `memoryEngine` 被正确绑定
3. 简单任务也可以选择性走 AgentLoop（统一路径）

**修改 main.ts 初始化逻辑**：确保 `JiabaixingCore` 初始化时创建并绑定 `AgentLoop`。

### Phase 4: 感知层事件化

**文件**: `src/multimodal/VisionEngine.ts` + `src/multimodal/SpeechRecognizer.ts` + `src/multimodal/MultimodalFusionEngine.ts`

#### 4.1 VisionEngine 事件

在 `analyzeImage()`、`ocr()`、`processImage()` 的开始和完成处发射 `perception_update`：

```typescript
EventBus.emit('perception_update', {
  traceId: `vision_${Date.now()}`,
  modality: 'image',
  status: 'started',
  timestamp: new Date().toISOString(),
});
// ... 处理 ...
EventBus.emit('perception_update', {
  traceId,
  modality: 'image',
  status: 'completed',
  progress: 1,
  result: { description: result.description, objects: result.objects },
  confidence: result.success ? 0.9 : 0,
  timestamp: new Date().toISOString(),
});
```

#### 4.2 SpeechRecognizer 事件

同理，在 `transcribe()` 和 `transcribeStream()` 中发射 `perception_update`（modality: 'voice'）。

#### 4.3 MultimodalFusionEngine 事件

在 `process()` 方法中，为每个子处理阶段（audio/visual/text/sensor/fusion）发射 `perception_update`（modality: 'fusion'）。

### Phase 5: 技能执行实时事件

**文件**: `src/core/EnhancedSkillExecutor.ts`

在 `execute()` 方法的关键节点发射 `skill_execution_update`：

1. 执行开始时 → `step: 'started'`
2. 每次重试时 → `step: 'retry'`, `attempt: retryCount`
3. 回退策略触发时 → `step: 'fallback'`
4. 执行成功时 → `step: 'completed'`
5. 执行失败时 → `step: 'failed'`, `error: lastError`

### Phase 6: 进化引擎实时事件

**文件**: `src/evolution/RealTimeFeedbackLoop.ts`

在以下位置发射 `evolution_event`：

1. `assessAndReact()` 中质量评估完成后 → `type: 'quality_assessed'`
2. `triggerMicroOptimization()` 中微优化触发时 → `type: 'micro_optimization'`
3. `triggerDeepOptimization()` 中深度优化触发时 → `type: 'deep_optimization'`
4. 策略更新后 → `type: 'strategy_updated'`
5. 自适应阈值调整后 → `type: 'threshold_adjusted'`

### Phase 7: 前端状态面板（Composition Patterns）

#### 7.1 扩展 WebSocket 消息类型

**文件**: `src/frontend/src/types/chat.ts`

在 `WebSocketMessage.type` 联合类型中新增：

```typescript
| 'perception_update'
| 'brain_stage_update'
| 'skill_execution_update'
| 'evolution_event'
```

#### 7.2 创建 AGENT 状态上下文（React Context）

**文件**: `src/frontend/src/contexts/AgentStateContext.tsx`

使用 React Context + useReducer 管理全局 AGENT 状态：

```typescript
interface AgentState {
  // 感知层
  perception: {
    activeModalities: Array<'voice' | 'image' | 'text' | 'sensor'>;
    currentTask: PerceptionTask | null;
    history: PerceptionTask[];
  };
  // 决策层
  brain: {
    currentStage: BrainStage | null;
    stageHistory: BrainStageRecord[];
    currentTraceId: string | null;
  };
  // 执行层
  execution: {
    activeExecutions: SkillExecutionRecord[];
    executionHistory: SkillExecutionRecord[];
  };
  // 进化层
  evolution: {
    latestScore: number;
    scoreHistory: Array<{ timestamp: string; score: number }>;
    recentEvents: EvolutionEvent[];
    strategyPool: Strategy[];
  };
}
```

#### 7.3 增强 useWebSocket Hook

**文件**: `src/frontend/src/hooks/useWebSocket.ts`

在 `handleMessage` 中新增对新消息类型的处理：

* `perception_update` → 调用 perception listener

* `brain_stage_update` → 调用 brain stage listener

* `skill_execution_update` → 调用 skill execution listener

* `evolution_event` → 调用 evolution listener

新增 listener 注册方法：

```typescript
onPerceptionUpdate(listener: PerceptionUpdateListener): void
onBrainStageUpdate(listener: BrainStageUpdateListener): void
onSkillExecutionUpdate(listener: SkillExecutionUpdateListener): void
onEvolutionEvent(listener: EvolutionEventListener): void
```

#### 7.4 重构 AgentExecutionPanel（Composition Patterns）

**文件**: `src/frontend/src/components/AgentExecutionPanel/AgentExecutionPanel.tsx`

当前实现是静态展示，需要改为：

1. 接入 `AgentStateContext` 获取实时状态
2. 显示当前 trace 的完整阶段流水线
3. 每个阶段显示：名称、状态、耗时、结果摘要
4. 支持多个并行执行的 trace

使用 Compound Components 模式：

```tsx
<AgentExecutionPanel>
  <AgentExecutionPanel.TraceList>
    {traces.map(trace => (
      <AgentExecutionPanel.Trace key={trace.traceId} trace={trace}>
        <AgentExecutionPanel.StageTimeline />
        <AgentExecutionPanel.StageDetails />
      </AgentExecutionPanel.Trace>
    ))}
  </AgentExecutionPanel.TraceList>
</AgentExecutionPanel>
```

#### 7.5 创建 PerceptionPanel（感知面板）

**文件**: `src/frontend/src/components/PerceptionPanel/PerceptionPanel.tsx`

显示当前激活的感知通道：

* 语音：波形动画 + 转文字结果

* 图像：缩略图 + 分析结果

* 文本：输入预览

* 融合：置信度仪表盘

#### 7.6 创建 ExecutionPanel（执行面板）

**文件**: `src/frontend/src/components/ExecutionPanel/ExecutionPanel.tsx`

显示技能执行实时状态：

* 技能名称、参数

* 执行进度条

* 重试次数指示

* 回退策略标记

* 执行追踪时间线

#### 7.7 增强 EvolutionPanel

**文件**: `src/frontend/src/components/EvolutionPanel/EvolutionPanel.tsx`

当前问题：图表用假数据、无实时推送。

改进：

1. 接入 `AgentStateContext` 获取实时进化事件
2. 质量分数趋势图绑定真实数据
3. 优化触发动画（微优化/深度优化）
4. 策略池可视化
5. 自适应阈值变化曲线

#### 7.8 重构 App.tsx 布局

**文件**: `src/frontend/src/App.tsx`

将 `agent` 视图从单一的 `AgentExecutionPanel` 扩展为完整的 AGENT Dashboard：

```tsx
{activeModule === 'agent' && (
  <AgentDashboard>
    <PerceptionPanel />
    <BrainStagePanel />
    <ExecutionPanel />
    <EvolutionMiniPanel />
  </AgentDashboard>
)}
```

或者采用标签页方式在一个面板内切换四个子视图。

### Phase 8: 集成验证与测试

#### 8.1 端到端验证清单

* [ ] 发送一条消息 → 前端能看到 brain\_stage\_update 事件流（意图识别→任务分解→场景识别→记忆检索→LLM生成→人格微调）

* [ ] 上传一张图片 → 前端能看到 perception\_update（image started → processing → completed）

* [ ] 触发技能执行 → 前端能看到 skill\_execution\_update（started → retry → completed）

* [ ] 触发低质量响应 → 前端能看到 evolution\_event（quality\_assessed → micro\_optimization）

* [ ] 所有事件在 LogPanel 中也能看到（通过 server\_log）

#### 8.2 测试策略

1. **单元测试**: 测试每个新增的事件发射点是否正确发射事件
2. **集成测试**: 测试 EventBus → WebSocket → 前端的完整事件流
3. **端到端测试**: 启动完整系统，通过前端 UI 验证事件可视化

## 文件修改清单

### 后端文件

| 文件                                         | 修改类型 | 修改内容                   |
| ------------------------------------------ | ---- | ---------------------- |
| `src/shared/EventBus.ts`                   | 编辑   | 新增 4 个事件类型到 EventMap   |
| `src/server/index.ts`                      | 编辑   | WebSocket 订阅并广播新事件     |
| `src/core/JiabaixingCore.ts`               | 编辑   | processInput 各阶段插入事件发射 |
| `src/core/AgentLoop.ts`                    | 编辑   | 各阶段插入事件发射              |
| `src/core/EnhancedSkillExecutor.ts`        | 编辑   | 执行节点插入事件发射             |
| `src/evolution/RealTimeFeedbackLoop.ts`    | 编辑   | 优化触发点插入事件发射            |
| `src/multimodal/VisionEngine.ts`           | 编辑   | 分析开始/完成插入事件发射          |
| `src/multimodal/SpeechRecognizer.ts`       | 编辑   | 识别开始/完成插入事件发射          |
| `src/multimodal/MultimodalFusionEngine.ts` | 编辑   | 融合阶段插入事件发射             |

### 前端文件

| 文件                                                 | 修改类型 | 修改内容                           |
| -------------------------------------------------- | ---- | ------------------------------ |
| `src/frontend/src/types/chat.ts`                   | 编辑   | WebSocketMessage.type 新增 4 个类型 |
| `src/frontend/src/hooks/useWebSocket.ts`           | 编辑   | 新增消息类型处理和 listener 注册          |
| `src/frontend/src/contexts/AgentStateContext.tsx`  | 新建   | AGENT 全局状态管理                   |
| `src/frontend/src/components/PerceptionPanel/`     | 新建   | 感知层可视化面板                       |
| `src/frontend/src/components/BrainStagePanel/`     | 新建   | 大脑决策阶段可视化面板                    |
| `src/frontend/src/components/ExecutionPanel/`      | 新建   | 技能执行可视化面板                      |
| `src/frontend/src/components/AgentExecutionPanel/` | 编辑   | 重构为实时数据驱动                      |
| `src/frontend/src/components/EvolutionPanel/`      | 编辑   | 接入实时数据，替换假数据                   |
| `src/frontend/src/App.tsx`                         | 编辑   | 新增 AgentDashboard 布局           |

## 风险与回退方案

### 风险

1. **事件风暴**：大量事件可能影响性能 → 解决方案：事件节流（throttle）+ 前端批量更新
2. **AgentLoop 接入导致行为变化** → 解决方案：保留原有内联逻辑作为 fallback，AgentLoop 仅增强不替换
3. **前端状态膨胀** → 解决方案：状态历史限制（如只保留最近 50 条），定期清理

### 回退方案

* 所有修改都是"增加"而非"替换"，可随时关闭事件发射（通过配置开关）

* 前端面板如不稳定，可回退到现有静态实现

## 验收标准

1. **后端**：每次 `processInput` 调用至少发射 6 个 `brain_stage_update` 事件
2. **后端**：每次技能执行发射至少 2 个 `skill_execution_update` 事件
3. **后端**：每次质量评估发射 1 个 `evolution_event` 事件
4. **前端**：Agent Dashboard 能实时显示当前处理阶段
5. **前端**：技能执行能看到进度和重试状态
6. **前端**：进化面板显示真实质量分数趋势
7. **测试**：`npm run check:all` 全部通过

