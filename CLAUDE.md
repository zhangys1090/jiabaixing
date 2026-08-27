# Jiabaixing V6.0 — Claude Code 开发指南

> 为 Claude Code 和所有 AI 编码助手定制的项目上下文

---

## 一句话说明

家百星 V6.0 是一个混合架构 Agent Framework：Python 主循环(ReAct+Checkpoint+CancellationToken) + TypeScript Harness(E-T-C-S-L-V 六层管控) + 33工具 + 进化引擎。运行在 Python 3.11+ / Node.js 20.x + Express + SQLite/ChromaDB。

## 项目定位

- **当前状态**: V6.0 混合架构，Python主循环10项弱实现已修复，Harness六层管控已成型
- **不是**: 重新发明轮子的AI框架——核心价值是六层Harness管控 + 主循环鲁棒性 + 进化引擎
- **核心亮点**: E-T-C-S-L-V 六层独立开关、33个声明式工具(8类)、EvolutionEngine、110条轨迹数据、Checkpoint/CancellationToken/声明式超时
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

P0 — 主循环鲁棒性（V6.0 已修复）:

- ✅ W1: Checkpoint暂停/恢复 — LoopCheckpoint序列化/反序列化，长任务失败可恢复
- ✅ W2: 工具执行超时控制 — 声明式per-tool超时 + asyncio.wait_for强制终止
- ✅ W5: CancellationToken — 协作式取消令牌，外部可中断长时间运行Agent
- ✅ W3: 错误重试策略 — ErrorClassifier语义化分类替代字符串匹配

P0 — 长任务模式（V6.0 新增，参考Codex Harness）:

- ✅ LongTaskOrchestrator — Codex风格长任务编排（分解→并行→checkpoint→验证→恢复）
- ✅ TaskBudget — token/time/iteration三维预算硬限制
- ✅ TaskCheckpointStore — 渐进式检查点持久化（JSON文件存储）
- ✅ 子任务DAG编排 — 无依赖并行，有依赖拓扑排序
- ✅ 长任务API — /v1/long-task/{submit,status,cancel,resume,subtasks,checkpoints}

P1 — Harness集成（V6.0 已修复）:

- ✅ W6: TraceLog记录完整 — 20种事件类型（含LLM_REQUEST/APPROVAL/CHECKPOINT等）
- ✅ W9: VerificationLoop深度集成 — pre_tool + post_tool + post_response三阶段验证
- ✅ W10: 策略选择可配置 — strategy_hint参数控制执行策略偏好
- ✅ W7: 上下文截断Token计数 — 基于token预算而非消息条数

P1 — 桌面自动化（V6.0 已修复）:

- ✅ D2: UAC窗口检测 — \_detect_uac_block()操作前检测提权提示
- ✅ D3: 中文输入法兼容 — type_text自动切换剪贴板粘贴策略

P2 — UX打磨:

- ✅ W4: 并行工具依赖声明 — \_resolve_tool_dependencies()DAG拓扑排序防止读写冲突
- ✅ W8: 流式中间结果 — run_stream新增llm_request/llm_response/tool_progress/checkpoint/verification事件
- 配置文件热加载
- 错误用户提示优化

---

## V6.0 主循环弱实现修复摘要

| 优先级 | 编号 | 弱实现                     | 修复方案                                                                     | 涉及文件                            |
| ------ | ---- | -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| P0     | W1   | 无Checkpoint暂停/恢复      | LoopCheckpoint数据类 + run(checkpoint=) 恢复 + last_checkpoint属性           | turn_types.py, conversation_loop.py |
| P0     | W2   | 工具执行无超时控制         | \_get_tool_timeout() + asyncio.wait_for + ToolDefinition.timeout字段         | conversation_loop.py, registry.py   |
| P1     | W3   | 错误重试策略过于简单       | ErrorClassifier.classify() 替代字符串匹配                                    | conversation_loop.py                |
| P1     | W4   | 并行工具无依赖声明         | \_resolve_tool_dependencies() DAG拓扑排序                                    | conversation_loop.py                |
| P1     | W5   | 无CancellationToken        | CancellationToken类 + run(cancellation_token=) + while循环检查               | turn_types.py, conversation_loop.py |
| P1     | W6   | TraceLog记录不完整         | TraceEventType扩展至20种（LLM_REQUEST/APPROVAL_REQUEST/CHECKPOINT_SAVE等）   | trace_log.py, conversation_loop.py  |
| P2     | W7   | 上下文截断策略粗糙         | token预算截断 + is_token_exhausted触发                                       | conversation_loop.py                |
| P2     | W8   | 无流式中间结果             | run_stream新增llm_request/llm_response/tool_progress/checkpoint/verification | conversation_loop.py                |
| P2     | W9   | VerificationLoop未深度集成 | \_pre_tool_verify() + \_post_response_verify()                               | conversation_loop.py                |
| P2     | W10  | 策略选择逻辑不透明         | strategy_hint参数 + strategy_hint属性                                        | conversation_loop.py                |

---

## 安全提醒

- 不提交 .env 到 Git
- SQLite 使用参数化查询
- Express 路由使用 helmet 安全头
- 所有用户输入需验证
- 工具调用有 PermissionGuard

---

## 防御性编程规范（P0 级强制）

> 以下规则源自 2026-08 架构审计，修复了 70+ 处 P0 级内存泄漏和资源耗尽问题。所有新代码必须遵守。

### 1. 所有 dict/list/set 实例属性必须声明容量上限

长时间运行的 Agent 进程中，无容量限制的集合会持续增长直到 OOM。这是本项目最大的系统性缺陷。

**规则**：每个 `self._xxx: dict | list | set` 必须在 `__init__` 中声明对应的 `self._MAX_XXX` 常量。

```python
# ✅ 正确
def __init__(self) -> None:
    self._cache: dict[str, str] = {}
    self._MAX_CACHE = 5000

# ❌ 错误 — 无容量上限
def __init__(self) -> None:
    self._cache: dict[str, str] = {}
```

### 2. 所有集合写入点必须添加 LRU 清理

在数据写入（`append`、`dict[key]=value`、`add`）之后，必须检查容量并淘汰旧数据。

**统一清理模式（75% 保留率）**：

```python
# dict 类型 — 按插入顺序淘汰最旧
self._cache[key] = value
if len(self._cache) > self._MAX_CACHE:
    oldest_keys = list(self._cache.keys())[: len(self._cache) - (self._MAX_CACHE * 3 // 4)]
    for k in oldest_keys:
        del self._cache[k]

# list 类型 — 保留最近的数据
self._history.append(entry)
if len(self._history) > self._MAX_HISTORY:
    self._history = self._history[-self._MAX_HISTORY * 3 // 4:]

# set 类型 — 转为 list 截取
self._ids.add(new_id)
if len(self._ids) > self._MAX_IDS:
    self._ids = set(list(self._ids)[-(self._MAX_IDS * 3 // 4):])
```

**关联集合必须协调清理**：当多个字典共享同一 key 空间时，删除一个 key 必须同步删除其他字典中的对应条目。

```python
# ✅ 关联清理
if len(self._usage_counts) > self._MAX_CACHED_IDS:
    sorted_ids = sorted(self._last_access.items(), key=lambda x: x[1])
    to_remove = sorted_ids[: len(self._usage_counts) - (self._MAX_CACHED_IDS * 3 // 4)]
    for mid, _ in to_remove:
        self._usage_counts.pop(mid, None)
        self._last_access.pop(mid, None)
        self._importance_cache.pop(mid, None)
```

### 3. 禁止模块级可变状态跨会话共享

模块级变量（如 `_correction_round = 0`）在所有会话/请求间共享，导致状态泄漏和竞态条件。

**规则**：所有可变状态必须绑定到实例（`self._xxx`），不得使用模块级变量。

```python
# ❌ 错误 — 模块级变量，所有会话共享
_correction_round = 0

# ✅ 正确 — 实例属性，每个会话独立
class LoopController:
    def __init__(self) -> None:
        self._correction_round = 0
```

### 4. API 端点必须验证所有输入

未验证的输入可被恶意利用，导致注入攻击或服务崩溃。

**规则**：每个 API 端点必须验证请求体的类型、长度和取值范围。

```python
# ✅ 正确
@router.post("/sessions")
async def create_session(request: Request) -> JSONResponse:
    body = await request.json()
    user_id = body.get("user_id", "")
    if not isinstance(user_id, str) or not user_id.strip():
        return JSONResponse({"error": "user_id is required"}, status_code=400)
    if len(user_id) > 256:
        return JSONResponse({"error": "user_id too long"}, status_code=400)
```

### 5. 数据库连接必须使用上下文管理器

未关闭的连接会耗尽连接池，导致后续请求失败。

**规则**：所有数据库操作必须使用 `with` 语句或 `try/finally` 确保连接释放。

```python
# ✅ 正确
def get_session(self, session_id: str) -> Session | None:
    with self._get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return Session(**dict(row)) if row else None

# ❌ 错误 — 连接可能泄漏
def get_session(self, session_id: str) -> Session | None:
    conn = self._get_connection()
    row = conn.execute(...).fetchone()
    conn.close()  # 如果 execute 抛异常，连接永远不会关闭
```

### 容量上限参考值

| 数据类型       | 推荐上限     | 说明                   |
| -------------- | ------------ | ---------------------- |
| 缓存字典       | 5,000–50,000 | 视缓存粒度而定         |
| 历史记录列表   | 1,000–5,000  | 保留最近记录即可       |
| 用户会话字典   | 5,000–50,000 | 活跃用户数             |
| 事件处理器列表 | 50–200       | 每个事件类型的处理器数 |
| 统计字典       | 200–500      | 按场景/工具/策略分桶   |
| 主题/队列字典  | 100–200      | 消息队列主题数         |
| 嵌入向量列表   | 5,000–10,000 | 向量检索文档数         |

### 例外情况（无需容量限制）

以下情况可以豁免容量限制，但必须在代码注释中说明理由：

1. **每次执行重置的临时数据** — 如 `SandboxExecutor._logs`，每次 `execute()` 调用开始时清空
2. **静态配置数据** — 如 `SkillAuditor._allowed_modules`，初始化后不再增长
3. **固定键的统计字典** — 如 `StrategyAdapter._stats`，键在 `__init__` 中确定，不会新增
4. **已有独立淘汰机制的缓存** — 如 `LRUCache._cache`，内部已实现 LRU 淘汰

### 6. 禁止硬编码密钥/Token/密码

所有密钥、Token、密码必须通过环境变量或安全存储获取，不得在源码中出现字面值。

```python
# ❌ 错误 — 硬编码密钥
adapter = SlackAdapter(bot_token="xoxb-...", app_token="xapp-...")

# ✅ 正确 — 环境变量
adapter = SlackAdapter(
    bot_token=os.environ["SLACK_BOT_TOKEN"],
    app_token=os.environ["SLACK_APP_TOKEN"],
)
```

**文档示例也必须使用 `os.environ`**，因为示例代码经常被直接复制到生产环境。

### 7. 所有 HTTP 客户端必须设置超时

无超时的 HTTP 请求可能永久挂起，耗尽连接池和协程资源。

**规则**：`httpx.AsyncClient()` / `aiohttp.ClientSession()` 必须在构造时传入 `timeout` 参数。

```python
# ❌ 错误 — 无超时，请求可能永久挂起
async with httpx.AsyncClient() as client:
    resp = await client.get(url)

# ✅ 正确 — 构造时设置超时
async with httpx.AsyncClient(timeout=30.0) as client:
    resp = await client.get(url)
```

**推荐超时值**：普通 API 调用 30s，LLM 流式请求 120s，代理转发 60s。

### 8. 禁止吞没异常（except + pass 无日志）

`except Exception: pass` 完全隐藏错误信息，使调试成为不可能。`__del__` 和 `close()` 中的 `pass` 可以接受，但其他位置必须记录日志。

```python
# ❌ 错误 — 异常被完全吞没
except Exception:
    pass

# ✅ 正确 — 至少记录日志
except Exception as _exc:
    log.warning("操作失败，降级处理", error=str(_exc))
```

### 9. 数据库连接持有类必须实现 close() 和 **del**

使用 `threading.local` 或实例属性持有数据库连接的类，必须提供 `close()` 方法和 `__del__` 兜底，防止连接泄漏。

```python
# ✅ 正确
class LLMCache:
    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(str(self._db_path))
        return self._local.conn

    def close(self) -> None:
        if hasattr(self._local, "conn") and self._local.conn is not None:
            try:
                self._local.conn.close()
            except Exception:
                pass
            self._local.conn = None

    def __del__(self) -> None:
        self.close()
```

### 10. API 请求模型必须使用 Pydantic 验证器

FastAPI 端点的请求体必须通过 Pydantic `model_post_init` 或 `Field` 约束验证输入，禁止接受任意字符串。

```python
# ❌ 错误 — role 字段接受任意值
class AddMessageRequest(BaseModel):
    role: str
    content: str

# ✅ 正确 — 限制 role 取值范围和 content 长度
class AddMessageRequest(BaseModel):
    role: str
    content: str

    def model_post_init(self, __ctx: object) -> None:
        _VALID_ROLES = {"user", "assistant", "system", "tool"}
        if self.role not in _VALID_ROLES:
            raise ValueError(f"Invalid role: {self.role}")
        if len(self.content) > 100_000:
            raise ValueError("content too long")
```

### 11. 异常日志必须包含错误详情

`except Exception:` 后的 `log.xxx("异常处理")` 不记录异常信息，调试时无法定位根因。

```python
# ❌ 错误 — 日志无异常详情，无法定位问题
except Exception:
    log.warning("异常降级处理")

# ✅ 正确 — 捕获异常并记录详情
except Exception as _exc:
    log.warning("异常降级处理", error=str(_exc))
```

### 12. 异步锁批量获取必须支持失败回滚

连续 `await lock.acquire()` 时，如果中途失败或被取消，已获取的锁不会释放，导致死锁。

```python
# ❌ 错误 — 中途失败导致死锁
for p in paths:
    await self._path_locks[p].acquire()

# ✅ 正确 — 失败时释放已获取的锁
for p in paths:
    try:
        await self._path_locks[p].acquire()
        acquired.append(p)
    except BaseException:
        for ap in reversed(acquired):
            self._path_locks[ap].release()
        raise
```

### 13. 文件路径必须校验路径遍历

文件操作工具接受用户输入的路径时，必须检查 `../` 等路径遍历攻击特征。

```python
# ❌ 错误 — 未校验路径遍历
def _resolve_path(raw_path: str) -> Path:
    return Path(raw_path).resolve()

# ✅ 正确 — 使用 PathSecurityGuard 校验
from agent.security.path_security import PathSecurityGuard
_path_guard = PathSecurityGuard()

def _resolve_path(raw_path: str) -> Path:
    if _path_guard.is_path_traversal(raw_path):
        raise ValueError(f"路径包含非法遍历字符: {raw_path}")
    return Path(raw_path).expanduser().resolve()
```

### 14. SQL ORDER BY 必须使用显式列映射

动态排序字段如果直接拼接进 SQL，存在 SQL 注入风险。必须使用白名单映射。

```python
# ❌ 错误 — SQL 注入风险
sql = f"SELECT * FROM table ORDER BY {sort_by} DESC"

# ✅ 正确 — 显式列映射
valid_sort = ("usage_count", "success_rate", "created_at")
if sort_by not in valid_sort:
    raise ValueError(f"Invalid sort_by: {sort_by}")
sort_col = {"usage_count": "usage_count", ...}[sort_by]
sql = f"SELECT * FROM table ORDER BY {sort_col} DESC LIMIT ?"
```
