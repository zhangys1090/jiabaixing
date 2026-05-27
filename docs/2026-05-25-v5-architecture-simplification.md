# V5.0 架构精简与规范化实施计划

> **目标**：将 Jiabaixing V5.0 从"双系统并行"状态精简为单一、统一的 Harness 架构，消除重复代码，提升可维护性。
> **实施原则**：先确保新系统稳定，再逐步移除旧代码，确保系统始终可运行。

---

## 现状分析

### 发现的重复与冗余

1. **双工具系统并行**：
   - 新系统：`src/harness/tools/`（6 类 19 个工具）
   - 旧系统：`src/tools/`（13 个工具）+ `src/skills/`（33 个技能）
   - 大量功能重复

2. **重复的类型定义**：
   - `src/shared/contracts.ts`
   - `src/frontend/src/shared/contracts.ts`
   - 两个文件内容几乎完全相同

3. **冗余的 LLM 适配器**：
   - `src/llm/`（旧）
   - `src/harness/loop/Executor.ts`（新）
   - `src/models/LLMProvider.ts`（已有）

4. **可清理的临时文件**：
   - `temp/` 文件夹可能有过时文件
   - `docs/` 中有过时文档（P0/P1/P2 报告）

---

## 阶段一：验证与巩固新系统（低风险）

### Task 1：验证 Harness 系统完整性

**目标**：确保新 Harness 系统可以独立替代旧系统的所有功能

**文件**：
- 创建：`tests/harness/comprehensive-coverage.test.ts`

**步骤**：
1. 创建完整功能覆盖测试
2. 验证所有 19 个 Harness 工具可以正常工作
3. 验证所有 6 个 Harness 层次协同工作
4. 验证从入口到回复的完整流程

**验收标准**：
- 测试覆盖率 Harness 核心功能 100%
- 所有旧工具功能在 Harness 中均有对应替代

---

## 阶段二：统一类型定义

### Task 2：解决重复 contracts.ts

**目标**：只保留一份类型定义文件

**文件**：
- 删除：`src/frontend/src/shared/contracts.ts`
- 修改：`tsconfig.json` 添加路径映射
- 修改：`src/frontend/tsconfig.json` 添加路径映射
- 修改：前端所有导入 `contracts.ts` 的地方

**步骤**：
1. 确认 `src/shared/contracts.ts` 是最新最完整的
2. 删除 `src/frontend/src/shared/contracts.ts`
3. 在 `tsconfig.json` 中添加路径映射：
   ```json
   "paths": {
     "@shared/*": ["src/shared/*"]
   }
   ```
4. 更新前端所有导入语句

**验收标准**：
- 类型安全
- 前后端类型一致
- 编译无错误

---

## 阶段三：工具系统统一

### Task 3：迁移仍在使用旧 tools/ 的代码到 Harness

**文件**：
- 扫描所有导入 `src/tools/` 的文件
- 迁移到 `src/harness/tools/`

**步骤**：
1. 识别所有使用旧工具系统的代码
2. 逐个迁移到 Harness 工具
3. 使用 `SkillBridge` 作为临时过渡

**验收标准**：
- 没有代码再导入 `src/tools/` 模块

### Task 4：迁移仍在使用旧 skills/ 的代码到 Harness

**文件**：
- 扫描所有导入 `src/skills/` 的文件
- 迁移到 `src/harness/tools/`

**步骤**：
1. 确认哪些技能在 Harness 中有对应工具
2. 迁移代码
3. 标记仍需保留的技能（特殊功能）

**验收标准**：
- 主要功能完全使用 Harness 工具

### Task 5：保留但禁用旧工具系统（安全网）

**文件**：
- 修改：`src/tools/index.ts` 添加警告
- 修改：`src/skills/index.ts` 添加警告

**步骤**：
1. 在旧系统入口添加弃用警告
2. 但代码仍可运行（安全网）

---

## 阶段四：彻底清理旧系统

### Task 6：删除旧工具系统

**文件**：
- 删除：`src/tools/` 整个文件夹
- 删除：`src/skills/` 文件夹（除特殊技能外）

**步骤**：
1. 确认不再有代码引用
2. 全量测试确保系统仍可运行
3. 安全删除

### Task 7：清理冗余的 LLM 适配器

**文件**：
- 评估：`src/llm/` 每个模块
- 删除：已被 Harness 完全替代的模块

**步骤**：
1. 检查 `src/llm/` 中的每个文件
2. 确认功能是否已在 Harness 中实现
3. 保留仍在使用的部分
4. 删除冗余部分

---

## 阶段五：文档与依赖清理

### Task 8：清理过时文档

**文件**：
- 删除：`docs/P0优先级开发完成度报告.md`（过时）
- 删除：`docs/P1优先级开发完成度报告.md`（过时）
- 删除：`docs/P2_Development_Document.md`（过时）
- 删除：`docs/P2_Test_Report.md`（过时）
- 删除：`docs/P2_User_Manual.md`（过时）
- 删除：`docs/架构优化方案4.0.md`（过时）
- 删除：`docs/架构升级报告-v4.0.md`（过时）
- 删除：`docs/优化方案.md`（过时）
- 保留：`PROJECT.md`（最新）
- 保留：`CODE_WIKI.md`（最新）

### Task 9：清理未使用的依赖

**文件**：
- 修改：`package.json`

**步骤**：
1. 运行 `npm audit` 和 `npm prune`
2. 识别未使用的依赖
3. 安全移除（有把握的）

---

## 阶段六：性能优化（可选）

### Task 10：巨型文件拆分（可选）

**目标**：提升可维护性

**文件**：
- 拆分：`src/core/JiabaixingCore.ts`
- 拆分：`src/harness/AgentHarness.ts`
- 拆分：`src/harness/loop/LoopController.ts`

**原则**：
- 保持功能不变
- 保持接口不变
- 逐步拆分，不引起大变更

---

## 风险控制

### 回滚策略

每个阶段完成后：
1. 全量测试通过
2. 保留回滚路径（git 提交清晰）
3. 如果发现问题，立即回滚并分析

### 持续验证

- 每个 Task 完成后运行 `npm test`
- 运行完整集成测试
- 手动验证关键功能

---

## 执行顺序建议

**优先级**（从上到下）：
1. Task 1 - 验证新系统（最重要）
2. Task 2 - 统一类型（最小变更，立竿见影）
3. Task 3/4 - 工具系统迁移
4. Task 5 - 旧系统禁用
5. Task 6/7 - 彻底清理
6. Task 8/9 - 文档/依赖清理
7. Task 10 - 巨型文件拆分（可选，非关键路径）

---

## 预期收益

| 度量 | 改进 |
|-----|-----|
| 代码行数 | 减少 ~40% |
| 维护成本 | 降低 ~50% |
| 编译速度 | 提升 ~20% |
| 测试速度 | 提升 ~30% |
| 新人上手时间 | 减少 ~50% |
| 架构一致性 | 大幅提升 |

