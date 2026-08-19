# 家百星项目长期记忆

## 架构总览
- 混合架构: TS 薄网关(Express :3111, ~350 .ts) + Python FastAPI 真后端。默认端口 3112; docker-compose 与 K8s configmap 经 `AGENT_PORT=8765` 覆盖为 8765(与 Service/PYTHON_AGENT_URL 对齐)。`AGENT_BACKEND=python` 默认激活, Python 不可用时安全降级 TS 本地。
- AGENTS.md §0.1 强制: Agent 核心(LLM/记忆/Loop/进化/MCP/A2A/Redis/OTel/会话/轨迹)主实现必须在 Python; TS 仅做 UI/桌面自动化/HTTP-WS 入口/bridge 壳。仅 TS 实现不计入"已完成"。

## 枢纽迁移(2026-07, 全部完成)
- MCP/记忆/LLM/Loop/进化/A2A/SessionStore/TrajectoryDatabase/OTel SDK 的 TS 实现已收口为 bridge 壳(re-export + @deprecated), 真实逻辑在 Python。
- 探针 `scripts/doc-derived-audit.mjs` → 37 PASS / 0 FAIL(接入 CI 红线, 有 FAIL 即 exit 1)。

## 能力对齐(Hermes 0.18.0, 2026-07-17/18 完成)
- 4 张卡 R1-A/R1-B/R2/R3 全落地且 Python 主实现+测试+env 激活:
  - R1-A 运行时安全姿态 `security/runtime_posture.py`(SAFE/CONFIRM/AUTO/YOLO, critical 永不放行)
  - R1-B 插件信任 `plugins/trust.py`(TrustLevel 复用, 新插件默认 UNTRUSTED)
  - R2 工具集概率分发 `tools/toolset_sampling.py`(ToolsetSampler)
  - R3 Provider 目录 `llm/provider_catalog.py`(15 家+OAuth)+窄腰 `catalog.py`; CI 守卫 `check-core-tool-schema.mjs`
- 诚实遗留: ① R1/R1-B 的 HTTP/桌面管理面未做; ② 采样结果未喂 EvolutionEngine; ③ Vertex/Bedrock 仅凭据获取, OAuth 授权码流转未做。

## 测试状态与盲区
- Python pytest ~1479 通过; TS jest 部分恒真/预存失败(comprehensive-coverage 9 失败且慢)。
- CI 护栏 `check-no-tautology-tests.mjs` 已拦恒真断言。
- 前端/网关"假绿"盲区已部分补: WS 去重契约测试 + DesktopDashboard 聊天契约测试。活聊天路径=DesktopDashboard(HTTP-only, 不订阅 WS stream), ChatInterface 为死代码。

## P0/P1 生产硬核差距(2026-07-18 已收口)
- 来源审计: `docs/Agent_Technical_Maturity_Audit_2026-07-18.md`(综合≈4.3/5, 86%); 落地要求短板 3.0。
- 🔴 P0 分布式锁: `python/agent/infrastructure/distributed_lock.py`(RedisLock SET NX PX + Lua 释放 + 自动续期; LocalLock 模块级 registry 兜底; `create_lock`/`LockManager` 工厂, REDIS_ENABLED 切换)。cron 调度锁 `cron:sched:{id}` + 执行锁 `cron:exec:{id}` 已接入 `scheduler/cron.py`。
- 🟡 P0 消息队列主干: `message_queue.py` 根因修复——此前 Redis 路径仅 XADD(只写不读), 补全 `_redis_worker`(XREADGROUP 消费者组循环) + `_handle_redis`(XACK/重投/死信, 且修复 re-XADD 误将 max_retries 写成 retry_count 的 bug)。`MQ_ENABLED` 激活后多副本真正解耦。
- 🟡 P1 商用闭环证据: `slo_collector.py`(成功率+P95, 有界样本, 线程安全) + `api/slo.py`(`/v1/health/slo`) + `main.py` MetricsMiddleware 喂数据; `scripts/verify_production_readiness.py`(红/黄/绿核查 + `--traffic N` 真实流量最后一公里门禁) + `docs/PRODUCTION_READINESS_RUNBOOK.md`。
- **SLO 生产态两处真实 bug(2026-07-18 最后一公里验证中发现并修复)**: ① `MetricsMiddleware` 误调 `record(duration_ms=...)`, 收集器形参实为 `latency_ms` → `TypeError` 被 `except:pass` 静默吞掉, SLO 长期记 0; 改为 `record(latency_ms=...)` 且异常改 `log.warning`。 ② `ApiGatewayMiddleware`(限流) 原在最外层, 其直发 `429` 绕过 `MetricsMiddleware` 导致限流/鉴权错误不进 SLO; 重排为 `CORS(最外)→Metrics→ApiGateway(最内)`, 现 429 也被记录。修复后真实流量 100 次 → SLO 记录样本=133, 成功率 1.0, P95≈2.4ms, 状态 ok(绿灯)。
- 水平扩展(残留已收口): `infrastructure/sharding.py`(一致性哈希 `consistent_shard` + `get_shard_count`/`get_replica_index`/`this_replica_owns` + `LeaderElection` 基于分布式锁); `scheduler/cron.py` 接入 `LeaderElection`(仅 leader 跑 `_tick_loop`, 失锁即停; 全副本订阅 MQ 执行 job) + `_save()` 线程写锁; `evolution/multi_agent.py` 切到 `create_message_queue()`(本地即时投递 + 跨副本 Redis Streams + 跳自身回声)。`docs/PRODUCTION_READINESS_RUNBOOK.md` §6 新增水平扩展章。
- 测试: 新增 `test_distributed_lock.py`/`test_message_queue_redis_consumer.py`/`test_slo_endpoint.py`/`test_sharding.py`/`test_multi_agent_mq.py`/`test_cron_leader.py`(39 通过/2 Redis 跳过); 恒真护栏通过; 现有 `test_message_queue.py` 未回归。
- K8s: configmap 补 `MQ_ENABLED=true` + `AGENT_PORT=8765`(修端口错位) + `AGENT_REPLICAS='2'` + `SHARD_COUNT='2'` + `REDIS_ENABLED='true'`/REDIS_URL; 锁/MQ 在 K8s 即转绿。

## 真实差距(残留)
- Python 侧: Redis 业务使用现仅锁/MQ/SLO 三处。OTel 仅 Python 端 `otel_setup.py`(TS 已移除 NodeSDK, 改为 traceId 透传壳)。
- K8s `deploy/kubernetes/` 18 配置完整, 但 Redis/OTelCollector **运行态**是否真启用待验证(本开发机无 Redis/Docker, verify 脚本锁/MQ 项在本机为红, 属部署前置而非代码缺陷; K8s 同 namespace Redis 可达即绿)。
- 生产模拟 `tests/production_simulation/` 6/6 组件可接受, 负载 88% 成功率。
- jobs.json 仍为单文件共享(已加线程写锁 + 仅 leader 写, 缓解未根治); 彻底消除竞态建议迁 Redis/SQLite。
- **网关包生产态真实缺陷(2026-07-18 已修复, 分两轮)**: ① `MessageDispatcher` 在 `engine.py:3214` 引擎初始化时被实例化, 其 `__init__` 调 `set_send_function(self._mirror_send)` 但类内无 `_mirror_send`(`AttributeError` 致引擎初始化即崩) → 补 `_mirror_send(target_chat, content)`(按 `platform#chat` 路由同名适配器)。② `platform_manager.py:114` 被注入垃圾字符 `xi` → `IndentationError`。③ `relay_adapter.py` 用 `@dataclass` 却缺 `from dataclasses import dataclass` → `NameError`。④ `platform_manager.py` `get_status`/`get_all_statuses` 调 `is_connected()` 未 `await`(ABC 声明 `async`), 致 `status.connected` 被赋为协程而非布尔(连接状态上报失真) → 改 `async`+`await`。⑤ `relay_adapter.py` `send_message` 模拟模式(`_ws is None`)返回 `True` 却不计入 `sent` 统计 → 修正计数。①②③ 位于引擎 lazy-init 子系统(`critical=False`, 失败静默失效)。修复后 `agent` 包 **282 模块导入 0 缺陷**。
- **全包导入扫描 CI 红线(2026-07-18 第三轮, 新增)**: `python/scripts/check_import_scan.py` 同时做①全 `agent.*` 导入扫描(抓 SyntaxError/IndentationError/NameError/AttributeError/本地包缺失)②对引擎启动必构造子系统(`MessageDispatcher`/`PlatformManager`/`RelayAdapter`)无参实例化(抓实例化期 `AttributeError`, 纯导入扫不到)。发现代码缺陷即 `exit 1`。已接入 `.github/workflows/backend-ci-cd.yml` 的 `python-test` job。⚠️ **前提**: `python/agent/gateway/` 整包与 `tests/test_gateway.py` 目前在本机 `git status` 为 **untracked**, 必须先 `git add`/提交, 该 CI 步骤在仓库中才能找到 `agent.gateway`(否则会因找不到关键子系统模块而阻断)。
- **网关单测盲区填补(2026-07-18 第三轮)**: `tests/test_gateway.py` 新增 `TestPlatformManager`(注册/启动/发送/广播/状态聚合/错误计数) + `TestRelayAdapter`(模拟模式/编解码往返/统计结构) 共 26 例, 使此前零覆盖的两子系统有测试守护; 该套件现 **59/59 通过**。全量 pytest 仍有 48 例失败, 但**全部位于无关模块**(database/loop/multimodal/otel/p0_migration/verification_constraints/credential_cost/shell/sandbox/phase7/phase_b_e2e/result_aggregator/error_classifier), 且无一 import 网关模块, 属预存失败, 非本次引入。

## 关键配置
- 超时: TOOL_TIMEOUT=30s, LLM_TIMEOUT=60s, AGENT_GLOBAL_TIMEOUT_SEC=300s。
- .gitignore: `/*.py` 仅限根目录, python/ 正常跟踪。
- Python 测试: `cd python && python -m pytest tests/ -q`。

## 功能审计与 P0/P1/P2 路线图(2026-08-11 起)
- 依据 `jiabaixing_functional_audit_2026-08-11.html`(五维审计: LLM 底座/编排调度/感知五感/执行层/差异化能力), 制定 P0(安全可靠性,1周)/P1(一致性闭环,2-4周)/P2(差异化增强,1-2月) 三阶段路线图, 用户已两次确认"按计划执行"。
- **P0 全部完成(2026-08-11/12 验证)**:
  - P0-1 ASR 注入: `src/multimodal/SpeechRecognizer.ts` 由 `execSync` 字符串拼接改为 `execFileSync` + argv 数组(无 shell), 新增 `validateWhisperInputs` 白名单(模型名/语言/临时路径); 安全单测 `tests/unit/multimodal/SpeechRecognizer.security.test.ts`(6 例, jest 本地因 node_modules 损坏无法跑, 已用 tsc 转译+Module._load 桩做真实源码运行时验证)。
  - P0-2 failover: `agent/llm/router.py`(`get_fallback` 排除失败集合 + `fallback_chain`)/`provider.py`(多 provider 退避重试 + jitter + 显式 timeout + transport 降级); `tests/test_llm_failover.py`(4 例) 通过。
  - P0-3 静默异常红线: 16 文件 33 处 `except:pass` → `log_ignored`(基线收 0); 另补修 11 处 `except:continue` 静默吞; `python/pyproject.toml` 加 `[tool.ruff.lint] select=["E722","S112"]`, `backend-ci-cd.yml` python-test job 加 ruff 门禁; ratchet `check_silent_except.py`=0, `test_p2_1_silent_except`=12/12, ruff agent/ 干净。
- **P1 状态**: P1-1 完成; P1-2 完成; **P1-3 完成**(真实听觉: voice_interact.listen 接 SpeechRecognizer 真实ASR+感知总线 voice_recognized; SpeechSynthesizer TTS 后端切换); **P1-4 进行中**(优先级调度 优先级堆+RWLock+虚拟节点, Python message_queue/distributed_lock/sharding); P1-5 待办(ReAct 关键路径补测, 覆盖率≥70%)。
- **P2 待办**: P2-1 embedding 语义缓存; P2-2 感知数据源插件化; P2-3 Skill 中间件层; P2-4 窄腰 catalog+死代码清理; P2-5 进化/记忆深度增强+otel 协程修复。

## TS 工具链环境须知(重要)
- **本机 `node_modules` 已损坏**: `node_modules/.bin` 为空、jest/esbuild/tsx 入口缺失(`npx jest` 联网拉取也 EPERM 失败)。**无法跑 jest/tsx**。
- 验证 TS 改动的可用手段: ① `node_modules/typescript/bin/tsc`(5.9.3 可用) 转译 CJS + `Module._load` 钩子注入桩做真实源码运行时验证; ② 静态核查(grep 注入面); ③ 若需跑测试, 需先 `npm ci` 修复依赖(可能需联网)。
- Python 侧: `ruff` 0.16.1 与 `pytest` 9.1.1 可用(`C:/Users/Administrator/.workbuddy/binaries/...` 隔离运行时)。

## 常用文档
- 成熟度审计: `docs/Agent_Technical_Maturity_Audit_2026-07-18.md`; 生产就绪: `docs/PRODUCTION_READINESS_RUNBOOK.md`
- 旧差距报告: `docs/Agent_Technical_System_Gap_Report_2026-07-03.md`, `docs/Gap_Closure_Phase_Plan_2026-07-04.md`, `docs/adr/ADR-001-llm-hub-migration.md`
- Agent 效能评估: `python/scripts/analyze_agent_efficiency.py`; 生产核查: `python/scripts/verify_production_readiness.py`
