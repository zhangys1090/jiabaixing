# 统一上下文编排器使用指南

**版本**: 1.0
**最后更新**: 2026-06-24

---

## 一、概述

统一上下文编排器（Unified Context Orchestrator）是家百星系统中负责统一管理和编排所有上下文组件的核心模块。它提供了单一的上下文构建入口，简化了调用方式，同时提供了灵活的组件注册、依赖管理、缓存优化和错误降级机制。

### 1.1 主要特性

- **统一入口**：一个 `build_context()` 方法搞定所有上下文构建
- **组件化**：支持组件注册、注销、热插拔
- **智能编排**：基于优先级和依赖关系自动排序执行
- **多级缓存**：L1结果缓存 + L2组件级缓存，提升性能
- **错误降级**：单个组件失败不影响整体，自动降级
- **可观测**：完整的统计、日志、监控指标
- **向后兼容**：双轨运行，默认关闭，可随时回滚

### 1.2 适用场景

- 需要构建复杂LLM对话上下文的场景
- 多个上下文组件需要协同工作的场景
- 需要性能优化和缓存的场景
- 需要高可靠性和错误降级的场景

---

## 二、快速开始

### 2.1 启用编排器

通过环境变量启用：

```bash
# Windows
set USE_UNIFIED_CONTEXT=true

# Linux/Mac
export USE_UNIFIED_CONTEXT=true
```

或者在代码中手动启用：

```python
from agent.context import UnifiedContextOrchestrator

orchestrator = UnifiedContextOrchestrator(
    use_cache=True,
    enabled=True,
)
```

### 2.2 基本使用

```python
from agent.context import UnifiedContextOrchestrator, ContextBuildRequest
from agent.context.adapters import (
    SystemPromptComponent,
    PersonaComponent,
    MemoryRetrievalComponent,
    ContextAssemblerComponent,
)

# 创建编排器
orchestrator = UnifiedContextOrchestrator(use_cache=True)

# 注册组件
orchestrator.register_component(SystemPromptComponent())
orchestrator.register_component(PersonaComponent())
orchestrator.register_component(MemoryRetrievalComponent())
orchestrator.register_component(ContextAssemblerComponent())

# 构建上下文
request = ContextBuildRequest(
    user_input="你好，请帮我写一个Python函数",
    session_id="test_session",
    scene="development",
    use_memory=True,
    max_tokens=4000,
)

result = await orchestrator.build_context(request)

# 使用结果
messages = result.messages
print(f"构建完成，共 {len(messages)} 条消息")
print(f"总Token数: {result.total_tokens}")
```

### 2.3 在 AgentEngine 中使用

编排器已集成到 `AgentEngine` 中，启用后可直接使用：

```python
from agent.core.engine import AgentEngine

engine = AgentEngine()
await engine.initialize()

# 使用统一上下文编排器
if engine.unified_context_orchestrator:
    request = ContextBuildRequest(
        user_input="你好",
        session_id="default",
    )
    result = await engine.unified_context_orchestrator.build_context(request)
```

---

## 三、核心概念

### 3.1 组件（Component）

组件是上下文构建的基本单元，每个组件负责一项特定的功能。所有组件都继承自 `ContextComponent` 基类。

**组件属性**：

- `name`：组件名称（唯一标识）
- `priority`：优先级（数字越小越早执行）
- `dependencies`：依赖的其他组件
- `enabled`：是否启用

**组件方法**：

- `can_handle(request)`：判断是否需要处理该请求
- `execute(request, context)`：执行组件逻辑

### 3.2 优先级体系

| 层级     | 优先级范围 | 说明                              |
| -------- | ---------- | --------------------------------- |
| 系统层   | 10-99      | 系统Prompt、人格设定、语气调整    |
| 记忆层   | 100-199    | 记忆检索、情景记忆、记忆策展      |
| 上下文层 | 200-299    | 文件上下文、@引用解析、动态上下文 |
| 历史层   | 300-399    | 历史消息管理                      |
| 组装层   | 400-499    | 上下文组装                        |
| 优化层   | 500-599    | Token预算、压缩、注意力聚焦       |

### 3.3 构建流程

```
1. 接收请求
   ↓
2. 检查缓存（命中则直接返回）
   ↓
3. 组件筛选（can_handle + enabled）
   ↓
4. 拓扑排序（基于优先级和依赖）
   ↓
5. 顺序执行每个组件
   ├─ 检查依赖
   ├─ 执行组件
   ├─ 错误捕获和降级
   └─ 收集结果
   ↓
6. 组装最终结果
   ↓
7. 写入缓存
   ↓
8. 返回结果
```

### 3.4 缓存机制

**两级缓存**：

- **L1 结果缓存**：完整的构建结果，基于请求内容哈希
- **L2 组件级缓存**：每个组件的输出缓存，独立失效

**缓存策略**：

- LRU（最近最少使用）淘汰
- TTL（生存时间）过期
- 可配置大小和过期时间

---

## 四、API 参考

### 4.1 UnifiedContextOrchestrator

#### 构造函数

```python
UnifiedContextOrchestrator(
    use_cache: bool = True,
    cache_max_size: int = 100,
    cache_ttl: int = 300,
    enabled: bool = True,
)
```

**参数**：

- `use_cache`：是否启用缓存
- `cache_max_size`：缓存最大条目数
- `cache_ttl`：缓存过期时间（秒）
- `enabled`：是否启用编排器

#### build_context

```python
async def build_context(
    request: ContextBuildRequest,
) -> ContextBuildResult
```

统一的上下文构建入口。

**参数**：

- `request`：上下文构建请求

**返回**：

- `ContextBuildResult`：构建结果

#### register_component

```python
def register_component(component: ContextComponent) -> None
```

注册组件。

#### unregister_component

```python
def unregister_component(name: str) -> bool
```

注销组件，返回是否成功。

#### get_component

```python
def get_component(name: str) -> ContextComponent | None
```

获取组件实例。

#### list_components

```python
def list_components() -> list[str]
```

列出所有已注册的组件名称。

#### enable_component / disable_component

```python
def enable_component(name: str) -> bool
def disable_component(name: str) -> bool
```

启用/禁用组件。

#### clear_cache

```python
def clear_cache() -> None
```

清空所有缓存。

#### get_cache_stats

```python
def get_cache_stats() -> dict[str, Any]
```

获取缓存统计信息。

#### get_statistics

```python
def get_statistics() -> BuildStatistics
```

获取构建统计信息。

### 4.2 ContextBuildRequest

上下文构建请求数据类。

**主要属性**：

- `user_input`：用户输入（必填）
- `session_id`：会话ID，默认 "default"
- `scene`：场景类型，默认 "daily"
- `system_prompt`：基础系统Prompt
- `use_memory`：是否使用记忆，默认 True
- `memory_limit`：记忆条数限制，默认 5
- `history`：历史消息列表
- `history_limit`：历史消息条数限制，默认 20
- `use_file_context`：是否使用文件上下文，默认 True
- `use_compression`：是否启用压缩，默认 True
- `max_tokens`：最大Token数，默认 8000
- `use_cache`：是否使用缓存，默认 True
- `metadata`：元数据字典

### 4.3 ContextBuildResult

上下文构建结果数据类。

**主要属性**：

- `messages`：最终的消息列表
- `system_prompt`：系统Prompt（单独提取）
- `history`：历史消息（单独提取）
- `total_tokens`：总Token数
- `component_results`：各组件执行结果
- `build_time_ms`：总构建耗时（毫秒）
- `from_cache`：是否来自缓存
- `status`：构建状态（SUCCESS/PARTIAL/FAILED）
- `errors`：错误列表
- `warnings`：警告列表

---

## 五、内置组件

### 5.1 SystemPromptComponent

**名称**：`system_prompt`
**优先级**：10（最高）

负责构建基础的系统Prompt。如果请求中没有提供 system_prompt，则使用默认值。

### 5.2 PersonaComponent

**名称**：`persona`
**优先级**：20
**依赖**：`system_prompt`（强依赖）

负责构建人格摘要和场景语气指令。可集成 `PersonaCore` 使用。

### 5.3 MemoryRetrievalComponent

**名称**：`memory_retrieval`
**优先级**：100
**依赖**：`persona`（弱依赖）

负责从记忆系统检索相关记忆。可集成 `MemoryEngine` 使用。

**可配置**：

- `use_memory`：是否使用记忆
- `memory_limit`：记忆条数限制

### 5.4 FileContextComponent

**名称**：`file_context`
**优先级**：200
**依赖**：`memory_retrieval`（弱依赖）

负责加载项目上下文文件。可集成 `ContextFileRegistry` 使用。

**可配置**：

- `use_file_context`：是否使用文件上下文
- `context_files`：指定上下文文件

### 5.5 TokenBudgetComponent

**名称**：`token_budget`
**优先级**：500
**依赖**：`file_context`（弱依赖）

负责分配和管理Token预算。可集成 `TokenBudgetAllocator` 使用。

### 5.6 ContextAssemblerComponent

**名称**：`context_assembler`
**优先级**：400
**依赖**：`token_budget`（弱依赖）

负责组装最终的上下文消息，包括历史消息和用户输入。

---

## 六、自定义组件开发

### 6.1 创建自定义组件

继承 `ContextComponent` 基类，实现必要的方法：

```python
from agent.context.base import ContextComponent
from agent.context.models import (
    BuildContext,
    ComponentPriority,
    ContextBuildRequest,
)


class MyCustomComponent(ContextComponent):
    """我的自定义组件"""

    def __init__(self, config: dict | None = None) -> None:
        super().__init__()
        self._config = config or {}

    @property
    def name(self) -> str:
        return "my_custom_component"

    @property
    def priority(self) -> int:
        return ComponentPriority.DYNAMIC_CONTEXT  # 选择合适的优先级

    @property
    def dependencies(self) -> list:
        return [
            # 声明依赖的组件
            ComponentDependency(
                component_name="system_prompt",
                required=True,  # 强依赖
            ),
        ]

    def can_handle(self, request: ContextBuildRequest) -> bool:
        """判断是否需要处理该请求"""
        # 可以根据请求内容决定是否执行
        return True

    async def _execute(
        self,
        request: ContextBuildRequest,
        context: BuildContext,
    ) -> dict:
        """执行组件逻辑

        Args:
            request: 构建请求
            context: 构建上下文（可获取其他组件的输出）

        Returns:
            dict: 组件输出数据
        """
        # 获取其他组件的输出
        system_output = context.get_output("system_prompt")

        # 你的业务逻辑...
        result_data = {
            "custom_info": "这是自定义组件的输出",
        }

        # 可以添加消息到上下文
        context.add_message("system", "【自定义信息】...")

        return result_data
```

### 6.2 注册自定义组件

```python
orchestrator.register_component(MyCustomComponent(config={...}))
```

### 6.3 最佳实践

1. **合理选择优先级**：根据组件的功能选择合适的优先级层级
2. **明确依赖关系**：正确声明依赖，确保执行顺序正确
3. **实现 can_handle**：根据请求内容决定是否执行，避免不必要的计算
4. **错误处理**：在 `_execute` 中抛出异常，基类会自动捕获并降级
5. **输出数据**：通过返回值输出数据，通过 `context.add_message()` 添加消息
6. **使用上下文**：通过 `context.get_output()` 获取其他组件的输出

---

## 七、性能优化

### 7.1 缓存优化

**启用缓存**：

```python
orchestrator = UnifiedContextOrchestrator(
    use_cache=True,
    cache_max_size=200,  # 增加缓存大小
    cache_ttl=600,       # 延长缓存时间
)
```

**缓存命中率优化**：

- 尽量保持请求参数一致
- 合理设置 history_limit，减少历史消息变化对缓存的影响
- 对重复请求使用相同的 session_id

### 7.2 组件优化

- 禁用不需要的组件
- 对计算密集型组件实现组件级缓存
- 使用 `can_handle()` 跳过不必要的执行

### 7.3 性能指标

**预期性能**：

- 缓存命中时：< 10ms
- 完整构建时：< 100ms（6个基础组件）
- 缓存命中率：> 50%（重复请求场景）

**查看性能指标**：

```python
# 缓存统计
cache_stats = orchestrator.get_cache_stats()
print(f"缓存命中率: {cache_stats['hit_rate']:.2%}")

# 构建统计
stats = orchestrator.get_statistics()
print(f"平均构建耗时: {stats.avg_time_ms:.2f}ms")
print(f"成功率: {stats.success_rate:.2%}")
```

---

## 八、错误处理与降级

### 8.1 降级策略

编排器支持4级降级：

| 级别       | 说明                     |
| ---------- | ------------------------ |
| FULL       | 完整执行（无降级）       |
| SIMPLIFIED | 简化模式（组件内部实现） |
| SKIP       | 跳过组件                 |
| USE_CACHE  | 使用缓存结果             |

### 8.2 错误处理机制

- **单个组件失败**：自动降级为跳过，记录警告，继续执行
- **强依赖失败**：跳过所有依赖该组件的组件
- **循环依赖**：降级为按优先级顺序执行
- **编排器禁用**：返回基础上下文结果

### 8.3 监控错误

```python
result = await orchestrator.build_context(request)

if result.status == BuildStatus.PARTIAL:
    # 部分成功，有组件降级
    print(f"警告: {len(result.warnings)} 条")
    print(f"失败组件: {result.get_failed_components()}")
    print(f"降级组件: {result.get_degraded_components()}")

elif result.status == BuildStatus.FAILED:
    # 完全失败
    print(f"错误: {len(result.errors)} 个")
    for error in result.errors:
        print(f"  - {error.error_type}: {error.message}")
```

---

## 九、迁移指南

### 9.1 从旧接口迁移

**旧方式（手动构建）**：

```python
messages = []
if system_prompt:
    messages.append({"role": "system", "content": system_prompt})
if history:
    messages.extend(history)
messages.append({"role": "user", "content": user_input})
```

**新方式（使用编排器）**：

```python
request = ContextBuildRequest(
    user_input=user_input,
    system_prompt=system_prompt,
    history=history,
)
result = await orchestrator.build_context(request)
messages = result.messages
```

### 9.2 渐进式迁移策略

**阶段1：双轨运行**

- 新旧实现并存
- 通过环境变量切换
- 默认使用旧实现

**阶段2：灰度发布**

- 部分用户/场景使用新实现
- 收集性能和错误数据
- 逐步扩大范围

**阶段3：全量切换**

- 新实现成为默认
- 保留旧实现作为回滚选项

**阶段4：清理旧代码**

- 移除旧实现
- 清理兼容代码

### 9.3 回滚方案

如果新编排器出现问题，可以快速回滚：

```bash
# 关闭统一上下文编排器
set USE_UNIFIED_CONTEXT=false
```

或者在代码中：

```python
orchestrator.enabled = False
```

---

## 十、常见问题

### Q1: 如何启用统一上下文编排器？

**A**: 设置环境变量 `USE_UNIFIED_CONTEXT=true`，或者在代码中手动创建并启用。

### Q2: 编排器会影响现有功能吗？

**A**: 不会。默认是关闭的，启用后也是双轨运行，可以随时回滚。

### Q3: 如何添加自定义组件？

**A**: 继承 `ContextComponent` 基类，实现必要的方法，然后调用 `orchestrator.register_component()` 注册。

### Q4: 缓存如何工作？

**A**: 基于请求内容的MD5哈希作为缓存键，支持LRU淘汰和TTL过期。相同请求会直接返回缓存结果。

### Q5: 组件执行顺序是怎样的？

**A**: 首先按优先级排序，然后根据依赖关系进行拓扑排序，确保依赖的组件先执行。

### Q6: 如何调试上下文构建问题？

**A**:

1. 查看 `result.component_results` 了解每个组件的执行状态
2. 查看 `result.errors` 和 `result.warnings` 了解错误信息
3. 开启调试日志查看详细执行过程

### Q7: 性能不达标怎么办？

**A**:

1. 检查缓存命中率，优化缓存策略
2. 禁用不需要的组件
3. 优化慢组件的实现
4. 考虑使用组件级缓存

---

## 十一、故障排查

### 11.1 编排器未启用

**症状**：`engine.unified_context_orchestrator` 为 None

**解决方案**：

- 检查环境变量 `USE_UNIFIED_CONTEXT` 是否设置为 `true`
- 检查初始化日志中是否有相关警告

### 11.2 组件执行失败

**症状**：构建状态为 PARTIAL 或 FAILED

**排查步骤**：

1. 查看 `result.errors` 获取错误详情
2. 查看组件的依赖是否都成功执行
3. 检查组件的配置是否正确

### 11.3 缓存不生效

**症状**：相同请求每次都重新构建

**排查步骤**：

1. 确认 `use_cache=True`
2. 检查请求参数是否完全一致
3. 查看缓存统计，确认命中率
4. 检查缓存是否已满导致频繁淘汰

### 11.4 性能问题

**症状**：构建耗时过长

**优化方向**：

1. 启用缓存，提高命中率
2. 禁用不需要的组件
3. 优化慢组件的实现
4. 增加缓存大小

---

## 十二、架构设计

### 12.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│              UnifiedContextOrchestrator                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Component Registry                    │  │
│  │  组件注册、发现、管理                              │  │
│  └───────────────────────────────────────────────────┘  │
│                            │                            │
│                            ▼                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │         Orchestration Engine                      │  │
│  │  优先级排序、依赖解析、拓扑排序、条件执行          │  │
│  └───────────────────────────────────────────────────┘  │
│                            │                            │
│                            ▼                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Cache Layer                          │  │
│  │  L1结果缓存 + L2组件级缓存                        │  │
│  └───────────────────────────────────────────────────┘  │
│                            │                            │
│                            ▼                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │         Stats & Monitoring                        │  │
│  │  构建统计、组件指标、缓存指标                      │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 12.2 设计原则

1. **单一职责**：每个组件只负责一项功能
2. **开闭原则**：对扩展开放，对修改关闭
3. **依赖倒置**：依赖抽象，不依赖具体实现
4. **容错设计**：失败降级，不影响整体
5. **性能优先**：缓存、懒加载、按需执行

---

## 附录

### A. 文件结构

```
python/agent/context/
├── __init__.py                    # 包初始化
├── models.py                      # 数据结构定义
├── base.py                        # 组件基类和注册器
├── cache.py                       # 缓存模块
├── unified_orchestrator.py        # 编排器主类
└── adapters/                      # 内置组件适配器
    ├── __init__.py
    ├── system_prompt.py
    ├── persona.py
    ├── memory_retrieval.py
    ├── file_context.py
    ├── token_budget.py
    └── context_assembler.py
```

### B. 相关文档

- 设计文档：`docs/UNIFIED_CONTEXT_ORCHESTRATOR_DESIGN.md`
- 能力差距分析：`docs/AGENT_CAPABILITY_GAP_ANALYSIS.md`

### C. 环境变量

| 变量名                             | 默认值  | 说明                     |
| ---------------------------------- | ------- | ------------------------ |
| `USE_UNIFIED_CONTEXT`              | `false` | 是否启用统一上下文编排器 |
| `JIA_BAI_XING_USE_UNIFIED_CONTEXT` | `false` | 同上（别名）             |

---

**文档结束**
