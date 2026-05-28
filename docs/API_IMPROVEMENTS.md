# API改进和新增功能文档

## 概述

本文档介绍Phase 0-11审查后实施的三个主要改进：

1. **Redis缓存集成** - 支持分布式缓存，可选内存回退
2. **性能监控系统** - 细粒度的性能指标收集和分析
3. **API文档完善** - 全面的使用示例和最佳实践

---

## 1. Redis缓存集成

### 功能特性

- **抽象缓存接口** - 统一的缓存API，支持多种后端
- **Redis支持** - 分布式缓存架构，预留Redis集成
- **内存回退** - Redis不可用时自动使用内存缓存
- **LRU淘汰策略** - 自动管理缓存大小
- **TTL过期** - 支持缓存条目过期时间
- **统计功能** - 缓存命中率、大小等指标

### 环境变量配置

```bash
# 启用Redis (需要安装ioredis依赖)
REDIS_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password (可选)
REDIS_DB=0

# 缓存配置
CACHE_TTL=120000  # 默认120秒
USE_NEW_CACHE=true  # 启用新缓存系统
```

### API使用示例

```typescript
import { RedisCache } from '../src/models/RedisCache';
import { LLMResponseCache } from '../src/models/LLMResponseCache';

// 基础Redis缓存使用
const cache = new RedisCache<string>({
  ttl: 60000, // 60秒TTL
  maxSize: 500,
  namespace: 'my_app',
});

// 设置缓存
cache.set('key1', 'value1');
await cache.setAsync('key2', 'value2');

// 获取缓存
const value = cache.get('key1');
const asyncValue = await cache.getAsync('key2');

// 获取统计信息
const stats = cache.getStats();
console.log(`缓存命中率: ${(stats.hitRate * 100).toFixed(1)}%`);

// LLM响应缓存 (向后兼容)
const llmCache = new LLMResponseCache(300000); // 5分钟TTL
const key = llmCache.generateKey('用户输入', '系统提示');
llmCache.set(key, 'LLM响应');
const response = llmCache.get(key);
```

### 架构设计

```
┌─────────────────────────────────────────┐
│         LLMResponseCache (旧API)        │  ← 向后兼容
├─────────────────────────────────────────┤
│         RedisCache (适配器)             │  ← 统一接口
├─────────────────────────────────────────┤
│  MemoryCache   │   RedisCache (预留)   │  ← 双缓存支持
└─────────────────────────────────────────┘
```

---

## 2. 性能监控系统

### 功能特性

- **性能追踪** - 细粒度的函数执行时间测量
- **统计分析** - P50/P95/P99延迟分布
- **错误追踪** - 失败率和错误统计
- **吞吐量计算** - 每秒调用次数
- **系统负载** - 内存使用、运行时间监控
- **报告生成** - 完整的性能报告

### 基本使用

```typescript
import { perf, measure, startSpan, endSpan } from '../src/utils/PerformanceMonitor';

// 方式1: 使用measure函数
const result = await measure('my_operation', async () => {
  // 执行异步操作
  return await someAsyncFunction();
}, 'category_name');

// 方式2: 使用同步measure
const syncResult = measureSync('sync_operation', () => {
  // 同步操作
  return computeSomething();
}, 'category');

// 方式3: 使用span API (更灵活)
const spanId = startSpan('complex_operation', 'workflow', { userId: '123' });
try {
  // ... 执行操作
  endSpan(spanId, true, { result: 'success' });
} catch (error) {
  endSpan(spanId, false, { error: (error as Error).message });
  throw error;
}
```

### 高级功能

```typescript
import { PerformanceMonitor } from '../src/utils/PerformanceMonitor';

const monitor = PerformanceMonitor.getInstance();

// 获取分类统计
const llmStats = monitor.getCategoryStats('llm');
console.log(`LLM平均响应: ${llmStats.avgDuration.toFixed(2)}ms`);
console.log(`P95延迟: ${llmStats.p95Duration.toFixed(2)}ms`);

// 获取完整报告
const report = monitor.getReport();

// 打印报告
monitor.printReport();

// 监控特定指标
const specificStats = monitor.getMetricStats('llm_chat');
console.log(`调用次数: ${specificStats.totalCalls}`);
console.log(`错误率: ${(specificStats.errorRate * 100).toFixed(1)}%`);

// 清空数据
monitor.clear();
```

### 性能报告示例

```
============================================================
📊 性能监控报告
🕐 生成时间: 2026-05-28T12:34:56.789Z
📈 总指标数: 1,234

📁 llm:
   调用次数: 456
   成功率: 98.5%
   平均耗时: 234.56ms
   P50/P95/P99: 180.45/420.78/680.90ms

📁 cache:
   调用次数: 789
   成功率: 100.0%
   平均耗时: 0.89ms
   P50/P95/P99: 0.56/1.78/2.90ms

🐢 最慢操作 TOP 10:
   1. llm_complex_query: 567.89ms (12 calls)
   2. memory_vector_search: 345.67ms (45 calls)
   ...

💻 系统负载:
   RSS: 256.78 MB
   Heap Total: 384.56 MB
   Heap Used: 192.34 MB
   Uptime: 3600.5s
============================================================
```

---

## 3. LLMProvider性能集成

### 已集成的性能指标

LLMProvider现在自动收集以下性能指标：

- `llm_chat` - LLM对话调用
- `llm_multimodal` - 多模态调用
- `cache_get` - 缓存读取
- `cache_set` - 缓存写入
- `llm_function_calling` - 函数调用

### 使用示例

```typescript
import { LLMProvider } from '../src/models/LLMProvider';
import { perf } from '../src/utils/PerformanceMonitor';

const llm = new LLMProvider();

// 正常使用 - 性能监控自动启用
const response = await llm.chat('你好');

// 查看性能统计
const stats = perf.getCategoryStats('llm');
console.log(`LLM调用统计:`, stats);

// 定期打印报告
setInterval(() => {
  perf.printReport();
}, 60000); // 每分钟
```

---

## 4. 完整示例: 综合使用

```typescript
import { LLMProvider } from '../src/models/LLMProvider';
import { RedisCache } from '../src/models/RedisCache';
import { perf, measure } from '../src/utils/PerformanceMonitor';

async function main() {
  console.log('🚀 启动应用...');

  // 初始化组件
  const llm = new LLMProvider();
  const appCache = new RedisCache<{ data: any }>({
    ttl: 300000,
    namespace: 'app_data',
  });

  // 使用性能监控包裹操作
  const result = await measure('workflow_complete', async () => {
    // 1. 尝试从缓存获取
    const cached = await appCache.getAsync('workflow_result');
    if (cached) {
      return cached;
    }

    // 2. 调用LLM
    const llmResult = await measure('llm_call', async () => {
      return await llm.chat('分析这些数据');
    }, 'llm');

    // 3. 缓存结果
    await appCache.setAsync('workflow_result', llmResult);
    
    return llmResult;
  }, 'workflow');

  // 打印性能报告
  console.log('\n📊 性能报告:');
  perf.printReport();

  // 查看缓存统计
  console.log('\n💾 缓存统计:');
  const cacheStats = appCache.getStats();
  console.log(cacheStats);
}

main().catch(console.error);
```

---

## 5. 最佳实践

### 缓存最佳实践

1. **合理设置TTL** - 根据数据变化频率设置
2. **监控命中率** - 保持在80%以上为好
3. **控制缓存大小** - 避免内存过度使用
4. **键命名规范** - 使用命名空间避免冲突

### 性能监控最佳实践

1. **分类合理** - 使用有意义的category名称
2. **避免过度监控** - 不监控非常高频的小操作
3. **定期查看报告** - 发现性能瓶颈
4. **设置告警** - 基于P95延迟设置阈值

---

## 6. 向后兼容性

所有改进都保持了完全的向后兼容性：

- `LLMResponseCache` API保持不变
- 新功能通过环境变量启用
- 默认行为与原系统一致
- 渐进式迁移路径

---

## 7. 测试覆盖

所有新功能都有完整的测试覆盖：

- 缓存接口测试
- Redis适配器测试
- 性能监控测试
- 集成测试

运行测试：
```bash
npm test
```

---

## 8. 故障排除

### 缓存问题

**问题**: 缓存命中率低
- 检查TTL设置是否合理
- 确认键生成逻辑是否正确
- 查看是否频繁写入相同键

### 性能问题

**问题**: 内存使用过高
- 检查maxSize设置
- 查看是否有内存泄漏
- 使用getStats()监控增长趋势

### Redis问题

**问题**: Redis连接失败
- 系统自动回退到内存缓存
- 检查Redis服务状态
- 验证连接配置

---

## 9. 迁移指南

### 从旧系统迁移

1. 更新依赖（如需要Redis）
2. 设置环境变量
3. 无需修改代码 - API保持兼容
4. 监控性能和缓存效果

### 启用Redis

```bash
# 1. 安装依赖
npm install ioredis

# 2. 设置环境变量
REDIS_ENABLED=true
REDIS_HOST=localhost

# 3. 重启应用 - 代码无需修改
```

---

## 10. 相关文件

- `src/models/CacheInterface.ts` - 缓存抽象接口
- `src/models/RedisCache.ts` - Redis缓存适配器
- `src/models/LLMResponseCache.ts` - LLM缓存（更新）
- `src/utils/PerformanceMonitor.ts` - 性能监控系统
- `docs/API_IMPROVEMENTS.md` - 本文档

---

*文档版本: 1.0 | 更新日期: 2026-05-28*
