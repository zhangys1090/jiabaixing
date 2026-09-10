# Jiabaixing v3 LLM 原生架构完整设计计划

## 摘要

将 jiabaixing 从"pipeline-based chatbot"彻底改造为"LLM-native AI Agent"。核心哲学：**LLM 是操作系统，其余一切皆工具**。用底层规则补齐 LLM 的短板（持久性、时间感、执行力、自我认知），把 LLM 的创造性解放到最大。

当前已完成：FC 循环、基础设施工具、自动记忆注入、时间上下文、工具预算、质量评估。
**本计划补齐剩余短板：Scheduler v3 集成、主动消息 FC 化、知识库自动提取、工具结果验证、对话状态持久化。**

***

## 当前状态分析

### 已完成的改造

| 模块               | 当前状态                                                                       | 文件                                           |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| FC 循环核心          | 自动记忆注入 + 时间上下文 + 软硬预算 + 质量评分                                               | `src/core/JiabaixingCore.ts` lines 725-940   |
| 基础设施工具           | 5 个工具：memory\_recall/store, emotion\_detect, analyze\_scene, self\_reflect | `src/core/JiabaixingCore.ts` lines 2599-2877 |
| 宪法 system prompt | 动态时间 + 人格定义 + 行为准则                                                         | `src/core/JiabaixingCore.ts` lines 2879-2926 |
| PersonaRules     | 纯安全过滤（不再润色）                                                                | `src/persona/PersonaRules.ts`                |
| IntentRecognizer | 纯 fallback 模式                                                              | `src/core/JiabaixingCore.ts` line 295        |

### 还缺失的短板

| 短板                                      | 现状                                                                                                   | 影响                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Scheduler 未 FC 化**                    | Scheduler 通过 EventBus 发射 `proactive_interaction`，main.ts 调用 `generateProactiveMessage()` 走旧 pipeline | 主动消息和被动消息走不同路径，架构分裂            |
| **generateProactiveMessage 旧 pipeline** | 使用 `personaGuard.buildSystemPrompt()` + `personaGuard.adjustTone()` + 硬编码 reasonGuidance             | 未利用 FC 循环的智能决策能力               |
| **无工具结果验证**                             | FC 循环直接信任工具返回结果                                                                                      | LLM 可能基于错误工具输出产生幻觉             |
| **无对话状态持久化**                            | `recentConversationHistory` 只在内存中                                                                    | 进程重启后对话上下文丢失                   |
| **无自动知识提取**                             | 每次对话结束后不自动提取关键信息存入记忆                                                                                 | 需要 LLM 主动调用 memory\_store，经常遗漏 |
| **Scheduler 任务硬编码**                     | `executeMorningBriefing` 等任务直接 emit 固定消息                                                             | 无法利用 LLM 的创造性生成个性化主动消息         |

***

## 架构设计：完整 v3 蓝图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户输入层                                   │
│  文本 / 语音 / 图像 / 文件 / 主动触发 (Scheduler)                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    JiabaixingCore.processInput()                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │ 直接命令    │  │ Scheduler   │  │ 用户主动输入                │  │
│  │ 预处理器    │  │ 主动消息    │  │ (正常对话)                  │  │
│  │ (bypass)    │  │ (统一入口)  │  │                             │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              LLM 原生 Function Calling 循环                  │    │
│  │  ┌─────────────────────────────────────────────────────┐   │    │
│  │  │  自动记忆注入 (autoRetrieveMemories)                 │   │    │
│  │  │  时间上下文 (buildConstitutionPrompt)                │   │    │
│  │  │  宪法 system prompt                                  │   │    │
│  │  └─────────────────────────────────────────────────────┘   │    │
│  │                              │                             │    │
│  │                              ▼                             │    │
│  │  ┌─────────────────────────────────────────────────────┐   │    │
│  │  │  LLM.chatWithTools(messages, tools)                  │   │    │
│  │  │  ├─ 基础设施工具 (memory/ emotion/ scene/ reflect)   │   │    │
│  │  │  ├─ 业务技能 (file/ search/ code/ browser/ command)  │   │    │
│  │  │  └─ 工具结果验证 (validateToolResult)                │   │    │
│  │  └─────────────────────────────────────────────────────┘   │    │
│  │                              │                             │    │
│  │                              ▼                             │    │
│  │  ┌─────────────────────────────────────────────────────┐   │    │
│  │  │  软预算警告 (4轮) → 硬预算终止 (8轮)                 │   │    │
│  │  │  自动质量评分 (computeQualityScore)                  │   │    │
│  │  │  安全过滤 (safetyFilter)                             │   │    │
│  │  │  进化反馈 (assessQuality with real score)            │   │    │
│  │  └─────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  对话状态持久化 (saveConversationState)                      │    │
│  │  自动知识提取 (autoExtractKnowledge)                         │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         输出层                                       │
│  响应文本 / 工具执行结果 / 主动消息 / 错误降级                         │
└─────────────────────────────────────────────────────────────────────┘
```

***

## 具体改造计划（6 项）

### 1. Scheduler v3 — 主动消息走 FC 架构

**问题**：Scheduler 的 `executeMorningBriefing` 等任务直接 emit 固定模板消息，未利用 LLM 的智能决策能力。

**改造方案**：

```typescript
// ScenarioAwareScheduler.ts — 改造 executeMorningBriefing
private async executeMorningBriefing(): Promise<void> {
  // 不再直接 emit 固定消息，而是构建上下文让 LLM 生成
  const context = await this.buildProactiveContext('morning_briefing');
  void EventBus.emit('proactive_interaction', {
    reason: 'morning_briefing',
    context: JSON.stringify(context),
    scene: '早晨',
    priority: 'normal',
  });
}

// 新增：构建主动消息上下文
private async buildProactiveContext(reason: string): Promise<Record<string, unknown>> {
  const now = new Date();
  const hour = now.getHours();
  
  // 获取今日日程
  const todayTasks = this.getTodayTasks();
  
  // 获取最近记忆
  const recentMemories = this.memoryEngine 
    ? await this.memoryEngine.retrieveRelevant({ query: '今日计划 待办 重要', limit: 3 })
    : [];
  
  // 获取情绪趋势
  const emotionTrend = this.userBehaviorPattern.emotionTrend.slice(-7);
  
  return {
    time: now.toISOString(),
    hour,
    dayOfWeek: now.getDay(),
    todayTasks,
    recentMemories: recentMemories.map((m: { content: string }) => m.content),
    emotionTrend,
    userPattern: this.userBehaviorPattern,
  };
}
```

**JiabaixingCore.ts — 改造 generateProactiveMessage**：

```typescript
public async generateProactiveMessage(context: {
  reason: string;
  context: string;
  scene: string;
  isEmotionBased: boolean;
}): Promise<string> {
  // v3: 主动消息也走 FC 循环，和被动消息统一路径
  const parsedContext = JSON.parse(context.context || '{}');
  
  // 构建 proactive input，走 processInput 的 FC 循环
  const proactiveInput = this.buildProactiveInput(context.reason, parsedContext);
  
  // 调用 processInput（复用相同的 FC 循环）
  const result = await this.processInput(proactiveInput, 'system', `proactive_${context.reason}`);
  
  return result.response;
}

private buildProactiveInput(reason: string, context: Record<string, unknown>): string {
  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  
  const reasonPrompts: Record<string, string> = {
    morning_briefing: `现在是 ${timeStr}。作为秘书，给用户发一条早安消息。\n今日日程：${(context.todayTasks as string[] || []).join(', ') || '无'}\n最近关注：${(context.recentMemories as string[] || []).slice(0, 2).join('；') || '无'}`,
    task_reminder: `提醒用户处理待办事项。\n待办：${(context.todayTasks as string[] || []).join(', ') || '无'}`,
    emotion_check: `用户最近情绪趋势：${JSON.stringify(context.emotionTrend || [])}。温和地表达关切。`,
    evening_checkin: `晚上了，询问用户今天的情况，是否需要整理明天的安排。`,
    late_night: `已经深夜了，提醒用户注意休息。`,
  };
  
  return reasonPrompts[reason] || `系统触发：${reason}`;
}
```

**文件**：`src/core/ScenarioAwareScheduler.ts`, `src/core/JiabaixingCore.ts`

***

### 2. 工具结果验证 — 防止 LLM 基于错误输出幻觉

**问题**：FC 循环中工具返回的结果直接传给 LLM，如果工具返回错误/空/不合理数据，LLM 可能产生幻觉。

**改造方案**：

```typescript
// JiabaixingCore.ts — 在 executeToolCall 后添加验证层

private validateToolResult(
  toolName: string,
  result: { success: boolean; output: unknown; error?: string }
): { valid: boolean; sanitizedOutput: string; warning?: string } {
  // 1. 检查执行是否成功
  if (!result.success) {
    return {
      valid: true, // 允许失败结果通过，但标记错误
      sanitizedOutput: `错误: ${result.error || '工具执行失败'}`,
      warning: `${toolName} 执行失败`,
    };
  }
  
  // 2. 检查输出是否为空或过于简短
  const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  if (!outputStr || outputStr.trim().length === 0) {
    return {
      valid: true,
      sanitizedOutput: '工具返回了空结果',
      warning: `${toolName} 返回空结果`,
    };
  }
  
  // 3. 检查输出是否包含明显的错误标记
  const errorPatterns = ['error', 'exception', 'failed', 'timeout', 'unauthorized', 'not found'];
  const lowerOutput = outputStr.toLowerCase();
  if (errorPatterns.some(p => lowerOutput.includes(p)) && outputStr.length < 200) {
    return {
      valid: true,
      sanitizedOutput: outputStr,
      warning: `${toolName} 可能返回了错误信息`,
    };
  }
  
  // 4. 截断过长的输出（防止 Token 爆炸）
  const MAX_TOOL_OUTPUT = 4000;
  if (outputStr.length > MAX_TOOL_OUTPUT) {
    return {
      valid: true,
      sanitizedOutput: outputStr.substring(0, MAX_TOOL_OUTPUT) + '\n...[内容已截断]',
      warning: `${toolName} 输出过长，已截断`,
    };
  }
  
  return { valid: true, sanitizedOutput: outputStr };
}
```

在 FC 循环中使用：

```typescript
for (const toolCall of fcResponse.toolCalls) {
  const rawResult = await skillRegistry.executeToolCall(toolCall, { userId, traceId });
  const validated = this.validateToolResult(toolCall.function.name, rawResult);
  
  if (validated.warning) {
    Logger.warn(`⚠️ ${validated.warning}`, 'JiabaixingCore');
  }
  
  messages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: validated.sanitizedOutput,
  });
}
```

**文件**：`src/core/JiabaixingCore.ts`

***

### 3. 对话状态持久化 — 防止进程重启丢失上下文

**问题**：`recentConversationHistory` 是内存数组，进程重启后对话上下文完全丢失。

**改造方案**：

```typescript
// JiabaixingCore.ts — 添加对话状态持久化

private readonly CONVERSATION_STATE_FILE = path.join(process.cwd(), 'data', 'conversation_state.json');

/**
 * 保存对话状态到文件
 */
private async saveConversationState(): Promise<void> {
  try {
    const state = {
      history: this.recentConversationHistory,
      lastUpdated: new Date().toISOString(),
      userId: 'default',
    };
    fs.writeFileSync(this.CONVERSATION_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // 忽略保存失败
  }
}

/**
 * 从文件恢复对话状态
 */
private async loadConversationState(): Promise<void> {
  try {
    if (fs.existsSync(this.CONVERSATION_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(this.CONVERSATION_STATE_FILE, 'utf-8'));
      if (state.history && Array.isArray(state.history)) {
        this.recentConversationHistory = state.history.slice(-this.MAX_CONVERSATION_HISTORY);
        Logger.info(`💾 已恢复 ${this.recentConversationHistory.length} 条对话历史`, 'JiabaixingCore');
      }
    }
  } catch {
    // 忽略恢复失败
  }
}
```

在 `processInput` 结尾和 `initialize` 中调用：

```typescript
// initialize 中恢复
async initialize(): Promise<void> {
  // ... 现有代码 ...
  await this.loadConversationState();
}

// processInput 结尾保存
this.recentConversationHistory.push(...);
await this.saveConversationState(); // 异步保存，不阻塞返回
```

**文件**：`src/core/JiabaixingCore.ts`

***

### 4. 自动知识提取 — 对话结束后自动提取关键信息

**问题**：当前依赖 LLM 主动调用 `memory_store` 工具保存信息，但 LLM 经常遗漏。

**改造方案**：在 `processInput` 返回后，异步提取关键信息并自动存储：

```typescript
// JiabaixingCore.ts — 添加自动知识提取

/**
 * v3: 自动知识提取——对话结束后异步提取关键信息存入记忆
 * 不依赖 LLM 主动调用 memory_store
 */
private async autoExtractKnowledge(
  input: string,
  response: string,
  userId?: string
): Promise<void> {
  if (!this.memoryEngine?.storeShortTermMemory) return;
  
  // 简单规则提取（无需 LLM，快速可靠）
  const extracted: Array<{ content: string; category: string }> = [];
  
  // 1. 提取用户偏好（"我喜欢..." / "我讨厌..." / "我习惯..."）
  const preferencePatterns = [
    { pattern: /我(?:喜欢|爱|偏好|习惯|常用|一般|通常)\s*([^。，！？]+)/, category: 'preference' },
    { pattern: /我(?:不喜欢|讨厌|反感|不用|从不)\s*([^。，！？]+)/, category: 'preference' },
    { pattern: /我(?:是|在|做|从事)\s*([^。，！？]{3,30})/, category: 'fact' },
    { pattern: /我(?:明天|下周|后天|过几天|待会|稍后)\s*(?:要|需要|准备|打算)\s*([^。，！？]+)/, category: 'task' },
  ];
  
  for (const { pattern, category } of preferencePatterns) {
    const match = input.match(pattern);
    if (match && match[1].trim().length > 2) {
      extracted.push({ content: match[1].trim(), category });
    }
  }
  
  // 2. 提取确认的任务/事件
  if (response.includes('已') && (response.includes('设置') || response.includes('添加') || response.includes('保存'))) {
    const taskMatch = input.match(/(?:设置|添加|创建|安排|提醒)\s*([^。，！？]+)/);
    if (taskMatch) {
      extracted.push({ content: `任务/提醒: ${taskMatch[1].trim()}`, category: 'task' });
    }
  }
  
  // 3. 存储提取的信息
  for (const item of extracted) {
    try {
      await this.memoryEngine.storeShortTermMemory(item.content, item.category, userId || '');
      Logger.info(`🧠 自动提取知识: [${item.category}] ${item.content}`, 'JiabaixingCore');
    } catch {
      // 忽略存储失败
    }
  }
}
```

在 `processInput` 返回前异步调用：

```typescript
// 返回前异步提取知识（不阻塞响应）
setImmediate(() => {
  this.autoExtractKnowledge(input, safeResponse, userId).catch(() => {});
});
```

**文件**：`src/core/JiabaixingCore.ts`

***

### 5. Scheduler 任务智能化 — 用 LLM 生成个性化主动消息

**问题**：`executeMorningBriefing` 等任务直接 emit 固定消息（"早上好！今天有什么计划？"），缺乏个性化。

**改造方案**：已在"1. Scheduler v3"中涵盖。Scheduler 构建丰富上下文 → 通过 `proactive_interaction` → `generateProactiveMessage` 走 FC 循环 → LLM 生成个性化消息。

**关键改进**：

* `executeMorningBriefing` 不再直接 emit，而是构建包含今日日程、最近记忆、用户画像的上下文

* `executeEmotionCheck` 分析情绪趋势后，构建情绪上下文让 LLM 生成关切消息

* `executeTaskReminder` 获取实际待办事项，让 LLM 生成提醒消息

**文件**：`src/core/ScenarioAwareScheduler.ts`

***

### 6. 工具调用链路可观测性 — 完整追踪

**问题**：FC 循环中的工具调用缺乏完整追踪，难以调试和优化。

**改造方案**：

```typescript
// JiabaixingCore.ts — 增强工具调用追踪

interface ToolExecutionTrace {
  toolName: string;
  toolCallId: string;
  startTime: number;
  endTime: number;
  duration: number;
  success: boolean;
  outputLength: number;
  warning?: string;
}

// 在 FC 循环中收集追踪信息
const toolTraces: ToolExecutionTrace[] = [];

for (const toolCall of fcResponse.toolCalls) {
  const toolStart = Date.now();
  const rawResult = await skillRegistry.executeToolCall(toolCall, { userId, traceId });
  const validated = this.validateToolResult(toolCall.function.name, rawResult);
  
  toolTraces.push({
    toolName: toolCall.function.name,
    toolCallId: toolCall.id,
    startTime: toolStart,
    endTime: Date.now(),
    duration: Date.now() - toolStart,
    success: rawResult.success,
    outputLength: validated.sanitizedOutput.length,
    warning: validated.warning,
  });
  
  // ... 其余代码 ...
}

// 记录完整追踪
Logger.info(
  `🔧 工具调用追踪: ${toolTraces.map(t => `${t.toolName}(${t.duration}ms${t.warning ? ',⚠️' : ''})`).join(' → ')}`,
  'JiabaixingCore'
);

// 发射追踪事件供前端展示
void EventBus.emit('tool_execution_trace', {
  traceId: finalTraceId,
  toolTraces,
  totalDuration: Date.now() - startTime,
  loopCount,
});
```

**文件**：`src/core/JiabaixingCore.ts`, `src/shared/EventBus.ts`（添加事件类型）

***

## 实施顺序

```
Phase 1: 基础设施（无外部依赖）
  ├─ 2. 工具结果验证
  ├─ 3. 对话状态持久化
  └─ 4. 自动知识提取

Phase 2: Scheduler 改造（依赖 Phase 1）
  ├─ 5. Scheduler 任务智能化
  └─ 1. Scheduler v3 — 主动消息走 FC 架构

Phase 3: 可观测性（独立）
  └─ 6. 工具调用链路可观测性
```

***

## 验证步骤

1. **构建验证**：`npx tsc --noEmit` — 0 errors
2. **FC 循环测试**：发送测试消息，验证工具调用、记忆注入、时间上下文正常工作
3. **主动消息测试**：触发 Scheduler 任务，验证主动消息走 FC 循环
4. **状态持久化测试**：重启进程，验证对话历史恢复
5. **知识提取测试**：发送包含偏好的消息，验证自动提取并存储

***

## 风险与回退

| 风险                    | 缓解措施                                        |
| --------------------- | ------------------------------------------- |
| Scheduler 改造后主动消息延迟增加 | FC 循环有 30s 超时，超时时降级到固定模板                    |
| 自动知识提取误提取             | 使用保守规则，只提取明确标记的偏好/任务                        |
| 对话状态文件损坏              | `loadConversationState` 有 try-catch，损坏时静默忽略 |
| 工具结果验证过度拦截            | 验证层只标记警告，不阻止结果传递                            |

