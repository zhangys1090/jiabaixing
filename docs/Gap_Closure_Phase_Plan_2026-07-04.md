# 家百星 Agent 差距修复实施计划 (2026-07-04)

> **基于代码验证后的真实差距** | 5阶段路线图 | 预计16周完成
> **综合评分目标**: 5.7/10 → 8.5/10

---

## 总体策略

| 原则                       | 说明                           |
| -------------------------- | ------------------------------ |
| **先修复断点，再扩展能力** | Phase 1聚焦真实阻断性问题      |
| **渐进式启用**             | 所有新功能都有环境变量开关     |
| **Python侧先行**           | 混合架构中Python层是短板集中区 |
| **保持向后兼容**           | 不破坏现有API和行为            |

---

## Phase 1: 基础层修复 (2周)

### 目标

修复记忆中链路断点、Python侧Redis集成、MemoryAssistant主循环集成

### 任务清单

#### P1-1: Python侧Redis集成

**优先级**: 阻塞性
**工作量**: 3天
**负责人**: 后端工程师

**现状**:

- `python/pyproject.toml` 中无redis客户端依赖
- TS侧RedisCache已实现但默认关闭(REDIS_ENABLED)
- Docker Compose中Redis已配置但Python端未连接

**实施步骤**:

1. `python/pyproject.toml` 添加 `redis` 和 `aioredis` 依赖
2. 创建 `python/agent/memory/redis_cache.py` - Python端Redis适配器
3. 创建 `python/agent/memory/postgres_extension.py` - PostgreSQL扩展模块
4. 修改 `python/agent/memory/engine.py` - 注入Redis缓存层
5. 环境变量支持: `REDIS_URL` / `REDIS_ENABLED` / `REDIS_POOL_SIZE`
6. 编写单元测试(pytest)

**验收标准**:

- Python端可通过Redis存储短期记忆
- Redis不可用时优雅降级到内存缓存
- 测试通过率100%

#### P1-2: MemoryAssistant主循环集成

**优先级**: 高
**工作量**: 2天
**负责人**: 核心开发工程师

**现状**:

- MemoryAssistant类已实现但未被LoopController主循环直接调用
- MemoryEngine在TS侧被注入但未在Python Harness统一架构下使用

**实施步骤**:

1. 修改 `python/agent/loop/controller.py` - 在每轮执行后调用MemoryAssistant.autoRetrieveMemories()
2. 修改 `python/agent/loop/reflection.py` - 将反思结果自动写入MemoryAssistant
3. 在 `_lightweight_reflection_round()` 中集成 `memoryAssistant.recordSuccessExperience()`
4. 在规划阶段注入 `memoryAssistant.retrieveContext()` 结果

**验收标准**:

- 每轮执行后MemoryAssistant被自动调用
- 反思结果可被后续任务检索复用
- 轻量级反思耗时<500ms

#### P1-3: ChromaDB连接健壮性改进

**优先级**: 中
**工作量**: 1天
**负责人**: 后端工程师

**现状**:

- ChromaVectorDatabase硬编码localhost:8000
- ChromaDB不可用时降级到SQLite,向量检索变为关键词搜索

**实施步骤**:

1. 从环境变量读取ChromaDB地址: `CHROMADB_URL` (默认localhost:8000)
2. 增加连接重试机制(最多3次,间隔1s)
3. 增加健康检查端点 `/api/health/vector-db`
4. 日志记录降级事件

**验收标准**:

- ChromaDB不可用时有明确日志+降级
- 环境变量可配置ChromaDB地址
- 健康检查端点返回向量存储状态

#### P1-4: TS MemoryEngine → Python Bridge

**优先级**: 中
**工作量**: 2天
**负责人**: 后端工程师

**现状**:

- TS侧MemoryEngine在AGENT_BACKEND=python模式下被水印
- Python侧有独立MemoryEngine但未与TS侧建立Bridge

**实施步骤**:

1. 创建 `src/harness/tools/memory/memory_sync.ts` - TS→Python记忆同步桥
2. 在Python端创建 `python/agent/tools/memory_sync_tool.py` - 接收TS侧请求
3. 双向同步: TS ShortTermMemory → Python LongTermMemory(向量存储)
4. 工具注册: 桥接为Harness可调用的memory_sync工具

**验收标准**:

- TS侧记忆写入自动同步到Python后端
- Python侧记忆检索可返回到TS前端
- 同步失败不阻塞主流程

### Phase 1 验收指标

| 指标               | 修复前           | 修复后               |
| ------------------ | ---------------- | -------------------- |
| MemoryEngine使用率 | 0%(未注入消费方) | 100%(主循环每轮调用) |
| Redis集成          | TS侧有但关闭     | TS+Python双端启用    |
| ChromaDB健壮性     | 硬编码+无重试    | 可配置+重试+健康检查 |
| TS↔Python记忆同步  | 断裂             | 桥接完成             |

### Phase 1 预估收益

- 记忆功能从"形同虚设"到"真正可用"
- Redis分布式缓存为Phase 3水平扩展打底
- 为后续所有记忆相关能力提升奠定基础

---

## Phase 2: 协议完善层 (3周)

### 目标

MCP Resources/Prompts完善 + Python侧OTel集成 + 消息队列引入

### 任务清单

#### P2-1: MCP传输层扩展(HTTP/SSE)

**优先级**: 高
**工作量**: 4天
**负责人**: 后端工程师

**现状**:

- 仅支持stdio传输(JSON-RPC)
- 缺少HTTP SSE传输,无法远程MCP服务

**实施步骤**:

1. 创建 `src/mcp/HttpSseTransport.ts` - HTTP流式传输层
2. 创建 `src/mcp/McpServerManagerV2.ts` - 支持双传输模式
3. 添加Express端点: `POST /api/mcp/:serverName/stream`
4. 环境变量: `MCP_HTTP_ENABLED` / `MCP_SSE_PORT`
5. 修改 `MCPToolBridge` 支持远程MCP服务器

**验收标准**:

- 支持stdio和HTTP SSE两种传输模式
- 可通过HTTP流式调用远程MCP服务器
- 传输层切换通过环境变量控制

#### P2-2: Python侧OpenTelemetry集成

**优先级**: 高
**工作量**: 5天
**负责人**: 后端工程师

**现状**:

- TS侧OTel已完整集成,Python侧完全空白
- Python端使用原生logging,无结构化追踪

**实施步骤**:

1. `python/pyproject.toml` 添加 otel依赖:
   - `opentelemetry-api`
   - `opentelemetry-sdk`
   - `opentelemetry-exporter-otlp-proto-grpc`
   - `opentelemetry-exporter-prometheus`
2. 创建 `python/agent/core/otel_tracer.py` - OTel Tracer初始化
3. 创建 `python/agent/core/otel_metrics.py` - Prometheus Metrics导出
4. 在 `controller.py` 中添加装饰器: `@otel_trace("loop.execute")`
5. 在 `executor.py` 中添加工具调用追踪
6. 在 `reflection.py` 中添加反思过程追踪
7. 暴露 `/metrics` 端点(Prometheus端口)

**验收标准**:

- Python端trace数据可推送到OTLP Collector
- Prometheus指标可在 `/metrics` 端点抓取
- 与TS侧共享相同的serviceName和traceId
- 测试覆盖率80%+

#### P2-3: 消息队列引入(Redis Streams)

**优先级**: 高
**工作量**: 5天
**负责人**: 后端工程师

**现状**:

- 仅有EventBus进程内事件总线
- 无Kafka/RabbitMQ/Redis Streams

**实施步骤**:

1. 利用Phase 1已部署的Redis,使用Redis Streams替代Kafka(轻量级)
2. 创建 `python/agent/core/message_queue.py` - Redis Streams封装
3. 定义消息类型: TaskCreated, TaskCompleted, ReflectionEvent, EvolutionTrigger
4. 修改 `controller.py` - 事件发射改为MQ消息
5. 创建消费者: `python/agent/core/mq_consumer.py` - 异步消费
6. 增加重试+死信队列机制

**验收标准**:

- 所有核心事件通过MQ传递(EventBus降级为MQ的适配器)
- 消费者可独立扩展(多worker)
- 消息持久化+重试+死信队列
- 向后兼容: 无MQ时自动降级为进程内EventBus

#### P2-4: MCP Sampling和Progress协议

**优先级**: 低
**工作量**: 2天
**负责人**: 后端工程师

**现状**:

- MCP仅实现Tools/Resources/Prompts
- 缺少Sampling(LLM采样)和Progress(进度通知)

**实施步骤**:

1. 在 `MCPServerManager` 中实现 `sampling/createMessage`
2. 在 `MCPServerManager` 中实现 `notifications/progress`
3. 文档化新增协议能力

**验收标准**:

- MCP Server可提供Prompt模板给LLM采样
- 长任务执行可推送Progress通知

### Phase 2 验收指标

| 指标        | 修复前     | 修复后                   |
| ----------- | ---------- | ------------------------ |
| MCP传输层   | 仅stdio    | stdio+HTTP SSE           |
| Python OTel | 无         | 完整集成                 |
| 消息队列    | 仅EventBus | Redis Streams+消费者扩展 |
| MCP完整性   | 3/7协议    | 5/7协议                  |

### Phase 2 预估收益

- 可观测性达到生产级标准(TS+Python双向OTel)
- 异步解耦支持多worker扩展
- 为Phase 3水平扩展铺平道路

---

## Phase 3: 分布式与互操作层 (4周)

### 目标

A2A网络层实现 + Kubernetes部署 + API网关

### 任务清单

#### P3-1: A2A网络层实现

**优先级**: 阻塞性
**工作量**: 10天
**负责人**: 后端工程师 + 架构师

**现状**:

- AgentRegistry.ts第843-1218行有~375行A2A类型定义
- A2AProtocolManager有接口但无网络层
- 无HTTP/gRPC/WebSocket传输

**实施步骤**:

1. **设计A2A通信协议**:
   - Agent Card端点: `GET /.well-known/agent.json`
   - Task提交: `POST /api/a2a/tasks`
   - Task查询: `GET /api/a2a/tasks/{taskId}`
   - 推送通知: `POST /api/a2a/push`
2. **实现A2A Protocol Manager (网络层)**:
   - 创建 `python/agent/a2a/protocol_server.py` - A2A HTTP服务器
   - 创建 `python/agent/a2a/agent_card.py` - Agent Card序列化
   - 创建 `python/agent/a2a/task_lifecycle.py` - Task生命周期管理
   - 创建 `python/agent/a2a/push_notification.py` - 推送通知
3. **实现A2A Client**:
   - 创建 `src/a2a/A2AClient.ts` - TS侧A2A客户端
   - 支持HTTP POST作为传输
   - Agent Card发现与缓存
4. **集成到现有OrchestratorAgent**:
   - 修改 `src/harness/orchestration/OrchestratorAgent.ts`
   - 跨Agent任务委派通过A2A发送
   - 任务结果通过A2A回调接收

**验收标准**:

- 可实现跨进程Agent的任务委派
- Agent Card可被发现和解析
- Task Lifecycle支持创建/执行/取消/查询
- 推送通知可回调Sender

#### P3-2: Kubernetes部署配置

**优先级**: 高
**工作量**: 4天
**负责人**: DevOps/架构师

**现状**:

- 有Dockerfile和docker-compose.yml
- 无K8s配置

**实施步骤**:

1. 创建 `deploy/kubernetes/namespace.yaml`
2. 创建 `deploy/kubernetes/deployment.yaml` (TS网关+Python后端)
3. 创建 `deploy/kubernetes/service.yaml` (NodePort/LoadBalancer)
4. 创建 `deploy/kubernetes/ingress.yaml` (HTTPS+域名)
5. 创建 `deploy/kubernetes/configmap.yaml` (环境变量)
6. 创建 `deploy/kubernetes/hpa.yaml` (自动扩缩容)
7. 创建 `deploy/kubernetes/pdb.yaml` (PodDisruptionBudget)
8. 创建 `deploy/kubernetes/prometheus/scrape-config.yaml`
9. 编写Helm Chart(可选,长期维护)

**验收标准**:

- `kubectl apply -f deploy/kubernetes/` 可一键部署
- HPA支持基于CPU/memory/自定义指标扩缩
- Ingress配置TLS终结
- 健康检查存活探针

#### P3-3: API网关(自研统一网关层)

**优先级**: 中
**工作量**: 4天
**负责人**: 后端工程师

**现状**:

- 无统一API网关(Kong/APISIX)
- 鉴权/限流分散在各路由

**实施步骤**:

1. 创建 `src/gateway/Gateway.ts` - 统一网关入口
2. 中间件链: RateLimit → Auth → TraceId → CORS → Logging
3. 鉴权: JWT验证 + API Key + OAuth2
4. 限流: 令牌桶算法(configurable per route)
5. 路由注册: `gateway.registerRoute('/api/a2a/*', a2aRouter)`
6. 统一错误响应格式

**验收标准**:

- 所有API请求经过统一网关
- 鉴权/限流/日志统一管理
- 向后兼容: 现有路由可渐进迁移

#### P3-4: 分布式会话共享

**优先级**: 中
**工作量**: 3天
**负责人**: 后端工程师

**现状**:

- activeTasks是进程内Map
- 多实例部署时无会话共享

**实施步骤**:

1. 利用Phase 1的Redis,创建 `src/shared/DistributedSessionStore.ts`
2. 迁移 `activeTasks` 从Map到Redis Hash
3. 增加会话TTL自动过期
4. 连接中断时会话恢复机制

**验收标准**:

- 多实例部署时共享会话状态
- 会话可跨实例恢复
- Redis不可用时优雅降级

### Phase 3 验收指标

| 指标       | 修复前       | 修复后            |
| ---------- | ------------ | ----------------- |
| A2A协议    | 仅类型定义   | 完整网络层+互操作 |
| K8s部署    | 无           | 完整K8s配置       |
| API网关    | 分散在各路由 | 统一网关          |
| 分布式会话 | 进程内Map    | Redis共享         |

### Phase 3 预估收益

- 具备多实例部署和水平扩展能力
- 可与其他Agent框架互操作(A2A标准)
- 生产级部署和运维

---

## Phase 4: 智能增强层 (3周)

### 目标

学习信号增强 + ToT推理 + 灰度发布机制

### 任务清单

#### P4-1: 多维度学习信号增强

**优先级**: 高
**工作量**: 4天
**负责人**: 后端工程师

**现状**:

- 学习信号稀疏,主要依赖qualityScore单一指标
- EvolutionKnowledgeBase框架在但效果有限

**实施步骤**:

1. 创建 `python/agent/evolution/learning_signal_engine.py`
2. 新增信号维度:
   - 用户满意度(显式反馈+隐式行为)
   - 执行效率(步骤数/耗时对比历史基线)
   - 代码质量(编译通过率/测试覆盖率变化)
   - Token效率(单位产出Token消耗)
3. 修改 `evolution/strategy_adapter.py` - 基于多维信号调整策略
4. 创建 `python/agent/evolution/signal_dashboard.py` - 可视化看板(可选)
5. 信号入库: `TrajectoryDatabase.addLearningSignal()`

**验收标准**:

- 每秒可记录>100个学习信号
- 策略调整基于多维度加权评分
- 信号可回溯和分析

#### P4-2: Tree-of-Thought (ToT) 推理框架

**优先级**: 中
**工作量**: 5天
**负责人**: 后端工程师

**现状**:

- 无ToT/GoT多路径推理框架
- CoT依赖LLM自身能力,无显式编排

**实施步骤**:

1. 创建 `python/agent/core/tot_reasoner.py`
2. 实现ToT核心算法:
   - 状态生成: 对当前状态生成N个可能下一步
   - 状态评估: LLM打分每个状态的前景
   - 搜索: BFS/DFS/MCTS选择最优路径
   - 终止: 达到目标状态或最大深度
3. 集成到Planner: `planner.totReason(task, maxDepth=5, branchingFactor=3)`
4. 创建工具: `tot_reason` 工具供LLM调用

**验收标准**:

- 复杂推理任务成功率提升15%+
- 搜索深度和分支因子可配置
- 与传统ReAct循环可切换

#### P4-3: 灰度发布机制

**优先级**: 中
**工作量**: 3天
**负责人**: DevOps/后端工程师

**现状**:

- 无灰度发布机制
- 策略/提示词/模型更新风险高

**实施步骤**:

1. 创建 `python/agent/core/canary_deployer.py`
2. 支持灰度维度:
   - 提示词版本灰度(金丝雀发布)
   - 模型切换灰度(10%流量新模型)
   - 策略参数灰度(新策略vs旧策略A/B)
3. 灰度路由: `gateway.forwardToCanary(user, percentage=10)`
4. 自动回滚: 灰度成功率<80%自动切回
5. 灰度仪表盘: 实时监控两组指标差异

**验收标准**:

- 提示词/模型/策略可独立灰度
- 灰度期间可实时监控指标
- 失败自动回滚<30s

#### P4-4: LLM动态优先级排序

**优先级**: 低
**工作量**: 2天
**负责人**: 后端工程师

**现状**:

- 优先级排序为静态枚举(CRITICAL/HIGH/NORMAL/LOW)
- 无LLM动态打分

**实施步骤**:

1. 创建 `python/agent/core/dynamic_priority_scorer.py`
2. 输入: 任务描述 + 上下文 + 资源约束
3. 输出: LLM打分(1-10) + 理由
4. 规则约束: 超时任务自动升优先级
5. 集成到TaskDispatcher优先级队列

**验收标准**:

- 优先级打分耗时<2s
- 可回退到静态规则(当LLM不可用时)

### Phase 4 验收指标

| 指标         | 修复前            | 修复后                   |
| ------------ | ----------------- | ------------------------ |
| 学习信号维度 | 1个(qualityScore) | 4+个(多维)               |
| ToT推理      | 无                | 完整框架                 |
| 灰度发布     | 无                | 提示词/模型/策略均可灰度 |
| 优先级       | 静态枚举          | LLM动态打分              |

### Phase 4 预估收益

- 系统自我学习能力显著提升
- 复杂推理任务处理能力增强
- 发布安全性大幅提高

---

## Phase 5: 生产就绪层 (4周)

### 目标

真实用户验证 + 生产流量 + 持续反馈闭环

### 任务清单

#### P5-1: 生产环境部署

**优先级**: 阻塞性
**工作量**: 5天
**负责人**: DevOps

**实施步骤**:

1. 在云服务器(阿里云/AWS)部署K8s集群(最小2节点)
2. 使用Phase 3的K8s配置一键部署
3. 配置CI/CD流水线(GitHub Actions/GitLab CI)
4. 配置监控告警(Prometheus+Grafana+AlertManager)
5. 配置日志聚合(EFK: Elasticsearch+Fluentd+Kibana)

**验收标准**:

- K8s集群稳定运行7天无宕机
- Prometheus指标可抓取
- Grafana看板可访问
- 日志实时聚合

#### P5-2: 真实用户引入与数据收集

**优先级**: 高
**工作量**: 5天
**负责人**: 全团队

**实施步骤**:

1. 邀请10-50名内测用户(内部团队先)
2. 配置用户行为埋点:
   - 任务成功率
   - 平均执行时长
   - 工具使用分布
   - 用户满意度评分
3. 创建badcase回收机制:
   - `/api/reports/badcase` 端点
   - 自动收集失败任务的完整轨迹
   - 分类标注失败原因
4. 每周分析用户反馈,Top3问题优先修复

**验收标准**:

- 日活用户≥10人
- 收集≥100个真实任务数据
- Badcase分类覆盖率80%+

#### P5-3: 持续反馈闭环系统

**优先级**: 高
**工作量**: 5天
**负责人**: 后端工程师

**实施步骤**:

1. 创建 `python/agent/core/feedback_loop.py`
2. 自动化闭环:
   - Badcase自动触发ReflectionEngine深度反思
   - 反思结果写入EvolutionKnowledgeBase
   - EvolutionTrigger基于反馈密度自动触发进化
   - 进化结果自动验证+灰度发布
3. 人工审核节点:
   - 高风险进化操作需人工审批
   - 用户反馈可标记为"重要"触发即时处理
4. 反馈报表: 每周自动生成反馈分析报表

**验收标准**:

- Badcase到反思<1分钟
- 反思到进化策略调整<1小时
- 进化成功率≥60%(Phase 1的验收标准)

#### P5-4: 安全合规审计

**优先级**: 中
**工作量**: 3天
**负责人**: 安全审计师

**实施步骤**:

1. 渗透测试(内部或第三方)
2. 数据安全审查:
   - API密钥轮换机制
   - 用户数据加密(静态+传输)
   - 访问日志审计 trails
3. 合规性检查:
   - GDPR/个人信息保护法 compliance
   - 数据脱敏管道验证(DataSovereigntyPipeline)
4. 生成安全审计报告

**验收标准**:

- 无P0/P1安全漏洞
- 数据脱敏管道100%覆盖
- 审计报告可交付

#### P5-5: 文档与培训

**优先级**: 低
**工作量**: 2天
**负责人**: 全团队

**实施步骤**:

1. 更新架构文档: `ARCHITECTURE.md` 反映最终架构
2. 编写运维手册: 部署/监控/排错指南
3. 编写用户手册: 功能使用说明
4. 团队培训: 新同事Onboarding指南

### Phase 5 验收指标

| 指标     | 修复前     | 修复后       |
| -------- | ---------- | ------------ |
| 部署方式 | 本地Docker | K8s生产集群  |
| 用户规模 | 0          | 10+日活      |
| 反馈闭环 | 手动       | 自动(分钟级) |
| 安全审计 | 无         | 完整报告     |

### Phase 5 预估收益

- 系统达到生产级可用标准
- 形成"用户反馈→自动反思→进化→灰度发布"完整闭环
- 具备规模化运营能力

---

## 风险与缓解

| 风险                    | 影响 | 缓解措施                             |
| ----------------------- | ---- | ------------------------------------ |
| Phase 1延迟影响后续阶段 | 高   | 严格2周工期,不妥协质量               |
| A2A协议复杂性超预期     | 中   | 先实现HTTP POST基础版,gRPC后续       |
| K8s运维成本高           | 中   | 先用Managed K8s(ACK/EKS),后期自建    |
| 真实用户引入速度慢      | 低   | 内部团队先试用,积累100个任务后再对外 |
| 学习信号噪声大          | 中   | 初期只记录高质量信号,逐步放宽        |

---

## 里程碑与交付物

| 时间    | 里程碑      | 关键交付物                                 |
| ------- | ----------- | ------------------------------------------ |
| Week 2  | Phase 1完成 | Python Redis集成+MemoryAssistant主循环集成 |
| Week 5  | Phase 2完成 | MCP HTTP传输+Python OTel+Redis Streams     |
| Week 9  | Phase 3完成 | A2A网络层+K8s部署+API网关                  |
| Week 12 | Phase 4完成 | 学习信号引擎+ToT推理+灰度发布              |
| Week 16 | Phase 5完成 | 生产部署+真实用户+持续反馈闭环             |

---

## 综合评分增长预期

| 阶段      | 基础设施 | 三层架构 | 七大能力 | MCP/A2A | 落地要求 | 综合    |
| --------- | -------- | -------- | -------- | ------- | -------- | ------- |
| 当前      | 5.5      | 6.8      | 5.7      | 5.0     | 4.5      | **5.7** |
| Phase 1后 | 7.0      | 7.5      | 7.0      | 5.0     | 5.0      | **6.9** |
| Phase 2后 | 7.5      | 8.0      | 7.2      | 6.5     | 5.5      | **7.3** |
| Phase 3后 | 8.5      | 8.5      | 7.5      | 8.0     | 6.5      | **8.0** |
| Phase 4后 | 8.5      | 9.0      | 8.5      | 8.0     | 7.0      | **8.4** |
| Phase 5后 | 9.0      | 9.0      | 8.5      | 9.0     | 8.5      | **8.8** |

**目标**: 16周从5.7/10提升到8.8/10,达到生产级Agent标准。

---

## Agent分工建议

| Agent角色          | 负责Phase                       | 预计投入 |
| ------------------ | ------------------------------- | -------- |
| **架构师 Agent**   | Phase 3 (A2A设计/K8s架构)       | 20%      |
| **核心开发 Agent** | Phase 1+2 (记忆/OTel/MQ)        | 40%      |
| **记忆系统 Agent** | Phase 1 (MemoryAssistant/Redis) | 20%      |
| **进化引擎 Agent** | Phase 4 (学习信号/ToT)          | 15%      |
| **代码审计 Agent** | 全程质量把关                    | 5%       |
| **测试验证 Agent** | 每阶段验收测试                  | 10%      |
| **DevOps Agent**   | Phase 3+5 (K8s/部署)            | 15%      |

---

**文档版本**: v1.0
**生成日期**: 2026-07-04
**下次更新**: Phase 1完成后
