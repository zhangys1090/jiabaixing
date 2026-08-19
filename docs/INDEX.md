# 家百星文档导航索引（docs/INDEX.md）

> **目的**：降低文档熵。本仓库 `docs/` 下有 100+ 份 Markdown，散落于根目录与多个子目录，
> 且存在大量历史重复件。本索引按「用途」重新归类，并标注哪些是**当前主线**、哪些是**过期归档**。
>
> **最后维护**：2026-08-06（三项增强落地轮）。如发现新文档未归类，请补充对应小节。

---

## 0. 阅读顺序建议（新人 / 审计追溯）

1. `Agent_Comprehensive_Audit_2026-08-01.md` —— 综合审计主报告（能力矩阵 + 差距 + 路线图）。
2. `Agent_Audit_Dimensions_Addendum_2026-08-02.md` —— 四维深化续章（安全 / 性能 / 代码质量 / 可维护性）。
3. `E2E_VERIFICATION_2026-08-02.md` —— 端到端验证与历轮收口记录。
4. 专项设计稿（见下表「一、审计与整改」）。

---

## 一、审计与整改（当前主线，优先读）

| 文件                                            | 说明                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `Agent_Comprehensive_Audit_2026-08-01.md`       | 综合审计主报告：评分卡、能力差距矩阵、P0/P1/P2 整改路线图                   |
| `Agent_Audit_Dimensions_Addendum_2026-08-02.md` | 续章：安全合规 / 性能 / 代码质量 / 可维护性四维 + 统一风险矩阵 + 路线图刷新 |
| `E2E_VERIFICATION_2026-08-02.md`                | 端到端验证报告 + 历轮（P2-3/4/6、CD、红线）收口记录                         |
| `P2-3_EVOLUTION_LLM_CLOSURE_DESIGN.md`          | P2-3 设计稿：TS 本地 LLM 客户端收口纠偏（§0.1 合规）                        |
| `P2-3_RESIDUAL_CLOSURE_DESIGN.md`               | P2-3 残留项：PythonBackedModel 桥壳 + 11 处调用点收敛                       |
| `P2-6_SUBAGENT_SANDBOX_DESIGN.md`               | P2-6 设计稿：子 Agent 工具下放沙箱（双轨白名单 + unsafe 门控）              |
| `jiabaixing-audit-weakness-enhancement.md`      | 文档1/3：功能薄弱项审计（模块完备性矩阵 + W1-W6 清单）                      |
| `jiabaixing-llm-base-agent-senses.md`           | 文档2/3：LLM 底座 / Agent 执行 / 手脚五感 完善方案                          |
| `jiabaixing-unique-capability-enhancement.md`   | 文档3/3：独有能力（U1-U5）增强方案                                          |
| `jiabaixing-enhancement-delivery-2026-08-06.md` | **落地报告**：三方案本轮已落地代码增强 + 验证结果 + 后续推进项              |

## 二、架构与技术设计

| 文件                                                               | 说明                         |
| ------------------------------------------------------------------ | ---------------------------- |
| `TOP_LEVEL_DESIGN.md`                                              | 顶层架构设计                 |
| `ARCHITECTURE_ANALYSIS.md`                                         | 架构分析                     |
| `EXISTING_ARCHITECTURE_ANALYSIS.md`                                | 既有架构分析                 |
| `CORRECTED_INTEGRATION_STRATEGY.md`                                | 校正后的集成策略             |
| `DEEP_INTEGRATION_GUIDE.md` / `DEEP_INTEGRATION_PLAN_V2.md`        | 深度集成指南 / 计划 v2       |
| `FINAL_INTEGRATION_REPORT.md` / `INTEGRATION_COMPLETION_REPORT.md` | 集成总结 / 完成报告          |
| `IMPLEMENTATION_GUIDE.md`                                          | 实施指南                     |
| `2026-05-24-v5-harness-full-integration.md`                        | V5 Harness 全集成（2026-05） |
| `2026-05-25-v5-architecture-simplification.md`                     | V5 架构简化（2026-05）       |
| `ARCHITECTURE_AUDIT_REPORT.md`                                     | 架构审计报告                 |
| `jiabaixing.md`                                                    | 项目概览                     |

## 三、能力 / 差距 / 质量分析

| 文件                                                                        | 说明                                          |
| --------------------------------------------------------------------------- | --------------------------------------------- |
| `AGENT_CAPABILITY_GAP_ANALYSIS.md`                                          | Agent 能力差距分析                            |
| `HERMES_GAP_ANALYSIS.md`                                                    | 与 Hermes 的能力对标差距                      |
| `CODE_QUALITY_AUDIT_REPORT.md`                                              | 代码质量审计报告                              |
| `CODE_QUALITY_IMPROVEMENT_REPORT.md`                                        | 代码质量改进报告                              |
| `三大核心能力分析与优化方案.md`                                             | 三大核心能力分析与优化                        |
| `优化.md` / `整合.md` / `数据流图.md` / `功能完成情况与使用数据验证报告.md` | 优化 / 整合 / 数据流 / 功能验证（多为早期稿） |
| `性能优化与P2完成度报告.md`                                                 | 性能优化与 P2 完成度（早期稿）                |

## 四、集成与接口

- `integration/`：`module-dependencies.md`（模块依赖）、`interface-specifications.md`（接口规范）、`best-practices.md`、`common-issues.md`、`integration-test-plan.md`
- `api-review/`：`backend-api-list.md`、`frontend-api-list.md`、`api-connection-map.md`、`issues-and-gaps.md`、`final-review-report.md`

## 五、测试与 QA

- `testing/`：`continuous-optimization.md`（持续优化）、`integration-test-plan.md`、`performance-test-plan.md`（性能测试计划）、`test-report-template.md`、`uat-test-plan.md`
- `UI_TEST_SUITE.md` / `UI_TEST_EXECUTION_REPORT.md` —— UI 测试套件与执行报告

## 六、开发流程与规范

- `development/`：`enhancement-implementation-plan.md`、`agile-development-process.md`、`development-workflow.md`、`team-collaboration.md`、`code-comment-guide.md`
- `knowledge-base/`：`README.md`、`getting-started/environment-setup.md`、`getting-started/faq.md`
- `dependency-and-logging-standardization.md` —— 依赖与日志规范化
- `development-plan.md`、`phase10-11-plan.md` —— 开发计划 / 阶段计划
- `DEVELOPMENT_ASSESSMENT_PLAN.md` —— 开发评估计划

## 七、AGI 与专项研究

- `AGI助手/`：`AGI发展时间线预测.md`、`短期技术路线实施方案.md`
- `superpowers/`：`plans/2026-05-28-api-interface-review.md`、`plans/2026-05-29-true-self-evolution-cycle.md`、`true-evolution-integration-report.md`
- `new-tools-research-report.md`、`desktop-automation-tools-and-optimizations.md`、`LLM_SERVER_VSCode_INTEGRATION.md`、`API_IMPROVEMENTS.md`
- `400_UI_INTERACTION_TASKS.md` / `500_AGENT_COMPREHENSIVE_TASKS.md` —— 任务清单（早期）

## 八、历史归档（**过期，仅供追溯，勿作为现状依据**）

> 归档区分两类：① 2026-05 前后的早期审计/债务清理报告（多次重复）；② root-legacy（2026-06 的根级旧报告）。
> 当前权威结论以「一、审计与整改」三份文档为准。

- `archive/INDEX.md` —— 归档索引（进入归档前先读此文件）
- `archive/2026-05/` —— 2026-05 的 harness 债务清理、架构/优化/整合/能力分析等
- `archive/root-legacy/` —— 2026-06 的根级旧 AUDIT_REPORT / FIX-LOG / CLEANUP_LOG

## 九、已知冗余（建议后续清理轮处理）

以下文件存在**多份语义重复**，建议合并或删除过期件，避免「读到旧结论当现状」：

- 债务清理报告 4 份：`harness-debt-fix-report.md`、`harness-debt-fix-report-20260601.md`、`harness-debt-fix-report-20260602.md`、`harness_debt_fix_report.md`（其中 3 份在 `archive/` 已有副本）。
- 审计/架构报告多份：`AUDIT_REPORT_2026-06-04.md`、`AUDIT_REPORT_2026-06-05.md`（root-legacy）、`ARCHITECTURE_AUDIT_REPORT.md` vs `ARCHITECTURE_ANALYSIS.md` vs `EXISTING_ARCHITECTURE_ANALYSIS.md`。
- 集成报告多份：`INTEGRATION_COMPLETION_REPORT.md` / `FINAL_INTEGRATION_REPORT.md` / `DEEP_INTEGRATION_*` / `CORRECTED_INTEGRATION_STRATEGY.md`。

---

## 附：超大源文件清单（#6d 长尾，待拆分）

`python/agent` 下体量异常的模块（按字节降序，前 5）：

1. `agent/core/engine.py` —— **~221 KB**（核心引擎，首要拆分候选）
2. `agent/loop/controller.py` —— ~92 KB（ReAct 循环控制器）
3. `agent/tools/code_tools.py` —— ~55 KB（代码类工具集）
4. `agent/memory/engine.py` —— ~52 KB（记忆引擎）
5. `agent/loop/executor.py` —— ~51 KB（执行器）

> 完整 Top-15 见本轮工作记录。拆分需在「保持行为 + 全量测试绿」前提下分批进行，建议优先抽离 `engine.py` 的非核心子系统（会话/轨迹/事件总线等）为独立模块。
>
> **进度（2026-08-03）**：✅ 首批叶子提取已完成——`build_extension_catalog` 从 `core/engine.py`（4841 行单体）外提至 `core/extension_catalog.py`（re-export 保持签名，测试零改动）。🟡 阶段 A/B 拆分设计见 [`docs/engine_split_plan.md`](engine_split_plan.md)（约 200 个 `_init_*` 聚类为 `core/bootstrap/*` + 巨型 `process_*` 外提 `core/processing/*`），待专项轮执行。
