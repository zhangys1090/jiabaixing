# 家百星 vs Hermes — 节点差距分析与新增节点建议

> **目的**：以 Hermes Agent v0.18.0 节点全景为基准，识别家百星在**用户实用性**与**功能性**上的差距，列出应新增/增强的节点清单与优先级路线图。
> **基准**：用户提供的 Hermes v0.18.0 审计　**对象**：`C:\zy\jiabaixing`（V5.0 混合架构）
> **日期**：2026-07-10

---

## 一、对比方法论

- 将 Hermes 的 30 个节点（14 功能 + 8 使用性 + 分发层）逐条映射到家百星实测代码。
- 状态判定：🟢 对齐/更强　🟡 部分对齐　🔴 缺失　⚫ 弃用/绕过
- 聚焦两类增加值：**(A) 用户实用性节点**（让更多用户、更多场景能触达系统）；**(B) 功能性节点**（让系统能力更完整、更可靠）。

---

## 二、节点对齐矩阵（Hermes → 家百星）

| Hermes 节点                      | 家百星对应                                                                       | 状态      | 说明                             |
| -------------------------------- | -------------------------------------------------------------------------------- | --------- | -------------------------------- |
| 1. AIAgent 核心运行时            | `loop/controller.py` (ReAct)                                                     | 🟢 更强   | 六层 E-T-C-S-L-V 分离            |
| 2. run_conversation              | `loop/controller.py` 对话循环                                                    | 🟢        | —                                |
| 3. init_agent 装配               | `src/main.ts:bootstrap` + Python app 装配                                        | 🟢        | —                                |
| 4. Provider 抽象                 | `llm/provider.py` + `router.py`                                                  | 🟢        | litellm 动态，比 27 硬编码更灵活 |
| 5. 厂商适配器                    | litellm 统一适配                                                                 | 🟢        | 不同实现但覆盖                   |
| 6. **MoAClient 多模型聚合**      | 仅 fallback 链                                                                   | 🔴        | **建议新增**                     |
| 7. MemoryManager 对话记忆        | `memory/engine.py`                                                               | 🟢        | —                                |
| 8. MemoryProvider 长期后端       | SQLite+FTS5+向量                                                                 | 🟢        | 外部适配器弱于 Hermes            |
| 9. 学习图/SkillNode              | evolution skill_engine + curator                                                 | 🟡        | 无显式 learning_graph            |
| 10. Skills 系统                  | Python 仅 registry；TS curator 被绕过                                            | 🟡        | **建议增强**                     |
| 11. **optional-skills 预置目录** | 无                                                                               | 🔴        | **建议新增**                     |
| 12. Plugins 系统                 | base + manager（通用）                                                           | 🟡        | 缺多 kind 扩展                   |
| 13. 工具定义/执行                | `tools/*`（30+ 工具）                                                            | 🟢 更强   | —                                |
| 14. Toolsets 分发                | `toolset_registry.py`                                                            | 🟢        | —                                |
| 15. 子 Agent 委派                | SubAgentDelegator + MultiAgentOrchestrator                                       | 🟢 更强   | 3 种 fanout 策略                 |
| 16. Cron 调度                    | `scheduler/cron.py`                                                              | 🟢        | 含 lifecycle 待确认              |
| 17. 上下文压缩                   | `context_compressor.py`(948行)                                                   | 🟢 更强   | —                                |
| 18. 状态/日志/配置               | logger/session_store/trajectory                                                  | 🟢        | —                                |
| 19. 桌面 App                     | Electron + 桌面自动化                                                            | 🟢 更强   | 独有                             |
| 20. Web Dashboard                | React build 托管                                                                 | 🟢        | 管理组件较弱                     |
| 21. 文档站                       | `docs/`（非 Docusaurus）                                                         | 🟡        | **建议增强**                     |
| 22. CLI 命令树                   | 20+ 子命令 + Python CLI                                                          | 🟢 更丰富 | —                                |
| 23. setup/auth 流程              | `config/setup.ts` + `.env`                                                       | 🟡        | 缺统一 OAuth 向导                |
| 24. Gateway 通道                 | 8 平台（TS）                                                                     | 🟡        | **缺 email/WhatsApp**            |
| 25. Gateway 编排                 | IntegrationManager                                                               | 🟢        | —                                |
| 26. **TUI 终端界面**             | 无                                                                               | 🔴        | **建议新增（高优先级）**         |
| 27. ACP(IDE)                     | ACPServer + stdio + bridge                                                       | 🟢        | —                                |
| 28. MCP Serve                    | Python 完整(stdio+SSE)                                                           | 🟢 更强   | —                                |
| 29. Providers 目录(27)           | litellm 动态注册表                                                               | 🟢 等效   | —                                |
| 30. 安全/权限                    | SecurityGuard+OutputGuardrail+Permission+Approval+CredentialPool+CostGuard+Hooks | 🟢 更强   | 含成本护栏                       |

**额外维度（Hermes 无 / 家百星独有）**
| 维度 | 家百星状态 | 说明 |
| --- | --- | --- |
| Evolution 代码自修改 | 🟢 独有优势 | Hermes 仅能创建技能 |
| OpenTelemetry 追踪 | 🔴 缺失 | 此前审计已确认 Python 侧无 OTel |
| 桌面自动化 | 🟢 独有优势 | 截图/UI 检测/输入模拟 |
| 中文优先 | 🟢 优势 | 中文分词/中文 TTS |

---

## 三、家百星相对 Hermes 的优势（务必保留）

1. **六层 Harness 独立开关** — E-T-C-S-L-V 每层可独立启用，比 Hermes 单层 `AIAgent._run()` 更清晰。
2. **Evolution / 代码自修改** — Hermes 只能创建技能，家百星能修改自身代码（v2_engine）。
3. **桌面自动化引擎** — 屏幕截图、UI 检测、输入模拟（Hermes 无）。
4. **SubAgent fanout 三策略** — parallel/sequential/**adaptive**，比 Hermes 固定并发更强。
5. **统一 HookManager** — 比 Hermes 分散钩子更一致。
6. **中文优先** — 中文分词、中文 TTS 优化。
7. **8 个 IM 平台适配器** — 微信/企业微信/钉钉/飞书/QQ/Slack/Telegram/Discord（Hermes 部分靠插件）。

---

## 四、待新增 / 增强节点清单（核心交付）

> **(A) 用户实用性** = 让更多用户/场景触达系统　**(B) 功能性** = 让能力更完整可靠
> **优先级**：P0 前置修复/高价值 → P1 功能性增强 → P2 完整性补齐

| 编号     | 新增节点                                       | 类别   | 参考 Hermes 位置                                               | 家百星现状                                      | 对用户/系统的价值                                    | 优先级 | 工作量 |
| -------- | ---------------------------------------------- | ------ | -------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- | ------ | ------ |
| **P0-1** | **默认激活 Python 后端**                       | A+修复 | —                                                              | `AGENT_BACKEND` 未默认设置，严格 `=== 'python'` | 消除"开箱跑残缺旧实现"的隐性故障，是新用户第一道门槛 | **P0** | 0.5 天 |
| **P0-2** | **TUI 终端界面**                               | A      | `tui_gateway/` + `ui-tui/`                                     | 完全缺失（仅 readline REPL）                    | 覆盖非桌面/非 IDE 的终端重度用户，降低使用门槛       | **P0** | 3–5 天 |
| **P1-1** | **Skills Hub 同步 + optional-skills 预置目录** | A+B    | `tools/skills_hub.py`、`optional-skills/`                      | Python 仅 registry；TS curator 被绕过           | 开箱即得可用技能生态，减少自建成本                   | P1     | 3–4 天 |
| **P1-2** | **OpenTelemetry 追踪**                         | B      | `plugins/observability`                                        | 此前审计确认 Python 侧无 OTel                   | 生产可观测性、延迟/错误归因、对标企业级              | P1     | 2–3 天 |
| **P1-3** | **Plugin kinds 扩展**                          | B      | `plugins/`（browser/kanban/observability/image_gen/video_gen） | 仅通用 base+manager                             | 复用社区插件生态，扩展能力边界                       | P1     | 4–6 天 |
| **P1-4** | **MoA 多模型聚合**                             | B      | `agent/moa_loop.py`                                            | 仅 fallback 链                                  | 多模型投票/聚合提升复杂任务质量                      | P1     | 2–3 天 |
| **P2-1** | **Email + WhatsApp 网关适配器**                | A      | `plugins/platforms/email`、`whatsapp`                          | 8 平台，缺 email/WhatsApp                       | 补齐企业/海外触达面                                  | P2     | 2–3 天 |
| **P2-2** | **MCP 精选目录 (optional-mcps)**               | A+B    | `optional-mcps/`（linear/n8n/…）                               | 仅 MCP Serve，无精选目录                        | 一键接入第三方 MCP，降低集成成本                     | P2     | 2 天   |
| **P2-3** | **流式上下文脱敏 (StreamingContextScrubber)**  | B      | `agent/memory_manager.py`                                      | 有 sensitive_detector 但非流式脱敏              | 流式输出中的密钥/PII 实时遮蔽，提升安全              | P2     | 1–2 天 |
| **P2-4** | **学习图 (Learning Graph)**                    | B      | `agent/learning_graph.py`                                      | evolution skill_engine 近似                     | 技能/记忆节点关系显式化，支撑长期演化                | P2     | 2–3 天 |
| **P2-5** | **统一首次运行向导（含 OAuth/多 Profile）**    | A      | `hermes setup --nous`、`login`                                 | 仅 LLM 部分向导，无统一流程                     | 新用户 5 分钟上手，含多 profile 管理                 | P2     | 2–3 天 |
| **P2-6** | **文档站 (Docusaurus)**                        | A      | `website/`                                                     | `docs/` 174 md 但非站点                         | 降低学习与贡献门槛                                   | P2     | 2–3 天 |

---

## 五、推荐路线图

### Phase 0 — 前置修复（1 周内，阻断项）

- **P0-1 默认激活 Python 后端**：`.env`/启动脚本显式 `AGENT_BACKEND=python`；或 `JiabaixingCore.ts` 增加默认回退；统一 `APP_VERSION` 与文档；删除/标记被绕过的重复 TS 模块以消除"假完成"。
- **P0-2 TUI**：建议基于 `textual`（Python）或 React 复用前端组件，复用现有 `cli.py` / REST API，优先做"会话列表 + 流式对话 + 工具活动"三屏。

### Phase 1 — 功能性增强（2–4 周）

- P1-1 Skills Hub + optional-skills 目录
- P1-2 OpenTelemetry 追踪（接入现有 StructuredLogger）
- P1-3 Plugin kinds 扩展（先做 browser / image_gen / video_gen / observability）
- P1-4 MoA 多模型聚合

### Phase 2 — 完整性补齐（4–8 周）

- P2-1 Email + WhatsApp 适配器
- P2-2 optional-mcps 精选目录
- P2-3 流式上下文脱敏
- P2-4 学习图
- P2-5 统一首次运行向导
- P2-6 文档站

---

## 六、执行建议

1. **先修 P0-1 再谈新增**：当前默认路径会让新用户在"残缺 TS 旧实现"上运行，所有新增节点若建立在错误基座上都将失效。这是最高杠杆的修复。
2. **保持架构原则**：AGENTS.md 强制"Agent 核心功能以 Python 端为主"。所有新增节点（尤其 TUI/MoA/Skills Hub）应优先在 `python/agent/` 实现，TS 仅作入口路由，避免重蹈双实现并存的覆辙。
3. **新增即测**：每个新增节点需满足"Python 实现完整 + TS 路由联通 + 测试通过 + 端到端可溯源"（AGENTS.md §0.3 的"已完成"认定标准），防止再次产生"🟡 部分完成"。
4. **可借鉴但勿照搬**：Hermes 的"27 硬编码 Provider"在家百星已被 litellm 动态注册表超越，不必回退；其 TUI、Skills Hub、optional-mcps 目录、OTel 是值得直接借鉴的成熟模式。
