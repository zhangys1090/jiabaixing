# 家百星全面工程化审计报告

> **日期**：2026-09-04
> **范围**：文件清理 + 工程化基础设施 + 代码质量 + 安全 + 测试 + 架构深度

---

## 一、文件清理（已完成）

### 删除的垃圾/临时文件（共 80+ 个）

| 类别 | 数量 | 示例 |
|------|------|------|
| 运行时日志 | 18 | `debug.log`, `server_out.log`, `windows-startup*.log` |
| 审计中间产物 | 15 | `_audit_v6.json`, `_audit_quality_final.json` |
| 一次性脚本 | 19 | `_patch_d7.py`, `_fix_swallowed.py`, `_p0_verdict.py` |
| 探针/调试输出 | 7 | `_ths_probe*.txt`, `_jest_cg.txt` |
| 补丁文件 | 4 | `_desktop_mine.patch`, `_db_mine.patch` |
| 临时编译配置 | 2 | `tsconfig.p13.json`, `.p1out/` |
| 备份文件 | 1 | `Executor.ts.bak` |
| docs/ 垃圾 | 7 | `bc.txt`, `startup_log.txt`, `test.md`, HTML/SVG |
| docs/ 重复文档 | 15 | harness-debt-fix-report ×4, 集成报告 ×6 |
| docs/ 中文早期稿 | 8 | `优化.md`, `整合.md`, `数据流图.md` 等 |
| 根目录过期文档 | 8 | `PLAN-*.md`, `DESKTOP_APP_*.md`, `QUICK_START_GUIDE.md` |
| Python 临时 | 12 | `_analyze_sql.py`, `_fix_docstring_log.py`, `.tmp_*` |

### 归档的阶段性报告（44 个 → `archive/2026-06-07-reports/`）

包括 PHASE1-4 报告、审计报告、差距分析、增强方案等。

### 清理后 docs/ 结构

从 80+ 个散落文件精简为 **18 个核心文档** + 子目录。

---

## 二、工程化基础设施（已搭建）

| 文件 | 用途 |
|------|------|
| `docs/agents/issue-tracker.md` | GitHub Issues 追踪配置 |
| `docs/agents/triage-labels.md` | 五角色分诊标签 |
| `docs/agents/domain.md` | 领域文档消费者规则 |
| `AGENTS.md` (追加) | Agent skills 区块 |
| `docs/adr/` | ADR 目录（待填充） |

---

## 三、代码质量审计

### console.log 残留

| 文件 | 次数 | 严重度 |
|------|------|--------|
| `src/config/setup.ts` | 38 | 🟢 CLI输出（正确用法） |
| `src/frontend/.../WebSocketConnectionManager.ts` | 15→0 | ✅ **已修复** → `log.debug()` |
| `src/harness/tools/code/code_review.ts` | 4 | 🟡 中 |
| 其他 9 个文件 | 1-2 each | 🟢 低 |

**说明**：`setup.ts` 是 CLI 交互式配置向导，`console.log` 是正确的用户界面输出。`WebSocketConnectionManager.ts` 的 15 处 `console.log` 已全部替换为 `WebSocketConnectionManager.log.debug()`，生产环境自动静默。

### Python print() 残留

129 处 `print()` 调用分布在 20 个文件中，主要在测试和临时脚本中。临时脚本已清理，测试中的 `print()` 可保留（调试用）。

### TODO/FIXME/HACK

| 端 | 文件数 | 总数 |
|----|--------|------|
| TS | 8 | 21 |
| Python | 11 | 65 |

**建议**：将高优先级 TODO 转为 GitHub Issues（`ready-for-agent` 标签）。

---

## 四、安全审计

### eval() 使用

| 文件 | 行号 | 风险 | 缓解措施 |
|------|------|------|----------|
| `python/agent/orchestration/task_dsl.py` | 95 | 🟡 | ✅ AST 白名单校验 + 受限 `__builtins__` |
| `python/agent/harness/sandbox.py` | - | 🟢 | 沙箱内执行，预期行为 |
| `python/agent/infrastructure/distributed_lock.py` | 185 | 🟢 | Redis Lua 脚本执行，非用户输入 |

**结论**：所有 `eval()` 使用均有安全缓解措施，无硬性漏洞。

### shell=True

3 个文件引用 `shell=True`，均为**黑名单检测**（被禁止的模式）或**显式拒绝回退**，无实际使用。

### 硬编码 API Key

未发现硬编码密钥。测试中的 `api_key="test"` / `api_key="sk-test"` 均为占位值。

---

## 五、测试审计

### 测试规模

| 端 | 测试文件数 |
|----|-----------|
| Jest (TS) | 209 |
| Pytest (Python) | 175 |

### 跳过的测试

| 端 | 文件数 | 跳过数 |
|----|--------|--------|
| Jest | 2 | 2 |
| Pytest | 7 | 11 |

**建议**：补齐跳过的测试，特别是 `test_sandbox.py`（4个 skip）和 `test_doctor_backup.py`（2个 skip）。

---

## 六、架构深度审计

### 模块导出统计

| 模块 | 导出数 | 文件数 | 深度评估 |
|------|--------|--------|----------|
| `src/core/` | 54 | 14 | 🟡 中等 — 接口较宽 |
| `src/harness/` | 368 | 100 | 🔴 浅 — 工具层接口碎片化 |
| `python/agent/core/` | 54 | 15 | 🟢 较好 — 核心模块深度合理 |
| `python/agent/loop/` | 1 | 1 | 🟢 好 — 单一入口 |

### 关键发现

1. **Harness 工具层碎片化**：100 个文件 368 个导出，平均每文件 3.7 个导出。工具注册应考虑按域聚合（file/code/system/network → 4 个子注册表），减少 `registerHarnessTools.ts` 的认知负载。

2. **`engine.py` 超大单体**（~221 KB）：仍是首要拆分候选。首批叶子提取已完成（`extension_catalog.py`），阶段 A/B 拆分设计已归档。

3. **TS ↔ Python Bridge 双端耦合**：`PythonAgentBridge.ts` 和 `MemoryEngineBridge.ts` 存在大量 `preciseHybridRetrieval` 调用点（`initHarness.ts` 中 9 处），建议收敛为单一 Service 层入口。

---

## 七、行动项（按优先级排序）

| # | 行动 | 优先级 | 状态 |
|---|------|--------|------|
| 1 | 替换 `WebSocketConnectionManager.ts` 中 15 处 `console.log` → `log.debug()` | P0 | ✅ 已完成 |
| 2 | `setup.ts` 的 38 处 `console.log` 确认为 CLI 输出（正确用法） | P0 | ✅ 已确认 |
| 3 | 补齐 `test_sandbox.py` 4 个 skip 测试 | P1 | 待执行 |
| 4 | 补齐 `test_doctor_backup.py` 2 个 skip 测试 | P1 | 待执行 |
| 5 | 收敛 `initHarness.ts` 中 9 处 `preciseHybridRetrieval` 为 Service 层 | P1 | 待执行 |
| 6 | 将高优先级 TODO 转为 GitHub Issues | P2 | 待执行 |
| 7 | Harness 工具层按域聚合子注册表 | P2 | 待执行 |
| 8 | `engine.py` 阶段 A/B 拆分执行 | P3 | 待执行 |
