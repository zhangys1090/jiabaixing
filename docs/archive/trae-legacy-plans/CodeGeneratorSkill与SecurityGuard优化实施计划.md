# CodeGeneratorSkill 与 SecurityGuard 优化实施计划

## 概述

本计划针对 jiabaixing 系统中两个核心模块进行深度优化：
1. **CodeGeneratorSkill** — 从占位实现升级为真正的智能代码生成技能（已部分实现，需完善集成）
2. **SecurityGuard** — 实现代码沙箱检查和权限校验的真实逻辑（已实现核心逻辑，需集成到 ToolExecutor）

---

## 当前状态分析

### CodeGeneratorSkill (`src/skills/CodeGeneratorSkill.ts`)

**已实现：**
- ✅ `generateCode()` — 集成 LLM，调用 `llmProvider.devGenerateCode()` 生成代码
- ✅ `analyzeCode()` — 集成 LLM 进行代码质量分析，含解析逻辑
- ✅ `fixCode()` — 集成 LLM 进行代码修复
- ✅ 快捷方法：`generateTypeScriptCode`, `generatePythonCode`, `generateJavaCode`, `generateGoCode`
- ✅ 降级机制：`generateFallbackCode()` 在 LLM 失败时返回模板代码
- ✅ 代码清理：`cleanGeneratedCode()` 移除 markdown 代码块标记

**待完善：**
- ⚠️ `code_generator` 工具（ToolExecutor 中）仍为硬编码模板生成，未使用 CodeGeneratorSkill
- ⚠️ 缺少与 SkillRegistry 的注册集成
- ⚠️ 缺少代码执行/验证能力（生成后能否运行）

### SecurityGuard (`src/security/SecurityGuard.ts`)

**已实现：**
- ✅ `sandboxCheck()` — 危险代码模式检测（eval、network、filesystem、infinite_loop、child_process、global_pollution）
- ✅ `permissionCheck()` — 基于角色的访问控制（RBAC）
- ✅ `validateInput()` — SQL注入、XSS、安全红线检查
- ✅ `validateCommand()` — 命令注入检查
- ✅ `executeWithProtection()` — 超时控制、资源限制的执行包装
- ✅ 审计日志：`logAudit()`, `getAuditLogs()`
- ✅ 资源限制检查：`resourceLimitCheck()`

**待完善：**
- ⚠️ ToolExecutor 中 `registerCodeGeneratorTool()` 未调用 SecurityGuard 进行代码安全检查
- ⚠️ `code_analyzer` 工具未集成 SecurityGuard 的安全分析
- ⚠️ 缺少对生成代码的自动沙箱检查流程

### ToolExecutor (`src/tools/ToolExecutor.ts`)

**当前集成状态：**
- ✅ `execute()` 方法已集成 SecurityGuard：`validateInput()` + `validateCommand()` + `executeWithProtection()`
- ❌ `registerCodeGeneratorTool()` 仍为硬编码模板，未使用 CodeGeneratorSkill
- ❌ `registerCodeAnalyzerTool()` 有独立的安全分析逻辑，未复用 SecurityGuard

---

## 实施步骤

### 步骤 1：CodeGeneratorSkill 完善 — 集成到 SkillRegistry

**目标：** 让 CodeGeneratorSkill 成为正式注册的技能，可被 Agent 调用

**操作：**
1. 在 `src/skills/SkillRegistry.ts` 中注册 `code_generator` 技能
2. 修改 `src/skills/SkillBridge.ts` 支持 CodeGeneratorSkill 的调用协议
3. 确保 CodeGeneratorSkill 接收 LLMProvider 实例（通过构造函数注入）

**验证：**
- SkillRegistry 能列出 `code_generator` 技能
- SkillBridge 能正确调用 `generateCode()` 方法

### 步骤 2：ToolExecutor 重构 — `code_generator` 工具使用 CodeGeneratorSkill

**目标：** 替换 ToolExecutor 中硬编码的代码生成逻辑

**操作：**
1. 修改 `ToolExecutor` 构造函数，接收 `CodeGeneratorSkill` 实例（或 LLMProvider 实例用于创建）
2. 重写 `registerCodeGeneratorTool()` 的 `execute` 方法：
   - 调用 `codeGeneratorSkill.generateCode()` 替代硬编码模板
   - 调用 `codeGeneratorSkill.analyzeCode()` 对生成代码进行质量检查
   - 调用 `securityGuard.sandboxCheck()` 对生成代码进行安全检查
3. 保留原有接口（参数不变），内部实现替换为真实逻辑

**验证：**
- `code_generator` 工具返回 LLM 生成的代码（非模板）
- 生成代码包含类型定义和注释
- 安全检查拦截危险代码

### 步骤 3：ToolExecutor 重构 — `code_analyzer` 工具复用 SecurityGuard

**目标：** 统一安全分析逻辑，避免重复实现

**操作：**
1. 修改 `registerCodeAnalyzerTool()` 的 `execute` 方法：
   - 在 AST 分析后，调用 `securityGuard.sandboxCheck()` 进行代码安全扫描
   - 复用 `performSecurityAnalysis()` 的结果（已存在，保持现状）
   - 将 SecurityGuard 的审计日志与工具调用日志关联

**验证：**
- `code_analyzer` 工具报告包含 SecurityGuard 的安全检查结果
- 危险代码被正确标记

### 步骤 4：SecurityGuard 增强 — 代码生成场景专用检查

**目标：** 针对 AI 生成代码的特点，增强安全检查

**操作：**
1. 在 `SecurityGuard` 中新增 `validateGeneratedCode()` 方法：
   - 检查生成代码的完整性（是否有未完成的函数、缺少闭合括号）
   - 检查是否包含幻觉 API（调用不存在的函数/模块）
   - 检查是否有硬编码的敏感信息（密码、密钥、token）
2. 在 `sandboxCheck()` 中增加对生成代码常见问题的检测：
   - 未处理的 Promise
   - 缺少错误处理
   - 潜在的无限递归

**验证：**
- 不完整的生成代码被标记为警告
- 包含硬编码密钥的代码被拦截

### 步骤 5：端到端集成测试

**目标：** 验证完整流程：用户请求 → Agent 调用 → CodeGeneratorSkill 生成 → SecurityGuard 检查 → 返回结果

**测试用例：**
1. **正常代码生成：** "生成一个 TypeScript 函数，计算斐波那契数列"
   - 期望：返回完整的、可运行的 TypeScript 函数
2. **危险代码拦截：** 请求生成包含 `eval(userInput)` 的代码
   - 期望：SecurityGuard 拦截，返回错误
3. **代码分析：** 提交包含 `console.log` 和过长行的代码
   - 期望：分析结果包含对应警告
4. **代码修复：** 提交有语法错误的代码
   - 期望：返回修复后的代码
5. **权限控制：** guest 用户请求执行 `run_command` 工具
   - 期望：permissionCheck 拒绝

### 步骤 6：编译验证

**目标：** 确保所有修改通过 TypeScript 编译

**操作：**
1. 运行 `npm run build:fast`
2. 修复所有类型错误
3. 运行 `npm run lint`
4. 修复所有 lint 错误

---

## 文件修改清单

| 文件 | 修改类型 | 修改内容 |
|------|---------|---------|
| `src/skills/CodeGeneratorSkill.ts` | 增强 | 添加 `validateGeneratedCode()` 方法，完善 JSDoc |
| `src/skills/SkillRegistry.ts` | 修改 | 注册 `code_generator` 技能 |
| `src/skills/SkillBridge.ts` | 修改 | 支持 CodeGeneratorSkill 调用协议 |
| `src/tools/ToolExecutor.ts` | 重构 | `registerCodeGeneratorTool()` 使用 CodeGeneratorSkill |
| `src/tools/ToolExecutor.ts` | 增强 | `registerCodeAnalyzerTool()` 集成 SecurityGuard.sandboxCheck |
| `src/security/SecurityGuard.ts` | 增强 | 添加 `validateGeneratedCode()` 方法 |
| `src/core/JiabaixingCore.ts` | 修改 | 初始化时注入 CodeGeneratorSkill 到 ToolExecutor |

---

## 验收标准

### CodeGeneratorSkill
- [ ] `code_generator` 工具返回 LLM 生成的真实代码（非硬编码模板）
- [ ] 支持 TypeScript、Python、Java、Go 等语言
- [ ] 生成代码包含必要的类型定义和注释
- [ ] LLM 不可用时优雅降级到模板生成
- [ ] 代码分析能识别语法错误和风格问题
- [ ] 代码修复能自动修复常见错误

### SecurityGuard
- [ ] 沙箱检查能识别危险代码模式（eval、child_process 等）
- [ ] 权限检查基于用户角色进行校验（admin/developer/user/guest）
- [ ] ToolExecutor 执行 `code_generator` 前自动进行安全检查
- [ ] 生成代码中的硬编码敏感信息被检测并警告
- [ ] 安全事件被记录到审计日志
- [ ] 审计日志支持按用户/资源/时间查询

### 集成
- [ ] Agent 能通过自然语言请求触发代码生成
- [ ] 生成的代码经过 SecurityGuard 检查后才返回给用户
- [ ] 危险代码生成请求被拦截并给出明确原因
- [ ] 所有修改通过 TypeScript 编译和 ESLint 检查

---

## 风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| LLM 服务不可用 | 代码生成功能降级为模板 | 已实现 `generateFallbackCode()` 降级机制 |
| SecurityGuard 误报 | 正常代码被拦截 | 区分 error 和 warning，warning 不阻止执行 |
| ToolExecutor 接口变更 | 影响其他工具 | 保持 `code_generator` 工具参数不变，仅修改内部实现 |
| 性能问题 | LLM 调用延迟高 | 已有超时控制（30s），支持异步执行 |

---

## 实施顺序

| 步骤 | 任务 | 依赖 |
|------|------|------|
| 1 | CodeGeneratorSkill 完善（添加 validateGeneratedCode） | 无 |
| 2 | SecurityGuard 增强（添加 validateGeneratedCode） | 无 |
| 3 | SkillRegistry 注册 code_generator 技能 | 步骤 1 |
| 4 | ToolExecutor 重构 code_generator 工具 | 步骤 1, 2 |
| 5 | ToolExecutor 增强 code_analyzer 工具 | 步骤 2 |
| 6 | JiabaixingCore 初始化注入 | 步骤 3, 4 |
| 7 | 编译验证并测试 | 全部 |
