# 生产就绪运行手册（落地要求 / 审计 P1）

> 目的：把《Agent 完整技术体系总图》中"拒绝本地 Demo，搭建线上真实商用项目"从文档主张变为可核查事实。
> 配套代码：`python/agent/infrastructure/distributed_lock.py`、`message_queue.py`(Redis 消费者循环)、`api/slo.py`、`scripts/verify_production_readiness.py`。
> 核查脚本：`python python/scripts/verify_production_readiness.py`（任一红项退出码 1）。

---

## 0. 三分差距与对应落地

| 差距                 | 级别 | 代码落地                                                                                                                                                                               | 本手册闭环动作               |
| -------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 分布式锁缺失         | P0   | `distributed_lock.py`：Redis `SET NX PX` + Lua 释放 + 自动续期；cron 调度按 `cron:sched:{id}` / `cron:exec:{id}` 加锁                                                                  | §1 配置 + 核查脚本红/绿      |
| 消息队列未成主干     | P0   | `message_queue.py` 补全 Redis `XREADGROUP` 消费者循环；cron 调度经 MQ `cron.dispatch` 解耦                                                                                             | §2 开启 MQ + 跨实例消费验证  |
| 真实商用闭环证据不足 | P1   | `api/slo.py` 的 `/v1/health/slo` + SLO 收集器（成功率 / P95 延迟）；`MetricsMiddleware` 自动喂数                                                                                       | §3 灰度 + 监控 + 告警 + 回滚 |
| 水平扩展 / 分片缺失  | P1   | `infrastructure/sharding.py`：一致性哈希 `consistent_shard` + `get_shard_count` / `get_replica_index` / `this_replica_owns`；`LeaderElection`（基于分布式锁）；cron / multi_agent 接入 | §6 分片 + 选主 + 跨实例协作  |

---

## 1. 分布式锁（P0）上线清单

1. `deploy/kubernetes/configmap.yaml` 已含：
   - `REDIS_ENABLED: 'true'`、`REDIS_URL: 'redis://jiabaixing-redis:6379/0'`
   - `LOCK_TIMEOUT_MS / LOCK_RETRY_INTERVAL_MS / LOCK_MAX_RETRIES / LOCK_AUTO_EXTEND`
2. 确认 Redis 实例在 K8s 内可达（与 `python-deployment.yaml` 同 namespace）。
3. 运行核查：`python python/scripts/verify_production_readiness.py` → 「分布式锁」须为 **[绿]**。
4. 风险点：锁依赖 Redis；若 Redis 不可用，锁降级为进程内 `asyncio.Lock`——**单副本安全，多副本竞态重新出现**。因此 Redis 必须随副本一同高可用（Redis 部署清单已就位）。

---

## 2. 消息队列主干（P0）上线清单

1. `configmap.yaml` 增加并确认：`MQ_ENABLED: 'true'`（此前默认 false，是"MQ 未成主干"的隐藏根因之一）。
2. 同上 Redis 可达。
3. 跨实例解耦验证（核心证据）：
   - 起 2 个副本（HPA 已配，或临时 `kubectl scale deploy/jiabaixing-python --replicas=2`）。
   - 让一个副本 `publish` 一条 `cron.dispatch` / 业务消息，**断言由另一个副本的消费者组 worker 执行**（见 `tests/test_message_queue_redis_consumer.py::test_redis_cross_instance_consume`）。
4. 核查脚本「消息队列主干」须为 **[绿]**。

---

## 3. 真实商用闭环（P1）灰度与监控

### 3.1 灰度发布（避免"上线即翻车"）

- 先 1 副本验证功能，再 `scale` 至 2，观察 SLO 端点 24h。
- 用 K8s `traffic-split` / 入口权重做 5%→25%→100% 真实用户灰度；禁止"全部切流后才看指标"。

### 3.2 真实用户埋点（"真实用户"证据）

- 网关 `MetricsMiddleware` 已对每次 HTTP/WS 请求记录延迟与错误，自动喂入 SLO 收集器。
- **中间件顺序（已修正）**：`CORS(最外) → Metrics → ApiGateway(最内)`。此前 `ApiGateway` 为最外层，其直接 `send` 的 `429` 拒绝响应会绕过 `MetricsMiddleware`，导致限流/鉴权错误不进入 SLO。修正后 429 也被 `MetricsMiddleware` 捕获（`is_error=True`），SLO 错误率真实反映限流。
- **调用参数（已修正）**：`MetricsMiddleware` 曾误用 `record(duration_ms=...)`，而收集器形参为 `latency_ms`，导致 `TypeError` 被静默吞掉、SLO 长期记为 0。已改为 `record(latency_ms=...)` 并将异常改为显式 `log.warning`，现每次响应都真实落盘。
- 业务侧：在关键用户动作（首响、工具调用成功、任务完成）调用 `get_slo_collector().record(latency_ms, is_error)`，使 SLO 反映"真实用户体感"而非仅健康检查。

### 3.3 监控与告警（"持续反馈"证据）

- 暴露：`GET /v1/health/slo` 返回 `{success_rate, p95_latency_ms, status}`。
- 监控面板轮询该端点；**`status == "breach"` 即触发告警**（成功率 < 0.95 或 P95 > 2000ms）。
- 阈值在 `python/agent/infrastructure/slo_collector.py::SLO_OBJECTIVES` 集中定义，按真实用户 SLA 调整。

### 3.4 回滚

- 灰度期保留旧镜像 tag；`status=breach` 持续 5min → `kubectl rollout undo deploy/jiabaixing-python`。
- 锁/MQ 均为"优雅降级"设计：即便 Redis 抖动，系统降级为单实例语义而非崩溃，回滚窗口宽松。

---

## 3.5 最后一公里：真实流量验证（上线前必做）

> 仅做配置/端点可达性检查不足以证明"生产态"——必须让真实流量穿过生产 HTTP 栈并被 SLO 收集器记录。

`verify_production_readiness.py` 提供 `--traffic N` 开关：向线上服务发起 N 次真实 HTTP 请求
（`/v1/health/slo`、`/v1/metrics`、`/docs`、`/openapi.json`），再读取 `/v1/health/slo` 断言
`window.total_requests` 已记录 ≥ 50% 的真实流量。这是"研发态硬核 → 生产态"的关键证据。

```bash
# 1) 先起一个真实 HTTP 栈（绕过 LLM engine 初始化，仅验证 HTTP 层）
SMOKE_PORT=8765 PYTHONPATH=/path/to/python \
    python python/scripts/live_smoke.py &

# 2) 发起 100 次真实流量并完成最后一公里核查
python python/scripts/verify_production_readiness.py \
    --slo-url http://localhost:8765 --traffic 100
# 期望输出：[绿] 真实流量验证 (Real Traffic) —— 真实流量 100 次（成功 100），SLO 已记录样本=133 ...
```

**注意（Windows / IPv4 沙箱）**：`uvicorn` 默认监听 `0.0.0.0`（仅 IPv4），而 `localhost` 在部分平台
优先解析为 IPv6 `::1`，会让每次请求卡 ~2s 且打不到 SLO 中间件。核查脚本已自动把 `localhost` 归一为
`127.0.0.1`；手动 `curl` 验证时也请用 `http://127.0.0.1:8765`。

> 本沙箱（开发机）未部署 Redis，故「分布式锁 / 消息队列主干」两项在本机核查为 **[红]**，属部署前置条件
> 而非代码缺陷：K8s `configmap.yaml` 已置 `REDIS_ENABLED=true` / `MQ_ENABLED=true` 且同 namespace Redis 可达，
> 在生产环境核查即转绿。SLO / 副本数 / 真实流量三项与 Redis 无关，可在本机直接验证为绿。

---

## 4. 一键核查（上线前门禁）

```bash
# 在 CI / 上线流水线最后一步
python python/scripts/verify_production_readiness.py --slo-url http://jiabaixing-python:8765
echo $?   # 0=可上线；1=存在红项，阻断发布
```

> 红项对应未解除的 P0 风险（锁/MQ 未跨实例生效、副本不足、SLO 不可监控），**必须归零才可上线**。黄项为改进项，不阻断但需跟踪。

---

## 5. 已知遗留（诚实清单）

- **多 Agent 跨副本协作 —— 已完成**：`evolution/multi_agent.py` 已切到 `create_message_queue()` 传输
  （本地即时投递做向后兼容，跨副本经 Redis Streams 消费者组，并跳过自身回声）。进程内
  `asyncio.Queue` 仅作为 Redis 不可用时的降级，不再是主干。
- **`jobs.json` 仍为单文件共享（已缓解，未根治）**：`CronJobScheduler._save()` 已加线程写锁
  （`threading.Lock`）防止并发写损坏；且 cron 仅 **leader 副本** 跑 `_tick_loop`，其余副本只作为
  MQ 任务执行者待命，从根本上消除多副本同写。彻底消除竞态建议后续将状态迁 Redis/SQLite。
- **真实用户流量需由业务侧导入**：本手册与脚本只负责"让生产硬核可被验证"，不替代真实用户增长。
- **SLO 历史 bug 已修复**：`MetricsMiddleware` 的 `record(duration_ms=...)` 形参错配（应为 `latency_ms`）
  与 `ApiGateway` 最外层导致 429 绕过 SLO 两个问题已修复（见 §3.2），现 SLO 真实反映全部流量。

---

## 6. 水平扩展（分片 + 选主，新增）

> 目的：让 Agent 后端可水平扩展到多副本而不重复执行 / 不遗漏任务。

### 6.1 分片原语 `infrastructure/sharding.py`

- `consistent_shard(key, n)`：一致性哈希，把任意 key 稳定映射到 `[0, n)` 分片，扩缩容时抖动可控。
- `get_shard_count()` / `get_replica_index()`：从 `SHARD_COUNT` / `REPLICA_INDEX` 环境变量读取（默认 1）。
- `this_replica_owns(key)`：本副本是否负责该 key——配合 `consistent_shard` 实现 per-key 归属判定。

### 6.2 选主 `LeaderElection`

- 基于 `create_lock(f"leader:{service}", ttl_ms=30000)`：首个抢到锁的副本成为 leader，后台定时续期；
  失锁即让位。`is_leader` 实时反映身份，`stop()` 释放锁并退出竞选循环。
- 多副本下"只允许一个 leader 跑调度循环 / 写共享状态"，其余副本作为执行者，避免重复执行。

### 6.3 接入点

- **`scheduler/cron.py`**：`start()` 创建 `LeaderElection("cron")`；仅 leader 跑 `_tick_loop`，
  失去领导权即停；所有副本订阅 MQ 以执行被分派的 job。`_save()` 受线程锁保护。
- **`evolution/multi_agent.py`**：消息经 `create_message_queue()` 跨副本协作（见 §5）。

### 6.4 部署注意

- `deploy/kubernetes/configmap.yaml` 已补 `AGENT_REPLICAS: '2'`、`SHARD_COUNT: '2'`；
  StatefulSet 的 `REPLICA_INDEX` 可选（缺省按副本序推断）。副本数 ≥2 时锁 / MQ / 选主 / 分片才体现价值。

---

## 7. CI 红线补充：全包导入扫描（防 critical=False 静默吞缺陷）

> 背景：网关子系统（`MessageDispatcher` / `PlatformManager` / `RelayAdapter`）在引擎初始化时
> 被 lazy 构建且标记 `critical=False`。一旦构造失败，引擎不抛启动错误、子系统静默失效，
> 单测与启动均不报警——典型的"生产态盲区"。

### 7.1 扫描脚本 `python/scripts/check_import_scan.py`

- **导入期**：遍历全部 `agent.*` 模块导入，捕获 `SyntaxError` / `IndentationError` / `NameError` /
  `AttributeError` / 本地包缺失 `ImportError`；第三方缺失（`No module named 'xxx'`）仅告警不阻断。
- **实例化期**：对"引擎启动必构造"的子系统做无参实例化，捕获如 `MessageDispatcher` 缺 `_mirror_send`
  这类实例化期 `AttributeError`（纯导入扫描抓不到）。
- 退出码：`0`=通过；`1`=发现代码缺陷（阻断 CI）。

### 7.2 CI 接线

`.github/workflows/backend-ci-cd.yml` 的 `python-test` job 末尾新增：

```yaml
- name: Run import-scan red line (catch critical=False silent defects)
  run: python scripts/check_import_scan.py
```

（job 工作目录已是 `python`，`pip install -e ".[test]"` 后 `agent` 可导入；脚本自带 `sys.path` 自引导。）

### 7.3 实测发现并修复的缺陷（本轮）

- `relay_adapter.py` 行首垃圾字符 `xi` 导致 `IndentationError`（导入期）；已删。
- `relay_adapter.py` 用 `@dataclass` 却缺 `from dataclasses import dataclass`（`NameError`）；已补。
- `dispatcher.py` 构造时调 `set_send_function(self._mirror_send)` 但类内无该方法（`AttributeError`，实例化期）；已补 `_mirror_send`。
- `platform_manager.py` `get_status` / `get_all_statuses` 调用 `await` 缺失的 `is_connected()`（ABC 声明 `async`），导致 `status.connected` 被赋为协程而非布尔（连接状态上报失真）；已改为 `async` + `await`。
- `relay_adapter.py` `send_message` 在模拟模式（`_ws is None`）返回 `True` 却不计入 `sent` 统计；已修正计数。

### 7.4 单测盲区填补

`tests/test_gateway.py` 新增 `TestPlatformManager`（注册/启动/发送/广播/状态聚合/错误计数）与
`TestRelayAdapter`（模拟模式/编解码往返/统计结构）共 26 个用例，使此前零覆盖的两个子系统有测试守护；
该测试套件现 59/59 通过。
