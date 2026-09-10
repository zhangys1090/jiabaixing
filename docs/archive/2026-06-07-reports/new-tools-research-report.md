# 新工具实现方案调研报告

## 1. 背景

项目：jiabaixing V5.0 — Harness Agent Framework  
运行环境：WSL Ubuntu, TypeScript CommonJS, Node 20.x  
测试框架：Jest + ts-jest  
编码规范：eslint + prettier, 使用 Logger

当前已有 25+ 个工具，注册模式成熟。本次调研两个新工具：
- `chart_generate` — 生成图表（matplotlib / plotly.js）
- `message_push` — 消息推送（ServerChan / 钉钉Webhook / 企业微信）

---

## 2. 现有工具注册模式总结

### 2.1 文件结构

每个工具是一个独立文件，位于分类子目录下：

```
src/harness/tools/
├── network/
│   ├── web_search.ts        # 工具定义 + 执行器
│   ├── image_generate.ts    # 工具定义 + 执行器
│   ├── web_fetch.ts
│   └── ...
├── system/
├── file/
├── code/
├── daily/
├── memory/
└── registry/
    ├── ToolRegistry.ts       # 核心注册表
    ├── SchemaValidator.ts
    ├── PermissionGuard.ts
    └── ...
```

### 2.2 单个工具文件模式

每个工具文件包含三部分（参考 `web_search.ts`、`image_generate.ts`）：

1. **工具定义常量** (`XXX_DEF`): `ToolDefinition` 类型
2. **依赖注入接口** (`XXXDeps`): 便于测试 mock
3. **执行器工厂函数** (`createXXXExecutor`): 返回 `(params, context) => Promise<ToolResult>`

### 2.3 注册流程

在 `registerHarnessTools.ts` 中：
1. import `XXX_DEF` 和 `createXXXExecutor`
2. 将 `XXXDeps` 合并到 `HarnessToolDeps` 联合接口
3. 在 `registerHarnessTools()` 中调用 `toolRegistry.register(XXX_DEF, createXXXExecutor(deps))`

### 2.4 ToolDefinition 接口

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: Record<string, ToolParameterDef>;
  requiredParams: string[];
  requiredPermissions: Permission[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  idempotent: boolean;
  timeout: number;
  requiresConfirmation?: boolean;
}
```

可用分类: `MEMORY | FILE | CODE | DESKTOP | COGNITION | SYSTEM | DAILY | NETWORK`  
可用权限: `MEMORY_READ | MEMORY_WRITE | FILE_READ | FILE_WRITE | DESKTOP_CONTROL | NETWORK_ACCESS | CODE_EXECUTE | SYSTEM_ADMIN`

---

## 3. chart_generate — 图表生成工具

### 3.1 技术方案对比

| 方案 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| **Plotly.js (Node.js)** | 纯 JS 栈，无需 Python；支持交互式图表；输出 HTML/PNG | 生成 PNG 需要 `plotly.js-image-server` 或 puppeteer | ⭐⭐⭐ 推荐 |
| **child_process + matplotlib** | Python 生态强大；输出 PNG 原生支持 | 依赖 Python 环境；进程管理复杂 | ⭐⭐ |
| **ECharts (Node.js)** | 轻量；中文文档好；Node-canvas 可渲染 PNG | `node-canvas` 编译依赖多 | ⭐⭐ |
| **QuickChart.io API** | 零依赖；Rest API 调用 | 网络依赖；数据保密性 | ⭐ |

**推荐方案：Plotly.js trace 方案（纯 Node.js，无 Python 依赖）**

因为项目当前是纯 TypeScript/Node.js 栈，引入 Python 会增加部署复杂度。Plotly 提供 Node.js API，用 `plotly.js-dist-min` + `canvas` 可离线渲染，或用 `quickchart-js` 库通过免费 API 生成。

**具体推荐：`quickchart-js`** 方案，零依赖、无需 canvas 编译、支持 Chart.js / Plotly 两种格式。

备选方案：`plotly.js-dist-min` + `@captchachart/captcha-chart` 本地渲染（需要系统安装 libuuid 等依赖，WSL 上配置较麻烦）。

### 3.2 文件路径

```
src/harness/tools/network/chart_generate.ts    # 工具定义 + 执行器
tests/unit/tools/chart_generate.test.ts         # 单元测试
```

分类选择 `NETWORK`（因需要网络请求 quickchart 服务 / 或调用外部渲染服务）。

### 3.3 接口设计

#### 输入参数

```typescript
parameters: {
  chart_type: {
    type: 'string',
    description: '图表类型',
    enum: ['bar', 'line', 'pie', 'scatter', 'doughnut', 'radar', 'polar'],
    default: 'bar',
  },
  title: {
    type: 'string',
    description: '图表标题',
  },
  labels: {
    type: 'array',
    description: 'X轴/分类标签列表',
    items: { type: 'string' },
  },
  datasets: {
    type: 'array',
    description: '数据集列表（一条或多条数据系列）',
    items: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '数据系列名称' },
        data: { type: 'array', description: '数据值列表', items: { type: 'number' } },
        color: { type: 'string', description: '颜色（可选，如 #ff0000）' },
      },
    },
  },
  output_format: {
    type: 'string',
    description: '输出格式',
    enum: ['url', 'base64', 'markdown'],
    default: 'markdown',
  },
  width: {
    type: 'number',
    description: '图表宽度（像素）',
    default: 600,
  },
  height: {
    type: 'number',
    description: '图表高度（像素）',
    default: 400,
  },
}
requiredParams: ['title', 'labels', 'datasets'],
```

#### 返回值

```
success: true / false
output: 
  - output_format='markdown': "![图表标题](url)" 格式的 Markdown
  - output_format='url': 图片 CDN 直链
  - output_format='base64': data:image/png;base64,...
metadata: {
  chartUrl: string;
  chartType: string;
  width: number;
  height: number;
}
```

#### 工具定义常量

```typescript
export const CHART_GENERATE_DEF: ToolDefinition = {
  name: 'chart_generate',
  description: '生成数据图表（支持柱状图、折线图、饼图、散点图等）。根据数据自动生成可视化图表，返回 Markdown 可渲染的图片链接。适用于数据统计、趋势分析、报告生成等场景。',
  category: ToolCategory.NETWORK,
  parameters: {
    // 如上参数定义
  },
  requiredParams: ['title', 'labels', 'datasets'],
  requiredPermissions: [Permission.NETWORK_ACCESS],
  riskLevel: 'low',
  idempotent: true,
  timeout: 30000,
};
```

### 3.4 依赖注入接口

```typescript
export interface ChartGenerateDeps {
  chartApiClient?: {
    generate(config: QuickChartConfig): Promise<{ url: string; buffer?: Buffer }>;
  };
}
```

### 3.5 执行器核心逻辑

1. 验证参数完整性（标题、labels、datasets 不能为空）
2. 若 `deps.chartApiClient` 存在，用注入的 client（测试用）
3. 否则使用 `quickchart-js` 库构建图表配置，通过 QuickChart.io 免费 API（或自托管实例）生成
4. 根据 `output_format` 返回不同格式

### 3.6 注册修改

在 `registerHarnessTools.ts` 中：

1. import 行添加：
```typescript
import { CHART_GENERATE_DEF, createChartGenerateExecutor, type ChartGenerateDeps } from './network/chart_generate';
```

2. `HarnessToolDeps` 添加 `ChartGenerateDeps`

3. 注册调用：
```typescript
toolRegistry.register(CHART_GENERATE_DEF, createChartGenerateExecutor(deps));
```

### 3.7 测试方案

参照 `tests/unit/tools/NewTools.test.ts` 的测试风格：

| 测试用例 | 描述 |
|----------|------|
| 工具定义检查 | name = 'chart_generate', requiredParams 包含 title/labels/datasets, timeout = 30000 |
| 空标题拒绝 | 传入空标题，断言 success = false, error 包含 "不能为空" |
| 空数据集拒绝 | 传入空 datasets 或空 labels，断言失败 |
| 缺失必填参数 | 只传 title 不传 datasets，断言失败 |
| 依赖注入 mock | 用 mock ChartApiClient 模拟成功返回 url，验证调用参数 |
| 多种图表类型 | mock 模式下测试 bar/line/pie 三种类型能生成 |
| output_format=markdown | mock 模式下验证输出包含 `![` 和 `](url)` 格式 |
| output_format=base64 | mock 模式下验证 output 包含 `data:image/png` |
| 所有参数组合 | 测试 width/height 自定义参数正确传递 |

测试模式：用 jest.fn() mock 依赖，不调用真实 API。

---

## 4. message_push — 消息推送工具

### 4.1 技术方案

纯 HTTP API 调用，不需要额外依赖。项目已有 `node-fetch`（或 Node 20.x 原生 fetch）。

支持三种推送渠道：

| 渠道 | 方式 | API 地址 | 是否需要 Key |
|------|------|----------|-------------|
| **ServerChan** | GET/POST | `https://sctapi.ftqq.com/{key}.send` | 是 (SendKey) |
| **钉钉 Webhook** | POST JSON | 用户提供 webhook URL | 是 (access_token) |
| **企业微信 Webhook** | POST JSON | 用户提供 webhook URL | 是 (key) |

### 4.2 文件路径

```
src/harness/tools/network/message_push.ts    # 工具定义 + 执行器
tests/unit/tools/message_push.test.ts         # 单元测试
```

分类选择 `NETWORK`（因涉及网络 API 调用）。

### 4.3 接口设计

#### 输入参数

```typescript
parameters: {
  channel: {
    type: 'string',
    description: '推送渠道',
    enum: ['serverchan', 'dingtalk', 'wecom'],
  },
  title: {
    type: 'string',
    description: '消息标题',
  },
  content: {
    type: 'string',
    description: '消息内容（支持 Markdown 格式）',
  },
  webhook_url: {
    type: 'string',
    description: 'Webhook 地址（钉钉/企微必填；ServerChan 不需要，自动从环境变量读取 SENDKEY）',
  },
  message_type: {
    type: 'string',
    description: '消息类型（仅钉钉/企微有效）',
    enum: ['text', 'markdown'],
    default: 'markdown',
  },
  at_mobiles: {
    type: 'array',
    description: '@ 的手机号列表（仅钉钉）',
    items: { type: 'string' },
  },
}
requiredParams: ['channel', 'title', 'content'],
```

#### 返回值

```
success: true / false
output: 成功/失败消息文本
metadata: {
  channel: string;
  pushUrl?: string;
  responseCode?: number;
}
```

#### 工具定义常量

```typescript
export const MESSAGE_PUSH_DEF: ToolDefinition = {
  name: 'message_push',
  description: '发送消息推送通知到多种渠道。支持 ServerChan（微信推送）、钉钉群机器人 Webhook、企业微信 Webhook。适用于告警通知、日报推送、任务完成通知等场景。',
  category: ToolCategory.NETWORK,
  parameters: {
    // 如上参数定义
  },
  requiredParams: ['channel', 'title', 'content'],
  requiredPermissions: [Permission.NETWORK_ACCESS],
  riskLevel: 'low',
  idempotent: false,
  timeout: 15000,
};
```

### 4.4 依赖注入接口

```typescript
export interface MessagePushDeps {
  httpClient?: {
    post(url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; data: unknown }>;
    get(url: string): Promise<{ status: number; data: unknown }>;
  };
}
```

### 4.5 执行器核心逻辑

1. 参数校验
2. 根据 `channel` 分发：
   - **ServerChan**: 环境变量读取 `SENDKEY`，构造 `https://sctapi.ftqq.com/{SENDKEY}.send?title={title}&desp={content}`
   - **钉钉**: POST 到 `{webhook_url}`，body 为 `{ msgtype: 'markdown', markdown: { title, text: content }, at: { atMobiles } }`
   - **企微**: POST 到 `{webhook_url}`，body 为 `{ msgtype: 'markdown', markdown: { content } }`
3. 解析响应，返回结果

### 4.6 注册修改

在 `registerHarnessTools.ts` 中：

1. import：
```typescript
import { MESSAGE_PUSH_DEF, createMessagePushExecutor, type MessagePushDeps } from './network/message_push';
```

2. `HarnessToolDeps` 添加 `MessagePushDeps`

3. 注册：
```typescript
toolRegistry.register(MESSAGE_PUSH_DEF, createMessagePushExecutor(deps));
```

### 4.7 测试方案

| 测试用例 | 描述 |
|----------|------|
| 工具定义检查 | name = 'message_push', requiredParams 包含 channel/title/content, timeout = 15000 |
| channel 不合法 | 传入 'invalid_channel'，断言失败 |
| 空标题/空内容 | 传入空 title 或空 content，断言失败 |
| ServerChan 缺少 SENDKEY | 不设置环境变量（或无 deps），断言 error 包含 "未配置" |
| 钉钉缺少 webhook_url | channel='dingtalk' 但没传 webhook_url，断言失败 |
| 企微缺少 webhook_url | channel='wecom' 但没传 webhook_url，断言失败 |
| ServerChan 成功推送 | mock httpClient 模拟成功返回，验证调用 URL 包含 SENDKEY |
| 钉钉成功推送 | mock httpClient 模拟成功返回，验证请求 body 格式正确（msgtype/markdown） |
| 企微成功推送 | mock httpClient 模拟成功返回，验证请求 body 格式正确 |
| at_mobiles 参数 | 验证钉钉请求中包含 at.atMobiles |
| HTTP 错误处理 | mock httpClient 返回 400/500，验证 success = false |

---

## 5. 实施步骤

### 5.1 chart_generate

1. 安装依赖：`npm install quickchart-js`（或轻量方案用原生 fetch + QuickChart API）
2. 创建 `src/harness/tools/network/chart_generate.ts`
3. 在 `registerHarnessTools.ts` 中注册
4. 创建 `tests/unit/tools/chart_generate.test.ts`
5. 运行测试验证

### 5.2 message_push

1. 无需额外依赖（使用内置 fetch）
2. 创建 `src/harness/tools/network/message_push.ts`
3. 在 `registerHarnessTools.ts` 中注册
4. 创建 `tests/unit/tools/message_push.test.ts`
5. 运行测试验证

### 5.3 配置项

在 `.env` 文件中新增可选配置：

```
# ServerChan (微信推送)
SENDKEY=

# QuickChart (图表生成)
QUICKCHART_BASE_URL=https://quickchart.io
```

---

## 6. 风险与注意事项

1. **QuickChart 免费版限制**: 免费版有 1000次/天的限制、图片大小限制。生产环境建议自托管 QuickChart 实例（Docker）。
2. **ServerChan 免费版**: 免费版有 5条/天的限制，仅用于开发测试。
3. **钉钉/企微 Webhook 安全**: webhook_url 包含 secret token，确保不记录日志。
4. **图表中文字体**: QuickChart 默认支持中文，自托管时需要额外配置中文字体。
