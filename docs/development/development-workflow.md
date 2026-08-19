# 开发流程指南

本文档定义了jiabaixing项目的开发流程，旨在帮助团队成员规范开发工作，提高开发效率。

## 目录

1. [环境准备](#环境准备)
2. [开发流程](#开发流程)
3. [代码规范](#代码规范)
4. [测试要求](#测试要求)
5. [提交规范](#提交规范)
6. [分支管理](#分支管理)
7. [代码审查](#代码审查)

## 环境准备

### 1. 安装Node.js

确保本地已安装Node.js 18+版本：

```bash
# 检查Node.js版本
node -v

# 检查npm版本
npm -v
```

### 2. 克隆代码

```bash
git clone <repository-url>
cd jiabaixing
```

### 3. 安装依赖

```bash
# 安装后端依赖
npm install

# 安装前端依赖
cd src/frontend
npm install
cd ../..
```

### 4. 配置环境变量

复制环境变量模板文件：

```bash
cp .env.example .env
```

根据本地环境修改必要的配置项。

## 开发流程

### 1. 创建功能分支

在开始开发新功能或修复bug之前，创建新的分支：

```bash
# 创建新分支
git checkout -b feature/功能名称
# 或者
git checkout -b fix/问题描述
```

### 2. 开发功能

按照代码注释规范编写代码，确保：

- 添加必要的注释
- 遵循统一的代码风格
- 编写或更新相关测试

### 3. 运行开发服务器

```bash
# 启动后端服务
npm run start

# 启动前端开发服务器（另一个终端）
cd src/frontend
npm start
```

### 4. 代码检查

在提交代码前，运行代码检查工具：

```bash
# 运行ESLint检查
npm run lint

# 运行Prettier格式化
npm run format

# 运行TypeScript类型检查
npx tsc --noEmit
```

### 5. 运行测试

确保所有测试通过：

```bash
# 运行所有测试
npm test

# 运行测试（覆盖率）
npm run test:coverage
```

### 6. 提交代码

按照提交规范提交代码：

```bash
git add .
git commit -m "feat: 添加新功能"
git push origin feature/功能名称
```

### 7. 创建Pull Request

在GitHub上创建Pull Request，等待代码审查。

## 代码规范

### 1. TypeScript规范

- 使用TypeScript类型注解，避免使用`any`类型
- 接口和类型定义使用PascalCase
- 变量和函数使用camelCase
- 常量使用UPPER_SNAKE_CASE

### 2. 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 变量 | camelCase | `userName`, `isActive` |
| 函数 | camelCase | `getUser()`, `handleClick()` |
| 类 | PascalCase | `UserService`, `AuthManager` |
| 接口 | PascalCase | `IUser`, `IResponse` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRIES`, `API_BASE_URL` |
| 文件 | camelCase或kebab-case | `userService.ts`, `user-service.ts` |

### 3. 代码注释

遵循《代码注释规范》的要求，添加必要的注释。

## 测试要求

### 1. 单元测试

每个新增的函数/方法应包含对应的单元测试：

```typescript
describe('UserService', () => {
    describe('getUser', () => {
        it('应该返回用户信息', async () => {
            // 测试代码
        });

        it('应该处理用户不存在的情况', async () => {
            // 测试代码
        });
    });
});
```

### 2. 集成测试

对于模块间的交互，编写集成测试：

```typescript
describe('API Integration', () => {
    it('应该正确处理用户认证', async () => {
        // 集成测试代码
    });
});
```

### 3. 测试覆盖率

- 核心业务逻辑：覆盖率 >= 80%
- 公共工具函数：覆盖率 >= 90%
- UI组件：覆盖率 >= 70%

## 提交规范

### 提交信息格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type类型

| Type | 说明 |
|------|------|
| feat | 新功能 |
| fix | Bug修复 |
| docs | 文档更新 |
| style | 代码格式（不影响功能） |
| refactor | 重构 |
| test | 测试相关 |
| chore | 构建/工具相关 |

### 示例

```
feat(auth): 添加用户注册功能

- 添加用户注册API接口
- 添加密码加密存储
- 添加注册验证逻辑

Closes #123
```

## 分支管理

### 分支命名

| 分支类型 | 命名格式 | 示例 |
|----------|----------|------|
| 功能分支 | feature/* | feature/user-auth |
| 修复分支 | fix/* | fix/login-bug |
| 发布分支 | release/* | release/v1.0.0 |
| 热修复分支 | hotfix/* | hotfix/critical-fix |

### 分支流程

```
main (生产环境)
    ^
    |
release/* (发布准备)
    ^
    |
develop (开发集成)
    ^
    |
feature/* (功能开发)
    |
fix/* (Bug修复)
```

## 代码审查

### 审查要点

1. **代码质量**：是否遵循代码规范，是否存在潜在的bug
2. **功能实现**：是否正确实现了需求
3. **测试覆盖**：是否包含足够的测试
4. **性能影响**：是否有性能问题
5. **安全性**：是否存在安全隐患

### 审查流程

1. 作者提交Pull Request
2. 审查者检查代码
3. 提出修改意见或批准合并
4. 作者根据意见修改代码
5. 审查者批准后合并到目标分支

## 依赖注入规范 (V5.6)

### 1. 获取依赖

**新代码必须通过 DI 容器获取依赖，禁止直接调用 `getInstance()`：**

```typescript
// ✅ 正确：通过 DI 容器
import { DIContainer, DI_TOKENS } from '../shared/DIContainer';
const eventBus = await DIContainer.getInstance().resolve<JiabaixingEventBus>(DI_TOKENS.EVENT_BUS);

// ❌ 错误：直接调用单例
import { EventBus } from '../shared/EventBus';
const eventBus = EventBus.getInstance();
```

### 2. 注册新依赖

新增 Service/Manager/Engine 类时，必须：

1. 在 `DIContainer.ts` 的 `DI_TOKENS` 中添加对应 Symbol
2. 在 `DependencyRegistry.ts` 的 `SINGLETON_MIGRATION_MAP` 中登记迁移条目
3. 在 `registerCoreDependencies()` 或初始化流程中注册到容器

```typescript
// DIContainer.ts
export const DI_TOKENS = {
  // ... 已有 Token
  MY_NEW_SERVICE: Symbol('MyNewService'),
} as const;

// DependencyRegistry.ts
const SINGLETON_MIGRATION_MAP: SingletonMigrationEntry[] = [
  // ... 已有条目
  { className: 'MyNewService', token: DI_TOKENS.MY_NEW_SERVICE, module: '../services/MyNewService', tags: [DI_TAGS.CORE], priority: 2, migrated: true },
];
```

### 3. 测试中使用 DI

```typescript
import { DIContainer, DI_TOKENS } from '../../shared/DIContainer';

describe('MyService', () => {
  let container: DIContainer;

  beforeEach(() => {
    container = DIContainer.create(); // 独立容器，不影响全局
    container.registerValue(DI_TOKENS.EVENT_BUS, mockEventBus);
    container.registerValue(DI_TOKENS.LLM_PROVIDER, mockLLM);
  });

  afterEach(async () => {
    await container.dispose(); // 清理
  });

  it('should work', async () => {
    const service = await container.resolve<MyService>(DI_TOKENS.MY_NEW_SERVICE);
    // ...
  });
});
```

### 4. 生命周期选择

| 生命周期 | 适用场景 | 示例 |
|---------|---------|------|
| `singleton` | 全局唯一的服务 | EventBus, ConfigLoader, SecurityGuard |
| `transient` | 每次使用都新建 | 请求处理器, 临时计算器 |
| `scoped` | 请求/会话内唯一 | 会话上下文, 请求级缓存 |

## Agent 编排规范 (V5.6)

### 1. BaseAgent 竞标调度

新增的 `bid()` / `canHandle()` / `healthCheck()` 接口用于多 Agent 编排：

```typescript
// OrchestratorAgent 选择最佳执行者
const bids = await Promise.all(
  agents.map(agent => agent.bid(taskGoal, requiredTools))
);
const validBids = bids.filter((b): b is AgentBid => b !== null);
const winner = validBids.sort((a, b) => b.confidence - a.confidence)[0];
```

### 2. TaskDispatcher assignedTo 闭环

OrchestratorAgent 的 `assignDynamicRoles()` 结果现在会实际影响 TaskDispatcher 的 Agent 分配：

```
OrchestratorAgent.assignDynamicRoles() → task.assignedTo = agentId
  → TaskDispatcher.assignAgent() 优先使用 task.assignedTo
  → 回退: agentId → findBestAgent → getIdleAgents
```

### 3. Bridge 轨迹数据

`PythonAgentBridge.processInput()` 现在返回 `BridgeProcessResult`，包含完整轨迹：

```typescript
interface BridgeProcessResult {
  response: string;
  traceId?: string;
  intent?: string;
  qualityScore?: number;   // Python 端评估的质量分
  toolCallsMade?: number;  // 本次执行的工具调用次数
  roundsUsed?: number;     // ReAct 循环轮数
  duration?: number;       // 总执行时长 (ms)
  finishReason?: string;   // 结束原因 (stop/tool_call/max_rounds)
}
```

### 4. HarnessDeps 校验

注入依赖时会自动校验必需字段：

```typescript
const harness = new AgentHarness();
harness.setDeps(deps); // 缺少 llm/constitutionalBuilder/memoryInjector/dynamicContext/historyProvider 时告警
```

### 5. ESLint 规则

- `no-restricted-imports`: 禁止 import 6 个废弃模块（ContextManager/LLMProvider/EvolutionOrchestrator/MemoryEngine/TokenBudgetAllocator/loop/*）
- `no-restricted-syntax`: 警告 `getInstance()` 调用，提示使用 DI 容器

## 架构拆分规范 (V5.6)

### 1. EventBus 职责拆分

EventBus 已拆分为三个职责清晰的服务：

```
EventBus (事件广播 + 持久化)
  ├── TraceCollector (全链路追踪: trace/token/toolCall)
  └── AgentDiscovery (Agent 通信: 注册/订阅/邮箱)
```

直接使用子服务获取更细粒度的控制：

```typescript
const bus = EventBus.getInstance();
// 追踪
bus.traceCollector.startTrace(id, 'tool_execution');
bus.traceCollector.recordTokenUsage(id, 'gpt-4', 100, 50);
// Agent 通信
bus.agentDiscovery.registerAgent(profile);
bus.agentDiscovery.getAgentsByCapability('code_generation');
```

### 2. ToolRegistry 状态外置

ToolRegistry 的运行时状态（熔断器/信号量/配额/去重缓存）已抽象为 `ToolRuntimeState` 接口：

```typescript
// 默认使用内存存储
const registry = new ToolRegistry();

// 生产环境可替换为 Redis 存储
registry.setRuntimeState(new RedisToolRuntimeState(redisClient));
```

接口方法：`getCircuitBreaker` / `setCircuitBreaker` / `getSemaphore` / `setSemaphore` / `getQuota` / `setQuota` / `getDedupResult` / `setDedupResult`

### 3. ContextManager 委托迁移

ContextManager 已支持委托模式，优先使用 UnifiedContextPipeline：

```typescript
const cm = new ContextManager(deps);
// 设置委托（Python 后端）
cm.setDelegatePipeline(unifiedContextPipeline);
// buildContext() 将优先调用 pipeline，失败时回退 TS 本地实现
const messages = await cm.buildContext(input);
```

## 类型与错误规范 (V5.6)

### 1. Result<T> 统一返回类型

新代码应使用 `Result<T>` 替代 `{ success, output?, error? }` 模式：

```typescript
import { Result, ok, err, isOk, isErr } from '../types';

async function divide(a: number, b: number): Promise<Result<number>> {
  if (b === 0) return err('除数不能为零', 'DIVISION_BY_ZERO');
  return ok(a / b);
}

const result = await divide(10, 0);
if (isOk(result)) {
  console.log(result.value); // 类型安全，无需 !
} else {
  console.log(result.error); // string
  console.log(result.code);  // 'DIVISION_BY_ZERO'
}
```

### 2. SandboxExecutor 双模式

```typescript
// 默认：Worker 线程真隔离（推荐）
const sandbox = new SandboxExecutor({ mode: 'isolated', securityLevel: 'high' });

// 仅 low 安全级别允许 inline 模式
const devSandbox = new SandboxExecutor({ mode: 'inline', securityLevel: 'low' });
```

### 3. safeExecute 安全执行

```typescript
import { safeExecute, safeExecuteSync } from '../../shared/errors';

const result = await safeExecute(() => riskyOperation());
if (result.ok) {
  // result.value
} else {
  // result.error: JiabaixingError
}
```

### 4. 新增错误类型

| 错误类 | code | statusCode | 用途 |
|--------|------|------------|------|
| `CircuitBreakerOpenError` | CIRCUIT_BREAKER_OPEN | 503 | 工具熔断器打开 |
| `SandboxExecutionError` | SANDBOX_EXECUTION_ERROR | 500 | 沙箱执行失败 |
| `DependencyResolutionError` | DEPENDENCY_RESOLUTION_ERROR | 500 | DI 容器依赖解析失败 |

## V6.0 迁移规范 (2026-08-17)

### 1. 单例 → DI 迁移规则

所有单例类必须添加 `create()` 工厂方法，保留 `getInstance()` 向后兼容：

```typescript
export class MyService {
  private static instance: MyService | null = null;

  // ✅ V6.0 新增：DI 容器工厂方法
  static create(): MyService {
    return new MyService();
  }

  // ⚠️ 保留向后兼容，新代码不应直接调用
  static getInstance(): MyService {
    if (!MyService.instance) {
      MyService.instance = new MyService();
    }
    return MyService.instance;
  }
}
```

### 2. DI 注册模式

在 `DependencyRegistry.ts` 中使用 `create()` 注册：

```typescript
container.register(
  DI_TOKENS.MY_SERVICE,
  () => MyService.create(),          // ✅ 使用 create()
  { lifecycle: 'singleton', tags: [DI_TAGS.CORE] }
);
```

### 3. 废弃模块代理

TS 端废弃模块应通过 `DeprecatedModuleProxy` 转发到 Python：

```typescript
import { DEPRECATED_PROXY } from '../../shared/DeprecatedModuleProxy';

const result = await DEPRECATED_PROXY.proxy({
  method: 'POST',
  path: '/api/memory/store',
  body: { content, type: 'long-term' }
});
```

### 4. API 契约检查

新增端点必须在 `api-contract.ts` 中登记：

```typescript
import { getContractGaps, getContractStats } from '../../shared/api-contract';

const stats = getContractStats();
// { total: 44, tsOnly: 8, pyOnly: 14, aligned: 22, alignmentRate: '50.0%' }
```

### 5. 迁移进度

| 优先级 | 已迁移 | 总计 | 进度 |
|--------|--------|------|------|
| P0 | 6 | 6 | 100% |
| P1 | 12 | 12 | 100% |
| P2 | 7 | 7 | 100% |
| P3 | 0 | 12 | 0% |
| **合计** | **25** | **37** | **67.6%** |

## 总结

遵循以上开发流程，可以确保代码质量和团队协作效率。建议团队成员在实际开发中不断优化和完善流程，以适应项目需求的变化。
