# Jiabaixing V5.0 — Claude Code 开发指南

> 为 Claude Code 和所有 AI 编码助手定制的项目上下文

---

## 一句话说明

家百星 V5.0 是一个 TypeScript Agent Harness Framework，六层(E-T-C-S-L-V)管控+33工具+进化引擎。运行在 Node.js 20.x + Express + SQLite/ChromaDB。

## 项目定位

- **当前状态**: V5.0 Harness 架构已成型，33工具已注册，52/52测试通过
- **不是**: 重新发明轮子的AI框架——核心价值是六层Harness管控和进化引擎
- **核心亮点**: E-T-C-S-L-V 六层独立开关、33个声明式工具(8类)、EvolutionEngine、110条轨迹数据
- **运行平台**: Windows (主) / WSL / Linux

## CRITICAL: 开发模式

### 不要「我来帮你改」
用户用 Claude Code / Codex 作为主力编码工具。你（Claude Code）看到的代码是用户自己或之前 Claude Code 会话写的。**不要问「是否要我去改」**——直接讨论方案、给代码建议、分析架构。

### 修改前必读
修改任何代码前，先回答：
1. 这个改动属于哪一层？(E/T/C/S/L/V 还是 core/security/server)?
2. 这个改动的安全影响是什么？
3. 有对应的测试文件吗？

### 所有改动必须
- ✅ 通过 `npx tsc --noEmit` 编译检查
- ✅ 通过 `npm test` 或至少有相关测试覆盖
- ✅ 符合项目 eslint 和 prettier 规范

---

## 项目结构快照

```
src/
├── main.ts              # 入口 (Express + WS)
├── cli.ts               # CLI模式 (2910行)
├── core/                # 核心引擎 (JiabaixingCore等)
├── harness/             # 六层管控 (loop/tools/context/persistence/constraints/verification)
├── evolution/           # 进化引擎
├── llm/                 # LLM连接
├── memory/              # 记忆系统
├── security/            # 安全 (EncryptionManager/SecurityGuard等)
├── desktop/             # 桌面自动化
├── mcp/                 # MCP协议
├── interaction/         # 交互引擎
├── multimodal/          # 多模态
├── persona/             # 人格系统
├── integration/         # 集成(IntegrationManager/GatewayBridge)
├── server/              # Express路由/WebSocket
├── routes/              # API路由
├── utils/               # 工具(Logger/PerformanceMonitor)
├── shared/              # 共享(EventBus/types)
├── config/              # 配置(ConfigLoader/setup)
├── skills/              # 技能系统
├── types/               # 类型声明
└── frontend/            # React前端
```

## 关键路径

```
用户输入 → JiabaixingCore.processInput()
  → AgentHarness.processInput()
    → ContextManager.buildContext()          [C层]
    → ConstraintsService.executeHooks()      [L层]
    → LoopController.run()
      → Planner.plan()                       [E层]
      → Executor.execute() → ToolRegistry    [E+T层]
      → Evaluator.evaluate()                 [E+V层]
      → Reporter.report()                    [E层]
    → PersistenceService.record()            [S层]
    → EventBus.emit('response_ready')
```

## 数据库

- **SQLite**: 对话历史、状态、轨迹 (better-sqlite3)
- **ChromaDB**: 长期记忆、向量检索 (chromadb npm)

## 技术约束

- Node.js >= 20.x, TypeScript 6.0
- Express 4.x + WebSocket (ws)
- 使用 tsx 运行（非 ts-node），编译用 tsc
- better-sqlite3 需要原生编译 (npm rebuild better-sqlite3)
- 前端 React 18 (CRA)，位于 src/frontend/

## 测试

- Jest + ts-jest
- `npm test` — 运行全部
- `npx jest tests/xxx -v` — 单文件
- 测试文件在 tests/ 目录

## 常见问题处理

### better-sqlite3 编译失败
```bash
npm run fix:native
# 或: npm rebuild better-sqlite3
```

### TypeScript 编译报错
```bash
npx tsc --noEmit          # 检查类型
npx tsc --project tsconfig.fast.json  # 快速编译
```

### 端口被占用
```bash
lsof -i :3111
kill -9 <PID>
```

### 环境变量
复制 `.env.example` 为 `.env`，或编辑 `data/providers.json`
关键变量: DEEPSEEK_API_KEY / XIAOMI_API_KEY / LLM_MODEL

---

## 当前开发重点（按优先级）

P0 — 核心可展示闭环:
- 一条命令走完全工具链的穿透Demo
- Gateway消息推送

P1 — UX打磨:
- 配置文件热加载
- 错误用户提示优化

P2 — 能力补全:
- 更多工具类别
- 第三方集成扩展

---

## 安全提醒

- 不提交 .env 到 Git
- SQLite 使用参数化查询
- Express 路由使用 helmet 安全头
- 所有用户输入需验证
- 工具调用有 PermissionGuard
