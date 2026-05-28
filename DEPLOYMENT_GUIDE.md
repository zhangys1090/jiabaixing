# Jiabaixing V5.0 本地深度部署与测试指南

## 📋 目录

- [前置条件](#前置条件)
- [快速部署](#快速部署)
- [详细部署步骤](#详细部署步骤)
- [深度测试指南](#深度测试指南)
- [访问系统](#访问系统)
- [常见问题](#常见问题)

---

## 📦 前置条件

### 必需软件

| 软件 | 版本要求 | 下载地址 |
|------|---------|---------|
| **Node.js** | >= 20.x | https://nodejs.org/ |
| **npm** | 随 Node.js 安装 | - |
| **Git** | 任意 | https://git-scm.com/ |

### 可选软件

| 软件 | 用途 | 下载地址 |
|------|------|---------|
| **Ollama** | 本地 LLM 运行 | https://ollama.com/ |
| **VS Code** | 代码编辑器 | https://code.visualstudio.com/ |

### 硬件要求

- **CPU**: 4核以上
- **内存**: 8GB 以上
- **磁盘**: 10GB 可用空间
- **网络**: 可访问外网（用于 API 调用）

---

## 🚀 快速部署（推荐）

### 方式1: 使用一键部署脚本（Windows）

```powershell
# 打开 PowerShell（以管理员或普通用户）
cd c:\zy\jiabaixing
.\scripts\deploy.ps1
```

### 方式2: 手动部署

```bash
# 1. 进入项目目录
cd c:\zy\jiabaixing

# 2. 安装依赖
npm install

# 3. 配置环境变量
copy .env.example .env
# 编辑 .env 文件，配置 API Key

# 4. 创建数据目录
mkdir data, data\eval, data\persistence, data\memory, logs, uploads

# 5. 重建原生模块
npm run fix:native

# 6. 启动系统
npm start
```

---

## 🔧 详细部署步骤

### 步骤 1: 环境检查

```bash
# 检查 Node.js
node --version

# 检查 npm
npm --version

# 检查 Git（可选）
git --version
```

### 步骤 2: 安装依赖

```bash
# 进入项目目录
cd c:\zy\jiabaixing

# 安装后端依赖
npm install

# 安装前端依赖（可选，如果已安装会跳过）
cd src\frontend
npm install
cd ..\..
```

### 步骤 3: 配置环境变量

编辑 `.env` 文件，配置以下关键项：

```env
# ====================
# API 配置（必需）
# ====================

# DeepSeek API（推荐）
DEEPSEEK_API_KEY=sk_your_api_key_here
OPENAI_API_BASE=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash

# 或使用 OpenAI API
OPENAI_API_KEY=sk-your-openai-key
OPENAI_API_BASE=https://api.openai.com
LLM_MODEL=gpt-4

# ====================
# 服务器配置
# ====================
PORT=3111
API_PORT=3111
HOST=localhost

# ====================
# 安全配置
# ====================
JWT_SECRET=your_random_secret_key_here_change_in_production

# ====================
# 功能开关
# ====================
ENABLE_DIRECT_EXECUTOR=true
QQ_ENABLED=false
```

### 步骤 4: 验证配置

```bash
# 检查 TypeScript 编译
npm run build:fast

# 检查是否有语法错误
npm run lint
```

### 步骤 5: 启动系统

```bash
# 方式1: 同时启动后端+前端（推荐）
npm start

# 方式2: 分别启动（需要两个终端窗口）
# 终端1: 启动后端
npm run start:backend

# 终端2: 启动前端
npm run start:frontend

# 方式3: 仅启动后端
npm run start:main
```

---

## 🧪 深度测试指南

### 测试分类

#### 1. 单元测试（不需要 API Key）

```bash
# 运行所有测试
npm test

# 运行特定测试文件
npm test -- tests/harness/independent-evaluator.test.ts
npm test -- tests/harness/evaluation-pipeline.test.ts
npm test -- tests/harness/trajectory.test.ts

# 运行 Harness 相关测试
npm test -- --grep "Harness"

# 运行并生成覆盖率报告
npm run test:coverage
```

#### 2. 集成测试

```bash
# 运行集成测试
npm run test:integration

# 运行完整端到端测试（需要系统运行中）
npm run test:e2e
```

#### 3. 评估流水线测试（需要 API Key）

```bash
# 运行完整评估（需要 API Key 配置）
npm run eval

# 运行特定类别的评估
npm run eval -- --category safety
npm run eval -- --category memory

# 详细输出模式
npm run eval -- --verbose

# 运行评估流水线演示脚本（不需要 API Key）
npx ts-node scripts/full-evaluation-pipeline.ts
```

### 完整测试清单

#### ✅ P0 - Evaluator 独立化测试

| 测试 | 状态 | 说明 |
|------|------|------|
| 独立评估服务测试 | ⏳ 待运行 | tests/harness/independent-evaluator.test.ts |
| 评估流水线测试 | ⏳ 待运行 | tests/harness/evaluation-pipeline.test.ts |
| 步骤评估器测试 | ⏳ 待运行 | tests/harness/step-evaluator.test.ts |
| 质量评分器测试 | ⏳ 待运行 | tests/harness/quality-scorer.test.ts |

#### ✅ P1 - 结构化评估集测试

| 测试 | 状态 | 说明 |
|------|------|------|
| 评估运行器测试 | ⏳ 待运行 | tests/harness/eval-runner.test.ts |
| 完整评估集 | ⏳ 待运行 | npm run eval |
| 50+ 用例验证 | ⏳ 待运行 | GoldenEvalSet.ts |

#### ✅ P2 - 全轨迹审计测试

| 测试 | 状态 | 说明 |
|------|------|------|
| 轨迹数据库测试 | ⏳ 待运行 | tests/harness/trajectory.test.ts |
| 持久化集成测试 | ⏳ 待运行 | tests/harness/persistence-injection.test.ts |

#### ✅ 核心功能测试

| 功能 | 状态 | 说明 |
|------|------|------|
| Loop 控制器测试 | ⏳ 待运行 | tests/harness/loop.test.ts |
| 工具注册测试 | ⏳ 待运行 | tests/harness/tools.test.ts |
| 验证服务测试 | ⏳ 待运行 | tests/harness/verification.test.ts |
| Agent 注册测试 | ⏳ 待运行 | tests/harness/agent-registry.test.ts |

---

## 🌐 访问系统

### 服务地址

| 服务 | 地址 | 说明 |
|------|------|------|
| **前端界面** | http://localhost:3000 | Web UI 界面 |
| **后端 API** | http://localhost:3111 | REST API |
| **WebSocket** | ws://localhost:3111 | 实时通信 |

### 前端功能面板

访问 http://localhost:3000 后，你可以使用以下功能：

1. **聊天界面** - 与 AI 助手对话
2. **Agent 执行面板** - 查看和管理 Agent 执行
3. **记忆面板** - 管理记忆系统
4. **技能控制台** - 执行和管理技能
5. **安全面板** - 安全设置和审计
6. **集成面板** - 网关和平台集成
7. **性能监控** - 系统性能指标
8. **进化面板** - 进化引擎监控
9. **桌面控制** - 桌面自动化

### API 端点测试

```bash
# 健康检查
curl http://localhost:3111/api/core/health

# 工具使用统计
curl http://localhost:3111/api/debug/tool-usage

# 技能列表
curl http://localhost:3111/api/skill/list

# 进化指标
curl http://localhost:3111/api/evolution/metrics
```

### CLI 命令行工具

在另一个终端窗口运行：

```bash
npm run cli
```

CLI 支持以下功能：
- 网关配置（微信/QQ/飞书/钉钉）
- 定时任务管理
- 系统配置
- 终端聊天模式

---

## 🔍 验证部署成功

### 检查清单

- [ ] Node.js 和 npm 已正确安装
- [ ] npm install 运行成功
- [ ] .env 文件已配置 API Key
- [ ] 数据目录已创建（data/, logs/, uploads/）
- [ ] npm start 启动成功
- [ ] 前端可以访问 http://localhost:3000
- [ ] 后端 API 可以访问 http://localhost:3111
- [ ] WebSocket 连接正常
- [ ] 测试运行通过（npm test）

### 快速验证命令

```bash
# 1. 检查端口是否监听
# Windows
netstat -ano | findstr "3000 3111"

# 2. 发送测试请求
curl http://localhost:3111/api/core/health

# 3. 运行快速测试
npm test -- tests/harness/comprehensive-coverage.test.ts
```

---

## ❓ 常见问题

### Q1: npm install 失败

**解决方案**
```bash
# 清除缓存重新安装
npm cache clean --force
rmdir /s /q node_modules
del package-lock.json
npm install

# 或使用淘宝镜像
npm install --registry=https://registry.npmmirror.com
```

### Q2: better-sqlite3 错误

**解决方案**
```bash
# 重建原生模块
npm run fix:native

# 或手动重建
npm rebuild better-sqlite3
```

### Q3: 端口 3000 或 3111 被占用

**解决方案**

编辑 `.env` 文件：
```env
PORT=3001          # 改为其他端口
API_PORT=3112     # 改为其他端口
```

### Q4: LLM API 调用失败

**解决方案**

1. 检查 API Key 是否正确
2. 检查网络连接
3. 检查 API 服务是否正常
4. 尝试使用不同的 LLM 提供商

### Q5: 前端无法连接后端

**解决方案**

1. 确认后端已启动
2. 检查前端代理配置（src/frontend/package.json）
3. 检查 CORS 配置
4. 检查防火墙设置

### Q6: npm 命令不识别

**解决方案**

1. 确认 Node.js 已添加到系统 PATH
2. 重启终端窗口
3. 尝试完整路径：`C:\Program Files\nodejs\npm`

### Q7: 测试运行超时

**解决方案**

1. 增加测试超时时间
2. 检查是否有真实 API 调用（可以 mock）
3. 先运行快速测试，再运行完整测试

---

## 📊 监控和日志

### 日志位置

- **应用日志**: `logs/` 目录
- **持久化数据**: `data/persistence/` 目录
- **评估报告**: `data/eval/reports/` 目录
- **记忆数据**: `data/memory/` 目录

### 查看日志

```bash
# 运行日志分析
npm run log:analyze

# 生成报告
npm run log:report

# 查询特定日志
npm run log:query
```

---

## 🎯 下一步

部署成功后，你可以：

1. **体验核心功能**
   - 与 AI 助手对话
   - 测试记忆系统
   - 尝试各种工具

2. **继续完成 V5.0 对齐**
   - 运行评估流水线
   - 完成测试验证
   - 收集使用反馈

3. **扩展系统功能**
   - 集成更多平台（微信、QQ、飞书等）
   - 添加自定义技能
   - 配置自动化任务

4. **性能优化**
   - 配置本地 LLM（Ollama）
   - 优化缓存策略
   - 调整并发参数

---

## 📞 获取帮助

如果遇到问题：

1. 查看 [README.md](./README.md) 了解更多信息
2. 查看 [TEST_RUN_GUIDE.md](./TEST_RUN_GUIDE.md) 测试指南
3. 查看 [V5.0-ALIGNMENT-REPORT.md](./V5.0-ALIGNMENT-REPORT.md) 对齐报告
4. 检查 logs 目录中的日志文件

---

**部署文档版本**: 1.0  
**最后更新**: 2026-05-28  
**适用版本**: Jiabaixing V5.0
