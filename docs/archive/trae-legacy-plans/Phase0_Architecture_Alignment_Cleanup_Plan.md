# 阶段 0：架构对齐与清理计划

## 任务概览

| 任务 ID | 任务名称 | 验收标准 |
|---------|---------|---------|
| 0.1 | 删除废弃目录 | 无残留引用，编译通过 |
| 0.2 | 新建目录并迁移模块 | 保留原 interaction 中的人格规则暂存，后续重写 |
| 0.3 | 封装工具能力为 Skills | 技能可通过接口调用，无人格耦合 |

---

## 任务 0.1：删除废弃目录与清理引用

### 现状分析
- `src/管家/` - 不存在
- `src/情人/` - 不存在  
- `src/development/` - 不存在
- 但存在相关引用：
  - `src/frontend/src/components/HousekeeperModule.tsx` (管家模块前端组件)
  - `src/frontend/src/components/LoverModule.tsx` (情人模块前端组件)
  - `src/frontend/src/components/DevelopmentModule.tsx` (开发模块前端组件)

### 实施步骤

1. **删除前端废弃组件**
   - 删除 `src/frontend/src/components/HousekeeperModule.tsx`
   - 删除 `src/frontend/src/components/LoverModule.tsx`
   - 删除 `src/frontend/src/components/DevelopmentModule.tsx`

2. **清理引用**
   - 从 `src/frontend/src/App.tsx` 中移除上述组件的导入和使用
   - 搜索全项目确保无残留引用

3. **验证**
   - 运行 `npm run build` 确保编译通过
   - 运行 `npm run lint` 确保无引用错误

---

## 任务 0.2：新建目录并迁移模块

### 现状分析
- `src/persona/` - 不存在，需要创建
- `src/skills/` - 已存在，包含 FileSkill、SearchSkill、ScheduleSkill
- `src/evolution/` - 已存在，包含完整的进化反馈系统
- 人格规则位于 `src/interaction/PersonaRules.ts`，需要迁移到 `src/persona/`

### 实施步骤

1. **创建 `src/persona/` 目录**
   - 迁移 `src/interaction/PersonaRules.ts` → `src/persona/PersonaRules.ts`
   - 创建 `src/persona/index.ts` 统一导出
   - 更新所有引用 PersonaRules 的文件导入路径

2. **完善 `src/skills/` 目录**
   - 现有技能已存在，无需迁移
   - 创建 `src/skills/index.ts` 统一导出（如不存在）

3. **完善 `src/evolution/` 目录**
   - 现有进化系统已存在，无需迁移
   - 验证目录结构完整性

4. **更新引用**
   - 搜索全项目所有引用 `../interaction/PersonaRules` 的地方
   - 更新为 `../persona/PersonaRules` 或 `@/persona/PersonaRules`

5. **验证**
   - 运行 `npm run build` 确保编译通过
   - 运行单元测试确保功能正常

---

## 任务 0.3：封装工具能力为 Skills 纯函数模块

### 现状分析
- `src/tools/ToolExecutor.ts` 包含大量工具实现（约 1966 行）
  - 文件读写：`read_file`、`write_file`
  - 命令执行：`run_command`
  - 代码搜索：`search_code`
  - 代码分析：`code_analyzer`
  - 代码生成：`code_generator`
  - 代码测试：`code_tester`
  - 代码优化：`code_optimizer`
  - 安全审计：`security_auditor`
  - 性能分析：`performance_analyzer`
  - 项目分析：`project_analyzer`
  - 调试助手：`debug_helper`
  - 代码重构：`code_refactor`
  - 测试自动化：`test_automation`

- 现有 Skills：
  - `FileSkill.ts` - 文件操作（已实现）
  - `SearchSkill.ts` - 搜索功能（已实现）
  - `ScheduleSkill.ts` - 任务调度（已实现）

### 实施步骤

1. **创建新的 Skill 模块**

   a. **CommandSkill.ts** - 命令执行技能
   ```typescript
   // 从 ToolExecutor 提取 run_command 逻辑
   // 封装为纯函数，支持安全校验
   ```

   b. **CodeAnalysisSkill.ts** - 代码分析技能
   ```typescript
   // 从 ToolExecutor 提取 code_analyzer 逻辑
   // 包含 AST 分析、安全检查、性能分析
   ```

   c. **CodeGeneratorSkill.ts** - 代码生成技能
   ```typescript
   // 从 ToolExecutor 提取 code_generator 逻辑
   ```

   d. **CodeTesterSkill.ts** - 代码测试技能
   ```typescript
   // 从 ToolExecutor 提取 code_tester 逻辑
   ```

   e. **CodeOptimizerSkill.ts** - 代码优化技能
   ```typescript
   // 从 ToolExecutor 提取 code_optimizer 逻辑
   ```

   f. **SecurityAuditSkill.ts** - 安全审计技能
   ```typescript
   // 从 ToolExecutor 提取 security_auditor 逻辑
   ```

   g. **ProjectAnalyzerSkill.ts** - 项目分析技能
   ```typescript
   // 从 ToolExecutor 提取 project_analyzer 逻辑
   ```

2. **创建辅助函数库**
   - 创建 `src/skills/utils/` 目录
   - 将 ToolExecutor 中的公共辅助函数提取为纯函数：
     - `codeQualityEvaluator.ts`
     - `staticAnalyzer.ts`
     - `securityAnalyzer.ts`
     - `performanceAnalyzer.ts`
     - `codeMetricsCalculator.ts`

3. **注册到 SkillRegistry**
   - 更新 `src/skills/index.ts` 导入所有新技能
   - 在应用初始化时批量注册到 SkillRegistry

4. **解耦人格依赖**
   - 确保所有 Skill 模块不依赖 PersonaRules
   - 确保所有 Skill 模块不依赖 InteractionEngine
   - Skill 只依赖：SkillInterface、Logger、SecurityGuard、工具函数

5. **更新 SkillRegistry**
   - 完善 SkillRegistry 的批量注册逻辑
   - 添加技能分组管理（文件系统、代码工具、安全工具等）

6. **编写单元测试**
   - 为每个新 Skill 编写测试用例
   - 验证技能可通过接口独立调用

7. **验证**
   - 运行 `npm run build` 确保编译通过
   - 运行 `npm test` 确保所有测试通过
   - 验证技能执行无人格耦合

---

## 验收标准检查清单

### 任务 0.1
- [ ] `src/管家/` 不存在或为空
- [ ] `src/情人/` 不存在或为空
- [ ] `src/development/` 不存在或为空
- [ ] 前端组件 HousekeeperModule、LoverModule、DevelopmentModule 已删除
- [ ] 无残留引用（通过 `grep` 验证）
- [ ] `npm run build` 编译通过
- [ ] `npm run lint` 无错误

### 任务 0.2
- [ ] `src/persona/` 目录已创建
- [ ] `src/persona/PersonaRules.ts` 存在
- [ ] `src/persona/index.ts` 存在并正确导出
- [ ] 所有引用已更新
- [ ] `src/skills/` 目录完整
- [ ] `src/evolution/` 目录完整
- [ ] `npm run build` 编译通过
- [ ] 相关单元测试通过

### 任务 0.3
- [ ] 所有工具能力已封装为 Skills 纯函数模块
- [ ] 新 Skills 已注册到 SkillRegistry
- [ ] 技能可通过 `SkillRegistry.executeSkill()` 调用
- [ ] 无人格耦合（Skills 不依赖 PersonaRules）
- [ ] 每个新 Skill 有对应的单元测试
- [ ] `npm run build` 编译通过
- [ ] `npm test` 所有测试通过

---

## 依赖关系

```
任务 0.1 → 任务 0.2 → 任务 0.3
```

- 任务 0.1 和 0.2 可并行执行
- 任务 0.3 依赖任务 0.2 完成（需要 skills 目录结构稳定）

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 删除组件导致前端崩溃 | 高 | 先注释而非删除，验证后再清理 |
| 迁移 PersonaRules 导致引用断裂 | 中 | 使用 IDE 全局搜索确保更新所有引用 |
| 工具封装破坏现有功能 | 高 | 保持 ToolExecutor 向后兼容，逐步迁移 |
| 测试覆盖不足 | 中 | 为每个新 Skill 编写测试用例 |
