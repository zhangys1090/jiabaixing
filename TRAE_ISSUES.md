# Jiabaixing V5.0 问题清单 ← 给 TRAE / Claude Code 用

> 项目路径: `C:\zy\jiabaixing`
> TypeScript 6.0.2, Node >=20
> 启动: `npm run start:backend`

---

## ⚠️ 第一要务：修复编译错误（23个）

### 文件1: `src/security/AuditLogger.ts` — 20 个错误

**根因：** `AuditLogEntry` 接口定义与 `AuditLogger.ts` 中实际使用的字段不匹配。

**修复方案：** 在 `src/security/types.ts`（或 AuditLogger.ts 顶部）给 `AuditLogEntry` 接口添加以下缺失字段：
- `actor: string`
- `target: string`
- `category: string`
- `userId: string`
- `resource: string`

并将 `result` 类型从 `"success" | "failure"` 改为 `"success" | "failure" | "warning"`。

具体错误位置：
```
L246-249: 使用了 entry.actor / entry.target / entry.category — 接口缺这3个字段
L299-313: query 参数类型 Partial<AuditLogEntry> 中也使用了 actor/target/category
L346: 创建对象时缺 userId, resource
L391-394: 遍历时用了 actor/target/category
L420: result 类型少了 "warning"
L425-426: category 字段
```

### 文件2: `src/harness/AgentHarness.ts` — 1 个错误

**根因：** `ContextManagerDeps.historyProvider` 现在需要 `getAllHistory()` 方法，但 AgentHarness 创建时只传了 `getRecentHistory`。

**修复方案：** 在 AgentHarness.ts L279 附近，给 `historyProvider` 添加 `getAllHistory()` 方法：
```typescript
getAllHistory: () => this.deps.historyProvider.getAllHistory(),
```
或根据实际需要实现。

### 文件3: `src/harness/evaluation/IndependentEvaluationService.ts` — 3 个错误

**修复：**
1. L169: `completed` 属性类型签名为 `boolean`，但传入了 `string | boolean | undefined` → 添加类型守卫
2. L434: `messages[i].tool_calls` 可能为 `undefined` → 加可选链 `messages[i].tool_calls?.length`
3. L448: `messages[i].content` 类型为 `string | null | undefined`，但返回值要求 `string | null` → 加空值处理

---

## ⚠️ 第二要务：ESLint 手动修复（189个，按优先级）

### P0: 未处理的 Promise（~20个）—— 可能导致静默失败

涉及文件：
- `src/cli.ts` L779 — `@typescript-eslint/no-floating-promises`
- `src/hardware/DeviceDiscovery.ts` L48
- `src/hardware/DeviceManager.ts` L188
- `src/harness/persistence/PersistenceService.ts` L153, L154, L466
- `src/integration/IntegrationManager.ts` L83, L144
- `src/integration/TRAEOptimizationIntegrator.ts` L208, L223
- `src/integration/adapters/QQAdapter.ts` L301

**修复：** 在每个未处理的 Promise 前加 `void` 关键字，或 await 它。

### P1: any 类型（~40 个）—— 类型安全风险

涉及文件（按数量排序）：
- `src/hardware/AudioVideoDeviceAccess.ts` ~35 个 any
- `src/hardware/LocalDeviceAccess.ts` ~31 个 any
- `src/server/bootstrap.ts` ~12 个 any
- `src/server/routes/memoryRoutes.ts` ~2 个 any
- `src/integration/adapters/WeChatQRAdapter.ts` ~10 个 any
- 其他零散分布

### P2: 未使用变量（~80 个）—— 代码噪音

涉及 50+ 个文件，主要是：
- 各 `src/server/routes/*Routes.ts` 导入了 `Request` 和 `Response` 但未使用
- 各 adapter 中 `imageUrls` 和 `mentions` 参数未使用
- 各类变量赋值后未使用

**修复：** 删除未使用的 import 和变量，或在参数名前加 `_` 前缀。

### P3: await-thenable（~5 个）
- `src/desktop/StateSnapshotManager.ts` L178, L458 — await 非 Promise 值
- `src/server/bootstrap.ts` L100 — await 非 Promise

---

## 🔵 第三要务：Prettier 格式（1777个）

运行 `npx prettier --write src/` 即可自动修复。

---

## 📦 第四要务：测试修复（14个套件失败）

先完成第一要务（编译通过）后，这14个测试套件会自动恢复运行：
```
tests/harness/loop.test.ts
tests/harness/tools.test.ts
tests/harness/verification.test.ts
tests/harness/phase2-loop-context.test.ts
tests/harness/phase3-4-deep.test.ts
tests/harness/phase5-routing.test.ts
tests/harness/step-evaluator.test.ts
tests/harness/integration.test.ts
tests/harness/full-pipeline.test.ts
tests/harness/comprehensive-coverage.test.ts
tests/harness/independent-evaluator.test.ts
tests/harness/persistence-injection.test.ts
tests/unit/security/AuditLogger.test.ts
tests/unit/security/SecurityManager.test.ts
```

当前已有 202 个测试运行通过，11 个套件正常。

---

## 🏛 第五要务：架构缺陷（优先级低，不影响编译）

1. **上下文压缩/摘要/卸荷未实现** — `ContextManager.ts` 已有接口声明但方法体为空
2. **Evaluator 未解耦** — 与执行循环耦合
3. **无 Golden Eval Set** — 评估基于基础 LLM-as-a-Judge
4. **回溯最多 1 次** — 重试能力有限
5. **混沌测试/对抗测试** — 未实施
6. **插件签名验证** — 未实施
7. **全轨迹审计** — trajectory-level 审计未实现

---

## 验证命令

```bash
# 编译检查
npm run build

# 运行测试
npm test

# ESLint 检查
npm run lint
```
