# TS → Python 废弃文件迁移映射

> 当 `AGENT_BACKEND=python`（默认）时，以下 TS 文件不再被主流程使用，
> 但保留在 `AGENT_BACKEND=local` 回退模式中以供兼容。
>
> **V5.5 更新** (2026-07-14): Python 端已完成 Facade 拆分和中间件化，
> 架构质量显著提升。V6.0 将移除所有 TS 端 AI 核心组件。

| TS 文件                                       | Python 替代                                   | 状态        |
| --------------------------------------------- | --------------------------------------------- | ----------- |
| `src/models/LLMProvider.ts`                   | `python/agent/llm/provider.py`                | @deprecated |
| `src/models/ProviderManager.ts`               | `python/agent/llm/router.py`                  | @deprecated |
| `src/models/PromptCacheManager.ts`            | `python/agent/llm/prompt_cache.py`            | @deprecated |
| `src/models/SqliteCacheStore.ts`              | `python/agent/llm/prompt_cache.py`            | @deprecated |
| `src/models/LLMResponseCache.ts`              | `python/agent/llm/cache.py`                   | @deprecated |
| `src/models/RequestQueue.ts`                  | `python/agent/llm/queue.py`                   | @deprecated |
| `src/memory/MemoryEngine.ts`                  | `python/agent/memory/engine.py`               | @deprecated |
| `src/memory/ChineseTokenizer.ts`              | `python/agent/memory/tokenizer.py`            | @deprecated |
| `src/evolution/EvolutionEngine.ts`            | `python/agent/evolution/engine.py`            | @deprecated |
| `src/harness/loop/LoopController.ts`          | `python/agent/loop/controller.py`             | @deprecated |
| `src/harness/AgentHarness.ts`                 | `python/agent/core/engine.py`                 | @deprecated |
| `src/harness/context/ContextManager.ts`       | `python/agent/context/`                       | @deprecated |
| `src/harness/context/TokenBudgetAllocator.ts` | `python/agent/core/context_pipeline.py`       | @deprecated |
| `src/evolution/ImplicitFeedbackCollector.ts`  | `python/agent/evolution/implicit_feedback.py` | @deprecated |

## 清理策略

- **Phase 1**: 所有废弃文件标记 `@deprecated` 注释，IDE 会高亮警告
- **Phase 2**: `AGENT_BACKEND=local` 模式完全移除后，删除以上文件
- **当前状态**: 保留兼容，不主动删除（避免破坏 local 模式回退）
