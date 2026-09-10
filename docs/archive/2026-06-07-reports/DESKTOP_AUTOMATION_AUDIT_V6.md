# 桌面端任务自动化能力审计报告 V6.0

> 审计日期：2026-08-22 | 审计范围：Python Agent 桌面自动化全栈

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    LongTaskOrchestrator                       │
│  (Codex风格长任务编排: 分解→并行→checkpoint→验证→恢复)       │
└──────────┬──────────────────────────────────┬────────────────┘
           │                                  │
┌──────────▼──────────┐          ┌───────────▼──────────────┐
│  ConversationLoop    │          │  DesktopOperationLoop    │
│  (ReAct+Checkpoint   │          │  (感知→执行→验证→重试)   │
│   +CancelToken       │          │   闭环流程)              │
│   +ToolTimeout)      │          └──────┬──────────────────┘
└──────────┬──────────┘                  │
           │                    ┌────────▼────────┐
┌──────────▼──────────┐        │  ActionSandbox   │
│  ToolRegistry (33)   │        │  (风险预检+回滚) │
│  ├─ DesktopTools(8)  │        └────────┬────────┘
│  ├─ SystemTools(5)   │                 │
│  ├─ CognitionTools(4)│        ┌────────▼────────┐
│  ├─ PerceptionTools(3)│       │  Perception      │
│  └─ ...              │        │  ├─ VisualGrounding│
└──────────────────────┘        │  ├─ LocalOCR      │
                                │  ├─ ScreenWatcher  │
                                │  ├─ UIACache       │
                                │  └─ ActionVerifier │
                                └──────────────────┘
```

---

## 二、能力矩阵

### 2.1 感知层（Perception）

| 能力         | 实现文件                                | 状态 | 精度   | 延迟     | 弱项                         |
| ------------ | --------------------------------------- | ---- | ------ | -------- | ---------------------------- |
| 截图         | DesktopController.screenshot            | ✅   | 像素级 | ~50ms    | 无                           |
| OCR文字识别  | LocalOCR (PaddleOCR/Tesseract)          | ✅   | 中-高  | ~200ms   | 中文混合排版                 |
| UI元素树     | UIAElementCache (Win32/macOS)           | ✅   | 高     | ~100ms   | 跨进程UIA延迟                |
| 视觉定位     | VisualGrounding (UIA→OCR→VLM)           | ✅   | 高     | ~150ms   | VLM需API                     |
| 屏幕变化检测 | ScreenWatcher (pixel/hash)              | ✅   | 中     | ~1s/poll | 增量区域检测粗糙             |
| 操作验证     | ActionVerifier (pixel/ocr/vlm/uia+降级) | ✅   | 高     | ~300ms   | VLM不可用时自动降级OCR+pixel |

### 2.2 执行层（Execution）

| 能力                | 实现文件                             | 状态 | 可靠性 | 弱项                   |
| ------------------- | ------------------------------------ | ---- | ------ | ---------------------- |
| 鼠标操作            | DesktopController (pyautogui/ctypes) | ✅   | 高     | 无FAILSAFE时无安全退出 |
| 键盘操作            | DesktopController (pyautogui/ctypes) | ✅   | 高     | 中文输入法兼容         |
| 窗口管理            | DesktopController (pywin32)          | ✅   | 高     | UAC窗口无法操作        |
| 剪贴板              | DesktopController (ctypes)           | ✅   | 高     | 大文本剪贴板延迟       |
| Shell执行           | DesktopController.subprocess         | ✅   | 高     | 长时间命令无超时       |
| UIA精确操作         | UIAEngine (Win32)                    | ✅   | 高     | 仅Windows              |
| TS DesktopAgent代理 | desktop_tools.\_call_ts_desktop      | ⚠️   | 中     | TS后端需独立部署       |

### 2.3 安全层（Safety）

| 能力     | 实现文件                                | 状态 | 弱项                                        |
| -------- | --------------------------------------- | ---- | ------------------------------------------- |
| 风险预检 | ActionSandbox.pre_check                 | ✅   | 自定义规则需扩展                            |
| 操作回滚 | ActionSandbox.create_checkpoint/restore | ✅   | 仅文件级回滚，注册表/进程回滚不完整         |
| 审批管理 | ApprovalManager (3级5风险)              | ✅   | 批量操作审批效率低                          |
| 沙箱隔离 | WindowsHardSandbox (默认auto)           | ✅   | 进程级Job Object+受限令牌，gVisor为长期目标 |
| 坐标安全 | coordinate_system (归一化)              | ✅   | 无                                          |

### 2.4 编排层（Orchestration）

| 能力             | 实现文件                                | 状态 | 弱项                  |
| ---------------- | --------------------------------------- | ---- | --------------------- |
| 任务分解         | LongTaskOrchestrator.\_decompose_task   | ✅   | LLM分解可能不完整     |
| DAG编排          | OrchestrationExecutor                   | ✅   | 循环依赖检测已有      |
| 并行执行         | LongTaskOrchestrator.\_run_decomposed   | ✅   | 并发度默认3，可调     |
| 渐进式Checkpoint | TaskCheckpointStore (SQLite+JSON双后端) | ✅   | SQLite默认，JSON降级  |
| 预算硬限制       | TaskBudget (token/time/iteration)       | ✅   | 无                    |
| 取消支持         | CancellationToken                       | ✅   | 协作式，非强制        |
| 恢复支持         | LongTaskOrchestrator.resume             | ✅   | 需checkpoint存在      |
| DSL编排          | TaskDSL (pipeline/parallel/branch)      | ✅   | 条件求值AST白名单安全 |

---

## 三、弱项发现与修复计划

### 3.1 桌面自动化弱项

| 优先级 | 编号 | 弱项                  | 核心差距                    | 修复方案                                                                      |
| ------ | ---- | --------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| **P0** | D1   | Shell执行无超时       | 长时间命令阻塞整个Agent     | 复用W2 \_get_tool_timeout，shell_exec添加timeout参数                          |
| **P0** | D2   | UAC窗口无法操作       | 提权操作被系统阻止          | 检测UAC提示→通知用户→等待手动处理                                             |
| **P1** | D3   | 中文输入法兼容        | pyautogui.type中文乱码      | 剪贴板粘贴替代键盘输入                                                        |
| **P1** | D4   | VLM验证需外部API      | 离线环境无法验证            | LocalOCR+pixel_diff降级策略                                                   |
| **P1** | D5   | TS后端需独立部署      | DesktopExecutionAgent不可用 | Python原生路径完善，TS为可选增强                                              |
| **P2** | D6   | 屏幕变化增量检测粗糙  | 全屏对比而非区域对比        | ScreenWatcher添加ROI区域配置                                                  |
| **P2** | D7   | 注册表/进程回滚不完整 | ActionSandbox仅文件级回滚   | 扩展回滚到注册表快照和进程列表                                                |
| **P2** | D8   | 批量操作审批效率低    | 每个操作独立审批            | ✅ 批量审批+风险聚合+一次性确认 (batch_respond/batch_auto_approve_below_risk) |

### 3.2 长任务模式弱项

| 优先级 | 编号 | 弱项                     | 核心差距              | 修复方案                                             |
| ------ | ---- | ------------------------ | --------------------- | ---------------------------------------------------- |
| **P0** | L1   | Checkpoint存储仅JSON文件 | 大规模任务IO瓶颈      | 添加SQLite存储后端                                   |
| **P1** | L2   | 任务分解依赖LLM          | 分解质量不稳定        | 添加模板分解+人工修正                                |
| **P1** | L3   | 子任务失败传播简单       | 失败→跳过依赖，无重试 | 添加子任务级重试策略                                 |
| **P2** | L4   | 无任务优先级调度         | 所有子任务平等执行    | ✅ 集成DynamicPriorityScorer，\_sort_by_priority调度 |
| **P2** | L5   | 无跨会话任务持久化       | 重启后任务丢失        | ✅ TaskPersistenceStore (SQLite)，自动恢复           |

---

## 四、Codex Harness 对标

| 能力        | Codex Harness               | jiabaixing V6.0                     | 差距               |
| ----------- | --------------------------- | ----------------------------------- | ------------------ |
| Agent Loop  | Rust agent-loop.ts          | Python ConversationLoop             | 语言差异，功能对齐 |
| 沙箱隔离    | 内核级 (gVisor/Firecracker) | 进程级 (WindowsHardSandbox默认auto) | 已升级至进程级     |
| 审批策略    | 3级 (auto/suggest/require)  | 3级5风险                            | 对齐               |
| Checkpoint  | 每步自动                    | 每轮自动 (LoopCheckpoint)           | 对齐               |
| 工具超时    | 声明式 per-tool             | 声明式 per-tool (W2)                | 对齐               |
| 取消令牌    | AbortController             | CancellationToken (W5)              | 对齐               |
| 子Agent     | spawnSubagent               | LongTaskOrchestrator                | 对齐               |
| apply_patch | 原生支持                    | file_edit工具                       | 对齐               |
| MCP协议     | 原生支持                    | MCP orchestrator                    | 对齐               |
| 长任务编排  | 无内置                      | LongTaskOrchestrator                | **超越**           |
| 桌面自动化  | 无                          | DesktopOperationLoop                | **超越**           |
| 感知闭环    | 无                          | Perception五感+ActionVerifier       | **超越**           |

---

## 五、修复优先级路线图

### Phase 1 — P0修复（本周）

- [x] D1: Shell执行超时 — 复用W2超时机制
- [x] D2: UAC窗口检测 — 添加UAC检测+通知
- [x] 沙箱隔离升级 — WindowsHardSandbox默认auto（进程级Job Object+受限令牌）

### Phase 2 — P1修复（下周）

- [x] D3: 中文输入法兼容 — 剪贴板粘贴策略
- [x] D4: VLM离线降级 — LocalOCR+pixel_diff自动降级（ocr_pixel_fallback策略）
- [x] D5: Python原生路径完善 — TS后端默认关闭，Python原生为默认路径
- [x] L1: Checkpoint SQLite存储 — 双后端（SQLite默认+JSON降级）
- [x] L2: 模板分解 — 5类任务模板（refactor/feature/debug/migration/document）
- [x] L3: 子任务重试 — SubTaskRetryPolicy（指数退避+可重试/不可重试错误分类）

### Phase 2+ — 容器级沙箱

- [x] DockerSandbox — 容器级隔离骨架（只读挂载+tmpfs写层+资源限制+降级链）

### Phase 3 — P2修复（后续）

- [x] D6-D8: 增量检测/回滚扩展/批量审批
- [x] L4-L5: 优先级调度/跨会话持久化

### Phase 3+4 — 内核虚拟化框架插件化增强 + 审计集成到主循环 (2026-08-22)

- [x] 内核虚拟化框架插件化增强
  - `ProviderMetrics` — 调用计数/延迟/错误率/降级计数/后端级指标采集
  - `KernelEventHooks` — 5 类事件钩子 (on_spawn/on_destroy/on_error/on_degrade/on_health_change)
  - `BackendHealthStatus` — 后端健康状态 (可用性/连续失败/在线率)
  - `KernelIsolationProvider.health_check()` — 周期性后端健康检查，触发 health_change 事件
  - `KernelIsolationProvider.update_backend_priority()` — 运行时配置热更新
  - `KernelIsolationProvider.get_metrics()` / `get_hooks()` / `get_health_status()` — 查询接口
  - `spawn`/`destroy` 集成指标采集和事件钩子发射

- [x] 框架集成化 — 沙箱审计中间件
  - `SandboxAuditMiddleware` — before_loop 执行健康检查注入 context.metadata
  - after_loop 采集指标快照记录到 context.metadata
  - 降级后端自动注入系统消息告警
  - 注册到 LoopController 中间件管道 (第 5 个中间件)
  - 环境变量 `SANDBOX_AUDIT_MIDDLEWARE_ENABLED` 控制

- [x] 审计集成到主系统循环 — 沙箱审计子代理
  - `SandboxAuditAgent` — 周期性检测隔离完整性
  - 5 维审计: 后端可用性/错误率/延迟/降级频率/配置一致性
  - `AuditFinding` + `AuditReport` — 审计发现和报告
  - 3 级严重度: INFO / WARNING / CRITICAL
  - 自动修复建议 (remediation)
  - 集成到 LoopController.run() — 每 10 次 loop 执行一次完整审计
  - 审计结果注入 context.metadata["sandbox_audit"]
  - CRITICAL 级别发现触发 log.warning 告警
  - 后台周期审计任务 (start/stop)
  - 报告历史记录 (最多 50 条)

---

## 六、Phase 3+4 架构增强详情

### 6.1 内核虚拟化框架插件化增强

#### ProviderMetrics 指标采集

| 指标                 | 类型  | 说明                       |
| -------------------- | ----- | -------------------------- |
| spawn_count          | int   | 总 spawn 调用次数          |
| spawn_success_count  | int   | 成功次数                   |
| spawn_error_count    | int   | 失败次数                   |
| destroy_count        | int   | destroy 调用次数           |
| degrade_count        | int   | 降级次数                   |
| avg_spawn_ms         | float | 平均 spawn 延迟            |
| error_rate           | float | 错误率 (0~1)               |
| backend_spawn_counts | dict  | 各后端 spawn 计数          |
| backend_error_counts | dict  | 各后端错误计数             |
| backend_latency_ms   | dict  | 各后端延迟采样 (最多 1000) |

#### KernelEventHooks 事件钩子

| 事件             | 触发时机       | 参数                                  |
| ---------------- | -------------- | ------------------------------------- |
| on_spawn         | spawn 成功后   | backend, vm_id, duration_ms           |
| on_destroy       | destroy 完成后 | vm_id, duration_ms                    |
| on_error         | spawn 失败后   | backend, error, duration_ms           |
| on_degrade       | 降级发生时     | requested, actual                     |
| on_health_change | 健康状态变化时 | backend, was_available, now_available |

#### BackendHealthStatus 健康状态

| 字段                 | 类型  | 说明         |
| -------------------- | ----- | ------------ |
| available            | bool  | 当前是否可用 |
| last_check_ms        | float | 最近检查耗时 |
| consecutive_failures | int   | 连续失败次数 |
| last_error           | str?  | 最近错误信息 |
| uptime_ratio         | float | 在线率 (0~1) |

### 6.2 沙箱审计子代理

#### 审计维度

| 维度       | 检测内容                  | 阈值 | 严重度   |
| ---------- | ------------------------- | ---- | -------- |
| 后端可用性 | consecutive_failures >= 3 | 3    | CRITICAL |
| 后端可用性 | consecutive_failures >= 1 | 1    | WARNING  |
| 错误率     | error_rate > 0.5          | 0.5  | CRITICAL |
| 错误率     | error_rate > 0.3          | 0.3  | WARNING  |
| 延迟       | avg_latency_ms > 30000    | 30s  | WARNING  |
| 降级频率   | degrade_count > 10        | 10   | WARNING  |
| 配置一致性 | 重复优先级                | —    | INFO     |

#### 集成路径

```
LoopController.run()
  ├─ MiddlewarePipeline.before_loop()
  │   └─ SandboxAuditMiddleware.before_loop() → health_check → context.metadata["sandbox_health"]
  ├─ ... (主循环执行) ...
  ├─ MiddlewarePipeline.after_loop()
  │   └─ SandboxAuditMiddleware.after_loop() → get_metrics → context.metadata["sandbox_metrics"]
  └─ SandboxAuditAgent.run_audit() → context.metadata["sandbox_audit"]
      ├─ health_check(force=True)
      ├─ get_metrics()
      ├─ 5 维审计检测
      └─ AuditReport (findings + remediation)
```

### 6.3 综合差距评分更新

| 维度             | V6.0 (Phase 3)               | V6.0 (Phase 3+4)                                | 变化 |
| ---------------- | ---------------------------- | ----------------------------------------------- | ---- |
| 内核虚拟化插件化 | ⭐⭐⭐⭐⭐ (动态注册+优先级) | ⭐⭐⭐⭐⭐ (+健康检查+事件钩子+指标+热更新)     | 巩固 |
| 沙箱可观测性     | ⭐⭐ (无指标)                | ⭐⭐⭐⭐⭐ (ProviderMetrics+事件钩子+健康状态)  | +3   |
| 沙箱审计集成     | ⭐ (无)                      | ⭐⭐⭐⭐⭐ (中间件+子代理+5维审计+修复建议)     | +4   |
| 主循环沙箱感知   | ⭐ (无)                      | ⭐⭐⭐⭐⭐ (metadata注入+降级告警+CRITICAL通知) | +4   |
| 框架集成化       | ⭐⭐⭐ (独立模块)            | ⭐⭐⭐⭐⭐ (中间件管道+主循环集成+后台审计)     | +2   |

### 6.4 Phase 4 — 桌面操作闭环增强 (2026-08-23)

- [x] D9: 操作验证闭环增强 — UIA 元素树 diff 验证
  - `DesktopOperationLoop._compute_uia_diff()` — 操作前后 UIA 元素集合 diff（added/removed）
  - `execute()` 中 `post_uia` 捕获 + diff 结果注入 `verification["uia_diff"]`
  - 最多展示 10 个 added/removed 元素，避免过大

- [x] D10: ActionSandbox 审计日志持久化 — SQLite 后端
  - `_init_audit_db()` — 初始化 SQLite 审计日志表（audit_log）
  - `_persist_audit_entry()` — 每次审计事件同步写入 SQLite
  - `query_audit_db(event/action/since/limit)` — 支持按事件类型、动作、时间范围查询
  - `close()` — 关闭数据库连接
  - 内存 `_audit_log` 保留为快速查询缓存，SQLite 为持久化后端

- [x] D11: DesktopController 多显示器支持
  - `list_monitors()` — 列出所有显示器（索引/坐标/分辨率/是否主显示器）
    - Windows: `EnumDisplayMonitors` API
    - 降级: Pillow `ImageGrab.grab().size`
    - 默认: 1920×1080
  - `screenshot_monitor(monitor_index)` — 截取指定显示器屏幕

- [x] L6: 操作循环指标采集 — `OperationLoopMetrics`
  - `OperationLoopMetrics` — 操作计数/成功失败/延迟/UAC 阻塞/动作级指标
  - `record(action, success, duration_ms, retries, uac_blocked)` — 每次操作记录
  - `success_rate` / `avg_duration_ms` — 计算属性
  - `to_dict()` — 序列化为 JSON 友好格式
  - `DesktopOperationLoop._metrics` + `get_metrics()` — 集成到操作循环

- [x] L7: ActionSandbox 与沙箱审计子代理集成
  - `ActionSandbox.integrate_with_sandbox_audit()` — 返回审计摘要（stats/blocked/rollbacks）
  - `SandboxAuditAgent.run_audit()` 新增 ActionSandbox 审计维度：
    - 拦截率偏高告警（block_rate > 30%）
    - 活跃 checkpoint 过多提示（> 20）
