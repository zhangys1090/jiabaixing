# Jiabaixing 家百星 · 5 分钟上手

> 让 AI 成为你的私人秘书 — 有记忆、能主动、会进化

## 1️⃣ 一键安装

```bash
# 在项目目录下执行
bash install.sh
```

脚本会自动：
- 检查 Node.js 环境（需要 >= 20.x）
- 安装 npm 依赖 + 编译 better-sqlite3
- 引导你配置 API Key
- 启动测试验证对话成功

## 2️⃣ 启动

```bash
# 一键启动（后端 + 前端）
./run.sh

# 或仅后端
./run.sh --no-frontend
```

启动后访问:
- API:  `http://localhost:3111`
- 前端: `http://localhost:3111/`

## 3️⃣ 对话

用 curl 测试：

```bash
# 健康检查
curl http://localhost:3111/api/health

# 发送消息
curl -X POST http://localhost:3111/api/process \
  -H "Content-Type: application/json" \
  -d '{"input":"帮我看看当前目录有什么文件"}'
```

或打开浏览器访问 `http://localhost:3111/` 使用前端界面。

## 4️⃣ CLI 模式

后端启动后，另开终端：

```bash
npm run cli
```

CLI 命令：
| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/status` | 系统状态 |
| `/model` | 当前模型信息 |
| `/skills` | 技能列表 |
| `/memory` | 记忆统计 |
| `/evolution` | 进化数据 |
| `/env` | 桌面环境 |
| `/gateway` | 平台连接配置 |
| `/schedule` | 定时任务管理 |
| `/config` | 系统配置 |
| `/clear` | 清屏 |
| `/quit` | 退出 |

直接输入文字即可与 AI 对话。

## 5️⃣ 配置

编辑 `.env` 文件配置 LLM：

```env
# 小米 MiMo（推荐，1M 上下文）
XIAOMI_API_KEY=tp-crt...y731
XIAOMI_MODEL=mimo-v2.5-pro

# 或 DeepSeek
DEEPSEEK_API_KEY=sk-...
LLM_MODEL=deepseek-chat
```

## 6️⃣ 运行测试

```bash
npm test                    # 全部测试
npm run test:watch          # 监听模式
npm run test:coverage       # 覆盖率
npm run eval                # 评估套件
```

## 7️⃣ 常见问题

**Q: better-sqlite3 编译失败？**
```bash
npm run fix:native
```

**Q: 端口被占用？**
脚本会自动尝试下一个端口。或手动指定：
```bash
PORT=3131 ./run.sh
```

**Q: WSL 下启动报错？**
确保 PATH 完整，或直接使用 `./run.sh`：

**Q: 前端页面白屏？**
确保 `src/frontend/build/` 存在。如不存在：
```bash
cd src/frontend && npm run build:fast
```

---

> 完整文档见 [PROJECT.md](./PROJECT.md) 和 [CLAUDE.md](./CLAUDE.md)
