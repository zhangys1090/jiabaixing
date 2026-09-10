# `engine.py` 超大文件拆分专项计划（#6d）

> 状态：🟡 进行中（首批叶子提取已完成，拆分设计如下，待专项轮执行）
> 关联：`docs/INDEX.md` 维护者清单 · `Agent_Audit_Dimensions_Addendum_2026-08-02.md` §治理#6

## 1. 现状（证据）

| 文件 | 行数 | 角色 |
| --- | --- | --- |
| `python/agent/core/engine.py` | **4841** | 单体 `AgentEngine` 上帝类 |
| `python/agent/desktop/desktop_controller.py` | 1023 | 桌面自动化 |
| `python/agent/tools/code_tools.py` | 1393 | 代码工具 |
| `python/agent/memory/engine.py` | 1306 | 记忆引擎 |
| `python/agent/sandbox/executor.py` | 556 | 沙箱执行 |

`main` 审计对象 `agent/core/engine.py`：

- 仅 2 个顶层定义：`build_extension_catalog`（已外提，见 §3）+ `class AgentEngine`。
- `AgentEngine` 含约 **200 个 `_init_*` 方法**（行 144–4836），每个返回一个可选组件（`LLMProvider` / `MemoryEngine` / `MCPToolBridge` / `CronJobScheduler` …），全部在 `initialize()`（行 521）里按拓扑顺序惰性装配。
- 另有 4 个巨型处理路径：`build_context`(1198) / `process_input`(1246) / `_process_with_conversation`(1677) / `_process_with_loop`(2088) / `process_input_stream`(2602)，单行方法超 400 行。

## 2. 拆分原则（不破坏现有 CI 门禁）

现有红线门禁（不可回归）：

1. **import-scan**（`scripts/check_import_scan.py`）—— 引擎启动必构造子系统（`MessageDispatcher`/`PlatformManager`/`RelayAdapter`）无参实例化；任何改名/重绑定导致 `AttributeError` 即 `exit 1`。
2. **silent-except 棘轮** —— 新增静默吞异常锁为 0（基线 0）。
3. **引擎初始化集成测试** —— `initialize()` 在 Python 模式必须成功装配全部非 critical 子系统。

因此拆分**必须保持 `agent.core.engine.AgentEngine` 公共签名不变**，采用「内聚提取 + 自由函数委托」而非「删方法」。

## 3. 已完成的首批（安全叶子提取）

- `build_extension_catalog`（原 44–65 行，纯函数，无引擎状态耦合）→ 提取至
  `python/agent/core/extension_catalog.py`，`engine.py` 通过 `from agent.core.extension_catalog import build_extension_catalog` re-export。
- 对外签名零变化：测试 `tests/test_extension_catalog_runtime.py` 仍 `from agent.core.engine import build_extension_catalog` 通过。
- 净减 `engine.py` ≈ 22 行，验证：import-scan PASS、该测试 PASS。

## 4. 推荐拆分方案（分阶段，按内聚域归类）

### 阶段 A — `_init_*` 按子系统聚类为 bootstrap 模块

新建 `python/agent/core/bootstrap/`，将约 200 个 `_init_x(self)` 转为自由函数：

```python
# agent/core/bootstrap/llm_memory.py
async def init_llm(engine: "AgentEngine") -> "LLMProvider | None":
    ...  # 原 engine._init_llm 体

# engine.py
from agent.core.bootstrap.llm_memory import init_llm
async def _init_llm(self):  # 保持方法名以最小改动委托
    self.llm = await init_llm(self)
```

建议分组（对应现有 `_init_*` 簇）：

| 新模块 | 涵盖的 `_init_*` | 估算行数 |
| --- | --- | --- |
| `bootstrap/llm_memory.py` | `_init_llm` / `_init_memory` / `_init_trajectory_db` / `_init_memory_providers` / `_init_memory_manager` | ~120 |
| `bootstrap/tools.py` | `_init_tool_registry` / `_init_toolset_registry` / `_init_mcp_tool_bridge` / `_init_permission_guard` / `_init_schema_validator` / `_init_tool_call_guard` / `_init_approval_manager` / `_init_tool_search` | ~180 |
| `bootstrap/context.py` | `_init_context_*`(14 个) / `_init_conversation` / `_init_coding_context` | ~220 |
| `bootstrap/evolution.py` | `_init_evolution` / `_init_evolution_trigger` / `_init_fewshot_generalizer` / …(约 20 个 evolution/learning) | ~240 |
| `bootstrap/a2a.py` | `_init_a2a_*`（7 个） / `_init_agent_registry` / `_init_orchestrator` | ~200 |
| `bootstrap/security.py` | `_init_security` / `_init_verification` / `_init_output_guardrail` / `_init_path_security` / `_init_url_safety` / `_init_ssl_guard` / `_init_redaction` / `_init_threat_patterns` | ~160 |
| `bootstrap/session.py` | `_init_session_store` / `_init_session_recap` / `_init_session_search_index` / `_init_session_lineage` | ~120 |
| `bootstrap/gateway_cli.py` | `_init_gateway_*` / `_init_cli_output` / `_init_curses_tui` / `_init_pty_bridge` / `_init_shell_completion` / `_init_clipboard` | ~200 |
| `bootstrap/infra.py` | `_init_redis_cache` / `_init_web_search` / `_init_cron_scheduler` / `_init_sandbox` / `_init_batch_processor` / `_init_production_metrics` | ~160 |

提取后 `engine.py` 保留：`AgentEngine` 壳 + `initialize()` 编排 + 委托方法 + 巨型处理路径（阶段 B）。

### 阶段 B — 巨型处理路径外提

| 新模块 | 来源方法 | 估算行数 |
| --- | --- | --- |
| `core/processing/context_build.py` | `build_context`(1198) | ~48 |
| `core/processing/simple.py` | `_process_simple`(1508) | ~170 |
| `core/processing/conversation.py` | `_process_with_conversation`(1677) | ~410 |
| `core/processing/loop.py` | `_process_with_loop`(2088) / `_auto_reflect`(2530) | ~530 |
| `core/processing/stream.py` | `process_input_stream`(2602) | ~295 |

阶段 B 风险最高（跨方法共享大量 `self` 状态与局部闭包如 `log_tool_call`），建议每个方法整体平移为 `async def process_x(engine, ...)` 并保持内部 `self.` 访问通过参数 `engine.`，逐方法灰度并配套单测。

## 5. 执行护栏（每步必做）

1. 每次提取后跑 `python scripts/check_import_scan.py` + `python scripts/check_silent_except.py` → 必须全绿。
2. 提取后跑 `python -m pytest tests/test_extension_catalog_runtime.py tests/test_gateway.py -q`（引擎装配相关）。
3. 每阶段一个独立 commit（严禁 `git add -A`），PR 描述标注「#6d 阶段 X」。
4. 禁止在提取过程中改写方法业务逻辑——纯机械搬迁，行为变更另开 PR。

## 6. 验收

- `engine.py` 行数降至 < 1500（保留编排 + 处理路径委托）。
- import-scan / silent-except / 引擎初始化集成测试全绿。
- 无公共 API 签名变化（`AgentEngine` 方法名保留作委托壳）。
