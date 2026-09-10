# jiabaixing 系统功能模块改进计划

> 基于 Phase 0-6 整合完成后的全面评估，针对 8 个模块提出具体改进方案。

---

## 一、当前系统基线状态

### 已完成（Phase 0-6 整合成果）

| 模块 | 状态 | 关键成果 |
|------|:----:|---------|
| AgentLoop 状态机 | ✅ | 6 阶段闭环（PERCEIVE→PLAN→EXECUTE→VERIFY→OUTPUT→LEARN）+ CancellationToken |
| SkillRegistry + SkillBridge | ✅ | 6 技能 + ToolExecutor 14 工具两级回落 |
| MemoryEngine | ✅ | 三层记忆 + 向量检索 + 用户画像 + PreferenceManager + PreferenceInjector |
| ScenarioAwareScheduler | ✅ | 6 路主动事件 + user_input 路由到 AgentLoop |
| EventBus | ✅ | 30+ 类型安全事件 + SQLite 持久化 |
| 前后端集成 | ✅ | WebSocket 双向 + REST API + SSE 日志流 |
| 压力测试 | ✅ | 5 梯度测试（L1-L5）+ 性能/稳定性测试 |

### 待改进模块

| 模块 | 当前状态 | 优先级 |
|------|:-------:|:------:|
| 沙箱执行 | ❌ 无隔离 | **P0** |
| 搜索能力 | ❌ 无 Web 搜索 | **P0** |
| 开放 Skill API | ⚠️ 仅内部 | **P1** |
| 拟人交互 | ⚠️ PersonaRules 硬门控 | **P1** |
| 浏览器自动化 | ❌ 无 | P2 |
| 多模态视觉 | ⚠️ 框架存在无管线 | P2 |
| 多模态融合 | ⚠️ 部分实现 | P2 |
| 硬件接入 | ❌ Stub | P3 |

---

## 二、模块改进详细计划

### 模块 1：沙箱执行环境（P0）

#### 现状
- `ToolExecutor.run_command` 直接调用 `child_process.exec`，无隔离
- 高危命令（rm -rf /）可直接执行
- 无资源限制（CPU/内存/磁盘）

#### 目标
实现命令执行的完全隔离，支持资源限制和超时保护。

#### 技术选型

| 方案 | 隔离级别 | 复杂度 | 适用场景 |
|------|:-------:|:------:|---------|
| **vm2** | 进程级 | 低 | 快速集成，适合 Node.js 脚本沙箱 |
| **Docker SDK** | 容器级 | 中 | 完整隔离，推荐用于 run_command |
| **nsjail** | 系统调用级 | 高 | Linux 专用，过度隔离 |

**推荐：Docker SDK（主方案）+ vm2（降级方案）**

#### 实施步骤

**Step 1.1：Docker 沙箱封装（3 天）**

```typescript
// src/tools/sandbox/DockerSandbox.ts
export interface SandboxConfig {
  image: string;           // 默认 node:20-alpine
  cpuLimit: string;        // '0.5' = 50% CPU
  memoryLimit: string;     // '256m' = 256MB
  timeoutMs: number;       // 默认 30000
  networkDisabled: boolean;// true = 禁止网络
  bindMounts: Array<{ host: string; container: string; readonly: boolean }>;
}

export class DockerSandbox {
  async execute(command: string, config?: Partial<SandboxConfig>): Promise<SandboxResult>;
  async cleanup(): Promise<void>;
}
```

- 集成 `dockerode` 库
- 创建专用沙箱镜像（基于 alpine，预装常用工具）
- 实现资源限制（cgroups v2）
- 实现超时自动终止

**Step 1.2：ToolExecutor 集成（1 天）**

```typescript
// ToolExecutor.ts 修改
private sandbox: DockerSandbox;

async execute(toolName: string, params: Record<string, unknown>): Promise<unknown> {
  if (toolName === 'run_command') {
    // 高优先级命令走沙箱
    if (this.isHighRisk(params.command as string)) {
      return this.sandbox.execute(params.command as string, {
        timeoutMs: 30000,
        memoryLimit: '256m',
        networkDisabled: true,
      });
    }
  }
  // ... 原有逻辑
}
```

**Step 1.3：安全策略配置（1 天）**

```typescript
// src/config/security.config.ts
export const SANDBOX_POLICY = {
  blockedCommands: ['rm -rf /', 'mkfs', 'dd if=/dev/zero'],
  allowedPaths: ['/tmp', '/workspace', process.cwd()],
  maxExecutionTime: 30000,
  maxMemoryMB: 256,
  maxOutputSize: 1024 * 1024, // 1MB
};
```

**Step 1.4：测试验证（1 天）**

- 危险命令拦截测试
- 资源限制测试（内存溢出、CPU 占满）
- 超时终止测试
- 文件系统隔离测试

#### 验收标准
- [ ] `rm -rf /` 被拦截并返回安全错误
- [ ] 内存超限命令被 OOM killer 终止
- [ ] 30 秒超时命令被强制终止
- [ ] 沙箱内文件修改不影响宿主机
- [ ] 压力测试：100 并发沙箱执行无泄漏

#### 时间估算：6 天

---

### 模块 2：搜索能力（P0）

#### 现状
- `search_code` 仅支持本地文件搜索
- 无 Web 搜索能力
- 无搜索引擎 API 集成

#### 目标
实现本地 + Web 双通道搜索。

#### 技术选型

| 搜索类型 | 方案 | 成本 | 备注 |
|---------|------|:----:|------|
| 本地代码 | `search_code` 增强 | 免费 | 已有基础 |
| Web 搜索 | **Serper.dev** (Google API) | $0.001/次 | 结构化 JSON 输出 |
| Web 搜索 | **Tavily** | 免费 tier | AI 优化搜索 |
| Web 搜索 | **DuckDuckGo** (无 API) | 免费 | 需爬虫，不稳定 |

**推荐：Tavily（主方案，免费 tier 足够）+ search_code 增强**

#### 实施步骤

**Step 2.1：search_code 增强（2 天）**

```typescript
// src/tools/SearchTool.ts 重构
export interface SearchOptions {
  scope: 'local' | 'web' | 'both';
  query: string;
  fileTypes?: string[];      // .ts, .js, .md
  maxResults?: number;       // 默认 10
  includeContent?: boolean;  // 是否返回匹配内容片段
}

export class SearchTool {
  async localSearch(options: SearchOptions): Promise<LocalSearchResult[]>;
  async webSearch(options: SearchOptions): Promise<WebSearchResult[]>;
  async hybridSearch(options: SearchOptions): Promise<SearchResult[]>; // 本地+Web合并排序
}
```

- 增强本地搜索：支持正则、AST 节点搜索、语义搜索（向量）
- 添加搜索结果排名（TF-IDF + 最近访问权重）

**Step 2.2：Web Search 集成（2 天）**

```typescript
// src/tools/WebSearchTool.ts
export class WebSearchTool {
  constructor(apiKey: string, provider: 'tavily' | 'serper');
  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  source: string;
}
```

- 集成 Tavily API（免费 tier 1000 次/月）
- 实现结果缓存（Redis/SQLite，TTL 1 小时）
- 添加搜索历史记录

**Step 2.3：SkillRegistry 注册（0.5 天）**

```typescript
// 注册为技能
skillRegistry.register({
  name: 'search',
  description: '本地代码搜索和 Web 信息检索',
  parameters: { query: 'string', scope: 'enum[local,web,both]' },
  handler: searchTool.hybridSearch.bind(searchTool),
});
```

**Step 2.4：测试验证（1 天）**

- 本地搜索：10 万文件索引 < 500ms
- Web 搜索：API 响应 < 2s
- 混合搜索：结果相关性排序正确

#### 验收标准
- [ ] `search_code` 支持语义搜索（向量匹配）
- [ ] Web 搜索返回结构化结果（标题/URL/摘要）
- [ ] 混合搜索优先返回本地结果，补充 Web 结果
- [ ] 搜索历史自动保存到 MemoryEngine
- [ ] API 错误时降级到本地搜索

#### 时间估算：5.5 天

---

### 模块 3：浏览器自动化（P2）

#### 现状
- 无浏览器自动化能力
- 秘书定位以本地开发为主，浏览器需求低

#### 目标
作为可选技能插件集成，不影响核心功能。

#### 技术选型

| 方案 | 体积 | 复杂度 | 备注 |
|------|:----:|:------:|------|
| **Puppeteer** | 大（Chromium ~150MB） | 中 | 功能最全 |
| **Playwright** | 大 | 中 | 多浏览器支持 |
| **puppeteer-core** | 小（无 Chromium） | 低 | 需外部 Chrome |

**推荐：puppeteer-core（可选依赖，不强制安装）**

#### 实施步骤

**Step 3.1：可选依赖封装（2 天）**

```typescript
// src/skills/BrowserSkill.ts
export class BrowserSkill implements Skill {
  private browser: import('puppeteer-core').Browser | null = null;

  async initialize(): Promise<void> {
    // 动态导入，失败不阻塞启动
    const puppeteer = await import('puppeteer-core').catch(() => null);
    if (!puppeteer) {
      Logger.warn('puppeteer-core 未安装，浏览器技能不可用');
      return;
    }
    // ... 初始化
  }

  async execute(params: {
    action: 'navigate' | 'screenshot' | 'extract' | 'click';
    url?: string;
    selector?: string;
  }): Promise<unknown>;
}
```

**Step 3.2：SkillRegistry 注册（0.5 天）**

```typescript
// 条件注册
if (await browserSkill.isAvailable()) {
  skillRegistry.register(browserSkill);
}
```

**Step 3.3：测试（0.5 天）**

- 截图功能测试
- 网页内容提取测试
- 未安装 puppeteer 时优雅降级

#### 验收标准
- [ ] 作为可选依赖，不安装不影响系统启动
- [ ] 支持网页截图、内容提取、简单点击
- [ ] 未安装时 SkillRegistry 自动跳过

#### 时间估算：3 天

---

### 模块 4：开放 Skill API（P1）

#### 现状
- SkillRegistry 仅内部使用
- 无外部技能注册机制
- 无技能市场概念

#### 目标
实现安全的第三方技能注册与执行。

#### 技术选型

| 方案 | 安全性 | 灵活性 | 备注 |
|------|:------:|:------:|------|
| **HTTP Webhook** | 中 | 高 | 技能作为外部服务 |
| **JavaScript 沙箱** | 高 | 中 | vm2 隔离执行 |
| **WASM 插件** | 高 | 低 | 过度复杂 |

**推荐：HTTP Webhook（主方案）+ JavaScript 沙箱（本地技能）**

#### 实施步骤

**Step 4.1：技能接口标准化（2 天）**

```typescript
// src/skills/SkillInterface.ts
export interface ExternalSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  endpoint?: string;        // Webhook URL
  localCode?: string;       // 沙箱执行代码
  permissions: SkillPermission[];
  parameters: SkillParameter[];
}

export interface SkillPermission {
  resource: 'file' | 'network' | 'command' | 'memory';
  actions: ('read' | 'write' | 'execute')[];
}
```

**Step 4.2：REST API 端点（2 天）**

```typescript
// src/server/index.ts 新增
app.post('/api/skills/register', authMiddleware, validateSkill, async (req, res) => {
  const skill: ExternalSkill = req.body;
  // 安全验证
  const validation = await securityValidator.validateSkill(skill);
  if (!validation.passed) {
    return res.status(400).json({ error: validation.errors });
  }
  // 注册
  await skillRegistry.registerExternal(skill);
  res.json({ success: true, skillId: skill.id });
});

app.get('/api/skills', authMiddleware, async (req, res) => {
  res.json(skillRegistry.getAllSkillMeta());
});

app.delete('/api/skills/:id', authMiddleware, async (req, res) => {
  await skillRegistry.unregister(req.params.id);
  res.json({ success: true });
});
```

**Step 4.3：安全验证机制（2 天）**

```typescript
// src/security/SkillValidator.ts
export class SkillValidator {
  async validateSkill(skill: ExternalSkill): Promise<ValidationResult> {
    // 1. 代码静态分析（本地技能）
    // 2. 权限审查（禁止 file:write + network 组合）
    // 3. 端点可达性检查（Webhook 技能）
    // 4. 签名验证（可选）
  }
}
```

**Step 4.4：权限控制（1 天）**

```typescript
// 执行时权限检查
async executeExternalSkill(skillId: string, params: unknown): Promise<unknown> {
  const skill = skillRegistry.get(skillId);
  if (!skill) throw new Error('Skill not found');

  // 检查权限
  if (skill.permissions.includes('file:write')) {
    await auditLogger.log({ action: 'skill_file_write', skillId, params });
  }

  if (skill.endpoint) {
    return this.executeWebhook(skill, params);
  } else if (skill.localCode) {
    return this.executeSandbox(skill, params);
  }
}
```

**Step 4.5：测试（1 天）**

- 注册/注销/列表 API 测试
- 权限越界拦截测试
- Webhook 超时处理测试
- 沙箱代码逃逸测试

#### 验收标准
- [ ] `POST /api/skills/register` 支持 Webhook 和本地代码两种模式
- [ ] 权限组合审查（禁止危险组合如 file:write + network）
- [ ] 本地代码在 vm2 沙箱中执行
- [ ] Webhook 调用超时 10s 自动失败
- [ ] 技能执行日志完整审计

#### 时间估算：8 天

---

### 模块 5：多模态视觉（P2）

#### 现状
- `EnvironmentPerceptionEngine` 框架存在
- 无实际图像处理管线
- LLM 已支持多模态（qwen2.5-vl）

#### 目标
依赖 LLM 自带多模态能力，不做独立视觉模块。

#### 实施步骤

**Step 5.1：图像输入适配（1 天）**

```typescript
// src/multimodal/MultimodalInput.ts 扩展
export interface MultimodalInputData {
  text?: string;
  image?: Buffer | string;  // base64 或文件路径
  audio?: Buffer;
  metadata?: {
    source: 'camera' | 'upload' | 'clipboard';
    timestamp: number;
  };
}
```

**Step 5.2：LLMProvider 多模态支持（1 天）**

```typescript
// src/models/LLMProvider.ts
async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
  // 检测消息中是否包含图像
  const hasImage = messages.some(m => m.image);
  if (hasImage) {
    // 使用多模态模型端点
    return this.multimodalChat(messages, options);
  }
  return this.textChat(messages, options);
}
```

**Step 5.3：前端图像上传（1 天）**

```typescript
// ChatInterface.tsx 添加图像上传
<input type="file" accept="image/*" onChange={handleImageUpload} />
```

#### 验收标准
- [ ] 支持上传图片作为输入
- [ ] LLM 能描述图片内容
- [ ] 不引入额外视觉模型依赖

#### 时间估算：3 天

---

### 模块 6：拟人交互重构（P1）

#### 现状
- `PersonaRules.ts` 是硬编码的 if-else 门控
- `InteractionEngine` 仅基础对话管理
- `DialogueManager` 无上下文记忆
- 情感分析（`EmotionAnalyzer`）存在但未深度集成

#### 目标
将 PersonaRules 从硬门控改为场景感知自适应。

#### 实施步骤

**Step 6.1：PersonaCore 场景感知引擎（3 天）**

```typescript
// src/persona/PersonaCore.ts 重构
export class PersonaCore {
  private sceneWeights: Map<PersonaScene, number> = new Map();

  async adaptTone(input: string, context: PersonaContext): Promise<ToneProfile> {
    // 1. 场景识别（工作/会议/驾驶/休闲）
    const scene = await this.sceneRecognizer.recognize(input, context);
    // 2. 情绪检测
    const emotion = await this.emotionAnalyzer.analyze(input);
    // 3. 用户画像加载
    const profile = await this.memoryEngine.getUserProfile(context.userId);
    // 4. 动态生成 tone 配置
    return this.generateToneProfile(scene, emotion, profile);
  }

  private generateToneProfile(
    scene: PersonaScene,
    emotion: EmotionResult,
    profile: UserProfile
  ): ToneProfile {
    const baseTone = this.getSceneBaseTone(scene);
    const emotionAdjustment = this.getEmotionAdjustment(emotion);
    const userPreference = this.getUserTonePreference(profile);

    return {
      formality: this.blend(baseTone.formality, emotionAdjustment.formality, userPreference.formality),
      warmth: this.blend(baseTone.warmth, emotionAdjustment.warmth, userPreference.warmth),
      verbosity: this.blend(baseTone.verbosity, emotionAdjustment.verbosity, userPreference.verbosity),
      emojiUsage: scene === 'work' ? 0.1 : 0.3,
    };
  }
}
```

**Step 6.2：对话上下文管理（2 天）**

```typescript
// src/interaction/DialogueManager.ts 重构
export class DialogueManager {
  private contextWindow: Map<string, DialogueContext> = new Map();

  async buildContext(userId: string, currentInput: string): Promise<DialogueContext> {
    // 1. 加载最近 10 轮对话
    const recentHistory = await this.memoryEngine.retrieveRecent(userId, 10);
    // 2. 提取对话主题
    const topics = this.extractTopics(recentHistory);
    // 3. 检测话题切换
    const topicShift = this.detectTopicShift(currentInput, topics);
    // 4. 构建上下文摘要
    return {
      history: recentHistory,
      topics,
      topicShift,
      userMood: await this.emotionAnalyzer.analyze(currentInput),
      pendingQuestions: this.extractPendingQuestions(recentHistory),
    };
  }
}
```

**Step 6.3：情感分析深度集成（2 天）**

```typescript
// src/multimodal/EmotionAnalyzer.ts 增强
export class EmotionAnalyzer {
  async analyze(input: string, history?: string[]): Promise<EmotionResult> {
    // 1. 基于规则快速检测
    const ruleBased = this.ruleBasedDetect(input);
    // 2. LLM 深度分析（复杂情绪）
    const llmBased = await this.llmAnalyze(input, history);
    // 3. 情绪趋势计算
    const trend = this.calculateTrend(history);

    return {
      primary: llmBased.primary || ruleBased.primary,
      intensity: llmBased.intensity,
      trend, // improving / stable / declining
      suggestedResponse: this.getResponseStrategy(llmBased, trend),
    };
  }
}
```

**Step 6.4：测试验证（1 天）**

- 场景切换时语气变化测试
- 情绪检测准确率 > 80%
- 对话上下文连贯性测试

#### 验收标准
- [ ] 工作场景语气正式、简洁
- [ ] 休闲场景语气温暖、可使用 emoji
- [ ] 检测到用户烦躁时自动安抚
- [ ] 对话上下文保持 10 轮连贯
- [ ] 话题切换时自然过渡

#### 时间估算：8 天

---

### 模块 7：多模态融合优化（P2）

#### 现状
- `SceneRecognizer`：基础场景识别
- `EmotionAnalyzer`：基础情绪分析
- `EnvironmentPerceptionEngine`：框架存在
- 无语音/视频处理管线

#### 目标
优化现有功能，语音作为可选扩展。

#### 实施步骤

**Step 7.1：场景识别增强（2 天）**

```typescript
// src/multimodal/SceneRecognizer.ts
export class SceneRecognizer {
  async recognize(input: string, context: ContextData): Promise<SceneResult> {
    // 1. 关键词匹配（快速）
    const keywordScene = this.keywordMatch(input);
    // 2. 语义分析（LLM）
    const semanticScene = await this.semanticAnalyze(input);
    // 3. 时间上下文（早晨/深夜）
    const temporalScene = this.getTemporalContext();
    // 4. 历史模式（用户习惯）
    const historicalScene = await this.getHistoricalPattern(context.userId);

    return this.weightedFusion([keywordScene, semanticScene, temporalScene, historicalScene]);
  }
}
```

**Step 7.2：语音处理（可选）（2 天）**

```typescript
// src/multimodal/SpeechProcessor.ts（可选依赖）
export class SpeechProcessor {
  async transcribe(audioBuffer: Buffer): Promise<string> {
    // 集成 Whisper API 或本地 whisper.cpp
    const whisper = await import('whisper-node').catch(() => null);
    if (!whisper) return '[语音转文字服务不可用]';
    return whisper.transcribe(audioBuffer);
  }

  async synthesize(text: string): Promise<Buffer> {
    // 集成 Edge TTS 或本地 TTS
    return this.ttsEngine.synthesize(text);
  }
}
```

**Step 7.3：环境感知增强（1 天）**

```typescript
// src/multimodal/EnvironmentPerceptionEngine.ts
export class EnvironmentPerceptionEngine {
  async perceive(): Promise<EnvironmentState> {
    return {
      timeOfDay: this.getTimeOfDay(),
      dayOfWeek: this.getDayOfWeek(),
      userActive: await this.detectUserActivity(),
      systemLoad: this.getSystemLoad(),
      upcomingEvents: await this.getCalendarEvents(),
    };
  }
}
```

#### 验收标准
- [ ] 场景识别准确率 > 85%
- [ ] 语音转文字作为可选功能
- [ ] 环境感知包含时间/日程/系统负载

#### 时间估算：5 天

---

### 模块 8：硬件接入（P3）

#### 现状
- `src/hardware/` 仅有接口定义
- `AudioVideoDeviceAccess.ts` 空实现
- `DeviceManager.ts` 空实现

#### 目标
实现核心硬件（音频输入/输出）接入。

#### 实施步骤

**Step 8.1：音频设备接入（2 天）**

```typescript
// src/hardware/AudioVideoDeviceAccess.ts
export class AudioDeviceAccess {
  async listInputDevices(): Promise<AudioDevice[]>;
  async startRecording(deviceId?: string): Promise<ReadableStream>;
  async stopRecording(): Promise<Buffer>;
  async playAudio(audioBuffer: Buffer, deviceId?: string): Promise<void>;
}
```

- 集成 `node-record-lpcm16`（录音）
- 集成 `speaker`（播放）

**Step 8.2：设备管理器（1 天）**

```typescript
// src/hardware/DeviceManager.ts
export class DeviceManager {
  private devices: Map<string, Device> = new Map();

  async scanDevices(): Promise<Device[]>;
  async getDeviceStatus(deviceId: string): Promise<DeviceStatus>;
  async registerDevice(device: Device): Promise<void>;
}
```

**Step 8.3：智能家居（占位）（1 天）**

```typescript
// src/hardware/LocalDeviceAccess.ts
export class LocalDeviceAccess {
  // 预留 HomeKit/Matter 接口
  async discoverHomeKitDevices(): Promise<HomeKitDevice[]>;
  async controlDevice(deviceId: string, command: DeviceCommand): Promise<void>;
}
```

#### 验收标准
- [ ] 列出系统音频输入/输出设备
- [ ] 录制音频并保存
- [ ] 播放音频文件
- [ ] 智能家居接口预留

#### 时间估算：4 天

---

## 三、实施优先级与时间线

### 优先级矩阵

```
        高影响
           │
    P0     │   P1
  沙箱执行 │  开放Skill API
  搜索能力 │  拟人交互重构
           │
  ─────────┼─────────
           │
    P2     │   P3
  浏览器   │  硬件接入
  多模态   │
  多模融合 │
           │
        低影响
```

### 时间线（总计 42.5 天 ≈ 8.5 周）

| 阶段 | 模块 | 时间 | 累计 |
|------|------|:----:|:----:|
| **Phase A（P0）** | 沙箱执行 + 搜索能力 | 11.5 天 | 11.5 天 |
| **Phase B（P1）** | 开放 Skill API + 拟人交互 | 16 天 | 27.5 天 |
| **Phase C（P2）** | 浏览器 + 多模态 + 多模融合 | 11 天 | 38.5 天 |
| **Phase D（P3）** | 硬件接入 | 4 天 | 42.5 天 |

### 并行策略

- **Week 1-2**：沙箱执行（后端）+ 搜索能力（后端）并行
- **Week 3-4**：开放 Skill API（后端）+ 拟人交互（核心）并行
- **Week 5**：浏览器自动化（可选）+ 多模态视觉（前端）并行
- **Week 6**：多模态融合优化 + 硬件接入
- **Week 7-8**：集成测试 + README 更新

---

## 四、README.md 更新计划

### 新增章节

1. **系统改进路线图** — 8 模块改进状态跟踪
2. **安全执行** — Docker 沙箱说明
3. **搜索能力** — 本地 + Web 搜索使用指南
4. **开放技能** — 第三方技能注册文档
5. **拟人交互** — 场景感知语气说明

### 修正章节

| 原描述 | 修正为 |
|--------|--------|
| "工具执行：部分" | "工具执行：完整（14 工具），沙箱执行开发中" |
| "主动循环：内容待充实" | "主动循环：完整（6 路主动事件 + AgentLoop 闭环）" |
| "记忆深度：仅存对话记录" | "记忆深度：三层记忆 + 画像 + 偏好注入 + 进化" |
| "LLM 对话生成：初始化需增强" | 移除 — 已完整 |

---

## 五、风险与应对

| 风险 | 影响 | 应对 |
|------|:----:|------|
| Docker 沙箱 Windows 兼容性 | 高 | 提供 WSL2 方案 + vm2 降级 |
| Tavily API 免费额度耗尽 | 中 | 实现多 provider 切换（Serper 备用）|
| Puppeteer 体积过大 | 低 | 使用 puppeteer-core，不强制安装 |
| vm2 安全漏洞 | 中 | 定期更新，监控 CVE |
| 拟人交互重构回归 | 中 | 保留旧 PersonaRules 作为 fallback |

---

## 六、验收总标准

- [ ] **P0 完成**：沙箱执行拦截危险命令 + 搜索支持本地+Web
- [ ] **P1 完成**：Skill API 开放 + PersonaRules 场景感知
- [ ] **P2 完成**：浏览器可选 + 多模态图像输入
- [ ] **P3 完成**：音频设备接入
- [ ] **全量测试通过**：npx tsc 零错误 + jest 全部通过 + 压力测试无回归
- [ ] **README 更新**：反映最新功能状态
