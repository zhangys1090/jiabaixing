# Jiabaixing 全功能测试任务清单

## 说明

以下是针对 Jiabaixing V5.0 所有主要模块的测试任务清单。每个测试任务都包含：
- **目标**: 测试什么功能
- **步骤**: 具体操作
- **预期结果**: 应该看到什么
- **验证**: 如何确认通过

---

## 模块 1：集成网关（核心新增功能）

### 1.1 QQ 适配器连接测试
**目标**: 验证 QQ 通过 Mirai 连接
**前置条件**: 本地已启动 Mirai Console + mirai-api-http
- [ ] 启动后端服务 `npm start`
- [ ] 调用 API 连接 QQ：
  ```bash
  curl -X POST http://localhost:3001/api/integration/qq/connect \
    -H "Content-Type: application/json" \
    -d '{"config":{"miraiHttpHost":"localhost","miraiHttpPort":"8080","miraiVerifyKey":"your_verify_key","qqAccount":"123456789"}}'
  ```
- [ ] 预期：返回 `{"success":true,"data":{"success":true,"platform":"qq","status":"connected"}}`
- [ ] 验证：前端集成面板显示 QQ 图标（🐧）和"已连接"状态

### 1.2 QQ 消息发送测试
**目标**: 验证通过 Jiabaixing 向 QQ 好友发送消息
- [ ] QQ 适配器已连接
- [ ] 调用 API：
  ```bash
  curl -X POST http://localhost:3001/api/integration/qq/send \
    -H "Content-Type: application/json" \
    -d '{"platform":"qq","message":"你好，这是 Jiabaixing 的测试消息","to":"好友QQ号"}'
  ```
- [ ] 预期：好友收到消息，API 返回 messageId
- [ ] 验证：消息日志面板显示发出的消息

### 1.3 QQ 群消息测试
**目标**: 验证群消息发送
- [ ] QQ 适配器已连接
- [ ] 发送群消息（to 以 `g` 或 `group_` 开头）：
  ```bash
  curl -X POST http://localhost:3001/api/integration/qq/send \
    -H "Content-Type: application/json" \
    -d '{"platform":"qq","message":"大家好！","to":"g12345678"}'
  ```
- [ ] 预期：群内收到消息

### 1.4 QQ 断开连接测试
**目标**: 验证断开连接的正确性
- [ ] 调用 API：
  ```bash
  curl -X POST http://localhost:3001/api/integration/qq/disconnect
  ```
- [ ] 预期：状态变为 "disconnected"，Mirai session 被释放
- [ ] 验证：前端面板显示"未连接"

### 1.5 微信适配器测试
**目标**: 验证微信企业号/公众号连接
- [ ] 调用 API：
  ```bash
  curl -X POST http://localhost:3001/api/integration/wechat/connect \
    -H "Content-Type: application/json" \
    -d '{"config":{"appId":"demo","appSecret":"demo","token":"demo"}}'
  ```
- [ ] 预期：返回 connected
- [ ] 验证：前端显示微信已连接

### 1.6 飞书适配器测试
**目标**: 验证飞书平台连接
- [ ] 调用 API：
  ```bash
  curl -X POST http://localhost:3001/api/integration/feishu/connect \
    -H "Content-Type: application/json" \
    -d '{"config":{"appId":"demo","appSecret":"demo"}}'
  ```
- [ ] 预期：返回 connected

### 1.7 钉钉适配器测试
**目标**: 验证钉钉平台连接
- [ ] 调用 API：
  ```bash
  curl -X POST http://localhost:3001/api/integration/dingtalk/connect \
    -H "Content-Type: application/json" \
    -d '{"config":{"appId":"demo","appSecret":"demo"}}'
  ```
- [ ] 预期：返回 connected

### 1.8 多平台同时连接测试
**目标**: 验证多个平台可同时连接
- [ ] 依次连接微信、飞书、钉钉、QQ
- [ ] 调用：`curl http://localhost:3001/api/integration/platforms`
- [ ] 预期：返回 4 个平台，状态均为 connected
- [ ] 验证：前端显示所有平台已连接

### 1.9 Webhook 处理测试
**目标**: 验证微信 Webhook 消息处理链
- [ ] 模拟微信推送消息：
  ```bash
  curl -X POST http://localhost:3001/api/integration/wechat/webhook \
    -H "Content-Type: application/json" \
    -d '{"msgtype":"text","content":"测试消息","fromusername":"user_001"}'
  ```
- [ ] 预期：返回 `{"success":true}`
- [ ] 验证：日志显示"收到来自 wechat 的消息"

### 1.10 EventBus 事件广播测试
**目标**: 验证集成消息通过 EventBus 广播到整个系统
- [ ] 触发 Webhook 后检查日志
- [ ] 预期：看到 `integration_message` 事件被触发
- [ ] 验证：事件包含 platform/type/content 等完整信息

---

## 模块 2：核心引擎

### 2.1 基础对话测试
**目标**: 验证 LLM 对话能力
- [ ] 发送对话请求：
  ```bash
  curl -X POST http://localhost:3001/api/process \
    -H "Content-Type: application/json" \
    -d '{"input":"你好，请介绍一下你自己"}'
  ```
- [ ] 预期：返回 response 字段，内容合理

### 2.2 任务执行测试
**目标**: 验证任务执行流程
- [ ] 发送任务指令：
  ```bash
  curl -X POST http://localhost:3001/api/process \
    -H "Content-Type: application/json" \
    -d '{"input":"帮我列出当前目录的文件"}'
  ```
- [ ] 预期：返回文件列表或执行结果

### 2.3 WebSocket 实时通信测试
**目标**: 验证 WebSocket 双向通信
- [ ] 使用 wscat 连接：`wscat -c ws://localhost:3001`
- [ ] 发送消息：`{"type":"user_input","payload":{"input":"你好"}}`
- [ ] 预期：收到 type 为 "response_ready" 的响应

### 2.4 长文本处理测试
**目标**: 验证长输入处理
- [ ] 发送 1000 字以上的输入
- [ ] 预期：正常处理，不被截断

---

## 模块 3：记忆系统

### 3.1 记忆存储测试
**目标**: 验证记忆写入
- [ ] 调用 API：
  ```bash
  curl -X POST http://localhost:3001/api/memory/store \
    -H "Content-Type: application/json" \
    -d '{"content":"测试记忆内容","type":"test","tags":["test"]}'
  ```
- [ ] 预期：返回 success

### 3.2 记忆检索测试
**目标**: 验证记忆搜索
- [ ] 调用：
  ```bash
  curl -X GET "http://localhost:3001/api/memory/search?query=测试"
  ```
- [ ] 预期：返回之前存储的记忆

### 3.3 记忆统计测试
**目标**: 验证记忆统计分析
- [ ] 调用：`curl http://localhost:3001/api/memory/stats`
- [ ] 预期：返回记忆条数、类型分布等统计信息

---

## 模块 4：进化系统

### 4.1 进化状态查询测试
**目标**: 验证进化引擎状态
- [ ] 调用：`curl http://localhost:3001/api/evolution/status`
- [ ] 预期：返回 evolution engine 当前的运行状态

### 4.2 进化指标查询测试
**目标**: 验证进化指标数据
- [ ] 调用：`curl http://localhost:3001/api/evolution/metrics`
- [ ] 预期：返回可量化的进化指标

### 4.3 自我修复触发测试
**目标**: 验证自愈引擎
- [ ] 调用：
  ```bash
  curl -X POST http://localhost:3001/api/evolution/healing \
    -H "Content-Type: application/json" \
    -d '{"scope":"test"}'
  ```
- [ ] 预期：返回 healing 结果

---

## 模块 5：安全系统

### 5.1 安全审计日志测试
**目标**: 验证安全审计日志记录
- [ ] 调用：`curl http://localhost:3001/api/security/logs`
- [ ] 预期：返回安全事件日志列表

### 5.2 输入验证测试
**目标**: 验证 API 输入安全
- [ ] 发送恶意输入：
  ```bash
  curl -X POST http://localhost:3001/api/process \
    -H "Content-Type: application/json" \
    -d '{"input":"<script>alert(1)</script>"}'
  ```
- [ ] 预期：安全处理，不执行注入代码

---

## 模块 6：桌面控制

### 6.1 桌面截图测试
**目标**: 验证桌面截图功能
- [ ] 在 DesktopPanel UI 中点击截图按钮
- [ ] 预期：返回当前屏幕截图

### 6.2 桌面自动化测试
**目标**: 验证桌面操作执行
- [ ] 发送桌面操作指令（如 "打开计算器"）
- [ ] 预期：桌面执行相应操作

---

## 模块 7：技能系统

### 7.1 技能列表测试
**目标**: 验证技能注册
- [ ] 调用：`curl http://localhost:3001/api/skills/list`
- [ ] 预期：返回已注册的所有技能列表

### 7.2 技能执行测试
**目标**: 验证技能执行
- [ ] 调用：
  ```bash
  curl -X POST http://localhost:3001/api/skills/execute \
    -H "Content-Type: application/json" \
    -d '{"skillName":"SearchSkill","params":{"query":"测试"}}'
  ```
- [ ] 预期：技能执行并返回结果

### 7.3 前端控制台技能测试
**目标**: 验证前端 SkillConsole 组件
- [ ] 打开前端 SkillConsole 面板
- [ ] 选择一个技能并执行
- [ ] 预期：技能结果在前端显示

---

## 模块 8：调度器与自动化

### 8.1 自动化任务列表测试
**目标**: 验证自动化任务查询
- [ ] 调用：`curl http://localhost:3001/api/automation/tasks`
- [ ] 预期：返回自动化任务列表

### 8.2 场景触发测试
**目标**: 验证场景识别自动触发
- [ ] 模拟场景识别事件
- [ ] 预期：调度器根据场景自动触发任务

---

## 模块 9：Harness Agent 框架

### 9.1 Agent 状态查询测试
**目标**: 验证 Harness 框架状态
- [ ] 调用：`curl http://localhost:3001/api/v1/agent/status`
- [ ] 预期：返回 Agent 当前状态信息

### 9.2 Agent 执行链路测试
**目标**: 验证 Agent 执行完整链路追踪
- [ ] 发送需要在 Harness 中执行的复杂任务
- [ ] 预期：traceId 贯穿整个执行过程

---

## 模块 10：前端 UI 测试

### 10.1 集成管理面板 UI 测试
**目标**: 验证 IntegrationPanel 完整交互
- [ ] 打开前端页面（http://localhost:3000）
- [ ] 左侧菜单找到"集成管理"面板
- [ ] **操作**：查看平台卡片
  - [ ] 显示 4 个平台（微信、飞书、钉钉、QQ）
  - [ ] 每个卡片有图标、名称、描述、状态
- [ ] **操作**：点击 QQ 的"连接"按钮
  - [ ] 弹出配置表单，包含 5 个字段
  - [ ] 填写 Mirai 配置信息
  - [ ] 点击"确认"
- [ ] **操作**：切换到"消息日志"标签
  - [ ] 显示消息列表或"暂无消息记录"
- [ ] **验证**：配置表单能正确提交，状态能更新

### 10.2 其他面板可用性测试
**目标**: 验证所有面板可正常打开
- [ ] 依次点击所有面板标签：
  - [ ] ChatInterface（对话界面）
  - [ ] AgentExecutionPanel（代理执行）
  - [ ] AutomationPanel（自动化）
  - [ ] DesktopPanel（桌面控制）
  - [ ] EvolutionPanel（进化）
  - [ ] SecurityPanel（安全）
  - [ ] MemoryPanel（记忆）
  - [ ] MonitorPanel（监控）
  - [ ] SettingsPanel（设置）
  - [ ] SkillConsole（技能控制台）
  - [ ] PerformancePanel（性能）
- [ ] 预期：每个面板正常渲染，无白屏

### 10.3 对话界面测试
**目标**: 验证前端与后端通信
- [ ] 在 ChatInterface 中输入消息
- [ ] 点击发送
- [ ] 预期：消息显示在对话中，后端返回响应

### 10.4 前端状态栏测试
**目标**: 验证前端状态显示
- [ ] 查看主界面底部的状态栏
- [ ] 预期：显示当前连接状态、系统信息

---

## 模块 11：系统集成测试

### 11.1 健康检查测试
**目标**: 验证完整系统健康
- [ ] 调用：`curl http://localhost:3001/api/health`
- [ ] 预期：返回所有服务的健康状态：
  ```json
  {
    "status": "healthy",
    "services": {
      "websocket": {"status": "ok"},
      "core": {"status": "ok"},
      "llm": {"status": "ok"},
      "memory": {"status": "ok"}
    }
  }
  ```

### 11.2 日志流测试
**目标**: 验证日志系统
- [ ] 通过 WebSocket 订阅日志：`{"type":"subscribe_logs"}`
- [ ] 在系统中执行一些操作
- [ ] 预期：实时收到 server_log 事件

### 11.3 端到端消息流测试
**目标**: 验证完整的消息处理链路
**链路**: Webhook → Adapter → IntegrationManager → EventBus → 前端
- [x] 步骤 1: 发送 Webhook 到微信
  ```bash
  curl -X POST http://localhost:3001/api/integration/wechat/webhook \
    -H "Content-Type: application/json" \
    -d '{"msgtype":"text","content":"测试消息","fromusername":"user_001"}'
  ```
- [x] 步骤 2: 后端日志显示消息被处理
- [x] 步骤 3: EventBus 触发 integration_message 事件
- [x] 步骤 4: 通过 WebSocket 推送到前端
- [ ] **验证**：前端消息日志面板显示该消息

### 11.4 错误恢复测试
**目标**: 验证系统在异常情况下的稳定性
- [ ] 在不启动 Mirai 的情况下尝试连接 QQ
- [ ] 预期：优雅报错，不崩溃
- [ ] 启动 Mirai 后再次连接
- [ ] 预期：连接成功

### 11.5 性能基础测试
**目标**: 验证系统基本性能
- [ ] 调用：`curl http://localhost:3001/api/performance/snapshot`
- [ ] 预期：返回内存使用、CPU 负载等数据

---

## 测试结果记录模板

```
## 测试日期: YYYY-MM-DD
## 测试者: [姓名]

### 模块 1：集成网关
- [ ] 1.1 QQ 连接: PASS / FAIL / SKIP
  - 备注: [如果失败，写明原因]
- [ ] 1.2 QQ 消息发送: PASS / FAIL / SKIP
  - 备注:

### 模块 2：核心引擎
- [ ] 2.1 基础对话: PASS / FAIL
  - 备注:
...

### 总体统计
- 总测试数: XX
- 通过: XX
- 失败: XX
- 跳过: XX
- 通过率: XX%
```

---

## 快速执行脚本

将所有集成 API 测试一次性执行：

```powershell
# 1. 健康检查
Invoke-RestMethod -Uri http://localhost:3001/api/health

# 2. 获取平台列表
Invoke-RestMethod -Uri http://localhost:3001/api/integration/platforms

# 3. 连接所有平台（模拟）
$platforms = @("wechat","feishu","dingtalk")
foreach ($p in $platforms) {
  $body = @{config=@{appId="demo";appSecret="demo"}} | ConvertTo-Json
  Invoke-RestMethod -Uri "http://localhost:3001/api/integration/$p/connect" -Method Post -Body $body -ContentType "application/json"
}

# 4. 连接 QQ（需要 Mirai 运行中）
$qqBody = @{config=@{miraiHttpHost="localhost";miraiHttpPort="8080";miraiVerifyKey="your_key";qqAccount="123456"}} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3001/api/integration/qq/connect" -Method Post -Body $qqBody -ContentType "application/json"

# 5. 获取所有平台状态
Invoke-RestMethod -Uri http://localhost:3001/api/integration/platforms

# 6. 发送测试 Webhook
$whBody = @{msgtype="text";content="测试消息";fromusername="user_001"} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3001/api/integration/wechat/webhook" -Method Post -Body $whBody -ContentType "application/json"

# 7. 断开连接
foreach ($p in @("wechat","feishu","dingtalk","qq")) {
  Invoke-RestMethod -Uri "http://localhost:3001/api/integration/$p/disconnect" -Method Post
}
```

---

## 优先级说明

| 优先级 | 测试内容 | 说明 |
|--------|---------|------|
| P0 | 1.1-1.4, 11.1, 10.1 | **核心集成功能**，必须先通过 |
| P1 | 1.5-1.10, 2.1-2.3, 10.2-10.3 | **主要功能**，必须全部通过 |
| P2 | 3.1-3.3, 7.1-7.3, 10.4 | **辅助功能**，建议全部通过 |
| P3 | 4.1-4.3, 5.1-5.2, 8.1-8.2, 9.1-9.2, 11.2-11.5 | **增强功能**，按需测试 |
