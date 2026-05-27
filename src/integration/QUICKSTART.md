# 🚀 集成网关快速启动指南

## 📖 5分钟快速上手

### 第一步：配置凭证

在项目根目录的 `.env` 文件中添加以下配置：

```env
# ==================== 微信配置 ====================
WECHAT_APP_ID=your_wechat_app_id
WECHAT_APP_SECRET=your_wechat_app_secret
WECHAT_TOKEN=your_wechat_token
WECHAT_ENCODING_AES_KEY=your_wechat_aes_key

# ==================== 飞书配置 ====================
FEISHU_APP_ID=your_feishu_app_id
FEISHU_APP_SECRET=your_feishu_app_secret
FEISHU_VERIFICATION_TOKEN=your_feishu_verification_token

# ==================== 钉钉配置 ====================
DINGTALK_CLIENT_ID=your_dingtalk_client_id
DINGTALK_CLIENT_SECRET=your_dingtalk_client_secret
```

### 第二步：启动服务

```bash
# 启动后端服务
cd c:\zy\jiabaixing
npm start
```

服务启动后，应该看到：

```
🚀 服务器已启动: http://localhost:3001
🎯 API 文档: http://localhost:3001/api/docs
🤝 集成网关已就绪
```

### 第三步：访问前端

打开浏览器访问：

```
http://localhost:3000
```

在左侧菜单中找到 **"集成管理"** 面板。

### 第四步：连接平台

#### 方式一：UI 操作

1. 打开"集成管理"面板
2. 点击要连接的平台（微信/飞书/钉钉）卡片
3. 点击 **"连接"** 按钮
4. 填写平台凭证信息
5. 点击 **"确认"**

#### 方式二：API 操作

**连接微信：**
```bash
curl -X POST http://localhost:3001/api/integration/wechat/connect \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "appId": "your_app_id",
      "appSecret": "your_app_secret",
      "token": "your_token"
    }
  }'
```

**连接飞书：**
```bash
curl -X POST http://localhost:3001/api/integration/feishu/connect \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "appId": "your_app_id",
      "appSecret": "your_app_secret"
    }
  }'
```

**连接钉钉：**
```bash
curl -X POST http://localhost:3001/api/integration/dingtalk/connect \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "clientId": "your_client_id",
      "clientSecret": "your_client_secret"
    }
  }'
```

## 🔧 常见平台配置

### 微信公众平台

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入 **开发 → 基本配置**
3. 记录 **AppID** 和 **AppSecret**
4. 配置服务器地址（URL）：
   ```
   https://your-domain.com/api/integration/wechat/webhook
   ```
5. 设置 **Token** 和 **EncodingAESKey**
6. 启用服务器配置

### 飞书开放平台

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建 **企业自建应用**
3. 获取 **App ID** 和 **App Secret**
4. 配置事件订阅：
   ```
   https://your-domain.com/api/integration/feishu/webhook
   ```
5. 添加权限：
   - `im:message`
   - `im:message.receive_v1`

### 钉钉开放平台

1. 登录 [钉钉开放平台](https://open.dingtalk.com/)
2. 创建 **企业内部应用**
3. 获取 **Client ID** 和 **Client Secret**
4. 添加机器人：
   ```
   https://your-domain.com/api/integration/dingtalk/webhook
   ```
5. 配置机器人能力

## 📡 测试连接

### 获取平台列表

```bash
curl http://localhost:3001/api/integration/platforms
```

### 查看连接状态

```bash
# 查看微信状态
curl http://localhost:3001/api/integration/wechat/status

# 查看飞书状态
curl http://localhost:3001/api/integration/feishu/status

# 查看钉钉状态
curl http://localhost:3001/api/integration/dingtalk/status
```

### 发送测试消息

```bash
curl -X POST http://localhost:3001/api/integration/wechat/send \
  -H "Content-Type: application/json" \
  -d '{
    "message": "你好，测试消息！",
    "messageType": "text",
    "to": "recipient_openid"
  }'
```

## 🐛 快速故障排查

### 连接失败？

检查清单：
- [ ] 凭证信息是否正确
- [ ] 网络是否畅通
- [ ] 平台 API 是否可用
- [ ] 查看后端日志

查看日志：
```bash
# Windows
type logs\app.log | select -last 50

# 或实时监控
Get-Content logs\app.log -Wait -Tail 50
```

### 消息收不到？

检查清单：
- [ ] Webhook URL 是否可访问
- [ ] 是否已启用事件订阅
- [ ] 签名验证是否通过
- [ ] 权限是否配置正确

### 消息发不出？

检查清单：
- [ ] 接收方 ID 是否正确
- [ ] API 权限是否足够
- [ ] 消息格式是否正确
- [ ] 账户是否欠费（某些平台）

## 📚 下一步

- 📖 阅读完整文档：[集成网关使用指南](./README.md)
- 🔨 查看开发指南：如何添加新平台
- 💡 探索高级功能：事件处理、消息队列
- 🤝 加入社区：分享你的集成案例

## 💬 获取帮助

遇到问题？
1. 查看日志文件 `logs/app.log`
2. 参考 [完整文档](./README.md)
3. 查看 [故障排查章节](./README.md#故障排查)
4. 联系开发团队

---

**快速链接：**
- [完整使用指南](./README.md)
- [API 参考](./README.md#api-参考)
- [开发指南](./README.md#开发指南)
- [常见问题](./README.md#故障排查)
