# Jiabaixing V5.0 — 多Agent开发团队手册

> **目的**: 定义家百星项目开发中的多Agent角色分工与协作流程
> **适用**: Claude Code、Hermes Agent、Codex CLI 等 AI 编码助手
> **版本**: 1.0
> **日期**: 2026-06-03

---

## 一、角色体系

```
┌─────────────────────────────────────────────────┐
│              🧠 架构师 (Architect)              │
│  负责: 系统设计/重构/技术选型/架构决策          │
│  输出: ADR文档/架构图/接口契约                   │
├─────────────────────────────────────────────────┤
│     ┌───────────┐     ┌───────────┐            │
│     │ 前端工程师 │     │ 后端工程师 │            │
│     │ Frontend   │     │ Backend    │            │
│     └─────┬─────┘     └─────┬─────┘            │
│           │                 │                    │
│     ┌─────┴─────┐     ┌─────┴─────┐            │
│     │  页面组件  │     │  API/业务  │            │
│     │  React/TS │     │  TypeScript│            │
│     └───────────┘     └───────────┘            │
├─────────────────────────────────────────────────┤
│              🔍 代码审计师 (Auditor)            │
│  负责: 质量审查/合规检查/安全审计               │
│  触发: 每个PR合并前 / 每轮迭代后                │
├─────────────────────────────────────────────────┤
│              🧪 测试工程师 (QA)                 │
│  负责: 测试设计/自动化测试/回归验证             │
│  触发: 每个功能完成后 / 发布前                  │
└─────────────────────────────────────────────────┘
```

### 角色职责矩阵

| 角色 | 代码编写 | 架构决策 | 代码审查 | 测试编写 | 文档编写 |
|------|---------|---------|---------|---------|---------|
| 架构师 | ❌ | ✅ | ✅ | ❌ | ✅(技术方案) |
| 前端工程师 | ✅ | ❌ | ❌ | ✅(前端) | ✅(组件文档) |
| 后端工程师 | ✅ | ❌ | ❌ | ✅(后端) | ✅(API文档) |
| 代码审计师 | ❌ | ❌ | ✅ | ❌ | ✅(审查报告) |
| 测试工程师 | ✅(测试) | ❌ | ❌ | ✅ | ✅(测试报告) |

### 角色分工细则

#### 🧠 架构师
- **输入**: 用户需求 / 技术方案
- **输出**: ADR(架构决策记录)、接口契约、重构方案
- **不允许**: 直接写业务代码、修改功能实现
- **看什么文档**: PROJECT.md, data/providers.json, src/config/
- **协作**: 架构师审完后，通知对应工程师实施

#### 🔧 前端工程师
- **技术栈**: React 18 / TypeScript 6 / MUI
- **范围**: `src/frontend/` 全部
- **规则**: 组件必须带 .test.tsx；样式只用 MUI sx prop 或 CSS-in-JS
- **不允许**: 修改后端代码、数据库、工具注册表
- **测试命令**: `cd src/frontend && npm test`

#### ⚙️ 后端工程师
- **技术栈**: TypeScript 6 / Express / better-sqlite3 / ChromaDB
- **范围**: `src/` 下除 `src/frontend/` 外的全部
- **规则**: 每个新 API 端点必须在 `tests/` 有对应集成测试
- **不允许**: 修改前端代码、数据库迁移需架构师批准
- **测试命令**: `npm test` (jest)

#### 🔍 代码审计师
- **职责**: 检查代码质量、架构合规、安全漏洞、性能风险
- **清单**(每条必须过):
  - [ ] 代码风格匹配项目规范（eslint + prettier）
  - [ ] 无 console.log 残留（用 Logger 替代）
  - [ ] TypeScript 编译 0 errors
  - [ ] 测试覆盖率未下降
  - [ ] 无安全漏洞（SQL注入/XSS/密钥硬编码）
  - [ ] 无死代码/死文件
  - [ ] API 变更已更新文档
- **审计命令**: `npm run check:all`

#### 🧪 测试工程师
- **职责**: 为每个新功能编写测试、执行回归测试
- **清单**:
  - [ ] 单元测试（每个新函数至少1个）
  - [ ] 集成测试（每个新API端点至少1个）
  - [ ] 边界条件测试（空值/异常/超时）
  - [ ] 所有测试通过
  - [ ] 测试保留在 `tests/` 目录
- **测试命令**: `npm test` / `npm run test:coverage`

---

## 二、开发流程

### 标准开发循环

```
Step 1: 用户需求 → 架构师分析方案 (输出ADR)
Step 2: 架构师批准 → 拆分为任务卡
Step 3: 前端/后端工程师并行实施
Step 4: 测试工程师编写测试 + 执行回归
Step 5: 代码审计师审查 (阻塞步骤)
Step 6: 架构师最终确认 → PR合并
```

### 紧急修复流程

```
Step 1: 工程师直接修复
Step 2: 测试工程师补测试
Step 3: 审计师事后审查 (24h内)
```

### 提交规范

```
<type>: <简短描述>

<可选详细说明>

类型: feat / fix / refactor / test / docs / style / chore
示例:
  feat: 添加LLM提供商热切换API
  fix: 修复工具调用去重守卫空指针
  test: 添加情绪周期边界条件测试
```

### 分支策略

```
main          ← 生产分支，仅合并PR
  ├── feat/*  ← 功能分支
  ├── fix/*   ← 修复分支
  └── refactor/* ← 重构分支
```

---

## 三、启动命令速查

### 项目命令
```bash
npm run start          # 启动后端+前端
npm run cli            # CLI交互模式
npm run daemon         # 后台守护模式
npm test               # 运行全部测试
npm run test:coverage  # 带覆盖率
npm run lint           # 代码检查
npm run build          # TypeScript编译
```

### 单文件测试
```bash
npx jest tests/harness/loop/LoopController.test.ts -v
npx jest tests/harness/tools/ -v
npx jest --listTests   # 列出所有测试文件
```

### 快速验证
```bash
curl http://localhost:3111/api/health  # 健康检查
npm run setup:test                      # LLM连接测试
npx tsc --noEmit                        # 类型检查
```

---

## 四、关键模块文件索引

```yaml
核心入口:
  src/main.ts: 后端服务入口 (Express + WebSocket)
  src/cli.ts: CLI交互模式入口 (2910行, 含IPC+HTTP双通道)

核心引擎:
  src/core/JiabaixingCore.ts: 主引擎
  src/core/ConstitutionPromptBuilder.ts: 系统Prompt构建
  src/core/MemoryAssistant.ts: 记忆管理

Harness六层:
  src/harness/loop/LoopController.ts: E层 - 执行循环
  src/harness/loop/Planner.ts: 规划器
  src/harness/loop/Executor.ts: 执行器
  src/harness/loop/Evaluator.ts: 评估器
  src/harness/loop/Reporter.ts: 报告器
  src/harness/tools/registry/ToolRegistry.ts: T层 - 工具注册
  src/harness/tools/registry/ToolCallGuard.ts: 工具守卫
  src/harness/context/ContextManager.ts: C层 - 上下文
  src/harness/persistence/PersistenceService.ts: S层 - 持久化
  src/harness/constraints/ConstraintsService.ts: L层 - 生命周期
  src/harness/verification/VerificationService.ts: V层 - 验证

其他:
  src/server/: Express路由
  src/evolution/EvolutionEngine.ts: 进化引擎
  src/memory/: 记忆系统
  src/security/: 安全系统
  src/desktop/: 桌面自动化
  src/mcp/: MCP协议支持
  src/interaction/: 交互引擎
  src/multimodal/: 多模态
  src/persona/: 人格系统
  src/routes/: 路由
  src/io/: 输入输出
```

---

## 五、开发纪律（硬性规则）

1. **先测试后代码** — 新功能必须先写测试再实现
2. **审计阻塞** — 代码审计师未批准前不得合并
3. **不越界** — 前端不碰后端，后端不碰前端
4. **提交粒度** — 每个功能点一个提交，不要大混提交
5. **日志规范** — 用 Logger 实例，不要 console.log
6. **错误处理** — 所有工具调用必须 try-catch
7. **配置先行** — .env 或 providers.json 优先，不硬编码 API Key
8. **架构师批准** — 任何接口变更、数据库迁移、依赖引入需架构师批准
