# 📋 家百星 V5.0 全项目审计报告 — 2026-06-04

> **执行**: Hermes Agent 自动化审计 | **项目路径**: `/mnt/c/zy/jiabaixing/`

---

## 1. 架构健康度评分：**A**（优秀）

### E层 — 执行循环 ✅

| 模块                   | 大小  | 状态    |
| ---------------------- | ----- | ------- |
| `LoopController.ts`    | 52KB  | ✅ 存在 |
| `Planner.ts`           | 28KB  | ✅ 存在 |
| `Executor.ts`          | 55KB  | ✅ 存在 |
| `Evaluator.ts`         | 7.2KB | ✅ 存在 |
| `Reporter.ts`          | 4.5KB | ✅ 存在 |
| `AutonomousTrigger.ts` | 9KB   | ✅ 存在 |

### T层 — 工具系统 ✅

- **58个工具文件**（按类分布）:
  - `code/` — 6个工具（分析/修复/生成/审查/CSV）
  - `cognition/` — 3个工具（情绪检测/场景分析/自省）
  - `daily/` — 8个工具（任务管理/日程/备忘录/简报）
  - `desktop/` — 2个工具（自动化/截图）
  - `file/` — 7个工具（搜索/列表/编辑/读取/去重）
  - `memory/` — 4个工具（查询/回忆/搜索/存储）
  - `network/` — 6个工具（搜索/抓取/图片/推送/技能创建/TTS）
  - `system/` — 7个工具（shell/委托/日志/回滚/上下文/清理/语音）
  - `registry/` — 5个文件（注册表/守卫/权限/验证/MCP桥）
  - `skill/` — 1个（技能共享）

### C层 — 上下文管理 ✅

- `ContextManager.ts` ✅ 存在
- `TokenBudgetAllocator.ts` ✅ 存在（Token预算分配）

### S层 — 持久化 ✅

- `PersistenceService.ts` ✅ 存在
- `TrajectoryDatabase.ts` ✅ 存在
- `TrajectoryFlywheel.ts` ✅ 存在（飞轮机制）
- `TrajectoryQueryService.ts` ✅ 存在

### L层 — 生命周期 ✅

- `ConstraintsService.ts` ✅ 存在

### V层 — 验证 ✅

- `VerificationService.ts` ✅ 存在

### EvolutionEngine ⚠️

- `engine-state.json` 存在，47次优化记录
- **问题**: `file_search` 工具成功率极低（130次调用仅2次成功，成功率1.5%）
- `feedbackHistory` 大量重复条目（"不对 python 不是 javascript" 高频出现）
- 重复 `qualityScore: 30` 的异常高分记录（正常范围0-1）

### 记忆系统状态

| 数据库                       | 大小  | WAL   |
| ---------------------------- | ----- | ----- |
| `jiabaixing_memory.db`       | 176KB | 4MB   |
| `vectors.db` (Chroma)        | 4KB   | 3.3MB |
| `long_term_memory_sqlite.db` | 4KB   | 2.2MB |
| `event_bus.db`               | 396KB | —     |
| `sovereignty_audit.db`       | 20KB  | —     |

---

## 2. 编译状态：✅ **0 errors**

- `npx tsc --noEmit` 编译零错误通过
- TypeScript 版本 6.0+
- `dist/` 有 1388 个文件（与 `src/` 328个 .ts 文件匹配良好）
- 无新旧编译错误对比（首次审计）

---

## 3. 测试审计：⚠️ **61个测试文件，但运行超时**

### 测试概况

| 指标         | 值                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 测试文件总数 | 61（jest --listTests）                                                                                                      |
| 测试目录分布 | `tests/harness/` (18), `tests/unit/` (28), `src/evolution/v2/__tests__/` (5), `tests/integration/` (5+), `tests/debug/` (1) |
| 前端测试     | `src/frontend/src/utils/errorMonitoring.test.ts` (1)                                                                        |
| Jest 配置    | ts-jest preset, node环境, V8 coverage                                                                                       |
| 覆盖率阈值   | branches: 30%, functions: 30%, lines: 30%                                                                                   |
| 覆盖率收集   | 排除 frontend/, types/, index.ts                                                                                            |
| 测试设置     | 抑制 console 输出，加载 dotenv                                                                                              |

### ⚠️ 关注点

- **测试运行超时** — `npx jest` 单个测试也会超时（30s+）
- 可能原因：dotenv 加载触发 LLM 连接初始化，或 `globalSetup` 中有阻塞操作
- 已有 `better-sqlite3` mock，但部分工具测试可能仍需 LLM
- `coverage/` 目录 32MB，说明之前成功运行过覆盖率测试
- Logger.test.ts 单独运行通过（静默退出码0）

### 建议

- 为 CI 环境添加 `--forceExit` 和超时设置
- 考虑添加 `--testTimeout=10000` 到测试配置

---

## 4. 安全审计：✅ **低风险**

| 检查项            | 状态 | 详情                                                   |
| ----------------- | ---- | ------------------------------------------------------ |
| .env API密钥      | ✅   | TAVILY_API_KEY、XIAOMI_API_KEY 已模糊化（显示 \*\*\*） |
| .gitignore        | ✅   | 包含 `.env`, `*.log`, `node_modules`, `dist`           |
| 日志敏感数据      | ✅   | 日志无明文API密钥泄露                                  |
| 前端 node_modules | ✅   | 分离管理（`src/frontend/` 独立 package）               |
| 硬编码密钥        | ✅   | 未发现硬编码 API Key/Secret                            |

### 轻微注意

- Snyk 配置文件 `.snyk` 存在但未集成到 CI 流程
- `npm audit` 未运行（项目使用 `security:audit` 脚本）

---

## 5. 依赖审计：⚠️ **18个包可更新**

### 过期依赖（18个）

| 包名                   | 当前    | 最新       | 差异                |
| ---------------------- | ------- | ---------- | ------------------- |
| **chromadb**           | 1.10.5  | **3.4.3**  | 🚨 major            |
| **eslint**             | 9.39.4  | **10.4.1** | 🚨 major            |
| **express**            | 4.22.1  | **5.2.1**  | 🚨 major            |
| **helmet**             | 7.2.0   | **8.2.0**  | 🚨 major            |
| **node-fetch**         | 2.7.0   | **3.3.2**  | 🚨 major (ESM only) |
| **@nut-tree/nut-js**   | 3.1.2   | **4.2.0**  | 🚨 major            |
| axios                  | 1.16.1  | 1.17.0     | minor               |
| better-sqlite3         | 12.9.0  | 12.10.0    | minor               |
| jest                   | 30.3.0  | 30.4.2     | minor               |
| ws                     | 8.20.1  | 8.21.0     | minor               |
| playwright             | 1.59.1  | 1.60.0     | minor               |
| fs-extra               | 11.3.4  | 11.3.5     | patch               |
| ts-jest                | 29.4.9  | 29.4.11    | patch               |
| eslint-plugin-prettier | 5.5.5   | 5.5.6      | patch               |
| @types/node            | 25.6.0  | 25.9.1     | patch               |
| @types/express         | 4.17.25 | 5.0.6      | major (types)       |
| @typescript-eslint/\*  | 8.59.1  | 8.60.1     | patch               |
| @types/express         | 4.17.25 | 5.0.6      | major               |

### 资源

| 项目                | 大小                  |
| ------------------- | --------------------- |
| `node_modules/`     | **189 MB**（520个包） |
| `package-lock.json` | 397 KB                |

---

## 6. 资源审计

| 目录            | 大小        | 说明                 |
| --------------- | ----------- | -------------------- |
| `node_modules/` | 189 MB      | 520 个包             |
| `coverage/`     | 32 MB       | 覆盖率报告           |
| `data/`         | 17 MB       | 数据库+持久化        |
| `dist/`         | 9 MB        | 编译输出（1388文件） |
| `logs/`         | 956 KB      | 日志（低于50MB阈值） |
| `snapshots/`    | 124 KB      | 快照目录             |
| `tmp/`          | 8 KB        | 临时文件             |
| **总计**        | **~248 MB** |                      |

### 日志清理状态

- `logs/` 仅 956KB — 远低于 50MB 阈值，**无需清理**
- 已保留: `audit.log`, `combined.log`, `error.log`
- 冗余的架构报告文件（`.md`）共6个（~32KB），不影响性能，建议移入 `docs/` 归档

---

## 7. Windows迁移评估：🟡 **L1-核心可迁移**

### 跨平台兼容性

| 依赖                 | WSL | Windows原生           | 备注                         |
| -------------------- | --- | --------------------- | ---------------------------- |
| `better-sqlite3`     | ✅  | ⚠️ 需`node-gyp`重编译 | ✅ `jiabaixing.bat` 已处理   |
| `screenshot-desktop` | ✅  | ✅                    | 原生支持                     |
| `playwright`         | ✅  | ✅                    | 跨平台                       |
| `@nut-tree/nut-js`   | ✅  | ✅                    | 跨平台                       |
| `chromadb`           | ✅  | ❌（WAL问题）         | Windows下WAL文件锁有已知问题 |

### 平台特定代码

- `src/cli.ts` — 3处 `process.platform === 'win32'` 判断（Named Pipe路径）
- `src/daemon/DaemonManager.ts` — 3处 `os.platform() === 'win32'`（SIGKILL替代）
- `src/core/ScenarioAwareScheduler.ts` — 2处 Windows fs.watch 异常处理
- `src/desktop/` — Windows相关代码（窗口管理）

### Windows启动脚本完整性 ✅

| 脚本                  | 状态 | 功能                                         |
| --------------------- | ---- | -------------------------------------------- |
| `jiabaixing.bat`      | ✅   | 英文版启动器，含better-sqlite3重建、端口管理 |
| `家百星.bat`          | ✅   | 中文版启动器，UI更友好                       |
| `install-desktop.ps1` | ✅   | 桌面集成安装脚本                             |
| `scripts/deploy.ps1`  | ✅   | 部署脚本                                     |

### 迁移等级：🟡 **L1-核心可迁移**

- **完全迁移** ❌ — chromadb 3.x 在 Windows 下的 WAL 锁是已知问题
- **L1-核心（无Chroma）** ✅ — 可依赖 SQLite 记忆系统运行
- **迁移工作清单**:
  1. 移除或替换 chromadb 依赖（或升级到 3.x 测试 Windows 兼容性）
  2. 确认 screenshot-desktop 在 Windows 下的截图权限
  3. 桌面自动化（nut-js）可能需要管理员权限运行
  4. `get-foreground-window.ps1` 脚本路径硬编码检查

---

## 8. 与上次审计对比

**⚠️ 首次审计** — 无历史基线。以下为初次基线记录：

| 指标             | 值  | 基线 |
| ---------------- | --- | ---- |
| TypeScript错误数 | 0   | ✅   |
| 测试文件数       | 61  | —    |
| 箭头注册工具     | 58  | —    |
| 依赖过期数       | 18  | —    |
| 安全风险         | 低  | —    |

---

## ⚠️ Top 3 紧急问题

### 🔴 P1: file_search 工具成功率仅 1.5%

- **现状**: 130次调用仅2次成功
- **影响**: 进化引擎记录了大量失败反馈，重复条目占满 engine-state.json
- **建议**: 检查 file_search 实现，确认 WSL 文件系统权限和路径处理逻辑

### 🟡 P2: 测试运行超时无法自动化

- **现状**: 所有 `npx jest` 调用超时（30s内无输出）
- **影响**: CI/CD 和审计无法验证测试通过率
- **建议**: 排查 globalSetup 或 dotenv 加载，增加 `--testTimeout=10000` 配置

### 🟡 P3: chromadb 版本严重滞后（1.10.5 → 3.4.3）

- **现状**: chromadb 落后2个大版本
- **影响**: Windows兼容性问题、安全问题、功能缺失
- **建议**: 评估 chromadb 是否真正使用（vectors.db仅4KB），考虑移除或用 SQLite 替代

---

## ✅ 建议优先修复

1. **修复 file_search** → 这是最影响用户体验的问题
2. **恢复测试运行** → 追加 `testTimeout` 配置和 `--runInBand` 参数
3. **清理 EvolutionEngine 重复条目** → `engine-state.json` 有大量重复反馈
4. **归档旧日志** → 将 `logs/` 下的6个过时 `.md` 报告移入 `docs/`

---

_审计完成时间: 2026-06-04 04:00 UTC | 下次审计建议: 2026-06-11_
