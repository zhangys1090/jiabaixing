# 集成网关使用指南

## 📋 概述

集成网关是 Jiabaixing V5.0 的核心功能之一，允许系统与多个第三方平台（微信、飞书、钉钉）建立连接，实现消息收发和交互功能。

## 🎯 功能特性

### 支持的平台

1. **💬 微信 (WeChat)**
   - 公众号/企业微信消息接收
   - 消息自动回复
   - 素材管理

2. **✈️ 飞书 (Feishu/Lark)**
   - 企业应用集成
   - 消息事件订阅
   - 多端消息同步

3. **🔔 钉钉 (DingTalk)**
   - 企业内部应用
   - 机器人消息
   - 群消息管理

## 🚀 快速开始

### 1. 配置平台凭证

每个平台都需要在对应的配置文件中设置凭证信息。

#### 微信配置

在环境变量或配置文件中设置：

```bash
# 微信公众平台配置
WECHAT_APP_ID=your_app_id
WECHAT_APP_SECRET=your_app_secret
WECHAT_TOKEN=your_token
WECHAT_ENCODING_AES_KEY=your_aes_key
```

#### 飞书配置

```bash
# 飞书应用配置
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
FEISHU_VERIFICATION_TOKEN=your_verification_token
FEISHU_ENCRYPT_KEY=your_encrypt_key  # 可选
```

#### 钉钉配置

```bash
# 钉钉应用配置
DINGTALK_CLIENT_ID=your_client_id
DINGTALK_CLIENT_SECRET=your_client_secret
DINGTALK_SIGNATURE_SECRET=your_signature_secret  # 可选
```

### 2. 启动后端服务

```bash
# 启动后端网关
cd c:\zy\jiabaixing
npm start
```

后端服务将启动在配置的端口（默认 3001）。

### 3. 访问前端界面

打开浏览器访问前端界面：

```
http://localhost:3000
```

导航到"集成管理"面板（IntegrationPanel）。

### 4. 连接平台

#### 通过 UI 连接

1. 打开集成管理面板
2. 选择要连接的平台（微信/飞书/钉钉）
3. 点击"连接"按钮
4. 填写平台配置信息
5. 点击"确认"完成连接

#### 通过 API 连接

```bash
# 连接微信
curl -X POST http://localhost:3001/api/integration/wechat/connect \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "appId": "your_app_id",
      "appSecret": "your_app_secret",
      "token": "your_token"
    }
  }'

# 连接飞书
curl -X POST http://localhost:3001/api/integration/feishu/connect \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "appId": "your_app_id",
      "appSecret": "your_app_secret",
      "verificationToken": "your_token"
    }
  }'

# 连接钉钉
curl -X POST http://localhost:3001/api/integration/dingtalk/connect \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "clientId": "your_client_id",
      "clientSecret": "your_client_secret"
    }
  }'
```

## 📡 API 参考

### 获取平台列表

```bash
GET /api/integration/platforms
```

响应示例：
```json
{
  "success": true,
  "data": {
    "platforms": [
      {
        "id": "wechat",
        "name": "微信",
        "icon": "💬",
        "description": "微信公众平台/企业微信集成",
        "features": ["消息接收", "消息发送", "事件订阅"],
        "status": "disconnected",
        "available": true
      }
    ]
  }
}
```

### 获取平台状态

```bash
GET /api/integration/:platform/status
```

参数：
- `platform`: 平台标识（wechat/feishu/dingtalk）

响应示例：
```json
{
  "success": true,
  "data": {
    "status": {
      "platform": "wechat",
      "connected": true,
      "status": "connected",
      "lastConnectedAt": "2026-05-18T10:30:00.000Z"
    }
  }
}
```

### 断开平台连接

```bash
POST /api/integration/:platform/disconnect
```

响应示例：
```json
{
  "success": true,
  "data": {
    "success": true,
    "platform": "wechat"
  }
}
```

### 发送消息

```bash
POST /api/integration/:platform/send
```

请求体：
```json
{
  "message": "你好，这是测试消息",
  "messageType": "text",
  "to": "recipient_id",
  "metadata": {}
}
```

响应示例：
```json
{
  "success": true,
  "data": {
    "success": true,
    "messageId": "msg_123456789",
    "timestamp": "2026-05-18T10:35:00.000Z"
  }
}
```

### Webhook 回调

```bash
POST /api/integration/:platform/webhook
```

接收来自各平台的事件通知（消息、事件等）。

## 🔧 高级配置

### Webhook 配置

每个平台都需要配置 Webhook URL 以接收事件通知：

#### 微信 Webhook URL

```
https://your-domain.com/api/integration/wechat/webhook
```

配置步骤：
1. 登录微信公众平台
2. 进入"开发" -> "基本配置"
3. 填写服务器配置
4. 设置 URL、Token、EncodingAESKey
5. 启用服务器配置

#### 飞书 Webhook URL

```
https://your-domain.com/api/integration/feishu/webhook
```

配置步骤：
1. 登录飞书开放平台
2. 创建企业自建应用
3. 配置消息事件订阅
4. 设置请求地址
5. 配置权限

#### 钉钉 Webhook URL

```
https://your-domain.com/api/integration/dingtalk/webhook
```

配置步骤：
1. 登录钉钉开放平台
2. 创建企业内部应用
3. 配置机器人
4. 设置签名密钥
5. 配置消息订阅

### 事件处理

系统通过 EventBus 处理接收到的平台事件：

```typescript
// 监听集成消息事件
EventBus.on('integration_message', (payload) => {
  console.log('收到平台消息:', payload);
});

// 监听连接事件
EventBus.on('integration_connected', (payload) => {
  console.log('平台已连接:', payload);
});

// 监听断开事件
EventBus.on('integration_disconnected', (payload) => {
  console.log('平台已断开:', payload);
});
```

## 🐛 故障排查

### 常见问题

#### 1. 连接失败

**症状**：平台连接失败，显示错误信息

**排查步骤**：
1. 检查凭证信息是否正确
2. 确认网络连接
3. 验证 Webhook URL 是否可访问
4. 检查防火墙设置

#### 2. 消息接收不到

**症状**：平台发送消息但系统未响应

**排查步骤**：
1. 确认 Webhook 已正确配置
2. 检查平台服务器配置
3. 验证消息签名验证
4. 查看日志文件

#### 3. 消息发送失败

**症状**：发送消息返回错误

**排查步骤**：
1. 检查 API 权限
2. 确认接收方 ID 正确
3. 验证消息格式
4. 查看错误日志

### 日志查看

```bash
# 查看集成相关日志
tail -f logs/integration.log

# 查看所有日志
tail -f logs/app.log
```

## 📖 开发指南

### 架构设计

```
┌─────────────────┐
│   前端 UI       │  IntegrationPanel
└────────┬────────┘
         │ HTTP/WebSocket
         ▼
┌─────────────────┐
│   API 网关      │  Express Router
│  /api/integration/*
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Integration    │ IntegrationManager
│    Manager      │  (单例模式)
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌────────┐
│ WeChat │ │ Feishu │
│Adapter │ │Adapter │
└────────┘ └────────┘
    │
    ▼
┌────────┐
│DingTalk│
│Adapter │
└────────┘
```

### 添加新平台

1. **创建适配器**：

```typescript
// src/integration/adapters/NewPlatformAdapter.ts
import { BaseIntegrationAdapter } from './BaseIntegrationAdapter';
import {
  PlatformConfig,
  SendMessageResponse,
  IncomingMessageEvent,
} from '../../shared/contracts';

export class NewPlatformAdapter extends BaseIntegrationAdapter {
  constructor() {
    super('newplatform');
  }

  async connect(config: PlatformConfig): Promise<boolean> {
    // 实现连接逻辑
    return true;
  }

  async disconnect(): Promise<void> {
    // 实现断开逻辑
  }

  async sendMessage(
    message: string,
    to?: string,
    imageUrls?: string[],
    mentions?: string[]
  ): Promise<SendMessageResponse> {
    // 实现发送逻辑
    return { success: true };
  }

  async handleWebhook(payload: Record<string, unknown>): Promise<{ success: boolean }> {
    // 实现 Webhook 处理逻辑
    return { success: true };
  }
}
```

2. **注册到管理器**：

编辑 `src/integration/IntegrationManager.ts`：

```typescript
import { NewPlatformAdapter } from './adapters/NewPlatformAdapter';

// 在构造函数中添加
this.adapters.set('newplatform', new NewPlatformAdapter());
```

3. **添加平台信息**：

编辑 `PLATFORM_INFO` 常量：

```typescript
const PLATFORM_INFO = {
  // ... 其他平台
  newplatform: {
    id: 'newplatform',
    name: '新平台',
    icon: '🔗',
    description: '新平台描述',
    features: ['功能1', '功能2'],
  },
};
```

4. **添加类型定义**：

在 `src/shared/contracts.ts` 中添加：

```typescript
export type IntegrationPlatform = 'wechat' | 'feishu' | 'dingtalk' | 'newplatform';
```

## 📝 示例代码

### 完整使用示例

```typescript
import { IntegrationManager } from './integration/IntegrationManager';
import { EventBus } from './shared/EventBus';

// 获取单例实例
const integrationManager = IntegrationManager.getInstance();

// 监听消息
EventBus.on('integration_message', (payload) => {
  console.log('收到消息:', payload);
  // 处理消息逻辑
});

// 连接平台
await integrationManager.connect('wechat', {
  appId: 'your_app_id',
  appSecret: 'your_app_secret',
  token: 'your_token',
});

// 发送消息
await integrationManager.sendMessage({
  platform: 'wechat',
  message: 'Hello from Jiabaixing!',
  messageType: 'text',
  to: 'recipient_openid',
});

// 断开连接
await integrationManager.disconnect('wechat');
```

### React 组件使用

```typescript
import React, { useEffect } from 'react';
import { IntegrationPanel } from './components/IntegrationPanel';

function App() {
  return (
    <div className="app">
      <h1>Jiabaixing 集成管理</h1>
      <IntegrationPanel />
    </div>
  );
}

export default App;
```

## 🔒 安全建议

1. **凭证管理**
   - 使用环境变量存储敏感信息
   - 定期轮换 API 密钥
   - 不要将凭证提交到代码仓库

2. **Webhook 安全**
   - 验证消息签名
   - 使用 HTTPS
   - 限制 IP 访问

3. **消息验证**
   - 验证消息来源
   - 检查消息格式
   - 防止注入攻击

## 📞 技术支持

如遇到问题，请查看：
1. 日志文件：`logs/` 目录
2. 控制台输出
3. 平台开发者文档

## 📄 许可证

本项目遵循 Jiabaixing V5.0 许可证协议。

---

**版本**: 1.0.0  
**最后更新**: 2026-05-18  
**维护者**: Jiabaixing 开发团队
