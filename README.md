# Jiabaixing 家百星 V5.0

> **私人 AI 秘书** — 有记忆、能主动、会进化  
> TypeScript · Node.js · Harness Agent Framework

一键启动你的本地 AI 智能体：

```bash
bash install.sh    # 安装 + 配置 LLM
./run.sh           # 启动（后端 :3111 + 前端 :3111）
```

---

## 是什么

家百星是一个**本地运行的 AI Agent 框架**。她不是 API 封装壳，也不是聊天 UI——而是一个完整的 LLM 执行管控系统。

核心理念：
```
Agent = (LLM 推理 + 能力组件) × Harness 六层管控
```

LLM 做认知（推理、选工具、表达），Harness 做工程（预算、权限、验证、状态）。

## 文档

- **[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)** — 开发者指南（架构、API、工具、配置、故障排查）
- **[PROJECT.md](PROJECT.md)** — 项目全景文档
- **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** — 部署指南

## 快速开始

```bash
# 1. 一键安装
bash install.sh
# 自动：检查环境 → npm install → better-sqlite3编译 → 配置向导

# 2. 启动
./run.sh
# 访问 http://localhost:3111

# 3. 测试
curl http://localhost:3111/api/health
npm run setup:test    # 测试 LLM 连接
npm test              # 874 个测试
```

## 架构

六层 E-T-C-S-L-V Harness 系统，33 个声明式工具：

| 层 | 职责 | 关键文件 |
|----|------|---------|
| **E** Execution Loop | Planner→Executor→Evaluator→Reporter 状态机 | `LoopController.ts` |
| **T** Tool Registry | 33 工具 x 8 类, JSON Schema + 四级权限 | `ToolRegistry.ts` |
| **C** Context Manager | 宪法Prompt→记忆→上下文→6桶Token分配 | `ContextManager.ts` |
| **S** State Store | 瞬时/SQLite/ChromaDB 三层状态 | `PersistenceService.ts` |
| **L** Lifecycle Hooks | 9 钩子: before_loop ~ after_response | `AgentHarness.ts` |
| **V** Verification | 输出安全 + 结果验证 + 五维质量评分 | `VerificationService.ts` |

## 能力

| 能力 | 说明 |
|------|------|
| 33 工具 x 8 类 | memory, cognition, desktop, file, code, system, daily, network |
| 三层记忆 | 瞬时(SQLite)/短期(SQLite)/长期(ChromaDB) |
| 多模型路由 | ProviderManager 管理，自动降级+熔断感知 |
| 进化引擎 | V2 LLM 自进化：分析→计划→修改→验证 |
| CLI + 前端 | REPL CLI + React 18 面板 + WebSocket 实时推送 |
| 多平台网关 | 微信/QQ/飞书/钉钉 |
| 评估框架 | 30 条 Golden Set, 轨迹审计, 质量评分 |
| 定时任务 | ScenarioAwareScheduler 场景感知触发 |

## 命令

```bash
npm run setup            # Provider 配置向导
npm run setup:list       # 查看 Provider 配置
npm run setup:test       # 测试所有 LLM 连接
npm run cli              # CLI 模式
npm test                 # 874 测试 / 52 套件
npm run eval             # 评估套件
```

## 配置

```bash
npm run setup   # 交互式配置向导
```

支持多 Provider（DeepSeek/小米MiMo/OpenAI/智谱/本地），自动导入 `.env`。

详细文档见 [PROJECT.md](./PROJECT.md)。

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 20+, TypeScript (ES2022) |
| Web | Express 4.x + WebSocket |
| 前端 | React 18 + Zustand |
| 数据库 | better-sqlite3 + ChromaDB |
| LLM | OpenAI 兼容 (ProviderManager) |
| 测试 | Jest 30, 874 tests |

## 项目结构

```
src/
├── core/              JiabaixingCore, ScenarioAwareScheduler
├── harness/           ★ E-T-C-S-L-V 六层
│   ├── loop/          执行循环
│   ├── tools/         33 工具
│   ├── context/       上下文管理
│   ├── evaluation/    评估框架
│   ├── persistence/   持久化
│   ├── verification/  安全验证
│   └── orchestration/ 多Agent编排
├── models/            LLMProvider, ProviderManager
├── memory/            三层记忆
├── evolution/         进化引擎 V2
├── security/          安全审计
├── server/            Express + WebSocket
├── config/            配置向导
├── frontend/          React 18 面板
└── main.ts            入口
```
