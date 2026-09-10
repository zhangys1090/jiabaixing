# jiabaixing 主循环弱实现审计报告

> **审计时间**: 2026-08-22 | **架构版本**: V6.0 混合架构
> **审计范围**: ConversationLoop / Engine.process_input / VerificationLoop / 工具调度 / 错误处理 / 状态管理
> **对标**: Codex Harness Agent Loop + DeepSeek Harness Plugin Loop

---

## 一、主循环架构概览

### 当前数据流

```
用户消息 → Engine.process_input()
              ├─ 安全检查 (SecurityPolicyEngine)
              ├─ 上下文解析 (ContextReferenceResolver)
              ├─ 策略选择 (_resolve_execution_strategy)
              ├─ 澄清检测 (ClarificationEngine)
              │
              ├─ strategy == "multi_agent"
              │   └─ MultiAgentOrchestrator.process_goal_with_loop()
              │
              ├─ strategy in ("plan_exec_eval", "react")
              │   └─ ConversationLoop.run()
              │       ├─ TraceLog.record(SESSION_START)  [Harness]
              │       ├─ 认知信号注入 (inject_cognition_into_messages)
              │       ├─ 工具守卫重置 (tool_call_guard.reset_round)
              │       │
              │       ├─ while not budget.exhausted:
              │       │   ├─ ContextWindow截断 [Harness] (len>20)
              │       │   ├─ LLM.chat(messages, tools)
              │       │   ├─ ThinkScrubber.scrub(content)
              │       │   ├─ if tool_calls:
              │       │   │   └─ _dispatch_tool_calls()
              │       │   │       ├─ 并行/串行选择
              │       │   │       └─ _execute_tool_with_retry()
              │       │   │           ├─ _execute_tool()
              │       │   │           │   ├─ Schema校验
              │       │   │           │   ├─ 工具守卫检查
              │       │   │           │   ├─ 权限检查 (PermissionGuard)
              │       │   │           │   ├─ 审批 (ApprovalManager) [Harness]
              │       │   │           │   ├─ Hook: beforeToolCall
              │       │   │           │   ├─ ToolRegistry.execute()
              │       │   │           │   ├─ TraceLog.record(TOOL_CALL) [Harness]
              │       │   │           │   ├─ 工具守卫记录
              │       │   │           │   └─ Hook: afterToolCall
              │       │   │           └─ _reflect_on_failure() → 重试
              │       │   └─ VerificationLoop._verify_and_correct()
              │       │
              │       ├─ TurnFinalizer.finalize()
              │       └─ TraceLog.record(SESSION_END) [Harness]
              │
              └─ strategy == "simple"
                  └─ LLM.chat() 直接调用
```

---

## 二、弱实现清单

### W1: 无 Checkpoint 暂停/恢复机制 [严重度: P0]

**现状**：ConversationLoop.run() 是一次性执行，无法暂停/恢复。

**Codex Harness 做法**：

- 每轮循环后序列化 TurnContext
- 支持从任意轮次恢复执行
- 用户可中途暂停，稍后继续

**影响**：

- 长任务（>10轮工具调用）中途失败需从头开始
- 无法实现"暂停确认后继续"的人机协作模式
- 评测系统无法复用中间状态

**建议**：

```python
class TurnContext:
    def serialize(self) -> dict[str, Any]:
        """序列化当前轮次状态"""
        return {
            "messages": self.messages,
            "tool_calls": [...],
            "tool_results": [...],
            "budget": {...},
            "round": self.current_round,
        }

    @classmethod
    def deserialize(cls, data: dict) -> "TurnContext":
        """从序列化数据恢复"""
```

---

### W2: 工具执行无超时控制 [严重度: P0]

**现状**：`ToolRegistry.execute()` 无超时参数，工具可无限执行。

**Codex Harness 做法**：

- 每个工具有声明式超时（`timeout_ms`）
- 超时自动终止并返回错误
- 沙箱级强制超时（兜底）

**影响**：

- `shell_exec` 执行长命令可阻塞整个循环
- 网络工具（`web_fetch`）无响应可永久等待
- 一个工具超时导致整个对话卡死

**建议**：

```python
async def _execute_tool(self, tool_call: ToolCall) -> ToolResult:
    timeout = self._get_tool_timeout(tool_call.name)  # 从工具定义获取
    try:
        result = await asyncio.wait_for(
            self._tool_registry.execute(tool_call.name, params),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        return ToolResult(success=False, error=f"Tool {tool_call.name} timed out after {timeout}s")
```

---

### W3: 错误重试策略过于简单 [严重度: P1]

**现状**：`_reflect_on_failure()` 仅做字符串匹配判断是否可重试，修正参数靠 LLM 反思。

**Codex Harness 做法**：

- 结构化错误分类（Transient/Permanent/RateLimit/Auth）
- 每类错误有独立重试策略（指数退避/立即放弃/降级重试）
- 重试预算独立于迭代预算

**当前问题**：

```python
non_retryable = [
    "not found", "未找到", "不存在", "permission denied",
    "权限", "forbidden", "unauthorized", "invalid tool",
]
# 仅靠字符串匹配，无法区分：
# - "permission denied" (永久错误，不应重试)
# - "rate limit exceeded" (临时错误，应退避重试)
# - "connection timeout" (临时错误，应立即重试)
```

**建议**：

```python
class ErrorCategory(Enum):
    PERMANENT = "permanent"      # 权限/不存在/格式错误 → 不重试
    TRANSIENT = "transient"      # 超时/连接失败 → 指数退避重试
    RATE_LIMIT = "rate_limit"    # 限流 → 固定退避重试
    DEGRADABLE = "degradable"    # 可降级 → 换工具重试

class RetryPolicy:
    max_retries: int
    base_delay: float
    max_delay: float
    backoff: str  # "exponential" | "linear" | "fixed"
```

---

### W4: 并行工具执行无依赖声明 [严重度: P1]

**现状**：`_dispatch_tool_calls()` 将所有工具视为无依赖并行执行。

**Codex Harness 做法**：

- 工具声明 `depends_on: list[str]`
- 拓扑排序后分阶段并行
- 阶段内并行，阶段间串行

**当前问题**：

- `file_read` 和 `file_write` 可能并行执行，导致读写冲突
- `memory_search` 和 `memory_store` 并行，可能读到旧数据

**建议**：在工具定义中添加 `depends_on` 和 `conflicts_with` 声明。

---

### W5: 无 CancellationToken 支持 [严重度: P1]

**现状**：ConversationLoop.run() 一旦开始无法中途取消。

**Codex Harness 做法**：

- 每轮循环检查 CancellationToken
- 用户点击"停止"→ 设置 token → 循环优雅退出
- 已执行的工具结果保留，未执行的跳过

**影响**：

- 用户无法中断长时间运行的 Agent
- 评测系统无法设置全局超时
- WebSocket 断开后循环可能继续执行

**建议**：

```python
async def run(self, user_input, ..., cancellation_token: CancellationToken | None = None):
    while not budget.is_exhausted:
        if cancellation_token and cancellation_token.is_cancelled:
            break
        ...
```

---

### W6: TraceLog 记录不完整 [严重度: P1]

**现状**：仅记录 SESSION_START/TOOL_CALL/SESSION_END 三种事件。

**DeepSeek Harness 做法**：

- 记录所有状态变更：LLM_REQUEST/LLM_RESPONSE/APPROVAL_DECISION/SCORE/ERROR
- 每条记录含 trace_id + parent_id，支持树状结构
- 支持从 TraceLog 重建完整执行状态

**缺失事件**：
| 事件 | 说明 | 重要性 |
|------|------|--------|
| LLM_REQUEST | LLM 调用参数（模型、温度、工具列表） | 高 |
| LLM_RESPONSE | LLM 返回（content、tool_calls、usage） | 高 |
| APPROVAL_DECISION | 审批决策（策略、风险等级、结果） | 中 |
| PERMISSION_CHECK | 权限检查结果 | 中 |
| ERROR | 错误事件（分类、重试决策） | 高 |
| RETRY | 重试事件（原因、修正参数） | 中 |

---

### W7: 上下文截断策略粗糙 [严重度: P2]

**现状**：`len(messages) > 20` 时触发截断，阈值硬编码。

**Codex Harness 做法**：

- 基于 Token 计数而非消息条数
- 不同模型有不同的 Token 预算
- 分层保留：system 必留 → 最近 N 轮 → 摘要压缩早期

**当前问题**：

- 20 条消息可能只有 2000 Token（远未超限），却触发截断
- 也可能 20 条消息有 200k Token（已超限），截断太晚
- 未考虑不同模型的上下文窗口大小

**建议**：用 Token 计数替代消息条数，从 LLMProvider 获取模型上下文窗口大小。

---

### W8: 无流式中间结果输出 [严重度: P2]

**现状**：ConversationLoop.run() 返回最终结果，中间步骤不可观测。

**Codex Harness 做法**：

- 每轮循环 yield 中间结果
- 工具调用开始/结束各 yield 一次
- 用户可实时看到 Agent 的思考过程

**影响**：

- 用户等待时无反馈，体验差
- 无法实现"逐步确认"模式
- 调试时无法观察中间状态

**建议**：将 `run()` 改为 `async generator`，每步 `yield` 中间状态。

---

### W9: VerificationLoop 未深度集成 [严重度: P2]

**现状**：VerificationLoop 仅在工具结果后做简单校验（`_verify_and_correct`），未实现完整验证闭环。

**设计文档承诺**：

```
VerificationLoop.wrap()
    ├── pre_tool: 工具执行前校验
    ├── post_tool: 工具执行后验证 → 失败则触发修正
    ├── post_response: 最终响应验证 → 护栏 + 质量评分
    └── report: 生成验证报告
```

**实际**：仅 `post_tool` 部分实现，`pre_tool` 和 `post_response` 未集成到主循环。

---

### W10: 策略选择逻辑不透明 [严重度: P2]

**现状**：`_resolve_execution_strategy()` 和 `_should_use_loop()` 的决策逻辑不透明。

**DeepSeek Harness 做法**：

- Profile 机制明确声明使用哪种策略
- 策略选择可配置、可覆盖
- 决策过程记录到 TraceLog

**当前问题**：

- 用户无法控制使用哪种策略
- 策略选择无日志，调试困难
- 不同策略的切换条件硬编码

---

## 三、弱实现优先级排序

| 优先级 | 编号 | 弱实现                    | 工作量 | 收益         |
| ------ | ---- | ------------------------- | ------ | ------------ |
| **P0** | W1   | Checkpoint 暂停/恢复      | 中     | 长任务可靠性 |
| **P0** | W2   | 工具执行超时控制          | 小     | 防阻塞       |
| **P1** | W3   | 错误重试策略增强          | 中     | 重试成功率   |
| **P1** | W4   | 并行工具依赖声明          | 中     | 执行正确性   |
| **P1** | W5   | CancellationToken         | 小     | 用户体验     |
| **P1** | W6   | TraceLog 记录完善         | 中     | 可观测性     |
| **P2** | W7   | 上下文截断策略            | 小     | 长对话可靠性 |
| **P2** | W8   | 流式中间结果              | 大     | 用户体验     |
| **P2** | W9   | VerificationLoop 深度集成 | 中     | 结果质量     |
| **P2** | W10  | 策略选择透明化            | 小     | 可调试性     |

---

## 四、与 Codex/DSH Agent Loop 对标

| 能力       | Codex Harness | DSH            | jiabaixing 现状     | 差距   |
| ---------- | ------------- | -------------- | ------------------- | ------ |
| Agent Loop | ✅ Rust 实现  | ✅ Plugin Loop | ✅ ConversationLoop | 无     |
| 审批策略   | ✅ 3级5风险   | ❌ 无内置      | ✅ 3级5风险         | 无     |
| 沙箱隔离   | ✅ 内核级     | ✅ 插件级      | ⚠️ 逻辑级           | 需升级 |
| 上下文管理 | ✅ Token预算  | ✅ 插件        | ⚠️ 消息条数         | 需改进 |
| Checkpoint | ✅ 支持       | ✅ 支持        | ❌ 不支持           | **P0** |
| 工具超时   | ✅ 声明式     | ✅ 插件        | ❌ 不支持           | **P0** |
| 取消令牌   | ✅ 支持       | ✅ 支持        | ❌ 不支持           | **P1** |
| 流式输出   | ✅ 支持       | ✅ 支持        | ⚠️ 仅最终           | **P2** |
| 错误分类   | ✅ 结构化     | ✅ 插件        | ⚠️ 字符串匹配       | **P1** |
| 并行依赖   | ✅ 声明式     | ✅ 插件        | ❌ 全并行           | **P1** |
| 轨迹完整   | ✅ OTel       | ✅ TraceLog    | ⚠️ 3种事件          | **P1** |
| 插件化     | ❌ 无         | ✅ Cordis      | ✅ PluginRegistry   | 需扩展 |
| 热插拔     | ❌ 不支持     | ✅ 支持        | ✅ 支持             | 无     |
| 三维评分   | ❌ 无         | ✅ 内置        | ✅ 内置             | 无     |
| pass@k     | ✅ 内置       | ❌ 无          | ✅ 内置             | 无     |

---

## 五、V6.0 修复状态（2026-08-22）

| 优先级 | 编号 | 弱实现                   | 状态      | 修复方案                                                                                                                  | 涉及文件                               |
| ------ | ---- | ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| P0     | W1   | Checkpoint暂停/恢复      | ✅ 已修复 | LoopCheckpoint数据类 + serialize/deserialize + run(checkpoint=)恢复 + last_checkpoint属性                                 | turn_types.py, conversation_loop.py    |
| P0     | W2   | 工具执行超时控制         | ✅ 已修复 | \_get_tool_timeout()声明式查找 + asyncio.wait_for强制终止 + ToolDefinition.timeout字段 + TimeoutError→ToolResult          | conversation_loop.py, registry.py      |
| P1     | W3   | 错误重试策略增强         | ✅ 已修复 | ErrorClassifier.classify()语义化分类替代字符串匹配，is_retryable驱动重试决策                                              | conversation_loop.py                   |
| P1     | W4   | 并行工具依赖声明         | ✅ 已修复 | \_resolve_tool_dependencies()静态方法 + ToolCallItem.depends_on填充 + DAG拓扑排序（file_write依赖同路径file_read）        | conversation_loop.py, tool_executor.py |
| P1     | W5   | CancellationToken        | ✅ 已修复 | CancellationToken类 + run(cancellation_token=)参数 + while循环每轮检查is_cancelled                                        | turn_types.py, conversation_loop.py    |
| P1     | W6   | TraceLog记录完善         | ✅ 已修复 | TraceEventType扩展至20种：+LLM_REQUEST/APPROVAL_REQUEST/CHECKPOINT_SAVE/CHECKPOINT_RESTORE/CANCEL_REQUEST/STRATEGY_SELECT | trace_log.py, conversation_loop.py     |
| P2     | W7   | 上下文截断策略           | ✅ 已修复 | 基于token预算截断(is_token_exhausted触发) + ContextWindowManager集成 + TraceLog记录CONTEXT_TRUNCATION                     | conversation_loop.py                   |
| P2     | W8   | 流式中间结果             | ✅ 已修复 | run_stream新增llm_request/llm_response/tool_progress/checkpoint/verification事件                                          | conversation_loop.py                   |
| P2     | W9   | VerificationLoop深度集成 | ✅ 已修复 | \_pre_tool_verify()工具执行前验证 + \_post_response_verify()LLM响应后验证 + 原有\_verify_and_correct()工具结果后验证      | conversation_loop.py                   |
| P2     | W10  | 策略选择透明化           | ✅ 已修复 | strategy_hint参数(fast/safe/balanced) + strategy_hint属性 + ConversationResult.metadata记录                               | conversation_loop.py                   |

### 修复后对标差距更新

| 能力       | Codex Harness | DSH            | jiabaixing V6.0      | 差距       |
| ---------- | ------------- | -------------- | -------------------- | ---------- |
| Agent Loop | ✅ Rust 实现  | ✅ Plugin Loop | ✅ ConversationLoop  | 无         |
| 审批策略   | ✅ 3级5风险   | ❌ 无内置      | ✅ 3级5风险          | 无         |
| 沙箱隔离   | ✅ 内核级     | ✅ 插件级      | ⚠️ 逻辑级            | 需升级     |
| 上下文管理 | ✅ Token预算  | ✅ 插件        | ✅ Token预算         | **已修复** |
| Checkpoint | ✅ 支持       | ✅ 支持        | ✅ LoopCheckpoint    | **已修复** |
| 工具超时   | ✅ 声明式     | ✅ 插件        | ✅ 声明式per-tool    | **已修复** |
| 取消令牌   | ✅ 支持       | ✅ 支持        | ✅ CancellationToken | **已修复** |
| 流式输出   | ✅ 支持       | ✅ 支持        | ✅ 富类型流式事件    | **已修复** |
| 错误分类   | ✅ 结构化     | ✅ 插件        | ✅ ErrorClassifier   | **已修复** |
| 并行依赖   | ✅ 声明式     | ✅ 插件        | ✅ DAG拓扑排序       | **已修复** |
| 轨迹完整   | ✅ OTel       | ✅ TraceLog    | ✅ 20种事件          | **已修复** |
| 插件化     | ❌ 无         | ✅ Cordis      | ✅ PluginRegistry    | 需扩展     |
| 热插拔     | ❌ 不支持     | ✅ 支持        | ✅ 支持              | 无         |
| 三维评分   | ❌ 无         | ✅ 内置        | ✅ 内置              | 无         |
| pass@k     | ✅ 内置       | ❌ 无          | ✅ 内置              | 无         |
