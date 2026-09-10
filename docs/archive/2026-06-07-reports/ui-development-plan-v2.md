# 家百星前端 UI 整体开发计划 v2.0

> **版本**: 2.0 | **日期**: 2026-07-03 | **定位**: 基于 Hermes 功能节点模式的全栈UI重构
> **设计理念**: "御姐秘书"——成熟、专业、温暖、高效

---

## 一、现状诊断总览

### 1.1 架构全景

```
┌─────────────────────────────────────────────────────────────────┐
│                        App.tsx (状态驱动视图)                      │
│  ┌──────────┐ ┌─────────────────────────────┐                   │
│  │ Sidebar   │ │  Content Area (13 views)     │                   │
│  │ (4组13项) │ │                             │                   │
│  │           │ │  ChatInterface ✅ 完全连通    │                   │
│  │ 工作区    │ │  HermesPanel  ✅ 完全连通    │                   │
│  │ 执行/自动 │ │  VibeCoding  ⚠️ 半连通      │                   │
│  │ 大脑/记忆 │ │  MonitorPanel✅ 完全连通     │                   │
│  │ 系统监控  │ │  其余9个面板  ⚠️ 部分可用    │                   │
│  └──────────┘ └─────────────────────────────┘                   │
│                    ↕ WebSocket (30+ 事件)                       │
│         ┌──────────────────────────────────┐                     │
│         │  Zustand Stores (10个)            │                     │
│         │  + apiService (80+ API方法)       │                     │
│         └──────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 问题矩阵

| 维度         | 当前状态                  | 核心问题                                    |
| ------------ | ------------------------- | ------------------------------------------- |
| **设计语言** | 两套并存（紫→琥珀迁移中） | 色彩不统一，旧组件硬编码颜色                |
| **组件模式** | 各自为政                  | 无统一的面板骨架、表单、表格、空状态        |
| **后端连接** | 10个Store + 80+API        | 部分面板有API但UI未接线；部分功能节点缺失   |
| **交互体验** | 基础可用                  | 缺少加载骨架屏、统一错误处理、操作反馈Toast |
| **导航**     | 侧边栏+顶栏               | 无面包屑、无快捷搜索、无最近访问            |

### 1.3 HermesPanel 为什么值得作为模板

HermesPanel 是当前**最成熟的组件**，具备以下特征：

- ✅ **Tab容器 + 功能节点** 模式（输入→操作→结果）
- ✅ **100% CSS Variables** 驱动（无硬编码色值）
- ✅ **BEM命名** 规范严格
- ✅ **统一错误/加载/空状态** 处理
- ✅ **直接调用apiService**（不经过store中转）
- ✅ **统计卡片 + 操作按钮组 + 结果展示** 三段式布局

**目标：将此模式推广到全部面板。**

---

## 二、设计方案 — "家百星 Design System 2.0"

### 2.1 设计Token体系（已存在于 variables.css，需强制执行）

| Token分类  | 示例值                        | 用途                         |
| ---------- | ----------------------------- | ---------------------------- |
| **灰度**   | `--gray-0`~`--gray-10`        | 背景层次、文字层级           |
| **强调色** | `--accent: #c9956b`           | 按钮、链接、高亮、品牌       |
| **功能色** | `green/red/blue`              | 状态指示(成功/失败/信息)     |
| **间距**   | `--s-1`(4px) ~ `--s-10`(64px) | 统一间距阶梯                 |
| **圆角**   | `--r-sm`~`--r-xl`             | 组件圆润程度                 |
| **动效**   | `--ease: 0.15s ease`          | 全局过渡时长曲线             |
| **字体**   | `DM Sans + Noto Sans SC`      | UI文本；等宽用JetBrains Mono |

### 2.2 组件模式规范 — "功能节点"（Function Node）

每个面板内部采用 **Tab → Section → FunctionNode** 三层结构：

```
PanelName (e.g. AutomationPanel)
├── Header (标题 + 描述 + 全局操作)
├── TabBar (子功能切换)
│   ├── Tab 1 → Section 1
│   │   └── FunctionNode A (输入区 + 操作按钮 + 结果展示)
│   │       ├── .xxx__input-group (label + input/select)
│   │       ├── .xxx__action-bar (primary btn + secondary btn)
│   │       └── .xxx__result-area (stats/table/json/error)
│   ├── Tab 2 → Section 2
│   │   └── FunctionNode B ...
│   └── Tab 3 → ...
└── Footer (可选: 批量操作/导出/帮助)
```

**每个 FunctionNode 必须包含**:

1. 输入区 (`input-group`) — label + input/textarea/select
2. 操作按钮 (`action-bar`) — primary + 可选 secondary
3. 结果展示 (`result-area`) — 成功时显示数据，失败时显示错误
4. 加载态 — 统一的 loading spinner/skeleton
5. 空态 — 数据为空时的提示

### 2.3 通用CSS类库（新增 `base-panel.css`）

```css
/* === 面板骨架 === */
.panel-container {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  height: 100%;
  overflow-y: auto;
}
.panel-header {
  padding-bottom: var(--s-2);
  border-bottom: var(--border-light);
}
.panel-title {
  margin: 0;
  font-size: var(--text-lg);
  color: var(--text);
}
.panel-subtitle {
  margin: 4px 0 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

/* === Tab Bar === */
.tab-bar {
  display: flex;
  gap: 2px;
  background: var(--bg);
  border-radius: var(--r-md);
  padding: 2px;
}
.tab {
  flex: 1;
  padding: 6px var(--s-1);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: all var(--ease);
}
.tab:hover {
  background: var(--bg-surface);
}
.tab--active {
  background: var(--bg-hover);
  color: var(--text);
  font-weight: 600;
}

/* === 表单元素 === */
.form-label {
  display: block;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: 600;
  margin-bottom: 4px;
}
.form-input,
.form-textarea,
.form-select {
  width: 100%;
  padding: var(--s-2) var(--s-3);
  background: var(--bg-surface);
  border: var(--border-light);
  border-radius: var(--r-md);
  color: var(--text);
  font-size: var(--text-sm);
  outline: none;
  transition: border-color var(--ease);
}
.form-input:focus,
.form-textarea:focus,
.form-select:focus {
  border-color: var(--accent);
}
.form-textarea {
  resize: vertical;
  font-family: inherit;
  min-height: 60px;
}

/* === 按钮 === */
.btn {
  padding: 6px var(--s-3);
  background: var(--bg-surface);
  border: var(--border-light);
  border-radius: var(--r-md);
  color: var(--text);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: all var(--ease);
}
.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn--primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 85%, black);
}
.btn--small {
  padding: 4px var(--s-2);
  font-size: 10px;
}
.btn--danger {
  background: var(--red);
  color: #fff;
  border-color: var(--red);
}
.btn--ghost {
  background: transparent;
  border: none;
  color: var(--text-secondary);
}
.btn--ghost:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* === 结果区域 === */
.result-area {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--s-2);
}
.stat-card {
  background: var(--bg-surface);
  border: var(--border-light);
  border-radius: var(--r-md);
  padding: var(--s-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.stat-value {
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--accent);
}
.stat-label {
  font-size: 10px;
  color: var(--text-muted);
}

/* === 反馈 === */
.error-msg {
  padding: var(--s-2) var(--s-3);
  background: color-mix(in srgb, var(--red) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent);
  border-radius: var(--r-md);
  color: var(--red);
  font-size: var(--text-xs);
}
.loading-msg {
  padding: var(--s-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-align: center;
}
.empty-hint {
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-align: center;
  padding: var(--s-4);
}

/* === 子分组 === */
.subgroup {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-2);
  background: var(--bg-surface);
  border: var(--border-light);
  border-radius: var(--r-md);
}
.section {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
```

---

## 三、各面板改造计划

### Phase A: 核心体验（Chat + Hermes + Settings）

#### A1. ChatInterface 对话面板 — 已是最佳，微调优化

**当前状态**: ✅ 最完善的面板，WS双通道、流式输出、工具卡片、斜杠命令

**改造项**:
| # | 改造项 | 说明 | 优先级 |
|---|--------|------|--------|
| A1-1 | 消息气泡视觉升级 | 增加"正在思考"骨架动画、工具调用进度条嵌入消息流 | P1 |
| A1-2 | SessionSearch 增强 | 从"开发中"改为真实会话列表调用 `getConversations()` | P1 |
| A1-3 | 斜杠命令补全 | `/skills`→打开设置面板skill tab, `/model`→模型切换浮窗 | P2 |
| A1-4 | 多模态拖放反馈 | 文件拖入后显示预览缩略图+文件名+大小 | P2 |

#### A2. HermesPanel 特性增强 — 作为标杆，小幅增强

**当前状态**: ✅ 最符合规范的组件

**改造项**:
| # | 改造项 | 说明 | 优先级 |
|---|--------|------|--------|
| A2-1 | 批处理结果增强 | 增加成功率饼图、平均耗时柱状图（内嵌简单SVG图表） | P2 |
| A2-2 | 图像生成结果可视化 | 如果返回图片URL则渲染 `<img>` 而非纯文本 | P1 |
| A2-3 | TTS播放器 | 返回音频URL时增加内嵌audio player | P2 |
| A2-4 | 新增 MCP 工具节点 | 利用 `callMCPTool` API 增加 MCP 工具执行tab | P3 |

#### A3. SettingsPanel LLM管理 — 已修复props问题，继续完善

**当前状态**: ✅ props已修复，可正常渲染

**改造项**:
| # | 改造项 | 说明 | 优先级 |
|---|--------|------|--------|
| A3-1 | 模型能力评分条可视化 | 用 `.aion-gauge` 渐变填充替代纯数字 | P1 |
| A3-2 | 切换确认弹窗 | 切换前弹出确认（"切换将影响所有对话"） | P2 |
| A3-3 | 技能配置子Tab | 在SettingsPanel内增加SkillConsole的精简版 | P2 |
| A3-4 | 系统配置子Tab | 展示 `getSystemConfig()` 返回的关键参数（timeout/端口/模式） | P3 |

---

### Phase B: 监控与系统面板（Monitor / Security / Console）

#### B1. MonitorPanel 监控仪表盘

**当前状态**: ✅ 有真实数据源（4个tab: resources/llm/integrity/logs），但视觉较朴素

**改造方向**: → **实时仪表盘风格**

**功能节点规划**:

| Tab        | 功能节点   | 输入               | 操作              | 结果展示                              |
| ---------- | ---------- | ------------------ | ----------------- | ------------------------------------- |
| **资源**   | 系统概览卡 | 自动加载           | 手动刷新按钮      | CPU/内存/磁盘 Gauge 图                |
| **LLM**    | 性能分析   | 自动加载           | 刷新              | 调用次数/延迟/Token用量 折线图（SVG） |
| **完整性** | 健康检查   | 自动加载           | 重新扫描          | 通过/失败列表 + 风险等级徽章          |
| **日志**   | 实时日志流 | WS server_log 驱动 | 过滤器(log level) | 时间线日志列表（带颜色编码）          |

**关键改进**:

- 资源tab: 使用 SVG gauge 替代纯数字
- 日志tab: 增加 level 过滤下拉框、时间范围选择、关键词搜索
- 所有tab: 统一使用 base-panel CSS 类

#### B2. SecurityPanel 安全中心

**当前状态**: ✅ 有安全日志/验证/审计功能

**改造方向**: → **安全态势驾驶舱**

**功能节点规划**:

| Tab      | 功能节点     | 输入     | 操作      | 结果展示                           |
| -------- | ------------ | -------- | --------- | ---------------------------------- |
| **概况** | 安全评分卡   | 自动加载 | -         | 总体评分(0-100) + 4维度雷达图(SVG) |
| **日志** | 安全事件列表 | 自动加载 | 刷新/导出 | 事件时间线(类型/来源/风险等级)     |
| **验证** | 输入检测器   | 文本输入 | 验证按钮  | 结果(有效/警告/危险) + 解释        |
| **报告** | 审计报告     | 自动生成 | 下载PDF   | 结构化审计摘要                     |

**关键改进**:

- 安全评分卡: 圆形进度环(SVG) + 4维度分解
- 事件列表: 按风险等级着色(high红/medium黄/low绿)
- 输入验证器: 实时预览 + 一键复制报告

#### B3. ConsolePanel 控制台

**当前状态**: ✅ 已修复inline style（上轮完成），但功能单一

**改造方向**: → **运维控制台**

**功能节点规划**:

| 区域         | 内容                                                 |
| ------------ | ---------------------------------------------------- |
| 状态卡片区   | 系统运行时间 / LLM健康 / WS连接 / Agent状态（4宫格） |
| Provider管理 | 点击切换模型（复用Settings逻辑）                     |
| 实时日志流   | WS server_log 驱动 + auto-scroll + 关键词高亮        |
| 快捷操作     | 重连WS / 清除日志 / 导出日志 / Ping后端              |

**关键改进**:

- Provider行: 增加 health indicator pulse animation
- 日志区: 增加按level过滤(color toggle)
- 快捷操作: 水平排列图标按钮组

---

### Phase C: 执行与自动化面板（Automation / Desktop / CLI）

#### C1. AutomationPanel 自动化任务

**当前状态**: ✅ 已替换prompt()为Modal表单（上轮完成）

**改造方向**: → **任务调度中心**

**功能节点规划**:

| Tab        | 功能节点      | 输入      | 操作                | 结果展示                          |
| ---------- | ------------- | --------- | ------------------- | --------------------------------- |
| **任务**   | 任务列表+CRUD | Modal表单 | 创建/编辑/删除/启停 | 任务卡片(名称/cron/状态/上次运行) |
| **触发器** | 主动触发规则  | 条件配置  | 测试触发            | 触发历史记录                      |
| **模式**   | 用户行为模式  | 自动采集  | -                   | 模式洞察卡片                      |

**关键改进**:

- 任务卡片: 显示cron人类可读描述("每天9:00")、下次运行倒计时、启用toggle开关
- 创建Modal: 增加cron表达式可视化选择器(每/周/月/自定义)
- 列表: 空态引导创建首个任务

#### C2. DesktopPanel 桌面自动化

**当前状态**: ⚠️ OCR降级提示、撤销按钮已清理（上轮完成）

**改造方向**: → **桌面操作工作台**

**功能节点规划**:

| Tab      | 功能节点 | 输入   | 操作     | 结果展示                   |
| -------- | -------- | ------ | -------- | -------------------------- |
| **截图** | 屏幕捕获 | -      | 截图按钮 | 图片预览(可放大)           |
| **OCR**  | 文字识别 | 截图后 | 识别按钮 | 识别结果文本(可选中复制)   |
| **历史** | 操作回放 | 自动   | -        | 操作时间线(截图+动作+结果) |

**关键改进**:

- 截图预览: 内嵌 `<img>` + 下载按钮
- OCR结果: 文本可选择 + "复制到剪贴板"按钮 + "发送到对话"快捷操作
- 历史时间线: 缩略图 + 动作标签

#### C3. CLIPanel CLI终端

**当前状态**: ❓ 可能Mock/占位

**改造方向**: → **网关命令终端**

**功能节点规划**:
保持终端模拟器风格，但确保命令能真正到达后端：

| 命令      | 后端API                            | 说明           |
| --------- | ---------------------------------- | -------------- |
| `status`  | `getHealth()` + `getModelStatus()` | 系统健康快照   |
| `gateway` | `getSystemConfig()`                | 网关配置信息   |
| `tools`   | `listTools()`                      | 已注册工具列表 |
| `memory`  | `getMemoryStats()`                 | 记忆系统统计   |
| `clear`   | 本地操作                           | 清除终端屏幕   |

**关键改进**:

- 每个命令输出格式化为彩色终端样式
- 增加 Tab 补全（按Tab键补全命令名）
- 命令历史上下键翻阅

---

### Phase D: 大脑与记忆面板（Memory / Evolution / VibeCoding）

#### D1. MemoryPanel 记忆系统

**当前状态**: ✅ 有搜索/画像/统计功能

**改造方向**: → **知识记忆图谱**

**功能节点规划**:

| Tab      | 功能节点 | 输入       | 操作     | 结果展示                      |
| -------- | -------- | ---------- | -------- | ----------------------------- |
| **搜索** | 语义检索 | 关键词输入 | 搜索按钮 | 结果列表(相关度+摘要+时间戳)  |
| **画像** | 用户画像 | 自动加载   | 刷新     | 画像卡片(兴趣/偏好/频率词云)  |
| **统计** | 记忆指标 | 自动加载   | -        | 存储量/召回率/命中率 数字卡片 |

**关键改进**:

- 搜索结果: 相关度条形图 + 高亮匹配关键词
- 画像: 兴趣标签云(大小=权重)
- 统计: 趋势迷你图(SVG sparkline)

#### D2. EvolutionPanel 进化系统

**当前状态**: ✅ props已修复，4个tab(loops/events/metrics/subloops)

**改造方向**: → **进化引擎控制台**

**功能节点规划**:

| Tab        | 功能节点       | 输入               | 操作         | 结果展示                             |
| ---------- | -------------- | ------------------ | ------------ | ------------------------------------ |
| **循环**   | 进化循环状态   | 自动加载           | 触发完整进化 | 循环状态网格(名称/活跃/计数)         |
| **事件**   | 进化事件流     | WS evolution_event | -            | 事件时间线(类型emoji+描述+分数+时间) |
| **指标**   | 进化指标       | 自动加载           | -            | 3指标卡片 + **趋势图**(SVG折线)      |
| **子循环** | 自修/重构/增强 | 自动加载           | 分别触发     | 3个子引擎状态+成功/失败比            |

**关键改进**:

- 指标tab: "图表开发中..." → 用内嵌SVG绘制简单趋势图
- 事件流: 增加 type filter 下拉框
- 子循环: 进度环(SVG)显示成功占比

#### D3. VibeCodingPanel Vibe编码

**当前状态**: ⚠️ 半连通（纯展示，依赖外部注入props）

**改造方向**: → **澄清+预览+追踪一体化**

**改造项**:

- 澄清请求: 选项按钮增加 hover 效果和选中态动画
- 执行预览: 风险等级用颜色编码(红/黄/绿badge)
- 工具追踪: 最近N条追踪改为可展开详情（显示完整args+result摘要）
- 整体: 当没有数据时显示"等待Agent执行..."的优雅空态

---

### Phase E: 集成平台（Integration）

#### E1. IntegrationPanel 第三方集成

**当前状态**: ✅ 未实现平台已加"暂不支持"提示（上轮完成）

**改造方向**: → **集成中心**

**功能节点规划**:

| Tab          | 功能节点        | 平台支持情况                                           |
| ------------ | --------------- | ------------------------------------------------------ |
| **微信**     | 微信接入        | ✅ 有 `getWeChatQRCode()` / `sendIntegrationMessage()` |
| **飞书**     | 飞书机器人      | ✅ connect/disconnect/message                          |
| **钉钉**     | 钉钉Webhook     | ✅ 同上                                                |
| **Telegram** | Telegram Bot    | ⚠️ 配置表单待实现                                      |
| **Discord**  | Discord Webhook | ⚠️ 配置表单待实现                                      |
| **通用**     | Webhook配置     | ✅ `getIntegrationWebhook()`                           |

**关键改进**:

- 微信: 显示二维码图片 + 连接状态
- 飞书/钉书: 显示连接状态 + 测试消息发送
- 未实现平台: 保持"暂不支持"提示，但增加"需求反馈"入口

---

## 四、后端连接补齐计划

以下面板存在 **API已定义但UI未完全接线** 的缺口：

| 面板            | 已有API                                                                          | 缺少的UI接线                  | 行动              |
| --------------- | -------------------------------------------------------------------------------- | ----------------------------- | ----------------- |
| MemoryPanel     | `getConversations()`, `searchMemory()`, `getMemoryProfile()`, `getMemoryStats()` | 会话列表未对接                | 接入SessionSearch |
| EvolutionPanel  | `getEvolutionMetrics()`, `triggerOrchestratorOptimize()`                         | metrics tab用mock数据         | 改为真实API调用   |
| MonitorPanel    | `getPerformanceMetrics()`, `getErrorLogs()`, `getLogsQuery()`                    | logs tab可能未充分使用        | 增加过滤/分页UI   |
| AutomationPanel | `getAutomationTriggers()`, `getAutomationPatterns()`, `executeAutomationTask()`  | triggers/patterns tab可能mock | 确认并接线        |
| CLIPanel        | 全部命令                                                                         | 不确定是否有真实shell通道     | 验证或标注demo    |

---

## 五、全局体验提升（跨面板通用）

### 5.1 Toast通知系统

**现状**: 错误仅在面板内显示，用户切走后看不到
**方案**: 创建全局 Toast Context，支持 `success/error/warning/info` 四种类型
**触发场景**: 模型切换成功、自动化任务创建、审批通过/拒绝、文件上传完成

### 5.2 加载骨架屏

**现状**: Suspense 只显示"正在加载面板..."
**方案**: 为每个面板创建 skeleton 占位（模仿真实布局的灰色脉冲块）

### 5.3 面板间快速跳转

**现状**: 只能通过侧边栏切换
**方案**:

- 面板内增加"关联面板"快捷链接（如MonitorPanel底部链接到SecurityPanel）
- 面包屑: `系统 > 监控 > 资源`

### 5.4 键盘快捷键增强

**现状**: 已有 Ctrl+1~9 模块切换
**增加**:

- `Ctrl+/`: 打开快捷键帮助面板（覆盖全屏）
- `Ctrl+F`: 聚焦到当前面板内的搜索框
- `Esc`: 关闭任何打开的Modal/Dropdown

---

## 六、实施路线图

### 第一轮: 基础设施 + 核心面板 (Day 1)

| 序号 | 任务                                             | 产出物                                      |
| ---- | ------------------------------------------------ | ------------------------------------------- |
| R1-1 | 创建 `base-panel.css` 通用类库                   | `src/styles/base-panel.css`                 |
| R1-2 | 创建全局 Toast 通知系统                          | `src/components/Toast/ToastProvider.tsx`    |
| R1-3 | 创建 Skeleton 加载占位组件                       | `src/components/Skeleton/PanelSkeleton.tsx` |
| R1-4 | 重构 SettingsPanel 使用 base-panel 类 + 增强功能 | 更新 SettingsPanel.tsx/.css                 |
| R1-5 | 重构 MonitorPanel 使用 Hermes 风格功能节点       | 更新 MonitorPanel.tsx/.css                  |
| R1-6 | TypeScript 编译验证                              | 零错误                                      |

### 第二轮: 系统+执行面板 (Day 2)

| 序号 | 任务                                       | 产出物                        |
| ---- | ------------------------------------------ | ----------------------------- |
| R2-1 | 重构 SecurityPanel (安全评分卡+雷达图)     | 更新 SecurityPanel.tsx/.css   |
| R2-2 | 重构 ConsolePanel (日志过滤器+快捷操作)    | 更新 ConsolePanel.tsx/.css    |
| R2-3 | 增强 AutomationPanel (cron选择器+任务卡片) | 更新 AutomationPanel.tsx/.css |
| R2-4 | 增强 DesktopPanel (截图预览+OCR复制)       | 更新 DesktopPanel.tsx/.css    |
| R2-5 | 验证 CLIPanel 命令真实性，必要时重写       | 更新 CLIPanel.tsx/.css        |

### 第三轮: 大脑+记忆+集成 (Day 3)

| 序号 | 任务                                            | 产出物                         |
| ---- | ----------------------------------------------- | ------------------------------ |
| R3-1 | 重构 MemoryPanel (搜索结果+画像+统计)           | 更新 MemoryPanel.tsx/.css      |
| R3-2 | 重构 EvolutionPanel (趋势图+事件过滤)           | 更新 EvolutionPanel.tsx/.css   |
| R3-3 | 增强 VibeCodingPanel (空态+追踪展开)            | 更新 VibeCodingPanel.tsx/.css  |
| R3-4 | 增强 IntegrationPanel (微信二维码+测试消息)     | 更新 IntegrationPanel.tsx/.css |
| R3-5 | ChatInterface 微调 (思考骨架+SessionSearch真接) | 更新 ChatInterface.tsx         |

### 第四轮: 打磨+验收 (Day 4)

| 序号 | 任务                                   | 产出物                    |
| ---- | -------------------------------------- | ------------------------- |
| R4-1 | 清理旧 App.css 紫色调变量残留          | App.css 精简              |
| R4-2 | 全面暗色/浅色主题一致性检查            | 两个theme下逐面板截图对比 |
| R4-3 | 响应式适配 (移动端侧边栏折叠+面板全宽) | useResponsive hook 增强   |
| R4-4 | 端到端测试: 启动服务逐面板验证         | E2E测试报告               |
| R4-5 | TypeScript 编译最终验证 + 代码审查     | 零错误 + 审查通过         |

---

## 七、实施进度跟踪

### 已完成任务 (截至 2026-07-03)

| 轮次   | 任务                     | 状态      | 说明                               |
| ------ | ------------------------ | --------- | ---------------------------------- |
| **R1** | base-panel.css           | ✅ 完成   | 通用面板CSS类库                    |
| **R1** | Toast 通知系统           | ✅ 完成   | 全局 ToastContext + ToastContainer |
| **R1** | Skeleton 骨架屏          | ✅ 完成   | PanelSkeleton 组件                 |
| **R1** | SettingsPanel 重构       | ✅ 完成   | 全屏面板 + base-panel 类           |
| **R1** | MonitorPanel 重构        | ✅ 完成   | Hermes 风格功能节点                |
| **R1** | TypeScript 编译          | ✅ 零错误 | 无报错                             |
| **R2** | SecurityPanel 安全评分卡 | ✅ 完成   | SVG圆形进度环 + 雷达图             |
| **R2** | ConsolePanel 运维控制台  | ✅ 完成   | 日志过滤器 + 快捷操作              |
| **R2** | AutomationPanel 任务调度 | ✅ 完成   | Cron可视化 + 任务卡片              |
| **R2** | DesktopPanel 桌面工作台  | ✅ 完成   | 截图预览 + OCR复制                 |
| **R2** | CLIPanel 命令终端        | ✅ 完成   | Tab补全 + 多候选提示               |
| **R2** | TypeScript 编译          | ✅ 零错误 | 无报错                             |

### 待完成任务

| 轮次   | 任务                                       | 预计工作量 |
| ------ | ------------------------------------------ | ---------- |
| **R3** | MemoryPanel 语义检索增强                   | Day 3      |
| **R3** | EvolutionPanel 趋势图 + 事件过滤           | Day 3      |
| **R3** | VibeCodingPanel 空态 + 追踪展开            | Day 3      |
| **R3** | IntegrationPanel 微信二维码 + 测试消息     | Day 3      |
| **R3** | ChatInterface 思考骨架 + SessionSearch真接 | Day 3      |
| **R4** | 清理旧 App.css 紫色调变量                  | Day 4      |
| **R4** | 全面暗色/浅色主题一致性检查                | Day 4      |
| **R4** | 响应式适配 (移动端)                        | Day 4      |
| **R4** | 端到端测试 + 最终验证                      | Day 4      |

---

## 七、技术规范总结

### 文件结构约定

```
src/frontend/src/
├── styles/
│   ├── variables.css          ← 设计Token (不变)
│   ├── base-panel.css         ← 【新增】通用面板类库
│   └── aion-ui.css            ← Aion扩展 (不变)
├── components/
│   ├── Toast/                 ← 【新增】全局Toast
│   │   ├── ToastProvider.tsx
│   │   └── Toast.css
│   ├── Skeleton/              ← 【新增】骨架屏
│   │   ├── PanelSkeleton.tsx
│   │   └── PanelSkeleton.css
│   ├── [各面板]/              ← 逐一改造
│   │   ├── XXXPanel.tsx       ← 使用 base-panel 类
│   │   └── XXXPanel.css       ← 仅保留面板特有样式
│   └── ChatInterface/         ← 微调
├── contexts/
│   └── ToastContext.tsx        ← 【新增】Toast状态
└── stores/                     ← 不变
```

### 代码规范

1. **所有新面板必须使用 `base-panel.css` 中的类名**
2. **禁止在 TSX 中写 inline style** (除了动态计算值如 width/height)
3. **禁止硬编码颜色值** (必须引用 CSS 变量)
4. **每个 FunctionNode 必须有 error/loading/empty 三态**
5. **API 调用统一走 apiService，不绕 store 中转**（除非需要全局共享状态）

---

_文档结束 — 待用户审阅确认后进入实施阶段_
