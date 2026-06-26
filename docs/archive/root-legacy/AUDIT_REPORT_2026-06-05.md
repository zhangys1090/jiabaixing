# 📋 家百星 V5.0 全项目审计报告 — 2026-06-05

> **执行**: Hermes Agent 自动化审计 | **项目路径**: `/mnt/c/zy/jiabaixing/`
> **审计时间**: 2026-06-05 04:00 CST

---

## 1. 架构健康度评分：**A**（优秀）

### E层 — 执行循环 ✅

| 模块                   | 大小  | 状态                  |
| ---------------------- | ----- | --------------------- |
| `LoopController.ts`    | 53KB  | ✅ 存在               |
| `Planner.ts`           | 28KB  | ✅ 存在               |
| `Executor.ts`          | 45KB  | ✅ 存在               |
| `Evaluator.ts`         | 8.9KB | ✅ 存在               |
| `Reporter.ts`          | 4.6KB | ✅ 存在               |
| `AutonomousTrigger.ts` | 8.9KB | ✅ 存在               |
| `RetryExecutor.ts`     | 3.2KB | ✅ 新增（上次未记录） |

### T层 — 工具系统 ✅

- **62个工具文件**（较上次58个 ↑ +4）
- 分类：
  - `code/` — 6个工具（分析/修复/生成/审查/CSV/项目审查）
  - `cognition/` — 3个工具（情绪检测/场景分析/自省）
  - `daily/` — 9个工具（任务管理/日程/简报/备忘录/状态/分析/依赖/优先级/批量任务）
  - `desktop/` — 2个工具（自动化/截图）
  - `file/` — 7个工具（搜索/列表/编辑/读取/去重/grep/活跃文件）
  - `memory/` — 5个工具（查询/回忆/搜索/存储/知识查询）
  - `network/` — 8个工具（搜索/抓取/图片/推送/技能创建/TTS/浏览器Agent/图表生成）
  - `system/` — 8个工具（shell执行/shell生成/委托/日志/回滚/上下文/清理/语音交互）
  - `registry/` — 5个文件（注册表/守卫/权限/验证/MCP桥）
  - `skill/` — 1个（技能共享）
- 新增: `code_review_project`, `browser_agent`, `chart_generate`, `log_clean`, `voice_interact`, `v5DesktopTools` 等

### C层 — 上下文管理 ✅

- `ContextManager.ts` (38KB) ✅
- `TokenBudgetAllocator.ts` (2.7KB) ✅
- 另有 `ContextCompressor.ts` (5.6KB) 在 loop 下

### S层 — 持久化 ✅

- `PersistenceService.ts` (18KB) ✅
- `TrajectoryDatabase.ts` (17KB) ✅
- `TrajectoryFlywheel.ts` (21KB) ✅
- `TrajectoryQueryService.ts` (5KB) ✅

### L层 — 生命周期 ✅

- `ConstraintsService.ts` (16KB) ✅

### V层 — 验证 ✅

- `VerificationService.ts` (7.2KB) ✅

### 其他架构组件

- **sandbox 沙箱**: `SandboxExecutor.ts` ✅
- **orchestration 编排**: AgentRegistry, OrchestratorAgent, ResultAggregator, SubAgentFanout, TaskDispatcher ✅
- **security 安全**: `SensitiveDetector.ts` ✅
- **evaluation 评估系统**: AssertionValidator, EvalGate, EvalRunner, EvalTrendAnalyzer, EvaluationPipeline, GoldenEvalSet, IndependentEvaluationService, OptimizationFeedbackLoop, QualityScorer, StepEvaluator ✅

### EvolutionEngine ⚠️

- `engine-state.json` 存在，**59次优化记录**（上次47次 ↑ +12）
- `file_search` 工具: 178次调用，仅2次成功，成功率 **1.1%**（上次1.5%，持续恶化）
- 大量重复的promptExamples（同一个"不对 python 不是 javascript"被记录了15+次）
- feedbackHistory 中有大量重复的失败记录（Python/JavaScript混淆爆发式出现）
- **需清理重复进化条目**

---

## 2. 编译状态

| 指标            | 值                |
| --------------- | ----------------- |
| 编译错误        | **0 errors** ✅   |
| src .ts 文件数  | 339               |
| dist .js 文件数 | 364               |
| 编译类型        | ES2022 → CommonJS |
| 与上次对比      | 维持0错误 ✅      |

---

## 3. 测试状态 ⚠️

| 指标                           | 值                                            |
| ------------------------------ | --------------------------------------------- |
| 测试文件总数（含node_modules） | 191个（含第三方包）                           |
| 项目自有测试文件               | **5个**（在 `src/evolution/v2/__tests__/`）   |
| jest 配置                      | `ts-jest` preset 无法找到 — 缺少 ts-jest 依赖 |
| ts-jest 版本                   | 29.4.9 (已安装，但preset找不到)               |
| 测试运行                       | ❌ 失败 — `Preset ts-jest not found`          |

**问题**: jest.config.js 使用 `ts-jest` preset，但安装的 `ts-jest@29.4.9` 与 `jest@30.3.0` 不兼容。需要升级 ts-jest 到 v30 版本。

测试覆盖:

- `src/evolution/v2/__tests__/EvolutionEngineV2.test.ts`
- `src/evolution/v2/__tests__/EvolutionPlanner.test.ts`
- `src/evolution/v2/__tests__/EvolutionRollback.test.ts`
- `src/evolution/v2/__tests__/SelfModificationEngine.test.ts`
- `src/evolution/v2/__tests__/types.test.ts`

还有 `tests/` 目录下的集成测试和单元测试被 jest 配置 `testPathIgnorePatterns` 排除了。

---

## 4. 安全风险 ⚠️

| 风险项                 | 等级    | 状态                                                        |
| ---------------------- | ------- | ----------------------------------------------------------- |
| .env 硬编码密钥        | 🟡 中   | 存在暴露风险，虽被 .gitignore 排除，但本地文件含多种API Key |
| 日志敏感数据泄露       | 🟢 低   | 日志已清理到21MB，无明文密码                                |
| .gitignore 完整性      | 🟢 良好 | 覆盖 logs/, data/, .env, node_modules                       |
| 前端 node_modules      | 🟡 中   | 736MB，包含完整测试框架和依赖，非生产环境可接受             |
| JWT_SECRET 含特殊字符  | 🟢 低   | 已配置                                                      |
| ZHIPU_API_KEY 部分暴露 | 🟡 中   | `.env` 中显示部分字符串 `11dde3...viU0`                     |

---

## 5. 资源使用情况

| 目录                         | 大小      | 说明             |
| ---------------------------- | --------- | ---------------- |
| `node_modules/`              | 189MB     | 核心依赖，健康   |
| `src/frontend/node_modules/` | **736MB** | 前端依赖，偏大   |
| `dist/`                      | 9.4MB     | 编译产物，正常   |
| `logs/`                      | **21MB**  | 已清理（原91MB） |
| `data/`                      | 18MB      | 数据库文件       |
| `coverage/`                  | 36MB      | 测试覆盖率报告   |
| `snapshots/`                 | 124KB     | 状态快照         |
| `tmp/`                       | 8KB       | 临时文件         |

**数据库文件**: 10个 SQLite 数据库，总计约1.3MB，状态正常

- `trajectory.db` — 608KB（最大）
- `event_bus.db` — 396KB
- `jiabaixing_memory.db` — 176KB

**日志清理成效**: 91MB → **21MB**（↓77%）

---

## 6. Windows迁移评估

### 可迁移等级：🟡 **L1-核心可迁移**（部分WSL依赖不可跨平台）

| 依赖                        | 跨平台        | 说明                                                       |
| --------------------------- | ------------- | ---------------------------------------------------------- |
| `better-sqlite3`            | ⚠️ 需重新编译 | WSL编译产物 `invalid ELF header` — Windows需 `npm rebuild` |
| `screenshot-desktop`        | ❌ WSL特有    | 依赖Linux桌面环境，Windows需替换方案                       |
| `playwright`                | ✅ 跨平台     | 1.59.1，需安装Windows浏览器                                |
| `@nut-tree/nut-js`          | ⚠️ 版本落后   | 当前3.1.2，最新4.2.0，API有重大变更                        |
| `chromadb`                  | ✅ 跨平台     | 1.10.5，模块加载正常                                       |
| `get-foreground-window.ps1` | ✅            | 已作为脚本引用，不依赖WSL                                  |

### WSL特有代码

- `process.platform === 'win32'` 判断在 **14个位置**出现：
  - `src/cli.ts` — 3处（CLI模式、路径处理）
  - `src/main.ts` — 4处（服务启动、系统托盘、热键等）
  - `src/server/bootstrap.ts` — 2处（服务器配置）
  - `src/harness/tools/file/file_read.ts` — 1处（路径转换）
  - `src/harness/tools/system/shell_generate.ts` — 1处
  - `src/utils/Logger.ts` — 1处（颜色代码）
  - `src/core/ScenarioAwareScheduler.ts` — 1处

### Windows 启动脚本完整性

| 脚本                  | 大小  | 说明            |
| --------------------- | ----- | --------------- |
| `jiabaixing.bat`      | 2.8KB | ✅ 核心启动脚本 |
| `家百星.bat`          | 2.7KB | ✅ 中文启动脚本 |
| `install-desktop.ps1` | 609B  | ✅ 桌面安装脚本 |
| `scripts/deploy.ps1`  | 5.3KB | ✅ 部署脚本     |

### 迁移工作清单

1. **必须解决的问题**:
   - `better-sqlite3` 在Windows下 `npm rebuild` 需要Visual Studio Build Tools
   - `screenshot-desktop` 需要替换为 `screenshot-desktop` 的Windows原生包或 `@nut-tree/nut-js` 截图功能
   - `@nut-tree/nut-js` 需升级到4.x（API不兼容，需测试）
2. **推荐处理**:
   - 路径硬编码检查（当前未发现 `/mnt/c` 硬编码，但多平台路径处理需验证）
   - shell_generate 对Linux命令的硬编码假设
3. **无障碍**:
   - chromadb 直接可用
   - playwright 安装 Windows 浏览器即可
   - Express/WebSocket/中间件全部跨平台

---

## 7. 与上次审计（2026-06-04）对比

| 指标              | 上次   | 本次       | 变化       |
| ----------------- | ------ | ---------- | ---------- |
| 架构评分          | A      | A          | → 维持     |
| 编译错误          | 0      | 0          | → 维持     |
| 工具文件数        | 58     | 62         | ↑ +4       |
| 进化优化          | 47     | 59         | ↑ +12      |
| file_search成功率 | 1.5%   | 1.1%       | ↓ 持续恶化 |
| 日志大小          | ~90MB+ | 21MB       | ↓ 已清理   |
| 前端node_modules  | 未记录 | 736MB      | 需关注     |
| 测试运行          | 未记录 | ❌ 失败    | 新发现问题 |
| 数据库文件        | 未记录 | 10个/1.3MB | 正常       |

---

## 8. 最紧急的3个问题

### 🔴 1. 测试环境不可用 — ts-jest与jest版本不兼容

**影响**: 所有测试无法运行，无法进行回归验证
**修复**: 升级 `ts-jest` 到 `30.x` 以匹配 `jest@30.3.0`

```bash
npm install --save-dev ts-jest@^30.0.0
```

### 🟡 2. file_search 工具成功率极低（1.1%）

**影响**: EvolutionEngine 积累了16+重复的"Python/JavaScript混淆"修复条目，系统噪音大
**修复建议**:

- 清理 `engine-state.json` 中的重复promptExamples
- 检查 `file_search` 实现逻辑

### 🟡 3. 前端node_modules膨胀（736MB）

**影响**: 占用大量磁盘空间，且前端使用 `react-scripts 5.0.1`（已停止维护）
**建议**:

- 开发中可接受，但打包部署时应清理
- 评估迁移到 Vite

---

## 9. 建议优先修复

1. **🔧 修复测试** — `npm install --save-dev ts-jest@^30.0.0`，让 `npm test` 可运行
2. **🧹 清理 EvolutionEngine** — 去重 engine-state.json 的promptExamples
3. **📊 file_search 调试** — 检查为什么178次调用仅2次成功
4. **📦 前端评估** — 考虑迁移 react-scripts 到 Vite
5. **💾 Windows迁移准备** — 记录 better-sqlite3 和 screenshot-desktop 的替代方案

---

_Report generated by Hermes Agent on 2026-06-05 04:00 CST_
