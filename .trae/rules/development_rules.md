# Jiabaixing 开发规则

## 核心原则

### 1. 不重复造轮子

- **优先使用现有组件**：在开发新功能前，必须先检查现有代码库是否已有类似功能
- **复用优于重写**：优先扩展现有组件，而不是创建新组件
- **统一架构**：新功能必须遵循现有架构模式，不创建独立的子系统

### 2. 直接集成到系统

- **禁止独立组件**：不允许创建独立的、未集成的组件文件
- **立即集成**：写完代码后必须立即集成到现有系统中
- **端到端验证**：集成后必须验证从用户输入到系统输出的完整流程

### 3. 测试必须100%通过

- **测试先行**：开发前先写测试用例
- **测试覆盖**：所有新功能必须有对应的测试
- **测试通过**：代码提交前所有测试必须100%通过
- **回归测试**：修改现有代码后必须运行完整测试套件

---

## 代码编写规则

### 1. 代码审查清单

在编写任何代码前，必须回答以下问题：

- [ ] 现有代码库中是否已有类似功能？
- [ ] 能否通过扩展现有组件实现需求？
- [ ] 新代码如何集成到现有系统？
- [ ] 是否有对应的测试用例？
- [ ] 测试是否能100%通过？

### 2. 开发流程

#### 步骤1: 需求分析

- 明确功能需求
- 检查现有代码库
- 确定最优实现方案

#### 步骤2: 设计方案

- 基于现有架构设计
- 避免创建新组件
- 规划集成点

#### 步骤3: 编写测试

- 先写测试用例
- 确保测试可运行
- 测试应该失败（因为功能未实现）

#### 步骤4: 实现功能

- 修改现有文件
- 避免创建新文件
- 确保代码风格一致

#### 步骤5: 集成验证

- 运行测试
- 确保测试100%通过
- 验证端到端流程

#### 步骤6: 代码提交

- 所有测试通过
- 代码审查通过
- 文档更新完成

### 3. 禁止行为

❌ **禁止创建独立的、未集成的组件**

- 错误示例：创建 `src/optimization/` 目录，包含多个独立组件
- 正确做法：直接修改 `src/models/LLMProvider.ts` 等现有文件

❌ **禁止重复实现已有功能**

- 错误示例：创建新的缓存系统，而系统已有缓存机制
- 正确做法：检查并扩展现有缓存功能

❌ **禁止提交未测试的代码**

- 错误示例：写完代码不测试就提交
- 正确做法：确保所有测试100%通过后再提交

❌ **禁止创建无用的文档**

- 错误示例：创建大量文档但代码未集成
- 正确做法：代码集成后再更新文档

---

## 测试规则

### 1. 测试要求

- **测试覆盖率**: 新功能测试覆盖率必须达到100%
- **测试通过率**: 所有测试必须100%通过
- **回归测试**: 修改现有代码后必须运行完整测试套件
- **性能测试**: 性能相关功能必须有性能测试

### 2. 测试类型

#### 单元测试

- 测试单个函数/方法
- 模拟外部依赖
- 快速执行（<1秒）

#### 集成测试

- 测试组件间的交互
- 使用真实依赖
- 验证完整流程

#### 端到端测试

- 模拟用户操作
- 验证系统输出
- 测试关键路径

### 3. 测试执行

#### Python 侧测试（核心 AI 逻辑）

```bash
# 运行全部 Python 测试（必须使用 Python 3.13）
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/ -v

# 运行特定模块测试
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/test_llm.py -v
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/test_memory.py -v
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/test_core_loop.py -v

# 运行特定测试用例（-k 关键字过滤）
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/ -k "test_credential" -v

# 运行测试并显示详细输出
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/ -v --tb=long

# 运行测试并生成覆盖率报告
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/ --cov=agent --cov-report=term-missing
```

**Python 测试文件对应关系**：

| 测试文件                   | 覆盖模块                                   | Phase   |
| -------------------------- | ------------------------------------------ | ------- |
| test_api.py                | API 基础端点                               | Phase 0 |
| test_llm.py                | LLM Provider/Cache/Queue/Router            | Phase 1 |
| test_memory.py             | Memory Engine/Store/Tokenizer              | Phase 2 |
| test_loop.py               | Loop Controller/Planner/Executor/Evaluator | Phase 3 |
| test_evolution.py          | Evolution Engine                           | Phase 4 |
| test_phase5.py             | Skill/Cron/Session                         | Phase 5 |
| test_phase6.py             | Context/Persona/Security                   | Phase 6 |
| test_phase7.py             | Tool Registry                              | Phase 7 |
| test_phase8_e2e.py         | 端到端集成                                 | Phase 8 |
| test_core_loop.py          | ConversationLoop/Compressor/Curator        | Phase 9 |
| test_p1_credential_cost.py | CredentialPool/CostGuard/PromptCache       | P1      |

#### TypeScript 侧测试（前端/IDE 集成）

```bash
# 运行所有 TS 测试
npm test

# 运行特定测试
npm test -- --grep "LLMProvider"

# 运行测试并生成覆盖率报告
npm test -- --coverage

# 运行测试并监听文件变化
npm test -- --watch
```

#### 混合架构测试（TS ↔ Python Bridge）

```bash
# 1. 启动 Python Agent 后端
cd python
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m uvicorn agent.main:app --port 8765

# 2. 设置环境变量切换到 Python 后端
$env:AGENT_BACKEND = "python"
$env:PYTHON_AGENT_URL = "http://localhost:8765"

# 3. 启动 TS 服务并验证 Bridge 通信
npm start
```

### 4. 测试编写规范

#### Python 测试规范

- **测试文件命名**: `test_<模块名>.py`，放在 `python/tests/` 目录
- **测试类命名**: `Test<功能名>`，如 `TestCredentialPool`、`TestPromptCacheManager`
- **测试方法命名**: `test_<行为描述>`，如 `test_round_robin_rotates`、`test_exact_hit`
- **数据库隔离**: 涉及 SQLite 的测试必须使用独立临时数据库，避免测试间数据残留

  ```python
  import tempfile, os, time

  class TestPromptCacheManager:
      _db_counter = 0

      def _make_manager(self, ...):
          TestPromptCacheManager._db_counter += 1
          tmpdir = os.path.join(tempfile.gettempdir(), "jbx_pcache_test")
          os.makedirs(tmpdir, exist_ok=True)
          db_path = os.path.join(tmpdir, f"cache_{TestPromptCacheManager._db_counter}_{int(time.time()*1000)}.db")
          store = PromptCacheStore(db_path)
          ...
  ```

- **资源清理**: 测试结束前必须关闭数据库连接，避免 `PermissionError`
  ```python
  def test_with_database():
      store = PromptCacheStore(db_path)
      # ... 测试逻辑 ...
      store.close()  # 必须显式关闭
  ```
- **异步测试**: 使用 `pytest.mark.asyncio` 装饰器
  ```python
  @pytest.mark.asyncio
  async def test_async_function():
      result = await some_async_operation()
      assert result is not None
  ```

#### TypeScript 测试规范

- **测试文件命名**: `<模块名>.test.ts`，放在对应模块的 `__tests__/` 目录
- **测试框架**: Jest
- **Mock 外部依赖**: 使用 `jest.mock()` 模拟 API 调用

### 5. 测试失败处理

- 测试失败时，禁止提交代码
- 必须修复所有失败的测试
- 如果测试本身有问题，先修复测试再提交
- **Python 测试数据库残留问题**：若出现缓存命中异常，检查是否复用了同一数据库文件
- **Windows 文件锁问题**：若出现 `PermissionError [WinError 32]`，确保测试中显式关闭了数据库连接

---

## 集成规则

### 1. 集成要求

- **立即集成**: 代码写完后立即集成到系统
- **端到端验证**: 验证从用户输入到系统输出的完整流程
- **向后兼容**: 确保不破坏现有功能

### 2. 集成检查清单

- [ ] 代码已修改现有文件
- [ ] 所有测试通过
- [ ] 端到端流程验证通过
- [ ] 现有功能未受影响
- [ ] 文档已更新

### 3. 集成验证

#### Python 侧集成验证

```bash
# 运行完整 Python 测试套件
cd c:\zy\jiabaixing\python
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m pytest tests/ -v

# 启动 Python Agent 服务
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m uvicorn agent.main:app --port 8765 --reload

# 验证健康检查
Invoke-RestMethod http://localhost:8765/health
```

#### TypeScript 侧集成验证

```bash
# 运行完整 TS 测试套件
npm test

# 运行集成测试
npm run test:integration

# 运行端到端测试
npm run test:e2e

# 启动系统验证
npm start
```

#### 混合架构集成验证

```bash
# 1. 启动 Python 后端
cd c:\zy\jiabaixing\python
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" -m uvicorn agent.main:app --port 8765

# 2. 设置环境变量
$env:AGENT_BACKEND = "python"
$env:PYTHON_AGENT_URL = "http://localhost:8765"

# 3. 启动 TS 前端
cd c:\zy\jiabaixing
npm start

# 4. 验证 Bridge 通信
# 在浏览器访问 http://localhost:3000/api/ide/sessions
# 或通过 ACP 协议发送聊天请求
```

### 4. 混合架构模块归属

| 层                       | 语言       | 模块                                      | 说明                               |
| ------------------------ | ---------- | ----------------------------------------- | ---------------------------------- |
| 前端/IDE                 | TypeScript | React + Electron + ACP                    | 用户界面                           |
| HTTP/WS 入口             | TypeScript | Express + WebSocket                       | 请求路由                           |
| Bridge                   | TypeScript | PythonAgentBridge                         | TS ↔ Python 通信                   |
| LLM                      | Python     | agent/llm/                                | litellm + 缓存 + 凭据池 + 成本守卫 |
| Memory                   | Python     | agent/memory/                             | SQLite FTS5 + jieba + 策展人       |
| Loop                     | Python     | agent/loop/ + agent/core/                 | FC 循环 + 上下文压缩               |
| Evolution                | Python     | agent/evolution/                          | V1+V2 合并引擎                     |
| Skill/Cron/Session       | Python     | agent/skills/ + scheduler/ + persistence/ | 技能/定时/会话                     |
| Context/Persona/Security | Python     | agent/core/                               | 上下文管道/人格/安全               |
| Gateway                  | Python     | agent/gateway/                            | 多平台适配器                       |
| Transport                | Python     | agent/llm/transports.py                   | 多 LLM 协议适配                    |
| 桌面自动化               | TypeScript | nut.js/playwright                         | Node.js 原生                       |
| 文件/系统工具            | TypeScript | harness/tools/                            | Node.js 文件系统                   |

---

## 性能优化规则

### 1. 优化原则

- **先测量后优化**: 使用性能分析工具找出瓶颈
- **优先优化热点**: 优化最耗时的部分
- **避免过早优化**: 不要在开发早期过度优化

### 2. 优化流程

#### 步骤1: 性能分析

- 运行性能测试
- 识别性能瓶颈
- 确定优化目标

#### 步骤2: 优化实现

- 修改现有代码
- 避免创建新组件
- 保持代码简洁

#### 步骤3: 效果验证

- 运行性能测试
- 对比优化前后
- 确保功能正常

### 3. 优化检查清单

- [ ] 已进行性能分析
- [ ] 已识别性能瓶颈
- [ ] 优化已集成到现有代码
- [ ] 性能测试通过
- [ ] 功能测试通过
- [ ] 现有功能未受影响

---

## 错误处理规则

### 1. 错误处理原则

- **所有错误必须处理**: 不允许忽略错误
- **错误必须记录**: 使用Logger记录所有错误
- **错误必须友好**: 向用户提供清晰的错误信息

### 2. 错误处理模式

```typescript
try {
  const result = await someOperation();
  return result;
} catch (error) {
  Logger.error('操作失败', error as Error, 'ComponentName');
  throw new Error(`操作失败: ${(error as Error).message}`);
}
```

---

## 代码风格规则

### 1. 命名规范

- **类名**: PascalCase (e.g., `LLMProvider`)
- **方法名**: camelCase (e.g., `generateResponse`)
- **常量**: UPPER_SNAKE_CASE (e.g., `MAX_RETRIES`)
- **私有成员**: 下划线前缀 (e.g., `_privateMethod`)

### 2. 注释规范（强制执行）

**所有类、公共方法、函数、接口必须有文档注释，否则不得提交。**

#### 2.1 Python 注释规范

- **所有类**: 必须有 `"""..."""` 文档注释，说明用途、属性和使用示例
- **所有公共方法/函数**: 必须有 `"""..."""` 文档注释，包含参数说明、返回值说明和异常说明
- **私有方法**: 复杂逻辑的私有方法也需要注释
- **模块级常量**: 关键常量必须有行内注释说明含义
- **复杂逻辑**: 必须有行内注释解释

```python
class LLMProvider:
    """LLM提供者，管理多模型调用、缓存和容错。

    集成凭据池轮换、成本守卫、Prompt缓存和传输层适配。

    Attributes:
        _models: 已注册的模型实例映射。
        _credential_pool: API Key凭据池。
        _cost_guard: 成本守卫实例。

    Usage:
        provider = LLMProvider()
        response = await provider.chat("你好")
    """

    async def chat(self, prompt: str, system_prompt: str = "") -> str:
        """发送聊天请求并返回LLM响应。

        Args:
            prompt: 用户输入文本。
            system_prompt: 系统提示词。

        Returns:
            str: LLM生成的响应文本。

        Raises:
            LLMUnavailableError: 所有模型均不可用时抛出。
            CostExceededError: 超出预算限制时抛出。
        """
        ...
```

#### 2.2 数据类注释规范

```python
@dataclass
class TaskNode:
    """任务节点定义，描述一个待执行的任务单元。

    Attributes:
        id: 任务唯一标识。
        goal: 任务目标描述。
        dependencies: 依赖的任务ID列表。
        priority: 优先级（1-10，10最高）。
        status: 当前状态（pending / running / completed / failed）。
    """
    id: str = ""
    goal: str = ""
    dependencies: list[str] = field(default_factory=list)
    priority: int = 5
    status: str = "pending"
```

#### 2.3 TypeScript 注释规范

- **公共方法**: 必须有JSDoc注释
- **复杂逻辑**: 必须有行内注释
- **TODO标记**: 必须包含负责人和截止日期

```typescript
/**
 * 生成LLM响应
 * @param input - 输入文本
 * @param options - 生成选项
 * @returns 生成的响应文本
 * @throws {Error} 当LLM服务不可用时抛出错误
 */
public async generateResponse(input: string, options?: GenerateOptions): Promise<string> {
  // TODO: 优化prompt长度 - @张三 2026-05-20
  const optimizedPrompt = this.optimizePrompt(input);
  // ...
}
```

#### 2.4 注释检查清单

- [ ] 所有 class 有文档注释
- [ ] 所有 public 方法有文档注释（含 Args/Returns/Raises）
- [ ] 所有 @dataclass 有 Attributes 文档
- [ ] 所有 Enum 有用途说明
- [ ] 关键常量有行内注释

### 3. 代码组织

- **导入顺序**: 第三方库 -> 内部模块 -> 类型导入
- **类成员顺序**: 公共方法 -> 私有方法 -> 属性
- **文件长度**: 单个文件不超过500行

---

## 违规处理

### 1. 轻微违规

- **警告**: 提醒开发者注意规则
- **要求**: 修复问题后重新提交

### 2. 严重违规

- **拒绝**: 拒绝合并代码
- **要求**: 重新开发符合规则的代码

### 3. 重复违规

- **限制**: 限制提交权限
- **培训**: 要求重新学习开发规则

---

## 规则更新

- **定期审查**: 每月审查一次规则
- **团队讨论**: 重大修改需要团队讨论
- **版本控制**: 规则变更必须有版本记录

---

## 示例：正确 vs 错误

### 错误示例 ❌

```typescript
// 创建独立的优化组件
// src/optimization/StreamResponseHandler.ts
export class StreamResponseHandler {
  // ... 500行代码
}

// src/optimization/RequestQueueManager.ts
export class RequestQueueManager {
  // ... 400行代码
}

// 创建测试但未集成
// optimization-test.js
// 测试独立组件，但组件未集成到系统
```

**问题**:

- 创建了独立的组件
- 组件未集成到现有系统
- 测试无法验证真实效果
- 重复造轮子

### 正确示例 ✅

```typescript
// 直接修改现有文件
// src/models/LLMProvider.ts
export class LLMProvider {
  private responseCache: Map<string, { text: string; timestamp: number }> =
    new Map();
  private requestQueue: Array<() => Promise<string>> = [];
  private maxConcurrent: number = 3;

  async generateResponse(input: string): Promise<string> {
    const cacheKey = this.generateCacheKey(input);

    // 检查缓存
    const cached = this.responseCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 30000) {
      return cached.text;
    }

    // 加入队列
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const response = await this.model.generate({ prompt: input });
          const text = response.text;

          // 缓存结果
          this.responseCache.set(cacheKey, { text, timestamp: Date.now() });

          resolve(text);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    while (
      this.requestQueue.length > 0 &&
      this.activeRequests < this.maxConcurrent
    ) {
      const request = this.requestQueue.shift();
      if (request) {
        this.activeRequests++;
        request().finally(() => {
          this.activeRequests--;
          this.processQueue();
        });
      }
    }
  }
}

// 测试集成后的功能
// src/models/__tests__/LLMProvider.test.ts
describe('LLMProvider', () => {
  it('应该缓存响应结果', async () => {
    const provider = new LLMProvider();
    const input = '测试输入';

    const response1 = await provider.generateResponse(input);
    const response2 = await provider.generateResponse(input);

    expect(response1).toBe(response2);
  });

  it('应该限制并发请求数', async () => {
    const provider = new LLMProvider();
    const promises = Array(5)
      .fill(null)
      .map(() => provider.generateResponse('测试输入'));

    const responses = await Promise.all(promises);
    expect(responses).toHaveLength(5);
  });
});
```

**优点**:

- 直接修改现有文件
- 立即集成到系统
- 测试验证真实效果
- 避免重复造轮子

---

## 版本控制规则

### 1. Git 提交规范

- **提交信息格式**: `type(scope): subject`
  - `type`: feat, fix, docs, style, refactor, test, chore
  - `scope`: 影响的模块或功能
  - `subject`: 简短描述（不超过50字符）

```bash
# 正确示例
feat(llm): 添加响应缓存功能
fix(intent): 修复代码生成意图识别问题
docs(readme): 更新安装说明
test(cache): 添加缓存失效测试

# 错误示例
update code
fix bug
add feature
```

### 2. 分支管理

- **主分支**: `main` - 生产环境代码
- **开发分支**: `develop` - 开发环境代码
- **功能分支**: `feature/功能名` - 新功能开发
- **修复分支**: `fix/问题描述` - 问题修复
- **发布分支**: `release/版本号` - 发布准备

### 3. 合并规则

- **禁止直接推送到主分支**: 必须通过Pull Request
- **代码审查**: 所有代码必须经过至少一人审查
- **冲突解决**: 合并前必须解决所有冲突
- **测试通过**: 合并前所有测试必须通过

### 4. 版本号规范

遵循语义化版本 (Semantic Versioning): `MAJOR.MINOR.PATCH`

- **MAJOR**: 不兼容的API变更
- **MINOR**: 向后兼容的功能新增
- **PATCH**: 向后兼容的问题修复

---

## 代码审查规则

### 1. 审查清单

#### 功能性

- [ ] 代码实现了需求文档中的所有功能
- [ ] 边界条件和异常情况得到处理
- [ ] 没有明显的逻辑错误
- [ ] 性能满足要求

#### 代码质量

- [ ] 代码风格符合项目规范
- [ ] 变量和函数命名清晰准确
- [ ] 代码结构清晰，易于理解
- [ ] 没有重复代码
- [ ] 注释充分且准确

#### 测试

- [ ] 有足够的单元测试
- [ ] 测试覆盖率达到要求
- [ ] 所有测试通过
- [ ] 包含边界情况测试

#### 安全性

- [ ] 没有安全漏洞
- [ ] 敏感信息得到保护
- [ ] 输入验证充分
- [ ] 错误信息不泄露敏感数据

### 2. 审查流程

1. **自我审查**: 开发者提交前自我审查
2. **同行审查**: 至少一名同行开发者审查
3. **技术负责人审查**: 重大变更需要技术负责人审查
4. **审查反馈**: 提供具体的改进建议
5. **修改完善**: 根据反馈修改代码
6. **最终批准**: 审查通过后合并

### 3. 审查时间要求

- **简单变更**: 24小时内完成审查
- **中等变更**: 48小时内完成审查
- **复杂变更**: 72小时内完成审查
- **紧急修复**: 立即审查

---

## 文档编写规范

### 1. 文档类型

#### 技术文档

- **API文档**: 使用Swagger/OpenAPI规范
- **架构文档**: 包含系统架构图和组件说明
- **数据库文档**: 包含ER图和表结构说明
- **部署文档**: 包含部署步骤和环境要求

#### 用户文档

- **用户手册**: 包含功能说明和使用示例
- **安装指南**: 包含安装步骤和常见问题
- **故障排查**: 包含常见问题和解决方案
- **更新日志**: 记录版本变更和新功能

### 2. 文档编写原则

- **准确性**: 文档内容必须准确无误
- **完整性**: 覆盖所有重要功能和场景
- **清晰性**: 语言简洁明了，易于理解
- **及时性**: 代码变更后及时更新文档
- **可维护性**: 文档结构清晰，易于维护

### 3. 文档格式

````markdown
# 标题

## 功能描述

简要描述功能的作用和用途

## 使用方法

### 基本用法

```代码示例

```
````

### 高级用法

```代码示例

```

## 参数说明

| 参数名 | 类型   | 必填 | 说明     |
| ------ | ------ | ---- | -------- |
| param1 | string | 是   | 参数说明 |
| param2 | number | 否   | 参数说明 |

## 返回值

返回值的类型和说明

## 示例

完整的使用示例

## 注意事项

使用时需要注意的事项

## 常见问题

FAQ和解决方案

````

---

## 安全编码规范

### 1. 输入验证

- **所有用户输入必须验证**: 不信任任何用户输入
- **使用白名单验证**: 优先使用白名单而非黑名单
- **长度限制**: 限制输入长度防止缓冲区溢出
- **类型检查**: 验证输入数据的类型

```typescript
// 正确示例
function validateUserInput(input: string): boolean {
  if (!input || input.length > 1000) {
    return false;
  }

  const allowedChars = /^[a-zA-Z0-9\s\-_.,!?]+$/;
  return allowedChars.test(input);
}

// 错误示例
function processInput(input: string): void {
  // 直接使用用户输入，没有验证
  console.log(input);
}
````

### 2. 输出编码

- **HTML编码**: 防止XSS攻击
- **URL编码**: 防止URL注入
- **SQL参数化**: 防止SQL注入

```typescript
// 正确示例
import * as sanitizeHtml from 'sanitize-html';

function renderUserContent(content: string): string {
  return sanitizeHtml(content, {
    allowedTags: ['b', 'i', 'u', 'strong', 'em'],
    allowedAttributes: {},
  });
}

// 错误示例
function renderUserContent(content: string): string {
  return `<div>${content}</div>`; // XSS漏洞
}
```

### 3. 敏感信息保护

- **不记录敏感信息**: 日志中不包含密码、密钥等
- **加密存储**: 敏感数据必须加密存储
- **安全传输**: 使用HTTPS传输敏感数据
- **定期轮换**: 密钥和密码定期轮换

```typescript
// 正确示例
import * as crypto from 'crypto';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512');
  return `${salt}:${hash.toString('hex')}`;
}

// 错误示例
function storePassword(password: string): void {
  database.save({ password }); // 明文存储
}
```

### 4. 权限控制

- **最小权限原则**: 只授予必要的权限
- **权限验证**: 每个操作都要验证权限
- **会话管理**: 合理设置会话超时时间
- **审计日志**: 记录重要操作

```typescript
// 正确示例
async function deleteUser(userId: string, requester: User): Promise<void> {
  if (!requester.hasPermission('user.delete')) {
    throw new Error('权限不足');
  }

  await database.deleteUser(userId);
  Logger.info(`用户 ${requester.id} 删除了用户 ${userId}`, 'Audit');
}

// 错误示例
async function deleteUser(userId: string): Promise<void> {
  await database.deleteUser(userId); // 没有权限验证
}
```

---

## 依赖管理规则

### 1. 依赖选择原则

- **必要性**: 只添加必要的依赖
- **稳定性**: 选择稳定、维护良好的库
- **安全性**: 定期检查依赖的安全漏洞
- **性能**: 考虑依赖对性能的影响
- **许可证**: 确保依赖的许可证兼容

### 2. 依赖版本管理

- **锁定版本**: 使用package-lock.json锁定版本
- **版本范围**: 合理设置版本范围
- **定期更新**: 定期更新依赖到最新稳定版
- **兼容性测试**: 更新依赖后进行兼容性测试

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "lodash": "^4.17.21",
    "axios": "^1.6.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "jest": "^29.0.0"
  }
}
```

### 3. 依赖审查

- **定期审查**: 每月审查一次依赖
- **移除未使用依赖**: 删除不再使用的依赖
- **安全扫描**: 使用npm audit检查安全漏洞
- **许可证检查**: 确保所有依赖的许可证合规

```bash
# 检查安全漏洞
npm audit

# 检查过时的依赖
npm outdated

# 查看依赖树
npm ls

# 清理未使用的依赖
npm prune
```

---

## 部署流程规范

### 1. 部署前检查

- [ ] 所有测试通过
- [ ] 代码审查完成
- [ ] 文档更新完成
- [ ] 配置文件准备就绪
- [ ] 数据库迁移脚本准备
- [ ] 回滚方案准备

### 2. 部署步骤

#### 预部署

1. **备份**: 备份当前版本和数据库
2. **通知**: 通知相关人员部署计划
3. **准备**: 准备部署环境和配置

#### 部署

1. **停止服务**: 停止当前运行的服务
2. **更新代码**: 拉取最新代码
3. **安装依赖**: 安装/更新依赖包
4. **构建项目**: 构建生产版本
5. **数据库迁移**: 执行数据库迁移脚本
6. **启动服务**: 启动新版本服务
7. **健康检查**: 验证服务正常运行

#### 部署后

1. **监控**: 监控服务运行状态
2. **日志检查**: 检查错误日志
3. **性能验证**: 验证性能指标
4. **用户验证**: 验证关键功能正常

### 3. 回滚流程

1. **检测问题**: 发现严重问题立即决定回滚
2. **停止服务**: 停止当前服务
3. **恢复备份**: 恢复代码和数据库备份
4. **重启服务**: 重启之前版本的服务
5. **验证**: 验证服务恢复正常
6. **分析**: 分析问题原因，制定修复方案

---

## 问题排查指南

### 1. 常见问题类型

#### 性能问题

**症状**: 响应时间过长，CPU/内存占用高

**排查步骤**:

1. 使用性能分析工具识别瓶颈
2. 检查数据库查询是否优化
3. 检查是否有内存泄漏
4. 检查网络请求是否合理
5. 检查算法复杂度

**解决方案**:

- 优化数据库查询，添加索引
- 使用缓存减少重复计算
- 优化算法，降低复杂度
- 增加资源限制和监控

#### 内存问题

**症状**: 内存占用持续增长，最终崩溃

**排查步骤**:

1. 使用内存分析工具检查内存使用
2. 检查是否有未释放的资源
3. 检查是否有循环引用
4. 检查缓存策略是否合理

**解决方案**:

- 及时释放不再使用的资源
- 修复循环引用
- 优化缓存策略，设置过期时间
- 增加内存监控和告警

#### 并发问题

**症状**: 数据不一致，死锁，竞态条件

**排查步骤**:

1. 检查共享资源的访问
2. 检查锁的使用是否正确
3. 检查事务隔离级别
4. 检查是否有竞态条件

**解决方案**:

- 使用适当的锁机制
- 设置合理的事务隔离级别
- 使用原子操作
- 避免共享状态

### 2. 调试技巧

#### 日志记录

```typescript
// 分级日志
Logger.debug('详细调试信息', 'Component');
Logger.info('一般信息', 'Component');
Logger.warn('警告信息', 'Component');
Logger.error('错误信息', error, 'Component');

// 结构化日志
Logger.info('用户登录', 'Auth', {
  userId: user.id,
  timestamp: new Date().toISOString(),
  ip: request.ip,
});
```

#### 错误追踪

```typescript
// 使用try-catch捕获错误
try {
  await riskyOperation();
} catch (error) {
  Logger.error('操作失败', error as Error, 'Component');
  throw new Error(`操作失败: ${(error as Error).message}`);
}

// 使用finally清理资源
let resource = null;
try {
  resource = acquireResource();
  await useResource(resource);
} finally {
  if (resource) {
    releaseResource(resource);
  }
}
```

---

## 团队协作规则

### 1. 沟通规范

- **及时响应**: 工作时间内及时回复消息
- **清晰表达**: 沟通内容清晰明确
- **尊重他人**: 保持礼貌和专业
- **积极反馈**: 主动提供反馈和建议

### 2. 任务分配

- **明确责任**: 每个任务有明确的负责人
- **合理估算**: 准确估算任务时间和难度
- **及时更新**: 定期更新任务进度
- **遇到问题**: 及时报告问题和风险

### 3. 知识分享

- **代码评审**: 通过代码评审分享知识
- **技术分享**: 定期进行技术分享会
- **文档维护**: 维护技术文档和最佳实践
- **问题总结**: 总结问题和解决方案

### 4. 冲突解决

- **理性讨论**: 基于事实和数据进行讨论
- **寻求共识**: 努力达成共识
- **尊重决定**: 尊重团队最终决定
- **持续改进**: 从冲突中学习和改进

---

## 工具和脚本

### 1. 开发工具

- **IDE**: VS Code / WebStorm
- **版本控制**: Git
- **包管理**: npm / yarn
- **构建工具**: webpack / vite
- **测试框架**: jest / mocha
- **代码检查**: eslint / prettier
- **类型检查**: tsc

### 2. 常用脚本

```bash
# 开发相关
npm start              # 启动开发服务器
npm run build          # 构建生产版本
npm run test           # 运行测试
npm run lint           # 代码检查
npm run format         # 代码格式化

# Git相关
git status             # 查看状态
git add .              # 添加所有更改
git commit -m "msg"    # 提交更改
git push               # 推送到远程
git pull               # 拉取更新

# 调试相关
npm run debug          # 启动调试模式
npm run profile        # 性能分析
npm run coverage       # 测试覆盖率
```

### 3. 自动化脚本

```bash
# package.json
{
  "scripts": {
    "pre-commit": "npm run lint && npm run test",
    "pre-push": "npm run build && npm run test:e2e",
    "release": "npm version patch && npm run build && git push --tags",
    "clean": "rm -rf dist node_modules",
    "reset": "npm run clean && npm install"
  }
}
```

---

## AI 生产级代码开发规范（强制执行版）

> 所有 AI 生成的代码必须严格遵守本规范。违反规范的代码将被拒绝合并。

---

### 一、核心原则（最高优先级）

| 原则             | 说明                                                   |
| ---------------- | ------------------------------------------------------ |
| 可读性优先于一切 | 代码是写给人看的，其次才是给机器执行的                 |
| 安全第一         | 任何代码都必须首先考虑安全性，绝不生成有安全漏洞的代码 |
| 简单就是美       | 避免过度设计，用最简单的方案解决问题                   |
| 防御性编程       | 永远假设输入是恶意的，外部调用会失败                   |
| 可维护性         | 代码应该易于修改、扩展和调试                           |
| 可测试性         | 代码设计时就要考虑如何测试，避免不可测试的代码         |

---

### 二、代码风格与命名规范

#### 2.1 通用命名规则

- 使用 **英文** 命名，禁止使用拼音或混合语言
- 命名必须 **有意义**，能够准确描述变量/函数/类的用途
- 避免使用缩写，除非是行业通用缩写（如 ID、URL、HTTP）
- 保持命名风格的一致性，同一项目中不混用多种风格

#### 2.2 不同元素的命名规范

| 元素类型          | 命名风格         | 示例                                    |
| ----------------- | ---------------- | --------------------------------------- |
| 类名/接口名       | PascalCase       | `UserService`, `HttpRequestHandler`     |
| 方法名/函数名     | camelCase        | `getUserById`, `calculateTotalPrice`    |
| 变量名/参数名     | camelCase        | `userId`, `orderList`, `isActive`       |
| 常量名            | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT`    |
| 枚举值            | UPPER_SNAKE_CASE | `OrderStatus.PENDING`, `HttpMethod.GET` |
| 包名/模块名       | snake_case       | `user_service`, `data_processor`        |
| 数据库表名/字段名 | snake_case       | `users`, `order_items`, `created_at`    |

#### 2.3 代码格式规范

- 使用 **4 个空格**缩进，禁止使用制表符
- 每行代码长度不超过 **120 个字符**
- 运算符前后必须有空格：`a = b + c`，而不是 `a=b+c`
- 逗号后面必须有空格：`func(a, b, c)`，而不是 `func(a,b,c)`
- 左大括号不换行，右大括号单独一行
- 函数之间、逻辑块之间必须有空行分隔
- 导入语句按标准库、第三方库、本地库分组，组之间有空行

---

### 三、架构与设计规范

#### 3.1 分层架构要求

严格遵循分层架构，每层只能调用下一层的方法，禁止反向调用和跨层调用：

| 层         | 职责                                    |
| ---------- | --------------------------------------- |
| 表现层     | 处理 HTTP 请求/响应，参数校验，结果封装 |
| 业务逻辑层 | 实现核心业务逻辑，事务管理              |
| 数据访问层 | 与数据库交互，封装 CRUD 操作            |
| 基础设施层 | 提供通用功能（如日志、缓存、消息队列）  |

#### 3.2 设计原则

- **单一职责原则**: 一个类/函数只负责一件事
- **开闭原则**: 对扩展开放，对修改关闭
- **依赖倒置原则**: 依赖抽象，不依赖具体实现
- **接口隔离原则**: 使用小而专一的接口，不使用大而全的接口
- **里氏替换原则**: 子类可以替换父类而不影响程序正确性

#### 3.3 代码组织规范

- 按功能模块划分包/目录，而不是按技术层划分
- 每个模块内部再按技术层划分子目录
- 避免出现过大的类（超过 500 行）和过长的函数（超过 50 行）
- 提取公共代码到工具类，避免代码重复
- 使用依赖注入管理对象依赖，避免硬编码依赖

---

### 四、安全性规范（绝对强制执行）

#### 4.1 输入验证

- **所有外部输入必须验证**: 包括请求参数、路径变量、请求头、Cookie
- 使用**白名单验证**，而不是黑名单验证
- 验证数据类型、长度、格式和范围
- 对特殊字符进行转义或过滤
- 禁止将未验证的输入直接拼接到 SQL、命令行或 HTML 中

#### 4.2 防注入攻击

- **必须使用参数化查询**，禁止拼接 SQL 语句
- 使用 ORM 框架时，禁止使用原生 SQL 拼接
- 禁止使用 `eval()`、`exec()` 等执行动态代码的函数
- 对命令行参数进行严格验证和转义
- 对 XML 输入进行 XXE 防护

#### 4.3 认证与授权

- 所有需要认证的接口必须添加认证拦截器
- 实现基于角色的访问控制（RBAC）
- 敏感操作需要二次验证
- 密码必须使用强哈希算法（如 bcrypt）存储，禁止明文存储
- 实现会话管理和令牌过期机制

#### 4.4 其他安全要求

- 禁止在代码中硬编码敏感信息（如密码、密钥、令牌）
- 敏感信息在日志中必须脱敏
- 实现防止 CSRF 攻击的机制
- 实现防止暴力破解的机制（如限流、锁定）
- 定期更新依赖库，修复已知的安全漏洞

---

### 五、错误处理与日志规范

#### 5.1 错误处理原则

- **不要忽略任何异常**，至少要记录日志
- 使用异常处理错误，而不是返回码
- 捕获具体的异常类型，而不是捕获所有异常
- 在合适的层级处理异常，不要过度捕获
- 向用户返回友好的错误信息，不要暴露系统内部细节

#### 5.2 异常处理规范

- 自定义业务异常类，区分不同类型的业务错误
- 统一异常处理机制，使用全局异常处理器
- 异常信息应该包含：错误码、错误消息、上下文信息
- 在异常中包含足够的信息，便于问题定位
- 避免在循环中捕获异常

#### 5.3 日志规范

| 级别  | 用途                               |
| ----- | ---------------------------------- |
| DEBUG | 开发调试信息，生产环境关闭         |
| INFO  | 系统运行状态、重要操作记录         |
| WARN  | 警告信息，不影响系统运行但需要关注 |
| ERROR | 错误信息，影响系统正常运行         |
| FATAL | 致命错误，系统无法继续运行         |

- 使用结构化日志格式（如 JSON）
- 日志必须包含：时间戳、日志级别、线程名、类名、方法名、消息内容
- 敏感信息必须脱敏后再记录
- 避免在循环中打印大量日志

---

### 六、性能与可靠性规范

#### 6.1 数据库性能

- 为所有查询条件添加合适的索引
- 避免全表扫描，避免使用 `SELECT *`
- 批量操作代替循环单条操作
- 合理使用分页查询，避免查询大量数据
- 对热点数据使用缓存
- 避免长事务，事务范围尽可能小

#### 6.2 接口性能

- 接口响应时间原则上不超过 500ms
- 避免在接口中进行复杂计算或大量 IO 操作
- 使用异步处理非核心业务逻辑
- 实现接口限流机制，防止系统过载
- 避免重复调用相同的接口或查询相同的数据

#### 6.3 可靠性要求

- 实现重试机制，处理临时故障
- 实现熔断机制，防止故障扩散
- 实现降级机制，保证核心功能可用
- 关键操作必须有幂等性保证
- 实现健康检查接口，便于监控系统监控

---

### 七、测试规范

#### 7.1 单元测试要求

- 所有业务逻辑代码必须编写单元测试
- 单元测试覆盖率不低于 80%
- 测试用例应该覆盖正常情况、边界情况和异常情况
- 使用模拟对象隔离外部依赖
- 单元测试应该独立、可重复、快速执行

#### 7.2 集成测试要求

- 编写集成测试验证模块之间的交互
- 编写接口测试验证 API 的正确性
- 测试环境应该与生产环境尽可能一致
- 自动化测试应该集成到 CI/CD 流程中

#### 7.3 测试代码规范

- 测试代码也需要遵循代码风格规范
- 测试方法名应该清晰描述测试场景
- 每个测试方法只测试一个场景
- 使用断言验证结果，不要使用打印语句
- 测试数据应该在测试方法内部准备和清理

---

### 八、文档规范

#### 8.1 代码注释

- 注释应该解释 **"为什么"**，而不是 **"做什么"**
- 为所有公共类、公共方法添加文档注释
- 文档注释应该包含：功能描述、参数说明、返回值说明、异常说明
- 复杂的业务逻辑需要添加行内注释
- 及时更新注释，避免注释与代码不一致

#### 8.2 项目文档

- 项目必须有 README.md 文件，包含：项目介绍、环境要求、安装部署步骤、使用说明
- 编写 API 文档，使用 OpenAPI 规范
- 编写数据库设计文档
- 编写架构设计文档
- 编写部署运维文档

---

### 九、版本控制规范

- 提交信息必须清晰、有意义，使用 `类型：描述` 格式
- 提交类型包括：`feat`、`fix`、`docs`、`style`、`refactor`、`test`、`chore`
- 每次提交只做一件事，避免一次提交包含多个不相关的修改
- 禁止直接提交到主分支，使用分支开发、合并请求的方式
- 合并前必须进行代码审查
- 使用语义化版本号：主版本号.次版本号.修订号

---

### 十、AI 辅助开发特殊要求

| 要求                 | 说明                                     |
| -------------------- | ---------------------------------------- |
| 先理解需求再写代码   | 如果需求不明确，先询问清楚               |
| 先设计再编码         | 先给出整体设计思路和架构，再编写具体代码 |
| 生成完整可运行的代码 | 不要只生成代码片段                       |
| 添加必要的注释       | 为复杂逻辑添加注释                       |
| 说明代码的优缺点     | 如果有多种实现方案，说明各自的优缺点     |
| 指出潜在的问题       | 指出代码中可能存在的问题和风险           |
| 提供测试用例         | 为生成的代码提供对应的测试用例           |
| 遵循已有代码风格     | 如果有已有代码，遵循已有代码的风格和规范 |

---

### 十一、违规处理

#### 轻微违规

- **警告**: 提醒开发者注意规则
- **要求**: 修复问题后重新提交

#### 严重违规

- **拒绝**: 拒绝合并代码
- **要求**: 重新开发符合规则的代码

#### 重复违规

- **限制**: 限制提交权限
- **培训**: 要求重新学习开发规则

---

## 总结

### 核心原则

1. **不重复造轮子** - 优先使用和扩展现有组件
2. **立即集成** - 代码写完后立即集成到系统
3. **测试100%通过** - 所有测试必须通过才能提交
4. **端到端验证** - 验证完整的用户流程
5. **安全第一** - 始终考虑安全性
6. **团队协作** - 保持良好的团队沟通和协作
7. **可读性优先** - 代码是写给人看的
8. **防御性编程** - 永远假设输入是恶意的

### 开发流程

需求分析 → 检查现有代码 → 编写测试 → 实现功能 → 集成验证 → 代码审查 → 提交代码 → 部署上线

### 成功标准

- ✅ 所有测试100%通过
- ✅ 代码已集成到现有系统
- ✅ 端到端流程验证通过
- ✅ 现有功能未受影响
- ✅ 文档已更新
- ✅ 代码审查通过
- ✅ 安全检查通过
- ✅ 性能指标达标
- ✅ 命名规范符合标准
- ✅ 错误处理完整

### 持续改进

- **定期回顾**: 每月回顾开发流程和规则
- **收集反馈**: 收集团队成员的反馈意见
- **优化流程**: 根据反馈优化开发流程
- **更新规则**: 及时更新开发规则和最佳实践

---

**规则版本**: 3.0
**生效日期**: 2026-06-23
**维护者**: 开发团队
**最后更新**: 2026-06-23（新增 AI 生产级代码开发规范强制执行版 + 架构/安全/性能/测试/文档/版本控制规范）
