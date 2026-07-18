# 桌面执行Agent架构升级 - Codex风格 Computer Use

> 升级日期: 2026-06-23
> 版本: v2.1
> 参考: Codex Computer Use / UI-TARS / Anthropic Claude Computer Use

---

## 〇、五感与手脚 — 核心原则

> 五感（视觉/听觉）与手脚（桌面/浏览器操作）能力统一注册为 Tool，
> 由 ToolRegistry 调度，LLM 在推理循环中自主决定何时感知、何时执行。

### 五条原则

| #   | 原则                             | 说明                                                                                         |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **所有五感/手脚能力都是 Tool**   | 注册到 ToolRegistry，由 Executor 统一调度，不创建独立入口                                    |
| 2   | **不创建独立子系统**             | ~~PerceptionHub/ActionHub~~ 取消，ToolRegistry 已是统一调度层                                |
| 3   | **新增 ToolCategory.PERCEPTION** | 感知类工具（screen_parse / speech_transcribe / action_verify / smart_wait）归类到 PERCEPTION |
| 4   | **复用现有 Toolset 机制**        | Desktop 工具集自动包含 DESKTOP + PERCEPTION 工具，无需额外配置                               |
| 5   | **LLM 自主决定何时感知/执行**    | 不需要额外的"感知调度层"，LLM 在推理循环中自然决定何时截图、何时点击                         |

### 工具全景（去重后 77 个）

| 类别           | 工具                                                                        | 说明                                                 |
| -------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| **PERCEPTION** | `screen_parse`                                                              | 可交互元素检测 + Set-of-Mark 标注                    |
|                | `action_verify`                                                             | 操作后截图验证（像素差异/OCR/VLM）                   |
|                | `smart_wait`                                                                | 智能等待（change/stable/selector 三模式）            |
|                | `speech_transcribe`                                                         | 语音转文字（faster-whisper STT）                     |
| **DESKTOP**    | `desktop_automate`                                                          | 桌面自动化（支持归一化坐标）                         |
|                | `desktop_screenshot`                                                        | 桌面截图                                             |
|                | `desktop_window`                                                            | 窗口管理                                             |
|                | `desktop_clipboard`                                                         | 剪贴板读写                                           |
| **BROWSER**    | `browser_fill_form`                                                         | 语义化表单填写（新增）                               |
|                | `browser_agent` / `navigate` / `click` / `type` / `screenshot` / `get_text` | 浏览器操作                                           |
| **VISION**     | `vision_understand`                                                         | Vision 模型理解图片（替代 ~~image_understand~~）     |
| **VOICE**      | `voice_interact`                                                            | 语音交互（speak/listen/session，替代 ~~tts_speak~~） |
| **SHELL**      | `shell_exec`                                                                | Shell 命令执行（替代 ~~desktop_shell~~）             |

### 已去除的重复工具

| 已移除             | 合并到                             | 原因                                             |
| ------------------ | ---------------------------------- | ------------------------------------------------ |
| `desktop_shell`    | `shell_exec` (code_tools)          | 功能完全重叠，统一入口                           |
| `image_understand` | `vision_understand` (vision_tools) | 功能完全重叠，vision_tools 实现更完整            |
| `tts_speak`        | `voice_interact` (system_tools)    | voice_interact 包含 speak+listen+session，是超集 |

---

## 一、升级概述

将 jiabaixing 的桌面自动化模块从"基础操作工具"升级为**Codex风格的放手式执行Agent**。

### 核心变化

| 维度     | v1.x (旧版)    | v2.0 (Codex风格)            | v2.1 (五感+手脚)                                              |
| -------- | -------------- | --------------------------- | ------------------------------------------------------------- |
| 定位     | 桌面操作工具集 | 放手式执行Agent             | 放手式执行Agent + 感知闭环                                    |
| 交互     | 逐步指令       | 一句话任务委派              | 一句话任务委派 + 自动验证                                     |
| 坐标系统 | 像素坐标       | 归一化坐标 [0-1000]         | 归一化坐标 [0-1000]（TS+Python双端对齐）                      |
| 工具接口 | 内部函数调用   | 标准 MCP 协议               | ToolRegistry + MCP 双通道                                     |
| 可观测性 | 日志输出       | 实时事件流 + 可视化         | 实时事件流 + 操作验证                                         |
| 安全性   | 基础黑名单     | 四层安全防护体系            | 四层安全防护体系                                              |
| 任务执行 | 单步执行       | 技能包 + LLM规划 + 闭环验证 | 技能包 + LLM规划 + 感知验证闭环                               |
| 感知能力 | 无             | 无                          | screen_parse / action_verify / smart_wait / speech_transcribe |
| 表单填写 | 无             | 无                          | browser_fill_form（语义化匹配）                               |

---

## 二、新增核心模块

### 2.1 归一化坐标系统 (NormalizedCoordinates)

**文件**: `src/desktop/NormalizedCoordinates.ts`

参考 UI-TARS 设计，所有坐标统一使用 `[0, 1000] × [0, 1000]` 归一化值。

**为什么重要？**

- VLM 输出的坐标直接可用，无需转换
- 自动适配不同分辨率屏幕
- 跨设备一致性
- 技能包可复用

**使用示例：**

```typescript
import { toPixel, toNormalized, coords } from './desktop';

// 归一化 → 像素
const pixel = toPixel(500, 500); // 屏幕中心
// → { x: 960, y: 540 } (1920x1080屏幕)

// 像素 → 归一化
const normalized = toNormalized(960, 540);
// → { x: 500, y: 500 }

// 获取屏幕信息
const size = coords.getPixelScreenSize();
```

---

### 2.2 桌面 MCP 服务器 (DesktopMCPServer)

**文件**: `src/desktop/DesktopMCPServer.ts`

将所有桌面操作能力封装为标准 **MCP (Model Context Protocol)** 工具。

**支持的 15 个标准工具：**

| 工具名            | 功能         | 参数                                  |
| ----------------- | ------------ | ------------------------------------- |
| `screenshot`      | 截图         | monitor?                              |
| `click`           | 点击         | x, y, button?, clicks?                |
| `double_click`    | 双击         | x, y                                  |
| `type`            | 输入文字     | text                                  |
| `key`             | 按键         | key                                   |
| `key_combo`       | 组合键       | keys[]                                |
| `scroll`          | 滚动         | delta, x?, y?                         |
| `drag`            | 拖拽         | from_x, from_y, to_x, to_y, duration? |
| `get_windows`     | 获取窗口列表 | -                                     |
| `activate_window` | 激活窗口     | title                                 |
| `open_app`        | 打开应用     | app, args?                            |
| `wait`            | 等待         | ms?                                   |
| `get_clipboard`   | 获取剪贴板   | -                                     |
| `set_clipboard`   | 设置剪贴板   | text                                  |
| `get_screen_size` | 获取屏幕尺寸 | -                                     |

**使用示例：**

```typescript
import { DesktopMCPServer } from './desktop';

const mcp = DesktopMCPServer.getInstance();
await mcp.initialize();

// 列出所有工具
const tools = mcp.listTools();

// 调用工具
const result = await mcp.callTool('click', { x: 500, y: 500 });
// → { content: [...], isError: false }
```

---

### 2.3 事件流系统 (DesktopEventStream)

**文件**: `src/desktop/DesktopEventStream.ts`

参考 UI-TARS Event Stream 设计，实现"所见即所得"的实时监控。

**事件类型：**

- `task_start` / `task_end` - 任务开始/结束
- `observation` - 观察结果（截图）
- `planning` - 规划中
- `action_start` / `action_end` - 动作执行
- `action_error` - 动作错误
- `retry` - 重试
- `checkpoint` - 检查点
- `status_change` - 状态变化
- `safety_warning` - 安全警告
- `user_intervention_required` - 需要用户干预

**使用示例：**

```typescript
import { DesktopEventStream } from './desktop';

const stream = DesktopEventStream.getInstance();

// 订阅事件
const unsubscribe = stream.subscribe((event) => {
  console.log(`[${event.type}]`, event.data);
});

// 开始任务
const taskId = stream.startTask('打开浏览器搜索');

// 发送事件
stream.emitObservation(screenshotBase64, 1920, 1080);
stream.emitActionStart('click', '点击搜索按钮', { x: 500, y: 300 });

// 获取历史
const history = stream.getHistory(100); // 最近100条

// 导出
const json = stream.exportEvents(taskId);
```

---

### 2.4 安全防护系统 (DesktopSafetyGuard)

**文件**: `src/desktop/DesktopSafetyGuard.ts`

四层安全防护体系，参考 Codex Computer Use 安全设计。

#### 安全层级

| 层级         | 防护方式        | 说明                          |
| ------------ | --------------- | ----------------------------- |
| **事前拦截** | 危险操作黑名单  | 10+ 类危险操作自动识别        |
| **事中监控** | 频率限制 + 超时 | 每分钟最大操作数、任务超时    |
| **紧急停止** | 键盘 + 鼠标角   | ESC键、鼠标移到左上角立即停止 |
| **事后回滚** | 检查点恢复      | StateSnapshotManager 状态快照 |

#### 危险操作黑名单

- 系统关机/重启
- 删除系统目录 (rm -rf /, C:\Windows)
- 格式化磁盘
- 修改系统注册表
- 终止系统关键进程 (svchost, explorer)
- 修改防火墙规则
- 用户账户管理操作
- 磁盘分区/启动配置修改

#### 安全级别

| 级别         | 说明                         | 适用场景           |
| ------------ | ---------------------------- | ------------------ |
| `strict`     | 严格模式，所有危险操作都拦截 | 生产环境、敏感操作 |
| `moderate`   | 中等，危险操作需确认         | 默认模式           |
| `permissive` | 宽松，仅拦截最危险操作       | 测试环境、信任场景 |

**使用示例：**

```typescript
import { DesktopSafetyGuard } from './desktop';

const guard = DesktopSafetyGuard.getInstance({
  level: 'moderate',
  maxActionsPerMinute: 60,
  taskTimeoutMs: 300000, // 5分钟
});

await guard.initialize();

// 检查操作
const check = guard.checkAction('shell', '执行命令', { command: 'rm -rf /' });
// → { allowed: false, reason: '危险操作已拦截: 删除系统目录', severity: 'critical' }

// 紧急停止回调
guard.onEmergencyStop(() => {
  console.log('🚨 紧急停止！');
});

// 手动触发紧急停止
guard.emergencyStop('用户按下停止按钮');
```

---

### 2.5 技能包系统 (DesktopSkillRegistry)

**文件**: `src/desktop/DesktopSkillRegistry.ts`

预定义复杂任务模板，让Agent更快、更稳定地完成常见任务。

#### 技能结构

每个技能包含：

- **匹配规则** - 关键词 + 正则模式
- **参数定义** - 输入参数 schema
- **步骤生成器** - 根据参数生成执行步骤
- **错误恢复** - 失败时的重试/回退策略
- **验证逻辑** - 任务完成验证

#### 内置技能

| 技能ID            | 名称         | 分类     | 说明                     |
| ----------------- | ------------ | -------- | ------------------------ |
| `browser.search`  | 浏览器搜索   | 浏览器   | 打开浏览器并搜索指定内容 |
| `notepad.write`   | 记事本写内容 | 办公     | 打开记事本并输入文本     |
| `screenshot.full` | 全屏截图     | 工具     | 截取当前全屏并保存       |
| `window.maximize` | 最大化窗口   | 窗口管理 | 最大化当前或指定窗口     |

**使用示例：**

```typescript
import { DesktopSkillRegistry } from './desktop';

const registry = DesktopSkillRegistry.getInstance();

// 匹配技能
const match = registry.matchSkill('帮我搜索一下天气');
// → { skill: browser.search, confidence: 85, extractedParams: { query: '天气' } }

// 执行技能
const result = await registry.executeSkill(
  'browser.search',
  { query: '天气' },
  async (step) => {
    // 执行每个步骤...
    return true;
  }
);
// → { success: true, stepsCompleted: 7, totalSteps: 7, durationMs: 8500 }

// 自定义技能
registry.registerSkill({
  id: 'custom.my_skill',
  name: '我的自定义技能',
  category: '自定义',
  version: '1.0.0',
  matchRules: {
    keywords: ['自定义', '我的技能'],
    patterns: [],
    priority: 50,
  },
  parameters: [],
  generateSteps: () => [
    /* 步骤 */
  ],
  riskLevel: 'low',
});
```

---

### 2.6 桌面执行Agent (DesktopExecutionAgent)

**文件**: `src/desktop/DesktopExecutionAgent.ts`

主入口，整合所有模块，提供统一的任务执行接口。

#### 执行策略

1. **技能匹配优先** - 先尝试匹配预置技能（快、稳）
2. **LLM规划兜底** - 没匹配到技能时，用LLM动态规划（灵活）
3. **基础模式降级** - LLM不可用时，降级为基础操作

#### 工作流程

```
用户输入
    ↓
┌─────────────────┐
│  安全检查        │
└─────────────────┘
    ↓
┌─────────────────┐
│  技能匹配？      │─ 是 → 执行技能步骤
└─────────────────┘        ↓
    ↓ 否              每步: 安全检查 → 执行 → 验证
┌─────────────────┐
│  LLM可用？       │─ 是 → LLM规划循环
└─────────────────┘        ↓
    ↓ 否              观察 → 决策 → 执行 → 验证 → 循环
┌─────────────────┐
│  基础模式        │
└─────────────────┘
    ↓
  结果汇报
```

**使用示例：**

```typescript
import { DesktopExecutionAgent } from './desktop';

const agent = DesktopExecutionAgent.getInstance({
  safetyLevel: 'moderate',
  enableSkills: true,
  enableLLMPlanning: true,
  maxSteps: 50,
});

// 初始化
await agent.initialize();

// 执行任务（一句话委派）
const result = await agent.executeTask('帮我打开浏览器搜索今天的天气');

console.log(result.success ? '任务完成！' : '任务失败');
console.log(`执行了 ${result.stepsCompleted} 步`);
console.log(`耗时 ${result.durationMs / 1000} 秒`);
if (result.usedSkill) {
  console.log(`使用技能: ${result.usedSkill}`);
}

// 实时监控
agent.getEventStream().subscribe((event) => {
  if (event.type === 'action_start') {
    console.log(`▶️  ${event.data.description}`);
  }
});

// 紧急停止
agent.stop('用户要求停止');
```

---

## 三、架构对比

### 旧架构 (v1.x)

```
用户输入 → DesktopAgentLoop
    ↓
  观察 → 决策 → 执行 → 验证
    ↓
  结果
```

### 新架构 (v2.0 Codex风格)

```
用户输入
    ↓
┌─────────────────────────────────────┐
│      DesktopExecutionAgent          │  ← 主入口
├─────────────────────────────────────┤
│  ┌──────────┐  ┌────────────────┐  │
│  │ 安全防护  │  │   技能匹配器    │  │
│  └──────────┘  └────────────────┘  │
│         ↓               ↓          │
│  ┌──────────────────────────────┐  │
│  │        MCP 工具层             │  │  ← 标准协议
│  │  screenshot / click / type... │  │
│  └──────────────────────────────┘  │
│                ↓                   │
│  ┌──────────────────────────────┐  │
│  │        事件流系统             │  │  ← 实时可观测
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
    ↓
  执行结果 + 完整轨迹
```

---

## 四、快速开始

### 4.1 最简使用

```typescript
import { executionAgent } from './desktop';

// 1. 初始化（只需一次）
await executionAgent.initialize();

// 2. 一句话委派任务
const result = await executionAgent.executeTask('帮我打开记事本写点东西');

// 3. 查看结果
console.log(result.report);
```

### 4.2 自定义配置

```typescript
import { DesktopExecutionAgent } from './desktop';

const agent = DesktopExecutionAgent.getInstance({
  safetyLevel: 'strict', // 严格安全模式
  enableSkills: true, // 启用技能包
  enableLLMPlanning: true, // 启用LLM规划
  maxSteps: 100, // 最大步数
  autoVerify: true, // 每步自动验证
});
```

### 4.3 实时监控

```typescript
import { executionAgent } from './desktop';

const stream = executionAgent.getEventStream();

stream.subscribe((event) => {
  switch (event.type) {
    case 'task_start':
      console.log('🎯 任务开始:', event.data.description);
      break;
    case 'action_start':
      console.log('▶️ ', event.data.description);
      break;
    case 'action_end':
      console.log(event.data.success ? '✅' : '❌', event.data.description);
      break;
    case 'task_end':
      console.log('🏁 任务结束:', event.data.result);
      break;
  }
});
```

### 4.4 添加自定义技能

```typescript
import { skillRegistry } from './desktop';

skillRegistry.registerSkill({
  id: 'myapp.open',
  name: '打开我的应用',
  description: '打开我常用的应用',
  category: '自定义',
  version: '1.0.0',
  matchRules: {
    keywords: ['打开我的应用', '我的应用'],
    patterns: [/打开我的应用/],
    priority: 80,
  },
  parameters: [],
  generateSteps: () => [
    {
      id: 'open',
      type: 'action',
      description: '打开我的应用',
      action: { type: 'openApp', params: { app: 'myapp.exe' } },
    },
    {
      id: 'wait',
      type: 'wait',
      description: '等待启动',
      wait: { durationMs: 2000 },
    },
  ],
  riskLevel: 'low',
  estimatedTime: 3,
});
```

---

## 五、最佳实践

### 5.1 安全第一

- 生产环境使用 `strict` 安全级别
- 敏感操作前务必确认
- 始终设置任务超时
- 保留紧急停止的物理方式

### 5.2 技能优先

- 常用任务尽量做成技能包
- 技能比LLM规划更稳定、更快
- 技能可以精确控制每一步

### 5.3 事件驱动

- 使用事件流做UI展示
- 用事件流做审计日志
- 用事件流做问题排查

### 5.4 渐进式放手

1. 先从简单任务开始（截图、打开应用）
2. 观察Agent的执行过程
3. 逐步增加任务复杂度
4. 确认安全后再完全放手

---

## 六、五感与手脚 — 实现审计

### 6.1 归一化坐标系统 ✅ 已完成

| 端     | 文件                                        | 状态      | 完成度                                                                              |
| ------ | ------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| TS     | `src/desktop/NormalizedCoordinates.ts`      | ✅ 已完成 | 100% — 单例模式，自动获取屏幕分辨率，支持 Electron/Node.js 双环境                   |
| Python | `python/agent/desktop/coordinate_system.py` | ✅ 已完成 | 100% — NormalizedPoint/NormalizedRect + from_normalized/to_normalized，与 TS 端对齐 |

**集成点**: `desktop_automate` 工具的 `coordinate_mode=normalized` 参数，自动将 task 文本中的 `(x,y)` 坐标从归一化转换为像素。

### 6.2 感知工具（PERCEPTION）✅ 已完成

| 工具                | 文件                                     | 实现程度 | 说明                                                                                                                                    |
| ------------------- | ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `screen_parse`      | `python/agent/tools/perception_tools.py` | ✅ 90%   | 桌面端：Windows UI Automation + macOS Accessibility + OCR 三级降级；浏览器端：DOM 提取；Set-of-Mark 标注。**待完善**：GPU 加速视觉检测  |
| `action_verify`     | `python/agent/tools/perception_tools.py` | ✅ 90%   | 像素差异 + OCR 文字对比 + VLM 判断三策略（auto 自动选择）；区域裁剪支持归一化坐标。**待完善**：VLM 双图对比（当前仅发送操作后截图）     |
| `smart_wait`        | `python/agent/tools/perception_tools.py` | ✅ 95%   | change/stable/selector 三模式；selector 模式优先复用已有浏览器会话；感知哈希变化检测。**待完善**：多显示器场景                          |
| `speech_transcribe` | `python/agent/tools/perception_tools.py` | ✅ 90%   | faster-whisper 集成；GPU 自动检测（torch.cuda/ctranslate2）；流式输出（逐段时间戳）；VAD 过滤；模型缓存。**待完善**：实时麦克风流式转录 |

### 6.3 手脚工具（DESKTOP/BROWSER）

| 工具                 | 文件                                  | 实现程度 | 说明                                                                                                                                      |
| -------------------- | ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop_automate`   | `python/agent/tools/desktop_tools.py` | ✅ 95%   | 归一化坐标支持（结构化转换：2点/4点矩形）；TS DesktopExecutionAgent 优先 + Python 降级                                                    |
| `desktop_screenshot` | `python/agent/tools/desktop_tools.py` | ✅ 95%   | 全屏/区域截图已实现                                                                                                                       |
| `desktop_window`     | `python/agent/tools/desktop_tools.py` | ✅ 90%   | 窗口列表/激活/最大化/最小化/关闭已实现                                                                                                    |
| `desktop_clipboard`  | `python/agent/tools/desktop_tools.py` | ✅ 95%   | 读写剪贴板已实现                                                                                                                          |
| `browser_fill_form`  | `python/agent/tools/browser_tools.py` | ✅ 85%   | 语义化匹配五策略（label/placeholder/name/aria-label/类型推断）；iframe 内表单支持；动态加载等待；自动提交。**待完善**：CAPTCHA 处理       |
| `browser_agent`      | `python/agent/tools/browser_tools.py` | ✅ 85%   | Playwright 自动化已实现                                                                                                                   |
| `vision_understand`  | `python/agent/tools/vision_tools.py`  | ✅ 85%   | GPT-4o/Claude Vision 已集成；跨模态记忆写入已实现                                                                                         |
| `voice_interact`     | `python/agent/tools/system_tools.py`  | ✅ 85%   | speak: edge-tts → pyttsx3 → macOS say → 模拟四级降级；listen: 对接 speech_transcribe 真实 STT；voice 角色选择。**待完善**：实时麦克风录音 |
| `shell_exec`         | `python/agent/tools/code_tools.py`    | ✅ 95%   | 命令执行 + 安全检查已实现                                                                                                                 |

### 6.4 注册与调度

| 组件                      | 文件                                                      | 状态                                                   |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `ToolCategory.PERCEPTION` | `python/agent/tools/registry.py` + `src/harness/types.ts` | ✅ 双端已添加                                          |
| 感知工具注册              | `python/agent/tools/registry.py`                          | ✅ 4 个感知工具已注册                                  |
| Desktop 工具集            | `python/agent/tools/builtin_toolsets.py`                  | ✅ 已包含 PERCEPTION 分类                              |
| Full 工具集               | `python/agent/tools/builtin_toolsets.py`                  | ✅ 已包含 PERCEPTION 分类                              |
| 重复工具清理              | registry.py + 源文件                                      | ✅ desktop_shell / image_understand / tts_speak 已移除 |

### 6.5 总体成熟度

```
五感与手脚实现成熟度（v2.2 更新）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
归一化坐标系统    ████████████████████ 100%
感知工具注册调度  ████████████████████ 100%
screen_parse      ██████████████████░░  90%  macOS A11y + OCR降级
action_verify     ███████████████████░  95%  像素/OCR/VLM三策略 + 双图对比
smart_wait        ███████████████████░  95%  selector会话复用
speech_transcribe ██████████████████░░  90%  GPU检测 + 流式输出
desktop_automate  ███████████████████░  95%  结构化坐标转换
browser_fill_form ███████████████████░  95%  iframe/动态/CAPTCHA检测
voice_interact    ███████████████████░  95%  edge-tts + 实时录音 + STT对接
重复工具清理      ████████████████████ 100%
桌面端TS APP      ████████████████████ 100%  16模块完整实现
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
综合成熟度        ████████████████████  96%
```

---

## 七、后续规划

- [x] 归一化坐标系统（TS + Python 双端对齐）
- [x] 感知工具注册到 ToolRegistry（PERCEPTION 分类）
- [x] 重复工具清理（desktop_shell / image_understand / tts_speak）
- [x] browser_fill_form 语义化表单填写
- [x] desktop_automate 归一化坐标支持（结构化转换）
- [x] action_verify OCR 文字对比 + VLM 判断策略
- [x] screen_parse macOS Accessibility 支持
- [x] voice_interact 真实 TTS/STT 引擎集成（edge-tts + speech_transcribe）
- [x] browser_fill_form iframe/动态表单支持
- [x] smart_wait selector 模式复用已有浏览器会话
- [x] speech_transcribe GPU 自动检测 + 流式输出
- [x] action_verify VLM 双图对比（前后截图同时发送）
- [x] voice_interact 实时麦克风录音（sounddevice / pyaudio）
- [x] browser_fill_form CAPTCHA 检测与提示
- [ ] screen_parse GPU 加速视觉检测
- [ ] 更多内置技能包（Office、浏览器、开发工具等）
- [ ] 操作录制与回放
- [ ] Self-play 自我学习优化
- [ ] 多显示器支持
- [ ] 远程桌面支持

---

## 八、相关文件

| 文件                                        | 说明                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `src/desktop/NormalizedCoordinates.ts`      | TS 端归一化坐标系统                                                         |
| `python/agent/desktop/coordinate_system.py` | Python 端归一化坐标系统                                                     |
| `python/agent/tools/perception_tools.py`    | 感知工具集（screen_parse / action_verify / smart_wait / speech_transcribe） |
| `python/agent/tools/desktop_tools.py`       | 桌面工具集（desktop_automate + 归一化坐标支持）                             |
| `python/agent/tools/browser_tools.py`       | 浏览器工具集（含 browser_fill_form）                                        |
| `python/agent/tools/vision_tools.py`        | Vision 工具（vision_understand）                                            |
| `python/agent/tools/registry.py`            | 工具注册中心（含 PERCEPTION 分类）                                          |
| `python/agent/tools/builtin_toolsets.py`    | 内置工具集定义                                                              |
| `src/harness/types.ts`                      | TS 端类型定义（含 PERCEPTION 分类）                                         |
| `src/desktop/DesktopMCPServer.ts`           | MCP 工具服务器                                                              |
| `src/desktop/DesktopEventStream.ts`         | 事件流系统                                                                  |
| `src/desktop/DesktopSafetyGuard.ts`         | 安全防护系统                                                                |
| `src/desktop/DesktopSkillRegistry.ts`       | 技能包系统                                                                  |
| `src/desktop/DesktopExecutionAgent.ts`      | 执行 Agent 主入口                                                           |
| `src/desktop/index.ts`                      | 模块导出                                                                    |

---

**升级完成！** 🎉

现在 jiabaixing 拥有了 Codex 风格的 Computer Use 能力，可以放手式操作电脑完成各种任务。
