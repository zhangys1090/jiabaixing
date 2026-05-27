# V4.5 → V5.0 架构整合计划（不动大文件版）

## 一、目标

将当前混沌状态精简为**一套干净、可运行的V5.0架构**。**不动12个巨型文件**（风险太高），只做安全的小改动。

### 成功标准
| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| 架构文档 | 5套互打 | 1套 CODE_WIKI.md |
| TS编译错误 | ~40个 | 0（只修非巨型文件的错误） |
| `as unknown as` | 91处 | <20处（只修非巨型文件） |
| 测试通过率 | ~79% | ≥90% |
| WebSocket重复广播 | 存在 | 0 |
| 模块路由冲突 | 部分 | 统一 main.ts 为唯一入口 |

### 不在范围
- ❌ 12个巨型文件（>3000行）—— 不动
- ❌ 新功能开发
- ❌ Phase 4 高级可视化
- ❌ 语音/桌面代理硬件链路

---

## 二、当前状态

### V4.5 已删除（~63,000行死代码）
- ✅ `src/server/index.ts` (36,624行)
- ✅ `src/server/middleware/` (5文件)
- ✅ `src/server/services/` (3文件)
- ✅ `src/index.ts` (10,194行) — JiaBaiXing旧类
- ✅ 修复 systemStateRoutes / main.ts / test 引用链
- ✅ CODE_WIKI.md 同步（10步→12步）

### 待做（仅动小文件）

**A. 架构文档整合** — 多套文档合并到 CODE_WIKI.md 一套
**B. TS编译修复** — 只修非巨型文件中的错误
**C. 消除 `as unknown as`** — 非巨型文件中可安全替换的
**D. WebSocket 去重** — 删除重复广播
**E. 补测试** — 关键路径测试
**F. 自动化调度** — 每晚1点运行检查+报告

---

## 三、具体步骤

### Step 1: 架构文档整合（最安全，纯文档）

将分散在多处的架构信息合并到 CODE_WIKI.md 中，使其成为唯一真相来源：

1. **清理 docs/ 目录下的过期文档**
   - 标记或归档 `架构优化方案4.0.md` 中的"待实施"部分（因为大文件不拆了）
   - 标记 `数据流图.md` 中的断点哪些已修复、哪些仍存在
   - 统一 `三大核心能力分析与优化方案.md` 到 CODE_WIKI.md 的 V5.0 章节

2. **CODE_WIKI.md 补充**
   - 加"V4.5 减法记录"章节（已完成）
   - 加"已知债务"章节（标记12个巨型文件为已知、12步初始化文档已同步）
   - 加"V5.0 架构原理"章节（Harness路由 + 降级兜底 + 契约驱动 + EventBus事件映射）
   - 删除"10层流转"等有歧义的表述

3. **删除 5 套文档中已被代码替代的过时内容**
   - `架构升级报告-v4.0.md` 中的 P0 内容（已实现）→ 移到 CHANGELOG
   - `P0/P1/P2 完成度报告` 与代码同步

### Step 2: TS编译修复（只修小文件）

策略：运行 `tsc --noEmit`，排除12个巨型文件目录，只修其余文件。

```bash
# 先排除大文件看还剩多少错误
npx tsc --noEmit 2>&1 | grep -v "JiabaixingCore\|ToolManager\|LLMProvider\|\
MultiModelLLMProvider\|EvolutionOrchestrator\|EventBus\|EmotionDiaryGenerator\|\
UserProfile\|UserProfileSystem\|StateSnapshotManager\|DesktopUIInspector\|\
systemStateRoutes" | tee logs/ts_errors_small.txt
```

排错优先级：
1. `core/` 中非大文件的 TS 错误
2. `server/routes/` 中的类型错误
3. `shared/` 中的接口不匹配
4. `harness/` 子模块的错误

### Step 3: 消除 `as unknown as`（非巨型文件）

```bash
# 统计小文件中的数量
rg "as unknown as" src/ --files-with-matches | \
  grep -v "JiabaixingCore\|ToolManager\|LLMProvider\|..." | \
  wc -l
```

策略：
- 小文件中 `as unknown as SpecificType` → 去掉中间 `as unknown`
- 补缺失的类型标注 → 从源头消除断言需求
- 标记不可消除的（EventBus泛型等）→ 记录到 CODE_WIKI.md 已知债务

### Step 4: WebSocket 去重（1个文件改动）

**问题**：`websocket.ts` 直接 `ws.send('response_ready')`，同时 `eventBusSetup.ts` 监听 `response_ready` 并广播。前端收到两次相同响应。

**修复**（改 [websocket.ts](file:///c:/zy/jiabaixing/src/server/websocket.ts) 约10行）：
- 删除 `websocket.ts` 中的直接 `ws.send('response_ready')`
- 统一由 `EventBus.emit('response_ready') → eventBusSetup.ts broadcast` 推送
- 已有的 `checkAndMarkResponse` 去重机制保留

### Step 5: 补测试

不补大文件的测试，只补：
1. `systemStateRoutes` 注入方式变了，补1个测试
2. `websocket.ts` 去重后补1个测试
3. `harness/loop/` 各组件补基础测试（如果缺失）

目标：测试通过率 79% → 90%（提高11个百分点，不动大文件测试）

### Step 6: 创建自动化脚本 + Schedule

**新文件**：`scripts/optimization-check.ts`

功能：
```
1. npx tsc --noEmit → 统计错误数（排除大文件，单独计数）
2. npm test --json → 解析通过/失败/跳过
3. npm run lint → 统计 warning 数
4. 输出 JSON: {
     tsErrors: { total: 0, bigFileErrors: 0, smallFileErrors: 0 },
     tests: { pass: 0, fail: 0, skip: 0, passRate: "xx%" },
     lint: { warnings: 0 },
     timestamp: "ISO"
   }
5. 写入 files: logs/optimization_status.json + logs/optimization_report_YYYYMMDD.md
```

**Schedule**：每晚1点上海时间运行
```
cron: 0 1 * * *
任务: 运行 scripts/optimization-check.ts → 生成报告
     如果小文件TS错误增加 → 标记告警
     如果测试通过率下降 → 标记告警
     自动修复: eslint --fix（仅格式）
```

---

## 四、技能使用

| 技能 | 用途 | 阶段 |
|------|------|------|
| `code-quality` | lint + format 修复 | Step 2-3 |
| `security-best-practices` | WebSocket/路由安全审查 | Step 4 |
| `consulting-analysis` | 生成架构整合分析报告 | Step 1 |

---

## 五、改动汇总

| 改动 | 文件数 | 风险 |
|------|--------|------|
| 文档整合 | docs/*.md + CODE_WIKI.md | 零 |
| TS编译修复（小文件） | ~10个 | 极低 |
| `as unknown as` 消除（小文件） | ~15个 | 极低 |
| WebSocket 去重 | 1个（websocket.ts） | 低 |
| 补测试 | ~3个新测试文件 | 零 |
| 自动化脚本 + Schedule | 1个新文件 | 零 |

**总计改动：~30个文件，0个大文件，最大改动是 websocket.ts 约10行。**

---

## 六、验收标准

- [ ] CODE_WIKI.md 是唯一架构真相来源
- [ ] 小文件 TS 编译零错误
- [ ] `as unknown as` 在小文件中 <10处
- [ ] 测试通过率 ≥ 90%
- [ ] WebSocket 无重复广播
- [ ] 自动化报告生成到 logs/
- [ ] Schedule 任务创建成功

---

## 七、Schedule 配置

```json
{
  "name": "架构精简优化",
  "cron": "0 1 * * *",
  "timezone": "Asia/Shanghai",
  "message": "在 c:/zy/jiabaixing 项目目录执行架构优化检查：
1. 运行 npm run lint 检查代码规范
2. 运行 npx tsc --noEmit 检查 TS 编译错误（区分大文件和小文件错误）
3. 运行 npm test --json 获取测试通过率
4. 运行 node scripts/optimization-check.ts 生成统计报告
5. 将报告写入 logs/optimization_report_YYYYMMDD.md

策略：
- eslint --fix 自动修复格式问题 → 自动执行
- TS错误/测试失败 → 仅报告不修改（需要人工判断和审查）
- 大文件（12个>3000行）的错误单独统计，不在本轮修复范围

输出格式：JSON状态文件 + Markdown报告"
}
```
