# 阶段 1-4 实施计划：单一人格核心落地 → 全链路测试交付

## 项目现状分析

### 已有模块评估

| 模块 | 状态 | 说明 |
|------|------|------|
| `PersonaRules.ts` | 需重写 | 当前是硬编码规则+润色器，需改为场景感知微调器 |
| `JiabaixingCore.processInput()` | 需改造 | 当前三分支（快速路径/DAG/降级），需改为单一路径 |
| `MemoryEngine` | 需升级 | 已有基础记忆功能，需增加行为模式存储和时间衰减权重 |
| `ScenarioAwareScheduler` | 需丰富 | 已有场景调度基础，需增加主动检查循环 |
| `LLMProvider` | 可用 | 已有 chat/analyzeCode/generateModifiedFileContent 接口 |
| `SceneRecognizer` | 可用 | 已有基于文本的场景识别 |
| `EvolutionManager` | 需扩展 | 已有基础进化分析，需增加策略优化和定时触发 |
| `InteractionEngine` | 待整合 | 已有模板回复体系，后续逐步替换为 LLM 生成 |
| `CoreReasoningEngine` | 保留 | 复杂任务仍走 DAG 流程，简单任务走单一路径 |

---

## 阶段 1：单一人格核心落地（2天）

### 1.1 实现 PersonaCore.ts

**目标**：定义御姐秘书完整档案，支持配置加载

**实现要点**：
```typescript
// src/persona/PersonaCore.ts
export interface PersonaProfile {
  name: string;
  age: number;
  gender: string;
  role: string;
  coreTraits: string[];
  speechStyle: {
    dos: string[];
    donts: string[];
  };
  boundaryRules: string[];
  sceneToneMatrix: Record<string, ToneParams>;
}

export interface ToneParams {
  temperature: number;   // 0-1
  formality: number;     // 0-1
  verbosity: number;     // 0-1
  emojiFrequency: number; // 0-1
  proactive: boolean;
}

export class PersonaCore {
  private profile: PersonaProfile;
  private configPath: string;
  
  static async load(configPath?: string): Promise<PersonaCore>;
  getProfile(): PersonaProfile;
  getToneForScene(scene: string): ToneParams;
  buildPersonaSummary(): string; // 供 LLM prompt 使用
}
```

**验收标准**：
- `PersonaCore.load()` 可加载默认配置
- 可获取完整人格对象
- 支持不同场景的语气参数查询

### 1.2 重写 PersonaRules.ts 为场景感知微调器

**目标**：根据 SceneRecognizer 的场景标签选择语气参数，而非硬拦截

**改造要点**：
- 移除硬编码的 `forbiddenContent` 和 `forbiddenPatterns` 拦截逻辑
- 保留安全红线检查（自杀/暴力等）
- 新增 `adjustTone(content: string, scene: string): string` 方法
- 输入场景标签（开发/日常/安慰），输出调整后的语气参数对象

**核心逻辑**：
```typescript
export class PersonaRules {
  private personaCore: PersonaCore;
  
  adjustTone(content: string, sceneTag: string): {
    adjustedContent: string;
    toneParams: ToneParams;
    appliedAdjustments: string[];
  };
}
```

**验收标准**：
- 输入 `"开发"` 场景，输出正式、简洁的语气参数
- 输入 `"安慰"` 场景，输出温暖、克制的语气参数
- 不再抛出硬拦截错误，改为标记警告

### 1.3 实现 DialogueGenerator.ts

**目标**：调用 LLMProvider 生成回复，自动注入人格摘要、记忆、场景指令

**实现要点**：
```typescript
// src/persona/DialogueGenerator.ts
export class DialogueGenerator {
  constructor(
    private llm: LLMProvider,
    private personaCore: PersonaCore,
    private memoryEngine: MemoryEngine
  ) {}

  async generate(
    input: string,
    sceneTag: string,
    memoryContext: MemoryItem[],
    userProfileSummary: string
  ): Promise<string>;
  
  private buildSystemPrompt(sceneTag: string): string;
  private buildUserPrompt(input: string, memoryContext: MemoryItem[]): string;
}
```

**Prompt 构建逻辑**：
1. System Prompt = 人格摘要 + 场景语气指令 + 边界提醒
2. User Prompt = 用户输入 + 召回的记忆摘要 + 用户画像摘要

**验收标准**：
- 回复自然、符合人设
- 无模板感
- 能引用记忆中的具体信息

### 1.4 改造 JiabaixingCore.processInput()

**目标**：单一路径：场景识别 → 记忆召回 → LLM 生成 → 人格微调 → 输出

**当前问题**：
```typescript
// 当前三分支
if (isSimpleConversational) { /* 快速路径 */ }
else if (coreReasoningEngine) { /* DAG 路径 */ }
else { /* 降级路径 */ }
```

**改造后**：
```typescript
async processInput(input: string, userId?: string, traceId?: string): Promise<ProcessInputResult> {
  // 1. 场景识别
  const sceneTag = await this.sceneRecognizer.recognize(input);
  
  // 2. 记忆召回
  const memoryContext = await this.memoryEngine.retrieveRelevant({
    query: input,
    userId,
    limit: 5,
    includeBehaviorPatterns: true,
  });
  
  // 3. 判断任务复杂度
  const complexity = assessTaskComplexity(input);
  
  let rawResponse: string;
  
  if (complexity === TaskComplexity.COMPLEX) {
    // 复杂任务仍走 DAG
    rawResponse = await this.coreReasoningEngine.execute(input, sceneTag);
  } else {
    // 简单/常规任务走单一路径
    rawResponse = await this.dialogueGenerator.generate(
      input, sceneTag, memoryContext, this.userProfileSummary
    );
  }
  
  // 4. 人格微调
  const finalResponse = this.personaRules.adjustTone(rawResponse, sceneTag.type);
  
  // 5. 输出
  return { response: finalResponse.adjustedContent, traceId, intent: sceneTag.type };
}
```

**验收标准**：
- 不再有三分支 if-else
- 代码简洁
- 功能完整（简单对话+复杂任务都支持）

---

## 阶段 2：记忆增强与主动循环（2天）

### 2.1 升级 MemoryEngine

**目标**：增加用户行为模式存储，支持时间衰减权重

**新增数据结构**：
```typescript
interface BehaviorPattern {
  pattern: string;           // 如 "每天晚上9点问明天日程"
  frequency: number;         // 发生频率
  lastOccurred: Date;
  timeDecayWeight: number;   // 时间衰减权重 (0-1)
  confidence: number;        // 置信度
}

interface MemoryRetrievalParams {
  query: string;
  userId?: string;
  limit?: number;
  includeBehaviorPatterns?: boolean;
  timeDecayFactor?: number;  // 衰减因子，默认 0.95
}
```

**实现要点**：
- 在 `MemoryEngine` 中新增 `behaviorPatterns` 存储区
- 实现 `detectBehaviorPatterns()` 方法，定期扫描历史记录
- 召回时按 `timeDecayWeight * relevanceScore` 排序

**验收标准**：
- 新记忆类型可存入
- 召回排序考虑时间衰减
- 能检测出 "每天晚上9点问日程" 这类模式

### 2.2 丰富 ScenarioAwareScheduler

**目标**：每 10 分钟扫描日程、检查记忆模式，触发主动交互

**新增逻辑**：
```typescript
export class ScenarioAwareScheduler {
  private proactiveCheckInterval: NodeJS.Timeout;
  
  startProactiveLoop(): void {
    // 每 10 分钟执行一次
    this.proactiveCheckInterval = setInterval(() => {
      this.checkSchedules();      // 检查是否有即将到来的日程
      this.checkEmotionTrends();  // 检查情绪趋势
      this.checkBehaviorPatterns(); // 检查行为模式触发
    }, 10 * 60 * 1000);
  }
  
  private async checkSchedules(): Promise<void>;
  private async checkEmotionTrends(): Promise<void>;
  private async checkBehaviorPatterns(): Promise<void>;
}
```

**验收标准**：
- 能自动发送晨间简报
- 能发送休息提醒
- 日志可见触发记录

### 2.3 记忆深度集成到 LLM 上下文

**目标**：每次请求附加用户画像摘要、近期行为模式

**实现要点**：
- `DialogueGenerator.buildUserPrompt()` 中增加：
  - 用户画像摘要（偏好语言、框架、习惯）
  - 近期行为模式（最近关注的主题、重复的行为）
  - 相关历史对话（语义召回）

**验收标准**：
- 回复体现 "她记得我"
- 能引用之前的偏好
- 能根据行为模式预判需求

---

## 阶段 3：进化引擎与正向循环打通（3天）

### 3.1 实现 FeedbackCollector

**目标**：在 processInput 末尾非阻塞采集反馈，写入记忆

**实现要点**：
```typescript
// src/evolution/FeedbackCollector.ts
export class FeedbackCollector {
  collect(input: string, response: string, executionResult: ExecutionResult): void {
    // 非阻塞采集
    setImmediate(() => {
      this.storeFeedback({
        traceId,
        input,
        response,
        executionSuccess: executionResult.success,
        userCorrection: this.detectCorrection(input, response),
        inferredSatisfaction: this.inferSatisfaction(input, response),
        timestamp: Date.now(),
      });
    });
  }
}
```

**验收标准**：
- 每次交互完产生一条反馈记录
- 非阻塞，不影响响应速度
- 存储到记忆的 feedback 区

### 3.2 实现 StrategyOptimizer

**目标**：支持三种策略调整

**实现要点**：
```typescript
// src/evolution/StrategyOptimizer.ts
export class StrategyOptimizer {
  // ① 语气偏好学习
  learnTonePreference(feedbackRecords: FeedbackRecord[]): ToneAdjustment;
  
  // ② 技能选择偏好
  learnSkillPreference(feedbackRecords: FeedbackRecord[]): SkillWeightAdjustment;
  
  // ③ 拆解策略微调
  learnDecompositionStrategy(feedbackRecords: FeedbackRecord[]): PromptExample[];
  
  // 自动触发优化
  async optimizeIfNeeded(): Promise<OptimizationLog | null>;
}
```

**触发条件**：
- 积累 50 条反馈后自动触发
- 生成调整日志

**验收标准**：
- 50 条反馈后自动触发优化
- 生成调整日志
- 三种策略都能独立调整

### 3.3 实现 EvolutionEngine 主控

**目标**：定时每日凌晨 3 点自动运行，或手动触发

**实现要点**：
```typescript
// src/evolution/EvolutionEngine.ts
export class EvolutionEngine {
  private feedbackCollector: FeedbackCollector;
  private strategyOptimizer: StrategyOptimizer;
  
  start(): void {
    // 每日凌晨 3 点
    schedule.scheduleJob('0 3 * * *', () => {
      this.runDailyOptimization();
    });
  }
  
  // 手动触发（如用户说"你最近回复有点冷"）
  async triggerManualOptimization(reason: string): Promise<OptimizationLog>;
  
  private async runDailyOptimization(): Promise<void>;
}
```

**验收标准**：
- 定时任务正常
- 手动触发正常
- 生成优化报告

### 3.4 在 main.ts 中初始化进化引擎

**目标**：系统启动即进入自我进化模式

**实现要点**：
```typescript
// src/main.ts
const ENABLE_AUTO_OPTIMIZE = process.env.ENABLE_AUTO_OPTIMIZE !== 'false';

if (ENABLE_AUTO_OPTIMIZE) {
  const evolutionEngine = new EvolutionEngine(memoryEngine, interactionEngine);
  evolutionEngine.start();
  Logger.info('🧬 进化引擎已启动', 'Main');
}
```

**验收标准**：
- 环境开关 `ENABLE_AUTO_OPTIMIZE=true` 生效
- 系统启动即进入进化模式

---

## 阶段 4：全链路测试与交付（2天）

### 4.1 人格一致性测试

**测试场景**：连续 100 轮对话
**验收方法**：
```typescript
test('persona consistency over 100 rounds', async () => {
  const conversations = generateTestConversations(100);
  for (const input of conversations) {
    const result = await core.processInput(input, 'test-user');
    const validation = personaRules.validate(result.response);
    expect(validation.isValid).toBe(true);
    expect(validation.warnings).toHaveLength(0);
  }
});
```

### 4.2 主动循环测试

**测试场景**：设置 2 分钟后的日程，等待 Scheduler 提醒
**验收方法**：
```typescript
test('proactive scheduler reminder', async () => {
  const scheduleTime = new Date(Date.now() + 2 * 60 * 1000);
  await scheduler.addSchedule({ time: scheduleTime, content: '测试提醒' });
  
  // 等待 3 分钟
  await sleep(3 * 60 * 1000);
  
  // 检查日志中是否有提醒记录
  expect(logs).toContain('发送主动提醒');
}, 5 * 60 * 1000);
```

### 4.3 正向循环效果测试

**测试场景**：模拟 10 次 "请用 snake_case" 纠错
**验收方法**：
```typescript
test('positive loop: snake_case learning', async () => {
  // 模拟 10 次纠错
  for (let i = 0; i < 10; i++) {
    await core.processInput('文件命名请用 snake_case', 'test-user');
    feedbackCollector.collectCorrection('file_skill', 'naming', 'snake_case');
  }
  
  // 触发优化
  await strategyOptimizer.optimizeIfNeeded();
  
  // 检查下次生成是否自动使用 snake_case
  const result = await skillRegistry.executeSkill('code_generator', {
    requirements: 'create a file',
  });
  expect(result.output.code).toMatch(/snake_case|_/);
});
```

### 4.4 记忆持久化测试

**测试场景**：重启系统，检查记忆是否保留
**验收方法**：
```typescript
test('memory persistence after restart', async () => {
  // 存储记忆
  await memoryEngine.store({ content: '偏好 TypeScript', userId: 'test' });
  
  // 模拟重启（重新实例化）
  const newMemoryEngine = new MemoryEngine();
  await newMemoryEngine.initialize();
  
  // 召回
  const memories = await newMemoryEngine.retrieveRelevant({
    query: '编程语言偏好',
    userId: 'test',
  });
  
  expect(memories.some(m => m.content.includes('TypeScript'))).toBe(true);
});
```

---

## 实施顺序与依赖关系

```
阶段 1
├── 1.1 PersonaCore.ts (无依赖)
├── 1.2 PersonaRules.ts 重写 (依赖 1.1)
├── 1.3 DialogueGenerator.ts (依赖 1.1, LLMProvider, MemoryEngine)
└── 1.4 改造 processInput() (依赖 1.2, 1.3, SceneRecognizer)

阶段 2
├── 2.1 升级 MemoryEngine (无依赖)
├── 2.2 丰富 ScenarioAwareScheduler (依赖 2.1)
└── 2.3 记忆集成到 LLM (依赖 2.1, 1.3)

阶段 3
├── 3.1 FeedbackCollector (依赖 processInput)
├── 3.2 StrategyOptimizer (依赖 3.1)
├── 3.3 EvolutionEngine (依赖 3.1, 3.2)
└── 3.4 main.ts 集成 (依赖 3.3)

阶段 4
├── 4.1 人格一致性测试 (依赖阶段 1)
├── 4.2 主动循环测试 (依赖阶段 2)
├── 4.3 正向循环测试 (依赖阶段 3)
└── 4.4 记忆持久化测试 (依赖阶段 2)
```

---

## 文件变更预估

### 新增文件
```
src/persona/
├── PersonaCore.ts           # 1.1
├── DialogueGenerator.ts     # 1.3
└── index.ts                 # 更新导出

src/evolution/
├── FeedbackCollector.ts     # 3.1
├── StrategyOptimizer.ts     # 3.2
├── EvolutionEngine.ts       # 3.3
└── index.ts                 # 更新导出

tests/integration/
├── PersonaConsistency.test.ts    # 4.1
├── ProactiveScheduler.test.ts    # 4.2
├── PositiveLoop.test.ts          # 4.3
└── MemoryPersistence.test.ts     # 4.4
```

### 修改文件
```
src/persona/PersonaRules.ts           # 1.2 重写
src/core/JiabaixingCore.ts            # 1.4 改造 processInput
src/memory/MemoryEngine.ts            # 2.1 升级
src/core/ScenarioAwareScheduler.ts    # 2.2 丰富
src/models/LLMProvider.ts             # 可能需扩展接口
src/main.ts                           # 3.4 初始化进化引擎
```
