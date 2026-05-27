# CodeGeneratorSkill 与 SecurityGuard 优化计划

## 概述

本计划针对 jiabaixing 系统中两个核心模块进行优化：
1. **CodeGeneratorSkill** — 从占位实现升级为真正的智能代码生成技能
2. **SecurityGuard** — 实现代码沙箱检查和权限校验的真实逻辑

---

## 第一部分：CodeGeneratorSkill 优化

### 当前问题
- `generateTypeScriptCode` / `generatePythonCode` 等方法返回硬编码模板，包含 `TODO: 实现核心逻辑`
- 未集成 LLM，无法根据需求描述生成有意义的代码
- 缺乏代码分析、修复等高级功能

### 优化目标
实现真正的智能代码生成，支持：
1. 基于 LLM 的代码生成（替代硬编码模板）
2. 代码语法检查和风格建议
3. 常见错误的自动修复
4. 多语言支持增强

### 实现步骤

#### 步骤 1：集成 LLM 生成代码

**修改 `generateCode` 方法**：
- 调用 `LLMProvider` 根据需求描述生成代码
- 使用结构化 prompt 引导 LLM 生成高质量代码
- 支持指定语言、框架、测试等要求

**Prompt 模板设计**：
```
你是一名资深软件工程师。请根据以下需求生成代码：

需求：{requirements}
语言：{language}
框架：{framework}
要求：
1. 代码完整可运行
2. 包含必要的类型定义和注释
3. 遵循最佳实践
4. {includeTests ? '包含单元测试' : ''}

请直接输出代码，不要包含解释。
```

#### 步骤 2：实现代码分析功能

**新增 `analyzeCode` 方法**：
- 调用 LLM 分析代码质量
- 检查语法错误、风格问题
- 提供改进建议

**分析维度**：
- 语法正确性
- 代码风格（命名、缩进、注释）
- 潜在 Bug（空指针、资源泄漏）
- 性能问题
- 安全漏洞

#### 步骤 3：实现代码修复功能

**新增 `fixCode` 方法**：
- 接收代码和错误描述
- 调用 LLM 生成修复后的代码
- 支持常见错误类型：语法错误、类型错误、逻辑错误

#### 步骤 4：增强多语言支持

**新增语言支持**：
- Go、C++、C#、Ruby、PHP
- 每种语言有专门的 prompt 模板
- 支持语言特定的最佳实践

### 接口扩展

```typescript
interface CodeAnalysisResult {
  issues: Array<{
    type: 'error' | 'warning' | 'suggestion';
    line?: number;
    message: string;
    fix?: string;
  }>;
  score: number; // 0-100 代码质量评分
}

interface CodeFixResult {
  original: string;
  fixed: string;
  changes: Array<{
    type: string;
    description: string;
  }>;
}
```

---

## 第二部分：SecurityGuard 优化

### 当前问题
- `sandboxCheck` 方法为空实现，仅返回 `valid: true`
- `permissionCheck` 方法默认允许所有操作
- 缺乏真正的代码沙箱执行环境

### 优化目标
实现真正的安全防护：
1. 代码沙箱检查（危险代码识别）
2. 基于角色的权限校验
3. 资源使用限制
4. 安全事件审计日志

### 实现步骤

#### 步骤 1：实现代码沙箱检查

**危险代码识别**：
- 检查危险 API 调用（`eval`、`Function`、`exec`、`system`）
- 检查无限循环风险（`while(true)` 无退出条件）
- 检查内存泄漏风险（全局变量、闭包泄漏）
- 检查网络请求（未授权的外部调用）
- 检查文件系统操作（未授权的文件读写）

**实现方式**：
```typescript
private dangerousPatterns: Record<string, RegExp[]> = {
  eval: [/eval\s*\(/, /new\s+Function\s*\(/, /setTimeout\s*\(\s*["']/, /setInterval\s*\(\s*["']/],
  network: [/fetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /navigator\.sendBeacon/],
  filesystem: [/fs\./, /require\s*\(\s*["']fs["']\)/, /readFile/, /writeFile/],
  infinite_loop: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
};
```

#### 步骤 2：实现权限校验逻辑

**基于角色的权限系统**：
- 定义角色：admin、developer、user、guest
- 每个角色有权限列表
- 支持资源级别的访问控制

**权限配置**：
```typescript
interface PermissionConfig {
  roles: Record<string, string[]>;
  resources: Record<string, {
    allowedRoles: string[];
    allowedActions: string[];
  }>;
}
```

#### 步骤 3：集成到 ToolExecutor

**修改工具执行流程**：
1. 执行前：调用 `sandboxCheck` 检查代码安全性
2. 执行中：调用 `executeWithProtection` 应用超时和资源限制
3. 执行后：记录安全审计日志

#### 步骤 4：安全事件审计

**审计日志**：
- 记录所有安全检查事件
- 记录权限校验失败事件
- 记录资源超限事件
- 支持日志导出和分析

---

## 实施顺序

| 步骤 | 任务 | 预计工时 | 依赖 |
|------|------|---------|------|
| 1 | CodeGeneratorSkill: 集成 LLM 生成代码 | 2h | LLMProvider |
| 2 | CodeGeneratorSkill: 实现代码分析 | 1.5h | LLMProvider |
| 3 | CodeGeneratorSkill: 实现代码修复 | 1.5h | LLMProvider |
| 4 | SecurityGuard: 实现沙箱检查 | 2h | 无 |
| 5 | SecurityGuard: 实现权限校验 | 1.5h | 无 |
| 6 | SecurityGuard: 集成到 ToolExecutor | 1h | ToolExecutor |
| 7 | 编译验证并测试 | 1h | 全部 |

**总计**：约 10.5 工时（1.5 天）

---

## 验收标准

### CodeGeneratorSkill
- [ ] 根据需求描述生成可运行的代码（非模板）
- [ ] 支持 TypeScript、Python、Java、Go 等语言
- [ ] 代码分析能识别语法错误和风格问题
- [ ] 代码修复能自动修复常见错误
- [ ] 生成代码包含必要的注释和类型定义

### SecurityGuard
- [ ] 沙箱检查能识别危险代码模式
- [ ] 权限检查基于用户角色进行校验
- [ ] 资源限制能阻止超限操作
- [ ] 安全事件被记录到审计日志
- [ ] ToolExecutor 执行前自动进行安全检查
