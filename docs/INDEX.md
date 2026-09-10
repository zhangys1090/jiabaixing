# 家百星文档导航索引（docs/INDEX.md）

> **目的**：降低文档熵。按「用途」归类当前文档，标注主线 vs 归档。
> **最后维护**：2026-09-04（全面清理 + 归档整理 + 目录精简）。

---

## 0. 阅读顺序建议

1. `COMPREHENSIVE_ENGINEERING_AUDIT_2026-09-04.md` — 最新全面工程化审计
2. `ARCHITECTURE_AUDIT_V6.md` — V6.2 架构审计主报告（P0/P1/P2 内核提升）
3. `EXECUTION_AGENT_ROADMAP.md` — V1.1 执行Agent路线图
4. `TOP_LEVEL_DESIGN.md` — 顶层架构设计
5. `BUSINESS_LOGIC.md` — 业务逻辑
6. `PRODUCTION_READINESS_RUNBOOK.md` — 生产就绪运维手册

---

## 一、架构与设计（当前主线）

| 文档 | 说明 |
|------|------|
| `COMPREHENSIVE_ENGINEERING_AUDIT_2026-09-04.md` | 全面工程化审计（文件清理+代码质量+安全+测试） |
| `ARCHITECTURE_AUDIT_V6.md` | V6.2 架构审计：P0/P1/P2 内核提升 + 集成矩阵 + 测试结果 |
| `EXECUTION_AGENT_ROADMAP.md` | V1.1 路线图：战略能力落地 + 主循环集成架构 |
| `TOP_LEVEL_DESIGN.md` | 顶层架构设计 |
| `BUSINESS_LOGIC.md` | 业务逻辑定义 |
| `PLANNING_REASONING_DESIGN.md` | 规划推理设计 |
| `HARNESS_OPEN_SOURCE_REFERENCE.md` | Harness 开源参考 |
| `DEPRECATION_MAP.md` | 废弃映射表 |
| `DEPRECATION_SCHEDULE.md` | 废弃时间表 |

## 二、变更记录

| 文档 | 说明 |
|------|------|
| `P0-1_default_python_backend_changelog.md` | P0-1 Python 后端默认切换日志 |

## 三、运维与指南

| 文档 | 说明 |
|------|------|
| `PRODUCTION_READINESS_RUNBOOK.md` | 生产就绪运维手册 |
| `FEATURE_USAGE_GUIDE.md` | 功能使用指南 |
| `API_IMPROVEMENTS.md` | API 改进记录 |

## 四、AGI 研究

- `AGI助手/AGI发展时间线预测.md` — AGI 发展时间线预测
- `AGI助手/短期技术路线实施方案.md` — 短期技术路线实施方案

## 五、工程化基础设施

- `agents/issue-tracker.md` — Issue 追踪配置
- `agents/triage-labels.md` — 分诊标签词汇
- `agents/domain.md` — 领域文档消费者规则

## 六、子目录

| 目录 | 说明 |
|------|------|
| `integration/` | 模块依赖、接口规范、最佳实践 |
| `api-review/` | 后端/前端 API 列表、连接图、差距分析 |
| `testing/` | 持续优化、集成/性能测试计划 |
| `development/` | 增强实施计划、敏捷流程、代码注释指南 |
| `knowledge-base/` | 环境搭建、FAQ |
| `design/` | 架构设计文档（THIN_HARNESS_FAT_SKILLS） |
| `adr/` | 架构决策记录（ADR） |
| `训练资源/` | 算法数据集参考 |

## 七、历史归档（过期，仅供追溯）

| 目录 | 说明 |
|------|------|
| `archive/INDEX.md` | 归档索引 |
| `archive/2026-05/` | 2026-05 早期审计/债务清理（38 个文件） |
| `archive/root-legacy/` | 2026-06 根级旧报告（9 个文件） |
| `archive/2026-06-07-reports/` | 2026-06~08 阶段性审计/设计/实施报告（59 个文件） |
| `archive/superpowers-legacy/` | superpowers 旧计划（16 个文件） |
| `archive/trae-legacy-plans/` | .trae/documents 旧计划（22 个文件） |

---

## 附：超大源文件清单（待拆分）

`python/agent` 下体量异常的模块：

1. `agent/core/engine.py` — ~221 KB（核心引擎，首要拆分候选）
2. `agent/loop/controller.py` — ~92 KB（ReAct 循环控制器）
3. `agent/tools/code_tools.py` — ~55 KB（代码类工具集）
4. `agent/memory/engine.py` — ~52 KB（记忆引擎）
5. `agent/loop/executor.py` — ~51 KB（执行器）
