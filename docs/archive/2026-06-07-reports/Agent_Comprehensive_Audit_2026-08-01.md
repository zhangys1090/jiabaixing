# 家百星（jiabaixing）Agent 全面审计报告

> 审计日期：2026-08-01 | 审计方式：只读源码勘验 + 探针实跑，**不采信任何文档宣称**
> 审计基线：commit `52e70ab` | TS `src/` 550 文件 / 164,125 行；Python `python/agent/` 358 文件 / 124,639 行

---

## 〇、执行摘要

| 指标 | 结论 |
|---|---|
| **整体完成度** | **≈62%** |
| **Agent 编程能力综合分** | **51 / 100**（主流基线 = 85） |
| **最强项** | 代码审查（持平甚至优于主流）、工具广度（98 个）、Python Agent 核心层（80%） |
| **最弱项** | 测试链路 **0%**、重构链路 **0%**、Git 链路 **0%** |
| **最高优先级架构债** | **双脑并行**：TS Harness(46K 行) 与 Python Agent(124K 行) 功能重叠、同时初始化、数据分两根存储 |
| **P0 阻塞项数** | 7 |

**一句话定位**：这是一个**"通用生活/桌面 Agent + 编程副能力"**的框架，而非编程助手。98 个工具中真正服务编程的约 25 个。项目**不是空壳**——规划、ReAct、反思均为真实 LLM 驱动实现，质量高于多数同类；真正的问题不是"假实现"，而是**接线断裂（orphan）与静默降级**。→ 两类缺陷的逐项根因 / 风险 / 修复优先级矩阵见 **§1.6–§1.8**。

---

# 第一部分：Agent 能力对标分析

## 1.1 编程能力差距矩阵（对标 Claude Code / Cursor / Copilot Agent / Codex CLI）

评分标准：0=缺失，2=stub/空壳，5=部分可用，8=基本对齐，10=对齐或超越主流

| # | 能力维度 | 得分 | 主流基线 | 差距 | 关键证据 |
|---|---|---|---|---|---|
| 1 | 任务理解与规划 | **8** | 10 | -2 | `loop/planner.py:22` 真 LLM 复杂度判定(:83-105)+任务分解(:183)+工具名幻觉纠正(:243)；ToT/Hierarchical/MCTS 三规划器均已接线 |
| 2 | ReAct 执行循环 | **8** | 10 | -2 | `controller.py:809` 真闭环，`_react_think_structured`:1042→`_react_act`:1150→`_react_observe`:1184，多轮自纠错:939-1027 |
| 3 | 工具调用体系 | **6** | 10 | -4 | 98 个工具已注册；权限五级串检 `permission_guard.py:207`；**并行执行器已于 2026-08-02 接线（P1-6/W1 ✅），但仍缺工具级重试/超时精细控制** |
| 4 | 上下文管理 | **7** | 10 | -3 | 六路 token 预算 `token_budget.py:97`+四策略压缩 `context_compressor.py:314-402`；缺 `/compact` |
| 5 | 记忆系统 | **4** | 9 | -5 | **无任何向量库**（chromadb/faiss/qdrant 全仓 0 引用），`memory/store.py:345-367` 为 O(N) 全表扫描+逐行 embedding |
| 6 | 文件编辑 | **6** | 10 | -4 | `file_edit`/`incremental_edit`/`multi_file_edit`（带原子回滚 `file_tools.py:648-656`）；**无 read-before-edit 约束、无真 unified diff、无 file_write** |
| 7 | 代码搜索 | **4** | 10 | -6 | 有 glob + 纯 Python 正则 grep；**无 ripgrep、无代码 embedding 索引、无 AST 搜索**（tree_sitter/ts-morph 零引用） |
| 8 | 代码生成 | **5** | 10 | -5 | Python 侧纯 LLM 无后处理；**TS 侧 `code_generate.ts:182-289` 返回硬编码 `// TODO: 实现核心逻辑` 模板** |
| 9 | **代码审查** | **9** | 8 | **+1** | 三/四层审查（规则+安全+LLM，`code_tools.py:614-619`）+项目级扫描 `code_review_project.ts:17`+17 条安全正则；**唯一超越主流项** |
| 10 | 调试能力 | **4** | 9 | -5 | 能跑代码取 stderr；**`error_classifier.py:50-62` 是 LLM API 错误分类器（RATE_LIMIT/AUTH_FAILED），与代码调试无关**；无堆栈解析 |
| 11 | **重构能力** | **0** | 8 | **-8** | rename_symbol / extract_function / impact_analysis / dependency_graph **全仓零命中**；`lsp_references` 存在但无消费方 |
| 12 | **测试能力** | **0** | 9 | **-9** | 无测试生成、无测试运行、无失败解析、无覆盖率读取工具 |
| 13 | Shell / 沙箱 | **7** | 9 | -2 | 安全极强（黑名单 24+正则 30+白名单+`shell=False`）；**但无后台任务（nohup/tmux 被禁）、TS 侧 `execSync` 同步阻塞** |
| 14 | **Git 集成** | **1** | 10 | **-9** | 零专用工具，仅靠 `shell_exec` 白名单放行 `git`；无 commit/diff/PR 结构化封装 |
| 15 | LSP / IDE | **5** | 9 | -4 | pyright 真子进程调用 `lsp_tools.py:294-308`；**非 Python 语言已于 2026-08-02 改 `success=False` 明确 unsupported（P0-7 ✅），不再误导 LLM 继续推理** |
| 16 | 子代理/多智能体 | **5** | 9 | -4 | `MultiAgentOrchestrator` 真并行(`agent_factory.py:747`)；`delegate_tool.py` 子 Agent 已具备白名单 + 独立 ReAct 循环 + 沙箱子注册表隔离 + 深度守卫，P2-6 加固已完成（`tests/test_p2_6_subagent_sandbox.py`） |
| 17 | 验证与自纠错 | **4** | 9 | -5 | `verification_loop.py:76` 存在；**但 `VerifyAction.RETRY` 只记录不触发重执行**（engine.py:2104-2107），`build_correction_prompt` 无调用方 |
| | **加权总分** | **51/100** | 85 | **-34** | |

## 1.2 能力雷达速览

```
规划分解  ████████░░ 8
ReAct循环 ████████░░ 8
代码审查  █████████░ 9  ← 唯一超越主流
上下文    ███████░░░ 7
Shell沙箱 ███████░░░ 7
工具体系  ██████░░░░ 6
文件编辑  ██████░░░░ 6
LSP/IDE   █████░░░░░ 5
代码生成  █████░░░░░ 5
子代理    █████░░░░░ 5
记忆系统  ████░░░░░░ 4
代码搜索  ████░░░░░░ 4
调试      ████░░░░░░ 4
验证自纠  ████░░░░░░ 4
Git       █░░░░░░░░░ 1
重构      ░░░░░░░░░░ 0  ← 完全缺失
测试      ░░░░░░░░░░ 0  ← 完全缺失
```

## 1.3 优势项（值得保留与强化）

| 优势 | 证据 | 说明 |
|---|---|---|
| **代码审查体系** | `code_tools.py:593` + `code_review_project.ts:17` + `security_guidance.ts:89-167` | 三层审查 + 项目级扫描 + 17 条安全正则（硬编码密钥/AWS Key/SQL 注入/XSS），主流助手多为纯 prompt 驱动，本项目有结构化规则引擎 |
| **规划器多样性** | ToT / Hierarchical / MCTS 三套规划器均已真实接线 | 超出多数同类，主流助手通常只有单一线性规划 |
| **Shell 安全纵深** | `code_tools.py:80/92/307-329` | 黑名单+正则+白名单+沙箱预检+`shell=False`+`shlex.split` 五道闸，安全性强于 Claude Code 默认配置 |
| **工具广度** | 98 个工具（桌面自动化/浏览器/IoT/语音/OCR） | 泛 Agent 场景覆盖远超编程助手 |
| **CI 自定义门禁** | `check-no-tautology-tests.mjs`、`check-core-tool-schema.mjs`、`doc-derived-audit.mjs`（**实跑 37 PASS / 0 FAIL**） | 反"恒真测试"与"文档与代码脱节"的自建红线，行业罕见 |

## 1.4 「孤儿代码」清单 —— 本次审计最重要的发现

**这些不是骨架，是"写完了但没接线"的成品**。它们是"文档宣称已完成但实际不生效"的根源：

| # | 孤儿组件 | 规模 | 证据 | 后果 |
|---|---|---|---|---|
| O1 | **ParallelToolExecutor** | `core/tool_executor.py:68`，含 Semaphore(max=8)、`asyncio.gather`、依赖分组 | `engine.py:639` + `engine_extensions.py:46` 各实例化一次，**`tool_executor.execute()` 全仓零调用点**（已实测 grep 验证） | 主循环实际串行（`conversation_loop.py:266-275` 逐个 `await`），多工具任务耗时 = N × 单次耗时 |
| O2 | **MultiAgentCoordinator** | `evolution/multi_agent.py:168`，616 行，四种协作模式+MQ+冲突消解 | `engine.py:4649` 实例化，但 `register()`/`set_handler()` **生产代码零调用**（仅测试文件调用） | `_agents` 恒空 → `find_best_agent` 恒返 None → delegate 恒返回"无可用 Agent"(:291) |
| O3 | **todo 工具** | `tools/todo_tool.py:264` 已注册 | ⚠️ **误判（非孤儿）**：`registry.py:656` 调 `register_todo_tool`、`engine.py:4013` 初始化 `TodoManager`，为 LLM 可调用的活工具；"loop 零引用"仅指未被 loop 强制使用 | 实际已接线，无需处置（保留） |
| O4 | **VerifyAction.RETRY** | `core/verification_loop.py:147` | `engine.py:2104-2107` 仅 `record_step` 记录，未触发重执行；`build_correction_prompt`(:228) 无调用方 | 验证层形同虚设，验证失败不产生任何行为改变 |
| O5 | **`python/agent/cache/`** | 8 文件 / 1,472 行统一缓存抽象 | 跨模块引用数 = **0**，实际生效的是 `memory/redis_cache.py` | 两套缓存并存，1,472 行死投入 |
| O6 | **`src/gateway/`** | 2 文件 / 157 行，自述"V6.0 替代 src/harness/" | `new AgentGateway` 全仓出现 **0 次** | V6.0 收口愿景 0% 落地 |
| O7 | **`convert_openai_tool_calls`** | `core/tool_executor.py:248` | 零调用（已实测 grep 全仓唯一引用即定义本身） | ✅ **已删除(2026-08-03)**：`tool_executor.py` 中该函数及其独占的 `import json as _json` 一并移除，零调用方，删除安全 |
| O8 | **前端 ChatInterface 子树** | 947 + 572 + 338 + 353 + 191 + 82 + 63 行 | `App.tsx:1-13` import 清单完全不含 ChatInterface；`:135-142` 中 `chat` 视图也渲染 DesktopDashboard | **约 3,131 行 / 前端 13,765 行 ≈ 23% 死代码**；已被自身测试文件 `chat-contract.test.tsx:7-10` 记录在案 |

> **原有假设已验证成立**：DesktopDashboard 是活聊天路径（HTTP-only，无 WebSocket 引用），ChatInterface 确为死代码。

## 1.5 「假成功」与静默降级 —— 最危险的隐患

| # | 问题 | 数量/位置 | 危害等级 |
|---|---|---|---|
| S1 | **`except: pass/continue` 静默吞异常** | **391 处**。`core/engine.py` **84 处**、`loop/controller.py` 25、`tools/system_tools.py` 19、`tools/perception_tools.py` 10 | 🔴 **极高**——任何子系统失效都不报错，只悄悄降级 |
| S2 | **`critical=False` 子系统静默失效机制** | `dependencies.py:142-144` + `engine.py:600/616` `_mark_subsystem_degraded` | 🔴 极高——初始化失败即置 None、全流程跳过 |
| S3 | **LSP 非 Python 语言返回 `success=True` 的假回执** | `lsp_tools.py:145-149, 173-177, 202-206` 返回"LSP 补全请求已记录…"字符串 | 🔴 极高——**LLM 会误判为成功并继续推理** |
| S4 | **审批流可被静默绕过** | `conversation_loop.py:509-510` `except Exception: pass` | 🔴 高——审批异常即放行 |
| S5 | **API 鉴权默认完全关闭** | `main.py:180` `require_api_key=bool(_api_keys)`（已实测确认） | 🔴 高——未设 `API_KEYS` 环境变量时裸奔 |
| S6 | **`file_edit` 多匹配不报错** | `file_tools.py:437-440` 用 `content.count()` 判重但不抛错，直接 `replace(...,1)` | 🟡 中——静默改错风险 |
| S7 | **TS `code_generate` 产出 TODO 模板** | `code_generate.ts:182,191,214,252,274,289` | 🟡 中——注册了但产出无价值 |
| S8 | **`ocr_extract` 纯 stub** | `file_parse_tools.py:343` `# TODO: 集成实际的OCR API` | 🟡 中 |
| S9 | **`voice_interact` 返回 mock** | `voice_interact.ts:174-182` `mockSessionId`/`simulated:true`；`:290` `Buffer.from('模拟音频输入数据')` | 🟡 中 |
| S10 | **`_validate_js_ts_syntax` 只数括号** | `file_tools.py:465-476` | 🟢 低 |

---

## 1.6 接线断裂（Orphan / Wiring-Break）缺陷深度分析

> **定义**：模块被定义、实例化或注册，却从未接入运行时控制流/数据流；或两条本应联通的路径因开关/分支/双实现而彼此隔绝。后果是"文档/代码看起来完成了，实际不生效"，且因无报错而极难发现。
> 本章是对 §1.4「孤儿代码清单」的**根因级深化**——不只列"有哪些孤儿"，而是回答"为什么孤儿会产生、影响谁、怎么修"。

### 1.6.1 受影响模块 · 表现 · 根因 · 风险（逐项）

| # | 受影响模块 | 具体表现（实测） | 根因分析 | 风险评估 |
|---|---|---|---|---|
| W1 | **ParallelToolExecutor（主执行器）** | `engine.py:639` 与 `engine_extensions.py:46` **各 `new` 一次** `ParallelToolExecutor`，但执行路径 `conversation_loop.py` 用的是**自身** `_parallel_executor`（`__init__` 内 `_build_parallel_executor()`）。`engine.tool_executor` 被写两次、读零次 → **双重孤儿**（grep `engine\.tool_executor` 仅命中赋值点，无读取点）。 | 历史重构留痕：并行执行器先在 engine 层接线（:639 无参构造），后在 extensions 层重复接线（:46 带 config 构造），最终真正生效的是第三次接线（conversation_loop 自有实例）。三次接线无统一单一真源。 | 🔴 **高**：① 双重实例化浪费；② 若未来有人改 `engine.tool_executor` 期望它生效，改动静默无效；③ 行为以"第三个实例"为准，维护者极易改错对象。 |
| W2 | **TS Harness 无条件启动（双脑并行）** | `bootstrap.ts:576` `initHarness()` 位于所有 `isPythonBackend()` 分支**之外**，即使默认 Python 后端就绪，仍完整构造 TS Harness（AgentHarness / LoopController / Planner / Executor / TrajectoryFlywheel / MCPToolBridge 等，约 42K 行"活着但旁路"）。 | AGENTS§0.1 要求 Agent 核心以 Python 为主实现、TS 仅作壳；但 TS Harness 未被废弃，且启动逻辑未随后端选择而短路。 | 🔴 **高**：① 启动慢、内存浪费；② 两套实现并存 → 行为漂移（同一 bug 在 TS/Py 各修各的）；③ `isPythonBackend()` 基于**运行时连接状态**（bootstrap.ts:36-38），Python 抖动会静默切到 TS 实现且无告警（见 2.2 阻塞项）。 |
| W3 | **`python/agent/cache/` 缓存抽象** | ⚠️ **勘误（修正 §1.4 O5）**：此前称其"跨模块引用 0、1,472 行死投入"——**实测不成立**。grep `from agent.cache` / `cache.get\|set\|CacheStore\|RedisCache\|MemoryCache` 命中 **20 个消费文件**（context/unified_orchestrator、tools/tool_result_cache、llm/provider、orchestration、api/proxy_server 等）。 | 该包**并非孤儿**，但存在**三层缓存并存**：`cache/`（统一抽象）、`memory/redis_cache.py`、`tools/tool_result_cache.py`，职责边界模糊，调用方各取所需。 | 🟡 **中**：非"死代码"，属"重复抽象"。风险是缓存策略不一致（有的走 tier、有的直连 redis、有的本地 dict），难统一失效/命中统计。 |
| W4 | **前端 ChatInterface 子树** | `App.tsx` import 清单不含 ChatInterface；`chat` 视图渲染 DesktopDashboard。约 3,131 行（947+572+338+353+191+82+63）/ 前端 13,765 行 ≈ **23% 死代码**，且被自身测试 `chat-contract.test.tsx` 记录在案。 | 历史"双重聊天实现"并存（ChatInterface vs DesktopDashboard），迁移未收口。 | 🟡 **中**：死代码本身不致命，但"双重实现"导致修 Bug 改错文件（历史双重回复事故即源于此，见 2.1 阻塞项）。 |
| W5 | **数据双根（`data/` vs `python/data/`）** | TS 侧落盘在 `data/`（如 `data/persistence/evolution-metrics.json`），Python 侧落盘在 `python/data/`（如 `python/data/cron/jobs.json`，被前者引用）。两套根目录，路径解析各自为政。 | 混合架构演进中，TS（旧主）与 Python（新真后端）各自沉淀数据目录，未统一数据根。 | 🟡 **中**：备份/恢复/迁移需同时处理两个根；相对路径在不同 cwd 下解析不同 → 潜在数据"找不到"（与 P0-5 同主题）。 |
| W6 | **`src/gateway/` V6.0 愿景** | 自述"V6.0 替代 src/harness/"，但 `new AgentGateway` 全仓 0 次出现 → 愿景 0% 落地。 | 规划先行、实现未跟。 | 🟢 **低**：纯未启动项，不影响现网。 |
| W7 | **`convert_openai_tool_calls`** | `core/tool_executor.py:248` 定义，零调用。 | 与 W1 同源：tool_executor 体系本身接线不全。 | 🟢 **低**：配合 W1 修复时一并接线或删除。 |

### 1.6.2 接线断裂的共性根因
1. **三重接线无单一真源**（W1）：同一能力在 engine / extensions / conversation_loop 三处各自实例化，最后一处"赢"，前两者沦为孤儿。
2. **启动开关与运行时开关不一致**（W2）：启动期无条件 init，运行期按连接状态切后端 → 两条路径长期并存、互不可见。
3. **迁移/收口未闭环**（W4/W6）：新实现就位但旧实现未删、import 未切，留下"影子代码"。
4. **数据根未统一**（W5）：跨语言边界的数据落地缺少约定。

### 1.6.3 风险总评
接线断裂的本质是**"看起来完成、实际不生效"**——比假实现更隐蔽，因为它不报错。最高危是 **W1**（执行路径与配置实例错位）与 **W2**（双脑并行导致行为漂移）。建议优先在 CI 增加"关键组件必须有生产调用点"断言（见 §审计边界声明 + §1.8.1）。

---

## 1.7 静默降级（Silent Degradation）缺陷深度分析

> **定义**：系统在异常/边界条件下，不抛出明确错误、不发出可观测告警，便自行降低功能等级（置 None / 返回空默认值 / `except: pass` / `log.warning`+continue），使问题被隐藏、运维无法感知、LLM 误判成功。
> 本章是对 §1.5「假成功与静默降级」的**机制级深化**——定位到贯穿引擎的"降级开关"与可观测性缺口。

### 1.7.1 机制总览：一套"降级开关"贯穿引擎
`engine.py` 提供 `_mark_subsystem_degraded(name, reason)`（:349），被 **15 处**调用（:445 / 549 / 557 / 566 / 574 / 592 / 600 / 608 / 616 / 628 / 636 / 654 / 670 / 678 / 717）。其语义：
- 把子系统加入 `_degraded_subsystems` 集合 + 记录原因；
- 仅 `log.warning("Subsystem degraded", ...)` —— **不阻断启动、不进错误级日志、不触发告警**；
- 再尝试通知 `subsystem_guard` 跟踪器，而该通知自身用 `except Exception: pass`（:363）**把通知失败也吞掉**。

**关键缺口：降级状态未接入"启动失败"判定。** `main.py:291` 的 health 状态仅看 `error_rate < 0.05`，不查 `_degraded_subsystems`。因此一个**刚启动、`loop` 已降级（:670 置 None）的引擎，health 仍返回 "healthy"**（错误率为 0）——运维无感知，请求进来后行为异常或崩溃。

### 1.7.2 受影响模块 · 表现 · 根因 · 风险（逐项）

| # | 受影响模块 / 位置 | 具体表现（实测） | 根因分析 | 风险评估 |
|---|---|---|---|---|
| D1 | **核心子系统降级（15 处 `_mark_subsystem_degraded`）** | 任一子系统初始化失败 → 置 None + 仅 warning。`loop`(:670)、`tool_registry`(:566)、`schema_validator`(:608)、`constraints`(:654) 等关键能力均在列。 | 设计意图是"优雅降级"，但**未区分可降级与不可降级**：`loop`（主推理循环）降级后引擎根本无法服务对话，却仍报告 healthy。 | 🔴 **极高**：关键能力静默失效，且 health 不反映；用户/运维看到"服务正常"却在对话中遇到 None 解引用或功能缺失。 |
| D2 | **`except: pass` / `except Exception: pass` 裸吞** | ⚠️ **勘误（修正 §1.5 S1）**：此前称 `engine.py` 有 **84 处**裸吞——**实测不成立**。`engine.py` 内仅 **1 处** `except Exception: pass`（初始化尾部 :295-296）；`conversation_loop.py` 内有 **3 处**（:307 守卫 reset、:621 **审批**、:640 终态 hook）。全仓"391 处"未在本次复测，建议以本审计 grep 为准重新计数。 | 局部容错被写成"吞异常"，缺少日志/指标。 | 🔴 **高**：异常被抹除，事后无法追溯；但 `engine.py` 内主要是 `log.warning` 形式（较 pass 好），真正 `pass` 极少。 |
| D3 | **LSP 非 Python 语言假成功** | `lsp_tools.py` 6 个非 Python 语言路径返回 `success=True` + "请求已记录"字符串（原 S3）。 | 用"已记录"伪装成功，未区分"已受理"与"已完成"。 | 🔴 **高**：LLM 误判工具成功 → 基于错误结果继续推理（Chain-of-Thought 污染）。**已在 P0-7 修复**（改为 success=False + unsupported 错误）。 |
| D4 | **审批流静默放行（fail-open）** | `conversation_loop.py:621-622` `except Exception: pass` 包住 `approval_manager.request_approval(...)` → 审批请求异常即**跳过审批、直接执行工具**。（注：权限检查本身 :498-503 已是 fail-closed 正确实现，但审批步骤仍 fail-open。） | 把"审批服务抖动"与"用户被拒"混为一谈，异常路径默认放行。 | 🔴 **高**：安全相关，异常即放行等于降级为无审批。 |
| D5 | **API 鉴权默认关闭** | `main.py:180` `require_api_key=bool(_api_keys)` → 未设 key 即裸奔（原 S5）。 | 用"无 key 即开发模式"假设，未区分环境。 | 🔴 **高**：生产无 key 仍可访问。**已在 P0-6 修复**（非 dev 且无 key 时 fail-fast）。 |
| D6 | **安全守卫失败仍继续执行** | `conversation_loop.py:565-566` Schema 校验异常 → `log.warning("...跳过校验继续执行")`；`:584-585` 工具调用守卫异常 → `log.warning("...跳过守卫继续执行")`。 | 守卫（schema/guard）异常被当作"非阻塞"处理，fail-open。 | 🔴 **高**：校验/守卫的意义在于拦截，异常时放行等于撤防。 |
| D7 | **`file_edit` 多匹配静默** | `file_tools.py:437-440` `content.count()` 判重但不抛错，直接 `replace(...,1)`。 | 边界条件被"猜"处理。 | 🟡 **中**：可能改错匹配处而不报错。 |
| D8 | **验证层 RETRY 不触发** | `engine.py:2104-2107` 仅 `record_step` 记录，`build_correction_prompt`(:228) 无调用方（原 O4）。 | ✅ **已完成(2026-08-02)**：`engine.py:2196-2211` 已调用 `build_correction_prompt` 并把修正提示挂到 `result.metadata["verification_correction"]`；`VerifyAction.RETRY` 回路接通。测试 `test_d8_*` 已在 52/52 套件中 | 🟡 **中**：自纠错链路断。 |
| D9 | **`isPythonBackend()` 运行时切换无告警** | Python 抖动时静默切 TS 实现（2.2 阻塞项）。 | 降级判断基于运行时连接，无告警/无回切日志。 | 🟡 **中**：行为漂移，且难复现。 |

### 1.7.3 静默降级的共性根因
1. **"优雅降级"被泛化为"吞错"**：`critical=False` 默认值 + 15 处 `_mark_subsystem_degraded` 让任何失败都能"温柔地消失"，缺少"哪些能降级、哪些必须 fail-fast"的显式清单。
2. **降级状态不可观测**：仅 `log.warning` + 内部集合，未进 health/metrics/告警；`main.py:291` health 不看 degraded。
3. **`except: pass` 的文化残留**：少量位置仍裸吞（D2/D4），且通知降级跟踪器自身也 `except: pass`（:363）。
4. **"已记录"≠"已完成"的语义混淆**（D3）：对外返回成功状，对内仅排队/忽略。

### 1.7.4 风险总评
静默降级是**"运维看不见的塌陷"**。最危险的是 **D1**（关键子系统降级但 health 仍 healthy）、**D4/D6**（安全相关 fail-open）。D3/D5 已修复，D1/D2/D4/D6 仍开放。

---

## 1.8 修复优先级与任务分配矩阵

> 按"隐蔽性 × 影响面 × 修复成本"排序，便于排期与分派。标识符对应 §1.6/§1.7。

| 优先级 | 项 | 缺陷类 | 修复动作（可验） | 估时 | 建议分派 |

> **修复进度（截至 2026-08-02）**：P0 四项 **W1 / D4 / D6 / D1 已全部完成**；本日继续推进 P1，\n> **W3（三层缓存）✅ 已完成**、**D2（裸吞异常加固）✅ 已完成**，并顺带发现并修复一处 **D6 级安全 fail-open**（`code_tools.py` 沙箱预检 100% 失效）。回归测试 `tests/test_defect_fixes_orphan_silent.py` **52/52 通过**；导入扫描红线 `check_import_scan.py` **310/310 PASS**；静默吞异常棘轮 `check_silent_except.py` 基线收紧至 **352**（≤历史基线 355，无新增）。详见下方 W3 / D2 / D6-b 行与 §1.8.1 治理更新。**跨编号说明**：本矩阵（§1.8）用 D/W 码追踪「接线断裂 / 静默降级」两类缺陷；§3.1 阻塞项中的 **P0-6（API 鉴权 fail-fast）、P0-7（LSP 假成功修正）也已修复**（详见文末「修复进展」节，并已在 §3.1 表中标记 ✅）；并行执行器（§3.2 P1-6 / 本矩阵 W1）同步完成。**本批次新增完成（2026-08-02 第二轮）**：**P0-1（双脑并行）✅**（含 W2 启动期 gating + 运行时 `isPythonBackend()` 静默切换根绝）、**P1-1（测试链路）✅**、**P1-2（Git 链路）✅**、**W2（TS Harness 双启）✅**——均已在 §3.1/§3.2 与 §1.8 矩阵中标记。
> **第三轮（2026-08-02）收口**：§3.1 的 **P0-2（CD 占位）✅ / P0-3（K8s 清单冲突）✅ / P0-4（Alembic 迁移）✅ / P0-5（数据双根）✅** 全部完成；本矩阵 **D8（RETRY 接线）✅**；§3.2 **P1-3（重构 depgraph）✅ / P1-4（file_grep ripgrep+AST）✅ / P1-5（记忆 LIMIT 预筛）✅**；§3.3 **P2-2 / P2-7 / P2-8 / P2-9 / P2-10 已完成**，P2-1 已达 CI 棘轮基线，P2-3 / P2-4 / P2-6 已评估并留待专项轮（见 §3.3 各行）。回归门禁：导入扫描 **311/311 PASS**、静默吞异常 **351（≤352，无新增）**、缺陷修复套件 **52 + 15 + 7(P1-3/4/5) + 4(P2-7) = 78 通过**。
> ⚠️ **（已核实作废）原"独立阻断项"说明**：此前记录称 `engine.py:15` 的 `from agent.evolution.feedback_loop import ContinuousFeedbackLoop` 因重构为 `FeedbackLoop` 而悬空。经 2026-08-02 复查：`feedback_loop.py:171` 仍导出 `ContinuousFeedbackLoop`（另于 `:535` 导出 `FeedbackLoop(evolution_engine=)`），`engine.py` 的 import 与两处 `ContinuousFeedbackLoop(...)` 调用均有效；导入扫描红线 `check_import_scan.py` 现已 **310/310 PASS**。该阻断项不成立，予以移除。
|---|---|---|---|---|---|
| **P0** | **D1** 关键子系统降级不可观测 ✅ **已完成(2026-08-02)** | 静默降级 | `engine.py`：`_mark_subsystem_degraded(..., critical=False)` 新增 `_critical_degraded` 集合，`critical=True` 时 `log.error` 并计入关键降级（已标记 `tool_registry`/`schema_validator`/`constraints`/`loop` 4 处 critical）；`get_degraded_report()` 暴露 `critical_degraded`/`critical_degraded_count`。`api/health.py`：新增模块级 `subsystems_health(engine)` 并由 `register_default_checks` 注册 `subsystems` 检查——critical 降级 → `unhealthy`、普通降级 → `degraded`，`/health` 现可观测。回归测试见 `tests/test_defect_fixes_orphan_silent.py` | 0.5d | 后端 |
| **P0** | **D4** 审批流静默放行 ✅ **已完成(2026-08-02)** | 静默降级 | `conversation_loop.py:_execute_tool` 审批 `except Exception: pass` → fail-closed：审批请求异常默认**拒绝**（返回 `ToolResult(success=False, error="approval_error")`）。权限检查本身已 fail-closed，仅审批缺口补齐。回归测试：`test_d4_approval_exception_denied` | 0.5d | 后端 |
| **P0** | **D6** 守卫异常 fail-open ✅ **已完成(2026-08-02)** | 静默降级 | `conversation_loop.py:_execute_tool` 两处 fail-open 改 fail-closed：Schema 校验异常 → 返回 `error="schema_validation_error"`；工具调用守卫异常 → 返回 `error="tool_guard_error"`。均禁止静默放行。回归测试：`test_d6_schema_validation_exception_denied` / `test_d6_guard_exception_denied` | 0.5d | 后端 |
| **P0** | **W1** 并行执行器三重接线 ✅ **已完成(2026-08-02)** | 接线断裂 | 删除 `engine.py` 与 `engine_extensions.py` 的 `tool_executor` 孤儿赋值与 import（此前 engine/extensions 各挂一份、执行路径读 `conversation_loop._parallel_executor` 自有实例 → "写两次读零次"）。并行执行器现由 `ConversationLoop` 单一持有。回归测试：`test_w1_*` | 0.5d | 后端 |
| **P1** | **W2** TS Harness 无条件启动 ✅ **已完成(2026-08-02)** | 接线断裂 | `bootstrap.ts:645-662`：`enableTsHarness = !pythonBackendLive \|\| harnessForced`（其中 `pythonBackendLive = pythonBridge !== null`，`harnessForced = AGENT_HARNESS_ENABLE==='1'\|\|'true'`），仅当 Python 后端未存活或显式强制时才 `initHarness()`；默认 Python 主实现下 TS Harness 不再构造。仅剩 P0-1 的**运行时 `isPythonBackend()` 静默切换**（多处分支按 `pythonBridge !== null` 实时轮询）待收口——属 P0-1 子项，非 W2 本身 | 0.5d | 前端/网关 |
| **P1** | **W3** 三层缓存并存 ✅ **已完成(2026-08-02)** | 接线断裂 | **(a) 缓存键错位（真实生产缺陷）**：`llm/provider.py` 读路径 `tiered_cache.get(messages, effective_model, system_prompt=...)`，但两处写路径硬编码 `system_prompt=None` 且一处用 `self.model` 而非 `effective_model` → 写键≠读键 → 响应缓存命中率结构性为 0（静默降级、无报错）。已将 `system_prompt`+`effective_model` 贯穿 `chat → queue.submit(_do_chat) → _do_chat → (_do_chat_via_transport｜_do_chat_via_litellm)`，并以真实 `system_prompt` 写入；验证命中率 0.0→1.0。**(b) 孤儿 `ToolResultCache` 接线移除**：`engine.py._init_tool_result_cache`（零调用点）删除，`dependencies.py` 对应 `SubsystemSpec` 与 `domain_containers.py` 槽位一并移除（接线前需先引入 cacheable 白名单，避免缓存副作用型工具）。**(c) 死代码包删除**：`python/agent/cache/`（8 文件）与 `test_unified_cache.py` 整包删除（其为 untracked，备份见 `.workbuddy/removed/2026-08-02_w3_unified_cache/`）。三层缓存收敛为 `llm/cache.TieredCache`（L1+L2 SQLite）与 `memory/redis_cache.py` 两条清晰路径。回归测试：`test_w3_*` 共 6 例（命中率、键依赖 system_prompt、下游签名、无硬编码 None 写、stats 双层级） | 1d | 后端 |
| **P1** | **D2** 裸吞异常实测与加固 ✅ **已完成(2026-08-02)** | 静默降级 | **实测**：全仓静默吞异常棘轮基线 **355 → 收紧至 352**（355→353 来自合法可选依赖守卫豁免；353→352 来自本轮收尾修复 `tracing.py`/`registry.py` 2 处真实裸吞）。**加固**：`tools/refactor_tools.py` 文件写入失败由 `except: pass` → `log.error` + 从 `changed` 移除 + 计入 `write_failures`，工具返回 `success=not write_failures`；`tools/test_gen_tools.py` 两处 `except (Exception/ValueError): pass` → `log.warning`（读既有测试风格、解析 pytest-cov 未覆盖行号）。**棘轮豁免**：`scripts/check_silent_except.py` 新增 `_is_optional_dependency_guard`——合法的可选依赖守卫 `try: import X; _x_available=True; except ImportError: pass` 不再误报为静默吞异常（收紧 `vector_store.py` 等基线）。回归测试：`test_defect_fixes_orphan_silent.py` D2 相关用例 | 1d | 后端 |
| **P1** | **D6-b** 工具沙箱预检失效（fail-open）✅ **已完成(2026-08-02)** | 静默降级/安全 | **重大发现**：`tools/code_tools.py` `shell_exec` 沙箱预检 `from agent.sandbox.types import SecurityLevel`——该模块**不存在**（SecurityLevel 实际在 `agent.sandbox.executor`），每次调用抛 `ModuleNotFoundError`，被 `except Exception: pass` 吞掉后**直接落到 `subprocess.run`** → 沙箱预检**从未生效过**（100% 失效）。修复：导入改为 `from agent.sandbox.executor import SandboxExecutor, SandboxConfig, SecurityLevel`，并改为 **fail-closed**——预检不可用时返回 `ToolResult(success=False, error=..., metadata={"security_violation": True, "guard_unavailable": True})` + `log.error`；把 `if not pre_check.allowed` 移出 try 使真实拒绝仍生效。验证：`rm -rf /` 被拦截，fail-closed 路径输出 ERROR 且 `success=False`。回归测试：`test_d6b_code_tools_sandbox_fail_closed_when_guard_unavailable`（已补入 `test_defect_fixes_orphan_silent.py`，本次随套件 52/52 通过） | 0.5d | 后端 |
| **P1** | **D8** 验证 RETRY 接线 | 静默降级 | `engine.py:2104` 的 RETRY 分支接 `build_correction_prompt` 并重执行；补测试 | 0.5d | 后端 |
| **P2** | **W4** 前端双聊天实现 | 接线断裂 | 删除 ChatInterface 子树（或反之保留其一），统一 `chat` 视图入口；补契约测试防回归 | 1d | 前端 |
| **P2** | **W5** 数据双根 | 接线断裂 | 引入 `DATA_ROOT` 统一常量，TS/Py 均从此解析；迁移 `data/` 与 `python/data/` 到单一根（注意 P0-5 同主题） | 1d | 后端+前端 |
| **P2** | **W6/W7** 愿景/死定义 | 接线断裂 | `src/gateway/` 或补实现或标记 TODO 删除；`convert_openai_tool_calls` 接线或删除 | 0.5d | — |
| **P2** | **D7/D9** 局部静默 | 静默降级 | `file_edit` 多匹配抛 `AmbiguousMatchError`；`isPythonBackend` 切换写告警日志+metrics | 0.5d | 后端 |

### 1.8.1 配套治理（防复发）
- **CI 红线 · 孤儿接线**：新增 `check-orphan-wiring.mjs`——对 `ParallelToolExecutor` / `AgentGateway` / `ChatInterface` 等"易孤儿"符号断言"存在 ≥1 生产调用点"，否则 exit 1（呼应 §审计边界声明建议）。
- **CI 红线 · 静默吞异常**：新增 `check-no-silent-pass.mjs` 扫描 `except: pass` / `except Exception: pass`（允许名单除外）；并将 `_mark_subsystem_degraded` 强制写入 metrics（`subsystem_degraded_total{name}`）。
- **fail-fast 清单**：在 `dependencies.py` 增加 `critical=True/False` 显式标注，启动期对 `critical=True` 失败直接中止而非降级；非 critical 失败才走 `_mark_subsystem_degraded` 并**进 health**。
- **可观测性闭环**：`main.py:291` health 接入 `_degraded_subsystems`，critical 降级即 `status=degraded`；新增 `/v1/health/detail` 暴露 degraded 明细供巡检。

---

# 第二部分：各架构层完成度审计

## 2.0 完成度总览

| 层 | 完成度 | 代码规模 | 核心判据 |
|---|---|---|---|
| L1 前端 / 交互层 | **60%** | 前端 13,765 行 + desktop 9,970 + cli 5,662 | 主流程可用，但 23% 死代码、流式/语音/快捷键全悬空 |
| L2 TS 网关 / 服务层 | **55%** | server 12,325 + harness 46,140 | 路由健全（168 端点），但 AGENTS§0.1 合规仅 3/8，5.6 万行影子实现 |
| L3 Agent 逻辑层（Python） | **80%** | 124,639 行 / 358 文件 | 最扎实层：130+ 端点、主链路完整、126 个 pytest 文件、仅 4 处 skip |
| L4 数据 / 持久化层 | **50%** | — | 能存能取，但**无迁移框架 + 双数据根** |
| L5 基础设施层 | **65%** | K8s 16 yaml + CI 7 job | CI 与可观测性真实可用，**CD 为零** |
| **整体** | **≈62%** | TS 164,125 + Py 124,639 | |

## 2.1 L1 前端 / 交互层 —— 60%

**已完成**：DesktopDashboard 主界面（1,275 行含 FeatureNodeGrid）、SettingsPanel、SessionList 增删改排序（`App.tsx:166-181`）、Zustand 6 store、i18n(353 行)、Toast/Theme/Chat Context、Electron 壳全套（`electron/main.js`+TrayManager+Updater+GlobalShortcuts+BackendLauncher）、CLI 全套（31 文件 5,662 行，REPL 591 行 + 20 子命令 + 三模式）、桌面自动化引擎（`src/desktop/` 21 文件 9,970 行，非 Electron 壳）

**进行中**：导航仅剩 1 项（`App.tsx:34-39` NAV_GROUPS 只有 settings）；WS 流式管道已建（`hooks/websocket/` 1,527 行）但活路径不用

**未启动**：聊天流式渲染接入、语音交互挂载(353 行悬空)、快捷键挂载、错误边界（`ErrorBoundary.tsx` 116 行未挂载）

**阻塞项**：ChatInterface 与 DesktopDashboard 两套聊天实现并存 → 修 Bug 易改错文件（历史"双重回复"事故即源于此）；重复组件 `QuickToolPalette`×2、`SessionList`×2

## 2.2 L2 TS 网关 / 服务层 —— 55%

**AGENTS.md §0.1 收口合规实测 = 3/8**：

| 模块 | 规模 | 收口状态 | 证据 |
|---|---|---|---|
| MCP | 2 文件 / 29 行 | ✅ 真收口 | 业务全在 `python/agent/api/mcp.py`(677 行/18 端点) |
| 会话/轨迹 | — | ✅ 真收口 | `SessionStore.ts:11`、`TrajectoryDatabase.ts:11` 标注"仅为本地回退" |
| A2A | — | ✅ 真收口 | `AgentRegistry.ts:964` @deprecated 架构违规声明 |
| 记忆 | 30 文件 / 9,255 行 | 🟡 门面收口，本体未删 | `MemoryEngine.ts` 30 行真壳，但 `MemoryRetriever`(937)+`UserProfile`(995)+`SemanticSimilarityEngine`(606)+`ChromaVectorDatabase` 共 9,225 行独立实现仍在 |
| **LLM** | `llm/`(已删) + `models/` 6,690 行 | 🟢 **已收口(2026-08-03)** | 纠偏：`src/llm/` 实为 prompt 模板/token 预算/能力探测/流式处理**辅助工具**（非 Provider/Cache/Router），且零外部引用，**已于 2026-08-03 删除**；真正的 TS LLM 客户端 `src/models/OpenAICompatibleModel.ts`(622)+`transports/`(575) 属 `AGENT_BACKEND=local` 废弃回退。2026-08-03 完成桥壳化：`LLMProviderBridge` 在 python 默认模式使用新建 `PythonBackedModel` 占位壳，**不再实例化** `OpenAICompatibleModel`+`transports/`；后者加 `@deprecated`（仅 local 回退），推理经 `PythonAgentBridge` 走 Python。**2026-08-03 C 项收口**：`MultiModelProvider.createModel` / `MultiModelLLMProviderBridge.registerModel` / `ModelManager.registerDefaultModels` / `ModelInterface.ModelFactory.createModel` 共 4 处 `new OpenAICompatibleModel` 站点统一加 `getActivePythonBridge()` 门控，python 模式改用 `PythonBackedModel`，**彻底消除 TS 实例化本地 LLM 客户端的可能**；local 模式回退不变。单测 `tests/unit/models/pythonModeBridgeShell.test.ts` 6/6 绿 |
| **进化** | 26 文件 / 8,240 行 | 🟢 **已收口(2026-08-03)** | `EvolutionOrchestrator`+V2 已加 `@deprecated`（local 回退）；`initEvolution.ts` 在 `AGENT_BACKEND=python`（默认）下**不再启动 TS 自进化引擎（会写文件）**。2026-08-03 完成 11 处调用点收敛（JiabaixingCore/WsProcessor/FeedbackLoops/OrchestratorAgent/systemStateRoutes/evolutionRoutes×6/initHarness）全部加 `isPythonBackend`/`getBridge` 门控，python 模式经 `PythonAgentBridge` 委派，不再触达 TS 编排器；bootstrap 的 evolution.status 早已门控 |
| Redis / OTel | — | 🟡 部分 | — |

**`src/harness/` 现状（46,140 行）**：**未被废弃，仍在无条件启动**。`bootstrap.ts:576` 的 `initHarness()` **不在任何 `isPythonBackend()` 分支内** —— 即使 Python 后端就绪，1,340 行 initHarness 仍构造完整 TS Harness。其中严格无引用死代码 15 文件 / 4,006 行(8.7%)，其余约 42,000 行"活着但旁路"。

**已完成**：25 路由文件 / 168 端点、WS 网关（WsAuth+WsRateLimit+WsDedup+WsRetry）、PythonAgentBridge 双向桥接、OpenAI 兼容层(512 行)

**阻塞项**：`isPythonBackend()` 基于**运行时连接状态**（`bootstrap.ts:36-38`）→ **Python 抖动会静默切到 TS 实现，产生行为漂移且无告警**

## 2.3 L3 Agent 逻辑层（Python）—— 80%

| 模块 | 文件/行数 | 被引用度 | 判定 |
|---|---|---|---|
| `core` | 37 / 16,501 | 161 | 生产核心 |
| `tools` | 48 / 19,496 | 6 | 生产可用（98 工具） |
| `evolution` | 22 / 11,628 | 7 | 生产可用 |
| `loop` | 24 / 11,376 | 5 | 生产可用（ReAct/ToT） |
| `llm` | 24 / 8,170 | 12 | 生产可用 |
| `context` | 21 / 6,692 | **2** | 🟡 接线偏薄，投入产出失衡 |
| `persistence` / `security` / `memory` / `a2a` | 5,949 / 3,442 / 5,629 / 3,063 | 10/10/5/5 | 生产可用 |
| **`cache`** | 8 / 1,472 | **0** | ❌ 孤儿 |
| `persona` / `utils` | 0 / 8 行 | 0 | 空占位 |
| `lsp` / `acp` / `skill` / `evaluation` / `gateway` | 各 1 引用 | — | 🟡 实验性 |

**API 端点约 130+**（`main.py:198-216` 注册 18 router）：`/v1/chat`、`/v1/chat/completions`、`/v1/llm/*`(608 行)、`/v1/{plan,execute,evaluate,reflect}`、`/v1/memory/*`(23 端点)、`/v1/evolution/*`(13)、`/v1/cron/*`(10)、`/v1/sessions/*`(17，含 checkpoint/resume/bookmarks/fulltext)、`/v1/mcp/*`(18)、`/v1/trajectory/*`(7)、`/v1/health/slo`、`/v1/metrics`

**这是五层中最扎实的一层**——主链路完整、端点密集、测试真实（126 个 pytest 文件，仅 4 处 skip）。

## 2.4 L4 数据 / 持久化层 —— 50%

**🔴 风险 1：无 schema 迁移机制**。全仓无 `migrations/`、无 `alembic.ini`。建表方式为分散的 `CREATE TABLE IF NOT EXISTS`（散布于 `persistence/{database,trajectory,session_store,session_search_index,session_lineage}.py`）。**无版本号、无回滚、无升级路径 → 任何 schema 变更都会导致存量库不可用。**

**🔴 风险 2：数据双根分裂**

| 数据根 | 内容 |
|---|---|
| `data/`（TS 侧，10 个 .db） | `jiabaixing_memory.db`(487KB)、`gateway_sessions.db`、`llm_cache.db`、`sessions.db`、`vectors.db`、`event_bus.db`、`sovereignty_audit.db`、`debug-test.db`(测试残留)、`knowledge/graph.db`、`trajectory/trajectory.db` |
| `python/data/`（Python 侧，12 个 .db） | `memory.db`、`llm_cache.db`、`trajectory.db`、`episodic_memory.db`、`session_search.db`、`session_lineage.db`、`prompt_cache.db`、`reflection_kb.db`、`learning_graph.db` 等 |

`llm_cache.db` / `trajectory.db` / 记忆库**两侧各存一份，互不同步** → "记忆写入后查不到"类幽灵 Bug。

**🔴 风险 3：向量库配了但没用**。`config.py:34` 定义 `CHROMA_PATH`，但 **`chromadb` 在 `python/agent/` 全部源码中 0 次 import**（已实测验证，faiss/qdrant/milvus/pinecone/weaviate 同样零命中）。真实向量检索是 `memory/store.py:332-367` 的 LLM embed + 内存 cosine + 500 条 LRU 缓存。

**已缓解**：jobs.json 多副本竞态 —— `scheduler/cron.py:246-249` 已加 LeaderElection + threading.Lock（但 `:491` 仍是非原子 `write_text`，崩溃可致文件截断）。

## 2.5 L5 基础设施层 —— 65%

**🔴 CD 完全是空壳**（已实测确认 `.github/workflows/backend-ci-cd.yml`）：
- `deploy-staging`(:154-158) 与 `deploy-production`(:187-190) 全部是 `echo "Deploying..."` + `# 在这里添加部署脚本`
- `download-artifact` 的 `path: |` 为**空值**（:151-152、:183-184）→ **YAML 实际损坏**
- 结论：**"生产部署"能力实际为 0**

**CI 真实性**：

| Job | 真实性 |
|---|---|
| `lint-and-typecheck` | ✅ 真（ESLint+Prettier+tsc + 3 个自定义门禁） |
| `test` | ✅ 真（单测+集成+覆盖率+Codecov） |
| `python-test` | ✅ 真（全量 pytest + import-scan 红线） |
| `build` | ✅ 真 |
| `deploy-staging` / `deploy-production` | ❌ **形式化 echo** |
| `security-scan` | 🟡 半真（npm audit 真跑；Snyk 依赖未配置的 SNYK_TOKEN） |

**🔴 K8s 两代清单并存且冲突**：新代（namespace/configmap/secret/redis-StatefulSet/otel-collector/python-deployment/gateway-deployment/ingress/hpa/pdb，质量良好）与旧代（`deployment.yaml` 170 行单体 + `namespace-and-redis.yaml` 重复定义 Namespace+Redis Deployment）并存。README:14 建议 `kubectl apply -f deploy/kubernetes/` → **会同时应用两代清单，Namespace 重复 + Redis 双实例，部署必然失败**。

**其他**：`secret.yaml:16-20` 三个密钥均为 `'placeholder'`；`Dockerfile:56` `CMD ["npx","tsx","src/main.ts"]` —— **生产直接跑 TS 源码，无编译产物**。

**可观测性（真实可用）**：OTel(`otel_setup.py` 280 行 + K8s collector 133 行)、`/v1/metrics` + `/v1/metrics/dashboard`、四层健康检查(`api/health.py:283-298`)、SLO 端点(`api/slo.py:20`)。

---

# 第三部分：问题清单与改进建议

## 3.1 P0 阻塞项（必须优先解决，共 7 项）

| ID | 阻塞项 | 所属 | 影响 | 建议动作 | 工作量 |
|---|---|---|---|---|---|
| **P0-1** | **双脑并行**：TS Harness 与 Python Agent 同时初始化、功能重叠、数据分两根 | L2+L3+L4 | 最高优先级架构债；行为漂移无告警 | ✅ **已完成(2026-08-02)**：(a) 启动期 gating 随 **W2** 落地——`initHarness()` 仅在 `!pythonBackendLive \|\| AGENT_HARNESS_ENABLE` 时调用；(b) 运行时静默切换已根绝——`isPythonBackend()`(`bootstrap.ts`) 改为返回**启动期一次性锁定的 `_backendDecision`**（`python`/`ts`），不再每秒轮询 `pythonBridge !== null`；若会话中途连接状态与锁定决策冲突，仅 `Logger.warn` 告警一次、行为不变。所有 IPC / 路由层（JiabaixingCore / websocket / coreRoutes / chatRoutes / acpRoutes）的 `isPythonBackend()` 调用均收敛到同一锁定决策，双脑行为漂移消除 | 3d（实际 ~1d） |
| **P0-2** | **CD 全部是 echo 占位 + YAML 损坏** | L5 | 生产部署能力 = 0 | ✅ **已完成(2026-08-02)**：`backend-ci-cd.yml` 移除两处空 `path: \|` 下载步骤；staging/prod 部署步骤由 `echo` 占位替换为真实 `kubectl apply -k deploy/kubernetes/` + `kubectl -n jiabaixing rollout status deployment/... --timeout=180s/300s`；staging 在 `KUBE_CONFIG_STAGING` 缺失时仅告警跳过，prod 在 `KUBE_CONFIG_PROD` 缺失时 `exit 1`（fail-fast）。YAML 通过 `python -c yaml.safe_load` 校验 | 2d（实际 0.5d） |
| **P0-3** | **K8s 两代清单冲突** | L5 | `kubectl apply -f 目录` 必然失败 | ✅ **已完成(2026-08-02)**：gen-1 清单（`deployment.yaml`/`service.yaml`/`namespace-and-redis.yaml`）已由先前工作删除；新增 `deploy/kubernetes/kustomization.yaml` 仅收口 gen-2 资源（namespace/configmap/secret/python-/gateway-/redis-/otel-collector/hpa/pdb/ingress，共 17 个唯一资源）；自研校验脚本确认无重复资源、kustomization 引用全部解析 | 0.5d（实际 0.25d） |
| **P0-4** | **无 schema 迁移框架** | L4 | 任何 schema 变更导致存量库不可用 | ✅ **已完成(2026-08-02)**：引入 Alembic（`python/migrations/`，`alembic.ini`+`env.py`+`script.py.mako`+`versions/0001_baseline_memory.py`）；启动期 `RUN_MIGRATIONS=1` 时 `agent/main.py` 调用 `run_migrations()` 把记忆库升级到 head；`python/scripts/migrate.py` 提供 `upgrade/downgrade/current/stamp` 命令行。基线 revision 已 `alembic upgrade head` 实测通过（产出 `memories`/`memories_fts`/`alembic_version`）。`alembic` 已加入 `pyproject.toml` 依赖。其余持久化库（trajectory/session_lineage/session_search）仍自愈 `CREATE TABLE IF NOT EXISTS`，后续可加 revision 接管 | 3d（实际 ~1d） |
| **P0-5** | **数据双根分裂** | L4 | "记忆写入后查不到"幽灵 Bug | ✅ **已完成(2026-08-02)**：`python/agent/config.py` 新增权威 `DATA_ROOT = DATA_DIR`(= `python/data`)；7 处 cwd 相对的 `Path("data/...")` 落盘默认值（cli/plugin_manager、cli/profile_manager、desktop/desktop_controller、evolution/skill_hub、gateway/forensics、mcp/server_manager、memory/providers）改为从 `DATA_ROOT` 解析，消除"不同 cwd 写出/读出不同根"的幽灵数据。TS 侧保留现状（legacy，Python 为权威后端） | 2d（实际 0.5d） |
| **P0-6** | **API 鉴权默认关闭**（`main.py:180`） | L5 | 生产裸奔 | 改为 `require_api_key = ENV != "development"`；无 key 时启动即 fail-fast ✅ 已完成(2026-08-02) | 0.5d |
| **P0-7** | **LSP 假成功 stub 返回 `success=True`** | Agent | **LLM 被误导继续推理** | `lsp_tools.py:145-206` 非 Python 语言路径改 `success=False` + 明确 unsupported ✅ 已完成(2026-08-02) | 0.5d |

## 3.2 P1 能力补强（对标差距最大的三条链路）

| ID | 缺口 | 差距分 | 建议动作 | 工作量 |
|---|---|---|---|---|
| **P1-1** | **测试链路完全缺失** | -9 | ✅ **已完成(2026-08-02)**：新增 3 个工具并接入 `register_default_tools`（`python/agent/tools/test_tools.py`）：`test_run`（按扩展名自动选 pytest/jest/npm，解析结构化失败 `failed_tests` 列表）、`test_generate`（AST 风格脚手架，pytest/unittest/JS/TS，拒绝覆盖既有文件）、`coverage_read`（解析 lcov / cobertura XML / sqlite `.coverage`，返回 `total_pct` + 逐文件 `line_pct`）。这是从"能写代码"到"能交付代码"的分水岭，现已打通 | 5d（实际 0.5d） |
| **P1-2** | **Git 链路完全缺失** | -9 | ✅ **已完成(2026-08-02)**：新增 4 个结构化工具（`python/agent/tools/git_tools.py`）：`git_status`（解析 `porcelain -b` → branch/staged/modified/untracked）、`git_diff`、`git_commit`（`git add -A` 或指定 files 后 `git commit -m <message>`，message 走参数非 shell 拼接；`git rev-parse HEAD` 回写 `metadata.commit`）、`git_log`。并把 `git diff`（改动文件清单）接入已有的强项 `code_review`（新增可选 `git_repo` 参数，自动审查 `git diff --name-only` + `--staged --name-only` 的改动文件）。不再依赖 shell_exec 拼命令 | 3d（实际 0.5d） |
| **P1-3** | **重构链路完全缺失** | -8 | ✅ **已完成(2026-08-02)**：`rename_symbol` 此前已作为 `refactor_rename`（AST，local+project）落地；本轮新增 `refactor_depgraph`（Python 用 `ast` 解析 import/from 含相对导入归包，TS 用正则提取 import/require；输出 mermaid/json/text）。已接入 `register_default_tools`；回归测试 `test_p1_p3_p4_p5_tools.py` 覆盖。修复了 depgraph 渲染时外部依赖节点 KeyError 的真实 bug | 5d（实际 0.5d） |
| **P1-4** | **代码搜索无 ripgrep / 无 AST** | -6 | ✅ **已完成(2026-08-02)**：`file_grep` 改为优先调用 ripgrep 二进制（`shutil.which("rg")`，支持 `-B/-A/-C`、`-U --multiline-dotall`），失败回退纯 Python；新增 AST 模式（`mode: "ast"`，仅 Python，按 def/class/assign/arg 符号扫描）。回归测试覆盖 text/context/ast 三种路径 | 3d（实际 0.5d） |
| **P1-5** | **记忆 O(N) 全表扫描** | -5 | ✅ **已完成(2026-08-02)**：`memory/store.py` 的 `search_semantic` 与 `_search_by_embedding` 均补 `LIMIT min(limit*5,1000)` 封顶 + `scene`/`timestamp` 预筛，消除对 `memories` 全表的 Python 端 O(N) 打分扫描；回归测试断言 SQL 含 `LIMIT`/`scene = ?`/`timestamp >= ?` | 4d（实际 0.5d） |
| **P1-6** | **并行工具执行器孤儿化** | -4 | **性能收益最大的单点修复**：在 `conversation_loop.py:266` 用 `ParallelToolExecutor.execute()` 替换串行 for 循环（代码已写好，只差接线） | **1d** |

## 3.3 P2 治理项

| ID | 问题 | 建议动作 | 工作量 |
|---|---|---|---|
| P2-1 | **391 处静默 except** | 分批治理：`core/engine.py`(84 处) 优先，最低要求是 `log.warning` 而非 `pass`；CI 增加 `check-silent-except.mjs` 红线（新增即拦） | ✅ **已达基线(2026-08-02)**：`check_silent_except.py` 棘轮已落地（基线 352，当前 351，无新增）；`engine.py` 优先治理已完成。剩余 391 处为分批长尾，属持续治理项 |
| P2-2 | 前端 23% 死代码（3,131 行） | ✅ **已完成(2026-08-02)**：删除 `src/frontend/src/components/ChatInterface/` 子树（15 文件，约 3,131 行）。经核查 `App.test.tsx`/`ChatContext.tsx` 仅以注释引用、`chat-contract.test.tsx` 仅引用活路径 `DesktopDashboard`，无活代码导入，删除安全。此举同时消除 `ChatInterface` 对 `@mui/material` 的缺失模块依赖，使后端 `tsc` 编译不再有 TS2307 错误（`npm run build` 可产出 `dist/main.js`） | 2d（实际 0.5d） |
| P2-3 | `src/llm` + `src/evolution` 未收口（§0.1 违规） | 按 AGENTS.md §0.4 应"拒绝合并"；补 bridge 壳 + @deprecated，或修订 AGENTS.md 承认现状 | ✅ **已完成(2026-08-03)**：(1) `src/llm/` 经核查为 orphan 辅助工具（非 §0.1 禁项），已删除；(2) `src/evolution` 收口——`@deprecated` + `initEvolution.ts` 在 python 默认模式不再启动会写文件的 TS 自进化引擎，改走 Python bridge；(3) 残留两项已于 2026-08-03 完成：(a) 本地 LLM Provider 桥壳化（`LLMProviderBridge` python 模式用 `PythonBackedModel` 占位壳，`OpenAICompatibleModel`+`transports/` 加 `@deprecated`）；(b) 11 处调用点收敛到 `PythonAgentBridge`（python 模式门控后完全不触达 TS 进化编排器）。**C 项（2026-08-03 追加）**：`MultiModelProvider`/`MultiModelLLMProviderBridge`/`ModelManager`/`ModelFactory` 4 处 `new OpenAICompatibleModel` 站点统一门控为 `PythonBackedModel`，python 模式彻底无 TS 本地 LLM 客户端实例化。设计见 `docs/P2-3_RESIDUAL_CLOSURE_DESIGN.md` |
| P2-4 | 孤儿组件 O1~O8 | 二选一：接线 或 删除。**不允许长期悬空**——这是"文档说完成、实际不生效"的根源 | ✅ **已完成(2026-08-03)**：全量盘点 O1~O8 → O1 已接线(P1-6/W1)、O2 删除(`evolution/multi_agent.py` 死双胎)、O3 误判保留(活工具)、O4 已接线(D8)、O5/O6/O8 已删、**O7 `convert_openai_tool_calls` 于 2026-08-03 删除(零调用方+独占 import 一并移除)**。详见 `docs/E2E_VERIFICATION_2026-08-02.md` §6.2 |
| P2-5 | `VerifyAction.RETRY` 不触发重试 | `engine.py:2104-2107` 接上 `build_correction_prompt` → 重执行回路 | ✅ **已完成（即 D8，已落地）**：`engine.py:2196-2211` 已调用 `build_correction_prompt` 并挂到 `result.metadata["verification_correction"]`；测试 `test_d8_real_verification_loop_produces_retry_and_correction` + `test_d8_dispatch_tool_calls_applies_verification` 已在 52/52 套件中 |
| P2-6 | 子 Agent 无工具（`delegate_tool.py` 裸 LLM） | 给子 Agent 下放工具集 + 独立 ReAct 循环 + 沙箱边界 | ✅ **已完成(2026-08-03)**：`delegate_tool.py` 已实现白名单 + 独立 ReAct 循环 + 沙箱子注册表隔离 + 深度守卫；本轮补强为**双轨白名单**（注册表元数据派生 `risk==low` − 显式拒绝集 `SUBAGENT_DENY_TOOLS`，拒绝集覆盖被误标 low 的有状态/外部副作用工具）、边界 enforcement（单工具超时 30s、输出截断 8000 字符、第五道步数墙 `max_steps`=12）、`unsafe` 算子级能力门控（`delegate_task` 永不可回流）；回归测试 `tests/test_p2_6_subagent_sandbox.py` 19 例全过。设计见 `docs/P2-6_SUBAGENT_SANDBOX_DESIGN.md` |
| P2-7 | 无 read-before-edit 安全约束 | `file_edit`/`incremental_edit` 增加"本会话读过才能改"校验；多匹配时抛错而非静默替换 | ✅ **已完成(2026-08-02)**：`file_tools.py` 新增模块级 `_READ_FILES` 记录 + `_read_before_edit_check`；`file_edit`/`incremental_edit`/`multi_file_edit` 在写入前校验"已先 file_read"，并提供 `bypass_read_check` 安全阀；`file_edit` 非 replace_all 多匹配、`incremental_edit` 的 search 多匹配均改为报错而非静默替换首处。回归测试 `test_p2_7_read_before_edit.py` 4 例全过 |
| P2-8 | `python/agent/cache/` 1,472 行孤儿 | 删除或与 `memory/redis_cache.py` 合并 | ✅ **已完成(2026-08-02)**：目录已不存在（先前工作已清理），确认无残留 |
| P2-9 | TS `code_generate` 返回 TODO 模板 | 删除该 TS 工具，统一走 Python 侧 | ✅ **已完成(2026-08-02)**：`src/harness/tools/code/code_generate.ts` 不再伪造 `success=True` 的 TODO 模板；`generateCode` 未注入时改返回 `success=False` + 明确错误（代码生成已由 Python 真后端承接），消除"假成功"静默降级 |
| P2-10 | Dockerfile 生产跑 TS 源码 | 改为多阶段 `npm run build` + `node dist/main.js` | ✅ **已完成(2026-08-02)**：`Dockerfile` 改为 frontend-builder + backend-builder + runtime 三阶段；runtime 运行编译产物 `node dist/main.js`（不再 `npx tsx` 跑源码，避免离线镜像缺 tsx 失败）。`npm run build` 实测产出 `dist/main.js`（预置类型错误以 `||` 容错，emit 不受影响） | 1d（实际 0.5d） |

## 3.4 建议的三阶段路线图

**第一阶段（2 周）· 止血**
> P0-1 ~ P0-7 全部关闭 + P1-6（并行执行器接线，1 天换最大性能收益）
> 目标：架构不再自相矛盾，部署链路真实可用，安全默认值正确
> 验收：`kubectl apply -k deploy/kubernetes/` 一次成功；未设 API_KEYS 时启动 fail-fast

**第二阶段（3 周）· 补齐编程能力**
> P1-1 测试链路 → P1-2 Git 链路 → P1-4 搜索升级 → P1-3 重构链路
> 目标：编程能力综合分从 51 → 75
> 验收：Agent 能独立完成"改代码 → 跑测试 → 看失败 → 修复 → commit"闭环

**第三阶段（3 周）· 治理与提效**
> P2-1 静默 except 治理（含 CI 红线）→ P2-2 前端死代码清理 → P2-4 孤儿组件二选一 → P1-5 记忆索引
> 目标：整体完成度 62% → 80%；消除"文档说完成、实际不生效"的结构性成因

---

## 附录 A：本次审计的实跑验证记录

| 验证项 | 命令/方法 | 结果 |
|---|---|---|
| 文档派生审计探针 | `node scripts/doc-derived-audit.mjs` | ✅ **37 PASS / 0 FAIL** |
| ParallelToolExecutor 调用点 | `grep -rn "tool_executor\." agent/` | ✅ **零调用点**（孤儿确认） |
| 向量库依赖 | Grep `chromadb\|faiss\|qdrant\|milvus\|pinecone\|weaviate` on `python/agent/` | ✅ **零命中** |
| `src/llm` 收口 | Grep `@deprecated\|PythonAgentBridge` on `src/llm/` | ✅ **目录已删除(2026-08-03)**：原 `src/llm/` 为 orphan 辅助工具（零外部引用），已删除；活文件 `prompt-templates.ts` 迁至 `src/models/` 并更新 5 处引用 |
| API 鉴权默认值 | 读 `python/agent/main.py:160-200` | ✅ `require_api_key=bool(_api_keys)` 确认 |
| CD 真实性 | 读 `.github/workflows/backend-ci-cd.yml:137-208` | ✅ echo 占位 + `path: |` 空值确认 |
| 静默 except 分布 | Grep `except[^:]*:\s*(pass\|continue)$` multiline | ✅ 391 处，engine.py 84 处 |

## 附录 B：审计中额外发现的两项「开发反馈循环」缺陷

这两项不在原定审计范围内，但实测中暴露，且影响所有开发者的日常效率：

### B-1 🔴 本地 TypeScript 类型检查完全无法运行

```
$ node node_modules/typescript/bin/tsc --noEmit
error TS2688: Cannot find type definition file for 'jest'.
error TS2688: Cannot find type definition file for 'node'.
```

根因：`node_modules/@types/jest/` 为**空目录**，`node_modules/@types/node/` 缺根级 `index.d.ts` 与 `package.json`（只剩子目录）。而 `tsconfig.json:6` 声明 `"types": ["node", "jest"]` 为必需。

连带问题：`node_modules/.bin/` 中**缺少 `tsc` 软链**（`./node_modules/.bin/tsc` 返回 exit 127），`npx tsc` 会误触发全局包下载提示。

**后果**：AGENTS.md 代码审计师清单要求"TypeScript 编译 0 errors"，但本地开发者**根本无法执行这项检查**，只能等 CI。这解释了为什么 TS 侧质量债长期累积。

**建议**：`npm ci` 重装（P0，0.5h）；并在 `scripts/pre-commit.js` 中加入 `tsc --noEmit` 可用性自检。

### B-2 🟡 Python 测试套件单次运行 > 40 分钟

`cd python && python -m pytest tests/ -q --timeout=120` 在审计窗口内运行 **超过 40 分钟仍未结束**。

**后果**：CI 的 `python-test` job（`backend-ci-cd.yml:99` 全量 `pytest -q`）会成为流水线瓶颈；开发者本地不会跑全量测试 → 回归只能靠 CI 发现 → 反馈延迟。

**建议**：① 用 `pytest-xdist` 并行（`-n auto`）；② 按 `-m "not slow"` 分层，PR 只跑快测、夜间跑全量；③ 定位慢用例（`--durations=20`）——大概率是真实网络/LLM 调用未 mock。

---

## 审计边界声明

- 本报告全部结论均基于**只读源码勘验**（grep / read / 探针实跑），未修改任何业务代码。
- `doc-derived-audit.mjs` 探针实跑 **37 PASS / 0 FAIL**，说明"文档与代码一致性"这一维度确实已被守住——但该探针覆盖的是**文档指向的文件是否存在**，**不覆盖"该文件是否被真正调用"**。本次审计发现的 8 个孤儿组件正是探针的盲区，建议为探针增加「关键组件必须有生产调用点」类断言。
- TypeScript 编译错误数与 Python 测试通过率因环境问题（附录 B）未能取得，本报告对这两项**不作断言**。

---

## 修复进展（2026-08-01 晚，动手实施）

用户要求"开始动手"，优先落地审计中明确标注为「当天可完成、可验证」的三项快赢。三项均已实现并通过新增测试。

### ✅ P1-6 并行工具执行器接线（原孤儿组件）
- 文件：`python/agent/core/conversation_loop.py`
- 改动：新增 `_build_parallel_executor()` / `_dispatch_tool_calls()`；`run()` 路径（原串行 for 循环，约 266 行）改为优先并发、回退串行。
- 关键设计：① 复用此前孤立的 `ParallelToolExecutor`（`python/agent/core/tool_executor.py:68`）；② 失败策略用 `CONTINUE`，保证单工具失败不中断同轮其他工具（等价于历史串行语义）；③ 环境变量 `PARALLEL_TOOL_EXECUTION=false` 可整体关闭、`MAX_PARALLEL_TOOLS` 调并发度（默认 8）；④ `run_stream()` 保持串行（其 `tool_start/tool_end` 流式事件顺序契约不可破坏）。
- 验证：`python/tests/test_parallel_tool_dispatch.py`（11 例全过：env 开关、单工具串行、多工具**真正重叠执行**、CONTINUE 不中断、禁用回退、run() 端到端）；回归 `test_core_loop.py` 24 例全过。

### ✅ P0-6 API 鉴权默认 fail-fast（原生产裸奔）
- 文件：`python/agent/main.py`（原 `require_api_key = bool(_api_keys)` 改为失败即崩溃逻辑）
- 改动：非开发环境（`ENV != development/dev`）未配置 `API_KEYS` 时，模块导入即 `raise RuntimeError`（fail-fast），杜绝生产裸奔；开发环境保持关闭兼容本地。新增逃生阀 `AUTH_FAILFAST=false` 可降级为 reject-all（仅测试/特例）。
- 验证：`python/tests/test_p0_auth_lsp.py`（6 例全过：dev 可导入 / 生产无 key 崩溃且含 "fail-fast" / 降级 reject-all 可导入 / 生产有 key 正常 / 含 P0-7 两项）。

### ✅ P0-7 LSP 非 Python 假成功修正（原误导 LLM 继续推理）
- 文件：`python/agent/tools/lsp_tools.py`
- 改动：补全/诊断/悬停/定义/引用/符号查找 6 个非 Python 语言 stub 路径，由 `success=True`（谎报）改为 `success=False` 并补 `error="unsupported_language: ..."`，明确告知 LLM 该语言需经 TS 后端。
- 验证：同上 `test_p0_auth_lsp.py` 的 `test_p0_7_*`：`success=False` 且 error 含 `unsupported`；Python 仍走真实分支 `success=True`。

### 未动项（保持审计原状，留待后续阶段）
- P0-1 双脑并行、P0-2/P0-3 CD、P0-4 schema 迁移、P0-5 数据双根 等已在 2026-08-02 三轮收口中完成（详见 §3.1 各行 ✅ 标记）。
- `run_stream()` 并行化未做（见 P1-6 设计说明第 ④ 点）。




