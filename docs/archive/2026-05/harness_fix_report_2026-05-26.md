# Harness 六层架构债务修复报告

## 修复时间

2026-05-26

## P0 优先级 (最高)

### ✅ P0-1: Executor.ts 生命周期钩子注入

**文件**: `src/harness/loop/Executor.ts`

**修复内容**:

- 在工具调用链路中注入 `BEFORE_TOOL_CALL` 钩子，允许在执行前修改参数或拦截调用
- 在工具调用成功后注入 `AFTER_TOOL_CALL` 钩子，允许替换结果
- 在工具调用失败时注入 `ON_ERROR` 钩子
- 所有钩子调用 `this.deps.constraintsService?.executeHooks()`

**相关文件修改**:

- `src/harness/AgentHarness.ts`: 添加 `constraintsService` 传递到 Executor

---

### ✅ P0-2: bootstrap persistenceDeps 方法签名兼容性

**文件**: `src/server/bootstrap.ts`

**修复内容**:

- 修复 `memoryEngine.preciseHybridRetrieval` 返回类型转换，MemoryItem.content 类型兼容
- 修复 `storeFeedbackSignal` 调用签名，传递完整 data 对象而非散列参数
- 修复 `userProfile.getData()` 改为 `userProfile.toJSON()`，并添加类型转换

---

## P1 优先级 (高)

### ✅ P1-3: T层工具执行器 stub 接入真实后端

**文件**: `src/server/bootstrap.ts`

**修复内容**:

- `analyzeCode`: 从返回模拟数据改为调用真实 LLM 进行代码分析
- `web_search`: httpClient 已可用，会降级使用 DuckDuckGo HTML 搜索
- `generateCode`, `fixCode`: 已经使用真实 LLM

---

### ✅ P1-4: E层单轮循环改为多轮迭代

**文件**: `src/harness/loop/LoopController.ts`

**修复内容**:

- 将 Plan-Execute-Evaluate 单轮流程改为 while 循环
- 根据 Evaluator 的 `suggestedAction` 决定循环行为:
  - `continue`: 目标达成或进展缓慢时结束
  - `replan`: 触发重新规划
  - `abort`: 主动中止
- 添加 `MAX_REPLAN_COUNT = 2` 限制重新规划次数
- 预算检查在每轮迭代前执行
- 添加 `ON_STEP_COMPLETED` 钩子

---

## P2 优先级 (中)

### ✅ P2-5: L层行为约束实现

**文件**: `src/harness/constraints/ConstraintsService.ts`

**修复内容**:
实现 `enforceBehaviorConstraint` 实际检查逻辑:

- `no-unbounded-recursion`: 检查递归深度限制
- `no-unauthorized-file-access`: 检查禁止访问的系统目录
- `no-sensitive-data-leak`: 检查输出中的敏感信息模式
- `no-dangerous-commands`: 检测危险命令 (rm -rf, drop table 等)
- `resource-limit-check`: 检查内存和 CPU 时间限制

---

### ✅ P2-6: V层敏感信息检测扩展

**文件**: `src/harness/verification/VerificationService.ts`

**修复内容**:
扩展 `checkOutputSafety` 敏感信息检测模式:

**金融类**:

- 银行卡号 (16-19位)
- 身份证号 (18位)
- 社保号 (10-12位)

**认证凭据**:

- 密码/密钥泄露 (password, pwd, passwd, secret, 密钥)
- API Key/Token 泄露
- 认证头泄露 (bearer, basic)

**通信联系方式**:

- 手机号码 (1[3-9]开头的11位)
- 邮箱地址

**网络标识**:

- IPv4 地址

**其他**:

- 家庭/公司地址和电话
- 医疗记录号

**风险等级**:

- critical: 密钥/Token 泄露
- high: 密码、身份证、医疗信息
- medium: 手机号、邮箱、地址
- low: IP 地址

**脱敏功能**: 自动替换检测到的敏感信息为 `[类型-已脱敏]`

---

## P3 优先级 (低)

### ✅ P3-7: Token 估算改进

**文件**: `src/harness/loop/Executor.ts`

**修复内容**:
改进 `estimateMessagesTokens` 方法，区分不同文本类型:

| 类型 | 字符/Token |
| ---- | ---------- |
| 中文 | 2 ≈ 1      |
| 英文 | 4 ≈ 1      |
| 代码 | 4 ≈ 1      |
| 标点 | 3 ≈ 1      |

新增 `countTokens` 方法:

- 识别代码块 (``` 包裹的内容)
- 识别中文字符 (CJK Unicode 范围)
- 识别英文字母和数字
- 识别代码符号

---

### ✅ P3-8: AgentHarness 默认配置全开

**文件**: `src/harness/AgentHarness.ts`

**修复内容**:

- 默认配置从全部关闭改为全部开启
- 新增 `getEnvConfig()` 函数，从环境变量读取配置:
  - `HARNESS_LOOP`
  - `HARNESS_TOOLS`
  - `HARNESS_CONTEXT`
  - `HARNESS_VERIFICATION`
  - `HARNESS_CONSTRAINTS`
  - `HARNESS_PERSISTENCE`
  - `HARNESS_TRAJECTORY`
  - `HARNESS_EVALUATOR`
- 配置优先级: 环境变量 > 构造函数参数 > 默认值

---

## 编译验证

所有修改已通过 `npx tsc --noEmit` 编译检查，无错误。

---

## 后续建议

1. **测试覆盖**: 建议为新增的约束检查和敏感信息检测添加单元测试
2. **配置文档**: 建议在文档中说明新的环境变量配置选项
3. **监控**: 建议在生产环境中监控钩子拦截率和敏感信息检测触发次数
4. **性能**: Token 估算改进后，建议在实际使用中验证估算准确性
