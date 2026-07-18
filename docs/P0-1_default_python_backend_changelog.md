# P0-1 实施记录：默认激活 Python 后端

> **目标**：消除"开箱默认跑残缺 TS 本地实现"的隐性故障——所有新增节点的地基。
> **日期**：2026-07-10
> **关联**：`Jiabaixing_Node_Gap_And_Add_Proposals_2026-07-10.md` P0-1、架构原则（AGENTS.md §0）

---

## 一、问题根因（修复前）

| 环节                                    | 修复前状态                                                      | 后果                                                                                    |
| --------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `JiabaixingCore.ts:544`                 | `process.env.AGENT_BACKEND === 'python'` 严格相等判断，无默认值 | 未设环境变量即走 TS 本地（大量 `@deprecated` 模块）                                     |
| `bootstrap.ts` 桥接块                   | `if (process.env.AGENT_BACKEND === 'python')` 才连接 Python     | 未设变量则不连接 Python 桥                                                              |
| `isPythonBackend()`                     | `AGENT_BACKEND === 'python' && pythonBridge !== null`           | 仅检查环境变量字符串，不反映真实桥接状态                                                |
| 启动脚本（`start.sh`/`run.sh`/`*.bat`） | 仅拉起 TS 网关，**从不启动 Python uvicorn**                     | 即使设了 `AGENT_BACKEND=python`，网关连接空端口 → `healthCheck` 失败 → 静默降级 TS 本地 |
| `.env` / `.env.example`                 | 未设 `AGENT_BACKEND`；`APP_VERSION=2.0.0`（与 V5.0 不符）       | 文档声称"Python 为默认"，实际开箱即 TS 本地                                             |

**关键认知**：仅改代码默认值不够——启动脚本必须**同时拉起 Python 进程**，否则"默认 Python"形同虚设。

---

## 二、修复方案（双层保险）

### 1. 代码层：未设置 `AGENT_BACKEND` 时默认按 Python 处理

| 文件                             | 改动                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/JiabaixingCore.ts`     | `processInput` 路由条件改为 `(process.env.AGENT_BACKEND ?? 'python') === 'python'`，保留 `&& this.pythonBridgeResolver` 守卫（未桥接/测试场景安全降级）                                                                            |
| `src/server/bootstrap.ts`        | ① 桥接块条件改为 `usePythonBackend`（未设置 / `python` / 其他值 → 默认 Python；仅显式 `local`/`ts`/`ts-local` 回退 TS 本地）<br>② `isPythonBackend()` 改为直接返回 `pythonBridge !== null`，**反映真实桥接状态**而非环境变量字符串 |
| `src/server/routes/acpRoutes.ts` | 无需改动（其 `isPythonBackend` 已是 `backend !== 'local'`，与默认 Python 语义一致）                                                                                                                                                |

**为什么改 `isPythonBackend()` 安全**：

- 该函数所有调用点（`bootstrap.ts` IPC 处理、`websocket.ts`、`coreRoutes.ts`、`chatRoutes.ts`）均在**请求时刻**执行，晚于启动期的桥接块（bootstrap 第 582 行）。
- 桥接块在 Python 健康时设置 `pythonBridge`，不健康时置 `null`。因此 `pythonBridge !== null` 在请求时刻精确反映"是否真在用 Python 后端"。
- 显式 `AGENT_BACKEND=local` 时桥接块不连接，`pythonBridge` 恒为 `null` → 正确回退 TS 本地。

### 2. 配置层：显式声明 + 版本号修正

| 文件           | 改动                                                       |
| -------------- | ---------------------------------------------------------- |
| `.env`         | 新增 `AGENT_BACKEND=python`；`APP_VERSION=2.0.0` → `5.0.0` |
| `.env.example` | 同上                                                       |

### 3. 启动脚本层：best-effort 拉起 Python 并等待就绪

所有启动脚本统一新增：**通过 `.venv/Scripts/python.exe` 在 `127.0.0.1:3112` 拉起 `uvicorn agent.main:app`，并在启动 TS 网关前轮询 `GET /health`（最多 ~40s）**。

| 脚本             | 改动要点                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `start.sh`       | 新增 `SCRIPT_DIR` 定义 + `start_python_backend()` 辅助函数；`start_dev()` 中在 `npm start` 前调用 |
| `run.sh`         | 新增 `start_python_backend()`；`cleanup()` 增加 Python PID 清理；启动后端前调用                   |
| `start.bat`      | `:start_dev` 中 `npm start` 前插入 Python 拉起 + 等待块                                           |
| `jiabaixing.bat` | `[1/4]` 后端启动前插入 Python 拉起 + 等待块                                                       |
| `家百星.bat`     | 同上                                                                                              |

**非致命设计**：

- 虚拟环境 / `python/` 目录缺失 → 打印警告，继续用 TS 本地（已废弃）。
- Python 启动超时（40s 内 `/health` 无响应）→ `bootstrap.ts` 的 `healthCheck` 仍会失败并降级 TS 本地，不会卡死。
- 端口对齐：Python `config.py:26` 默认 `AGENT_PORT=3112`，与 `bootstrap.ts` 的 `PYTHON_AGENT_URL` 默认 `http://localhost:3112` 完全一致。

---

## 三、架构影响面

| 入口                                    | 是否受益     | 说明                                                                                |
| --------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| HTTP/WS 网关（`main.ts` → `bootstrap`） | ✅           | 主入口，P0-1 直接生效                                                               |
| Electron 桌面端（`BackendLauncher.js`） | ✅           | 已独立拉起 uvicorn(8765)，与本次 3112 不冲突；网关默认 Python 后桥接更稳            |
| CLI（`src/cli/`，含 REPL/daemon）       | ✅           | CLI 是网关的**客户端**（经 IPC/HTTP 发送消息），网关默认 Python 即覆盖              |
| Docker / K8s                            | ✅（无影响） | `docker-compose.yml` / `kubernetes/configmap.yaml` 早已显式 `AGENT_BACKEND: python` |

---

## 四、验证清单

| 验证项              | 方法                                                                                                       | 预期                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------ |
| TS 编译无新增错误   | `npx tsc --noEmit`                                                                                         | 改动文件 0 新增错误      |
| Python 启动命令有效 | 经 `.venv/Scripts/python.exe -m uvicorn agent.main:app --host 127.0.0.1 --port 3112` 拉起并 `curl /health` | 返回 200 + `status:"ok"` |
| 启动脚本端口对齐    | 检查 `PYTHON_AGENT_URL` 默认 3112 == `AGENT_PORT` 3112                                                     | 一致                     |
| 降级路径可用        | `AGENT_BACKEND=local` 或不启动 Python                                                                      | 网关降级 TS 本地，不崩溃 |

---

## 五、后续建议（不在本次范围）

1. **补充 Python 不可用时的人工告警**：当前静默降级，建议在 `bootstrap.ts` 降级分支增加一次 `console.warn`/日志，提示用户"Python 后端未启用，新节点能力不可用"。
2. **CLI 核心路径核对**：`src/cli/` 无任何 `JiabaixingCore`/`bootstrap` 引用，需确认 CLI 的所有能力命令（chat/skills/memory/evolution）确实通过网关转发到 Python，而非遗漏了本地实现。
3. **文档统一**：ARCHITECTURE.md 仍描述 TS 中心 + ChromaDB，与现有 Python 中心 + SQLite/FTS5 + 向量不符，建议本轮一并修订。
