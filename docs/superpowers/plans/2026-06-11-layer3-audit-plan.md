# 多模态层 + 桌面自动化层 + 集成网关层 + API路由层 审计计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对家百星项目的多模态层、桌面自动化层、集成网关层、API路由层进行全面代码与功能审计，识别架构缺陷、安全隐患、性能瓶颈和测试盲区

**Architecture:** 四层递进审计 — 多模态层(5文件)→桌面自动化层(17文件)→集成网关层(20文件)→API路由层(18文件)，每层按"代码规范→功能完整性→安全审计→性能评估→测试覆盖"五维度审计

**Tech Stack:** TypeScript 6 / Express / WebSocket / Jest / robotjs / screenshot-desktop / MCP Protocol

---

## 审计范围与文件清单

### 多模态层 (5文件)

| 文件                                            | 行数 | 职责                            |
| ----------------------------------------------- | ---- | ------------------------------- |
| `src/multimodal/EnvironmentPerceptionEngine.ts` | ~410 | 环境感知引擎，情绪分析+场景识别 |
| `src/multimodal/EmotionAnalyzer.ts`             | ~130 | 情感分析器                      |
| `src/multimodal/MultimodalInput.ts`             | ~130 | 多模态输入管理                  |
| `src/multimodal/SpeechRecognizer.ts`            | ~120 | 语音识别器                      |
| `src/multimodal/SceneRecognizer.ts`             | ~130 | 场景识别器                      |

### 桌面自动化层 (17文件)

| 文件                                      | 行数 | 职责         |
| ----------------------------------------- | ---- | ------------ |
| `src/desktop/DesktopActionExecutor.ts`    | ~300 | 动作执行器   |
| `src/desktop/DesktopVisionEngine.ts`      | ~250 | 视觉引擎     |
| `src/desktop/SystemInput.ts`              | ~200 | 系统输入模拟 |
| `src/desktop/ScreenCapture.ts`            | ~200 | 屏幕截图     |
| `src/desktop/DesktopWorkflowRecorder.ts`  | ~400 | 工作流录制   |
| `src/desktop/DesktopUIInspector.ts`       | ~200 | UI检查器     |
| `src/desktop/DesktopHotkeyManager.ts`     | ~150 | 热键管理     |
| `src/desktop/DesktopDecisionEngine.ts`    | ~250 | 决策引擎     |
| `src/desktop/DesktopAgentLoop.ts`         | ~110 | 自动化主循环 |
| `src/desktop/StateSnapshotManager.ts`     | ~200 | 状态快照管理 |
| `src/desktop/WindowManager.ts`            | ~200 | 窗口管理器   |
| `src/desktop/ElementMatcher.ts`           | ~200 | 元素匹配器   |
| `src/desktop/ApprovalGate.ts`             | ~150 | 审批门控     |
| `src/desktop/snapshot/SnapshotStorage.ts` | ~150 | 快照存储     |
| `src/desktop/ui/UIElementParser.ts`       | ~150 | UI元素解析器 |
| `src/desktop/ui/types.ts`                 | ~80  | UI类型定义   |
| `src/desktop/snapshot/types.ts`           | ~60  | 快照类型定义 |

### 集成网关层 (20文件)

| 文件                                                 | 行数  | 职责             |
| ---------------------------------------------------- | ----- | ---------------- |
| `src/integration/GatewayBridge.ts`                   | ~200  | 网关桥接         |
| `src/integration/MultiPlatformGateway.ts`            | ~400  | 多平台网关主入口 |
| `src/integration/IntegrationManager.ts`              | ~300  | 集成管理器       |
| `src/integration/index.ts`                           | ~50   | 导出入口         |
| `src/integration/gatewayWorker.ts`                   | ~200  | 网关工作进程     |
| `src/mcp/MCPServerManager.ts`                        | ~90   | MCP服务器管理    |
| `src/mcp/index.ts`                                   | ~50   | MCP导出入口      |
| `src/interaction/InteractionEngine.ts`               | ~1122 | 交互引擎         |
| `src/interaction/ContinuousDialogManager.ts`         | ~443  | 连续对话管理     |
| `src/io/FileSystem.ts`                               | ~150  | 文件系统操作     |
| `src/server/init/initGateway.ts`                     | ~100  | 网关初始化       |
| `src/integration/adapters/BaseIntegrationAdapter.ts` | ~150  | 基础适配器       |
| `src/integration/adapters/WeChatAdapter.ts`          | ~200  | 微信适配器       |
| `src/integration/adapters/DingTalkAdapter.ts`        | ~200  | 钉钉适配器       |
| `src/integration/adapters/FeishuAdapter.ts`          | ~200  | 飞书适配器       |
| `src/integration/adapters/TelegramAdapter.ts`        | ~200  | Telegram适配器   |
| `src/integration/adapters/QQAdapter.ts`              | ~200  | QQ适配器         |
| `src/integration/adapters/DiscordAdapter.ts`         | ~200  | Discord适配器    |
| `src/integration/adapters/SlackAdapter.ts`           | ~200  | Slack适配器      |
| `src/integration/adapters/WeChatQRAdapter.ts`        | ~200  | 微信二维码适配器 |

### API路由层 (18文件)

| 文件                                       | 行数 | 职责          |
| ------------------------------------------ | ---- | ------------- |
| `src/server/routes/chatRoutes.ts`          | ~227 | 对话API       |
| `src/server/routes/coreRoutes.ts`          | ~459 | 核心API       |
| `src/server/routes/integrationRoutes.ts`   | ~568 | 集成平台API   |
| `src/server/routes/automationRoutes.ts`    | ~381 | 自动化API     |
| `src/server/routes/mcpRoutes.ts`           | ~262 | MCP服务器API  |
| `src/server/routes/memoryRoutes.ts`        | ~236 | 记忆系统API   |
| `src/server/routes/evolutionRoutes.ts`     | ~191 | 进化引擎API   |
| `src/server/routes/securityRoutes.ts`      | ~202 | 安全API       |
| `src/server/routes/contextManageRoutes.ts` | ~174 | 上下文管理API |
| `src/server/routes/orchestrateRoutes.ts`   | ~172 | 编排API       |
| `src/server/routes/skillRoutes.ts`         | ~199 | 技能API       |
| `src/server/routes/performanceRoutes.ts`   | ~161 | 性能监控API   |
| `src/server/routes/debugRoutes.ts`         | ~230 | 调试API       |
| `src/server/routes/docsRoutes.ts`          | ~224 | 文档API       |
| `src/server/routes/approvalRoutes.ts`      | ~128 | 审批API       |
| `src/server/middleware/authMiddleware.ts`  | ~112 | 认证中间件    |
| `src/server/websocket/index.ts`            | ~80  | WebSocket管理 |
| `src/server/bootstrap.ts`                  | ~150 | 启动引导      |

---

## 审计维度定义

| 维度              | 检查项                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| **D1 代码规范**   | TypeScript类型安全(no any)、命名规范、JSDoc注释、文件长度≤500行、导入顺序 |
| **D2 功能完整性** | 接口契约一致性、错误处理覆盖、边界条件、降级策略、功能闭环                |
| **D3 安全审计**   | 输入验证、输出编码、敏感信息保护、权限控制、注入防护、CSRF、速率限制      |
| **D4 性能评估**   | 内存泄漏、异步阻塞、缓存策略、资源限制、大文件处理                        |
| **D5 测试覆盖**   | 单元测试覆盖、集成测试覆盖、边界测试、mock合理性                          |

---

## Task 1: 多模态层审计 — EnvironmentPerceptionEngine.ts

**Files:**

- Audit: `src/multimodal/EnvironmentPerceptionEngine.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 410行，符合500行限制
2. ✅ TypeScript类型安全，无any
3. ✅ JSDoc注释完整
4. ⚠️ 系统信息采集逻辑存在潜在风险（如hostname预测不准确）
5. ⚠️ 错误处理仅日志记录未抛出异常（P2-12已修复：关键错误重新抛出）
6. ⚠️ 未体现降级策略

---

## Task 2: 多模态层审计 — EmotionAnalyzer/MultimodalInput/SpeechRecognizer/SceneRecognizer

**Files:**

- Audit: `src/multimodal/EmotionAnalyzer.ts`
- Audit: `src/multimodal/MultimodalInput.ts`
- Audit: `src/multimodal/SpeechRecognizer.ts`
- Audit: `src/multimodal/SceneRecognizer.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 四个文件均在120-130行，符合规范
2. ✅ TypeScript类型安全
3. ⚠️ EmotionAnalyzer：情绪关键词匹配硬编码，不够灵活
4. ⚠️ SpeechRecognizer：依赖外部语音识别服务，缺少降级策略
5. ⚠️ SceneRecognizer：场景识别规则硬编码
6. ⚠️ MultimodalInput：输入数据未做大小限制

---

## Task 3: 桌面自动化层审计 — DesktopActionExecutor/SystemInput/ScreenCapture

**Files:**

- Audit: `src/desktop/DesktopActionExecutor.ts`
- Audit: `src/desktop/SystemInput.ts`
- Audit: `src/desktop/ScreenCapture.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 文件行数在200-300行，符合规范
2. ✅ TypeScript类型安全
3. 🔴 DesktopActionExecutor：执行桌面操作前缺少充分的权限校验，可能执行危险操作
4. ⚠️ SystemInput：键盘/鼠标模拟缺少操作频率限制，可能被滥用
5. ⚠️ ScreenCapture：截图数据未做大小限制，大量截图可能导致内存问题
6. ⚠️ DesktopActionExecutor：操作日志可能包含敏感信息（如截图内容）

---

## Task 4: 桌面自动化层审计 — DesktopWorkflowRecorder/DesktopUIInspector/DesktopDecisionEngine

**Files:**

- Audit: `src/desktop/DesktopWorkflowRecorder.ts`
- Audit: `src/desktop/DesktopUIInspector.ts`
- Audit: `src/desktop/DesktopDecisionEngine.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ⚠️ DesktopWorkflowRecorder 400行接近限制
2. ✅ TypeScript类型安全
3. ⚠️ DesktopWorkflowRecorder：录制的工作流可能包含敏感操作序列
4. ⚠️ DesktopDecisionEngine：决策逻辑基于规则，缺少学习机制
5. ⚠️ DesktopUIInspector：UI元素信息可能包含敏感数据

---

## Task 5: 桌面自动化层审计 — 其他文件

**Files:**

- Audit: `src/desktop/DesktopAgentLoop.ts`
- Audit: `src/desktop/DesktopHotkeyManager.ts`
- Audit: `src/desktop/StateSnapshotManager.ts`
- Audit: `src/desktop/WindowManager.ts`
- Audit: `src/desktop/ElementMatcher.ts`
- Audit: `src/desktop/ApprovalGate.ts`
- Audit: `src/desktop/DesktopVisionEngine.ts`
- Audit: `src/desktop/snapshot/SnapshotStorage.ts`
- Audit: `src/desktop/ui/UIElementParser.ts`
- Audit: `src/desktop/ui/types.ts`
- Audit: `src/desktop/snapshot/types.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 大部分文件行数在60-250行，符合规范
2. ✅ TypeScript类型安全
3. ⚠️ ApprovalGate：审批逻辑可能被绕过（缺少强制校验）
4. ⚠️ WindowManager：窗口操作缺少安全边界检查
5. ⚠️ SnapshotStorage：快照数据可能包含敏感信息，缺少加密
6. ⚠️ DesktopVisionEngine：图像识别依赖外部模型，缺少降级策略

---

## Task 6: 集成网关层审计 — MultiPlatformGateway/GatewayBridge/IntegrationManager

**Files:**

- Audit: `src/integration/MultiPlatformGateway.ts`
- Audit: `src/integration/GatewayBridge.ts`
- Audit: `src/integration/IntegrationManager.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ⚠️ MultiPlatformGateway 400行接近限制
2. ✅ TypeScript类型安全
3. 🔴 MultiPlatformGateway：平台适配器注册缺少验证，可能注册恶意适配器
4. ⚠️ GatewayBridge：消息转发缺少速率限制
5. ⚠️ IntegrationManager：集成配置可能包含敏感token，缺少加密存储
6. ⚠️ IntegrationManager：适配器生命周期管理缺少错误恢复

---

## Task 7: 集成网关层审计 — 平台适配器 (9个)

**Files:**

- Audit: `src/integration/adapters/BaseIntegrationAdapter.ts`
- Audit: `src/integration/adapters/WeChatAdapter.ts`
- Audit: `src/integration/adapters/DingTalkAdapter.ts`
- Audit: `src/integration/adapters/FeishuAdapter.ts`
- Audit: `src/integration/adapters/TelegramAdapter.ts`
- Audit: `src/integration/adapters/QQAdapter.ts`
- Audit: `src/integration/adapters/DiscordAdapter.ts`
- Audit: `src/integration/adapters/SlackAdapter.ts`
- Audit: `src/integration/adapters/WeChatQRAdapter.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 适配器文件均在150-200行，符合规范
2. ✅ 统一继承BaseIntegrationAdapter
3. 🔴 Webhook URL验证不足 — 多个适配器的webhook URL未做格式校验，可能导致SSRF攻击
4. 🔴 平台Token/Secret硬编码风险 — 部分适配器可能将token存储在内存中未加密
5. ⚠️ 消息发送失败缺少重试机制
6. ⚠️ 适配器间消息格式不统一
7. ⚠️ WeChatQRAdapter：二维码登录流程缺少超时处理

---

## Task 8: 集成网关层审计 — MCP/Interaction/IO

**Files:**

- Audit: `src/mcp/MCPServerManager.ts`
- Audit: `src/mcp/index.ts`
- Audit: `src/interaction/InteractionEngine.ts`
- Audit: `src/interaction/ContinuousDialogManager.ts`
- Audit: `src/io/FileSystem.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. 🔴 InteractionEngine 1122行严重超出500行限制
2. ✅ MCP模块文件行数符合规范
3. ⚠️ MCPServerManager：连接超时和重试机制已添加（P2-11修复）
4. ⚠️ FileSystem：文件操作缺少路径安全检查
5. ⚠️ InteractionEngine：未见缓存策略（P2-7已评估：由LLM层处理）
6. ⚠️ ContinuousDialogManager：依赖node-record-lpcm16

---

## Task 9: API路由层审计 — chatRoutes/coreRoutes

**Files:**

- Audit: `src/server/routes/chatRoutes.ts`
- Audit: `src/server/routes/coreRoutes.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ chatRoutes 227行，coreRoutes 459行，均符合规范
2. ✅ coreRoutes使用了requireAuth认证中间件
3. 🔴 chatRoutes：POST /api/chat缺少速率限制，可能被滥用进行DoS攻击
4. 🔴 chatRoutes：请求体字段缺少输入验证和清理
5. ⚠️ coreRoutes：部分敏感API（如模型管理）需要认证但缺少权限分级
6. ⚠️ chatRoutes：SSE流式响应缺少超时控制

---

## Task 10: API路由层审计 — integrationRoutes/automationRoutes

**Files:**

- Audit: `src/server/routes/integrationRoutes.ts`
- Audit: `src/server/routes/automationRoutes.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. 🔴 integrationRoutes 568行严重超出500行限制
2. ⚠️ automationRoutes 381行接近限制
3. 🔴 integrationRoutes：Webhook URL未做SSRF防护
4. 🔴 automationRoutes：使用了较多any类型，类型安全不足
5. ⚠️ integrationRoutes：平台连接/断开操作缺少认证保护
6. ⚠️ automationRoutes：工作流执行参数缺少合法性验证

---

## Task 11: API路由层审计 — mcpRoutes/memoryRoutes/evolutionRoutes

**Files:**

- Audit: `src/server/routes/mcpRoutes.ts`
- Audit: `src/server/routes/memoryRoutes.ts`
- Audit: `src/server/routes/evolutionRoutes.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 三个文件均在191-262行，符合规范
2. ✅ TypeScript类型安全良好
3. 🔴 evolutionRoutes：触发进化操作的API缺少认证保护
4. ⚠️ mcpRoutes：工具调用参数缺少输入验证
5. ⚠️ memoryRoutes：用户画像数据可能包含敏感信息，缺少脱敏
6. ⚠️ evolutionRoutes：进化周期计算开销大，缺少资源限制

---

## Task 12: API路由层审计 — securityRoutes/contextManageRoutes/orchestrateRoutes/skillRoutes

**Files:**

- Audit: `src/server/routes/securityRoutes.ts`
- Audit: `src/server/routes/contextManageRoutes.ts`
- Audit: `src/server/routes/orchestrateRoutes.ts`
- Audit: `src/server/routes/skillRoutes.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 四个文件均在172-202行，符合规范
2. ✅ TypeScript类型安全良好
3. 🔴 skillRoutes：技能执行API缺少权限校验，可能执行任意技能
4. ⚠️ securityRoutes：安全日志API本身需要更严格的认证
5. ⚠️ contextManageRoutes：上下文数据可能包含敏感信息
6. ⚠️ orchestrateRoutes：编排逻辑需注意请求转接的完整性

---

## Task 13: API路由层审计 — performanceRoutes/debugRoutes/docsRoutes/approvalRoutes

**Files:**

- Audit: `src/server/routes/performanceRoutes.ts`
- Audit: `src/server/routes/debugRoutes.ts`
- Audit: `src/server/routes/docsRoutes.ts`
- Audit: `src/server/routes/approvalRoutes.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 四个文件均在128-230行，符合规范
2. 🔴 debugRoutes：调试接口在生产环境必须禁用，但缺少环境检查
3. ⚠️ performanceRoutes：监控数据访问需要认证保护
4. ⚠️ approvalRoutes：审批流权限控制需加强
5. ⚠️ docsRoutes：静态文件服务需防止路径遍历

---

## Task 14: API路由层审计 — authMiddleware/websocket/bootstrap

**Files:**

- Audit: `src/server/middleware/authMiddleware.ts`
- Audit: `src/server/websocket/index.ts`
- Audit: `src/server/bootstrap.ts`

- [ ] **Step 1: D1-D5 全面审计**

**发现：**

1. ✅ 三个文件均在80-150行，符合规范
2. 🔴 authMiddleware：JWT密钥可能硬编码或使用弱密钥
3. 🔴 websocket：WebSocket连接缺少认证机制
4. ⚠️ authMiddleware：缺少token刷新机制
5. ⚠️ bootstrap：配置加载需注意敏感信息保护
6. ⚠️ websocket：连接数未做限制

---

## 审计发现汇总

### 严重问题 (P0 — 必须修复)

| #     | 文件                  | 问题                          | 影响              |
| ----- | --------------------- | ----------------------------- | ----------------- |
| P0-1  | chatRoutes.ts         | POST /api/chat缺少速率限制    | DoS攻击风险       |
| P0-2  | chatRoutes.ts         | 请求体字段缺少输入验证        | 注入攻击/数据污染 |
| P0-3  | integrationRoutes.ts  | Webhook URL未做SSRF防护       | 服务端请求伪造    |
| P0-4  | authMiddleware.ts     | JWT密钥可能硬编码或使用弱密钥 | 认证绕过          |
| P0-5  | websocket/index.ts    | WebSocket连接缺少认证         | 未授权访问        |
| P0-6  | evolutionRoutes.ts    | 触发进化API缺少认证           | 未授权触发进化    |
| P0-7  | skillRoutes.ts        | 技能执行API缺少权限校验       | 任意技能执行      |
| P0-8  | debugRoutes.ts        | 调试接口生产环境未禁用        | 信息泄露/系统操控 |
| P0-9  | 平台适配器(多个)      | Webhook URL未做格式校验       | SSRF攻击          |
| P0-10 | DesktopActionExecutor | 桌面操作缺少充分权限校验      | 危险操作执行      |

### 重要问题 (P1 — 应该修复)

| #     | 文件                 | 问题                      | 影响           |
| ----- | -------------------- | ------------------------- | -------------- |
| P1-1  | InteractionEngine.ts | 文件1122行超出500行限制   | 可维护性差     |
| P1-2  | integrationRoutes.ts | 文件568行超出500行限制    | 可维护性差     |
| P1-3  | automationRoutes.ts  | 使用较多any类型           | 类型安全不足   |
| P1-4  | MultiPlatformGateway | 适配器注册缺少验证        | 恶意适配器注册 |
| P1-5  | IntegrationManager   | Token/Secret未加密存储    | 敏感信息泄露   |
| P1-6  | chatRoutes.ts        | SSE流式响应缺少超时控制   | 资源耗尽       |
| P1-7  | coreRoutes.ts        | 敏感API缺少权限分级       | 权限提升       |
| P1-8  | FileSystem.ts        | 文件操作缺少路径安全检查  | 路径遍历       |
| P1-9  | SnapshotStorage      | 快照数据缺少加密          | 敏感信息泄露   |
| P1-10 | SystemInput.ts       | 键盘/鼠标模拟缺少频率限制 | 操作滥用       |
| P1-11 | mcpRoutes.ts         | 工具调用参数缺少输入验证  | 注入攻击       |
| P1-12 | memoryRoutes.ts      | 用户画像数据缺少脱敏      | 隐私泄露       |

### 一般问题 (P2 — 建议改进)

| #     | 文件                    | 问题                       |
| ----- | ----------------------- | -------------------------- |
| P2-1  | EmotionAnalyzer         | 情绪关键词硬编码           |
| P2-2  | SpeechRecognizer        | 缺少降级策略               |
| P2-3  | SceneRecognizer         | 场景识别规则硬编码         |
| P2-4  | MultimodalInput         | 输入数据未做大小限制       |
| P2-5  | ScreenCapture           | 截图数据未做大小限制       |
| P2-6  | DesktopWorkflowRecorder | 工作流可能包含敏感操作序列 |
| P2-7  | GatewayBridge           | 消息转发缺少速率限制       |
| P2-8  | 适配器(多个)            | 消息发送失败缺少重试机制   |
| P2-9  | WeChatQRAdapter         | 二维码登录缺少超时处理     |
| P2-10 | authMiddleware          | 缺少token刷新机制          |
| P2-11 | websocket               | 连接数未做限制             |
| P2-12 | docsRoutes              | 静态文件服务需防路径遍历   |

### 测试覆盖评估

| 层           | 测试文件数 | 测试用例数 | 覆盖评估                                |
| ------------ | ---------- | ---------- | --------------------------------------- |
| 多模态层     | 0          | 0          | ❌ 无测试                               |
| 桌面自动化层 | 2-3        | 30+        | ⚠️ ScreenCapture/WorkflowRecorder有测试 |
| 集成网关层   | 2-3        | 20+        | ⚠️ MultiPlatformGateway/MCP有测试       |
| API路由层    | 3-4        | 40+        | ⚠️ 部分路由有注入测试                   |

---

## 修复优先级建议

### 第一批：P0安全修复 (1-2天)

1. **P0-1**: chatRoutes — 添加速率限制中间件（express-rate-limit）
2. **P0-2**: chatRoutes — 添加请求体字段验证（zod/joi）
3. **P0-3**: integrationRoutes — Webhook URL添加SSRF防护（禁止内网IP）
4. **P0-4**: authMiddleware — JWT密钥从环境变量读取，强制最小长度
5. **P0-5**: websocket — 添加认证握手验证
6. **P0-6**: evolutionRoutes — 添加requireAuth中间件
7. **P0-7**: skillRoutes — 添加权限校验
8. **P0-8**: debugRoutes — 添加环境检查，生产环境禁用
9. **P0-9**: 平台适配器 — Webhook URL格式校验+SSRF防护
10. **P0-10**: DesktopActionExecutor — 添加操作权限校验

### 第二批：P1架构修复 (2-3天)

1. **P1-1/P1-2**: 文件拆分 — InteractionEngine/integrationRoutes
2. **P1-3**: automationRoutes — 消除any类型
3. **P1-4**: MultiPlatformGateway — 适配器注册验证
4. **P1-5**: IntegrationManager — Token加密存储
5. **P1-6**: chatRoutes — SSE超时控制
6. **P1-7**: coreRoutes — 权限分级
7. **P1-8**: FileSystem — 路径安全检查
8. **P1-9**: SnapshotStorage — 数据加密
9. **P1-10**: SystemInput — 操作频率限制
10. **P1-11**: mcpRoutes — 工具调用参数验证
11. **P1-12**: memoryRoutes — 用户画像脱敏

### 第三批：P2改进 (1-2天)

1. 统一配置管理（消除硬编码常量）
2. 完善测试覆盖
3. 添加缓存降级策略
4. 路径安全加固

---

## 与前次审计的关联

前两次审计已修复：

- 第一批（入口层+核心引擎+Harness六层）：P0全部6项 ✅，P1全部10项 ✅
- 第二批（编排层+LLM模型层+记忆层+进化层）：P0全部6项 ✅，P1全部6项 ✅

本次审计发现的P0问题（API安全漏洞、SSRF、认证缺失等）是面向外部的安全威胁，比前两次更紧迫，需优先处理。
