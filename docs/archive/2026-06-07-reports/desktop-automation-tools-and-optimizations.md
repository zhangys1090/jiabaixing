# 桌面自动化工具与优化记录

> 版本: 3.0 | 更新日期: 2026-05-29 | 维护者: 开发团队

---

## 一、架构概览

Jiabaixing 桌面自动化采用 **六层架构** (V5.0):

```
Constraints → Verification → Persistence → Context → Tools → Loop
```

核心循环 `DesktopAgentLoop` 实现 **观察→规划→执行→验证** 四阶段闭环:

```
用户指令 → observe() → llmPlanActions() → executeActions() → verifyResult()
                ↑                                           ↓
                └───── 失败重试 + Checkpoint恢复 ←──────────┘
```

---

## 二、核心模块

### 2.1 DesktopAgentLoop

**文件**: `src/desktop/DesktopAgentLoop.ts`

**职责**: 桌面自动化核心循环，协调观察、规划、执行、验证四阶段

**关键能力**:
- LLM 驱动决策: 截图 + UI 信息 → LLM → 结构化 DesktopAction[]
- 错误恢复闭环: 失败 → Checkpoint 恢复 → 重新观察 → 重试
- 安全沙箱: 三级模式 (strict/moderate/off) + forbiddenActions 过滤
- Manifest 管理: 工作空间描述 (allowedApps, allowedPaths, outputDirs)
- 执行超时保护: executionTimeoutMs (默认 120s)

**配置项**:

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| maxRetries | number | 3 | 最大重试次数 |
| verifyAfterAction | boolean | true | 每次动作后验证 |
| autoObserveIntervalMs | number | 5000 | 自动观察间隔 |
| enableLLMPlanning | boolean | true | 启用 LLM 规划 |
| maxPlanSteps | number | 20 | 单次最大规划步数 |
| enableCheckpoint | boolean | true | 启用 Checkpoint |
| sandboxMode | string | 'moderate' | 沙箱模式 |
| executionTimeoutMs | number | 120000 | 执行超时 (ms) |

**沙箱模式**:

| 模式 | 说明 |
|------|------|
| strict | 仅允许 allowedApps 白名单中的命令 |
| moderate | 仅拦截 forbiddenActions 列表中的命令 |
| off | 不做安全过滤 |

### 2.2 SystemInput (v3 - 全异步)

**文件**: `src/desktop/SystemInput.ts`

**职责**: 系统鼠标键盘控制，通过 PowerShell + user32.dll SendInput API 实现

**关键改造**:
- v1: 同步 execSync，每次操作 200-500ms 启动开销
- v2: 常驻 PowerShell 进程，但 click/move 等仍用同步
- **v3: 全异步 + 常驻进程，所有操作走常驻进程，延迟降至 ~50ms**

**方法列表**:

| 方法 | 签名 | 说明 |
|------|------|------|
| click | `async click(x?, y?): Promise<InputResult>` | 左键点击 |
| rightClick | `async rightClick(x?, y?): Promise<InputResult>` | 右键点击 |
| moveMouse | `async moveMouse(x, y): Promise<InputResult>` | 移动鼠标 |
| scroll | `async scroll(delta): Promise<InputResult>` | 滚轮滚动 |
| drag | `async drag(fromX, fromY, toX, toY): Promise<InputResult>` | 拖拽 |
| keyPress | `async keyPress(keyCode): Promise<InputResult>` | 按键 |
| keyCombo | `async keyCombo(...keyCodes): Promise<InputResult>` | 组合键 |
| typeText | `async typeText(text): Promise<InputResult>` | 输入文字 |
| getMousePosition | `async getMousePosition(): Promise<MousePosition>` | 获取鼠标位置 |
| shutdown | `async shutdown(): Promise<void>` | 关闭常驻进程 |

**常驻进程机制**:
- 启动时 spawn PowerShell 进程，通过 stdin/stdout 通信
- 命令用 `__CMD_END_{id}__` 标记分隔
- 进程崩溃自动降级为 execSync
- 输出缓冲区上限 1MB，超限自动截断

**SendKeys 转义**: `+`, `^`, `%`, `~`, `{`, `}`, `(`, `)` 全部正确转义

**组合键**: 使用 `keybd_event` down/up 模式，支持 Ctrl+S 等组合键

### 2.3 DesktopActionExecutor

**文件**: `src/desktop/DesktopActionExecutor.ts`

**职责**: 执行 DesktopAction 动作，支持 22 种动作类型

**动作类型**:

| 类型 | 方法 | 说明 |
|------|------|------|
| click | handleClick | 左键点击 |
| rightClick | handleRightClick | 右键点击 |
| type | handleType | 输入文字 |
| key | handleKey | 按键 |
| keyCombo | handleKeyCombo | 组合键 |
| moveMouse | handleMoveMouse | 移动鼠标 |
| scroll | handleScroll | 滚轮 |
| drag | handleDrag | 拖拽 |
| wait | handleWait | 等待 (异步 sleep) |
| screenshot | handleScreenshot | 截图 |
| shell | handleShell | Shell 命令 (异步 exec) |
| clipboardRead | handleClipboardRead | 读取剪贴板 |
| clipboardWrite | handleClipboardWrite | 写入剪贴板 |
| clickElement | handleClickElement | 点击 UI 元素 |
| typeIntoElement | handleTypeIntoElement | 向 UI 元素输入 |
| getElementText | handleGetElementText | 获取元素文本 |

### 2.4 DesktopVisionEngine

**文件**: `src/desktop/DesktopVisionEngine.ts`

**职责**: 视觉理解，为 LLM 决策提供屏幕信息

**双路径**:
- LLM 视觉分析: 截图 base64 → LLM Vision API → 精确描述
- 本地降级: OCR + 窗口信息 → generateLocalDescription()

### 2.5 DesktopUIInspector

**文件**: `src/desktop/DesktopUIInspector.ts`

**职责**: UI 元素检测与查找

**关键方法**:
- `findElement(description)`: 按描述查找 UI 元素
- `findElementByDescription(description)`: 带降级的元素查找
  - 优先精确匹配
  - 降级: 过滤可交互元素 → 按名称模糊匹配
  - 无匹配返回 null (不返回无关元素)
- `getInteractiveElements()`: 获取所有可交互元素

---

## 三、新增工具

### 3.1 web_fetch

**文件**: `src/harness/tools/network/web_fetch.ts`

**职责**: 补"能搜不能读"缺口

**功能**: URL → fetch → HTML → htmlToMarkdown() → Markdown/Text/HTML

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 目标 URL |
| format | string | 否 | 输出格式 (markdown/text/html) |
| max_length | number | 否 | 最大长度 (默认 10000) |

**安全**: 去除 script/style/nav/footer 标签

### 3.2 image_generate

**文件**: `src/harness/tools/network/image_generate.ts`

**职责**: 补"能看不能画"缺口

**功能**: prompt → 图像生成 API → base64/URL

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| prompt | string | 是 | 图像描述 |
| size | string | 否 | 尺寸 (square_hd/square/portrait_4_3/portrait_16_9/landscape_4_3/landscape_16_9) |
| style | string | 否 | 风格追加到 prompt |

### 3.3 shell_exec

**文件**: `src/harness/tools/system/shell_exec.ts`

**职责**: 补"无命令行"缺口

**功能**: command → exec → output

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| command | string | 是 | Shell 命令 |
| timeout | number | 否 | 超时 (默认 30000ms) |

**安全**: FORBIDDEN_COMMANDS 列表拦截 (14 条)

---

## 四、安全规则

### 4.1 统一禁止命令列表 (14 条)

DesktopAgentLoop.forbiddenActions 和 shell_exec.FORBIDDEN_COMMANDS 已统一:

| 命令 | 风险等级 | 说明 |
|------|---------|------|
| format | 🔴 严重 | 磁盘格式化 |
| del /s | 🔴 严重 | 递归删除文件 |
| rm -rf | 🔴 严重 | Linux 递归删除 |
| rm -rf / | 🔴 严重 | Linux 根目录删除 |
| rm -rf /* | 🔴 严重 | Linux 根目录删除变体 |
| shutdown | 🔴 严重 | 系统关机 |
| restart | 🔴 严重 | 系统重启 |
| reg delete | 🔴 严重 | 注册表删除 |
| reg add | 🟡 高危 | 注册表修改 |
| net user | 🟡 高危 | 用户账户操作 |
| net localgroup | 🟡 高危 | 用户组操作 |
| cipher /w | 🟡 高危 | 数据覆写 |
| diskpart | 🔴 严重 | 磁盘分区操作 |
| bcdedit | 🔴 严重 | 启动配置修改 |
| taskkill /f /im svchost | 🔴 严重 | 系统进程终止 |

### 4.2 已知局限

当前使用 `includes()` 模糊匹配，以下绕过方式尚未覆盖:
- 大小写混合 (如 `ShUtDoWn`)
- PowerShell 别名 (如 `gci` 代替 `Get-ChildItem`)
- 路径变体 (如 `C:\Windows\System32\format.com`)

**后续优化**: 升级为正则匹配或命令解析器

---

## 五、稳定性优化记录

### 5.1 已修复的稳定性隐患

| # | 问题 | 严重度 | 影响 | 修复方案 | 修改文件 |
|---|------|--------|------|---------|---------|
| 1 | handleWait 忙等待 | 🔴 严重 | 100% CPU 阻塞事件循环 | 改为 `await this.sleep(ms)` | DesktopActionExecutor.ts |
| 2 | SendKeys 特殊字符未转义 | 🔴 严重 | 输入含 `+^%~{}()` 的文本出错 | 添加完整转义链 | SystemInput.ts |
| 3 | handleKeyCombo 用 SendKeys | 🔴 严重 | 无法模拟 Ctrl+S 等组合键 | 改用 keybd_event down/up | SystemInput.ts + DesktopActionExecutor.ts |
| 4 | findElementByDescription 降级返回无关元素 | 🟡 中等 | 可能点击错误目标 | 先过滤可交互元素再按名称匹配，无匹配返回 null | DesktopUIInspector.ts |
| 5 | execute() 无总体超时 | 🟡 中等 | 重试循环可能无限运行 | 添加 executionTimeoutMs (默认 120s) | DesktopAgentLoop.ts |
| 6 | handleShell 用 execSync | 🟡 中等 | 阻塞事件循环最多 30s | 改用异步 `exec()` | DesktopActionExecutor.ts |

### 5.2 SystemInput 全异步改造

| 版本 | 架构 | 单次操作延迟 | 事件循环影响 |
|------|------|-------------|-------------|
| v1 | execSync 同步 | 200-500ms | 阻塞 |
| v2 | 常驻进程 + 部分同步 | 50ms (异步) / 200-500ms (同步) | 部分阻塞 |
| **v3** | **全异步 + 常驻进程** | **~50ms** | **不阻塞** |

改造范围:
- click → async + 常驻进程
- rightClick → async + 常驻进程
- moveMouse → async + 常驻进程
- scroll → async + 常驻进程
- drag → async + 常驻进程
- keyPress → async + 常驻进程
- keyCombo → async + 常驻进程
- typeText → async + 常驻进程
- getMousePosition → async + 常驻进程

DesktopActionExecutor 同步适配:
- handleClick → async
- handleRightClick → async
- handleType → async
- handleKey → async
- handleKeyCombo → async
- handleMoveMouse → async
- handleScroll → async
- handleDrag → async
- handleClickElement → async
- handleTypeIntoElement → async

### 5.3 PowerShell 常驻进程加固

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 进程崩溃恢复 | ✅ | exit 事件拒绝所有 pendingCommands，降级为 execSync |
| 输出缓冲区溢出 | ✅ | MAX_OUTPUT_BUFFER=1MB 上限，超限截断+告警 |
| 命令超时处理 | ✅ | setTimeout 清理 pendingCommands |
| 并发安全 | ✅ | Node.js 单线程保证 commandId 递增无竞态 |
| 进程泄漏 | ✅ | shutdown() 写入 exit + kill() + 置 null |
| 降级路径 | ✅ | usePersistentSession=false 时自动走 execSync |

### 5.4 安全规则统一

- DesktopAgentLoop.forbiddenActions: 7 条 → 14 条
- 与 shell_exec.FORBIDDEN_COMMANDS 保持一致

---

## 六、测试覆盖

### 6.1 DesktopAgentLoop 测试 (17 个)

| 分类 | 数量 | 测试项 |
|------|------|--------|
| LLM 驱动决策 | 3 | 规划动作、解析动作、空规划降级 |
| 错误恢复闭环 | 2 | 重试成功、Checkpoint 恢复 |
| 安全沙箱 | 2 | forbiddenActions 过滤、strict 模式白名单 |
| Checkpoint | 3 | 保存、恢复、差异对比 |
| Manifest | 3 | 更新、获取、默认值 |
| 正则降级 | 4 | LLM 不可用降级、空结果、剪贴板正则、截图正则 |

### 6.2 新工具测试 (26 个)

| 工具 | 数量 | 测试项 |
|------|------|--------|
| web_fetch | 10 | 正常获取、格式转换、截断、安全过滤、错误处理 |
| image_generate | 5 | 正常生成、尺寸选项、风格追加、错误处理 |
| shell_exec | 11 | 正常执行、禁止命令拦截、超时、错误处理 |

### 6.3 验证结果

```
TypeScript 编译: 0 错误
单元测试: 43/43 通过
安全规则: 14 条统一覆盖
6 个稳定性隐患: 全部修复
SystemInput: 全异步改造完成
```

---

## 七、工具注册总览

registerHarnessTools.ts 注册 33 个工具，含 3 个新增:

| 类别 | 工具 | 新增 |
|------|------|------|
| 网络 | web_fetch | ✅ |
| 网络 | image_generate | ✅ |
| 系统 | shell_exec | ✅ |
| 桌面 | 22 种 DesktopAction | - |
| 其他 | 8 个基础工具 | - |

---

## 八、待优化项

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 高 | 安全规则升级 | includes() → 正则匹配/命令解析器，防止大小写混合/别名绕过 |
| 中 | Hermes MCP 协议层集成 | 在服务端配置 Hermes 作为 MCP Host，接入 browser 和 cron |
| 中 | OpenClaw x_search | 社交媒体搜索工具，按业务需求决定 |
| 低 | Vision Engine 缓存 | 相同截图避免重复 LLM 调用 |
| 低 | 动作执行并行化 | 独立动作可并行执行提升速度 |
